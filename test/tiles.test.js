const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

// The SVG inside a tile's data: URI, decoded.
function svgOf(uri) {
  assert.ok(uri.indexOf("data:image/svg+xml;utf8,") === 0, uri.slice(0, 40));
  return decodeURIComponent(uri.slice("data:image/svg+xml;utf8,".length));
}
function texts(uri) {
  const out = [];
  svgOf(uri).replace(/<text[^>]*>([^<]*)<\/text>/g, (_, t) => out.push(t));
  return out;
}

test("tileTier: hi-res, lossless, high, low, unknown", () => {
  const tier = plugin._tileTier;
  assert.equal(tier({ filename: "a.flac", bitDepth: 24, sampleRate: 96000 }), "hires");
  assert.equal(tier({ filename: "a.flac", bitDepth: 16, sampleRate: 48000 }), "lossless");
  assert.equal(tier({ filename: "a.flac" }), "lossless", "unreported depth counts as CD");
  assert.equal(tier({ filename: "a.mp3", bitRate: 320 }), "high");
  assert.equal(tier({ filename: "a.mp3", bitRate: 200, isVariableBitRate: true }), "high", "V0/V2 count as high");
  assert.equal(tier({ filename: "a.mp3", bitRate: 192 }), "low");
  assert.equal(tier({ filename: "a.ogg" }), "unknown");
});

test("tileDetail: depth/rate for lossless, the bitrate for lossy, nothing when unreported", () => {
  const d = plugin._tileDetail;
  assert.equal(d({ filename: "a.flac", bitDepth: 16, sampleRate: 44100 }), "16/44");
  assert.equal(d({ filename: "a.flac", bitDepth: 24, sampleRate: 96000 }), "24/96");
  assert.equal(d({ filename: "a.flac", sampleRate: 88200 }), "88k");
  assert.equal(d({ filename: "a.flac" }), "");
  assert.equal(d({ filename: "a.mp3", bitRate: 320 }), "320");
  assert.equal(d({ filename: "a.mp3", bitRate: 245, isVariableBitRate: true }), "~245");
  assert.equal(d({ filename: "a.m4a" }), "");
});

test("fileTile: the container in big letters, the detail under it, from a Soulseek path", () => {
  const uri = plugin._fileTile({ filename: "Music\\BoC\\01 - Roygbiv.flac", bitDepth: 16, sampleRate: 44100 });
  assert.deepEqual(texts(uri), ["FLAC", "16/44"]);
  assert.deepEqual(texts(plugin._fileTile({ filename: "x\\y.ogg" })), ["OGG"], "no detail line when nothing is reported");
});

test("formatTile: cached per label/detail/tier, small, and only ever an extension as text", () => {
  const a = plugin._formatTile("FLAC", "16/44", "lossless");
  assert.equal(plugin._formatTile("FLAC", "16/44", "lossless"), a, "same string, not rebuilt");
  assert.ok(a.length < 700, "stays small: it rides every Search render — " + a.length);
  // A hostile "extension" can't inject markup: labels are [A-Z0-9] only.
  const odd = plugin._fileTile({ filename: "a.x<y", extension: "fl<a>c" });
  assert.ok(!/<a>/.test(svgOf(odd)), svgOf(odd));
});

test("folderTile: the main format by bytes, MIX for a real lossless/lossy split", () => {
  const flac = (n) => ({ filename: "d\\" + n + ".flac", size: 30e6, bitDepth: 16, sampleRate: 44100 });
  const mp3 = (n, size) => ({ filename: "d\\" + n + ".mp3", size: size || 8e6, bitRate: 320 });
  assert.deepEqual(texts(plugin._folderTile([flac(1), flac(2), mp3(3, 1e6)])), ["FLAC", "16/44"],
    "a stray small mp3 doesn't make it a mix");
  assert.deepEqual(texts(plugin._folderTile([flac(1), mp3(2, 20e6), mp3(3, 20e6)])), ["MIX"]);
  assert.deepEqual(texts(plugin._folderTile([mp3(1), mp3(2)])), ["MP3", "320"]);
  assert.deepEqual(texts(plugin._folderTile([])), ["?"]);
});

test("transferTile: the advertised quality kept on the tracked record, else the container alone", () => {
  const t = { filename: "m\\a\\01 - x.flac" };
  assert.deepEqual(texts(plugin._transferTile(t, { quality: { bitDepth: 24, sampleRate: 96000 } })), ["FLAC", "24/96"]);
  assert.deepEqual(texts(plugin._transferTile(t, null)), ["FLAC"]);
});
