const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { fakeHost } = require("./harness/host");

// --- the view layout from the 2026-10 UX review ------------------------------
// One home per job: Search (recent searches, a results toolbar), Downloads
// (every download a job, Search's included), the whole playback fallback on
// its tab, and Settings reduced to a status checklist + connection.

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

test("historyEntry / withResolve: a small record per resolve, newest first, capped", () => {
  const rec = { at: 1000, title: "Windowlicker", artist: "Aphex Twin", outcome: "played", totalMs: 14600, message: null,
    chosen: { username: "kaltwasser", filename: "m\\Aphex\\Windowlicker.mp3", extension: "mp3", bitRate: 320, qualityTier: 1 } };
  const e = plugin._historyEntry(rec);
  assert.deepEqual(e.file, { name: "Windowlicker.mp3", user: "kaltwasser", quality: "MP3 320kbps" });
  assert.ok(!("candidates" in e) && !("steps" in e), "no candidate lists or steps kept");
  const list = plugin._withResolve([{ n: 1 }, { n: 2 }], e, 2);
  assert.equal(list.length, 2);
  assert.equal(list[0], e);
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

  r = rows(rd, "local", null, "managed");
  assert.ok(!r[1].control, "the installed slskd's card below carries Share…");
  assert.match(r[1].description, /card below/);

  assert.equal(rows(Object.assign({}, rd, { shareCount: 3 }), "remote", null, "slskd")[2].label, "⚠ slskd is on another computer");
  assert.equal(rows(Object.assign({}, rd, { shareCount: null }), "local", null, "slskd").length, 2, "an unreported share count claims nothing");
});

// --- the views --------------------------------------------------------------

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

