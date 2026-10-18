const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { fakeHost } = require("./harness/host");

// --- the 2026-10-11 UX pass -------------------------------------------------
// Results carry their own download state (no toast, no jump to Downloads), a
// folder opens before anything is queued, Downloads moved behind the jobs and
// counts only what's live, the fallback says what it is doing.

const plugin = loadPlugin();
const SEP = "\u0000";

const BODIES = [
  { username: "peer", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1000, files: [
    { filename: "m\\OK Computer\\01 - Airbag.flac", size: 30e6, length: 284, bitDepth: 16, sampleRate: 44100 },
    { filename: "m\\OK Computer\\02 - Paranoid Android.flac", size: 40e6, length: 383, bitDepth: 16, sampleRate: 44100 },
    { filename: "m\\OK Computer\\03 - Subterranean Homesick Alien.flac", size: 28e6, length: 267, bitDepth: 16, sampleRate: 44100 }
  ] },
  { username: "other", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 500, files: [
    { filename: "z\\OKC\\Airbag.mp3", size: 6e6, length: 284, bitRate: 320 }
  ] }
];

function searchHost(library) {
  const posts = [];
  let polls = 0;
  const h = fakeHost({
    library: library,
    fetch: async (url, init) => {
      const json = (v) => ({ status: 200, text: async () => JSON.stringify(v) });
      if (url.includes("/api/v0/transfers/downloads/batches") && init && init.method === "POST") {
        posts.push(JSON.parse(init.body));
        return json({ failures: [] });
      }
      if (url.includes("/api/v0/searches") && init && init.method === "POST") return json({ id: "s1" });
      if (url.includes("/responses")) return json(BODIES);
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
  if (!node || typeof node !== "object") return out;
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

// --- pure ---------------------------------------------------------------------

test("rowTransferStatus: a result until queued, then Queued → Downloading → Done; a cancel makes it a result again", () => {
  const s = plugin._rowTransferStatus;
  const now = 1e9;
  assert.equal(s(null, null, false, now), null, "never queued");
  assert.equal(s(null, { queuedAt: now - 1000 }, false, now).badge.label, "Queued", "just queued, before slskd lists it");
  assert.equal(s(null, { queuedAt: now - 120000 }, false, now), null, "long gone from slskd and never finished");
  const q = s({ state: "Queued, Remotely", placeInQueue: 3 }, {}, false, now);
  assert.deepEqual([q.badge.label, q.actions], ["Queued · #3", ["cancel-transfer"]]);
  const d = s({ state: "InProgress", size: 100, bytesTransferred: 42 }, {}, false, now);
  assert.deepEqual([d.badge.label, d.progress, d.actions], ["Downloading 42%", 0.42, ["cancel-transfer"]]);
  const done = s({ state: "Completed, Succeeded" }, { resolvedPath: "/x" }, true, now);
  assert.deepEqual([done.badge.label, done.actions, done.action], ["Done", ["play-transfer", "import-transfer"], "play-transfer"]);
  assert.deepEqual(s({ state: "Completed, Succeeded" }, {}, false, now).actions, [], "done but not playable here (remote slskd)");
  assert.deepEqual(s({ state: "Completed, Errored" }, {}, false, now).actions, ["retry-transfer"]);
  assert.equal(s({ state: "Completed, Cancelled" }, {}, false, now), null);
});

test("transferKeys: search and folder row ids map to transfer keys; a known key is never stripped", () => {
  const key = "peer" + SEP + "m\\a.flac";
  assert.deepEqual(plugin._transferKeys({ selectedIds: ["f:" + key, "o:" + key, key] }), [key, key, key]);
  assert.deepEqual(plugin._transferKeys({ itemId: "f:nosep" }), ["f:nosep"], "not a key shape: left alone");
});

test("declaredActions: only what some row offers (the host greys out the rest in the selection bar), plus the kept ones", () => {
  const all = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(plugin._declaredActions(all, [{ actions: ["c"] }, { actions: [] }]).map((x) => x.id), ["c"]);
  assert.deepEqual(plugin._declaredActions(all, [], ["a"]).map((x) => x.id), ["a"]);
  assert.deepEqual(plugin._declaredActions(all, [{ actions: ["b", "a"] }]).map((x) => x.id), ["a", "b"], "in the declared order");
});

test("liveTransferCount: what is moving or needs you; finished and cancelled are history", () => {
  const c = plugin._liveTransferCount;
  assert.equal(c([{ state: "Completed, Succeeded" }, { state: "Completed, Cancelled" }]), 0);
  assert.equal(c([{ state: "InProgress" }, { state: "Queued, Remotely" }, { state: "Completed, Errored" }, { state: "Completed, Succeeded" }]), 3);
  assert.equal(c(null), 0);
});

test("ownedInFolder: Fill reads its mode, a plain search reads the library lookup", () => {
  const g = { files: [{ filename: "m\\X\\01 - Airbag.flac" }, { filename: "m\\X\\03 - Subterranean Homesick Alien.flac" }] };
  const fill = { kind: "fill", owned: [{ title: "Airbag", track_number: 1, duration_secs: 284 }] };
  assert.deepEqual(Object.keys(plugin._ownedInFolder(g, fill, null)), ["m\\X\\01 - Airbag.flac"]);
  assert.deepEqual(plugin._ownedInFolder(g, null, { "m\\X\\03 - Subterranean Homesick Alien.flac": true }),
    { "m\\X\\03 - Subterranean Homesick Alien.flac": true });
  assert.deepEqual(plugin._ownedInFolder(g, null, undefined), {}, "not looked up yet");
});

test("historyRows: a chip per outcome; only a song that didn't play offers the search", () => {
  const now = Date.now();
  const rows = plugin._historyRows([
    { at: now, title: "Sugarcube", artist: "Yo La Tengo", outcome: "played", ms: 7200, file: { quality: "FLAC", user: "vinylhead" } },
    { at: now - 3600e3, title: "Tom Courtenay", artist: "Yo La Tengo", outcome: "no-match", message: "0 of 41 files matched" },
    { at: now, title: "Shadows", artist: null, outcome: "timeout" }
  ], now);
  assert.deepEqual(rows.map((r) => r.badge.label), ["Played", "Nothing matched", "Ran out of time"]);
  assert.deepEqual(rows.map((r) => r.actions), [[], ["fallback-search"], ["fallback-search"]]);
  assert.equal(rows[0].subtitle, "Yo La Tengo  ·  started in 7.2 s  ·  FLAC from vinylhead  ·  just now");
  assert.equal(rows[1].subtitle, "Yo La Tengo  ·  0 of 41 files matched  ·  1 h ago");
  assert.equal(rows[0].artistName, "Yo La Tengo", "a song row: the track menu works on it");
});

test("withResolve: the host's quick retries of one song are one play; a later play or another song is a new entry", () => {
  const w = plugin._withResolve;
  const t0 = 1e9;
  let list = w([], { at: t0, title: "Let Down", artist: "Radiohead", outcome: "no-match" }, 50);
  list = w(list, { at: t0 + 7000, title: "let down", artist: "RADIOHEAD", outcome: "no-match" }, 50);
  list = w(list, { at: t0 + 14000, title: "Let Down", artist: "Radiohead", outcome: "played" }, 50);
  assert.equal(list.length, 1, "three tries, one row");
  assert.deepEqual([list[0].outcome, list[0].tries], ["played", 3], "the last try's outcome is the play's");
  assert.equal(plugin._resolveStats(list).started, 1);
  list = w(list, { at: t0 + 20000, title: "Karma Police", artist: "Radiohead", outcome: "no-match" }, 50);
  list = w(list, { at: t0 + 20000 + 3 * 60e3, title: "Karma Police", artist: "Radiohead", outcome: "no-match" }, 50);
  assert.deepEqual(list.map((e) => e.title), ["Karma Police", "Karma Police", "Let Down"], "past the window it's a new play");
  const rows = plugin._historyRows([{ at: t0, title: "Let Down", artist: "Radiohead", outcome: "no-match", message: "nothing matched", tries: 4 }], t0);
  assert.match(rows[0].subtitle, /nothing matched {2}· {2}tried 4 times {2}· {2}just now$/);
});

test("fallbackStatusNode: never used warns where to switch it on; used says when; running says what", () => {
  const now = Date.now();
  const never = plugin._fallbackStatusNode([], null, now);
  assert.match(never.className, /ds-banner--warning/);
  assert.match(never.children[0].content, /Settings → Providers → Playback fallback/);
  const used = plugin._fallbackStatusNode([{ at: now - 120e3 }], null, now);
  assert.match(used.content, /^Last used 2 min ago\./);
  const running = plugin._fallbackStatusNode([], { outcome: "running", title: "Autumn Sweater", artist: "Yo La Tengo" }, now);
  assert.match(running.content, /^Finding “Autumn Sweater” by Yo La Tengo on Soulseek now/);
});

test("rowTransferStatus: a finished upgrade file offers Replace on its own row, first", () => {
  const s = plugin._rowTransferStatus;
  const done = s({ state: "Completed, Succeeded" }, { resolvedPath: "/x", upgrade: { trackId: 42 } }, true, 0);
  assert.deepEqual(done.actions, ["replace-transfer", "play-transfer", "import-transfer"]);
  assert.equal(done.badge.label, "Done", "the plugin never hears whether the Replace went through");
  assert.deepEqual(s({ state: "Completed, Succeeded" }, { resolvedPath: "/x", upgrade: { trackId: 42 } }, false, 0).actions, [], "remote slskd: nothing to replace from here");
});

test("withResolve: a replay right after a song played is a new play, not a retry", () => {
  const w = plugin._withResolve;
  let list = w([], { at: 1e9, title: "Sugarcube", artist: "Yo La Tengo", outcome: "played" }, 50);
  list = w(list, { at: 1e9 + 30e3, title: "Sugarcube", artist: "Yo La Tengo", outcome: "cached" }, 50);
  assert.equal(list.length, 2);
  assert.equal(list[0].tries, undefined);
});

test("fallbackStatusNode: clearing Recent doesn't bring back 'Not used yet'", () => {
  const now = Date.now();
  const node = plugin._fallbackStatusNode([], null, now, now - 5 * 60e3);
  assert.match(node.content, /^Last used 5 min ago\./);
});

// --- integration ----------------------------------------------------------------

function transferHost(files, library) {
  const posts = [], deletes = [];
  const byUser = {};
  for (const f of files) (byUser[f.username] = byUser[f.username] || []).push(f);
  const h = fakeHost({
    library: library || { tracks: [] },
    fetch: async (url, init) => {
      const json = (v, status) => ({ status: status || 200, text: async () => JSON.stringify(v) });
      const method = (init && init.method) || "GET";
      if (url.includes("/api/v0/transfers/downloads/batches") && method === "POST") { posts.push(JSON.parse(init.body)); return json({ failures: [] }); }
      if (url.includes("/api/v0/transfers/downloads/") && method === "DELETE") { deletes.push(url); return json({}, 204); }
      if (/\/api\/v0\/transfers\/downloads(\?|$)/.test(url) && method === "GET") {
        return json(Object.keys(byUser).map((u) => ({ username: u, directories: [{ directory: "d", files: byUser[u] }] })));
      }
      return undefined;
    }
  });
  return { h, posts, deletes };
}

function transfer(username, filename, state) {
  return { username, filename, state, size: 10e6, bytesTransferred: state === "InProgress" ? 5e6 : 0, id: username + "-" + filename };
}

test("a mixed selection: Retry re-queues only the failed file, Cancel cancels only the moving one", async () => {
  const p = loadPlugin();
  const moving = "a" + SEP + "m\\A\\01 - Moving.flac";
  const failed = "b" + SEP + "m\\B\\02 - Broken.flac";
  const done = "c" + SEP + "m\\C\\03 - Done.flac";
  const { h, posts, deletes } = transferHost([
    transfer("a", "m\\A\\01 - Moving.flac", "InProgress"),
    transfer("b", "m\\B\\02 - Broken.flac", "Completed, Errored"),
    transfer("c", "m\\C\\03 - Done.flac", "Completed, Succeeded")
  ]);
  await p.activate(h.api);
  try {
    await p._refreshTransfers();
    const ids = [moving, failed, done].map((k) => "f:" + k);
    h.actions["retry-transfer"]({ selectedIds: ids });
    await waitFor(() => posts.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(posts.length, 1, "only the failed file is re-queued");
    assert.equal(posts[0].username, "b");
    assert.equal(h.calls.notifications.length, 0, "no refusal toasts for files that were never retried");

    h.actions["cancel-transfer"]({ selectedIds: ids });
    await waitFor(() => deletes.length >= 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(deletes.length, 1, "only the moving one is cancelled");
    assert.match(decodeURIComponent(deletes[0]), /\/downloads\/a\//);
  } finally {
    p.deactivate();
  }
});

test("Recent: Search Soulseek for it finds the song clicked, even after a new resolve moved the rows down", async () => {
  const p = loadPlugin();
  const { h } = searchHost({ tracks: [] });
  await p.activate(h.api);
  try {
    const a = p._startResolveRecord("Let Down", "Radiohead", 299, "radiohead let down");
    p._finishResolve(a, "no-match", "nothing matched");
    h.actions["main-tab"]({ tabId: "fallback" });
    const before = findNodes(lastView(h), (n) => n.type === "track-row-list")[0].items[0];
    assert.equal(before.title, "Let Down");
    // Another song lands on top before the click.
    const b = p._startResolveRecord("Creep", "Radiohead", 238, "radiohead creep");
    b.at += 1;
    p._finishResolve(b, "no-match", "nothing matched");
    h.actions["fallback-search"]({ itemId: before.id });
    await waitFor(() => {
      const box = findNodes(lastView(h), (n) => n.type === "search-input")[0];
      return box && box.value === "Radiohead Let Down";
    });
  } finally {
    p.deactivate();
  }
});

test("an open folder whose downloads failed still offers Download", async () => {
  const p = loadPlugin();
  const { h } = searchHost({ tracks: [] });
  await p.activate(h.api);
  try {
    h.actions["search"]({ query: "ok computer" });
    await waitFor(() => findNodes(lastView(h), (n) => n.type === "track-row-list").length === 1);
    h.actions["result-mode"]({ tabId: "folders" });
    const card = findNodes(lastView(h), (n) => n.type === "track-row-list" && n.sortAction === "sort-folders")[0].items.find((i) => i.title === "OK Computer");
    h.actions["open-folder"]({ itemId: card.id });
    // Every file of the folder failed in slskd.
    const rows = findNodes(lastView(h), (n) => n.type === "track-row-list")[0].items;
    p._setTransfersForTest(rows.map((r) => {
      const key = r.id.slice(2), at = key.indexOf(SEP);
      return transfer(key.slice(0, at), key.slice(at + 1), "Completed, Errored");
    }));
    h.actions["open-folder"]({ itemId: card.id });   // redraw
    const view = lastView(h);
    assert.equal(findNodes(view, (n) => n.type === "text" && /Every file here is queued/.test(n.content || "")).length, 0);
    assert.equal(findNodes(view, (n) => n.type === "button" && n.action === "folder-download").length, 1);
    assert.ok(findNodes(view, (n) => n.type === "track-row-list")[0].items.every((r) => r.badge.label === "Failed"));
  } finally {
    p.deactivate();
  }
});

test("Search: Download keeps you on the results, the row turns Queued, and no toast is raised", async () => {
  const p = loadPlugin();
  const { h, posts } = searchHost({ tracks: [] });
  await p.activate(h.api);
  try {
    h.actions["search"]({ query: "ok computer" });
    await waitFor(() => findNodes(lastView(h), (n) => n.type === "track-row-list").length === 1);
    const list = findNodes(lastView(h), (n) => n.type === "track-row-list")[0];
    const row = list.items.find((i) => /Airbag\.flac$/.test(i.title));
    assert.deepEqual(row.actions, ["download-file"]);
    assert.deepEqual(list.actions.map((a) => a.id), ["download-file"], "the selection bar offers only what some row can do");

    h.actions["download-file"]({ itemId: row.id });
    await waitFor(() => posts.length === 1);
    await waitFor(() => {
      const l = findNodes(lastView(h), (n) => n.type === "track-row-list")[0];
      const r = l && l.items.find((i) => i.id === row.id);
      return !!(r && r.badge && /^Queued/.test(r.badge.label));
    });
    const queuedList = findNodes(lastView(h), (n) => n.type === "track-row-list")[0];
    assert.deepEqual(queuedList.actions.map((a) => a.id), ["download-file", "cancel-transfer"], "Cancel joins once a file is on its way");
    const tabs = findNodes(lastView(h), (n) => n.type === "tabs")[0];
    assert.equal(tabs.activeTab, "search", "still on the results");
    assert.deepEqual(tabs.tabs.map((t) => t.id), ["search", "upgrades", "fallback", "transfers", "settings"]);
    assert.equal(h.calls.notifications.length, 0, "no toast: " + h.calls.notifications.join(" | "));

    // The same row offered again, from a selection, isn't queued twice.
    h.actions["download-file"]({ selectedIds: [row.id] });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(posts.length, 1);
  } finally {
    p.deactivate();
  }
});

test("Search: Search… on an album opens on Folders; the open folder marks songs the library has by name", async () => {
  const p = loadPlugin();
  const owned = [{ id: 1, title: "Airbag", artist_name: "Radiohead", duration_secs: 284, path: "file:///a" }];
  const { h, posts } = searchHost({ tracks: owned });
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-search"]({ kind: "album", albumTitle: "OK Computer", artistName: "Radiohead" });
    await waitFor(() => findNodes(lastView(h), (n) => n.type === "track-row-list" && n.sortAction === "sort-folders").length === 1);
    const grid = findNodes(lastView(h), (n) => n.type === "track-row-list" && n.sortAction === "sort-folders")[0];
    const okc = grid.items.find((i) => i.title === "OK Computer");
    assert.equal(okc.action, "open-folder");
    h.actions["open-folder"]({ itemId: okc.id });
    // While the library hasn't answered, "all" isn't the button to press first.
    const first = lastView(h);
    assert.equal(findNodes(first, (n) => n.type === "text" && n.content === "Checking your library…").length, 1);
    assert.equal(findNodes(first, (n) => n.type === "button" && n.action === "folder-download")[0].variant, "secondary");
    assert.equal(findNodes(first, (n) => n.type === "button" && n.action === "close-folder")[0].label, "← Folders");
    await waitFor(() => findNodes(lastView(h), (n) => n.type === "button" && n.action === "folder-download").length === 2);
    const rows = findNodes(lastView(h), (n) => n.type === "track-row-list")[0].items;
    assert.deepEqual(rows.filter((r) => r.badge).map((r) => r.title), ["01 - Airbag.flac"]);
    assert.equal(posts.length, 0, "opening a folder queues nothing");
    h.actions["close-folder"]();
    assert.equal(findNodes(lastView(h), (n) => n.type === "track-row-list" && n.sortAction === "sort-folders").length, 1, "back to the folder list");
  } finally {
    p.deactivate();
  }
});

test("Fallback: the sidebar item shows a dot while a resolve runs, and clears when it ends", async () => {
  const p = loadPlugin();
  const { h } = searchHost({ tracks: [] });
  await p.activate(h.api);
  try {
    assert.equal(p._sidebarBadge(), null, "ready, idle");
    const rec = p._startResolveRecord("Autumn Sweater", "Yo La Tengo", 232, "yo la tengo autumn sweater");
    const dot = h.calls.badges[h.calls.badges.length - 1];
    assert.equal(dot.variant, "accent");
    assert.match(dot.tooltip, /Autumn Sweater/);
    p._finishResolve(rec, "no-match", "nothing matched");
    assert.equal(h.calls.badges[h.calls.badges.length - 1], null);

    // The miss is a row with the way forward.
    h.actions["main-tab"]({ tabId: "fallback" });
    const recent = findNodes(lastView(h), (n) => n.type === "track-row-list")[0];
    assert.deepEqual(recent.items[0].actions, ["fallback-search"]);
    h.actions["fallback-search"]({ itemId: recent.items[0].id });
    await waitFor(() => findNodes(lastView(h), (n) => n.type === "tabs")[0].activeTab === "search");
  } finally {
    p.deactivate();
  }
});

test("Folders: a sortable table — name opens, hover downloads the whole folder, the row shows how far it got", async () => {
  const p = loadPlugin();
  const { h, posts } = searchHost({ tracks: [] });
  await p.activate(h.api);
  try {
    h.actions["search"]({ query: "ok computer" });
    await waitFor(() => findNodes(lastView(h), (n) => n.type === "track-row-list").length === 1);
    h.actions["result-mode"]({ tabId: "folders" });
    let list = findNodes(lastView(h), (n) => n.type === "track-row-list" && n.sortAction === "sort-folders")[0];
    assert.equal(findNodes(lastView(h), (n) => n.type === "card-grid").length, 0, "no card grid any more");
    assert.equal(list.selectionMode, "single");
    assert.equal(list.contextMenu, false, "a folder isn't a track");
    assert.equal(list.openOnClick, "title");
    assert.deepEqual(list.columns.map((c) => c.id), ["quality", "tracks", "size", "availability"]);
    assert.deepEqual(list.items.map((i) => i.title), ["OK Computer", "OKC"], "ranked order first");
    const okc = list.items[0];
    assert.equal(okc.cells.quality, "FLAC 44kHz/16bit");
    assert.equal(okc.cells.tracks, "3");
    assert.equal(okc.subtitle, "peer");
    assert.deepEqual(okc.actions, ["folder-row-download", "open-folder"]);
    assert.deepEqual(list.actions.map((a) => a.label), ["Download folder", "Open folder"]);

    // Sorting by Tracks ascending puts the one-file folder first; Best match undoes it.
    h.actions["sort-folders"]({ column: "tracks", direction: "asc" });
    list = findNodes(lastView(h), (n) => n.type === "track-row-list" && n.sortAction === "sort-folders")[0];
    assert.deepEqual(list.items.map((i) => i.title), ["OKC", "OK Computer"]);
    assert.equal(list.sortBy, "tracks");
    const bar = findNodes(lastView(h), (n) => n.type === "toolbar" && (n.buttons || []).some((b) => b.action === "sort-best"))[0];
    assert.equal(bar.status, "sorted by Tracks");
    h.actions["sort-best"]();
    list = findNodes(lastView(h), (n) => n.type === "track-row-list" && n.sortAction === "sort-folders")[0];
    assert.deepEqual(list.items.map((i) => i.title), ["OK Computer", "OKC"]);

    // The hover button queues every file of the folder without opening it.
    h.actions["folder-row-download"]({ itemId: okc.id, selectedIds: [okc.id] });
    await waitFor(() => posts.length === 1);
    assert.equal(posts[0].username, "peer");
    assert.equal(posts[0].files.length, 3);
    await waitFor(() => {
      const r = findNodes(lastView(h), (n) => n.type === "track-row-list" && n.sortAction === "sort-folders")[0].items[0];
      return !!(r.badge && /^Queued 3 of 3$/.test(r.badge.label));
    });
    const row = findNodes(lastView(h), (n) => n.type === "track-row-list" && n.sortAction === "sort-folders")[0].items[0];
    assert.deepEqual(row.actions, ["open-folder"], "nothing left to queue");
    assert.equal(findNodes(lastView(h), (n) => n.type === "track-row-list" && n.sortAction === "sort-folders").length, 1, "still on the folder list");
    assert.equal(h.calls.notifications.length, 0);
  } finally {
    p.deactivate();
  }
});

test("Downloads: newest first by when each transfer last happened", () => {
  const t = (name, at) => Object.assign({ filename: name }, at);
  const sorted = plugin._sortTransfersNewestFirst([
    t("old", { requestedAt: "2026-09-01T10:00:00Z", endedAt: "2026-09-01T10:05:00Z" }),
    t("undated", {}),
    t("new", { requestedAt: "2026-10-18T09:00:00Z" }),
    t("mid", { requestedAt: "2026-10-01T09:00:00Z", endedAt: "2026-10-02T09:00:00Z" })
  ]);
  assert.deepEqual(sorted.map((x) => x.filename), ["new", "mid", "old", "undated"]);
});

test("folderQualityLabel / folderRowStatus", () => {
  const flac = (i) => ({ filename: "a\\" + i + ".flac", extension: "flac", size: 30e6, qualityTier: 0, bitDepth: 24, sampleRate: 96000 });
  const mp3 = (i) => ({ filename: "a\\" + i + ".mp3", extension: "mp3", size: 20e6, qualityTier: 2, bitRate: 320 });
  assert.equal(plugin._folderQualityLabel([flac(1), flac(2)]), "FLAC 96kHz/24bit");
  assert.equal(plugin._folderQualityLabel([flac(1), mp3(2), mp3(3)]), "Mixed");
  assert.equal(plugin._folderQualityLabel([]), "");
  assert.equal(plugin._folderRowStatus({ username: "u", files: [flac(1)] }, Date.now()), null, "nothing queued, no chip");
});
