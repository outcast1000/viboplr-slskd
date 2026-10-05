const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { fakeHost } = require("./harness/host");

// --- Automatic upgrades (the Upgrades tab) -----------------------------------
// "Upgrade" on a library track finds, downloads and CHECKS a better copy on its
// own; the user only compares and replaces. The pick is automatic, the replace
// never is.

const plugin = loadPlugin();
const SEP = plugin._KEY_SEP;

const MP3_192 = plugin._libraryQuality({ format: "mp3", file_size: 6336000, duration_secs: 264 });

function cand(o) {
  return Object.assign({
    username: "peer", filename: "m\\Radiohead\\OK Computer\\06 - Karma Police.flac", size: 30e6, length: 264,
    bitRate: null, bitDepth: 16, sampleRate: 44100, isVariableBitRate: false, extension: "flac", qualityTier: 0,
    hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1000, sharerTier: 1, availabilityTier: 0, formatRank: 0
  }, o);
}
const FLAC = cand({});
const MP3_320 = cand({ username: "mp3er", filename: "m\\Radiohead\\06 - Karma Police.mp3", size: 10.5e6, bitRate: 320, bitDepth: null, sampleRate: null, extension: "mp3", qualityTier: 1 });
const MP3_V0 = cand({ username: "vbr", filename: "m\\Radiohead\\06 - Karma Police (V0).mp3", size: 8e6, bitRate: 245, isVariableBitRate: true, bitDepth: null, sampleRate: null, extension: "mp3", qualityTier: 1 });
const OGG_320 = cand({ username: "ogg", filename: "m\\Radiohead\\06 - Karma Police.ogg", size: 10.5e6, bitRate: 320, bitDepth: null, sampleRate: null, extension: "ogg", qualityTier: 1 });
const MP3_192_TWIN = cand({ username: "twin", filename: "m\\Radiohead\\06 - Karma Police (192).mp3", size: 6.3e6, bitRate: 192, bitDepth: null, sampleRate: null, extension: "mp3", qualityTier: 3 });
const LIVE_FLAC = cand({ username: "live", filename: "m\\Radiohead\\06 - Karma Police (Live).flac" });

const ENTRY = (target) => ({ title: "Karma Police", artist: "Radiohead", current: MP3_192, target });

test("meetsQualityTarget: best takes anything, lossless only lossless, MP3 320 / V0 only high-bitrate lossy", () => {
  const m = plugin._meetsQualityTarget;
  assert.equal(m(FLAC, "best"), true);
  assert.equal(m(MP3_320, "best"), true);
  assert.equal(m(FLAC, "lossless"), true);
  assert.equal(m(MP3_320, "lossless"), false);
  assert.equal(m(MP3_320, "high"), true);
  assert.equal(m(MP3_V0, "high"), true, "V0 is high-bitrate");
  assert.equal(m(FLAC, "high"), false, "the size-conscious option skips lossless");
  assert.equal(m(MP3_320, "nonsense"), true, "an unknown value filters nothing");
});

const FLAC_24 = cand({ username: "hires", bitDepth: 24, sampleRate: 96000, size: 120e6 });
const FLAC_NO_DEPTH = cand({ username: "nodepth", bitDepth: null, sampleRate: null });
const ALAC = cand({ username: "alac", filename: "m\\Radiohead\\06 - Karma Police.m4a", extension: "alac" });
const AAC_256 = cand({ username: "aac", filename: "m\\Radiohead\\06 - Karma Police.m4a", size: 8.4e6, bitRate: 256, bitDepth: null, sampleRate: null, extension: "m4a", qualityTier: 1 });

test("meetsQualityTarget: the finer targets — FLAC 16, hi-res, MP3 320, 256 kbps or better", () => {
  const m = plugin._meetsQualityTarget;
  assert.equal(m(FLAC, "flac16"), true);
  assert.equal(m(FLAC_NO_DEPTH, "flac16"), true, "a FLAC with no reported depth is CD quality");
  assert.equal(m(FLAC_24, "flac16"), false, "hi-res is skipped under CD quality");
  assert.equal(m(ALAC, "flac16"), false, "the target names FLAC");
  assert.equal(m(MP3_320, "flac16"), false);

  assert.equal(m(FLAC_24, "hires"), true);
  assert.equal(m(FLAC, "hires"), false);
  assert.equal(m(FLAC_NO_DEPTH, "hires"), false, "hi-res has to be reported, not assumed");

  assert.equal(m(MP3_320, "mp3_320"), true);
  assert.equal(m(Object.assign({}, MP3_320, { bitRate: 318 }), "mp3_320"), true, "a measured 320 lands a little either side");
  assert.equal(m(MP3_V0, "mp3_320"), false, "V0 is not 320");
  assert.equal(m(OGG_320, "mp3_320"), false);

  assert.equal(m(AAC_256, "lossy256"), true);
  assert.equal(m(MP3_V0, "lossy256"), true, "V0 counts");
  assert.equal(m(MP3_192_TWIN, "lossy256"), false);
  assert.equal(m(FLAC, "lossy256"), false, "lossless is skipped");
});

test("rankUpgrade: FLAC 16 picks the CD-quality FLAC and offers hi-res as the alternative", () => {
  const r = plugin._rankUpgrade([FLAC_24, MP3_320, FLAC, ALAC], ENTRY("flac16"));
  assert.deepEqual(r.picks.map((c) => c.username), ["peer"]);
  assert.equal(r.alternative.username, "hires", "the best better copy it ruled out");

  const any = plugin._rankUpgrade([ALAC, FLAC], ENTRY("lossless"));
  assert.deepEqual(any.picks.map((c) => c.username), ["peer", "alac"], "FLAC leads its tier under Any lossless");
});

test("the default Upgrade target is FLAC 16", () => {
  assert.equal(plugin._upgradeTargetOf(undefined), "flac16");
  assert.equal(plugin._upgradeTargetOf("nonsense"), "flac16");
  assert.equal(plugin._upgradeTargetOf("hires"), "hires");
});

// --- slskd on Windows ---------------------------------------------------------
// slskd rejects a download whose partial-file path Windows would normalize —
// any segment ending in a dot or a space — with "Only absolute paths may be
// specified (Parameter 'filename')". Such files are dropped, on Windows only.

