"use strict";
// 0.31: the Downloads tab's History line (what every download came to) and the
// Fallback tab's description and delete rules — the pure halves. The job-side
// recording is exercised end to end in jobs.test.js.
const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

const job = (o) => Object.assign({ kind: "get", title: "Lucky", artist: "Radiohead", album: "OK Computer", durationSecs: 264 }, o || {});

test("jobHistoryEntry: a save names the file, the sharer and where it went; a failure its reason", () => {
  const saved = plugin._jobHistoryEntry(job({ active: { username: "a" }, file: { quality: { extension: "flac", bitDepth: 16, sampleRate: 44100 } } }),
    "saved", 1000, 1, { trackId: 99, path: "/m/Lucky.flac", collectionName: "Music" });
  assert.equal(saved.id, "h1000-1");
  assert.match(saved.line, /^FLAC.* from a · in Music$/, saved.line);
  assert.deepEqual([saved.trackId, saved.path, saved.upgradeOf], [99, "/m/Lucky.flac", null]);

  const failed = plugin._jobHistoryEntry(job({ message: "a refused the download" }), "failed", 2000, 2, null);
  assert.equal(failed.line, "a refused the download");
  assert.deepEqual([failed.trackId, failed.path], [null, null], "nothing to play");

  const replaced = plugin._jobHistoryEntry(job({ kind: undefined, trackId: 42, currentLabel: "MP3 ≈128kbps",
    file: { quality: { extension: "flac", bitDepth: 16, sampleRate: 44100 } } }), "replaced", 3000, 3, null);
  assert.match(replaced.line, /^MP3 ≈128kbps → FLAC/, "before → after: " + replaced.line);
  assert.deepEqual([replaced.trackId, replaced.upgradeOf], [42, 42], "Play the row it replaced; Download again upgrades it");
});

test("withJobHistory keeps the newest first and caps the list", () => {
  let list = [];
  for (let i = 0; i < plugin._JOB_HISTORY_MAX + 5; i++) list = plugin._withJobHistory(list, { id: "h" + i }, plugin._JOB_HISTORY_MAX);
  assert.equal(list.length, plugin._JOB_HISTORY_MAX);
  assert.equal(list[0].id, "h" + (plugin._JOB_HISTORY_MAX + 4));
});

test("jobHistorySummary counts the endings, leaving out zeros and the uncounted", () => {
  const e = (outcome) => ({ outcome });
  assert.equal(plugin._jobHistorySummary([e("saved"), e("saved"), e("replaced"), e("failed"), e("none"), e("cancelled"), e("gone")]),
    "2 saved · 1 replaced · 2 failed · 1 cancelled", "nothing found counts as failed; gone isn't counted");
  assert.equal(plugin._jobHistorySummary([e("gone")]), "1 entry", "never an empty line");
});

test("jobHistoryRows: Play only for what left a song, Download again for what didn't work out", () => {
  const rows = plugin._jobHistoryRows([
    { id: "a", outcome: "saved", title: "Lucky", artist: "Radiohead", line: "FLAC from a", at: 0, path: "/m/x.flac" },
    { id: "b", outcome: "saved", title: "Lost", artist: null, line: "Saved to your library", at: 0 },
    { id: "c", outcome: "none", title: "Glory Box", artist: "Portishead", line: "Nothing matched", at: 0 },
    { id: "d", outcome: "gone", title: "Old", artist: null, line: "No longer in your library", at: 0 }
  ], 60000);
  assert.deepEqual(rows.map((r) => r.actions), [
    ["history-play", "history-remove"],
    ["history-remove"],
    ["history-again", "history-remove"],
    ["history-remove"]
  ], "a save with nothing to play offers no Play; gone offers only removal");
  assert.equal(rows[2].badge.label, "Nothing found");
  assert.equal(rows[0].subtitle, "Radiohead  ·  FLAC from a  ·  1 min ago");
});

test("seedJobHistory starts History from an older version's replaced / gone upgrades, newest first", () => {
  const seeded = plugin._seedJobHistory({
    t1: { trackId: 1, title: "One", state: "replaced", updatedAt: 1000, currentLabel: "MP3" },
    t2: { trackId: 2, title: "Two", state: "gone", updatedAt: 3000, message: "No longer in your library" },
    t3: { trackId: 3, title: "Three", state: "none", updatedAt: 2000 }
  });
  assert.deepEqual(seeded.map((h) => [h.title, h.outcome]), [["Two", "gone"], ["One", "replaced"]],
    "only what the old Finished line listed");
});

test("fallbackIntroNode says what the tab is, and whether cleanup runs", () => {
  const text = (n) => n.children.map((c) => c.content).join(" ");
  assert.match(text(plugin._fallbackIntroNode(true)), /^When a song can't play from anywhere else.*cleaned up automatically/);
  assert.match(text(plugin._fallbackIntroNode(false)), /Automatic cleanup is off — set limits in Settings → Playback fallback/,
    "off by default, and then it says so instead of promising a cleanup");
});

test("deletableKeptKeys leaves songs in your library alone", () => {
  const index = { a: { ref: "ra", state: "kept" }, b: { ref: "rb", state: "kept" }, c: { ref: "rc", state: "downloading" } };
  const status = { a: { ref: "ra", inLibrary: true }, b: { ref: "rb", inLibrary: false } };
  assert.deepEqual(plugin._deletableKeptKeys(index, status), ["b", "c"], "a is the library's; c still downloading can go");
  assert.deepEqual(plugin._deletableKeptKeys(index, { a: { ref: "stale", inLibrary: true } }), ["a", "b", "c"],
    "a status about an older copy of the song doesn't count");
});
