// viboplr-slskd — search and download from the Soulseek network.
//
// Viboplr cannot speak Soulseek (custom binary TCP; the plugin sandbox only has
// HTTP), so this plugin drives a user-run slskd daemon over its REST API.
//
// Design notes:
//  - THE PLUGIN OWNS THE TRANSFER LIFECYCLE. A Soulseek transfer can sit in a
//    stranger's upload queue for hours; every host resolver path is bounded at
//    60s. So we enqueue in slskd and render our own progress, and only touch
//    api.downloads.enqueue AFTER a file is complete (then it's an instant copy).
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
var VIEW_ID = "slskd-browse";
var SETTINGS_VIEW_ID = "slskd-settings";
var PROVIDER_ID = "slskd-import";
var SCHEME = "slsk";
var DEST_ROOT = "viboplr";

var AUDIO_EXTS = [
  "mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "wav", "aiff", "aif",
  "ape", "wv", "wma", "alac", "mpc", "tta", "dsf", "dff"
];
var LOSSLESS_EXTS = ["flac", "wav", "aiff", "aif", "ape", "wv", "alac", "tta", "dsf", "dff"];

// Quality tiers. `unknown` deliberately sits BELOW high and ABOVE medium: many
// Soulseek clients report no attributes at all, and ranking those last would
// systematically bury good results.
var T_LOSSLESS = 0, T_HIGH = 1, T_UNKNOWN = 2, T_MEDIUM = 3, T_LOW = 4;

var SEARCH_POLL_MS = 1000;
var SEARCH_CAP_MS = 30000;
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
var search = { query: "", id: null, running: false, responseCount: 0, fileCount: 0, results: [], folders: [], error: null };
var searchGen = 0;

var transfers = [];       // raw slskd transfer records (downloads)
var tracked = {};         // transferId -> { destination, resolvedPath, meta }
var viewOpen = false;

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

      var key = (resp.username || "") + " " + file.filename;
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

