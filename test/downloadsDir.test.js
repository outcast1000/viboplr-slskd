const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { fakeHost } = require("./harness/host");

// slskd answers GET /api/v0/options to administrators only; the API key the
// install writes (role readwrite) gets a 403. Without a fallback every
// finished download waited forever for a folder it would never learn.

const optionsRefused = (sessionOk, seen) => async (url, init) => {
  const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  const auth = init && init.headers && init.headers.Authorization;
  if (path === "/api/v0/options") {
    seen.push(auth ? "bearer" : "key");
    if (auth === "Bearer jwt") {
      return { status: 200, text: async () => JSON.stringify({ directories: { downloads: "D:\\slskd\\downloads", incomplete: "D:\\slskd\\incomplete" } }) };
    }
    return { status: 403, text: async () => "" };
  }
  if (path === "/api/v0/session") {
    return sessionOk ? { status: 200, text: async () => JSON.stringify({ token: "jwt" }) } : { status: 401, text: async () => "" };
  }
  return undefined;
};

async function withPlugin(opts, fn) {
  const p = loadPlugin();
  const h = fakeHost(opts);
  await p.activate(h.api);
  try {
    await fn(p, h);
  } finally {
    p.deactivate();
  }
}

test("downloads folder: a key slskd refuses /options to falls back to the web sign-in", async () => {
  const seen = [];
  await withPlugin({ fetch: optionsRefused(true, seen) }, async (p, h) => {
    await p._loadDownloadsDir();
    const status = await h.tools.status({});
    assert.equal(status.downloadsFolder, "D:\\slskd\\downloads");
    assert.deepEqual(seen.slice(0, 2), ["key", "bearer"]);
  });
});

test("downloads folder: the slskd this plugin installed falls back to the folder it wrote", async () => {
  await withPlugin({
    fetch: optionsRefused(false, []),
    store: {
      managedBy: "plugin",
      managedSlskd: { source: "host", port: 5030, webUsername: "viboplr", webPassword: "w".repeat(24), downloadsDir: "D:\\@Temp\\soulseek\\downloads", installedAt: 1 }
    },
    progState: { registered: true, running: true }
  }, async (p, h) => {
    await p._loadDownloadsDir();
    const status = await h.tools.status({});
    assert.equal(status.downloadsFolder, "D:\\@Temp\\soulseek\\downloads");
  });
});

test("downloads folder: a refused lookup isn't repeated on every poll", async () => {
  const seen = [];
  await withPlugin({ fetch: optionsRefused(false, seen) }, async (p, h) => {
    for (let i = 0; i < 5; i++) await p._loadDownloadsDir();
    const status = await h.tools.status({});
    assert.equal(status.downloadsFolder, null);
    assert.equal(seen.filter((s) => s === "key").length, 1, "asked once, then waits");
  });
});

test("upgradeLine: a finished download still being located says so, not 'queued'", () => {
  const p = loadPlugin();
  const e = {
    state: "downloading", title: "Feuer frei!", target: "flac16", trackId: null, path: null,
    message: "Downloaded — waiting for slskd to say where it saves files",
    active: { username: "peer", filename: "Music\\05 - Feuer frei!.flac", extension: "flac", bitDepth: 16, sampleRate: 44100 }
  };
  const line = p._upgradeLine(e, { state: "Completed, Succeeded", size: 100 }, 0);
  assert.match(line, /waiting for slskd to say where it saves files/);
  assert.doesNotMatch(line, /queued/);
});