test("windowsCantStore: a trailing dot or space in the sharer's name or any folder", () => {
  const w = plugin._windowsCantStore;
  assert.equal(w("peer", "@@abcde\\Music\\R.E.M.\\Automatic\\01 Drive.flac"), true, "R.E.M.");
  assert.equal(w("peer", "Music\\Greatest Hits Vol. 2 \\01.mp3"), true, "a trailing space");
  assert.equal(w("john.", "Music\\Album\\01.mp3"), true, "the sharer's name is a folder too");
  assert.equal(w("peer", "C:\\Music\\...And Justice for All\\01 Blackened.flac"), false, "leading dots are fine");
  assert.equal(w("peer", "Music\\.\\Album\\01.mp3"), false, "slskd turns a lone dot into _");
  assert.equal(w("peer", "Music\\Why?\\01.mp3"), false, "an invalid character becomes _");
  assert.equal(plugin._isWindowsPathBug("Only absolute paths may be specified (Parameter 'filename')"), true);
  assert.equal(plugin._isWindowsPathBug("Transfer rejected: Banned"), false);
});

// The same error with no bad segment at all: slskd's own incomplete folder is
// mixed (`…\Soulseek/.incomplete`), so every download fails whatever the source.
test("misconfiguredSlskdDir: a Windows slskd folder with a forward slash in it", () => {
  const m = plugin._misconfiguredSlskdDir;
  const dl = "C:\\Users\\x\\Music\\Soulseek";
  assert.equal(m(dl, dl + "/.incomplete"), dl + "/.incomplete", "the incomplete folder is the one slskd checks");
  assert.equal(m("C:/Users/x/Music", "C:\\Users\\x\\Music\\.incomplete"), "C:/Users/x/Music", "all-forward counts too");
  assert.equal(m("\\\\nas\\music", "\\\\nas\\music/.incomplete"), "\\\\nas\\music/.incomplete", "UNC");
  assert.equal(m(dl, dl + "\\.incomplete"), null, "normalized is fine");
  assert.equal(m("/home/x/Music", "/home/x/Music/.incomplete"), null, "not Windows");
  assert.equal(m(null, null), null, "not read yet");
});

test("rankResults drops files a Windows slskd can't store, and only on Windows", () => {
  const responses = [
    { username: "peer", hasFreeUploadSlot: true, files: [
      { filename: "Music\\R.E.M.\\Automatic for the People\\01 Drive.flac", size: 3e7, extension: "flac" },
      { filename: "Music\\REM\\Automatic for the People\\01 Drive.flac", size: 3e7, extension: "flac" }
    ] }
  ];
  const win = plugin._rankResults(responses, { windowsDaemon: true });
  assert.deepEqual(win.map((c) => c.filename), ["Music\\REM\\Automatic for the People\\01 Drive.flac"]);
  assert.equal(plugin._rankResults(responses, {}).length, 2);
});

test("rankUpgrade: same recording, better than the copy, at the target — best first; the rest become the alternative", () => {
  const all = [MP3_192_TWIN, OGG_320, MP3_320, LIVE_FLAC, FLAC, MP3_V0];

  const best = plugin._rankUpgrade(all, ENTRY("best"));
  assert.deepEqual(best.picks.map((c) => c.username), ["peer", "mp3er", "ogg", "vbr"], "lossless, then the highest rate; the twin and the live take are out");
  assert.equal(best.alternative, null);

  const lossless = plugin._rankUpgrade(all, ENTRY("lossless"));
  assert.deepEqual(lossless.picks.map((c) => c.username), ["peer"]);
  assert.equal(lossless.alternative.username, "mp3er", "the best better copy that isn't lossless");

  const high = plugin._rankUpgrade(all, ENTRY("high"));
  assert.deepEqual(high.picks.map((c) => c.username), ["mp3er", "vbr", "ogg"], "MP3 leads the tier, 320 before V0");
  assert.equal(high.alternative.username, "peer");

  const none = plugin._rankUpgrade([MP3_192_TWIN], ENTRY("best"));
  assert.equal(none.picks.length, 0);
  assert.equal(none.alternative, null);
  assert.equal(none.matched, 1);
  assert.equal(none.better, 0);
});

test("rankUpgrade: a proven sharer beats an unknown one at the same quality", () => {
  const unknown = cand({ username: "unknown", sharerTier: 1 });
  const proven = cand({ username: "proven", sharerTier: 0, filename: "m\\Radiohead\\Karma Police.flac" });
  assert.equal(plugin._rankUpgrade([unknown, proven], ENTRY("best")).picks[0].username, "proven");
});

