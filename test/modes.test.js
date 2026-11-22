const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { fakeHost } = require("./harness/host");

const plugin = loadPlugin();
const SEP = plugin._KEY_SEP;

// --- Upgrade mode -------------------------------------------------------------
// Upgrade runs a search and reads it against the library, keeping only files
// better than the copy in hand. The user still picks what to download — it is
// not a metadata download provider. (Fill missing tracks was removed in 0.33.0.)

// --- libraryQuality ---------------------------------------------------------

test("libraryQuality: lossless by container, a lossy rate from size over duration", () => {
  const flac = plugin._libraryQuality({ format: "flac", file_size: 30e6, duration_secs: 240, path: "file:///a.flac" });
  assert.equal(flac.qualityTier, 0, "lossless");
  assert.equal(flac.bitRate, null, "no rate is invented for lossless");

  // 6,336,000 bytes over 264 s = 192 kbps → medium
  const mp3 = plugin._libraryQuality({ format: "mp3", file_size: 6336000, duration_secs: 264 });
  assert.equal(mp3.bitRate, 192);
  assert.equal(mp3.qualityTier, 3);

  // 9,600,000 bytes over 300 s = 256 kbps → high; container read off the path
  const fromPath = plugin._libraryQuality({ format: null, path: "file:///x/y.m4a", file_size: 9600000, duration_secs: 300 });
  assert.equal(fromPath.extension, "m4a");
  assert.equal(fromPath.bitRate, 256);
  assert.equal(fromPath.qualityTier, 1);

  assert.equal(plugin._libraryQuality({ format: "mp3", file_size: null, duration_secs: 240 }).qualityTier, 2, "no size → unknown");
});

// --- isUpgradeOver ----------------------------------------------------------

test("isUpgradeOver: a higher tier, or the same lossy tier at a clearly higher rate", () => {
  const up = plugin._isUpgradeOver;
  const mp3_192 = { qualityTier: 3, bitRate: 192 };
  assert.equal(up({ qualityTier: 0 }, mp3_192), true, "lossless beats lossy");
  assert.equal(up({ qualityTier: 1, bitRate: 320 }, mp3_192), true, "high beats medium");
  assert.equal(up({ qualityTier: 3, bitRate: 240 }, mp3_192), true, "+25% at the same tier counts");
  assert.equal(up({ qualityTier: 3, bitRate: 200 }, mp3_192), false, "+4% is a re-encode, not an upgrade");
  assert.equal(up({ qualityTier: 4, bitRate: 96 }, mp3_192), false, "worse tier");
  assert.equal(up({ qualityTier: 2, bitRate: null }, mp3_192), false, "a file reporting no quality can't claim to be better");
  assert.equal(up({ qualityTier: 0 }, { qualityTier: 2, bitRate: null }), true, "…but a known lossless beats an unknown copy");
});

test("isUpgradeOver: a lossless copy is beaten only by more bits or a higher sample rate", () => {
  const up = plugin._isUpgradeOver;
  const flac = { qualityTier: 0, bitRate: null };
  assert.equal(up({ qualityTier: 0, bitDepth: 16, sampleRate: 44100 }, flac), false, "same CD quality");
  assert.equal(up({ qualityTier: 0, bitDepth: null, sampleRate: null }, flac), false, "unreported depth/rate is assumed CD");
  assert.equal(up({ qualityTier: 0, bitDepth: 24, sampleRate: 44100 }, flac), true, "24-bit");
  assert.equal(up({ qualityTier: 0, bitDepth: 16, sampleRate: 96000 }, flac), true, "96 kHz");
  assert.equal(up({ qualityTier: 1, bitRate: 320 }, flac), false, "lossy never beats lossless");
});

// --- integration: the modes end to end --------------------------------------
// A scripted slskd (one search, completing on the second poll) plus a small
// library. `posts` records every download batch the plugin asked slskd for.

