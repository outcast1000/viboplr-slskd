const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { fakeHost } = require("./harness/host");

// --- Automatic upgrades (the Upgrades tab) -----------------------------------
// "Upgrade" on a library track finds, downloads and CHECKS a better copy on its
// own; the user only compares and replaces. The pick is automatic, the replace
// never is.

const plugin = loadPlugin();
const SEP = plugin._KEY_SEP;

const MP3_192 = plugin._libraryQuality({ format: "mp3", file_size: 6336000, duration_secs: 264 });

function cand(o) {
  return Object.assign({
    username: "peer", filename: "m\\Radiohead\\OK Computer\\06 - Karma Police.flac", size: 30e6, length: 264,
    bitRate: null, bitDepth: 16, sampleRate: 44100, isVariableBitRate: false, extension: "flac", qualityTier: 0,
    hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1000, sharerTier: 1, availabilityTier: 0, formatRank: 0
  }, o);
}
const FLAC = cand({});
const MP3_320 = cand({ username: "mp3er", filename: "m\\Radiohead\\06 - Karma Police.mp3", size: 10.5e6, bitRate: 320, bitDepth: null, sampleRate: null, extension: "mp3", qualityTier: 1 });
const MP3_V0 = cand({ username: "vbr", filename: "m\\Radiohead\\06 - Karma Police (V0).mp3", size: 8e6, bitRate: 245, isVariableBitRate: true, bitDepth: null, sampleRate: null, extension: "mp3", qualityTier: 1 });
const OGG_320 = cand({ username: "ogg", filename: "m\\Radiohead\\06 - Karma Police.ogg", size: 10.5e6, bitRate: 320, bitDepth: null, sampleRate: null, extension: "ogg", qualityTier: 1 });
const MP3_192_TWIN = cand({ username: "twin", filename: "m\\Radiohead\\06 - Karma Police (192).mp3", size: 6.3e6, bitRate: 192, bitDepth: null, sampleRate: null, extension: "mp3", qualityTier: 3 });
const LIVE_FLAC = cand({ username: "live", filename: "m\\Radiohead\\06 - Karma Police (Live).flac" });

const ENTRY = (target) => ({ title: "Karma Police", artist: "Radiohead", current: MP3_192, target });

test("meetsQualityTarget: best takes anything, lossless only lossless, MP3 320 / V0 only high-bitrate lossy", () => {
  const m = plugin._meetsQualityTarget;
  assert.equal(m(FLAC, "best"), true);
  assert.equal(m(MP3_320, "best"), true);
  assert.equal(m(FLAC, "lossless"), true);
  assert.equal(m(MP3_320, "lossless"), false);
  assert.equal(m(MP3_320, "high"), true);
  assert.equal(m(MP3_V0, "high"), true, "V0 is high-bitrate");
  assert.equal(m(FLAC, "high"), false, "the size-conscious option skips lossless");
  assert.equal(m(MP3_320, "nonsense"), true, "an unknown value reads as best");
});

test("rankUpgrade: same recording, better than the copy, at the target — best first; the rest become the alternative", () => {
  const all = [MP3_192_TWIN, OGG_320, MP3_320, LIVE_FLAC, FLAC, MP3_V0];

  const best = plugin._rankUpgrade(all, ENTRY("best"));
  assert.deepEqual(best.picks.map((c) => c.username), ["peer", "mp3er", "ogg", "vbr"], "lossless, then the highest rate; the twin and the live take are out");
  assert.equal(best.alternative, null);

  const lossless = plugin._rankUpgrade(all, ENTRY("lossless"));
  assert.deepEqual(lossless.picks.map((c) => c.username), ["peer"]);
  assert.equal(lossless.alternative.username, "mp3er", "the best better copy that isn't lossless");

  const high = plugin._rankUpgrade(all, ENTRY("high"));
  assert.deepEqual(high.picks.map((c) => c.username), ["mp3er", "vbr", "ogg"], "MP3 leads the tier, 320 before V0");
  assert.equal(high.alternative.username, "peer");

  const none = plugin._rankUpgrade([MP3_192_TWIN], ENTRY("best"));
  assert.equal(none.picks.length, 0);
  assert.equal(none.alternative, null);
  assert.equal(none.matched, 1);
  assert.equal(none.better, 0);
});

