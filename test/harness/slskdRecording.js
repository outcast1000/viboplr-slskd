"use strict";
// Record what a REAL slskd answers, anonymised, and play it back later.
//
// Recording runs the fake slskd as a proxy in front of the real one (off the
// VPN): every request is forwarded unchanged and the real answer goes back to
// the plugin, so the app is used normally. Alongside, what came back is
// written to a recording folder:
//
//   application.json            the signed-in status (whitelisted fields)
//   searches/<slug>.json        one per query: every poll with its time since
//                               the search started, then the final responses
//   transfers.json              per transfer: every state change with its
//                               time since the download was queued
//
// Replay reads that folder: a search for a recorded query returns the real
// responses on the recorded clock, a download of a recorded file follows the
// recorded timeline (queue positions, stalls, failures and all). Anything not
// recorded falls back to the generated data.
//
// ANONYMISING is the point of most of this file. Real answers carry other
// Soulseek users' names and the folders they share from. So:
//   - everything is WHITELISTED: a field not named below is dropped, which
//     keeps a future slskd field from leaking without anyone deciding to;
//   - usernames become `peer-<8 hex>`: an HMAC keyed by a salt kept in the
//     user's home folder, NOT in the recording, so the same sharer gets the
//     same name across recordings without the recording being reversible by
//     trying candidate names;
//   - a remote path keeps only its last two segments (the album folder and the
//     file), re-rooted under the fake sharer: share roots, drive letters and
//     home folders live above that and never reach disk;
//   - free text that survives (folder and file names, error messages) has IP
//     addresses, email addresses and any recorded username replaced.
// Review a recording before committing it anyway — a folder name can still
// say something about who ripped it.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

// ---------------------------------------------------------------------------
// Anonymising (pure apart from the salt).

function defaultSaltPath() {
  return path.join(os.homedir(), ".config", "fake-slskd", "salt");
}

/** The salt that keys usernames; created on first use, never written into a recording. */
function loadSalt(saltPath) {
  const p = saltPath || defaultSaltPath();
  try {
    const s = fs.readFileSync(p, "utf8").trim();
    if (s) return s;
  } catch (e) { /* first use */ }
  const s = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s + "\n", { mode: 0o600 });
  return s;
}

function makeAnonymiser(salt) {
  const users = {}; // real → fake, for scrubbing names out of free text

  function user(name) {
    if (name == null || name === "") return name;
    const real = String(name);
    if (!users[real]) users[real] = "peer-" + crypto.createHmac("sha256", salt).update(real).digest("hex").slice(0, 8);
    return users[real];
  }

  function text(s) {
    if (s == null) return s;
    let out = String(s)
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "user@example.invalid")
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "203.0.113.1")
      .replace(/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, "2001:db8::1");
    // Longest first, so "bob" can't eat part of "bobby".
    for (const real of Object.keys(users).sort((a, b) => b.length - a.length)) {
      if (real.length >= 3) out = out.split(real).join(users[real]);
    }
    return out;
  }

  function remotePath(filename, anonUser) {
    const segs = String(filename || "").split(/[\\/]+/).filter(Boolean);
    const kept = segs.slice(-2).map(text);
    return "@@" + anonUser + "\\Music\\" + kept.join("\\");
  }

  return { user, text, remotePath, users };
}

const FILE_FIELDS = ["extension", "size", "length", "bitRate", "bitDepth", "sampleRate", "isVariableBitRate", "code"];

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj && obj[f] !== undefined) out[f] = obj[f];
  return out;
}

function anonFile(f, anonUser, A) {
  return Object.assign({ filename: A.remotePath(f && f.filename, anonUser) }, pick(f, FILE_FIELDS));
}

/** One search response, whitelisted and anonymised. */
function anonResponse(r, A) {
  const u = A.user(r && r.username);
  return Object.assign(
    { username: u },
    pick(r, ["hasFreeUploadSlot", "queueLength", "uploadSpeed", "fileCount", "lockedFileCount", "token"]),
    {
      files: ((r && r.files) || []).map((f) => anonFile(f, u, A)),
      lockedFiles: ((r && r.lockedFiles) || []).map((f) => anonFile(f, u, A))
    }
  );
}

function anonApplication(st) {
  const s = (st && st.server) || {};
  return {
    server: Object.assign({ address: "server.slsknet.org:2242" }, pick(s, ["state", "isConnected", "isLoggedIn", "isTransitioning"])),
    user: { username: s.isLoggedIn === false ? null : "fake-me" },
    version: { current: String((st && st.version && st.version.current) || "unknown") + "-recorded" },
    shares: pick(st && st.shares, ["directories", "files"])
  };
}

function slug(query) {
  const base = String(query).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "query";
  return base + "-" + crypto.createHash("sha256").update(normQuery(query)).digest("hex").slice(0, 6);
}

