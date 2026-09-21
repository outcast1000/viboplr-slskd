const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { file, response } = require("./harness/fixtures.js");

const plugin = loadPlugin();

// --- qualityTier -----------------------------------------------------------

test("qualityTier: lossless extensions win regardless of bitrate", () => {
  assert.equal(plugin._qualityTier(file({ extension: "flac", bitRate: null })), 0);
  assert.equal(plugin._qualityTier(file({ extension: "wav", bitRate: 64 })), 0);
});

test("qualityTier: a non-null bitDepth also means lossless", () => {
  assert.equal(plugin._qualityTier(file({ extension: "m4a", bitDepth: 24, bitRate: null })), 0);
});

test("qualityTier: bitrate thresholds", () => {
  assert.equal(plugin._qualityTier(file({ bitRate: 320 })), 1); // high
  assert.equal(plugin._qualityTier(file({ bitRate: 256 })), 1);
  assert.equal(plugin._qualityTier(file({ bitRate: 192 })), 3); // medium
  assert.equal(plugin._qualityTier(file({ bitRate: 128 })), 3);
  assert.equal(plugin._qualityTier(file({ bitRate: 96 })), 4);  // low
});

test("qualityTier: VBR at >=192 counts as high, below that it does not", () => {
  assert.equal(plugin._qualityTier(file({ bitRate: 192, isVariableBitRate: true })), 1);
  assert.equal(plugin._qualityTier(file({ bitRate: 160, isVariableBitRate: true })), 3);
});

test("qualityTier: unknown bitrate ranks BELOW high and ABOVE medium", () => {
  const unknown = plugin._qualityTier(file({ bitRate: null }));
  assert.equal(unknown, 2);
  assert.ok(unknown > plugin._qualityTier(file({ bitRate: 320 })), "unknown must lose to high");
  assert.ok(unknown < plugin._qualityTier(file({ bitRate: 128 })), "unknown must beat medium");
});

test("qualityTier: falls back to the filename when extension is empty", () => {
  assert.equal(plugin._qualityTier(file({ extension: "", filename: "x\\y.flac", bitRate: null })), 0);
});

// --- rejection -------------------------------------------------------------

test("rankResults rejects locked files — membership, not the isLocked flag", () => {
  // slskd never assigns isLocked, so it arrives false even for locked files.
  const locked = file({ filename: "a\\locked.mp3", isLocked: false });
  const out = plugin._rankResults([response({ files: [], lockedFiles: [locked] })], {});
  assert.equal(out.length, 0);
});

test("rankResults rejects zero-size files and non-audio extensions", () => {
  const out = plugin._rankResults([
    response({ files: [file({ filename: "a\\empty.mp3", size: 0 })] }),
    response({ username: "b", files: [file({ filename: "a\\cover.jpg", extension: "jpg" })] }),
    response({ username: "c", files: [file({ filename: "a\\notes.nfo", extension: "nfo" })] })
  ], {});
  assert.equal(out.length, 0);
});

test("rankResults rejects files whose duration is far from a known duration", () => {
  const responses = [response({
    files: [
      file({ filename: "a\\right.mp3", length: 210 }),
      file({ filename: "a\\wrong.mp3", length: 400 })
    ]
  })];
  const out = plugin._rankResults(responses, { knownDurationSecs: 208 });
  assert.equal(out.length, 1);
  assert.equal(out[0].filename, "a\\right.mp3");
});

test("rankResults keeps files with an unknown duration even when a duration is known", () => {
  const out = plugin._rankResults(
    [response({ files: [file({ filename: "a\\x.mp3", length: null })] })],
    { knownDurationSecs: 100 }
  );
  assert.equal(out.length, 1);
});

test("rankResults dedupes on (username, filename)", () => {
  const f = file({ filename: "a\\dupe.mp3" });
  const out = plugin._rankResults([
    response({ files: [f] }),
    response({ files: [f] })
  ], {});
  assert.equal(out.length, 1);
});

test("rankResults drops whole responses over maxQueue", () => {
  const out = plugin._rankResults(
    [response({ queueLength: 50, hasFreeUploadSlot: false, files: [file()] })],
    { maxQueue: 10 }
  );
  assert.equal(out.length, 0);
});

// --- ordering --------------------------------------------------------------

