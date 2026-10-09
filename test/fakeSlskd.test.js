// The fake slskd (test/harness/fakeSlskd.js) and its record/replay mode
// (test/harness/slskdRecording.js). Two halves:
//   - the pure parts: deterministic results, transfer timelines, anonymising;
//   - the real plugin driven against the fake over real HTTP, which is the
//     check that the fake answers in shapes the plugin actually reads —
//     including the record → replay round trip.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadPlugin } = require("./harness/sandbox.js");
const { fakeHost } = require("./harness/host");
const { createFakeSlskd, responsesFor, transferAt } = require("./harness/fakeSlskd.js");
const { makeAnonymiser, anonResponse, replaySearchAt, replayTransferAt } = require("./harness/slskdRecording.js");

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), "fake-slskd-" + name + "-"));

// --- generated results -----------------------------------------------------

test("the same query always gets the same results, and every word is in every path", () => {
  const a = responsesFor("Radiohead - Karma Police");
  const b = responsesFor("radiohead - karma police");
  assert.deepEqual(a, b, "case doesn't change the answer");
  assert.notDeepEqual(responsesFor("Björk Jóga"), a);
  for (const r of a) {
    for (const f of r.files.concat(r.lockedFiles)) {
      assert.match(f.filename.toLowerCase(), /radiohead/);
      assert.match(f.filename.toLowerCase(), /karma police/);
      assert.ok(f.size > 0 && f.length > 0);
    }
  }
  assert.ok(a.some((r) => r.lockedFiles.length && !r.files.length), "a sharer with locked files only");
  assert.ok(a.some((r) => !r.hasFreeUploadSlot && r.queueLength > 0), "a busy sharer");
});

test("advertised sizes match the format's bitrate (the upgrade check divides size by duration)", () => {
  for (const r of responsesFor("anything at all")) {
    for (const f of r.files.concat(r.lockedFiles)) {
      const kbps = (f.size * 8) / f.length / 1000;
      if (f.extension === "flac") assert.ok(kbps > 600, f.filename + " reads as " + kbps + " kbps");
      else assert.ok(Math.abs(kbps - f.bitRate) < 2, f.filename + " reads as " + kbps + " kbps");
    }
  }
});

test("transfers follow their sharer's profile", () => {
  const t = (username) => ({ username, size: 10e6 });
  assert.equal(transferAt(t("fake-flac"), 0, "normal", 1).state, "Requested");
  assert.equal(transferAt(t("fake-flac"), 2000, "normal", 1).state, "InProgress");
  assert.equal(transferAt(t("fake-flac"), 60000, "normal", 1).state, "Completed, Succeeded");

  const busy = transferAt(t("fake-busy"), 5000, "normal", 1);
  assert.equal(busy.state, "Queued, Remotely");
  assert.ok(busy.placeInQueue > 1);
  assert.equal(transferAt(t("fake-stalled"), 600000, "normal", 1).state, "Initializing", "never sends a byte");
  assert.equal(transferAt(t("fake-flaky"), 60000, "normal", 1).state, "Completed, Errored");
  assert.equal(transferAt(t("fake-flac"), 60000, "peer-fails", 1).state, "Completed, Errored", "the scenario fails everyone");
  assert.equal(transferAt(t("fake-flac"), 1000, "normal", 0.01).state, "Completed, Succeeded", "scale speeds the clock up");
});

// --- anonymising -----------------------------------------------------------

test("usernames become stable fake names keyed by the salt", () => {
  const A = makeAnonymiser("salt-1");
  assert.match(A.user("RealPerson42"), /^peer-[0-9a-f]{8}$/);
  assert.equal(A.user("RealPerson42"), A.user("RealPerson42"));
  assert.notEqual(A.user("RealPerson42"), A.user("someone-else"));
  assert.notEqual(makeAnonymiser("salt-2").user("RealPerson42"), A.user("RealPerson42"), "another salt, another name");
});

