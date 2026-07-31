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
