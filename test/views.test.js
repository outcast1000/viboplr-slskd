const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { fakeHost } = require("./harness/host");

// --- the view layout from the 2026-10 UX review ------------------------------
// One home per job: Search (recent searches, a results toolbar), Downloads
// grouped by state, Upgrades with its own target, the whole playback fallback
// on its tab, and Settings reduced to a status checklist + connection.

const plugin = loadPlugin();

function findNodes(node, pred, out) {
  out = out || [];
  if (!node || typeof node !== "object") return out;
  if (pred(node)) out.push(node);
  (node.children || []).forEach((c) => findNodes(c, pred, out));
  return out;
}
function lastView(h) {
  const views = h.calls.views.filter((v) => v.viewId === "slskd-browse");
  return views[views.length - 1].data;
}

// --- pure helpers ---------------------------------------------------------

test("transferGroup: problems first, then moving, waiting, finished, cancelled", () => {
  const g = (state) => plugin._transferGroup({ state });
  assert.equal(g("Completed, Errored"), "attention");
  assert.equal(g("Completed, Rejected"), "attention");
  assert.equal(g("InProgress"), "active");
  assert.equal(g("Initializing"), "active");
  assert.equal(g("Queued, Remotely"), "waiting");
  assert.equal(g("Requested"), "waiting");
  assert.equal(g("Completed, Succeeded"), "finished");
  assert.equal(g("Completed, Cancelled"), "cancelled");
});

test("plainTransferError: slskd's text in a user's words, unknown text kept", () => {
  const p = plugin._plainTransferError;
  assert.equal(p("Transfer rejected: File not shared.", "peer"), "peer no longer shares this file");
  assert.equal(p("Too many files", "peer"), "peer's queue is full");
  assert.equal(p("Failed to connect: Connection refused", "peer"), "peer went offline or can't be reached");
  assert.equal(p("Transfer timed out", "peer"), "peer went offline or can't be reached");
  assert.equal(p("Something new and odd", "peer"), "Something new and odd");
  assert.equal(p(null, "peer"), "the transfer stopped");
});

test("waitedFor: minutes, hours, days — nothing under a minute or without a timestamp", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const w = (iso) => plugin._waitedFor({ enqueuedAt: iso }, now);
  assert.equal(w("2026-10-06T11:46:00Z"), "waiting 14 min");
  assert.equal(w("2026-10-06T09:00:00Z"), "waiting 3 h");
  assert.equal(w("2026-10-03T12:00:00Z"), "waiting 3 d");
  assert.equal(w("2026-10-06T11:59:40Z"), "");
  assert.equal(plugin._waitedFor({ requestedAt: "2026-10-06T11:50:00Z" }, now), "waiting 10 min", "requestedAt when not enqueued yet");
  assert.equal(plugin._waitedFor({}, now), "");
});

test("transfersSummary: counts, bytes, speed and where files land, in one line", () => {
  const s = plugin._transfersSummary({
    active: [{ bytesTransferred: 5e6, size: 10e6, averageSpeed: 1e6 }, { bytesTransferred: 1e6, size: 4e6, averageSpeed: 5e5 }],
    waiting: [{}], attention: [], finished: [], cancelled: []
  }, "Music");
  assert.equal(s.done, 6e6);
  assert.equal(s.total, 14e6);
  assert.match(s.label, /^2 downloading · 1 waiting · .+ of .+ · ↓ .+ · lands in “Music”$/);
});

test("withRecentSearch: newest first, no case-duplicates, capped", () => {
  const w = plugin._withRecentSearch;
  assert.deepEqual(w(["b", "c"], "a", 6), ["a", "b", "c"]);
  assert.deepEqual(w(["Burial Untrue", "x"], "burial untrue", 6), ["burial untrue", "x"], "re-searching moves it up");
  assert.deepEqual(w(["1", "2", "3"], "0", 3), ["0", "1", "2"]);
  assert.deepEqual(w(["a"], "  ", 6), ["a"], "blank isn't remembered");
});

test("folderSubtitle: sharer, tracks, size and whether they'll send it", () => {
  assert.equal(plugin._folderSubtitle({ username: "vinylgh0st", files: [{}, {}], totalSize: 60e6, hasFreeUploadSlot: true }),
    "vinylgh0st · 2 tracks · 57 MB · free slot");
  assert.equal(plugin._folderSubtitle({ username: "u", files: [{}], totalSize: 1e6, hasFreeUploadSlot: false, queueLength: 12 }),
    "u · 1 track · 977 KB · queue 12");
});