test("a search response keeps the album folder and file, nothing above them, and no unlisted field", () => {
  const A = makeAnonymiser("salt");
  const real = {
    username: "johnsmith1980",
    hasFreeUploadSlot: true, queueLength: 2, uploadSpeed: 99000, fileCount: 1, lockedFileCount: 0, token: 7,
    someFutureField: "who knows",
    files: [{
      filename: "@@johnsmith1980\\C:\\Users\\John Smith\\Music\\Radiohead - OK Computer (1997)\\06 - Karma Police (ripped by johnsmith1980, mail john@example.com, 10.0.0.12).flac",
      extension: "flac", size: 30e6, length: 264, bitRate: null, bitDepth: 16, sampleRate: 44100, isVariableBitRate: false, code: 1,
      attributes: [{ type: "Secret" }]
    }],
    lockedFiles: []
  };
  const out = anonResponse(real, A);
  const s = JSON.stringify(out);
  assert.ok(!/john/i.test(s), "no trace of the user: " + s);
  assert.ok(!/Users|C:/.test(s), "nothing above the album folder");
  assert.ok(!s.includes("10.0.0.12") && !s.includes("example.com"), "IP and email scrubbed");
  assert.ok(!s.includes("someFutureField") && !s.includes("attributes"), "whitelisted fields only");
  assert.equal(out.username, A.user("johnsmith1980"));
  assert.match(out.files[0].filename, /^@@peer-[0-9a-f]{8}\\Music\\Radiohead - OK Computer \(1997\)\\06 - Karma Police/);
  assert.equal(out.files[0].size, 30e6);
  assert.equal(out.files[0].bitDepth, 16);
});

test("replay walks a recorded search and transfer on the recorded clock", () => {
  const rec = {
    polls: [
      { t: 0, state: "InProgress", responseCount: 0 },
      { t: 1000, state: "InProgress", responseCount: 1, fileCount: 1 },
      { t: 3000, state: "Completed, TimedOut", responseCount: 2, fileCount: 3 }
    ],
    responses: [{ username: "peer-a", files: [] }, { username: "peer-b", files: [] }]
  };
  assert.equal(replaySearchAt(rec, 500, 1).responses.length, 0);
  assert.equal(replaySearchAt(rec, 1500, 1).responses.length, 1);
  const end = replaySearchAt(rec, 3500, 1);
  assert.equal(end.state, "Completed, TimedOut");
  assert.equal(end.responses.length, 2);
  assert.equal(replaySearchAt(rec, 35, 0.01).state, "Completed, TimedOut", "scaled");

  const tr = { timeline: [{ t: 0, state: "Queued, Remotely", placeInQueue: 4 }, { t: 2000, state: "InProgress", bytesTransferred: 500 }] };
  assert.equal(replayTransferAt(tr, 100, 1).placeInQueue, 4);
  assert.equal(replayTransferAt(tr, 60000, 1).state, "InProgress", "a timeline that ends mid-transfer holds: a stall");
});

// --- the plugin against the fake, over real HTTP ----------------------------

// fakeHost answers from a path map; this sends the plugin's requests to the
// fake for real instead.
function hostFor(url, extra) {
  return fakeHost(Object.assign({
    store: { url, apiKey: "k".repeat(20), tracked: {} },
    fetch: async (u, init) => {
      if (!u.startsWith(url)) return undefined;
      const r = await fetch(u, { method: init.method, headers: init.headers, body: init.body });
      const text = await r.text();
      return { status: r.status, headers: {}, text: async () => text, json: async () => JSON.parse(text) };
    }
  }, extra || {}));
}

async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function searchAndDownload(h, query) {
  await until(async () => (await h.tools.status({})).state === "ready", 10000, "ready");
  const found = await h.tools.search({ query });
  assert.ok(found.results.length > 0, "found something");
  const pick = found.results.find((r) => r.hasFreeUploadSlot && r.user !== "fake-stalled" && r.user !== "fake-flaky") || found.results[0];
  const q = await h.tools.download({ ids: [pick.id] });
  assert.equal(q.queued.length, 1);
  const done = await until(async () => {
    const list = await h.tools.list_downloads({});
    return list.downloads.find((d) => d.user === pick.user && d.uri);
  }, 20000, "the download to finish and be located");
  return { found, pick, done };
}

