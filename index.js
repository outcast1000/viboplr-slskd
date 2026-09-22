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
//  - Sandbox: no fetch, no WebSocket, no Map/Set, no btoa. Base64 is hand-rolled;
//    polling replaces SignalR.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
var PLUGIN_ID = "slskd";
var VIEW_ID = "slskd-browse";
var SETTINGS_VIEW_ID = "slskd-settings";
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
  batchSeq: 0
};

var readiness = { state: "unconfigured", detail: null, username: null, version: null, shareCount: null };
var notifiedState = null;
var sharesWarned = false;

var downloadsDir = null;
var tier = "remote";

var activeTab = "search";
// `matchCount` / `folderCount` are what the search actually produced;
// `results` / `folders` are the capped slices the view renders. `sortColumn` is
// null while the list is in ranked ("best match") order.
var search = { query: "", id: null, running: false, responseCount: 0, fileCount: 0, matchCount: 0, folderCount: 0, results: [], folders: [], error: null, sortColumn: null, sortDir: "desc" };
var searchGen = 0;

var transfers = [];       // raw slskd transfer records (downloads)
var tracked = {};         // "user filename" -> { destination, b64, resolvedPath, meta, size, length }
var localCollections = []; // host's local collections, for "did this land in the library?"
var knownDone = {};       // transfer keys already seen finished (completion detection)
var completionsSeeded = false;
var tagsPending = {};     // resolvedPath -> in-flight readAudioTags promise

// slskd runs ONE search at a time (POST /searches answers 429 while another is
// in flight), so every search — the view's, a context-menu one, an assistant
// tool's — goes through this chain.
var searchChain = Promise.resolve();
// The last ranked list the assistant `search` tool produced, keyed by candidate
// id, so `download` can be handed ids instead of (user, filename, size) triples.
var toolResults = {};

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