test("rankUpgrade: a proven sharer beats an unknown one at the same quality", () => {
  const unknown = cand({ username: "unknown", sharerTier: 1 });
  const proven = cand({ username: "proven", sharerTier: 0, filename: "m\\Radiohead\\Karma Police.flac" });
  assert.equal(plugin._rankUpgrade([unknown, proven], ENTRY("best")).picks[0].username, "proven");
});

test("checkUpgrade: the finished file must be what it claimed, better than the copy, and at the target", () => {
  const check = plugin._checkUpgrade;
  const measure = plugin._measuredQuality;
  // 10.5 MB over 264 s ≈ 318 kbps: an honest 320.
  assert.equal(check(ENTRY("best"), MP3_320, measure(MP3_320, 10.5e6, 264)).ok, true);
  // "320" that is 4.2 MB over 264 s ≈ 127 kbps.
  const liar = check(ENTRY("best"), MP3_320, measure(MP3_320, 4.2e6, 264));
  assert.equal(liar.ok, false);
  assert.ok(liar.note.includes("advertised 320 kbps, measured ≈127 kbps"), liar.note);
  // Honestly labelled, but no better than the copy in hand.
  const same = cand({ extension: "mp3", qualityTier: 3, bitRate: 200 });
  assert.equal(check(ENTRY("best"), same, measure(same, 6.6e6, 264)).ok, false);
  // Lossless takes its figures from the sharer; the container decides the tier.
  assert.equal(check(ENTRY("lossless"), FLAC, measure(FLAC, 30e6, 264)).ok, true);
  assert.equal(check(ENTRY("high"), FLAC, measure(FLAC, 30e6, 264)).ok, false, "below the target");
  // Unmeasurable (no duration) passes to the compare step, with a note.
  const blind = check(ENTRY("best"), MP3_320, null);
  assert.equal(blind.ok, true);
  assert.ok(/couldn't measure/.test(blind.note));
});

test("upgradeRowActions: only what does something to that upgrade", () => {
  const a = plugin._upgradeRowActions;
  assert.deepEqual(a({ state: "ready" }), ["upgrade-replace", "upgrade-choose", "upgrade-remove"]);
  assert.deepEqual(a({ state: "alternative" }), ["upgrade-take-alternative", "upgrade-choose", "upgrade-retry", "upgrade-remove"]);
  assert.deepEqual(a({ state: "downloading" }), ["upgrade-choose", "upgrade-remove"]);
  assert.deepEqual(a({ state: "none" }), ["upgrade-choose", "upgrade-retry", "upgrade-remove"]);
  assert.deepEqual(a({ state: "replaced" }), ["upgrade-remove"]);
});

// --- the flow ------------------------------------------------------------------

const LIBRARY_MP3 = {
  id: 42, path: "file:///Users/me/Music/RH/06 Karma Police.mp3", title: "Karma Police", artist_name: "Radiohead",
  album_id: 7, album_title: "OK Computer", track_number: 6, format: "mp3", file_size: 6336000, duration_secs: 264
};

// A scripted slskd. `responses` is the search's answer. `states[user]` is the
// sequence a transfer from that user walks through, one step per transfer
// poll; `bytes[user]` how much of it has arrived while InProgress.
function upgradeHost(o) {
  const calls = { batches: [], cancels: [] };
  const live = {};  // username -> { file, polls }
  const library = { tracks: [Object.assign({}, LIBRARY_MP3)] };
  const h = fakeHost({
    store: Object.assign({ upgradeTarget: o.target || "best" }, o.store || {}),
    library,
    fetch: async (url, init) => {
      const json = (v, status) => ({ status: status || 200, text: async () => JSON.stringify(v) });
      const method = (init && init.method) || "GET";
      if (url.includes("/api/v0/searches") && method === "POST") return json({ id: "s1" });
      if (url.includes("/api/v0/searches/s1") && method === "PUT") return json({});
      if (url.includes("/responses")) return json(o.responses);
      if (url.includes("/api/v0/searches/s1")) return json({ id: "s1", state: "Completed, ResponseLimitReached", responseCount: 1, fileCount: 3 });
      if (url.includes("/api/v0/transfers/downloads/batches") && method === "POST") {
        const b = JSON.parse(init.body);
        calls.batches.push(b);
        live[b.username] = { file: b.files[0], polls: 0 };
        return json({ failures: [] });
      }
      if (url.endsWith("/api/v0/transfers/downloads") && method === "GET") {
        const users = Object.keys(live).map((u) => {
          const seq = (o.states && o.states[u]) || ["Queued, Remotely", "InProgress", "Completed, Succeeded"];
          const state = seq[Math.min(live[u].polls++, seq.length - 1)];
          const f = live[u].file;
          return { username: u, directories: [{ files: [{
            id: "t-" + u, username: u, filename: f.filename, size: f.size, state,
            bytesTransferred: state === "InProgress" ? ((o.bytes && o.bytes[u]) != null ? o.bytes[u] : 1000) : (state.includes("Succeeded") ? f.size : 0)
          }] }] };
        });
        return json(users);
      }
      if (url.includes("/api/v0/files/downloads/directories/") && method === "GET") {
        const names = Object.keys(live).map((u) => live[u].file.filename.split("\\").pop());
        return json({ files: names.map((n) => ({ name: n, fullName: n, length: 1 })), directories: [] });
      }
      if (url.includes("/api/v0/transfers/downloads/") && method === "DELETE") {
        const user = decodeURIComponent(url.split("/api/v0/transfers/downloads/")[1].split("/")[0]);
        calls.cancels.push(user);
        delete live[user];
        return { status: 200, text: async () => "" };
      }
      return undefined;
    }
  });
  // Real durations for whatever finished: what the host's tag reader returns.
  h.api.system.readAudioTags = async (paths) => paths.map(() => ({ title: null, artist: null, album_artist: null, album: null, track_number: null, disc_number: null, year: null, genre: null, duration_secs: 264 }));
  return { h, calls, library };
}

async function waitFor(pred, ms, what) {
  const until = Date.now() + (ms || 8000);
  while (Date.now() < until) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting" + (what ? " for " + what : ""));
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

// Polls until `pred` or a cap — each poll is one step of the scripted slskd.
async function pollUntil(p, pred, what) {
  for (let i = 0; i < 40; i++) {
    if (pred()) return;
    await p._refreshTransfers();
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("never reached: " + what);
}

const entryOf = (p) => p._upgrades()["t42"];

test("integration: Upgrade finds, downloads and checks a better copy, then hands the compare dialog the row to replace", async () => {
  const p = loadPlugin();
  const { h, calls, library } = upgradeHost({
    responses: [
      { username: "peer", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1000, files: [
        { filename: "m\\Radiohead\\06 - Karma Police.flac", size: 30e6, length: 264, bitDepth: 16, sampleRate: 44100 },
        { filename: "m\\Radiohead\\06 - Karma Police (192).mp3", size: 6.3e6, length: 264, bitRate: 192 }] }
    ]
  });
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-upgrade"]({ kind: "track", trackId: 42, title: "Karma Police", artistName: "Radiohead" });
    assert.equal(h.calls.navigated.length, 0, "runs in the background — the view isn't pulled open");
    const started = h.calls.notices.find((n) => /Looking for a better copy/.test(n.message));
    assert.ok(started, h.calls.notifications.join(" | "));
    assert.equal(started.options.action.id, "open-upgrades");

    await waitFor(() => entryOf(p) && entryOf(p).state === "downloading", 8000, "the download to start");
    assert.equal(calls.batches.length, 1);
    assert.equal(calls.batches[0].username, "peer");
    assert.deepEqual(calls.batches[0].files.map((f) => f.filename), ["m\\Radiohead\\06 - Karma Police.flac"]);
    assert.ok(calls.batches[0].options.destination.startsWith("viboplr/upgrades/"), calls.batches[0].options.destination);

    await pollUntil(p, () => entryOf(p).state === "ready", "ready");
    const e = entryOf(p);
    assert.equal(e.file.quality.extension, "flac");
    const ready = h.calls.notices.find((n) => /is ready/.test(n.message));
    assert.ok(ready, h.calls.notifications.join(" | "));
    assert.equal(ready.options.action.id, "upgrade-replace-notice");
    assert.ok(!h.calls.notifications.some((m) => /choose Replace in library on the Downloads tab/.test(m)), "the generic completion toast stays quiet");
    assert.ok(h.store.upgrades.t42, "persisted");

    // The Upgrades tab lists it, with Compare & replace.
    h.actions["main-tab"]({ tabId: "upgrades" });
    const list = findNodes(lastView(h), (n) => n.type === "track-row-list")[0];
    assert.equal(list.items.length, 1);
    assert.ok(list.items[0].subtitle.startsWith("Ready: FLAC"), list.items[0].subtitle);
    assert.deepEqual(list.items[0].actions, ["upgrade-replace", "upgrade-choose", "upgrade-remove"]);

    h.actions["upgrade-replace-notice"]();
    assert.equal(h.calls.requestAction.length, 1);
    const r = h.calls.requestAction[0];
    assert.equal(r.action, "download-tracks");
    assert.equal(r.payload.tracks[0].libraryTrackId, 42);
    assert.equal(r.payload.tracks[0].uri, "slsk://peer" + SEP + "m\\Radiohead\\06 - Karma Police.flac");

    // The user confirmed in the dialog: the library row now points at the new file.
    library.tracks[0].path = "file:///Users/me/Music/RH/06 Karma Police.flac";
    library.tracks[0].file_size = 30e6;
    await pollUntil(p, () => entryOf(p).state === "replaced", "replaced");
  } finally {
    p.deactivate();
  }
});

test("integration: a file that isn't what it claimed is rejected after download and the next sharer is asked", async () => {
  const p = loadPlugin();
  const { h, calls } = upgradeHost({
    responses: [
      // Advertised 320 but 4.2 MB over 264 s — really ~127 kbps. Ranked first (free slot, faster).
      { username: "liar", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 9000, files: [
        { filename: "m\\Radiohead\\06 - Karma Police.mp3", size: 4.2e6, length: 264, bitRate: 320 }] },
      { username: "honest", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 10, files: [
        { filename: "x\\Radiohead - Karma Police.mp3", size: 10.5e6, length: 264, bitRate: 320 }] }
    ]
  });
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-upgrade"]({ kind: "track", trackId: 42 });
    await waitFor(() => entryOf(p) && entryOf(p).state === "downloading", 8000, "the download to start");
    assert.equal(calls.batches[0].username, "liar");
    await pollUntil(p, () => calls.batches.length === 2, "the second sharer");
    assert.equal(calls.batches[1].username, "honest");
    const rejectedKey = "liar" + SEP + "m\\Radiohead\\06 - Karma Police.mp3";
    assert.equal(h.store.tracked[rejectedKey].upgrade, undefined, "the rejected file is no longer offered as a replacement");
    assert.ok(h.store.tracked[rejectedKey], "…but it stays — the plugin deletes only fallback files");
    await pollUntil(p, () => entryOf(p).state === "ready", "ready");
    assert.equal(entryOf(p).file.key, "honest" + SEP + "x\\Radiohead - Karma Police.mp3");
  } finally {
    p.deactivate();
  }
});

test("integration: a sharer who sends nothing is dropped after the stall time for the next one", async () => {
  const p = loadPlugin();
  const { h, calls } = upgradeHost({
    responses: [
      { username: "stuck", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 9000, files: [
        { filename: "m\\Radiohead\\06 - Karma Police.flac", size: 30e6, length: 264, bitDepth: 16 }] },
      { username: "other", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 10, files: [
        { filename: "y\\Radiohead\\06 Karma Police.flac", size: 29e6, length: 264, bitDepth: 16 }] }
    ],
    states: { stuck: ["Queued, Remotely"] }
  });
  p._setUpgradeTimings(30000, 50);
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-upgrade"]({ kind: "track", trackId: 42 });
    await waitFor(() => entryOf(p) && entryOf(p).state === "downloading", 8000, "the download to start");
    assert.equal(calls.batches[0].username, "stuck");
    await new Promise((r) => setTimeout(r, 80));
    await pollUntil(p, () => calls.batches.length === 2, "the next sharer");
    assert.ok(calls.cancels.includes("stuck"), "the stalled transfer was cancelled in slskd");
    assert.equal(calls.batches[1].username, "other");
    assert.equal(h.store.sharers.stuck.stalled, 1, "the ledger remembers the stall");
  } finally {
    p.deactivate();
  }
});