function normQuery(q) {
  return String(q || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Recorder: watches proxied exchanges.

function createRecorder(dir, opts) {
  const o = opts || {};
  const now = o.now || Date.now;
  const A = makeAnonymiser(o.salt || loadSalt(o.saltPath));
  const searches = {};   // slskd search id → { query, startedAt, polls, responses }
  const queued = {};     // real user \0 real filename → { at, key }
  const transfers = loadJson(path.join(dir, "transfers.json")) || {};
  fs.mkdirSync(path.join(dir, "searches"), { recursive: true });

  function saveSearch(s) {
    const file = path.join(dir, "searches", slug(s.query) + ".json");
    writeJson(file, { query: s.query, recordedAt: new Date(s.startedAt).toISOString(), polls: s.polls, responsesAt: s.responsesAt, responses: s.responses || [] });
  }

  let pending = null;
  function saveTransfers() {
    if (pending) return;
    pending = setTimeout(function () { pending = null; writeJson(path.join(dir, "transfers.json"), transfers); }, 200);
  }

  function pollOf(json, t) {
    return Object.assign({ t }, pick(json, ["state", "responseCount", "fileCount", "lockedFileCount"]));
  }

  /** Called after every proxied request. `body`/`json` are parsed when JSON. */
  function observe(method, url, body, status, json) {
    const p = url.pathname.split("/").filter(Boolean).map(decodeURIComponent).slice(2);
    if (status < 200 || status >= 300) return;

    if (method === "GET" && p[0] === "application" && json) {
      writeJson(path.join(dir, "application.json"), anonApplication(json));
      return;
    }
    if (p[0] === "searches") {
      if (method === "POST" && p.length === 1 && json && json.id) {
        const s = { query: body && body.searchText, startedAt: now(), polls: [], responses: null };
        s.polls.push(pollOf(json, 0));
        searches[json.id] = s;
        return;
      }
      const s = searches[p[1]];
      if (!s) return;
      const t = now() - s.startedAt;
      const list = p[2] === "responses" ? json : (url.searchParams.get("includeResponses") === "true" && json ? json.responses : null);
      if (method === "GET" && Array.isArray(list)) {
        s.responses = list.map((r) => anonResponse(r, A));
        s.responsesAt = t;
        saveSearch(s);
      } else if (method === "GET" && p.length === 2 && json) {
        s.polls.push(pollOf(json, t));
      } else if (method === "PUT" && p.length === 2) {
        s.polls.push({ t, stopped: true });
      }
      return;
    }
    if (p[0] === "transfers" && p[1] === "downloads") {
      if (method === "POST" && p[2] === "batches" && body) {
        const u = A.user(body.username);
        for (const f of body.files || []) {
          const key = u + "\0" + A.remotePath(f.filename, u);
          queued[body.username + "\0" + f.filename] = { at: now(), key };
          transfers[key] = { size: f.size || null, recordedAt: new Date().toISOString(), timeline: [] };
        }
        saveTransfers();
        return;
      }
      if (method === "GET" && p.length === 2 && Array.isArray(json)) {
        for (const userGroup of json) {
          for (const d of (userGroup && userGroup.directories) || []) {
            for (const t of (d && d.files) || []) {
              const q = queued[(t.username || userGroup.username) + "\0" + t.filename];
              if (!q) continue; // queued before recording started: no start time to measure from
              const tl = transfers[q.key].timeline;
              const entry = Object.assign({ t: now() - q.at }, pick(t, ["state", "bytesTransferred", "averageSpeed", "placeInQueue"]),
                t.exception ? { exception: A.text(t.exception) } : {});
              const last = tl[tl.length - 1];
              if (last && last.state === entry.state && last.bytesTransferred === entry.bytesTransferred && last.placeInQueue === entry.placeInQueue) continue;
              tl.push(entry);
              if (t.size && !transfers[q.key].size) transfers[q.key].size = t.size;
              saveTransfers();
            }
          }
        }
      }
    }
  }

  function flush() {
    if (pending) { clearTimeout(pending); pending = null; }
    writeJson(path.join(dir, "transfers.json"), transfers);
  }

  return { observe, flush, anonymiser: A };
}

// ---------------------------------------------------------------------------
// Replay.

function loadRecording(dir) {
  const searches = {};
  const sdir = path.join(dir, "searches");
  let names = [];
  try { names = fs.readdirSync(sdir).filter((n) => n.endsWith(".json")); } catch (e) { /* none */ }
  for (const n of names) {
    const s = loadJson(path.join(sdir, n));
    if (s && s.query) searches[normQuery(s.query)] = s;
  }
  return {
    application: loadJson(path.join(dir, "application.json")),
    transfers: loadJson(path.join(dir, "transfers.json")) || {},
    search(query) { return searches[normQuery(query)] || null; },
    queries: Object.keys(searches)
  };
}

/** A recorded search's state `ageMs` in (recorded times × scale). Pure. */
function replaySearchAt(rec, ageMs, scale) {
  const s = scale || 1;
  const polls = (rec.polls || []).filter((x) => !x.stopped);
  let cur = polls[0] || { state: "InProgress", responseCount: 0, fileCount: 0, lockedFileCount: 0 };
  for (const x of polls) if (x.t * s <= ageMs) cur = x;
  const all = rec.responses || [];
  const done = /Completed/.test(cur.state || "");
  // Bodies are only known as the final list; reveal them in order, as many as
  // the recorded count says had arrived.
  const n = done ? all.length : Math.min(all.length, cur.responseCount || 0);
  return { state: cur.state || "InProgress", responseCount: cur.responseCount != null ? cur.responseCount : n, fileCount: cur.fileCount || 0, lockedFileCount: cur.lockedFileCount || 0, responses: all.slice(0, n), done };
}

/** A recorded transfer's state `ageMs` after it was queued. Pure. A timeline
 *  that ends mid-transfer holds its last state — which is what a stall is. */
function replayTransferAt(rec, ageMs, scale) {
  const s = scale || 1;
  let cur = { state: "Requested", bytesTransferred: 0 };
  for (const x of (rec && rec.timeline) || []) if (x.t * s <= ageMs) cur = x;
  return {
    state: cur.state,
    bytes: cur.bytesTransferred || 0,
    averageSpeed: cur.averageSpeed || 0,
    placeInQueue: cur.placeInQueue != null ? cur.placeInQueue : undefined,
    exception: cur.exception || undefined
  };
}

// ---------------------------------------------------------------------------

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

module.exports = {
  makeAnonymiser, anonResponse, anonApplication, loadSalt, defaultSaltPath,
  createRecorder, loadRecording, replaySearchAt, replayTransferAt, slug, normQuery
};
