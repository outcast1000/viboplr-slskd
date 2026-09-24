"use strict";
// The playback fallback: the `slskd-fallback` stream resolver the host asks by
// metadata when a track has no playable source. Pure matching first, then the
// whole flow through a fake host and a scripted slskd — search, enqueue into
// the fallback folder, wait, locate, answer file://, and remember it so the
// next request for the same song never searches.

const test = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { fakeHost } = require("./harness/host.js");

const p = loadPlugin();
const SEP = p._KEY_SEP;

function cand(overrides) {
  return Object.assign({
    username: "peer", filename: "Music\\Radiohead\\OK Computer\\03 - Karma Police.mp3",
    size: 9000000, length: 264, bitRate: 320, bitDepth: null, sampleRate: 44100, isVariableBitRate: false,
    extension: "mp3", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 2000000,
    qualityTier: 1, availabilityTier: 0, formatRank: 0
  }, overrides || {});
}

// --- normalization and identity ----------------------------------------------

test("normalizeText lowercases, strips diacritics and punctuation", () => {
  assert.equal(p._normalizeText("Björk — Jóga (Remastered)"), "bjork joga remastered");
  assert.equal(p._normalizeText("Simon & Garfunkel"), "simon and garfunkel");
  assert.equal(p._normalizeText(null), "");
});

test("fallbackKey ignores edition words, years and stop words so the same song maps to one entry", () => {
  const a = p._fallbackKey("Karma Police (Remastered 2009)", "Radiohead");
  const b = p._fallbackKey("karma police", "RADIOHEAD");
  assert.equal(a, b);
  assert.notEqual(a, p._fallbackKey("Karma Police", "Someone Else"));
  // A title that is nothing but noise keeps its words rather than matching everything.
  assert.equal(p._fallbackKey("Live", "X"), "live|x");
});

test("fallbackQuery drops parentheticals and leads with the artist", () => {
  assert.equal(p._fallbackQuery("Karma Police (Remastered 2009)", "Radiohead"), "radiohead karma police");
  assert.equal(p._fallbackQuery("Jóga", "Björk"), "bjork joga");
  assert.equal(p._fallbackQuery("Creep", null), "creep");
});

// --- scoring -------------------------------------------------------------------

test("a file carrying the title and an artist folder scores fully", () => {
  const m = p._scoreFallbackCandidate(cand(), { title: ["karma", "police"], artist: ["radiohead"] });
  assert.equal(m.title, 1);
  assert.equal(m.artist, 1);
  assert.equal(m.penalty, 0);
  assert.ok(m.score > 0.99);
});

test("a variant the request did not ask for is penalized; one it did ask for is not", () => {
  const live = cand({ filename: "Music\\Radiohead\\Live\\Karma Police (live).mp3" });
  const notAsked = p._scoreFallbackCandidate(live, { title: ["karma", "police"], artist: ["radiohead"] });
  assert.ok(notAsked.penalty > 0);
  const asked = p._scoreFallbackCandidate(live, { title: ["karma", "police", "live"], artist: ["radiohead"] });
  assert.equal(asked.penalty, 0);
});

test("rankFallback drops files that are not the song and keeps the match on each survivor", () => {
  const list = [
    cand({ filename: "Music\\Radiohead\\OK Computer\\02 - Paranoid Android.mp3" }),
    cand({ filename: "Music\\Coldplay\\Karma Police (cover).mp3", username: "other" }),
    cand()
  ];
  const out = p._rankFallback(list, "Karma Police", "Radiohead", null);
  assert.equal(out.length, 1, "wrong song and wrong artist are dropped, not demoted");
  assert.equal(out[0].filename, list[2].filename);
  assert.equal(typeof out[0].match.score, "number");
  assert.equal(list[2].match, undefined, "the input candidate is not mutated");
});

test("a free upload slot outranks a marginally better title match", () => {
  const list = [
    cand({ username: "busy", filename: "Music\\Radiohead\\03 - Karma Police.mp3", hasFreeUploadSlot: false, availabilityTier: 2, queueLength: 40 }),
    cand({ username: "free", filename: "Music\\Radiohead\\03 - Karma Police (2009 remaster).mp3", availabilityTier: 0 })
  ];
  const out = p._rankFallback(list, "Karma Police", "Radiohead", null);
  assert.equal(out[0].username, "free");
});

test("without a format preference the fallback favours high-bitrate lossy over lossless; with one, the user's order stands", () => {
  const flac = cand({ username: "a", filename: "Music\\Radiohead\\03 - Karma Police.flac", extension: "flac", qualityTier: 0, size: 30000000 });
  const mp3 = cand({ username: "b" });
  assert.equal(p._rankFallback([flac, mp3], "Karma Police", "Radiohead", null)[0].username, "b");
  flac.formatRank = 0; mp3.formatRank = 1;
  assert.equal(p._rankFallback([flac, mp3], "Karma Police", "Radiohead", ["flac", "mp3"])[0].username, "a");
});

test("matchLabel and fallbackTotals read the way the tab shows them", () => {
  assert.equal(p._matchLabel({ score: 0.87, penalty: 0 }), "87%");
  assert.equal(p._matchLabel({ score: 0.5, penalty: 0.3 }), "50% · variant");
  const totals = p._fallbackTotals({ a: { state: "kept", size: 10 }, b: { state: "pending", size: 99 }, c: { state: "kept", size: 5 } });
  assert.deepEqual(totals, { count: 2, bytes: 15 });
  assert.deepEqual(p._keptKeys({ itemId: "k:x|y" }), ["x|y"]);
});