function modeHost(o) {
  const posts = [];
  let polls = 0;
  const h = fakeHost({
    library: o.library,
    fetch: async (url, init) => {
      const json = (v) => ({ status: 200, text: async () => JSON.stringify(v) });
      if (url.includes("/api/v0/transfers/downloads/batches") && init && init.method === "POST") {
        posts.push(JSON.parse(init.body));
        return json({ failures: [] });
      }
      if (url.includes("/api/v0/searches") && init && init.method === "POST") return json({ id: "s1" });
      if (url.includes("/responses")) return json(o.bodies);
      if (url.includes("/api/v0/searches/s1")) {
        polls++;
        return json({ id: "s1", state: polls >= 2 ? "Completed, ResponseLimitReached" : "InProgress", responseCount: 1, fileCount: 3 });
      }
      return undefined;
    }
  });
  return { h, posts };
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

async function waitFor(pred, ms) {
  const until = Date.now() + (ms || 5000);
  while (Date.now() < until) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting");
}

const LIBRARY_MP3 = {
  id: 42, path: "file:///Users/me/Music/RH/06 Karma Police.mp3", title: "Karma Police", artist_name: "Radiohead",
  album_id: 7, album_title: "OK Computer", track_number: 6, format: "mp3", file_size: 6336000, duration_secs: 264
};

const KARMA_FILES = [
  { filename: "m\\RH\\06 - Karma Police.flac", size: 30e6, length: 264, bitDepth: 16, sampleRate: 44100 },
  { filename: "m\\RH\\06 - Karma Police.mp3", size: 6e6, length: 264, bitRate: 192 },
  { filename: "m\\RH\\06 - Karma Police (320).mp3", size: 10e6, length: 264, bitRate: 320 }
];

test("Upgrade: reads the library copy, shows only better files, and stamps the download with the row to replace", async () => {
  const p = loadPlugin();
  const { h, posts } = modeHost({
    library: { tracks: [LIBRARY_MP3] },
    bodies: [{ username: "peer", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1000, files: KARMA_FILES }]
  });
  await p.activate(h.api);
  try {
    await p._startUpgrade({ kind: "track", trackId: 42, title: "Karma Police", artistName: "Radiohead" });

    let view = lastView(h);
    const header = findNodes(view, (n) => n.type === "text" && /Upgrading/.test(n.content || ""));
    assert.equal(header.length, 1);
    assert.ok(header[0].content.includes("“Karma Police” by Radiohead"), header[0].content);
    assert.ok(header[0].content.includes("MP3 ≈192kbps"), "the copy's quality, marked approximate: " + header[0].content);
    assert.ok(header[0].content.includes("6.0 MB"), header[0].content);

    let list = findNodes(view, (n) => n.type === "track-row-list")[0];
    assert.ok(list, "results rendered");
    assert.deepEqual(list.items.map((i) => i.title), ["06 - Karma Police.flac", "06 - Karma Police (320).mp3"], "the 192 kbps twin is hidden");
    assert.equal(list.actions[0].label, "Upgrade");
    const bar = findNodes(view, (n) => n.type === "toolbar" && (n.buttons || []).length >= 0 && /better file/.test(n.title || ""))[0];
    assert.ok(bar, "the results toolbar counts the better files");
    assert.ok(!bar.buttons.some((b) => b.action === "result-mode"), "no Folders view for a single track");
    assert.equal(findNodes(view, (n) => n.type === "text" && /Showing the best/.test(n.content || "")).length, 0, "no truncation note under the filter");

    // Lifting the filter shows all three, the better two still marked.
    h.actions["mode-show-all"]();
    view = lastView(h);
    list = findNodes(view, (n) => n.type === "track-row-list")[0];
    assert.equal(list.items.length, 3);
    const marks = list.items.map((i) => (i.cells.quality || "").startsWith("↑ "));
    assert.deepEqual(marks, [true, true, false]);

    // Picking one makes it that track's upgrade job, downloading this file
    // with the library's names — no search of its own.
    const key = "peer" + SEP + KARMA_FILES[2].filename;
    h.actions["download-file"]({ itemId: "f:" + key });
    await waitFor(() => h.store.tracked && h.store.tracked[key]);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].files.map((f) => f.filename), [KARMA_FILES[2].filename]);
    const rec = h.store.tracked[key];
    assert.equal(rec.upgrade.trackId, 42);
    assert.equal(rec.upgrade.auto, true, "the job follows it");
    assert.equal(rec.meta.title, "Karma Police");
    assert.equal(rec.meta.album, "OK Computer", "album from the library, not guessed from the folder");
    assert.equal(rec.meta.trackNumber, 6);
    await waitFor(() => p._upgrades()["t42"] && p._upgrades()["t42"].state === "downloading");
    const job = p._upgrades()["t42"];
    assert.equal(job.active.filename, KARMA_FILES[2].filename);
    assert.equal(job.target, "best", "an MP3 picked by hand lowers the FLAC target for this job");
    assert.equal(h.calls.notifications.length, 0, "no toast: the row says Queued");
  } finally {
    p.deactivate();
  }
});

