const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

// --- remote path helpers ---------------------------------------------------
// Soulseek paths are Windows-style and backslash-separated.

test("basenameRemote / dirnameRemote handle backslashes and slashes", () => {
  assert.equal(plugin._basenameRemote("@@abc\\Music\\Album\\01.mp3"), "01.mp3");
  assert.equal(plugin._dirnameRemote("@@abc\\Music\\Album\\01.mp3"), "@@abc\\Music\\Album");
  assert.equal(plugin._basenameRemote("a/b/c.mp3"), "c.mp3");
  assert.equal(plugin._basenameRemote("bare.mp3"), "bare.mp3");
  assert.equal(plugin._dirnameRemote("bare.mp3"), "");
});

test("extOf lowercases and tolerates no extension", () => {
  assert.equal(plugin._extOf("a\\b.FLAC"), "flac");
  assert.equal(plugin._extOf("a\\b"), "");
  assert.equal(plugin._extOf("a.b.mp3"), "mp3");
});

// --- parseTrackMeta --------------------------------------------------------

test("parseTrackMeta reads 'NN - Artist - Title'", () => {
  const m = plugin._parseTrackMeta("@@x\\Music\\Radiohead - OK Computer\\03 - Radiohead - Karma Police.flac");
  assert.equal(m.trackNumber, 3);
  assert.equal(m.artist, "Radiohead");
  assert.equal(m.title, "Karma Police");
  assert.equal(m.album, "OK Computer");
});

test("parseTrackMeta reads 'NN. Title' and takes the artist from the folder", () => {
  const m = plugin._parseTrackMeta("@@x\\Bjork - Homogenic (1997)\\05. Joga.mp3");
  assert.equal(m.trackNumber, 5);
  assert.equal(m.title, "Joga");
  assert.equal(m.artist, "Bjork");
  assert.equal(m.album, "Homogenic", "a trailing (year) is stripped from the album");
});

test("parseTrackMeta handles en-dash and em-dash separators", () => {
  assert.equal(plugin._parseTrackMeta("d\\Björk – Jóga.mp3").artist, "Björk");
  assert.equal(plugin._parseTrackMeta("d\\A — B.mp3").title, "B");
});

test("parseTrackMeta falls back to the bare stem with no separator", () => {
  const m = plugin._parseTrackMeta("Some Song.mp3");
  assert.equal(m.title, "Some Song");
  assert.equal(m.artist, null);
  assert.equal(m.album, null);
});

test("parseTrackMeta converts underscores and collapses whitespace", () => {
  const m = plugin._parseTrackMeta("d\\Artist_-_Some__Title.mp3");
  assert.equal(m.title, "Some Title");
});

test("parseTrackMeta keeps a hyphenated title intact", () => {
  const m = plugin._parseTrackMeta("d\\Artist - Some - Long - Title.mp3");
  assert.equal(m.artist, "Artist");
  assert.equal(m.title, "Some - Long - Title");
});

test("parseTrackMeta never returns an empty title", () => {
  assert.ok(plugin._parseTrackMeta("d\\.mp3").title.length > 0);
});

// --- context-menu target ---------------------------------------------------
// PluginContextMenuTarget carries different fields per kind; reading `title`
// alone would produce an empty query for artist and album rows.

test("searchQueryForTarget builds a query per target kind", () => {
  assert.equal(
    plugin._searchQueryForTarget({ kind: "track", title: "Karma Police", artistName: "Radiohead" }),
    "Radiohead Karma Police"
  );
  assert.equal(
    plugin._searchQueryForTarget({ kind: "album", albumTitle: "OK Computer", artistName: "Radiohead" }),
    "Radiohead OK Computer"
  );
  assert.equal(
    plugin._searchQueryForTarget({ kind: "artist", artistName: "Radiohead" }),
    "Radiohead"
  );
});

test("searchQueryForTarget copes with missing fields", () => {
  assert.equal(plugin._searchQueryForTarget({ kind: "track", title: "Solo" }), "Solo");
  assert.equal(plugin._searchQueryForTarget({ kind: "artist", title: "From Title" }), "From Title");
  assert.equal(plugin._searchQueryForTarget({}), "");
  assert.equal(plugin._searchQueryForTarget(null), "");
});

// --- tier detection --------------------------------------------------------

test("hostOf extracts the host from a variety of URLs", () => {
  assert.equal(plugin._hostOf("http://localhost:5030"), "localhost");
  assert.equal(plugin._hostOf("https://nas.local:5031/"), "nas.local");
  assert.equal(plugin._hostOf("http://user:pw@127.0.0.1:5030"), "127.0.0.1");
  assert.equal(plugin._hostOf("http://[::1]:5030"), "::1");
  assert.equal(plugin._hostOf("not a url"), null);
});

test("detectTier defaults to local only for loopback hosts", () => {
  assert.equal(plugin._detectTier("http://localhost:5030", null), "local");
  assert.equal(plugin._detectTier("http://127.0.0.1:5030", null), "local");
  assert.equal(plugin._detectTier("http://127.1.2.3:5030", null), "local");
  assert.equal(plugin._detectTier("http://[::1]:5030", null), "local");
  assert.equal(plugin._detectTier("http://192.168.1.20:5030", null), "remote");
  assert.equal(plugin._detectTier("https://nas.example.com", null), "remote");
  assert.equal(plugin._detectTier("", null), "remote");
});

test("detectTier honours an explicit override in both directions", () => {
  assert.equal(plugin._detectTier("http://192.168.1.20:5030", "local"), "local");
  assert.equal(plugin._detectTier("http://localhost:5030", "remote"), "remote");
});

// --- formatting ------------------------------------------------------------

test("formatBytes is human readable", () => {
  assert.equal(plugin._formatBytes(512), "512 B");
  assert.equal(plugin._formatBytes(1536), "1.5 KB");
  assert.equal(plugin._formatBytes(8 * 1024 * 1024), "8.0 MB");
  assert.equal(plugin._formatBytes(null), "");
});

test("formatDurationSecs formats minutes and hours", () => {
  assert.equal(plugin._formatDurationSecs(0), "0:00");
  assert.equal(plugin._formatDurationSecs(65), "1:05");
  assert.equal(plugin._formatDurationSecs(3661), "1:01:01");
  assert.equal(plugin._formatDurationSecs(null), "");
});

test("parsePreferredFormats normalises a comma-separated list", () => {
  assert.deepEqual(plugin._parsePreferredFormats(" FLAC , .mp3 "), ["flac", "mp3"]);
  assert.equal(plugin._parsePreferredFormats(""), null);
  assert.equal(plugin._parsePreferredFormats(null), null);
});