test("resolveStats: played counts kept copies; the median is over fresh fetches only", () => {
  const s = plugin._resolveStats([
    { outcome: "played", ms: 10000 }, { outcome: "played", ms: 20000 }, { outcome: "played", ms: 14000 },
    { outcome: "cached", ms: 50 }, { outcome: "failed", ms: 55000 }, { outcome: "timeout", ms: 55000 }
  ]);
  assert.deepEqual(s, { total: 6, started: 4, medianMs: 14000 });
  assert.deepEqual(plugin._resolveStats([]), { total: 0, started: 0, medianMs: null });
});

test("historyEntry / withResolve / historyLine: a small record per resolve, newest first, capped", () => {
  const rec = { at: 1000, title: "Windowlicker", artist: "Aphex Twin", outcome: "played", totalMs: 14600, message: null,
    chosen: { username: "kaltwasser", filename: "m\\Aphex\\Windowlicker.mp3", extension: "mp3", bitRate: 320, qualityTier: 1 } };
  const e = plugin._historyEntry(rec);
  assert.deepEqual(e.file, { name: "Windowlicker.mp3", user: "kaltwasser", quality: "MP3 320kbps" });
  assert.ok(!("candidates" in e) && !("steps" in e), "no candidate lists or steps kept");
  const list = plugin._withResolve([{ n: 1 }, { n: 2 }], e, 2);
  assert.equal(list.length, 2);
  assert.equal(list[0], e);
  assert.equal(plugin._historyLine(e, 1000 + 3 * 3600e3),
    "✓ “Windowlicker” — Aphex Twin  ·  Played  ·  14.6 s  ·  MP3 320kbps from kaltwasser  ·  3 h ago");
  assert.match(plugin._historyLine({ at: 0, title: "X", outcome: "no-match", ms: 20000, message: "nothing matched" }, 60000), /^✗ “X”  ·  Nothing matched  ·  20 s  ·  nothing matched  ·  1 min ago$/);
});

test("upgradeStepper: ✓ done, ● now, ○ to come; null off the road", () => {
  assert.equal(plugin._upgradeStepper("searching"), "● Search   ─   ○ Download   ─   ○ Check   ─   ○ Replace");
  assert.equal(plugin._upgradeStepper("downloading", 0.42), "✓ Search   ─   ● Download 42%   ─   ○ Check   ─   ○ Replace");
  assert.equal(plugin._upgradeStepper("ready"), "✓ Search   ─   ✓ Download   ─   ✓ Check   ─   ● Replace");
  assert.equal(plugin._upgradeStepper("none"), null);
  assert.equal(plugin._upgradeStepper("cancelled"), null);
});

test("statusChecklist: connected, sharing, reaching the library — the fix on the row that needs it", () => {
  const rd = { username: "me", version: "0.26.0", shareCount: 0 };
  const cfg = { url: "http://localhost:5030" };
  const rows = (r, tierNow, col, share) => plugin._statusChecklist(r, cfg, tierNow, col, share, "").children;

  let r = rows(rd, "local", null, "slskd");
  assert.equal(r[0].label, "✓ Connected as me");
  assert.equal(r[1].label, "⚠ Not sharing anything");
  assert.equal(r[1].control.action, "open-slskd", "slskd's settings hold the fix");
  assert.equal(r[2].label, "⚠ Downloads stay in slskd's folder");

  r = rows(Object.assign({}, rd, { shareCount: 3 }), "local", { name: "Music" }, "slskd");
  assert.equal(r[1].label, "✓ Sharing 3 folders");
  assert.equal(r[2].label, "✓ Downloads reach your library");
  assert.match(r[2].description, /“Music”/);

  r = rows(rd, "local", null, "roadie");
  assert.ok(!r[1].control, "Roadie's card below carries Share…");
  assert.match(r[1].description, /card below/);

  assert.equal(rows(Object.assign({}, rd, { shareCount: 3 }), "remote", null, "slskd")[2].label, "⚠ slskd is on another computer");
  assert.equal(rows(Object.assign({}, rd, { shareCount: null }), "local", null, "slskd").length, 2, "an unreported share count claims nothing");
});

// --- the views --------------------------------------------------------------

function transfer(username, filename, state, extra) {
  return Object.assign({ username, filename, state, size: 10e6, bytesTransferred: 0, id: username + filename }, extra || {});
}

function downloadsHost(files) {
  const byUser = {};
  for (const f of files) (byUser[f.username] = byUser[f.username] || []).push(f);
  return fakeHost({ responses: {
    "/api/v0/transfers/downloads": Object.keys(byUser).map((u) => ({ username: u, directories: [{ directory: "d", files: byUser[u] }] }))
  } });
}

