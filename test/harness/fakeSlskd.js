"use strict";
// A fake slskd: a local HTTP server that answers the slskd REST endpoints this
// plugin calls, with consistent made-up results, so the plugin can be run and
// debugged where the Soulseek network itself is unreachable (a work VPN, a
// filtered network) or where a failure has to happen on cue.
//
// It sits BELOW the plugin on purpose: the plugin's own HTTP client, readiness
// probe, search polling, transfer tracking, file location and upgrade checks
// all run unchanged against it. Nothing here ships — the release zip is
// manifest.json + index.js only.
//
// Two users:
//   - `scripts/fake-slskd.js` — the CLI. Point the plugin's slskd address at it.
//   - `test/fakeSlskd.test.js` — starts it in-process (`createFakeSlskd`) and
//     drives the real plugin against it.
//
// Shapes follow slskd 0.2x (field names from src/slskd/**/Types), the same
// source `fixtures.js` mirrors. What the plugin does not read is left out.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const https = require("node:https");
const { file: fixtureFile, response: fixtureResponse } = require("./fixtures.js");
const { createRecorder, loadRecording, replaySearchAt, replayTransferAt } = require("./slskdRecording.js");

// ---------------------------------------------------------------------------
// Scenarios — what the fake pretends the world looks like.

const SCENARIOS = {
  normal: "signed in; ten sharers with a spread of formats, one busy, one stalled, one that fails mid-transfer",
  empty: "signed in; every search finds nothing",
  slow: "signed in; results trickle in over ~25 s, past the playback fallback's 20 s search share",
  "peer-fails": "signed in; every transfer fails part-way",
  "vpn-blocked": "not signed in: the connection to Soulseek opens and is closed before an answer (what a work filter does)",
  "bad-password": "not signed in: Soulseek rejected the login",
  unauthorized: "slskd rejects the API key"
};

const SIGNED_OUT = { "vpn-blocked": true, "bad-password": true };

// ---------------------------------------------------------------------------
// Sharers. Every search is answered by the same cast, so a given query gives
// the same results every time. `timeline` drives what a transfer from them
// does; all times are milliseconds at scale 1.

const PEERS = [
  { username: "fake-hires", format: "flac24", freeSlot: true, speed: 6e6, folder: "Hi-Res" },
  { username: "fake-flac", format: "flac16", freeSlot: true, speed: 3e6 },
  { username: "fake-cdrip", format: "flac16", freeSlot: true, speed: 1.5e6, extraVariant: "Instrumental" },
  { username: "fake-320", format: "mp3-320", freeSlot: true, speed: 1.5e6 },
  { username: "fake-v0", format: "mp3-v0", freeSlot: true, speed: 1.2e6 },
  { username: "fake-busy", format: "flac16", freeSlot: false, queueLength: 37, queueMs: 30000, speed: 2e6 },
  { username: "fake-stalled", format: "mp3-320", freeSlot: true, stalls: true, speed: 0 },
  { username: "fake-flaky", format: "flac16", freeSlot: true, failsAt: 0.4, speed: 2e6 },
  { username: "fake-live", format: "mp3-192", freeSlot: true, speed: 1e6, variant: "Live", durationDelta: 95 },
  { username: "fake-locked", format: "flac16", freeSlot: true, locked: true, speed: 2e6 }
];

// kbps here is what size/duration works out to — the plugin's upgrade check
// divides the advertised size by the file's real duration, so these have to
// look like the format they claim.
const FORMATS = {
  flac24: { ext: "flac", label: "FLAC 24-96", kbps: 2900, bitRate: null, bitDepth: 24, sampleRate: 96000, vbr: false },
  flac16: { ext: "flac", label: "FLAC", kbps: 900, bitRate: null, bitDepth: 16, sampleRate: 44100, vbr: false },
  "mp3-320": { ext: "mp3", label: "320", kbps: 320, bitRate: 320, bitDepth: null, sampleRate: 44100, vbr: false },
  "mp3-v0": { ext: "mp3", label: "V0", kbps: 245, bitRate: 245, bitDepth: null, sampleRate: 44100, vbr: true },
  "mp3-192": { ext: "mp3", label: "192", kbps: 192, bitRate: 192, bitDepth: null, sampleRate: 44100, vbr: false }
};

