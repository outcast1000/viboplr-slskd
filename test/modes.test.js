const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { fakeHost } = require("./harness/host");

const plugin = loadPlugin();
const SEP = plugin._KEY_SEP;

// --- Upgrade / fill-album modes ---------------------------------------------
// Two context-menu actions run a search and read it against the library:
// "Upgrade with Soulseek…" keeps only files better than the copy in hand,
// "Fill missing tracks with Soulseek…" keeps only files the album lacks. The
// user still picks what to download — neither is a metadata download provider.

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

// --- ownedTrackFor / missingFiles -------------------------------------------

test("ownedTrackFor matches a Soulseek filename to a library title on words, both ways", () => {
  const owned = [{ title: "Karma Police" }, { title: "No Surprises" }];
  const of = (filename) => plugin._ownedTrackFor({ filename }, owned);
  assert.equal(of("m\\Radiohead - OK Computer\\06 - Karma Police.flac").title, "Karma Police");
  assert.equal(of("m\\OK Computer\\Radiohead - No Surprises.mp3").title, "No Surprises", "an 'Artist - Title' stem");
  assert.equal(of("m\\OK Computer\\Karma Police (Remastered 2009).flac").title, "Karma Police", "edition words and years are noise");
  assert.equal(of("m\\OK Computer\\07 - Fitter Happier.flac"), null);
  assert.equal(of("m\\Live\\06 - Karma Police (Live).mp3"), null, "a variant word the library title lacks is a different recording");
  assert.equal(of("m\\x\\Police.mp3"), null, "half the words is not the song");
  assert.equal(plugin._ownedTrackFor({ filename: "m\\x\\Karma Police.mp3" }, []), null, "nothing owned → nothing matches");
});

test("missingFiles keeps only what the album lacks", () => {
  const owned = [{ title: "Airbag" }, { title: "Paranoid Android" }];
  const files = [
    { filename: "m\\OKC\\01 - Airbag.flac" },
    { filename: "m\\OKC\\02 - Paranoid Android.flac" },
    { filename: "m\\OKC\\03 - Subterranean Homesick Alien.flac" }
  ];
  assert.deepEqual(plugin._missingFiles(files, owned).map((f) => f.filename), ["m\\OKC\\03 - Subterranean Homesick Alien.flac"]);
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
    assert.equal(findNodes(view, (n) => n.type === "tabs" && n.action === "result-mode").length, 0, "no Folders view for a single track");
    assert.equal(findNodes(view, (n) => n.type === "text" && /Showing the best/.test(n.content || "")).length, 0, "no truncation note under the filter");

    // Lifting the filter shows all three, the better two still marked.
    h.actions["mode-show-all"]();
    view = lastView(h);
    list = findNodes(view, (n) => n.type === "track-row-list")[0];
    assert.equal(list.items.length, 3);
    const marks = list.items.map((i) => (i.cells.quality || "").startsWith("↑ "));
    assert.deepEqual(marks, [true, true, false]);

    // Picking one downloads it with the library's names and the row to replace.
    const key = "peer" + SEP + KARMA_FILES[2].filename;
    h.actions["download-file"]({ itemId: "f:" + key });
    await waitFor(() => h.store.tracked && h.store.tracked[key]);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].files.map((f) => f.filename), [KARMA_FILES[2].filename]);
    const rec = h.store.tracked[key];
    assert.deepEqual(rec.upgrade, { trackId: 42, title: "Karma Police", artist: "Radiohead" });
    assert.equal(rec.meta.title, "Karma Police");
    assert.equal(rec.meta.album, "OK Computer", "album from the library, not guessed from the folder");
    assert.equal(rec.meta.trackNumber, 6);

    // Finished: the row offers Replace ahead of the generic copy, and Replace
    // hands the host modal the library row to replace.
    assert.deepEqual(plugin._transferRowActions({ state: "Completed, Succeeded" }, { resolvedPath: "/x", upgrade: { trackId: 42 } }, "local"),
      ["play-transfer", "replace-transfer", "import-transfer", "remove-transfer"]);
    rec.resolvedPath = "/Users/me/Music/slskd/viboplr/1-RH/06 - Karma Police (320).mp3";
    h.actions["replace-transfer"]({ itemId: key });
    assert.equal(h.calls.requestAction.length, 1);
    const r = h.calls.requestAction[0];
    assert.equal(r.action, "download-tracks");
    assert.equal(r.payload.providerId, "slskd:slskd-import");
    assert.equal(r.payload.tracks.length, 1);
    assert.equal(r.payload.tracks[0].uri, "slsk://" + key);
    assert.equal(r.payload.tracks[0].libraryTrackId, 42);
    assert.equal(r.payload.tracks[0].title, "Karma Police");
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
    assert.ok(h.calls.notifications.some((m) => /isn't one — searching Soulseek/.test(m)), h.calls.notifications.join(" | "));
    view = lastView(h);
    assert.equal(findNodes(view, (n) => n.type === "text" && /Upgrading/.test(n.content || "")).length, 0, "a plain search, no mode");

    await p._startUpgrade({ kind: "track", title: "Karma Police", artistName: "Radiohead" });
    assert.ok(h.calls.notifications.some((m) => /Upgrade works on tracks in your library/.test(m)));
  } finally {
    p.deactivate();
  }
});