test("Upgrade: says when nothing better exists, and falls back to a plain search for a track that isn't a local library file", async () => {
  const p = loadPlugin();
  const { h } = modeHost({
    library: { tracks: [LIBRARY_MP3, { id: 43, path: "subsonic://x/1", title: "Airbag", artist_name: "Radiohead", format: null, file_size: null, duration_secs: 284 }] },
    bodies: [{ username: "peer", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1000, files: [KARMA_FILES[1]] }]
  });
  await p.activate(h.api);
  try {
    await p._startUpgrade({ kind: "track", trackId: 42 });
    let view = lastView(h);
    assert.equal(findNodes(view, (n) => n.type === "track-row-list").length, 0);
    assert.equal(findNodes(view, (n) => n.type === "text" && /Nothing better than your copy/.test(n.content || "")).length, 1);

    await p._startUpgrade({ kind: "track", trackId: 43 });
    view = lastView(h);
    assert.equal(findNodes(view, (n) => n.type === "text" && /isn't one — searching Soulseek/.test(n.content || "")).length, 1, "the reason sits in the Search tab");
    assert.equal(findNodes(view, (n) => n.type === "text" && /Upgrading/.test(n.content || "")).length, 0, "a plain search, no mode");

    await p._startUpgrade({ kind: "track", title: "No Surprises", artistName: "Radiohead" });
    view = lastView(h);
    assert.equal(findNodes(view, (n) => n.type === "text" && /Upgrade works on tracks in your library/.test(n.content || "")).length, 1);
    assert.equal(findNodes(view, (n) => n.type === "text" && /isn't one/.test(n.content || "")).length, 0, "a new search replaces the old note");
    assert.equal(h.calls.notifications.length, 0, "no toasts: " + h.calls.notifications.join(" | "));
  } finally {
    p.deactivate();
  }
});

// The queue and Now Playing only know a library id when the entry cached one,
// so Upgrade on the playing song arrives with names alone. It must still find
// the library row — before, it became a plain search whose download could
// never be replaced into the library ("That file isn't a finished upgrade").
test("Upgrade: a target with no library id finds the row by title and artist", async () => {
  const p = loadPlugin();
  const LIVE = Object.assign({}, LIBRARY_MP3, { id: 50, path: "file:///Users/me/Music/RH/Karma Police (live).mp3", duration_secs: 290 });
  const REMOTE = Object.assign({}, LIBRARY_MP3, { id: 51, path: "subsonic://x/9" });
  const { h } = modeHost({
    library: { tracks: [REMOTE, LIVE, LIBRARY_MP3] },
    bodies: [{ username: "peer", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1000, files: KARMA_FILES }]
  });
  await p.activate(h.api);
  try {
    await p._startUpgrade({ kind: "track", title: "karma police", artistName: "RADIOHEAD", durationSecs: 263 });
    const header = findNodes(lastView(h), (n) => n.type === "text" && /Upgrading/.test(n.content || ""));
    assert.equal(header.length, 1, "upgrade mode, not a plain search");
    assert.ok(!h.calls.notifications.some((m) => /Upgrade works on tracks in your library/.test(m)));

    const key = "peer" + SEP + KARMA_FILES[0].filename;
    h.actions["download-file"]({ itemId: "f:" + key });
    await waitFor(() => h.store.tracked && h.store.tracked[key]);
    assert.equal(h.store.tracked[key].upgrade.trackId, 42, "the local copy nearest in length, not the remote or the live one");
  } finally {
    p.deactivate();
  }
});

// --- Download mode ------------------------------------------------------------
// "Download…" on a track the library doesn't hold as a local file: the Search
// tab shows only files that are this song, the best first, and the finished
// file is offered to the library.

test("the manifest offers Download (and its taken-over twin) on tracks and keeps Search… for albums and artists", () => {
  const manifest = JSON.parse(require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "manifest.json"), "utf8"));
  const items = manifest.contributes.contextMenuItems;
  const dl = items.find((i) => i.id === "slskd-download");
  assert.ok(dl, "a Download item");
  assert.equal(dl.label, "Download", "no plugin name in the label — the host adds it; no … since it starts at once");
  assert.deepEqual(dl.targets, ["track"]);
  const choose = items.find((i) => i.id === "slskd-download-choose");
  assert.equal(choose.label, "Download and let me choose…");
  assert.deepEqual(choose.targets, ["track"]);
  assert.ok(!items.some((i) => i.id === "slskd-upgrade"), "a song you have is a Download too");
  assert.deepEqual(items.filter((i) => i.targets.includes("track")).map((i) => i.id), ["slskd-download", "slskd-download-choose"]);
  assert.deepEqual(items.find((i) => i.id === "slskd-search").targets, ["album", "artist"]);
});

const DL_FILE = "m\\Radiohead\\OK Computer\\06 - Karma Police.flac";

test("a finished Download (a record from before 0.28) offers the file to the library; one landing in a collection says it's on its way", async () => {
  const p = loadPlugin();
  const { h } = modeHost({ library: { tracks: [] }, bodies: [] });
  await p.activate(h.api);
  try {
    const key = "peer" + SEP + DL_FILE;
    const outside = "/Users/me/Downloads/slskd/viboplr/1-x/06 - Karma Police.flac";
    h.store.tracked = h.store.tracked || {};
    p._setTracked(key, { resolvedPath: outside, meta: { title: "Karma Police", artist: "Radiohead" },
      download: { title: "Karma Police", artist: "Radiohead" } });
    await p._handleCompletions([{ username: "peer", filename: DL_FILE, state: "Completed, Succeeded", size: 30e6 }]);
    const n = h.calls.notices[h.calls.notices.length - 1];
    assert.match(n.message, /^“Karma Police” is downloaded/);
    assert.equal(n.options.action.label, "Add to library…");
    await h.actions[n.options.action.id]();
    const r = h.calls.requestAction[h.calls.requestAction.length - 1];
    assert.equal(r.action, "download-tracks");
    assert.equal(r.payload.purpose, "import");
    assert.equal(r.payload.tracks[0].title, "Karma Police");

    // Inside a collection the rescan brings it in: no button to press.
    p._setTracked(key, { resolvedPath: "/Users/me/Music/slskd/x/06 - Karma Police.flac", meta: { title: "Karma Police" },
      download: { title: "Karma Police", artist: "Radiohead" } });
    await p._handleCompletions([{ username: "peer", filename: DL_FILE, state: "Completed, Succeeded", size: 30e6 }]);
    const m = h.calls.notices.filter((x) => /Karma Police/.test(x.message)).pop();
    assert.match(m.message, /on its way into your library/);
    assert.ok(!(m.options && m.options.action), "no button when the scan does it");
  } finally {
    p.deactivate();
  }
});
