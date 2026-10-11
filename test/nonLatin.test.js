const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { fakeHost } = require("./harness/host");

// --- Names outside a–z --------------------------------------------------------
// normalizeText once kept only [a-z0-9]: a Greek or Cyrillic title became an
// empty search slskd refuses ("SearchText can not be null, empty…"), and
// letters NFD can't take apart were cut out mid-word ("Lágnætti" → "lagn tti").
// Soulseek peers match characters literally, so a track search tries its own
// spelling first and the folded one after.

const p = loadPlugin();

test("normalizeText keeps every script's letters and folds the ones NFD leaves whole", () => {
  assert.equal(p._normalizeText("Σωκράτης Μάλαμας — Τσιγάρο ατέλειωτο"), "σωκρατησ μαλαμασ τσιγαρο ατελειωτο");
  assert.equal(p._normalizeText("Sólstafir – Lágnætti"), "solstafir lagnaetti");
  assert.equal(p._normalizeText("Miðaftann"), "midaftann");
  assert.equal(p._normalizeText("Мумий Тролль"), "мумии тролль", "й is и + a mark under NFD — folded alike on both sides");
  assert.equal(p._normalizeText("Straße / Øresund / Þórir"), "strasse oresund thorir");
  assert.equal(p._normalizeText("Björk — Jóga (Remastered)"), "bjork joga remastered", "Latin unchanged");
});

test("fallbackQuery: never empty for a non-Latin title; the query forms keep the letters", () => {
  assert.equal(p._fallbackQuery("Τσιγάρο ατέλειωτο", "Σωκράτης Μάλαμας"), "σωκρατησ μαλαμασ τσιγαρο ατελειωτο", "matching form");
  assert.equal(p._fallbackQuery("Τσιγάρο ατέλειωτο", "Σωκράτης Μάλαμας", true), "σωκράτης μάλαμας τσιγάρο ατέλειωτο");
  assert.equal(p._fallbackQuery("Τσιγάρο ατέλειωτο", "Σωκράτης Μάλαμας", "unaccented"), "σωκρατης μαλαμας τσιγαρο ατελειωτο",
    "accents off, final sigma kept — peers match letters literally");
  assert.equal(p._fallbackQuery("Lágnætti", "Sólstafir", true), "sólstafir lágnætti");
  assert.equal(p._fallbackQuery("Lágnætti", "Sólstafir", "unaccented"), "solstafir lagnætti");
  assert.equal(p._fallbackQuery("The Song (Remastered)", "The Band", true), "band song", "stop and edition words still go");
});

function file(filename) {
  return { username: "peer", filename, size: 9e6, length: 226, bitDepth: 16, sampleRate: 44100, extension: "flac",
    qualityTier: 0, formatRank: 0, sharerTier: 1, availabilityTier: 0 };
}

test("rankFallback matches a Greek title written with or without accents", () => {
  const accented = file("ellinika\\Σωκράτης Μάλαμας\\Κύκλος\\10 Τσιγάρο ατέλειωτο.flac");
  const bare = file("ellinika\\Σωκρατης Μαλαμας - 10 Τσιγαρο ατελειωτο.flac");
  const other = file("ellinika\\Σωκρατης Μαλαμας - 11 Τα πάγια.flac");
  const got = p._rankFallback([accented, bare, other], "Τσιγάρο ατέλειωτο", "Σωκράτης Μάλαμας", null, "best");
  assert.deepEqual(got.map((c) => c.filename).sort(), [accented.filename, bare.filename].sort());
});

test("rankFallback matches Icelandic letters against a file that spelled them out", () => {
  const spelledOut = file("music\\Solstafir\\Otta\\01 - Lagnaetti.flac");
  assert.equal(p._rankFallback([spelledOut], "Lágnætti", "Sólstafir", null, "best").length, 1);
});

// A scripted slskd answering only exact spellings — peers match characters
// literally. `answers[searchText]` is that search's file list.
function spellingHost(answers, library) {
  const searches = [];
  const h = fakeHost({
    store: { upgradeTarget: "best" },
    library: { tracks: library },
    fetch: async (url, init) => {
      const json = (v) => ({ status: 200, text: async () => JSON.stringify(v) });
      const method = (init && init.method) || "GET";
      if (url.endsWith("/api/v0/searches") && method === "POST") {
        const text = JSON.parse(init.body).searchText;
        if (!text.trim()) return { status: 400, text: async () => '"The field SearchText can not be null, empty, or consist of only whitespace"' };
        searches.push(text);
        return json({ id: "s" + searches.length });
      }
      const m = url.match(/\/api\/v0\/searches\/s(\d+)/);
      if (!m) return undefined;
      const files = answers[searches[Number(m[1]) - 1]] || [];
      const responses = files.length ? [{ username: "peer", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1e6, files }] : [];
      if (method === "PUT") return json({});
      if (url.includes("/responses")) return json(responses);
      return json({ id: "s" + m[1], state: "Completed, Succeeded", responseCount: responses.length, fileCount: files.length });
    }
  });
  return { h, searches };
}

async function settled(p, key) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const e = p._upgrades()[key];
    if (e && e.state !== "searching") return e;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("never settled");
}

const MALAMAS = { id: 12368, path: "file:///m/GR/10 Τσιγάρο ατέλειωτο.mp3", title: "Τσιγάρο ατέλειωτο", artist_name: "Σωκράτης Μάλαμας",
  album_id: 1, album_title: "Κύκλος", track_number: 10, format: "mp3", file_size: 3700000, duration_secs: 226 };

test("integration: a Greek upgrade searches as spelled, then unaccented — and finds the unaccented file", async () => {
  const p2 = loadPlugin();
  const { h, searches } = spellingHost({
    "σωκρατης μαλαμας τσιγαρο ατελειωτο": [
      { filename: "ellinika\\Σωκρατης Μαλαμας - 10 Τσιγαρο ατελειωτο.flac", size: 25e6, length: 226, bitDepth: 16, sampleRate: 44100 }]
  }, [Object.assign({}, MALAMAS)]);
  await p2.activate(h.api);
  try {
    await h.actions["ctx:slskd-upgrade"]({ kind: "track", trackId: 12368, title: MALAMAS.title, artistName: MALAMAS.artist_name });
    const e = await settled(p2, "t12368");
    assert.deepEqual(searches, ["σωκράτης μάλαμας τσιγάρο ατέλειωτο", "σωκρατης μαλαμας τσιγαρο ατελειωτο"],
      "never an empty query; the spelled form first");
    assert.ok(e.candidates.length, e.message);
    assert.deepEqual(p2._blockedArtists(), {}, "an answered folded search is not a block");
  } finally {
    p2.deactivate();
  }
});

test("integration: the spelled query answering stops there", async () => {
  const p2 = loadPlugin();
  const { h, searches } = spellingHost({
    "σωκράτης μάλαμας τσιγάρο ατέλειωτο": [
      { filename: "ellinika\\Σωκράτης Μάλαμας\\Κύκλος\\10 Τσιγάρο ατέλειωτο.flac", size: 25e6, length: 226, bitDepth: 16, sampleRate: 44100 }]
  }, [Object.assign({}, MALAMAS)]);
  await p2.activate(h.api);
  try {
    await h.actions["ctx:slskd-upgrade"]({ kind: "track", trackId: 12368, title: MALAMAS.title, artistName: MALAMAS.artist_name });
    const e = await settled(p2, "t12368");
    assert.deepEqual(searches, ["σωκράτης μάλαμας τσιγάρο ατέλειωτο"]);
    assert.ok(e.candidates.length, e.message);
  } finally {
    p2.deactivate();
  }
});