const OKC_OWNED = [
  { id: 1, album_id: 7, title: "Airbag", track_number: 1, duration_secs: 284, path: "file:///a" },
  { id: 2, album_id: 7, title: "Paranoid Android", track_number: 2, duration_secs: 383, path: "file:///b" },
  { id: 9, album_id: 8, title: "Creep", track_number: 2, duration_secs: 238, path: "file:///c" }
];
const OKC_BODIES = [
  { username: "peer", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1000, files: [
    { filename: "m\\OK Computer\\01 - Airbag.flac", size: 30e6, length: 284, bitDepth: 16, sampleRate: 44100 },
    { filename: "m\\OK Computer\\02 - Paranoid Android.flac", size: 40e6, length: 383, bitDepth: 16, sampleRate: 44100 },
    { filename: "m\\OK Computer\\03 - Subterranean Homesick Alien.flac", size: 28e6, length: 267, bitDepth: 16, sampleRate: 44100 }
  ] },
  { username: "other", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 500, files: [
    { filename: "z\\OKC\\Airbag.mp3", size: 6e6, length: 284, bitRate: 320 }
  ] }
];

test("Fill: compares each folder with the album's library rows and downloads only what's missing", async () => {
  const p = loadPlugin();
  const { h, posts } = modeHost({ library: { tracks: OKC_OWNED }, bodies: OKC_BODIES });
  await p.activate(h.api);
  try {
    await p._startFill({ kind: "album", albumId: 7, albumTitle: "OK Computer", artistName: "Radiohead" });

    let view = lastView(h);
    const header = findNodes(view, (n) => n.type === "text" && /Filling/.test(n.content || ""))[0];
    assert.ok(header, "mode header");
    assert.ok(header.content.includes("“OK Computer” by Radiohead"), header.content);
    assert.ok(header.content.includes("you have 2 tracks"), "counts this album's rows only: " + header.content);

    // Opens on Folders; the folder that has nothing new is hidden.
    const tabs = findNodes(view, (n) => n.type === "tabs" && n.action === "result-mode")[0];
    assert.equal(tabs.activeTab, "folders");
    let grid = findNodes(view, (n) => n.type === "card-grid")[0];
    assert.ok(grid, "folder cards");
    assert.equal(grid.items.length, 1);
    assert.equal(grid.items[0].title, "OK Computer");
    assert.ok(grid.items[0].subtitle.includes("3 files · 1 you don't have · 27 MB"), "the missing file's size, not the folder's: " + grid.items[0].subtitle);
    assert.equal(grid.items[0].action, "fill-folder");

    // Everything: both folders, the complete one saying so.
    h.actions["mode-show-all"]();
    grid = findNodes(lastView(h), (n) => n.type === "card-grid")[0];
    assert.equal(grid.items.length, 2);
    assert.ok(grid.items[1].subtitle.includes("you have all of these"), grid.items[1].subtitle);
    h.actions["mode-show-all"]();

    // Fill from the folder: one file, tagged with the library's album.
    h.actions["fill-folder"]({ itemId: grid.items[0].id });
    await waitFor(() => posts.length === 1);
    assert.equal(posts[0].username, "peer");
    assert.deepEqual(posts[0].files.map((f) => f.filename), ["m\\OK Computer\\03 - Subterranean Homesick Alien.flac"]);
    await waitFor(() => h.store.tracked && Object.keys(h.store.tracked).length === 1);
    const rec = h.store.tracked[Object.keys(h.store.tracked)[0]];
    assert.equal(rec.meta.album, "OK Computer");
    assert.equal(rec.meta.albumArtist, "Radiohead");
    assert.equal(rec.meta.title, "Subterranean Homesick Alien", "the file's own title stands");
    assert.equal(rec.upgrade, undefined, "a fill is not an upgrade");

    // A folder with nothing missing is a no-op with a reason.
    h.actions["fill-folder"]({ itemId: grid.items[1].id });
    assert.ok(h.calls.notifications.some((m) => /already have every track/.test(m)));
    assert.equal(posts.length, 1);

    // The Files view under the same filter shows only the missing file.
    h.actions["result-mode"]({ tabId: "files" });
    const list = findNodes(lastView(h), (n) => n.type === "track-row-list")[0];
    assert.deepEqual(list.items.map((i) => i.title), ["03 - Subterranean Homesick Alien.flac"]);
  } finally {
    p.deactivate();
  }
});

test("Fill: an album target without an id is looked up by name, and one with no library rows becomes a plain search", async () => {
  const p = loadPlugin();
  const { h } = modeHost({
    library: { tracks: OKC_OWNED, albums: [{ id: 8, title: "Pablo Honey", artist_name: "Radiohead" }, { id: 7, title: "OK Computer", artist_name: "Radiohead" }] },
    bodies: OKC_BODIES
  });
  await p.activate(h.api);
  try {
    await p._startFill({ kind: "album", albumTitle: "ok computer", artistName: "Radiohead" });
    const header = findNodes(lastView(h), (n) => n.type === "text" && /Filling/.test(n.content || ""))[0];
    assert.ok(header && header.content.includes("you have 2 tracks"), "resolved the id by title, case-insensitively");

    await p._startFill({ kind: "album", albumTitle: "Kid A", artistName: "Radiohead" });
    assert.ok(h.calls.notifications.some((m) => /“Kid A” has no tracks in your library/.test(m)), h.calls.notifications.join(" | "));
    assert.equal(findNodes(lastView(h), (n) => n.type === "text" && /Filling/.test(n.content || "")).length, 0);
  } finally {
    p.deactivate();
  }
});