test("quality beats availability ACROSS tiers", () => {
  const flacSlow = response({
    username: "slow", hasFreeUploadSlot: false, queueLength: 40, uploadSpeed: 1000,
    files: [file({ filename: "a\\song.flac", extension: "flac", bitRate: null })]
  });
  const mp3Fast = response({
    username: "fast", hasFreeUploadSlot: true, uploadSpeed: 9000000,
    files: [file({ filename: "b\\song.mp3", bitRate: 128 })]
  });
  const out = plugin._rankResults([mp3Fast, flacSlow], {});
  assert.equal(out[0].username, "slow", "an instantly-available 128kbps must not beat FLAC");
});

test("availability breaks ties WITHIN a quality tier", () => {
  // 320 and 256 are both `high`, so availability decides.
  const a = response({
    username: "queued", hasFreeUploadSlot: false, queueLength: 30, uploadSpeed: 9000000,
    files: [file({ filename: "a\\s.mp3", bitRate: 320 })]
  });
  const b = response({
    username: "free", hasFreeUploadSlot: true, uploadSpeed: 100,
    files: [file({ filename: "b\\s.mp3", bitRate: 256 })]
  });
  const out = plugin._rankResults([a, b], {});
  assert.equal(out[0].username, "free");
});

test("upload speed breaks ties within the same quality and availability tier", () => {
  const slow = response({ username: "slow", uploadSpeed: 1000, files: [file({ filename: "a\\s.mp3" })] });
  const fast = response({ username: "fast", uploadSpeed: 8000000, files: [file({ filename: "b\\s.mp3" })] });
  const out = plugin._rankResults([slow, fast], {});
  assert.equal(out[0].username, "fast");
});

test("preferredFormats outranks quality tier", () => {
  const flac = response({ username: "f", files: [file({ filename: "a\\s.flac", extension: "flac", bitRate: null })] });
  const mp3 = response({ username: "m", files: [file({ filename: "b\\s.mp3", bitRate: 320 })] });
  const out = plugin._rankResults([flac, mp3], { preferredFormats: ["mp3", "flac"] });
  assert.equal(out[0].extension, "mp3", "an explicit format preference must win");

  const dflt = plugin._rankResults([flac, mp3], {});
  assert.equal(dflt[0].extension, "flac", "without a preference, quality leads");
});

test("formats outside preferredFormats sort after those inside it", () => {
  const ogg = response({ username: "o", files: [file({ filename: "a\\s.ogg", extension: "ogg", bitRate: 320 })] });
  const mp3 = response({ username: "m", files: [file({ filename: "b\\s.mp3", bitRate: 128 })] });
  const out = plugin._rankResults([ogg, mp3], { preferredFormats: ["mp3"] });
  assert.equal(out[0].extension, "mp3");
});

test("fully-tied candidates sort stably by username then filename", () => {
  const mk = (u, fn) => response({ username: u, files: [file({ filename: fn })] });
  const input = [mk("zeta", "z\\b.mp3"), mk("alpha", "a\\b.mp3"), mk("alpha", "a\\a.mp3")];
  const first = plugin._rankResults(input, {});
  const second = plugin._rankResults(input.slice().reverse(), {});
  assert.deepEqual(
    first.map((c) => c.username + "/" + c.filename),
    second.map((c) => c.username + "/" + c.filename),
    "ranking must not depend on input order"
  );
  assert.equal(first[0].username, "alpha");
  assert.equal(first[0].filename, "a\\a.mp3");
});

test("rankResults tolerates empty and malformed input", () => {
  assert.deepEqual(plugin._rankResults(null, {}), []);
  assert.deepEqual(plugin._rankResults([], {}), []);
  assert.deepEqual(plugin._rankResults([response({ files: [{}] })], {}), []);
});

// --- grouping --------------------------------------------------------------

test("groupByFolder groups by user + remote folder, preserving rank order", () => {
  const ranked = plugin._rankResults([
    response({
      username: "u1",
      files: [
        file({ filename: "@@x\\Music\\Album A\\01.mp3", size: 100 }),
        file({ filename: "@@x\\Music\\Album A\\02.mp3", size: 200 }),
        file({ filename: "@@x\\Music\\Album B\\01.mp3", size: 300 })
      ]
    })
  ], {});
  const groups = plugin._groupByFolder(ranked);
  assert.equal(groups.length, 2);
  const a = groups.find((g) => g.name === "Album A");
  assert.equal(a.files.length, 2);
  assert.equal(a.totalSize, 300);
  assert.equal(a.username, "u1");
});

