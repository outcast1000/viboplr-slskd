"use strict";
// Download jobs: every Download is a job that searches, downloads, checks and
// then saves the file into the library (a song you don't have) or offers to
// replace your copy (one you do). Taken over, a job waits for the user at
// every step instead. Upgrade-specific behaviour is in upgrades.test.js.
const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { fakeHost } = require("./harness/host");

const plugin = loadPlugin();

const LIBRARY_MP3 = {
  id: 42, path: "file:///Users/me/Music/RH/06 Karma Police.mp3", title: "Karma Police", artist_name: "Radiohead",
  album_id: 7, album_title: "OK Computer", track_number: 6, format: "mp3", file_size: 6336000, duration_secs: 264
};

const LUCKY = [
  { username: "a", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 100, files: [{ filename: "m\\Radiohead\\OK Computer\\11 - Lucky.flac", size: 30e6, length: 264, bitDepth: 16 }] },
  { username: "b", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 10, files: [{ filename: "n\\Radiohead\\11 - Lucky.flac", size: 29e6, length: 264, bitDepth: 16 }] }
];

// A scripted slskd (as in upgrades.test.js) plus the host's import surface.
function jobHost(o) {
  const calls = { batches: [], cancels: [], imports: [], plans: [] };
  const live = {};
  const h = fakeHost({
    store: Object.assign({ upgradeTarget: "best" }, o.store || {}),
    // slskd's folder (/Users/me/Music/slskd) outside the library unless a test
    // says otherwise: the job then copies the file in through the host.
    collections: o.collections || [{ id: 1, name: "Music", path: "/Users/me/Library" }],
    library: { tracks: [Object.assign({}, LIBRARY_MP3)] },
    fetch: async (url, init) => {
      const json = (v, status) => ({ status: status || 200, text: async () => JSON.stringify(v) });
      const method = (init && init.method) || "GET";
      if (url.includes("/api/v0/searches") && method === "POST") return json({ id: "s1" });
      if (url.includes("/api/v0/searches/s1") && method === "PUT") return json({});
      if (url.includes("/responses")) return json(o.responses);
      if (url.includes("/api/v0/searches/s1")) return json({ id: "s1", state: "Completed, ResponseLimitReached", responseCount: 1, fileCount: 2 });
      if (url.includes("/api/v0/transfers/downloads/batches") && method === "POST") {
        const b = JSON.parse(init.body);
        calls.batches.push(b);
        live[b.username] = { file: b.files[0], polls: 0 };
        return json({ failures: [] });
      }
      if (url.endsWith("/api/v0/transfers/downloads") && method === "GET") {
        return json(Object.keys(live).map((u) => {
          const seq = (o.states && o.states[u]) || ["Queued, Remotely", "InProgress", "Completed, Succeeded"];
          const state = seq[Math.min(live[u].polls++, seq.length - 1)];
          const f = live[u].file;
          return { username: u, directories: [{ files: [{ id: "t-" + u, username: u, filename: f.filename, size: f.size, state,
            bytesTransferred: state === "InProgress" ? 1000 : (state.includes("Succeeded") ? f.size : 0) }] }] };
        }));
      }
      if (url.includes("/api/v0/files/downloads/directories/") && method === "GET") {
        const names = Object.keys(live).map((u) => live[u].file.filename.split("\\").pop());
        return json({ files: names.map((n) => ({ name: n, fullName: n, length: 1 })), directories: [] });
      }
      if (url.includes("/api/v0/transfers/downloads/") && method === "DELETE") {
        calls.cancels.push(decodeURIComponent(url.split("/api/v0/transfers/downloads/")[1].split("/")[0]));
        return { status: 200, text: async () => "" };
      }
      return undefined;
    }
  });
  h.api.system.readAudioTags = async (paths) => paths.map(() => ({ title: null, artist: null, album_artist: null, album: null, track_number: null, disc_number: null, year: null, genre: null, duration_secs: 264 }));
  h.api.library.planImport = async (req) => { calls.plans.push(req); return { collectionId: 1, collectionName: "Music", placement: "artist" }; };
  h.api.library.importFile = async (req) => {
    calls.imports.push(req);
    if (o.exists && !req.asCopy) return { status: "exists", trackId: 42, path: "/Users/me/Music/RH/06 Karma Police.mp3", collectionId: 1, collectionName: "Music", copies: 1 };
    return { status: "imported", trackId: 99, path: "/Users/me/Music/Radiohead/OK Computer/11 Lucky.flac", collectionId: 1, collectionName: "Music", placement: "artist" };
  };
  return { h, calls };
}

