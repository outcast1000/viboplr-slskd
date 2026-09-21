const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();
const SEP = plugin._KEY_SEP;

// --- collectionForPath ------------------------------------------------------
// Same contract as the qBittorrent plugin's helper: longest matching root wins,
// a partial segment match is not a match, Windows compares case-insensitively.

test("collectionForPath picks the collection whose root contains the file", () => {
  const cols = [
    { id: 1, name: "Music", path: "/Users/me/Music" },
    { id: 2, name: "Downloads", path: "/Users/me/Music/slskd" }
  ];
  assert.equal(plugin._collectionForPath("/Users/me/Music/slskd/viboplr/1/x.flac", cols).id, 2, "nested root wins");
  assert.equal(plugin._collectionForPath("/Users/me/Music/Albums/x.flac", cols).id, 1);
  assert.equal(plugin._collectionForPath("/Users/me/Movies/x.mkv", cols), null);
});

test("collectionForPath does not match a partial path segment", () => {
  const cols = [{ id: 1, name: "M", path: "/Users/me/Music" }];
  assert.equal(plugin._collectionForPath("/Users/me/Music2/x.mp3", cols), null);
});

test("collectionForPath is case-insensitive and slash-agnostic on Windows", () => {
  const cols = [{ id: 7, name: "W", path: "C:\\Users\\Me\\Music" }];
  assert.equal(plugin._collectionForPath("c:/users/me/music/a/b.mp3", cols).id, 7);
});

test("collectionForPath skips collections without a path and handles empty input", () => {
  assert.equal(plugin._collectionForPath("/x/y.mp3", [{ id: 1, name: "n", path: null }]), null);
  assert.equal(plugin._collectionForPath("", [{ id: 1, name: "n", path: "/x" }]), null);
  assert.equal(plugin._collectionForPath("/x/y.mp3", null), null);
});

// --- mergeMeta --------------------------------------------------------------
// Tags win per field; the filename parse fills every gap. Not all-or-nothing.

test("mergeMeta takes tags per field and falls back to the parse per field", () => {
  const parsed = { title: "Karma Police", artist: "Radiohead", album: "OK Computer", trackNumber: 3 };
  const tags = { title: "Karma Police", artist: "  Radiohead ", album: null, track_number: null, year: 1997, duration_secs: 264.2 };
  const m = plugin._mergeMeta(parsed, tags);
  assert.equal(m.artist, "Radiohead", "tag wins, trimmed");
  assert.equal(m.album, "OK Computer", "null tag → parse");
  assert.equal(m.trackNumber, 3, "null tag → parse");
  assert.equal(m.year, 1997);
  assert.equal(m.durationSecs, 264.2);
});

test("mergeMeta with no tags is the parse, with an unreadable file too", () => {
  const parsed = { title: "T", artist: null, album: "A", trackNumber: null };
  assert.deepEqual(plugin._mergeMeta(parsed, null), {
    title: "T", artist: null, album: "A", albumArtist: null, trackNumber: null, year: null, genre: null, durationSecs: null
  });
});

test("mergeMeta treats an empty-string tag as absent", () => {
  assert.equal(plugin._mergeMeta({ title: "From name" }, { title: "" }).title, "From name");
});

// --- candidateId ------------------------------------------------------------
// Deterministic from (user, filename) and route-safe: the assistant passes
// these back, so they must survive a JSON round trip and a URL segment.

test("candidateId is stable, distinct per (user, file) and route-safe", () => {
  const a = plugin._candidateId({ username: "u", filename: "@@x\\Music\\01 - A.mp3" });
  assert.equal(a, plugin._candidateId({ username: "u", filename: "@@x\\Music\\01 - A.mp3" }));
  assert.notEqual(a, plugin._candidateId({ username: "v", filename: "@@x\\Music\\01 - A.mp3" }));
  assert.notEqual(a, plugin._candidateId({ username: "u", filename: "@@x\\Music\\02 - B.mp3" }));
  assert.match(a, /^c[0-9a-z]+$/);
});