test("the plugin searches, downloads and locates a file through the fake", { timeout: 40000 }, async () => {
  const downloads = tmp("dl");
  const fake = await createFakeSlskd({ port: 0, downloads, scale: 0.02, audio: "stub" });
  const p = loadPlugin();
  const h = hostFor(fake.url);
  await p.activate(h.api);
  try {
    const { pick, done } = await searchAndDownload(h, "Radiohead - Karma Police");
    assert.equal(done.phase, "succeeded");
    const files = fs.readdirSync(downloads, { recursive: true }).map(String).filter((f) => f.endsWith(pick.filename));
    assert.equal(files.length, 1, "the file is on disk where slskd said");
  } finally {
    p.deactivate();
    await fake.close();
  }
});

test("a signed-out scenario reaches the plugin as not ready, with the reason from slskd's log", { timeout: 20000 }, async () => {
  const fake = await createFakeSlskd({ port: 0, downloads: tmp("dl"), scenario: "vpn-blocked", audio: "stub" });
  const p = loadPlugin();
  const h = hostFor(fake.url);
  await p.activate(h.api);
  try {
    const st = await until(async () => { const s = await h.tools.status({}); return s.state !== "unknown" && s.state !== "checking" ? s : null; }, 10000, "a readiness answer");
    assert.notEqual(st.state, "ready");
    await assert.rejects(() => h.tools.search({ query: "anything" }), /not ready/);
  } finally {
    p.deactivate();
    await fake.close();
  }
});

test("record through a proxy, then replay: real answers come back anonymised", { timeout: 60000 }, async () => {
  // The "real" slskd is another fake, whose sharer names stand in for real users.
  const upstream = await createFakeSlskd({ port: 0, downloads: tmp("up"), scale: 0.02, audio: "stub" });
  const recording = tmp("rec");
  const saltPath = path.join(tmp("salt"), "salt");
  const recorder = await createFakeSlskd({ port: 0, upstream: upstream.url, record: recording, saltPath });
  const query = "Radiohead - Karma Police";
  let recordedPick;
  {
    const p = loadPlugin();
    const h = hostFor(recorder.url);
    await p.activate(h.api);
    try {
      recordedPick = (await searchAndDownload(h, query)).pick;
    } finally {
      p.deactivate();
      await recorder.close();
      await upstream.close();
    }
  }

  // What was saved.
  const all = fs.readdirSync(recording, { recursive: true }).map(String).filter((f) => f.endsWith(".json"));
  const text = all.map((f) => fs.readFileSync(path.join(recording, f), "utf8")).join("\n");
  assert.ok(all.includes("application.json") && all.includes("transfers.json"));
  assert.ok(all.some((f) => f.startsWith("searches" + path.sep)), "one file per query");
  assert.ok(!/fake-(hires|flac|cdrip|320|v0|busy|stalled|flaky|live|locked)/.test(text), "no upstream username survived");
  assert.ok(!fs.readdirSync(recording, { recursive: true }).map(String).some((f) => /salt/.test(f)), "the salt stays out of the recording");
  const transfers = JSON.parse(fs.readFileSync(path.join(recording, "transfers.json"), "utf8"));
  const timeline = Object.values(transfers)[0].timeline;
  assert.ok(timeline.length >= 2, "several states, not a snapshot");
  assert.ok(timeline.every((e, i) => i === 0 || e.t >= timeline[i - 1].t), "timestamps run forward");
  assert.equal(timeline[timeline.length - 1].state, "Completed, Succeeded");

  // Replay, with no upstream at all.
  const downloads = tmp("replay");
  const replay = await createFakeSlskd({ port: 0, downloads, replay: recording, scale: 1, audio: "stub" });
  const p = loadPlugin();
  const h = hostFor(replay.url);
  await p.activate(h.api);
  try {
    await until(async () => (await h.tools.status({})).state === "ready", 10000, "ready");
    const found = await h.tools.search({ query });
    assert.ok(found.results.length > 0);
    assert.ok(found.results.every((r) => /^peer-[0-9a-f]{8}$/.test(r.user)), "recorded, anonymised sharers: " + found.results.map((r) => r.user));
    // The sharer the recording downloaded from replays its recorded transfer.
    const again = found.results.find((r) => r.filename === recordedPick.filename && Object.keys(transfers).some((k) => k.startsWith(r.user + "\0")));
    assert.ok(again, "the recorded file is offered again");
    await h.tools.download({ ids: [again.id] });
    const done = await until(async () => (await h.tools.list_downloads({})).downloads.find((d) => d.uri), 20000, "the replayed download");
    assert.equal(done.phase, "succeeded");
    assert.ok(Object.values(replay.state.transfers).every((t) => t.replay && t.replay.timeline.length), "followed the recorded timeline, not a generated one");

    const generated = await h.tools.search({ query: "something never recorded" });
    assert.ok(generated.results.some((r) => /^fake-/.test(r.user)), "unrecorded queries fall back to generated sharers");
  } finally {
    p.deactivate();
    await replay.close();
  }
});