test("groupByFolder keeps the same folder from different users separate", () => {
  const ranked = plugin._rankResults([
    response({ username: "u1", files: [file({ filename: "m\\Album\\01.mp3" })] }),
    response({ username: "u2", files: [file({ filename: "m\\Album\\01.mp3" })] })
  ], {});
  assert.equal(plugin._groupByFolder(ranked).length, 2);
});

// --- resultLabel / resultSource --------------------------------------------
// The title is the filename and nothing else; who has it and where lives on the
// second line. Everyone on Soulseek shares the same album, so a column of bare
// basenames reads as one track repeated 40 times — the sharer and the folder
// are what tell the rows apart.

test("resultLabel is the filename alone", () => {
  assert.equal(
    plugin._resultLabel({
      username: "ieee802dot11ac",
      filename: "music\\Rage Against The Machine\\Rage Against The Machine\\04. Settle For Nothing.flac"
    }),
    "04. Settle For Nothing.flac"
  );
});

test("resultSource is user · folder, with forward slashes", () => {
  assert.equal(
    plugin._resultSource({
      username: "ieee802dot11ac",
      filename: "music\\Rage Against The Machine\\Rage Against The Machine\\04. Settle For Nothing.flac"
    }),
    "ieee802dot11ac · music/Rage Against The Machine/Rage Against The Machine"
  );
});

test("resultSource shows the WHOLE folder path, not just its last segment", () => {
  assert.equal(
    plugin._resultSource({ username: "u", filename: "Discography\\1992 - Album\\01.mp3" }),
    "u · Discography/1992 - Album"
  );
});

test("resultSource is just the user for a file shared at the root", () => {
  assert.equal(plugin._resultSource({ username: "u", filename: "01.mp3" }), "u");
});

test("resultSource is just the folder when there is no user", () => {
  assert.equal(plugin._resultSource({ username: "", filename: "a/b.mp3" }), "a");
});

test("the label helpers are null-safe", () => {
  assert.equal(plugin._resultLabel(null), "");
  assert.equal(plugin._resultSource(null), "");
});

// --- resultCells -----------------------------------------------------------
// A cell the sharer never reported must be ABSENT, not "0" or "": the host
// renders a missing cell as an em dash, which reads as unknown. Soulseek
// clients routinely report no bitrate and no duration at all — 1,316 of 8,666
// files in one measured search carried no length.

test("resultCells fills every column when the sharer reported everything", () => {
  const cells = plugin._resultCells({
    extension: "flac", qualityTier: 0, sampleRate: 44100, bitDepth: 16,
    size: 31354797, length: 288, hasFreeUploadSlot: true, queueLength: 0
  });
  assert.equal(cells.quality, "FLAC 44kHz/16bit");
  assert.equal(cells.size, "30 MB");
  assert.equal(cells.duration, "4:48");
  assert.equal(cells.availability, "free slot");
});

test("resultCells omits duration and quality a client never reported", () => {
  const cells = plugin._resultCells({
    extension: "", qualityTier: 2, size: 100, length: null, queueLength: 3
  });
  assert.equal("duration" in cells, false);
  assert.equal("quality" in cells, false);
  assert.equal(cells.availability, "queue 3");
});

test("the columns are declared with labels and widths", () => {
  const ids = plugin._RESULT_COLUMNS.map((c) => c.id);
  assert.deepEqual(ids, ["quality", "size", "duration", "availability"]);
  for (const col of plugin._RESULT_COLUMNS) {
    assert.ok(col.label, "every column needs a header — columns without one are unreadable");
    assert.ok(col.width > 0);
  }
});

// --- result caps -----------------------------------------------------------
// A broad query returns 20k+ files across 16k+ folders; rendering all of them is
// unusable and slow. The list is ranked best-first, so the cap only drops a tail
// nobody would scroll to.

test("the file cap is 1000", () => {
  assert.equal(plugin._MAX_RESULT_FILES, 1000);
  assert.equal(plugin._MAX_RESULT_FOLDERS, 1000);
});