test("checkUpgrade: the finished file must be what it claimed, better than the copy, and at the target", () => {
  const check = plugin._checkUpgrade;
  const measure = plugin._measuredQuality;
  // 10.5 MB over 264 s ≈ 318 kbps: an honest 320.
  assert.equal(check(ENTRY("best"), MP3_320, measure(MP3_320, 10.5e6, 264)).ok, true);
  // "320" that is 4.2 MB over 264 s ≈ 127 kbps.
  const liar = check(ENTRY("best"), MP3_320, measure(MP3_320, 4.2e6, 264));
  assert.equal(liar.ok, false);
  assert.ok(liar.note.includes("advertised 320 kbps, measured ≈127 kbps"), liar.note);
  // Honestly labelled, but no better than the copy in hand.
  const same = cand({ extension: "mp3", qualityTier: 3, bitRate: 200 });
  assert.equal(check(ENTRY("best"), same, measure(same, 6.6e6, 264)).ok, false);
  // Lossless takes its figures from the sharer; the container decides the tier.
  assert.equal(check(ENTRY("lossless"), FLAC, measure(FLAC, 30e6, 264)).ok, true);
  assert.equal(check(ENTRY("high"), FLAC, measure(FLAC, 30e6, 264)).ok, false, "below the target");
  // Unmeasurable (no duration) passes to the compare step, with a note.
  const blind = check(ENTRY("best"), MP3_320, null);
  assert.equal(blind.ok, true);
  assert.ok(/couldn't measure/.test(blind.note));
});

test("upgradeRowActions: only what does something to that upgrade", () => {
  const a = plugin._upgradeRowActions;
  const cands = [{ username: "a", filename: "x" }, { username: "b", filename: "y" }];
  // Try another sharer and Choose myself… are on the panel (Details), not the rows.
  assert.deepEqual(a({ state: "ready" }), ["upgrade-show", "upgrade-replace", "upgrade-remove"]);
  assert.deepEqual(a({ state: "alternative" }), ["upgrade-show", "upgrade-take-alternative", "upgrade-retry", "upgrade-remove"]);
  assert.deepEqual(a({ state: "searching" }), ["upgrade-show", "upgrade-cancel", "upgrade-remove"]);
  assert.deepEqual(a({ state: "downloading", candidates: cands, triedUsers: ["a"] }),
    ["upgrade-show", "upgrade-cancel", "upgrade-remove"]);
  assert.deepEqual(a({ state: "none" }), ["upgrade-show", "upgrade-retry", "upgrade-remove"]);
  assert.deepEqual(a({ state: "cancelled" }), ["upgrade-show", "upgrade-retry", "upgrade-remove"]);
  assert.deepEqual(a({ state: "replaced" }), ["upgrade-remove"]);
  assert.deepEqual(a({ state: "gone" }), ["upgrade-remove"], "nothing left to upgrade or retry");
});

// --- the flow ------------------------------------------------------------------

const LIBRARY_MP3 = {
  id: 42, path: "file:///Users/me/Music/RH/06 Karma Police.mp3", title: "Karma Police", artist_name: "Radiohead",
  album_id: 7, album_title: "OK Computer", track_number: 6, format: "mp3", file_size: 6336000, duration_secs: 264
};

// A scripted slskd. `responses` is the search's answer. `states[user]` is the
// sequence a transfer from that user walks through, one step per transfer
// poll; `bytes[user]` how much of it has arrived while InProgress.
function upgradeHost(o) {
  const calls = { batches: [], cancels: [] };
  const live = {};  // username -> { file, polls }
  const library = { tracks: [Object.assign({}, LIBRARY_MP3)] };
  const h = fakeHost({
    store: Object.assign({ upgradeTarget: o.target || "best" }, o.store || {}),
    library,
    fetch: async (url, init) => {
      const json = (v, status) => ({ status: status || 200, text: async () => JSON.stringify(v) });
      const method = (init && init.method) || "GET";
      if (url.includes("/api/v0/searches") && method === "POST") return json({ id: "s1" });
      if (url.includes("/api/v0/searches/s1") && method === "PUT") return json({});
      if (url.includes("/responses")) return json(o.responses);
      if (url.includes("/api/v0/searches/s1")) return json({ id: "s1", state: "Completed, ResponseLimitReached", responseCount: 1, fileCount: 3 });
      if (url.includes("/api/v0/transfers/downloads/batches") && method === "POST") {
        const b = JSON.parse(init.body);
        calls.batches.push(b);
        live[b.username] = { file: b.files[0], polls: 0 };
        return json({ failures: [] });
      }
      if (url.endsWith("/api/v0/transfers/downloads") && method === "GET") {
        const users = Object.keys(live).map((u) => {
          const seq = (o.states && o.states[u]) || ["Queued, Remotely", "InProgress", "Completed, Succeeded"];
          const state = seq[Math.min(live[u].polls++, seq.length - 1)];
          const f = live[u].file;
          return { username: u, directories: [{ files: [{
            id: "t-" + u, username: u, filename: f.filename, size: f.size, state,
            bytesTransferred: state === "InProgress" ? ((o.bytes && o.bytes[u]) != null ? o.bytes[u] : 1000) : (state.includes("Succeeded") ? f.size : 0)
          }] }] };
        });
        return json(users);
      }
      if (url.includes("/api/v0/files/downloads/directories/") && method === "GET") {
        const names = Object.keys(live).map((u) => live[u].file.filename.split("\\").pop());
        return json({ files: names.map((n) => ({ name: n, fullName: n, length: 1 })), directories: [] });
      }
      if (url.includes("/api/v0/transfers/downloads/") && method === "DELETE") {
        const user = decodeURIComponent(url.split("/api/v0/transfers/downloads/")[1].split("/")[0]);
        calls.cancels.push(user);
        delete live[user];
        return { status: 200, text: async () => "" };
      }
      return undefined;
    }
  });
  // Real durations for whatever finished: what the host's tag reader returns.
  h.api.system.readAudioTags = async (paths) => paths.map(() => ({ title: null, artist: null, album_artist: null, album: null, track_number: null, disc_number: null, year: null, genre: null, duration_secs: 264 }));
  return { h, calls, library };
}

async function waitFor(pred, ms, what) {
  const until = Date.now() + (ms || 8000);
  while (Date.now() < until) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting" + (what ? " for " + what : ""));
}

function lastView(h) {
  const views = h.calls.views.filter((v) => v.viewId === "slskd-browse");
  return views[views.length - 1].data;
}

function findNodes(node, pred, out) {
  out = out || [];
  if (!node) return out;
  if (pred(node)) out.push(node);
  (node.children || []).forEach((c) => findNodes(c, pred, out));
  return out;
}

// Polls until `pred` or a cap — each poll is one step of the scripted slskd.
async function pollUntil(p, pred, what) {
  for (let i = 0; i < 40; i++) {
    if (pred()) return;
    await p._refreshTransfers();
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("never reached: " + what);
}

const entryOf = (p) => p._upgrades()["t42"];

test("integration (older host): Upgrade opens the Upgrades tab, finds, downloads and checks a better copy, then hands the compare dialog the row to replace", async () => {
  const p = loadPlugin();
  const { h, calls, library } = upgradeHost({
    responses: [
      { username: "peer", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1000, files: [
        { filename: "m\\Radiohead\\06 - Karma Police.flac", size: 30e6, length: 264, bitDepth: 16, sampleRate: 44100 },
        { filename: "m\\Radiohead\\06 - Karma Police (192).mp3", size: 6.3e6, length: 264, bitRate: 192 }] }
    ]
  });
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-upgrade"]({ kind: "track", trackId: 42, title: "Karma Police", artistName: "Radiohead" });
    assert.deepEqual(h.calls.navigated, ["slskd-browse"], "the click lands on the plugin's view");
    const tabs = findNodes(lastView(h), (n) => n.type === "tabs")[0];
    assert.equal(tabs.activeTab, "upgrades", "…on the Upgrades tab");
    assert.ok(findNodes(lastView(h), (n) => n.type === "section" && n.title === "Upgrading").length, "with this track's panel on top");
    assert.ok(!h.calls.notices.some((n) => /Looking for a better copy/.test(n.message)), "no toast — the view already says it");

    await waitFor(() => entryOf(p) && entryOf(p).state === "downloading", 8000, "the download to start");
    assert.equal(calls.batches.length, 1);
    assert.equal(calls.batches[0].username, "peer");
    assert.deepEqual(calls.batches[0].files.map((f) => f.filename), ["m\\Radiohead\\06 - Karma Police.flac"]);
    assert.ok(calls.batches[0].options.destination.startsWith("viboplr/upgrades/"), calls.batches[0].options.destination);

    await pollUntil(p, () => entryOf(p).state === "ready", "ready");
    const e = entryOf(p);
    assert.equal(e.file.quality.extension, "flac");
    const ready = h.calls.notices.find((n) => /is ready/.test(n.message));
    assert.ok(ready, h.calls.notifications.join(" | "));
    assert.equal(ready.options.action.id, "upgrade-replace-notice");
    assert.ok(!h.calls.notifications.some((m) => /choose Replace in library on the Downloads tab/.test(m)), "the generic completion toast stays quiet");
    assert.ok(h.store.upgrades.t42, "persisted");

    // The Upgrades tab lists it, with Compare & replace.
    h.actions["main-tab"]({ tabId: "upgrades" });
    const list = findNodes(lastView(h), (n) => n.type === "track-row-list")[0];
    assert.equal(list.items.length, 1);
    assert.ok(list.items[0].subtitle.startsWith("Ready: FLAC"), list.items[0].subtitle);
    assert.deepEqual(list.items[0].actions, ["upgrade-show", "upgrade-replace", "upgrade-remove"]);

    h.actions["upgrade-replace-notice"]();
    assert.equal(h.calls.requestAction.length, 1);
    const r = h.calls.requestAction[0];
    assert.equal(r.action, "download-tracks");
    assert.equal(r.payload.tracks[0].libraryTrackId, 42);
    assert.equal(r.payload.tracks[0].uri, "slsk://peer" + SEP + "m\\Radiohead\\06 - Karma Police.flac");

    // The user confirmed in the dialog: the library row now points at the new file.
    library.tracks[0].path = "file:///Users/me/Music/RH/06 Karma Police.flac";
    library.tracks[0].file_size = 30e6;
    await pollUntil(p, () => entryOf(p).state === "replaced", "replaced");
  } finally {
    p.deactivate();
  }
});

const KARMA_FLAC = [
  { username: "peer", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1000, files: [
    { filename: "m\\Radiohead\\06 - Karma Police.flac", size: 30e6, length: 264, bitDepth: 16, sampleRate: 44100 }] }
];

// A host with api.library.replaceTrackFile: its Replace dialog answers `answers`
// in turn ("replaced" / "declined" / an Error to throw).
function replacingHost(answers) {
  const made = upgradeHost({ responses: KARMA_FLAC });
  const asked = [];
  made.h.api.library.replaceTrackFile = async (req) => {
    asked.push(req);
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return a === "replaced"
      ? { status: "replaced", trackId: req.trackId, path: "/Users/me/Music/RH/06 Karma Police.flac", previousPath: "/Users/me/Music/RH/06 Karma Police.mp3" }
      : { status: "declined" };
  };
  return Object.assign(made, { asked });
}

test("integration: once the file checks out, the host's Replace dialog is asked straight away — one question, then replaced", async () => {
  const p = loadPlugin();
  const { h, asked } = replacingHost(["replaced"]);
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-upgrade"]({ kind: "track", trackId: 42, title: "Karma Police", artistName: "Radiohead" });
    await waitFor(() => entryOf(p) && entryOf(p).state === "downloading", 8000, "the download to start");
    await pollUntil(p, () => asked.length === 1, "the Replace dialog");
    assert.equal(asked[0].trackId, 42);
    assert.ok(/06 - Karma Police\.flac$/.test(asked[0].path) || /Karma Police\.flac$/.test(asked[0].path), asked[0].path);
    assert.equal(asked[0].source, "peer on Soulseek");
    await waitFor(() => entryOf(p).state === "replaced", 2000, "replaced");
    assert.ok(!h.calls.notices.some((n) => /is ready/.test(n.message)), "no ready toast — the dialog is the question");
    assert.equal(h.calls.requestAction.length, 0, "no download modal on the way");
    assert.equal(h.store.upgrades.t42.state, "replaced", "persisted");
  } finally {
    p.deactivate();
  }
});