// ---------------------------------------------------------------------------
// Deterministic results.

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seeded(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function titleCase(s) {
  return String(s).trim().replace(/\s+/g, " ").replace(/(^|\s)(\p{L})/gu, (m, sp, c) => sp + c.toUpperCase());
}

// The names a query is answered with. Soulseek returns only files whose path
// holds every search word, so every word of the query ends up in the path.
// "Artist - Title" splits on the dash; anything else becomes the title, with
// no artist (the plugin's own parse then has only the folder to go on).
function namesFor(query) {
  const q = String(query || "").trim();
  const dash = q.split(/\s+[-–—]\s+/);
  if (dash.length >= 2) return { artist: titleCase(dash[0]), title: titleCase(dash.slice(1).join(" - ")) };
  return { artist: null, title: titleCase(q) };
}

/** Every response a search for `query` produces, in arrival order. Pure. */
function responsesFor(query) {
  const rnd = seeded(hashString(String(query).toLowerCase()));
  const names = namesFor(query);
  const baseSecs = 170 + Math.floor(rnd() * 130);
  const year = 1975 + Math.floor(rnd() * 45);
  const trackNo = 1 + Math.floor(rnd() * 11);
  const album = names.artist ? "Fake Sessions" : null;

  return PEERS.map(function (peer, i) {
    const fmt = FORMATS[peer.format];
    const durationSecs = baseSecs + (peer.durationDelta || 0) + Math.round((rnd() - 0.5) * 2);
    const folderBits = [
      names.artist ? names.artist + " - " + album : names.title,
      "(" + year + ")",
      "[" + (peer.folder || fmt.label) + "]"
    ];
    const folder = "@@" + peer.username + "\\Music\\" + folderBits.join(" ");
    const fileFor = function (variant, number, secs) {
      const title = names.title + (variant ? " (" + variant + ")" : "");
      return fixtureFile({
        filename: folder + "\\" + String(number).padStart(2, "0") + " - " + title + "." + fmt.ext,
        extension: fmt.ext,
        size: Math.round((fmt.kbps * 1000 / 8) * secs),
        length: secs,
        bitRate: fmt.bitRate,
        bitDepth: fmt.bitDepth,
        sampleRate: fmt.sampleRate,
        isVariableBitRate: fmt.vbr
      });
    };
    const files = [fileFor(peer.variant || null, trackNo, durationSecs)];
    if (peer.extraVariant) files.push(fileFor(peer.extraVariant, trackNo + 1, durationSecs + 3));
    return fixtureResponse({
      username: peer.username,
      hasFreeUploadSlot: peer.freeSlot,
      queueLength: peer.queueLength || 0,
      uploadSpeed: peer.speed || 1000,
      fileCount: peer.locked ? 0 : files.length,
      lockedFileCount: peer.locked ? files.length : 0,
      files: peer.locked ? [] : files,
      lockedFiles: peer.locked ? files : [],
      token: i + 1
    });
  });
}

// ---------------------------------------------------------------------------
// Transfers: a transfer's state is a pure function of its age, so a poll at
// any moment sees a consistent story and tests can step a clock.

const STEP_MS = { requested: 300, initializing: 500 };

function peerFor(username) {
  return PEERS.find((p) => p.username === username) || { username, freeSlot: true, speed: 2e6 };
}

/** Where a transfer is `ageMs` after it was enqueued. Pure. */
function transferAt(t, ageMs, scenario, scale) {
  const peer = peerFor(t.username);
  const s = scale || 1;
  const size = t.size || 1;
  const failsAt = scenario === "peer-fails" ? 0.4 : peer.failsAt;
  let at = STEP_MS.requested * s;
  if (ageMs < at) return { state: "Requested", bytes: 0 };
  if (!peer.freeSlot) {
    const queueMs = (peer.queueMs || 0) * s;
    if (ageMs < at + queueMs) {
      return { state: "Queued, Remotely", bytes: 0, placeInQueue: Math.max(1, Math.ceil((at + queueMs - ageMs) / (1000 * s))) };
    }
    at += queueMs;
  }
  at += STEP_MS.initializing * s;
  if (ageMs < at || peer.stalls) return { state: "Initializing", bytes: 0 };
  const speed = (peer.speed || 2e6) / s;
  const bytes = Math.min(size, Math.floor(((ageMs - at) / 1000) * speed));
  if (failsAt != null && bytes >= size * failsAt) {
    return { state: "Completed, Errored", bytes: Math.floor(size * failsAt), exception: "Remote connection closed" };
  }
  if (bytes < size) return { state: "InProgress", bytes, averageSpeed: speed };
  return { state: "Completed, Succeeded", bytes: size, averageSpeed: speed };
}

// What to encode a finished file as, from what the search advertised.
function formatFromFile(f) {
  const ext = String((f && f.extension) || remoteBasename(f && f.filename).split(".").pop() || "mp3").toLowerCase();
  return { ext, bitRate: f && f.bitRate != null ? f.bitRate : null, bitDepth: f && f.bitDepth != null ? f.bitDepth : null,
    sampleRate: (f && f.sampleRate) || 44100, vbr: !!(f && f.isVariableBitRate) };
}

// ---------------------------------------------------------------------------
// Files on disk.

function remoteBasename(filename) {
  const parts = String(filename || "").split(/[\\/]/);
  return parts[parts.length - 1] || "file";
}

function remoteDirname(filename) {
  const s = String(filename || "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i >= 0 ? s.slice(0, i) : "";
}

// A destination comes from the plugin; never let it point outside the root.
function inside(root, rel) {
  const full = path.resolve(root, rel || ".");
  const r = path.resolve(root);
  return full === r || full.startsWith(r + path.sep) ? full : null;
}

function parsedTags(filename) {
  const stem = remoteBasename(filename).replace(/\.[A-Za-z0-9]{1,5}$/, "");
  const m = stem.match(/^(\d{1,3})\s*-\s*(.+)$/);
  const folder = remoteBasename(remoteDirname(filename)).replace(/\s*\(\d{4}\).*$/, "");
  const fparts = folder.split(" - ");
  return {
    track: m ? m[1] : null,
    title: m ? m[2] : stem,
    artist: fparts.length >= 2 ? fparts[0] : null,
    album: fparts.length >= 2 ? fparts.slice(1).join(" - ") : folder
  };
}

// Audio the app can actually play, at the advertised duration and quality, so
// the Replace dialog and the upgrade check read what the search promised. A
// tone, not noise: FLAC of noise at 24/96 would be over 100 MB a song.
function ffmpegArgs(out, info) {
  const fmt = info.format || {};
  const tags = parsedTags(info.filename);
  const freq = 220 + (hashString(info.filename) % 440);
  const args = ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=" + freq + ":sample_rate=" + (fmt.sampleRate || 44100) + ":duration=" + Math.max(1, info.durationSecs || 30),
    "-af", "volume=0.2"];
  for (const [k, v] of Object.entries({ title: tags.title, artist: tags.artist, album: tags.album, track: tags.track })) {
    if (v) args.push("-metadata", k + "=" + v);
  }
  const kbps = (fmt.bitRate || 256) + "k";
  if (fmt.ext === "flac") args.push("-c:a", "flac", "-sample_fmt", fmt.bitDepth === 24 ? "s32" : "s16");
  else if (fmt.ext === "wav") args.push("-c:a", fmt.bitDepth === 24 ? "pcm_s24le" : "pcm_s16le");
  else if (fmt.ext === "m4a" || fmt.ext === "aac") args.push("-c:a", "aac", "-b:a", kbps);
  else if (fmt.ext === "ogg") args.push("-c:a", "libvorbis", "-b:a", kbps);
  else if (fmt.ext === "opus") args.push("-c:a", "libopus", "-b:a", kbps);
  else if (fmt.vbr) args.push("-c:a", "libmp3lame", "-q:a", "0");
  else args.push("-c:a", "libmp3lame", "-b:a", (fmt.bitRate || 320) + "k");
  args.push(out);
  return args;
}

function writeAudio(out, info, mode) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (mode === "stub") {
    fs.writeFileSync(out, "fake slskd stub: " + info.filename + "\n");
    return Promise.resolve();
  }
  const ext = (info.format && info.format.ext) || "";
  if (mode !== "stub" && !(mode && mode.source) && !/^(flac|mp3|wav|m4a|aac|ogg|opus)$/.test(ext)) {
    // A container ffmpeg would have to guess at (ape, wv, …): a placeholder.
    fs.writeFileSync(out, "fake slskd: no encoder for ." + (ext || "?") + "\n");
    return Promise.resolve();
  }
  if (mode && mode.source) {
    fs.copyFileSync(mode.source, out);
    return Promise.resolve();
  }
  return new Promise(function (resolve, reject) {
    const child = spawn(mode && mode.ffmpeg ? mode.ffmpeg : "ffmpeg", ffmpegArgs(out, info), { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg exited " + code + ": " + err.trim()))));
  });
}

function listing(dir, relTo) {
  const node = { name: path.basename(dir), fullName: path.relative(relTo, dir).split(path.sep).join("/"), files: [], directories: [] };
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return node; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) node.directories.push(listing(full, relTo));
    else if (e.isFile()) {
      const st = fs.statSync(full);
      node.files.push({ name: e.name, fullName: path.relative(relTo, full).split(path.sep).join("/"), length: st.size, createdAt: st.birthtime.toISOString(), modifiedAt: st.mtime.toISOString() });
    }
  }
  return node;
}