// --- the plugin's Test server switch ------------------------------------------

test("the Test server section offers the switch only while a fake answers, or while it is on", () => {
  const p = loadPlugin();
  const idle = JSON.stringify(p._testServerSection({ debugServer: false }, false));
  assert.doesNotMatch(idle, /set-debug-server/, "no switch with nothing to switch to");
  assert.match(idle, /npx github:outcast1000\/viboplr-slskd/, "says how to start one");
  assert.match(idle, /detect-test-server/);
  assert.match(idle, /test-server-docs/);
  assert.doesNotMatch(JSON.stringify(p._testServerSection({ debugServer: false }, null)), /set-debug-server/);
  assert.doesNotMatch(idle, /Nothing answered/, "no verdict before anyone looked");
  assert.match(JSON.stringify(p._testServerSection({ debugServer: false, debugUrl: "http://127.0.0.1:5039" }, false, Date.now())),
    /Nothing answered at http:\/\/127.0.0.1:5039 or on ports 5039–5049/, "Look again says when it found nothing");
  const found = p._testServerSection({ debugServer: false, debugUrl: "http://127.0.0.1:5039" }, { mode: "replay" });
  assert.match(JSON.stringify(found), /set-debug-server/);
  assert.match(JSON.stringify(found), /replaying a recording/);
  assert.match(JSON.stringify(p._testServerSection({ debugServer: true }, false)), /set-debug-server/,
    "stays switchable while on, even with the fake stopped, so it can be switched off");
});

test("a fake on this computer is looked for across the port range; a remote address only where it is", () => {
  const p = loadPlugin();
  const local = p._debugCandidates("http://127.0.0.1:5039/");
  assert.equal(local[0], "http://127.0.0.1:5039", "the saved address first");
  assert.equal(local.length, 11, "5039–5049, the saved one not repeated");
  assert.ok(local.includes("http://127.0.0.1:5049"));
  assert.equal(p._debugCandidates("http://localhost:7000")[0], "http://localhost:7000");
  assert.ok(p._debugCandidates("http://localhost:7000").includes("http://localhost:5040"));
  assert.deepEqual(p._debugCandidates("http://192.168.1.5:5039"), ["http://192.168.1.5:5039"], "no scanning someone else's machine");
  assert.deepEqual(p._debugCandidates(""), []);
});

