const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { fakeHost } = require("./harness/host");

// --- Blocked search phrases ---------------------------------------------------
// Soulseek's server won't search some phrases (artist names, after takedown
// requests): "Linkin Park Numb" gets no responses at all while "Meteora Numb"
// gets hundreds of files — most of them filed under "Linkin Park". A track
// search that comes back with nothing, when it named the artist, retries once
// by album + title, and the album then stands in for the artist when matching.

const plugin = loadPlugin();

test("albumTitleQuery: album words, then title words; nothing without an album", () => {
  assert.equal(plugin._albumTitleQuery("Numb", "Meteora"), "meteora numb");
  assert.equal(plugin._albumTitleQuery("Hey", "Doolittle (Remastered)"), "doolittle hey", "edition parentheses go");
  assert.equal(plugin._albumTitleQuery("Numb", null), null, "the title alone matches too many other songs");
  assert.equal(plugin._albumTitleQuery("Numb", ""), null);
});

const NUMB_IN_ALBUM_FOLDER = {
  username: "peer", filename: "music\\Meteora\\13 - Numb.flac", size: 25e6, length: 187,
  bitDepth: 16, sampleRate: 44100, extension: "flac", qualityTier: 0, formatRank: 0, sharerTier: 1, availabilityTier: 0
};

test("rankFallback: an album folder stands in for the artist only when the search was by album", () => {
  assert.equal(plugin._rankFallback([NUMB_IN_ALBUM_FOLDER], "Numb", "Linkin Park", null, "best").length, 0,
    "a path that never names the artist is not that artist's song — by default");
  const byAlbum = plugin._rankFallback([NUMB_IN_ALBUM_FOLDER], "Numb", "Linkin Park", null, "best", "Meteora");
  assert.equal(byAlbum.length, 1, "…but it is when the album is the identity we searched by");
  const live = Object.assign({}, NUMB_IN_ALBUM_FOLDER, { filename: "music\\Meteora\\13 - Numb (Live).flac" });
  assert.equal(plugin._rankFallback([live], "Numb", "Linkin Park", null, "best", "Meteora")[0].match.penalty > 0, true,
    "a variant word still costs, album or not");
  const other = Object.assign({}, NUMB_IN_ALBUM_FOLDER, { filename: "music\\Zooropa\\03 - Numb.flac" });
  assert.equal(plugin._rankFallback([other], "Numb", "Linkin Park", null, "best", "Meteora").length, 0,
    "another album's 'Numb' (U2) is not this one");
});

const LIBRARY = [
  { id: 1, path: "file:///m/LP/13 Numb.mp3", title: "Numb", artist_name: "Linkin Park", album_id: 1, album_title: "Meteora",
    track_number: 13, format: "mp3", file_size: 4500329, duration_secs: 187 },
  { id: 2, path: "file:///m/LP/08 In the End.mp3", title: "In the End", artist_name: "Linkin Park", album_id: 2, album_title: "Hybrid Theory",
    track_number: 8, format: "mp3", file_size: 3700000, duration_secs: 216 },
  { id: 3, path: "file:///m/X/01 Song.mp3", title: "Song", artist_name: "Nobody Shares", album_id: 3, album_title: null,
    track_number: 1, format: "mp3", file_size: 3000000, duration_secs: 200 }
];

// A scripted slskd whose server refuses `blocked` (lowercased substring): those
// searches finish with no responses at all. Everything else answers with one
// album-folder FLAC per known title. Records every searchText.
function blockingHost(blocked) {
  const searches = [];
  const h = fakeHost({
    store: { upgradeTarget: "best" },
    library: { tracks: LIBRARY.map((t) => Object.assign({}, t)) },
    fetch: async (url, init) => {
      const json = (v) => ({ status: 200, text: async () => JSON.stringify(v) });
      const method = (init && init.method) || "GET";
      if (url.endsWith("/api/v0/searches") && method === "POST") {
        const text = JSON.parse(init.body).searchText;
        searches.push(text);
        return json({ id: "s" + searches.length });
      }
      const m = url.match(/\/api\/v0\/searches\/s(\d+)/);
      if (!m) return undefined;
      const text = searches[Number(m[1]) - 1].toLowerCase();
      const responses = text.includes(blocked) ? [] : answerFor(text);
      if (method === "PUT") return json({});
      if (url.includes("/responses")) return json(responses);
      return json({ id: "s" + m[1], state: "Completed, Succeeded", responseCount: responses.length, fileCount: responses.length });
    }
  });
  return { h, searches };
}