async function waitFor(pred, ms, what) {
  const until = Date.now() + (ms || 8000);
  while (Date.now() < until) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting" + (what ? " for " + what : ""));
}

async function pollUntil(p, pred, what) {
  for (let i = 0; i < 40; i++) {
    if (pred()) return;
    await p._refreshTransfers();
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("never reached: " + what);
}

function lastView(h) {
  const views = h.calls.views.filter((v) => v.viewId === "slskd-browse");
  return views[views.length - 1].data;
}

function findNodes(node, pred, out) {
  out = out || [];
  if (!node) return out;
  if (pred(node)) out.push(node);
  (node.children || []).forEach((c) => findNodes(c, pred, out));
  return out;
}

const job = (p) => p._upgrades().g1;
const LUCKY_TARGET = { kind: "track", title: "Lucky", artistName: "Radiohead", albumTitle: "OK Computer" };

test("parseSongQuery reads “Artist - Title”, or a bare title", () => {
  assert.deepEqual(plugin._parseSongQuery("Massive Attack - Angel"), { artistName: "Massive Attack", title: "Angel" });
  assert.deepEqual(plugin._parseSongQuery("  Teardrop  "), { title: "Teardrop", artistName: null });
  assert.equal(plugin._parseSongQuery("   "), null);
});

test("jobDestination says where a new song goes, and what an upgrade replaces", () => {
  const get = { key: "g1", kind: "get", trackId: null, artist: "Aphex Twin", album: "Windowlicker EP" };
  assert.equal(plugin._jobDestination(get), null, "nothing before the host has answered");
  assert.equal(plugin._jobDestination(Object.assign({ plan: { collectionName: "Music", placement: "artist" } }, get)), "→ Music · next to your Aphex Twin tracks");
  assert.equal(plugin._jobDestination(Object.assign({ plan: { collectionName: "Old drive", placement: "album" } }, get)), "→ Old drive · next to Windowlicker EP");
  assert.equal(plugin._jobDestination(Object.assign({ plan: { collectionName: "Music", placement: "only" } }, get)), "→ Music");
  assert.equal(plugin._jobDestination({ trackId: 42, path: "file:///m/a.mp3" }), "→ replaces /m/a.mp3");
});

test("integration: Download on a song you don't have runs search → download → check → save, and ends in the library", async () => {
  const p = loadPlugin();
  const { h, calls } = jobHost({ responses: LUCKY });
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-download"](LUCKY_TARGET);
    assert.ok(job(p), "a job exists");
    assert.equal(job(p).kind, "get");
    assert.equal(h.calls.navigated.length, 0, "the view doesn't open on its own");
    assert.match(h.calls.notifications[0], /Looking for “Lucky” on Soulseek/);
    await waitFor(() => job(p).plan, 2000, "the host to say where it goes");
    assert.deepEqual(calls.plans[0], { title: "Lucky", artist: "Radiohead", album: "OK Computer" });
    await waitFor(() => job(p).state === "downloading", 8000, "the download to start");
    assert.equal(calls.batches[0].username, "a", "the best sharer first");
    await pollUntil(p, () => job(p).state === "saved", "saved");
    assert.equal(calls.imports.length, 1);
    assert.equal(calls.imports[0].title, "Lucky");
    assert.equal(calls.imports[0].artist, "Radiohead");
    assert.equal(calls.imports[0].asCopy, false);
    assert.match(calls.imports[0].path, /11 - Lucky\.flac$/);
    assert.equal(job(p).saved.collectionName, "Music");
    const done = h.calls.notices[h.calls.notices.length - 1];
    assert.match(done.message, /“Lucky” is in your library/);
    assert.equal(done.options.action.id, "job-play-notice");
    h.actions["job-play-notice"]();
    assert.match(h.calls.played[0].path, /^file:\/\/.*11 Lucky\.flac$/, "Play plays the library copy");
  } finally {
    await p.deactivate();
  }
});