// --- transfer presentation --------------------------------------------------

test("transferProgress is 0..1 and null without a size", () => {
  assert.equal(plugin._transferProgress({ size: 200, bytesTransferred: 50 }), 0.25);
  assert.equal(plugin._transferProgress({ size: 200, bytesTransferred: 999 }), 1);
  assert.equal(plugin._transferProgress({ size: 0, bytesTransferred: 5 }), null);
  assert.equal(plugin._transferProgress(null), null);
});

test("transferSubtitle leads with the phase and reads the same down the column", () => {
  const sub = plugin._transferSubtitle;
  assert.match(sub({ state: "InProgress", size: 1000, bytesTransferred: 500, averageSpeed: 2048, username: "peer" }, null, "local"), /^Downloading 50%.*↓ 2\.0 KB\/s.*from peer$/);
  assert.match(sub({ state: "Queued, Remotely", size: 1000, placeInQueue: 4, username: "peer" }, null, "local"), /^Waiting in peer's queue · position 4/);
  assert.match(sub({ state: "Completed, Succeeded", size: 1000, username: "peer" }, null, "local"), /^Finished.*locating file…$/);
  assert.doesNotMatch(sub({ state: "Completed, Succeeded", size: 1000, username: "peer" }, { resolvedPath: "/x" }, "local"), /locating/);
  assert.doesNotMatch(sub({ state: "Completed, Succeeded", size: 1000, username: "peer" }, null, "remote"), /locating/, "remote tier never locates");
  assert.match(sub({ state: "Completed, Errored", exception: "boom", attempts: 2, username: "peer" }, null, "local"), /^Failed — boom.*attempt 2/);
});

test("transferRowActions offers only what would act on THAT transfer", () => {
  const act = plugin._transferRowActions;
  assert.deepEqual(act({ state: "Completed, Succeeded" }, { resolvedPath: "/x" }, "local"), ["play-transfer", "import-transfer", "remove-transfer"]);
  assert.deepEqual(act({ state: "Completed, Succeeded" }, { resolvedPath: "/x" }, "remote"), ["remove-transfer"], "remote: nothing to play or copy");
  assert.deepEqual(act({ state: "Completed, Succeeded" }, null, "local"), ["remove-transfer"], "not located yet");
  assert.deepEqual(act({ state: "Completed, Errored" }, null, "local"), ["retry-transfer", "another-source", "remove-transfer"]);
  assert.deepEqual(act({ state: "Completed, Cancelled" }, null, "local"), ["retry-transfer", "remove-transfer"]);
  assert.deepEqual(act({ state: "InProgress" }, null, "local"), ["cancel-transfer"]);
  assert.deepEqual(act({ state: "Queued, Locally" }, null, "local"), ["cancel-transfer"]);
});

test("rowIds reads a hover button, a selection toolbar and a plain button alike", () => {
  assert.deepEqual(plugin._rowIds({ itemId: "a" }), ["a"]);
  assert.deepEqual(plugin._rowIds({ selectedIds: ["a", "b", null, ""] }), ["a", "b"]);
  assert.deepEqual(plugin._rowIds({ selectedIds: ["a"], itemId: "b" }), ["a"], "a selection outranks the clicked row");
  assert.deepEqual(plugin._rowIds({ ref: "r" }), ["r"]);
  assert.deepEqual(plugin._rowIds(null), []);
});

// --- key separator ----------------------------------------------------------
// The separator used to be a literal NUL byte in the source, which made the
// file binary to every text tool. It is now an escape; the value is unchanged
// so records persisted by 0.1.0 still resolve.

test("KEY_SEP is a single NUL character", () => {
  assert.equal(SEP, "\u0000");
  assert.equal(SEP.length, 1);
});

// --- activation smoke test --------------------------------------------------
// Drives activate() against a fake host: readiness lands on "ready", every
// host surface the manifest promises is registered, and Add to library opens
// the host's download modal with the provider key + slsk:// uri the host
// expects — the path that broke when the host removed api.downloads.enqueue.

function fakeHost(opts) {
  const o = opts || {};
  const store = Object.assign({
    url: "http://localhost:5030",
    apiKey: "k".repeat(20),
    tracked: {}
  }, o.store || {});
  const actions = {};
  const tools = {};
  const resolvers = {};
  const calls = { requestAction: [], notifications: [], badges: [], resync: [], played: [] };
  const responses = Object.assign({
    "/api/v0/application": {
      server: { state: "Connected, LoggedIn", isLoggedIn: true, isTransitioning: false, username: "me" },
      version: { current: "0.26.0" },
      shares: { directories: 3, files: 100 }
    },
    "/api/v0/options": { directories: { downloads: "/Users/me/Music/slskd" } },
    "/api/v0/transfers/downloads": []
  }, o.responses || {});
  const api = {
    appVersion: "1.0.66",
    log() {},
    storage: {
      get: async (k) => store[k],
      set: async (k, v) => { store[k] = v; },
      delete: async (k) => { delete store[k]; }
    },
    network: {
      fetch: async (url) => {
        const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
        if (!(path in responses)) return { status: 404, text: async () => '"not found"' };
        return { status: 200, text: async () => JSON.stringify(responses[path]) };
      },
      openUrl: async () => {}
    },
    ui: {
      setViewData() {},
      showNotification: (m) => calls.notifications.push(m),
      onAction: (id, fn) => { actions[id] = fn; },
      navigateToView() {},
      requestAction: (a, p) => calls.requestAction.push({ action: a, payload: p }),
      setBadge: (v, b) => calls.badges.push(b)
    },
    playback: {
      onResolveStreamByUri: (scheme, fn) => { resolvers["stream:" + scheme] = fn; },
      playTrack: (t) => calls.played.push(t),
      playTracks: (ts) => calls.played.push(...ts)
    },
    downloads: {
      onResolveByUri: (id, fn) => { resolvers["download:" + id] = fn; },
      onGetQualities: (id, fn) => { resolvers["qualities:" + id] = fn; }
    },
    contextMenu: { onAction: (id, fn) => { actions["ctx:" + id] = fn; } },
    collections: {
      getLocalCollections: async () => o.collections || [{ id: 1, name: "Music", path: "/Users/me/Music" }],
      resync: async (id) => { calls.resync.push(id); }
    },
    system: { readAudioTags: async (paths) => paths.map(() => null) },
    assistant: { onTool: (name, fn) => { tools[name] = fn; } }
  };
  return { api, actions, tools, resolvers, calls, store };
}

test("activate registers every surface the manifest declares, and readiness lands on ready", async () => {
  const p = loadPlugin();
  const h = fakeHost();
  await p.activate(h.api);
  try {
    const manifest = JSON.parse(require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "manifest.json"), "utf8"));
    for (const t of manifest.contributes.assistant.tools) {
      assert.equal(typeof h.tools[t.name], "function", "assistant tool " + t.name + " has a handler");
    }
    assert.deepEqual(Object.keys(h.tools).sort(), manifest.contributes.assistant.tools.map((t) => t.name).sort(), "no undeclared tools");
    for (const item of manifest.contributes.contextMenuItems) {
      assert.equal(typeof h.actions["ctx:" + item.id], "function", "context menu " + item.id + " handled");
    }
    assert.equal(typeof h.resolvers["stream:slsk"], "function");
    assert.equal(typeof h.resolvers["download:" + manifest.contributes.downloadProviders[0].id], "function");
    assert.equal(typeof h.actions["host:search"], "function", "tabbed view handles the Cmd+K handover");
    for (const id of ["play-transfer", "import-transfer", "retry-transfer", "another-source", "cancel-transfer", "remove-transfer", "download-file", "download-folder"]) {
      assert.equal(typeof h.actions[id], "function", id + " handled");
    }
    const status = await h.tools.status({});
    assert.equal(status.state, "ready");
    assert.equal(status.soulseekUsername, "me");
    assert.equal(status.slskdOnThisComputer, true);
    assert.equal(status.downloadsReachLibraryAutomatically, true, "downloads dir sits inside the Music collection");
    assert.equal(h.calls.badges[h.calls.badges.length - 1], null, "ready → no badge");
  } finally {
    p.deactivate();
  }
});