// ---------------------------------------------------------------------------
// The server.

/**
 * opts: { port (0 = any), host, scenario, apiKey (null = accept any), scale
 * (time multiplier, <1 = faster), downloads (absolute dir), audio ("ffmpeg" |
 * "stub" | { source } | { ffmpeg }), now (clock, for tests), log (fn),
 * upstream (a real slskd's URL: proxy to it), upstreamKey (its API key — else
 * the plugin's own is forwarded), upstreamInsecure, record (dir: save what the
 * upstream answers), replay (dir: answer recorded queries from it), salt /
 * saltPath (the username key, see slskdRecording.js) }.
 * Resolves { url, port, close(), state }.
 */
function createFakeSlskd(opts) {
  const o = Object.assign({ port: 5039, host: "127.0.0.1", scenario: "normal", apiKey: null, scale: 1, audio: "ffmpeg" }, opts || {});
  if (!SCENARIOS[o.scenario]) throw new Error("unknown scenario \"" + o.scenario + "\" — one of: " + Object.keys(SCENARIOS).join(", "));
  const now = o.now || Date.now;
  const log = o.log || function () {};
  const downloads = path.resolve(o.downloads || path.join(require("node:os").tmpdir(), "fake-slskd", "downloads"));
  const incomplete = path.join(path.dirname(downloads), "incomplete");
  fs.mkdirSync(downloads, { recursive: true });

  const state = { scenario: o.scenario, searches: {}, transfers: {}, writes: {} };
  const recorder = o.upstream && o.record ? createRecorder(path.resolve(o.record), { now, salt: o.salt, saltPath: o.saltPath }) : null;
  const recording = o.replay ? loadRecording(path.resolve(o.replay)) : null;
  if (recording) log("replaying " + recording.queries.length + " recorded search(es) and " + Object.keys(recording.transfers).length + " transfer(s)");
  // Sent on every answer: how the plugin knows it is talking to a fake (its
  // Settings → Test server row appears only then) and which kind.
  const MODE = o.upstream ? (recorder ? "record" : "proxy") : (recording ? "replay" : "generated");
  const signedOut = !!SIGNED_OUT[o.scenario];

  function searchView(s, withResponses) {
    if (s.replay) return replayedSearchView(s, withResponses);
    const age = now() - s.startedAt;
    const gap = (o.scenario === "slow" ? 2500 : 250) * o.scale;
    const all = s.stoppedAt != null || o.scenario === "empty" ? s.arrived : s.all.slice(0, Math.min(s.all.length, Math.floor(age / gap)));
    s.arrived = all;
    const done = s.stoppedAt != null || o.scenario === "empty" ? true : age >= gap * (s.all.length + 2);
    const endState = s.stoppedAt != null ? "Completed, Cancelled" : "Completed, TimedOut";
    const out = {
      id: s.id,
      searchText: s.searchText,
      token: s.token,
      state: done ? endState : "InProgress",
      isComplete: done,
      startedAt: new Date(s.startedAt).toISOString(),
      endedAt: done ? new Date(s.stoppedAt != null ? s.stoppedAt : s.startedAt + gap * (s.all.length + 2)).toISOString() : null,
      responseCount: all.length,
      fileCount: all.reduce((n, r) => n + r.fileCount, 0),
      lockedFileCount: all.reduce((n, r) => n + r.lockedFileCount, 0)
    };
    if (withResponses) out.responses = all;
    return out;
  }

  function replayedSearchView(s, withResponses) {
    const age = (s.stoppedAt != null ? s.stoppedAt : now()) - s.startedAt;
    const r = replaySearchAt(s.replay, age, o.scale);
    s.arrived = r.responses;
    const st = r.done ? r.state : (s.stoppedAt != null ? "Completed, Cancelled" : r.state);
    const done = /Completed/.test(st);
    const out = { id: s.id, searchText: s.searchText, token: s.token, state: st, isComplete: done,
      startedAt: new Date(s.startedAt).toISOString(), endedAt: done ? new Date(s.startedAt + age).toISOString() : null,
      responseCount: r.responseCount, fileCount: r.fileCount, lockedFileCount: r.lockedFileCount };
    if (withResponses) out.responses = r.responses;
    return out;
  }

  function progressAt(t, ageMs) {
    return t.replay ? replayTransferAt(t.replay, ageMs, o.scale) : transferAt(t, ageMs, o.scenario, o.scale);
  }

  function transferView(t) {
    if (t.cancelledAt != null && !t.frozen) {
      const at = progressAt(t, t.cancelledAt - t.enqueuedAt);
      t.frozen = { state: "Completed, Cancelled", bytes: at.bytes };
    }
    let cur = t.frozen || progressAt(t, now() - t.enqueuedAt);
    if (!t.frozen && cur.state === "Completed, Succeeded") {
      // The file has to be on disk before slskd says it succeeded.
      const w = state.writes[t.id];
      if (!w) {
        const out = inside(downloads, path.join(t.destination || "", remoteBasename(t.filename)));
        state.writes[t.id] = { done: false };
        if (out) {
          writeAudio(out, { filename: t.filename, durationSecs: t.length, format: t.format }, o.audio)
            .then(() => { state.writes[t.id].done = true; log("wrote " + out); })
            .catch((e) => { state.writes[t.id].error = String(e.message || e); log("couldn't write " + out + ": " + state.writes[t.id].error); });
        } else {
          state.writes[t.id].error = "destination outside the downloads folder";
        }
      }
      const wr = state.writes[t.id];
      if (wr.error) t.frozen = cur = { state: "Completed, Errored", bytes: cur.bytes, exception: wr.error };
      else if (!wr.done) cur = { state: "InProgress", bytes: Math.max(0, t.size - 1), averageSpeed: cur.averageSpeed };
      else t.frozen = cur;
    } else if (!t.frozen && /Completed/.test(cur.state)) {
      t.frozen = cur;
    }
    const ended = /Completed/.test(cur.state);
    return {
      id: t.id,
      username: t.username,
      direction: "Download",
      filename: t.filename,
      size: t.size,
      startOffset: 0,
      state: cur.state,
      requestedAt: new Date(t.enqueuedAt).toISOString(),
      enqueuedAt: new Date(t.enqueuedAt).toISOString(),
      startedAt: cur.bytes > 0 ? new Date(t.enqueuedAt).toISOString() : null,
      endedAt: ended ? new Date(now()).toISOString() : null,
      bytesTransferred: cur.bytes,
      bytesRemaining: Math.max(0, t.size - cur.bytes),
      averageSpeed: cur.averageSpeed || 0,
      percentComplete: t.size ? Math.round((cur.bytes / t.size) * 1000) / 10 : 0,
      placeInQueue: cur.placeInQueue != null ? cur.placeInQueue : null,
      exception: cur.exception || null
    };
  }

  function grouped() {
    const byUser = {};
    for (const t of Object.values(state.transfers)) {
      const v = transferView(t);
      const u = (byUser[t.username] = byUser[t.username] || { username: t.username, directories: {} });
      const dir = remoteDirname(t.filename);
      (u.directories[dir] = u.directories[dir] || { directory: dir, fileCount: 0, files: [] }).files.push(v);
      u.directories[dir].fileCount++;
    }
    return Object.values(byUser).map((u) => ({ username: u.username, directories: Object.values(u.directories) }));
  }

  function logLines() {
    const at = new Date(now()).toISOString();
    const lines = o.scenario === "vpn-blocked"
      ? ["Connected to the Soulseek server", "Disconnected from the Soulseek server: \"Remote connection closed\""]
      : o.scenario === "bad-password"
        ? ["Connected to the Soulseek server", "Failed to log in to the Soulseek server: INVALIDPASS"]
        : ["Connected to the Soulseek server", "Logged in to the Soulseek server as fake-me"];
    return lines.map((message) => ({ timestamp: at, level: "Information", context: "SoulseekClient", message }));
  }

  // Each handler returns [status, body]; a string body is sent as a JSON
  // string, which is how slskd reports most failures.
  async function handle(method, url, body) {
    const route = url.pathname;
    const p = route.split("/").filter(Boolean).map(decodeURIComponent);
    if (p[0] !== "api" || p[1] !== "v0") return [404, "not found"];
    const r = p.slice(2);

    if (method === "GET" && r[0] === "session" && r[1] === "enabled") return [200, true];
    if (method === "POST" && r[0] === "session" && r.length === 1) return [200, { token: "fake-admin-token", name: "slskd", tokenType: "Bearer" }];

    if (method === "GET" && r[0] === "application") {
      if (recording && recording.application && !signedOut) return [200, recording.application];
      return [200, {
        server: signedOut
          ? { address: "server.slsknet.org:2242", state: "Disconnected", isConnected: false, isLoggedIn: false, isTransitioning: false }
          : { address: "server.slsknet.org:2242", state: "Connected, LoggedIn", isConnected: true, isLoggedIn: true, isTransitioning: false },
        user: { username: signedOut ? null : "fake-me" },
        version: { current: "0.24.0-fake", full: "0.24.0-fake (fake slskd, scenario " + o.scenario + ")" },
        shares: { directories: 3, files: 120 }
      }];
    }
    if (method === "GET" && r[0] === "options" && r.length === 1) {
      return [200, { directories: { downloads, incomplete }, remoteFileManagement: true, remoteConfiguration: true }];
    }
    if (r[0] === "options" && r[1] === "yaml") {
      if (method === "GET" && r.length === 2) return [200, state.yaml || "shares:\n  directories: []\n"];
      if (method === "POST" && r[2] === "validate") return [200, ""];
      if (method === "PUT") { state.yaml = typeof body === "string" ? body : ""; return [200, ""]; }
    }
    if (r[0] === "shares") {
      if (method === "GET") return [200, { local: [{ localPath: path.join(path.dirname(downloads), "shared"), isExcluded: false }] }];
      if (method === "PUT") return [204, null];
    }
    if (method === "GET" && r[0] === "logs") return [200, logLines()];

    if (r[0] === "searches") {
      if (method === "POST" && r.length === 1) {
        if (signedOut) return [409, "The server connection must be connected and logged in to perform a search (currently: Disconnected)"];
        const text = body && typeof body.searchText === "string" ? body.searchText.trim() : "";
        if (!text) return [400, "searchText is required"];
        const recorded = recording && o.scenario !== "empty" ? recording.search(text) : null;
        const s = { id: crypto.randomUUID(), searchText: text, token: Object.keys(state.searches).length + 1, startedAt: now(), stoppedAt: null,
          replay: recorded, all: recorded ? (recorded.responses || []) : (o.scenario === "empty" ? [] : responsesFor(text)), arrived: [] };
        state.searches[s.id] = s;
        log("search “" + text + "” → " + s.all.length + " responses" + (recorded ? " (recorded)" : " (generated)"));
        return [200, searchView(s, false)];
      }
      const s = state.searches[r[1]];
      if (!s) return [404, "search not found"];
      if (method === "GET" && r[2] === "responses") { searchView(s, false); return [200, s.arrived]; }
      if (method === "GET" && r.length === 2) return [200, searchView(s, url.searchParams.get("includeResponses") === "true")];
      if (method === "PUT" && r.length === 2) { if (s.stoppedAt == null) { searchView(s, false); s.stoppedAt = now(); } return [200, searchView(s, false)]; }
      if (method === "DELETE" && r.length === 2) { delete state.searches[s.id]; return [204, null]; }
    }

    if (r[0] === "transfers" && r[1] === "downloads") {
      if (method === "GET" && r.length === 2) return [200, grouped()];
      if (method === "POST" && r[2] === "batches") {
        if (signedOut) return [409, "The server connection must be connected and logged in to download (currently: Disconnected)"];
        const username = body && body.username;
        const files = (body && Array.isArray(body.files)) ? body.files : [];
        if (!username || !files.length) return [400, "username and files are required"];
        const destination = body.options && body.options.destination ? String(body.options.destination) : "";
        if (!inside(downloads, destination)) return [400, "destination must be inside the downloads folder"];
        const known = {};
        for (const resp of Object.values(state.searches).flatMap((s) => s.all)) {
          for (const f of resp.files.concat(resp.lockedFiles)) known[resp.username + "\0" + f.filename] = f;
        }
        const enqueued = [];
        const failures = [];
        for (const f of files) {
          const live = Object.values(state.transfers).some((t) => t.username === username && t.filename === f.filename && !/Completed/.test(transferView(t).state));
          if (live) { failures.push({ filename: f.filename, message: "already queued" }); continue; }
          const ad = known[username + "\0" + f.filename];
          const replay = recording ? recording.transfers[username + "\0" + f.filename] || null : null;
          const t = { id: crypto.randomUUID(), username, filename: f.filename, size: Number(f.size) || (ad && ad.size) || 5e6,
            length: ad && ad.length ? ad.length : 200, format: formatFromFile(ad || { filename: f.filename }),
            replay, destination, enqueuedAt: now(), cancelledAt: null, frozen: null };
          state.transfers[t.id] = t;
          enqueued.push({ id: t.id, filename: t.filename, size: t.size });
        }
        log("queued " + enqueued.length + " file(s) from " + username + (failures.length ? ", refused " + failures.length : ""));
        return [failures.length && enqueued.length ? 207 : (enqueued.length ? 201 : 409), failures.length && !enqueued.length ? failures[0].message : { enqueued, failures }];
      }
      if (method === "DELETE" && r.length === 4) {
        const t = state.transfers[r[3]];
        if (!t || t.username !== r[2]) return [404, "transfer not found"];
        if (t.cancelledAt == null && !t.frozen) t.cancelledAt = now();
        if (url.searchParams.get("remove") === "true") delete state.transfers[t.id];
        return [204, null];
      }
    }

    if (r[0] === "files" && r[1] === "downloads" && r[2] === "directories") {
      const rel = r[3] != null ? Buffer.from(r[3], "base64").toString("utf8") : "";
      const dir = inside(downloads, rel);
      if (!dir) return [400, "outside the downloads folder"];
      if (method === "GET") {
        if (!fs.existsSync(dir)) return [404, "directory not found"];
        // A targeted listing names files relative to THAT directory, as slskd does.
        return [200, listing(dir, rel ? dir : downloads)];
      }
      if (method === "DELETE" && rel) {
        if (!fs.existsSync(dir)) return [404, "directory not found"];
        fs.rmSync(dir, { recursive: true, force: true });
        log("deleted " + dir);
        return [204, null];
      }
    }

    return [404, "no such endpoint in the fake slskd: " + method + " " + route];
  }

  // Record mode: the real slskd answers; the recorder only watches.
  function forward(req, raw) {
    const target = new URL(req.url, o.upstream);
    const headers = { Accept: req.headers.accept || "application/json" };
    if (req.headers["content-type"]) headers["Content-Type"] = req.headers["content-type"];
    if (req.headers.authorization) headers.Authorization = req.headers.authorization;
    const key = o.upstreamKey || req.headers["x-api-key"];
    if (key) headers["X-API-Key"] = key;
    const lib = target.protocol === "https:" ? https : http;
    return new Promise(function (resolve, reject) {
      const up = lib.request(target, { method: req.method, headers, rejectUnauthorized: !o.upstreamInsecure }, function (r) {
        let text = "";
        r.setEncoding("utf8");
        r.on("data", (d) => { text += d; });
        r.on("end", () => resolve({ status: r.statusCode, text, type: r.headers["content-type"] }));
      });
      up.on("error", reject);
      if (raw) up.write(raw);
      up.end();
    });
  }

  async function proxy(req, res, raw, url) {
    let up;
    try {
      up = await forward(req, raw);
    } catch (e) {
      log(req.method + " " + url.pathname + " → upstream unreachable: " + e.message);
      res.writeHead(502, { "Content-Type": "application/json", "X-Fake-Slskd": MODE });
      res.end(JSON.stringify("fake slskd: the upstream slskd didn't answer (" + e.message + ")"));
      return;
    }
    log(req.method + " " + url.pathname + url.search + " → " + up.status + " (upstream)");
    res.writeHead(up.status, { "Content-Type": up.type || "application/json", "X-Fake-Slskd": MODE });
    res.end(up.text);
    if (!recorder) return;
    let body = null;
    let json = null;
    try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = null; }
    try { json = up.text ? JSON.parse(up.text) : null; } catch (e) { json = null; }
    try { recorder.observe(req.method, url, body, up.status, json); } catch (e) { log("recorder: " + e.message); }
  }

  const server = http.createServer(function (req, res) {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", async function () {
      const url = new URL(req.url, "http://fake");
      if (o.upstream) return proxy(req, res, raw, url);
      const open = url.pathname === "/api/v0/session/enabled" || (req.method === "POST" && url.pathname === "/api/v0/session");
      const key = req.headers["x-api-key"];
      const bearer = /^Bearer /.test(req.headers.authorization || "");
      let status;
      let payload;
      if (!open && !bearer && (o.scenario === "unauthorized" || (o.apiKey && key !== o.apiKey))) {
        status = 401;
        payload = null;
      } else {
        let body = null;
        if (raw) { try { body = JSON.parse(raw); } catch (e) { body = raw; } }
        try {
          [status, payload] = await handle(req.method, url, body);
        } catch (e) {
          status = 500;
          payload = String((e && e.message) || e);
        }
      }
      log(req.method + " " + url.pathname + url.search + " → " + status);
      res.writeHead(status, { "Content-Type": "application/json", "X-Fake-Slskd": MODE });
      res.end(payload === null || payload === undefined ? "" : JSON.stringify(payload));
    });
  });

  return new Promise(function (resolve, reject) {
    server.once("error", reject);
    server.listen(o.port, o.host, function () {
      const port = server.address().port;
      resolve({
        url: "http://" + o.host + ":" + port,
        port,
        downloads,
        state,
        close: () => new Promise((done) => {
          if (recorder) recorder.flush();
          server.close(() => done());
        })
      });
    });
  });
}

module.exports = { createFakeSlskd, responsesFor, transferAt, namesFor, SCENARIOS, PEERS, FORMATS };