// --- the flow ------------------------------------------------------------------

// A scripted slskd: one search that finds the song, a batch endpoint that
// accepts it, a transfer that goes queued → downloading → succeeded on
// successive polls, and a Files API that lists the finished file.
function fallbackHost(opts) {
  const o = opts || {};
  const calls = { batches: [], deletes: [], searches: 0, stops: 0 };
  let transferPolls = 0;
  // `slowSearch`: a popular query slskd keeps collecting for (its timeout is
  // an inactivity one) — InProgress until stopped, bodies only after the stop.
  let stopped = false;
  let batch = null;
  const states = o.states || ["Queued, Remotely", "InProgress", "Completed, Succeeded"];
  const file = { filename: "Music\\Radiohead\\OK Computer\\03 - Karma Police.mp3", size: 9000000, length: 264, bitRate: 320 };
  const h = fakeHost({
    store: o.store,
    fetch: async (url, init) => {
      const json = (v, status) => ({ status: status || 200, text: async () => JSON.stringify(v) });
      const method = (init && init.method) || "GET";
      if (url.includes("/api/v0/searches") && method === "POST") { calls.searches++; return json({ id: "s1" }); }
      if (url.includes("/api/v0/searches/s1") && method === "PUT") { calls.stops++; stopped = true; return json({}); }
      if (url.includes("/responses")) {
        if (o.slowSearch && !stopped) return json([]);
        return json([
          { username: "peer", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 2000000, files: [file,
            { filename: "Music\\Radiohead\\OK Computer\\02 - Paranoid Android.mp3", size: 9500000, length: 383, bitRate: 320 }] },
          { username: "slow", hasFreeUploadSlot: false, queueLength: 30, uploadSpeed: 100, files: [
            { filename: "Radiohead - Karma Police.mp3", size: 8000000, length: 264, bitRate: 192 }] }
        ]);
      }
      if (url.includes("/api/v0/searches/s1")) {
        if (o.slowSearch && !stopped) return json({ id: "s1", state: "InProgress", responseCount: 2, fileCount: 3 });
        return json({ id: "s1", state: o.slowSearch ? "Completed, Cancelled" : "Completed, ResponseLimitReached", responseCount: 2, fileCount: 3 });
      }
      if (url.includes("/api/v0/transfers/downloads/batches") && method === "POST") {
        batch = JSON.parse(init.body);
        calls.batches.push(batch);
        return json({ failures: [] });
      }
      if (url.endsWith("/api/v0/transfers/downloads") && method === "GET") {
        if (!batch) return json([]);
        const state = states[Math.min(transferPolls++, states.length - 1)];
        return json([{ username: batch.username, directories: [{ files: [{
          id: "t1", username: batch.username, filename: batch.files[0].filename, size: batch.files[0].size,
          state, bytesTransferred: state === "InProgress" ? 4000000 : (state.includes("Succeeded") ? 9000000 : 0),
          averageSpeed: state === "InProgress" ? 1000000 : 0, placeInQueue: state.startsWith("Queued") ? 3 : null
        }] }] }]);
      }
      if (url.includes("/api/v0/files/downloads/directories/") && method === "GET") {
        if (o.emptyListing) return json({ files: [], directories: [] });
        return json({ files: [{ name: "03 - Karma Police.mp3", fullName: "03 - Karma Police.mp3", length: 9000000 }], directories: [] });
      }
      if (url.includes("/api/v0/files/downloads/directories/") && method === "DELETE") {
        calls.deletes.push(url);
        return { status: o.deleteStatus || 200, text: async () => "" };
      }
      if (url.includes("/api/v0/transfers/downloads/") && method === "DELETE") return { status: 200, text: async () => "" };
      return undefined;
    }
  });
  return { h, calls };
}

test("activate registers the metadata resolver the manifest declares", async () => {
  const plugin = loadPlugin();
  const { h } = fallbackHost();
  await plugin.activate(h.api);
  try {
    const manifest = JSON.parse(require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "manifest.json"), "utf8"));
    assert.equal(manifest.contributes.streamResolvers[0].id, plugin._FALLBACK_ID);
    assert.equal(typeof h.resolvers["meta:" + plugin._FALLBACK_ID], "function");
    assert.ok(manifest.apiUsage.some((u) => u.api === "playback.onStreamResolve"), "declared in apiUsage");
  } finally {
    plugin.deactivate();
  }
});