test("Add to library opens the host download modal with the provider key and slsk:// uri", async () => {
  const p = loadPlugin();
  const key = "peer" + SEP + "@@x\\Music\\OK Computer\\03 - Karma Police.flac";
  const h = fakeHost({
    store: {
      tracked: {
        [key]: {
          destination: "viboplr/1-OK_Computer", b64: null,
          resolvedPath: "/Users/me/Music/slskd/viboplr/1-OK_Computer/03 - Karma Police.flac",
          meta: { title: "Karma Police", artist: "Radiohead", album: "OK Computer", trackNumber: 3 },
          size: 28000000, length: 264
        }
      }
    }
  });
  await p.activate(h.api);
  try {
    h.actions["import-transfer"]({ itemId: key });
    assert.equal(h.calls.requestAction.length, 1);
    const r = h.calls.requestAction[0];
    assert.equal(r.action, "download-tracks");
    assert.equal(r.payload.providerId, "slskd:slskd-import", "host keys providers as pluginId:providerId");
    assert.equal(r.payload.providerName, "Soulseek");
    assert.equal(r.payload.tracks.length, 1);
    assert.equal(r.payload.tracks[0].uri, "slsk://" + key);
    assert.equal(r.payload.tracks[0].title, "Karma Police");
    assert.equal(r.payload.tracks[0].artist_name, "Radiohead");
    assert.equal(r.payload.tracks[0].durationSecs, 264);

    // The provider the modal then calls answers a file:// copy with a real ext.
    const resolved = await h.resolvers["download:slskd-import"]("slsk://" + key, "original");
    assert.equal(resolved.url, "file:///Users/me/Music/slskd/viboplr/1-OK_Computer/03 - Karma Police.flac");
    assert.equal(resolved.ext, "flac", "a concrete extension, never \"auto\"");
    assert.equal(resolved.metadata.trackNumber, 3);

    // Play goes through the scheme resolver to the same file, unencoded.
    h.actions["play-transfer"]({ itemId: key });
    assert.equal(h.calls.played.length, 1);
    assert.equal(h.calls.played[0].path, "slsk://" + key);
    assert.equal(h.calls.played[0].kind, "audio");
    const url = await h.resolvers["stream:slsk"](key);
    assert.equal(url, "file:///Users/me/Music/slskd/viboplr/1-OK_Computer/03 - Karma Police.flac");
  } finally {
    p.deactivate();
  }
});

test("Add to library on a remote-tier slskd explains instead of opening the modal", async () => {
  const p = loadPlugin();
  const key = "peer" + SEP + "x\\a.mp3";
  const h = fakeHost({
    store: {
      url: "http://nas.local:5030",
      tracked: { [key]: { destination: "viboplr/1", resolvedPath: "/srv/dl/viboplr/1/a.mp3", meta: { title: "a" } } }
    }
  });
  await p.activate(h.api);
  try {
    h.actions["import-transfer"]({ itemId: key });
    assert.equal(h.calls.requestAction.length, 0);
    assert.match(h.calls.notifications[h.calls.notifications.length - 1], /another machine/);
    assert.equal(await h.resolvers["stream:slsk"](key), null, "remote files are not playable from here");
  } finally {
    p.deactivate();
  }
});

test("assistant download rejects ids that did not come from the last search", async () => {
  const p = loadPlugin();
  const h = fakeHost();
  await p.activate(h.api);
  try {
    await assert.rejects(() => h.tools.download({ ids: ["nope"] }), /Unknown result id/);
    await assert.rejects(() => h.tools.download({}), /"ids"/);
    await assert.rejects(() => h.tools.search({}), /"query"/);
  } finally {
    p.deactivate();
  }
});