test("integration: nothing at the target → the best better copy is offered; Take it downloads that one", async () => {
  const p = loadPlugin();
  const { h, calls } = upgradeHost({
    target: "lossless",
    responses: [
      { username: "mp3er", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 100, files: [
        { filename: "m\\Radiohead\\06 - Karma Police.mp3", size: 10.5e6, length: 264, bitRate: 320 }] }
    ]
  });
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-upgrade"]({ kind: "track", trackId: 42 });
    await waitFor(() => entryOf(p) && entryOf(p).state === "alternative", 8000, "the alternative");
    assert.equal(calls.batches.length, 0, "nothing downloaded that misses the target");
    assert.ok(/No lossless copy found; best better copy is MP3 320kbps/.test(entryOf(p).message), entryOf(p).message);

    await h.actions["upgrade-take-alternative"]({ itemId: "t42" });
    await waitFor(() => calls.batches.length === 1, 2000, "the alternative's download");
    assert.equal(calls.batches[0].username, "mp3er");
    await pollUntil(p, () => entryOf(p).state === "ready", "ready");
  } finally {
    p.deactivate();
  }
});

test("integration: cancelling the download in Downloads stops the upgrade rather than trying the next sharer", async () => {
  const p = loadPlugin();
  const { h, calls } = upgradeHost({
    responses: [
      { username: "a", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 100, files: [{ filename: "m\\Radiohead\\06 - Karma Police.flac", size: 30e6, length: 264 }] },
      { username: "b", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 10, files: [{ filename: "n\\Radiohead\\06 - Karma Police.flac", size: 30e6, length: 264 }] }
    ],
    states: { a: ["Queued, Remotely", "Completed, Cancelled"] }
  });
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-upgrade"]({ kind: "track", trackId: 42 });
    await waitFor(() => entryOf(p) && entryOf(p).state === "downloading", 8000, "the download to start");
    await pollUntil(p, () => entryOf(p).state === "failed", "stopped");
    assert.equal(entryOf(p).message, "Download cancelled");
    assert.equal(calls.batches.length, 1);
  } finally {
    p.deactivate();
  }
});

test("integration: the Upgrade target is a setting, and Upgrade on a non-library track still falls back to a plain search", async () => {
  const p = loadPlugin();
  const { h } = upgradeHost({ responses: [] });
  await p.activate(h.api);
  try {
    h.actions["main-tab"]({ tabId: "settings" });
    const select = findNodes(lastView(h), (n) => n.type === "settings-row" && n.label === "Upgrade to")[0];
    assert.ok(select, "Settings shows the target");
    assert.deepEqual(select.control.options.map((o) => o.value), ["best", "lossless", "high"]);
    h.actions["set-upgrade-target"]({ value: "high" });
    await waitFor(() => h.store.upgradeTarget === "high", 2000, "the setting to save");

    await h.actions["ctx:slskd-upgrade"]({ kind: "track", title: "Unknown", artistName: "Nobody" });
    assert.ok(h.calls.notifications.some((m) => /Upgrade works on tracks in your library/.test(m)));
    assert.equal(Object.keys(p._upgrades()).length, 0);
  } finally {
    p.deactivate();
  }
});
