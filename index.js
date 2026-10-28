// viboplr-slskd — search and download from the Soulseek network.
//
// Viboplr cannot speak Soulseek (custom binary TCP; the plugin sandbox only has
// HTTP), so this plugin drives a user-run slskd daemon over its REST API.
//
// Design notes:
//  - THE PLUGIN OWNS THE TRANSFER LIFECYCLE. A Soulseek transfer can sit in a
//    stranger's upload queue for hours; every host resolver path is bounded at
//    60s. So we enqueue in slskd and render our own progress. A finished file
//    reaches the library two ways, both of which the qBittorrent plugin uses:
//    automatically, by rescanning the collection slskd's downloads folder sits
//    in (api.collections.resync); or on demand, through the host's own download
//    modal (api.ui.requestAction("download-tracks") → our onResolveByUri answers
//    a file:// URL, which is an instant local copy well inside any budget).
//    There is no api.downloads.enqueue any more — the host removed its
//    background queue — so nothing here relies on it.
//  - DEPENDENCY NOTIFICATION IS OURS. The host's binaryDependencies mechanism
//    only resolves names in its own Rust REGISTRY (ffmpeg/yt-dlp); a name outside
//    it is silently dropped. slskd also isn't a host-exec'd binary. So we run our
//    own four-state readiness machine and set our own sidebar badge.
//  - NO LOCAL PATH IS DERIVABLE. Transfer records carry only the REMOTE filename,
//    and slskd's destination layout is a user-configurable token pattern. We
//    instead pick our own `Options.Destination` at enqueue time and read back the
//    real filename via the Files API.
//  - THE PLAYBACK FALLBACK IS BUDGETED, NOT UNBOUNDED. As a stream resolver the
//    plugin gets the host's 60s like everyone else, so it runs one bounded
//    search, fetches the best match from a sharer with a free slot, and moves on
//    from one that doesn't start. What lands in time plays; what doesn't keeps
//    downloading and answers the next request for the same song instantly. The
//    files it fetches are indexed (`fallback`) so the user can delete exactly
//    those, through slskd's Files API — see "Playback fallback" below.
//  - Sandbox: no fetch, no WebSocket, no Map/Set, no btoa. Base64 is hand-rolled;
//    polling replaces SignalR.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
var PLUGIN_ID = "slskd";
var VIEW_ID = "slskd-browse";
var PROVIDER_ID = "slskd-import";
// The host keys download providers as "pluginId:providerId" — what
// requestAction("download-tracks") must be handed (cf. "ytdlp:ytdlp-download").
var PROVIDER_KEY = PLUGIN_ID + ":" + PROVIDER_ID;
var PROVIDER_NAME = "Soulseek";
var SCHEME = "slsk";
var DEST_ROOT = "viboplr";
// Separator inside the "user<sep>filename" keys that identify a transfer
// (tracked records, row ids, slsk:// refs). NUL can appear in neither a Soulseek
// username nor a path, so the split is unambiguous; written as an escape so the
// source stays a text file.
var KEY_SEP = "\u0000";
// Reserved host action: Cmd+K hands its typed query to a plugin view through
// this (HOST_SEARCH_ACTION in the host). A tabbed view has to handle it — the
// host's own seeding only finds a top-level search-input, and ours lives inside
// the Search tab.
var HOST_SEARCH_ACTION = "host:search";

var AUDIO_EXTS = [
  "mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "wav", "aiff", "aif",
  "ape", "wv", "wma", "alac", "mpc", "tta", "dsf", "dff"
];
var LOSSLESS_EXTS = ["flac", "wav", "aiff", "aif", "ape", "wv", "alac", "tta", "dsf", "dff"];

// Quality tiers. `unknown` deliberately sits BELOW high and ABOVE medium: many
// Soulseek clients report no attributes at all, and ranking those last would
// systematically bury good results.
var T_LOSSLESS = 0, T_HIGH = 1, T_UNKNOWN = 2, T_MEDIUM = 3, T_LOW = 4;

// A broad query ("rage against the machine") really does come back with 20k+
// downloadable files across 16k+ folders. Every one of those becomes a row or a
// card object handed to the host's renderer, which is both unusable to scroll
// and expensive to build — so the view shows the best N and says so. The list is
// already ranked best-first, so a cap costs only the tail nobody would reach.
var MAX_RESULT_FILES = 1000;
var MAX_RESULT_FOLDERS = 1000;

var SEARCH_POLL_MS = 1000;
var SEARCH_CAP_MS = 30000;
// Response bodies are written a moment AFTER the search flips to Completed —
// measured at ~68ms against slskd 0.26.0, but a poll that lands inside that gap
// reads an empty list, which used to surface as "no results" for a search that
// found thousands. Retry briefly before believing an empty answer.
var RESPONSES_RETRY_MS = 250;
var RESPONSES_RETRY_TRIES = 12;
var TRANSFER_POLL_FAST_MS = 3000;
var TRANSFER_POLL_SLOW_MS = 30000;
var READINESS_POLL_MS = 60000;

// Playback fallback (the `slskd-fallback` stream resolver). The host gives a
// resolver 60s; everything below is carved out of that.
var FALLBACK_ID = "slskd-fallback";
var FALLBACK_LABEL = "Soulseek";
var FALLBACK_SUBDIR = "fallback";            // DEST_ROOT/fallback/<seq>-<label>
var FALLBACK_BUDGET_MS = 55000;              // answer (or give up) before the host does
var FALLBACK_SEARCH_MS = 20000;              // the search's share of the budget
var FALLBACK_START_MS = 12000;               // no bytes for this long = the slot wasn't free; next sharer
var FALLBACK_RECONCILE_AGE_MS = 60000;       // a pending entry younger than this still belongs to its resolve
var FALLBACK_CLEANUP_EVERY_MS = 10 * 60 * 1000;  // automatic cleanup runs at most this often from the poll
var FALLBACK_CLEANUP_RECENT_MS = 15 * 60 * 1000; // a file played this recently is never cleaned up (it may be playing)
var GB = 1024 * 1024 * 1024;
var FALLBACK_MAX_GB_OPTIONS = [0, 1, 2, 5, 10, 20];       // 0 = no size limit
var FALLBACK_MAX_AGE_DAY_OPTIONS = [0, 7, 30, 90, 180];   // 0 = no age limit
var FALLBACK_MIN_REMAINING_MS = 10000;       // don't start a sharer with less than this left
var FALLBACK_POLL_MS = 1000;
var FALLBACK_MAX_TRIES = 4;                  // sharers tried per resolve, hedged or not
var FALLBACK_HEDGE_MS = 5000;                // no bytes from the first sharer for this long → queue a second
var FALLBACK_MAX_INFLIGHT = 2;               // never more than this many strangers' slots at once
var FALLBACK_MIN_TITLE_MATCH = 0.6;          // share of the title's words the filename must carry
var FALLBACK_MIN_ARTIST_MATCH = 0.5;         // share of the artist's words the path must carry
var FALLBACK_VIEW_CANDIDATES = 25;

// Automatic upgrades (the Upgrades tab). Nobody is waiting on these, so the
// clock is the sharer's queue, not a listener's patience.
var UPGRADE_SUBDIR = "upgrades";             // DEST_ROOT/upgrades/<seq>-<label>
var UPGRADE_SEARCH_MS = 30000;               // one bounded search per upgrade
var UPGRADE_STALL_MS = 10 * 60 * 1000;       // no bytes for this long → the next sharer
var UPGRADE_MAX_TRIES = 4;                   // sharers asked per upgrade
var UPGRADE_KEEP_CANDIDATES = 8;
var UPGRADE_UNSEEN_LIMIT = 5;                // polls a transfer may be missing from slskd's list

var B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
var api = null;

var settings = {
  url: "",
  apiKey: "",
  tierOverride: null,     // null | "local" | "remote"
  insecure: false,        // accept slskd's self-signed cert
  preferredFormats: "",   // comma-separated, "" = no preference
  fallbackQuality: "fast", // "fast" | "best" | "lossless" | "high" — see FALLBACK_MODES; preferredFormats orders within it
  fallbackMaxGb: 0,         // automatic cleanup: keep at most this many GB of fallback files (0 = off)
  fallbackMaxAgeDays: 0,    // automatic cleanup: delete fallback files not played for this many days (0 = off)
  upgradeTarget: "flac16", // a UPGRADE_TARGETS key — what an automatic upgrade looks for
  batchSeq: 0,
  managedBy: null,        // null | "plugin" — this plugin installed the slskd it talks to (see "Installing slskd")
  stopWithViboplr: false, // the installed slskd stops when Viboplr quits (default: it keeps running)
  startWithViboplr: true, // the plugin starts the installed slskd when it activates, if it isn't running
  debugServer: false,     // talk to the fake slskd (FAKE_SLSKD_COMMAND) instead — see "Test server"
  debugUrl: "http://127.0.0.1:5039"
};

// ---------------------------------------------------------------------------
// Test server
// ---------------------------------------------------------------------------
// The repo's fake slskd (`npm run fake-slskd`, docs/fake-slskd.md) stands in
// for slskd where Soulseek can't be reached. Switching to it leaves the real
// address and key untouched — `conn()` is what every request and every
// readiness surface reads — and keeps a SEPARATE copy of the state that only
// means something for one server (`stateKey`): the fake's transfer list holds
// none of the real downloads, and reading it as the real one would have the
// plugin forget them as "vanished".
var DEBUG_STATE_PREFIX = "debug.";
var debugDetected = null;   // null = not checked; else { mode } from the fake's X-Fake-Slskd header, or false
// Runs the fake from GitHub, no checkout needed (the repo's package.json `bin`).
var FAKE_SLSKD_COMMAND = "npx github:outcast1000/viboplr-slskd";
var FAKE_SLSKD_DOCS = "https://github.com/outcast1000/viboplr-slskd/blob/main/docs/fake-slskd.md";
var debugLookedAt = 0;      // when Look again last ran, for its "nothing answered"
// Where a fake started with --port is looked for, beside the saved address.
var DEBUG_PORT_FIRST = 5039;
var DEBUG_PORT_LAST = 5049;

function conn() {
  if (!settings.debugServer) return settings;
  return Object.assign({}, settings, {
    url: settings.debugUrl || "http://127.0.0.1:5039",
    apiKey: settings.apiKey || "fake-slskd",
    insecure: false,
    managedBy: null,
    tierOverride: null,
    debug: true
  });
}

function stateKey(key) {
  return settings.debugServer ? DEBUG_STATE_PREFIX + key : key;
}

var readiness = { state: "unconfigured", detail: null, username: null, version: null, shareCount: null };
// slskd's own word for its Soulseek connection ("Connecting", "Connected,
// LoggedIn", "Disconnected"…) from the last probe; the setup's sign-in step
// shows it while it waits.
var lastServerState = null;
var sharesWarned = false;

var downloadsDir = null;
// slskd's own directories.incomplete, read alongside downloadsDir. Only used to
// tell a misconfigured slskd from a bad source when a download fails.
var incompleteDir = null;
var tier = "remote";

var activeTab = "search";
// `matchCount` / `folderCount` are what the search actually produced;
// `results` / `folders` are the capped slices the view renders. `sortColumn` is
// null while the list is in ranked ("best match") order.
// `mode` is what a context-menu action asked the search to do beyond finding
// files — see "Upgrade / fill-album modes" — and is dropped by the next plain
// search.
var search = { query: "", id: null, running: false, responseCount: 0, fileCount: 0, matchCount: 0, folderCount: 0, results: [], folders: [], error: null, sortColumn: null, sortDir: "desc", folderSortColumn: null, folderSortDir: "desc", mode: null };
var searchGen = 0;

var transfers = [];       // raw slskd transfer records (downloads)
var tracked = {};         // "user filename" -> { destination, b64, resolvedPath, meta, size, length }
var localCollections = []; // host's local collections, for "did this land in the library?"
var knownDone = {};       // transfer keys already seen finished (completion detection)
var completionsSeeded = false;
var tagsPending = {};     // resolvedPath -> in-flight readAudioTags promise
// Files the playback fallback fetched, keyed by normalized song identity
// (`fallbackKey`) → { ref (tracked key), title, artist, query, at, size, state:
// "pending" | "kept", path, lastUsedAt }. Persisted; the Downloads tab lists and
// deletes exactly these.
var fallback = {};
// What every sharer has done for us, keyed by username → { delivered, failed,
// stalled, bytes, lastAt }. Fed by every download this plugin watches — the
// Search tab's, the assistant's, the fallback's — and read back as a ranking
// key, because the free-slot flag and upload speed a sharer advertises are
// self-reported and were both wrong for the peer that cost the first live run
// its whole budget. A sharer that has actually delivered outranks one that
// merely claims it could.
var sharers = {};
// Which transfers the ledger has dealt with: "claimed" while a fallback race is
// watching one (the race reports its outcome; the poll must not), "counted"
// once an outcome was recorded — or seen already finished at the first poll of
// a session, which is history, not news. Two observers see every transfer
// (the poll and, for fallback files, the race), and this is what stops them
// counting one outcome twice or a stale one at every restart.
var ledgerSeen = {};

// slskd runs ONE search at a time (POST /searches answers 429 while another is
// in flight), so every search — the view's, a context-menu one, an assistant
// tool's — goes through this chain.
var searchChain = Promise.resolve();
// What the assistant's recent `search` calls produced, keyed by candidate id,
// so `download` can be handed ids instead of (user, filename, size) triples.
// Each holds { c, mode, seq }: the candidate, the upgrade mode of the search it
// came from (null for a plain one — what `download` stamps onto the tracked
// record), and which search. The last TOOL_SEARCHES_KEPT searches stay valid:
// keeping only the newest made an id from one search useless the moment a
// second search ran, mid-way through picking from the first.
var toolResults = {};
var toolSearchSeq = 0;
var TOOL_SEARCHES_KEPT = 5;

var readinessTimer = null;
var transferTimer = null;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// UTF-8 bytes without TextEncoder (absent from the sandbox).
function utf8Bytes(str) {
  var out = [];
  var s = String(str == null ? "" : str);
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      var c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
      } else {
        out.push(0xef, 0xbf, 0xbd);
      }
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

// Standard base64 (slskd decodes with Convert.FromBase64String, so no base64url).
function b64encode(str) {
  var bytes = utf8Bytes(str);
  var out = "";
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i];
    var has1 = i + 1 < bytes.length;
    var has2 = i + 2 < bytes.length;
    var b1 = has1 ? bytes[i + 1] : 0;
    var b2 = has2 ? bytes[i + 2] : 0;
    out += B64_ALPHABET.charAt(b0 >> 2);
    out += B64_ALPHABET.charAt(((b0 & 3) << 4) | (b1 >> 4));
    out += has1 ? B64_ALPHABET.charAt(((b1 & 15) << 2) | (b2 >> 6)) : "=";
    out += has2 ? B64_ALPHABET.charAt(b2 & 63) : "=";
  }
  return out;
}

// slskd serializes [Flags] enums as comma-separated strings via
// JsonStringEnumConverter, e.g. "Connected, LoggedIn" / "Completed, Succeeded".
// Always flag-test; never equality-compare.
function hasFlag(stateString, flag) {
  if (!stateString || !flag) return false;
  var parts = String(stateString).split(",");
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].trim().toLowerCase() === String(flag).trim().toLowerCase()) return true;
  }
  return false;
}

function basenameRemote(p) {
  var s = String(p == null ? "" : p);
  var i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i >= 0 ? s.slice(i + 1) : s;
}

function dirnameRemote(p) {
  var s = String(p == null ? "" : p);
  var i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i >= 0 ? s.slice(0, i) : "";
}

function extOf(nameOrPath) {
  var base = basenameRemote(nameOrPath);
  var m = base.match(/\.([A-Za-z0-9]{1,5})$/);
  return m ? m[1].toLowerCase() : "";
}

function fileExtension(file) {
  var e = String(file && file.extension ? file.extension : "").toLowerCase();
  e = e.replace(/^\./, "");
  return e || extOf(file && file.filename);
}

// lossless(0) > high(1) > unknown(2) > medium(3) > low(4)
function qualityTier(file) {
  var ext = fileExtension(file);
  if (LOSSLESS_EXTS.indexOf(ext) >= 0) return T_LOSSLESS;
  if (file && file.bitDepth != null && file.bitDepth > 0) return T_LOSSLESS;
  var br = file ? file.bitRate : null;
  if (br == null) return T_UNKNOWN;
  // VBR is worth more than its nominal rate suggests (V0 ~245, V2 ~190).
  if (file.isVariableBitRate && br >= 192) return T_HIGH;
  if (br >= 256) return T_HIGH;
  if (br >= 128) return T_MEDIUM;
  return T_LOW;
}

function availabilityTier(response) {
  if (response && response.hasFreeUploadSlot) return 0;
  var q = response && response.queueLength != null ? response.queueLength : 0;
  return q <= 10 ? 1 : 2;
}

function parsePreferredFormats(raw) {
  if (!raw) return null;
  var list = String(raw).toLowerCase().split(",")
    .map(function (s) { return s.trim().replace(/^\./, ""); })
    .filter(function (s) { return !!s; });
  return list.length ? list : null;
}

function formatRank(ext, preferred) {
  if (!preferred) return 0;
  var i = preferred.indexOf(ext);
  return i >= 0 ? i : preferred.length;
}

// Pure: would a Windows slskd refuse to download this file? slskd writes a
// partial download to <incomplete>\<username>\<the sharer's folders>\<file> and
// then insists that path is already normalized (`Path.GetFullPath(p) == p`).
// On Windows GetFullPath trims a trailing dot or space off every segment, so a
// sharer named "john." or a folder called "R.E.M." or "Vol. 2 " fails every
// time with "Only absolute paths may be specified (Parameter 'filename')".
// slskd's sanitizer turns invalid characters into "_" and "."/".." into "_"
// first, so neither of those trips it; only a trailing dot/space survives.
function windowsCantStore(username, filename) {
  var segs = [String(username || "")].concat(String(filename || "").split(/[\\\/]/));
  for (var i = 0; i < segs.length; i++) {
    var s = segs[i];
    if (!s || s === "." || s === "..") continue;
    var last = s.charAt(s.length - 1);
    if (last === "." || last === " ") return true;
  }
  return false;
}

// The same slskd failure as `windowsCantStore`, read back off a transfer that
// hit it (a result listed before the check, or another client's download).
function isWindowsPathBug(exception) {
  return /Only absolute paths may be specified/.test(String(exception || ""));
}

// Pure: is this a Windows absolute path with a forward slash in it? slskd
// builds every partial download under directories.incomplete and demands the
// result already be normalized, so a configured folder like
// `C:\Users\x\Music\Soulseek/.incomplete` (what an older slskd setup wrote before it normalized paths)
// fails EVERY download with the same "Only absolute paths" error as
// `windowsCantStore` — no source is at fault and none will work.
function windowsPathNotNormalized(p) {
  var s = String(p == null ? "" : p);
  return (/^[A-Za-z]:[\\\/]/.test(s) || /^\\\\/.test(s)) && s.indexOf("/") >= 0;
}

// The slskd folder that makes every Windows download fail, or null.
function misconfiguredSlskdDir(downloads, incomplete) {
  if (windowsPathNotNormalized(incomplete)) return incomplete;
  if (windowsPathNotNormalized(downloads)) return downloads;
  return null;
}

var MISCONFIGURED_DIR_TEXT = "slskd's download folder mixes / and \\, so slskd on Windows rejects every download. " +
  "Fix directories in slskd.yml (or slskd's settings page) and restart slskd";

// responses: slskd Search.responses[]. Availability lives on the response,
// quality on the file, so the unit of ranking is a flattened (response, file).
function rankResults(responses, prefs) {
  prefs = prefs || {};
  var preferred = prefs.preferredFormats || null;
  var known = prefs.knownDurationSecs != null ? prefs.knownDurationSecs : null;
  var maxQueue = prefs.maxQueue != null ? prefs.maxQueue : null;
  var tierOf = typeof prefs.sharerTier === "function" ? prefs.sharerTier : null;
  var out = [];
  var seen = {};

  var list = responses || [];
  for (var r = 0; r < list.length; r++) {
    var resp = list[r] || {};
    if (maxQueue != null && (resp.queueLength || 0) > maxQueue) continue;
    // Files from `lockedFiles` are NOT downloadable. `file.isLocked` is never
    // assigned by slskd's mapper (it deserializes false even for locked files),
    // so collection membership is the only trustworthy signal.
    var files = resp.files || [];
    var avail = availabilityTier(resp);
    for (var f = 0; f < files.length; f++) {
      var file = files[f] || {};
      if (!file.filename) continue;
      if (!file.size) continue;
      var ext = fileExtension(file);
      if (AUDIO_EXTS.indexOf(ext) < 0) continue;
      if (known != null && file.length != null && Math.abs(file.length - known) > 5) continue;
      if (prefs.windowsDaemon && windowsCantStore(resp.username || "", file.filename)) continue;

      var key = (resp.username || "") + KEY_SEP + file.filename;
      if (seen[key]) continue;
      seen[key] = 1;

      out.push({
        username: resp.username || "",
        filename: file.filename,
        size: file.size,
        length: file.length != null ? file.length : null,
        bitRate: file.bitRate != null ? file.bitRate : null,
        bitDepth: file.bitDepth != null ? file.bitDepth : null,
        sampleRate: file.sampleRate != null ? file.sampleRate : null,
        isVariableBitRate: !!file.isVariableBitRate,
        extension: ext,
        hasFreeUploadSlot: !!resp.hasFreeUploadSlot,
        queueLength: resp.queueLength != null ? resp.queueLength : 0,
        uploadSpeed: resp.uploadSpeed != null ? resp.uploadSpeed : 0,
        qualityTier: qualityTier(file),
        availabilityTier: avail,
        sharerTier: tierOf ? tierOf(resp.username || "") : 1,
        formatRank: formatRank(ext, preferred)
      });
    }
  }

  out.sort(function (a, b) {
    if (a.formatRank !== b.formatRank) return a.formatRank - b.formatRank;
    if (a.qualityTier !== b.qualityTier) return a.qualityTier - b.qualityTier;
    // A sharer who has delivered before beats one who only advertises a slot.
    if (a.sharerTier !== b.sharerTier) return a.sharerTier - b.sharerTier;
    if (a.availabilityTier !== b.availabilityTier) return a.availabilityTier - b.availabilityTier;
    if (a.uploadSpeed !== b.uploadSpeed) return b.uploadSpeed - a.uploadSpeed;
    if (a.queueLength !== b.queueLength) return a.queueLength - b.queueLength;
    if (a.username !== b.username) return a.username < b.username ? -1 : 1;
    if (a.filename !== b.filename) return a.filename < b.filename ? -1 : 1;
    return 0;
  });
  return out;
}

// A result row's title: the filename, nothing else. The identifying context
// (who has it, which folder) goes on the second line — see `resultSource`.
function resultLabel(c) {
  return c ? basenameRemote(c.filename) : "";
}

// The second line: "user · folder". Two files with the same name are the norm on
// Soulseek (everyone shares the same album), so the sharer and the folder they
// keep it in are what actually tell two rows apart. The remote folder path is
// shown whole, not just its last segment — "Discography" says nothing without
// the "Rage Against The Machine" above it — and with forward slashes, since a
// Soulseek path is not a path on this machine.
function resultSource(c) {
  if (!c) return "";
  var folder = dirnameRemote(c.filename).replace(/\\/g, "/");
  if (!c.username) return folder;
  return folder ? c.username + " · " + folder : c.username;
}

// Soulseek users mostly share whole albums, so folders are a first-class result.
function groupByFolder(candidates) {
  var order = [];
  var map = {};
  var list = candidates || [];
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    var folder = dirnameRemote(c.filename);
    var key = c.username + KEY_SEP + folder;
    if (!map[key]) {
      map[key] = {
        key: key,
        username: c.username,
        folder: folder,
        name: basenameRemote(folder) || folder,
        files: [],
        totalSize: 0,
        hasFreeUploadSlot: c.hasFreeUploadSlot,
        queueLength: c.queueLength,
        uploadSpeed: c.uploadSpeed,
        availabilityTier: c.availabilityTier,
        bestQualityTier: c.qualityTier
      };
      order.push(map[key]);
    }
    var g = map[key];
    g.files.push(c);
    g.totalSize += c.size || 0;
    if (c.qualityTier < g.bestQualityTier) g.bestQualityTier = c.qualityTier;
  }
  // `candidates` arrives ranked, so first-seen order is already best-first.
  return order;
}

function parseTrackMeta(remotePath) {
  var base = basenameRemote(remotePath);
  var stem = base.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  var folder = basenameRemote(dirnameRemote(remotePath));
  var trackNumber = null;

  var m = stem.match(/^\s*(\d{1,3})\s*[-._)\]]\s*(.+)$/);
  if (m) { trackNumber = parseInt(m[1], 10); stem = m[2]; }
  stem = stem.replace(/_/g, " ").replace(/\s+/g, " ").trim();

  var artist = null;
  var title = stem;
  var parts = stem.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    artist = parts[0].trim();
    title = parts.slice(1).join(" - ").trim();
  }

  var album = null;
  if (folder) {
    var fparts = folder.replace(/_/g, " ").split(/\s+[-–—]\s+/);
    if (fparts.length >= 2) {
      if (!artist) artist = fparts[0].trim();
      album = fparts.slice(1).join(" - ").trim();
    } else {
      album = folder.trim();
    }
    album = album.replace(/\s*[\(\[]\s*\d{4}\s*[\)\]]\s*$/, "").trim();
  }

  return {
    trackNumber: trackNumber,
    artist: artist || null,
    title: title || base,
    album: album || null
  };
}

// PluginContextMenuTarget carries different fields per kind: an artist target has
// only artistName, an album target has albumTitle + artistName, a track target
// has title + artistName. Reading `title` alone would send an empty query for
// artist and album rows.
function searchQueryForTarget(target) {
  var t = target || {};
  var parts;
  if (t.kind === "artist") parts = [t.artistName || t.title];
  else if (t.kind === "album") parts = [t.artistName, t.albumTitle || t.title];
  else parts = [t.artistName, t.title];
  return parts.filter(Boolean).join(" ").trim();
}

function hostOf(url) {
  var m = String(url == null ? "" : url).match(/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/([^\/?#]+)/);
  if (!m) return null;
  var hostport = m[1];
  var at = hostport.lastIndexOf("@");
  if (at >= 0) hostport = hostport.slice(at + 1);
  if (hostport.charAt(0) === "[") {
    var end = hostport.indexOf("]");
    return end > 0 ? hostport.slice(1, end) : hostport;
  }
  var colon = hostport.indexOf(":");
  return colon >= 0 ? hostport.slice(0, colon) : hostport;
}

// The `file://` design needs a path the HOST process can read. Plugins can't stat
// arbitrary host paths, so: heuristic from the URL, overridable by the user, and
// self-corrected on the first copy failure.
function detectTier(url, override) {
  if (override === "local" || override === "remote") return override;
  var host = (hostOf(url) || "").toLowerCase();
  if (!host) return "remote";
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") return "local";
  if (/^127\./.test(host)) return "local";
  return "remote";
}

// probe: { kind: "unconfigured"|"unreachable"|"unauthorized"|"ok", serverState?, ... }
function nextReadiness(probe, prev) {
  var prevState = prev && prev.state ? prev.state : null;
  var state;
  var detail = null;

  if (!probe || probe.kind === "unconfigured") {
    state = "unconfigured";
  } else if (probe.kind === "unreachable") {
    state = "unreachable";
    detail = probe.detail || null;
  } else if (probe.kind === "unauthorized") {
    state = "unauthorized";
  } else {
    // slskd exposes computed booleans (isLoggedIn/isConnecting/…) alongside the
    // raw flags enum. Prefer them — verified against 0.26.0 — but keep the flag
    // parsing as a fallback in case an older/newer build omits them.
    var s = probe.serverState || "";
    var loggedIn = probe.isLoggedIn != null ? !!probe.isLoggedIn : hasFlag(s, "LoggedIn");
    var moving = probe.isTransitioning != null
      ? !!probe.isTransitioning
      : (hasFlag(s, "Connecting") || hasFlag(s, "LoggingIn"));
    if (loggedIn) state = "ready";
    else if (moving) state = "connecting";
    else state = "disconnected";
  }

  // No toast for any of these: a state that isn't ready is the banner at the
  // top of the view (`readinessBanner`) and the sidebar dot, like yt-dlp's
  // missing-binary banner. A toast at every launch without slskd was the
  // complaint that replaced it.
  return {
    state: state,
    detail: detail,
    username: probe && probe.username != null ? probe.username : null,
    version: probe && probe.version != null ? probe.version : null,
    shareCount: probe && probe.shareCount != null ? probe.shareCount : null,
    changed: state !== prevState
  };
}

// Files API `fullName` is relativized to the directory that was ASKED for, not
// to the downloads root: the root listing answers "viboplr/b1/Track.mp3" while a
// targeted listing of `viboplr/b1` answers "Track.mp3" for the same file. Every
// fullName is rebased onto the root (see `rebaseListing`) before it reaches
// here, so this only ever has to prepend directories.downloads.
function absolutePath(downloadsRoot, fullName) {
  if (!downloadsRoot || !fullName) return null;
  var root = String(downloadsRoot).replace(/[\/\\]+$/, "");
  var windows = root.indexOf("\\") >= 0 || /^[A-Za-z]:$/.test(root.slice(0, 2));
  var sep = windows ? "\\" : "/";
  var rel = String(fullName).replace(/^[\/\\]+/, "");
  rel = windows ? rel.replace(/\//g, "\\") : rel.replace(/\\/g, "/");
  return root + sep + rel;
}

// Rebase a TARGETED listing's `fullName`s onto the downloads root, so a listing
// means the same thing whichever endpoint produced it. Idempotent: a name that
// already carries the prefix (a root listing's, or a future slskd that changes
// its mind) is left alone.
function rebaseListing(files, destination) {
  var dir = String(destination || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  var list = files || [];
  if (!dir) return list;
  var prefix = dir + "/";
  var lower = prefix.toLowerCase();
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var f = list[i];
    var full = String((f && f.fullName) || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!full || full.toLowerCase().indexOf(lower) === 0) { out.push(f); continue; }
    out.push({
      name: f.name,
      fullName: prefix + full,
      length: f.length,
      attributes: f.attributes,
      createdAt: f.createdAt,
      modifiedAt: f.modifiedAt
    });
  }
  return out;
}

// Is `filePath` inside `root`? Case-insensitive for a Windows root, with the
// same separator normalising as `collectionForPath`.
function pathIsUnder(root, filePath) {
  var base = String(root || "").replace(/\\/g, "/").replace(/\/+$/, "");
  var path = String(filePath || "").replace(/\\/g, "/");
  if (!base || !path) return false;
  var win = isWindowsPath(root);
  var subject = win ? path.toLowerCase() : path;
  var needle = win ? base.toLowerCase() : base;
  if (subject.indexOf(needle) !== 0) return false;
  return subject.charAt(needle.length) === "/";
}

// Transfers carry no local path, and a conflict strategy may have renamed the
// file, so match the directory listing by size first, then basename. Ambiguous
// with no name match => null (better than importing the wrong file).
function matchFile(transfer, files) {
  if (!files || !files.length) return null;
  var want = basenameRemote(transfer && transfer.filename);
  var sized = [];
  for (var i = 0; i < files.length; i++) {
    if (transfer && transfer.size && files[i].length === transfer.size) sized.push(files[i]);
  }
  var pool = sized.length ? sized : files;
  for (var j = 0; j < pool.length; j++) {
    if (pool[j].name === want) return pool[j];
  }
  return sized.length === 1 ? sized[0] : null;
}

// parseUrlScheme does a raw url.substring(7) with NO decoding, so playback needs
// the path verbatim — encoding it would break every filename with a space.
function fileUrlForPlayback(absPath) {
  return absPath ? "file://" + absPath : null;
}

// download_file percent-DEcodes before copying, so a literal '%' must be escaped
// or the copy targets the wrong path. Everything else round-trips unchanged.
function fileUrlForDownload(absPath) {
  return absPath ? "file://" + String(absPath).replace(/%/g, "%25") : null;
}

function isWindowsPath(p) {
  var s = String(p == null ? "" : p);
  return /^[A-Za-z]:/.test(s) || s.indexOf("\\") >= 0;
}

// The collection whose root contains `filePath` — longest root wins, so a
// nested collection beats its parent. Case-insensitive on Windows only. Same
// contract as the qBittorrent plugin's helper of the same name, so the two
// plugins agree about "is this file in the library".
function collectionForPath(filePath, collections) {
  var path = String(filePath || "").replace(/\\/g, "/");
  if (!path) return null;
  var best = null;
  var bestLen = -1;
  var list = collections || [];
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    var root = String((c && c.path) || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (!root) continue;
    var win = isWindowsPath(root);
    var subject = win ? path.toLowerCase() : path;
    var needle = win ? root.toLowerCase() : root;
    if (subject.indexOf(needle) !== 0) continue;
    var nextChar = subject.charAt(needle.length);
    if (nextChar !== "" && nextChar !== "/") continue;
    if (needle.length > bestLen) { best = c; bestLen = needle.length; }
  }
  return best;
}

// Embedded tags win field by field; the filename parse fills the gaps. Per
// field, not all-or-nothing: a file tagged with an artist but no track number
// should still take its number off the "03 - " in front. `tags` is one entry of
// api.system.readAudioTags' answer (or null for an unreadable file).
function mergeMeta(parsed, tags) {
  var p = parsed || {};
  var t = tags || {};
  var pick = function (a, b) {
    if (a != null && String(a).trim() !== "") return typeof a === "string" ? a.trim() : a;
    return b != null && b !== "" ? b : null;
  };
  return {
    title: pick(t.title, p.title),
    artist: pick(t.artist, p.artist),
    album: pick(t.album, p.album),
    albumArtist: pick(t.album_artist, null),
    trackNumber: pick(t.track_number, p.trackNumber),
    year: pick(t.year, null),
    genre: pick(t.genre, null),
    durationSecs: pick(t.duration_secs, p.durationSecs)
  };
}

// Result ids the assistant passes back to `download`. Deterministic from the
// (user, filename) pair — a fresh search for the same query yields the same id
// for the same file — and route-safe (no spaces, backslashes or slashes).
function candidateId(c) {
  return "c" + hashString((c && c.username) + "\u0000" + (c && c.filename));
}

function hashString(s) {
  var h = 5381;
  var str = String(s == null ? "" : s);
  for (var i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

// 0..1, or null when slskd hasn't reported a size.
function transferProgress(t) {
  if (!t || !t.size) return null;
  var v = (t.bytesTransferred || 0) / t.size;
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec) return "";
  return formatBytes(bytesPerSec) + "/s";
}

// One line under a transfer's name, phase first. Reads the same way down the
// column so a glance at the Downloads tab tells the story without opening
// anything — the qBittorrent plugin's torrent rows set the pattern.
function transferSubtitle(t, rec, currentTier) {
  var phase = transferPhase(t && t.state);
  var bits = [];
  var user = (t && t.username) || "?";
  if (phase === "downloading" || phase === "starting") {
    var pct = transferProgress(t);
    bits.push(pct == null ? "Downloading" : "Downloading " + Math.round(pct * 100) + "%");
    bits.push(formatBytes(t.bytesTransferred) + " of " + formatBytes(t.size));
    if (t.averageSpeed) bits.push("↓ " + formatSpeed(t.averageSpeed));
    bits.push("from " + user);
  } else if (phase === "queued" || phase === "requested") {
    bits.push(t.placeInQueue != null
      ? "Waiting in " + user + "'s queue · position " + t.placeInQueue
      : "Queued with " + user);
    var waited = waitedFor(t, Date.now());
    if (waited) bits.push(waited);
    bits.push(formatBytes(t.size));
  } else if (phase === "succeeded") {
    bits.push("Finished");
    bits.push(formatBytes(t.size));
    bits.push("from " + user);
    if (currentTier === "local" && !(rec && rec.resolvedPath)) bits.push("locating file…");
  } else if (phase === "failed") {
    bits.push(!isWindowsPathBug(t.exception)
      ? "Failed — " + plainTransferError(t.exception, user)
      : misconfiguredSlskdDir(downloadsDir, incompleteDir)
        ? "Failed — " + MISCONFIGURED_DIR_TEXT
        : "Failed — slskd on Windows can't save a file whose folder or sharer name ends in a dot or space; try another source");
    if (t.attempts) bits.push("attempt " + t.attempts);
    bits.push("from " + user);
  } else if (phase === "cancelled") {
    bits.push("Cancelled");
    bits.push("from " + user);
  } else {
    bits.push("Pending");
    bits.push("from " + user);
  }
  return bits.filter(Boolean).join("  ·  ");
}

// Pure: slskd's failure text in the words a user would use, with what to do
// about it implied (the row's first action is Another source). The raw text
// stays for anything not recognised — an unknown message is still a clue.
function plainTransferError(exception, user) {
  var e = String(exception || "");
  var who = user || "the sharer";
  if (!e) return "the transfer stopped";
  if (/file not shared/i.test(e)) return who + " no longer shares this file";
  if (/(too many|queue (is )?full|limit)/i.test(e)) return who + "'s queue is full";
  if (/banned|not allowed|denied/i.test(e)) return who + " isn't sending to you";
  if (/offline|unreachable|connection (refused|reset)|no route|failed to connect|timed? ?out/i.test(e)) return who + " went offline or can't be reached";
  if (/cancel/i.test(e)) return who + " cancelled it";
  return e;
}

// Pure: "waiting 14 min" from slskd's enqueue/request timestamp, or "".
function waitedFor(t, now) {
  var at = Date.parse((t && (t.enqueuedAt || t.requestedAt)) || "");
  if (!isFinite(at)) return "";
  var m = Math.round(Math.max(0, now - at) / 60000);
  if (m < 1) return "";
  if (m < 60) return "waiting " + m + " min";
  var h = Math.floor(m / 60);
  return "waiting " + (h < 24 ? h + " h" : Math.floor(h / 24) + " d");
}

// Which of the list's declared actions a transfer row shows. Only what would
// do something to THIS transfer: Play / Add to library need a finished, located
// file; Retry / Another source need a failure; Remove is for anything at rest.
function transferRowActions(t, rec, currentTier) {
  var phase = transferPhase(t && t.state);
  var ids = [];
  if (phase === "succeeded") {
    if (currentTier === "local" && rec && rec.resolvedPath) {
      ids.push("play-transfer");
      // A file fetched as an upgrade has one obvious destination — the library
      // row it was fetched for — so that comes before the generic copy.
      if (rec.upgrade) ids.push("replace-transfer");
      ids.push("import-transfer");
    }
    ids.push("remove-transfer");
  } else if (phase === "failed") {
    ids.push("retry-transfer");
    ids.push("another-source");
    ids.push("remove-transfer");
  } else if (phase === "cancelled") {
    ids.push("retry-transfer");
    ids.push("remove-transfer");
  } else if (phase === "requested" || (phase === "queued" && hasFlag(t.state, "Remotely"))) {
    // Waiting on a stranger, maybe for hours: moving on is a real option.
    // (Queued *locally* is slskd's own queue, which another sharer won't skip.)
    ids.push("another-source");
    ids.push("cancel-transfer");
  } else {
    ids.push("cancel-transfer");
  }
  return ids;
}

// Row ids out of a list action payload: a hover button sends `itemId`, the
// selection toolbar sends `selectedIds`, a plain button sends `data.ref`.
function rowIds(data) {
  var out = [];
  var ids = data && data.selectedIds;
  if (ids && ids.length) {
    for (var i = 0; i < ids.length; i++) {
      if (ids[i] != null && ids[i] !== "") out.push(String(ids[i]));
    }
  }
  if (!out.length && data && data.itemId != null && data.itemId !== "") out.push(String(data.itemId));
  if (!out.length && data && data.ref != null && data.ref !== "") out.push(String(data.ref));
  return out;
}

// Kept-file row ids carry a "k:" prefix so they can't collide with a transfer
// key in a list that reuses the transfer actions.
function keptKeys(data) {
  return rowIds(data).map(function (id) { return id.indexOf("k:") === 0 ? id.slice(2) : id; });
}

// The transfer actions (Play / Retry / Cancel) are offered on search rows
// (`f:`) and an open folder's rows (`o:`) too, once a file was queued from
// there. A raw key that is itself known is never stripped — a username may
// begin with "f:".
function transferKeys(data) {
  return rowIds(data).map(function (id) {
    if (tracked[id] || transferByKey(id)) return id;
    var p = id.slice(0, 2);
    return (p === "f:" || p === "o:") && id.indexOf(KEY_SEP) > 2 ? id.slice(2) : id;
  });
}

function transferPhase(stateString) {
  var s = stateString || "";
  if (hasFlag(s, "Succeeded")) return "succeeded";
  if (hasFlag(s, "Cancelled")) return "cancelled";
  if (hasFlag(s, "Errored") || hasFlag(s, "TimedOut") || hasFlag(s, "Rejected")) return "failed";
  if (hasFlag(s, "InProgress")) return "downloading";
  if (hasFlag(s, "Initializing")) return "starting";
  if (hasFlag(s, "Queued")) return "queued";
  if (hasFlag(s, "Requested")) return "requested";
  if (hasFlag(s, "Completed")) return "failed";
  return "pending";
}

// The label is attacker-controlled (it comes from a remote peer's folder name),
// so this must not be able to produce a traversing segment. Mapping separators
// to '_' is not enough on its own — '..' survives that, and slskd would reject
// the whole enqueue with a confusing error.
function sanitizeSegment(s) {
  var out = String(s == null ? "" : s)
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/\.{2,}/g, "_")
    .slice(0, 48)
    .replace(/^[._-]+|[._-]+$/g, "");
  return out || "x";
}

// Standard base64 can contain '/', which would break the {base64Subdirectory}
// route segment. We control the destination, so pick one that encodes cleanly;
// callers fall back to a filtered root listing if none does.
function safeDestination(seq, label, subdir) {
  var stem = DEST_ROOT + "/" + (subdir ? sanitizeSegment(subdir) + "/" : "") + seq + (label ? "-" + sanitizeSegment(label) : "");
  for (var n = 0; n < 32; n++) {
    var dest = stem + (n ? "-" + n : "");
    var b64 = b64encode(dest);
    if (b64.indexOf("/") < 0) return { destination: dest, b64: b64 };
  }
  return { destination: stem, b64: null };
}

function formatBytes(n) {
  if (n == null) return "";
  var units = ["B", "KB", "MB", "GB"];
  var v = Number(n);
  var i = 0;
  while (v >= 1024 && i < units.length - 1) { v = v / 1024; i++; }
  return (i === 0 ? Math.round(v) : (v < 10 ? v.toFixed(1) : Math.round(v))) + " " + units[i];
}

// Thousands separators without toLocaleString (absent from the sandbox).
function formatCount(n) {
  var s = String(Math.floor(Math.abs(Number(n) || 0)));
  var out = "";
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s.charAt(i);
  }
  return out;
}

function formatDurationSecs(s) {
  if (s == null || isNaN(s)) return "";
  var t = Math.max(0, Math.round(s));
  var m = Math.floor(t / 60), sec = t % 60;
  if (m < 60) return m + ":" + (sec < 10 ? "0" : "") + sec;
  var h = Math.floor(m / 60);
  return h + ":" + ((m % 60) < 10 ? "0" : "") + (m % 60) + ":" + (sec < 10 ? "0" : "") + sec;
}

function qualityLabel(c) {
  if (!c) return "";
  var ext = (c.extension || "").toUpperCase();
  if (c.qualityTier === T_LOSSLESS) {
    var bits = [];
    if (c.sampleRate) bits.push(Math.round(c.sampleRate / 1000) + "kHz");
    if (c.bitDepth) bits.push(c.bitDepth + "bit");
    return ext + (bits.length ? " " + bits.join("/") : "");
  }
  if (c.bitRate) return ext + " " + c.bitRate + (c.isVariableBitRate ? "kbps VBR" : "kbps");
  return ext || "unknown";
}

// ---------------------------------------------------------------------------
// Format tiles — pure
// ---------------------------------------------------------------------------
// The thumbnail on a row whose cover would only be a guess (search results,
// upgrade sources, a download still in flight): the container in big letters,
// the number that decides quality under it, tinted by tier. The format is what
// the user chooses by there, and the name-based cover lookup is held to
// `artwork: "cached"` on purpose, so most of those rows were blank squares.
//
// A data: URI, which the host renders as-is in rows and cards. An SVG inside
// an <img> can't read the skin's variables, so the fill is translucent over
// whatever is behind it and the colour is only a hint — the text carries the
// meaning. Percent-encoded rather than base64 (cheaper than the hand-rolled
// b64encode, and shorter) and cached per (label, detail, tier): Search
// re-renders on every poll tick with up to MAX_RESULT_FILES rows.
var TILE_COLORS = {
  hires: "#b98cff",     // reported 24-bit, or above 48 kHz
  lossless: "#53a8ff",
  high: "#3fbfa6",      // T_HIGH: 256+ kbps, or VBR from 192
  low: "#e0a040",       // T_MEDIUM / T_LOW
  unknown: "#9a9cb0"    // nothing reported, or a folder of mixed tiers
};
var tileCache = {};

function tileTier(c) {
  if (!c) return "unknown";
  var t = c.qualityTier != null ? c.qualityTier : qualityTier(c);
  if (t === T_LOSSLESS) return (c.bitDepth || 0) > 16 || (c.sampleRate || 0) > 48000 ? "hires" : "lossless";
  if (t === T_HIGH) return "high";
  if (t === T_MEDIUM || t === T_LOW) return "low";
  return "unknown";
}

// "24/96", "16/44" for lossless; "320", or "~245" for VBR; "" when unreported.
function tileDetail(c) {
  if (!c) return "";
  var tier = tileTier(c);
  if (tier === "lossless" || tier === "hires") {
    if (c.bitDepth && c.sampleRate) return c.bitDepth + "/" + Math.floor(c.sampleRate / 1000);
    if (c.sampleRate) return Math.floor(c.sampleRate / 1000) + "k";
    return c.bitDepth ? c.bitDepth + "-bit" : "";
  }
  return c.bitRate ? (c.isVariableBitRate ? "~" : "") + c.bitRate : "";
}

function formatTile(label, detail, tier) {
  var key = label + "|" + detail + "|" + tier;
  if (tileCache[key]) return tileCache[key];
  var color = TILE_COLORS[tier] || TILE_COLORS.unknown;
  var font = "font-family='-apple-system,Segoe UI,sans-serif'";
  var svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'>" +
    "<rect width='40' height='40' rx='6' fill='" + color + "' fill-opacity='.18'/>" +
    "<text x='20' y='" + (detail ? "19.5" : "24") + "' text-anchor='middle' " + font +
    " font-size='" + (label.length > 4 ? "8.5" : "10.5") + "' font-weight='700' fill='" + color + "'>" + label + "</text>" +
    (detail ? "<text x='20' y='31' text-anchor='middle' " + font + " font-size='7.5' fill='" + color + "' fill-opacity='.85'>" + detail + "</text>" : "") +
    "</svg>";
  return (tileCache[key] = "data:image/svg+xml;utf8," + encodeURIComponent(svg));
}

// Labels are an extension, so only [A-Z0-9]; anything else would be markup.
function tileLabel(c) {
  var ext = String(fileExtension(c) || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
  return ext || "?";
}

function fileTile(c) {
  return formatTile(tileLabel(c), tileDetail(c), tileTier(c));
}

// A folder's main container by bytes, described by that container's
// best-ranked file (`files` arrive ranked). A folder that is a real mix —
// lossless and lossy each a fifth or more of it — has no main file, since one
// format would misdescribe what "download folder" fetches. Returns
// { file, label } with `file` null for a mix (label "MIX") or an empty folder.
function folderMain(files) {
  var list = files || [];
  if (!list.length) return { file: null, label: "?" };
  var bytes = {}, order = [], lossless = 0, lossy = 0, total = 0;
  for (var i = 0; i < list.length; i++) {
    var f = list[i], label = tileLabel(f), size = f.size || 0;
    if (bytes[label] == null) { bytes[label] = 0; order.push(label); }
    bytes[label] += size;
    total += size;
    if ((f.qualityTier != null ? f.qualityTier : qualityTier(f)) === T_LOSSLESS) lossless += size;
    else lossy += size;
  }
  if (total && lossless / total >= 0.2 && lossy / total >= 0.2) return { file: null, label: "MIX" };
  var main = order[0];
  for (var j = 1; j < order.length; j++) if (bytes[order[j]] > bytes[main]) main = order[j];
  for (var k = 0; k < list.length; k++) if (tileLabel(list[k]) === main) return { file: list[k], label: main };
  return { file: null, label: main };
}

// A folder's tile: its main container (folderMain), MIX for a real mix.
function folderTile(files) {
  var m = folderMain(files);
  return m.file ? fileTile(m.file) : formatTile(m.label, "", "unknown");
}

// Pure: the Quality cell of a folder row — the main file's label, "Mixed"
// for a lossless/lossy mix, or "" when nothing says.
function folderQualityLabel(files) {
  var m = folderMain(files);
  if (m.file) { var q = qualityLabel(m.file); return q === "unknown" ? "" : q; }
  return m.label === "MIX" ? "Mixed" : "";
}

// Pure: the advertised quality fields a tile needs, or null when the file
// came without them (a retry rebuilt from slskd's transfer record).
function qualitySnapshot(f) {
  if (!f || (f.bitRate == null && f.bitDepth == null && f.sampleRate == null)) return null;
  return { bitRate: f.bitRate != null ? f.bitRate : null, bitDepth: f.bitDepth != null ? f.bitDepth : null,
    sampleRate: f.sampleRate != null ? f.sampleRate : null, isVariableBitRate: !!f.isVariableBitRate };
}

// Pure: a transfer row's tile — the remote file's container plus what the
// sharer advertised for it when we queued it.
function transferTile(t, rec) {
  var q = (rec && rec.quality) || {};
  return fileTile({ filename: t && t.filename, bitRate: q.bitRate, bitDepth: q.bitDepth,
    sampleRate: q.sampleRate, isVariableBitRate: q.isVariableBitRate });
}

function availabilityLabel(c) {
  if (c.hasFreeUploadSlot) return "free slot";
  if (!c.queueLength) return "queued";
  return "queue " + c.queueLength;
}

// ---------------------------------------------------------------------------
// Sharer ledger — pure
// ---------------------------------------------------------------------------
// A delivery is worth two strikes: one bad day should not bury a sharer who
// has come through before, but a sharer who only ever fails sinks.
function sharerScore(st) {
  if (!st) return 0;
  return (st.delivered || 0) * 2 - (st.failed || 0) - (st.stalled || 0);
}

// 0 = proven (has delivered, net positive) · 1 = unknown · 2 = burned.
function sharerTier(st) {
  var sc = sharerScore(st);
  if (sc > 0) return 0;
  if (sc < 0) return 2;
  return 1;
}

function sharerLabel(st) {
  var tier = sharerTier(st);
  if (tier === 0) return "delivered " + (st.delivered === 1 ? "once" : st.delivered + "×");
  if (tier === 2) return "unreliable";
  return "";
}

// Record one outcome for a sharer. `event` is "delivered" | "failed" |
// "stalled"; anything else is ignored so callers can pass a drop reason through.
function noteSharer(ledger, username, event, bytes) {
  if (!username || !ledger) return ledger;
  if (event !== "delivered" && event !== "failed" && event !== "stalled") return ledger;
  var st = ledger[username] || { delivered: 0, failed: 0, stalled: 0, bytes: 0, lastAt: null };
  st[event] = (st[event] || 0) + 1;
  if (event === "delivered" && bytes) st.bytes = (st.bytes || 0) + bytes;
  st.lastAt = Date.now();
  ledger[username] = st;
  return ledger;
}

function ledgerTotals(ledger) {
  var keys = Object.keys(ledger || {});
  var proven = 0, burned = 0;
  for (var i = 0; i < keys.length; i++) {
    var t = sharerTier(ledger[keys[i]]);
    if (t === 0) proven++;
    else if (t === 2) burned++;
  }
  return { seen: keys.length, proven: proven, burned: burned };
}


// ---------------------------------------------------------------------------
// Playback fallback — pure helpers
// ---------------------------------------------------------------------------
// Lowercase, diacritics stripped, punctuation to spaces. `normalize` is a
// String method, so it is available in the sandbox where TextEncoder is not.
// Letters NFD doesn't take apart, folded to what a filename typed without them
// says: "Lágnætti" and "Lagnaetti" are the same song. Greek final sigma is its
// letter's other form.
var LETTER_FOLDS = { "æ": "ae", "ð": "d", "þ": "th", "ø": "o", "œ": "oe", "ß": "ss", "ł": "l", "đ": "d", "ı": "i", "ς": "σ" };
var LETTER_FOLD_RE = new RegExp("[" + Object.keys(LETTER_FOLDS).join("") + "]", "g");

// The matching form of a name: lowercase, accents gone, every script's letters
// kept. It once kept only a–z, which turned a Greek or Cyrillic title into
// nothing (an empty search slskd refuses) and cut "Lágnætti" to "lagn tti".
function normalizeText(s) {
  var out = String(s == null ? "" : s);
  if (typeof out.normalize === "function") out = out.normalize("NFD");
  return out
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(LETTER_FOLD_RE, function (c) { return LETTER_FOLDS[c]; })
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The searching forms. Soulseek peers match characters literally —
// "Sólstafir Lágnætti" and "solstafir lagnaetti" find different files, and
// Greek filenames are often typed without accents — so a track search tries
// its own spelling first, then the same letters without accents
// (`searchForTrack`). Never `normalizeText`'s letter folds: "σωκρατησ" would
// find no file named "Σωκρατης".
function spelledText(s, unaccented) {
  var out = String(s == null ? "" : s);
  if (typeof out.normalize === "function") out = out.normalize(unaccented ? "NFD" : "NFC");
  if (unaccented) out = out.replace(/\p{M}/gu, "");
  return out
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Words that describe an edition rather than the song. Dropped from both the
// query and the match, so "Karma Police (Remastered 2009)" finds a file called
// "Karma Police" and is not marked down for lacking the word "remastered".
var EDITION_WORDS = ["remaster", "remastered", "remastering", "version", "edit", "mono", "stereo",
  "deluxe", "explicit", "clean", "album", "single", "radio", "original", "digital", "bonus", "track",
  "anniversary", "edition", "reissue", "hd", "hq"];
var STOP_WORDS = ["the", "a", "an", "of", "and", "feat", "ft", "featuring", "vs", "with"];
// A file whose name says one of these when the requested title does not is a
// different recording of the song, not a copy of it.
var VARIANT_WORDS = ["live", "remix", "instrumental", "karaoke", "acoustic", "demo", "cover",
  "acapella", "rehearsal", "unplugged", "mix", "dub", "reprise", "medley", "tribute"];

// `spelled`: a query's words — true keeps each word as written, "unaccented"
// the same letters without accents (`spelledText`); absent, the folded
// matching form. The drop list is checked on the folded form either way, so
// "The" goes whichever way it's spelled.
function wordList(s, drop, spelled) {
  var words = (spelled ? spelledText(s, spelled === "unaccented") : normalizeText(s)).split(" ");
  var out = [];
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    if (!w) continue;
    var folded = spelled ? normalizeText(w) : w;
    if (drop && /^\d{4}$/.test(folded)) continue;
    if (drop && drop.indexOf(folded) >= 0) continue;
    out.push(w);
  }
  return out;
}

// The words of a title that identify the song: edition words, stop words and
// bare years are noise, but a title that is nothing but noise keeps its words
// rather than matching everything.
function titleWords(title, spelled) {
  var strict = wordList(title, EDITION_WORDS.concat(STOP_WORDS), spelled);
  return strict.length ? strict : wordList(title, null, spelled);
}

function artistWords(artist, spelled) {
  var strict = wordList(artist, STOP_WORDS, spelled);
  return strict.length ? strict : wordList(artist, null, spelled);
}

// ---------------------------------------------------------------------------
// Upgrade / fill-album modes (context menu)
// ---------------------------------------------------------------------------
// Two context-menu actions run an ordinary search and then read its results
// against the library: "Upgrade" hides everything that isn't better than the
// copy in hand, "Fill missing tracks" hides everything the album already has.
// Both stay interactive — the user still picks the file or folder — because a
// download asked for by hand gets a file the user chose, never a best guess
// (the same rule that keeps this plugin without a metadata download provider).

// The library row described the way a search result describes itself. The host
// stores a container and a size but no bitrate, so for a lossy file the rate is
// the size spread over the duration — within a few percent of the nominal CBR
// figure and a fair average for VBR, which is all "is this better?" needs.
function libraryQuality(track) {
  var t = track || {};
  var ext = String(t.format || extOf(t.path || "") || "").toLowerCase().replace(/^\./, "");
  var c = {
    extension: ext,
    bitRate: null,
    bitDepth: null,
    sampleRate: null,
    isVariableBitRate: false,
    size: t.file_size || null,
    length: t.duration_secs != null ? t.duration_secs : null
  };
  if (LOSSLESS_EXTS.indexOf(ext) < 0 && t.file_size > 0 && t.duration_secs > 0) {
    c.bitRate = Math.round((t.file_size * 8) / t.duration_secs / 1000);
  }
  c.qualityTier = qualityTier(c);
  return c;
}

// A result counts as an upgrade when it is a higher tier, or the same lossy
// tier at a clearly higher rate — a few percent is a re-encode of the same
// source, not an upgrade. A lossless copy is beaten only by more bits or a
// higher sample rate; the library doesn't know those for its own file, so CD
// quality is assumed. A result that reports no quality at all can't be called
// an upgrade over anything — the ranking gives such files the benefit of the
// doubt, but "upgrade" is a claim, and it needs a figure to stand on.
var UPGRADE_MIN_RATE_GAIN = 1.2;
function isUpgradeOver(candidate, current) {
  if (!candidate || !current) return false;
  if (candidate.qualityTier === T_UNKNOWN) return false;
  if (candidate.qualityTier < current.qualityTier) return true;
  if (candidate.qualityTier > current.qualityTier) return false;
  if (current.qualityTier === T_LOSSLESS) {
    return (candidate.bitDepth || 16) > 16 || (candidate.sampleRate || 44100) > 48000;
  }
  if (candidate.bitRate == null || current.bitRate == null) return false;
  return candidate.bitRate >= current.bitRate * UPGRADE_MIN_RATE_GAIN;
}

// Which owned track a Soulseek file is a copy of, or null. The filename's title
// (track number and "Artist - " prefix stripped by parseTrackMeta) is matched on
// words the way the fallback matches a request to a file, in BOTH directions so
// "Song" doesn't claim "Song Part Two", and a variant word the owned title
// lacks ("live", "remix") marks a different recording, not a copy.
function ownedTrackFor(candidate, owned) {
  var list = owned || [];
  if (!candidate || !list.length) return null;
  var fileWords = titleWords(parseTrackMeta(candidate.filename).title);
  if (!fileWords.length) return null;
  for (var i = 0; i < list.length; i++) {
    var want = titleWords(list[i].title);
    if (!want.length) continue;
    if (coverage(want, fileWords) < FALLBACK_MIN_TITLE_MATCH) continue;
    if (coverage(fileWords, want) < 0.5) continue;
    var variant = false;
    for (var v = 0; v < fileWords.length; v++) {
      if (VARIANT_WORDS.indexOf(fileWords[v]) >= 0 && want.indexOf(fileWords[v]) < 0) { variant = true; break; }
    }
    if (variant) continue;
    return list[i];
  }
  return null;
}

function missingFiles(files, owned) {
  return (files || []).filter(function (c) { return !ownedTrackFor(c, owned); });
}

// Stamp every ranked result with the mode's verdict once, so the view's filters
// and the folder cards read a flag instead of re-matching 20,000 filenames on
// every render.
function annotateForMode(ranked, mode) {
  if (!mode) return;
  for (var i = 0; i < ranked.length; i++) {
    var c = ranked[i];
    if (mode.kind === "upgrade") {
      c.better = isUpgradeOver(c, mode.current);
      c.source = upgradeSource(c, mode);
    } else if (mode.kind === "fill") {
      c.owned = !!ownedTrackFor(c, mode.owned);
    }
  }
}

// Identity of a request, for the kept-file index: what the host's `sameSong`
// keys on (title + artist), normalized the same way the matcher reads names.
function fallbackKey(title, artist) {
  return titleWords(title).join(" ") + "|" + artistWords(artist).join(" ");
}

// What to ask Soulseek for. Soulseek matches on file and folder names, and a
// name rarely carries the edition suffix a catalogue title does — so the
// parenthetical goes, and the artist comes first the way folders are laid out.
// `spelled`: true or "unaccented" for a query's own letters (see
// `wordList`); absent, the folded matching form.
function fallbackQuery(title, artist, spelled) {
  var t = String(title || "").replace(/\s*[\(\[][^\)\]]*[\)\]]\s*/g, " ");
  var words = artistWords(artist, spelled).concat(titleWords(t, spelled));
  if (!words.length) words = wordList(title, null, spelled);
  return words.join(" ");
}

// Soulseek's server keeps a list of excluded search phrases — names it was
// asked to take down — and a search containing one gets no responses at all.
// "Linkin Park Numb" answers nothing while "Meteora Numb" answers hundreds of
// files, most of them filed under "Linkin Park". So a track search that comes
// back with nothing, when it named the artist, is retried once by album +
// title, and the artist is remembered for the session so later searches go
// straight there instead of spending slskd's one search slot on a dead query.
var blockedArtists = {};

function stripParens(s) {
  return String(s || "").replace(/\s*[\(\[][^\)\]]*[\)\]]\s*/g, " ");
}

// The search for a track whose artist name Soulseek won't answer: album words
// then title words — the folder, then the file. Null without an album: the
// title alone matches too many other songs to replace a library file with.
function albumTitleQuery(title, album, spelled) {
  var albumW = titleWords(stripParens(album), spelled);
  if (!albumW.length) return null;
  var words = albumW.concat(titleWords(stripParens(title), spelled));
  return words.join(" ");
}

// Distinct, non-empty queries, in order.
function distinctQueries(list) {
  var out = [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && out.indexOf(list[i]) < 0) out.push(list[i]);
  }
  return out;
}

// "Nothing matched", said so the user looks in the right place: a blocked
// artist name is Soulseek's doing, not a missing song.
function noMatchMessage(ranked, artist, what) {
  if (ranked && ranked.artistBlocked) {
    return "Soulseek returns nothing for “" + artist + "” (a blocked search phrase); " +
      (ranked.byAlbum || ranked.albumTried ? "nothing found by album and title either" : "the track has no album to search by instead");
  }
  return "Nothing on Soulseek matched " + what;
}

function blockedArtistKey(artist) {
  return artistWords(artist).join(" ");
}

function isBlockedArtist(artist) {
  var k = blockedArtistKey(artist);
  return !!(k && blockedArtists[k]);
}

// `performSearch` for one track, trying queries in order until a peer answers:
// artist + title as spelled, then without accents, then — when those got
// no answer at all, the blocked-phrase case above — album + title the same
// two ways. A blocked artist starts at the album queries. Resolves the ranked
// list of the first query anyone answered (or the last one tried), or null
// when a search was abandoned (busy, past `until`). The list carries
// `byAlbum` — the query that answered — when it came from an album query,
// which is what tells the matchers to accept the album as the artist's
// stand-in (a folder named "Meteora" never says "Linkin Park"), and
// `artistBlocked` when every artist query came back empty, so a caller can say
// why instead of "nothing matched".
async function searchForTrack(t, prefs, onProgress, isStale, until) {
  var artistQs = distinctQueries([fallbackQuery(t.title, t.artist, true), fallbackQuery(t.title, t.artist, "unaccented")]);
  var albumQs = t.artist
    ? distinctQueries([albumTitleQuery(t.title, t.album, true), albumTitleQuery(t.title, t.album, "unaccented")])
      .filter(function (q) { return artistQs.indexOf(q) < 0; })
    : [];
  var blocked = !!(albumQs.length && isBlockedArtist(t.artist));
  var order = blocked ? albumQs.concat(artistQs) : artistQs.concat(albumQs);
  var last = null;
  var artistTried = 0;
  for (var i = 0; i < order.length; i++) {
    var q = order[i];
    var byAlbum = albumQs.indexOf(q) >= 0;
    var ranked = await performSearch(q, prefs, onProgress, isStale, until);
    if (!ranked) return ranked;
    if (byAlbum) ranked.byAlbum = q;
    // Peers answered — even with nothing downloadable, that's the answer.
    if (ranked.length || ranked.partial || ranked.responseCount) {
      if (byAlbum) ranked.artistBlocked = true;
      return ranked;
    }
    last = ranked;
    if (!byAlbum && ++artistTried === artistQs.length && t.artist && !blocked) {
      var key = blockedArtistKey(t.artist);
      if (key && albumQs.length) blockedArtists[key] = true;
      api.log("info", "search: “" + artistQs.join("” / “") + "” got no responses at all — Soulseek blocks some phrases; " +
        (albumQs.length ? "searching “" + albumQs[0] + "” instead" : "no album to search by instead"), "slskd");
    }
  }
  if (last && t.artist && artistTried === artistQs.length) {
    last.artistBlocked = true;
    last.albumTried = albumQs.length > 0;
  }
  return last;
}

function coverage(wanted, haystack) {
  if (!wanted.length) return 1;
  var hit = 0;
  for (var i = 0; i < wanted.length; i++) {
    if (haystack.indexOf(wanted[i]) >= 0) hit++;
  }
  return hit / wanted.length;
}

// How well one search result answers a request. `title` is matched against the
// file's own name, `artist` against the whole remote path (the artist is
// usually the folder, not the file). Variant words the request didn't ask for
// cost a fixed penalty each; extra words beyond that are free, because a
// filename carries a track number, a bitrate, a year.
function scoreFallbackCandidate(c, want) {
  var stem = basenameRemote(c.filename).replace(/\.[A-Za-z0-9]{1,5}$/, "");
  var stemWords = wordList(stem, null);
  var pathWords = wordList(String(c.filename || "").replace(/\\/g, " "), null);
  var titleScore = coverage(want.title, stemWords);
  var artistScore = want.artist.length ? Math.max(coverage(want.artist, pathWords), coverage(want.artist, stemWords)) : 1;
  // Results of an album + title search (the artist's own name is a blocked
  // phrase): a folder named for the album counts as the artist's — "Meteora"
  // stands in for "Linkin Park". Title, duration and the variant words still
  // have to hold, so this widens who the song is filed under, not what it is.
  if (want.album && want.album.length) artistScore = Math.max(artistScore, coverage(want.album, pathWords));
  var penalty = 0;
  var asked = want.title.concat(want.artist);
  for (var i = 0; i < VARIANT_WORDS.length; i++) {
    var v = VARIANT_WORDS[i];
    if (stemWords.indexOf(v) >= 0 && asked.indexOf(v) < 0) penalty += 0.3;
  }
  var score = titleScore * 0.65 + artistScore * 0.35 - penalty;
  return { title: titleScore, artist: artistScore, penalty: penalty, score: score };
}

// The fallback waits for the file with the user listening to silence, so by
// default a fast, sure transfer beats a better one: high-bitrate lossy comes
// before lossless (a fifth of the bytes for the same song). The user can flip
// that to "best" (lossless first, as the Search tab ranks), and a stated
// format preference overrides both, as it does everywhere else.
//
// "lossless" and "high" are filters as well as orders (see `rankFallback`):
// only lossless, or only high-bitrate lossy with MP3 first — the Upgrade
// target's options, for a listener who would rather wait or skip than hear
// anything less.
var FALLBACK_MODES = {
  fast: "Fastest start",
  best: "Best available",
  lossless: "Lossless only",
  high: "MP3 320 / V0 only"
};

function fallbackModeOf(value) {
  return FALLBACK_MODES[value] ? value : "fast";
}

function fallbackModeFilters(mode) {
  return mode === "lossless" || mode === "high";
}

function fallbackQualityRank(c, preferred, mode) {
  if (preferred && preferred.length) return c.formatRank * 10 + c.qualityTier;
  if (mode === "best" || mode === "lossless") return c.qualityTier;
  if (mode === "high") return c.extension === "mp3" ? 0 : 1;
  if (c.qualityTier === T_HIGH) return 0;
  if (c.qualityTier === T_UNKNOWN) return 1;
  if (c.qualityTier === T_LOSSLESS) return 2;
  if (c.qualityTier === T_MEDIUM) return 3;
  return 4;
}

// Ranked search results → the ones that are this song, best first. Every
// candidate carries its `match` so the Fallback tab can show why it placed
// where it did; the ones below the bar are dropped, not demoted.
// `album` is passed only for the results of an album + title search
// (`searchForTrack`'s `byAlbum`): it is then accepted in the artist's place.
function rankFallback(candidates, title, artist, preferred, mode, album) {
  var want = { title: titleWords(title), artist: artistWords(artist), album: album ? titleWords(stripParens(album)) : null };
  var out = [];
  var filtered = fallbackModeFilters(mode);
  for (var i = 0; i < (candidates || []).length; i++) {
    var c = candidates[i];
    if (filtered && !meetsQualityTarget(c, mode)) continue;
    var m = scoreFallbackCandidate(c, want);
    if (m.title < FALLBACK_MIN_TITLE_MATCH) continue;
    if (want.artist.length && m.artist < FALLBACK_MIN_ARTIST_MATCH) continue;
    if (m.score <= 0) continue;
    var copy = {};
    for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k)) copy[k] = c[k];
    copy.match = m;
    copy.fallbackRank = fallbackQualityRank(c, preferred, mode);
    if (copy.sharerTier == null) copy.sharerTier = 1;
    out.push(copy);
  }
  out.sort(function (a, b) {
    // Tenth-of-a-point buckets: a one-word difference in a long title should
    // not outrank a free upload slot.
    var sa = Math.round(a.match.score * 10), sb = Math.round(b.match.score * 10);
    if (sa !== sb) return sb - sa;
    // Proven delivery outranks an advertised free slot: the flag is
    // self-reported and was wrong for the sharer that cost a whole budget.
    if (a.sharerTier !== b.sharerTier) return a.sharerTier - b.sharerTier;
    if (a.availabilityTier !== b.availabilityTier) return a.availabilityTier - b.availabilityTier;
    if (a.fallbackRank !== b.fallbackRank) return a.fallbackRank - b.fallbackRank;
    if (a.uploadSpeed !== b.uploadSpeed) return b.uploadSpeed - a.uploadSpeed;
    if (a.queueLength !== b.queueLength) return a.queueLength - b.queueLength;
    if (a.size !== b.size) return a.size - b.size;
    return a.filename < b.filename ? -1 : (a.filename > b.filename ? 1 : 0);
  });
  return out;
}

function matchLabel(m) {
  if (!m) return "";
  var s = Math.round(Math.max(0, Math.min(1, m.score)) * 100) + "%";
  if (m.penalty) s += " · variant";
  return s;
}

function fallbackTotals(index) {
  var n = 0, bytes = 0;
  var keys = Object.keys(index || {});
  for (var i = 0; i < keys.length; i++) {
    var e = index[keys[i]];
    if (!e || e.state !== "kept") continue;
    n++;
    bytes += e.size || 0;
  }
  return { count: n, bytes: bytes };
}

// ---------------------------------------------------------------------------
// slskd client
// ---------------------------------------------------------------------------
function baseUrl() {
  return String(conn().url || "").replace(/\/+$/, "");
}

// slskd returns a bare JSON string for most failures, e.g.
// "The server connection must be connected and logged in to perform a search
// (currently: Disconnected)". That is far more useful than the status code.
function errorText(res, fallback) {
  if (res && typeof res.json === "string" && res.json) return res.json;
  if (res && res.json && typeof res.json.message === "string") return res.json.message;
  if (res && res.text && res.text.length < 300) return res.text.replace(/^"|"$/g, "");
  return fallback;
}

// A 409/500 from a connection check means our cached readiness is stale (it only
// re-probes every 60s), so re-sync rather than leaving a misleading "ready".
function resyncIfConnectionLost(res) {
  if (res && (res.status === 409 || res.status === 500)) {
    refreshReadiness().catch(function (e) { console.error("slskd re-probe failed:", e); });
  }
}

// Every request names us: the host's default User-Agent is browser-style,
// which some filtering proxies block from a non-browser client.
var CLIENT_USER_AGENT = "Vibo";

async function slskd(method, path, body) {
  var url = baseUrl() + path;
  var init = {
    method: method,
    headers: { "X-API-Key": conn().apiKey || "", "Accept": "application/json", "User-Agent": CLIENT_USER_AGENT }
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  if (conn().insecure) init.insecure = true;

  var res = await api.network.fetch(url, init);
  var text = "";
  try { text = await res.text(); } catch (e) { text = ""; }
  var json = null;
  if (text) { try { json = JSON.parse(text); } catch (e) { json = null; } }
  return { status: res.status, json: json, text: text };
}

async function probe() {
  var c = conn();
  if (!c.url || !c.apiKey) return { kind: "unconfigured" };
  var res;
  try {
    res = await slskd("GET", "/api/v0/application");
  } catch (e) {
    return { kind: "unreachable", detail: String((e && e.message) || e) };
  }
  if (res.status === 401 || res.status === 403) return { kind: "unauthorized" };
  if (res.status < 200 || res.status >= 300 || !res.json) {
    return { kind: "unreachable", detail: "HTTP " + res.status };
  }
  return parseApplication(res.json);
}

// GET /api/v0/application → the probe's "ok" shape. Pure so it can be pinned
// against a recorded payload.
function parseApplication(st) {
  st = st || {};
  var server = st.server || {};
  var shares = st.shares || {};
  // The logged-in name lives under `user`, not `server` (slskd 0.26:
  // `server` carries only connection state). `server.username` is kept as a
  // fallback in case an older daemon reported it there.
  var user = st.user || {};
  return {
    kind: "ok",
    serverState: server.state || "",
    isLoggedIn: server.isLoggedIn != null ? server.isLoggedIn : null,
    isTransitioning: server.isTransitioning != null ? server.isTransitioning : null,
    username: user.username || server.username || null,
    version: (st.version && st.version.current) || null,
    shareCount: shares.directories != null ? shares.directories
      : (shares.files != null ? shares.files : null)
  };
}

async function loadDownloadsDir() {
  try {
    var res = await slskd("GET", "/api/v0/options");
    if (res.status >= 200 && res.status < 300 && res.json && res.json.directories) {
      downloadsDir = res.json.directories.downloads || null;
      incompleteDir = res.json.directories.incomplete || null;
    }
  } catch (e) {
    console.error("slskd: couldn't read options:", e);
  }
}

// The host's local collections — what decides whether a finished file is
// already "in the library" (→ rescan) or needs the download modal to copy it
// into one. Feature-detected: older hosts have no api.collections.
async function loadCollections() {
  if (!api || !api.collections || typeof api.collections.getLocalCollections !== "function") {
    localCollections = [];
    return;
  }
  try {
    var list = await api.collections.getLocalCollections();
    localCollections = Array.isArray(list) ? list : [];
  } catch (e) {
    console.error("slskd: couldn't list local collections:", e);
    localCollections = [];
  }
}

// The collection slskd's downloads folder lives in, if any. When there is one,
// every finished download is already inside the library's roots and a rescan
// is all it takes; when there isn't, the user is told how to make it so.
function downloadsCollection() {
  if (tier !== "local" || !downloadsDir) return null;
  return collectionForPath(downloadsDir, localCollections);
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------
function badgeFor(state) {
  if (state === "unconfigured") return { type: "dot", variant: "muted", tooltip: "Soulseek isn't set up yet" };
  if (state === "unreachable") return { type: "dot", variant: "error", tooltip: "slskd isn't reachable" };
  if (state === "unauthorized") return { type: "dot", variant: "error", tooltip: "slskd rejected the API key" };
  if (state === "disconnected") return { type: "dot", variant: "warning", tooltip: "slskd isn't logged in to Soulseek" };
  if (state === "connecting") return { type: "dot", variant: "muted", tooltip: "slskd is connecting to Soulseek…" };
  return null;
}

// Pure: the notice across the top of the view while slskd is set up but not
// ready, or null. One line saying what's wrong, the one click that fixes it
// when there is one, and "Fix…" to the Settings tab, where the full
// explanation sits above the Connection card. A slskd this plugin installed
// is only stopped, so the notice starts it. `why` is the sign-in
// reason read from slskd's log; `onSettings` drops "Fix…" on the Settings
// tab, where the explanation is already right below — there the button
// had nowhere to go and looked dead.
function readinessBanner(st, cfg, m, why, onSettings) {
  var ours = usesManaged(cfg, m);
  var busy = !!(m && m.job);
  var fix = onSettings ? [] : [actionButton("Fix…", "slskd-show-fix")];
  var text, variant, buttons;
  if (st === "unreachable" && ours) {
    // Why it isn't running, when the last start failed (e.g. the user said no
    // to running programs): without it the banner only restates the symptom.
    text = m && m.error && !busy
      ? "slskd isn't running. " + m.error
      : "slskd isn't running. Search, downloads and the playback fallback need it.";
    variant = "warning";
    buttons = [actionButton("Start slskd", "managed-start", "accent", { disabled: busy })];
  } else if (st === "unreachable") {
    text = "Can't reach slskd at " + (cfg.url || "the saved address") + ". It may be stopped.";
    variant = "error";
    buttons = [checkButton("Try again")].concat(fix);
  } else if (st === "unauthorized") {
    text = "slskd rejected the API key.";
    variant = "error";
    buttons = fix;
  } else if (st === "disconnected" && why && why.kind === "blocked") {
    text = "This network blocks Soulseek, so slskd can't sign in.";
    variant = "warning";
    buttons = [checkButton("Check again")].concat(fix);
  } else if (st === "disconnected") {
    text = "slskd is running but isn't signed in to Soulseek.";
    variant = "warning";
    buttons = ours && managedOwnsAddress(cfg.url, m.record) && !signinNeedsNetwork(why)
      ? [actionButton("Restart slskd", "managed-restart", "accent", { disabled: busy })].concat(fix)
      : [checkButton("Check again")].concat(fix);
  } else if (st === "connecting") {
    text = "slskd is connecting to Soulseek…";
    variant = "warning";
    buttons = [];
  } else {
    return null;
  }
  return { type: "layout", direction: "horizontal", className: "ds-banner ds-banner--" + variant,
    children: [{ type: "text", content: text }, buttonRow(buttons)] };
}

// Pure: the host-drawn header over the view (api.ui.setViewHeader). It says
// whether slskd works, in one word, plus where it is; the fix for a problem
// stays in `readinessBanner`, which is larger and carries the button.
// `rd` is `readiness`; `setup` is `managed.setup` (the install checklist).
function viewHeaderFor(rd, cfg, m, tierNow, setup) {
  var st = rd.state;
  var url = cfg.url || "";
  var ours = usesManaged(cfg, m);
  var open = url ? [{ label: "Open slskd", action: "open-slskd" }] : [];
  if (setup) {
    return { subtitle: "Setting up slskd on this computer", status: { variant: "muted", label: "Setting up" }, actions: [] };
  }
  if (st === "unconfigured") {
    return { subtitle: "Search and download from the Soulseek network", status: { variant: "muted", label: "Not set up" }, actions: [] };
  }
  var where = (cfg.debug ? "Test server · " : (ours ? "slskd installed here · " : "")) + url;
  if (st === "ready") {
    var sub = (cfg.debug ? "Test server · " : "") + "Connected as " + (rd.username || "?") + (rd.version ? " · slskd " + rd.version : "");
    if (tierNow !== "local") sub += " · on another computer";
    return { subtitle: sub, status: { variant: "success", label: "Ready" }, actions: open };
  }
  if (st === "unreachable") {
    return ours
      ? { subtitle: where, status: { variant: "warning", label: "Not running" }, actions: [] }
      : { subtitle: where, status: { variant: "error", label: "Unreachable" }, actions: [] };
  }
  if (st === "unauthorized") return { subtitle: where, status: { variant: "error", label: "Key rejected" }, actions: open };
  if (st === "disconnected") return { subtitle: where, status: { variant: "warning", label: "Signed out" }, actions: open };
  return { subtitle: where, status: { variant: "muted", label: "Connecting…" }, actions: open };
}

// Sends the header only when it changed: render() runs on every poll tick,
// and each setViewHeader re-renders the host.
var lastViewHeader = null;
function pushViewHeader() {
  if (!api || !api.ui || typeof api.ui.setViewHeader !== "function") return; // older hosts
  var header = viewHeaderFor(readiness, conn(), managed, tier, managed.setup);
  var key = JSON.stringify(header);
  if (key === lastViewHeader) return;
  lastViewHeader = key;
  api.ui.setViewHeader(VIEW_ID, header);
}

// Pure: the full "what's wrong and how to fix it" for a state that isn't
// ready, on top of the Settings tab (the banner's "Fix…").
function fixNodes(st, cfg, r, detail, why) {
  if (st === "unreachable") return setupHomeView(st, cfg, r, detail);
  if (st === "unauthorized") return unauthorizedNodes(cfg, r);
  if (st === "disconnected") return disconnectedNodes(cfg, r, why);
  return [];
}

async function refreshReadiness() {
  var p = await probe();
  // A fake restarted on another port: follow it rather than report it gone.
  if (settings.debugServer && p.kind !== "ok" && await detectDebugServer()) p = await probe();
  lastServerState = p.kind === "ok" ? p.serverState : null;
  // What the host says about the slskd this plugin installed (running?
  // started before?). A cheap host call, no process spawned.
  try {
    await probeManaged();
  } catch (e) {
    console.error("slskd: couldn't read the installed slskd's status:", e);
  }
  var next = nextReadiness(p, readiness);
  readiness = {
    state: next.state,
    detail: next.detail,
    username: next.username,
    version: next.version,
    shareCount: next.shareCount
  };
  tier = detectTier(conn().url, conn().tierOverride);
  if (!settings.debugServer && !debugDetected) await detectDebugServer();

  pushBadge();

  try {
    await refreshSigninWhy();
  } catch (e) {
    console.error("slskd: couldn't read why slskd is signed out:", e);
    signinWhy = null;
  }

  if (next.state === "ready" && !downloadsDir) await loadDownloadsDir();
  if (next.state === "ready" || usesManaged(conn(), managed)) await loadCollections();
  await rescanSharesIfPending();
  await loadSlskdShared();

  // Sharing drives queue priority. A leeching setup produces slow downloads that
  // read as "this plugin is broken", so say it once, informationally.
  if (next.state === "ready" && readiness.shareCount === 0 && !sharesWarned) {
    sharesWarned = true;
    await api.storage.set(stateKey("sharesWarned"), true);
    var canShare = usesManaged(conn(), managed) && shareGap(localCollections, slskdShared).length > 0;
    api.ui.showNotification("slskd isn't sharing any folders. Soulseek prioritises users who share, so downloads may be slow or queue for a long time.",
      canShare ? { action: { label: "Share collections", id: "share-collections" } } : undefined);
  }

  render();
  renderSettings();
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// One Soulseek search, start to ranked list. Throws with a user-readable
// message on failure; resolves `null` when `isStale()` says nobody wants the
// answer any more. `onProgress(responseCount, fileCount)` fires on every poll —
// counts stream live (SearchService.cs:296-300) while response BODIES land only
// at completion (:311, :361), so a caller can show a real counter meanwhile.
//
// `until` (optional, epoch ms) is a deadline that means "answer by then with
// whatever has arrived" — NOT staleness. slskd's search timeout is an
// *inactivity* timeout, so a popular query keeps collecting responses for 35-40s;
// a caller on a budget (the playback fallback) must cut it short and still get
// the responses, which a stale predicate would throw away. The cut is the same
// as the SEARCH_CAP_MS one: stop the search (so its bodies land) and rank what
// slskd holds. A result cut short carries `partial: true`. Resolves `null`
// without searching when the deadline passed while this search sat queued
// behind another in `searchChain`.
//
// THE POLL IS DELIBERATELY LEAN. `?includeResponses=true` was on every poll,
// which is why a broad search was so expensive: measured against slskd 0.26.0,
// the counts-only body is ~254 bytes while the same search's bodies are 2.6 MB,
// and the loop runs up to 30 times — ~78 MB pulled through the plugin sandbox
// and JSON-parsed, to read two integers off it 29 times and use the payload
// once. The bodies are now fetched exactly once, after completion.
//
// Serialized through `searchChain`: slskd holds a one-slot semaphore on
// POST /searches and answers 429 to a second caller, so two searches (the view
// and an assistant tool, say) must queue rather than collide. For the same
// reason a search nobody wants any more is stopped, not just abandoned — left
// running it would hold that slot for the next caller's whole search.
function performSearch(query, prefs, onProgress, isStale, until) {
  var run = function () { return performSearchNow(query, prefs, onProgress, isStale, until); };
  var next = searchChain.then(run, run);
  searchChain = next.catch(function () { /* keep the chain alive for the next caller */ });
  return next;
}

async function performSearchNow(query, prefs, onProgress, isStale, until) {
  var stale = isStale || function () { return false; };
  if (stale()) return null;
  var capAt = Date.now() + SEARCH_CAP_MS;
  if (until != null) {
    if (Date.now() >= until) return null;
    capAt = Math.min(capAt, until);
  }

  var res;
  try {
    res = await slskd("POST", "/api/v0/searches", { searchText: query });
  } catch (e) {
    throw new Error("Couldn't reach slskd: " + ((e && e.message) || e));
  }
  if (res.status < 200 || res.status >= 300 || !res.json || !res.json.id) {
    resyncIfConnectionLost(res);
    throw new Error(errorText(res, "slskd rejected the search (HTTP " + res.status + ")."));
  }
  var id = res.json.id;
  var startedAt = Date.now();

  var last = null;
  while (Date.now() < capAt) {
    await sleep(Math.max(0, Math.min(SEARCH_POLL_MS, capAt - Date.now())));
    if (stale()) { await stopSearch(id); return null; }

    var poll;
    try {
      poll = await slskd("GET", "/api/v0/searches/" + encodeURIComponent(id));
    } catch (e) {
      continue;
    }
    if (stale()) { await stopSearch(id); return null; }
    if (!poll.json) continue;
    last = poll.json;

    if (onProgress) onProgress(last.responseCount || 0, last.fileCount || 0);

    if (hasFlag(last.state, "Completed")) {
      var done = await fetchResponses(id, stale);
      if (done === null) return null;
      var rankedDone = rankResults(done, prefs || {});
      // How many peers answered at all — zero is what a blocked search phrase
      // looks like, as opposed to answers with nothing downloadable in them.
      rankedDone.responseCount = done.length;
      return rankedDone;
    }
  }

  // Past the cap: whatever slskd holds now is the answer. Stop the search first
  // — that is what makes its response bodies land — then read them.
  await stopSearch(id);
  var partial = await fetchResponses(id, stale);
  if (partial === null) return null;
  if (partial.length) {
    var ranked = rankResults(partial, prefs || {});
    ranked.partial = true;
    ranked.responseCount = partial.length;
    return ranked;
  }
  throw new Error("Search timed out after " + Math.round((Date.now() - startedAt) / 1000) + " seconds.");
}

// Stop a search slskd is still running (PUT /searches/{id}). Best-effort: a
// failure only means the search runs to its own timeout.
async function stopSearch(id) {
  try {
    await slskd("PUT", "/api/v0/searches/" + encodeURIComponent(id));
  } catch (e) {
    console.error("slskd: couldn't stop a search:", e);
  }
}

// The one heavy read of a search: its response bodies, fetched after the search
// is over. `/responses` is the narrow endpoint (just the array); an older slskd
// without it falls back to the whole search object. Resolves `[]` when there is
// genuinely nothing, `null` when the caller stopped caring mid-fetch.
async function fetchResponses(id, stale) {
  var path = "/api/v0/searches/" + encodeURIComponent(id);
  for (var i = 0; i < RESPONSES_RETRY_TRIES; i++) {
    if (stale && stale()) return null;
    var got = await readResponses(path + "/responses", null);
    if (got === null) got = await readResponses(path + "?includeResponses=true", "responses");
    if (got && got.length) return got;
    await sleep(RESPONSES_RETRY_MS);
  }
  return [];
}

// One attempt at one endpoint. `field` names the property holding the array
// when the body is an object rather than the array itself. `null` means "this
// endpoint didn't answer with a list" — try the other shape.
async function readResponses(path, field) {
  var res;
  try {
    res = await slskd("GET", path);
  } catch (e) {
    return null;
  }
  if (res.status < 200 || res.status >= 300 || !res.json) return null;
  var list = field ? res.json[field] : res.json;
  return Array.isArray(list) ? list : null;
}

function viewPrefs(extra) {
  var prefs = {
    preferredFormats: parsePreferredFormats(settings.preferredFormats),
    sharerTier: function (username) { return sharerTier(sharers[username]); },
    windowsDaemon: !!downloadsDir && isWindowsPath(downloadsDir)
  };
  if (extra && extra.knownDurationSecs != null) prefs.knownDurationSecs = extra.knownDurationSecs;
  return prefs;
}

// The sidebar's search: owns `search` (the view state) and re-renders as counts
// arrive. A newer search supersedes an older one through `searchGen`.
async function runSearch(query, extra) {
  if (!(extra && extra.mode)) rememberSearch(query);
  if (!query || readiness.state !== "ready") return;
  var gen = ++searchGen;
  var mode = (extra && extra.mode) || null;
  search = { query: query, id: null, running: true, responseCount: 0, fileCount: 0, matchCount: 0, folderCount: 0, results: [], folders: [], error: null, sortColumn: null, sortDir: "desc", folderSortColumn: null, folderSortDir: "desc", mode: mode, note: (extra && extra.note) || null };
  // Filling an album is a folder job — Soulseek users share whole albums — so
  // that mode opens on the Folders view, as does a search handed over from an
  // album (`extra.folders`); everything else opens on Files.
  activeTab = (mode && mode.kind === "fill") || (extra && extra.folders) ? "folders" : "search";
  openFolder = null;
  folderOwned = {};
  folderOwnedChecked = {};
  render();

  var ranked;
  try {
    ranked = await performSearch(query, viewPrefs(extra), function (responses, files) {
      if (gen !== searchGen) return;
      search.responseCount = responses;
      search.fileCount = files;
      render();
    }, function () { return gen !== searchGen; });
  } catch (e) {
    if (gen !== searchGen) return;
    search.running = false;
    search.error = (e && e.message) || String(e);
    render();
    return;
  }
  if (gen !== searchGen || ranked === null) return;
  if (ranked.responseCount != null) search.responseCount = ranked.responseCount;
  annotateForMode(ranked, mode);
  // Group from the FULL ranked list, then cap: a folder that survives the cut
  // must keep every one of its files, or "download folder" would silently grab
  // part of an album.
  var folders = groupByFolder(ranked);
  search.matchCount = ranked.length;
  search.folderCount = folders.length;
  search.results = ranked.slice(0, MAX_RESULT_FILES);
  search.folders = folders.slice(0, MAX_RESULT_FOLDERS);
  search.running = false;
  render();
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------
async function nextBatch(label, subdir) {
  settings.batchSeq = (settings.batchSeq || 0) + 1;
  await api.storage.set("batchSeq", settings.batchSeq);
  return safeDestination(settings.batchSeq, label, subdir);
}

// The one place a download is started — the view's buttons, Retry, and the
// assistant's `download` tool all come through here, so an assistant-queued
// file is tracked, located and imported exactly like a clicked one. Throws
// with a readable message; the caller decides how to surface it.
//
// `recExtra` is what a context-menu mode knows that the filename doesn't:
// `meta` (tag-shaped, from the library — merged under the parsed names so the
// finished file is tagged and imported as the track it was fetched for) and
// `upgrade` (the library row this file is meant to replace).
async function enqueueBatch(username, files, label, subdir, recExtra) {
  var batch = await nextBatch(label, subdir);
  var payload = {
    username: username,
    files: files.map(function (f) { return { filename: f.filename, size: f.size }; }),
    options: { destination: batch.destination, externalId: DEST_ROOT + "-" + settings.batchSeq }
  };
  var res;
  try {
    res = await slskd("POST", "/api/v0/transfers/downloads/batches", payload);
  } catch (e) {
    throw new Error("Couldn't reach slskd to start the download.");
  }
  if (res.status < 200 || res.status >= 300) {
    resyncIfConnectionLost(res);
    throw new Error(errorText(res, "slskd refused the download (HTTP " + res.status + ")."));
  }
  // 207: some files were refused (already queued, or a bad name). Track the
  // rest; the caller reports the failures.
  var failures = (res.json && res.json.failures) || [];
  var failed = {};
  for (var f = 0; f < failures.length; f++) {
    if (failures[f] && failures[f].filename) failed[failures[f].filename] = failures[f].message || "refused";
  }

  var extra = recExtra || {};
  var queued = [];
  for (var i = 0; i < files.length; i++) {
    if (failed[files[i].filename]) continue;
    var parsed = parseTrackMeta(files[i].filename);
    var rec = {
      destination: batch.destination,
      b64: batch.b64,
      resolvedPath: null,
      meta: extra.meta ? mergeMeta(parsed, extra.meta) : parsed,
      size: files[i].size || null,
      length: files[i].length != null ? files[i].length : null,
      // What the sharer advertised, for the row's format tile while the
      // transfer is in flight (slskd's transfer record carries none of it).
      quality: qualitySnapshot(files[i]),
      // Lets a search row say "Queued" in the second before slskd's transfer
      // list first carries the file (see rowTransferStatus).
      queuedAt: nowMs()
    };
    if (extra.upgrade) rec.upgrade = extra.upgrade;
    tracked[username + KEY_SEP + files[i].filename] = rec;
    queued.push(files[i]);
  }
  await api.storage.set(stateKey("tracked"), tracked);
  schedulePoll(true);
  return { queued: queued, failures: failures };
}

// View-side wrapper. The view stays where it is: the rows a download started
// from show its state themselves (`rowTransferStatus`), so picking several
// files from one search costs no trips back from the Downloads tab. Only a
// refusal speaks up, since no row will ever change for it.
async function enqueueFiles(username, files, label, recExtra) {
  var out;
  try {
    out = await enqueueBatch(username, files, label, undefined, recExtra);
  } catch (e) {
    api.ui.showNotification((e && e.message) || "Couldn't start the download.");
    return false;
  }
  var n = out.queued.length;
  if (n === 0) api.ui.showNotification("slskd refused every file.");
  else if (out.failures.length) api.ui.showNotification("Queued " + n + " from " + username + " · slskd refused " + out.failures.length + ".");
  render();
  return n > 0;
}

function trackKeyOf(t) {
  return (t.username || "") + KEY_SEP + (t.filename || "");
}

function transferByKey(key) {
  for (var i = 0; i < transfers.length; i++) {
    if (trackKeyOf(transfers[i]) === key) return transfers[i];
  }
  return null;
}

function splitKey(key) {
  var ref = String(key || "");
  var sep = ref.indexOf(KEY_SEP);
  if (sep < 0) return null;
  return { username: ref.slice(0, sep), filename: ref.slice(sep + 1) };
}

// Transfers slskd knows about, flattened out of its user → directory grouping.
async function fetchTransfers() {
  var res = await slskd("GET", "/api/v0/transfers/downloads");
  if (!res.json) return null;
  var flat = [];
  var users = Array.isArray(res.json) ? res.json : [];
  for (var u = 0; u < users.length; u++) {
    var dirs = (users[u] && users[u].directories) || [];
    for (var d = 0; d < dirs.length; d++) {
      var fs = (dirs[d] && dirs[d].files) || [];
      for (var i = 0; i < fs.length; i++) {
        var t = fs[i];
        if (t && !t.removed) flat.push(t);
      }
    }
  }
  // slskd groups by sharer and folder; the Downloads tab reads newest first.
  return sortTransfersNewestFirst(flat);
}

// Pure: when a transfer last happened — finished, else started, else asked
// for — as epoch ms, or 0 when slskd sent no date.
function transferTime(t) {
  var s = t && (t.endedAt || t.startedAt || t.enqueuedAt || t.requestedAt);
  var ms = s ? Date.parse(s) : NaN;
  return isNaN(ms) ? 0 : ms;
}

function sortTransfersNewestFirst(list) {
  return list.slice().sort(function (a, b) { return transferTime(b) - transferTime(a); });
}

async function refreshTransfers() {
  if (readiness.state !== "ready") return;
  var flat;
  try {
    flat = await fetchTransfers();
  } catch (e) {
    return;
  }
  if (!flat) return;
  transfers = flat;

  var justFinished = [];
  for (var k = 0; k < flat.length; k++) {
    var tr = flat[k];
    var key = trackKeyOf(tr);
    var rec = tracked[key];
    var phase = transferPhase(tr.state);
    if (phase === "succeeded" && !knownDone[key]) {
      knownDone[key] = true;
      if (completionsSeeded) justFinished.push(tr);
    }
    // The ledger: only transitions seen live count. Whatever is already
    // finished at the first poll of a session is history — marked as dealt
    // with, not recorded — or every restart would re-count it.
    if (phase === "succeeded" || phase === "failed") {
      if (completionsSeeded) ledgerCount(key, tr.username, phase === "succeeded" ? "delivered" : "failed", tr.size || 0, false);
      else if (!ledgerSeen[key]) ledgerSeen[key] = "counted";
    }
    if (rec && !rec.resolvedPath && phase === "succeeded") {
      await resolveTransferPath(tr, rec);
    }
  }
  // First poll of the session: everything already finished is new to US but
  // nothing just happened. Seed silently, or a restart would notify (and
  // rescan) once per finished file.
  completionsSeeded = true;

  await readTagsForResolved();
  await reconcilePendingFallbacks();
  await enforceFallbackLimits(false);
  await adoptManualUpgrades();
  await advanceUpgrades();
  render();
  if (justFinished.length) await handleCompletions(justFinished);
}

// A fallback download left running past the budget ("used next time") is only
// worth anything if someone watches it land — or fail. Every poll checks the
// pending entries: a finished one is located and becomes a kept file; a failed,
// cancelled or vanished one is dropped from slskd's list and forgotten, so a
// flaky sharer leaves neither a stray "Failed" row in Downloads nor an index
// entry that would send the next request waiting on a corpse. Entries younger
// than `FALLBACK_RECONCILE_AGE_MS`, or any entry while a resolve is running,
// still belong to that resolve and are left alone.
async function reconcilePendingFallbacks() {
  if (fallbackBusy) return;
  var keys = Object.keys(fallback);
  var changed = false;
  for (var i = 0; i < keys.length; i++) {
    var e = fallback[keys[i]];
    if (!e || e.state !== "pending") continue;
    if (nowMs() - (e.at || 0) < FALLBACK_RECONCILE_AGE_MS) continue;
    var t = transferByKey(e.ref);
    var phase = t ? transferPhase(t.state) : null;
    if (phase === "succeeded") {
      var rec = tracked[e.ref];
      var path = rec ? (rec.resolvedPath || await resolveTransferPath(t, rec)) : null;
      if (!path) continue;
      e.state = "kept";
      e.path = path;
      e.size = t.size || e.size || null;
      changed = true;
      api.log("info", "fallback: the background download of “" + e.title + "” finished — kept for next time", "slskd");
    } else if (!t || phase === "failed" || phase === "cancelled") {
      if (t && phase === "failed") ledgerCount(e.ref, t.username, "failed", 0, false);
      if (t) await dropStalled(t);
      delete tracked[e.ref];
      delete fallback[keys[i]];
      changed = true;
      api.log("warn", "fallback: the background download of “" + e.title + "” " + (t ? phase : "vanished from slskd") + " — forgotten", "slskd");
    }
  }
  if (changed) {
    await saveFallbackIndex();
    await api.storage.set(stateKey("tracked"), tracked);
  }
}

// Embedded tags for every located file that hasn't been read yet, in ONE host
// call: the host probes on a worker thread and a call per file is a round trip
// per file. Feature-detected; the filename parse stands where tags can't be
// read, and a failure is deliberately not cached as a miss (it is the host or
// the mount, not the file).
async function readTagsForResolved() {
  if (!api || !api.system || typeof api.system.readAudioTags !== "function") return;
  var wanted = [];
  var keys = Object.keys(tracked);
  for (var i = 0; i < keys.length; i++) {
    var rec = tracked[keys[i]];
    if (rec && rec.resolvedPath && !rec.tagsRead && !tagsPending[rec.resolvedPath]) wanted.push(keys[i]);
  }
  if (!wanted.length) return;
  var paths = wanted.map(function (k) { return tracked[k].resolvedPath; });
  var job = api.system.readAudioTags(paths)
    .then(function (results) {
      for (var j = 0; j < wanted.length; j++) {
        var rec = tracked[wanted[j]];
        if (!rec) continue;
        var tags = (results && results[j]) || null;
        rec.meta = mergeMeta(rec.meta, tags);
        rec.tagsRead = true;
        // The host read the file and found no audio in it: damaged, truncated
        // or not what its name says (a run of zero bytes once passed as FLAC).
        rec.unreadable = !tags;
      }
      return api.storage.set(stateKey("tracked"), tracked);
    })
    .catch(function (e) {
      console.error("slskd: could not read tags for finished files:", e);
    })
    .then(function () {
      for (var m = 0; m < paths.length; m++) delete tagsPending[paths[m]];
    });
  for (var p = 0; p < paths.length; p++) tagsPending[paths[p]] = job;
  await job;
}

// Announce what just finished and, when it landed inside a collection, rescan
// that collection so the files reach the library without a click. Deduped by
// collection: an album finishing is a dozen files and must not queue a dozen
// scans of the same folder.
async function handleCompletions(finished) {
  var names = [];
  var byCollection = {};
  for (var i = 0; i < finished.length; i++) {
    var rec = tracked[trackKeyOf(finished[i])];
    var meta = (rec && rec.meta) || parseTrackMeta(finished[i].filename);
    names.push(meta.title || basenameRemote(finished[i].filename));
    if (rec && rec.resolvedPath && tier === "local") {
      var c = collectionForPath(rec.resolvedPath, localCollections);
      if (c) byCollection[c.id] = c;
    }
  }
  var upgradeRec = finished.length === 1 ? tracked[trackKeyOf(finished[0])] : null;
  if (upgradeRec && upgradeRec.upgrade && upgradeRec.upgrade.auto) {
    // An automatic upgrade announces itself once the file passed its check
    // (advanceUpgradeCheck) — "ready" before that could be a mislabelled file.
  } else if (upgradeRec && upgradeRec.upgrade) {
    // The file arrived for one purpose; say where the button is rather than
    // opening the modal over whatever the user is doing now — a Soulseek
    // transfer can land hours after it was asked for.
    api.ui.showNotification("Upgrade for “" + names[0] + "” is ready — choose Replace in library on the Downloads tab.");
  } else {
    api.ui.showNotification(finished.length === 1
      ? "Finished downloading: " + names[0]
      : "Finished downloading " + finished.length + " files (" + names[0] + ", …)");
  }

  if (!api.collections || typeof api.collections.resync !== "function") return;
  var ids = Object.keys(byCollection);
  for (var k = 0; k < ids.length; k++) {
    try {
      await api.collections.resync(Number(ids[k]));
      api.ui.showNotification("Scanning “" + byCollection[ids[k]].name + "” for the new files");
    } catch (e) {
      console.error("slskd: could not rescan collection " + ids[k] + ":", e);
    }
  }
}

// DELETE cancels a live transfer; `remove=true` also drops the record so the
// row disappears from slskd's list (and ours on the next poll). A 404 means it
// is already gone, which is the outcome we wanted.
async function cancelTransfer(t, remove) {
  if (!t || t.id == null) return;
  var path = "/api/v0/transfers/downloads/" + encodeURIComponent(t.username || "") + "/" + encodeURIComponent(t.id) + (remove ? "?remove=true" : "");
  var res = await slskd("DELETE", path);
  var ok = (res.status >= 200 && res.status < 300) || res.status === 404;
  if (!ok) {
    throw new Error(errorText(res, "slskd couldn't " + (remove ? "remove" : "cancel") + " that download (HTTP " + res.status + ")."));
  }
  if (remove) {
    var key = trackKeyOf(t);
    delete knownDone[key];
    transfers = transfers.filter(function (x) { return trackKeyOf(x) !== key; });
  }
}

async function listDestination(rec) {
  // Targeted listing when the base64 is route-safe; otherwise a filtered root
  // listing (correct always, just heavier).
  if (rec.b64) {
    try {
      var res = await slskd("GET", "/api/v0/files/downloads/directories/" + rec.b64 + "?recursive=true");
      // Names come back relative to THIS directory, not to the downloads root.
      if (res.status >= 200 && res.status < 300 && res.json) {
        return rebaseListing(flattenListing(res.json), rec.destination);
      }
    } catch (e) {
      console.error("slskd: targeted listing failed, falling back to the root listing:", e);
    }
  }
  try {
    var root = await slskd("GET", "/api/v0/files/downloads/directories?recursive=true");
    if (root.status >= 200 && root.status < 300 && root.json) {
      var all = flattenListing(root.json);
      var prefix = rec.destination.replace(/\\/g, "/") + "/";
      return all.filter(function (f) {
        return String(f.fullName || "").replace(/\\/g, "/").indexOf(prefix) === 0;
      });
    }
  } catch (e) {
    console.error("slskd: couldn't list the downloads folder:", e);
  }
  return [];
}

function flattenListing(node) {
  var out = [];
  (function walk(n) {
    if (!n) return;
    var files = n.files || [];
    for (var i = 0; i < files.length; i++) out.push(files[i]);
    var dirs = n.directories || [];
    for (var j = 0; j < dirs.length; j++) walk(dirs[j]);
  })(node);
  return out;
}

async function resolveTransferPath(transfer, rec) {
  if (!downloadsDir) await loadDownloadsDir();
  if (!downloadsDir) return null;
  var files = await listDestination(rec);
  var hit = matchFile(transfer, files);
  if (!hit) return null;
  rec.resolvedPath = absolutePath(downloadsDir, hit.fullName);
  tracked[trackKeyOf(transfer)] = rec;
  await api.storage.set(stateKey("tracked"), tracked);
  return rec.resolvedPath;
}

// The transfer a tracked record describes, rebuilt from the record itself.
// `resolveTransferPath` only needs the remote filename (for the basename) and
// the size, and slskd forgets a finished transfer once the user clears it — so
// a record has to be able to re-locate its own file without one.
function transferFromRecord(ref, rec) {
  var parts = splitKey(ref);
  return {
    username: parts ? parts.username : "",
    filename: parts ? parts.filename : "",
    size: rec ? rec.size : null
  };
}

// Where a tracked file is NOW. `resolvedPath` is a cache of where slskd put it,
// and slskd's downloads folder is the user's to repoint — do that and every
// stored path is stale, which playback only discovers as "file not found". So
// the cache is trusted only while it still sits under the CURRENT folder, and
// re-derived from a fresh listing otherwise. Also what heals a path written by
// a version of this plugin that mis-joined the targeted listing.
async function currentPath(ref, rec) {
  if (!rec) return null;
  if (!downloadsDir) await loadDownloadsDir();
  if (!downloadsDir) return rec.resolvedPath || null;
  if (rec.resolvedPath && pathIsUnder(downloadsDir, rec.resolvedPath)) return rec.resolvedPath;
  rec.resolvedPath = null;
  return await resolveTransferPath(transferByKey(ref) || transferFromRecord(ref, rec), rec);
}

function findTrackedByRef(ref) {
  return tracked[ref] || null;
}

// The slsk:// URIs handed to an ASSISTANT are percent-encoded (`toolUri`): a
// model can't be trusted to echo the NUL inside a key back byte for byte. The
// resolvers decode before looking up; a raw key (what every host-internal
// caller passes) has a NUL or no "%" at all and is left alone.
function decodeRef(ref) {
  var s = String(ref || "");
  if (s.indexOf(KEY_SEP) >= 0 || s.indexOf("%") < 0) return s;
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

function toolUri(key) {
  return SCHEME + "://" + encodeURIComponent(key);
}

// ---------------------------------------------------------------------------
// Playback fallback — the stream resolver
// ---------------------------------------------------------------------------
// The host asks every stream resolver, in the user's order, for a track that
// has no playable source of its own, and gives each one 60 seconds. Soulseek
// sends whole files and a stranger's queue can be hours long, so this resolver
// works to a budget: one bounded search, then the best-matching file from a
// sharer with a free slot, abandoned for the next one when it hasn't started
// moving. What finishes inside the budget plays; what doesn't keeps
// downloading and answers the NEXT request for the same song instantly.
//
// Every file fetched this way is remembered in `fallback` (keyed by the
// normalized song identity), which is what lets the Downloads tab list and
// delete exactly these files and none of the user's own downloads.
var lastResolve = null;     // the most recent fallback attempt, for the Fallback tab (session only)
var fallbackBusy = false;

function nowMs() { return Date.now(); }

function startResolveRecord(title, artist, durationSecs, query) {
  lastResolve = {
    at: nowMs(), title: title, artist: artist || null, durationSecs: durationSecs != null ? durationSecs : null,
    query: query, steps: [], candidates: [], picked: null, chosen: null, tried: [], outcome: "running", message: null, path: null
  };
  pushBadge();
  renderIfFallback();
  return lastResolve;
}

function resolveStep(rec, label) {
  var step = { label: label, outcome: null, level: "info", ms: null, startedAt: nowMs() };
  rec.steps.push(step);
  renderIfFallback();
  return function settle(outcome, level) {
    step.outcome = outcome;
    step.level = level || "info";
    step.ms = nowMs() - step.startedAt;
    api.log(step.level === "error" ? "error" : (step.level === "warn" ? "warn" : "info"),
      "fallback: " + label + " → " + outcome + " (" + Math.round(step.ms / 100) / 10 + "s)", "slskd");
    renderIfFallback();
  };
}

function finishResolve(rec, outcome, message, path) {
  rec.outcome = outcome;
  rec.message = message || null;
  rec.path = path || null;
  rec.totalMs = nowMs() - rec.at;
  api.log(outcome === "played" || outcome === "cached" ? "info" : "warn",
    "fallback: " + outcome + (message ? " — " + message : "") + " (total " + Math.round(rec.totalMs / 100) / 10 + "s)", "slskd");
  resolveHistory = withResolve(resolveHistory, historyEntry(rec), RESOLVE_HISTORY_MAX);
  api.storage.set(stateKey("resolveHistory"), resolveHistory).catch(function (e) { console.error("slskd: couldn't save the fallback history:", e); });
  fallbackLastUsedAt = rec.at;
  api.storage.set(stateKey("fallbackLastUsedAt"), fallbackLastUsedAt).catch(function (e) { console.error("slskd: couldn't save when the fallback was last used:", e); });
  pushBadge();
  render();
}

// ---- resolve history -------------------------------------------------------
// "Last resolve" is one run and gone at a restart; whether to trust the
// fallback is a question about how often it works. So every finished resolve
// leaves a small record (no candidate lists, no steps) — the Fallback tab's
// numbers and its Recent list are read off these.
var RESOLVE_HISTORY_MAX = 50;
var resolveHistory = [];
// When the fallback last ran, kept apart from the history so Clear on Recent
// doesn't turn the tab back into "Not used yet — is it switched on?".
var fallbackLastUsedAt = null;

// Pure: the record kept for one finished resolve.
function historyEntry(rec) {
  var c = rec.chosen || rec.picked;
  return {
    at: rec.at, title: rec.title, artist: rec.artist, outcome: rec.outcome,
    ms: rec.totalMs != null ? rec.totalMs : null, message: rec.message || null,
    file: c ? { name: basenameRemote(c.filename), user: c.username, quality: qualityLabel(c) } : null
  };
}

// A failed play is retried by the host at once (seen live: four resolves of one
// song inside half a minute). Within this window a resolve of the same song is
// the same play, not another one.
var RESOLVE_MERGE_MS = 2 * 60 * 1000;

function sameResolveSong(a, b) {
  return !!a && !!b && normalizeText(a.title || "") === normalizeText(b.title || "") &&
    normalizeText(a.artist || "") === normalizeText(b.artist || "");
}

// Pure: newest first, capped. A retry of the newest entry's song inside
// RESOLVE_MERGE_MS replaces it — its outcome is the play's outcome now — and
// counts the try (`tries`), so Recent lists the song once and "played N of M"
// counts plays, not attempts.
function withResolve(list, entry, max) {
  var prev = (list || [])[0];
  // Only a try after one that didn't play is a retry; playing the same song
  // again soon after it played is a new play, not "tried 2 times".
  var prevPlayed = prev && (prev.outcome === "played" || prev.outcome === "cached");
  if (prev && !prevPlayed && sameResolveSong(prev, entry) && entry.at - prev.at >= 0 && entry.at - prev.at < RESOLVE_MERGE_MS) {
    var merged = Object.assign({}, entry, { tries: (prev.tries || 1) + 1 });
    return [merged].concat(list.slice(1)).slice(0, max);
  }
  return [entry].concat(list || []).slice(0, max);
}

// Pure: the Fallback tab's numbers. `started` counts what played, a copy
// fetched earlier included; the median is over fresh fetches only, since a
// kept copy plays at once and would flatter it.
function resolveStats(list) {
  var all = list || [];
  var started = 0, times = [];
  for (var i = 0; i < all.length; i++) {
    var e = all[i];
    if (e.outcome === "played" || e.outcome === "cached") started++;
    if (e.outcome === "played" && e.ms != null) times.push(e.ms);
  }
  times.sort(function (a, b) { return a - b; });
  var median = null;
  if (times.length) {
    var mid = Math.floor(times.length / 2);
    median = times.length % 2 ? times[mid] : (times[mid - 1] + times[mid]) / 2;
  }
  return { total: all.length, started: started, medianMs: median };
}

var RESOLVE_OUTCOME_WORDS = {
  running: "Working…",
  played: "Played",
  cached: "Played a kept copy",
  timeout: "Ran out of time",
  "no-match": "Nothing matched",
  failed: "Failed"
};

function secondsLabel(ms) {
  return Math.round(ms / 100) / 10 + " s";
}

// Pure: "3 h ago" / "2 d ago" / "just now".
function agoLabel(at, now) {
  var m = Math.round(Math.max(0, now - at) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + " min ago";
  var h = Math.round(m / 60);
  return h < 24 ? h + " h ago" : Math.round(h / 24) + " d ago";
}

// Pure: one line of the Recent list.
function historyLine(e, now) {
  var mark = e.outcome === "played" || e.outcome === "cached" ? "✓" : e.outcome === "timeout" ? "…" : "✗";
  var bits = [RESOLVE_OUTCOME_WORDS[e.outcome] || e.outcome];
  if (e.outcome === "cached") bits[0] = "Played a kept copy";
  else if (e.ms != null) bits.push(secondsLabel(e.ms));
  if (e.file && e.outcome === "played") bits.push(e.file.quality + " from " + e.file.user);
  else if (e.message && e.outcome !== "played") bits.push(e.message);
  bits.push(agoLabel(e.at, now));
  return mark + " " + "“" + e.title + "”" + (e.artist ? " — " + e.artist : "") + "  ·  " + bits.join("  ·  ");
}

// Pure: one Recent entry as a row. The chip says how it ended; the subtitle
// what that took and from whom. A song that didn't play offers a search.
var HISTORY_BADGES = {
  played: { label: "Played", variant: "success" },
  cached: { label: "Kept copy", variant: "success" },
  timeout: { label: "Ran out of time", variant: "warning" },
  "no-match": { label: "Nothing matched", variant: "error" },
  failed: { label: "Failed", variant: "error" },
  running: { label: "Working", variant: "accent" }
};
// A Recent row's id names the entry, not its place: resolves land while the
// tab is open, and a position-based id then pointed at the song below.
function historyRowId(e) {
  return "h:" + e.at + "|" + (e.title || "");
}

function historyRows(list, now) {
  return list.map(function (e) {
    var bits = [];
    if (e.outcome === "played" && e.ms != null) bits.push("started in " + secondsLabel(e.ms));
    if (e.file && e.outcome === "played") bits.push(e.file.quality + " from " + e.file.user);
    else if (e.message && e.outcome !== "played" && e.outcome !== "cached") bits.push(e.message);
    if (e.tries > 1) bits.push("tried " + e.tries + " times");
    bits.push(agoLabel(e.at, now));
    var missed = e.outcome === "no-match" || e.outcome === "timeout" || e.outcome === "failed";
    return {
      id: historyRowId(e),
      title: e.title,
      subtitle: (e.artist ? e.artist + "  ·  " : "") + bits.join("  ·  "),
      artistName: e.artist || null,
      kind: "audio",
      badge: HISTORY_BADGES[e.outcome] || undefined,
      actions: missed ? ["fallback-search"] : []
    };
  });
}

// Pure: the line on top of the Fallback tab. The plugin can't see whether the
// user switched the fallback on, or where it sits in the order — the host
// doesn't say — so it says what its own history shows, and where to look.
var FALLBACK_SETTINGS_PATH = "Settings → Providers → Playback fallback";
function fallbackStatusNode(history, last, now, lastUsedAt) {
  if (last && last.outcome === "running") {
    return { type: "text", content: "Finding “" + last.title + "”" + (last.artist ? " by " + last.artist : "") + " on Soulseek now — details under Last resolve." };
  }
  var latestAt = history && history[0] ? history[0].at : null;
  if (lastUsedAt != null && (latestAt == null || lastUsedAt > latestAt)) latestAt = lastUsedAt;
  if (latestAt == null) {
    return { type: "layout", direction: "horizontal", className: "ds-banner ds-banner--warning",
      children: [{ type: "text", content: "Not used yet. It plays a track from Soulseek when nothing earlier in your order can — check that it's switched on in " + FALLBACK_SETTINGS_PATH + "." }] };
  }
  return { type: "text", className: "plugin-muted",
    content: "Last used " + agoLabel(latestAt, now) + ". Viboplr asks it when nothing earlier in " + FALLBACK_SETTINGS_PATH + " can play a track." };
}

// The sidebar item says "working" while a resolve runs, so it shows from any
// view; a problem with slskd itself (badgeFor) always wins over it.
function sidebarBadge() {
  var b = badgeFor(readiness.state);
  if (b) return b;
  if (lastResolve && lastResolve.outcome === "running") {
    return { type: "dot", variant: "accent", tooltip: "Finding “" + lastResolve.title + "” on Soulseek…" };
  }
  return null;
}

function pushBadge() {
  if (!api || !api.ui || typeof api.ui.setBadge !== "function") return;
  api.ui.setBadge(VIEW_ID, sidebarBadge());
}

function renderIfFallback() {
  if (activeTab === "fallback") render();
}

function recordSharer(username, event, bytes) {
  // With slskd's own folder misconfigured every download fails here; that
  // says nothing about the sharer, so don't let it sink their standing.
  if (event === "failed" && misconfiguredSlskdDir(downloadsDir, incompleteDir)) return;
  noteSharer(sharers, username, event, bytes);
  api.storage.set(stateKey("sharers"), sharers).catch(function (e) { console.error("slskd: couldn't save the sharer ledger:", e); });
}

// Count one transfer's outcome exactly once. `owner` is true for the race
// reporting a transfer it claimed; the poll passes false and yields to a claim.
function ledgerCount(key, username, event, bytes, owner) {
  var st = ledgerSeen[key];
  if (st === "counted") return;
  if (st === "claimed" && !owner) return;
  ledgerSeen[key] = "counted";
  recordSharer(username, event, bytes);
}

async function saveFallbackIndex() {
  try {
    await api.storage.set(stateKey("fallback"), fallback);
  } catch (e) {
    console.error("slskd: couldn't save the fallback index:", e);
  }
}

// Where a kept file is now, checked against a FRESH listing every time: the
// host's chain only advances when a resolver fails during resolve, so a path
// that no longer exists must be discovered here, not by the player.
async function relocateKept(entry) {
  var rec = tracked[entry.ref];
  if (!rec) return null;
  rec.resolvedPath = null;
  try {
    return await resolveTransferPath(transferByKey(entry.ref) || transferFromRecord(entry.ref, rec), rec);
  } catch (e) {
    console.error("slskd: couldn't relocate a fallback file:", e);
    return null;
  }
}

// Watch one transfer until it finishes, fails, stalls or the budget runs out.
// "Stalled" means NO BYTES have arrived for `FALLBACK_START_MS` — the sharer's
// slot was not free after all — and is what makes trying the next candidate
// worthwhile. It is measured on bytes, not on state, deliberately: slskd
// flickers Queued → Initializing → InProgress (at 0 bytes) → Queued while it
// retries a sharer, so a state-based rule marked such a transfer "started" and
// then waited on it to the deadline — 51 s of silence on a real run.
async function waitForTransfer(key, deadline, onTick, stallMs) {
  var stallAfter = stallMs || FALLBACK_START_MS;
  var movedAt = nowMs();
  var lastBytes = 0;
  var unseen = 0;
  while (nowMs() < deadline) {
    await sleep(FALLBACK_POLL_MS);
    var flat = null;
    try { flat = await fetchTransfers(); } catch (e) { flat = null; }
    if (!flat) continue;
    transfers = flat;
    var t = transferByKey(key);
    if (!t) {
      // slskd lists a transfer the moment it accepts the enqueue; a few misses
      // are a race, a run of them means it was dropped.
      if (++unseen >= 5) return { state: "gone" };
      continue;
    }
    unseen = 0;
    var phase = transferPhase(t.state);
    if (phase === "succeeded") return { state: "done", transfer: t };
    if (phase === "failed" || phase === "cancelled") return { state: phase, transfer: t };
    var bytes = t.bytesTransferred || 0;
    if (bytes > lastBytes) { lastBytes = bytes; movedAt = nowMs(); }
    if (onTick) onTick(t, phase);
    if (nowMs() - movedAt > stallAfter) return { state: "stalled", transfer: t };
  }
  return { state: "timeout", transfer: transferByKey(key) };
}

// The listing can lag the state flip by a moment, as search bodies do.
async function locateFinished(transfer, rec) {
  for (var n = 0; n < 4; n++) {
    var path = await resolveTransferPath(transfer, rec);
    if (path) return path;
    await sleep(500);
  }
  return null;
}

async function dropStalled(t) {
  try {
    await cancelTransfer(t, true);
  } catch (e) {
    console.error("slskd: couldn't drop a stalled fallback transfer:", e);
  }
}

// A sharer slskd couldn't even reach ("Failed to connect to user …") fails the
// enqueue, but slskd may still have recorded the attempt as a failed download.
// Every other dropped attempt is removed (dropStalled), so this one must be
// too, or it sits in the Downloads tab as "Failed" until removed by hand.
async function dropIfListed(key) {
  try {
    transfers = (await fetchTransfers()) || transfers;
  } catch (e) {
    console.error("slskd: couldn't re-read transfers after a failed enqueue:", e);
    return;
  }
  var t = transferByKey(key);
  if (t) await dropStalled(t);
}

function fallbackAnswer(path) {
  return { url: fileUrlForPlayback(path), label: FALLBACK_LABEL };
}

// What the download modal gets for a finished file: an instant local copy.
function downloadAnswer(path, meta) {
  meta = meta || {};
  var ext = extOf(path);
  var out = {
    url: fileUrlForDownload(path),
    metadata: {
      title: meta.title || null,
      artist: meta.artist || null,
      album: meta.album || null,
      trackNumber: meta.trackNumber || null,
      year: meta.year || null,
      genre: meta.genre || null
    }
  };
  // The provider names the file: a concrete extension whenever it is known,
  // never "auto" (the host no longer sniffs bytes).
  if (ext) out.ext = ext;
  return out;
}

// The download modal's by-metadata resolve: the copy the fallback kept for this
// song, wherever it is now, or null. Same key the fallback stored it under.
async function resolveKeptDownload(title, artistName) {
  if (!title) return null;
  var entry = fallback[fallbackKey(title, artistName)];
  if (!entry) return null;
  var path = await relocateKept(entry);
  if (!path) return null;
  var rec = tracked[entry.ref];
  return downloadAnswer(path, rec && rec.meta);
}

// While a fallback transfer runs, the tab shows the same line the Downloads
// tab would — "Waiting in peer's queue · position 3", "Downloading 40% · 3.6 MB
// of 9 MB · ↓ 1.2 MB/s" — so a long wait has a stated reason. `eta` is our
// own: bytes left over the reported average speed.
function liveTransferTick(rec, key) {
  return function (t) {
    rec.progress = transferProgress(t);
    rec.live = transferSubtitle(t, tracked[key], tier);
    rec.eta = transferEta(t);
    renderIfFallback();
  };
}

function transferEta(t) {
  if (!t || !t.size || !t.averageSpeed) return null;
  var left = t.size - (t.bytesTransferred || 0);
  if (left <= 0) return 0;
  return Math.round(left / t.averageSpeed);
}

function clearLive(rec) {
  rec.progress = null;
  rec.live = null;
  rec.eta = null;
}

function liveLine(rec) {
  return rec.live + (rec.eta ? "  ·  about " + formatDurationSecs(rec.eta) + " left" : "");
}

// The fetch, hedged. The best candidate is queued at once. If no byte has
// arrived after FALLBACK_HEDGE_MS, the runner-up — a DIFFERENT sharer; slskd
// queues per user, so two files from one user just queue behind each other —
// is queued beside it, never more than FALLBACK_MAX_INFLIGHT at a time. The
// first transfer to move is the leader: every other attempt is cancelled on the
// spot, and a leader is never second-guessed, however slow. Any attempt with no
// bytes for FALLBACK_START_MS is dropped and its slot refilled. This grew out of
// the first live run, where a "free slot" sharer that never sent a byte cost
// the whole budget one sharer at a time; a good sharer, which is the common
// case, still costs exactly one enqueue.
//
// Returns { state: "done", path, attempt } | { state: "timeout", attempt } (one
// transfer left running for next time) | { state: "unlocated" } | { state:
// "exhausted" } (every sharer tried and dropped) | { state: "none" } (nothing
// could even be queued).
async function raceSharers(rec, matches, ctx) {
  var live = [];
  var next = 0;
  var users = {};
  var tried = 0;
  var lastStartAt = 0;
  var leader = null;

  function indexEntry(attempt, state, path) {
    fallback[ctx.fkey] = { ref: attempt.key, title: ctx.title, artist: ctx.artistName || null, query: ctx.query,
      at: attempt.startedAt, size: attempt.c.size || null, state: state, path: path || null };
  }

  async function persist() {
    await saveFallbackIndex();
    await api.storage.set(stateKey("tracked"), tracked);
  }

  // Queue the next candidate from a sharer not yet tried. False when there is
  // none left (or the per-resolve cap is reached).
  async function startNext() {
    while (next < matches.length && tried < FALLBACK_MAX_TRIES) {
      var c = matches[next++];
      if (users[c.username]) continue;
      users[c.username] = 1;
      tried++;
      var key = c.username + KEY_SEP + c.filename;
      rec.tried.push(key);
      var settle = resolveStep(rec, "download from " + c.username + " (" + basenameRemote(c.filename) + ", " + formatBytes(c.size) + ")");
      try {
        var out = await enqueueBatch(c.username, [c], (ctx.artistName ? ctx.artistName + " - " : "") + ctx.title, FALLBACK_SUBDIR);
        if (!out.queued.length) {
          settle("slskd refused it" + (out.failures[0] && out.failures[0].message ? " — " + out.failures[0].message : ""), "warn");
          ledgerCount(key, c.username, "failed", 0, true);
          await dropIfListed(key);
          continue;
        }
      } catch (e) {
        settle((e && e.message) || String(e), "error");
        ledgerCount(key, c.username, "failed", 0, true);
        await dropIfListed(key);
        continue;
      }
      if (tracked[key]) tracked[key].fallback = true;
      // Claim the transfer for the ledger: this race reports its outcome, so
      // the poll, which may see the state flip first, leaves it alone.
      if (!ledgerSeen[key]) ledgerSeen[key] = "claimed";
      var attempt = { c: c, key: key, settle: settle, startedAt: nowMs(), movedAt: nowMs(), lastBytes: 0, unseen: 0, transfer: null };
      live.push(attempt);
      lastStartAt = attempt.startedAt;
      if (!rec.picked) rec.picked = c;
      if (!fallback[ctx.fkey]) indexEntry(attempt, "pending");
      await persist();
      renderIfFallback();
      return true;
    }
    return false;
  }

  // Cancel an attempt in slskd and forget it here — transfer row, bookkeeping
  // record, and the index entry if it was pointing at this one.
  async function drop(attempt, reason, level, event) {
    var at = live.indexOf(attempt);
    if (at >= 0) live.splice(at, 1);
    if (leader === attempt) leader = null;
    if (event) ledgerCount(attempt.key, attempt.c.username, event, 0, true);
    if (attempt.transfer) await dropStalled(attempt.transfer); else await dropIfListed(attempt.key);
    delete tracked[attempt.key];
    if (fallback[ctx.fkey] && fallback[ctx.fkey].ref === attempt.key) delete fallback[ctx.fkey];
    if (rec.picked && sameCandidate(rec.picked, attempt.c)) rec.picked = (leader || live[0] || {}).c || null;
    await persist();
    attempt.settle(reason, level || "warn");
  }

  if (!(await startNext())) return { state: "none" };

  while (nowMs() < ctx.deadline) {
    await sleep(FALLBACK_POLL_MS);
    var flat = null;
    try { flat = await fetchTransfers(); } catch (e) { flat = null; }
    if (!flat) continue;
    transfers = flat;

    var snapshot = live.slice();
    for (var i = 0; i < snapshot.length; i++) {
      var a = snapshot[i];
      if (live.indexOf(a) < 0) continue;
      var t = transferByKey(a.key);
      if (!t) {
        // slskd lists a transfer the moment it accepts the enqueue; a few
        // misses are a race, a run of them means it was dropped.
        if (++a.unseen >= 5) await drop(a, "vanished from slskd", "warn", "failed");
        continue;
      }
      a.unseen = 0;
      a.transfer = t;
      var phase = transferPhase(t.state);
      if (phase === "succeeded") {
        var others = live.filter(function (x) { return x !== a; });
        for (var k = 0; k < others.length; k++) await drop(others[k], "another sharer delivered first");
        ledgerCount(a.key, a.c.username, "delivered", t.size || a.c.size || 0, true);
        var path = await locateFinished(t, tracked[a.key]);
        if (!path) {
          a.settle("finished, but the file could not be located in slskd's downloads folder", "error");
          return { state: "unlocated", attempt: a };
        }
        indexEntry(a, "kept", path);
        fallback[ctx.fkey].lastUsedAt = nowMs();
        fallback[ctx.fkey].size = t.size || a.c.size || null;
        await persist();
        rec.chosen = a.c;
        rec.picked = a.c;
        a.settle("finished");
        return { state: "done", path: path, attempt: a };
      }
      if (phase === "failed" || phase === "cancelled") {
        await drop(a, phase, "warn", phase === "failed" ? "failed" : null);
        continue;
      }
      var bytes = t.bytesTransferred || 0;
      if (bytes > a.lastBytes) {
        a.lastBytes = bytes;
        a.movedAt = nowMs();
        if (!leader) {
          leader = a;
          rec.picked = a.c;
          indexEntry(a, "pending");
          await persist();
          var losers = live.filter(function (x) { return x !== a; });
          for (var m = 0; m < losers.length; m++) await drop(losers[m], "another sharer started sending first");
        }
      }
      if (nowMs() - a.movedAt > FALLBACK_START_MS) {
        await drop(a, "no data for " + Math.round(FALLBACK_START_MS / 1000) + "s", "warn", "stalled");
      }
    }

    // Hedge, or refill after a drop: only while nothing is moving, only up to
    // the in-flight cap, and only with enough budget left for it to matter.
    if (!leader && live.length < FALLBACK_MAX_INFLIGHT && ctx.deadline - nowMs() >= FALLBACK_MIN_REMAINING_MS) {
      var silentFor = live.length ? nowMs() - lastStartAt : Infinity;
      if (silentFor >= FALLBACK_HEDGE_MS) await startNext();
    }
    if (!live.length) return { state: "exhausted" };

    var primary = leader || live[0];
    if (primary.transfer) liveTransferTick(rec, primary.key)(primary.transfer);
  }

  // Out of time. Keep ONE transfer running for next time — the leader if any,
  // else the first — and cancel the rest, so two strangers' slots aren't held
  // for a song nobody is waiting on any more.
  var keep = leader || live[0] || null;
  var rest = live.filter(function (x) { return x !== keep; });
  for (var r = 0; r < rest.length; r++) await drop(rest[r], "out of time — cancelled" + (keep ? " in favour of " + keep.c.username : ""));
  if (!keep) return { state: "exhausted" };
  indexEntry(keep, "pending");
  await persist();
  rec.picked = keep.c;
  rec.chosen = keep.c;
  keep.settle("out of time while downloading — it keeps going and is used next time", "warn");
  return { state: "timeout", attempt: keep };
}

async function resolveFallback(title, artistName, albumName, durationSecs, opts) {
  if (opts && opts.preferVideo) return null;           // audio only; the video pass is not ours
  if (readiness.state !== "ready" || tier !== "local") return null;
  if (!title) return null;
  if (fallbackBusy) {
    api.log("info", "fallback: skipped “" + title + "” — another fallback is still running", "slskd");
    return null;
  }
  fallbackBusy = true;
  var deadline = nowMs() + FALLBACK_BUDGET_MS;
  var query = fallbackQuery(title, artistName);
  var fkey = fallbackKey(title, artistName);
  var rec = startResolveRecord(title, artistName, durationSecs, query);
  try {
    // 1. Something we already fetched for this song?
    var kept = fallback[fkey];
    if (kept) {
      var settleKept = resolveStep(rec, "look for a copy fetched earlier");
      var path0 = await relocateKept(kept);
      if (path0) {
        kept.state = "kept";
        kept.path = path0;
        kept.lastUsedAt = nowMs();
        await saveFallbackIndex();
        settleKept("found " + path0);
        finishResolve(rec, "cached", "played the copy fetched earlier", path0);
        return fallbackAnswer(path0);
      }
      // Still on its way from a previous, timed-out attempt?
      var live = null;
      try { transfers = (await fetchTransfers()) || transfers; } catch (e) { /* the wait below re-reads */ }
      live = transferByKey(kept.ref);
      var livePhase = live ? transferPhase(live.state) : null;
      if (live && (livePhase === "downloading" || livePhase === "starting" || livePhase === "queued" || livePhase === "requested")) {
        settleKept("still downloading from the earlier attempt — waiting on it");
        var settleWait0 = resolveStep(rec, "wait for the earlier download");
        var w0 = await waitForTransfer(kept.ref, deadline, liveTransferTick(rec, kept.ref));
        clearLive(rec);
        if (w0.state === "done") {
          var p1 = await locateFinished(w0.transfer, tracked[kept.ref]);
          if (p1) {
            kept.state = "kept"; kept.path = p1; kept.size = w0.transfer.size || kept.size || null; kept.lastUsedAt = nowMs();
            await saveFallbackIndex();
            settleWait0("finished");
            finishResolve(rec, "played", "finished the earlier download", p1);
            return fallbackAnswer(p1);
          }
          settleWait0("finished but the file could not be located", "warn");
        } else if (w0.state === "timeout") {
          settleWait0("still not finished — it keeps downloading for next time", "warn");
          finishResolve(rec, "timeout", "the earlier download is still running; it will be used next time");
          return null;
        } else {
          settleWait0(w0.state, "warn");
        }
      } else {
        settleKept("gone — searching again", "warn");
      }
      delete fallback[fkey];
      await saveFallbackIndex();
    }

    // 2. Search, bounded well inside the budget so a download can still fit.
    var searchDeadline = Math.min(deadline, nowMs() + FALLBACK_SEARCH_MS);
    var settleSearch = resolveStep(rec, "search Soulseek for “" + query + "”");
    var ranked;
    try {
      // A deadline, not a stale check: at it the search is stopped and what
      // slskd collected so far is ranked, rather than thrown away.
      ranked = await searchForTrack({ title: title, artist: artistName, album: albumName },
        viewPrefs({ knownDurationSecs: durationSecs }), null, null, searchDeadline);
    } catch (e) {
      settleSearch((e && e.message) || String(e), "error");
      finishResolve(rec, "failed", (e && e.message) || "search failed");
      return null;
    }
    if (ranked === null) {
      settleSearch("another search held slskd until the time ran out", "warn");
      finishResolve(rec, "no-match", "slskd was busy with another search");
      return null;
    }
    var preferred = parsePreferredFormats(settings.preferredFormats);
    var mode = fallbackModeOf(settings.fallbackQuality);
    var byAlbum = ranked.byAlbum ? albumName : null;
    if (ranked.byAlbum) rec.query = ranked.byAlbum;
    var matches = rankFallback(ranked, title, artistName, preferred, mode, byAlbum);
    rec.candidates = matches.slice(0, FALLBACK_VIEW_CANDIDATES);
    settleSearch((ranked.byAlbum ? "“" + artistName + "” is a blocked search on Soulseek, so searched “" + ranked.byAlbum + "”: " : "") +
      ranked.length + " downloadable file" + (ranked.length === 1 ? "" : "s") + ", " + matches.length + " that match" +
      (ranked.partial ? " (cut at " + Math.round(FALLBACK_SEARCH_MS / 1000) + "s while slskd was still searching)" : ""), matches.length ? "info" : "warn");
    if (!matches.length) {
      // Say when it was the quality setting, not the song, that came up empty —
      // "nothing matched" would send the user looking in the wrong place.
      var unfiltered = fallbackModeFilters(mode) ? rankFallback(ranked, title, artistName, preferred, "best", byAlbum).length : 0;
      finishResolve(rec, "no-match", unfiltered
        ? "no " + (mode === "lossless" ? "lossless" : "MP3 320 / V0") + " file — " + unfiltered + " other matching file" + (unfiltered === 1 ? "" : "s") + " skipped by the Fallback quality setting"
        : (ranked.artistBlocked ? noMatchMessage(ranked, artistName, "")
          : (ranked.length ? "nothing on Soulseek matched the title and artist closely enough" : "nothing on Soulseek matched")));
      return null;
    }

    // 3. Fetch — hedged. See `raceSharers`.
    var race = await raceSharers(rec, matches, { fkey: fkey, title: title, artistName: artistName, query: ranked.byAlbum || query, deadline: deadline });
    clearLive(rec);
    if (race.state === "done") {
      finishResolve(rec, "played", null, race.path);
      schedulePoll(true);
      return fallbackAnswer(race.path);
    }
    if (race.state === "unlocated") {
      finishResolve(rec, "failed", "the download finished but its file could not be located");
      return null;
    }
    if (race.state === "timeout") {
      finishResolve(rec, "timeout", "the download did not finish within the budget; it continues in the background");
      schedulePoll(true);
      return null;
    }
    finishResolve(rec, "failed", race.state === "none" ? "every sharer refused the download" : "no sharer delivered the file in time");
    return null;
  } catch (e) {
    console.error("slskd: fallback resolve failed:", e);
    finishResolve(rec, "failed", (e && e.message) || String(e));
    return null;
  } finally {
    fallbackBusy = false;
  }
}

// ---------------------------------------------------------------------------
// Playback fallback — kept files and their removal
// ---------------------------------------------------------------------------
// Files this plugin fetched on the user's behalf are the one kind it is willing
// to delete, and only when asked. Deletion goes through slskd's own Files API:
// the daemon owns that folder, and the plugin sandbox can only remove files in
// its own data directory anyway. slskd gates that API behind
// `remote_file_management`, so a refusal is explained rather than swallowed.
var REMOTE_FILE_MANAGEMENT_HINT = "slskd refused to delete the file. Deleting through its API needs " +
  "a top-level `remote_file_management: true` line in slskd.yml (or SLSKD_REMOTE_FILE_MANAGEMENT=true) — slskd picks the change up without a restart.";

// Pure: the slskd folder a kept file sits in, base64'd for the Files API, read
// off its path — for an entry whose transfer record is gone. Every fallback
// fetch gets its own `DEST_ROOT/FALLBACK_SUBDIR/<seq>-<label>` folder, so that
// folder is exactly the file's. Null when the path doesn't show one, or its
// base64 can't be a route segment.
function fallbackDirB64(path) {
  var p = String(path || "").replace(/\\/g, "/");
  var marker = "/" + DEST_ROOT + "/" + FALLBACK_SUBDIR + "/";
  var at = p.lastIndexOf(marker);
  if (at < 0) return null;
  var dir = p.slice(at + marker.length).split("/")[0];
  if (!dir) return null;
  var b64 = b64encode(DEST_ROOT + "/" + FALLBACK_SUBDIR + "/" + dir);
  return b64.indexOf("/") < 0 ? b64 : null;
}

async function deleteFallbackFile(fkey) {
  var entry = fallback[fkey];
  if (!entry) return;
  var rec = tracked[entry.ref];
  var b64 = (rec && rec.b64) || fallbackDirB64(entry.path);
  if (b64) {
    var res = await slskd("DELETE", "/api/v0/files/downloads/directories/" + b64);
    if (res.status === 403) throw new Error(REMOTE_FILE_MANAGEMENT_HINT);
    if (!((res.status >= 200 && res.status < 300) || res.status === 404)) {
      throw new Error(errorText(res, "slskd couldn't delete that file (HTTP " + res.status + ")."));
    }
  } else if (rec || entry.path) {
    // Forgetting it here would leave the file on disk and count it as gone.
    throw new Error("That file's folder can't be addressed through slskd's API; delete it from slskd's downloads folder by hand.");
  }
  var t = transferByKey(entry.ref);
  if (t) {
    try { await cancelTransfer(t, true); } catch (e) { console.error("slskd: couldn't drop the transfer record:", e); }
  }
  delete tracked[entry.ref];
  delete fallback[fkey];
  await api.storage.set(stateKey("tracked"), tracked);
  await saveFallbackIndex();
}

async function deleteFallbackFiles(keys) {
  var failed = [];
  var firstError = null;
  for (var i = 0; i < keys.length; i++) {
    try {
      await deleteFallbackFile(keys[i]);
    } catch (e) {
      failed.push(keys[i]);
      if (!firstError) firstError = e;
      console.error("slskd: couldn't delete fallback file " + keys[i] + ":", e);
    }
  }
  render();
  renderSettings();
  schedulePoll(true);
  if (firstError) {
    api.ui.showNotification(failed.length === keys.length
      ? ((firstError && firstError.message) || "Couldn't delete the files.")
      : "Deleted " + (keys.length - failed.length) + " of " + keys.length + " — " + ((firstError && firstError.message) || "some couldn't be deleted."));
  } else if (keys.length) {
    api.ui.showNotification(keys.length === 1 ? "Deleted 1 fallback file." : "Deleted " + keys.length + " fallback files.");
  }
}

// ---------------------------------------------------------------------------
// Playback fallback — automatic cleanup
// ---------------------------------------------------------------------------
// Kept files are a cache, and a cache with no bound fills the disk. Two
// optional limits (Settings → Playback fallback), both off by default so an
// update never deletes anything the user didn't ask to have deleted:
// `fallbackMaxAgeDays` drops files not played for that long, `fallbackMaxGb`
// then drops the least recently played until the total fits.
//
// Never touched: a file inside one of the user's collections (it is a library
// track too — deleting it would leave a row with no file), one played in the
// last `FALLBACK_CLEANUP_RECENT_MS` (it may be the one playing), and a pending
// download (it isn't a file yet).

function fallbackUsedAt(e) {
  return e.lastUsedAt || e.at || 0;
}

// Pure: which kept files the limits remove, least recently played first.
// `opts`: { maxBytes, maxAgeMs (0 = off), now, protect(entry) → bool }.
function fallbackEvictions(index, opts) {
  var keys = Object.keys(index || {});
  var kept = [];
  var total = 0;
  for (var i = 0; i < keys.length; i++) {
    var e = index[keys[i]];
    if (!e || e.state !== "kept") continue;
    total += e.size || 0;
    var protectedEntry = (opts.now - fallbackUsedAt(e) < FALLBACK_CLEANUP_RECENT_MS) || (opts.protect && opts.protect(e));
    if (!protectedEntry) kept.push({ key: keys[i], e: e });
  }
  kept.sort(function (a, b) { return fallbackUsedAt(a.e) - fallbackUsedAt(b.e) || (a.key < b.key ? -1 : 1); });
  var out = [];
  for (var j = 0; j < kept.length; j++) {
    var c = kept[j];
    var stale = opts.maxAgeMs > 0 && opts.now - fallbackUsedAt(c.e) > opts.maxAgeMs;
    var over = opts.maxBytes > 0 && total > opts.maxBytes;
    if (!stale && !over) continue;
    out.push(c.key);
    total -= c.e.size || 0;
  }
  return out;
}

function fallbackLimitsOn() {
  return (Number(settings.fallbackMaxGb) || 0) > 0 || (Number(settings.fallbackMaxAgeDays) || 0) > 0;
}

var fallbackCleanupAt = 0;
var fallbackCleanupRunning = false;
// The last automatic cleanup's outcome, shown under the settings — never a
// toast, since this runs unattended every few minutes. { at, deleted, bytes, error }.
var fallbackCleanup = null;

// Apply the limits. `force` skips the throttle (a setting just changed).
async function enforceFallbackLimits(force) {
  if (!fallbackLimitsOn() || fallbackBusy || fallbackCleanupRunning || readiness.state !== "ready") return;
  if (!force && nowMs() - fallbackCleanupAt < FALLBACK_CLEANUP_EVERY_MS) return;
  fallbackCleanupAt = nowMs();
  var victims = fallbackEvictions(fallback, {
    maxBytes: (Number(settings.fallbackMaxGb) || 0) * GB,
    maxAgeMs: (Number(settings.fallbackMaxAgeDays) || 0) * 24 * 60 * 60 * 1000,
    now: nowMs(),
    protect: function (e) { return !!(e.path && collectionForPath(e.path, localCollections)); }
  });
  if (!victims.length) {
    if (fallbackCleanup && fallbackCleanup.error) { fallbackCleanup = null; renderSettings(); }
    return;
  }
  fallbackCleanupRunning = true;
  var deleted = 0, bytes = 0, error = null;
  try {
    for (var i = 0; i < victims.length; i++) {
      var e = fallback[victims[i]];
      if (!e) continue;
      try {
        await deleteFallbackFile(victims[i]);
        deleted++;
        bytes += e.size || 0;
      } catch (err) {
        // A refusal (no remote_file_management) refuses every file the same
        // way: stop rather than hammer slskd with the rest.
        error = (err && err.message) || String(err);
        console.error("slskd: automatic fallback cleanup failed:", err);
        break;
      }
    }
  } finally {
    fallbackCleanupRunning = false;
  }
  fallbackCleanup = { at: nowMs(), deleted: deleted, bytes: bytes, error: error };
  if (deleted) api.log("info", "fallback cleanup: deleted " + deleted + " file(s), " + formatBytes(bytes), "slskd");
  render();
  renderSettings();
}


// ---------------------------------------------------------------------------
// Setup — the guide lives on the plugin's GitHub Pages site, not in this view:
// a web page can auto-detect the OS, offer real Copy buttons and be read on
// the phone next to the computer being set up. The plugin's job is to mint
// the API key, hand it to the page in the URL fragment (never sent to the
// server) and connect once slskd is up. Nothing is downloaded, written or
// launched from here — the user owns slskd.
// ---------------------------------------------------------------------------

var PAGES_URL = "https://outcast1000.github.io/viboplr-slskd/";
var WHAT_IS_THIS_URL = PAGES_URL + "what-is-this.html";
var SETUP_GUIDE_URL = PAGES_URL;
var SETUP_DEFAULT_URL = "http://localhost:5030";

// 40 hex chars. Math.random is the only source the plugin sandbox offers (no
// crypto); the key only ever travels between two programs on the user's own
// machine, and slskd itself accepts anything 16–255 chars long.
function randomApiKey() {
  var hex = "0123456789abcdef";
  var out = "";
  for (var i = 0; i < 40; i++) out += hex.charAt(Math.floor(Math.random() * 16));
  return out;
}

// The key rides in the fragment so the setup page can fill it into the yml
// snippet without it ever reaching GitHub's servers. The about page carries
// the fragment along to the setup page.
//
// `collections` (the host's local collections) ride along the same way, as
// `share=` — newline-joined paths — so the guide can offer them as the shared
// folders to pick from. Same fragment rule: the paths reach the page's own
// script and never a server.
// Pure: the host's local collections as folder paths, deduped, in order —
// what slskd shares by default, whichever way it is installed.
function collectionPaths(collections) {
  var paths = [];
  for (var i = 0; collections && i < collections.length; i++) {
    var p = collections[i] && collections[i].path;
    if (p && paths.indexOf(p) < 0) paths.push(p);
  }
  return paths;
}

function guideFragment(apiKey, collections) {
  var out = "#key=" + encodeURIComponent(apiKey || "");
  var paths = collectionPaths(collections);
  if (paths.length) out += "&share=" + encodeURIComponent(paths.join("\n"));
  return out;
}
function setupGuideUrl(apiKey, collections) {
  return SETUP_GUIDE_URL + guideFragment(apiKey, collections);
}
function whatIsThisUrl(apiKey, collections) {
  return WHAT_IS_THIS_URL + guideFragment(apiKey, collections);
}


// ---------------------------------------------------------------------------
// Installing slskd on this computer (api.system.programs)
// ---------------------------------------------------------------------------
// One of three ways to get slskd (the others: the manual guide, and connecting
// to one the user runs). Viboplr installs slskd as one of its own tools: the
// manifest's binaryDependencies entry says where it comes from (slskd/slskd's
// GitHub releases, checked against GitHub's checksum), and Viboplr downloads
// it on the user's click, lists it in Extensions → Tools and announces its
// updates there. The plugin only starts and stops it
// (api.system.programs.start({ dependency: "slskd" })) and writes its
// settings. Viboplr never starts it by itself, except to restart it around an
// update the user clicked: the plugin starts slskd when Viboplr opens
// (settings.startWithViboplr) or when the user asks.
//
// Where things live (the plugin's own storage folder, `api.storage.files`):
//
//   slskd/data/slskd.yml        written once at install; slskd owns it after
//   slskd/data/app/             slskd's app directory (database, its own logs)
//   slskd/data/extract/         .NET's single-file extraction folder
//   slskd/data/incomplete/      partial downloads (here, so no folder outside
//                               the store has to be created for slskd)
//   logs/slskd.log              slskd's output (the host writes it)
//
// The program itself is Viboplr's, in its shared tools folder. Plugin versions
// up to 0.25.0 downloaded slskd into this store instead (slskd/<version>/): a
// record without `source: "host"` is such a copy. It keeps starting from there
// and offers one row, Move, which switches it to Viboplr's copy; it gets no
// updates until it moves.
//
// The permission it needs (`programs:run`) is an OPTIONAL one in the manifest:
// a user who runs their own slskd is never asked for it. Nothing here runs
// without the user's click.

var MANAGED_NAME = "slskd";          // the program's name in api.system.programs
var SLSKD_TOOL = "slskd";            // the tool's name in binaryDependencies / Extensions → Tools
var MANAGED_RECORD_KEY = "managedSlskd";
var MANAGED_DIR = "slskd";
var MANAGED_LISTEN_PORT = 50300;     // Soulseek's incoming connections (slskd's default)
var MANAGED_WEB_PORTS = [5030, 5031, 5032, 5033, 5034, 5035, 5036, 5037, 5038, 5039];
var MANAGED_STOP_GRACE_SECS = 15;
var INSTALL_DECLINED = "Install declined";
// What programs.start rejects with when the user says no to "Run slskd in the
// background?" (the host's DEPENDENCY_RUN_DECLINED).
var RUN_DECLINED = "Run declined";
// After asking Viboplr to install slskd: how often to look whether it landed,
// and for how long. The install dialog is the user's; they may take a while.
var TOOL_POLL_MS = 3000;
var TOOL_WAIT_MS = 5 * 60 * 1000;

// supported: this host can install slskd as its tool and run it; dep: what
// the host says about that tool (api.system.getDependency: { installed,
// version, origin, latest }, or null when no definition is in force); record:
// what the install left (storage `managedSlskd`: { source: "host", port,
// webUsername, webPassword, downloadsDir, installedAt } — a legacy store copy
// has { version, asset } instead of source); status: the host's last
// api.system.programs.status; job: a start / stop / move / share the user
// started ({ kind, line, percent }); error: the last failure, shown until the
// next attempt; setup: the install checklist while it runs.
var managed = { supported: false, dep: null, record: null, status: null, job: null, error: null, setup: null };
// What slskd itself shares (GET /api/v0/shares), read once slskd is ready;
// null when not read.
var slskdShared = null;
// The install form. The Soulseek account is also kept in plugin storage
// (ACCOUNT_KEY) as it is typed, so a restart — or an install that failed and
// is tried again later — doesn't make the user type it again; it outlives a
// finished install too, for the next one, until the card's Remove forgets it
// (forgetAccount). It is stored in the clear, as
// slskd.yml stores it. The rest of the form is memory only. `autostart` (saved as
// settings.startWithViboplr once the install succeeds) defaults on: slskd is
// meant to be running whenever Viboplr is; the user can turn that off here or
// later.
// `shareCollections`: share the user's Viboplr collections on Soulseek — on
// unless they turn it off, because Soulseek queues people who share nothing
// behind everyone else.
// `downloadsDir` starts as <Downloads>/Soulseek (prefillDownloadsDir), so the
// form needs no picking before it works.
var installForm = freshInstallForm();
var ACCOUNT_KEY = "soulseekAccount";
// Writes chained so they land in typing order.
var accountWrite = Promise.resolve();

// The form as it starts: empty, except the account the user last typed.
function freshInstallForm() {
  return {
    username: installForm ? installForm.username : "",
    password: installForm ? installForm.password : "",
    downloadsDir: "", autostart: true, shareCollections: true
  };
}

// Pure: the stored account, or null for nothing worth keeping.
function storedAccount(form) {
  var username = String((form && form.username) || "");
  var password = String((form && form.password) || "");
  return username || password ? { username: username, password: password } : null;
}

// Written on every keystroke, not after a pause: deactivate can't wait for a
// write, so a debounced one pending at quit would be lost. An emptied form
// deletes the key rather than storing null.
function saveAccount() {
  var account = storedAccount(installForm);
  // Taken now: a write still queued when deactivate clears `api` must land.
  var storage = api.storage;
  accountWrite = accountWrite.then(function () {
    return account ? storage.set(ACCOUNT_KEY, account) : storage.delete(ACCOUNT_KEY);
  }).catch(function (e) {
    console.error("slskd: couldn't save the Soulseek account:", e);
  });
  return accountWrite;
}

// Remove forgets the account too: the user asked for slskd to be gone, and
// the password shouldn't outlive it in the plugin's storage.
function forgetAccount() {
  installForm.username = "";
  installForm.password = "";
  return saveAccount();
}

async function loadAccount() {
  try {
    var a = await api.storage.get(ACCOUNT_KEY);
    if (a && typeof a === "object") {
      installForm.username = typeof a.username === "string" ? a.username : "";
      installForm.password = typeof a.password === "string" ? a.password : "";
    }
  } catch (e) {
    console.error("slskd: couldn't read the Soulseek account:", e);
  }
}

// Pure: the program file inside a legacy store copy (slskd/<version>/).
function slskdBinaryName(asset) {
  return /^win-/.test(String(asset || "")) ? "slskd.exe" : "slskd";
}

// Pure: the record is Viboplr's copy of slskd, not a legacy store copy.
function isHostRecord(record) {
  return !!(record && record.source === "host");
}

// Pure: the tool is installed as Viboplr's own copy (a system copy on PATH is
// the user's, and Viboplr never starts it).
function hostToolReady(dep) {
  return !!(dep && dep.installed && dep.origin === "managed");
}

// Pure: "<downloads>/Soulseek", with the separator the folder already uses.
function defaultDownloadsDir(folders) {
  var d = folders && typeof folders.downloads === "string" ? trimDir(folders.downloads) : "";
  if (!d) return "";
  var sep = d.indexOf("\\") >= 0 && d.indexOf("/") < 0 ? "\\" : "/";
  return d + sep + "Soulseek";
}

// The form's downloads folder starts as <Downloads>/Soulseek when the host
// can say where Downloads is; otherwise the user picks one.
async function prefillDownloadsDir() {
  if (installForm.downloadsDir || !api || !api.system || typeof api.system.userFolders !== "function") return;
  try {
    var dir = defaultDownloadsDir(await api.system.userFolders());
    if (dir && !installForm.downloadsDir) installForm.downloadsDir = dir;
  } catch (e) {
    console.error("slskd: couldn't read the Downloads folder:", e);
  }
}

// 24 random alphanumerics for slskd's web sign-in. Math.random is all the
// sandbox offers (no crypto); the page listens on 127.0.0.1 only.
function randomPassword() {
  var chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  var out = "";
  for (var i = 0; i < 24; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

// Pure: slskd.yml for a fresh install. Every string is written as a JSON
// string, which is a valid YAML double-quoted scalar (a Windows path's
// backslashes included), so no value can break the file's structure. The
// shape is the one Roadie's slskd setup used (revision 6), with two changes:
// the web sign-in is a random one rather than slskd's guessable default, and
// partial downloads go inside the plugin's own folder.
//   remote_configuration: lets the plugin add shared folders later through
//     slskd's own settings API (validated by slskd);
//   remote_file_management: lets the plugin delete the fallback's files;
//   web on 127.0.0.1 only, the API key limited to this computer.
function renderSlskdYml(c) {
  var q = function (s) { return JSON.stringify(String(s)); };
  var shares = (c.shares || []).map(function (d) { return "    - " + q(d); });
  return [
    "# Written by Viboplr's Soulseek plugin when it installed slskd. slskd owns",
    "# this file from here on: change settings in slskd's web page.",
    "headless: false",
    "remote_configuration: true",
    "remote_file_management: true",
    "flags:",
    "  no_logo: true",
    "  no_version_check: true",
    "directories:",
    "  downloads: " + q(c.downloadsDir),
    "  incomplete: " + q(c.incompleteDir),
    "shares:",
    shares.length ? "  directories:\n" + shares.join("\n") : "  directories: []",
    "web:",
    "  port: " + Number(c.port),
    "  ip_address: \"127.0.0.1\"",
    "  https:",
    "    disabled: true",
    "  authentication:",
    "    disabled: false",
    "    username: " + q(c.webUsername),
    "    password: " + q(c.webPassword),
    "    api_keys:",
    "      viboplr:",
    "        key: " + q(c.apiKey),
    "        role: readwrite",
    "        cidr: \"127.0.0.1/32,::1/128\"",
    "soulseek:",
    "  username: " + q(c.soulseekUsername),
    "  password: " + q(c.soulseekPassword),
    "  listen_port: " + Number(c.listenPort || MANAGED_LISTEN_PORT),
    ""
  ].join("\n");
}

// Pure: the folders the install shares — the downloads folder, then the
// collections (when the user leaves that on), each once.
function installShares(form, collections) {
  var out = [];
  var add = function (p) { if (p && out.indexOf(p) < 0) out.push(p); };
  add(trimDir(form.downloadsDir));
  if (form.shareCollections) collectionPaths(collections).forEach(function (p) { add(trimDir(p)); });
  return out;
}

// Pure: the install can go ahead.
function installFormComplete(form) {
  return !!(form && String(form.username || "").trim() && String(form.password || "") && String(form.downloadsDir || "").trim());
}

// Pure: what a failed program call means to the user. The host rejects an
// install the user turned down with "Install declined", and a permission they
// refused with a PermissionError naming it.
// `kind` is what was being done ("start", "restart", "move"…); a refused
// permission means something different for a start than for an install.
function managedFailure(e, kind) {
  var msg = String((e && e.message) || e || "");
  var starting = kind === "start" || kind === "restart";
  if (msg === INSTALL_DECLINED) return { declined: true, message: "You cancelled the install." };
  if (msg.indexOf(RUN_DECLINED) === 0) return { declined: true, message: "You didn't allow slskd to run in the background, so it wasn't started." };
  if (/^Permission denied/.test(msg)) {
    return { declined: true, message: starting
      ? "You didn't allow Soulseek to run programs, so slskd wasn't started. Start slskd asks again."
      : "Viboplr wasn't allowed to install programs for this plugin, so nothing was installed." };
  }
  if (/already running/i.test(msg)) return { declined: false, message: "Another copy of slskd is already running on this computer. Quit it (or connect Viboplr to it instead), then try again." };
  return { declined: false, message: msg || "Something went wrong." };
}

// Pure: the host can install slskd as its own tool and run it for this
// plugin (Viboplr 1.0.113+). Whether slskd's definition is in force is
// `managed.dep`, read from the host.
function managedCapable(a) {
  return !!(a && a.system && a.system.programs && typeof a.system.programs.start === "function" &&
    typeof a.system.getDependency === "function" &&
    a.ui && typeof a.ui.pickFolder === "function" && typeof a.ui.requestAction === "function");
}

// Pure: "Install automatically" can be offered: a capable host. slskd's
// definition need not be in force yet — an unsigned (side-loaded or dev) copy's
// waits for the user's consent, which the host asks for when the install
// requests the tool (`require-dependency`). minAppVersion 1.0.113 guarantees a
// host that accepts the definition at all.
function canInstallHere(m) {
  return !!(m && m.supported);
}

// Pure: the address the plugin talks to is the slskd it installed: a loopback
// host on the port it chose. "localhost:5030" and "127.0.0.1:5030" are the
// same slskd.
function isLoopbackHost(h) {
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}
function hostPort(u) {
  var m = /^\s*(https?):\/\/(\[[^\]]+\]|[^:\/]+)(?::(\d+))?/i.exec(String(u || ""));
  if (!m) return null;
  return { host: m[2].toLowerCase(), port: m[3] ? Number(m[3]) : (m[1].toLowerCase() === "https" ? 443 : 80) };
}
function managedOwnsAddress(url, record) {
  if (!record || !record.port) return false;
  var a = hostPort(url);
  return !!(a && a.port === Number(record.port) && isLoopbackHost(a.host));
}

// Pure: the plugin installed slskd and uses it.
function usesManaged(cfg, m) {
  return !!(cfg && cfg.managedBy === "plugin" && m && m.record);
}

async function loadManagedRecord() {
  try {
    var r = await api.storage.get(MANAGED_RECORD_KEY);
    managed.record = r && typeof r === "object" && (r.version || r.source === "host") ? r : null;
  } catch (e) {
    console.error("slskd: couldn't read the install record:", e);
    managed.record = null;
  }
}

async function saveManagedRecord(r) {
  managed.record = r;
  try {
    if (r) await api.storage.set(MANAGED_RECORD_KEY, r);
    else await api.storage.delete(MANAGED_RECORD_KEY);
  } catch (e) {
    console.error("slskd: couldn't save the install record:", e);
  }
}

// What the host says about the slskd this plugin started. Cheap (no
// process is spawned), so it runs on every readiness pass while installed.
async function probeManaged() {
  managed.supported = managedCapable(api);
  if (!managed.supported) { managed.status = null; managed.dep = null; return; }
  try {
    managed.dep = await api.system.getDependency(SLSKD_TOOL);
  } catch (e) {
    console.error("slskd: couldn't read the slskd tool's status:", e);
    managed.dep = null;
  }
  if (!managed.record) { managed.status = null; return; }
  try {
    managed.status = await api.system.programs.status(MANAGED_NAME);
  } catch (e) {
    // Not allowed (the optional permission was revoked): treat as not running.
    console.error("slskd: couldn't read slskd's status:", e);
    managed.status = null;
  }
}

// Absolute path of something in the store, made to exist first when it is a
// folder slskd needs.
async function storePath(segments, ensureDir) {
  if (ensureDir) await api.storage.files.writeText(segments.concat([".keep"]), "");
  var p = await api.storage.files.getPath(segments);
  if (!p) throw new Error("couldn't locate " + segments.join("/") + " in the plugin's folder");
  return trimDir(p);
}

// Pure: what api.system.programs.start gets, from paths already resolved.
// Viboplr's copy is named by the tool (the host finds it, and its working
// folder is this plugin's store); a legacy store copy by its path.
function managedStartSpec(record, paths, outliveApp) {
  var where = isHostRecord(record)
    ? { dependency: SLSKD_TOOL }
    : { path: [MANAGED_DIR, record.version, slskdBinaryName(record.asset)] };
  return Object.assign(where, {
    args: ["--app-dir", paths.app, "--config", paths.config, "--no-logo"],
    env: {
      // .NET unpacks a single-file app on first run; keep that inside the
      // plugin's folder so a removal is complete.
      DOTNET_BUNDLE_EXTRACT_BASE_DIR: paths.extract,
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      DOTNET_NOLOGO: "1"
    },
    outliveApp: outliveApp !== false
  });
}

async function managedPaths() {
  return {
    app: await storePath([MANAGED_DIR, "data", "app"], true),
    extract: await storePath([MANAGED_DIR, "data", "extract"], true),
    config: await storePath([MANAGED_DIR, "data", "slskd.yml"], false)
  };
}

// Pure: a fetch error that means nothing listens on the port. Only a refused
// connection says so ("Connection refused (os error 61)", Windows' "actively
// refused it"); a timeout or anything else may be a program that is slow to
// answer, and binding next to it would fail.
function portLooksFree(error) {
  return /refused/i.test(String((error && error.message) || error || ""));
}

// How long a port probe waits for its refusal. Windows doesn't refuse a
// connection to a closed localhost port at once: it retries the SYN and
// answers "actively refused" after about 2s (measured 2.1s). An 800ms budget
// timed out on every port first, so a free computer read as "all taken".
var PORT_PROBE_TIMEOUT_MS = 4000;

// Probe every item at once and resolve with the first, in list order, whose
// probe answers non-null — as soon as every item before it has answered null,
// without waiting for the slower ones after it. Resolves null when none does.
// Probing at once matters on Windows, where a closed localhost port refuses
// only after ~2s: in turn, a dozen ports cost half a minute.
function firstInOrder(items, probe) {
  return new Promise(function (resolve) {
    var answers = new Array(items.length);
    var settled = new Array(items.length);
    var done = false;
    function check() {
      if (done) return;
      for (var i = 0; i < items.length; i++) {
        if (!settled[i]) return;
        if (answers[i] != null) { done = true; resolve(answers[i]); return; }
      }
      done = true;
      resolve(null);
    }
    if (!items.length) { resolve(null); return; }
    items.forEach(function (item, i) {
      Promise.resolve().then(function () { return probe(item); }).then(function (v) { answers[i] = v == null ? null : v; }, function (e) {
        console.error("slskd: probe of", item, "failed:", e);
        answers[i] = null;
      }).then(function () { settled[i] = true; check(); });
    });
  });
}

// The first web port nothing listens on. Anything that answers (even an
// error page) or hangs is in use; the lowest free port wins, not the first
// to answer.
function pickFreePort() {
  return firstInOrder(MANAGED_WEB_PORTS, function (port) {
    return api.network.fetch("http://127.0.0.1:" + port + "/", { method: "GET", timeoutMs: PORT_PROBE_TIMEOUT_MS, headers: { "User-Agent": CLIENT_USER_AGENT } })
      .then(function () { return null; }, function (e) {
        if (portLooksFree(e)) return port;
        // A timeout or anything but a refusal: something may be there, so the
        // port is skipped — logged, since a wrong budget once made every port
        // look taken.
        console.error("slskd: port " + port + " didn't refuse a connection, treating it as in use:", e);
        return null;
      });
  });
}

// Make sure Viboplr has its copy of slskd: already there, or ask Viboplr to
// install it (its own dialog: "slskd is needed …", with the download and the
// checksum check) and look every few seconds until it lands. Resolves with
// the tool's status, or null once `isCurrent()` says nobody is waiting any
// more (Cancel, a deactivate). The host tells the plugin nothing when the
// dialog closes, so a dialog turned down shows up as the wait running out.
// Polls with Viboplr still knowing nothing of slskd before the checklist says
// so (~12s at the real poll rate). A definition waiting for the user's trust
// also reads as null, so this can't fail at once: the consent dialog comes
// first and may take a moment to answer.
var NO_DEFINITION_HINT_POLLS = 4;
var NO_DEFINITION_HINT = "Viboplr doesn't know how to install slskd yet, so it has no Install dialog to show. " +
  "If it asked whether to trust this plugin's tool, answer that first. Otherwise its notifications (the bell) may say why — " +
  "a development copy of this plugin needs a development build of Viboplr. You can also run slskd yourself and connect to it.";

// `onNoDefinition(text | null)`: shown while Viboplr has no slskd definition
// (getDependency answers null), cleared once it has one.
// A require-dependency asked for while there is no definition is dropped by
// the host (the trust prompt may still be open), so it is asked for again the
// first time a definition appears; otherwise the user who answered the trust
// prompt would never see an Install dialog and the wait would just run out.
async function ensureHostTool(isCurrent, onNoDefinition) {
  var dep = await api.system.getDependency(SLSKD_TOOL);
  if (hostToolReady(dep)) return dep;
  if (dep && dep.installed && dep.origin === "system") {
    throw new Error("slskd is already installed on this computer outside Viboplr" + (dep.version ? " (" + dep.version + ")" : "") + ". Viboplr doesn't start that copy: start it the way you installed it and connect to it instead.");
  }
  function requestInstall() {
    api.ui.requestAction("require-dependency", { name: SLSKD_TOOL, feature: "Running slskd for you" });
  }
  requestInstall();
  var defined = !!dep;
  var hinted = false;
  var until = Date.now() + TOOL_WAIT_MS;
  for (var polls = 1; Date.now() < until; polls++) {
    await sleep(TOOL_POLL_MS);
    if (!api || !isCurrent()) return null;
    try {
      dep = await api.system.getDependency(SLSKD_TOOL);
    } catch (e) {
      console.error("slskd: couldn't read the slskd tool's status:", e);
      dep = null;
    }
    if (dep && hinted) {
      hinted = false;
      if (onNoDefinition) onNoDefinition(null);
    }
    if (hostToolReady(dep)) return dep;
    if (dep && !defined) {
      defined = true;
      requestInstall();
    } else if (!dep && !defined && !hinted && polls >= NO_DEFINITION_HINT_POLLS) {
      hinted = true;
      if (onNoDefinition) onNoDefinition(NO_DEFINITION_HINT);
    }
  }
  if (!defined) {
    throw new Error("Viboplr never offered to install slskd: it still has no definition for it. If it asked whether to trust this plugin's tool, answer that and try again " +
      "(a development copy of this plugin needs a development build of Viboplr). You can also run slskd yourself and connect to it.");
  }
  throw new Error("slskd wasn't installed. Install it from Viboplr's dialog (or Extensions → Tools), then try again.");
}

// ---- The install: one screen, one checklist ------------------------------
//
// While `managed.setup` is set the view shows nothing but this (render()).
// Each step moves on only on a signal we really have: the first progress
// report (the user said yes to Viboplr's dialogs), the download's bytes, the
// unpack and version check, the host starting slskd, our own connection, and
// slskd's server state.

var SETUP_STEPS = [
  { id: "approve", label: "Install slskd in Viboplr" },
  { id: "start", label: "Start slskd" },
  { id: "connect", label: "Connect Viboplr" },
  { id: "signin", label: "Sign in to Soulseek" }
];
var SIGNIN_WAIT_MS = 45000;
var SIGNIN_POLL_MS = 2000;

function setupIndex(id) {
  for (var i = 0; i < SETUP_STEPS.length; i++) if (SETUP_STEPS[i].id === id) return i;
  return -1;
}

// Pure: a fresh setup for the account the user typed (or none).
function newSetup(username) {
  return { at: 0, percent: null, progress: null, failed: null, username: String(username || "").trim() || null };
}

// Pure: move to `id` — never backwards, and never past a failure.
function advanceSetup(s, id) {
  var i = setupIndex(id);
  if (!s || s.failed || i <= s.at) return s;
  s.at = i;
  s.percent = null;
  s.progress = null;
  return s;
}

// Pure: stop at the current step with a message.
function failSetup(s, message) {
  if (s && !s.failed) s.failed = { step: SETUP_STEPS[s.at].id, message: message };
  return s;
}

// Pure: the checklist rows — { id, label, state: done|active|failed|pending, detail }.
function setupChecklist(s) {
  return SETUP_STEPS.map(function (step, i) {
    var state = i < s.at ? "done" : (i > s.at ? "pending" : (s.failed ? "failed" : "active"));
    var label = step.label;
    if (step.id === "signin" && s.username) label = "Sign in to Soulseek as " + s.username;
    var detail = null;
    if (state === "failed") detail = s.failed.message;
    else if (state === "active" && step.id === "approve") detail = s.progress || "Viboplr asks before it installs anything: press Install in its dialog. Once installed, slskd appears in Extensions → Tools, where Viboplr keeps it up to date.";
    else if (state === "active" && step.id === "signin" && s.progress) detail = s.progress;
    return { id: step.id, label: label, state: state, detail: detail };
  });
}

// Pure: why sign-in hasn't happened, when slskd's log names no reason.
function signinFailure(state, username) {
  if (!username) return "No Soulseek account was given, so slskd can't sign in and search.";
  if (state === "disconnected" || state === "connecting") {
    return "slskd couldn't reach the Soulseek server yet. It keeps trying in the background; a VPN or firewall may be blocking it.";
  }
  if (state === "unauthorized") return "slskd rejected Viboplr's key.";
  if (state === "unreachable") return "slskd stopped answering.";
  return "slskd isn't ready (" + state + ").";
}

// Pure: the live line under the sign-in step, from slskd's server state.
function signinProgress(serverState, secs) {
  var st = String(serverState || "");
  var t = secs > 0 ? " " + secs + "s" : "";
  if (/LoggingIn/i.test(st)) return "Connected; signing in…" + t;
  if (/Connecting/i.test(st)) return "Connecting to the Soulseek server…" + t;
  if (/Disconnected|^None$/i.test(st) || !st) return "Waiting for slskd to reach the Soulseek server…" + t;
  return "slskd reports: " + st + t;
}

// Pure: the reason slskd's own log gives for not signing in, newest first,
// as { kind, message } — or null when the log says nothing we can name.
// "rejected" is final (slskd won't get in by retrying); "kicked" means
// another client signed in with the same account, and slskd does not sign in
// again by itself after that; "network" is what a VPN or firewall looks like
// from here. A sign-in newer than any failure means the failure is history.
function signinReasonFromLog(lines, username) {
  var list = Array.isArray(lines) ? lines : [];
  for (var i = list.length - 1; i >= 0; i--) {
    var l = String(list[i] || "");
    if (/Logged in to the Soulseek server/i.test(l)) return null;
    // Checked before the network case: the line starts "Disconnected from
    // the Soulseek server" too, and was once reported as a firewall.
    if (/another client logged in using the same username/i.test(l)) {
      return { kind: "kicked", message: "Soulseek signed slskd out because another app signed in" + (username ? " as " + username : "") + " (Nicotine+, SoulseekQt, or slskd on another computer). Soulseek allows one sign-in per account: close the other one or give it a different account, then restart slskd. slskd doesn't sign in again by itself after this." };
    }
    if (/INVALIDPASS|rejected (the )?login|invalid (user(name)?|password)/i.test(l)) {
      return { kind: "rejected", message: "The Soulseek server refused to sign in" + (username ? " as " + username : "") + ": the password is wrong, or someone else already uses that username." };
    }
    // Connected, then closed before any login answer: something between slskd
    // and the server took the connection and dropped it. A work web filter
    // does exactly this (Zscaler answers Soulseek's login with an HTTP 403).
    // A wrong password gets an answer, not a hang-up, so this isn't one.
    if (/Disconnected from the Soulseek server:\s*"?Remote connection closed/i.test(l) &&
        i > 0 && /Connected to the Soulseek server/i.test(String(list[i - 1] || ""))) {
      return { kind: "blocked", message: "The network cuts slskd off from the Soulseek server: the connection opens, then closes before Soulseek answers. A work network or web filter (Zscaler, for example), a VPN, or a firewall is blocking Soulseek. Restarting slskd won't help. Try another network, or ask whoever runs this one. slskd keeps retrying, and signs in by itself once it gets through." };
    }
    if (/(Disconnected from|Failed to connect to|Failed to log in to) the Soulseek server/i.test(l) ||/Soulseek server.*(timed out|refused|unreachable)/i.test(l)) {
      var why = /timed out/i.test(l) ? "the connection timed out"
        : (/refused/i.test(l) ? "the connection was refused"
          : (/unreachable|no route/i.test(l) ? "the network can't reach it" : "the connection failed"));
      return { kind: "network", message: "slskd can't reach the Soulseek server: " + why + ". A VPN, a work network or a firewall is probably blocking it. slskd keeps retrying in the background, and searching works once it gets through." };
    }
  }
  return null;
}

// slskd's output as the host captured it (logs/slskd.log in the plugin's
// folder), last 1000 lines: a slskd whose key is refused writes a warning a
// minute, which buries the sign-in lines that say what went wrong.
async function managedLogLines() {
  if (!managed.record) return [];
  try {
    var text = await api.storage.files.readText(["logs", MANAGED_NAME + ".log"]);
    var lines = String(text || "").split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - 1000));
  } catch (e) {
    console.error("slskd: couldn't read slskd's log:", e);
    return [];
  }
}

async function installSlskd() {
  // The button is disabled without a complete form; Enter in the password
  // field is the other way here.
  if (!installFormComplete(installForm) || managed.setup) return;
  var form = Object.assign({}, installForm);
  var s = newSetup(form.username);
  managed.setup = s;
  render();
  try {
    await installSteps(s, form);
  } catch (e) {
    if (managed.setup !== s) return;
    var f = managedFailure(e);
    console.error("slskd: install failed:", e);
    if (f.declined) {
      // Back to the form, with what the user typed still in it.
      managed.setup = null;
      managed.error = f.message;
    } else {
      failSetup(s, f.message);
      api.log("warn", "slskd install: " + f.message, "slskd");
    }
    render();
  }
}

async function installSteps(s, form) {
  managed.error = null;
  var dep = await ensureHostTool(function () { return managed.setup === s; }, function (hint) {
    s.progress = hint;
    render();
  });
  if (!dep || managed.setup !== s) return;
  managed.dep = dep;

  var port = await pickFreePort();
  if (!port) throw new Error("Ports " + MANAGED_WEB_PORTS[0] + "–" + MANAGED_WEB_PORTS[MANAGED_WEB_PORTS.length - 1] + " are all taken on this computer, so slskd has no port for its web page.");
  ensureSetupKey();
  await loadCollections();
  var record = {
    source: "host",
    port: port,
    webUsername: "viboplr",
    webPassword: randomPassword(),
    downloadsDir: trimDir(form.downloadsDir),
    installedAt: Date.now()
  };
  var incomplete = await storePath([MANAGED_DIR, "data", "incomplete"], true);
  await api.storage.files.writeText([MANAGED_DIR, "data", "slskd.yml"], renderSlskdYml({
    downloadsDir: record.downloadsDir,
    incompleteDir: incomplete,
    shares: installShares(form, localCollections),
    port: port,
    webUsername: record.webUsername,
    webPassword: record.webPassword,
    apiKey: settings.apiKey,
    soulseekUsername: String(form.username).trim(),
    soulseekPassword: String(form.password)
  }));
  await saveManagedRecord(record);
  api.log("info", "slskd " + (dep.version || "") + " set up (Viboplr's copy, port " + port + ")", "slskd");

  advanceSetup(s, "start");
  render();
  try {
    await startManagedProcess();
  } catch (e) {
    // "Don't allow" in the run dialog: nothing is left half set up.
    if (managedFailure(e).declined) await saveManagedRecord(null);
    throw e;
  }
  await setStartWithViboplr(!!form.autostart);
  await probeManaged();
  await continueSetup(s, "connect");
}

// The steps after slskd started; also what Try again re-runs from the failed
// step. Anything that throws fails the step it happened on, so the checklist
// can never be left spinning.
async function continueSetup(s, from) {
  try {
    await continueSetupSteps(s, from);
  } catch (e) {
    console.error("slskd: setup step failed:", e);
    if (managed.setup !== s) return;
    failSetup(s, managedFailure(e).message);
    render();
  }
}

async function continueSetupSteps(s, from) {
  s.failed = null;
  s.at = Math.min(s.at, setupIndex(from));
  advanceSetup(s, from);
  if (s.at === setupIndex("start")) {
    render();
    await startManagedProcess();
    await probeManaged();
    advanceSetup(s, "connect");
  }
  if (s.at === setupIndex("connect")) {
    render();
    await useManagedConnection();
    advanceSetup(s, "signin");
  }
  render();
  var started = Date.now();
  var until = started + SIGNIN_WAIT_MS;
  for (var polls = 1; ; polls++) {
    await refreshReadiness();
    if (managed.setup !== s) return;
    if (readiness.state === "ready") {
      api.log("info", "slskd set up and signed in as " + (readiness.username || "?"), "slskd");
      // Only now: until it works, Back returns to the form as the user filled it.
      installForm = freshInstallForm();
      managed.setup = null;
      render();
      renderSettings();
      return;
    }
    s.progress = signinProgress(lastServerState, Math.round((Date.now() - started) / 1000));
    // A refused sign-in won't fix itself by waiting: look for one every few
    // polls and stop at once.
    if (polls % 5 === 0) {
      var early = signinReasonFromLog(await managedLogLines(), s.username);
      if (managed.setup !== s) return;
      if (early && early.kind === "rejected") {
        failSetup(s, early.message);
        render();
        return;
      }
    }
    render();
    if (Date.now() >= until) break;
    await sleep(SIGNIN_POLL_MS);
    if (managed.setup !== s) return;
  }
  var reason = signinReasonFromLog(await managedLogLines(), s.username);
  if (managed.setup !== s) return;
  failSetup(s, reason ? reason.message : signinFailure(readiness.state, s.username));
  render();
}

// Point the plugin at the slskd it installed.
async function useManagedConnection() {
  var r = managed.record;
  settings.url = "http://127.0.0.1:" + r.port;
  settings.insecure = false;
  settings.managedBy = "plugin";
  await Promise.all([
    api.storage.set("url", settings.url),
    api.storage.set("apiKey", settings.apiKey),
    api.storage.set("insecure", false),
    api.storage.set("managedBy", "plugin")
  ]).catch(function (e) { console.error("slskd: couldn't save the connection:", e); });
  downloadsDir = null;
  incompleteDir = null;
}

async function releaseManagedConnection() {
  settings.url = "";
  settings.managedBy = null;
  await Promise.all([
    api.storage.set("url", ""),
    api.storage.set("managedBy", null)
  ]).catch(function (e) { console.error("slskd: couldn't clear the connection:", e); });
}

// The whole view while an install runs.
function setupProgressView() {
  var s = managed.setup;
  var glyph = { done: "✓", active: "●", failed: "✗", pending: "○" };
  var children = [headingText("Setting up slskd")];
  var rows = setupChecklist(s);
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    children.push({ type: "text", content: glyph[row.state] + "  " + row.label, className: row.state === "pending" ? MUTED : undefined });
    if (row.detail) children.push(mutedText(row.detail));
  }
  var buttons = [];
  if (!s.failed && s.at === setupIndex("approve")) {
    // Waiting on Viboplr's dialog: a way out that doesn't need it.
    buttons.push({ label: "Cancel", action: "install-close", variant: "secondary" });
  } else if (s.failed) {
    var step = s.failed.step;
    if (step === "approve") {
      buttons.push({ label: "Back", action: "install-close", variant: "accent" });
    } else {
      buttons.push({ label: step === "signin" ? "Check again" : "Try again", action: "install-retry", variant: "accent" });
      buttons.push({ label: "Close", action: "install-close", variant: "secondary" });
    }
  }
  if (buttons.length) {
    children.push({ type: "spacer" });
    children.push({ type: "toolbar", buttons: buttons });
  }
  return { type: "layout", direction: "vertical", children: children };
}

// ---- Running it ---------------------------------------------------------

// Start the installed slskd (a running one is left alone by the host). Keeps
// running after Viboplr quits unless the user said otherwise.
async function startManagedProcess() {
  var paths = await managedPaths();
  return api.system.programs.start(MANAGED_NAME, managedStartSpec(managed.record, paths, !settings.stopWithViboplr));
}

// slskd's own shutdown first — it finishes writing its database — then the
// host's signal and, past the grace, a kill.
async function stopManagedProcess() {
  try {
    var token = await slskdAdminToken();
    await slskdSettingsCall("DELETE", "/api/v0/application", token);
  } catch (e) {
    console.error("slskd: graceful stop unavailable, signalling instead:", e);
  }
  return api.system.programs.stop(MANAGED_NAME, { graceSecs: MANAGED_STOP_GRACE_SECS });
}

// Run one start / restart / update the user asked for, shown in the view and
// with its failure kept until the next attempt.
async function runManagedJob(kind, line, fn) {
  if (managed.job) return;
  managed.error = null;
  managed.job = { kind: kind, line: line, percent: null };
  render();
  try {
    await fn(managed.job);
  } catch (e) {
    console.error("slskd: " + kind + " failed:", e);
    managed.error = managedFailure(e, kind).message;
  } finally {
    managed.job = null;
    await probeManaged();
    render();
    renderSettings();
  }
}

function startManaged() {
  return runManagedJob("start", "Starting slskd…", async function () {
    await startManagedProcess();
    await awaitSlskdUp();
  });
}

// A kicked slskd stays signed out until it restarts. Quiet on success: the
// readiness pass that follows is the answer.
function restartManaged() {
  return runManagedJob("restart", "Restarting slskd…", async function () {
    await stopManagedProcess();
    signinWhy = null;
    await startManagedProcess();
    await awaitSlskdUp();
  });
}

// A legacy store copy (slskd/<version>/ from plugin ≤ 0.25.0) moves to
// Viboplr's copy: Viboplr installs it (it asks), the old one stops, the same
// slskd.yml and data start on Viboplr's copy, and the old folder goes. If the
// new copy won't start, the old one starts again and nothing is deleted.
function moveManaged() {
  return runManagedJob("move", "Waiting for Viboplr to install slskd…", async function (job) {
    var legacy = managed.record;
    if (!legacy || isHostRecord(legacy)) return;
    var dep = await ensureHostTool(function () { return managed.job === job; }, function (hint) {
      job.line = hint || "Waiting for Viboplr to install slskd…";
      render();
    });
    if (!dep) return;
    managed.dep = dep;
    job.line = "Moving slskd to Viboplr's copy…";
    render();
    await stopManagedProcess();
    var moved = Object.assign({}, legacy, { source: "host" });
    delete moved.version;
    delete moved.asset;
    await saveManagedRecord(moved);
    try {
      await startManagedProcess();
    } catch (e) {
      console.error("slskd: Viboplr's copy didn't start; back to the old one:", e);
      await saveManagedRecord(legacy);
      try { await startManagedProcess(); } catch (e2) { console.error("slskd: the old copy didn't start either:", e2); }
      throw e;
    }
    try { await api.storage.files.remove([MANAGED_DIR, legacy.version]); } catch (e) { console.error("slskd: couldn't remove the old copy:", e); }
    api.log("info", "slskd moved from the plugin's copy (" + legacy.version + ") to Viboplr's (" + (dep.version || "?") + ")", "slskd");
    managedPlaces = null;
    await awaitSlskdUp();
  });
}

// How long slskd may say "Disconnected" after it first answers before the
// wait takes that as the answer: right after a start it can report it for a
// moment before it begins to connect.
var START_SETTLE_MS = 10000;

// The host's start returns once the process is up, but slskd opens its web
// port a few seconds later and signs in to Soulseek after that. A single
// readiness pass right after found nothing, so the view said "not running"
// until the next minute's poll. Look again every couple of seconds until slskd
// answers and settles, or the wait runs out (the minute's poll carries on).
// The wait in progress; deactivate() drops it so the loop ends.
var startWait = null;

async function awaitSlskdUp() {
  var token = {};
  startWait = token;
  try {
    var until = Date.now() + SIGNIN_WAIT_MS;
    var answeredAt = 0;
    for (;;) {
      await refreshReadiness();
      if (startWait !== token) return;
      var st = readiness.state;
      if (st !== "unreachable" && !answeredAt) answeredAt = Date.now();
      var settled = st === "ready" || st === "unauthorized" || st === "unconfigured" ||
        (st === "disconnected" && Date.now() - answeredAt >= START_SETTLE_MS);
      if (settled || Date.now() >= until) return;
      if (managed.job) managed.job.line = st === "unreachable" ? "Waiting for slskd to answer…" : "Waiting for slskd to sign in to Soulseek…";
      render();
      await sleep(SIGNIN_POLL_MS);
      if (startWait !== token) return;
    }
  } finally {
    if (startWait === token) startWait = null;
  }
}

// Saved at once, not through saveSetting's debounce: it is read on the next
// activation, which may be a restart away.
async function setStartWithViboplr(on) {
  settings.startWithViboplr = !!on;
  try {
    await api.storage.set("startWithViboplr", settings.startWithViboplr);
  } catch (e) {
    console.error("slskd: couldn't save startWithViboplr:", e);
  }
}

// Pure: start the installed slskd now, on activation? Only one the plugin
// installed and has started before (the host knows it), that isn't running,
// with the setting on and no install in progress. Viboplr itself never starts
// a program at login; this is the "start it with Viboplr" half.
function shouldStartWithViboplr(cfg, m) {
  return !!(cfg && cfg.startWithViboplr && m && m.supported && !m.setup && !m.job &&
    usesManaged(cfg, m) && m.status && m.status.registered && !m.status.running);
}

// ---- Removing it ---------------------------------------------------------
//
// Stops slskd and deletes everything this plugin put in
// its own folder for it: the program, slskd.yml (the Soulseek login) and
// slskd's database. Folders slskd wrote to — downloads, shares — are never
// touched.
var managedRemove = { asking: false, error: null };

function managedRemoveRows(rm, job) {
  if (job && job.kind === "remove") return [mutedText(job.line)];
  if (rm.asking) {
    return [
      { type: "settings-row", label: "Remove slskd?",
        description: isHostRecord(managed.record)
          ? "slskd stops, and its settings, data and Soulseek login are deleted. Your downloads and shared folders stay where they are. Viboplr's copy of the program stays in Extensions → Tools; remove it there if nothing else uses it."
          : "slskd stops and is deleted from this computer, with its settings and Soulseek login. Your downloads and shared folders stay where they are." },
      buttonRow([
        actionButton("Remove slskd", "managed-remove", "accent"),
        actionButton("Cancel", "managed-remove-cancel")
      ])
    ];
  }
  var rows = [optionRow("Remove slskd", "Uninstall the slskd this plugin installed.",
    actionButton("Remove…", "managed-remove-ask", "secondary", { disabled: !!job }))];
  if (rm.error) rows.push(mutedText(rm.error));
  return rows;
}

// Success says nothing: the view falls back to the setup hub, which is the
// answer. A failure stays under the button.
async function removeManaged() {
  managedRemove = { asking: false, error: null };
  managed.job = { kind: "remove", line: "Removing slskd…", percent: null };
  render();
  try {
    await stopManagedProcess();
    await api.system.programs.remove(MANAGED_NAME);
    await api.storage.files.remove([MANAGED_DIR]);
    try { await api.storage.files.remove(["logs"]); } catch (e) { console.error("slskd: couldn't remove slskd's logs:", e); }
  } catch (e) {
    console.error("slskd: removing slskd failed:", e);
    managedRemove.error = String(e && e.message || e);
    managed.job = null;
    render();
    return;
  }
  managed.job = null;
  api.log("info", "slskd removed", "slskd");
  webLogin = null;
  downloadsDir = null;
  incompleteDir = null;
  slskdShared = null;
  await forgetAccount();
  await saveManagedRecord(null);
  if (settings.managedBy === "plugin") await releaseManagedConnection();
  await probeManaged();
  await refreshReadiness();
  render();
}

// ---- Sharing more folders, through slskd ---------------------------------
//
// The install shares the downloads folder and (by default) every local
// collection. A collection added later shows up as a gap on the card with
// Share…, which asks here first — the folders become public — and then adds
// them to slskd's own settings through slskd's settings API (validated by
// slskd), and asks slskd to rescan.

// Pure: a path with its trailing separators dropped, for comparing folders.
function trimDir(p) {
  var s = String(p || "");
  while (s.length > 1 && /[\\/]$/.test(s)) s = s.slice(0, -1);
  return s;
}

// Pure: `path` is `dir` or inside it.
function isUnder(path, dir) {
  var a = trimDir(path), b = trimDir(dir);
  if (!a || !b) return false;
  return a === b || a.indexOf(b + "/") === 0 || a.indexOf(b + "\\") === 0;
}

// Pure: the collection folders slskd doesn't share yet. `sharedNow` is what
// slskd reports; unread (null), nothing is claimed missing.
function shareGap(collections, sharedNow) {
  if (!Array.isArray(sharedNow)) return [];
  return collectionPaths(collections).filter(function (p) {
    return !sharedNow.some(function (d) { return isUnder(p, d); });
  });
}

// { error, manual, confirm } of the share change, shown on the row.
var shareChange = { error: null };
// A rescan owed to slskd once it answers again.
var rescanPending = false;

// Pure: the Sharing row(s) on the card. `share.confirm`: the folders the user
// is about to make public, waiting for their yes.
function sharingRows(collections, job, share, sharedNow) {
  if (job && job.kind === "share") return [mutedText(job.line)];
  if (share && share.confirm && share.confirm.length) {
    return [{ type: "settings-row", label: "Share these folders?", description: describeFolders(share.confirm) + ". Everyone on Soulseek can browse and download what you share. slskd saves this in its own settings; you can stop sharing a folder there later." },
      buttonRow([actionButton("Share", "share-confirm", "accent"), actionButton("Cancel", "share-cancel")])];
  }
  if (!Array.isArray(sharedNow)) return [];
  var gap = shareGap(collections, sharedNow);
  var rows = gap.length
    ? [optionRow("Sharing", "Not shared yet: " + describeFolders(gap) + ". Everyone on Soulseek can browse and download what you share, and Soulseek serves people who share first.",
      actionButton("Share…", "share-collections", "accent", { disabled: !!job }))]
    : [{ type: "settings-row", label: "Sharing", description: sharedNow.length ? "Shared: " + describeFolders(sharedNow) + "." : "Nothing is shared." }];
  if (share && share.error) {
    rows.push(mutedText(share.error));
    if (share.manual) rows.push(buttonRow([actionButton("Open slskd's settings", "open-slskd")]));
  }
  return rows;
}

async function shareCollections() {
  await loadCollections();
  var gap = shareGap(localCollections, slskdShared);
  if (!gap.length) { render(); return; }
  // The folders become public: the card asks before anything changes.
  shareChange = { error: null, confirm: gap };
  render();
}

// Pure: the folders slskd shares, from GET /api/v0/shares
// ({ "<host>": [{ localPath, isExcluded }] }). Excluded ones are not shared.
function sharedFromSlskd(json) {
  var out = [];
  if (!json || typeof json !== "object") return out;
  Object.keys(json).forEach(function (host) {
    (Array.isArray(json[host]) ? json[host] : []).forEach(function (sh) {
      if (sh && sh.localPath && !sh.isExcluded) out.push(String(sh.localPath));
    });
  });
  return out;
}

// Pure: a YAML scalar as its string (enough for the paths a folder list holds).
function yamlScalar(t) {
  var v = String(t || "").trim();
  if (v.charAt(0) === '"') { try { return JSON.parse(v); } catch (e) { return null; } }
  if (v.charAt(0) === "'") return v.length > 1 && v.charAt(v.length - 1) === "'" ? v.slice(1, -1).replace(/''/g, "'") : null;
  return v.replace(/\s+#.*$/, "");
}

// Pure: slskd's settings file with `dirs` added under shares → directories,
// or null when the file isn't in a shape this can change safely (then the
// user adds them in slskd's own settings). Adds only; a folder already
// listed is not repeated; nothing else in the file changes. Paths go in as
// JSON strings, which are valid YAML double-quoted scalars.
function yamlWithShares(yaml, dirs) {
  var nl = /\r\n/.test(yaml) ? "\r\n" : "\n";
  var lines = String(yaml || "").split(/\r?\n/);
  var add = function (have) {
    return dirs.filter(function (d, i) {
      return dirs.indexOf(d) === i && !have.some(function (h) { return trimDir(h) === trimDir(d); });
    });
  };
  var item = function (ind, d) { return ind + "- " + JSON.stringify(d); };
  var sharesAt = -1;
  for (var i = 0; i < lines.length; i++) {
    if (/^shares:\s*(#.*)?$/.test(lines[i])) { sharesAt = i; break; }
    if (/^shares:/.test(lines[i])) return null; // `shares: {…}` inline: leave it to the user
  }
  if (sharesAt < 0) {
    var fresh = add([]);
    if (!fresh.length) return yaml;
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.concat(["shares:", "  directories:"], fresh.map(function (d) { return item("    ", d); })).join(nl) + nl;
  }
  var end = lines.length;
  for (var j = sharesAt + 1; j < lines.length; j++) {
    if (lines[j] !== "" && !/^\s/.test(lines[j]) && !/^\s*#/.test(lines[j])) { end = j; break; }
  }
  for (var k = sharesAt + 1; k < end; k++) {
    var m = /^(\s+)directories:\s*(.*?)\s*$/.exec(lines[k]);
    if (!m) continue;
    var ind = m[1], rest = m[2].replace(/\s+#.*$/, "");
    if (rest === "" ) {
      var have = [], last = k, itemInd = ind + "  ";
      for (var q = k + 1; q < end; q++) {
        var im = /^(\s+)-\s+(.*)$/.exec(lines[q]);
        if (im && im[1].length > ind.length) {
          var val = yamlScalar(im[2]);
          if (val === null) return null;
          have.push(val); last = q; itemInd = im[1];
        } else if (lines[q].trim() === "" || /^\s*#/.test(lines[q])) {
          continue;
        } else if (/^\s/.test(lines[q]) && lines[q].search(/\S/) > ind.length) {
          return null; // something nested we don't understand
        } else break;
      }
      var more = add(have);
      if (!more.length) return yaml;
      var out = lines.slice(0, last + 1).concat(more.map(function (d) { return item(itemInd, d); }), lines.slice(last + 1));
      return out.join(nl);
    }
    var list = null;
    if (rest === "[]") list = [];
    else if (/^\[.*\]$/.test(rest)) { try { list = JSON.parse(rest); } catch (e) { return null; } }
    if (!Array.isArray(list) || list.some(function (x) { return typeof x !== "string"; })) return null;
    var extra = add(list);
    if (!extra.length) return yaml;
    var block = [ind + "directories:"].concat(list.concat(extra).map(function (d) { return item(ind + "  ", d); }));
    return lines.slice(0, k).concat(block, lines.slice(k + 1)).join(nl);
  }
  // A shares section without a folder list: add one as its first child.
  var childInd = "  ";
  for (var c = sharesAt + 1; c < end; c++) if (lines[c].trim() && !/^\s*#/.test(lines[c])) { childInd = /^(\s+)/.exec(lines[c])[1]; break; }
  var fresh2 = add([]);
  if (!fresh2.length) return yaml;
  return lines.slice(0, sharesAt + 1).concat([childInd + "directories:"], fresh2.map(function (d) { return item(childInd + "  ", d); }), lines.slice(sharesAt + 1)).join(nl);
}


// What slskd shares, from slskd. Quiet on failure: the Sharing row then just
// waits for the next pass.
async function loadSlskdShared() {
  if (!usesManaged(settings, managed) || readiness.state !== "ready") return;
  try {
    var res = await slskd("GET", "/api/v0/shares");
    if (res.status === 200) slskdShared = sharedFromSlskd(res.json);
  } catch (e) {
    console.error("slskd: reading its shares failed:", e);
  }
}

// slskd's settings API and its shutdown want its web sign-in (an
// administrator), not the API key. The slskd this plugin installed has the
// random login the install wrote; any other has slskd's default.
async function slskdAdminToken() {
  var r = managed.record;
  var login = usesManaged(settings, managed) && r.webUsername ? { username: r.webUsername, password: r.webPassword } : SLSKD_DEFAULT_LOGIN;
  var res = await slskd("POST", "/api/v0/session", { username: login.username, password: login.password });
  if (res.status !== 200 || !res.json || !res.json.token) throw new Error("slskd didn't accept its web login (HTTP " + res.status + ")");
  return res.json.token;
}

// One call to slskd's settings API with the admin token; the body is a YAML
// document sent as a JSON string, which is what slskd's endpoints take.
async function slskdSettingsCall(method, path, token, yamlText) {
  var init = { method: method, headers: { "Authorization": "Bearer " + token, "Accept": "application/json", "User-Agent": CLIENT_USER_AGENT } };
  if (yamlText !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(yamlText);
  }
  if (settings.insecure) init.insecure = true;
  var res = await api.network.fetch(baseUrl() + path, init);
  var text = "";
  try { text = await res.text(); } catch (e) { text = ""; }
  var json = null;
  if (text) { try { json = JSON.parse(text); } catch (e) { json = null; } }
  return { status: res.status, json: json, text: text };
}

// The user said yes to the folders: add them to slskd's own settings file
// through slskd (validated by slskd first), then rescan.
async function shareThroughSlskd(gap) {
  if (managed.job) return;
  shareChange = { error: null };
  managed.job = { kind: "share", line: "Adding the folders to slskd's settings…", percent: null };
  render();
  try {
    var token = await slskdAdminToken();
    var got = await slskdSettingsCall("GET", "/api/v0/options/yaml", token);
    if (got.status === 403) throw Object.assign(new Error("slskd doesn't allow changing its settings from other apps (remote_configuration is off)."), { manual: true });
    var current = typeof got.json === "string" ? got.json : null;
    if (got.status !== 200 || current === null) throw new Error("couldn't read slskd's settings (HTTP " + got.status + ")");
    var next = yamlWithShares(current, gap);
    if (next === null) throw Object.assign(new Error("slskd's settings file is laid out in a way the plugin won't edit. Add these folders under shares → directories in slskd's settings: " + describeFolders(gap) + "."), { manual: true });
    if (next !== current) {
      var check = await slskdSettingsCall("POST", "/api/v0/options/yaml/validate", token, next);
      if (check.status !== 200 || (check.text && check.text.trim() && check.text.trim() !== "\"\"")) {
        throw Object.assign(new Error("slskd didn't accept the change: " + (check.text || "HTTP " + check.status).slice(0, 200)), { manual: true });
      }
      var put = await slskdSettingsCall("PUT", "/api/v0/options/yaml", token, next);
      if (put.status !== 200) throw new Error("slskd didn't save its settings (HTTP " + put.status + ")");
    }
    api.log("info", "shared " + gap.length + " more folder(s) through slskd's settings", "slskd");
    rescanPending = true;
    slskdShared = null;
  } catch (e) {
    console.error("slskd: sharing through slskd failed:", e);
    shareChange = { error: String(e && e.message || e), manual: !!(e && e.manual) };
  } finally {
    managed.job = null;
  }
  await refreshReadiness();
  render();
}

// Ask slskd to scan its shares; once, after a change, when it is signed in.
async function rescanSharesIfPending() {
  if (!rescanPending || readiness.state !== "ready") return;
  rescanPending = false;
  try {
    var res = await slskd("PUT", "/api/v0/shares");
    if (res.status >= 300) console.error("slskd: share rescan answered HTTP " + res.status);
    else api.log("info", "asked slskd to rescan its shares", "slskd");
  } catch (e) {
    console.error("slskd: share rescan failed:", e);
  }
}

// Pure: "/Users/a/Music, D:\\Rock and 3 more" — the folders by name, briefly.
function describeFolders(paths) {
  var shown = paths.slice(0, 3).join(", ");
  return paths.length > 3 ? shown + " and " + (paths.length - 3) + " more" : shown;
}

// The install form's row that says which folders become public, with the
// way out. Absent when there are no collections to share.
function shareCollectionsRows() {
  var paths = collectionPaths(localCollections);
  if (!paths.length) return [];
  return [{ type: "settings-row", label: "Share my Viboplr collections",
    description: (paths.length === 1 ? "1 folder: " : paths.length + " folders: ") + describeFolders(paths) +
      ". Other Soulseek users can browse and download from them; Soulseek serves people who share before those who don't. Your downloads folder is shared too.",
    control: { type: "toggle", label: "", action: "install-set-share", checked: !!installForm.shareCollections } }];
}

function autostartRow(action, checked) {
  return { type: "settings-row", label: "Start slskd with Viboplr",
    description: "On: when Viboplr opens, the plugin starts slskd if it isn't already running. Off: start it from here when you want it. To have slskd run without Viboplr, add it to your computer's login items yourself.",
    control: { type: "toggle", label: "", action: action, checked: !!checked } };
}

function keepRunningRow() {
  return { type: "settings-row", label: "Keep slskd running when Viboplr quits",
    description: "On: downloads and sharing carry on while Viboplr is closed. Off: Viboplr stops slskd when it quits. Applies from slskd's next start.",
    control: { type: "toggle", label: "", action: "managed-set-keep-running", checked: !settings.stopWithViboplr } };
}

// Pure: the downloads row's text — where finished files go, and whether they
// reach the library by themselves (only inside a local collection).
function downloadsFolderText(folder, collections) {
  if (!folder) return "Where finished downloads go.";
  var col = collectionForPath(folder, collections);
  return folder + " — where finished downloads go. " + (col
    ? "It's inside your " + (col.name || "collection") + " collection, so finished files reach your library by themselves."
    : "Finished files won't appear in your library on their own: pick a folder inside one of your collections for that.");
}

function installFormSection() {
  var folder = String(installForm.downloadsDir || "");
  return {
    type: "section",
    title: "Your Soulseek setup",
    children: [
      mutedText("Your account goes into slskd's own settings file; the plugin doesn't keep it."),
      { type: "settings-row", label: "Soulseek username",
        control: { type: "text-input", placeholder: "username", action: "install-set-user", value: installForm.username } },
      { type: "settings-row", label: "Soulseek password",
        control: { type: "text-input", placeholder: "password", action: "install-set-pass", password: true, value: installForm.password } },
      mutedText("No account yet? Soulseek has no sign-up page: choose a username nobody else uses and a password, and the account is created the first time slskd signs in. Keep the password somewhere safe; Soulseek can't reset it."),
      optionRow("Downloads folder", downloadsFolderText(folder, localCollections),
        actionButton(folder ? "Change…" : "Choose…", "install-pick-folder", folder ? "secondary" : "accent")),
      autostartRow("install-set-autostart", installForm.autostart)
    ].concat(shareCollectionsRows(), [
      { type: "button", label: "Install slskd", action: "install", variant: "accent", disabled: !installFormComplete(installForm) }
    ])
  };
}

// Why the slskd isn't signed in, read from its log on each readiness pass
// while it isn't: { kind, message } or null.
var signinWhy = null;

async function refreshSigninWhy() {
  if (readiness.state !== "disconnected") {
    signinWhy = null;
    return;
  }
  // slskd's own log endpoint answers with the key we already hold, so the
  // reason is there for any slskd. The output the host captured is the
  // fallback for the one this plugin installed (an older slskd, or a key
  // without access to the log).
  var ours = usesManaged(settings, managed) && managedOwnsAddress(settings.url, managed.record);
  var lines = await slskdApiLogLines();
  if (!lines.length && ours) lines = await managedLogLines();
  signinWhy = signinReasonFromLog(lines, null);
}

// Pure: slskd's GET /api/v0/logs entries as plain message lines, oldest first.
function apiLogMessages(json) {
  if (!Array.isArray(json)) return [];
  var out = [];
  for (var i = 0; i < json.length; i++) {
    if (json[i] && typeof json[i].message === "string") out.push(json[i].message);
  }
  return out;
}

async function slskdApiLogLines() {
  try {
    var res = await slskd("GET", "/api/v0/logs");
    return res.status >= 200 && res.status < 300 ? apiLogMessages(res.json) : [];
  } catch (e) {
    console.error("slskd: couldn't read slskd's log:", e);
    return [];
  }
}

// ---- Where slskd's files are ---------------------------------------------

// Pure: the host can open and reveal local paths.
function canOpenPaths() {
  return !!(api && api.system && typeof api.system.openPath === "function" && typeof api.system.revealPath === "function");
}

// The places worth showing, resolved when the card asks for them. The
// settings file is revealed in its folder, never opened: it holds the
// Soulseek password, and opening a .yml hands it to whatever editor is
// associated.
var managedPlaces = null;
async function loadManagedPlaces() {
  if (!managed.record) { managedPlaces = null; return; }
  var get = async function (segs) {
    try { return await api.storage.files.getPath(segs); } catch (e) { return null; }
  };
  var places = [];
  var cfg = await get([MANAGED_DIR, "data", "slskd.yml"]);
  if (cfg) places.push({ label: "Settings file", path: cfg, reveal: true });
  // Viboplr's copy lives in its tools folder (Extensions → Tools).
  var bin = isHostRecord(managed.record) ? null : await get([MANAGED_DIR, managed.record.version]);
  if (bin) places.push({ label: "Installed in", path: bin, reveal: false });
  var data = await get([MANAGED_DIR, "data", "app"]);
  if (data) places.push({ label: "Data folder", path: data, reveal: false });
  var log = await get(["logs", MANAGED_NAME + ".log"]);
  if (log) places.push({ label: "Log", path: log, reveal: true });
  managedPlaces = places;
}

var managedShowFiles = false;
var managedShowDetails = false;

// Pure: one folded row, and when `open` one row per location with its button
// on the row itself.
function managedFileRows(places, canOpen, open) {
  if (!canOpen) return [];
  var rows = [optionRow("slskd's files", open ? "Where slskd lives on this computer." : "Install folder, settings file, data and log.",
    actionButton(open ? "Hide" : "Show", "managed-files-toggle"))];
  if (!open || !places) return rows;
  for (var j = 0; j < places.length; j++) {
    var p = places[j];
    var desc = p.label === "Settings file" ? p.path + " — holds your Soulseek password. Change settings in slskd's web page, which checks them." : p.path;
    rows.push(optionRow(p.label, desc,
      actionButton(p.reveal ? "Show in folder" : "Open folder", "managed-open-path", "secondary", { data: { path: p.path, reveal: p.reveal } })));
  }
  return rows;
}

async function openManagedPath(path, reveal) {
  try {
    if (reveal) await api.system.revealPath(path);
    else await api.system.openPath(path);
  } catch (e) {
    console.error("slskd: couldn't open " + path + ":", e);
    api.ui.showNotification("Couldn't open " + path + ": " + String(e && e.message || e), { kind: "error" });
  }
}

// A start / update in flight (its line and percent), or the last failure,
// which stays until the next attempt. A removal or a share change shows on
// its own row, not here.
function managedJobNodes() {
  var nodes = [];
  if (managed.job && (managed.job.kind === "remove" || managed.job.kind === "share")) return nodes;
  if (managed.job) {
    nodes.push(mutedText(managed.job.line));
    if (managed.job.percent != null) nodes.push({ type: "progress-bar", value: managed.job.percent, max: 100 });
  } else if (managed.error) {
    nodes.push(mutedText(managed.error));
  }
  return nodes;
}

// Pure: the card's version line (Viboplr's copy: where its updates are) or,
// for a legacy store copy, the row that moves it to Viboplr's copy. `dep` is
// the host's tool status.
function managedVersionRows(record, dep, job) {
  if (!record) return [];
  if (isHostRecord(record)) {
    var v = dep && dep.version ? "slskd " + dep.version : "slskd";
    return [{ type: "settings-row", label: "Version", description: v + " · Viboplr's copy. Updates appear in Extensions → Tools and in Viboplr's update notice; slskd restarts on the new version and keeps its settings." }];
  }
  if (job && job.kind === "move") return [];
  return [optionRow("Move slskd to Viboplr's copy",
    "This slskd (" + (record.version || "?") + ") was installed by an older version of this plugin and gets no updates. Moving it lets Viboplr keep it up to date in Extensions → Tools. slskd keeps its settings, data and Soulseek account.",
    actionButton("Move…", "managed-move", "accent", { disabled: !!job }))];
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

// "slskd not found" — unconfigured (never connected) or unreachable (was set
// up, now nothing answers) — is a hub and three pages. The hub says what's
// wrong in one line and lists the ways forward; each way (install it here,
// install by hand, connect to one you already run) gets a page to itself, so
// the account form, the guide and the address fields are never on screen
// together. `setupPage` resets to the hub whenever slskd becomes ready.
var SETUP_PAGES = ["home", "install-auto", "install-manual", "connect"];
var setupPage = "home";

// The host's own classes, not ones of ours: `plugin-heading` is its small
// uppercase section label (the same look as a section title, so a page title
// drawn with it vanished among them) and there is no `plugin-muted` rule, so
// the title is an <h2> and secondary text borrows the settings-row
// description style.
var MUTED = "plugin-settings-description";
function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function headingText(text) {
  return { type: "text", content: "<h2>" + escapeHtml(text) + "</h2>" };
}
function mutedText(text) {
  return { type: "text", content: text, className: MUTED };
}
// A row of plain buttons. Not a `toolbar`: the host draws that as a full-width
// header bar, which is right above a list and heavy in the middle of a page.
function buttonRow(buttons) {
  return { type: "layout", direction: "horizontal", children: buttons };
}
function actionButton(label, action, variant, extra) {
  var b = { type: "button", label: label, action: action, variant: variant || "secondary" };
  for (var k in extra || {}) b[k] = extra[k];
  return b;
}
function pageButton(label, page, variant) {
  return actionButton(label, "setup-page", variant, { data: { page: page } });
}
// One way forward: what it is on the left, the button that takes it pinned to
// the right (the row is a wrapping flex line; an auto margin is what aligns
// the buttons of every row into one column).
function optionRow(label, description, control) {
  var c = {};
  for (var k in control) c[k] = control[k];
  c.style = { marginLeft: "auto" };
  return { type: "settings-row", label: label, description: description, control: c };
}
function backBar() {
  return buttonRow([pageButton("‹ Back", "home")]);
}
// ---- Finding slskd on this computer, before anything else ---------------
//
// The first run looks for a slskd already running here, on its usual ports,
// before anything is installed: a slskd the user runs, the manual guide's,
// or one this plugin installed all answer the same way. slskd answers
// GET /api/v0/session/enabled without a key ("true" or "false": whether it
// wants one), which tells it apart from anything else on the port. Found, the
// plugin tries the key it already has (the guide writes that one into
// slskd.yml); if slskd wants another, the user types it. Only when nothing is
// found does installing come in.

// state: "idle" | "looking" | "found" | "none". found: { url, insecure,
// authEnabled }. keyInput: what the user typed (memory only until it works).
var discovery = { state: "idle", found: null, keyInput: "", error: null };
var DISCOVERY_TIMEOUT_MS = 1500;

// Pure: where to look, most likely first. slskd listens on 5030 (HTTP) and
// 5031 (HTTPS, a self-signed certificate) by default; a second copy, or a
// taken port, moves it a few ports up.
function discoveryCandidates() {
  var out = [];
  for (var port = 5030; port <= 5040; port++) out.push({ url: "http://127.0.0.1:" + port, insecure: false });
  out.splice(2, 0, { url: "https://127.0.0.1:5031", insecure: true });
  return out;
}

// Pure: slskd's answer to /api/v0/session/enabled → whether it wants a key,
// or null when whatever answered isn't slskd.
function slskdFingerprint(status, text) {
  if (status !== 200) return null;
  var t = String(text || "").trim().toLowerCase();
  if (t === "true") return { authEnabled: true };
  if (t === "false") return { authEnabled: false };
  return null;
}

async function fetchText(url, init) {
  var withUa = Object.assign({}, init || {});
  withUa.headers = Object.assign({ "User-Agent": CLIENT_USER_AGENT }, withUa.headers || {});
  var res = await api.network.fetch(url, withUa);
  var text = "";
  try { text = await res.text(); } catch (e) { text = ""; }
  return { status: res.status, text: text };
}

// Does `key` open slskd at `where`? true / false (401/403) / null (no answer).
async function keyWorks(where, key) {
  try {
    var r = await fetchText(where.url + "/api/v0/application", { method: "GET", timeoutMs: DISCOVERY_TIMEOUT_MS, insecure: where.insecure,
      headers: { "X-API-Key": key || "", "Accept": "application/json" } });
    if (r.status === 200) return true;
    if (r.status === 401 || r.status === 403) return false;
  } catch (e) { /* unreachable */ }
  return null;
}

// Save a connection the user (or discovery) settled on: theirs, not one this
// plugin installed.
async function useConnection(url, key, insecure) {
  settings.url = url;
  settings.apiKey = key;
  settings.insecure = !!insecure;
  settings.managedBy = null;
  await Promise.all([
    api.storage.set("url", url),
    api.storage.set("apiKey", key),
    api.storage.set("insecure", !!insecure),
    api.storage.set("managedBy", null)
  ]).catch(function (e) { console.error("slskd: couldn't save the connection:", e); });
  downloadsDir = null;
  incompleteDir = null;
}

// Look for slskd here. Found with a working key (or no key needed): connect.
// Found wanting a key: ask for it. Not found: the install options.
async function discoverSlskd() {
  if (discovery.state === "looking") return;
  discovery = { state: "looking", found: null, keyInput: "", error: null };
  render();
  // All candidates at once, the most likely one still winning.
  var found = await firstInOrder(discoveryCandidates(), function (cand) {
    return fetchText(cand.url + "/api/v0/session/enabled", { method: "GET", timeoutMs: DISCOVERY_TIMEOUT_MS, insecure: cand.insecure, headers: { "Accept": "application/json" } })
      .then(function (r) {
        var fp = slskdFingerprint(r.status, r.text);
        return fp ? { url: cand.url, insecure: cand.insecure, authEnabled: fp.authEnabled } : null;
      }, function () { return null; });   // nothing on this port — the usual answer, not an error
  });
  if (!found) {
    api.log("info", "no slskd found on this computer", "slskd");
    discovery = { state: "none", found: null, keyInput: "", error: null };
    await refreshReadiness();
    render();
    return;
  }
  api.log("info", "found slskd at " + found.url + (found.authEnabled ? " (wants a key)" : " (no key needed)"), "slskd");
  ensureSetupKey();
  if (!found.authEnabled || (await keyWorks(found, settings.apiKey)) === true) {
    await useConnection(found.url, settings.apiKey, found.insecure);
    discovery = { state: "found", found: found, keyInput: "", error: null };
    await refreshReadiness();
    render();
    return;
  }
  // It wants a key we don't have: the user types one of slskd's.
  discovery = { state: "found", found: found, keyInput: "", error: null };
  render();
}

// The user typed slskd's key: keep it only once slskd accepts it.
async function connectDiscovered() {
  var f = discovery.found;
  var key = String(discovery.keyInput || "").trim();
  if (!f || !key) return;
  discovery.error = null;
  var ok = await keyWorks(f, key);
  if (ok !== true) {
    discovery.error = ok === false ? "slskd didn't accept that key. Copy one exactly as it appears under api_keys in slskd's settings." : "slskd stopped answering at " + f.url + ". Is it still running?";
    render();
    return;
  }
  discovery.keyInput = "";
  await useConnection(f.url, key, f.insecure);
  api.log("info", "connected to slskd at " + f.url + " with the user's key", "slskd");
  await refreshReadiness();
  render();
}

// Pure: the hub's top part while discovery runs or after it found slskd.
function discoveryNodes(d) {
  if (!d || d.state === "idle") return [];
  if (d.state === "looking") return [mutedText("Looking for slskd on this computer…")];
  if (d.state !== "found" || !d.found) return [];
  var f = d.found;
  var rows = [
    mutedText("slskd is running at " + f.url + ". Enter one of its API keys to connect Viboplr to it."),
    { type: "settings-row", label: "API key",
      description: "Listed in slskd's settings file (slskd.yml) under web → authentication → api_keys. On slskd's own page: System → Options.",
      control: { type: "text-input", placeholder: "API key", action: "discover-set-key", password: true, value: d.keyInput || "" } }
  ];
  if (d.error) rows.push(mutedText(d.error));
  rows.push(buttonRow([actionButton("Connect", "discover-connect", "accent", { disabled: !String(d.keyInput || "").trim() }), actionButton("Open slskd", "discover-open")]));
  return [{ type: "section", title: "Found slskd on this computer", children: rows }];
}

// Pure: the install options, shared by the first-run hub and the "not
// installed any more?" part of the unreachable one. Installing here comes first
// and is the recommended one wherever this Viboplr can do it.
// `m` is `managed`.
function installRows(m) {
  var rows = [];
  var auto = canInstallHere(m);
  if (auto) {
    rows.push(optionRow("Install automatically",
      "Viboplr downloads slskd and runs it in the background on this computer, after it asks you. Recommended.",
      pageButton("Install…", "install-auto", "accent")));
  }
  rows.push(optionRow("Install manually",
    "A step-by-step guide for your computer, in the browser.",
    pageButton("Show guide…", "install-manual", auto ? "secondary" : "accent")));
  return rows;
}

// Pure: the hub for a slskd that isn't found. `st` is "unconfigured" or
// "unreachable"; `cfg` the connection settings; `m` the installed-slskd
// snapshot; `detail` the last probe's error, if any; `d` the discovery state
// (first run only).
function setupHomeView(st, cfg, m, detail, d) {
  var children = [];

  if (st === "unreachable" && usesManaged(cfg, m)) {
    // This plugin installed it, so it's only stopped.
    children.push(headingText("slskd is stopped"));
    children.push(mutedText("slskd is installed on this computer; it isn't running right now."));
    children.push(buttonRow([
      actionButton("Start slskd", "managed-start", "accent", { disabled: !!(m && m.job) }),
      pageButton("Connection settings…", "connect")
    ]));
    return children;
  }

  if (st === "unreachable") {
    children.push(headingText("Can't reach slskd"));
    // Only an HTTP status says something new (something answered, wrongly).
    // A transport error is the proxy's "error sending request for url (…)",
    // which repeats the address above in longer words.
    var httpDetail = /^HTTP \d+/.test(detail || "") ? " (" + detail + ")" : "";
    children.push(mutedText("Nothing answered at " + (cfg.url || "the saved address") + ". slskd may be stopped, or no longer installed." + httpDetail));
    children.push(buttonRow([
      checkButton("Try again", "accent"),
      pageButton("Connection settings…", "connect")
    ]));
    children.push({ type: "section", title: "Stopped?", children: [optionRow("Start slskd",
      "Start it the way you installed it. The guide's Run step shows how for your computer.",
      { type: "button", label: "Show how…", action: "setup-open-guide", variant: "secondary" })] });
    children.push({ type: "section", title: "Not installed any more?", children: installRows(m) });
    return children;
  }

  children.push(headingText("Search and download from Soulseek"));
  children.push(mutedText("Viboplr reaches Soulseek through slskd, a small app that runs in the background on your computer."));
  var looking = d && d.state === "looking";
  var found = d && d.state === "found" && d.found;
  children = children.concat(discoveryNodes(d));
  if (looking) return children;
  if (!found) {
    if (d && d.state === "none") children.push(mutedText("No slskd is running on this computer."));
    children.push({ type: "section", title: "Install slskd", children: installRows(m) });
  }
  children.push({ type: "section", title: found ? "A different slskd?" : "Running slskd somewhere else?", children: [
    optionRow("Connect to your slskd",
      "In Docker, on a NAS or another computer — enter its address and API key.",
      pageButton("Connect…", "connect"))
  ] });
  children.push(buttonRow([actionButton("Look again", "discover-again"), actionButton("What is Soulseek?", "setup-open-about")]));
  return children;
}

function installAutoView() {
  var children = [backBar(), headingText("Install slskd automatically")];
  if (!canInstallHere(managed)) {
    children.push(mutedText(managed.supported
      ? "Viboplr can't install slskd here: its definition isn't in force (Extensions → Tools says why). The manual guide takes a few minutes."
      : "This version of Viboplr can't install slskd for you. The manual guide takes a few minutes."));
    children.push(pageButton("Show guide…", "install-manual", "accent"));
    return children;
  }
  children.push(mutedText(hostToolReady(managed.dep)
    ? "slskd " + (managed.dep.version || "") + " is already installed in Viboplr. This sets it up and runs it in the background on this computer."
    : "Viboplr installs slskd from its official release on GitHub, checks it against GitHub's checksum, and runs it in the background on this computer. It asks you before it installs anything, and keeps slskd up to date in Extensions → Tools."));
  children.push(installFormSection());
  var job = managedJobNodes();
  for (var i = 0; i < job.length; i++) children.push(job[i]);
  return children;
}

function installManualView() {
  var children = [backBar(), headingText("Install slskd manually")];
  children.push(mutedText("The guide opens in your browser and picks the download for your computer. The settings it gives you already carry this plugin's API key."));
  children.push(buttonRow([
    actionButton("Open the guide", "setup-open-guide", "accent"),
    actionButton("What is Soulseek?", "setup-open-about")
  ]));
  var tried = readiness.state === "unreachable";
  children.push({ type: "section", title: "Once slskd is running", children: [
    optionRow("Connect to " + SETUP_DEFAULT_URL,
      tried ? "Nothing answered at " + (settings.url || SETUP_DEFAULT_URL) + " yet. Check slskd is running, then try again." : "The address the guide sets up.",
      { type: "button", label: tried ? "Try again" : "Connect", action: "setup-connect", variant: "accent" }),
    optionRow("Different address?", "If you changed the port, or run slskd somewhere else.", pageButton("Enter address…", "connect"))
  ] });
  return children;
}

function connectView() {
  var children = [backBar(), headingText("Connect to slskd")];
  children.push(mutedText("The address slskd listens on, and an API key listed in its slskd.yml."));
  // Only worth saying when it can be the reason: HTTPS, failing, not allowed yet.
  if (/^https:/i.test(settings.url || "") && readiness.state === "unreachable" && !settings.insecure) {
    children.push(mutedText("slskd's default HTTPS certificate is self-signed — turn on \"Allow self-signed certificate\"."));
  }
  children.push(connectionSection());
  return children;
}

// The full-page screen: the first-run hub, or one of its pages (also reached
// from the "Can't reach slskd" explanation on the Settings tab). Any other
// state that isn't ready is the normal view with a banner on top (`render`).
function setupView() {
  var children;
  if (setupPage === "install-auto") children = installAutoView();
  else if (setupPage === "install-manual") children = installManualView();
  else if (setupPage === "connect") children = connectView();
  else children = setupHomeView(readiness.state, settings, managed, readiness.detail, discovery).concat(managedJobNodes());
  return { type: "layout", direction: "vertical", children: children };
}

// Pure: whether `render` shows the full-page setup screen rather than the
// tabs. The first run always does; a slskd that stopped answering does only
// while the user is on one of the hub's pages (install, connect).
function wantsSetupScreen(st, page) {
  return st === "unconfigured" || (st === "unreachable" && page !== "home");
}

// Pure: the "key rejected" screen. The slskd this plugin installed carries the
// plugin's key in its settings; a refusal means slskd's settings were changed.
function unauthorizedNodes(cfg, m) {
  var nodes = [headingText("slskd rejected the API key")];
  if (usesManaged(cfg, m)) {
    nodes.push({ type: "text", content: "This is the slskd Viboplr installed, but it no longer accepts the key it was set up with — its API keys were changed in slskd's settings. Add the key back in slskd's settings page (System → Options, web → authentication → api_keys), or remove slskd and install it again." });
    nodes.push(buttonRow([actionButton("Open slskd", "open-slskd", "accent"), checkButton("Check again")]));
    return nodes;
  }
  nodes.push({ type: "text", content: "slskd is running, but its settings file doesn't list the key below. Add it under web → authentication → api_keys in slskd.yml and restart slskd — the setup guide's Configure step shows the exact lines with this key already in them." });
  nodes.push({ type: "button", label: "Open setup guide", action: "setup-open-guide", variant: "accent" });
  return nodes;
}

// Pure: the "not signed in" screen. For the slskd this plugin installed the
// reason comes from its log and the fix is a restart.
function disconnectedNodes(cfg, m, why) {
  var nodes = [headingText("slskd isn't signed in to Soulseek")];
  var busy = !!(m && m.job);
  var ours = usesManaged(cfg, m) && managedOwnsAddress(cfg.url, m.record);
  // The network is in the way: a restart changes nothing, checking again
  // is the honest button.
  if (why && signinNeedsNetwork(why)) {
    nodes.push({ type: "text", content: why.message });
    nodes.push(buttonRow([checkButton("Check again", "accent"), actionButton("Open slskd", "open-slskd")]));
    return nodes;
  }
  if (ours) {
    nodes.push({ type: "text", content: why ? why.message
      : "slskd is running and the key works, but it isn't signed in to the Soulseek network, and its log doesn't say why. Restarting slskd makes it sign in again." });
    nodes.push(buttonRow([actionButton("Restart slskd", "managed-restart", "accent", { disabled: busy }),
      actionButton("Open slskd", "open-slskd")]));
    return nodes;
  }
  nodes.push({ type: "text", content: why ? why.message
    : "slskd is running and the key works, but it isn't connected to the Soulseek network. Check the Soulseek username and password under soulseek: in slskd.yml (the guide's Configure step) and restart slskd, or sign in from slskd's own page." });
  nodes.push(buttonRow([actionButton("Open setup guide", "setup-open-guide", "accent"),
    actionButton("Open slskd", "open-slskd"), checkButton("Check again")]));
  return nodes;
}

// Pure: a sign-in reason only a different network fixes.
function signinNeedsNetwork(why) {
  return !!why && (why.kind === "blocked" || why.kind === "network");
}

// "Test" / "Try again" / "Check again": all the same probe. While it runs the
// button says so and can't be pressed twice; the status line then says when
// it last ran, so a check that found nothing new still visibly happened.
var connCheck = { running: false, at: 0 };

async function checkConnection() {
  if (connCheck.running) return;
  connCheck.running = true;
  render();
  try {
    await refreshReadiness();
  } catch (e) {
    console.error("slskd probe failed:", e);
  } finally {
    connCheck.running = false;
    connCheck.at = Date.now();
    render();
  }
}

// The Settings tab's scroll key after "Fix…", until the tab changes.
var fixScrollKey = null;
var fixSeq = 0;

function checkButton(label, variant) {
  return actionButton(connCheck.running ? "Checking…" : label, "test-connection", variant, { disabled: connCheck.running });
}

// Pure: "checked just now" / "checked 3 min ago" / "" for never.
function checkedAgo(at, now) {
  if (!at) return "";
  var s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "checked just now";
  var m = Math.round(s / 60);
  return m < 60 ? "checked " + m + " min ago" : "checked over an hour ago";
}

// The guide shows a key and the yml carries it, so a key must exist before the
// first render. Saved straight to storage: `saveSetting` would also re-probe,
// and a key without an address is still "unconfigured".
function ensureSetupKey() {
  if (settings.apiKey) return;
  settings.apiKey = randomApiKey();
  api.storage.set("apiKey", settings.apiKey).catch(function (e) { console.error("slskd: couldn't save apiKey:", e); });
}

// Pure: the address/key form, for a slskd the user runs, or unfolded.
function connectionFormRows() {
  return [
      { type: "settings-row", label: "slskd address", description: "e.g. http://localhost:5030",
        control: { type: "text-input", placeholder: "http://localhost:5030", action: "set-url", value: settings.url } },
      { type: "settings-row", label: "API key", description: "Must appear in slskd.yml under web → authentication → api_keys. The setup guide writes it in for you.",
        control: { type: "text-input", placeholder: "API key", action: "set-key", password: true, value: settings.apiKey } },
      { type: "settings-row", label: "Allow self-signed certificate", description: "Needed if slskd serves HTTPS with its default certificate",
        control: { type: "toggle", label: "", action: "set-insecure", checked: !!settings.insecure } },
      { type: "toolbar", buttons: [
          checkButton("Test connection", "accent"),
          { label: "Open setup guide", action: "setup-open-guide", variant: "secondary" }
        ],
        status: statusLine(), statusVariant: statusVariant() }
  ];
}

function statusVariant() {
  var st = readiness.state;
  return st === "ready" ? "success" : (st === "connecting" || st === "unconfigured" ? "default" : "error");
}

function connectionSection() {
  if (usesManaged(settings, managed)) return managedConnectionSection();
  return { type: "section", title: "Connection", children: connectionFormRows() };
}

// The slskd this plugin installed: the plugin filled in the address and key,
// so the form is folded away (typing into it stops using this slskd) and the
// card is what can be done with it: test, start / stop behaviour, sharing,
// update, files, remove.
function managedConnectionSection() {
  var st = managed.status;
  // Remove goes last: the one destructive row sits below everything else.
  var rows = [optionRow("Address", settings.url + " · " + statusLine(), checkButton("Test"))]
    .concat(managedVersionRows(managed.record, managed.dep, managed.job))
    .concat([autostartRow("managed-autostart", settings.startWithViboplr), keepRunningRow()])
    .concat(sharingRows(localCollections, managed.job, shareChange, slskdShared))
    .concat(managedFileRows(managedPlaces, canOpenPaths(), managedShowFiles))
    .concat([optionRow("Connection details", managedShowDetails
      ? "Filled in at install. Changing them stops using the slskd installed here."
      : "The address and key set up at install.", actionButton(managedShowDetails ? "Hide" : "Show", "managed-details-toggle"))]);
  if (managedShowDetails) rows = rows.concat(connectionFormRows());
  rows = rows.concat(managedRemoveRows(managedRemove, managed.job));
  return { type: "section", title: "slskd on this computer", children: rows };
}

// ---- slskd's own web page -----------------------------------------------
//
// For testing and for slskd's own settings. The page asks for a sign-in that
// is not the API key: the slskd this plugin installed sits behind the random
// login the install wrote; a slskd the user set up has slskd's defaults
// unless they changed web → authentication in slskd.yml, which the plugin
// can't read. Shown on the click only.
//
// webLogin: null (hidden) | { username, password, note }
var webLogin = null;
var SLSKD_DEFAULT_LOGIN = { username: "slskd", password: "slskd" };

function revealWebLogin() {
  var r = managed.record;
  webLogin = usesManaged(settings, managed) && r.webUsername
    ? { username: r.webUsername, password: r.webPassword, note: "The sign-in Viboplr set up for slskd's web page." }
    : { username: SLSKD_DEFAULT_LOGIN.username, password: SLSKD_DEFAULT_LOGIN.password,
        note: "slskd's defaults. If you changed web → authentication in slskd.yml, use those instead." };
  rerenderWebLogin();
}

function rerenderWebLogin() {
  render();
  renderSettings();
}

// Selectable, so the user can copy them — the plugin API has no clipboard.
function loginField(label, value) {
  return { type: "settings-row", label: label,
    control: { type: "text-input", action: "slskd-login-field", value: value } };
}

// Null until there's an address to open.
function webPageSection() {
  if (!settings.url) return null;
  var rows = [optionRow("Open slskd's page",
    settings.url + " — searches, transfers and slskd's own settings.",
    actionButton("Open", "open-slskd"))];
  var hide = actionButton("Hide login", "slskd-hide-login");
  if (!webLogin) {
    rows.push(optionRow("Sign-in", "The page asks for a username and password — not the API key.", actionButton("Show login", "slskd-show-login")));
  } else {
    rows.push(optionRow("Sign-in", webLogin.note, hide));
    rows.push(loginField("Username", webLogin.username));
    rows.push(loginField("Password", webLogin.password));
  }
  return { type: "section", title: "slskd web page", children: rows };
}

function statusLine() {
  if (connCheck.running) return "Checking…";
  var ago = checkedAgo(connCheck.at, Date.now());
  return readinessLine() + (ago ? " · " + ago : "");
}

function readinessLine() {
  var st = readiness.state;
  if (st === "ready") {
    return "Connected as " + (readiness.username || "?") + (readiness.version ? " · slskd " + readiness.version : "") +
      " · " + (tier === "local" ? "same computer" : "remote — downloads can't be played directly");
  }
  if (st === "unconfigured") return "Not set up yet";
  if (st === "unreachable") return "Not reachable";
  if (st === "unauthorized") return "API key rejected";
  if (st === "disconnected") return "Not signed in to Soulseek";
  return "Connecting…";
}

// Sorting happens HERE, on the raw numbers, because the host only ever sees the
// formatted strings ("30 MB", "4:48", "—") and sorting those would sort text.
// `desc` is defined as BEST-first for every column, not merely largest-first: on
// Quality that means lossless at the top, on Availability a free slot — which is
// what a user clicking "Quality ▼" means, and the opposite of the raw tier
// numbers, where 0 is best.
var RESULT_SORTS = {
  quality: function (c) { return [-c.qualityTier, c.bitRate || 0, c.size || 0]; },
  size: function (c) { return [c.size || 0]; },
  duration: function (c) { return c.length == null ? null : [c.length]; },
  availability: function (c) { return [-c.availabilityTier, -(c.queueLength || 0), c.uploadSpeed || 0]; }
};

// A copy of `list` ordered by `column`. Candidates with nothing to report on
// that column sink to the bottom in BOTH directions — "unknown" is not "zero",
// and flipping the arrow should not float a wall of em dashes to the top.
function sortCandidates(list, column, dir) {
  var keyOf = RESULT_SORTS[column];
  if (!keyOf) return list;
  var sign = dir === "asc" ? -1 : 1;
  var out = list.slice();
  out.sort(function (a, b) {
    var ka = keyOf(a), kb = keyOf(b);
    if (ka === null && kb === null) return 0;
    if (ka === null) return 1;
    if (kb === null) return -1;
    for (var i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return (kb[i] - ka[i]) * sign;
    }
    return 0;
  });
  return out;
}

// Columns replace the fixed Album / Duration pair. Kept to four: every one is a
// number the user actually chooses between, and the title + source line already
// eat most of the row's width.
var RESULT_COLUMNS = [
  { id: "quality", label: "Quality", width: 130, sortable: true },
  { id: "size", label: "Size", width: 80, align: "right", sortable: true },
  { id: "duration", label: "Length", width: 70, align: "right", sortable: true },
  { id: "availability", label: "Availability", width: 110, sortable: true }
];

function resultCells(c) {
  var cells = {};
  var quality = qualityLabel(c);
  if (quality && quality !== "unknown") cells.quality = quality;
  // With the upgrade filter lifted, the rows that would still be an upgrade
  // keep their mark, so "show everything" doesn't mean re-judging each one.
  if (search.mode && search.mode.kind === "upgrade" && search.mode.showAll && c.better) cells.quality = "↑ " + (cells.quality || quality);
  if (c.size) cells.size = formatBytes(c.size);
  if (c.length != null) cells.duration = formatDurationSecs(c.length);
  var rep = sharerLabel(sharers[c.username]);
  cells.availability = availabilityLabel(c) + (rep ? " · " + rep : "");
  return cells;
}

// The rows the Files view shows: everything, or — in a mode, until the user asks
// for all of it — only what the mode was started for.
function visibleResults() {
  var m = search.mode;
  if (!m || m.showAll) return search.results;
  if (m.kind === "upgrade") return search.results.filter(function (c) { return c.better; });
  if (m.kind === "fill") return search.results.filter(function (c) { return !c.owned; });
  return search.results;
}

function visibleFolders() {
  var m = search.mode;
  if (!m || m.kind !== "fill" || m.showAll) return search.folders;
  return search.folders.filter(function (g) { return missingFiles(g.files, m.owned).length > 0; });
}

function sortedResults() {
  var list = visibleResults();
  if (!search.sortColumn) return list;
  return sortCandidates(list, search.sortColumn, search.sortDir);
}

// How long a just-queued file may be missing from slskd's transfer list
// before its row stops saying "Queued" — the first poll lands well inside it.
var JUST_QUEUED_MS = 60000;

// Pure: what a search or folder row shows once its file was queued — the
// chip, the bar, and the one thing that row then offers — or null while it
// is still just a result (a cancelled one is a result again). `t` is slskd's
// transfer, `rec` our tracked record, `playable` whether the finished file
// can be played from here.
function rowTransferStatus(t, rec, playable, now) {
  var p;
  if (t) p = transferPhase(t.state);
  else if (rec && rec.resolvedPath) p = "succeeded";
  else if (rec && rec.queuedAt && now - rec.queuedAt < JUST_QUEUED_MS) p = "requested";
  else return null;
  if (p === "cancelled") return null;
  if (p === "succeeded") {
    // A file fetched as an upgrade (an Upgrade-mode search) has one obvious
    // next step, and it's on this row: before, the view jumped to Downloads,
    // where Replace waited; staying put, Play alone read as "finished" while
    // the library still held the old copy. The chip stays "Done" — whether
    // the host's Replace dialog went through, the plugin never hears.
    // Add to library sits on the row too: a file found by search ends here,
    // and the Downloads tab shouldn't be the only way into a collection.
    var ids = !playable ? [] : rec && rec.upgrade ? ["replace-transfer", "play-transfer", "import-transfer"] : ["play-transfer", "import-transfer"];
    return { phase: "done", badge: { label: "Done", variant: "success" }, progress: null,
      actions: ids, action: playable ? "play-transfer" : undefined };
  }
  if (p === "failed") return { phase: "failed", badge: { label: "Failed", variant: "error" }, progress: null, actions: ["retry-transfer"], action: undefined };
  if (p === "downloading" || p === "starting") {
    var pr = transferProgress(t);
    return { phase: "moving", badge: { label: "Downloading" + (pr != null ? " " + Math.round(pr * 100) + "%" : ""), variant: "accent" },
      progress: pr, actions: ["cancel-transfer"], action: undefined };
  }
  return { phase: "waiting", badge: { label: "Queued" + (t && t.placeInQueue != null ? " · #" + t.placeInQueue : ""), variant: "warning" },
    progress: null, actions: ["cancel-transfer"], action: undefined };
}

// Pure: a transfer phase Cancel applies to — anything not yet at rest.
function cancellablePhase(p) {
  return p !== "succeeded" && p !== "failed" && p !== "cancelled";
}

// Pure-ish: a download Retry applies to — one slskd lists as failed or
// cancelled, or one we queued that slskd has since forgotten (no transfer,
// no finished file, past the just-queued window). Plain results, files on
// their way and finished ones are not.
function retryableKey(key) {
  var t = transferByKey(key);
  if (t) {
    var p = transferPhase(t.state);
    return p === "failed" || p === "cancelled";
  }
  var rec = tracked[key];
  return !!rec && !rec.resolvedPath && !(rec.queuedAt && nowMs() - rec.queuedAt < JUST_QUEUED_MS);
}

// The phase a row's file is in, by its transfer key: "done" | "failed" |
// "moving" | "waiting", or null for a plain result.
function rowPhase(key, now) {
  var st = rowTransferStatus(transferByKey(key), tracked[key], false, now != null ? now : nowMs());
  return st ? st.phase : null;
}

// One file as a row, for the Files view (`f:` ids) and an open folder (`o:`).
// `owned`: the library already has this song (the folder view says so).
function resultRow(c, prefix, owned) {
  var meta = parseTrackMeta(c.filename);
  var key = c.username + KEY_SEP + c.filename;
  var st = rowTransferStatus(transferByKey(key), tracked[key], !!importTrackFor(key), nowMs());
  var row = {
    id: prefix + key,
    title: resultLabel(c),
    subtitle: resultSource(c),
    // What the subtitle used to carry now has columns of its own, so the
    // facts stay comparable down the list instead of running together in one
    // sentence per row. A cell the sharer didn't report is simply absent —
    // the host renders that as an em dash, which reads as "unknown" rather
    // than as zero.
    cells: resultCells(c),
    // The format, not a guessed cover: see formatTile. Not on Files rows: the
    // Quality column already says it, and at ~600 bytes a tile, 1,000 rows
    // made each re-render a ~1 MB payload — most of what made a big result
    // list lag. A cover the library already has still shows (`artwork:
    // "cached"`). An open folder is a few dozen rows and keeps its tiles.
    imageUrl: prefix === "f:" ? undefined : fileTile(c),
    durationSecs: c.length != null ? c.length : null,
    action: "download-file",
    actions: ["download-file"],
    artistName: meta.artist,
    albumTitle: meta.album,
    kind: "audio"
  };
  if (st) {
    row.badge = st.badge;
    if (st.progress != null) row.progress = st.progress;
    row.actions = st.actions;
    row.action = st.action;
  } else if (owned) {
    row.badge = { label: "In library", variant: "muted" };
  }
  return row;
}

function resultRows() {
  return sortedResults().map(function (c) { return resultRow(c, "f:", false); });
}

// Pure: of `all` (a list's possible actions), the ones some row offers, plus
// `keep` ids always. The host draws every declared action in the selection
// bar — greyed out until something is selected — so declaring all of them put
// Play / Retry / Cancel over a fresh search that had nothing to play or cancel.
function declaredActions(all, rows, keep) {
  var used = {};
  (keep || []).forEach(function (id) { used[id] = true; });
  for (var i = 0; i < (rows || []).length; i++) {
    var ids = rows[i].actions || [];
    for (var j = 0; j < ids.length; j++) used[ids[j]] = true;
  }
  return all.filter(function (a) { return used[a.id]; });
}

// Copy a finished download into a collection. Shared by Downloads and the
// search lists, so the action looks the same wherever a finished file shows.
var IMPORT_ACTION = { id: "import-transfer", label: "Add to library…", icon: "♫" };

// The actions a file list declares; which one a row shows is resultRow's call.
// A fresh search shows Download alone; Cancel joins once something is on its way.
function fileRowActions(upgrading, rows) {
  return declaredActions([
    { id: "download-file", label: upgrading ? "Upgrade" : "Download", icon: "⬇" },
    { id: "replace-transfer", label: "Replace in library…", icon: "⇪" },
    { id: "play-transfer", label: "Play", icon: "▶" },
    IMPORT_ACTION,
    { id: "retry-transfer", label: "Retry", icon: "↻" },
    { id: "cancel-transfer", label: "Cancel", icon: "■" }
  ], rows, ["download-file"]);
}

// The Downloads tab as a track-row-list: finished, located files carry a
// `path`, so the host's universal track menu, drag-to-queue and "Download…"
// (→ our onResolveByUri) all work on them with no code here.
function transferRows() {
  return transfers.map(function (t) {
    var key = trackKeyOf(t);
    var rec = tracked[key];
    var meta = (rec && rec.meta) || parseTrackMeta(t.filename);
    var playable = tier === "local" && rec && rec.resolvedPath && transferPhase(t.state) === "succeeded";
    var duration = meta.durationSecs != null ? meta.durationSecs : (rec && rec.length != null ? rec.length : null);
    return {
      id: key,
      title: meta.title || basenameRemote(t.filename),
      subtitle: transferSubtitle(t, rec, tier),
      album: meta.album || basenameRemote(dirnameRemote(t.filename)) || undefined,
      duration: duration != null ? formatDurationSecs(duration) : undefined,
      durationSecs: duration,
      artistName: meta.artist || null,
      albumTitle: meta.album || null,
      path: playable ? SCHEME + "://" + key : null,
      // A file still on its way (or one that never arrived) shows its format;
      // once it is here and tagged, its real cover takes over by name.
      imageUrl: playable ? undefined : transferTile(t, rec),
      progress: transferRowProgress(t),
      // The group title says the state; what it can't say is that this one
      // was fetched to replace a library copy.
      badge: rec && rec.upgrade ? { label: "Upgrade", variant: "accent" } : undefined,
      kind: "audio",
      actions: transferRowActions(t, rec, tier),
      action: playable ? "play-transfer" : undefined
    };
  });
}

// ---- the folder list ----------------------------------------------------------
// Folders are a table like Files, not a grid of cards: a card is built around a
// cover, and a folder has none — its tile was the format, drawn big, while the
// facts you choose a folder by (format, tracks, size, a free slot, the sharer)
// were squeezed into one truncated line and couldn't be sorted. The name opens
// the folder; the hover button downloads it, so the common case is one click
// and a stray click on the row still fetches nothing.
var FOLDER_LIST_COLUMNS = [
  { id: "quality", label: "Quality", width: 130, sortable: true },
  { id: "tracks", label: "Tracks", width: 70, align: "right", sortable: true },
  { id: "size", label: "Size", width: 80, align: "right", sortable: true },
  { id: "availability", label: "Availability", width: 110, sortable: true }
];

// Same convention as RESULT_SORTS: `desc` is best-first on every column.
var FOLDER_SORTS = {
  quality: function (g) { return [-g.bestQualityTier, g.totalSize || 0]; },
  tracks: function (g) { return [g.files.length]; },
  size: function (g) { return [g.totalSize || 0]; },
  availability: function (g) { return [-(g.availabilityTier != null ? g.availabilityTier : 9), -(g.queueLength || 0), g.uploadSpeed || 0]; }
};

function sortedFolders() {
  var list = visibleFolders();
  var keyOf = FOLDER_SORTS[search.folderSortColumn];
  if (!keyOf) return list;
  var sign = search.folderSortDir === "asc" ? -1 : 1;
  return list.slice().sort(function (a, b) {
    var ka = keyOf(a), kb = keyOf(b);
    for (var i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return (kb[i] - ka[i]) * sign;
    return 0;
  });
}

// Pure-ish: a folder row's chip once some of its files were queued — how far
// the folder got — or null while none were. Failed files count as free (see
// notYetQueued), so a folder whose downloads all failed is a result again.
function folderRowStatus(g, now) {
  var n = g.files.length, done = 0, active = 0, moving = 0;
  for (var i = 0; i < n; i++) {
    var ph = rowPhase(g.username + KEY_SEP + g.files[i].filename, now);
    if (ph === "done") done++;
    else if (ph === "moving" || ph === "waiting") { active++; if (ph === "moving") moving++; }
  }
  if (!done && !active) return null;
  if (done === n) return { label: "Done", variant: "success" };
  if (!active) return { label: done + " of " + n + " done", variant: "muted" };
  return moving
    ? { label: "Downloading " + done + " of " + n, variant: "accent" }
    : { label: "Queued " + (done + active) + " of " + n, variant: "warning" };
}

// The files a folder row's Download fetches: in Fill, the ones the album
// lacks; otherwise all of them — minus anything already on its way.
function folderRowFiles(g) {
  var m = search.mode;
  var files = m && m.kind === "fill" ? missingFiles(g.files, m.owned) : g.files;
  return notYetQueued(files);
}

function folderRows() {
  var m = search.mode;
  var fill = m && m.kind === "fill" ? m : null;
  var now = nowMs();
  return sortedFolders().map(function (g) {
    var rep = sharerLabel(sharers[g.username]);
    var cells = { tracks: String(g.files.length), size: formatBytes(g.totalSize), availability: availabilityLabel(g) + (rep ? " · " + rep : "") };
    var quality = folderQualityLabel(g.files);
    if (quality) cells.quality = quality;
    var subtitle = g.username;
    if (fill) {
      // What the row offers is the folder's contribution to THIS album, not
      // the folder: how many of its files you lack and what they weigh.
      var missing = missingFiles(g.files, fill.owned);
      subtitle += " · " + (missing.length
        ? missing.length + " you don't have · " + formatBytes(sumSizes(missing))
        : "you have all of these");
    }
    var row = {
      id: "d:" + g.key,
      title: g.name,
      subtitle: subtitle,
      cells: cells,
      imageUrl: folderTile(g.files),
      action: "open-folder",
      actions: folderRowFiles(g).length ? ["folder-row-download", "open-folder"] : ["open-folder"]
    };
    var badge = folderRowStatus(g, now);
    if (badge) row.badge = badge;
    return row;
  });
}

function folderRowActions(rows) {
  var fill = search.mode && search.mode.kind === "fill";
  return declaredActions([
    { id: "folder-row-download", label: fill ? "Download the ones you don't have" : "Download folder", icon: "⬇" },
    { id: "open-folder", label: "Open folder", icon: "›" }
  ], rows, ["open-folder"]);
}

// ---- the open folder ---------------------------------------------------------
// A card opens the folder instead of queueing all of it: a click that fetched
// a whole album, unseen, was too easy to make by accident. Inside, the
// tracklist with sizes and lengths, the songs the library already has marked,
// and one button for what you lack (or for all of it).
var openFolder = null;     // the open folder's key, or null for the cards
var folderOwned = {};      // folder key → { filename: true } for songs the library has
var folderOwnedChecked = {};

var FOLDER_OWNED_LOOKUPS_MAX = 40;

// Plain searches ask the library about each song once per folder; Fill knows
// already, from its mode.
// `folderOwnedChecked[key]` is "pending" while the lookups run and true once
// they're done — the view says "Checking your library…" until then.
async function checkFolderOwned(g) {
  if (folderOwnedChecked[g.key]) return;
  folderOwnedChecked[g.key] = "pending";
  var owned = {};
  try {
    var files = g.files.slice(0, FOLDER_OWNED_LOOKUPS_MAX);
    for (var i = 0; i < files.length; i++) {
      var meta = parseTrackMeta(files[i].filename);
      if (!meta.title) continue;
      var row = await libraryRowByName(meta.title, meta.artist, files[i].length);
      if (row) owned[files[i].filename] = true;
    }
  } finally {
    // A failed lookup leaves what was found; the hint must not spin forever.
    folderOwned[g.key] = owned;
    folderOwnedChecked[g.key] = true;
    if (openFolder === g.key) render();
  }
}

// Pure: which of a folder's files the library has, as { filename: true }.
function ownedInFolder(g, mode, ownedByName) {
  if (mode && mode.kind === "fill") {
    var missing = missingFiles(g.files, mode.owned);
    var miss = {};
    for (var i = 0; i < missing.length; i++) miss[missing[i].filename] = true;
    var out = {};
    for (var j = 0; j < g.files.length; j++) if (!miss[g.files[j].filename]) out[g.files[j].filename] = true;
    return out;
  }
  return ownedByName || {};
}

// Pure-ish: the files that aren't queued, downloading or done already. Failed
// ones count as free — a folder whose downloads failed must still offer its
// Download button, not say "Every file here is queued or downloaded".
function notYetQueued(files) {
  var now = nowMs();
  return files.filter(function (c) {
    var ph = rowPhase(c.username + KEY_SEP + c.filename, now);
    return !ph || ph === "failed";
  });
}

function sumSizes(files) {
  var b = 0;
  for (var i = 0; i < files.length; i++) b += files[i].size || 0;
  return b;
}

// The folder's own column set: the same facts as Files, without the sort
// (a tracklist reads in track order).
var FOLDER_COLUMNS = RESULT_COLUMNS.map(function (c) {
  return { id: c.id, label: c.label, width: c.width, align: c.align };
});

function folderView(g) {
  var out = [];
  out.push({ type: "toolbar", title: g.name, status: folderSubtitle(g), buttons: [] });
  var owned = ownedInFolder(g, search.mode, folderOwned[g.key]);
  var files = g.files.slice().sort(function (a, b) {
    var x = basenameRemote(a.filename).toLowerCase(), y = basenameRemote(b.filename).toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
  var missing = notYetQueued(files.filter(function (c) { return !owned[c.filename]; }));
  var all = notYetQueued(files);
  var ownedCount = files.filter(function (c) { return owned[c.filename]; }).length;
  // Until the library has answered, "all" may include songs you own, so it
  // isn't the button to press first.
  var checking = !(search.mode && search.mode.kind === "fill") && folderOwnedChecked[g.key] !== true;
  // Back leads the row: after a long folder name in the toolbar it drifted
  // toward the middle.
  var buttons = [actionButton("← Folders", "close-folder", "secondary")];
  if (!all.length) {
    buttons.push(mutedText("Every file here is queued or downloaded."));
  } else if (ownedCount && missing.length) {
    buttons.push(actionButton("Download the " + missing.length + " you don't have · " + formatBytes(sumSizes(missing)), "folder-download", "accent", { data: { which: "missing" } }));
    buttons.push(actionButton("Download all " + all.length + " · " + formatBytes(sumSizes(all)), "folder-download", "secondary", { data: { which: "all" } }));
  } else {
    buttons.push(actionButton("Download " + (all.length === 1 ? "1 file" : "all " + all.length) + " · " + formatBytes(sumSizes(all)), "folder-download", ownedCount || checking ? "secondary" : "accent", { data: { which: "all" } }));
  }
  if (ownedCount) buttons.push(mutedText("You have " + ownedCount + " of " + files.length + " already."));
  else if (checking) buttons.push(mutedText("Checking your library…"));
  out.push(buttonRow(buttons));
  var rows = files.map(function (c) { return resultRow(c, "o:", !!owned[c.filename]); });
  out.push({
    type: "track-row-list",
    items: rows,
    artwork: "cached",
    showHeader: true,
    selectable: true,
    openOnClick: "title",
    actions: fileRowActions(false, rows),
    columns: FOLDER_COLUMNS
  });
  return out;
}

// Pure: a folder card's line — who, how much, and whether they will send it.
// The format is on the card's tile (folderTile); what's left to choose by is
// the sharer: a free slot or a queue, and how they did for us before.
function folderSubtitle(g) {
  var n = g.files.length;
  var bits = [g.username, n + (n === 1 ? " track" : " tracks"), formatBytes(g.totalSize), availabilityLabel(g)];
  var rep = sharerLabel(sharers[g.username]);
  if (rep) bits.push(rep);
  return bits.join(" · ");
}

// The bar over the results: how much was found, Files / Folders, and — once a
// column header re-sorted the files — the way back to the ranked order. The
// host's headers toggle asc/desc and never offer a third state, so without it
// one click on a column cost you the ranking until you searched again.
//
// A toolbar, not a second `tabs` node: drawn like the main tabs right under
// them, Files / Folders read as more navigation, and users never found
// Folders at all (owner, 2026-10-06). The action and payload are the old
// tabs' (`result-mode`, `{ tabId }`).
function resultsToolbar(fileCount, folderCount, upgrading) {
  var folders = activeTab === "folders";
  var title = upgrading
    ? formatCount(fileCount) + (fileCount === 1 ? " better file" : " better files")
    : formatCount(folderCount) + (folderCount === 1 ? " folder" : " folders") + " · " + formatCount(fileCount) + (fileCount === 1 ? " file" : " files");
  var buttons = [];
  if (!upgrading) {
    buttons.push({ label: "Files", action: "result-mode", variant: folders ? "secondary" : "accent", data: { tabId: "files" } });
    buttons.push({ label: "Folders", action: "result-mode", variant: folders ? "accent" : "secondary", data: { tabId: "folders" } });
  }
  var status = search.responseCount ? "from " + formatCount(search.responseCount) + (search.responseCount === 1 ? " sharer" : " sharers") : undefined;
  var sortCol = folders ? (openFolder ? null : search.folderSortColumn) : search.sortColumn;
  if (sortCol) {
    var col = (folders ? FOLDER_LIST_COLUMNS : RESULT_COLUMNS).filter(function (c) { return c.id === sortCol; })[0];
    status = "sorted by " + (col ? col.label : sortCol);
    buttons.push({ label: "Best match", action: "sort-best", variant: "secondary", icon: "↺" });
  }
  return { type: "toolbar", title: title, buttons: buttons, status: status };
}

// ---- recent searches -------------------------------------------------------
// The last few plain searches as one-click buttons under the box, in place of
// retyping. Modes (Upgrade, Fill) aren't remembered: they come from a track or
// an album, not from the box.
var RECENT_SEARCH_MAX = 6;
var recentSearches = [];

// Pure: `list` with `query` at the front, case-insensitive duplicates dropped.
function withRecentSearch(list, query, max) {
  var q = String(query || "").trim();
  if (!q) return list || [];
  var low = q.toLowerCase();
  var out = [q];
  var src = list || [];
  for (var i = 0; i < src.length && out.length < max; i++) {
    if (String(src[i]).toLowerCase() !== low) out.push(src[i]);
  }
  return out;
}

function rememberSearch(query) {
  recentSearches = withRecentSearch(recentSearches, query, RECENT_SEARCH_MAX);
  api.storage.set("recentSearches", recentSearches).catch(function (e) { console.error("slskd: couldn't save recent searches:", e); });
}

function recentSearchRow() {
  if (!recentSearches.length) return [];
  var buttons = [mutedText("Recent")];
  for (var i = 0; i < recentSearches.length; i++) {
    buttons.push(actionButton(recentSearches[i], "recent-search", "secondary", { data: { query: recentSearches[i] } }));
  }
  buttons.push(actionButton("Clear", "recent-search-clear"));
  return [buttonRow(buttons)];
}

// The line above a mode's results: what was asked for, what the library has,
// and the way out of the filter. The plain search box stays above it — a new
// search is how a mode ends.
function modeHeader() {
  var m = search.mode;
  if (!m) return [];
  var out = [];
  if (m.kind === "upgrade") {
    var cur = m.current;
    var ext = (cur.extension || "").toUpperCase();
    // The rate is derived from size ÷ duration (see libraryQuality), so it is
    // shown as approximate rather than as a figure read off the file.
    var have = cur.qualityTier === T_LOSSLESS ? qualityLabel(cur)
      : (cur.bitRate ? ext + " ≈" + cur.bitRate + "kbps" : (ext || "unknown quality"));
    if (cur.size) have += " · " + formatBytes(cur.size);
    out.push({ type: "text", content: "Upgrading “" + m.title + "”" + (m.artist ? " by " + m.artist : "") +
      " — your copy is " + have + ". " + (m.showAll ? "Showing every file found; better ones are marked." : "Showing only files that would be an upgrade."), className: "plugin-muted" });
  } else if (m.kind === "fill") {
    out.push({ type: "text", content: "Filling “" + m.albumTitle + "”" + (m.artistName ? " by " + m.artistName : "") +
      " — you have " + m.owned.length + (m.owned.length === 1 ? " track" : " tracks") + " of it. " +
      (m.showAll ? "Showing every file and folder found." : "Showing only files you don't have; open a folder to download just those."), className: "plugin-muted" });
  }
  out.push({ type: "button", label: m.showAll ? "Only what's missing" : "Show everything found", action: "mode-show-all", variant: "secondary" });
  return out;
}

// What a download started from a mode carries into its tracked record — see
// `enqueueBatch`'s `recExtra`.
function modeRecExtra(mode) {
  var m = mode === undefined ? search.mode : mode;
  if (!m) return null;
  if (m.kind === "upgrade") {
    return {
      upgrade: { trackId: m.trackId, title: m.title, artist: m.artist },
      meta: { title: m.title, artist: m.artist, album: m.album, track_number: m.trackNumber }
    };
  }
  if (m.kind === "fill") return { meta: { album: m.albumTitle, album_artist: m.artistName } };
  return null;
}

// "Showing the best 1,000 of 20,431 files" — the cap has to be visible, or a
// broad query silently looks like it found exactly 1,000 things.
function truncationNote() {
  // Under a mode's filter the shown count is the filter's doing, not the cap's,
  // and "the best 3 of 20,431" would blame the wrong thing.
  if (search.mode && !search.mode.showAll) return null;
  var shown = activeTab === "folders" ? search.folders.length : search.results.length;
  var total = activeTab === "folders" ? search.folderCount : search.matchCount;
  var noun = activeTab === "folders" ? "folders" : "files";
  if (!total || total <= shown) return null;
  return "Showing the best " + formatCount(shown) + " of " + formatCount(total) + " " + noun +
    ". Narrow the search to see the rest.";
}

function searchTab() {
  var children = [];
  children.push({
    type: "search-input",
    placeholder: "Search Soulseek for an artist, album or track…",
    action: "search",
    value: search.query,
    submitOnly: true,
    buttonLabel: "Search",
    pasteButton: true
  });
  var mode = search.mode;
  if (!mode && !search.running) children = children.concat(recentSearchRow());
  children = children.concat(modeHeader());
  var note = searchNote(search);
  if (note) children.push(note);

  if (search.error) {
    children.push({ type: "text", content: search.error, className: "plugin-error" });
    return { type: "layout", direction: "vertical", children: children };
  }

  if (search.running) {
    children.push({
      type: "loading",
      message: search.fileCount
        ? search.fileCount + " files from " + search.responseCount + " users so far…"
        : "Searching Soulseek — this takes a few seconds…"
    });
    return { type: "layout", direction: "vertical", children: children };
  }

  if (!search.query) {
    children.push({ type: "text", content: "Search the Soulseek network. Results are ranked by quality first, then by who can send them fastest.", className: "plugin-muted" });
    return { type: "layout", direction: "vertical", children: children };
  }

  if (!search.results.length) {
    // No peer answered at all — a typo, or one of the phrases Soulseek's server
    // won't search for (artist names, after takedown requests). Say how to
    // find the files anyway.
    children.push({ type: "text", content: search.responseCount === 0 && !search.error
      ? "Nobody on Soulseek answered “" + search.query + "”. Soulseek blocks searches for some artist names — if this one names an artist, try the album and song title without it."
      : "No downloadable audio found for “" + search.query + "”. Try fewer or broader words.", className: "plugin-muted" });
    return { type: "layout", direction: "vertical", children: children };
  }

  // The mode's filter can leave nothing — which is an answer in itself, and a
  // different one from "Soulseek has nothing": the copy is already as good as
  // what's out there, or the album is already complete.
  // A single track's upgrade is a file job; the Folders view would only offer
  // whole albums for a song, so it isn't shown in that mode.
  var upgrading = mode && mode.kind === "upgrade";
  if (upgrading && activeTab === "folders") activeTab = "search";
  var files = visibleResults();
  var folders = upgrading ? [] : visibleFolders();
  if (mode && !mode.showAll && !files.length && !folders.length) {
    children.push({ type: "text", className: "plugin-muted", content: upgrading
      ? "Nothing better than your copy turned up among " + formatCount(search.matchCount) + " files. Show everything found to see them anyway."
      : "Every file found is already in your library. Show everything found to browse the folders anyway." });
    return { type: "layout", direction: "vertical", children: children };
  }
  children.push(resultsToolbar(files.length, folders.length, upgrading));

  var trimmed = truncationNote();
  if (trimmed) children.push({ type: "text", content: trimmed, className: "plugin-muted" });

  var opened = activeTab === "folders" && openFolder ? folderByRef(openFolder) : null;
  if (opened) {
    children = children.concat(folderView(opened));
  } else if (activeTab === "folders") {
    var folderList = folderRows();
    children.push({
      type: "track-row-list",
      items: folderList,
      artwork: "cached",
      showHeader: true,
      // Columns and hover buttons render only on a selectable list; single
      // keeps the bulk toolbar away — every action here is the row's own.
      selectable: true,
      selectionMode: "single",
      openOnClick: "title",
      // A folder isn't a track: Play / Enqueue on it would mean nothing.
      contextMenu: false,
      actions: folderRowActions(folderList),
      columns: FOLDER_LIST_COLUMNS,
      sortBy: search.folderSortColumn || undefined,
      sortDir: search.folderSortColumn ? search.folderSortDir : undefined,
      sortAction: "sort-folders"
    });
  } else {
    // `selectable` is what makes `columns` render at all: the host's list has
    // two bodies, and only the selectable one swaps the fixed Album / Duration
    // pair for declared columns — the other hardcodes them and ignores
    // `columns` entirely, which showed up as an empty "Album" column where
    // Quality / Size / Length / Availability should have been.
    //
    // It earns its place anyway: a selection can be downloaded in one go, which
    // matters when the tracks you want sit with different sharers. `openOnClick`
    // keeps a click on the name doing what it always did — clicking anywhere
    // else in the row selects, so multi-select costs no modifier.
    //
    // The host renders `items` in the order given and only reports a header
    // click; it never reorders anything itself.
    var rows = resultRows();
    children.push({
      type: "track-row-list",
      items: rows,
      // The rows' artist/album are guesses parsed out of strangers' file
      // paths. Show art Viboplr already has, but never let a search make it
      // fetch (and keep) a cover for every album that merely appeared in the
      // results. Older hosts ignore the field and fetch as before.
      artwork: "cached",
      showHeader: true,
      selectable: true,
      openOnClick: "title",
      actions: fileRowActions(upgrading, rows),
      columns: RESULT_COLUMNS,
      sortBy: search.sortColumn || undefined,
      sortDir: search.sortColumn ? search.sortDir : undefined,
      sortAction: "sort-results"
    });
  }
  return { type: "layout", direction: "vertical", children: children };
}

// ---- row status (the host's track-row-list `badge` / `progress`) -----------------
// Hosts after 1.0.90 draw a state chip at the start of a row's subtitle and a
// thin bar under it; older hosts ignore both fields, which is why every row
// still says the same thing in its subtitle text. A chip is only worth it where
// rows of different states share a list (Upgrades) or a row is special within
// its group (a download fetched as an upgrade) — under a "Downloading" group
// title, a "Downloading" chip on every row would say it twice.

// Pure: a transfer's bar, 0–1, while bytes are moving; null otherwise (no bar
// at all rather than one stuck at 0 for a queued file).
function transferRowProgress(t) {
  var p = transferPhase(t && t.state);
  if (p !== "downloading" && p !== "starting") return null;
  return transferProgress(t);
}

// Pure: the chip on an Upgrades row, by state.
var UPGRADE_BADGES = {
  searching: { label: "Searching", variant: "muted" },
  downloading: { label: "Downloading", variant: "accent" },
  checking: { label: "Checking", variant: "accent" },
  ready: { label: "Ready", variant: "success" },
  alternative: { label: "Below target", variant: "warning" },
  none: { label: "Nothing better", variant: "muted" },
  failed: { label: "Failed", variant: "error" },
  cancelled: { label: "Cancelled", variant: "muted" },
  replaced: { label: "Replaced", variant: "success" },
  gone: { label: "Not in library", variant: "muted" }
};
function upgradeBadge(e, t) {
  if (!e) return null;
  if (e.state === "downloading") {
    var p = t ? transferPhase(t.state) : null;
    if (p !== "downloading" && p !== "starting") return { label: "Queued", variant: "warning" };
  }
  return UPGRADE_BADGES[e.state] || null;
}

// Pure: an upgrade row's bar — the active download's, while it moves.
function upgradeRowProgress(e, t) {
  return e && e.state === "downloading" && t ? transferRowProgress(t) : null;
}

// Pure: which group of the Downloads tab a transfer sits in. Problems come
// first so a failure can't hide thirty rows down; a finished file is the one
// thing nobody needs to look at again.
function transferGroup(t) {
  var p = transferPhase(t && t.state);
  if (p === "failed") return "attention";
  if (p === "downloading" || p === "starting") return "active";
  if (p === "succeeded") return "finished";
  if (p === "cancelled") return "cancelled";
  return "waiting";
}

var TRANSFER_GROUPS = [
  { id: "attention", title: "Needs attention" },
  { id: "active", title: "Downloading" },
  { id: "waiting", title: "Waiting" },
  { id: "finished", title: "Finished" },
  { id: "cancelled", title: "Cancelled" }
];

// Pure: the Downloads tab's count — what is still moving or needs you. Finished
// and cancelled files are history; counting them kept the badge lit forever.
function liveTransferCount(list) {
  var n = 0;
  for (var i = 0; i < (list || []).length; i++) {
    var g = transferGroup(list[i]);
    if (g === "attention" || g === "active" || g === "waiting") n++;
  }
  return n;
}

// Finished rows past this many fold behind "Show all".
var FINISHED_SHOWN = 10;
var showAllFinished = false;

// Pure: one line for the summary bar over the groups.
function transfersSummary(groups, collectionName) {
  var active = groups.active, done = 0, total = 0, speed = 0;
  for (var i = 0; i < active.length; i++) {
    done += active[i].bytesTransferred || 0;
    total += active[i].size || 0;
    speed += active[i].averageSpeed || 0;
  }
  var bits = [];
  if (active.length) bits.push(active.length + " downloading");
  if (groups.waiting.length) bits.push(groups.waiting.length + " waiting");
  if (active.length) bits.push(formatBytes(done) + " of " + formatBytes(total));
  if (speed) bits.push("↓ " + formatSpeed(speed));
  if (collectionName) bits.push("lands in “" + collectionName + "”");
  return { done: done, total: total, label: bits.join(" · ") };
}

function transferList(rows, actionIds) {
  var all = {
    "play-transfer": { id: "play-transfer", label: "Play", icon: "▶" },
    "replace-transfer": { id: "replace-transfer", label: "Replace in library…", icon: "⇪" },
    // Not "＋": that is the host's Enqueue glyph.
    "import-transfer": IMPORT_ACTION,
    "retry-transfer": { id: "retry-transfer", label: "Retry", icon: "↻" },
    "another-source": { id: "another-source", label: "Another source", icon: "⇄" },
    "cancel-transfer": { id: "cancel-transfer", label: "Cancel", icon: "■" },
    // Leaves the file where it is — a list, not a trash can. The bin icon is
    // kept for "Delete file", which really deletes.
    "remove-transfer": { id: "remove-transfer", label: "Clear from list", icon: "✕" }
  };
  return {
    type: "track-row-list",
    items: rows,
    selectable: true,
    showHeader: true,
    // Which of these a row shows is transferRowActions' call — only what would
    // do something to THAT transfer.
    actions: actionIds.map(function (id) { return all[id]; })
  };
}

function transfersTab() {
  var children = [];
  var col = tier === "local" ? downloadsCollection() : null;
  if (!transfers.length) {
    children.push({ type: "text", className: "plugin-muted", content: "No downloads yet. Search, then Download a file or a whole folder." +
      (lastFallbackKeptCount() ? " Files the playback fallback fetched are on the Fallback tab." : "") });
    return { type: "layout", direction: "vertical", children: children };
  }

  // Where finished files go is one clause on the summary bar when it's good
  // news; the longer explanation is only for when the user has to act on it.
  if (tier === "remote") {
    children.push({ type: "text", content: "slskd is running on another machine, so finished files can't be played or added to the library from here. Add slskd's downloads folder (or its mount) as a music source in Collections.", className: "plugin-muted" });
  } else if (!col) {
    children.push({ type: "text", className: "plugin-muted", content: "Finished downloads play from here; Add to library copies one into a collection. Add slskd's downloads folder as a collection and they'll be picked up by themselves." });
  }

  var groups = { attention: [], active: [], waiting: [], finished: [], cancelled: [] };
  var rows = transferRows();
  for (var i = 0; i < transfers.length; i++) {
    var g = transferGroup(transfers[i]);
    groups[g].push(transfers[i]);
    rows[i].group = g;
  }
  var sum = transfersSummary(groups, col ? col.name : null);
  if (groups.active.length) {
    children.push({ type: "progress-bar", value: sum.done, max: sum.total || 1, label: sum.label });
  } else if (sum.label) {
    children.push({ type: "text", className: "plugin-muted", content: sum.label.charAt(0).toUpperCase() + sum.label.slice(1) + "." });
  }

  for (var k = 0; k < TRANSFER_GROUPS.length; k++) {
    var id = TRANSFER_GROUPS[k].id;
    var mine = rows.filter(function (r) { return r.group === id; });
    if (!mine.length) continue;
    var buttons = [];
    if (id === "attention") buttons.push({ label: "Retry all", action: "retry-transfer", icon: "↻", data: { selectedIds: mine.map(function (r) { return r.id; }) } });
    if (id === "finished") {
      // Every finished file in one go — the per-row button and a selection do
      // the same, but this is the one nobody has to discover.
      var importable = mine.filter(function (r) { return importTrackFor(r.id); }).map(function (r) { return r.id; });
      if (importable.length > 1) buttons.push({ label: "Add all " + importable.length + " to library…", action: "import-transfer", icon: IMPORT_ACTION.icon, data: { selectedIds: importable } });
    }
    if (id === "finished" || id === "cancelled") buttons.push({ label: "Clear", action: "remove-transfer", icon: "✕", data: { selectedIds: mine.map(function (r) { return r.id; }) } });
    var shown = mine;
    if (id === "finished" && mine.length > FINISHED_SHOWN) {
      buttons.unshift({ label: showAllFinished ? "Show fewer" : "Show all " + mine.length, action: "finished-toggle" });
      if (!showAllFinished) shown = mine.slice(0, FINISHED_SHOWN);
    }
    var status = String(mine.length);
    if (id === "finished" && col) status += " · in your library";
    children.push({ type: "toolbar", title: TRANSFER_GROUPS[k].title, status: status, buttons: buttons,
      statusVariant: id === "attention" ? "error" : undefined });
    children.push(transferList(shown, id === "attention" ? ["another-source", "retry-transfer", "remove-transfer"]
      : id === "finished" ? ["play-transfer", "replace-transfer", "import-transfer", "remove-transfer"]
      : id === "cancelled" ? ["retry-transfer", "remove-transfer"]
      : ["another-source", "cancel-transfer"]));
  }
  return { type: "layout", direction: "vertical", children: children };
}

function lastFallbackKeptCount() {
  return fallbackTotals(fallback).count;
}

// The Fallback tab: what the last automatic resolve did, step by step — the
// file it picked and every file it weighed. Mirrors the yt-dlp plugin's "Last
// resolve" panel. The files it kept are listed under Downloads (keptSection),
// with the rest of what slskd fetched.
//
// The facts of one candidate on one line: the Fallback tab is a read-out of
// what the resolver saw and did, not a second search view, so its files are
// text — no artwork, no row actions, nothing to click. (A track-row-list would
// fetch cover art for every row and offer Download on each, which is the Search
// tab's job.)
function candidateFacts(c) {
  var cells = resultCells(c);
  var bits = [];
  if (cells.quality) bits.push(cells.quality);
  if (cells.size) bits.push(cells.size);
  if (cells.duration) bits.push(cells.duration);
  if (cells.availability) bits.push(cells.availability);
  return bits.join(" · ");
}

function sameCandidate(a, b) {
  return !!(a && b && a.username === b.username && a.filename === b.filename);
}

// ✓ played · ↓ downloading now · ✗ tried and dropped.
function candidateMark(rec, c) {
  if (sameCandidate(rec.chosen, c)) return rec.outcome === "played" ? "✓" : "↓";
  if (rec.outcome === "running" && sameCandidate(rec.picked, c)) return "↓";
  if (rec.tried.indexOf(c.username + KEY_SEP + c.filename) >= 0) return "✗";
  return "  ";
}

function candidateLines(rec) {
  return rec.candidates.map(function (c) {
    return {
      type: "text",
      className: "plugin-muted",
      content: candidateMark(rec, c) + " " + matchLabel(c.match) + "  " + resultLabel(c) + "  ·  " + candidateFacts(c) + "  ·  " + resultSource(c)
    };
  });
}

// The file the resolver went for: the one it played, or the one it is (or was
// last) downloading. Null before any download was started.
function pickedLine(rec) {
  var c = rec.chosen || rec.picked;
  if (!c) return null;
  var state;
  if (rec.outcome === "played") state = "played";
  else if (rec.outcome === "running") state = rec.live ? liveLine(rec) : "waiting for the sharer";
  else if (rec.outcome === "timeout" && rec.chosen) state = "still downloading — used next time";
  else state = "dropped";
  return [
    { type: "text", content: "Picked: " + resultLabel(c) + "  —  " + state },
    { type: "text", className: "plugin-muted", content: candidateFacts(c) + "  ·  " + resultSource(c) }
  ];
}

function keptRows() {
  var keys = Object.keys(fallback);
  var rows = [];
  for (var i = 0; i < keys.length; i++) {
    var e = fallback[keys[i]];
    if (!e) continue;
    var rec = tracked[e.ref];
    var parts = splitKey(e.ref);
    var bits = [];
    if (e.state === "kept") {
      bits.push(formatBytes(e.size));
      if (parts) bits.push("from " + parts.username);
      if (rec && rec.resolvedPath) bits.push(rec.resolvedPath);
    } else {
      bits.push("still downloading");
      if (parts) bits.push("from " + parts.username);
    }
    var meta = (rec && rec.meta) || {};
    var playable = e.state === "kept" && rec && rec.resolvedPath;
    rows.push({
      id: "k:" + keys[i],
      title: e.title + (e.artist ? " — " + e.artist : ""),
      subtitle: bits.join("  ·  "),
      artistName: e.artist || meta.artist || null,
      albumTitle: meta.album || null,
      durationSecs: rec && rec.length != null ? rec.length : null,
      path: playable ? SCHEME + "://" + e.ref : null,
      kind: "audio",
      badge: e.state === "kept" ? undefined : { label: "Downloading", variant: "accent" },
      actions: playable ? ["play-kept", "import-kept", "delete-kept"] : ["delete-kept"],
      action: playable ? "play-kept" : undefined,
      sortAt: e.lastUsedAt || e.at || 0
    });
  }
  rows.sort(function (a, b) { return b.sortAt - a.sortAt; });
  return rows;
}

function outcomeLine(rec) {
  var label = {
    running: "Working…",
    played: "Played the file it fetched",
    cached: "Played a copy fetched earlier",
    timeout: "Ran out of time",
    "no-match": "Nothing matched",
    failed: "Failed"
  }[rec.outcome] || rec.outcome;
  var bits = [label];
  if (rec.message) bits.push(rec.message);
  if (rec.totalMs != null) bits.push(Math.round(rec.totalMs / 100) / 10 + "s");
  return bits.join("  ·  ");
}

var showResolveTrace = false;   // the Fallback tab's step-by-step trace, folded by default
var keptConfirm = false;        // "Delete all kept files?" showing

// The Fallback tab is the whole feature in one place: is it working (numbers),
// what it did last (summary first, the trace on request), what it did lately,
// the files it kept, and its settings. Those used to sit on three tabs.
function fallbackTab() {
  var children = [];
  children.push(fallbackStatusNode(resolveHistory, lastResolve, Date.now(), fallbackLastUsedAt));

  var st = resolveStats(resolveHistory);
  var totals = fallbackTotals(fallback);
  var lt = ledgerTotals(sharers);
  if (st.total || totals.count || lt.seen) {
    children.push({ type: "stats-grid", items: [
      { label: "played", value: st.started + " of " + st.total },
      { label: "median time to start", value: st.medianMs != null ? secondsLabel(st.medianMs) : "—" },
      { label: "files kept · " + formatBytes(totals.bytes), value: totals.count },
      { label: "sharers proven / unreliable", value: lt.proven + " / " + lt.burned }
    ] });
  }

  children = children.concat(lastResolveSection());

  if (resolveHistory.length) {
    children.push({ type: "toolbar", title: "Recent", status: resolveHistory.length + (resolveHistory.length === 1 ? " resolve" : " resolves"),
      buttons: [{ label: "Clear", action: "clear-resolve-history", icon: "✕" }] });
    // Rows, not lines: each is a song, so it gets the universal track menu,
    // and one that didn't play offers the search that might find it.
    // `selectable` because only that list body draws a row's hover actions.
    var recentRows = historyRows(resolveHistory.slice(0, 10), Date.now());
    children.push({
      type: "track-row-list",
      items: recentRows,
      artwork: "cached",
      showHeader: false,
      selectable: true,
      actions: declaredActions([{ id: "fallback-search", label: "Search Soulseek for it", icon: "⌕" }], recentRows)
    });
  }

  children = children.concat(keptSection());
  children.push(fallbackSettingsSection());
  return { type: "layout", direction: "vertical", children: children };
}

// The last resolve: what happened, to which song, with which file. The
// numbered steps and every candidate weighed (✓ ↓ ✗) are the debugging view,
// one click away instead of the first thing on the tab.
function lastResolveSection() {
  var out = [];
  var buttons = [];
  if (lastResolve) {
    buttons.push({ label: showResolveTrace ? "Hide trace" : "Show trace", action: "fallback-trace-toggle" });
    buttons.push({ label: "Clear", action: "clear-resolve", icon: "✕" });
  }
  out.push({ type: "toolbar", title: "Last resolve", buttons: buttons,
    status: lastResolve ? outcomeLine(lastResolve) : undefined,
    statusVariant: lastResolve && lastResolve.outcome === "failed" ? "error"
      : lastResolve && (lastResolve.outcome === "played" || lastResolve.outcome === "cached") ? "success" : undefined });
  if (!lastResolve) {
    out.push({ type: "text", className: "plugin-muted",
      content: "Nothing yet this session. Play a track with no source of its own — a library row whose file is gone, a streaming track that can't be reached — and what happened shows here." });
    return out;
  }

  var lr = lastResolve;
  out.push({ type: "text", content: "“" + lr.title + "”" + (lr.artist ? " — " + lr.artist : "") +
    (lr.durationSecs != null ? "  ·  " + formatDurationSecs(lr.durationSecs) : "") });
  if (lr.outcome === "running" && lr.live) {
    if (lr.progress != null) out.push({ type: "progress-bar", value: Math.round(lr.progress * 100), max: 100, label: liveLine(lr) });
    else out.push({ type: "loading", message: liveLine(lr) });
  } else if (lr.outcome === "running") {
    out.push({ type: "loading", message: "Working…" });
  }
  out.push(mutedText("Searched for “" + lr.query + "”"));
  var picked = pickedLine(lr);
  if (picked) out = out.concat(picked);
  if (lr.candidates.length && !showResolveTrace) {
    out.push(mutedText(lr.candidates.length + (lr.candidates.length === 1 ? " matching file" : " matching files") + " weighed — Show trace for each step and file."));
  }
  if (!showResolveTrace) return out;

  for (var i = 0; i < lr.steps.length; i++) {
    var s = lr.steps[i];
    var line = (i + 1) + ". " + s.label + (s.outcome ? " → " + s.outcome : "…") + (s.ms != null ? " (" + Math.round(s.ms / 100) / 10 + "s)" : "");
    out.push({ type: "text", content: line, className: s.level === "error" ? "plugin-error" : "plugin-muted" });
  }
  if (lr.candidates.length) {
    out.push(mutedText("Matching files, best first — ✓ played · ↓ downloading · ✗ tried and dropped. Match is how closely the file name fits the title and artist."));
    out = out.concat(candidateLines(lr));
  }
  return out;
}

// On the Fallback tab: the files the playback fallback fetched. They are the
// plugin's own record (slskd's transfer list may have forgotten them), kept so
// the same song plays instantly next time, and deletable from disk here.
function keptSection() {
  var totals = fallbackTotals(fallback);
  var keys = Object.keys(fallback);
  if (!keys.length) return [];
  var out = [];
  var col = downloadsCollection();
  out.push({ type: "toolbar", title: "Kept files",
    status: totals.count + (totals.count === 1 ? " file" : " files") + " · " + formatBytes(totals.bytes) + (col ? " · in your library via “" + col.name + "”" : ""),
    buttons: totals.count ? [{ label: "Delete all…", action: "delete-all-kept-ask", icon: "🗑" }] : [] });
  if (keptConfirm) {
    out.push({ type: "confirm", title: "Delete every kept file?",
      message: "Deletes " + totals.count + (totals.count === 1 ? " file" : " files") + " (" + formatBytes(totals.bytes) + ") from slskd's downloads folder. A song is simply fetched again the next time it's needed." +
        (col ? " They are library tracks too, through “" + col.name + "”, and leave the library with the files." : ""),
      confirmLabel: "Delete " + totals.count + (totals.count === 1 ? " file" : " files"), cancelLabel: "Keep them", confirmVariant: "danger",
      confirmAction: "delete-all-kept", cancelAction: "delete-all-kept-cancel" });
  }
  out.push({ type: "text", className: "plugin-muted",
    content: "Kept in slskd's downloads folder so the same song plays at once next time. Delete file removes it from disk through slskd." });
  out.push({
    type: "track-row-list",
    items: keptRows(),
    selectable: true,
    showHeader: true,
    actions: [
      { id: "play-kept", label: "Play", icon: "▶" },
      { id: "import-kept", label: "Add to library…", icon: "＋" },
      { id: "delete-kept", label: "Delete file", icon: "🗑" }
    ]
  });
  return out;
}

// Pure: what the chosen fallback quality means, in the row under it.
function fallbackQualityDescription(mode, preferredFormats) {
  var text = mode === "best"
    ? "Lossless first, as the Search tab ranks — the song can take several times longer to start."
    : mode === "lossless"
      ? "Only lossless files. When nobody has one in time, the fallback skips the track rather than play a lossy copy."
      : mode === "high"
        ? "Only high-bitrate lossy files, MP3 320 or V0 first. Lower rates, lossless and files that report no bitrate are skipped."
        : "High-bitrate lossy files first — a fifth of the bytes of lossless, so the song starts sooner. Anything that matches can play.";
  if (preferredFormats) {
    text += fallbackModeFilters(mode)
      ? " Your preferred formats (“" + preferredFormats + "”) order what's left."
      : " Your preferred formats (“" + preferredFormats + "”) decide the order instead.";
  }
  return text;
}

// Pure-ish: the line under "Keep at most" — what cleanup does, what it skips,
// and how the last run went (a refusal stays here until it clears).
function fallbackCleanupDescription() {
  var text = "Least recently played go first. Files inside a collection and anything played in the last 15 minutes are never deleted automatically.";
  var c = fallbackCleanup;
  if (c && c.error) text += " Last cleanup stopped: " + c.error;
  else if (c && c.deleted) text += " Last cleanup deleted " + c.deleted + (c.deleted === 1 ? " file" : " files") + " (" + formatBytes(c.bytes) + ").";
  return text;
}

function fallbackSettingsSection() {
  var totals = fallbackTotals(fallback);
  var children = [
    { type: "settings-row", label: "Quality",
      description: fallbackQualityDescription(fallbackModeOf(settings.fallbackQuality), settings.preferredFormats),
      control: { type: "select", action: "set-fallback-quality", value: fallbackModeOf(settings.fallbackQuality),
        options: [
          { value: "fast", label: "Fastest start" },
          { value: "best", label: "Best available" },
          { value: "lossless", label: "Lossless only" },
          { value: "high", label: "MP3 320 / V0 only" }
        ] } },
    { type: "settings-row", label: "Sharers",
      description: (function () {
        var lt = ledgerTotals(sharers);
        if (!lt.seen) return "None watched yet. Sharers who have delivered rank first, here and in Search.";
        return lt.seen + (lt.seen === 1 ? " sharer" : " sharers") + " seen · " + lt.proven + " proven · " + lt.burned + " unreliable. Proven sharers rank first, here and in Search.";
      })() },
    { type: "settings-row", label: "Keep at most",
      description: fallbackCleanupDescription(),
      control: { type: "select", action: "set-fallback-max-gb", value: String(Number(settings.fallbackMaxGb) || 0),
        options: FALLBACK_MAX_GB_OPTIONS.map(function (g) { return { value: String(g), label: g ? g + " GB" : "No limit" }; }) } },
    { type: "settings-row", label: "Delete if not played for",
      description: "A deleted song is fetched again when it's needed.",
      control: { type: "select", action: "set-fallback-max-age", value: String(Number(settings.fallbackMaxAgeDays) || 0),
        options: FALLBACK_MAX_AGE_DAY_OPTIONS.map(function (d) { return { value: String(d), label: d ? d + " days" : "Never" }; }) } },
    Object.keys(sharers).length ? buttonRow([actionButton("Forget sharer history", "reset-sharers")]) : null
  ].filter(Boolean);
  void totals;
  return { type: "section", title: "Settings", children: children };
}

function render() {
  if (!api) return;
  pushViewHeader();
  if (managed.setup) {
    api.ui.setViewData(VIEW_ID, setupProgressView(), { scrollKey: "setup" });
    return;
  }
  var st = readiness.state;
  if (st === "unconfigured") ensureSetupKey();
  if (wantsSetupScreen(st, setupPage)) {
    api.ui.setViewData(VIEW_ID, setupView(), { scrollKey: "setup" });
    return;
  }
  // Left a setup page because the state moved on (the key is now the
  // problem, or slskd answered): land on the explanation, not a blank Search.
  if (setupPage !== "home" && st !== "ready") activeTab = "settings";
  setupPage = "home";
  var mainTab = mainTabFor(activeTab);
  var body = [];
  // Not ready, like yt-dlp without its binary: the view stays, the problem
  // is one line on top with the click that fixes it.
  var banner = readinessBanner(st, conn(), managed, signinWhy, mainTab === "settings");
  if (banner) {
    body.push(banner);
    body = body.concat(managedJobNodes());
  }
  body.push({
    type: "tabs",
    tabs: [
      // What you came for first; the download history, which you rarely need
      // now that search rows carry their own state, after them.
      { id: "search", label: "Search" },
      { id: "upgrades", label: "Upgrades", count: Object.keys(upgrades).filter(function (k) { return upgrades[k].state !== "replaced" && upgrades[k].state !== "gone"; }).length || undefined },
      { id: "fallback", label: "Fallback" },
      { id: "transfers", label: "Downloads", count: liveTransferCount(transfers) || undefined },
      { id: "settings", label: "Settings" }
    ],
    activeTab: mainTab,
    action: "main-tab"
  });
  body.push(mainTab === "transfers" ? transfersTab()
    : mainTab === "upgrades" ? upgradesTab()
    : mainTab === "fallback" ? fallbackTab()
    : mainTab === "settings" ? settingsTab()
    : searchTab());
  api.ui.setViewData(VIEW_ID, { type: "layout", direction: "vertical", children: body },
    { scrollKey: mainTab === "search" ? "search:" + search.query
      : (mainTab === "settings" && fixScrollKey) || mainTab });
}

// Pure: which top-level tab `activeTab` belongs to. "folders" is the Search
// tab's folder mode, not a tab of its own.
function mainTabFor(tab) {
  return tab === "transfers" || tab === "upgrades" || tab === "fallback" || tab === "settings" ? tab : "search";
}

// Settings live in the view's own Settings tab. The setup screens carry the
// Connection section themselves, so nothing here is unreachable while slskd
// isn't ready.
function renderSettings() {
  if (activeTab === "settings" || activeTab === "fallback" || activeTab === "upgrades") render();
}

// Pure: the Status checklist on top of Settings while slskd is ready — the
// four things that must hold for downloads to work and reach the library,
// each with its fix on the same row. (Not ready, `fixNodes` explains instead.)
// `share` says how to fix sharing: "managed" (the card below has Share…),
// "slskd" (slskd's own settings), or null.
function statusChecklist(rd, cfg, currentTier, col, share, ago) {
  var rows = [];
  rows.push(optionRow("✓ Connected as " + (rd.username || "?"),
    (rd.version ? "slskd " + rd.version + " · " : "") + (cfg.managedBy === "plugin" ? "slskd installed here · " : "") + (cfg.url || "") + (ago ? " · " + ago : ""),
    checkButton("Test")));
  if (rd.shareCount == null) {
    // slskd didn't say; nothing to claim either way.
  } else if (rd.shareCount > 0) {
    rows.push({ type: "settings-row", label: "✓ Sharing " + rd.shareCount + (rd.shareCount === 1 ? " folder" : " folders"),
      description: "Soulseek serves people who share first." });
  } else {
    rows.push(share === "slskd"
      ? optionRow("⚠ Not sharing anything", "Sharers serve people who share first, so your downloads may queue a long time. Add a shared folder in slskd's settings.",
        actionButton("Open slskd", "open-slskd"))
      : { type: "settings-row", label: "⚠ Not sharing anything",
        description: "Sharers serve people who share first, so your downloads may queue a long time." + (share === "managed" ? " Share your collections from the card below." : "") });
  }
  if (currentTier !== "local") {
    rows.push({ type: "settings-row", label: "⚠ slskd is on another computer",
      description: "Finished files can't be played or added from here. Add slskd's downloads folder (or its mount) as a music source in Collections." });
  } else if (col) {
    rows.push({ type: "settings-row", label: "✓ Downloads reach your library",
      description: "slskd's downloads folder is inside “" + col.name + "”." });
  } else {
    rows.push({ type: "settings-row", label: "⚠ Downloads stay in slskd's folder",
      description: "Add that folder (or a parent) as a music source in Collections and finished downloads reach the library by themselves. Until then, use Add to library on each one." });
  }
  return { type: "section", title: "Status", children: rows };
}

function settingsTab() {
  var children = fixNodes(readiness.state, conn(), managed, readiness.detail, signinWhy);
  if (readiness.state === "ready") {
    var share = usesManaged(conn(), managed) ? "managed" : "slskd";
    children.push(statusChecklist(readiness, conn(), tier, tier === "local" && downloadsDir ? downloadsCollection() : null,
      share, checkedAgo(connCheck.at, Date.now())));
  }
  // Above Connection while a fake runs or is in use; otherwise a footnote at
  // the bottom saying how to start one.
  var testServer = testServerSection(settings, debugDetected, debugLookedAt);
  var testServerActive = !!(settings.debugServer || debugDetected);
  if (testServerActive) children.push(testServer);
  children.push(connectionSection());
  var webPage = webPageSection();
  if (webPage) children.push(webPage);

  children.push({
    type: "section",
    title: "Downloads",
    children: [
      { type: "settings-row", label: "Preferred formats",
        description: "Best first, e.g. “flac, mp3”. Empty ranks by quality.",
        control: { type: "text-input", placeholder: "flac, mp3", action: "set-formats", value: settings.preferredFormats } },
      { type: "settings-row", label: "slskd runs on this computer",
        description: "Turn off when slskd runs in Docker or on a NAS.",
        control: { type: "toggle", label: "", action: "set-local",
          checked: detectTier(settings.url, settings.tierOverride) === "local" } },
      { type: "settings-row", label: "Downloads folder",
        description: misconfiguredSlskdDir(downloadsDir, incompleteDir)
          ? downloadsDir + " — " + MISCONFIGURED_DIR_TEXT + "."
          : downloadsDir || "Read from slskd once connected." }
    ]
  });
  if (!testServerActive) children.push(testServer);
  children.push(mutedText("Upgrade and playback-fallback settings are on their own tabs."));
  return { type: "layout", direction: "vertical", children: children };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
// A selection can span several sharers, but an enqueue is addressed to ONE peer
// (slskd queues per user), so group first and send one batch each — sequentially,
// because each batch claims the next destination folder number.
async function downloadCandidates(list, recExtra) {
  var byUser = {};
  var order = [];
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    if (!byUser[c.username]) { byUser[c.username] = []; order.push(c.username); }
    byUser[c.username].push(c);
  }
  for (var u = 0; u < order.length; u++) {
    var files = byUser[order[u]];
    await enqueueFiles(order[u], files, basenameRemote(dirnameRemote(files[0].filename)), recExtra);
  }
}

// `f:` rows come from the Files view, `o:` rows from the open folder — whose
// files may lie past the Files view's cap, so they're looked up there.
function candidateByRef(ref) {
  var raw = String(ref || "");
  var fromFolder = raw.indexOf("o:") === 0;
  if (raw.indexOf("f:") === 0 || fromFolder) raw = raw.slice(2);
  var g = fromFolder ? folderByRef(openFolder) : null;
  var list = g ? g.files : search.results;
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    if (c.username + KEY_SEP + c.filename === raw) return c;
  }
  return null;
}

function folderByRef(ref) {
  var raw = String(ref || "");
  if (raw.indexOf("d:") === 0) raw = raw.slice(2);
  for (var i = 0; i < search.folders.length; i++) {
    if (search.folders[i].key === raw) return search.folders[i];
  }
  return null;
}

// A finished, located transfer as the track the host's download modal expects
// (same field names the yt-dlp plugin hands it). Null when the file isn't ours
// to offer — remote tier, still transferring, or not located yet.
function importTrackFor(key) {
  var rec = tracked[key];
  if (!rec || !rec.resolvedPath || tier !== "local") return null;
  var t = transferByKey(key);
  if (t && transferPhase(t.state) !== "succeeded") return null;
  var meta = rec.meta || {};
  var duration = meta.durationSecs != null ? meta.durationSecs : (rec.length != null ? rec.length : null);
  return {
    title: meta.title || basenameRemote(rec.resolvedPath),
    artist_name: meta.artist || null,
    album_title: meta.album || null,
    uri: SCHEME + "://" + key,
    durationSecs: duration
  };
}

// Copy finished downloads into a collection through the host's own download
// modal (one track → the configure step, several → the batch flow). The modal
// picks the destination, writes tags and cover art, and handles a file that
// already exists — none of which is worth reimplementing here.
function openImport(keys) {
  var tracks = [];
  for (var i = 0; i < keys.length; i++) {
    var tr = importTrackFor(keys[i]);
    if (tr) tracks.push(tr);
  }
  if (!tracks.length) {
    api.ui.showNotification(tier === "local"
      ? "Nothing here has finished downloading yet."
      : "slskd runs on another machine, so its files can't be copied from here. Add its downloads folder as a collection instead.");
    return;
  }
  // `purpose: "import"`: the files are already on this computer, so hosts that
  // know it word the modal as "Add to library" instead of "Download". Older
  // hosts ignore the field and keep saying Download.
  api.ui.requestAction("download-tracks", { providerId: PROVIDER_KEY, providerName: PROVIDER_NAME, tracks: tracks, purpose: "import" });
}

function playTransfer(key) {
  var rec = tracked[key];
  if (!rec || !rec.resolvedPath) return;
  var meta = rec.meta || {};
  var duration = meta.durationSecs != null ? meta.durationSecs : (rec.length != null ? rec.length : null);
  api.playback.playTrack({
    path: SCHEME + "://" + key,
    title: meta.title || basenameRemote(rec.resolvedPath),
    artist_name: meta.artist || null,
    album_title: meta.album || null,
    track_number: meta.trackNumber || null,
    duration_secs: duration,
    kind: "audio"
  });
}

function registerActions() {
  api.ui.onAction("search", function (data) {
    var q = (data && data.query) || "";
    runSearch(q.trim()).catch(function (e) { console.error("slskd search failed:", e); });
  });

  // Cmd+K hands its typed query over through this reserved action. The host
  // only auto-seeds a TOP-LEVEL search-input, and ours sits inside the Search
  // tab, so without this the query would sit unconsumed on the Downloads tab.
  api.ui.onAction(HOST_SEARCH_ACTION, function (data) {
    var q = String((data && data.query) || "").trim();
    if (!q) return;
    runSearch(q).catch(function (e) { console.error("slskd handed-over search failed:", e); });
  });

  api.ui.onAction("main-tab", function (data) {
    var id = data && data.tabId;
    activeTab = mainTabFor(id);
    fixScrollKey = null;
    render();
    schedulePoll(activeTab === "transfers");
  });

  // ---- the Fallback tab ----
  api.ui.onAction("clear-resolve", function () {
    lastResolve = null;
    render();
  });

  api.ui.onAction("open-fallback", function () {
    activeTab = "fallback";
    render();
    api.ui.navigateToView(VIEW_ID);
  });

  api.ui.onAction("play-kept", function (data) {
    var keys = keptKeys(data);
    for (var i = 0; i < keys.length; i++) {
      var e = fallback[keys[i]];
      if (e && e.state === "kept") { playTransfer(e.ref); return; }
    }
  });

  api.ui.onAction("import-kept", function (data) {
    var refs = [];
    var keys = keptKeys(data);
    for (var i = 0; i < keys.length; i++) {
      var e = fallback[keys[i]];
      if (e && e.state === "kept") refs.push(e.ref);
    }
    openImport(refs);
  });

  api.ui.onAction("delete-kept", function (data) {
    var keys = keptKeys(data).filter(function (k) { return !!fallback[k]; });
    if (!keys.length) return;
    deleteFallbackFiles(keys).catch(function (e) { console.error("slskd: deleting fallback files failed:", e); });
  });

  api.ui.onAction("delete-all-kept-ask", function () {
    keptConfirm = true;
    render();
  });

  api.ui.onAction("delete-all-kept-cancel", function () {
    keptConfirm = false;
    render();
  });

  api.ui.onAction("fallback-trace-toggle", function () {
    showResolveTrace = !showResolveTrace;
    render();
  });

  api.ui.onAction("clear-resolve-history", function () {
    resolveHistory = [];
    api.storage.set(stateKey("resolveHistory"), resolveHistory).catch(function (e) { console.error("slskd: couldn't clear the fallback history:", e); });
    render();
  });

  // A song the fallback couldn't play, handed to the Search tab: the user can
  // look through everything found, not just what the resolver would accept.
  api.ui.onAction("fallback-search", function (data) {
    var id = rowIds(data)[0] || "";
    var e = resolveHistory.filter(function (x) { return historyRowId(x) === id; })[0];
    if (!e) return;   // merged or cleared since it was drawn; the next render shows what's there
    var q = searchQueryForTarget({ kind: "track", title: e.title, artistName: e.artist });
    if (!q) return;
    runSearch(q).catch(function (err) { console.error("slskd: searching for a missed fallback track failed:", err); });
  });

  api.ui.onAction("delete-all-kept", function () {
    keptConfirm = false;
    var keys = Object.keys(fallback);
    if (!keys.length) return;
    deleteFallbackFiles(keys).catch(function (e) { console.error("slskd: deleting fallback files failed:", e); });
  });

  api.ui.onAction("recent-search", function (data) {
    var q = String((data && data.query) || "").trim();
    if (!q) return;
    runSearch(q).catch(function (e) { console.error("slskd: recent search failed:", e); });
  });

  api.ui.onAction("recent-search-clear", function () {
    recentSearches = [];
    api.storage.set("recentSearches", recentSearches).catch(function (e) { console.error("slskd: couldn't clear recent searches:", e); });
    render();
  });

  api.ui.onAction("result-mode", function (data) {
    activeTab = (data && data.tabId) === "folders" ? "folders" : "search";
    openFolder = null;
    render();
  });

  api.ui.onAction("sort-results", function (data) {
    var col = data && data.column;
    if (!RESULT_SORTS[col]) return;
    search.sortColumn = col;
    search.sortDir = (data && data.direction) === "asc" ? "asc" : "desc";
    render();
  });

  api.ui.onAction("sort-folders", function (data) {
    var col = data && data.column;
    if (!FOLDER_SORTS[col]) return;
    search.folderSortColumn = col;
    search.folderSortDir = (data && data.direction) === "asc" ? "asc" : "desc";
    render();
  });

  // Back to the ranked order — of whichever list the toolbar sits over.
  api.ui.onAction("sort-best", function () {
    if (activeTab === "folders") {
      search.folderSortColumn = null;
      search.folderSortDir = "desc";
    } else {
      search.sortColumn = null;
      search.sortDir = "desc";
    }
    render();
  });

  // One row (its hover button, or a click on the name) or a whole selection —
  // the selection toolbar sends `selectedIds` and no `itemId`, a row sends both.
  api.ui.onAction("download-file", function (data) {
    var refs = (data && data.selectedIds && data.selectedIds.length)
      ? data.selectedIds
      : [data && data.itemId];
    var picked = [];
    for (var i = 0; i < refs.length; i++) {
      var c = candidateByRef(refs[i]);
      if (c) picked.push(c);
    }
    // A selection can hold rows already on their way; only the rest go.
    picked = notYetQueued(picked);
    if (!picked.length) return;
    downloadCandidates(picked, modeRecExtra())
      .catch(function (e) { console.error("slskd enqueue failed:", e); });
  });

  // A folder row's name opens the folder (see folderView); nothing is queued
  // yet. Hosts before single-select lists draw the row actions in a bulk
  // toolbar, which sends `selectedIds` and no `itemId` — the first one opens.
  api.ui.onAction("open-folder", function (data) {
    var g = folderByRef((data && data.itemId) || (data && data.selectedIds && data.selectedIds[0]));
    if (!g) return;
    openFolder = g.key;
    activeTab = "folders";
    render();
    if (!(search.mode && search.mode.kind === "fill")) {
      checkFolderOwned(g).catch(function (e) { console.error("slskd: checking a folder against the library failed:", e); });
    }
  });

  api.ui.onAction("close-folder", function () {
    openFolder = null;
    render();
  });

  // A folder row's hover button: the folder without opening it — in Fill the
  // files the album lacks, otherwise all of them (folderRowFiles). An older
  // host's bulk toolbar sends a selection instead; each selected folder goes.
  api.ui.onAction("folder-row-download", function (data) {
    var refs = (data && data.selectedIds && data.selectedIds.length) ? data.selectedIds : [data && data.itemId];
    refs.forEach(function (ref) {
      var g = folderByRef(ref);
      if (!g) return;
      var files = folderRowFiles(g);
      if (!files.length) return;
      enqueueFiles(g.username, files, g.name, modeRecExtra())
        .catch(function (e) { console.error("slskd folder enqueue failed:", e); });
    });
  });

  // The open folder's button: everything not yet queued, or — `which:
  // "missing"` — only the songs the library lacks (in Fill, the album's).
  api.ui.onAction("folder-download", function (data) {
    var g = folderByRef(openFolder);
    if (!g) return;
    var owned = ownedInFolder(g, search.mode, folderOwned[g.key]);
    var files = g.files;
    if (data && data.which === "missing") files = files.filter(function (c) { return !owned[c.filename]; });
    files = notYetQueued(files);
    if (!files.length) return;
    enqueueFiles(g.username, files, g.name, modeRecExtra())
      .catch(function (e) { console.error("slskd folder enqueue failed:", e); });
  });

  // ---- the Upgrades tab ----
  api.ui.onAction("open-upgrades", function () {
    activeTab = "upgrades";
    render();
    api.ui.navigateToView(VIEW_ID);
    schedulePoll(true);
  });

  api.ui.onAction("upgrade-replace-notice", function () {
    if (lastReadyUpgrade) openUpgradeReplace(lastReadyUpgrade);
  });

  api.ui.onAction("upgrade-replace", function (data) {
    var ids = rowIds(data);
    if (ids.length > 1 && canReplaceInPlace()) {
      replaceAllReady(ids).catch(function (e) { console.error("slskd: replacing the selected upgrades failed:", e); });
    } else if (ids.length) {
      openUpgradeReplace(ids[0]);
    }
  });

  api.ui.onAction("upgrade-replace-all", function () {
    replaceAllReady(readyUpgradeKeys()).catch(function (e) { console.error("slskd: replacing the ready upgrades failed:", e); });
  });

  api.ui.onAction("upgrade-replace-stop", function () {
    if (replaceWalk) replaceWalk.stop = true;
    render();
  });

  api.ui.onAction("upgrade-take-alternative", function (data) {
    var ids = rowIds(data);
    for (var i = 0; i < ids.length; i++) {
      takeUpgradeAlternative(ids[i]).catch(function (e) { console.error("slskd: taking the upgrade alternative failed:", e); });
    }
  });

  // The interactive search the context menu used to open: the same filter,
  // the user picks the file.
  api.ui.onAction("upgrade-choose", function (data) {
    var e = upgrades[rowIds(data)[0]];
    if (!e) return;
    startUpgrade({ kind: "track", trackId: e.trackId, title: e.title, artistName: e.artist })
      .catch(function (err) { console.error("slskd upgrade search failed:", err); });
  });

  api.ui.onAction("upgrade-sources-toggle", function (data) {
    var key = rowIds(data)[0];
    if (!upgrades[key]) return;
    sourcesOpen[key] = !sourcesOpen[key];
    focusedUpgrade = key;
    render();
  });

  api.ui.onAction("upgrade-retry", function (data) {
    var ids = rowIds(data);
    for (var i = 0; i < ids.length; i++) {
      retryUpgrade(ids[i]).catch(function (e) { console.error("slskd: retrying the upgrade failed:", e); });
    }
  });

  api.ui.onAction("upgrade-show", function (data) {
    var id = rowIds(data)[0];
    if (!upgrades[id]) return;
    focusedUpgrade = id;
    render();
  });

  api.ui.onAction("upgrade-cancel", function (data) {
    var ids = rowIds(data);
    for (var i = 0; i < ids.length; i++) {
      cancelUpgrade(ids[i]).catch(function (e) { console.error("slskd: cancelling the upgrade failed:", e); });
    }
  });

  api.ui.onAction("upgrade-skip", function (data) {
    var id = rowIds(data)[0];
    if (!id) return;
    focusedUpgrade = id;
    skipUpgradeSource(id).catch(function (e) { console.error("slskd: trying another sharer failed:", e); });
  });

  api.ui.onAction("upgrade-use-source", function (data) {
    var ref = parseSourceId(rowIds(data)[0]);
    if (!ref) return;
    useUpgradeSource(ref.key, ref.index).catch(function (e) { console.error("slskd: switching the upgrade's source failed:", e); });
  });

  api.ui.onAction("upgrade-history-toggle", function () {
    showUpgradeHistory = !showUpgradeHistory;
    render();
  });

  api.ui.onAction("upgrade-history-clear", function () {
    clearUpgradeHistory().catch(function (e) { console.error("slskd: clearing the upgrade history failed:", e); });
  });

  api.ui.onAction("upgrade-remove", function (data) {
    var ids = rowIds(data);
    for (var i = 0; i < ids.length; i++) {
      removeUpgrade(ids[i]).catch(function (e) { console.error("slskd: removing the upgrade failed:", e); });
    }
  });

  api.ui.onAction("set-upgrade-target", function (data) {
    saveSetting("upgradeTarget", upgradeTargetOf(data && data.value));
  });

  api.ui.onAction("mode-show-all", function () {
    if (!search.mode) return;
    search.mode.showAll = !search.mode.showAll;
    render();
  });

  api.ui.onAction("replace-transfer", function (data) {
    // Only finished, located files (openReplace finds the library copy by name
    // when there's no upgrade stamp): a selection on the search list can hold
    // anything else too.
    var keys = transferKeys(data).filter(function (k) {
      var t = transferByKey(k);
      return !!(tracked[k] && importTrackFor(k) && (!t || transferPhase(t.state) === "succeeded"));
    });
    for (var i = 0; i < keys.length; i++) {
      openReplace(keys[i]).catch(function (e) { console.error("slskd: replace in library failed:", e); });
    }
  });

  // A selection plays as ONE queue, in list order; a single row just plays.
  api.ui.onAction("play-transfer", function (data) {
    var keys = transferKeys(data).filter(function (k) { return !!importTrackFor(k); });
    if (!keys.length) return;
    if (keys.length === 1) { playTransfer(keys[0]); return; }
    var tracks = [];
    for (var i = 0; i < keys.length; i++) {
      var rec = tracked[keys[i]];
      var meta = (rec && rec.meta) || {};
      tracks.push({
        path: SCHEME + "://" + keys[i],
        title: meta.title || basenameRemote(rec.resolvedPath),
        artist_name: meta.artist || null,
        album_title: meta.album || null,
        track_number: meta.trackNumber || null,
        duration_secs: meta.durationSecs != null ? meta.durationSecs : (rec.length != null ? rec.length : null),
        kind: "audio"
      });
    }
    api.playback.playTracks(tracks, 0, { name: "Soulseek downloads", source: "playlist" });
  });

  // One row, a selection, or the Finished group's "Add all" — from Downloads
  // (plain keys) or a search list (`f:` / `o:` ids, which transferKeys strips).
  // openImport skips whatever hasn't finished, so a mixed selection is fine.
  api.ui.onAction("import-transfer", function (data) {
    openImport(transferKeys(data));
  });

  // Re-queue with the same user. slskd retries a failed transfer on its own
  // schedule (attempts / nextAttemptAt); this is for after it has given up, or
  // for one the user cancelled.
  api.ui.onAction("retry-transfer", function (data) {
    // Only what has stopped: a selection on the search list can also hold
    // files still on their way (slskd would refuse each, one toast apiece),
    // finished ones, and plain results nobody asked to download.
    var keys = transferKeys(data).filter(retryableKey);
    var chain = Promise.resolve();
    keys.forEach(function (key) {
      var parts = splitKey(key);
      if (!parts) return;
      var t = transferByKey(key);
      var rec = tracked[key];
      var size = (t && t.size) || (rec && rec.size) || 0;
      // The re-queue writes a fresh record; carry over what the first one was
      // for, or a retried upgrade can no longer be replaced into the library.
      // `meta` goes back through mergeMeta, which reads tag-shaped keys.
      var m = rec && rec.meta;
      var extra = rec && (rec.upgrade || m) ? {
        upgrade: rec.upgrade || null,
        meta: m ? { title: m.title, artist: m.artist, album: m.album, album_artist: m.albumArtist, track_number: m.trackNumber,
          year: m.year, genre: m.genre, duration_secs: m.durationSecs } : null
      } : null;
      chain = chain.then(function () {
        return enqueueFiles(parts.username, [{ filename: parts.filename, size: size }], basenameRemote(dirnameRemote(parts.filename)), extra);
      });
    });
    chain.catch(function (e) { console.error("slskd retry failed:", e); });
  });

  // Search again for the same song, rejecting anything whose duration is off
  // from the copy that failed — the same knownDurationSecs guard the context
  // menu uses, so a mislabeled file can't be the "other source".
  api.ui.onAction("another-source", function (data) {
    var key = rowIds(data)[0];
    var parts = splitKey(key);
    var filename = parts ? parts.filename : String(key || "");
    var rec = tracked[key];
    var meta = (rec && rec.meta) || parseTrackMeta(filename);
    var known = meta.durationSecs != null ? meta.durationSecs : (rec && rec.length != null ? rec.length : null);
    runSearch([meta.artist, meta.title].filter(Boolean).join(" ") || basenameRemote(filename),
      known != null ? { knownDurationSecs: known } : null)
      .catch(function (e) { console.error("slskd re-search failed:", e); });
  });

  api.ui.onAction("cancel-transfer", function (data) {
    var keys = transferKeys(data);
    var chain = Promise.resolve();
    keys.forEach(function (key) {
      var t = transferByKey(key);
      // In flight only: cancelling a finished or failed transfer is a request
      // slskd answers with an error, for a row a selection merely swept in.
      if (!t || !cancellablePhase(transferPhase(t.state))) return;
      chain = chain.then(function () { return cancelTransfer(t, false); });
    });
    chain
      .then(function () { schedulePoll(true); })
      .catch(function (e) {
        console.error("slskd cancel failed:", e);
        api.ui.showNotification((e && e.message) || "Couldn't cancel that download.");
      });
  });

  // Drops the row from slskd's list. The file on disk is untouched — this is a
  // list, not a trash can, and slskd's own remote_file_management gate exists
  // precisely so an API caller can't delete downloads by default.
  api.ui.onAction("finished-toggle", function () {
    showAllFinished = !showAllFinished;
    render();
  });

  api.ui.onAction("remove-transfer", function (data) {
    var keys = rowIds(data);
    var chain = Promise.resolve();
    keys.forEach(function (key) {
      var t = transferByKey(key);
      if (!t) return;
      chain = chain.then(function () { return cancelTransfer(t, true); });
    });
    chain
      .then(function () { render(); schedulePoll(true); })
      .catch(function (e) {
        console.error("slskd remove failed:", e);
        api.ui.showNotification((e && e.message) || "Couldn't remove that download.");
      });
  });

  api.ui.onAction("open-slskd-site", function () {
    api.network.openUrl("https://slskd.com/").catch(console.error);
  });

  // Setup. Nothing here touches the user's machine: it opens the guide page
  // with the key in the fragment, mints a new key, or connects.
  // Collections are otherwise loaded only once slskd is ready — which during
  // setup it is not — so these fetch them first for the shared-folder picker.
  api.ui.onAction("setup-open-about", async function () {
    ensureSetupKey();
    await loadCollections();
    api.network.openUrl(whatIsThisUrl(settings.apiKey, localCollections)).catch(console.error);
  });
  api.ui.onAction("setup-open-guide", async function () {
    ensureSetupKey();
    await loadCollections();
    api.network.openUrl(setupGuideUrl(settings.apiKey, localCollections)).catch(console.error);
  });
  api.ui.onAction("setup-page", function (data) {
    var page = data && data.page;
    setupPage = SETUP_PAGES.indexOf(page) >= 0 ? page : "home";
    // The install page needs the tool's status (can Viboplr install it?), the
    // collections (what it offers to share; otherwise loaded only once slskd
    // is ready) and the default downloads folder.
    if (setupPage === "install-auto") {
      managed.error = null;
      Promise.all([
        probeManaged().catch(function (e) { console.error("slskd: install check failed:", e); }),
        loadCollections().catch(function (e) { console.error("slskd: loading collections failed:", e); }),
        prefillDownloadsDir()
      ]).then(render);
    }
    render();
  });
  api.ui.onAction("setup-connect", function () {
    if (!settings.url) settings.url = SETUP_DEFAULT_URL;
    saveSetting("url", settings.url);
  });

  api.ui.onAction("open-slskd", function () {
    if (settings.url) api.network.openUrl(settings.url).catch(console.error);
  });
  api.ui.onAction("slskd-show-login", function () { revealWebLogin(); });
  api.ui.onAction("slskd-hide-login", function () {
    webLogin = null;
    rerenderWebLogin();
  });
  // The login fields are there to be selected and copied; what's typed into
  // them goes nowhere.
  api.ui.onAction("slskd-login-field", function () {});

  // Installing slskd here. Every one of these is a click; Viboplr then asks
  // the user before anything is installed.
  api.ui.onAction("install", function () {
    installSlskd().catch(function (e) { console.error("slskd: install failed:", e); });
  });
  api.ui.onAction("install-pick-folder", async function () {
    try {
      var picked = await api.ui.pickFolder({ title: "Where should slskd put finished downloads?", defaultPath: installForm.downloadsDir || undefined });
      if (picked) {
        installForm.downloadsDir = picked;
        render();
      }
    } catch (e) {
      console.error("slskd: choosing a folder failed:", e);
    }
  });
  api.ui.onAction("install-retry", function () {
    var s = managed.setup;
    if (!s || !s.failed) return;
    continueSetup(s, s.failed.step).catch(function (e) { console.error("slskd: setup retry failed:", e); });
  });
  api.ui.onAction("install-close", function () {
    managed.setup = null;
    render();
  });
  api.ui.onAction("install-set-share", function (data) {
    installForm.shareCollections = !!(data && data.value);
    render();
  });
  api.ui.onAction("install-set-autostart", function (data) {
    installForm.autostart = !!(data && data.value);
    render();
  });
  api.ui.onAction("managed-start", function () {
    startManaged().catch(function (e) { console.error("slskd: start failed:", e); });
  });
  api.ui.onAction("managed-restart", function () {
    restartManaged().catch(function (e) { console.error("slskd: restart failed:", e); });
  });
  api.ui.onAction("managed-move", function () {
    moveManaged().catch(function (e) { console.error("slskd: moving to Viboplr's copy failed:", e); });
  });
  api.ui.onAction("managed-autostart", function (data) {
    setStartWithViboplr(!!(data && data.value)).then(function () {
      render();
      renderSettings();
    }).catch(function (e) { console.error("slskd: start-with-Viboplr change failed:", e); });
  });
  // Saved at once, not through saveSetting's debounce: it is read at the next
  // start, which may be a click away.
  api.ui.onAction("managed-set-keep-running", function (data) {
    settings.stopWithViboplr = !(data && data.value);
    api.storage.set("stopWithViboplr", settings.stopWithViboplr).catch(function (e) { console.error("slskd: couldn't save stopWithViboplr:", e); });
    render();
    renderSettings();
  });
  // The not-ready banner's "Fix…": the explanation is on top of Settings.
  api.ui.onAction("slskd-show-fix", function () {
    activeTab = "settings";
    // A fresh scroll key opens Settings at the top, where the explanation
    // is; the plain "settings" key would restore wherever it was left.
    fixScrollKey = "settings:fix:" + (++fixSeq);
    render();
    schedulePoll(false);
  });
  api.ui.onAction("share-collections", function () {
    shareCollections().catch(function (e) { console.error("slskd: sharing collections failed:", e); });
  });
  api.ui.onAction("share-confirm", function () {
    var gap = (shareChange && shareChange.confirm) || [];
    if (!gap.length) return;
    shareThroughSlskd(gap).catch(function (e) { console.error("slskd: sharing through slskd failed:", e); });
  });
  api.ui.onAction("share-cancel", function () {
    shareChange = { error: null };
    render();
  });
  api.ui.onAction("discover-again", function () {
    discoverSlskd().catch(function (e) { console.error("slskd: looking for slskd failed:", e); });
  });
  api.ui.onAction("discover-set-key", function (data) {
    discovery.keyInput = String((data && data.value) || "");
    discovery.error = null;
    render();
  });
  api.ui.onAction("discover-connect", function () {
    connectDiscovered().catch(function (e) { console.error("slskd: connecting to the slskd found failed:", e); });
  });
  api.ui.onAction("discover-open", function () {
    if (discovery.found) api.network.openUrl(discovery.found.url).catch(console.error);
  });
  api.ui.onAction("managed-files-toggle", function () {
    managedShowFiles = !managedShowFiles;
    (managedShowFiles ? loadManagedPlaces() : Promise.resolve()).then(render)
      .catch(function (e) { console.error("slskd: locating slskd's files failed:", e); });
  });
  api.ui.onAction("managed-details-toggle", function () {
    managedShowDetails = !managedShowDetails;
    render();
  });
  api.ui.onAction("managed-open-path", function (data) {
    if (!data || !data.path || !canOpenPaths()) return;
    openManagedPath(String(data.path), !!data.reveal).catch(function (e) { console.error("slskd: open path failed:", e); });
  });
  api.ui.onAction("managed-remove-ask", function () {
    managedRemove = { asking: true, error: null };
    render();
  });
  api.ui.onAction("managed-remove-cancel", function () {
    managedRemove.asking = false;
    render();
  });
  api.ui.onAction("managed-remove", function () {
    removeManaged().catch(function (e) { console.error("slskd: removing slskd failed:", e); });
  });
  // Every keystroke arrives; the view re-renders only when the Install
  // button's enabled state flips.
  function setField(key, value) {
    var was = installFormComplete(installForm);
    installForm[key] = value || "";
    saveAccount();
    if (installFormComplete(installForm) !== was) render();
  }
  api.ui.onAction("install-set-user", function (data) { setField("username", data && data.value); });
  api.ui.onAction("install-set-user:submit", function (data) { setField("username", data && data.value); });
  api.ui.onAction("install-set-pass", function (data) { setField("password", data && data.value); });
  api.ui.onAction("install-set-pass:submit", function (data) {
    setField("password", data && data.value);
    installSlskd().catch(function (e) { console.error("slskd: install failed:", e); });
  });

  api.ui.onAction("test-connection", function () {
    return checkConnection();
  });

  // A typed address or key is the user's own: the plugin stops treating the
  // connection as the slskd it installed, so nothing overwrites what they typed.
  function userSetsConnection(key, value) {
    webLogin = null;
    if (settings.managedBy && value !== settings[key]) {
      settings.managedBy = null;
      api.storage.set("managedBy", null).catch(function (e) { console.error("slskd: couldn't save managedBy:", e); });
    }
    saveSetting(key, value);
  }
  api.ui.onAction("set-url", function (data) { userSetsConnection("url", (data && data.value) || ""); });
  api.ui.onAction("set-url:submit", function (data) { userSetsConnection("url", (data && data.value) || ""); });
  api.ui.onAction("set-key", function (data) { userSetsConnection("apiKey", (data && data.value) || ""); });
  api.ui.onAction("set-key:submit", function (data) { userSetsConnection("apiKey", (data && data.value) || ""); });
  api.ui.onAction("set-formats", function (data) { saveSetting("preferredFormats", (data && data.value) || ""); });
  api.ui.onAction("set-fallback-max-gb", function (data) {
    var v = Number(data && data.value);
    saveSetting("fallbackMaxGb", FALLBACK_MAX_GB_OPTIONS.indexOf(v) >= 0 ? v : 0);
    enforceFallbackLimits(true).catch(function (e) { console.error("slskd: fallback cleanup failed:", e); });
  });

  api.ui.onAction("set-fallback-max-age", function (data) {
    var v = Number(data && data.value);
    saveSetting("fallbackMaxAgeDays", FALLBACK_MAX_AGE_DAY_OPTIONS.indexOf(v) >= 0 ? v : 0);
    enforceFallbackLimits(true).catch(function (e) { console.error("slskd: fallback cleanup failed:", e); });
  });

  api.ui.onAction("set-fallback-quality", function (data) {
    var v = data && data.value;
    if (!FALLBACK_MODES[v]) return;
    saveSetting("fallbackQuality", v);
  });
  api.ui.onAction("reset-sharers", function () {
    sharers = {};
    api.storage.set(stateKey("sharers"), sharers).catch(function (e) { console.error("slskd: couldn't reset the sharer ledger:", e); });
    render();
    renderSettings();
  });
  api.ui.onAction("set-insecure", function (data) { saveSetting("insecure", !!(data && data.value)); });
  api.ui.onAction("set-debug-server", function (data) {
    switchServer(!!(data && data.value)).catch(function (e) { console.error("slskd: switching server failed:", e); });
  });
  api.ui.onAction("detect-test-server", function () {
    return detectDebugServer()
      .then(function () { debugLookedAt = Date.now(); renderSettings(); })
      .catch(function (e) { console.error("slskd: test server check failed:", e); });
  });
  api.ui.onAction("test-server-docs", function () {
    api.network.openUrl(FAKE_SLSKD_DOCS).catch(console.error);
  });
  api.ui.onAction("set-debug-url", function (data) {
    var v = data && typeof data.value === "string" ? data.value.trim() : "";
    settings.debugUrl = v || "http://127.0.0.1:5039";
    api.storage.set("debugUrl", settings.debugUrl).catch(function (e) { console.error("slskd: couldn't save debugUrl:", e); });
    debugDetected = null;
    if (settings.debugServer) {
      downloadsDir = null;
      incompleteDir = null;
      refreshReadiness().catch(function (e) { console.error("slskd probe failed:", e); });
    } else {
      detectDebugServer().then(renderSettings).catch(function (e) { console.error("slskd: test server check failed:", e); });
    }
  });
  api.ui.onAction("set-local", function (data) {
    saveSetting("tierOverride", (data && data.value) ? "local" : "remote");
  });

  api.contextMenu.onAction("slskd-search", function (target) {
    var q = searchQueryForTarget(target);
    if (!q) return;
    api.ui.navigateToView(VIEW_ID);
    // When the host hands over the track's length, a Soulseek result more than a
    // few seconds off it is a different recording or a mislabeled file. Absent
    // on current hosts (the target carries ids and names only) — then no filter.
    var known = target && target.kind === "track" && target.durationSecs != null ? target.durationSecs : null;
    var extra = known != null ? { knownDurationSecs: known } : null;
    // An album is shared as a folder, so that search opens on Folders.
    if (target && target.kind === "album") extra = { folders: true };
    runSearch(q, extra)
      .catch(function (e) { console.error("slskd context search failed:", e); });
  });

  api.contextMenu.onAction("slskd-upgrade", function (target) {
    if (target && target.kind === "multi-track") {
      return queueUpgrades(target.trackIds || []).catch(function (e) { console.error("slskd batch upgrade failed:", e); });
    }
    return queueUpgrade(target).catch(function (e) { console.error("slskd upgrade failed:", e); });
  });

  api.contextMenu.onAction("slskd-fill-album", function (target) {
    startFill(target).catch(function (e) { console.error("slskd fill-album failed:", e); });
  });
}

// ---------------------------------------------------------------------------
// Automatic upgrades (the Upgrades tab)
// ---------------------------------------------------------------------------
// "Upgrade" on a library track runs the fallback's machinery with the goal
// turned around: nobody is listening, so quality leads and the clock is
// minutes, not seconds. One bounded search; the files that are this recording
// (`rankFallback`'s word match + the duration filter), strictly better than the
// copy in hand (`isUpgradeOver`) and at the user's Upgrade target; the best one
// is downloaded, and a sharer that sends nothing for `UPGRADE_STALL_MS` makes
// way for the next. The finished file is then CHECKED — its real size over its
// real duration, the same estimate `libraryQuality` makes for the library copy —
// before the user is asked anything, so a "320" that is really 128 never
// reaches the compare dialog.
//
// The pick is automatic; the REPLACE never is. It goes through the host's
// compare dialog (`openReplace`), so a wrong pick costs a download, never a
// library file. That is the line the "no metadata download provider" rule is
// really drawing, and why this is not one.
//
// Long-lived by design — a stranger's queue can be hours — so an upgrade is a
// persisted record the transfer poll advances (`advanceUpgrades`), not an async
// loop holding a promise open across a restart.
//
// `upgrades`: "t<trackId>" → {
//   trackId, title, artist, album, trackNumber, durationSecs, path,
//   current,        libraryQuality(row) — the copy in hand
//   target,         a UPGRADE_TARGETS key — the setting when it started
//   state,          "searching" | "downloading" | "checking" | "ready" |
//                   "alternative" | "none" | "failed" | "replaced" |
//                   "gone" (the library row no longer exists)
//   message,        the one line the row shows for a resting state
//   candidates,     lean copies of the ranked picks, best first
//   alternative,    the best better copy that misses the target (state "alternative")
//   triedUsers,     usernames already asked — each sharer gets one chance
//   active,         { key, username, filename, size, startedAt, movedAt, lastBytes, unseen }
//   file,           { key, path, quality } once a download passed the check
//   replaceRequested, createdAt, updatedAt
// }
var upgrades = {};
var upgradeSearchRunning = false;
var upgradeAdvancing = false;  // the poll and a click can both advance; one at a time
var lastReadyUpgrade = null;   // which entry the "ready" toast's button opens
var focusedUpgrade = null;     // the entry the Upgrades tab's panel describes (last one started here)

// In the Settings select's order, best-sounding first. Every target except
// "best" is a FILTER (see `meetsQualityTarget`): it waits for the right file
// rather than taking the next best, and the Upgrades tab offers the best better
// copy it ruled out ("Take the best found").
var UPGRADE_TARGETS = {
  flac16: "FLAC 16-bit (CD quality)",
  hires: "Hi-res lossless (24-bit)",
  lossless: "Any lossless",
  mp3_320: "MP3 320",
  high: "MP3 320 / V0",
  lossy256: "256 kbps or better",
  best: "Best available"
};
var UPGRADE_TARGET_DEFAULT = "flac16";

var UPGRADE_TARGET_HELP = {
  flac16: "FLAC at CD quality: 16-bit, 44.1 or 48 kHz. Hi-res files, several times the size, are skipped. A FLAC whose sharer reports no bit depth counts as CD quality, as nearly all are.",
  hires: "Only lossless files the sharer reports as hi-res: 24-bit, or above 48 kHz. Rare on Soulseek, and large. A copy without those figures is skipped.",
  lossless: "Any lossless file (FLAC, ALAC, WAV…), the most bits first and FLAC before other formats.",
  mp3_320: "Only MP3 at 320 kbps, the format every player and device reads.",
  high: "High-bitrate lossy, MP3 320 or V0 first: a better copy at a fraction of lossless's size. Lossless files are skipped.",
  lossy256: "Any lossy file at 256 kbps or more (MP3, AAC, Opus, Ogg; V0 counts). Lossless files are skipped.",
  best: "Lossless when someone has it, otherwise the best lossy file that beats your copy."
};

function upgradeTargetOf(value) {
  return UPGRADE_TARGETS[value] ? value : UPGRADE_TARGET_DEFAULT;
}

// Lossy thresholds sit a little under the nominal rate: the post-download check
// measures a file as size ÷ duration (`measuredQuality`), and a real 320 lands
// a few percent either side of 320 once tags and a rounded duration are in the
// sum. V0 averages ~245, so 300 still tells a 320 from it.
var MP3_320_MIN_KBPS = 300;
var LOSSY_256_MIN_KBPS = 240;

function isHiRes(c) {
  return (c.bitDepth || 0) >= 24 || (c.sampleRate || 0) > 48000;
}

// Pure: does a file reach the target? A filter, not a preference: the
// size-conscious targets (flac16 and the lossy ones) do NOT accept something
// "better", because better is exactly the size the user said no to. Also
// serves the fallback's "lossless" / "high" modes (`rankFallback`); its other
// modes, and an unknown value, take anything.
function meetsQualityTarget(c, target) {
  if (!c) return false;
  var lossless = c.qualityTier === T_LOSSLESS;
  var ext = String(c.extension || "").toLowerCase();
  var rate = c.bitRate || 0;
  if (target === "flac16") return lossless && ext === "flac" && !isHiRes(c);
  if (target === "hires") return lossless && isHiRes(c);
  if (target === "lossless") return lossless;
  if (target === "mp3_320") return ext === "mp3" && !lossless && rate >= MP3_320_MIN_KBPS;
  if (target === "high") return c.qualityTier === T_HIGH;
  if (target === "lossy256") return !lossless && rate >= LOSSY_256_MIN_KBPS;
  return true;
}

// Pure: how good a file is, as a sort key (lower first). Tier, then the figure
// inside the tier: more bits / a higher sample rate for lossless, a higher rate
// for lossy. The format an option names leads its tier — MP3 under "high",
// FLAC under "lossless" — since a target is only ever that format's figures.
function upgradeQualityKey(c, target) {
  var t = upgradeTargetOf(target);
  var inner = c.qualityTier === T_LOSSLESS
    ? -((c.bitDepth || 16) * 1000 + Math.round((c.sampleRate || 44100) / 1000))
    : -(c.bitRate || 0);
  var fmt = 0;
  if (t === "high" && c.extension !== "mp3") fmt = 1;
  if (t === "lossless" && c.extension !== "flac") fmt = 1;
  return [c.qualityTier, fmt, inner];
}

function compareKeys(a, b) {
  for (var i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// Pure: ranked search results → what this upgrade can use. `picks` are the
// same recording, better than `current` and at the target, best first:
// match (tenth-of-a-point buckets, as the fallback), then quality, then who is
// likely to deliver — a proven sharer, then a free slot, speed, queue.
// `alternative` is the best better copy that misses the target, so "no FLAC
// out there" can still offer the 320 that is. `better` counts both.
function rankUpgrade(ranked, entry) {
  var target = upgradeTargetOf(entry.target);
  var matches = rankFallback(ranked, entry.title, entry.artist, null, "best", ranked.byAlbum ? entry.album : null);
  // A variant word the title doesn't ask for (live, remix, cover…) is marked
  // down in the fallback, which only has to play something close. An upgrade
  // REPLACES the library copy, so a different recording is out entirely — and
  // so is a different MIX of it (see `upgradeSource`).
  var better = matches.filter(function (c) {
    if (c.match.penalty || !isUpgradeOver(c, entry.current)) return false;
    c.source = upgradeSource(c, entry);
    return !c.source.excluded;
  });
  var sorter = function (a, b) {
    // The library copy's own album first: a compilation, a vinyl rip or a
    // folder that names no album is the same song from a different master.
    if (a.source.tier !== b.source.tier) return a.source.tier - b.source.tier;
    var sa = Math.round(a.match.score * 10), sb = Math.round(b.match.score * 10);
    if (sa !== sb) return sb - sa;
    var q = compareKeys(upgradeQualityKey(a, target), upgradeQualityKey(b, target));
    if (q) return q;
    if (a.sharerTier !== b.sharerTier) return a.sharerTier - b.sharerTier;
    if (a.availabilityTier !== b.availabilityTier) return a.availabilityTier - b.availabilityTier;
    if (a.uploadSpeed !== b.uploadSpeed) return b.uploadSpeed - a.uploadSpeed;
    if (a.queueLength !== b.queueLength) return a.queueLength - b.queueLength;
    return a.filename < b.filename ? -1 : (a.filename > b.filename ? 1 : 0);
  };
  var picks = better.filter(function (c) { return meetsQualityTarget(c, target); }).sort(sorter);
  var rest = better.filter(function (c) { return !meetsQualityTarget(c, target); }).sort(sorter);
  return { picks: picks, alternative: rest[0] || null, matched: matches.length, better: better.length };
}

// Folder words that say a file is a different recording or a different mix of
// the song — never an upgrade, unless the library copy's own album says the
// same (an album called "Live at Leeds" is allowed its live files).
var UPGRADE_OTHER_RECORDING_WORDS = ["live", "concert", "unplugged", "bbc", "bootleg", "sessions", "session",
  "rehearsal", "rehearsals", "demo", "demos", "tribute", "karaoke", "acoustic", "instrumental"];
var UPGRADE_MULTICHANNEL_WORDS = ["atmos", "surround", "multichannel", "quad", "quadraphonic", "dvda", "dts", "6ch", "5ch", "8ch"];
// Folder words that say the same recording came from somewhere other than the
// album: ranked after the album's own copies, not excluded.
var UPGRADE_COMPILATION_WORDS = ["greatest", "hits", "best", "collection", "anthology", "essential", "essentials",
  "ultimate", "definitive", "gold", "compilation", "various", "va", "nuggets", "sampler", "soundtrack",
  "sixties", "seventies", "eighties", "nineties", "1001"];
var UPGRADE_VINYL_WORDS = ["vinyl", "lp", "needledrop", "needle"];

// Pure: what the folder a candidate sits in says about it, against the
// library copy. `excluded` (with `why`) for another recording or a multichannel
// mix; otherwise `tier` — 0 the album's own folder, 1 a folder that doesn't
// name it (or no album to compare), 2 a compilation or vinyl rip.
//
// Multichannel is also caught by size: a FLAC bigger than stereo PCM at its own
// rate and depth could ever need is carrying more than two channels (a 5.1
// Blu-ray rip at 16/48 runs ~2,500 kbps against stereo's 1,536 ceiling), and
// "5.1" survives no tokenizer as a word.
function upgradeSource(c, entry) {
  var path = String(c.filename || "").replace(/\\/g, " ");
  var folderWords = wordList(dirnameRemote(c.filename).replace(/\\/g, " "), null);
  var own = wordList([entry.album, entry.title].filter(Boolean).join(" "), null);
  var has = function (list) {
    for (var i = 0; i < list.length; i++) {
      if (folderWords.indexOf(list[i]) >= 0 && own.indexOf(list[i]) < 0) return list[i];
    }
    return null;
  };
  if (/(^|[^0-9])[57]\.1([^0-9]|$)/.test(path) || has(UPGRADE_MULTICHANNEL_WORDS) || /dvd[ -]?a\b/i.test(path)) {
    return { excluded: true, why: "a multichannel mix" };
  }
  if (exceedsStereo(c.extension, c.size, c.length, c.sampleRate, c.bitDepth)) {
    return { excluded: true, why: "more data than stereo — a multichannel mix" };
  }
  var other = has(UPGRADE_OTHER_RECORDING_WORDS);
  if (other) return { excluded: true, why: "another recording (“" + other + "”)" };
  if (has(UPGRADE_COMPILATION_WORDS) || has(UPGRADE_VINYL_WORDS)) return { tier: 2 };
  var albumW = entry.album ? titleWords(stripParens(entry.album)) : [];
  if (albumW.length && coverage(albumW, folderWords) >= 0.5) return { tier: 0 };
  return { tier: 1 };
}

// Pure: is a lossless file larger than two channels of PCM at its rate and
// depth? Unknown rate/depth read as CD (44.1k/16), the floor of what's shared;
// a little slack covers container overhead and embedded art.
function exceedsStereo(ext, size, lengthSecs, sampleRate, bitDepth) {
  if (["flac", "wav", "aiff", "aif", "alac", "ape", "wv"].indexOf(String(ext || "").toLowerCase()) < 0) return false;
  if (!size || !lengthSecs) return false;
  var kbps = size * 8 / lengthSecs / 1000;
  var ceiling = (sampleRate || 44100) * (bitDepth || 16) * 2 / 1000;
  return kbps > ceiling * 1.1;
}

// Pure: what a finished file really is. Lossless is taken from the container
// (a rate is meaningless there, and depth/rate can't be measured without
// decoding, so the sharer's figures stand); lossy is its size over its
// duration — `libraryQuality`'s estimate, so both sides of "is it better?"
// are measured the same way.
function measuredQuality(pick, size, durationSecs) {
  var q = libraryQuality({ format: pick.extension, file_size: size, duration_secs: durationSecs });
  if (q.qualityTier === T_LOSSLESS) {
    q.bitDepth = pick.bitDepth || null;
    q.sampleRate = pick.sampleRate || null;
  }
  return q;
}

// Pure: does the finished file hold up? `measured` null = couldn't measure
// (no duration from the tags, or an older host) — passed through, because the
// compare dialog still stands between it and the library. A lossy file more
// than a fifth below its advertised rate is mislabelled whatever else is true.
var UPGRADE_LABEL_TOLERANCE = 0.8;
function checkUpgrade(entry, pick, measured) {
  if (!measured) return { ok: true, note: "couldn't measure the file — check it in the compare step" };
  if (measured.qualityTier !== T_LOSSLESS && measured.bitRate != null && pick.bitRate &&
      measured.bitRate < pick.bitRate * UPGRADE_LABEL_TOLERANCE) {
    return { ok: false, note: "advertised " + pick.bitRate + " kbps, measured ≈" + measured.bitRate + " kbps" };
  }
  if (!isUpgradeOver(measured, entry.current)) {
    return { ok: false, note: "measured " + qualityLabel(measured) + " — no better than your copy" };
  }
  if (!meetsQualityTarget(measured, entry.target)) {
    return { ok: false, note: "measured " + qualityLabel(measured) + " — below the " + UPGRADE_TARGETS[upgradeTargetOf(entry.target)] + " target" };
  }
  return { ok: true, note: null };
}

function leanCandidate(c) {
  return {
    username: c.username, filename: c.filename, size: c.size, length: c.length,
    bitRate: c.bitRate, bitDepth: c.bitDepth, sampleRate: c.sampleRate,
    isVariableBitRate: c.isVariableBitRate, extension: c.extension, qualityTier: c.qualityTier,
    hasFreeUploadSlot: c.hasFreeUploadSlot, queueLength: c.queueLength, uploadSpeed: c.uploadSpeed,
    sharerTier: c.sharerTier, availabilityTier: c.availabilityTier
  };
}

function upgradeKey(trackId) {
  return "t" + trackId;
}

function upgradeIsBusy(e) {
  return !!e && (e.state === "searching" || e.state === "downloading" || e.state === "checking");
}

function upgradesNeedPoll() {
  var keys = Object.keys(upgrades);
  for (var i = 0; i < keys.length; i++) if (upgradeIsBusy(upgrades[keys[i]])) return true;
  return false;
}

async function saveUpgrades() {
  await api.storage.set(stateKey("upgrades"), upgrades);
}

function setUpgradeState(e, state, message) {
  e.state = state;
  e.message = message || null;
  e.updatedAt = nowMs();
}

// Pure: the second line of an Upgrades row.
function upgradeLine(e, t) {
  var target = UPGRADE_TARGETS[upgradeTargetOf(e.target)];
  var have = "your copy " + (e.currentLabel || "?");
  if (e.state === "searching") return "Searching Soulseek for " + target + " · " + have;
  if (e.state === "downloading" && e.active) {
    var pick = e.active;
    var bits = ["“" + basenameRemote(pick.filename) + "”", qualityLabel(pick) + " from " + pick.username];
    var phase = t ? transferPhase(t.state) : null;
    if (phase === "downloading" || phase === "starting") {
      var pct = transferProgress(t);
      bits.push(pct == null ? "downloading" : "downloading " + Math.round(pct * 100) + "%");
      if (t.averageSpeed) bits.push("↓ " + formatSpeed(t.averageSpeed));
    } else if (t && t.placeInQueue != null) {
      bits.push("waiting in their queue · position " + t.placeInQueue);
    } else {
      bits.push("queued");
    }
    return bits.join("  ·  ");
  }
  if (e.state === "checking") return "Checking the file…";
  if (e.state === "ready" && e.file && replaceOffers[upgradeKey(e.trackId)]) return "Ready: " + qualityLabel(e.file.quality) + " · waiting for your answer in the Replace dialog";
  if (e.state === "ready" && e.file) return "Ready: " + qualityLabel(e.file.quality) + " (" + have + ")" + (e.message ? " · " + e.message : "");
  if (e.state === "replaced") return "Replaced in your library";
  if (e.state === "gone") return e.message || "No longer in your library";
  return (e.message || e.state) + " · " + have;
}

// Pure: which row actions an Upgrades row shows.
function upgradeRowActions(e) {
  var ids = [];
  if (!upgradeIsHistory(e)) ids.push("upgrade-show");
  if (e.state === "ready") ids.push("upgrade-replace");
  if (e.state === "alternative") ids.push("upgrade-take-alternative");
  if (e.state === "none" || e.state === "failed" || e.state === "alternative" || e.state === "cancelled") ids.push("upgrade-retry");
  // Try another sharer and Choose myself… are on the panel (Details), not on
  // every row: a row offering five verbs is one nobody reads.
  if (upgradeIsBusy(e)) ids.push("upgrade-cancel");
  ids.push("upgrade-remove");
  return ids;
}

function currentLabelFor(q) {
  var ext = (q.extension || "").toUpperCase();
  var have = q.qualityTier === T_LOSSLESS ? qualityLabel(q) : (q.bitRate ? ext + " ≈" + q.bitRate + "kbps" : (ext || "unknown quality"));
  return have;
}

// The context-menu entry point. Checks what can be upgraded exactly as the
// interactive mode does — a local library file, or nothing to replace — and
// falls back to the same plain search when it can't.
// The click lands on the Upgrades tab at once, with this track's panel on top:
// what you have, what it's looking for, and then the file it is fetching.
async function queueUpgrade(target) {
  var t = target || {};
  activeTab = "upgrades";
  api.ui.navigateToView(VIEW_ID);
  var row = await libraryRowForTarget(t);
  if (!row) {
    return plainSearch(t, "Upgrade works on tracks in your library — searching Soulseek for this one instead.");
  }
  if (!row.path || String(row.path).indexOf("file://") !== 0) {
    return plainSearch({ kind: "track", title: row.title, artistName: row.artist_name },
      "Upgrade replaces a local file, and “" + row.title + "” isn't one — searching Soulseek for it instead.");
  }
  focusedUpgrade = upgradeKey(row.id);
  await beginUpgrade(row, { origin: "user" });
  render();
}

// Upgrade on a selection of library tracks. Each becomes an ordinary entry on
// the Upgrades tab; the poll runs their searches one at a time (slskd allows
// one search, and `upgradeSearchRunning` keeps upgrades from hogging it), so
// a large batch simply takes a while and the Search tab stays usable.
//
// A batch differs from a single Upgrade in one way: nothing pops up when a
// file is ready. Thirty Replace dialogs arriving at random over an hour would
// be thirty interruptions, so batch entries wait at Ready with Replace… on
// their rows and "Replace all ready…" on the tab, which walks the host's
// compare dialogs one after another. Every replace still goes through that
// dialog — the rule for Upgrade holds.
//
// Skipped, and said so in one notice: rows that aren't local files (nothing
// to replace), ones already searching, downloading or ready (a ready file is
// kept, not thrown away for a new search), and anything past the cap.
var UPGRADE_BATCH_MAX = 100;

async function queueUpgrades(trackIds) {
  var ids = [];
  var seen = {};
  for (var i = 0; i < (trackIds || []).length; i++) {
    var id = Number(trackIds[i]);
    if (!isFinite(id) || seen[id]) continue;
    seen[id] = 1;
    ids.push(id);
  }
  activeTab = "upgrades";
  api.ui.navigateToView(VIEW_ID);
  if (!ids.length) {
    api.ui.showNotification("Upgrade works on tracks in your library — none of the selected tracks is one.");
    render();
    return;
  }
  var over = Math.max(0, ids.length - UPGRADE_BATCH_MAX);
  if (over) ids = ids.slice(0, UPGRADE_BATCH_MAX);

  var started = [], notLocal = 0, missing = 0, already = 0;
  for (var j = 0; j < ids.length; j++) {
    var row = null;
    try { row = await api.library.getTrackById(ids[j]); } catch (e) { console.error("slskd: could not read library track " + ids[j] + ":", e); }
    if (!row) { missing++; continue; }
    if (!row.path || String(row.path).indexOf("file://") !== 0) { notLocal++; continue; }
    var prev = upgrades[upgradeKey(row.id)];
    if (prev && (upgradeIsBusy(prev) || prev.state === "ready")) { already++; continue; }
    var e = await beginUpgrade(row, { origin: "batch", deferred: true });
    if (e) started.push(e);
  }
  if (started.length) {
    focusedUpgrade = upgradeKey(started[0].trackId);
    await saveUpgrades();
    if (readiness.state === "ready") advanceUpgrades().catch(function (e) { console.error("slskd: advancing upgrades failed:", e); });
    schedulePoll(true);
  }
  render();
  var note = batchUpgradeNote(started.length, { notLocal: notLocal, missing: missing, already: already, over: over });
  if (note) api.ui.showNotification(note);
}

// Pure: the one notice after a batch Upgrade, or null when every selected
// track was started (the Upgrades tab filling up is the feedback then).
function batchUpgradeNote(startedCount, skipped) {
  var s = skipped || {};
  var parts = [];
  if (s.notLocal) parts.push(s.notLocal + (s.notLocal === 1 ? " isn't a local file" : " aren't local files"));
  if (s.already) parts.push(s.already + (s.already === 1 ? " is already being upgraded" : " are already being upgraded"));
  if (s.missing) parts.push(s.missing + (s.missing === 1 ? " isn't in your library" : " aren't in your library"));
  if (s.over) parts.push(s.over + " over the limit of " + UPGRADE_BATCH_MAX + " at a time");
  if (!parts.length) return null;
  var skippedCount = (s.notLocal || 0) + (s.already || 0) + (s.missing || 0) + (s.over || 0);
  var head = startedCount
    ? "Upgrading " + startedCount + (startedCount === 1 ? " track" : " tracks") + ". "
    : "Nothing to upgrade. ";
  return head + "Skipped " + skippedCount + ": " + parts.join(", ") + ".";
}

// The ready upgrades, each through the host's compare dialog in turn. A
// dialog answered "Keep current" leaves that one ready and moves on; Stop
// (the tab's button while the walk runs) ends the walk after the open dialog.
var replaceWalk = null;   // { stop: bool } while "Replace all ready" runs

async function replaceAllReady(keys) {
  if (replaceWalk || !canReplaceInPlace()) return;
  replaceWalk = { stop: false };
  render();
  try {
    for (var i = 0; i < keys.length; i++) {
      if (replaceWalk.stop) break;
      var e = upgrades[keys[i]];
      if (!e || e.state !== "ready" || !e.file) continue;
      await offerReplace(e);
    }
  } finally {
    replaceWalk = null;
    render();
  }
}

function readyUpgradeKeys() {
  return Object.keys(upgrades).filter(function (k) {
    var e = upgrades[k];
    return e && e.state === "ready" && e.file;
  }).sort(function (a, b) { return (upgrades[a].createdAt || 0) - (upgrades[b].createdAt || 0); });
}

// Start (or restart) the automatic upgrade of one local library row. Returns
// the entry, or null when one is already running for it. `origin` "user" is a
// click in Viboplr: the view is already showing it, so no toast, and the
// finished file is offered for replacing straight away. Anything else (the
// assistant tool) announces itself and leaves the replace to its caller.
async function beginUpgrade(row, opts) {
  var key = upgradeKey(row.id);
  var origin = opts && (opts.origin === "user" || opts.origin === "batch") ? opts.origin : "assistant";
  var byUser = origin !== "assistant";
  var deferred = !!(opts && opts.deferred);   // a batch saves and advances once, at the end
  var open = { label: "Show", id: "open-upgrades" };
  if (upgradeIsBusy(upgrades[key])) {
    if (!byUser) api.ui.showNotification("“" + row.title + "” is already being upgraded.", { action: open });
    return null;
  }
  var current = libraryQuality(row);
  upgrades[key] = {
    trackId: row.id,
    title: row.title,
    artist: row.artist_name || null,
    album: row.album_title || null,
    trackNumber: row.track_number || null,
    durationSecs: row.duration_secs != null && row.duration_secs > 0 ? row.duration_secs : null,
    path: row.path,
    current: current,
    currentLabel: currentLabelFor(current) + (current.size ? " · " + formatBytes(current.size) : ""),
    target: upgradeTargetOf(settings.upgradeTarget),
    state: "searching",
    message: null,
    candidates: [],
    alternative: null,
    triedUsers: [],
    active: null,
    file: null,
    replaceRequested: false,
    origin: origin,
    createdAt: nowMs(),
    updatedAt: nowMs()
  };
  if (deferred) return upgrades[key];
  await saveUpgrades();
  if (!byUser) {
    api.ui.showNotification(readiness.state === "ready"
      ? "Looking for a better copy of “" + row.title + "”."
      : "“" + row.title + "” will be upgraded once slskd is ready.", { action: open });
  }
  render();
  if (readiness.state === "ready") advanceUpgrades().catch(function (e) { console.error("slskd: advancing upgrades failed:", e); });
  schedulePoll(true);
  return upgrades[key];
}

// Run the search for one entry. Not awaited by the poll: it takes up to
// `UPGRADE_SEARCH_MS`, queued behind any other search in `searchChain`.
async function runUpgradeSearch(e) {
  upgradeSearchRunning = true;
  try {
    var prefs = viewPrefs({ knownDurationSecs: e.durationSecs });
    var ranked = await searchForTrack({ title: e.title, artist: e.artist, album: e.album }, prefs, null, null, nowMs() + UPGRADE_SEARCH_MS);
    if (upgrades[upgradeKey(e.trackId)] !== e || e.state !== "searching") return;   // removed meanwhile
    if (ranked === null) return;   // slskd was busy; the next poll tries again
    var r = rankUpgrade(ranked, e);
    e.candidates = r.picks.slice(0, UPGRADE_KEEP_CANDIDATES).map(leanCandidate);
    e.alternative = r.alternative ? leanCandidate(r.alternative) : null;
    api.log("info", "upgrade: “" + e.title + "” — " + (ranked.byAlbum ? "searched “" + ranked.byAlbum + "” (artist blocked), " : "") +
      ranked.length + " files, " + r.matched + " match, " + r.better + " better, " + r.picks.length + " at the target", "slskd");
    if (!e.candidates.length) {
      if (e.alternative) {
        setUpgradeState(e, "alternative", "No copy at " + UPGRADE_TARGETS[upgradeTargetOf(e.target)] + " found; best better copy is " + qualityLabel(e.alternative));
      } else {
        setUpgradeState(e, "none", r.matched ? "Nothing better than your copy on Soulseek right now" : noMatchMessage(ranked, e.artist, "this track"));
      }
      await saveUpgrades();
      return;
    }
    await startNextUpgradeCandidate(e);
  } catch (err) {
    console.error("slskd: upgrade search failed:", err);
    setUpgradeState(e, "failed", "Search failed: " + ((err && err.message) || String(err)));
    await saveUpgrades();
  } finally {
    upgradeSearchRunning = false;
    render();
  }
}

// Queue the best candidate from a sharer not yet asked. Rests the entry in
// "failed" when there is none, or the per-upgrade cap is reached.
async function startNextUpgradeCandidate(e) {
  while (e.triedUsers.length < UPGRADE_MAX_TRIES) {
    var c = nextUntriedSource(e);
    if (!c) break;
    if (await enqueueUpgradeCandidate(e, c)) return true;
  }
  e.active = null;
  setUpgradeState(e, "failed", "No sharer delivered (" + e.triedUsers.length + " tried)");
  await saveUpgrades();
  return false;
}

// Pure: the best candidate from a sharer not yet asked, or null.
function nextUntriedSource(e) {
  for (var i = 0; i < (e.candidates || []).length; i++) {
    if ((e.triedUsers || []).indexOf(e.candidates[i].username) < 0) return e.candidates[i];
  }
  return null;
}

// Queue one candidate as this upgrade's active attempt. False when slskd
// refused it (the sharer is marked tried either way).
async function enqueueUpgradeCandidate(e, c) {
  if (e.triedUsers.indexOf(c.username) < 0) e.triedUsers.push(c.username);
  var key = c.username + KEY_SEP + c.filename;
  try {
    var out = await enqueueBatch(c.username, [c], (e.artist ? e.artist + " - " : "") + e.title, UPGRADE_SUBDIR, {
      upgrade: { trackId: e.trackId, title: e.title, artist: e.artist, auto: true },
      meta: { title: e.title, artist: e.artist, album: e.album, track_number: e.trackNumber }
    });
    if (!out.queued.length) {
      ledgerCount(key, c.username, "failed", 0, false);
      await dropIfListed(key);
      return false;
    }
  } catch (err) {
    console.error("slskd: upgrade enqueue failed:", err);
    ledgerCount(key, c.username, "failed", 0, false);
    await dropIfListed(key);
    return false;
  }
  var now = nowMs();
  e.active = Object.assign(leanCandidate(c), { key: key, startedAt: now, movedAt: now, lastBytes: 0, unseen: 0 });
  setUpgradeState(e, "downloading");
  await saveUpgrades();
  return true;
}

// Give up on the active attempt and move on. `drop` = cancel it in slskd and
// forget the record (a stall); a failed/vanished one is already over.
async function abandonUpgradeAttempt(e, t, reason, drop) {
  var a = e.active;
  api.log("warn", "upgrade: “" + e.title + "” — " + a.username + ": " + reason, "slskd");
  if (drop && t) await dropStalled(t);
  if (drop) delete tracked[a.key];
  e.active = null;
  await api.storage.set(stateKey("tracked"), tracked);
  await startNextUpgradeCandidate(e);
}

// A file picked by hand for an upgrade (a search with upgradeFor, then a
// download) takes over that track's entry once it lands, and goes through the
// same check as an automatic pick (readable, stereo, better, at the target).
// Without this the entry kept offering whatever the automatic upgrade had
// found — a 5.1 mix, a compilation — while the right file sat in Downloads.
// An automatic attempt still in flight is left to finish in Downloads; it no
// longer belongs to the entry. Each finished file is considered once.
async function adoptManualUpgrades() {
  var keys = Object.keys(tracked);
  var trackedChanged = false;
  var upgradesChanged = false;
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var rec = tracked[k];
    if (!rec || !rec.upgrade || rec.upgrade.auto || rec.upgradeAdopted || !rec.resolvedPath) continue;
    var t = transferByKey(k);
    if (!t || transferPhase(t.state) !== "succeeded") continue;
    rec.upgradeAdopted = true;
    trackedChanged = true;
    var e = upgrades[upgradeKey(rec.upgrade.trackId)];
    if (!e || e.state === "replaced" || e.state === "gone" || (e.file && e.file.key === k)) continue;
    var parts = splitKey(k);
    var q = rec.quality || {};
    var c = {
      username: parts ? parts.username : t.username, filename: parts ? parts.filename : t.filename,
      size: t.size || rec.size || null, length: rec.length, extension: extOf(t.filename),
      bitRate: q.bitRate, bitDepth: q.bitDepth, sampleRate: q.sampleRate, isVariableBitRate: q.isVariableBitRate
    };
    if (e.active && e.active.key !== k) {
      api.log("info", "upgrade: “" + e.title + "” — using the file picked by hand (" + c.username + ") instead of " + e.active.username + "'s", "slskd");
    }
    var now = nowMs();
    e.active = Object.assign(leanCandidate(c), { key: k, startedAt: now, movedAt: now, lastBytes: c.size || 0, unseen: 0, manual: true });
    e.file = { key: k, path: rec.resolvedPath, size: c.size };
    e.lastRejected = null;
    setUpgradeState(e, "checking");
    upgradesChanged = true;
  }
  if (trackedChanged) await api.storage.set(stateKey("tracked"), tracked);
  if (upgradesChanged) await saveUpgrades();
}

// One step for every entry, from the transfer poll (so `transfers` is fresh).
async function advanceUpgrades() {
  if (readiness.state !== "ready" || upgradeAdvancing) return;
  upgradeAdvancing = true;
  try {
    await advanceUpgradesNow();
  } finally {
    upgradeAdvancing = false;
  }
}

async function advanceUpgradesNow() {
  var keys = Object.keys(upgrades);
  var changed = false;
  for (var i = 0; i < keys.length; i++) {
    var e = upgrades[keys[i]];
    if (!e) continue;
    if (e.state === "searching") {
      if (!upgradeSearchRunning) runUpgradeSearch(e).catch(function (err) { console.error("slskd: upgrade search failed:", err); });
    } else if (e.state === "downloading" && e.active) {
      await advanceUpgradeDownload(e);
    } else if (e.state === "checking") {
      await advanceUpgradeCheck(e);
    } else if (e.state === "ready" && e.replaceRequested) {
      changed = (await detectReplaced(e)) || changed;
    }
  }
  if (changed) await saveUpgrades();
}

async function advanceUpgradeDownload(e) {
  var a = e.active;
  var t = transferByKey(a.key);
  if (!t) {
    // Listed the moment slskd accepts it; a run of misses means it's gone
    // (removed from the Downloads tab, or by slskd).
    if (++a.unseen >= UPGRADE_UNSEEN_LIMIT) await abandonUpgradeAttempt(e, null, "vanished from slskd", false);
    return;
  }
  a.unseen = 0;
  var phase = transferPhase(t.state);
  if (phase === "succeeded") {
    var rec = tracked[a.key];
    var path = rec ? (rec.resolvedPath || await resolveTransferPath(t, rec)) : null;
    if (!path) return;   // located on a later poll
    e.file = { key: a.key, path: path, size: t.size || a.size || null };
    setUpgradeState(e, "checking");
    await saveUpgrades();
    await advanceUpgradeCheck(e);
    return;
  }
  if (phase === "cancelled") {
    // Cancelled from the Downloads tab (or slskd's own page): that's the user
    // saying no, not a sharer failing — stop, don't try the next one.
    e.active = null;
    setUpgradeState(e, "failed", "Download cancelled");
    await saveUpgrades();
    return;
  }
  if (phase === "failed") {
    await abandonUpgradeAttempt(e, t, "failed" + (t.exception ? " — " + t.exception : ""), false);
    return;
  }
  var bytes = t.bytesTransferred || 0;
  if (bytes > a.lastBytes) {
    a.lastBytes = bytes;
    a.movedAt = nowMs();
    await saveUpgrades();
  } else if (nowMs() - a.movedAt > UPGRADE_STALL_MS) {
    ledgerCount(a.key, a.username, "stalled", 0, false);
    await abandonUpgradeAttempt(e, t, "no data for " + Math.round(UPGRADE_STALL_MS / 60000) + " min", true);
  }
}

// Measure the finished file once its tags are read (`readTagsForResolved` runs
// earlier in the same poll). An older host without readAudioTags can't measure,
// and the file goes to the compare step on the sharer's word.
async function advanceUpgradeCheck(e) {
  var rec = tracked[e.file.key];
  var canRead = api.system && typeof api.system.readAudioTags === "function";
  if (rec && canRead && !rec.tagsRead) return;
  var duration = rec && rec.meta && rec.meta.durationSecs ? rec.meta.durationSecs : null;
  var pick = e.active || {};
  var measured = duration ? measuredQuality(pick, e.file.size, duration) : null;
  var verdict = rec && canRead && rec.unreadable
    ? { ok: false, note: "the file can't be read — damaged or incomplete" }
    : exceedsStereo(pick.extension || extOf(e.file.path), e.file.size, duration, pick.sampleRate, pick.bitDepth)
      ? { ok: false, note: "more data than stereo — a multichannel mix" }
      : checkUpgrade(e, pick, measured);
  if (!verdict.ok) {
    api.log("warn", "upgrade: “" + e.title + "” — rejected " + pick.username + "'s file: " + verdict.note, "slskd");
    // The file stays in Downloads — the plugin deletes only what the fallback
    // fetched — but it is no longer offered as a replacement.
    if (rec) delete rec.upgrade;
    e.file = null;
    e.active = null;
    e.lastRejected = verdict.note;
    await api.storage.set(stateKey("tracked"), tracked);
    await startNextUpgradeCandidate(e);
    if (e.state === "failed") e.message = "No file held up (" + verdict.note + ")";
    await saveUpgrades();
    return;
  }
  e.file.quality = measured || pick;
  setUpgradeState(e, "ready", verdict.note);
  await saveUpgrades();
  // One more question, and only one: the host's Replace dialog, straight away
  // for an upgrade the user started here. An assistant's upgrade is replaced
  // by the assistant; a batch's waits for "Replace all ready" (see
  // queueUpgrades); an older host gets the toast into its download modal.
  if (e.origin === "batch") return;
  if (e.origin !== "assistant" && canReplaceInPlace()) {
    offerReplace(e).catch(function (err) { console.error("slskd: offering the replace failed:", err); });
    return;
  }
  lastReadyUpgrade = upgradeKey(e.trackId);
  api.ui.showNotification("A better copy of “" + e.title + "” is ready: " + qualityLabel(e.file.quality) + ".",
    { action: { label: "Compare & replace", id: "upgrade-replace-notice" } });
}

// Pure: this host swaps a library file itself, behind its own dialog.
function canReplaceInPlace() {
  return !!(api && api.library && typeof api.library.replaceTrackFile === "function");
}

// Upgrades whose Replace dialog is open right now. Memory only: a dialog
// doesn't survive a restart, so neither may the flag.
var replaceOffers = {};

// Hand the checked file to the host: its dialog shows your copy against the
// new one, and on a yes it swaps the file under the same library row (pausing
// and resuming the track if it is the one playing). "Keep current" leaves the
// upgrade ready, with Replace… on its row.
async function offerReplace(e) {
  var key = upgradeKey(e.trackId);
  if (!e || e.state !== "ready" || !e.file || replaceOffers[key]) return;
  replaceOffers[key] = true;
  render();
  var res = null;
  var failure = null;
  try {
    res = await api.library.replaceTrackFile({
      trackId: e.trackId,
      path: e.file.path,
      source: e.active && e.active.username ? e.active.username + " on Soulseek" : "Soulseek",
      note: e.message || null
    });
  } catch (err) {
    console.error("slskd: replacing the library file failed:", err);
    failure = (err && err.message) || String(err);
  } finally {
    delete replaceOffers[key];
  }
  if (upgrades[key] !== e) { render(); return; }   // removed while the dialog was up
  if (res && res.status === "replaced") {
    setUpgradeState(e, "replaced");
    api.log("info", "upgrade: “" + e.title + "” replaced in the library with " + qualityLabel(e.file.quality), "slskd");
  } else if (failure) {
    setUpgradeState(e, "ready", "Replace failed: " + failure);
  }
  await saveUpgrades();
  render();
}

// After Compare & replace, the library row changes under us once the user
// confirmed. A different size or path is the sign; nothing else is needed.
// A row that is gone (deleted, or lost to an older host's replace that gave
// the file a new id) ends the upgrade as "gone" — left "ready", it would keep
// advertising a trackId no replace can use. A failed READ is not a missing
// row: that stays as it is and is asked again next time. Busy states are not
// checked here — their own flow ends them.
async function detectReplaced(e) {
  if (!api.library || typeof api.library.getTrackById !== "function") return false;
  var row = null;
  try { row = await api.library.getTrackById(e.trackId); } catch (err) { console.error("slskd: re-reading library track failed:", err); return false; }
  if (!row) {
    setUpgradeState(e, "gone", "No longer in your library" + (e.file && e.file.path ? " — the downloaded copy is at " + displayPath(e.file.path) : ""));
    return true;
  }
  if (e.state !== "ready") return false;   // only a ready file can have been swapped in
  if (!sameLibraryPath(row.path, e.path) || (row.file_size || null) !== (e.current.size || null)) {
    setUpgradeState(e, "replaced");
    return true;
  }
  return false;
}

// Pure: two library paths name the same file. The host may rewrite a stored
// `/` path to the platform's `\` (its Windows separator repair) without the
// file changing, which must not read as a replace.
function sameLibraryPath(a, b) {
  return String(a || "").replace(/\\/g, "/") === String(b || "").replace(/\\/g, "/");
}

function openUpgradeReplace(key) {
  var e = upgrades[key];
  if (!e || e.state !== "ready" || !e.file) return;
  if (canReplaceInPlace()) {
    offerReplace(e).catch(function (err) { console.error("slskd: offering the replace failed:", err); });
    return;
  }
  e.replaceRequested = true;
  saveUpgrades().catch(function (err) { console.error("slskd: couldn't save upgrades:", err); });
  openReplace(e.file.key);
}

async function removeUpgrade(key) {
  var e = upgrades[key];
  if (!e) return;
  if (e.state === "downloading" && e.active) {
    var t = transferByKey(e.active.key);
    if (t && transferPhase(t.state) !== "succeeded") {
      await dropStalled(t);
      delete tracked[e.active.key];
      await api.storage.set(stateKey("tracked"), tracked);
    }
  }
  delete upgrades[key];
  await saveUpgrades();
  render();
}

async function retryUpgrade(key) {
  var e = upgrades[key];
  if (!e || upgradeIsBusy(e) || e.state === "gone") return;
  e.target = upgradeTargetOf(settings.upgradeTarget);
  e.candidates = [];
  e.alternative = null;
  e.triedUsers = [];
  e.active = null;
  e.file = null;
  e.replaceRequested = false;
  setUpgradeState(e, "searching");
  await saveUpgrades();
  render();
  advanceUpgrades().catch(function (err) { console.error("slskd: advancing upgrades failed:", err); });
  schedulePoll(true);
}

// "Take it": the best better copy the target ruled out becomes the only pick.
async function takeUpgradeAlternative(key) {
  var e = upgrades[key];
  if (!e || e.state !== "alternative" || !e.alternative) return;
  e.target = "best";
  e.candidates = [e.alternative];
  e.alternative = null;
  e.triedUsers = [];
  await startNextUpgradeCandidate(e);
  render();
  schedulePoll(true);
}

// Stop the active attempt in slskd and forget its record — the user's call,
// so no sharer is marked down in the ledger for it. A finished file is left
// alone: it is already on disk, and the Downloads tab still lists it.
async function dropActiveUpgradeTransfer(e) {
  var a = e.active;
  e.active = null;
  if (!a) return;
  var t = transferByKey(a.key);
  if (!t) {
    // Queued since the last poll: re-read, or it would keep waiting in slskd.
    try {
      transfers = (await fetchTransfers()) || transfers;
    } catch (err) {
      console.error("slskd: couldn't re-read transfers before cancelling an upgrade:", err);
    }
    t = transferByKey(a.key);
  }
  if (t && transferPhase(t.state) === "succeeded") return;
  if (t) await dropStalled(t);
  delete tracked[a.key];
  await api.storage.set(stateKey("tracked"), tracked);
}

// "Cancel" on a pending upgrade: stop the search or the download and rest the
// entry, so Search again / another source can pick it up later. A search in
// flight can't be stopped mid-way, but its answer is dropped
// (`runUpgradeSearch` checks the state when it lands).
async function cancelUpgrade(key) {
  var e = upgrades[key];
  if (!e || !upgradeIsBusy(e)) return;
  await dropActiveUpgradeTransfer(e);
  e.file = null;
  setUpgradeState(e, "cancelled", "Cancelled");
  api.log("info", "upgrade: “" + e.title + "” — cancelled by the user", "slskd");
  await saveUpgrades();
  render();
}

// Pure: the files the last search turned up for this upgrade — the picks at
// the target, best first, then the best better copy that misses it.
function upgradeSources(e) {
  var out = (e.candidates || []).slice();
  var alt = e.alternative;
  if (alt && !out.some(function (c) { return c.username === alt.username && c.filename === alt.filename; })) out.push(alt);
  return out;
}

// Pure: the user may pick a source while one is downloading, or once the
// upgrade has come to rest without a file.
function canPickUpgradeSource(e) {
  return !!e && (e.state === "downloading" || e.state === "alternative" || e.state === "failed" ||
    e.state === "cancelled" || e.state === "none") && upgradeSources(e).length > 0;
}

// "Use this": download exactly this file instead, whatever is running now.
// The user's pick isn't held to the per-upgrade sharer cap, and one below the
// target lowers the bar for this upgrade, as "Take the best found" does — the
// post-download check still makes sure it's better than your copy.
async function useUpgradeSource(key, index) {
  var e = upgrades[key];
  if (!canPickUpgradeSource(e)) return;
  var c = upgradeSources(e)[index];
  if (!c) return;
  if (e.active && e.active.username === c.username && e.active.filename === c.filename) return;
  await dropActiveUpgradeTransfer(e);
  e.file = null;
  if (!meetsQualityTarget(c, e.target)) e.target = "best";
  if (!(await enqueueUpgradeCandidate(e, c))) {
    setUpgradeState(e, "failed", c.username + " refused the download — pick another source");
    await saveUpgrades();
  }
  render();
  schedulePoll(true);
}

// "Try another sharer": the next untried source, without waiting out the stall
// timer. When every one has been asked, the upgrade rests for the user.
async function skipUpgradeSource(key) {
  var e = upgrades[key];
  if (!e || e.state !== "downloading") return;
  var next = nextUntriedSource(e);
  if (!next) return;
  await useUpgradeSource(key, upgradeSources(e).indexOf(next));
}

// Pure: one row of the "Other sources" list.
function upgradeSourceRows(e) {
  var key = upgradeKey(e.trackId);
  return upgradeSources(e).map(function (c, i) {
    var active = !!(e.active && e.state === "downloading" && e.active.username === c.username && e.active.filename === c.filename);
    var tried = !active && (e.triedUsers || []).indexOf(c.username) >= 0;
    var bits = [c.username + " · " + dirnameRemote(c.filename).replace(/\\/g, "/")];
    if (!meetsQualityTarget(c, e.target)) bits.push("below your target");
    if (active) bits.push("downloading now");
    else if (tried) bits.push("tried");
    var rep = sharerLabel(sharers[c.username]);
    var badge = active ? { label: "Downloading", variant: "accent" }
      : tried ? { label: "Tried", variant: "muted" }
      : !meetsQualityTarget(c, e.target) ? { label: "Below target", variant: "warning" }
      : undefined;
    return {
      id: key + "#" + i,
      title: basenameRemote(c.filename),
      subtitle: bits.join("  ·  "),
      badge: badge,
      cells: { quality: qualityLabel(c), size: c.size ? formatBytes(c.size) : undefined,
        availability: c.username + " · " + availabilityLabel(c) + (rep ? " · " + rep : "") },
      imageUrl: fileTile(c),
      kind: "audio",
      actions: active ? [] : ["upgrade-use-source"]
    };
  });
}

// Pure: "t42#3" → { key: "t42", index: 3 }.
function parseSourceId(id) {
  var s = String(id || "");
  var at = s.lastIndexOf("#");
  if (at < 0) return null;
  var index = Number(s.slice(at + 1));
  return isFinite(index) ? { key: s.slice(0, at), index: index } : null;
}

// Pure: an upgrade that is over — kept only as history.
function upgradeIsHistory(e) {
  return !!e && (e.state === "replaced" || e.state === "gone");
}

var showUpgradeHistory = false;   // the History list on the Upgrades tab, folded by default

async function clearUpgradeHistory() {
  var keys = Object.keys(upgrades);
  for (var i = 0; i < keys.length; i++) {
    if (upgradeIsHistory(upgrades[keys[i]])) delete upgrades[keys[i]];
  }
  if (focusedUpgrade && !upgrades[focusedUpgrade]) focusedUpgrade = null;
  await saveUpgrades();
  render();
}

function upgradeRows(history) {
  return Object.keys(upgrades)
    .map(function (k) { return upgrades[k]; })
    .filter(function (e) { return upgradeIsHistory(e) === !!history; })
    .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); })
    .map(function (e) {
      var t = e.active ? transferByKey(e.active.key) : null;
      return {
        id: upgradeKey(e.trackId),
        title: e.title,
        subtitle: upgradeLine(e, t),
        badge: upgradeBadge(e, t) || undefined,
        progress: upgradeRowProgress(e, t),
        album: e.album || undefined,
        duration: e.durationSecs != null ? formatDurationSecs(e.durationSecs) : undefined,
        durationSecs: e.durationSecs,
        artistName: e.artist,
        albumTitle: e.album,
        kind: "audio",
        actions: upgradeRowActions(e)
      };
    });
}

// Pure: a local path for reading — no scheme, the platform's own separators.
function displayPath(p) {
  var s = String(p || "").replace(/^file:\/\//, "");
  return /^[A-Za-z]:[\\/]/.test(s) ? s.replace(/\//g, "\\") : s;
}

// Pure: which entry the panel describes — the one last started here while it
// still exists, else the newest one still in progress or waiting on you.
function panelUpgrade(all, focused) {
  if (focused && all[focused]) return all[focused];
  var best = null;
  for (var k in all) {
    var e = all[k];
    if (!e || !(upgradeIsBusy(e) || e.state === "ready")) continue;
    if (!best || (e.createdAt || 0) > (best.createdAt || 0)) best = e;
  }
  return best;
}

// Pure: the panel on top of the Upgrades tab — the whole process for one
// track in plain lines: the file you have, what it's after, the file it is
// fetching and from whom, and the file that will replace yours.
// `t` is the active transfer, `ready` whether slskd is up, `asking` whether
// the host's Replace dialog is open for it, `inPlace` whether this host
// replaces behind its own dialog.
// Pure: the four steps of an automatic upgrade as one line — ✓ done, ● now,
// ○ to come — or null for a state that isn't on that road (nothing found,
// failed, cancelled, gone). It answers "where is it?" without reading.
var UPGRADE_STEPS = ["Search", "Download", "Check", "Replace"];
function upgradeStepper(state, pct) {
  var at = { searching: 0, downloading: 1, checking: 2, ready: 3, replaced: 4 }[state];
  if (at == null) return null;
  return UPGRADE_STEPS.map(function (label, i) {
    var mark = i < at ? "✓" : i === at ? "●" : "○";
    return mark + " " + label + (i === 1 && i === at && pct != null ? " " + Math.round(pct * 100) + "%" : "");
  }).join("   ─   ");
}

// One side of the compare: a caption and what's under it.
function compareSide(caption, lines) {
  return { type: "layout", direction: "vertical", children: [mutedText(caption)].concat(lines) };
}

// Pure: the panel on top of the Upgrades tab — the steps, then the copy you
// have next to the one on its way (or ready), then what you can do.
// `t` is the active transfer, `ready` whether slskd is up, `asking` whether
// the host's Replace dialog is open for it, `inPlace` whether this host
// replaces behind its own dialog.
function upgradePanel(e, t, ready, asking, inPlace) {
  var key = upgradeKey(e.trackId);
  var phase = t ? transferPhase(t.state) : null;
  var pct = t && (phase === "downloading" || phase === "starting") ? transferProgress(t) : null;
  var lines = [
    { type: "text", content: "“" + e.title + "”" + (e.artist ? " · " + e.artist : ""), className: "plugin-heading" }
  ];
  var steps = upgradeStepper(e.state, pct);
  if (steps) lines.push(mutedText(steps));

  var mine = compareSide("Your copy", [
    { type: "text", content: e.currentLabel || "?" },
    mutedText(displayPath(e.path))
  ]);
  var theirs = null;
  var buttons = [];
  var cancel = actionButton("Cancel upgrade", "upgrade-cancel", "secondary", { data: { itemId: key } });
  if (e.state === "searching") {
    theirs = compareSide("Looking for", [
      { type: "text", content: UPGRADE_TARGETS[upgradeTargetOf(e.target)] },
      mutedText(ready ? "Searching Soulseek…" : "Waiting for slskd to be ready…")
    ]);
  } else if (e.state === "downloading" && e.active) {
    var a = e.active;
    var side = [
      { type: "text", content: qualityLabel(a) + (a.size ? " · " + formatBytes(a.size) : "") },
      mutedText("Downloading “" + basenameRemote(a.filename) + "” from " + a.username +
        (sharerLabel(sharers[a.username]) ? " · " + sharerLabel(sharers[a.username]) : ""))
    ];
    if (pct != null) {
      side.push({ type: "progress-bar", value: Math.round(pct * 100), max: 100,
        label: Math.round(pct * 100) + "%" + (t.averageSpeed ? " · ↓ " + formatSpeed(t.averageSpeed) : "") });
    } else if (t && t.placeInQueue != null) {
      side.push(mutedText("Waiting in " + a.username + "'s queue · position " + t.placeInQueue));
    } else {
      side.push(mutedText("Queued with " + a.username));
    }
    if (e.triedUsers && e.triedUsers.length > 1) side.push(mutedText("Sharer " + e.triedUsers.length + " — the earlier ones didn't deliver, or you moved on."));
    theirs = compareSide("On its way", side);
    if (nextUntriedSource(e)) buttons.push(actionButton("Try another sharer", "upgrade-skip", "secondary", { data: { itemId: key } }));
  } else if (e.state === "checking") {
    theirs = compareSide("Downloaded", [{ type: "text", content: "Checking the downloaded file…" }]);
  } else if (e.state === "ready" && e.file) {
    var r = [{ type: "text", content: "Ready: " + qualityLabel(e.file.quality) + (e.file.size ? " · " + formatBytes(e.file.size) : "") },
      mutedText(displayPath(e.file.path))];
    if (e.message) r.push(mutedText(e.message));
    theirs = compareSide("Replaces it", r);
    if (asking) lines.push({ type: "text", content: "Waiting for your answer in the Replace dialog…" });
    else buttons.push(actionButton(inPlace ? "Replace…" : "Compare & replace…", "upgrade-replace", "accent", { data: { itemId: key } }));
  } else if (e.state === "replaced") {
    lines.push({ type: "text", content: "Replaced in your library." });
  } else {
    lines.push({ type: "text", content: e.message || e.state });
    if (e.state === "alternative") buttons.push(actionButton("Take the best found", "upgrade-take-alternative", "accent", { data: { itemId: key } }));
    if (e.state === "none" || e.state === "failed" || e.state === "alternative" || e.state === "cancelled") buttons.push(actionButton("Search again", "upgrade-retry", "secondary", { data: { itemId: key } }));
  }
  lines.push(theirs ? { type: "layout", direction: "horizontal", children: [mine, { type: "text", content: "→" }, theirs] } : mine);

  // Choosing the source yourself stays inside this upgrade: the files its
  // search found, folded under one button, and "Use this" switches the
  // download while the entry carries on to Check and Replace. Only when the
  // search found nothing better does it fall back to a full Soulseek search.
  var pickable = canPickUpgradeSource(e);
  var open = pickable && !!sourcesOpen[key];
  if (pickable) {
    var n = upgradeSources(e).length;
    buttons.push(actionButton(open ? "Hide sources" : "Choose the source myself (" + n + ")", "upgrade-sources-toggle", "secondary", { data: { itemId: key } }));
  } else if (!upgradeIsHistory(e) && e.state !== "ready" && e.state !== "searching") {
    buttons.push(actionButton("Search Soulseek myself…", "upgrade-choose", "secondary", { data: { itemId: key } }));
  }
  // Cancel goes last, apart from the ways forward.
  if (upgradeIsBusy(e)) buttons.push(cancel);
  if (buttons.length) lines.push(buttonRow(buttons));
  // Every file the search found for it, so the user can take a different
  // source than the automatic pick — a sharer with a shorter queue, a smaller
  // file, the one below the target. `selectable` is what makes the columns
  // render at all (see searchTab).
  if (open) {
    lines.push({ type: "toolbar", title: "Sources found", status: upgradeSources(e).length + " · Use this downloads a different one", buttons: [] });
    lines.push({
      type: "track-row-list",
      items: upgradeSourceRows(e),
      showHeader: true,
      selectable: true,
      columns: SOURCE_COLUMNS,
      contextMenu: false,
      actions: [{ id: "upgrade-use-source", label: "Use this", icon: "⬇" }]
    });
  }
  return { type: "section", title: "Upgrading", children: lines };
}

var SOURCE_COLUMNS = [
  { id: "quality", label: "Quality", width: 130 },
  { id: "size", label: "Size", width: 80, align: "right" },
  { id: "availability", label: "Sharer", width: 170 }
];

var sourcesOpen = {};   // upgrade key → its "Sources found" list is unfolded

function upgradesTab() {
  var children = [];
  var inPlace = canReplaceInPlace();
  if (!Object.keys(upgrades).length) {
    children.push({ type: "text", className: "plugin-muted",
      content: "Nothing being upgraded. Choose Soulseek: Upgrade on a track in your library and a better copy is found, downloaded and checked here; you replace it after comparing the two." });
  } else {
    var shown = panelUpgrade(upgrades, focusedUpgrade);
    if (shown) {
      children.push(upgradePanel(shown, shown.active ? transferByKey(shown.active.key) : null,
        readiness.state === "ready", !!replaceOffers[upgradeKey(shown.trackId)], inPlace));
    }
    var pending = upgradeRows(false);
    if (pending.length) {
      var ready = readyUpgradeKeys();
      var bar = [];
      if (replaceWalk) bar.push({ label: "Stop after this one", action: "upgrade-replace-stop", icon: "■" });
      else if (ready.length > 1 && inPlace) bar.push({ label: "Replace all ready (" + ready.length + ")…", action: "upgrade-replace-all", variant: "accent", icon: "⇪" });
      children.push({ type: "toolbar", title: "Pending", buttons: bar,
        status: pending.length + (ready.length ? " · " + ready.length + " ready" : "") + (replaceWalk ? " · replacing one at a time" : "") });
      children.push({
        type: "track-row-list",
        items: pending,
        // Selectable, so Cancel / Search again / Remove / Replace reach many
        // at once from the selection bar (their handlers take every id).
        selectable: true,
        showHeader: false,
        actions: declaredActions([
          { id: "upgrade-show", label: "Details", icon: "☰" },
          { id: "upgrade-replace", label: inPlace ? "Replace…" : "Compare & replace…", icon: "⇪" },
          { id: "upgrade-take-alternative", label: "Take the best found", icon: "⬇" },
          { id: "upgrade-retry", label: "Search again", icon: "↻" },
          { id: "upgrade-cancel", label: "Cancel", icon: "■" },
          // Drops the entry; a downloaded file stays where it is.
          { id: "upgrade-remove", label: "Remove", icon: "✕" }
        ], pending)
      });
    } else {
      children.push(mutedText("Nothing pending."));
    }
    // Finished upgrades are of little use once done: one folded line, and the
    // list only on request.
    var history = upgradeRows(true);
    if (history.length) {
      children.push({ type: "toolbar", title: "History", status: history.length + " finished",
        buttons: [{ label: showUpgradeHistory ? "Hide" : "Show", action: "upgrade-history-toggle" },
          { label: "Clear", action: "upgrade-history-clear", icon: "✕" }] });
      if (showUpgradeHistory) {
        children.push({
          type: "track-row-list",
          items: history,
          showHeader: false,
          actions: [{ id: "upgrade-remove", label: "Remove", icon: "✕" }]
        });
      }
    }
  }
  // The setting that steers every upgrade, under the upgrades it steers:
  // the tab opens on what is happening, not on a dropdown.
  children.push(upgradeTargetRow());
  return { type: "layout", direction: "vertical", children: children };
}

// The one setting that decides what an upgrade looks for, on the tab it
// steers rather than three tabs away in Settings.
function upgradeTargetRow() {
  var t = upgradeTargetOf(settings.upgradeTarget);
  return { type: "settings-row", label: "Upgrade to",
    description: UPGRADE_TARGET_HELP[t] + " Nothing in your library changes until you replace.",
    control: { type: "select", action: "set-upgrade-target", value: t,
      options: Object.keys(UPGRADE_TARGETS).map(function (k) { return { value: k, label: UPGRADE_TARGETS[k] }; }) } };
}

// ---------------------------------------------------------------------------
// Upgrade / fill-album entry points
// ---------------------------------------------------------------------------
// Both fall back to the plain "Search on Soulseek…" behaviour when the library
// can't answer — a track that isn't a local library row has nothing to replace,
// an album with no rows here has nothing to compare against — and say so, so
// the user isn't left wondering why the filter never appeared.
// The library row a track target names. A target from the queue or Now Playing
// often carries no library id — the host only has one when the queue entry
// cached it — so the row is then found by name: same title and artist after
// normalizing, a local file over a remote one, and the nearest duration when
// several remain. Without this, Upgrade on the playing song quietly became a
// plain search, and its download could never be replaced into the library.
async function libraryRowForTarget(t) {
  var row = null;
  if (t.trackId != null && api.library && typeof api.library.getTrackById === "function") {
    try { row = await api.library.getTrackById(t.trackId); } catch (e) { console.error("slskd: could not read library track " + t.trackId + ":", e); }
  }
  if (row) return row;
  return libraryRowByName(t.title, t.artistName, t.durationSecs);
}

async function libraryRowByName(title, artist, durationSecs) {
  if (!title || !api.library || typeof api.library.ftsTracks !== "function") return null;
  var wantTitle = normalizeText(title);
  var wantArtist = artist ? normalizeText(artist) : null;
  if (!wantTitle) return null;
  var hits;
  try {
    hits = await api.library.ftsTracks(wantTitle + (wantArtist ? " " + wantArtist : ""), { limit: 50 }) || [];
  } catch (e) {
    console.error("slskd: library lookup for “" + title + "” failed:", e);
    return null;
  }
  var best = null;
  var bestScore = Infinity;
  for (var i = 0; i < hits.length; i++) {
    var r = hits[i];
    if (normalizeText(r.title) !== wantTitle) continue;
    if (wantArtist && normalizeText(r.artist_name || "") !== wantArtist) continue;
    var local = r.path && String(r.path).indexOf("file://") === 0;
    var drift = durationSecs && r.duration_secs ? Math.abs(r.duration_secs - durationSecs) : 0;
    var score = (local ? 0 : 1e6) + drift;
    if (score < bestScore) { best = r; bestScore = score; }
  }
  return best;
}

// `note` says why this became a plain search. It sits in the Search tab over
// the results (`searchNote`) rather than in a toast: every caller has just
// opened the view, so a toast repeated what the view should say, and it was
// gone while the search it explained was still running.
function plainSearch(target, note) {
  var q = searchQueryForTarget(target);
  if (!q) {
    if (note) api.ui.showNotification(note);
    return Promise.resolve();
  }
  return runSearch(q, note ? { note: note } : null);
}

// Pure: the inline note over a search's results, or null.
function searchNote(s) {
  if (!s || !s.note) return null;
  return { type: "layout", direction: "horizontal", className: "ds-banner ds-banner--warning",
    children: [{ type: "text", content: s.note }] };
}

async function startUpgrade(target) {
  var t = target || {};
  api.ui.navigateToView(VIEW_ID);
  var row = await libraryRowForTarget(t);
  if (!row) return plainSearch(t, "Upgrade works on tracks in your library — searching Soulseek for this one instead.");
  if (!row.path || String(row.path).indexOf("file://") !== 0) {
    return plainSearch({ kind: "track", title: row.title, artistName: row.artist_name },
      "Upgrade replaces a local file, and “" + row.title + "” isn't one — searching Soulseek for it instead.");
  }
  var mode = {
    kind: "upgrade",
    trackId: row.id,
    title: row.title,
    artist: row.artist_name || null,
    album: row.album_title || null,
    trackNumber: row.track_number || null,
    current: libraryQuality(row),
    showAll: false
  };
  var extra = { mode: mode };
  // Same recording or nothing: a result more than a few seconds off the copy in
  // hand is a different version, not a better copy of this one.
  if (row.duration_secs != null && row.duration_secs > 0) extra.knownDurationSecs = row.duration_secs;
  await runSearch(searchQueryForTarget({ kind: "track", title: row.title, artistName: row.artist_name }), extra);
}

// The album's library rows. An album target normally carries its id; one built
// from names alone (the control API's plugin-action route) is looked up by
// title + artist through the library's FTS.
async function albumRowsFor(t) {
  if (!api.library || typeof api.library.getTracks !== "function") return { id: null, tracks: [] };
  var albumId = t.albumId != null ? t.albumId : null;
  var title = t.albumTitle || t.title || "";
  if (albumId == null && title && typeof api.library.ftsAlbums === "function") {
    try {
      var hits = await api.library.ftsAlbums(title, { limit: 20 }) || [];
      var wantTitle = normalizeText(title);
      var wantArtist = t.artistName ? normalizeText(t.artistName) : null;
      for (var i = 0; i < hits.length; i++) {
        if (normalizeText(hits[i].title) !== wantTitle) continue;
        if (wantArtist && normalizeText(hits[i].artist_name || "") !== wantArtist) continue;
        albumId = hits[i].id;
        break;
      }
    } catch (e) {
      console.error("slskd: album lookup failed:", e);
    }
  }
  if (albumId == null) return { id: null, tracks: [] };
  try {
    return { id: albumId, tracks: await api.library.getTracks({ albumId: albumId, limit: 1000 }) || [] };
  } catch (e) {
    console.error("slskd: could not read album " + albumId + ":", e);
    return { id: albumId, tracks: [] };
  }
}

async function startFill(target) {
  var t = target || {};
  api.ui.navigateToView(VIEW_ID);
  var title = t.albumTitle || t.title || "";
  var album = await albumRowsFor(t);
  if (!album.tracks.length) {
    return plainSearch({ kind: "album", albumTitle: title, artistName: t.artistName },
      "“" + title + "” has no tracks in your library to compare against — searching Soulseek for the whole album instead.");
  }
  var mode = {
    kind: "fill",
    albumId: album.id,
    albumTitle: title,
    artistName: t.artistName || null,
    owned: album.tracks.map(function (r) {
      return { title: r.title, trackNumber: r.track_number != null ? r.track_number : null, durationSecs: r.duration_secs != null ? r.duration_secs : null };
    }),
    showAll: false
  };
  await runSearch(searchQueryForTarget({ kind: "album", albumTitle: title, artistName: t.artistName }), { mode: mode });
}

// Hand a finished upgrade to the host's download modal with the library row it
// is meant to replace. A host that knows `libraryTrackId` opens its compare →
// Replace / Save as copy flow; an older one runs the ordinary Add to library
// copy, which is the same modal minus the replace step.
//
// A file fetched from a plain search has no upgrade stamp, but the user asking
// to replace with it is intent enough: the library copy is found by the file's
// own title / artist / duration. The host's compare step still stands between
// that guess and the library file.
async function openReplace(key) {
  var rec = tracked[key];
  var tr = importTrackFor(key);
  if (!rec || !tr) {
    api.ui.showNotification("That file hasn't finished downloading yet.");
    return;
  }
  var trackId = rec.upgrade ? rec.upgrade.trackId : null;
  if (trackId == null) {
    var meta = rec.meta || {};
    var row = await libraryRowByName(meta.title, meta.artist, tr.durationSecs);
    if (!row || !row.path || String(row.path).indexOf("file://") !== 0) {
      api.ui.showNotification("No local copy of “" + tr.title + "” in your library to replace — Add to library copies it in instead.");
      return;
    }
    trackId = row.id;
  }
  tr.libraryTrackId = trackId;
  api.ui.requestAction("download-tracks", { providerId: PROVIDER_KEY, providerName: PROVIDER_NAME, tracks: [tr] });
}

// ---------------------------------------------------------------------------
// Assistant tools (api.assistant)
// ---------------------------------------------------------------------------
// The AI-facing surface (host control API / MCP). Same shape as the yt-dlp and
// qBittorrent plugins: small verbs, structured JSON, ids a model can pass back.
// `search` runs its OWN search and never touches the sidebar's state, which
// belongs to whatever the user has open; `download` goes through the same core
// as a clicked download, so an assistant-queued file is tracked, located and
// imported identically. Guarded: older hosts have no api.assistant namespace.
// What an upgrade search knows about where a file came from (`upgradeSource`),
// in words an assistant can show the user.
var SOURCE_LABELS = ["the album's own folder", "a folder that doesn't name the album", "a compilation or vinyl rip"];

function toolCandidate(c) {
  var out = toolCandidateFields(c);
  if (c.source) {
    if (c.source.excluded) out.notAnUpgrade = c.source.why;
    else out.source = SOURCE_LABELS[c.source.tier];
  }
  return out;
}

function toolCandidateFields(c) {
  return {
    id: candidateId(c),
    user: c.username,
    filename: basenameRemote(c.filename),
    folder: basenameRemote(dirnameRemote(c.filename)),
    format: c.extension || null,
    bitrateKbps: c.bitRate,
    lossless: c.qualityTier === T_LOSSLESS,
    quality: qualityLabel(c),
    sizeBytes: c.size,
    durationSecs: c.length,
    hasFreeUploadSlot: !!c.hasFreeUploadSlot,
    queueLength: c.queueLength,
    uploadSpeedBytesPerSec: c.uploadSpeed
  };
}

// Remember a search's candidates for `download`, and forget searches older
// than the last TOOL_SEARCHES_KEPT. A candidate found again by a newer search
// takes that search's mode (the latest intent wins).
function rememberToolResults(ranked, mode) {
  var seq = ++toolSearchSeq;
  for (var i = 0; i < ranked.length; i++) toolResults[candidateId(ranked[i])] = { c: ranked[i], mode: mode || null, seq: seq };
  var ids = Object.keys(toolResults);
  for (var j = 0; j < ids.length; j++) {
    if (toolResults[ids[j]].seq <= seq - TOOL_SEARCHES_KEPT) delete toolResults[ids[j]];
  }
}

var LIST_DOWNLOADS_LIMIT = 50;

// Pure: the list_downloads rows a caller asked for, newest first. Every
// transfer slskd still holds used to come back on every call — tens of
// kilobytes to find one uri. `total` is the count before `limit`.
function filterTransfers(rows, args) {
  var a = args || {};
  var phases = a.phase == null ? null : [].concat(a.phase).map(String);
  var q = a.query ? normalizeText(a.query) : "";
  var out = rows.filter(function (r) {
    if (a.upgradeFor != null && r.upgradeFor !== Number(a.upgradeFor)) return false;
    if (a.user && r.user !== String(a.user)) return false;
    if (phases && phases.indexOf(r.phase) < 0) return false;
    if (q && normalizeText([r.filename, r.title, r.artist, r.album].filter(Boolean).join(" ")).indexOf(q) < 0) return false;
    return true;
  });
  out.sort(function (x, y) { return String(y.requestedAt || "").localeCompare(String(x.requestedAt || "")); });
  var limit = Math.min(500, Math.max(1, parseInt(a.limit, 10) || LIST_DOWNLOADS_LIMIT));
  var shown = out.slice(0, limit);
  shown.total = out.length;
  return shown;
}

// Pure: the list_upgrades entries a caller asked for. `state` narrows to one
// or more states; replaced entries — done, and most of the list after a while
// — are left out unless asked for. `hidden` counts what that left out.
function filterUpgrades(entries, args) {
  var a = args || {};
  var states = a.state == null ? null : [].concat(a.state).map(String);
  var hidden = 0;
  var out = entries.filter(function (e) {
    if (states) return states.indexOf(e.state) >= 0;
    if (e.state === "replaced" && !a.includeReplaced) { hidden++; return false; }
    return true;
  });
  out.hidden = hidden;
  return out;
}

function toolTransfer(t) {
  var key = trackKeyOf(t);
  var rec = tracked[key];
  var meta = (rec && rec.meta) || parseTrackMeta(t.filename);
  var finished = transferPhase(t.state) === "succeeded" && tier === "local" && rec && rec.resolvedPath;
  return {
    uri: finished ? toolUri(key) : null,
    upgradeFor: rec && rec.upgrade ? rec.upgrade.trackId : null,
    user: t.username,
    filename: basenameRemote(t.filename),
    title: meta.title || null,
    artist: meta.artist || null,
    album: meta.album || null,
    phase: transferPhase(t.state),
    state: t.state,
    progress: transferProgress(t),
    bytesTransferred: t.bytesTransferred || 0,
    sizeBytes: t.size || null,
    placeInQueue: t.placeInQueue != null ? t.placeInQueue : null,
    speedBytesPerSec: t.averageSpeed || null,
    requestedAt: t.requestedAt || t.enqueuedAt || null,
    error: t.exception || null,
    attempts: t.attempts || null,
    localPath: (rec && rec.resolvedPath && tier === "local") ? rec.resolvedPath : null,
    startedByViboplr: !!rec
  };
}

// The library row an assistant names for an upgrade, or a readable refusal —
// the same two checks the context-menu Upgrade makes, as errors instead of a
// fallback to plain search (a model asked for an upgrade, not a search).
async function upgradableRow(trackId) {
  var id = Number(trackId);
  if (!isFinite(id)) throw new Error('"trackId" (a library track id) is required');
  if (!api.library || typeof api.library.getTrackById !== "function") throw new Error("this Viboplr can't read library tracks for plugins");
  var row = await api.library.getTrackById(id);
  if (!row) throw new Error("no library track with id " + id);
  if (!row.path || String(row.path).indexOf("file://") !== 0) {
    throw new Error("track " + id + " (“" + row.title + "”) isn't a local file — only a local file can be upgraded");
  }
  return row;
}

function upgradeModeFor(row) {
  return {
    kind: "upgrade",
    trackId: row.id,
    title: row.title,
    artist: row.artist_name || null,
    album: row.album_title || null,
    trackNumber: row.track_number || null,
    current: libraryQuality(row),
    showAll: false
  };
}

// One Upgrades entry for an assistant. A ready entry carries the finished
// file's `uri` — what the host's replace verb takes.
function toolUpgrade(e) {
  var t = e.active ? transferByKey(e.active.key) : null;
  var ready = e.state === "ready" && e.file;
  return {
    trackId: e.trackId,
    title: e.title,
    artist: e.artist || null,
    state: e.state,
    message: e.message || null,
    current: e.currentLabel || null,
    target: UPGRADE_TARGETS[upgradeTargetOf(e.target)] || e.target,
    downloading: e.state === "downloading" && e.active ? {
      user: e.active.username,
      quality: qualityLabel(e.active),
      progress: t ? transferProgress(t) : null,
      placeInQueue: t && t.placeInQueue != null ? t.placeInQueue : null
    } : null,
    ready: ready ? { quality: qualityLabel(e.file.quality), sizeBytes: e.file.size || null, uri: toolUri(e.file.key) } : null,
    alternative: e.state === "alternative" && e.alternative ? qualityLabel(e.alternative) : null
  };
}

function registerAssistantTools() {
  if (!api.assistant || typeof api.assistant.onTool !== "function") return;

  api.assistant.onTool("status", async function () {
    var col = downloadsCollection();
    return {
      state: readiness.state,
      detail: readiness.detail || null,
      soulseekUsername: readiness.username || null,
      slskdVersion: readiness.version || null,
      slskdAddress: conn().url || null,
      testServer: !!settings.debugServer,
      sharesAnything: readiness.shareCount == null ? null : readiness.shareCount > 0,
      slskdOnThisComputer: tier === "local",
      downloadsFolder: downloadsDir || null,
      downloadsReachLibraryAutomatically: !!col,
      libraryCollection: col ? col.name : null,
      activeDownloads: transfers.filter(function (t) {
        var p = transferPhase(t.state);
        return p === "downloading" || p === "queued" || p === "starting" || p === "requested";
      }).length
    };
  });

  api.assistant.onTool("search", async function (args) {
    var q = typeof args.query === "string" ? args.query.trim() : "";
    // Upgrade mode: the library row sets the query, the duration filter and
    // the bar a result has to clear — the view's "Upgrade with Soulseek…".
    var mode = null;
    var known = args.durationSecs != null && !isNaN(Number(args.durationSecs)) ? Number(args.durationSecs) : null;
    // The track a search is for, when the caller left the query to us: the
    // search then gets the blocked-artist retry (`searchForTrack`).
    var forTrack = null;
    if (args.upgradeFor != null) {
      var row = await upgradableRow(args.upgradeFor);
      mode = upgradeModeFor(row);
      if (!q) {
        forTrack = { title: row.title, artist: row.artist_name || null, album: row.album_title || null };
        q = searchQueryForTarget({ kind: "track", title: row.title, artistName: row.artist_name });
      }
      if (known == null && row.duration_secs > 0) known = row.duration_secs;
    }
    if (!q) throw new Error('"query" (string) is required, unless upgradeFor names a library track');
    if (readiness.state !== "ready") throw new Error("slskd is not ready (" + readiness.state + ") — see the status tool");
    var limit = Math.min(100, Math.max(1, parseInt(args.limit, 10) || 25));
    var prefs = viewPrefs(known != null ? { knownDurationSecs: known } : null);
    var ranked = forTrack ? await searchForTrack(forTrack, prefs, null, null) : await performSearch(q, prefs, null, null);
    if (ranked === null) ranked = [];
    var blocked = !!ranked.artistBlocked;
    if (ranked.byAlbum) q = ranked.byAlbum;
    else if (!ranked.length && !ranked.responseCount && !forTrack) blocked = true;
    annotateForMode(ranked, mode);
    rememberToolResults(ranked, mode);
    var shown = mode && !args.showAll ? ranked.filter(function (c) { return c.better; }) : ranked;
    // An upgrade lists the album's own copies first and other mixes last — the
    // same order the automatic upgrade picks in (`rankUpgrade`). Stable, so the
    // quality ranking holds within each group.
    if (mode && mode.kind === "upgrade") {
      var group = function (c) { return c.source ? (c.source.excluded ? 3 : c.source.tier) : 1; };
      shown = shown.map(function (c, i) { return { c: c, i: i }; })
        .sort(function (a, b) { return (group(a.c) - group(b.c)) || (a.i - b.i); })
        .map(function (x) { return x.c; });
    }
    var out = {
      query: q,
      total: ranked.length,
      note: "Ranked best-first: preferred format, then quality tier, then who can send it soonest. Pass ids to download; every file of a folder from one user = the whole album.",
      results: shown.slice(0, limit).map(function (c) {
        var r = toolCandidate(c);
        if (mode) r.better = !!c.better;
        return r;
      })
    };
    if (mode) {
      out.upgradeFor = { trackId: mode.trackId, title: mode.title, artist: mode.artist, current: currentLabelFor(mode.current) };
      out.better = ranked.filter(function (c) { return c.better; }).length;
      out.note = (args.showAll ? "Every file found; better = beats the library copy. " : "Only files that beat the library copy (showAll=true for everything). ") +
        "download stamps the file as this track's upgrade; once finished, list_downloads gives its uri for the host's replace_track_file.";
    }
    // Zero responses usually means a phrase Soulseek's server won't search for
    // (artist names, after takedown requests) — say so, or "no results" reads
    // as "Soulseek doesn't have it".
    if (ranked.byAlbum) {
      out.note += " The artist's name is a blocked search on Soulseek, so this searched by album and title instead (“" + ranked.byAlbum + "”) — check each result's folder is the right album.";
    } else if (blocked) {
      out.note += " Nobody answered at all: Soulseek blocks searches for some artist names. Search again without the artist — album and song title.";
    }
    return out;
  });

  api.assistant.onTool("download", async function (args) {
    var ids = Array.isArray(args.ids) ? args.ids.map(String) : (typeof args.ids === "string" ? [args.ids] : []);
    if (!ids.length) throw new Error('"ids" (array of result ids from search) is required');
    if (readiness.state !== "ready") throw new Error("slskd is not ready (" + readiness.state + ") — see the status tool");
    // One batch per sharer per search: files from different searches can carry
    // different upgrade stamps.
    var batches = {};
    var unknown = [];
    for (var i = 0; i < ids.length; i++) {
      var hit = toolResults[ids[i]];
      if (!hit) { unknown.push(ids[i]); continue; }
      var bk = hit.seq + KEY_SEP + hit.c.username;
      (batches[bk] = batches[bk] || { user: hit.c.username, mode: hit.mode, files: [] }).files.push(hit.c);
    }
    if (unknown.length && !Object.keys(batches).length) {
      throw new Error("Unknown result id(s): " + unknown.join(", ") + " — ids come from the last " + TOOL_SEARCHES_KEPT + " search calls");
    }
    var queued = [];
    var failures = [];
    var keys = Object.keys(batches);
    for (var u = 0; u < keys.length; u++) {
      var b = batches[keys[u]];
      var label = basenameRemote(dirnameRemote(b.files[0].filename));
      var out = await enqueueBatch(b.user, b.files, label, null, modeRecExtra(b.mode));
      for (var q = 0; q < out.queued.length; q++) queued.push({ user: b.user, filename: basenameRemote(out.queued[q].filename) });
      for (var f = 0; f < out.failures.length; f++) failures.push({ user: b.user, filename: basenameRemote(out.failures[f].filename), message: out.failures[f].message || "refused" });
    }
    if (queued.length) {
      api.ui.showNotification(queued.length === 1
        ? "Queued 1 Soulseek download (" + queued[0].filename + ")"
        : "Queued " + queued.length + " Soulseek downloads");
      render();
    }
    return { queued: queued, failures: failures, unknownIds: unknown,
      note: "Transfers wait in the other user's queue; watch list_downloads." };
  });

  api.assistant.onTool("list_downloads", async function (args) {
    if (readiness.state === "ready") {
      try {
        var fresh = await fetchTransfers();
        if (fresh) transfers = fresh;
      } catch (e) {
        console.error("slskd: list_downloads refresh failed:", e);
      }
    }
    var rows = filterTransfers(transfers.map(toolTransfer), args || {});
    return {
      downloads: rows,
      total: rows.total,
      note: "A finished file's uri is what Viboplr's replace_track_file (upgradeFor rows) or download_plugin_track takes." +
        (rows.total > rows.length ? " Showing the newest " + rows.length + " of " + rows.total + " — filter with upgradeFor, user, phase or query, or raise limit." : "")
    };
  });

  api.assistant.onTool("upgrade", async function (args) {
    var action = args.action || "start";
    var key = upgradeKey(Number(args.trackId));
    if (action === "start") {
      var row = await upgradableRow(args.trackId);
      var e = await beginUpgrade(row);
      if (!e) return { started: false, note: "already being upgraded", upgrade: toolUpgrade(upgrades[key]) };
      return { started: true, upgrade: toolUpgrade(e),
        note: "Runs in the background (search, download, then a size-over-duration check); watch list_upgrades until state is ready." };
    }
    var existing = upgrades[key];
    if (!existing) throw new Error("no upgrade for track " + args.trackId + " — start one with action=start");
    if (action === "retry") await retryUpgrade(key);
    else if (action === "take_alternative") await takeUpgradeAlternative(key);
    else if (action === "cancel") await cancelUpgrade(key);
    else if (action === "remove") { await removeUpgrade(key); return { removed: true, trackId: existing.trackId }; }
    else throw new Error('unknown action "' + action + '" — start, retry, take_alternative, cancel or remove');
    return { upgrade: toolUpgrade(upgrades[key]) };
  });

  api.assistant.onTool("list_upgrades", async function (args) {
    args = args || {};
    var keys = Object.keys(upgrades);
    var changed = false;
    for (var i = 0; i < keys.length; i++) {
      var e = upgrades[keys[i]];
      // Resting entries are re-read so none lists a trackId the library no
      // longer has; busy ones are left to the flow that is running them.
      if (!e || upgradeIsBusy(e) || e.state === "replaced" || e.state === "gone") continue;
      // A replace done through the host's API (not this view's dialog) is
      // noticed here and, via replaceRequested, by the poll from now on.
      if (await detectReplaced(e)) { changed = true; continue; }
      if (e.state === "ready" && !e.replaceRequested) { e.replaceRequested = true; changed = true; }
    }
    if (changed) await saveUpgrades();
    var all = keys.map(function (k) { return upgrades[k]; }).filter(Boolean);
    var picked = filterUpgrades(all, args);
    return {
      upgrades: picked.map(toolUpgrade),
      replacedHidden: picked.hidden,
      note: "When state is ready, show the user current vs ready.quality and pass ready.uri to Viboplr's replace_track_file (it stages, compares, and replaces only on confirm). State gone means the trackId no longer exists in the library — remove the entry (upgrade action=remove), don't stage against it." +
        (picked.hidden ? " " + picked.hidden + " replaced entr" + (picked.hidden === 1 ? "y is" : "ies are") + " hidden (includeReplaced=true lists them)." : "")
    };
  });
}

var saveTimer = null;
function saveSetting(key, value) {
  settings[key] = value;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    api.storage.set(key, value).catch(function (e) { console.error("slskd: couldn't save " + key + ":", e); });
    if (key === "url" || key === "apiKey" || key === "insecure") {
      downloadsDir = null;
      incompleteDir = null;
      refreshReadiness().catch(function (e) { console.error("slskd probe failed:", e); });
    } else {
      tier = detectTier(conn().url, conn().tierOverride);
      render();
      renderSettings();
    }
  }, 400);
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------
function schedulePoll(fast) {
  if (transferTimer) clearTimeout(transferTimer);
  var delay = fast ? TRANSFER_POLL_FAST_MS : TRANSFER_POLL_SLOW_MS;
  transferTimer = setTimeout(function () {
    refreshTransfers()
      .catch(function (e) { console.error("slskd transfer poll failed:", e); })
      .then(function () {
        var active = transfers.some(function (t) {
          var p = transferPhase(t.state);
          return p === "downloading" || p === "queued" || p === "starting" || p === "requested";
        });
        schedulePoll(active || upgradesNeedPoll() || activeTab === "transfers" || activeTab === "upgrades");
      });
  }, delay);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
async function loadSettings() {
  var keys = ["url", "apiKey", "tierOverride", "insecure", "preferredFormats", "fallbackQuality", "fallbackMaxGb", "fallbackMaxAgeDays", "upgradeTarget", "batchSeq", "managedBy", "stopWithViboplr", "startWithViboplr", "debugServer", "debugUrl"];
  for (var i = 0; i < keys.length; i++) {
    try {
      var v = await api.storage.get(keys[i]);
      if (v !== undefined && v !== null) settings[keys[i]] = v;
    } catch (e) {
      console.error("slskd: couldn't read setting " + keys[i] + ":", e);
    }
  }
  await loadManagedRecord();
  await loadAccount();
  // "roadie" is from plugin versions that ran slskd through Roadie, which
  // Viboplr no longer carries: the address stays (it is just a slskd now),
  // and one the plugin installed needs its install record.
  if (settings.managedBy && !(settings.managedBy === "plugin" && managed.record)) {
    settings.managedBy = null;
    api.storage.set("managedBy", null).catch(function (e) { console.error("slskd: couldn't save managedBy:", e); });
  }
  await loadServerState();
}

// The state that belongs to ONE slskd (see "Test server"): read under the
// current server's keys, and reset first so a switch never carries the old
// server's records across.
async function loadServerState() {
  sharesWarned = false;
  tracked = {};
  fallback = {};
  sharers = {};
  upgrades = {};
  resolveHistory = [];
  fallbackLastUsedAt = null;
  try {
    var w = await api.storage.get(stateKey("sharesWarned"));
    sharesWarned = !!w;
    var t = await api.storage.get(stateKey("tracked"));
    if (t && typeof t === "object") tracked = t;
    var fb = await api.storage.get(stateKey("fallback"));
    if (fb && typeof fb === "object") fallback = fb;
    var sh = await api.storage.get(stateKey("sharers"));
    if (sh && typeof sh === "object") sharers = sh;
    var up = await api.storage.get(stateKey("upgrades"));
    if (up && typeof up === "object") upgrades = up;
    var hist = await api.storage.get(stateKey("resolveHistory"));
    if (Array.isArray(hist)) resolveHistory = hist.slice(0, RESOLVE_HISTORY_MAX);
    var used = await api.storage.get(stateKey("fallbackLastUsedAt"));
    if (typeof used === "number") fallbackLastUsedAt = used;
  } catch (e) {
    console.error("slskd: couldn't read stored state:", e);
  }
  try {
    var rs = await api.storage.get("recentSearches");
    if (Array.isArray(rs)) recentSearches = rs.filter(function (q) { return typeof q === "string" && q; }).slice(0, RECENT_SEARCH_MAX);
  } catch (e) {
    console.error("slskd: couldn't read stored state:", e);
  }
}

// Is a fake slskd answering at the test address? It marks every answer with
// X-Fake-Slskd (generated / replay / record), which is what tells it apart
// from a real slskd. A fake on this computer is also looked for on ports
// DEBUG_PORT_FIRST–DEBUG_PORT_LAST, so one started with --port is found
// without typing its address; finding it elsewhere saves the new address.
// All candidates go at once: a refused connection answers straight away.
// Resolves true when the address moved.
async function detectDebugServer() {
  var url = String(settings.debugUrl || "").replace(/\/+$/, "");
  var candidates = debugCandidates(url);
  if (!candidates.length) { debugDetected = false; return false; }
  var answers = await Promise.all(candidates.map(function (base) {
    return api.network.fetch(base + "/api/v0/session/enabled", { method: "GET", timeoutMs: 1500, headers: { "Accept": "application/json", "User-Agent": CLIENT_USER_AGENT } })
      .then(function (res) { return res && res.headers ? res.headers["x-fake-slskd"] || null : null; })
      .catch(function () { return null; });   // nothing listening there — the usual answer, not an error
  }));
  for (var i = 0; i < candidates.length; i++) {
    if (!answers[i]) continue;
    debugDetected = { mode: String(answers[i]) };
    if (candidates[i] === url) return false;
    settings.debugUrl = candidates[i];
    try {
      await api.storage.set("debugUrl", settings.debugUrl);
    } catch (e) {
      console.error("slskd: couldn't save debugUrl:", e);
    }
    api.log("info", "found the test server at " + settings.debugUrl, "slskd");
    return true;
  }
  debugDetected = false;
  return false;
}

// Pure: the addresses to look for a fake at — the saved one first, then, when
// it is on this computer, the same host on each port of the range.
function debugCandidates(url) {
  url = String(url || "").replace(/\/+$/, "");
  if (!url) return [];
  var out = [url];
  var m = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.exec(url);
  if (!m) return out;
  for (var port = DEBUG_PORT_FIRST; port <= DEBUG_PORT_LAST; port++) {
    var u = "http://" + m[1] + ":" + port;
    if (out.indexOf(u) < 0) out.push(u);
  }
  return out;
}

// Pure: the "Test server" section. While a fake answers or the switch is on,
// the switch and its address; otherwise how to start one, and — once Look
// again has run — that nothing answered.
function testServerSection(cfg, detected, lookedAt) {
  if (!cfg.debugServer && !detected) {
    var children = [
      optionRow("Test without the Soulseek network",
        "For developers, or a network that blocks Soulseek: run `" + FAKE_SLSKD_COMMAND + "` in a terminal (needs Node.js) for a stand-in slskd, then press Look again. It's also found by itself within a minute.",
        actionButton("Look again", "detect-test-server", "secondary"))
    ];
    if (lookedAt) children.push(mutedText("Nothing answered at " + String(cfg.debugUrl || "").replace(/\/+$/, "") + " or on ports " + DEBUG_PORT_FIRST + "–" + DEBUG_PORT_LAST + ". Is the fake still running?"));
    children.push(buttonRow([actionButton("How it works", "test-server-docs", "secondary")]));
    return { type: "section", title: "Test server", children: children };
  }
  var mode = detected && detected.mode ? detected.mode : null;
  var what = mode === "replay" ? "replaying a recording" : (mode === "record" ? "recording a real slskd" : (mode ? "generated results" : null));
  return { type: "section", title: "Test server", children: [
    { type: "settings-row", label: "Use the test server",
      description: cfg.debugServer
        ? "On: searches and downloads go to the fake slskd" + (what ? " (" + what + ")" : "") + ". Your own slskd's address and key are kept, and its downloads come back when you switch off."
        : "A fake slskd is running" + (what ? " (" + what + ")" : "") + ". Switch to it to test without the Soulseek network. Its downloads are kept apart from your real ones.",
      control: { type: "toggle", label: "", action: "set-debug-server", checked: !!cfg.debugServer } },
    { type: "settings-row", label: "Test server address",
      description: "Where the fake listens. One on this computer is found by itself on ports " + DEBUG_PORT_FIRST + "–" + DEBUG_PORT_LAST + ".",
      control: { type: "text-input", placeholder: "http://127.0.0.1:5039", action: "set-debug-url", value: cfg.debugUrl || "" } }
  ] };
}

// Switch between the user's slskd and the test server. Everything held in
// memory about the old server goes; its stored state stays under its own keys.
async function switchServer(on) {
  if (!!settings.debugServer === !!on) return;
  settings.debugServer = !!on;
  try {
    await api.storage.set("debugServer", settings.debugServer);
  } catch (e) {
    console.error("slskd: couldn't save debugServer:", e);
  }
  searchGen++;
  search = { query: "", id: null, running: false, responseCount: 0, fileCount: 0, matchCount: 0, folderCount: 0, results: [], folders: [], error: null, sortColumn: null, sortDir: "desc", folderSortColumn: null, folderSortDir: "desc", mode: null };
  transfers = [];
  toolResults = {};
  knownDone = {};
  ledgerSeen = {};
  completionsSeeded = false;
  tagsPending = {};
  lastResolve = null;
  replaceOffers = {};
  focusedUpgrade = null;
  lastReadyUpgrade = null;
  downloadsDir = null;
  incompleteDir = null;
  lastServerState = null;
  signinWhy = null;
  slskdShared = null;
  readiness = { state: "connecting", detail: null, username: null, version: null, shareCount: null };
  await loadServerState();
  api.log("info", on ? "switched to the test server at " + conn().url : "switched back to slskd at " + (settings.url || "(not set)"), "slskd");
  await refreshReadiness();
  schedulePoll(true);
}

async function activate(hostApi) {
  api = hostApi;
  await loadSettings();
  tier = detectTier(conn().url, conn().tierOverride);

  registerActions();
  registerAssistantTools();

  // Completed Soulseek files play as ordinary local files. parseUrlScheme does a
  // raw substring(7), so the path must NOT be percent-encoded.
  api.playback.onResolveStreamByUri(SCHEME, async function (ref) {
    if (tier !== "local") return null;
    ref = decodeRef(ref);
    var rec = findTrackedByRef(ref);
    if (!rec) return null;
    var path = await currentPath(ref, rec);
    return path ? fileUrlForPlayback(path) : null;
  });

  // The playback fallback: the host asks by metadata when a track has no
  // playable source of its own. Budgeted — see "Playback fallback" above.
  if (typeof api.playback.onStreamResolve === "function") {
    api.playback.onStreamResolve(FALLBACK_ID, function (title, artistName, albumName, durationSecs, opts) {
      return resolveFallback(title, artistName, albumName, durationSecs, opts);
    });
  }

  // The download modal's provider for slsk:// — "Download…" on any of our rows
  // and the Add to library button both land here. The transfer already
  // finished, so this resolve is an instant local copy, well inside any budget.
  api.downloads.onResolveByUri(PROVIDER_ID, async function (uri) {
    var ref = decodeRef(String(uri || "").replace(/^slsk:\/\//, ""));
    var rec = findTrackedByRef(ref);
    var path = await currentPath(ref, rec);
    if (!path) return null;
    return downloadAnswer(path, rec.meta);
  });

  // A track the playback fallback played has no slsk:// URI, so the host's
  // download modal asks by metadata. That answers ONLY from the fallback's kept
  // copy — the file that is already playing. It never searches: a download the
  // user asked for by hand deserves a picked file, not the fallback's best guess.
  if (typeof api.downloads.onResolveByMetadata === "function") {
    api.downloads.onResolveByMetadata(PROVIDER_ID, function (title, artistName) {
      return resolveKeptDownload(title, artistName);
    });
  }

  api.downloads.onGetQualities(PROVIDER_ID, function () {
    return [{ value: "original", label: "Original file", description: "Copies the file Soulseek delivered, untouched." }];
  });

  // Asked only while a program of ours that shouldn't outlive Viboplr runs:
  // slskd's own shutdown (it finishes writing its database), then the host's
  // stop. The host stops what's left itself after its wait.
  if (api.system && api.system.programs && typeof api.system.programs.onAppQuitting === "function") {
    api.system.programs.onAppQuitting(function () {
      if (!managed.record || !settings.stopWithViboplr) return;
      return stopManagedProcess().catch(function (e) { console.error("slskd: stopping slskd at quit failed:", e); });
    });
  }

  render();
  renderSettings();

  await refreshReadiness();
  if (shouldStartWithViboplr(settings, managed)) {
    // Not awaited: a start waits for slskd to come up, and activation must not.
    startManaged().catch(function (e) { console.error("slskd: starting slskd with Viboplr failed:", e); });
  }
  if (readiness.state === "unconfigured") {
    discoverSlskd().catch(function (e) { console.error("slskd: looking for slskd failed:", e); });
  }
  readinessTimer = setInterval(function () {
    refreshReadiness().catch(function (e) { console.error("slskd readiness poll failed:", e); });
  }, READINESS_POLL_MS);
  schedulePoll(false);
}

function deactivate() {
  startWait = null;
  if (readinessTimer) clearInterval(readinessTimer);
  if (transferTimer) clearTimeout(transferTimer);
  if (saveTimer) clearTimeout(saveTimer);
  readinessTimer = null;
  transferTimer = null;
  saveTimer = null;
  searchGen++;
  toolResults = {};
  blockedArtists = {};
  knownDone = {};
  ledgerSeen = {};
  completionsSeeded = false;
  lastResolve = null;
  fallbackBusy = false;
  managed.setup = null;  // ends a setup's sign-in wait
  api = null;
}

return {
  activate: activate,
  deactivate: deactivate,

  // Exposed for the test harness.
  _testServerSection: testServerSection,
  _debugCandidates: debugCandidates,
  _b64encode: b64encode,
  _hasFlag: hasFlag,
  _qualityTier: qualityTier,
  _formatTile: formatTile,
  _transferGroup: transferGroup,
  _transferRowProgress: transferRowProgress,
  _upgradeBadge: upgradeBadge,
  _upgradeRowProgress: upgradeRowProgress,
  _queueUpgrades: queueUpgrades,
  _batchUpgradeNote: batchUpgradeNote,
  _replaceAllReady: replaceAllReady,
  _transfersSummary: transfersSummary,
  _plainTransferError: plainTransferError,
  _waitedFor: waitedFor,
  _withRecentSearch: withRecentSearch,
  _folderSubtitle: folderSubtitle,
  _folderQualityLabel: folderQualityLabel,
  _folderRowStatus: folderRowStatus,
  _sortTransfersNewestFirst: sortTransfersNewestFirst,
  _resolveStats: resolveStats,
  _withResolve: withResolve,
  _historyEntry: historyEntry,
  _historyLine: historyLine,
  _upgradeStepper: upgradeStepper,
  _statusChecklist: statusChecklist,
  _fileTile: fileTile,
  _folderTile: folderTile,
  _tileTier: tileTier,
  _tileDetail: tileDetail,
  _transferTile: transferTile,
  _availabilityTier: availabilityTier,
  _rankResults: rankResults,
  _groupByFolder: groupByFolder,
  _resultLabel: resultLabel,
  _resultSource: resultSource,
  _resultCells: resultCells,
  _sortCandidates: sortCandidates,
  _RESULT_COLUMNS: RESULT_COLUMNS,
  _formatCount: formatCount,
  _MAX_RESULT_FILES: MAX_RESULT_FILES,
  _MAX_RESULT_FOLDERS: MAX_RESULT_FOLDERS,
  _parseTrackMeta: parseTrackMeta,
  _parsePreferredFormats: parsePreferredFormats,
  _detectTier: detectTier,
  _randomApiKey: randomApiKey,
  _setupGuideUrl: setupGuideUrl,
  _whatIsThisUrl: whatIsThisUrl,
  _setupHomeView: setupHomeView,
  _wantsSetupScreen: wantsSetupScreen,
  _readinessBanner: readinessBanner,
  _viewHeaderFor: viewHeaderFor,
  _fixNodes: fixNodes,
  _collectionPaths: collectionPaths,
  _installShares: installShares,
  _renderSlskdYml: renderSlskdYml,
  _slskdBinaryName: slskdBinaryName,
  _isHostRecord: isHostRecord,
  _hostToolReady: hostToolReady,
  _defaultDownloadsDir: defaultDownloadsDir,
  _downloadsFolderText: downloadsFolderText,
  _canInstallHere: canInstallHere,
  _portLooksFree: portLooksFree,
  _pickFreePort: pickFreePort,
  _storedAccount: storedAccount,
  _managedFailure: managedFailure,
  _managedCapable: managedCapable,
  _managedStartSpec: managedStartSpec,
  _managedVersionRows: managedVersionRows,
  _managedFileRows: managedFileRows,
  _managedRemoveRows: managedRemoveRows,
  _installFormComplete: installFormComplete,
  _usesManaged: usesManaged,
  _describeFolders: describeFolders,
  _installRows: installRows,
  _connectionSection: connectionSection,
  _shareGap: shareGap,
  _yamlWithShares: yamlWithShares,
  _sharedFromSlskd: sharedFromSlskd,
  _discoveryCandidates: discoveryCandidates,
  _slskdFingerprint: slskdFingerprint,
  _discoveryNodes: discoveryNodes,
  _sharingRows: sharingRows,
  _managedOwnsAddress: managedOwnsAddress,
  _unauthorizedNodes: unauthorizedNodes,
  _disconnectedNodes: disconnectedNodes,
  _apiLogMessages: apiLogMessages,
  _checkedAgo: checkedAgo,
  _newSetup: newSetup,
  _advanceSetup: advanceSetup,
  _failSetup: failSetup,
  _setupChecklist: setupChecklist,
  _signinFailure: signinFailure,
  _signinProgress: signinProgress,
  _signinReasonFromLog: signinReasonFromLog,
  _setSigninTiming: function (waitMs, pollMs, settleMs) { SIGNIN_WAIT_MS = waitMs; SIGNIN_POLL_MS = pollMs; if (settleMs != null) START_SETTLE_MS = settleMs; },
  _setToolTiming: function (pollMs, waitMs) { TOOL_POLL_MS = pollMs; TOOL_WAIT_MS = waitMs; },
  _hostOf: hostOf,
  _searchQueryForTarget: searchQueryForTarget,
  _nextReadiness: nextReadiness,
  _parseApplication: parseApplication,
  _matchFile: matchFile,
  _absolutePath: absolutePath,
  _rebaseListing: rebaseListing,
  _pathIsUnder: pathIsUnder,
  _collectionForPath: collectionForPath,
  _mergeMeta: mergeMeta,
  _candidateId: candidateId,
  _transferProgress: transferProgress,
  _transferSubtitle: transferSubtitle,
  _transferRowActions: transferRowActions,
  _rowIds: rowIds,
  _KEY_SEP: KEY_SEP,
  _fileUrlForPlayback: fileUrlForPlayback,
  _fileUrlForDownload: fileUrlForDownload,
  _transferPhase: transferPhase,
  _safeDestination: safeDestination,
  _sanitizeSegment: sanitizeSegment,
  _basenameRemote: basenameRemote,
  _dirnameRemote: dirnameRemote,
  _extOf: extOf,
  _formatBytes: formatBytes,
  _formatDurationSecs: formatDurationSecs,
  _flattenListing: flattenListing,
  _FALLBACK_ID: FALLBACK_ID,
  _PROVIDER_ID: PROVIDER_ID,
  _normalizeText: normalizeText,
  _fallbackKey: fallbackKey,
  _fallbackQuery: fallbackQuery,
  _albumTitleQuery: albumTitleQuery,
  _searchForTrack: searchForTrack,
  _blockedArtists: function () { return blockedArtists; },
  _scoreFallbackCandidate: scoreFallbackCandidate,
  _rankFallback: rankFallback,
  _fallbackQualityRank: fallbackQualityRank,
  _fallbackQualityDescription: fallbackQualityDescription,
  _matchLabel: matchLabel,
  _fallbackTotals: fallbackTotals,
  _transferEta: transferEta,
  _waitForTransfer: waitForTransfer,
  _FALLBACK_HEDGE_MS: FALLBACK_HEDGE_MS,
  _sharerScore: sharerScore,
  _sharerTier: sharerTier,
  _sharerLabel: sharerLabel,
  _noteSharer: noteSharer,
  _ledgerTotals: ledgerTotals,
  _refreshTransfers: refreshTransfers,
  _keptKeys: keptKeys,
  _transferKeys: transferKeys,
  _retryableKey: retryableKey,
  _cancellablePhase: cancellablePhase,
  _historyRowId: historyRowId,
  _declaredActions: declaredActions,
  _rowTransferStatus: rowTransferStatus,
  _liveTransferCount: liveTransferCount,
  _ownedInFolder: ownedInFolder,
  _historyRows: historyRows,
  _fallbackStatusNode: fallbackStatusNode,
  _sidebarBadge: sidebarBadge,
  _startResolveRecord: startResolveRecord,
  _finishResolve: finishResolve,
  _libraryQuality: libraryQuality,
  _isUpgradeOver: isUpgradeOver,
  _ownedTrackFor: ownedTrackFor,
  _missingFiles: missingFiles,
  _startUpgrade: startUpgrade,
  _queueUpgrade: queueUpgrade,
  _advanceUpgrades: advanceUpgrades,
  _upgrades: function () { return upgrades; },
  _upgradeSource: upgradeSource,
  _exceedsStereo: exceedsStereo,
  _filterTransfers: filterTransfers,
  _filterUpgrades: filterUpgrades,
  _rememberToolResults: rememberToolResults,
  _toolResults: function () { return toolResults; },
  _meetsQualityTarget: meetsQualityTarget,
  _windowsCantStore: windowsCantStore,
  _misconfiguredSlskdDir: misconfiguredSlskdDir,
  _isWindowsPathBug: isWindowsPathBug,
  _rankUpgrade: rankUpgrade,
  _upgradeTargetOf: upgradeTargetOf,
  _measuredQuality: measuredQuality,
  _checkUpgrade: checkUpgrade,
  _upgradeLine: upgradeLine,
  _upgradePanel: upgradePanel,
  _panelUpgrade: panelUpgrade,
  _displayPath: displayPath,
  _upgradeRowActions: upgradeRowActions,
  _upgradeSources: upgradeSources,
  _fallbackEvictions: fallbackEvictions,
  _fallbackDirB64: fallbackDirB64,
  _enforceFallbackLimits: enforceFallbackLimits,
  _fallbackIndex: function () { return fallback; },
  _upgradeSourceRows: upgradeSourceRows,
  _parseSourceId: parseSourceId,
  _upgradesTab: upgradesTab,
  _sameLibraryPath: sameLibraryPath,
  _setUpgradeTimings: function (searchMs, stallMs) { UPGRADE_SEARCH_MS = searchMs; if (stallMs != null) UPGRADE_STALL_MS = stallMs; },
  _startFill: startFill,
  _setFallbackSearchMs: function (ms) { FALLBACK_SEARCH_MS = ms; },
  // Tests: what slskd's transfer list holds, without a poll.
  _setTransfersForTest: function (list) { transfers = list; }
};