test("integration: a song already in the library turns into a replace, and Save as copy keeps both", async () => {
  const p = loadPlugin();
  const { h, calls } = jobHost({ responses: LUCKY, exists: true });
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-download"](LUCKY_TARGET);
    await waitFor(() => job(p).state === "downloading", 8000, "the download to start");
    await pollUntil(p, () => job(p).state === "ready" && job(p).trackId === 42, "turned into a replace");
    assert.match(job(p).message, /You already have it/);
    h.actions["main-tab"]({ tabId: "upgrades" });
    const labels = findNodes(lastView(h), (n) => n.type === "button").map((b) => b.label);
    assert.ok(labels.includes("Save as copy"), labels.join(", "));
    assert.ok(labels.some((l) => /replace/i.test(l)), labels.join(", "));
    h.actions["job-save-copy"]({ itemId: "g1" });
    await waitFor(() => job(p).state === "saved", 2000, "saved as a copy");
    assert.equal(calls.imports[1].asCopy, true);
  } finally {
    await p.deactivate();
  }
});

test("integration: Download and let me choose stops at the files found; Use this downloads, and Save waits for you", async () => {
  const p = loadPlugin();
  const { h, calls } = jobHost({ responses: LUCKY });
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-download-choose"](LUCKY_TARGET);
    assert.equal(job(p).manual, true);
    await waitFor(() => job(p).state === "choosing", 8000, "the pick");
    assert.equal(calls.batches.length, 0, "nothing downloads until you choose");
    h.actions["main-tab"]({ tabId: "upgrades" });
    const view = lastView(h);
    assert.ok(findNodes(view, (n) => n.type === "button" && n.action === "job-let-run").length, "Let it run again is offered");
    const sources = findNodes(view, (n) => n.type === "track-row-list" && n.actions && n.actions.some((a) => a.id === "upgrade-use-source"))[0];
    assert.ok(sources, "the files found are listed");
    h.actions["upgrade-use-source"]({ itemId: sources.items[1].id });
    await waitFor(() => calls.batches.length === 1, 2000, "the pick to be queued");
    assert.equal(calls.batches[0].username, "b", "your pick, not the automatic one");
    await pollUntil(p, () => job(p).state === "ready", "downloaded");
    assert.equal(calls.imports.length, 0, "a job you took over isn't saved for you");
    h.actions["job-save"]({ itemId: "g1" });
    await waitFor(() => job(p).state === "saved", 2000, "saved");
  } finally {
    await p.deactivate();
  }
});

test("integration: Take over on a running download keeps it going, and a stalled sharer is left to you", async () => {
  const p = loadPlugin();
  const { h, calls } = jobHost({ responses: LUCKY, states: { a: ["Queued, Remotely"] } });
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-download"](LUCKY_TARGET);
    await waitFor(() => job(p).state === "downloading", 8000, "downloading");
    h.actions["job-take-over"]({ itemId: "g1" });
    await waitFor(() => job(p).manual === true, 2000, "taken over");
    assert.equal(job(p).state, "downloading", "nothing running is cancelled");
    job(p).active.movedAt = 0;   // long past the stall limit
    await p._refreshTransfers();
    assert.equal(job(p).state, "downloading", "no next sharer for a job you took over");
    assert.equal(job(p).active.stalled, true);
    assert.equal(calls.batches.length, 1);
    assert.deepEqual(calls.cancels, []);
  } finally {
    await p.deactivate();
  }
});

test("integration: a download that lands inside a collection is rescanned there, not copied in twice", async () => {
  const p = loadPlugin();
  const { h, calls } = jobHost({ responses: LUCKY, collections: [{ id: 1, name: "Music", path: "/Users/me/Music" }] });
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-download"](LUCKY_TARGET);
    await waitFor(() => job(p).state === "downloading", 8000, "the download to start");
    await pollUntil(p, () => job(p).state === "saved", "saved");
    assert.equal(calls.imports.length, 0, "no copy");
    assert.deepEqual(h.calls.resync, [1]);
    assert.ok(!h.calls.notifications.some((m) => /^Scanning/.test(m)), "the job's own toast, not the generic scan notice");
    assert.match(h.calls.notifications[h.calls.notifications.length - 1], /on its way into your library/);
  } finally {
    await p.deactivate();
  }
});

test("integration: Download on a song you have as a file is an upgrade job, keyed by the library row", async () => {
  const p = loadPlugin();
  const { h } = jobHost({ responses: [] });
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-download"]({ kind: "track", trackId: 42, title: "Karma Police", artistName: "Radiohead" });
    const e = p._upgrades().t42;
    assert.ok(e, "the upgrade job exists");
    assert.equal(e.kind, "upgrade");
    assert.match(h.calls.notifications[0], /better copy/);
  } finally {
    await p.deactivate();
  }
});