test("Downloads: grouped by state, problems first, with Retry all / Clear on the group bars", async () => {
  const p = loadPlugin();
  const h = downloadsHost([
    transfer("a", "m\\A\\01 - Done.flac", "Completed, Succeeded"),
    transfer("b", "m\\B\\02 - Waiting.flac", "Queued, Remotely", { placeInQueue: 37 }),
    transfer("c", "m\\C\\03 - Moving.flac", "InProgress", { bytesTransferred: 5e6, averageSpeed: 1e6 }),
    transfer("d", "m\\D\\04 - Broken.flac", "Completed, Rejected", { exception: "File not shared." })
  ]);
  await p.activate(h.api);
  try {
    await p._refreshTransfers();
    h.actions["main-tab"]({ tabId: "transfers" });
    const view = lastView(h);
    const bars = findNodes(view, (n) => n.type === "toolbar").map((n) => n.title);
    assert.deepEqual(bars, ["Needs attention", "Downloading", "Waiting", "Finished"]);
    const lists = findNodes(view, (n) => n.type === "track-row-list");
    assert.deepEqual(lists.map((l) => l.items.map((i) => i.title)), [["Broken"], ["Moving"], ["Waiting"], ["Done"]]);
    assert.match(lists[0].items[0].subtitle, /^Failed — d no longer shares this file/);
    assert.deepEqual(lists[0].items[0].actions, ["retry-transfer", "another-source", "remove-transfer"]);
    assert.deepEqual(lists[2].items[0].actions, ["another-source", "cancel-transfer"], "a remote queue can be left");

    const attention = findNodes(view, (n) => n.type === "toolbar" && n.title === "Needs attention")[0];
    assert.equal(attention.buttons[0].label, "Retry all");
    assert.deepEqual(attention.buttons[0].data.selectedIds, [lists[0].items[0].id]);
    const finished = findNodes(view, (n) => n.type === "toolbar" && n.title === "Finished")[0];
    assert.equal(finished.buttons[0].label, "Clear");

    // "Remove" said nothing about the file; the label now does.
    const removeLabel = lists[3].actions.filter((a) => a.id === "remove-transfer")[0];
    assert.equal(removeLabel.label, "Clear from list");
    assert.notEqual(removeLabel.icon, "🗑", "the bin is for Delete file");

    const bar = findNodes(view, (n) => n.type === "progress-bar")[0];
    assert.match(bar.label, /^1 downloading · 1 waiting/);
  } finally {
    p.deactivate();
  }
});

test("Search: recent searches are remembered and offered under the box; the results bar replaces the second tab row", async () => {
  const p = loadPlugin();
  let polls = 0;
  const h = fakeHost({ fetch: async (url, init) => {
    const json = (v) => ({ status: 200, text: async () => JSON.stringify(v) });
    if (url.includes("/api/v0/searches") && init && init.method === "POST") return json({ id: "s1" });
    if (url.includes("/responses")) return json([{ username: "peer", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1, files: [
      { filename: "m\\OKC\\01 - Airbag.flac", size: 30e6, length: 284, bitDepth: 16, sampleRate: 44100 }] }]);
    if (url.includes("/api/v0/searches/s1")) { polls++; return json({ id: "s1", state: polls >= 2 ? "Completed" : "InProgress", responseCount: 1, fileCount: 1 }); }
    return undefined;
  } });
  await p.activate(h.api);
  try {
    await h.actions["search"]({ query: "radiohead ok computer" });
    const until = Date.now() + 8000;
    while (Date.now() < until && !findNodes(lastView(h), (n) => n.type === "track-row-list").length) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(h.store.recentSearches, ["radiohead ok computer"]);

    let view = lastView(h);
    assert.equal(findNodes(view, (n) => n.type === "tabs" && n.action === "result-mode").length, 0, "no second tab bar");
    const bar = findNodes(view, (n) => n.type === "toolbar" && n.title === "1 folder · 1 file")[0];
    assert.ok(bar, "the results bar");
    assert.deepEqual(bar.buttons.map((b) => [b.label, b.variant]), [["Files", "accent"], ["Folders", "secondary"]]);
    assert.equal(bar.status, "from 1 sharer");
    const recent = findNodes(view, (n) => n.type === "button" && n.action === "recent-search");
    assert.deepEqual(recent.map((b) => b.data.query), ["radiohead ok computer"]);

    h.actions["sort-results"]({ column: "size", direction: "desc" });
    view = lastView(h);
    const sorted = findNodes(view, (n) => n.type === "toolbar" && /folder/.test(n.title || ""))[0];
    assert.equal(sorted.status, "sorted by Size");
    assert.ok(sorted.buttons.some((b) => b.action === "sort-best"), "the way back to the ranking");

    h.actions["recent-search-clear"]();
    assert.deepEqual(h.store.recentSearches, []);
  } finally {
    p.deactivate();
  }
});