test("a track with no source is searched, fetched into the fallback folder, located and answered as file://; the next request is served from the kept copy", async () => {
  const plugin = loadPlugin();
  const { h, calls } = fallbackHost();
  await plugin.activate(h.api);
  try {
    const resolve = h.resolvers["meta:" + plugin._FALLBACK_ID];
    const out = await resolve("Karma Police (Remastered 2009)", "Radiohead", "OK Computer", 264, {});
    assert.ok(out, "resolved");
    assert.equal(out.label, "Soulseek");
    assert.equal(out.url, "file:///Users/me/Music/slskd/viboplr/fallback/1-Radiohead_-_Karma_Police_Remastered_2009/03 - Karma Police.mp3");

    assert.equal(calls.searches, 1);
    assert.equal(calls.batches.length, 1, "one sharer was enough");
    assert.equal(calls.batches[0].username, "peer", "the free slot won over the queued 192k copy");
    assert.ok(calls.batches[0].options.destination.startsWith("viboplr/fallback/"), "fallback files get their own folder: " + calls.batches[0].options.destination);

    // Remembered, so the tab can list it and the next request skips the network.
    const keys = Object.keys(h.store.fallback);
    assert.equal(keys.length, 1);
    assert.equal(h.store.fallback[keys[0]].state, "kept");
    assert.equal(h.store.fallback[keys[0]].size, 9000000);
    const key = "peer" + SEP + "Music\\Radiohead\\OK Computer\\03 - Karma Police.mp3";
    assert.equal(h.store.fallback[keys[0]].ref, key);
    assert.equal(h.store.tracked[key].fallback, true);

    const again = await resolve("karma police", "radiohead", null, null, {});
    assert.equal(again.url, out.url);
    assert.equal(calls.searches, 1, "no second search for a song already fetched");
  } finally {
    plugin.deactivate();
  }
});

test("a search slskd is still running at the fallback's deadline is stopped and its responses used, not discarded", async () => {
  const plugin = loadPlugin();
  plugin._setFallbackSearchMs(1500);
  const { h, calls } = fallbackHost({ slowSearch: true });
  await plugin.activate(h.api);
  try {
    const out = await h.resolvers["meta:" + plugin._FALLBACK_ID]("Karma Police", "Radiohead", null, 264, {});
    assert.ok(out, "resolved from the responses collected before the deadline");
    assert.equal(calls.stops, 1, "the search was stopped so slskd's one search slot frees up");
    assert.equal(calls.batches.length, 1);
    assert.equal(calls.batches[0].username, "peer");
  } finally {
    plugin.deactivate();
  }
});

test("the Fallback tab is a read-out — picked file, matches as text, no lists to act on — and kept files live under Downloads", async () => {
  const plugin = loadPlugin();
  const { h } = fallbackHost();
  await plugin.activate(h.api);
  try {
    await h.resolvers["meta:" + plugin._FALLBACK_ID]("Karma Police", "Radiohead", null, 264, {});
    const lastView = () => h.calls.views[h.calls.views.length - 1].data;
    const nodes = (n, out = []) => {
      if (!n || typeof n !== "object") return out;
      out.push(n);
      for (const k of ["children", "items"]) if (Array.isArray(n[k])) n[k].forEach((c) => nodes(c, out));
      return out;
    };

    h.actions["main-tab"]({ tabId: "fallback" });
    const fb = nodes(lastView());
    assert.ok(!fb.some((n) => n.type === "track-row-list"), "no row list: no artwork, no row actions");
    const texts = fb.filter((n) => n.type === "text").map((n) => n.content);
    assert.ok(texts.some((t) => /^Picked: 03 - Karma Police\.mp3 {2}— {2}played$/.test(t)), "the picked file and what became of it: " + texts.join(" | "));
    assert.ok(texts.some((t) => t.startsWith("✓ ") && t.includes("03 - Karma Police.mp3")), "the played candidate is marked");
    assert.ok(!texts.some((t) => /Kept files|Delete all/.test(t)));

    h.actions["main-tab"]({ tabId: "transfers" });
    const dl = nodes(lastView());
    assert.ok(dl.some((n) => n.type === "toolbar" && n.title === "Fetched by the playback fallback"));
    const kept = dl.filter((n) => n.type === "track-row-list").pop();
    assert.deepEqual(kept.actions.map((a) => a.id), ["play-kept", "import-kept", "delete-kept"]);
  } finally {
    plugin.deactivate();
  }
});

test("a sharer slskd can't reach is removed from slskd's list, not left behind as Failed", async () => {
  const plugin = loadPlugin();
  const removed = [];
  let errored = null;
  const file = "Music\\Radiohead\\OK Computer\\03 - Karma Police.mp3";
  const h = require("./harness/host.js").fakeHost({
    fetch: async (url, init) => {
      const json = (v, status) => ({ status: status || 200, text: async () => JSON.stringify(v) });
      const method = (init && init.method) || "GET";
      if (url.includes("/api/v0/searches") && method === "POST") return json({ id: "s1" });
      if (url.includes("/responses")) return json([{ username: "unreachable", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1, files: [{ filename: file, size: 9000000, length: 264, bitRate: 320 }] }]);
      if (url.includes("/api/v0/searches/s1")) return json({ id: "s1", state: "Completed", responseCount: 1, fileCount: 1 });
      if (url.includes("/api/v0/transfers/downloads/batches") && method === "POST") {
        // slskd records the attempt, then answers with the connection error.
        errored = { id: "t9", username: "unreachable", filename: file, size: 9000000, state: "Completed, Errored" };
        return json("Failed to connect to user unreachable", 500);
      }
      if (url.endsWith("/api/v0/transfers/downloads") && method === "GET") {
        return json(errored ? [{ username: "unreachable", directories: [{ files: [errored] }] }] : []);
      }
      if (url.includes("/api/v0/transfers/downloads/unreachable/t9") && method === "DELETE") {
        removed.push(url);
        errored = null;
        return { status: 204, text: async () => "" };
      }
      return undefined;
    }
  });
  await plugin.activate(h.api);
  try {
    assert.equal(await h.resolvers["meta:" + plugin._FALLBACK_ID]("Karma Police", "Radiohead", null, 264, {}), null);
    assert.equal(removed.length, 1, "the failed attempt was removed");
    assert.ok(removed[0].endsWith("?remove=true"));
  } finally {
    plugin.deactivate();
  }
});