test("a fake started on another port is found and its address saved", { timeout: 20000 }, async () => {
  const real = await createFakeSlskd({ port: 0, downloads: tmp("real"), scale: 0.02, audio: "stub" });
  const p = loadPlugin();
  const marker = { status: 200, headers: { "x-fake-slskd": "generated" }, text: async () => "true", json: async () => true };
  const h = hostFor(real.url, {
    fetch: async (u, init) => {
      if (u.startsWith("http://127.0.0.1:5043/")) return marker;
      if (!u.startsWith(real.url)) return undefined;
      const r = await fetch(u, { method: init.method, headers: init.headers, body: init.body });
      const text = await r.text();
      return { status: r.status, headers: {}, text: async () => text, json: async () => JSON.parse(text) };
    }
  });
  await p.activate(h.api);
  try {
    await until(async () => (await h.tools.status({})).state === "ready", 10000, "ready");
    await h.actions["detect-test-server"]();
    assert.equal(h.store.debugUrl, "http://127.0.0.1:5043", "the found address is saved");
    await h.actions["main-tab"]({ tabId: "settings" });
    assert.match(JSON.stringify(h.calls.views[h.calls.views.length - 1].data), /set-debug-server/, "and the switch is offered");
  } finally {
    p.deactivate();
    await real.close();
  }
});

test("switching to the test server and back keeps the real server's downloads", { timeout: 40000 }, async () => {
  const real = await createFakeSlskd({ port: 0, downloads: tmp("real"), scale: 0.02, audio: "stub" });
  const testServer = await createFakeSlskd({ port: 0, downloads: tmp("test"), scale: 0.02, audio: "stub" });
  const realKey = "someone\0@@someone\\Music\\a\\01 - Real.flac";
  const p = loadPlugin();
  const h = hostFor(real.url, {
    store: { url: real.url, apiKey: "k".repeat(20), debugUrl: testServer.url,
      tracked: { [realKey]: { destination: "viboplr/1-real", b64: null, resolvedPath: null, meta: { title: "Real" }, size: 1 } } },
    // Both servers are real HTTP here, headers included (the fake's marker).
    fetch: async (u, init) => {
      if (!u.startsWith(real.url) && !u.startsWith(testServer.url)) return undefined;
      const r = await fetch(u, { method: init.method, headers: init.headers, body: init.body });
      const text = await r.text();
      const headers = {};
      r.headers.forEach((v, k) => { headers[k] = v; });
      return { status: r.status, headers, text: async () => text, json: async () => JSON.parse(text) };
    }
  });
  await p.activate(h.api);
  try {
    await until(async () => (await h.tools.status({})).state === "ready", 10000, "ready on the real server");
    let st = await h.tools.status({});
    assert.equal(st.slskdAddress, real.url);
    assert.equal(st.testServer, false);

    // The plugin noticed the fake (its X-Fake-Slskd header) and offers the switch.
    await h.actions["main-tab"]({ tabId: "settings" });
    const lastView = () => JSON.stringify(h.calls.views[h.calls.views.length - 1].data);
    assert.match(lastView(), /set-debug-server/, "the Test server row is offered");

    await h.actions["set-debug-server"]({ value: true });
    st = await until(async () => { const s = await h.tools.status({}); return s.state === "ready" && s.testServer ? s : null; }, 10000, "ready on the test server");
    assert.equal(st.slskdAddress, testServer.url);
    assert.equal(h.store.url, real.url, "the real address is untouched");
    assert.equal(h.store.debugServer, true);

    await searchAndDownload(h, "Test Artist - Test Song");
    assert.equal(Object.keys(testServer.state.transfers).length, 1, "the download went to the test server");
    assert.equal(Object.keys(real.state.transfers).length, 0, "and not to the real one");
    assert.equal(Object.keys(h.store["debug.tracked"] || {}).length, 1, "the test server's records live under their own key");
    assert.deepEqual(Object.keys(h.store.tracked), [realKey], "the real records weren't touched");

    await h.actions["set-debug-server"]({ value: false });
    st = await until(async () => { const s = await h.tools.status({}); return s.state === "ready" && !s.testServer ? s : null; }, 10000, "back on the real server");
    assert.equal(st.slskdAddress, real.url);
    assert.ok(h.store.tracked[realKey], "the real download record is still there");
    assert.equal((await h.tools.list_downloads({})).downloads.length, 0, "the test server's transfers aren't shown against the real one");
  } finally {
    p.deactivate();
    await real.close();
    await testServer.close();
  }
});