test("Settings: a status checklist, and the upgrade / fallback / library / sharing sections are gone", async () => {
  const p = loadPlugin();
  const h = fakeHost({});
  await p.activate(h.api);
  try {
    h.actions["main-tab"]({ tabId: "settings" });
    const titles = findNodes(lastView(h), (n) => n.type === "section").map((n) => n.title);
    assert.equal(titles[0], "Status");
    for (const gone of ["Upgrades", "Playback fallback", "Library", "Sharing"]) assert.ok(!titles.includes(gone), gone + " moved out: " + titles.join(", "));
    const status = findNodes(lastView(h), (n) => n.type === "section" && n.title === "Status")[0];
    assert.equal(status.children[0].label, "✓ Connected as me");
    assert.equal(status.children[1].label, "✓ Sharing 3 folders");
  } finally {
    p.deactivate();
  }
});

test("Fallback: Delete all asks first, through a confirm node", async () => {
  const p = loadPlugin();
  const h = fakeHost({ store: { fallback: { "song|artist": { ref: "u\u0000x.mp3", state: "kept", size: 5e6, title: "Song", artist: "Artist", at: 1 } } } });
  await p.activate(h.api);
  try {
    h.actions["main-tab"]({ tabId: "fallback" });
    const bar = findNodes(lastView(h), (n) => n.type === "toolbar" && n.title === "Kept files")[0];
    assert.equal(bar.buttons[0].action, "delete-all-kept-ask", "the button asks; it doesn't delete");
    h.actions["delete-all-kept-ask"]();
    const confirm = findNodes(lastView(h), (n) => n.type === "confirm")[0];
    assert.ok(confirm, "the confirm");
    assert.equal(confirm.confirmAction, "delete-all-kept");
    assert.equal(confirm.confirmVariant, "danger");
    h.actions["delete-all-kept-cancel"]();
    assert.equal(findNodes(lastView(h), (n) => n.type === "confirm").length, 0);
    assert.ok(p._fallbackIndex()["song|artist"], "nothing deleted");
  } finally {
    p.deactivate();
  }
});

// --- row status chips and bars (host track-row-list `badge` / `progress`) ---------

test("transferRowProgress: a bar only while bytes move", () => {
  const p = plugin._transferRowProgress;
  assert.equal(p({ state: "InProgress", size: 100, bytesTransferred: 25 }), 0.25);
  assert.equal(p({ state: "Initializing", size: 100, bytesTransferred: 0 }), 0);
  assert.equal(p({ state: "Queued, Remotely", size: 100, bytesTransferred: 0 }), null, "queued: no bar stuck at 0");
  assert.equal(p({ state: "Completed, Succeeded", size: 100, bytesTransferred: 100 }), null, "finished: the group says so");
});

test("upgradeBadge / upgradeRowProgress: one chip per state; a queued download says Queued", () => {
  const b = (state, t) => plugin._upgradeBadge({ state }, t);
  assert.deepEqual(b("searching"), { label: "Searching", variant: "muted" });
  assert.deepEqual(b("downloading", { state: "Queued, Remotely" }), { label: "Queued", variant: "warning" });
  assert.deepEqual(b("downloading", { state: "InProgress" }), { label: "Downloading", variant: "accent" });
  assert.deepEqual(b("ready"), { label: "Ready", variant: "success" });
  assert.deepEqual(b("alternative"), { label: "Below target", variant: "warning" });
  assert.deepEqual(b("failed"), { label: "Failed", variant: "error" });
  assert.equal(plugin._upgradeBadge(null), null);
  assert.equal(plugin._upgradeRowProgress({ state: "downloading" }, { state: "InProgress", size: 10, bytesTransferred: 5 }), 0.5);
  assert.equal(plugin._upgradeRowProgress({ state: "ready" }, { state: "InProgress", size: 10, bytesTransferred: 5 }), null);
});

test("Downloads rows: a bar on the moving one, an Upgrade chip on a file fetched as one", async () => {
  const p = loadPlugin();
  const key = "c" + "\u0000" + "m\\C\\03 - Moving.flac";
  const h = downloadsHost([
    transfer("c", "m\\C\\03 - Moving.flac", "InProgress", { bytesTransferred: 5e6 }),
    transfer("b", "m\\B\\02 - Waiting.flac", "Queued, Remotely")
  ]);
  h.store.tracked = { [key]: { upgrade: { trackId: 42 }, meta: {} } };
  await p.activate(h.api);
  try {
    await p._refreshTransfers();
    h.actions["main-tab"]({ tabId: "transfers" });
    const lists = findNodes(lastView(h), (n) => n.type === "track-row-list");
    const moving = lists[0].items[0];
    assert.equal(moving.progress, 0.5);
    assert.deepEqual(moving.badge, { label: "Upgrade", variant: "accent" });
    const waiting = lists[1].items[0];
    assert.equal(waiting.progress, null);
    assert.equal(waiting.badge, undefined, "the group title already says Waiting");
  } finally {
    p.deactivate();
  }
});