test("the resolver stays out of the video pass and answers null when slskd is remote", async () => {
  const plugin = loadPlugin();
  const { h, calls } = fallbackHost({ store: { tierOverride: "remote" } });
  await plugin.activate(h.api);
  try {
    const resolve = h.resolvers["meta:" + plugin._FALLBACK_ID];
    assert.equal(await resolve("Karma Police", "Radiohead", null, 264, { preferVideo: true }), null);
    assert.equal(await resolve("Karma Police", "Radiohead", null, 264, {}), null, "remote tier: a file:// path would be on another machine");
    assert.equal(calls.searches, 0);
  } finally {
    plugin.deactivate();
  }
});

test("nothing matching → null, and the Fallback tab shows the resolve that came up empty", async () => {
  const plugin = loadPlugin();
  const { h, calls } = fallbackHost();
  await plugin.activate(h.api);
  try {
    const resolve = h.resolvers["meta:" + plugin._FALLBACK_ID];
    assert.equal(await resolve("Wonderwall", "Oasis", null, 258, {}), null);
    assert.equal(calls.batches.length, 0, "nothing was downloaded");
    h.actions["main-tab"]({ tabId: "fallback" });
    const view = h.calls.views[h.calls.views.length - 1].data;
    const flat = JSON.stringify(view);
    assert.ok(flat.includes("Nothing matched"), "outcome shown");
    assert.ok(flat.includes("oasis wonderwall"), "the query is shown");
  } finally {
    plugin.deactivate();
  }
});

test("Delete removes the kept file through slskd's Files API and forgets it; a 403 explains remote_file_management", async () => {
  const plugin = loadPlugin();
  const { h, calls } = fallbackHost();
  await plugin.activate(h.api);
  try {
    const resolve = h.resolvers["meta:" + plugin._FALLBACK_ID];
    await resolve("Karma Police", "Radiohead", null, 264, {});
    const fkey = Object.keys(h.store.fallback)[0];
    const ref = h.store.fallback[fkey].ref;
    const b64 = h.store.tracked[ref].b64;
    assert.ok(b64, "the fallback folder is route-safe");

    h.actions["delete-kept"]({ itemId: "k:" + fkey });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.deletes.length, 1);
    assert.ok(calls.deletes[0].endsWith("/api/v0/files/downloads/directories/" + b64), calls.deletes[0]);
    assert.deepEqual(h.store.fallback, {});
    assert.equal(h.store.tracked[ref], undefined);
    assert.ok(h.calls.notifications.some((m) => /Deleted 1 fallback file/.test(m)));
  } finally {
    plugin.deactivate();
  }

  const plugin2 = loadPlugin();
  const second = fallbackHost({ deleteStatus: 403 });
  await plugin2.activate(second.h.api);
  try {
    await second.h.resolvers["meta:" + plugin2._FALLBACK_ID]("Karma Police", "Radiohead", null, 264, {});
    second.h.actions["delete-all-kept"]({});
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(Object.keys(second.h.store.fallback).length, 1, "a refused delete keeps the record");
    assert.ok(second.h.calls.notifications.some((m) => /remote_file_management/.test(m)), "the user is told what to enable");
  } finally {
    plugin2.deactivate();
  }
});

test("while the fallback waits, the tab shows the transfer the way the Downloads tab would: queue position, then progress with speed and time left", async () => {
  const plugin = loadPlugin();
  const { h } = fallbackHost();
  await plugin.activate(h.api);
  try {
    h.actions["main-tab"]({ tabId: "fallback" });
    const before = h.calls.views.length;
    await h.resolvers["meta:" + plugin._FALLBACK_ID]("Karma Police", "Radiohead", null, 264, {});
    const during = h.calls.views.slice(before).map((v) => JSON.stringify(v.data)).join("\n");
    assert.ok(during.includes("Waiting in peer's queue"), "the queued phase was shown");
    assert.ok(during.includes("position 3"), "with the position in it");
    assert.ok(during.includes("Downloading 44%"), "then the download with its percentage");
    assert.ok(during.includes("about 0:05 left"), "and the time left from the reported speed");
    const last = JSON.stringify(h.calls.views[h.calls.views.length - 1].data);
    assert.ok(!last.includes("Downloading 44%"), "live detail is cleared once the resolve settles");
  } finally {
    plugin.deactivate();
  }
});

test("transferEta is bytes left over the average speed, and null without one", () => {
  assert.equal(p._transferEta({ size: 9000000, bytesTransferred: 4000000, averageSpeed: 1000000 }), 5);
  assert.equal(p._transferEta({ size: 9000000, bytesTransferred: 9500000, averageSpeed: 1000000 }), 0);
  assert.equal(p._transferEta({ size: 9000000, bytesTransferred: 0, averageSpeed: 0 }), null);
  assert.equal(p._transferEta(null), null);
});