// responses: slskd Search.responses[]. Availability lives on the response,
// quality on the file, so the unit of ranking is a flattened (response, file).
function rankResults(responses, prefs) {
  prefs = prefs || {};
  var preferred = prefs.preferredFormats || null;
  var known = prefs.knownDurationSecs != null ? prefs.knownDurationSecs : null;
  var maxQueue = prefs.maxQueue != null ? prefs.maxQueue : null;
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
        formatRank: formatRank(ext, preferred)
      });
    }
  }

  out.sort(function (a, b) {
    if (a.formatRank !== b.formatRank) return a.formatRank - b.formatRank;
    if (a.qualityTier !== b.qualityTier) return a.qualityTier - b.qualityTier;
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

  var bad = state === "unreachable" || state === "unauthorized" || state === "disconnected";
  var changed = state !== prevState;

  return {
    state: state,
    detail: detail,
    username: probe && probe.username != null ? probe.username : null,
    version: probe && probe.version != null ? probe.version : null,
    shareCount: probe && probe.shareCount != null ? probe.shareCount : null,
    changed: changed,
    // Notify only on a TRANSITION INTO a bad state — polling must never spam.
    // "connecting" is transitional and never alarms.
    notify: changed && bad
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
    bits.push("Failed" + (t.exception ? " — " + t.exception : ""));
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
function safeDestination(seq, label) {
  var stem = DEST_ROOT + "/" + seq + (label ? "-" + sanitizeSegment(label) : "");
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
  var st = res.json || {};
  var server = st.server || {};
  var shares = st.shares || {};
  return {
    kind: "ok",
    serverState: server.state || "",
    isLoggedIn: server.isLoggedIn != null ? server.isLoggedIn : null,
    isTransitioning: server.isTransitioning != null ? server.isTransitioning : null,
    username: server.username || null,
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

function notificationFor(state) {
  if (state === "unreachable") return "slskd isn't reachable — open Soulseek in the sidebar to fix the address, or start slskd.";
  if (state === "unauthorized") return "slskd rejected the API key — update it in Settings → Soulseek.";
  if (state === "disconnected") return "slskd is running but isn't signed in to Soulseek.";
  return null;
}

async function refreshReadiness() {
  var p = await probe();
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

  if (next.notify && notifiedState !== next.state) {
    var msg = notificationFor(next.state);
    if (msg) api.ui.showNotification(msg);
    notifiedState = next.state;
  }
  if (!next.notify && next.changed) notifiedState = null;

  if (next.state === "ready" && !downloadsDir) await loadDownloadsDir();
  if (next.state === "ready") await loadCollections();

  // Sharing drives queue priority. A leeching setup produces slow downloads that
  // read as "this plugin is broken", so say it once, informationally.
  if (next.state === "ready" && readiness.shareCount === 0 && !sharesWarned) {
    sharesWarned = true;
    await api.storage.set("sharesWarned", true);
    api.ui.showNotification("slskd isn't sharing any folders. Soulseek prioritises users who share, so downloads may be slow or queue for a long time.");
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
// THE POLL IS DELIBERATELY LEAN. `?includeResponses=true` was on every poll,
// which is why a broad search was so expensive: measured against slskd 0.26.0,
// the counts-only body is ~254 bytes while the same search's bodies are 2.6 MB,
// and the loop runs up to 30 times — ~78 MB pulled through the plugin sandbox
// and JSON-parsed, to read two integers off it 29 times and use the payload
// once. The bodies are now fetched exactly once, after completion.
//
// Serialized through `searchChain`: slskd holds a one-slot semaphore on
// POST /searches and answers 429 to a second caller, so two searches (the view
// and an assistant tool, say) must queue rather than collide.
function performSearch(query, prefs, onProgress, isStale) {
  var run = function () { return performSearchNow(query, prefs, onProgress, isStale); };
  var next = searchChain.then(run, run);
  searchChain = next.catch(function () { /* keep the chain alive for the next caller */ });
  return next;
}

async function performSearchNow(query, prefs, onProgress, isStale) {
  var stale = isStale || function () { return false; };
  if (stale()) return null;

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

  var waited = 0;
  var last = null;
  while (waited < SEARCH_CAP_MS) {
    await sleep(SEARCH_POLL_MS);
    if (stale()) return null;
    waited += SEARCH_POLL_MS;

    var poll;
    try {
      poll = await slskd("GET", "/api/v0/searches/" + encodeURIComponent(id));
    } catch (e) {
      continue;
    }
    if (stale()) return null;
    if (!poll.json) continue;
    last = poll.json;

    if (onProgress) onProgress(last.responseCount || 0, last.fileCount || 0);

    if (hasFlag(last.state, "Completed")) {
      var done = await fetchResponses(id, stale);
      return done === null ? null : rankResults(done, prefs || {});
    }
  }

  // Past the cap: whatever slskd holds now is the answer. Stop the search so
  // its slot frees up for the next one, but don't wait on that.
  slskd("PUT", "/api/v0/searches/" + encodeURIComponent(id))
    .catch(function (e) { console.error("slskd: couldn't stop a timed-out search:", e); });
  var partial = await fetchResponses(id, stale);
  if (partial === null) return null;
  if (partial.length) return rankResults(partial, prefs || {});
  throw new Error("Search timed out after " + Math.round(SEARCH_CAP_MS / 1000) + " seconds.");
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
  var prefs = { preferredFormats: parsePreferredFormats(settings.preferredFormats) };
  if (extra && extra.knownDurationSecs != null) prefs.knownDurationSecs = extra.knownDurationSecs;
  return prefs;
}

// The sidebar's search: owns `search` (the view state) and re-renders as counts
// arrive. A newer search supersedes an older one through `searchGen`.
async function runSearch(query, extra) {
  if (!query || readiness.state !== "ready") return;
  var gen = ++searchGen;
  search = { query: query, id: null, running: true, responseCount: 0, fileCount: 0, matchCount: 0, folderCount: 0, results: [], folders: [], error: null, sortColumn: null, sortDir: "desc" };
  activeTab = "search";
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
async function nextBatch(label) {
  settings.batchSeq = (settings.batchSeq || 0) + 1;
  await api.storage.set("batchSeq", settings.batchSeq);
  return safeDestination(settings.batchSeq, label);
}

// The one place a download is started — the view's buttons, Retry, and the
// assistant's `download` tool all come through here, so an assistant-queued
// file is tracked, located and imported exactly like a clicked one. Throws
// with a readable message; the caller decides how to surface it.
async function enqueueBatch(username, files, label) {
  var batch = await nextBatch(label);
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

  var queued = [];
  for (var i = 0; i < files.length; i++) {
    if (failed[files[i].filename]) continue;
    tracked[username + KEY_SEP + files[i].filename] = {
      destination: batch.destination,
      b64: batch.b64,
      resolvedPath: null,
      meta: parseTrackMeta(files[i].filename),
      size: files[i].size || null,
      length: files[i].length != null ? files[i].length : null
    };
    queued.push(files[i]);
  }
  await api.storage.set("tracked", tracked);
  schedulePoll(true);
  return { queued: queued, failures: failures };
}

// View-side wrapper: notification, switch to the Downloads tab.
async function enqueueFiles(username, files, label) {
  var out;
  try {
    out = await enqueueBatch(username, files, label);
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
    if (rec && !rec.resolvedPath && phase === "succeeded") {
      await resolveTransferPath(tr, rec);
    }
  }
  // First poll of the session: everything already finished is new to US but
  // nothing just happened. Seed silently, or a restart would notify (and
  // rescan) once per finished file.
  completionsSeeded = true;

  await readTagsForResolved();
  render();
  if (justFinished.length) await handleCompletions(justFinished);
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
  api.ui.showNotification(finished.length === 1
    ? "Finished downloading: " + names[0]
    : "Finished downloading " + finished.length + " files (" + names[0] + ", …)");

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


// ---------------------------------------------------------------------------
// Setup — the guide lives on the plugin's GitHub Pages site, not in this view:
// a web page can auto-detect the OS, offer real Copy buttons and be read on
// the phone next to the computer being set up. The plugin's job is to mint
// the API key, hand it to the page in the URL fragment (never sent to the
// server) and connect once slskd is up. Nothing is downloaded, written or
// launched from here — the user owns slskd.
// ---------------------------------------------------------------------------

var SETUP_GUIDE_URL = "https://outcast1000.github.io/viboplr-slskd/";
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

// The key rides in the fragment so the page can fill it into the yml snippet
// without it ever reaching GitHub's servers.
function setupGuideUrl(apiKey) {
  return SETUP_GUIDE_URL + "#key=" + encodeURIComponent(apiKey || "");
}

function setupBlock(apiKey) {
  return {
    type: "section",
    title: "Set up slskd",
    children: [
      { type: "text", content: "The guide opens in your browser: where to download slskd, how to run it the first time, the exact lines to paste into its <code>slskd.yml</code> (with your key already in them), and how to start it at login. Come back and press Connect when it's running." },
      { type: "toolbar", buttons: [
        { label: "Open setup guide", action: "setup-open-guide", variant: "accent" },
        { label: "Connect to " + SETUP_DEFAULT_URL, action: "setup-connect", variant: "secondary" },
        { label: "Generate a new key", action: "setup-new-key", variant: "secondary" }
      ], status: "Your API key: " + apiKey }
    ]
  };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function setupView() {
  var children = [];
  var st = readiness.state;
  var showGuide = st === "unconfigured" || st === "unreachable";

  if (st === "unconfigured") {
    children.push({ type: "text", content: "Search and download from Soulseek", className: "plugin-heading" });
    children.push({ type: "text", content: "Viboplr can't talk to Soulseek directly, so this plugin drives slskd — a free, open-source Soulseek daemon that you install and run yourself. It's a ten-minute job; the guide walks through it for Windows, macOS and Docker, and the API key is already generated for you. Already running slskd somewhere (Docker, a NAS)? Skip to the Connection section." });
  } else if (st === "unreachable") {
    children.push({ type: "text", content: "slskd isn't reachable", className: "plugin-heading" });
    children.push({ type: "text", content: "Nothing answered at " + (settings.url || "(no address set)") + ". Check that slskd is running and the address is right." + (readiness.detail ? " (" + readiness.detail + ")" : "") });
    children.push({ type: "text", content: "If slskd uses HTTPS with its default self-signed certificate, turn on \"Allow self-signed certificate\" below.", className: "plugin-muted" });
  } else if (st === "unauthorized") {
    children.push({ type: "text", content: "slskd rejected the API key", className: "plugin-heading" });
    children.push({ type: "text", content: "slskd is running, but it didn't accept the key. Copy it again from slskd under Settings → Options → Web." });
  } else if (st === "disconnected") {
    children.push({ type: "text", content: "slskd isn't signed in to Soulseek", className: "plugin-heading" });
    children.push({ type: "text", content: "slskd is running and the key works, but it isn't connected to the Soulseek network. Check the Soulseek username and password in slskd's own settings." });
    children.push({ type: "button", label: "Open slskd", action: "open-slskd", variant: "secondary" });
  } else if (st === "connecting") {
    children.push({ type: "loading", message: "slskd is connecting to Soulseek…" });
  }

  if (showGuide) {
    children.push({ type: "spacer" });
    children.push(setupBlock(settings.apiKey));
  }
  children.push({ type: "spacer" });
  children.push(connectionSection());
  return { type: "layout", direction: "vertical", children: children };
}

// The guide shows a key and the yml carries it, so a key must exist before the
// first render. Saved straight to storage: `saveSetting` would also re-probe,
// and a key without an address is still "unconfigured".
function ensureSetupKey() {
  if (settings.apiKey) return;
  settings.apiKey = randomApiKey();
  api.storage.set("apiKey", settings.apiKey).catch(function (e) { console.error("slskd: couldn't save apiKey:", e); });
}

function connectionSection() {
  return {
    type: "section",
    title: "Connection",
    children: [
      { type: "settings-row", label: "slskd address", description: "e.g. http://localhost:5030",
        control: { type: "text-input", placeholder: "http://localhost:5030", action: "set-url", value: settings.url } },
      { type: "settings-row", label: "API key", description: "slskd → Settings → Options → Web",
        control: { type: "text-input", placeholder: "API key", action: "set-key", password: true, value: settings.apiKey } },
      { type: "settings-row", label: "Allow self-signed certificate", description: "Needed if slskd serves HTTPS with its default certificate",
        control: { type: "toggle", label: "", action: "set-insecure", checked: !!settings.insecure } },
      { type: "toolbar", buttons: [{ label: "Test connection", action: "test-connection", variant: "accent" }],
        status: statusLine(), statusVariant: readiness.state === "ready" ? "success" : (readiness.state === "connecting" || readiness.state === "unconfigured" ? "default" : "error") }
    ]
  };
}

function statusLine() {
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
  if (c.size) cells.size = formatBytes(c.size);
  if (c.length != null) cells.duration = formatDurationSecs(c.length);
  cells.availability = availabilityLabel(c);
  return cells;
}

function sortedResults() {
  if (!search.sortColumn) return search.results;
  return sortCandidates(search.results, search.sortColumn, search.sortDir);
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
  return search.folders.map(function (g) {
    return {
      id: "d:" + g.key,
      title: g.name,
      subtitle: g.username + " · " + g.files.length + " files · " + formatBytes(g.totalSize),
      action: "download-folder"
    };
  });
}

// "Showing the best 1,000 of 20,431 files" — the cap has to be visible, or a
// broad query silently looks like it found exactly 1,000 things.
function truncationNote() {
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

  children.push({ type: "tabs", tabs: [
    { id: "files", label: "Files", count: search.results.length },
    { id: "folders", label: "Folders", count: search.folders.length }
  ], activeTab: activeTab === "folders" ? "folders" : "files", action: "result-mode" });

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
      showHeader: true,
      selectable: true,
      openOnClick: "title",
      actions: [{ id: "download-file", label: "Download", icon: "⬇" }],
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
    return { type: "layout", direction: "vertical", children: children };
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
      { id: "import-transfer", label: "Add to library…", icon: "＋" },
      { id: "retry-transfer", label: "Retry", icon: "↻" },
      { id: "another-source", label: "Another source", icon: "⇄" },
      { id: "cancel-transfer", label: "Cancel", icon: "⏹" },
      { id: "remove-transfer", label: "Remove", icon: "🗑" }
    ]
  });
  return { type: "layout", direction: "vertical", children: children };
}

function render() {
  if (!api) return;
  if (readiness.state === "unconfigured") ensureSetupKey();
  if (readiness.state !== "ready") {
    api.ui.setViewData(VIEW_ID, setupView(), { scrollKey: "setup" });
    return;
  }
  var body = [{
    type: "tabs",
    tabs: [
      { id: "search", label: "Search" },
      { id: "transfers", label: "Downloads", count: transfers.length || undefined }
    ],
    activeTab: activeTab === "transfers" ? "transfers" : "search",
    action: "main-tab"
  }];
  body.push(activeTab === "transfers" ? transfersTab() : searchTab());
  api.ui.setViewData(VIEW_ID, { type: "layout", direction: "vertical", children: body },
    { scrollKey: activeTab === "transfers" ? "transfers" : "search:" + search.query });
}

function renderSettings() {
  if (!api) return;
  var children = [connectionSection()];

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
        description: downloadsDir || "Read from slskd once connected." }
    ]
  });

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

  if (readiness.state === "ready" && readiness.shareCount === 0) {
    children.push({
      type: "section",
      title: "Sharing",
      children: [{ type: "text", content: "slskd isn't sharing any folders. Soulseek gives priority to users who share, so your downloads may queue for a long time. Add a shared folder in slskd's own settings.", className: "plugin-muted" }]
    });
  }

  api.ui.setViewData(SETTINGS_VIEW_ID, { type: "layout", direction: "vertical", children: children });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
// A selection can span several sharers, but an enqueue is addressed to ONE peer
// (slskd queues per user), so group first and send one batch each — sequentially,
// because each batch claims the next destination folder number.
async function downloadCandidates(list) {
  var byUser = {};
  var order = [];
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    if (!byUser[c.username]) { byUser[c.username] = []; order.push(c.username); }
    byUser[c.username].push(c);
  }
  for (var u = 0; u < order.length; u++) {
    var files = byUser[order[u]];
    await enqueueFiles(order[u], files, basenameRemote(dirnameRemote(files[0].filename)));
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
    activeTab = (data && data.tabId) === "transfers" ? "transfers" : "search";
    render();
    schedulePoll(activeTab === "transfers");
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
    downloadCandidates(picked)
      .catch(function (e) { console.error("slskd enqueue failed:", e); });
  });

  api.ui.onAction("download-folder", function (data) {
    var g = folderByRef(data && data.itemId);
    if (!g) return;
    enqueueFiles(g.username, g.files, g.name)
      .catch(function (e) { console.error("slskd folder enqueue failed:", e); });
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
      chain = chain.then(function () {
        return enqueueFiles(parts.username, [{ filename: parts.filename, size: size }], basenameRemote(dirnameRemote(parts.filename)));
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
  api.ui.onAction("setup-open-guide", function () {
    ensureSetupKey();
    api.network.openUrl(setupGuideUrl(settings.apiKey)).catch(console.error);
  });
  api.ui.onAction("setup-new-key", function () {
    settings.apiKey = "";
    ensureSetupKey();
    render();
    renderSettings();
  });
  api.ui.onAction("setup-connect", function () {
    if (!settings.url) settings.url = SETUP_DEFAULT_URL;
    saveSetting("url", settings.url);
  });

  api.ui.onAction("open-slskd", function () {
    if (settings.url) api.network.openUrl(settings.url).catch(console.error);
  });

  api.ui.onAction("test-connection", function () {
    refreshReadiness().catch(function (e) { console.error("slskd probe failed:", e); });
  });

  api.ui.onAction("set-url", function (data) { saveSetting("url", (data && data.value) || ""); });
  api.ui.onAction("set-url:submit", function (data) { saveSetting("url", (data && data.value) || ""); });
  api.ui.onAction("set-key", function (data) { saveSetting("apiKey", (data && data.value) || ""); });
  api.ui.onAction("set-key:submit", function (data) { saveSetting("apiKey", (data && data.value) || ""); });
  api.ui.onAction("set-formats", function (data) { saveSetting("preferredFormats", (data && data.value) || ""); });
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
  return {
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
    if (!q) throw new Error('"query" (string) is required');
    if (readiness.state !== "ready") throw new Error("slskd is not ready (" + readiness.state + ") — see the status tool");
    var limit = Math.min(100, Math.max(1, parseInt(args.limit, 10) || 25));
    var prefs = viewPrefs(args.durationSecs != null && !isNaN(Number(args.durationSecs))
      ? { knownDurationSecs: Number(args.durationSecs) } : null);
    var ranked = await performSearch(q, prefs, null, null);
    if (ranked === null) ranked = [];
    toolResults = {};
    for (var i = 0; i < ranked.length; i++) toolResults[candidateId(ranked[i])] = ranked[i];
    return {
      query: q,
      total: ranked.length,
      note: "Ranked best-first: preferred format, then quality tier, then who can send it soonest. Pass ids to download; every file of a folder from one user = the whole album.",
      results: ranked.slice(0, limit).map(toolCandidate)
    };
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
      var out = await enqueueBatch(users[u], files, label);
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
    return { downloads: transfers.map(toolTransfer) };
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
        schedulePoll(active || activeTab === "transfers");
      });
  }, delay);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
async function loadSettings() {
  var keys = ["url", "apiKey", "tierOverride", "insecure", "preferredFormats", "batchSeq"];
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
    var rec = findTrackedByRef(ref);
    if (!rec) return null;
    var path = await currentPath(ref, rec);
    return path ? fileUrlForPlayback(path) : null;
  });

  // The download modal's provider for slsk:// — "Download…" on any of our rows
  // and the Add to library button both land here. The transfer already
  // finished, so this resolve is an instant local copy, well inside any budget.
  // No metadata-based resolver, deliberately: that would put an unbounded
  // Soulseek wait into the host's automatic fallback for every unplayable track.
  api.downloads.onResolveByUri(PROVIDER_ID, async function (uri) {
    var ref = String(uri || "").replace(/^slsk:\/\//, "");
    var rec = findTrackedByRef(ref);
    var path = await currentPath(ref, rec);
    if (!path) return null;
    var meta = rec.meta || {};
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
  });

  api.downloads.onGetQualities(PROVIDER_ID, function () {
    return [{ value: "original", label: "Original file", description: "Copies the file Soulseek delivered, untouched." }];
  });

  render();
  renderSettings();

  await refreshReadiness();
  readinessTimer = setInterval(function () {
    refreshReadiness().catch(function (e) { console.error("slskd readiness poll failed:", e); });
  }, READINESS_POLL_MS);
  schedulePoll(false);
}

function deactivate() {
  if (readinessTimer) clearInterval(readinessTimer);
  if (transferTimer) clearTimeout(transferTimer);
  if (saveTimer) clearTimeout(saveTimer);
  readinessTimer = null;
  transferTimer = null;
  saveTimer = null;
  searchGen++;
  toolResults = {};
  knownDone = {};
  completionsSeeded = false;
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
  _setupBlock: setupBlock,
  _hostOf: hostOf,
  _searchQueryForTarget: searchQueryForTarget,
  _nextReadiness: nextReadiness,
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
  _flattenListing: flattenListing
};