test("capping keeps the BEST results — ranking runs before the slice", () => {
  const responses = [];
  for (let i = 0; i < 1200; i++) {
    responses.push({
      username: "u" + i,
      hasFreeUploadSlot: i === 1199, // the very last response is the best one
      queueLength: i === 1199 ? 0 : 50,
      uploadSpeed: 1,
      files: [{ filename: "f\\" + i + ".flac", size: 100, length: 200 }]
    });
  }
  const ranked = plugin._rankResults(responses, {});
  assert.equal(ranked.length, 1200);
  assert.equal(ranked[0].username, "u1199");
  // What runSearch stores is the head of that ranking.
  const shown = ranked.slice(0, plugin._MAX_RESULT_FILES);
  assert.equal(shown.length, 1000);
  assert.equal(shown[0].username, "u1199");
});

test("folders are grouped from the FULL list, so a kept folder keeps every file", () => {
  const files = [];
  for (let i = 0; i < 1100; i++) files.push({ filename: "Album\\" + i + ".flac", size: 100, length: 200 });
  const ranked = plugin._rankResults([{ username: "u", files, queueLength: 0, uploadSpeed: 1 }], {});
  const folders = plugin._groupByFolder(ranked);
  assert.equal(folders.length, 1);
  // Grouping before the slice is what keeps this at 1100 rather than 1000 —
  // downloading the folder must not silently grab part of the album.
  assert.equal(folders[0].files.length, 1100);
});

// --- formatCount -----------------------------------------------------------
// toLocaleString is absent from the plugin sandbox.

test("formatCount groups thousands", () => {
  assert.equal(plugin._formatCount(0), "0");
  assert.equal(plugin._formatCount(999), "999");
  assert.equal(plugin._formatCount(1000), "1,000");
  assert.equal(plugin._formatCount(20431), "20,431");
  assert.equal(plugin._formatCount(1234567), "1,234,567");
});

// --- sortCandidates --------------------------------------------------------
// The host renders `items` in the order given and only reports the header
// click, so the plugin sorts — on the raw numbers, since the host never sees
// anything but the formatted strings. "desc" means BEST first on every column,
// which on Quality and Availability is the opposite of the raw tier number.

const CANDS = [
  { id: "lossless-slow", qualityTier: 0, bitRate: null, size: 30000000, length: 288, availabilityTier: 2, queueLength: 40, uploadSpeed: 100 },
  { id: "mp3-free", qualityTier: 1, bitRate: 320, size: 9000000, length: 240, availabilityTier: 0, queueLength: 0, uploadSpeed: 900 },
  { id: "mp3-low", qualityTier: 3, bitRate: 128, size: 4000000, length: null, availabilityTier: 1, queueLength: 3, uploadSpeed: 500 }
];
const order = (col, dir) => plugin._sortCandidates(CANDS, col, dir).map((c) => c.id);

test("quality desc puts lossless first, asc reverses it", () => {
  assert.deepEqual(order("quality", "desc"), ["lossless-slow", "mp3-free", "mp3-low"]);
  assert.deepEqual(order("quality", "asc"), ["mp3-low", "mp3-free", "lossless-slow"]);
});

test("availability desc puts a free slot first, not the longest queue", () => {
  assert.deepEqual(order("availability", "desc"), ["mp3-free", "mp3-low", "lossless-slow"]);
});

test("size sorts by bytes, both ways", () => {
  assert.deepEqual(order("size", "desc"), ["lossless-slow", "mp3-free", "mp3-low"]);
  assert.deepEqual(order("size", "asc"), ["mp3-low", "mp3-free", "lossless-slow"]);
});

test("a candidate with no duration sinks to the bottom in BOTH directions", () => {
  // Flipping the arrow must not float a wall of em dashes to the top: unknown
  // is not zero. 1,316 of 8,666 files in one measured search had no length.
  assert.equal(order("duration", "desc").pop(), "mp3-low");
  assert.equal(order("duration", "asc").pop(), "mp3-low");
  assert.deepEqual(order("duration", "asc").slice(0, 2), ["mp3-free", "lossless-slow"]);
});

test("sortCandidates does not mutate the ranked list", () => {
  const before = CANDS.map((c) => c.id);
  plugin._sortCandidates(CANDS, "size", "asc");
  assert.deepEqual(CANDS.map((c) => c.id), before);
});

test("an unknown column leaves the order alone", () => {
  assert.equal(plugin._sortCandidates(CANDS, "artist", "desc"), CANDS);
});

test("every sortable column has a comparator, and vice versa", () => {
  for (const col of plugin._RESULT_COLUMNS) {
    if (col.sortable) {
      assert.notEqual(plugin._sortCandidates(CANDS, col.id, "desc"), CANDS, col.id + " sorts");
    }
  }
});