// Soulseek users mostly share whole albums, so folders are a first-class result.
function groupByFolder(candidates) {
  var order = [];
  var map = {};
  var list = candidates || [];
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    var folder = dirnameRemote(c.filename);
    var key = c.username + " " + folder;
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

// Files API `fullName` is relativized to the downloads root (FileService.cs:341),
// so the absolute path needs directories.downloads prepended.
function absolutePath(downloadsRoot, fullName) {
  if (!downloadsRoot || !fullName) return null;
  var root = String(downloadsRoot).replace(/[\/\\]+$/, "");
  var windows = root.indexOf("\\") >= 0 || /^[A-Za-z]:$/.test(root.slice(0, 2));
  var sep = windows ? "\\" : "/";
  var rel = String(fullName).replace(/^[\/\\]+/, "");
  rel = windows ? rel.replace(/\//g, "\\") : rel.replace(/\\/g, "/");
  return root + sep + rel;
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

async function runSearch(query) {
  if (!query || readiness.state !== "ready") return;
  var gen = ++searchGen;
  search = { query: query, id: null, running: true, responseCount: 0, fileCount: 0, results: [], folders: [], error: null };
  render();

  var res;
  try {
    res = await slskd("POST", "/api/v0/searches", { searchText: query });
  } catch (e) {
    search.running = false;
    search.error = "Couldn't reach slskd: " + ((e && e.message) || e);
    render();
    return;
  }
  if (res.status < 200 || res.status >= 300 || !res.json || !res.json.id) {
    search.running = false;
    search.error = errorText(res, "slskd rejected the search (HTTP " + res.status + ").");
    resyncIfConnectionLost(res);
    render();
    return;
  }
  search.id = res.json.id;

  var waited = 0;
  while (waited < SEARCH_CAP_MS) {
    await sleep(SEARCH_POLL_MS);
    if (gen !== searchGen) return;
    waited += SEARCH_POLL_MS;

    var poll;
    try {
      poll = await slskd("GET", "/api/v0/searches/" + encodeURIComponent(search.id) + "?includeResponses=true");
    } catch (e) {
      continue;
    }
    if (gen !== searchGen) return;
    if (!poll.json) continue;

    // Counts stream live (SearchService.cs:296-300); response BODIES only land at
    // completion (:311, :361). So show a live counter, then render the list once.
    search.responseCount = poll.json.responseCount || 0;
    search.fileCount = poll.json.fileCount || 0;

    var done = hasFlag(poll.json.state, "Completed");
    if (done) {
      var ranked = rankResults(poll.json.responses || [], {
        preferredFormats: parsePreferredFormats(settings.preferredFormats)
      });
      search.results = ranked;
      search.folders = groupByFolder(ranked);
      search.running = false;
      render();
      return;
    }
    render();
  }

  search.running = false;
  if (!search.results.length) search.error = "Search timed out after 30 seconds.";
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

async function enqueueFiles(username, files, label) {
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
    api.ui.showNotification("Couldn't reach slskd to start the download.");
    return false;
  }
  if (res.status < 200 || res.status >= 300) {
    api.ui.showNotification(errorText(res, "slskd refused the download (HTTP " + res.status + ")."));
    resyncIfConnectionLost(res);
    return false;
  }

  for (var i = 0; i < files.length; i++) {
    tracked[username + " " + files[i].filename] = {
      destination: batch.destination,
      b64: batch.b64,
      resolvedPath: null,
      meta: parseTrackMeta(files[i].filename)
    };
  }
  await api.storage.set("tracked", tracked);
  api.ui.showNotification(files.length === 1
    ? "Queued 1 file from " + username + "."
    : "Queued " + files.length + " files from " + username + ".");

  activeTab = "transfers";
  render();
  schedulePoll(true);
  return true;
}

function trackKeyOf(t) {
  return (t.username || "") + " " + (t.filename || "");
}

async function refreshTransfers() {
  if (readiness.state !== "ready") return;
  var res;
  try {
    res = await slskd("GET", "/api/v0/transfers/downloads");
  } catch (e) {
    return;
  }
  if (!res.json) return;

  // The endpoint groups by user then directory; flatten to a transfer list.
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
  transfers = flat;

  for (var k = 0; k < flat.length; k++) {
    var tr = flat[k];
    var key = trackKeyOf(tr);
    var rec = tracked[key];
    if (rec && !rec.resolvedPath && transferPhase(tr.state) === "succeeded") {
      await resolveTransferPath(tr, rec);
    }
  }
  render();
}

async function listDestination(rec) {
  // Targeted listing when the base64 is route-safe; otherwise a filtered root
  // listing (correct always, just heavier).
  if (rec.b64) {
    try {
      var res = await slskd("GET", "/api/v0/files/downloads/directories/" + rec.b64 + "?recursive=true");
      if (res.status >= 200 && res.status < 300 && res.json) return flattenListing(res.json);
    } catch (e) { /* fall through to the root listing */ }
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
  } catch (e) { /* nothing else to try */ }
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

function findTrackedByRef(ref) {
  return tracked[ref] || null;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function setupView() {
  var children = [];
  var st = readiness.state;

  if (st === "unconfigured") {
    children.push({ type: "text", content: "Search and download from Soulseek", className: "plugin-heading" });
    children.push({ type: "text", content: "Viboplr can't talk to Soulseek directly, so this plugin drives slskd — a free, open-source Soulseek daemon you run yourself. Install it, sign in with a Soulseek account, then paste its address and API key below." });
    children.push({ type: "button", label: "Get slskd", action: "open-slskd-site", variant: "accent" });
    children.push({ type: "text", content: "Find the API key in slskd under Settings → Options → Web.", className: "plugin-muted" });
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

  children.push({ type: "spacer" });
  children.push(connectionSection());
  return { type: "layout", direction: "vertical", children: children };
}

function connectionSection() {
  return {
    type: "section",
    title: "Connection",
    children: [
      { type: "settings-row", label: "slskd address", description: "e.g. http://localhost:5030",
        control: { type: "text-input", placeholder: "http://localhost:5030", action: "set-url", value: settings.url } },
      { type: "settings-row", label: "API key", description: "slskd → Settings → Options → Web",
        control: { type: "text-input", placeholder: "API key", action: "set-key", value: settings.apiKey } },
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

function resultRows() {
  return search.results.map(function (c, i) {
    return {
      id: "f:" + c.username + " " + c.filename,
      title: basenameRemote(c.filename),
      subtitle: c.username + " · " + qualityLabel(c) + " · " + formatBytes(c.size) + " · " + availabilityLabel(c),
      album: basenameRemote(dirnameRemote(c.filename)),
      duration: formatDurationSecs(c.length),
      action: "download-file",
      artistName: parseTrackMeta(c.filename).artist,
      albumTitle: parseTrackMeta(c.filename).album
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

  if (activeTab === "folders") {
    children.push({ type: "card-grid", items: folderCards() });
  } else {
    children.push({ type: "track-row-list", items: resultRows(), showHeader: true });
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
    children.push({ type: "text", content: "slskd is running on another machine, so finished files can't be played or imported from here. Add slskd's downloads folder (or its mount) as a music source in Collections.", className: "plugin-muted" });
  }

  for (var i = 0; i < transfers.length; i++) {
    var t = transfers[i];
    var phase = transferPhase(t.state);
    var rec = tracked[trackKeyOf(t)];
    var name = basenameRemote(t.filename);
    var kids = [];

    kids.push({ type: "text", content: name });

    if (phase === "downloading" || phase === "starting") {
      kids.push({ type: "progress-bar", value: t.bytesTransferred || 0, max: t.size || 1,
        label: formatBytes(t.bytesTransferred) + " of " + formatBytes(t.size) + " from " + t.username });
    } else if (phase === "queued" || phase === "requested") {
      kids.push({ type: "text", content: t.placeInQueue != null
        ? "Waiting in " + t.username + "'s queue — position " + t.placeInQueue
        : "Queued with " + t.username, className: "plugin-muted" });
    } else if (phase === "succeeded") {
      var sub = "Finished · " + formatBytes(t.size);
      if (tier === "local" && rec && rec.resolvedPath) {
        kids.push({ type: "text", content: sub, className: "plugin-muted" });
        kids.push({ type: "toolbar", buttons: [
          { label: "Play", action: "play-transfer", variant: "accent", data: { ref: trackKeyOf(t) } },
          { label: "Add to library", action: "import-transfer", variant: "secondary", data: { ref: trackKeyOf(t) } }
        ] });
      } else {
        kids.push({ type: "text", content: sub + (tier === "local" ? " · locating file…" : ""), className: "plugin-muted" });
      }
    } else if (phase === "failed") {
      kids.push({ type: "text", content: "Failed" + (t.exception ? " — " + t.exception : "") +
        (t.attempts ? " (attempt " + t.attempts + ")" : ""), className: "plugin-error" });
      kids.push({ type: "toolbar", buttons: [
        { label: "Retry", action: "retry-transfer", variant: "secondary", data: { ref: trackKeyOf(t) } },
        { label: "Try another source", action: "another-source", variant: "secondary", data: { ref: trackKeyOf(t) } }
      ] });
    } else if (phase === "cancelled") {
      kids.push({ type: "text", content: "Cancelled", className: "plugin-muted" });
    }

    children.push({ type: "section", title: "", children: kids });
  }
  return { type: "layout", direction: "vertical", children: children };
}

function render() {
  if (!api) return;
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
function candidateByRef(ref) {
  var raw = String(ref || "");
  if (raw.indexOf("f:") === 0) raw = raw.slice(2);
  for (var i = 0; i < search.results.length; i++) {
    var c = search.results[i];
    if (c.username + " " + c.filename === raw) return c;
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

function registerActions() {
  api.ui.onAction("search", function (data) {
    var q = (data && data.query) || "";
    runSearch(q.trim()).catch(function (e) { console.error("slskd search failed:", e); });
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

  api.ui.onAction("download-file", function (data) {
    var c = candidateByRef(data && data.itemId);
    if (!c) return;
    enqueueFiles(c.username, [c], basenameRemote(dirnameRemote(c.filename)))
      .catch(function (e) { console.error("slskd enqueue failed:", e); });
  });

  api.ui.onAction("download-folder", function (data) {
    var g = folderByRef(data && data.itemId);
    if (!g) return;
    enqueueFiles(g.username, g.files, g.name)
      .catch(function (e) { console.error("slskd folder enqueue failed:", e); });
  });

  api.ui.onAction("play-transfer", function (data) {
    var rec = findTrackedByRef(data && data.ref);
    if (!rec || !rec.resolvedPath) return;
    var meta = rec.meta || {};
    api.playback.playTrack({
      path: SCHEME + "://" + (data && data.ref),
      title: meta.title || "Soulseek file",
      artist_name: meta.artist || null,
      album_title: meta.album || null
    });
  });

  api.ui.onAction("import-transfer", function (data) {
    var ref = data && data.ref;
    var rec = findTrackedByRef(ref);
    if (!rec || !rec.resolvedPath) return;
    var meta = rec.meta || {};
    api.downloads.enqueue({
      title: meta.title || basenameRemote(rec.resolvedPath),
      artistName: meta.artist || undefined,
      albumTitle: meta.album || undefined,
      uri: SCHEME + "://" + ref,
      provider: PROVIDER_ID
    }).then(function () {
      api.ui.showNotification("Importing “" + (meta.title || "file") + "” into your library.");
    }).catch(function (e) {
      console.error("slskd import failed:", e);
      api.ui.showNotification("Couldn't import that file.");
    });
  });

  api.ui.onAction("retry-transfer", function (data) {
    var ref = String((data && data.ref) || "");
    var sep = ref.indexOf(" ");
    if (sep < 0) return;
    var username = ref.slice(0, sep);
    var filename = ref.slice(sep + 1);
    var t = null;
    for (var i = 0; i < transfers.length; i++) {
      if (trackKeyOf(transfers[i]) === ref) { t = transfers[i]; break; }
    }
    enqueueFiles(username, [{ filename: filename, size: (t && t.size) || 0 }], basenameRemote(dirnameRemote(filename)))
      .catch(function (e) { console.error("slskd retry failed:", e); });
  });

  api.ui.onAction("another-source", function (data) {
    var ref = String((data && data.ref) || "");
    var sep = ref.indexOf(" ");
    var filename = sep >= 0 ? ref.slice(sep + 1) : ref;
    var meta = parseTrackMeta(filename);
    activeTab = "search";
    runSearch([meta.artist, meta.title].filter(Boolean).join(" ") || basenameRemote(filename))
      .catch(function (e) { console.error("slskd re-search failed:", e); });
  });

  api.ui.onAction("open-slskd-site", function () {
    api.network.openUrl("https://slskd.com/").catch(console.error);
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
    activeTab = "search";
    runSearch(q).catch(function (e) { console.error("slskd context search failed:", e); });
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

  // Completed Soulseek files play as ordinary local files. parseUrlScheme does a
  // raw substring(7), so the path must NOT be percent-encoded.
  api.playback.onResolveStreamByUri(SCHEME, async function (ref) {
    if (tier !== "local") return null;
    var rec = findTrackedByRef(ref);
    if (!rec) return null;
    if (!rec.resolvedPath) {
      for (var i = 0; i < transfers.length; i++) {
        if (trackKeyOf(transfers[i]) === ref && transferPhase(transfers[i].state) === "succeeded") {
          await resolveTransferPath(transfers[i], rec);
          break;
        }
      }
    }
    return rec.resolvedPath ? fileUrlForPlayback(rec.resolvedPath) : null;
  });

  // Import-only: the transfer already finished, so this resolve is an instant
  // local copy, well inside the host's 60s resolver budget.
  api.downloads.onResolveByUri(PROVIDER_ID, async function (uri) {
    var ref = String(uri || "").replace(/^slsk:\/\//, "");
    var rec = findTrackedByRef(ref);
    if (!rec || !rec.resolvedPath) return null;
    var meta = rec.meta || {};
    return {
      url: fileUrlForDownload(rec.resolvedPath),
      ext: extOf(rec.resolvedPath) || "auto",
      metadata: {
        title: meta.title || null,
        artist: meta.artist || null,
        album: meta.album || null,
        trackNumber: meta.trackNumber || null
      }
    };
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
  _parseTrackMeta: parseTrackMeta,
  _parsePreferredFormats: parsePreferredFormats,
  _detectTier: detectTier,
  _hostOf: hostOf,
  _searchQueryForTarget: searchQueryForTarget,
  _nextReadiness: nextReadiness,
  _matchFile: matchFile,
  _absolutePath: absolutePath,
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