test("integration: Keep current leaves the upgrade ready with Replace…, which asks again", async () => {
  const p = loadPlugin();
  const { h, asked } = replacingHost(["declined", "replaced"]);
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-upgrade"]({ kind: "track", trackId: 42 });
    await waitFor(() => entryOf(p) && entryOf(p).state === "downloading", 8000, "the download to start");
    await pollUntil(p, () => asked.length === 1, "the first dialog");
    await waitFor(() => entryOf(p).state === "ready" && !findNodes(lastView(h), (n) => n.type === "text" && /waiting for your answer/i.test(n.content || "")).length, 2000, "the dialog to close");
    const replace = findNodes(lastView(h), (n) => n.type === "button" && n.action === "upgrade-replace")[0];
    assert.ok(replace, "the panel offers Replace…");
    assert.equal(replace.label, "Replace…");
    h.actions["upgrade-replace"](replace.data);
    await waitFor(() => entryOf(p).state === "replaced", 2000, "replaced on the second ask");
    assert.equal(asked.length, 2);
  } finally {
    p.deactivate();
  }
});

test("integration: a swap that fails says so on the upgrade and keeps it ready", async () => {
  const p = loadPlugin();
  const { h, asked } = replacingHost([new Error("the file is open in another program")]);
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-upgrade"]({ kind: "track", trackId: 42 });
    await waitFor(() => entryOf(p) && entryOf(p).state === "downloading", 8000, "the download to start");
    await pollUntil(p, () => asked.length === 1, "the dialog");
    await waitFor(() => /Replace failed: the file is open/.test(entryOf(p).message || ""), 2000, "the failure");
    assert.equal(entryOf(p).state, "ready");
  } finally {
    p.deactivate();
  }
});