test("Settings: a status checklist, then Connection, Downloads (Look for first) and Playback fallback", async () => {
  const p = loadPlugin();
  const h = fakeHost({});
  await p.activate(h.api);
  try {
    h.actions["main-tab"]({ tabId: "settings" });
    const titles = findNodes(lastView(h), (n) => n.type === "section").map((n) => n.title);
    assert.equal(titles[0], "Status");
    for (const gone of ["Upgrades", "Library", "Sharing"]) assert.ok(!titles.includes(gone), gone + " moved out: " + titles.join(", "));
    assert.ok(titles.indexOf("Downloads") >= 0 && titles.indexOf("Playback fallback") > titles.indexOf("Downloads"), titles.join(", "));
    const downloads = findNodes(lastView(h), (n) => n.type === "section" && n.title === "Downloads")[0];
    assert.equal(downloads.children[0].label, "Look for");
    const fb = findNodes(lastView(h), (n) => n.type === "section" && n.title === "Playback fallback")[0];
    assert.deepEqual(fb.children.filter((c) => c.label).map((c) => c.label), ["Quality", "Sharers", "Keep at most", "Delete if not played for"]);
    const status = findNodes(lastView(h), (n) => n.type === "section" && n.title === "Status")[0];
    assert.equal(status.children[0].label, "✓ Connected as me");
    assert.equal(status.children[1].label, "✓ Sharing 3 folders");

    // The tabs they came from show only their lists.
    for (const tab of ["upgrades", "fallback"]) {
      h.actions["main-tab"]({ tabId: tab });
      assert.equal(findNodes(lastView(h), (n) => n.type === "settings-row").length, 0, tab + " has no settings rows");
    }
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
    const bar = findNodes(lastView(h), (n) => n.type === "toolbar" && n.title === "Songs")[0];
    assert.ok(bar.buttons.some((b) => b.action === "delete-all-kept-ask"), "the button asks; it doesn't delete");
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
  assert.deepEqual(b("searching"), { label: "Searching", variant: "accent", pulse: true });
  assert.deepEqual(b("downloading", { state: "Queued, Remotely" }), { label: "Queued", variant: "warning" }, "waiting: no pulse");
  assert.deepEqual(b("downloading", { state: "InProgress" }), { label: "Downloading", variant: "accent", pulse: true });
  assert.deepEqual(b("checking"), { label: "Checking", variant: "accent", pulse: true });
  assert.deepEqual(b("ready"), { label: "Ready", variant: "success" });
  assert.deepEqual(b("alternative"), { label: "Better copy found", variant: "warning" });
  assert.deepEqual(b("failed"), { label: "Didn't work", variant: "error" });
  assert.deepEqual(plugin._upgradeBadge({ state: "searching" }, null, 1), { label: "Up next", variant: "muted" });
  assert.deepEqual(plugin._upgradeBadge({ state: "searching" }, null, 4), { label: "Waiting", variant: "muted" });
  assert.deepEqual(plugin._upgradeBadge({ state: "searching" }, null, 0), { label: "Searching", variant: "accent", pulse: true });
  assert.equal(plugin._upgradeBadge(null), null);
  assert.equal(plugin._upgradeRowProgress({ state: "downloading" }, { state: "InProgress", size: 10, bytesTransferred: 5 }), 0.5);
  assert.equal(plugin._upgradeRowProgress({ state: "ready" }, { state: "InProgress", size: 10, bytesTransferred: 5 }), null);
});

test("upgradeRowProgress: the sweep while the plugin works with no figure, nothing while a row only waits", () => {
  const p = plugin._upgradeRowProgress;
  assert.equal(p({ state: "searching" }, null, 0), "indeterminate", "its search is running");
  assert.equal(p({ state: "searching" }, null, 2), null, "queued behind other searches");
  assert.equal(p({ state: "checking" }, null), "indeterminate");
  assert.equal(p({ state: "saving" }, null), "indeterminate");
  assert.equal(p({ state: "downloading" }, { state: "Queued, Remotely" }), null, "in a sharer's queue");
  assert.equal(p({ state: "downloading" }, null), null);
  assert.equal(p({ state: "choosing" }, null), null, "waiting for the user");
  assert.equal(p({ state: "failed" }, null), null);
});

test("searchRunningNodes: waiting its turn, then a clock against the cap with what arrived and a Stop", () => {
  const n = plugin._searchRunningNodes;
  const t0 = 1e9;
  const waiting = n({ query: "x", requestedAt: t0 }, null, t0 + 5000, 30000);
  assert.match(waiting[0].message, /Waiting for another Soulseek search.*5s/);
  assert.equal(waiting[1].children[0].label, "Cancel");
  assert.equal(waiting[1].children[0].action, "search-stop");

  const early = n({ query: "Low", fileCount: 0, responseCount: 0 }, t0, t0 + 3400, 30000);
  assert.match(early[0].message, /Searching Soulseek for “Low”/);
  assert.deepEqual([early[1].type, early[1].value, early[1].max], ["progress-bar", 3, 30]);
  assert.match(early[1].label, /^No answers yet · 3s/);
  assert.equal(early[2].children[0].label, "Stop");

  const some = n({ query: "Low", fileCount: 1234, responseCount: 1 }, t0, t0 + 45000, 30000);
  assert.equal(some[1].value, 30, "clamped at the cap");
  assert.match(some[1].label, /^1,234 files from 1 user so far/);
  assert.equal(some[2].children[0].label, "Stop and show results");
});

test("tabSearchStartedAt: only the tab's own search counts as started", () => {
  const mine = () => false;
  const s = { running: true, isStale: mine };
  assert.equal(plugin._tabSearchStartedAt(s, { owner: mine, startedAt: 7 }), 7);
  assert.equal(plugin._tabSearchStartedAt(s, { owner: () => false, startedAt: 7 }), null, "an upgrade's search");
  assert.equal(plugin._tabSearchStartedAt(s, null), null);
  assert.equal(plugin._tabSearchStartedAt({ running: false, isStale: mine }, { owner: mine, startedAt: 7 }), null);
});

test("busyJobCount: jobs still working, not those waiting on the user or done", () => {
  assert.equal(plugin._busyJobCount({
    a: { state: "searching" }, b: { state: "downloading" }, c: { state: "checking" }, d: { state: "saving" },
    e: { state: "ready" }, f: { state: "choosing" }, g: { state: "failed" }
  }), 4);
  assert.equal(plugin._busyJobCount({}), 0);
});
