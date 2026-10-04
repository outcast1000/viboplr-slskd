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
  upgradeTarget: "flac16", // a UPGRADE_TARGETS key — what an automatic upgrade looks for
  batchSeq: 0,
  managedBy: null         // null | "roadie" — the address/key came from Roadie and follow it
};

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
var search = { query: "", id: null, running: false, responseCount: 0, fileCount: 0, matchCount: 0, folderCount: 0, results: [], folders: [], error: null, sortColumn: null, sortDir: "desc", mode: null };
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
// The last ranked list the assistant `search` tool produced, keyed by candidate
// id, so `download` can be handed ids instead of (user, filename, size) triples.
var toolResults = {};
// The upgrade mode of the assistant's last search (null for a plain one) —
// what its `download` stamps onto the tracked record.
var toolMode = null;

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
// `C:\Users\x\Music\Soulseek/.incomplete` (what Roadie's slskd recipe wrote before it normalized paths)
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
  "Update Roadie and restart slskd, or fix directories in slskd.yml";

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
    bits.push(formatBytes(t.size));
  } else if (phase === "succeeded") {
    bits.push("Finished");
    bits.push(formatBytes(t.size));
    bits.push("from " + user);
    if (currentTier === "local" && !(rec && rec.resolvedPath)) bits.push("locating file…");
  } else if (phase === "failed") {
    bits.push(!isWindowsPathBug(t.exception)
      ? "Failed" + (t.exception ? " — " + t.exception : "")
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
function normalizeText(s) {
  var out = String(s == null ? "" : s);
  if (typeof out.normalize === "function") out = out.normalize("NFD");
  return out
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
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

function wordList(s, drop) {
  var words = normalizeText(s).split(" ");
  var out = [];
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    if (!w) continue;
    if (drop && /^\d{4}$/.test(w)) continue;
    if (drop && drop.indexOf(w) >= 0) continue;
    out.push(w);
  }
  return out;
}

// The words of a title that identify the song: edition words, stop words and
// bare years are noise, but a title that is nothing but noise keeps its words
// rather than matching everything.
function titleWords(title) {
  var strict = wordList(title, EDITION_WORDS.concat(STOP_WORDS));
  return strict.length ? strict : wordList(title, null);
}

function artistWords(artist) {
  var strict = wordList(artist, STOP_WORDS);
  return strict.length ? strict : wordList(artist, null);
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
    if (mode.kind === "upgrade") c.better = isUpgradeOver(c, mode.current);
    else if (mode.kind === "fill") c.owned = !!ownedTrackFor(c, mode.owned);
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
function fallbackQuery(title, artist) {
  var t = String(title || "").replace(/\s*[\(\[][^\)\]]*[\)\]]\s*/g, " ");
  var words = artistWords(artist).concat(titleWords(t));
  if (!words.length) words = wordList(title, null);
  return words.join(" ");
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
function rankFallback(candidates, title, artist, preferred, mode) {
  var want = { title: titleWords(title), artist: artistWords(artist) };
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
  return String(settings.url || "").replace(/\/+$/, "");
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

async function slskd(method, path, body) {
  var url = baseUrl() + path;
  var init = {
    method: method,
    headers: { "X-API-Key": settings.apiKey || "", "Accept": "application/json" }
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  if (settings.insecure) init.insecure = true;

  var res = await api.network.fetch(url, init);
  var text = "";
  try { text = await res.text(); } catch (e) { text = ""; }
  var json = null;
  if (text) { try { json = JSON.parse(text); } catch (e) { json = null; } }
  return { status: res.status, json: json, text: text };
}

async function probe() {
  if (!settings.url || !settings.apiKey) return { kind: "unconfigured" };
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
// explanation sits above the Connection card. A slskd Roadie installed and
// still has is only stopped, so the notice starts it. `why` is the sign-in
// reason read from slskd's log; `onSettings` drops "Fix…" on the Settings
// tab, where the explanation is already right below — there the button
// had nowhere to go and looked dead.
function readinessBanner(st, cfg, r, why, onSettings) {
  var tool = r && r.installed ? r.tool : null;
  var busy = !!(r && r.job);
  var fix = onSettings ? [] : [actionButton("Fix…", "slskd-show-fix")];
  var text, variant, buttons;
  if (st === "unreachable" && cfg.managedBy === "roadie" && tool && tool.installed) {
    text = "slskd isn't running. Search, downloads and the playback fallback need it.";
    variant = "warning";
    buttons = [actionButton("Start slskd", "roadie-start", "accent", { disabled: busy })];
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
    buttons = roadieOwnsAddress(cfg.url, tool) && !signinNeedsNetwork(why)
      ? [actionButton("Restart slskd", "roadie-restart", "accent", { disabled: busy })].concat(fix)
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
// `rd` is `readiness`; `setup` is `roadie.setup` (the install checklist).
function viewHeaderFor(rd, cfg, r, tierNow, setup) {
  var st = rd.state;
  var url = cfg.url || "";
  var roadieSlskd = cfg.managedBy === "roadie";
  var open = url ? [{ label: "Open slskd", action: "open-slskd" }] : [];
  if (setup) {
    return { subtitle: "Setting up slskd with Roadie", status: { variant: "muted", label: "Setting up" }, actions: [] };
  }
  if (st === "unconfigured") {
    return { subtitle: "Search and download from the Soulseek network", status: { variant: "muted", label: "Not set up" }, actions: [] };
  }
  var where = (roadieSlskd ? "slskd from Roadie · " : "") + url;
  if (st === "ready") {
    var sub = "Connected as " + (rd.username || "?") + (rd.version ? " · slskd " + rd.version : "");
    if (tierNow !== "local") sub += " · on another computer";
    return { subtitle: sub, status: { variant: "success", label: "Ready" }, actions: open };
  }
  if (st === "unreachable") {
    return roadieSlskd
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
  var header = viewHeaderFor(readiness, settings, roadie, tier, roadie.setup);
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
  lastServerState = p.kind === "ok" ? p.serverState : null;
  // Not ready → look for Roadie. It may hold the connection we lack, or say
  // that a managed slskd was removed. A changed connection is re-probed once.
  // A Roadie-managed slskd is asked even when ready (cached, one short exec
  // a minute at most): its port can move, and Settings shows its login-item
  // choice.
  // The first run looks for slskd by itself first; Roadie comes in only once
  // nothing was found (it is then one way to install slskd).
  var firstRunLooking = p.kind === "unconfigured" && discovery.state !== "none";
  if (!firstRunLooking && (p.kind !== "ok" || settings.managedBy === "roadie" || p.isLoggedIn === false)) {
    try {
      await probeRoadie();
      if (await reconcileRoadie(p.kind)) p = await probe();
    } catch (e) {
      console.error("slskd: Roadie probe failed:", e);
    }
  }
  var next = nextReadiness(p, readiness);
  readiness = {
    state: next.state,
    detail: next.detail,
    username: next.username,
    version: next.version,
    shareCount: next.shareCount
  };
  tier = detectTier(settings.url, settings.tierOverride);

  api.ui.setBadge(VIEW_ID, badgeFor(next.state));

  try {
    await refreshSigninWhy();
  } catch (e) {
    console.error("slskd: couldn't read why slskd is signed out:", e);
    signinWhy = null;
  }

  if (next.state === "ready" && !downloadsDir) await loadDownloadsDir();
  if (next.state === "ready" || settings.managedBy === "roadie") await loadCollections();
  await rescanSharesIfPending();
  await loadSlskdShared();

  // Sharing drives queue priority. A leeching setup produces slow downloads that
  // read as "this plugin is broken", so say it once, informationally.
  if (next.state === "ready" && readiness.shareCount === 0 && !sharesWarned) {
    sharesWarned = true;
    await api.storage.set("sharesWarned", true);
    var canShare = settings.managedBy === "roadie" && shareGap(localCollections, roadie.tool).length > 0;
    api.ui.showNotification("slskd isn't sharing any folders. Soulseek prioritises users who share, so downloads may be slow or queue for a long time.",
      canShare ? { action: { label: "Share collections", id: "roadie-share-collections" } } : undefined);
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
      return done === null ? null : rankResults(done, prefs || {});
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
  if (!query || readiness.state !== "ready") return;
  var gen = ++searchGen;
  var mode = (extra && extra.mode) || null;
  search = { query: query, id: null, running: true, responseCount: 0, fileCount: 0, matchCount: 0, folderCount: 0, results: [], folders: [], error: null, sortColumn: null, sortDir: "desc", mode: mode };
  // Filling an album is a folder job — Soulseek users share whole albums — so
  // that mode opens on the Folders view; everything else opens on Files.
  activeTab = mode && mode.kind === "fill" ? "folders" : "search";
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
      length: files[i].length != null ? files[i].length : null
    };
    if (extra.upgrade) rec.upgrade = extra.upgrade;
    tracked[username + KEY_SEP + files[i].filename] = rec;
    queued.push(files[i]);
  }
  await api.storage.set("tracked", tracked);
  schedulePoll(true);
  return { queued: queued, failures: failures };
}

// View-side wrapper: notification, switch to the Downloads tab.
async function enqueueFiles(username, files, label, recExtra) {
  var out;
  try {
    out = await enqueueBatch(username, files, label, undefined, recExtra);
  } catch (e) {
    api.ui.showNotification((e && e.message) || "Couldn't start the download.");
    return false;
  }
  var n = out.queued.length;
  var msg = n === 0 ? "slskd refused every file" : (n === 1 ? "Queued 1 file from " + username : "Queued " + n + " files from " + username);
  if (out.failures.length) msg += " · " + out.failures.length + " refused";
  api.ui.showNotification(msg + ".");
  activeTab = "transfers";
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
  return flat;
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
    await api.storage.set("tracked", tracked);
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
      }
      return api.storage.set("tracked", tracked);
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
  await api.storage.set("tracked", tracked);
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
  render();
}

function renderIfFallback() {
  if (activeTab === "fallback") render();
}

function recordSharer(username, event, bytes) {
  // With slskd's own folder misconfigured every download fails here; that
  // says nothing about the sharer, so don't let it sink their standing.
  if (event === "failed" && misconfiguredSlskdDir(downloadsDir, incompleteDir)) return;
  noteSharer(sharers, username, event, bytes);
  api.storage.set("sharers", sharers).catch(function (e) { console.error("slskd: couldn't save the sharer ledger:", e); });
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
    await api.storage.set("fallback", fallback);
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
    await api.storage.set("tracked", tracked);
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
      ranked = await performSearch(query, viewPrefs({ knownDurationSecs: durationSecs }), null, null, searchDeadline);
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
    var matches = rankFallback(ranked, title, artistName, preferred, mode);
    rec.candidates = matches.slice(0, FALLBACK_VIEW_CANDIDATES);
    settleSearch(ranked.length + " downloadable file" + (ranked.length === 1 ? "" : "s") + ", " + matches.length + " that match" +
      (ranked.partial ? " (cut at " + Math.round(FALLBACK_SEARCH_MS / 1000) + "s while slskd was still searching)" : ""), matches.length ? "info" : "warn");
    if (!matches.length) {
      // Say when it was the quality setting, not the song, that came up empty —
      // "nothing matched" would send the user looking in the wrong place.
      var unfiltered = fallbackModeFilters(mode) ? rankFallback(ranked, title, artistName, preferred, "best").length : 0;
      finishResolve(rec, "no-match", unfiltered
        ? "no " + (mode === "lossless" ? "lossless" : "MP3 320 / V0") + " file — " + unfiltered + " other matching file" + (unfiltered === 1 ? "" : "s") + " skipped by the Fallback quality setting"
        : (ranked.length ? "nothing on Soulseek matched the title and artist closely enough" : "nothing on Soulseek matched"));
      return null;
    }

    // 3. Fetch — hedged. See `raceSharers`.
    var race = await raceSharers(rec, matches, { fkey: fkey, title: title, artistName: artistName, query: query, deadline: deadline });
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

async function deleteFallbackFile(fkey) {
  var entry = fallback[fkey];
  if (!entry) return;
  var rec = tracked[entry.ref];
  if (rec && rec.b64) {
    var res = await slskd("DELETE", "/api/v0/files/downloads/directories/" + rec.b64);
    if (res.status === 403) throw new Error(REMOTE_FILE_MANAGEMENT_HINT);
    if (!((res.status >= 200 && res.status < 300) || res.status === 404)) {
      throw new Error(errorText(res, "slskd couldn't delete that file (HTTP " + res.status + ")."));
    }
  } else if (rec) {
    throw new Error("That file's folder can't be addressed through slskd's API; delete it from slskd's downloads folder by hand.");
  }
  var t = transferByKey(entry.ref);
  if (t) {
    try { await cancelTransfer(t, true); } catch (e) { console.error("slskd: couldn't drop the transfer record:", e); }
  }
  delete tracked[entry.ref];
  delete fallback[fkey];
  await api.storage.set("tracked", tracked);
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
// Roadie (https://github.com/outcast1000/roadie) installs, runs and updates
// slskd for the user, and asks them in its own dialog before each install
// and before handing this plugin a key. Viboplr carries Roadie's command-line
// release as a managed dependency (Settings → Dependencies; the host passes
// Viboplr's own --data-dir on every call), and the plugin drives it through
// api.system.exec:
//
//   roadie tool status slskd                        installed? running? approved?
//   roadie tool install slskd --consumer viboplr    one approval installs + grants our key
//   roadie tool connection slskd --consumer viboplr { url, apiKey } once granted
//   roadie tool start slskd
//
// Nothing here runs an install without the user's click, and Roadie's dialog
// is the consent on top of that. A host without Roadie in its dependency
// registry answers getDependency("roadie") with null, and then none of this
// shows: the setup guide stays the way to get slskd.
// ---------------------------------------------------------------------------

var ROADIE_DEP = "roadie";
var ROADIE_CONSUMER = "viboplr";
var ROADIE_AS = "Viboplr";
var ROADIE_STATUS_TTL_MS = 30000;

// supported: the host can provide Roadie; installed: the binary is present;
// tool: the last `tool status slskd` answer; job: an install/start the user
// started ({ kind, line, percent, cancel }); error: the last failure, shown
// until the next attempt.
var roadie = { supported: false, installed: false, tool: null, checkedAt: 0, job: null, error: null, setup: null, other: null };
// What slskd itself shares, read from slskd when it owns its settings (Roadie
// 0.6+ setup); null when not read (then Roadie's record is used).
var slskdShared = null;
// Typed into the install form; memory only, dropped once the install ends.
// `autostart` is the user's answer to "start slskd at login" — off unless
// they turn it on, because on means a login item (and macOS says so).
// `shareCollections`: share the user's Viboplr collections on Soulseek — on
// unless they turn it off. Soulseek queues people who share nothing behind
// everyone else, and a music library is the obvious thing to share.
var roadieCreds = { username: "", password: "", autostart: false, shareCollections: true };

// Pure: the CLI prints one JSON document on stdout, whatever the exit code.
function parseRoadieJson(stdout) {
  try { return JSON.parse(String(stdout || "").trim()); } catch (e) { return null; }
}

// Pure: a `roadie: …` progress line on stderr → what the view shows.
function roadieProgress(line) {
  var s = String(line || "").trim().replace(/^roadie:\s*/, "");
  if (!s) return null;
  if (/asking the user/i.test(s)) return { text: "Waiting for you to approve it in Roadie's dialog…", percent: null };
  var m = /^downloading (\d+)%/.exec(s);
  if (m) return { text: "Downloading slskd…", percent: Number(m[1]) };
  return { text: s.charAt(0).toUpperCase() + s.slice(1) + "…", percent: null };
}

// Pure: the arguments of the install, account values included when typed.
// "Start at login" is always sent, so the recipe's own default (on) never
// decides it for the user.
// `shareDirs`: extra folders slskd shares, sent as a JSON array under slskd's
// own setting name (the recipe's `configuration` entry `shares.directories`,
// added to the downloads folder); null or empty sends nothing.
var SHARES_ENTRY = "shares.directories";

function roadieInstallArgs(creds, shareDirs) {
  var args = ["tool", "install", "slskd", "--consumer", ROADIE_CONSUMER];
  var user = creds && String(creds.username || "").trim();
  var pass = creds && String(creds.password || "");
  if (user) args.push("--set", "soulseekUsername=" + user);
  if (pass) args.push("--set", "soulseekPassword=" + pass);
  args.push("--set", "autostart=" + (creds && creds.autostart ? "true" : "false"));
  if (shareDirs && shareDirs.length) args.push("--set", SHARES_ENTRY + "=" + JSON.stringify(shareDirs));
  return args;
}

// Pure: this Roadie's slskd recipe opens `shares.directories`. Older ones
// (before Roadie 0.3.0) reject an unknown key and would fail the install, so
// the folders go only where the entry shows up in `tool status`.
function roadieCanShareDirs(tool) {
  return !!(tool && tool.config && Array.isArray(tool.config[SHARES_ENTRY]));
}

// Pure: what the install sends as shared folders.
function installShareDirs(creds, tool, collections) {
  if (!creds || !creds.shareCollections || !roadieCanShareDirs(tool)) return null;
  var paths = collectionPaths(collections);
  return paths.length ? paths : null;
}

// Pure: the message for a CLI run that did not succeed.
function roadieFailure(code, json, stderr) {
  if (code === 2) return "You declined it in Roadie's dialog.";
  var msg = json && (json.error || json.note || (json.result && json.result.error));
  if (!msg) {
    var lines = String(stderr || "").trim().split("\n");
    msg = lines[lines.length - 1].replace(/^roadie:\s*/, "");
  }
  // Roadie 0.6+ gets slskd's recipe from its online catalog; without one
  // cached (first run, offline) it doesn't know slskd yet.
  if (/^unknown (tool|recipe):?\s*slskd\b/i.test(String(msg || ""))) {
    return "Roadie couldn't load slskd's setup from its online catalog. Check your internet connection, then try again.";
  }
  return msg || "Roadie exited with code " + code + ".";
}

async function roadieExec(args, opts) {
  var res = await api.system.exec(ROADIE_DEP, ["--as", ROADIE_AS].concat(args), opts);
  return { code: res.exitCode, json: parseRoadieJson(res.stdout), stderr: res.stderr };
}

// What the host has of Roadie, then (cached for a while) what Roadie says
// about slskd. Runs on every not-ready readiness pass and when the view asks.
async function probeRoadie(force) {
  if (!api.system || typeof api.system.getDependency !== "function") {
    roadie.supported = false;
    return roadie;
  }
  var dep = null;
  try { dep = await api.system.getDependency(ROADIE_DEP); } catch (e) { dep = null; }
  roadie.supported = !!dep;
  roadie.installed = !!(dep && dep.installed);
  if (!roadie.installed) {
    roadie.tool = null;
    return roadie;
  }
  if (!force && roadie.tool && Date.now() - roadie.checkedAt < ROADIE_STATUS_TTL_MS) return roadie;
  var r = await roadieExec(["tool", "status", "slskd"]);
  roadie.tool = r.code === 0 ? r.json : null;
  roadie.checkedAt = Date.now();
  if (roadie.tool && !roadie.tool.installed) await probeOtherInstance();
  else roadie.other = null;
  return roadie;
}

// Before an install: does another slskd already run here? Roadie 0.6+ says
// so in `tool options`; an older Roadie has no such command and says nothing.
async function probeOtherInstance() {
  try {
    var r = await roadieExec(["tool", "options", "slskd"]);
    roadie.other = r.code === 0 && r.json ? r.json.otherInstance || null : null;
  } catch (e) {
    console.error("slskd: Roadie options failed:", e);
    roadie.other = null;
  }
}

// Pure: what to do with Roadie's answer about slskd.
//   "connect" — fetch the address + key from Roadie and use them
//   "release" — Roadie says slskd is gone; forget the managed connection
//   null      — leave the user's settings alone
// A user-typed address (managedBy null with a url) is never overwritten, and
// Roadie saying nothing (status null) never releases anything. "connect" is
// only answered once Viboplr is approved, so the automatic path never makes
// Roadie open a dialog the user didn't ask for.
//   "rekey"   — slskd rejects the managed key: Roadie's slskd changed it (its
//               recipe moved to one shared key); read the connection again
// `probeKind` is the last probe's kind ("unauthorized" when slskd said 401).
function roadieAutoConfigAction(cfg, status, probeKind) {
  if (!status) return null;
  var managed = cfg.managedBy === "roadie";
  if (managed && status.installed === false) return "release";
  if (!status.installed) return null;
  var approved = Array.isArray(status.approvedConsumers) && status.approvedConsumers.indexOf(ROADIE_CONSUMER) >= 0;
  if (!approved) return null;
  if (managed && status.url && cfg.url !== status.url) return "connect";
  if (managed) return probeKind === "unauthorized" ? "rekey" : null;
  if (!cfg.url) return "connect";
  return null;
}

// { url, apiKey } for Viboplr. When Viboplr isn't approved yet Roadie asks
// the user first, so call this only from a click or once approved.
async function fetchRoadieConnection() {
  var r = await roadieExec(["tool", "connection", "slskd", "--consumer", ROADIE_CONSUMER]);
  if (r.code !== 0 || !r.json || !r.json.url) return { ok: false, code: r.code, reason: roadieFailure(r.code, r.json, r.stderr) };
  return { ok: true, url: r.json.url, apiKey: r.json.apiKey || "" };
}

async function adoptRoadieConnection(reason) {
  var c = await fetchRoadieConnection();
  if (!c.ok) {
    console.error("slskd: Roadie connection failed:", c.reason);
    roadie.error = c.reason;
    return false;
  }
  settings.url = c.url;
  settings.apiKey = c.apiKey;
  settings.insecure = false;
  settings.managedBy = "roadie";
  await Promise.all([
    api.storage.set("url", settings.url),
    api.storage.set("apiKey", settings.apiKey),
    api.storage.set("insecure", false),
    api.storage.set("managedBy", "roadie")
  ]).catch(function (e) { console.error("slskd: couldn't save Roadie connection:", e); });
  api.log("info", "connected to slskd through Roadie (" + reason + ") at " + c.url, "slskd");
  downloadsDir = null;
  incompleteDir = null;
  roadie.error = null;
  return true;
}

async function releaseRoadieConnection() {
  settings.url = "";
  settings.apiKey = "";
  settings.managedBy = null;
  await Promise.all([
    api.storage.set("url", ""),
    api.storage.set("apiKey", ""),
    api.storage.set("managedBy", null)
  ]).catch(function (e) { console.error("slskd: couldn't clear Roadie connection:", e); });
  api.log("info", "Roadie reports slskd removed — connection forgotten", "slskd");
}

// The key a "rekey" last fetched and slskd still refused: asked once per key,
// so a key that really is wrong ends in the "Key rejected" screen, not a loop.
var rekeyTried = null;

// Apply `roadieAutoConfigAction` to the live state. Returns true when the
// settings changed (the caller re-probes slskd).
async function reconcileRoadie(probeKind) {
  var action = roadieAutoConfigAction(settings, roadie.tool, probeKind);
  if (action === "connect") return adoptRoadieConnection("auto");
  if (action === "rekey") {
    if (rekeyTried === settings.apiKey) return false;
    rekeyTried = settings.apiKey;
    var before = settings.apiKey;
    var ok = await adoptRoadieConnection("slskd's key changed");
    return ok && settings.apiKey !== before;
  }
  if (action === "release") { await releaseRoadieConnection(); return true; }
  return false;
}

// Run one Roadie command the user asked for, with a Cancel. `onLine` gets
// each progress line on stderr; without one the line lands in `roadie.job`
// for the view. Resolves with the CLI's { code, json, stderr }, or null when
// cancelled or when another one is already running.
async function runRoadieJob(kind, args, firstLine, onLine) {
  if (roadie.job) return null;
  roadie.error = null;
  roadie.job = { kind: kind, line: firstLine, percent: null, cancel: null };
  render();
  try {
    return await roadieExec(args, {
      onStart: function (handle) {
        if (roadie.job) roadie.job.cancel = handle && handle.cancel;
        render();
      },
      onOutput: function (line, stream) {
        if (stream !== "stderr" || !roadie.job) return;
        if (onLine) { onLine(line); render(); return; }
        var p = roadieProgress(line);
        if (!p) return;
        roadie.job.line = p.text;
        roadie.job.percent = p.percent;
        render();
      }
    });
  } catch (e) {
    if (String(e && e.message || e) === "Cancelled") return null;
    throw e;
  } finally {
    roadie.job = null;
    render();
  }
}

// ---- Setting slskd up with Roadie: one screen, one checklist -------------
//
// While `roadie.setup` is set the view shows nothing but this (render()), so
// the address/key fields and the guide stay out of the way until it ends.
// Each step moves on only on a signal we really have: Roadie's stderr
// ("asking the user…", "downloading N%", "extracting" / "verifying"), its
// exit code, its status of slskd, our own connection, and slskd's server
// state. Starting slskd is the one inferred step: Roadie reports nothing
// between verifying and exiting.

var SETUP_STEPS = [
  { id: "approve", label: "Approve in Roadie's dialog" },
  { id: "download", label: "Download slskd" },
  { id: "unpack", label: "Unpack and check it" },
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

// Pure: which step a Roadie progress line means, and the percent if any.
function setupStepForLine(line) {
  var s = String(line || "").replace(/^roadie:\s*/, "").trim().toLowerCase();
  if (/^asking the user/.test(s)) return { step: "approve" };
  var m = /^downloading(?: (\d+)%)?/.exec(s);
  if (m) return { step: "download", percent: m[1] != null ? Number(m[1]) : null };
  if (/^(extracting|verifying)/.test(s)) return { step: "unpack" };
  return null;
}

// Pure: the checklist rows — { id, label, state: done|active|failed|pending, detail }.
function setupChecklist(s) {
  return SETUP_STEPS.map(function (step, i) {
    var state = i < s.at ? "done" : (i > s.at ? "pending" : (s.failed ? "failed" : "active"));
    var label = step.label;
    if (step.id === "signin" && s.username) label = "Sign in to Soulseek as " + s.username;
    var detail = null;
    if (state === "failed") detail = s.failed.message;
    else if (state === "active" && step.id === "approve") detail = "Roadie is showing a dialog. It may be behind this window.";
    else if (state === "active" && step.id === "download" && s.percent != null) detail = s.percent + "%";
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

// 1000 lines: a slskd whose key is being refused writes a warning a minute,
// which buries the sign-in lines that say what went wrong.
async function slskdLogLines() {
  try {
    var r = await roadieExec(["tool", "logs", "slskd", "--lines", "1000"]);
    return r.code === 0 && r.json && Array.isArray(r.json.lines) ? r.json.lines : [];
  } catch (e) {
    console.error("slskd: couldn't read slskd's log through Roadie:", e);
    return [];
  }
}

async function installSlskdWithRoadie() {
  // The button is disabled without an account; Enter in the password field
  // is the other way here.
  if (!roadieCredsComplete(roadieCreds) || roadie.setup) return;
  var s = newSetup(roadieCreds.username);
  roadie.setup = s;
  var r;
  try {
    r = await runRoadieJob("install", roadieInstallArgs(roadieCreds, installShareDirs(roadieCreds, roadie.tool, localCollections)), "", function (line) {
      var hit = setupStepForLine(line);
      if (!hit) return;
      advanceSetup(s, hit.step);
      if (hit.percent != null && s.at === setupIndex("download")) s.percent = hit.percent;
    });
  } catch (e) {
    console.error("slskd: Roadie install failed:", e);
    failSetup(s, String(e && e.message || e));
    render();
    return;
  }
  if (roadie.setup !== s) return;
  if (!r) {
    // Cancelled: back to the form, with what the user typed still in it.
    roadie.setup = null;
    render();
    return;
  }
  if (r.code !== 0) {
    failSetup(s, roadieFailure(r.code, r.json, r.stderr));
    api.log("warn", "Roadie install of slskd: " + s.failed.message, "slskd");
    render();
    return;
  }
  roadieCreds = { username: "", password: "", autostart: false, shareCollections: true };
  api.log("info", "slskd installed through Roadie", "slskd");
  await continueSetup(s, "start");
}

// The steps after Roadie's install ends; also what Try again re-runs from
// the failed step. Anything that throws fails the step it happened on, so
// the checklist can never be left spinning.
async function continueSetup(s, from) {
  try {
    await continueSetupSteps(s, from);
  } catch (e) {
    console.error("slskd: Roadie setup step failed:", e);
    if (roadie.setup !== s) return;
    failSetup(s, "Something went wrong: " + String(e && e.message || e));
    render();
  }
}

async function continueSetupSteps(s, from) {
  s.failed = null;
  s.at = Math.min(s.at, setupIndex(from));
  advanceSetup(s, from);
  if (s.at === setupIndex("start")) {
    render();
    await probeRoadie(true);
    if (roadie.setup !== s) return;
    var t = roadie.tool;
    if (!t || !t.running) {
      failSetup(s, (t && t.conflictDetail) || "slskd didn't start. Roadie's log for it has the reason.");
      render();
      return;
    }
    advanceSetup(s, "connect");
  }
  if (s.at === setupIndex("connect")) {
    render();
    // The one approval also granted Viboplr its key, so this asks nothing.
    var ok = await adoptRoadieConnection("install");
    if (roadie.setup !== s) return;
    if (!ok) {
      failSetup(s, roadie.error || "Roadie didn't hand over the connection.");
      render();
      return;
    }
    advanceSetup(s, "signin");
  }
  render();
  var started = Date.now();
  var until = started + SIGNIN_WAIT_MS;
  for (var polls = 1; ; polls++) {
    await refreshReadiness();
    if (roadie.setup !== s) return;
    if (readiness.state === "ready") {
      api.log("info", "slskd set up through Roadie and signed in as " + (readiness.username || "?"), "slskd");
      roadie.setup = null;
      render();
      renderSettings();
      return;
    }
    s.progress = signinProgress(lastServerState, Math.round((Date.now() - started) / 1000));
    // A refused sign-in won't fix itself by waiting: look for one every few
    // polls and stop at once.
    if (polls % 5 === 0) {
      var early = signinReasonFromLog(await slskdLogLines(), s.username);
      if (roadie.setup !== s) return;
      if (early && early.kind === "rejected") {
        failSetup(s, early.message);
        render();
        return;
      }
    }
    render();
    if (Date.now() >= until) break;
    await sleep(SIGNIN_POLL_MS);
    if (roadie.setup !== s) return;
  }
  var reason = signinReasonFromLog(await slskdLogLines(), s.username);
  if (roadie.setup !== s) return;
  failSetup(s, reason ? reason.message : signinFailure(readiness.state, s.username));
  render();
}

// The whole view while a setup runs.
function setupProgressView() {
  var s = roadie.setup;
  var glyph = { done: "✓", active: "●", failed: "✗", pending: "○" };
  var children = [{ type: "text", content: "Setting up slskd with Roadie", className: "plugin-heading" }];
  var rows = setupChecklist(s);
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    children.push({ type: "text", content: glyph[row.state] + "  " + row.label, className: row.state === "pending" ? "plugin-muted" : undefined });
    if (row.id === "download" && row.state === "active" && s.percent != null) {
      children.push({ type: "progress-bar", value: s.percent, max: 100 });
    } else if (row.detail) {
      children.push({ type: "text", content: row.detail, className: "plugin-muted" });
    }
  }
  var buttons = [];
  if (s.failed) {
    var step = s.failed.step;
    if (step === "approve" || step === "download" || step === "unpack") {
      buttons.push({ label: "Back", action: "roadie-setup-close", variant: "accent" });
    } else {
      buttons.push({ label: step === "signin" ? "Check again" : "Try again", action: "roadie-setup-retry", variant: "accent" });
      buttons.push({ label: "Close", action: "roadie-setup-close", variant: "secondary" });
    }
  } else if (roadie.job && roadie.job.cancel) {
    buttons.push({ label: "Cancel", action: "roadie-cancel", variant: "secondary" });
  }
  if (buttons.length) {
    children.push({ type: "spacer" });
    children.push({ type: "toolbar", buttons: buttons });
  }
  return { type: "layout", direction: "vertical", children: children };
}

// Started from the view (the banner or the Settings tab), so the progress and
// any failure show there, under the banner. Success is the banner clearing.
async function startSlskdWithRoadie() {
  var r;
  try {
    r = await runRoadieJob("start", ["tool", "start", "slskd"], "Starting slskd…");
  } catch (e) {
    console.error("slskd: Roadie start failed:", e);
    roadie.error = String(e && e.message || e);
    render();
    return;
  }
  if (!r) return;
  if (r.code !== 0) {
    roadie.error = roadieFailure(r.code, r.json, r.stderr);
    render();
    return;
  }
  roadie.tool = r.json;
  roadie.checkedAt = Date.now();
  await awaitSlskdUp("start");
}

// How long slskd may say "Disconnected" after it first answers before the
// wait takes that as the answer: right after a start it can report it for a
// moment before it begins to connect.
var START_SETTLE_MS = 10000;

// `roadie tool start` / `restart` exits as soon as slskd's process is up, but
// slskd opens its web port a few seconds later and signs in to Soulseek after
// that. A single readiness pass right after the exit found nothing, so the
// view said "not running" until the next minute's poll — and a second Start
// (a no-op on a running slskd) then looked like the fix. Keep the job showing
// and look again every couple of seconds until slskd answers and settles, or
// the wait runs out (the minute's poll carries on from there).
// The wait in progress; deactivate() drops it so the loop ends.
var startWait = null;

async function awaitSlskdUp(kind) {
  var job = { kind: kind, line: "Waiting for slskd to answer…", percent: null, cancel: null };
  var token = {};
  startWait = token;
  roadie.job = job;
  render();
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
      job.line = st === "unreachable" ? "Waiting for slskd to answer…" : "Waiting for slskd to sign in to Soulseek…";
      render();
      await sleep(SIGNIN_POLL_MS);
      if (startWait !== token) return;
    }
  } finally {
    if (startWait === token) startWait = null;
    if (roadie.job === job) {
      roadie.job = null;
      render();
    }
  }
}

// Pure: what the "Install automatically" page can offer, given what we know
// about Roadie.
//   "unsupported" — this host can't provide Roadie; only the manual guide works
//   "get-roadie"  — Roadie itself isn't installed yet; the host's modal gets it
//   "busy"        — a Roadie command the user started is running
//   "adopt"       — Roadie already has slskd; connecting is all that's left
//   "form"        — the account form that installs slskd
function autoInstallStage(r) {
  if (!r || !r.supported) return "unsupported";
  if (!r.installed) return "get-roadie";
  if (r.job) return "busy";
  if (r.tool && r.tool.installed) return "adopt";
  return "form";
}

// Pure: Roadie has an slskd this plugin isn't connected to — the quickest way
// forward from any not-found screen, so it's offered first.
function roadieHasUnusedSlskd(cfg, r) {
  return !!(r && r.supported && r.installed && r.tool && r.tool.installed && cfg.managedBy !== "roadie");
}

// Pure: slskd can't sign in, and so can't search, without both.
function roadieCredsComplete(creds) {
  return !!(creds && String(creds.username || "").trim() && String(creds.password || ""));
}

function roadieInstallSection() {
  return {
    type: "section",
    title: "Your Soulseek setup",
    children: [
      mutedText("Your account goes into slskd's own settings file; the plugin doesn't keep it."),
      { type: "settings-row", label: "Soulseek username",
        control: { type: "text-input", placeholder: "username", action: "roadie-set-user", value: roadieCreds.username } },
      { type: "settings-row", label: "Soulseek password",
        control: { type: "text-input", placeholder: "password", action: "roadie-set-pass", password: true, value: roadieCreds.password } },
      mutedText("No account yet? Soulseek has no sign-up page: choose a username nobody else uses and a password, and the account is created the first time slskd signs in. Keep the password somewhere safe; Soulseek can't reset it."),
      autostartRow("roadie-set-autostart", roadieCreds.autostart)
    ].concat(shareCollectionsRows(), [
      { type: "button", label: "Install slskd", action: "roadie-install", variant: "accent", disabled: !roadieCredsComplete(roadieCreds) }
    ])
  };
}

// ---- Sharing the user's collections through Roadie ----------------------
//
// New installs share every local collection (the install form's switch, on
// by default). An slskd installed before Roadie opened `shares.directories`
// (0.3.0), or a collection added since, is left out; the card says which and
// offers one click. The click is an install request for the same slskd with
// the new folder list, so Roadie's dialog shows the folders before anything
// is shared: nothing becomes public without that approval, and the plugin
// never raises the dialog on its own.

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

// Pure: the collection folders slskd doesn't share yet, given what Roadie
// shares (its `shares.directories`) and, when shared, the downloads folder.
// `sharedNow`: what slskd itself shares, when it owns its settings.
function shareGap(collections, tool, sharedNow) {
  if (!tool || !roadieCanShareDirs(tool)) return [];
  var shared;
  if (slskdOwnsSettings(tool)) {
    if (!Array.isArray(sharedNow)) return []; // not read yet: claim no gap
    shared = sharedNow.slice();
  } else {
    shared = (tool.config["shares.directories"] || []).slice();
    if (tool.config.shareDownloads && tool.config.downloadsDir) shared.push(tool.config.downloadsDir);
  }
  return collectionPaths(collections).filter(function (p) {
    return !shared.some(function (d) { return isUnder(p, d); });
  });
}

// Pure: the list sent to Roadie: what it shares now plus the gap. Adding
// only: a folder the user shared some other way is never dropped.
function sharedDirsWith(tool, gap) {
  var current = (tool && tool.config && tool.config["shares.directories"]) || [];
  var out = current.slice();
  for (var i = 0; i < gap.length; i++) if (out.indexOf(gap[i]) < 0) out.push(gap[i]);
  return out;
}

// { error } of the last attempt, shown on the row until the next one.
var roadieShare = { error: null };
// A rescan owed to slskd once it answers again: Roadie restarts it with the
// new folders, and it may restore its share list from a backup instead of
// scanning them.
var rescanPending = false;

// Pure: the Sharing row(s) on the card. `sharedNow`: slskd's own list, when
// it owns its settings. `share.confirm`: the folders the user is about to
// make public, waiting for their yes (slskd-owned settings: no Roadie dialog
// asks, so this does).
function sharingRows(tool, collections, job, share, sharedNow) {
  if (!tool || !roadieCanShareDirs(tool)) return [];
  if (job && job.kind === "share") {
    var running = [mutedText(job.line)];
    if (job.cancel) running.push(buttonRow([actionButton("Cancel", "roadie-cancel")]));
    return running;
  }
  if (share && share.confirm && share.confirm.length) {
    return [{ type: "settings-row", label: "Share these folders?", description: describeFolders(share.confirm) + ". Everyone on Soulseek can browse and download what you share. slskd saves this in its own settings; you can stop sharing a folder there later." },
      buttonRow([actionButton("Share", "roadie-share-confirm", "accent"), actionButton("Cancel", "roadie-share-cancel")])];
  }
  var owned = slskdOwnsSettings(tool);
  var gap = shareGap(collections, tool, sharedNow);
  var rows;
  if (owned && gap.length === 0 && Array.isArray(sharedNow)) {
    rows = [{ type: "settings-row", label: "Sharing", description: sharedNow.length ? "Shared: " + describeFolders(sharedNow) + "." : "Nothing is shared." }];
  } else if (owned && !Array.isArray(sharedNow)) {
    rows = [];
  } else if (gap.length) {
    rows = [optionRow("Sharing", "Not shared yet: " + describeFolders(gap) + ". Everyone on Soulseek can browse and download what you share, and Soulseek serves people who share first.",
      actionButton("Share…", "roadie-share-collections", "accent", { disabled: !!job }))];
  } else {
    var dirs = sharedDirsWith(tool, []);
    if (tool.config.shareDownloads && tool.config.downloadsDir) dirs = [tool.config.downloadsDir].concat(dirs);
    rows = [{ type: "settings-row", label: "Sharing", description: dirs.length ? "Shared: " + describeFolders(dirs) + "." : "Nothing is shared." }];
  }
  if (share && share.error) {
    rows.push(mutedText((owned ? "" : "Roadie: ") + share.error));
    if (share.manual) rows.push(buttonRow([actionButton("Open slskd's settings", "open-slskd")]));
  }
  return rows;
}

async function shareCollectionsWithRoadie() {
  await loadCollections();
  var tool = roadie.tool;
  var gap = shareGap(localCollections, tool, slskdShared);
  if (!gap.length) { render(); return; }
  if (slskdOwnsSettings(tool)) {
    // No Roadie dialog lists the folders on this path, so the card asks.
    roadieShare = { error: null, confirm: gap };
    render();
    return;
  }
  roadieShare = { error: null };
  var args = ["tool", "install", "slskd", "--set", SHARES_ENTRY + "=" + JSON.stringify(sharedDirsWith(tool, gap))];
  var r;
  try {
    r = await runRoadieJob("share", args, "Waiting for you to approve it in Roadie's dialog…");
  } catch (e) {
    console.error("slskd: Roadie share change failed:", e);
    roadieShare.error = String(e && e.message || e);
    render();
    return;
  }
  if (!r) return;
  if (r.code !== 0) {
    roadieShare.error = roadieFailure(r.code, r.json, r.stderr);
    api.log("warn", "Roadie share change: " + roadieShare.error, "slskd");
    render();
    return;
  }
  api.log("info", "sharing " + gap.length + " more folder(s) through Roadie", "slskd");
  rescanPending = true;
  await probeRoadie(true);
  await refreshReadiness();
}

// ---- When slskd owns its settings (Roadie 0.6+) -------------------------
//
// From slskd's revision-6 setup on, Roadie writes slskd's settings file once,
// at install, and then leaves it to slskd: `tool status` says
// `configurable: false`, and Roadie refuses to change the file again. Sharing
// more folders then goes through slskd's own settings API (its settings file,
// edited with slskd's validation) after the user confirms the folders here,
// and what slskd shares is read from slskd, not from Roadie's install-time
// record.

// Pure: Roadie hands slskd's settings to slskd after install.
function slskdOwnsSettings(tool) {
  return !!(tool && tool.installed && tool.configurable === false);
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

// Pure: a newer setup of slskd waiting for the user's review in Roadie
// (`tool status` → `recipeUpdate`, Roadie 0.6+): { from, to } or null.
function recipeUpdateInfo(tool) {
  var u = tool && tool.installed && tool.recipeUpdate;
  if (!u || !u.revision) return null;
  return { from: tool.revision || null, to: u.revision };
}

// Pure: Roadie found another slskd already running here (`tool options` →
// `otherInstance`, Roadie 0.6+): what the install page says about it.
function otherInstanceNodes(oi) {
  if (!oi || !oi.message) return [];
  var why = oi.blocksStart
    ? "slskd runs one copy per computer, so the one Roadie installs won't start while this one runs."
    : "The copy Roadie installs can't use the same port while this one runs.";
  return [{ type: "section", title: "slskd is already running here", children: [
    mutedText("Something answers as slskd on " + oi.url + ". " + why),
    mutedText("If it's your own slskd, connect Viboplr to it instead (you'll need its API key). Otherwise quit it, then install."),
    buttonRow([actionButton("Connect to it instead…", "roadie-use-other", "accent"), actionButton("Check again", "roadie-recheck-other")])
  ] }];
}

// What slskd shares, from slskd (its settings are its own). Quiet on failure:
// the Sharing row then just waits for the next pass.
async function loadSlskdShared() {
  if (!slskdOwnsSettings(roadie.tool) || readiness.state !== "ready") return;
  try {
    var res = await slskd("GET", "/api/v0/shares");
    if (res.status === 200) slskdShared = sharedFromSlskd(res.json);
  } catch (e) {
    console.error("slskd: reading its shares failed:", e);
  }
}

// slskd's settings API wants its web sign-in (an administrator), not the API
// key. A slskd Roadie installed hands that login to Viboplr with the
// connection; slskd's default is the fallback.
async function slskdAdminToken() {
  var login = null;
  try {
    var r = await roadieExec(["tool", "connection", "slskd", "--consumer", ROADIE_CONSUMER]);
    if (r.code === 0) login = webLoginFromRoadie(r.json);
  } catch (e) {
    console.error("slskd: reading the login from Roadie failed:", e);
  }
  login = login || SLSKD_DEFAULT_LOGIN;
  var res = await slskd("POST", "/api/v0/session", { username: login.username, password: login.password });
  if (res.status !== 200 || !res.json || !res.json.token) throw new Error("slskd didn't accept its web login (HTTP " + res.status + ")");
  return res.json.token;
}

// One call to slskd's settings API with the admin token; the body is a YAML
// document sent as a JSON string, which is what slskd's endpoints take.
async function slskdSettingsCall(method, path, token, yamlText) {
  var init = { method: method, headers: { "Authorization": "Bearer " + token, "Accept": "application/json" } };
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
  if (roadie.job) return;
  roadieShare = { error: null };
  roadie.job = { kind: "share", line: "Adding the folders to slskd's settings…", percent: null, cancel: null };
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
    roadieShare = { error: String(e && e.message || e), manual: !!(e && e.manual) };
  } finally {
    roadie.job = null;
  }
  await refreshReadiness();
  render();
}

// Roadie has a newer setup of slskd: the user reviews it in Roadie's dialog
// (`tool upgrade` proposes it, Roadie 0.6+). Afterwards the connection is read
// again, since a new setup may hand out a new key.
async function reviewRecipeUpdate() {
  var r;
  try {
    r = await runRoadieJob("recipe-update", ["tool", "upgrade", "slskd"], "Waiting for you to review it in Roadie's dialog…");
  } catch (e) {
    console.error("slskd: Roadie recipe update failed:", e);
    roadie.error = String(e && e.message || e);
    render();
    return;
  }
  if (!r) return;
  if (r.code === 2) { render(); return; } // declined: the offer stays until the next revision
  if (r.code !== 0) {
    roadie.error = roadieFailure(r.code, r.json, r.stderr);
    render();
    return;
  }
  api.log("info", "applied Roadie's new slskd setup", "slskd");
  await probeRoadie(true);
  if (settings.managedBy === "roadie") await adoptRoadieConnection("new slskd setup");
  slskdShared = null;
  await refreshReadiness();
}

// Pure: the card's row offering a newer slskd setup from Roadie.
function recipeUpdateRows(tool, job) {
  var u = recipeUpdateInfo(tool);
  if (!u) return [];
  if (job && job.kind === "recipe-update") {
    var running = [mutedText(job.line)];
    if (job.cancel) running.push(buttonRow([actionButton("Cancel", "roadie-cancel")]));
    return running;
  }
  return [optionRow("Update for slskd's setup",
    "Roadie has a newer way to run slskd" + (u.from ? " (setup " + u.from + " → " + u.to + ")" : "") + ". Roadie shows you what changes; nothing changes until you approve it.",
    actionButton("Review update…", "roadie-recipe-update", "accent", { disabled: !!job }))];
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

// The row that says which folders become public, with the way out. Absent
// when there is nothing to share or this Roadie can't take the list.
function shareCollectionsRows() {
  var paths = collectionPaths(localCollections);
  if (!paths.length || !roadieCanShareDirs(roadie.tool)) return [];
  return [{ type: "settings-row", label: "Share my Viboplr collections",
    description: (paths.length === 1 ? "1 folder: " : paths.length + " folders: ") + describeFolders(paths) +
      ". Other Soulseek users can browse and download from them; Soulseek serves people who share before those who don't. Your downloads folder is shared too.",
    control: { type: "toggle", label: "", action: "roadie-set-share", checked: !!roadieCreds.shareCollections } }];
}

function autostartRow(action, checked) {
  return { type: "settings-row", label: "Start slskd at login",
    description: "Off: slskd runs until you restart the computer; start it again from here. On: Roadie adds a login item that starts it, and macOS tells you so.",
    control: { type: "toggle", label: "", action: action, checked: !!checked } };
}

// Rows the Connection section adds when Roadie has slskd. Where its files
// are is shown whenever Roadie has one, connected or not: a user stuck on a
// rejected key is exactly the one looking for them. The login-item choice
// (`roadie tool autostart`) and Remove only when this plugin uses Roadie's
// slskd, since both act on that one.
function roadieManagedRows() {
  if (!roadie.installed || !roadie.tool || !roadie.tool.installed) return [];
  var managed = settings.managedBy === "roadie";
  return (managed ? [autostartRow("roadie-autostart", roadie.tool.autostart)] : [])
    .concat(roadieFileRows(roadie.tool, canOpenPaths(), roadieShowFiles))
    .concat(managed ? roadieRemoveRows(roadieRemove, roadie.job) : []);
}

// What the Connection section folds away: the file list, and (for Roadie's
// slskd) the address/key form Roadie filled in. Both stay out of the way of
// the one thing a not-ready screen is for, which is the fix at the top.
var roadieShowFiles = false;
var roadieShowDetails = false;

// Pure: the address the plugin talks to is Roadie's slskd: a loopback host
// on the port Roadie reports. "localhost:5030" typed by hand and Roadie's
// "127.0.0.1:5030" are the same slskd.
function isLoopbackHost(h) {
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}
function hostPort(u) {
  var m = /^\s*(https?):\/\/(\[[^\]]+\]|[^:\/]+)(?::(\d+))?/i.exec(String(u || ""));
  if (!m) return null;
  return { host: m[2].toLowerCase(), port: m[3] ? Number(m[3]) : (m[1].toLowerCase() === "https" ? 443 : 80) };
}
function roadieOwnsAddress(url, tool) {
  if (!tool || !tool.installed || !tool.url) return false;
  var a = hostPort(url), b = hostPort(tool.url);
  return !!(a && b && a.port === b.port && isLoopbackHost(a.host) && isLoopbackHost(b.host));
}

// Pure: Roadie has an slskd it will hand this plugin a key for without asking
// (Viboplr is already approved), so switching to it is one click.
function roadieCanHandOver(tool) {
  return !!(tool && tool.installed && Array.isArray(tool.approvedConsumers) && tool.approvedConsumers.indexOf(ROADIE_CONSUMER) >= 0);
}

// Why Roadie's slskd isn't signed in, read from its log on each readiness
// pass while it isn't: { kind, message } or null.
var signinWhy = null;

async function refreshSigninWhy() {
  if (readiness.state !== "disconnected") {
    signinWhy = null;
    return;
  }
  // slskd's own log endpoint answers with the key we already hold, so the
  // reason is there for any slskd, not only one Roadie runs. Roadie's copy
  // of the log is the fallback (an older slskd, or a key without access).
  var ours = roadie.installed && roadieOwnsAddress(settings.url, roadie.tool);
  var user = ours && roadie.tool.config && roadie.tool.config.soulseekUsername;
  var lines = await slskdApiLogLines();
  if (!lines.length && ours) lines = await slskdLogLines();
  signinWhy = signinReasonFromLog(lines, user ? String(user) : null);
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

// A kicked slskd stays signed out until it restarts. Quiet on success: the
// readiness pass that follows is the answer.
async function restartSlskdWithRoadie() {
  var r;
  try {
    r = await runRoadieJob("restart", ["tool", "restart", "slskd"], "Restarting slskd…");
  } catch (e) {
    console.error("slskd: Roadie restart failed:", e);
    roadie.error = String(e && e.message || e);
    render();
    return;
  }
  if (!r) return;
  if (r.code !== 0) {
    roadie.error = roadieFailure(r.code, r.json, r.stderr);
    render();
    return;
  }
  if (r.json && r.json.installed != null) { roadie.tool = r.json; roadie.checkedAt = Date.now(); }
  api.log("info", "slskd restarted through Roadie", "slskd");
  signinWhy = null;
  await awaitSlskdUp("restart");
}

// ---- Where Roadie keeps slskd --------------------------------------------
//
// Roadie's `tool status` names the install folder, the private data folder,
// the logs folder and the config file it renders (Roadie 0.5.0+; older ones
// send none of it and the rows stay away). The config file is revealed in its
// folder rather than opened: it holds the Soulseek password, and opening a
// .yml hands it to whatever editor is associated.

// Pure: the host can open and reveal local paths.
function canOpenPaths() {
  return !!(api && api.system && typeof api.system.openPath === "function" && typeof api.system.revealPath === "function");
}

// Pure: the locations Roadie reported, in the order a user looks for them.
// `reveal` selects the file in its folder instead of opening it.
function roadieFilePlaces(tool) {
  if (!tool) return [];
  var places = [];
  var files = Array.isArray(tool.configFiles) ? tool.configFiles : [];
  for (var i = 0; i < files.length; i++) {
    if (files[i] && files[i].path) places.push({ label: files.length > 1 ? "Settings file " + (i + 1) : "Settings file", path: files[i].path, reveal: true });
  }
  if (tool.installDir) places.push({ label: "Installed in", path: tool.installDir, reveal: false });
  if (tool.dataDir) places.push({ label: "Data folder", path: tool.dataDir, reveal: false });
  if (tool.logsDir) places.push({ label: "Logs", path: tool.logsDir, reveal: false });
  return places;
}

// Pure: one folded row, and when `open` one row per location with its button
// on the row itself.
function roadieFileRows(tool, canOpen, open) {
  if (!canOpen) return [];
  var places = roadieFilePlaces(tool);
  if (!places.length) return [];
  var rows = [optionRow("slskd's files", open ? "Where Roadie keeps slskd on this computer." : "Install folder, settings file, data and logs.",
    actionButton(open ? "Hide" : "Show", "roadie-files-toggle"))];
  if (!open) return rows;
  for (var j = 0; j < places.length; j++) {
    var p = places[j];
    var desc = p.reveal ? p.path + " — holds your Soulseek password, and Roadie rewrites it: change settings through Roadie, not here." : p.path;
    rows.push(optionRow(p.label, desc,
      actionButton(p.reveal ? "Show in folder" : "Open folder", "roadie-open-path", "secondary", { data: { path: p.path, reveal: p.reveal } })));
  }
  return rows;
}

async function openRoadiePath(path, reveal) {
  try {
    if (reveal) await api.system.revealPath(path);
    else await api.system.openPath(path);
  } catch (e) {
    console.error("slskd: couldn't open " + path + ":", e);
    api.ui.showNotification("Couldn't open " + path + ": " + String(e && e.message || e));
  }
}

// ---- Removing slskd through Roadie ---------------------------------------
//
// `roadie tool uninstall slskd` stops slskd, drops its login item and
// deletes its binaries; without --keep-data it also deletes the settings
// Roadie keeps for it (the Soulseek login, the web login) and every app's
// key. Folders slskd wrote to (downloads, shares) are never touched. The
// plugin offers the same two choices Roadie's own window does; Roadie's
// dialog is the confirmation on top of that, as for an install.
//
// asking: the choice is on screen; error: the last attempt's failure, kept
// until the next one (the Roadie dialog may have been missed).
var roadieRemove = { asking: false, error: null };

// Pure: the remove row in each state — idle, choosing, running, failed.
function roadieRemoveRows(rm, job) {
  if (job && job.kind === "uninstall") {
    var running = [mutedText(job.line)];
    if (job.cancel) running.push(buttonRow([actionButton("Cancel", "roadie-cancel")]));
    return running;
  }
  if (rm.asking) {
    return [
      { type: "settings-row", label: "Remove slskd?",
        description: "Roadie stops slskd and deletes it. Your downloads and shared folders stay where they are. Keeping the settings keeps your Soulseek login for a reinstall." },
      buttonRow([
        actionButton("Remove, keep settings", "roadie-remove", "accent", { data: { keepData: true } }),
        actionButton("Remove everything", "roadie-remove", "secondary", { data: { keepData: false } }),
        actionButton("Cancel", "roadie-remove-cancel")
      ])
    ];
  }
  var rows = [optionRow("Remove slskd", "Roadie installed it, so Roadie removes it. It asks you first.",
    actionButton("Remove…", "roadie-remove-ask", "secondary", { disabled: !!job }))];
  if (rm.error) rows.push(mutedText("Roadie: " + rm.error));
  return rows;
}

// Pure: the arguments of the uninstall.
function roadieUninstallArgs(keepData) {
  var args = ["tool", "uninstall", "slskd"];
  if (keepData) args.push("--keep-data");
  return args;
}

// Success says nothing: the view falls back to the setup hub, which is the
// answer. A decline or a failure stays under the button.
async function uninstallSlskdWithRoadie(keepData) {
  roadieRemove = { asking: false, error: null };
  var r;
  try {
    r = await runRoadieJob("uninstall", roadieUninstallArgs(keepData), "Waiting for you to approve it in Roadie's dialog…");
  } catch (e) {
    console.error("slskd: Roadie uninstall failed:", e);
    roadieRemove.error = String(e && e.message || e);
    render();
    return;
  }
  if (!r) return;
  if (r.code !== 0) {
    roadieRemove.error = roadieFailure(r.code, r.json, r.stderr);
    api.log("warn", "Roadie uninstall of slskd: " + roadieRemove.error, "slskd");
    render();
    return;
  }
  api.log("info", "slskd removed through Roadie" + (keepData ? " (settings kept)" : ""), "slskd");
  // Roadie said it's gone, so don't wait for the next status read to agree:
  // a stale "installed" would keep pointing the plugin at a dead address.
  webLogin = null;
  downloadsDir = null;
  incompleteDir = null;
  await releaseRoadieConnection();
  await probeRoadie(true);
  await refreshReadiness();
  render();
}

async function setRoadieAutostart(on) {
  var r = await roadieExec(["tool", "autostart", "slskd", on ? "on" : "off"]);
  if (r.code !== 0) {
    roadie.error = roadieFailure(r.code, r.json, r.stderr);
    api.ui.showNotification("Roadie couldn't change \"start at login\": " + roadie.error);
  } else {
    roadie.tool = r.json;
    roadie.checkedAt = Date.now();
    api.log("info", "slskd start-at-login " + (on ? "on" : "off") + " (Roadie)", "slskd");
  }
  render();
  renderSettings();
}

// A Roadie command in flight (its latest line and percent), or the last one's
// failure, which stays until the next attempt.
// An uninstall or a share change shows on its own row, not here.
function roadieJobNodes() {
  var nodes = [];
  if (roadie.job && (roadie.job.kind === "uninstall" || roadie.job.kind === "share")) return nodes;
  if (roadie.job) {
    nodes.push(mutedText(roadie.job.line));
    if (roadie.job.percent != null) nodes.push({ type: "progress-bar", value: roadie.job.percent, max: 100 });
    if (roadie.job.cancel) nodes.push(buttonRow([actionButton("Cancel", "roadie-cancel")]));
  } else if (roadie.error) {
    nodes.push(mutedText("Roadie: " + roadie.error));
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

// "slskd not found" — unconfigured (never connected) or unreachable (was set
// up, now nothing answers) — is a hub and three pages. The hub says what's
// wrong in one line and lists the ways forward; each way (install with Roadie,
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
function useRoadieRow() {
  return optionRow("Use Roadie's slskd",
    "Roadie already has slskd on this computer. Connect to it — Roadie asks you to approve once.",
    { type: "button", label: "Connect", action: "roadie-connect", variant: "accent" });
}

// ---- Finding slskd on this computer, before anything else ---------------
//
// The first run looks for a slskd already running here, on its usual ports,
// with no Roadie involved: a slskd the user runs, the manual guide's, or one
// Roadie installed all answer the same way. slskd answers
// GET /api/v0/session/enabled without a key ("true" or "false": whether it
// wants one), which tells it apart from anything else on the port. Found, the
// plugin tries the key it already has (the guide writes that one into
// slskd.yml); if slskd wants another, the user types it. Only when nothing is
// found does Roadie come in, as one way to install slskd.

// state: "idle" | "looking" | "found" | "none". found: { url, insecure,
// authEnabled, roadie } — `roadie`: Roadie runs this slskd and can hand over
// its key. keyInput: what the user typed (memory only until it works).
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
  var res = await api.network.fetch(url, init);
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

// Save a connection the user (or discovery) settled on: theirs, not Roadie's.
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
  var found = null;
  var cands = discoveryCandidates();
  for (var i = 0; i < cands.length && !found; i++) {
    try {
      var r = await fetchText(cands[i].url + "/api/v0/session/enabled", { method: "GET", timeoutMs: DISCOVERY_TIMEOUT_MS, insecure: cands[i].insecure, headers: { "Accept": "application/json" } });
      var fp = slskdFingerprint(r.status, r.text);
      if (fp) found = { url: cands[i].url, insecure: cands[i].insecure, authEnabled: fp.authEnabled, roadie: false };
    } catch (e) { /* nothing on this port */ }
  }
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
  // It wants a key we don't have. Roadie can hand one over only for a slskd
  // it runs itself; say so only when that's true (a status read, no dialog).
  try {
    await probeRoadie(true);
    found.roadie = !!(roadie.installed && roadie.tool && roadieOwnsAddress(found.url, roadie.tool));
  } catch (e) {
    found.roadie = false;
  }
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
  var buttons = [actionButton("Connect", "discover-connect", "accent", { disabled: !String(d.keyInput || "").trim() }), actionButton("Open slskd", "discover-open")];
  if (f.roadie) buttons.push(actionButton("Get the key from Roadie", "roadie-connect"));
  rows.push(buttonRow(buttons));
  return [{ type: "section", title: "Found slskd on this computer", children: rows }];
}

// Pure: the install options, shared by the first-run hub and the "not
// installed any more?" part of the unreachable one. Automatic comes first and
// is the recommended one wherever the host can provide Roadie.
function installRows(r) {
  var rows = [];
  var auto = !!(r && r.supported);
  if (auto) {
    rows.push(optionRow("Install automatically",
      "Roadie downloads slskd, runs it in the background and keeps it up to date. Recommended.",
      pageButton("Install…", "install-auto", "accent")));
  }
  rows.push(optionRow("Install manually",
    "A step-by-step guide for your computer, in the browser.",
    pageButton("Show guide…", "install-manual", auto ? "secondary" : "accent")));
  return rows;
}

// Pure: the hub for a slskd that isn't found. `st` is "unconfigured" or
// "unreachable"; `cfg` the connection settings; `r` the Roadie snapshot;
// `detail` the last probe's error, if any.
// `d`: the discovery state (first run only).
function setupHomeView(st, cfg, r, detail, d) {
  var children = [];
  var roadieSlskd = roadieHasUnusedSlskd(cfg, r);

  if (st === "unreachable" && cfg.managedBy === "roadie") {
    // Roadie installed it and still says so (an uninstall releases the
    // connection and lands on the first-run hub), so it's only stopped.
    children.push(headingText("slskd is stopped"));
    children.push(mutedText("Roadie installed slskd on this computer; it isn't running right now."));
    children.push(buttonRow([
      actionButton("Start slskd", "roadie-start", "accent", { disabled: !!(r && r.job) }),
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
    var startRows = [optionRow("Start slskd",
      "Start it the way you installed it. The guide's Run step shows how for your computer.",
      { type: "button", label: "Show how…", action: "setup-open-guide", variant: "secondary" })];
    if (roadieSlskd) startRows.unshift(useRoadieRow());
    children.push({ type: "section", title: "Stopped?", children: startRows });
    children.push({ type: "section", title: "Not installed any more?", children: installRows(r) });
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
    if (roadieSlskd) children.push({ type: "section", title: "Ready to connect", children: [useRoadieRow()] });
    children.push({ type: "section", title: "Install slskd", children: installRows(r) });
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
  var stage = autoInstallStage(roadie);
  if (stage === "unsupported") {
    children.push(mutedText("This version of Viboplr can't install slskd for you. The manual guide takes a few minutes."));
    children.push(pageButton("Show guide…", "install-manual", "accent"));
    return children;
  }
  children.push(mutedText("Roadie downloads slskd, asks you to approve it, and runs it in the background on this computer only."));
  if (stage === "get-roadie") {
    children.push({ type: "section", title: "First, Roadie", children: [
      optionRow("Install Roadie",
        "The small tool that installs and runs slskd for you. Viboplr fetches it; then come back here.",
        { type: "button", label: "Install Roadie…", action: "roadie-get", variant: "accent" })
    ] });
  } else if (stage === "adopt") {
    children.push({ type: "section", title: "Already installed", children: [useRoadieRow()] });
  } else if (stage === "form") {
    var other = otherInstanceNodes(roadie.other);
    for (var o = 0; o < other.length; o++) children.push(other[o]);
    children.push(roadieInstallSection());
  }
  var job = roadieJobNodes();
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
  else children = setupHomeView(readiness.state, settings, roadie, readiness.detail, discovery).concat(roadieJobNodes());
  return { type: "layout", direction: "vertical", children: children };
}

// Pure: whether `render` shows the full-page setup screen rather than the
// tabs. The first run always does; a slskd that stopped answering does only
// while the user is on one of the hub's pages (install, connect).
function wantsSetupScreen(st, page) {
  return st === "unconfigured" || (st === "unreachable" && page !== "home");
}

// Pure: the "key rejected" screen. When Roadie has slskd, the fix is
// Roadie's own key, not an edit to a file Roadie rewrites.
function unauthorizedNodes(cfg, r) {
  var tool = r && r.installed ? r.tool : null;
  var nodes = [headingText("slskd rejected the API key")];
  if (roadieCanHandOver(tool)) {
    var ours = roadieOwnsAddress(cfg.url, tool);
    nodes.push({ type: "text", content: ours
      ? "This is the slskd Roadie installed, and it only accepts the key Roadie gave Viboplr. The key below is a different one. Use Roadie's slskd to switch to Roadie's address and key; Viboplr is already allowed, so Roadie asks nothing."
      : "slskd is running, but it doesn't accept the key below. Roadie also has an slskd on this computer, which Viboplr is already allowed to use: switch to it, or fix the key for this one." });
    nodes.push(buttonRow([actionButton("Use Roadie's slskd", "roadie-connect", "accent"),
      actionButton("Open setup guide", "setup-open-guide")]));
    return nodes;
  }
  nodes.push({ type: "text", content: "slskd is running, but its settings file doesn't list the key below. Add it under web → authentication → api_keys in slskd.yml and restart slskd — the setup guide's Configure step shows the exact lines with this key already in them." });
  nodes.push({ type: "button", label: "Open setup guide", action: "setup-open-guide", variant: "accent" });
  return nodes;
}

// Pure: the "not signed in" screen. For Roadie's slskd the reason comes from
// its log and the fix is a restart through Roadie; the account lives in
// Roadie, so there is no yml to send the user to.
function disconnectedNodes(cfg, r, why) {
  var tool = r && r.installed ? r.tool : null;
  var nodes = [headingText("slskd isn't signed in to Soulseek")];
  var busy = !!(r && r.job);
  var ours = roadieOwnsAddress(cfg.url, tool);
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
    nodes.push(buttonRow([actionButton("Restart slskd", "roadie-restart", "accent", { disabled: busy }),
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
  if (settings.managedBy === "roadie" && roadie.installed && roadie.tool && roadie.tool.installed) return roadieConnectionSection();
  return { type: "section", title: "Connection", children: roadieManagedRows().concat(connectionFormRows()) };
}

// A slskd Roadie runs for this plugin: Roadie filled in the address and key,
// so the form is folded away (typing into it ends Roadie's management) and
// the card is what Roadie can do: test, start at login, files, remove.
function roadieConnectionSection() {
  // Remove goes last: the one destructive row sits below everything else.
  var rows = [optionRow("Address", settings.url + " · " + statusLine(), checkButton("Test"))]
    .concat(recipeUpdateRows(roadie.tool, roadie.job))
    .concat([autostartRow("roadie-autostart", roadie.tool.autostart)])
    .concat(sharingRows(roadie.tool, localCollections, roadie.job, roadieShare, slskdShared))
    .concat(roadieFileRows(roadie.tool, canOpenPaths(), roadieShowFiles))
    .concat([optionRow("Connection details", roadieShowDetails
      ? "Roadie filled these in. Changing them stops using Roadie's slskd."
      : "The address and key Roadie handed over.", actionButton(roadieShowDetails ? "Hide" : "Show", "roadie-details-toggle"))]);
  if (roadieShowDetails) rows = rows.concat(connectionFormRows());
  rows = rows.concat(roadieRemoveRows(roadieRemove, roadie.job));
  return { type: "section", title: "slskd from Roadie", children: rows };
}

// ---- slskd's own web page -----------------------------------------------
//
// For testing and for slskd's own settings. The page asks for a sign-in that
// is not the API key: a slskd Roadie installed sits behind the login its
// recipe sets (slskd / slskd since Roadie 0.5.2; "roadie" and a random
// password before), which Roadie hands to an approved app with the
// connection; a slskd the user set up has slskd's
// defaults unless they changed web → authentication in slskd.yml, which the
// plugin can't read. Fetched on the click and kept in memory only.
//
// webLogin: null (hidden) | { loading } | { error } | { username, password, note }
var webLogin = null;
var SLSKD_DEFAULT_LOGIN = { username: "slskd", password: "slskd" };

// Pure: the login out of Roadie's `tool connection` answer, or null when this
// Roadie predates it.
function webLoginFromRoadie(json) {
  var w = json && json.webLogin;
  if (!w || !w.username || !w.password) return null;
  return { username: String(w.username), password: String(w.password) };
}

async function revealWebLogin() {
  if (settings.managedBy !== "roadie") {
    webLogin = { username: SLSKD_DEFAULT_LOGIN.username, password: SLSKD_DEFAULT_LOGIN.password,
      note: "slskd's defaults. If you changed web → authentication in slskd.yml, use those instead." };
    rerenderWebLogin();
    return;
  }
  webLogin = { loading: true };
  rerenderWebLogin();
  var r;
  try {
    r = await roadieExec(["tool", "connection", "slskd", "--consumer", ROADIE_CONSUMER]);
  } catch (e) {
    console.error("slskd: reading the web login from Roadie failed:", e);
    webLogin = { error: String((e && e.message) || e) };
    rerenderWebLogin();
    return;
  }
  var login = r.code === 0 ? webLoginFromRoadie(r.json) : null;
  if (login) {
    webLogin = { username: login.username, password: login.password, note: "The sign-in Roadie set up for slskd's web page." };
  } else if (r.code !== 0) {
    webLogin = { error: "Roadie: " + roadieFailure(r.code, r.json, r.stderr) };
  } else {
    webLogin = { error: "This Roadie doesn't hand out slskd's login yet. It arrives with a Roadie update (Settings → Dependencies)." };
  }
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
  } else if (webLogin.loading) {
    rows.push(optionRow("Sign-in", "Asking Roadie…", hide));
  } else if (webLogin.error) {
    rows.push(optionRow("Sign-in", webLogin.error, hide));
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

function resultRows() {
  return sortedResults().map(function (c) {
    var meta = parseTrackMeta(c.filename);
    return {
      id: "f:" + c.username + KEY_SEP + c.filename,
      title: resultLabel(c),
      subtitle: resultSource(c),
      // What the subtitle used to carry now has columns of its own, so the
      // facts stay comparable down the list instead of running together in one
      // sentence per row. A cell the sharer didn't report is simply absent —
      // the host renders that as an em dash, which reads as "unknown" rather
      // than as zero.
      cells: resultCells(c),
      durationSecs: c.length != null ? c.length : null,
      action: "download-file",
      artistName: meta.artist,
      albumTitle: meta.album,
      kind: "audio"
    };
  });
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
      kind: "audio",
      actions: transferRowActions(t, rec, tier),
      action: playable ? "play-transfer" : undefined
    };
  });
}

function folderCards() {
  var m = search.mode;
  var fill = m && m.kind === "fill" ? m : null;
  return visibleFolders().map(function (g) {
    if (fill) {
      // What the card offers is the folder's contribution to THIS album, not
      // the folder: how many of its files you lack and what they weigh.
      var missing = missingFiles(g.files, fill.owned);
      var bytes = 0;
      for (var i = 0; i < missing.length; i++) bytes += missing[i].size || 0;
      return {
        id: "d:" + g.key,
        title: g.name,
        subtitle: g.username + " · " + g.files.length + " files · " + (missing.length
          ? missing.length + " you don't have · " + formatBytes(bytes)
          : "you have all of these"),
        action: "fill-folder"
      };
    }
    return {
      id: "d:" + g.key,
      title: g.name,
      subtitle: g.username + " · " + g.files.length + " files · " + formatBytes(g.totalSize),
      action: "download-folder"
    };
  });
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
      (m.showAll ? "Showing every file and folder found." : "Showing only files you don't have; Fill from a folder grabs just those."), className: "plugin-muted" });
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
  children = children.concat(modeHeader());

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
    children.push({ type: "text", content: "No downloadable audio found for “" + search.query + "”. Try fewer or broader words.", className: "plugin-muted" });
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
  if (!upgrading) {
    children.push({ type: "tabs", tabs: [
      { id: "files", label: "Files", count: files.length },
      { id: "folders", label: "Folders", count: folders.length }
    ], activeTab: activeTab === "folders" ? "folders" : "files", action: "result-mode" });
  }

  var trimmed = truncationNote();
  if (trimmed) children.push({ type: "text", content: trimmed, className: "plugin-muted" });

  // The host's headers toggle asc/desc and never offer a third state, so the way
  // back to the ranked order needs its own control — otherwise one click on a
  // column costs you the ranking until you search again.
  if (activeTab !== "folders" && search.sortColumn) {
    children.push({ type: "button", label: "Back to best match", action: "sort-best", variant: "secondary" });
  }

  if (activeTab === "folders") {
    children.push({ type: "card-grid", items: folderCards() });
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
    children.push({
      type: "track-row-list",
      items: resultRows(),
      // The rows' artist/album are guesses parsed out of strangers' file
      // paths. Show art Viboplr already has, but never let a search make it
      // fetch (and keep) a cover for every album that merely appeared in the
      // results. Older hosts ignore the field and fetch as before.
      artwork: "cached",
      showHeader: true,
      selectable: true,
      openOnClick: "title",
      actions: [{ id: "download-file", label: upgrading ? "Upgrade" : "Download", icon: "⬇" }],
      columns: RESULT_COLUMNS,
      sortBy: search.sortColumn || undefined,
      sortDir: search.sortColumn ? search.sortDir : undefined,
      sortAction: "sort-results"
    });
  }
  return { type: "layout", direction: "vertical", children: children };
}

function transfersTab() {
  var children = [];
  if (!transfers.length) {
    children.push({ type: "text", content: "No downloads yet.", className: "plugin-muted" });
    return { type: "layout", direction: "vertical", children: children.concat(keptSection()) };
  }

  if (tier === "remote") {
    children.push({ type: "text", content: "slskd is running on another machine, so finished files can't be played or added to the library from here. Add slskd's downloads folder (or its mount) as a music source in Collections.", className: "plugin-muted" });
  } else {
    var col = downloadsCollection();
    children.push({ type: "text", className: "plugin-muted", content: col
      ? "Finished downloads land in “" + col.name + "” and are added to your library automatically."
      : "Finished downloads play from here. Add to library copies one into a collection; or add slskd's downloads folder as a collection and they will be picked up automatically." });
  }

  // Live rows keep showing a percentage in the subtitle; a progress bar per row
  // isn't a thing the list can draw, and the phase text reads the same way down
  // the column.
  var active = transfers.filter(function (t) {
    var p = transferPhase(t.state);
    return p === "downloading" || p === "starting";
  });
  if (active.length) {
    var done = 0, total = 0;
    for (var i = 0; i < active.length; i++) { done += active[i].bytesTransferred || 0; total += active[i].size || 0; }
    children.push({ type: "progress-bar", value: done, max: total || 1,
      label: active.length + (active.length === 1 ? " download" : " downloads") + " in progress · " + formatBytes(done) + " of " + formatBytes(total) });
  }

  children.push({
    type: "track-row-list",
    items: transferRows(),
    selectable: true,
    showHeader: true,
    // Which of these a row shows is transferRowActions' call — only what would
    // do something to THAT transfer.
    actions: [
      { id: "play-transfer", label: "Play", icon: "▶" },
      { id: "replace-transfer", label: "Replace in library…", icon: "⇪" },
      { id: "import-transfer", label: "Add to library…", icon: "＋" },
      { id: "retry-transfer", label: "Retry", icon: "↻" },
      { id: "another-source", label: "Another source", icon: "⇄" },
      { id: "cancel-transfer", label: "Cancel", icon: "⏹" },
      { id: "remove-transfer", label: "Remove", icon: "🗑" }
    ]
  });
  return { type: "layout", direction: "vertical", children: children.concat(keptSection()) };
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

function fallbackTab() {
  var children = [];
  children.push({ type: "text", className: "plugin-muted",
    content: "When a track has no playable source of its own, Viboplr asks its fallback sources in turn. This one searches Soulseek for the song, " +
      "fetches the best match from a sharer with a free slot, and plays it once it lands — all within the minute the host allows. " +
      "Turn it on or off, and order it against other sources, in Settings → Providers → Playback fallback. The files it fetched are under Downloads." });

  children.push({ type: "toolbar", title: "Last resolve",
    buttons: lastResolve ? [{ label: "Clear", action: "clear-resolve", icon: "✕" }] : [] });
  if (!lastResolve) {
    children.push({ type: "text", className: "plugin-muted",
      content: "No fallback resolve yet this session. Play a track that has no source of its own — a library row whose file is gone, a track from a streaming plugin that can't reach it — and what happened appears here." });
    return { type: "layout", direction: "vertical", children: children };
  }

  var lr = lastResolve;
  children.push({ type: "text", content: "“" + lr.title + "”" + (lr.artist ? " — " + lr.artist : "") +
    (lr.durationSecs != null ? "  ·  " + formatDurationSecs(lr.durationSecs) : "") });
  children.push({ type: "text", className: "plugin-muted", content: "Searched for “" + lr.query + "”" });
  for (var i = 0; i < lr.steps.length; i++) {
    var s = lr.steps[i];
    var line = (i + 1) + ". " + s.label + (s.outcome ? " → " + s.outcome : "…") + (s.ms != null ? " (" + Math.round(s.ms / 100) / 10 + "s)" : "");
    children.push({ type: "text", content: line, className: s.level === "error" ? "plugin-error" : "plugin-muted" });
  }
  if (lr.outcome === "running" && lr.live) {
    if (lr.progress != null) {
      children.push({ type: "progress-bar", value: Math.round(lr.progress * 100), max: 100, label: liveLine(lr) });
    } else {
      children.push({ type: "loading", message: liveLine(lr) });
    }
  } else if (lr.outcome === "running") {
    children.push({ type: "loading", message: "Working…" });
  }
  children.push({ type: "text", content: outcomeLine(lr), className: lr.outcome === "failed" ? "plugin-error" : undefined });

  var picked = pickedLine(lr);
  if (picked) {
    children.push({ type: "toolbar", title: "Picked file" });
    children = children.concat(picked);
  }

  if (lr.candidates.length) {
    children.push({ type: "toolbar", title: "Matching files",
      status: lr.candidates.length + (lr.candidates.length === 1 ? " file" : " files") + ", best first" });
    children.push({ type: "text", className: "plugin-muted",
      content: "✓ played · ↓ downloading · ✗ tried and dropped. Match is how closely the file name fits the title and artist." });
    children = children.concat(candidateLines(lr));
  }
  return { type: "layout", direction: "vertical", children: children };
}

// Under Downloads: the files the playback fallback fetched. They are the
// plugin's own record (slskd's transfer list may have forgotten them), kept so
// the same song plays instantly next time, and deletable from disk here.
function keptSection() {
  var totals = fallbackTotals(fallback);
  var keys = Object.keys(fallback);
  if (!keys.length) return [];
  var out = [];
  out.push({ type: "toolbar", title: "Fetched by the playback fallback",
    status: totals.count + (totals.count === 1 ? " file" : " files") + " · " + formatBytes(totals.bytes),
    buttons: [{ label: "Delete all", action: "delete-all-kept", icon: "🗑" }] });
  out.push({ type: "text", className: "plugin-muted",
    content: "These stay in slskd's downloads folder so the same song plays instantly next time. Delete removes the file from disk through slskd" +
      (downloadsCollection() ? "; they are already part of your library through the collection that folder sits in." : ".") });
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

function fallbackSettingsSection() {
  var totals = fallbackTotals(fallback);
  var children = [
    { type: "text", className: "plugin-muted",
      content: "When a track has no playable source, Viboplr can fetch it from Soulseek: one bounded search, then the best-matching file from a sharer who has delivered before or advertises a free slot, played as soon as it lands. " +
        "Enable it and set its order among the other sources in Settings → Providers → Playback fallback." },
    { type: "settings-row", label: "Fallback quality",
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
        if (!lt.seen) return "No downloads watched yet. Every sharer's deliveries, failures and stalls are remembered, and sharers who have delivered are ranked above ones who only advertise a free slot — in the Search tab and in the fallback.";
        return lt.seen + (lt.seen === 1 ? " sharer" : " sharers") + " seen · " + lt.proven + " proven · " + lt.burned + " unreliable. Proven sharers rank first in results and in the fallback.";
      })() },
    { type: "settings-row", label: "Files kept by the fallback",
      description: totals.count
        ? totals.count + (totals.count === 1 ? " file" : " files") + " · " + formatBytes(totals.bytes) + ", in slskd's downloads folder under “" + DEST_ROOT + "/" + FALLBACK_SUBDIR + "”. The Downloads tab lists each one."
        : "None yet. Fetched files stay in slskd's downloads folder, under “" + DEST_ROOT + "/" + FALLBACK_SUBDIR + "”, so a song plays instantly the next time." },
    { type: "toolbar", buttons: [
      { label: "Show in Soulseek", action: "open-fallback", variant: "secondary" }
    ].concat(totals.count ? [{ label: "Delete all kept files", action: "delete-all-kept", variant: "secondary", icon: "🗑" }] : [])
     .concat(Object.keys(sharers).length ? [{ label: "Forget sharer history", action: "reset-sharers", variant: "secondary" }] : []) }
  ];
  return { type: "section", title: "Playback fallback", children: children };
}

function render() {
  if (!api) return;
  pushViewHeader();
  if (roadie.setup) {
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
  var banner = readinessBanner(st, settings, roadie, signinWhy, mainTab === "settings");
  if (banner) {
    body.push(banner);
    body = body.concat(roadieJobNodes());
  }
  body.push({
    type: "tabs",
    tabs: [
      { id: "search", label: "Search" },
      { id: "transfers", label: "Downloads", count: transfers.length || undefined },
      { id: "upgrades", label: "Upgrades", count: Object.keys(upgrades).filter(function (k) { return upgrades[k].state !== "replaced"; }).length || undefined },
      { id: "fallback", label: "Fallback" },
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
  if (activeTab === "settings") render();
}

function settingsTab() {
  var children = fixNodes(readiness.state, settings, roadie, readiness.detail, signinWhy);
  children.push(connectionSection());
  var webPage = webPageSection();
  if (webPage) children.push(webPage);

  children.push({
    type: "section",
    title: "Downloads",
    children: [
      { type: "settings-row", label: "slskd runs on this computer",
        description: "When on, finished downloads can be played and imported directly. Turn off if slskd runs in Docker or on a NAS.",
        control: { type: "toggle", label: "", action: "set-local",
          checked: detectTier(settings.url, settings.tierOverride) === "local" } },
      { type: "settings-row", label: "Preferred formats",
        description: "Comma-separated, best first — e.g. \"flac, mp3\". Leave empty to rank purely by quality.",
        control: { type: "text-input", placeholder: "flac, mp3", action: "set-formats", value: settings.preferredFormats } },
      { type: "settings-row", label: "Downloads folder",
        description: misconfiguredSlskdDir(downloadsDir, incompleteDir)
          ? downloadsDir + " — " + MISCONFIGURED_DIR_TEXT + "."
          : downloadsDir || "Read from slskd once connected." }
    ]
  });

  children.push(upgradeSettingsSection());
  children.push(fallbackSettingsSection());

  if (readiness.state === "ready" && tier === "local" && downloadsDir) {
    var col = downloadsCollection();
    children.push({
      type: "section",
      title: "Library",
      children: [{ type: "text", className: "plugin-muted", content: col
        ? "slskd's downloads folder is inside your “" + col.name + "” collection, so finished downloads are added to the library automatically."
        : "slskd's downloads folder isn't inside any of your collections. Add it (or a parent folder) as a music source in Collections and finished downloads will reach the library on their own; until then, use Add to library on a finished download to copy it into one." }]
    });
  }

  if (readiness.state === "ready" && readiness.shareCount === 0 && !(settings.managedBy === "roadie" && roadieCanShareDirs(roadie.tool))) {
    children.push({
      type: "section",
      title: "Sharing",
      children: [{ type: "text", content: "slskd isn't sharing any folders. Soulseek gives priority to users who share, so your downloads may queue for a long time. Add a shared folder in slskd's own settings.", className: "plugin-muted" }]
    });
  }

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

function candidateByRef(ref) {
  var raw = String(ref || "");
  if (raw.indexOf("f:") === 0) raw = raw.slice(2);
  for (var i = 0; i < search.results.length; i++) {
    var c = search.results[i];
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
  api.ui.requestAction("download-tracks", { providerId: PROVIDER_KEY, providerName: PROVIDER_NAME, tracks: tracks });
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

  api.ui.onAction("delete-all-kept", function () {
    var keys = Object.keys(fallback);
    if (!keys.length) return;
    deleteFallbackFiles(keys).catch(function (e) { console.error("slskd: deleting fallback files failed:", e); });
  });

  api.ui.onAction("result-mode", function (data) {
    activeTab = (data && data.tabId) === "folders" ? "folders" : "search";
    render();
  });

  api.ui.onAction("sort-results", function (data) {
    var col = data && data.column;
    if (!RESULT_SORTS[col]) return;
    search.sortColumn = col;
    search.sortDir = (data && data.direction) === "asc" ? "asc" : "desc";
    render();
  });

  api.ui.onAction("sort-best", function () {
    search.sortColumn = null;
    search.sortDir = "desc";
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
    if (!picked.length) return;
    downloadCandidates(picked, modeRecExtra())
      .catch(function (e) { console.error("slskd enqueue failed:", e); });
  });

  api.ui.onAction("download-folder", function (data) {
    var g = folderByRef(data && data.itemId);
    if (!g) return;
    enqueueFiles(g.username, g.files, g.name, modeRecExtra())
      .catch(function (e) { console.error("slskd folder enqueue failed:", e); });
  });

  // Fill mode's folder action: only the files the album lacks, from this one
  // sharer. The whole folder is a click away on "Show everything found".
  api.ui.onAction("fill-folder", function (data) {
    var g = folderByRef(data && data.itemId);
    var m = search.mode;
    if (!g || !m || m.kind !== "fill") return;
    var missing = missingFiles(g.files, m.owned);
    if (!missing.length) {
      api.ui.showNotification("You already have every track in that folder.");
      return;
    }
    enqueueFiles(g.username, missing, g.name, modeRecExtra())
      .catch(function (e) { console.error("slskd fill enqueue failed:", e); });
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
    if (ids.length) openUpgradeReplace(ids[0]);
  });

  api.ui.onAction("upgrade-take-alternative", function (data) {
    var ids = rowIds(data);
    if (!ids.length) return;
    takeUpgradeAlternative(ids[0]).catch(function (e) { console.error("slskd: taking the upgrade alternative failed:", e); });
  });

  // The interactive search the context menu used to open: the same filter,
  // the user picks the file.
  api.ui.onAction("upgrade-choose", function (data) {
    var e = upgrades[rowIds(data)[0]];
    if (!e) return;
    startUpgrade({ kind: "track", trackId: e.trackId, title: e.title, artistName: e.artist })
      .catch(function (err) { console.error("slskd upgrade search failed:", err); });
  });

  api.ui.onAction("upgrade-retry", function (data) {
    var ids = rowIds(data);
    for (var i = 0; i < ids.length; i++) {
      retryUpgrade(ids[i]).catch(function (e) { console.error("slskd: retrying the upgrade failed:", e); });
    }
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
    var keys = rowIds(data);
    for (var i = 0; i < keys.length; i++) {
      openReplace(keys[i]).catch(function (e) { console.error("slskd: replace in library failed:", e); });
    }
  });

  // A selection plays as ONE queue, in list order; a single row just plays.
  api.ui.onAction("play-transfer", function (data) {
    var keys = rowIds(data).filter(function (k) { return !!importTrackFor(k); });
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

  api.ui.onAction("import-transfer", function (data) {
    openImport(rowIds(data));
  });

  // Re-queue with the same user. slskd retries a failed transfer on its own
  // schedule (attempts / nextAttemptAt); this is for after it has given up, or
  // for one the user cancelled.
  api.ui.onAction("retry-transfer", function (data) {
    var keys = rowIds(data);
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
    var keys = rowIds(data);
    var chain = Promise.resolve();
    keys.forEach(function (key) {
      var t = transferByKey(key);
      if (!t) return;
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
    // Entering the automatic page is when Roadie's answer matters; a fresh
    // one means a Roadie installed a moment ago shows up without a restart.
    if (setupPage === "install-auto") {
      // Roadie's answer decides the form, and the collections are what it
      // offers to share (they are otherwise loaded only once slskd is ready).
      Promise.all([
        probeRoadie(true).catch(function (e) { console.error("slskd: Roadie probe failed:", e); }),
        loadCollections().catch(function (e) { console.error("slskd: loading collections failed:", e); })
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
  api.ui.onAction("slskd-show-login", function () {
    revealWebLogin().catch(function (e) { console.error("slskd: show login failed:", e); });
  });
  api.ui.onAction("slskd-hide-login", function () {
    webLogin = null;
    rerenderWebLogin();
  });
  // The login fields are there to be selected and copied; what's typed into
  // them goes nowhere.
  api.ui.onAction("slskd-login-field", function () {});

  // Roadie. Every one of these is a click; Roadie then asks the user in its
  // own dialog before it installs slskd or hands this plugin a key.
  api.ui.onAction("roadie-get", function () {
    // The host's own install modal for a registered dependency ("Install for
    // me"). It says nothing when Roadie lands, so re-probe once it has.
    api.ui.requestAction("require-dependency", { name: ROADIE_DEP, feature: "Soulseek" });
  });
  api.ui.onAction("roadie-install", function () {
    installSlskdWithRoadie().catch(function (e) { console.error("slskd: Roadie install failed:", e); });
  });
  api.ui.onAction("roadie-start", function () {
    startSlskdWithRoadie().catch(function (e) { console.error("slskd: Roadie start failed:", e); });
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
  api.ui.onAction("roadie-connect", function () {
    adoptRoadieConnection("button").then(function (ok) {
      if (ok) return refreshReadiness();
      render();
    }).catch(function (e) { console.error("slskd: Roadie connect failed:", e); });
  });
  api.ui.onAction("roadie-cancel", function () {
    if (roadie.job && roadie.job.cancel) roadie.job.cancel();
  });
  api.ui.onAction("roadie-setup-retry", function () {
    var s = roadie.setup;
    if (!s || !s.failed) return;
    continueSetup(s, s.failed.step).catch(function (e) { console.error("slskd: Roadie setup retry failed:", e); });
  });
  api.ui.onAction("roadie-setup-close", function () {
    roadie.setup = null;
    render();
  });
  api.ui.onAction("roadie-set-share", function (data) {
    roadieCreds.shareCollections = !!(data && data.value);
    render();
  });
  api.ui.onAction("roadie-set-autostart", function (data) {
    roadieCreds.autostart = !!(data && data.value);
    render();
  });
  api.ui.onAction("roadie-autostart", function (data) {
    setRoadieAutostart(!!(data && data.value)).catch(function (e) { console.error("slskd: Roadie autostart change failed:", e); });
  });
  api.ui.onAction("roadie-share-collections", function () {
    shareCollectionsWithRoadie().catch(function (e) { console.error("slskd: sharing collections failed:", e); });
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
  api.ui.onAction("roadie-share-confirm", function () {
    var gap = (roadieShare && roadieShare.confirm) || [];
    if (!gap.length) return;
    shareThroughSlskd(gap).catch(function (e) { console.error("slskd: sharing through slskd failed:", e); });
  });
  api.ui.onAction("roadie-share-cancel", function () {
    roadieShare = { error: null };
    render();
  });
  api.ui.onAction("roadie-recipe-update", function () {
    reviewRecipeUpdate().catch(function (e) { console.error("slskd: Roadie recipe update failed:", e); });
  });
  // Another slskd runs here: connect to it by hand (it has its own key).
  api.ui.onAction("roadie-use-other", function () {
    if (roadie.other && roadie.other.url) {
      settings.url = roadie.other.url;
      saveSetting("url", settings.url);
    }
    setupPage = "connect";
    render();
  });
  api.ui.onAction("roadie-recheck-other", function () {
    probeRoadie(true).then(render).catch(function (e) { console.error("slskd: Roadie probe failed:", e); });
  });
  api.ui.onAction("roadie-files-toggle", function () {
    roadieShowFiles = !roadieShowFiles;
    render();
  });
  api.ui.onAction("roadie-details-toggle", function () {
    roadieShowDetails = !roadieShowDetails;
    render();
  });
  api.ui.onAction("roadie-restart", function () {
    restartSlskdWithRoadie().catch(function (e) { console.error("slskd: Roadie restart failed:", e); });
  });
  api.ui.onAction("roadie-open-path", function (data) {
    if (!data || !data.path || !canOpenPaths()) return;
    openRoadiePath(String(data.path), !!data.reveal).catch(function (e) { console.error("slskd: open path failed:", e); });
  });
  api.ui.onAction("roadie-remove-ask", function () {
    roadieRemove = { asking: true, error: null };
    render();
  });
  api.ui.onAction("roadie-remove-cancel", function () {
    roadieRemove.asking = false;
    render();
  });
  api.ui.onAction("roadie-remove", function (data) {
    uninstallSlskdWithRoadie(!!(data && data.keepData)).catch(function (e) { console.error("slskd: Roadie uninstall failed:", e); });
  });
  // Every keystroke arrives; the view re-renders only when the Install
  // button's enabled state flips.
  function setCred(key, value) {
    var was = roadieCredsComplete(roadieCreds);
    roadieCreds[key] = value || "";
    if (roadieCredsComplete(roadieCreds) !== was) render();
  }
  api.ui.onAction("roadie-set-user", function (data) { setCred("username", data && data.value); });
  api.ui.onAction("roadie-set-user:submit", function (data) { setCred("username", data && data.value); });
  api.ui.onAction("roadie-set-pass", function (data) { setCred("password", data && data.value); });
  api.ui.onAction("roadie-set-pass:submit", function (data) {
    setCred("password", data && data.value);
    installSlskdWithRoadie().catch(function (e) { console.error("slskd: Roadie install failed:", e); });
  });

  api.ui.onAction("test-connection", function () {
    return checkConnection();
  });

  // A typed address or key is the user's own: it ends Roadie's management of
  // the connection, so nothing overwrites what they typed.
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
  api.ui.onAction("set-fallback-quality", function (data) {
    var v = data && data.value;
    if (!FALLBACK_MODES[v]) return;
    saveSetting("fallbackQuality", v);
  });
  api.ui.onAction("reset-sharers", function () {
    sharers = {};
    api.storage.set("sharers", sharers).catch(function (e) { console.error("slskd: couldn't reset the sharer ledger:", e); });
    render();
    renderSettings();
  });
  api.ui.onAction("set-insecure", function (data) { saveSetting("insecure", !!(data && data.value)); });
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
    runSearch(q, known != null ? { knownDurationSecs: known } : null)
      .catch(function (e) { console.error("slskd context search failed:", e); });
  });

  api.contextMenu.onAction("slskd-upgrade", function (target) {
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
//                   "alternative" | "none" | "failed" | "replaced"
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
  var matches = rankFallback(ranked, entry.title, entry.artist, null, "best");
  // A variant word the title doesn't ask for (live, remix, cover…) is marked
  // down in the fallback, which only has to play something close. An upgrade
  // REPLACES the library copy, so a different recording is out entirely.
  var better = matches.filter(function (c) { return !c.match.penalty && isUpgradeOver(c, entry.current); });
  var sorter = function (a, b) {
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
  await api.storage.set("upgrades", upgrades);
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
    var bits = [qualityLabel(pick) + " from " + pick.username];
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
  if (e.state === "ready" && e.file) return "Ready: " + qualityLabel(e.file.quality) + " (" + have + ")" + (e.message ? " · " + e.message : "");
  if (e.state === "replaced") return "Replaced in your library";
  return (e.message || e.state) + " · " + have;
}

// Pure: which row actions an Upgrades row shows.
function upgradeRowActions(e) {
  var ids = [];
  if (e.state === "ready") ids.push("upgrade-replace");
  if (e.state === "alternative") ids.push("upgrade-take-alternative");
  if (e.state !== "replaced") ids.push("upgrade-choose");
  if (e.state === "none" || e.state === "failed" || e.state === "alternative") ids.push("upgrade-retry");
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
async function queueUpgrade(target) {
  var t = target || {};
  var row = await libraryRowForTarget(t);
  if (!row) {
    api.ui.navigateToView(VIEW_ID);
    return plainSearch(t, "Upgrade works on tracks in your library — searching Soulseek for this one instead.");
  }
  if (!row.path || String(row.path).indexOf("file://") !== 0) {
    api.ui.navigateToView(VIEW_ID);
    return plainSearch({ kind: "track", title: row.title, artistName: row.artist_name },
      "Upgrade replaces a local file, and “" + row.title + "” isn't one — searching Soulseek for it instead.");
  }
  await beginUpgrade(row);
}

// Start (or restart) the automatic upgrade of one local library row. Returns
// the entry, or null when one is already running for it.
async function beginUpgrade(row) {
  var key = upgradeKey(row.id);
  var open = { label: "Show", id: "open-upgrades" };
  if (upgradeIsBusy(upgrades[key])) {
    api.ui.showNotification("“" + row.title + "” is already being upgraded.", { action: open });
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
    createdAt: nowMs(),
    updatedAt: nowMs()
  };
  await saveUpgrades();
  api.ui.showNotification(readiness.state === "ready"
    ? "Looking for a better copy of “" + row.title + "”."
    : "“" + row.title + "” will be upgraded once slskd is ready.", { action: open });
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
    var query = fallbackQuery(e.title, e.artist);
    var prefs = viewPrefs({ knownDurationSecs: e.durationSecs });
    var ranked = await performSearch(query, prefs, null, null, nowMs() + UPGRADE_SEARCH_MS);
    if (upgrades[upgradeKey(e.trackId)] !== e || e.state !== "searching") return;   // removed meanwhile
    if (ranked === null) return;   // slskd was busy; the next poll tries again
    var r = rankUpgrade(ranked, e);
    e.candidates = r.picks.slice(0, UPGRADE_KEEP_CANDIDATES).map(leanCandidate);
    e.alternative = r.alternative ? leanCandidate(r.alternative) : null;
    api.log("info", "upgrade: “" + e.title + "” — " + ranked.length + " files, " + r.matched + " match, " + r.better + " better, " + r.picks.length + " at the target", "slskd");
    if (!e.candidates.length) {
      if (e.alternative) {
        setUpgradeState(e, "alternative", "No copy at " + UPGRADE_TARGETS[upgradeTargetOf(e.target)] + " found; best better copy is " + qualityLabel(e.alternative));
      } else {
        setUpgradeState(e, "none", r.matched ? "Nothing better than your copy on Soulseek right now" : "Nothing on Soulseek matched this track");
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
    var c = null;
    for (var i = 0; i < e.candidates.length; i++) {
      if (e.triedUsers.indexOf(e.candidates[i].username) < 0) { c = e.candidates[i]; break; }
    }
    if (!c) break;
    e.triedUsers.push(c.username);
    var key = c.username + KEY_SEP + c.filename;
    try {
      var out = await enqueueBatch(c.username, [c], (e.artist ? e.artist + " - " : "") + e.title, UPGRADE_SUBDIR, {
        upgrade: { trackId: e.trackId, title: e.title, artist: e.artist, auto: true },
        meta: { title: e.title, artist: e.artist, album: e.album, track_number: e.trackNumber }
      });
      if (!out.queued.length) {
        ledgerCount(key, c.username, "failed", 0, false);
        await dropIfListed(key);
        continue;
      }
    } catch (err) {
      console.error("slskd: upgrade enqueue failed:", err);
      ledgerCount(key, c.username, "failed", 0, false);
      await dropIfListed(key);
      continue;
    }
    var now = nowMs();
    e.active = Object.assign(leanCandidate(c), { key: key, startedAt: now, movedAt: now, lastBytes: 0, unseen: 0 });
    setUpgradeState(e, "downloading");
    await saveUpgrades();
    return true;
  }
  e.active = null;
  setUpgradeState(e, "failed", "No sharer delivered (" + e.triedUsers.length + " tried)");
  await saveUpgrades();
  return false;
}

// Give up on the active attempt and move on. `drop` = cancel it in slskd and
// forget the record (a stall); a failed/vanished one is already over.
async function abandonUpgradeAttempt(e, t, reason, drop) {
  var a = e.active;
  api.log("warn", "upgrade: “" + e.title + "” — " + a.username + ": " + reason, "slskd");
  if (drop && t) await dropStalled(t);
  if (drop) delete tracked[a.key];
  e.active = null;
  await api.storage.set("tracked", tracked);
  await startNextUpgradeCandidate(e);
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
  var verdict = checkUpgrade(e, pick, measured);
  if (!verdict.ok) {
    api.log("warn", "upgrade: “" + e.title + "” — rejected " + pick.username + "'s file: " + verdict.note, "slskd");
    // The file stays in Downloads — the plugin deletes only what the fallback
    // fetched — but it is no longer offered as a replacement.
    if (rec) delete rec.upgrade;
    e.file = null;
    e.active = null;
    e.lastRejected = verdict.note;
    await api.storage.set("tracked", tracked);
    await startNextUpgradeCandidate(e);
    if (e.state === "failed") e.message = "No file held up (" + verdict.note + ")";
    await saveUpgrades();
    return;
  }
  e.file.quality = measured || pick;
  setUpgradeState(e, "ready", verdict.note);
  await saveUpgrades();
  lastReadyUpgrade = upgradeKey(e.trackId);
  api.ui.showNotification("A better copy of “" + e.title + "” is ready: " + qualityLabel(e.file.quality) + ".",
    { action: { label: "Compare & replace", id: "upgrade-replace-notice" } });
}

// After Compare & replace, the library row changes under us once the user
// confirmed. A different size or path is the sign; nothing else is needed.
async function detectReplaced(e) {
  if (!api.library || typeof api.library.getTrackById !== "function") return false;
  var row = null;
  try { row = await api.library.getTrackById(e.trackId); } catch (err) { console.error("slskd: re-reading library track failed:", err); return false; }
  if (!row) return false;
  if (row.path !== e.path || (row.file_size || null) !== (e.current.size || null)) {
    setUpgradeState(e, "replaced");
    return true;
  }
  return false;
}

function openUpgradeReplace(key) {
  var e = upgrades[key];
  if (!e || e.state !== "ready" || !e.file) return;
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
      await api.storage.set("tracked", tracked);
    }
  }
  delete upgrades[key];
  await saveUpgrades();
  render();
}

async function retryUpgrade(key) {
  var e = upgrades[key];
  if (!e || upgradeIsBusy(e)) return;
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

function upgradeRows() {
  return Object.keys(upgrades)
    .map(function (k) { return upgrades[k]; })
    .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); })
    .map(function (e) {
      var t = e.active ? transferByKey(e.active.key) : null;
      return {
        id: upgradeKey(e.trackId),
        title: e.title,
        subtitle: upgradeLine(e, t),
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

function upgradesTab() {
  var children = [];
  var target = UPGRADE_TARGETS[upgradeTargetOf(settings.upgradeTarget)];
  if (!Object.keys(upgrades).length) {
    children.push({ type: "text", className: "plugin-muted",
      content: "Nothing being upgraded. Choose Upgrade on a track in your library and a better copy is found, downloaded and checked here; you replace it after comparing the two." });
  } else {
    children.push({ type: "text", className: "plugin-muted",
      content: "Upgrading to: " + target + " (change it in Settings). Each track gets the best matching file from a sharer likely to deliver; nothing in your library changes until you compare and replace." });
    children.push({
      type: "track-row-list",
      items: upgradeRows(),
      showHeader: false,
      actions: [
        { id: "upgrade-replace", label: "Compare & replace…", icon: "⇪" },
        { id: "upgrade-take-alternative", label: "Take the best found", icon: "⬇" },
        { id: "upgrade-choose", label: "Choose myself…", icon: "⌕" },
        { id: "upgrade-retry", label: "Search again", icon: "↻" },
        { id: "upgrade-remove", label: "Remove", icon: "🗑" }
      ]
    });
  }
  return { type: "layout", direction: "vertical", children: children };
}

function upgradeSettingsSection() {
  var t = upgradeTargetOf(settings.upgradeTarget);
  return {
    type: "section",
    title: "Upgrades",
    children: [
      { type: "settings-row", label: "Upgrade to",
        description: UPGRADE_TARGET_HELP[t] +
          (t === "best" ? "" : " When nothing at the target turns up, the Upgrades tab offers the best better copy it did find."),
        control: { type: "select", action: "set-upgrade-target", value: t,
          options: Object.keys(UPGRADE_TARGETS).map(function (k) { return { value: k, label: UPGRADE_TARGETS[k] }; }) } }
    ]
  };
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

function plainSearch(target, note) {
  if (note) api.ui.showNotification(note);
  var q = searchQueryForTarget(target);
  if (!q) return Promise.resolve();
  return runSearch(q);
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
function toolCandidate(c) {
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
      slskdAddress: settings.url || null,
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
    if (args.upgradeFor != null) {
      var row = await upgradableRow(args.upgradeFor);
      mode = upgradeModeFor(row);
      if (!q) q = searchQueryForTarget({ kind: "track", title: row.title, artistName: row.artist_name });
      if (known == null && row.duration_secs > 0) known = row.duration_secs;
    }
    if (!q) throw new Error('"query" (string) is required, unless upgradeFor names a library track');
    if (readiness.state !== "ready") throw new Error("slskd is not ready (" + readiness.state + ") — see the status tool");
    var limit = Math.min(100, Math.max(1, parseInt(args.limit, 10) || 25));
    var prefs = viewPrefs(known != null ? { knownDurationSecs: known } : null);
    var ranked = await performSearch(q, prefs, null, null);
    if (ranked === null) ranked = [];
    annotateForMode(ranked, mode);
    toolResults = {};
    toolMode = mode;
    for (var i = 0; i < ranked.length; i++) toolResults[candidateId(ranked[i])] = ranked[i];
    var shown = mode && !args.showAll ? ranked.filter(function (c) { return c.better; }) : ranked;
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
    return out;
  });

  api.assistant.onTool("download", async function (args) {
    var ids = Array.isArray(args.ids) ? args.ids.map(String) : (typeof args.ids === "string" ? [args.ids] : []);
    if (!ids.length) throw new Error('"ids" (array of result ids from search) is required');
    if (readiness.state !== "ready") throw new Error("slskd is not ready (" + readiness.state + ") — see the status tool");
    var byUser = {};
    var unknown = [];
    for (var i = 0; i < ids.length; i++) {
      var c = toolResults[ids[i]];
      if (!c) { unknown.push(ids[i]); continue; }
      (byUser[c.username] = byUser[c.username] || []).push(c);
    }
    if (unknown.length && !Object.keys(byUser).length) {
      throw new Error("Unknown result id(s): " + unknown.join(", ") + " — ids come from the most recent search call");
    }
    var queued = [];
    var failures = [];
    var users = Object.keys(byUser);
    for (var u = 0; u < users.length; u++) {
      var files = byUser[users[u]];
      var label = basenameRemote(dirnameRemote(files[0].filename));
      var out = await enqueueBatch(users[u], files, label, null, modeRecExtra(toolMode));
      for (var q = 0; q < out.queued.length; q++) queued.push({ user: users[u], filename: basenameRemote(out.queued[q].filename) });
      for (var f = 0; f < out.failures.length; f++) failures.push({ user: users[u], filename: basenameRemote(out.failures[f].filename), message: out.failures[f].message || "refused" });
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

  api.assistant.onTool("list_downloads", async function () {
    if (readiness.state === "ready") {
      try {
        var fresh = await fetchTransfers();
        if (fresh) transfers = fresh;
      } catch (e) {
        console.error("slskd: list_downloads refresh failed:", e);
      }
    }
    return {
      downloads: transfers.map(toolTransfer),
      note: "A finished file's uri is what Viboplr's replace_track_file (upgradeFor rows) or download_plugin_track takes."
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
    else if (action === "remove") { await removeUpgrade(key); return { removed: true, trackId: existing.trackId }; }
    else throw new Error('unknown action "' + action + '" — start, retry, take_alternative or remove');
    return { upgrade: toolUpgrade(upgrades[key]) };
  });

  api.assistant.onTool("list_upgrades", async function () {
    var keys = Object.keys(upgrades);
    var changed = false;
    for (var i = 0; i < keys.length; i++) {
      var e = upgrades[keys[i]];
      if (!e || e.state !== "ready") continue;
      // A replace done through the host's API (not this view's dialog) is
      // noticed here and, via replaceRequested, by the poll from now on.
      if (await detectReplaced(e)) { changed = true; continue; }
      if (!e.replaceRequested) { e.replaceRequested = true; changed = true; }
    }
    if (changed) await saveUpgrades();
    return {
      upgrades: keys.map(function (k) { return upgrades[k]; }).filter(Boolean).map(toolUpgrade),
      note: "When state is ready, show the user current vs ready.quality and pass ready.uri to Viboplr's replace_track_file (it stages, compares, and replaces only on confirm)."
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
      tier = detectTier(settings.url, settings.tierOverride);
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
  var keys = ["url", "apiKey", "tierOverride", "insecure", "preferredFormats", "fallbackQuality", "upgradeTarget", "batchSeq", "managedBy"];
  for (var i = 0; i < keys.length; i++) {
    try {
      var v = await api.storage.get(keys[i]);
      if (v !== undefined && v !== null) settings[keys[i]] = v;
    } catch (e) {
      console.error("slskd: couldn't read setting " + keys[i] + ":", e);
    }
  }
  try {
    var w = await api.storage.get("sharesWarned");
    sharesWarned = !!w;
    var t = await api.storage.get("tracked");
    if (t && typeof t === "object") tracked = t;
    var fb = await api.storage.get("fallback");
    if (fb && typeof fb === "object") fallback = fb;
    var sh = await api.storage.get("sharers");
    if (sh && typeof sh === "object") sharers = sh;
    var up = await api.storage.get("upgrades");
    if (up && typeof up === "object") upgrades = up;
  } catch (e) {
    console.error("slskd: couldn't read stored state:", e);
  }
}

async function activate(hostApi) {
  api = hostApi;
  await loadSettings();
  tier = detectTier(settings.url, settings.tierOverride);

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

  render();
  renderSettings();

  await refreshReadiness();
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
  knownDone = {};
  ledgerSeen = {};
  completionsSeeded = false;
  lastResolve = null;
  fallbackBusy = false;
  roadie.setup = null;   // ends a setup's sign-in wait
  api = null;
}

return {
  activate: activate,
  deactivate: deactivate,

  // Exposed for the test harness.
  _b64encode: b64encode,
  _hasFlag: hasFlag,
  _qualityTier: qualityTier,
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
  _webLoginFromRoadie: webLoginFromRoadie,
  _readinessBanner: readinessBanner,
  _viewHeaderFor: viewHeaderFor,
  _fixNodes: fixNodes,
  _collectionPaths: collectionPaths,
  _installShareDirs: installShareDirs,
  _roadieCanShareDirs: roadieCanShareDirs,
  _describeFolders: describeFolders,
  _installRows: installRows,
  _connectionSection: connectionSection,
  _roadieAutoConfigAction: roadieAutoConfigAction,
  _autoInstallStage: autoInstallStage,
  _parseRoadieJson: parseRoadieJson,
  _roadieProgress: roadieProgress,
  _roadieInstallArgs: roadieInstallArgs,
  _roadieUninstallArgs: roadieUninstallArgs,
  _roadieRemoveRows: roadieRemoveRows,
  _roadieFileRows: roadieFileRows,
  _roadieFilePlaces: roadieFilePlaces,
  _shareGap: shareGap,
  _yamlWithShares: yamlWithShares,
  _sharedFromSlskd: sharedFromSlskd,
  _otherInstanceNodes: otherInstanceNodes,
  _recipeUpdateInfo: recipeUpdateInfo,
  _discoveryCandidates: discoveryCandidates,
  _slskdFingerprint: slskdFingerprint,
  _discoveryNodes: discoveryNodes,
  _sharedDirsWith: sharedDirsWith,
  _sharingRows: sharingRows,
  _roadieOwnsAddress: roadieOwnsAddress,
  _unauthorizedNodes: unauthorizedNodes,
  _disconnectedNodes: disconnectedNodes,
  _apiLogMessages: apiLogMessages,
  _checkedAgo: checkedAgo,
  _roadieFailure: roadieFailure,
  _roadieHasUnusedSlskd: roadieHasUnusedSlskd,
  _newSetup: newSetup,
  _advanceSetup: advanceSetup,
  _failSetup: failSetup,
  _setupStepForLine: setupStepForLine,
  _setupChecklist: setupChecklist,
  _signinFailure: signinFailure,
  _signinProgress: signinProgress,
  _signinReasonFromLog: signinReasonFromLog,
  _roadieCredsComplete: roadieCredsComplete,
  _setSigninTiming: function (waitMs, pollMs, settleMs) { SIGNIN_WAIT_MS = waitMs; SIGNIN_POLL_MS = pollMs; if (settleMs != null) START_SETTLE_MS = settleMs; },
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
  _libraryQuality: libraryQuality,
  _isUpgradeOver: isUpgradeOver,
  _ownedTrackFor: ownedTrackFor,
  _missingFiles: missingFiles,
  _startUpgrade: startUpgrade,
  _queueUpgrade: queueUpgrade,
  _advanceUpgrades: advanceUpgrades,
  _upgrades: function () { return upgrades; },
  _meetsQualityTarget: meetsQualityTarget,
  _windowsCantStore: windowsCantStore,
  _misconfiguredSlskdDir: misconfiguredSlskdDir,
  _isWindowsPathBug: isWindowsPathBug,
  _rankUpgrade: rankUpgrade,
  _upgradeTargetOf: upgradeTargetOf,
  _measuredQuality: measuredQuality,
  _checkUpgrade: checkUpgrade,
  _upgradeLine: upgradeLine,
  _upgradeRowActions: upgradeRowActions,
  _setUpgradeTimings: function (searchMs, stallMs) { UPGRADE_SEARCH_MS = searchMs; if (stallMs != null) UPGRADE_STALL_MS = stallMs; },
  _startFill: startFill,
  _setFallbackSearchMs: function (ms) { FALLBACK_SEARCH_MS = ms; }
};
