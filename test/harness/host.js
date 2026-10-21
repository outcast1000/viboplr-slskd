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
  const calls = { requestAction: [], notifications: [], notices: [], navigated: [], badges: [], resync: [], played: [], fetched: [], views: [], exec: [], opened: [], headers: [], programs: [] };
  // The plugin's own file store (api.storage.files), as path → text. Folders
  // exist implicitly; `getPath` answers for anything at or under a written path.
  const files = Object.assign({}, o.files || {});
  const FILES_ROOT = "/store";
  const joined = (segs) => segs.join("/");
  const filesApi = {
    writeText: async (segs, text) => { files[joined(segs)] = String(text); return FILES_ROOT + "/" + joined(segs); },
    readText: async (segs) => (joined(segs) in files ? files[joined(segs)] : null),
    getPath: async (segs) => {
      const k = joined(segs);
      const exists = k in files || Object.keys(files).some((f) => f.startsWith(k + "/"));
      return exists ? FILES_ROOT + "/" + k : null;
    },
    exists: async (segs) => joined(segs) in files,
    remove: async (segs) => {
      const k = joined(segs);
      for (const f of Object.keys(files)) if (f === k || f.startsWith(k + "/")) delete files[f];
      calls.programs.push({ op: "files.remove", path: k });
    }
  };
  // api.system.programs: `o.programs` overrides any method; the defaults
  // succeed. Every call is logged in `calls.programs` as { op, ... }.
  // `o.progState` seeds it — e.g. { registered: true } for a slskd the host
  // started before, now stopped.
  const progState = Object.assign({ running: false, registered: false, spec: null }, o.progState || {});
  const programsDefaults = {
    download: async (path, url, opts) => {
      if (opts && opts.onProgress) { opts.onProgress(10, 100); opts.onProgress(100, 100); }
      files[joined(path)] = "zip";
      return { path: FILES_ROOT + "/" + joined(path), sha256: (opts && opts.sha256) || "0".repeat(64), size: 100 };
    },
    extract: async (archive, dest) => { files[joined(dest) + "/slskd"] = "bin"; return 3; },
    run: async () => ({ exitCode: 0, stdout: "0.26.1\n", stderr: "" }),
    start: async (name, spec) => { progState.running = true; progState.registered = true; progState.spec = spec; return status(name); },
    status: async (name) => status(name),
    list: async () => (progState.registered ? [status("slskd")] : []),
    stop: async (name) => { progState.running = false; return status(name); },
    remove: async () => { progState.running = false; progState.registered = false; }
  };
  function status(name) {
    return { name, registered: progState.registered, running: progState.running, pid: progState.running ? 4242 : null,
      startedAt: progState.running ? 1 : null, outliveApp: progState.spec ? progState.spec.outliveApp !== false : true,
      logPath: FILES_ROOT + "/logs/" + name + ".log" };
  }
  // The slskd tool as api.system.getDependency reports it. `o.tool` seeds it
  // (default: defined, not installed); `requestAction("require-dependency")`
  // installs it as Viboplr's copy unless `o.installTool === false` (the user
  // closed the dialog).
  const toolState = { slskd: o.tool !== undefined ? o.tool : { name: "slskd", installed: false, version: null, origin: null, latest: "0.26.1" } };
  const installTool = () => {
    if (o.installTool === false || !toolState.slskd) return;
    toolState.slskd = { name: "slskd", installed: true, version: "0.26.1", origin: "managed", latest: "0.26.1" };
  };
  // Handlers the plugin gave programs.onAppQuitting.
  const quitHandlers = [];
  const programs = { onAppQuitting: o.noQuitHook ? undefined : (fn) => { quitHandlers.push(fn); return () => {}; } };
  for (const op of Object.keys(programsDefaults)) {
    programs[op] = async (...args) => {
      calls.programs.push({ op, args });
      const impl = (o.programs && o.programs[op]) || programsDefaults[op];
      return impl(...args);
    };
  }
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
      delete: async (k) => { delete store[k]; },
      files: filesApi
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
      setViewData: (viewId, data, opts) => calls.views.push({ viewId, data, opts: opts || {} }),
      // `notifications` keeps the text (what most tests read); `notices` keeps
      // the options too, for the warning's one-click action.
      showNotification: (m, options) => {
        calls.notifications.push(m);
        calls.notices.push({ message: m, options: options });
      },
      onAction: (id, fn) => { actions[id] = fn; },
      navigateToView: (v) => calls.navigated.push(v),
      requestAction: (a, p) => {
        calls.requestAction.push({ action: a, payload: p });
        if (a === "require-dependency" && p && p.name === "slskd") installTool();
      },
      setBadge: (v, b) => calls.badges.push(b),
      // Absent when a test asks for an older host (`noViewHeader: true`).
      setViewHeader: o.noViewHeader ? undefined : (v, h) => calls.headers.push({ viewId: v, header: h }),
      // Absent on a host that can't install programs (`o.noPrograms`).
      pickFolder: o.noPrograms ? undefined : async () => (o.pickFolder !== undefined ? o.pickFolder : "/Users/me/Music/Soulseek")
    },
    playback: {
      onResolveStreamByUri: (scheme, fn) => { resolvers["stream:" + scheme] = fn; },
      onStreamResolve: (id, fn) => { resolvers["meta:" + id] = fn; },
      playTrack: (t) => calls.played.push(t),
      playTracks: (ts) => calls.played.push(...ts)
    },
    downloads: {
      onResolveByUri: (id, fn) => { resolvers["download:" + id] = fn; },
      onResolveByMetadata: (id, fn) => { resolvers["download-meta:" + id] = fn; },
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
      ftsAlbums: async () => (o.library && o.library.albums) || [],
      // Every track: the plugin does its own exact title/artist match on top,
      // which is the part worth testing.
      ftsTracks: async () => (o.library && o.library.tracks) || []
    },
    // `o.dependencies` = { name: getDependency answer } (absent → null, i.e. a
    // host that doesn't know the binary); `o.exec(program, args, opts)` answers
    // api.system.exec. Every exec is logged in `calls.exec`.
    system: Object.assign(
      {
        readAudioTags: async (paths) => paths.map(() => null),
        openPath: async (p) => { calls.opened.push(["open", p]); },
        revealPath: async (p) => { calls.opened.push(["reveal", p]); }
      },
      o.dependencies || !o.noPrograms ? {
        getDependency: async (name) => {
          if (o.dependencies && o.dependencies[name] !== undefined) return o.dependencies[name];
          if (name === "slskd" && !o.noPrograms) return toolState.slskd;
          return null;
        }
      } : {},
      // The user's standard folders (`o.noUserFolders` for an older host).
      o.noUserFolders ? {} : { userFolders: async () => ({ home: "/Users/me", downloads: "/Users/me/Downloads", music: "/Users/me/Music" }) },
      o.exec ? {
        exec: async (program, args, execOpts) => {
          calls.exec.push({ program, args });
          return o.exec(program, args, execOpts);
        }
      } : {},
      // A host that can install programs for a plugin (`o.noPrograms` turns
      // it into an older one). `o.platform` defaults to an Apple-silicon Mac.
      o.noPrograms ? {} : {
        platform: async () => o.platform || { os: "macos", arch: "arm64" },
        programs
      }
    ),
    assistant: { onTool: (name, fn) => { tools[name] = fn; } }
  };
  return { api, actions, tools, resolvers, calls, store, files, progState, toolState, quitHandlers };
}

module.exports = { fakeHost };