// --- what a real run taught ------------------------------------------------------
// Against a live slskd, a sharer that advertised a free slot kept the transfer
// in "Queued, Remotely" for the whole budget, flickering through Initializing
// and InProgress at 0 bytes as slskd retried — and the state-based stall rule
// took that flicker for a start. The rule is now "no bytes for N seconds".

function flickerHost(bytesPerPoll) {
  let polls = 0;
  const flicker = ["Queued, Remotely", "Initializing", "InProgress", "Queued, Remotely"];
  return fakeHost({
    store: { tracked: {} },
    fetch: async (url, init) => {
      const method = (init && init.method) || "GET";
      if (url.endsWith("/api/v0/transfers/downloads") && method === "GET") {
        const n = polls++;
        return { status: 200, text: async () => JSON.stringify([{ username: "peer", directories: [{ files: [{
          id: "t1", username: "peer", filename: "a\\b.mp3", size: 9000000,
          state: flicker[n % flicker.length], bytesTransferred: bytesPerPoll * n
        }] }] }]) };
      }
      if (url.includes("/api/v0/transfers/downloads/") && method === "DELETE") return { status: 200, text: async () => "" };
      return undefined;
    }
  });
}

test("a transfer that flickers through InProgress at 0 bytes is stalled, not started", async () => {
  const plugin = loadPlugin();
  const h = flickerHost(0);
  await plugin.activate(h.api);
  try {
    const t0 = Date.now();
    const w = await plugin._waitForTransfer("peer" + SEP + "a\\b.mp3", Date.now() + 15000, null, 2500);
    assert.equal(w.state, "stalled");
    assert.ok(Date.now() - t0 < 6000, "gave up on the stall threshold, not the deadline");
  } finally {
    plugin.deactivate();
  }
});

test("a transfer whose bytes keep growing is never stalled, whatever its state says", async () => {
  const plugin = loadPlugin();
  const h = flickerHost(100000);
  await plugin.activate(h.api);
  try {
    const w = await plugin._waitForTransfer("peer" + SEP + "a\\b.mp3", Date.now() + 4500, null, 2500);
    assert.equal(w.state, "timeout", "ran to the deadline because data kept arriving");
  } finally {
    plugin.deactivate();
  }
});

test("the poll forgets a pending fallback whose background download failed, and drops slskd's row", async () => {
  const plugin = loadPlugin();
  const key = "yoblin" + SEP + "x\\Autumn Sweater.mp3";
  const deletes = [];
  const h = fakeHost({
    store: {
      tracked: { [key]: { destination: "viboplr/fallback/3-x", b64: "abc", resolvedPath: null, meta: {}, size: 12878403, fallback: true } },
      fallback: { "autumn sweater|yo la tengo": { ref: key, title: "Autumn Sweater", artist: "Yo La Tengo", at: Date.now() - 120000, size: 12878403, state: "pending", path: null } }
    },
    responses: {
      "/api/v0/transfers/downloads": [{ username: "yoblin", directories: [{ files: [{ id: "t9", username: "yoblin", filename: "x\\Autumn Sweater.mp3", size: 12878403, state: "Completed, Errored", bytesTransferred: 0 }] }] }]
    },
    fetch: async (url, init) => {
      if (init && init.method === "DELETE") { deletes.push(url); return { status: 200, text: async () => "" }; }
      return undefined;
    }
  });
  await plugin.activate(h.api);
  try {
    await plugin._refreshTransfers();
    assert.deepEqual(h.store.fallback, {}, "the failed attempt is forgotten");
    assert.equal(h.store.tracked[key], undefined);
    assert.equal(deletes.length, 1, "slskd's Failed row is removed");
    assert.ok(deletes[0].includes("remove=true"));
  } finally {
    plugin.deactivate();
  }
});

test("the poll turns a pending fallback whose background download finished into a kept file", async () => {
  const plugin = loadPlugin();
  const key = "peer" + SEP + "x\\Song.mp3";
  const h = fakeHost({
    store: {
      tracked: { [key]: { destination: "viboplr/fallback/4-x", b64: "dmlib3Bsci9mYWxsYmFjay80LXg=", resolvedPath: null, meta: {}, size: 5000, fallback: true } },
      fallback: { "song|artist": { ref: key, title: "Song", artist: "Artist", at: Date.now() - 120000, size: 5000, state: "pending", path: null } }
    },
    responses: {
      "/api/v0/transfers/downloads": [{ username: "peer", directories: [{ files: [{ id: "t2", username: "peer", filename: "x\\Song.mp3", size: 5000, state: "Completed, Succeeded", bytesTransferred: 5000 }] }] }],
      "/api/v0/files/downloads/directories/dmlib3Bsci9mYWxsYmFjay80LXg=": { files: [{ name: "Song.mp3", fullName: "Song.mp3", length: 5000 }], directories: [] }
    }
  });
  await plugin.activate(h.api);
  try {
    await plugin._refreshTransfers();
    const e = h.store.fallback["song|artist"];
    assert.equal(e.state, "kept");
    assert.equal(e.path, "/Users/me/Music/slskd/viboplr/fallback/4-x/Song.mp3");
  } finally {
    plugin.deactivate();
  }
});