test("integration: an assistant's upgrade never raises the dialog — its caller replaces", async () => {
  const p = loadPlugin();
  const { h, asked } = replacingHost(["replaced"]);
  await p.activate(h.api);
  try {
    await h.tools.upgrade({ trackId: 42 });
    await waitFor(() => entryOf(p) && entryOf(p).state === "downloading", 8000, "the download to start");
    assert.equal(h.calls.navigated.length, 0, "the view isn't pulled open for an assistant");
    await pollUntil(p, () => entryOf(p).state === "ready", "ready");
    assert.equal(asked.length, 0);
  } finally {
    p.deactivate();
  }
});

test("the Upgrades panel shows the file you have, the file it is fetching and the file that replaces yours", () => {
  const key = (s) => "x" + s;
  const base = { trackId: 42, title: "Sultans of Swing", artist: "Dire Straits", target: "flac16",
    path: "file://C:/Music/DS/Sultans of Swing.mp3", currentLabel: "MP3 ≈192kbps · 7.9 MB", triedUsers: ["peer"] };
  const text = (n) => JSON.stringify(n);

  const downloading = plugin._upgradePanel(Object.assign({}, base, { state: "downloading",
    active: { username: "peer", filename: "m\\DS\\03 - Sultans of Swing.flac", size: 38e6, extension: "flac", qualityTier: 0, bitDepth: 16, sampleRate: 44100 } }),
    { state: "InProgress", size: 38e6, bytesTransferred: 19e6, averageSpeed: 500000 }, true, false, true);
  assert.match(text(downloading), /"Your copy".*"MP3 ≈192kbps · 7\.9 MB"/, "your copy, next to the one on its way");
  assert.match(text(downloading), /C:\\\\Music\\\\DS\\\\Sultans of Swing\.mp3/, "the library file, as a Windows path");
  assert.match(text(downloading), /Downloading “03 - Sultans of Swing\.flac”/);
  assert.match(text(downloading), /from peer/);
  assert.equal(findNodes(downloading, (n) => n.type === "progress-bar")[0].value, 50);
  assert.match(text(downloading), /✓ Search   ─   ● Download 50%   ─   ○ Check   ─   ○ Replace/, "the steps");
  const dButtons = findNodes(downloading, (n) => n.type === "button").map((b) => b.label);
  assert.equal(dButtons[dButtons.length - 1], "Cancel upgrade", "Cancel last, apart from the ways forward");

  const ready = plugin._upgradePanel(Object.assign({}, base, { state: "ready",
    file: { path: "/slskd/downloads/viboplr/upgrades/1/03 - Sultans of Swing.flac", size: 38e6, quality: { extension: "flac", qualityTier: 0, bitDepth: 16, sampleRate: 44100 } } }),
    null, true, false, true);
  assert.match(text(ready), /Ready: FLAC/);
  assert.match(text(ready), /upgrades\/1\/03 - Sultans of Swing\.flac/, "the file that will replace yours");
  assert.equal(findNodes(ready, (n) => n.type === "button")[0].label, "Replace…");

  const asking = plugin._upgradePanel(Object.assign({}, base, { state: "ready", file: { path: "/x.flac", quality: { extension: "flac", qualityTier: 0 } } }), null, true, true, true);
  assert.match(text(asking), /Waiting for your answer/);
  assert.equal(findNodes(asking, (n) => n.type === "button").length, 0, "no second Replace while the dialog is up");

  const waiting = plugin._upgradePanel(Object.assign({}, base, { state: "searching" }), null, false, false, true);
  assert.match(text(waiting), /Waiting for slskd/);
  void key;
});

test("the panel follows the upgrade started here, else the newest one still going", () => {
  const all = {
    t1: { trackId: 1, state: "replaced", createdAt: 30 },
    t2: { trackId: 2, state: "downloading", createdAt: 10 },
    t3: { trackId: 3, state: "ready", createdAt: 20 }
  };
  assert.equal(plugin._panelUpgrade(all, "t1").trackId, 1, "the one started here, even once done");
  assert.equal(plugin._panelUpgrade(all, null).trackId, 3, "else the newest in progress or waiting on you");
  assert.equal(plugin._panelUpgrade({ t1: all.t1 }, "gone"), null, "nothing in flight → no panel");
});

test("integration: a file that isn't what it claimed is rejected after download and the next sharer is asked", async () => {
  const p = loadPlugin();
  const { h, calls } = upgradeHost({
    responses: [
      // Advertised 320 but 4.2 MB over 264 s — really ~127 kbps. Ranked first (free slot, faster).
      { username: "liar", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 9000, files: [
        { filename: "m\\Radiohead\\06 - Karma Police.mp3", size: 4.2e6, length: 264, bitRate: 320 }] },
      { username: "honest", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 10, files: [
        { filename: "x\\Radiohead - Karma Police.mp3", size: 10.5e6, length: 264, bitRate: 320 }] }
    ]
  });
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-upgrade"]({ kind: "track", trackId: 42 });
    await waitFor(() => entryOf(p) && entryOf(p).state === "downloading", 8000, "the download to start");
    assert.equal(calls.batches[0].username, "liar");
    await pollUntil(p, () => calls.batches.length === 2, "the second sharer");
    assert.equal(calls.batches[1].username, "honest");
    const rejectedKey = "liar" + SEP + "m\\Radiohead\\06 - Karma Police.mp3";
    assert.equal(h.store.tracked[rejectedKey].upgrade, undefined, "the rejected file is no longer offered as a replacement");
    assert.ok(h.store.tracked[rejectedKey], "…but it stays — the plugin deletes only fallback files");
    await pollUntil(p, () => entryOf(p).state === "ready", "ready");
    assert.equal(entryOf(p).file.key, "honest" + SEP + "x\\Radiohead - Karma Police.mp3");
  } finally {
    p.deactivate();
  }
});

