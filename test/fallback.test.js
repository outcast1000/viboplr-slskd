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
          state, bytesTransferred: state === "InProgress" ? 4000000 : (state.includes("Succeeded") ? 9000000 : 0)
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