test("a sharer dropped mid-resolve leaves no bookkeeping record behind; only the one that delivered is tracked", async () => {
  const plugin = loadPlugin();
  const good = "Music\\Yo La Tengo\\08 - Autumn Sweater.mp3";
  const bad = "Music\\Yo La Tengo\\Autumn Sweater.mp3";
  const batches = [];
  let polls = 0;
  const h = fakeHost({
    store: { tracked: {} },
    fetch: async (url, init) => {
      const json = (v) => ({ status: 200, text: async () => JSON.stringify(v) });
      const method = (init && init.method) || "GET";
      if (url.includes("/api/v0/searches") && method === "POST") return json({ id: "s1" });
      if (url.includes("/responses")) {
        return json([
          // Same quality; "flaky" wins the tie on upload speed and is tried first.
          { username: "flaky", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 9000000, files: [{ filename: bad, size: 9000000, length: 318, bitRate: 320 }] },
          { username: "solid", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1000000, files: [{ filename: good, size: 9000000, length: 318, bitRate: 320 }] }
        ]);
      }
      if (url.includes("/api/v0/searches/s1")) return json({ id: "s1", state: "Completed, ResponseLimitReached", responseCount: 2, fileCount: 2 });
      if (url.includes("/api/v0/transfers/downloads/batches") && method === "POST") { batches.push(JSON.parse(init.body)); return json({ failures: [] }); }
      if (url.endsWith("/api/v0/transfers/downloads") && method === "GET") {
        const rows = batches.map((b, i) => {
          const flaky = b.username === "flaky";
          const n = polls;
          const state = flaky ? "Completed, Errored" : (n - i < 2 ? "InProgress" : "Completed, Succeeded");
          return { username: b.username, directories: [{ files: [{ id: "t" + i, username: b.username, filename: b.files[0].filename, size: 9000000, state, bytesTransferred: flaky ? 0 : 9000000 }] }] };
        });
        polls++;
        return json(rows);
      }
      if (url.includes("/api/v0/files/downloads/directories/") && method === "GET") return json({ files: [{ name: "08 - Autumn Sweater.mp3", fullName: "08 - Autumn Sweater.mp3", length: 9000000 }], directories: [] });
      if (url.includes("/api/v0/transfers/downloads/") && method === "DELETE") return { status: 200, text: async () => "" };
      return undefined;
    }
  });
  await plugin.activate(h.api);
  try {
    const out = await h.resolvers["meta:" + plugin._FALLBACK_ID]("Autumn Sweater", "Yo La Tengo", null, 318, {});
    assert.ok(out && out.url.endsWith("/08 - Autumn Sweater.mp3"), "the second sharer delivered: " + (out && out.url));
    assert.deepEqual(batches.map((b) => b.username), ["flaky", "solid"], "the flaky sharer was tried first and dropped");
    const keys = Object.keys(h.store.tracked);
    assert.deepEqual(keys, ["solid" + SEP + good], "only the sharer that delivered is tracked");
    assert.equal(Object.values(h.store.fallback)[0].ref, "solid" + SEP + good);
  } finally {
    plugin.deactivate();
  }
});

// --- hedging --------------------------------------------------------------------
// The best sharer is queued at once; if it has sent nothing after 5 s a second
// sharer is queued beside it. First to move wins, the other is cancelled, and a
// moving transfer is never second-guessed.

function hedgeHost(behaviour) {
  const batches = [];
  const deletes = [];
  const seen = {};
  const file = (user) => "Music\\Yo La Tengo\\" + user + " - Autumn Sweater.mp3";
  const h = fakeHost({
    store: { tracked: {} },
    fetch: async (url, init) => {
      const json = (v) => ({ status: 200, text: async () => JSON.stringify(v) });
      const method = (init && init.method) || "GET";
      if (url.includes("/api/v0/searches") && method === "POST") return json({ id: "s1" });
      if (url.includes("/responses")) {
        return json(["alpha", "bravo", "charlie"].map((u, i) => ({
          username: u, hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 9000000 - i * 1000000,
          files: [{ filename: file(u), size: 9000000, length: 318, bitRate: 320 }]
        })));
      }
      if (url.includes("/api/v0/searches/s1")) return json({ id: "s1", state: "Completed, ResponseLimitReached", responseCount: 3, fileCount: 3 });
      if (url.includes("/api/v0/transfers/downloads/batches") && method === "POST") {
        const b = JSON.parse(init.body);
        batches.push({ user: b.username, at: Date.now() });
        return json({ failures: [] });
      }
      if (url.endsWith("/api/v0/transfers/downloads") && method === "GET") {
        const rows = batches.map((b, i) => {
          seen[b.user] = (seen[b.user] || 0) + 1;
          const st = behaviour(b.user, seen[b.user]);
          return { username: b.user, directories: [{ files: [{ id: "t" + i, username: b.user, filename: file(b.user), size: 9000000, state: st.state, bytesTransferred: st.bytes }] }] };
        });
        return json(rows);
      }
      if (url.includes("/api/v0/files/downloads/directories/") && method === "GET") {
        return json({ files: batches.map((b) => ({ name: b.user + " - Autumn Sweater.mp3", fullName: b.user + " - Autumn Sweater.mp3", length: 9000000 })), directories: [] });
      }
      if (url.includes("/api/v0/transfers/downloads/") && method === "DELETE") { deletes.push(url); return { status: 200, text: async () => "" }; }
      return undefined;
    }
  });
  return { h, batches, deletes };
}