test("integration: a sharer who sends nothing is dropped after the stall time for the next one", async () => {
  const p = loadPlugin();
  const { h, calls } = upgradeHost({
    responses: [
      { username: "stuck", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 9000, files: [
        { filename: "m\\Radiohead\\06 - Karma Police.flac", size: 30e6, length: 264, bitDepth: 16 }] },
      { username: "other", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 10, files: [
        { filename: "y\\Radiohead\\06 Karma Police.flac", size: 29e6, length: 264, bitDepth: 16 }] }
    ],
    states: { stuck: ["Queued, Remotely"] }
  });
  p._setUpgradeTimings(30000, 50);
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-upgrade"]({ kind: "track", trackId: 42 });
    await waitFor(() => entryOf(p) && entryOf(p).state === "downloading", 8000, "the download to start");
    assert.equal(calls.batches[0].username, "stuck");
    await new Promise((r) => setTimeout(r, 80));
    await pollUntil(p, () => calls.batches.length === 2, "the next sharer");
    assert.ok(calls.cancels.includes("stuck"), "the stalled transfer was cancelled in slskd");
    assert.equal(calls.batches[1].username, "other");
    assert.equal(h.store.sharers.stuck.stalled, 1, "the ledger remembers the stall");
  } finally {
    p.deactivate();
  }
});

test("integration: nothing at the target → the best better copy is offered; Take it downloads that one", async () => {
  const p = loadPlugin();
  const { h, calls } = upgradeHost({
    target: "lossless",
    responses: [
      { username: "mp3er", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 100, files: [
        { filename: "m\\Radiohead\\06 - Karma Police.mp3", size: 10.5e6, length: 264, bitRate: 320 }] }
    ]
  });
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-upgrade"]({ kind: "track", trackId: 42 });
    await waitFor(() => entryOf(p) && entryOf(p).state === "alternative", 8000, "the alternative");
    assert.equal(calls.batches.length, 0, "nothing downloaded that misses the target");
    assert.ok(/No copy at Any lossless found; best better copy is MP3 320kbps/.test(entryOf(p).message), entryOf(p).message);

    await h.actions["upgrade-take-alternative"]({ itemId: "t42" });
    await waitFor(() => calls.batches.length === 1, 2000, "the alternative's download");
    assert.equal(calls.batches[0].username, "mp3er");
    await pollUntil(p, () => entryOf(p).state === "ready", "ready");
  } finally {
    p.deactivate();
  }
});

test("integration: cancelling the download in Downloads stops the upgrade rather than trying the next sharer", async () => {
  const p = loadPlugin();
  const { h, calls } = upgradeHost({
    responses: [
      { username: "a", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 100, files: [{ filename: "m\\Radiohead\\06 - Karma Police.flac", size: 30e6, length: 264 }] },
      { username: "b", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 10, files: [{ filename: "n\\Radiohead\\06 - Karma Police.flac", size: 30e6, length: 264 }] }
    ],
    states: { a: ["Queued, Remotely", "Completed, Cancelled"] }
  });
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-upgrade"]({ kind: "track", trackId: 42 });
    await waitFor(() => entryOf(p) && entryOf(p).state === "downloading", 8000, "the download to start");
    await pollUntil(p, () => entryOf(p).state === "failed", "stopped");
    assert.equal(entryOf(p).message, "Download cancelled");
    assert.equal(calls.batches.length, 1);
  } finally {
    p.deactivate();
  }
});

const TWO_SHARERS = [
  { username: "a", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 100, files: [{ filename: "m\\Radiohead\\06 - Karma Police.flac", size: 30e6, length: 264, bitDepth: 16 }] },
  { username: "b", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 10, files: [{ filename: "n\\Radiohead\\06 - Karma Police.flac", size: 29e6, length: 264, bitDepth: 16 }] }
];

test("integration: Cancel on a queued upgrade stops it in slskd and rests it, ready for Search again", async () => {
  const p = loadPlugin();
  const { h, calls } = upgradeHost({ responses: TWO_SHARERS, states: { a: ["Queued, Remotely"] } });
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-upgrade"]({ kind: "track", trackId: 42 });
    await waitFor(() => entryOf(p) && entryOf(p).state === "downloading", 8000, "the download to start");
    await p._refreshTransfers();
    const cancel = findNodes(lastView(h), (n) => n.type === "button" && n.action === "upgrade-cancel")[0];
    assert.ok(cancel, "the panel offers Cancel while it is queued");
    h.actions["upgrade-cancel"](cancel.data);
    await waitFor(() => entryOf(p).state === "cancelled", 2000, "cancelled");
    assert.deepEqual(calls.cancels, ["a"], "the transfer is cancelled in slskd");
    assert.equal(calls.batches.length, 1, "no next sharer is asked");
    assert.equal(h.store.tracked["a" + SEP + "m\\Radiohead\\06 - Karma Police.flac"], undefined, "its record is forgotten");
    assert.equal(h.store.sharers && h.store.sharers.a && h.store.sharers.a.stalled, undefined, "the sharer isn't blamed for the user's cancel");
    const list = findNodes(lastView(h), (n) => n.type === "track-row-list" && n.items.some((i) => i.id === "t42"))[0];
    assert.ok(list.items[0].actions.includes("upgrade-retry"));
    const sources = findNodes(lastView(h), (n) => n.type === "track-row-list" && n.items.some((i) => i.id === "t42#1"))[0];
    assert.ok(sources, "a cancelled upgrade still offers the sources it found");
  } finally {
    p.deactivate();
  }
});

