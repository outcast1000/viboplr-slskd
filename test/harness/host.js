"use strict";
// A fake Viboplr host for the integration tests: records every handler the
// plugin registers, answers slskd's REST endpoints from a path map (or a
// per-test `fetch` override that sees the full URL), and logs what the plugin
// asked the host to do. Shared by transfers.test.js and fallback.test.js.

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
  const calls = { requestAction: [], notifications: [], badges: [], resync: [], played: [], fetched: [], views: [] };
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
      // `o.fetch(fullUrl, init)` sees the URL *with* its query string and may
      // answer; returning undefined falls through to the `responses` map.
      fetch: async (url, init) => {
        calls.fetched.push(url);
        if (o.fetch) {
          const custom = await o.fetch(url, init);
          if (custom) return custom;
        }
        const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
        if (!(path in responses)) return { status: 404, text: async () => '"not found"' };
        return { status: 200, text: async () => JSON.stringify(responses[path]) };
      },
      openUrl: async () => {}
    },
    ui: {
      setViewData: (viewId, data) => calls.views.push({ viewId, data }),
      showNotification: (m) => calls.notifications.push(m),
      onAction: (id, fn) => { actions[id] = fn; },
      navigateToView() {},
      requestAction: (a, p) => calls.requestAction.push({ action: a, payload: p }),
      setBadge: (v, b) => calls.badges.push(b)
    },
    playback: {
      onResolveStreamByUri: (scheme, fn) => { resolvers["stream:" + scheme] = fn; },
      onStreamResolve: (id, fn) => { resolvers["meta:" + id] = fn; },
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
    // `o.library` = { tracks: Track[], albums: Album[] } — the library the
    // upgrade / fill-album modes read. Empty by default.
    library: {
      getTrackById: async (id) => ((o.library && o.library.tracks) || []).find((t) => t.id === id) || null,
      getTracks: async (q) => ((o.library && o.library.tracks) || []).filter((t) => q && q.albumId != null ? t.album_id === q.albumId : true),
      ftsAlbums: async () => (o.library && o.library.albums) || []
    },
    system: { readAudioTags: async (paths) => paths.map(() => null) },
    assistant: { onTool: (name, fn) => { tools[name] = fn; } }
  };
  return { api, actions, tools, resolvers, calls, store };
}

module.exports = { fakeHost };