test("a sharer that sends nothing for 5 s gets a second one queued beside it; the one that moves wins and the silent one is cancelled", async () => {
  const plugin = loadPlugin();
  const { h, batches, deletes } = hedgeHost((user, n) => {
    if (user === "alpha") return { state: "Queued, Remotely", bytes: 0 };           // never sends
    return n < 2 ? { state: "InProgress", bytes: 4500000 } : { state: "Completed, Succeeded", bytes: 9000000 };
  });
  await plugin.activate(h.api);
  try {
    const out = await h.resolvers["meta:" + plugin._FALLBACK_ID]("Autumn Sweater", "Yo La Tengo", null, 318, {});
    assert.ok(out && out.url.endsWith("/bravo - Autumn Sweater.mp3"), "the hedge delivered: " + (out && out.url));
    assert.deepEqual(batches.map((b) => b.user), ["alpha", "bravo"], "exactly one hedge, from a different sharer");
    const gap = batches[1].at - batches[0].at;
    assert.ok(gap >= plugin._FALLBACK_HEDGE_MS - 200 && gap < plugin._FALLBACK_HEDGE_MS + 3000, "hedged after ~5 s, not after the 12 s stall: " + gap + "ms");
    assert.equal(deletes.length, 1, "the silent sharer was cancelled");
    assert.ok(decodeURIComponent(deletes[0]).includes("/alpha/"), deletes[0]);
    assert.deepEqual(Object.keys(h.store.tracked).map((k) => k.split(SEP)[0]), ["bravo"], "only the winner is tracked");
    assert.equal(Object.values(h.store.fallback)[0].ref.split(SEP)[0], "bravo");
  } finally {
    plugin.deactivate();
  }
});

test("a sharer that is sending, however slowly, is never hedged", async () => {
  const plugin = loadPlugin();
  const { h, batches } = hedgeHost((user, n) => {
    // alpha trickles: a little more every poll, done on the 8th (~8 s, past the hedge point).
    return n < 8 ? { state: "InProgress", bytes: 100000 * n } : { state: "Completed, Succeeded", bytes: 9000000 };
  });
  await plugin.activate(h.api);
  try {
    const out = await h.resolvers["meta:" + plugin._FALLBACK_ID]("Autumn Sweater", "Yo La Tengo", null, 318, {});
    assert.ok(out && out.url.endsWith("/alpha - Autumn Sweater.mp3"));
    assert.deepEqual(batches.map((b) => b.user), ["alpha"], "no second enqueue while bytes were arriving");
  } finally {
    plugin.deactivate();
  }
});

// --- the sharer ledger -------------------------------------------------------------
// Every download this plugin watches teaches it something about a sharer, and
// a sharer who has delivered outranks one who only advertises a free slot.

test("the ledger scores a delivery as two strikes' worth and tiers sharers proven / unknown / burned", () => {
  let led = {};
  p._noteSharer(led, "a", "delivered", 9000000);
  p._noteSharer(led, "a", "stalled");
  p._noteSharer(led, "b", "failed");
  p._noteSharer(led, "b", "stalled");
  p._noteSharer(led, "c", "ignored-event");
  assert.equal(p._sharerScore(led.a), 1, "2 for the delivery, -1 for the stall");
  assert.equal(p._sharerTier(led.a), 0, "proven");
  assert.equal(p._sharerTier(led.b), 2, "burned");
  assert.equal(p._sharerTier(led.c), 1, "an unknown event records nothing");
  assert.equal(p._sharerTier(undefined), 1, "never seen = unknown");
  assert.equal(led.a.bytes, 9000000);
  assert.equal(p._sharerLabel(led.a), "delivered once");
  assert.equal(p._sharerLabel({ delivered: 3, failed: 0, stalled: 0 }), "delivered 3×");
  assert.equal(p._sharerLabel(led.b), "unreliable");
  assert.equal(p._sharerLabel(undefined), "");
  assert.deepEqual(p._ledgerTotals(led), { seen: 2, proven: 1, burned: 1 });
});

test("Search-tab ranking promotes a proven sharer over an unknown one at equal quality, and buries a burned one", () => {
  const responses = [
    { username: "unknown", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 9000000, files: [{ filename: "a\\x.mp3", size: 1, bitRate: 320 }] },
    { username: "proven", hasFreeUploadSlot: false, queueLength: 4, uploadSpeed: 100, files: [{ filename: "b\\x.mp3", size: 1, bitRate: 320 }] },
    { username: "burned", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 9999999, files: [{ filename: "c\\x.mp3", size: 1, bitRate: 320 }] }
  ];
  const tiers = { proven: 0, unknown: 1, burned: 2 };
  const out = p._rankResults(responses, { sharerTier: (u) => tiers[u] });
  assert.deepEqual(out.map((c) => c.username), ["proven", "unknown", "burned"]);
  // Without a ledger the order is what it always was.
  const plain = p._rankResults(responses, {});
  assert.deepEqual(plain.map((c) => c.username), ["burned", "unknown", "proven"], "availability then speed, as before");
});

test("the fallback ranks a proven sharer with a queue above an unknown sharer with a free slot", () => {
  const unknown = cand({ username: "unknown", filename: "Music\\Radiohead\\Karma Police.mp3", sharerTier: 1, availabilityTier: 0 });
  const proven = cand({ username: "proven", filename: "Music\\Radiohead\\03 Karma Police.mp3", sharerTier: 0, availabilityTier: 1, hasFreeUploadSlot: false, queueLength: 3 });
  const out = p._rankFallback([unknown, proven], "Karma Police", "Radiohead", null, "fast");
  assert.equal(out[0].username, "proven");
});