test("integration: the panel lists the sources found; Use this switches to another sharer at once", async () => {
  const p = loadPlugin();
  const { h, calls } = upgradeHost({ responses: TWO_SHARERS, states: { a: ["Queued, Remotely"] } });
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-upgrade"]({ kind: "track", trackId: 42 });
    await waitFor(() => entryOf(p) && entryOf(p).state === "downloading", 8000, "the download to start");
    await p._refreshTransfers();
    const panel = findNodes(lastView(h), (n) => n.type === "section" && n.title === "Upgrading")[0];
    const sources = findNodes(panel, (n) => n.type === "track-row-list")[0];
    assert.ok(sources, "the sources list");
    assert.equal(sources.items.length, 2);
    assert.match(sources.items[0].subtitle, /^a · .*downloading now/);
    assert.match(sources.items[0].cells.availability, /^a · /, "the sharer column");
    assert.ok(sources.items[0].cells.quality, "the quality column");
    assert.ok(sources.selectable && sources.columns.length, "columns render only on a selectable list");
    assert.deepEqual(sources.items[0].actions, [], "the one downloading can't be picked again");
    assert.deepEqual(sources.items[1].actions, ["upgrade-use-source"]);

    await h.actions["upgrade-use-source"]({ itemId: sources.items[1].id });
    await waitFor(() => calls.batches.length === 2, 2000, "the switch");
    assert.deepEqual(calls.cancels, ["a"], "the first one is cancelled");
    assert.equal(calls.batches[1].username, "b");
    assert.equal(entryOf(p).active.username, "b");
    await pollUntil(p, () => entryOf(p).state === "ready", "ready");
    assert.equal(entryOf(p).file.key, "b" + SEP + "n\\Radiohead\\06 - Karma Police.flac");
  } finally {
    p.deactivate();
  }
});

test("integration: Try another sharer moves on without waiting out the stall timer", async () => {
  const p = loadPlugin();
  const { h, calls } = upgradeHost({ responses: TWO_SHARERS, states: { a: ["Queued, Remotely"] } });
  await p.activate(h.api);
  try {
    await h.actions["ctx:slskd-upgrade"]({ kind: "track", trackId: 42 });
    await waitFor(() => entryOf(p) && entryOf(p).state === "downloading", 8000, "the download to start");
    h.actions["upgrade-skip"]({ itemId: "t42" });
    await waitFor(() => calls.batches.length === 2, 2000, "the next sharer");
    assert.equal(calls.batches[1].username, "b");
    assert.deepEqual(calls.cancels, ["a"]);
    const panel = p._upgradePanel(entryOf(p), null, true, false, true);
    assert.ok(!findNodes(panel, (n) => n.type === "button" && n.action === "upgrade-skip").length, "nobody left to try");
  } finally {
    p.deactivate();
  }
});

test("the Upgrades tab lists what is pending; finished upgrades are folded into History", async () => {
  const p = loadPlugin();
  const done = (id, state) => ({ trackId: id, title: "Song " + id, state, target: "flac16", createdAt: id, currentLabel: "MP3" });
  const { h } = upgradeHost({ responses: [], store: { upgrades: {
    t1: done(1, "replaced"), t2: done(2, "gone"),
    t3: Object.assign(done(3, "none"), { message: "Nothing better" })
  } } });
  await p.activate(h.api);
  try {
    h.actions["main-tab"]({ tabId: "upgrades" });
    let lists = findNodes(lastView(h), (n) => n.type === "track-row-list");
    assert.equal(lists.length, 1, "only the pending list; history folded");
    assert.deepEqual(lists[0].items.map((i) => i.id), ["t3"]);
    assert.ok(findNodes(lastView(h), (n) => n.type === "toolbar" && n.title === "History" && n.status === "2 finished").length);

    h.actions["upgrade-history-toggle"]();
    lists = findNodes(lastView(h), (n) => n.type === "track-row-list");
    assert.equal(lists.length, 2);
    assert.deepEqual(lists[1].items.map((i) => i.id).sort(), ["t1", "t2"]);

    h.actions["upgrade-history-clear"]();
    await waitFor(() => !h.store.upgrades.t1 && !h.store.upgrades.t2, 2000, "history cleared");
    assert.ok(h.store.upgrades.t3, "the pending one stays");
  } finally {
    p.deactivate();
  }
});

test("parseSourceId splits a sources-list row id", () => {
  assert.deepEqual(plugin._parseSourceId("t42#3"), { key: "t42", index: 3 });
  assert.equal(plugin._parseSourceId("t42"), null);
});

test("integration: the Upgrade target is a setting, and Upgrade on a non-library track still falls back to a plain search", async () => {
  const p = loadPlugin();
  const { h } = upgradeHost({ responses: [] });
  await p.activate(h.api);
  try {
    h.actions["main-tab"]({ tabId: "upgrades" });
    const select = findNodes(lastView(h), (n) => n.type === "settings-row" && n.label === "Upgrade to")[0];
    assert.ok(select, "the Upgrades tab shows the target");
    assert.deepEqual(select.control.options.map((o) => o.value), ["flac16", "hires", "lossless", "mp3_320", "high", "lossy256", "best"]);
    h.actions["set-upgrade-target"]({ value: "high" });
    await waitFor(() => h.store.upgradeTarget === "high", 2000, "the setting to save");

    await h.actions["ctx:slskd-upgrade"]({ kind: "track", title: "Unknown", artistName: "Nobody" });
    assert.ok(h.calls.notifications.some((m) => /Upgrade works on tracks in your library/.test(m)));
    assert.equal(Object.keys(p._upgrades()).length, 0);
  } finally {
    p.deactivate();
  }
});

// --- the assistant surface ---------------------------------------------------
// The host's replace_track_file takes a plugin uri. These tools hand one out,
// percent-encoded because a model can't be trusted to echo a NUL back, and the
// download resolver must take that form as readily as the raw key.

const FLAC_AND_TWIN = [
  { username: "peer", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1000, files: [
    { filename: "m\\Radiohead\\06 - Karma Police.flac", size: 30e6, length: 264, bitDepth: 16, sampleRate: 44100 },
    { filename: "m\\Radiohead\\06 - Karma Police (192).mp3", size: 6.3e6, length: 264, bitRate: 192 }] }
];