function answerFor(text) {
  const files = [];
  if (text.includes("numb")) files.push({ filename: "music\\Meteora\\13 - Numb.flac", size: 25e6, length: 187, bitDepth: 16, sampleRate: 44100 });
  if (text.includes("end")) files.push({ filename: "music\\Hybrid Theory\\08 - In the End.flac", size: 26e6, length: 216, bitDepth: 16, sampleRate: 44100 });
  if (text.includes("song")) files.push({ filename: "music\\Misc\\01 - Song.txt", size: 1000, length: null });
  return [{ username: "peer", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1e6, files }];
}

async function waitFor(pred, what) {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting for " + what);
}

test("integration: an upgrade whose artist is a blocked phrase searches by album + title and finds the file", async () => {
  const p = loadPlugin();
  const { h, searches } = blockingHost("linkin park");
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-upgrade"]({ kind: "track", trackId: 1, title: "Numb", artistName: "Linkin Park" });
    await waitFor(() => p._upgrades().t1 && p._upgrades().t1.state !== "searching", "the search to settle");
    assert.deepEqual(searches, ["linkin park numb", "meteora numb"], "one blocked search, then the album + title one");
    const e = p._upgrades().t1;
    assert.notEqual(e.state, "none", e.message);
    assert.ok(e.candidates.length, "the album-folder FLAC is a candidate");
    assert.equal(e.candidates[0].filename, "music\\Meteora\\13 - Numb.flac");
    assert.equal(p._blockedArtists()["linkin park"], true, "remembered for the session");

    // The next Linkin Park track skips the dead search entirely.
    await h.actions["ctx:slskd-upgrade"]({ kind: "track", trackId: 2, title: "In the End", artistName: "Linkin Park" });
    await waitFor(() => p._upgrades().t2 && p._upgrades().t2.state !== "searching", "the second search");
    assert.deepEqual(searches.slice(2), ["hybrid theory in end"], "straight to album + title (stop words dropped)");
    assert.ok(p._upgrades().t2.candidates.length);
  } finally {
    p.deactivate();
  }
});

test("integration: with no album to search by, the upgrade says the artist is blocked instead of 'nothing matched'", async () => {
  const p = loadPlugin();
  const { h, searches } = blockingHost("nobody shares");
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-upgrade"]({ kind: "track", trackId: 3, title: "Song", artistName: "Nobody Shares" });
    await waitFor(() => p._upgrades().t3 && p._upgrades().t3.state !== "searching", "the search to settle");
    assert.deepEqual(searches, ["nobody shares song"], "no retry without an album");
    const e = p._upgrades().t3;
    assert.equal(e.state, "none");
    assert.match(e.message, /blocked search phrase/);
    assert.match(e.message, /no album/);
  } finally {
    p.deactivate();
  }
});

test("integration: peers that answer with nothing downloadable are not a block — no retry, nothing remembered", async () => {
  const p = loadPlugin();
  const { h, searches } = blockingHost("never-blocked");
  await p.activate(h.api);
  try {
    // "song" answers with a .txt only: responses, but nothing playable.
    await h.actions["ctx:slskd-upgrade"]({ kind: "track", trackId: 3, title: "Song", artistName: "Nobody Shares" });
    await waitFor(() => p._upgrades().t3 && p._upgrades().t3.state !== "searching", "the search to settle");
    assert.deepEqual(searches, ["nobody shares song"]);
    assert.equal(p._upgrades().t3.message, "Nothing on Soulseek matched this track");
    assert.deepEqual(p._blockedArtists(), {});
  } finally {
    p.deactivate();
  }
});

test("assistant search with upgradeFor: a blocked artist retries by album and says so", async () => {
  const p = loadPlugin();
  const { h, searches } = blockingHost("linkin park");
  await p.activate(h.api);
  try {
    const out = await h.tools.search({ upgradeFor: 1 });
    assert.deepEqual(searches, ["linkin park numb", "meteora numb"]);
    assert.equal(out.query, "meteora numb");
    assert.equal(out.better, 1);
    assert.match(out.note, /blocked search on Soulseek/);
  } finally {
    p.deactivate();
  }
});

test("assistant search with an explicit query: zero answers says the phrase may be blocked", async () => {
  const p = loadPlugin();
  const { h } = blockingHost("linkin park");
  await p.activate(h.api);
  try {
    const out = await h.tools.search({ query: "Linkin Park Numb" });
    assert.equal(out.total, 0);
    assert.match(out.note, /blocks searches for some artist names/);
  } finally {
    p.deactivate();
  }
});