test("the fallback quality setting: fast puts high-bitrate lossy first, best puts lossless first, preferred formats override both", () => {
  const flac = cand({ username: "a", filename: "Music\\Radiohead\\03 - Karma Police.flac", extension: "flac", qualityTier: 0, size: 30000000 });
  const mp3 = cand({ username: "b" });
  assert.equal(p._rankFallback([flac, mp3], "Karma Police", "Radiohead", null, "fast")[0].username, "b");
  assert.equal(p._rankFallback([flac, mp3], "Karma Police", "Radiohead", null, "best")[0].username, "a");
  flac.formatRank = 1; mp3.formatRank = 0;
  assert.equal(p._rankFallback([flac, mp3], "Karma Police", "Radiohead", ["mp3", "flac"], "best")[0].username, "b", "an explicit format list wins over the mode");
});

test("a live fallback writes the ledger: the sharer that delivered is proven, and the results show it", async () => {
  const plugin = loadPlugin();
  const { h } = fallbackHost();
  await plugin.activate(h.api);
  try {
    await h.resolvers["meta:" + plugin._FALLBACK_ID]("Karma Police", "Radiohead", null, 264, {});
    assert.equal(h.store.sharers.peer.delivered, 1);
    assert.equal(h.store.sharers.peer.bytes, 9000000);
    assert.equal(h.store.sharers.slow, undefined, "a sharer never tried is not in the ledger");
    // The label rides on the availability cell of every result row from now on.
    const cells = plugin._resultCells(cand({ username: "peer" }));
    assert.equal(cells.availability, "free slot · delivered once");
  } finally {
    plugin.deactivate();
  }
});

test("a sharer dropped for failing is marked against; the quality setting is read from storage and saved from its action", async () => {
  const plugin = loadPlugin();
  const good = "Music\\Yo La Tengo\\08 - Autumn Sweater.mp3";
  const bad = "Music\\Yo La Tengo\\Autumn Sweater.mp3";
  const batches = [];
  let polls = 0;
  const h = fakeHost({
    store: { tracked: {}, fallbackQuality: "best" },
    fetch: async (url, init) => {
      const json = (v) => ({ status: 200, text: async () => JSON.stringify(v) });
      const method = (init && init.method) || "GET";
      if (url.includes("/api/v0/searches") && method === "POST") return json({ id: "s1" });
      if (url.includes("/responses")) {
        return json([
          { username: "flaky", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 9000000, files: [{ filename: bad, size: 9000000, length: 318, bitRate: 320 }] },
          { username: "solid", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1000000, files: [{ filename: good, size: 9000000, length: 318, bitRate: 320 }] }
        ]);
      }
      if (url.includes("/api/v0/searches/s1")) return json({ id: "s1", state: "Completed, ResponseLimitReached", responseCount: 2, fileCount: 2 });
      if (url.includes("/api/v0/transfers/downloads/batches") && method === "POST") { batches.push(JSON.parse(init.body)); return json({ failures: [] }); }
      if (url.endsWith("/api/v0/transfers/downloads") && method === "GET") {
        const rows = batches.map((b, i) => {
          const flaky = b.username === "flaky";
          const state = flaky ? "Completed, Errored" : (polls - i < 2 ? "InProgress" : "Completed, Succeeded");
          return { username: b.username, directories: [{ files: [{ id: "t" + i, username: b.username, filename: b.files[0].filename, size: 9000000, state, bytesTransferred: flaky ? 0 : 9000000 }] }] };
        });
        polls++;
        return json(rows);
      }
      if (url.includes("/api/v0/files/downloads/directories/") && method === "GET") return json({ files: [{ name: "08 - Autumn Sweater.mp3", fullName: "08 - Autumn Sweater.mp3", length: 9000000 }], directories: [] });
      if (url.includes("/api/v0/transfers/downloads/") && method === "DELETE") return { status: 200, text: async () => "" };
      return undefined;
    }
  });
  await plugin.activate(h.api);
  try {
    await h.resolvers["meta:" + plugin._FALLBACK_ID]("Autumn Sweater", "Yo La Tengo", null, 318, {});
    assert.equal(h.store.sharers.flaky.failed, 1);
    assert.equal(h.store.sharers.solid.delivered, 1);
    assert.equal(plugin._sharerTier(h.store.sharers.flaky), 2);

    // Second resolve of another song: the ledger now puts "solid" first even
    // though "flaky" still advertises the faster upload.
    batches.length = 0; polls = 0;
    h.store.fallback = {};
    await h.resolvers["meta:" + plugin._FALLBACK_ID]("Autumn Sweater (Live)", "Yo La Tengo", null, null, {});
    assert.equal(batches[0] && batches[0].username, "solid", "the proven sharer is tried first now");

    // The settings action persists the quality mode.
    h.actions["set-fallback-quality"]({ value: "fast" });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(h.store.fallbackQuality, "fast");
    h.actions["set-fallback-quality"]({ value: "nonsense" });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(h.store.fallbackQuality, "fast", "an unknown value is ignored");
  } finally {
    plugin.deactivate();
  }
});