test("assistant: search upgradeFor returns only better files, download stamps the upgrade, list_downloads hands out a resolvable uri", async () => {
  const p = loadPlugin();
  const { h, calls } = upgradeHost({ responses: FLAC_AND_TWIN });
  await p.activate(h.api);
  try {
    const out = await h.tools.search({ upgradeFor: 42 });
    assert.equal(out.upgradeFor.trackId, 42);
    assert.equal(out.results.length, 1, "the 192 twin is not an upgrade over a 192 copy");
    assert.equal(out.results[0].format, "flac");
    assert.equal(out.results[0].better, true);
    const all = await h.tools.search({ upgradeFor: 42, showAll: true });
    assert.equal(all.results.length, 2);

    await h.tools.download({ ids: [out.results[0].id] });
    assert.equal(calls.batches.length, 1);
    await pollUntil(p, () => Object.values(h.store.tracked || {}).some((r) => r.resolvedPath), "the file to be located");
    const list = await h.tools.list_downloads({});
    const row = list.downloads.find((d) => d.phase === "succeeded");
    assert.ok(row, JSON.stringify(list.downloads));
    assert.equal(row.upgradeFor, 42, "stamped as track 42's upgrade");
    assert.ok(row.uri.startsWith("slsk://"), row.uri);
    assert.ok(!row.uri.includes(SEP), "no raw NUL in an assistant-facing uri");

    const resolved = await h.resolvers["download:slskd-import"](row.uri, "original");
    assert.ok(resolved && resolved.url.startsWith("file://"), JSON.stringify(resolved));
    assert.equal(resolved.metadata.title, "Karma Police", "the library's own metadata rides along");
  } finally {
    p.deactivate();
  }
});

test("assistant: upgrade runs the automatic flow, list_upgrades gives the ready uri, and a replace done through the host is noticed", async () => {
  const p = loadPlugin();
  const { h, library } = upgradeHost({ responses: FLAC_AND_TWIN });
  await p.activate(h.api);
  try {
    const started = await h.tools.upgrade({ trackId: 42 });
    assert.equal(started.started, true);
    assert.equal(started.upgrade.state, "searching");
    const again = await h.tools.upgrade({ trackId: 42 });
    assert.equal(again.started, false, "one upgrade per track");

    await waitFor(() => entryOf(p) && entryOf(p).state === "downloading", 8000, "the download to start");
    await pollUntil(p, () => entryOf(p).state === "ready", "ready");
    const listed = await h.tools.list_upgrades({});
    const u = listed.upgrades[0];
    assert.equal(u.state, "ready");
    assert.ok(u.ready.quality.startsWith("FLAC"), u.ready.quality);
    assert.ok(!u.ready.uri.includes(SEP));
    const resolved = await h.resolvers["download:slskd-import"](u.ready.uri, "original");
    assert.ok(resolved && resolved.url.startsWith("file://"));

    // The host's replace_track_file swapped the file under the same row.
    library.tracks[0].path = "file:///Users/me/Music/RH/06 Karma Police.flac";
    library.tracks[0].file_size = 30e6;
    const after = await h.tools.list_upgrades({});
    assert.equal(after.upgrades[0].state, "replaced");
  } finally {
    p.deactivate();
  }
});

test("sameLibraryPath: a separator-only rewrite is the same file", () => {
  const same = plugin._sameLibraryPath;
  assert.equal(same("file://C:/Music/RH/06.mp3", "file://C:\\Music\\RH\\06.mp3"), true);
  assert.equal(same("file://C:/Music/RH/06.mp3", "file://C:/Music/RH/06.flac"), false);
});

test("assistant: a ready upgrade whose library row vanished is listed as gone, not ready", async () => {
  const p = loadPlugin();
  const { h, library } = upgradeHost({ responses: FLAC_AND_TWIN });
  await p.activate(h.api);
  try {
    await h.tools.upgrade({ trackId: 42 });
    await waitFor(() => entryOf(p) && entryOf(p).state === "downloading", 8000, "the download to start");
    await pollUntil(p, () => entryOf(p).state === "ready", "ready");

    // The host rewrote the stored path's separators only: still the same file.
    library.tracks[0].path = library.tracks[0].path.replace(/\//g, "\\");
    assert.equal((await h.tools.list_upgrades({})).upgrades[0].state, "ready");

    // The row is gone (deleted, or re-keyed by an older host's replace).
    library.tracks.length = 0;
    const u = (await h.tools.list_upgrades({})).upgrades[0];
    assert.equal(u.state, "gone");
    assert.equal(u.ready, null, "no uri offered for a trackId nothing can replace");
    assert.match(u.message, /No longer in your library/);
    assert.equal(h.store.upgrades.t42.state, "gone", "persisted");

    await h.tools.upgrade({ trackId: 42, action: "retry" });
    assert.equal(entryOf(p).state, "gone", "retry does not search for a track that isn't there");
  } finally {
    p.deactivate();
  }
});

test("assistant: a resting upgrade (nothing found) whose library row vanished is listed as gone", async () => {
  const p = loadPlugin();
  const { h, library } = upgradeHost({ responses: [] });
  await p.activate(h.api);
  try {
    await h.tools.upgrade({ trackId: 42 });
    await waitFor(() => entryOf(p) && entryOf(p).state === "none", 8000, "the search to come up empty");
    assert.equal((await h.tools.list_upgrades({})).upgrades[0].state, "none", "row still there");
    library.tracks.length = 0;
    assert.equal((await h.tools.list_upgrades({})).upgrades[0].state, "gone");
  } finally {
    p.deactivate();
  }
});

test("assistant: upgrade refuses a track that isn't a local library file, and unknown actions", async () => {
  const p = loadPlugin();
  const { h, library } = upgradeHost({ responses: [] });
  library.tracks.push({ id: 43, path: "subsonic://1/abc", title: "Remote", artist_name: "X" });
  await p.activate(h.api);
  try {
    await assert.rejects(() => h.tools.upgrade({ trackId: 99 }), /no library track with id 99/);
    await assert.rejects(() => h.tools.upgrade({ trackId: 43 }), /isn't a local file/);
    await assert.rejects(() => h.tools.search({ upgradeFor: 43 }), /isn't a local file/);
    await assert.rejects(() => h.tools.upgrade({ trackId: 42, action: "retry" }), /no upgrade for track 42/);
    await h.tools.upgrade({ trackId: 42 });
    await assert.rejects(() => h.tools.upgrade({ trackId: 42, action: "explode" }), /unknown action/);
    assert.deepEqual(await h.tools.upgrade({ trackId: 42, action: "remove" }), { removed: true, trackId: 42 });
    assert.equal(Object.keys(p._upgrades()).length, 0);
  } finally {
    p.deactivate();
  }
});
