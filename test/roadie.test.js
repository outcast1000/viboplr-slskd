const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { fakeHost } = require("./harness/host.js");

const plugin = loadPlugin();

// Roadie (https://github.com/outcast1000/roadie) installs and runs slskd. The
// host carries its command-line release as a managed dependency and the plugin
// drives it with api.system.exec. These pin the rules that keep it from ever
// overwriting a user's own connection or asking Roadie anything unprompted.

const installedApproved = { installed: true, running: true, url: "http://127.0.0.1:5030", approvedConsumers: ["viboplr"] };
const notInstalled = { installed: false, running: false, url: "http://127.0.0.1:5030", approvedConsumers: [] };

test("auto-config: unconfigured + approved adopts; a typed address is never overwritten", () => {
  const act = plugin._roadieAutoConfigAction;
  assert.equal(act({ url: "", apiKey: "", managedBy: null }, installedApproved), "connect");
  assert.equal(act({ url: "http://nas:5030", apiKey: "k", managedBy: null }, installedApproved), null, "user-typed stays");
  assert.equal(act({ url: "http://", apiKey: "", managedBy: null }, installedApproved), null, "even half-typed");
});

test("auto-config: a managed connection follows Roadie's port and releases on uninstall, never on silence", () => {
  const act = plugin._roadieAutoConfigAction;
  const managed = { url: "http://127.0.0.1:5030", apiKey: "k", managedBy: "roadie" };
  assert.equal(act(managed, installedApproved), null, "same address → nothing to do");
  assert.equal(act(managed, { ...installedApproved, url: "http://127.0.0.1:5031" }), "connect", "port moved → re-read the connection");
  assert.equal(act(managed, notInstalled), "release");
  assert.equal(act(managed, null), null, "no answer from Roadie is not Roadie saying slskd is gone");
  assert.equal(act({ url: "", apiKey: "", managedBy: null }, { ...installedApproved, approvedConsumers: [] }), null, "not approved → never auto-connect (that would open Roadie's dialog unasked)");
  assert.equal(act({ url: "", apiKey: "", managedBy: null }, notInstalled), null, "not installed → nothing to adopt");
});

test("the automatic install page offers the one step Roadie's state allows", () => {
  const stage = plugin._autoInstallStage;
  assert.equal(stage({ supported: false }), "unsupported", "a host without Roadie can only send you to the guide");
  assert.equal(stage({ supported: true, installed: false }), "get-roadie");
  assert.equal(stage({ supported: true, installed: true, tool: notInstalled }), "form");
  assert.equal(stage({ supported: true, installed: true, tool: null }), "form", "no answer yet → the form, whose install asks Roadie anyway");
  assert.equal(stage({ supported: true, installed: true, tool: installedApproved }), "adopt");
  assert.equal(stage({ supported: true, installed: true, tool: notInstalled, job: {} }), "busy");
});

// The hub's node tree, flattened to what a user can click.
const clickable = (nodes) => {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === "button") out.push(n.data && n.data.page ? "page:" + n.data.page : n.action);
    if (n.type === "toolbar") n.buttons.forEach((b) => out.push(b.data && b.data.page ? "page:" + b.data.page : b.action));
    walk(n.children); walk(n.control);
  };
  walk(nodes);
  return out;
};

test("first-run hub: install automatically, install manually, or connect — nothing else on screen", () => {
  const hub = plugin._setupHomeView("unconfigured", { url: "", managedBy: null }, { supported: true, installed: false });
  assert.deepEqual(clickable(hub), ["page:install-auto", "page:install-manual", "page:connect", "setup-open-about"]);
  const text = JSON.stringify(hub);
  assert.ok(!text.includes("text-input"), "no address/key fields and no account form on the hub");
  const noRoadie = plugin._setupHomeView("unconfigured", { url: "", managedBy: null }, { supported: false });
  assert.deepEqual(clickable(noRoadie), ["page:install-manual", "page:connect", "setup-open-about"], "no Roadie → no automatic option");
});

test("hub: an slskd Roadie already has is offered first", () => {
  const r = { supported: true, installed: true, tool: installedApproved };
  assert.equal(clickable(plugin._setupHomeView("unconfigured", { url: "", managedBy: null }, r))[0], "roadie-connect");
  assert.equal(plugin._roadieHasUnusedSlskd({ managedBy: "roadie" }, r), false, "already ours → nothing to offer");
});

test("unreachable hub: retry and settings first, then start it, then reinstall", () => {
  const hub = plugin._setupHomeView("unreachable", { url: "http://localhost:5030", managedBy: null }, { supported: true, installed: false }, "connection refused");
  assert.deepEqual(clickable(hub), ["test-connection", "page:connect", "setup-open-guide", "page:install-auto", "page:install-manual"]);
  const text = JSON.stringify(hub);
  assert.ok(text.includes("http://localhost:5030"));
  assert.ok(!text.includes("connection refused"), "a transport error only repeats the address");
  const bad = JSON.stringify(plugin._setupHomeView("unreachable", { url: "http://localhost:5030", managedBy: null }, { supported: false }, "HTTP 502"));
  assert.ok(bad.includes("(HTTP 502)"), "a wrong answer is news, and shown");
  assert.ok(!text.includes("self-signed"), "the certificate hint is not for plain http");
});

test("a stopped Roadie-managed slskd is one Start button", () => {
  const hub = plugin._setupHomeView("unreachable", { url: "http://127.0.0.1:5030", managedBy: "roadie" }, { supported: true, installed: true, tool: installedApproved });
  assert.deepEqual(clickable(hub), ["roadie-start", "page:connect"]);
});

// A Roadie CLI that knows one slskd, driven by the calls the plugin makes.
// An install reports progress the way the real one does, on stderr.
function fakeRoadie(state) {
  return async (program, args, opts) => {
    assert.equal(program, "roadie");
    assert.deepEqual(args.slice(0, 2), ["--as", "Viboplr"], "every call names the app in Roadie's prompt");
    const cmd = args.slice(2);
    if (cmd[0] === "tool" && cmd[1] === "status") {
      if (state.statusThrowsAfterInstall && state.installArgs) throw new Error("exec exploded");
      return { exitCode: 0, stdout: JSON.stringify(state.tool), stderr: "" };
    }
    if (cmd[0] === "tool" && cmd[1] === "logs") return { exitCode: 0, stdout: JSON.stringify({ lines: state.logLines || [] }), stderr: "" };
    if (cmd[0] === "tool" && cmd[1] === "install") {
      state.installArgs = cmd;
      if (opts && opts.onStart) opts.onStart({ cancel() { state.cancelled = true; } });
      const say = (l) => opts && opts.onOutput && opts.onOutput(l, "stderr");
      say("roadie: asking the user in a dialog…");
      if (state.decline) return { exitCode: 2, stdout: JSON.stringify({ status: "declined" }), stderr: "" };
      for (const p of [10, 60, 100]) { state.seenDuring = state.seenDuring || []; say("roadie: downloading " + p + "%"); }
      say("roadie: verifying");
      if (state.failInstall) return { exitCode: 1, stdout: JSON.stringify({ status: "failed", note: state.failInstall }), stderr: "" };
      state.tool = state.startFails ? { ...installedApproved, running: false, conflictDetail: "Another copy of slskd is running on this computer." } : installedApproved;
      return { exitCode: 0, stdout: JSON.stringify({ status: "done" }), stderr: "" };
    }
    if (cmd[0] === "tool" && cmd[1] === "autostart") {
      state.tool = { ...state.tool, autostart: cmd[3] === "on" };
      return { exitCode: 0, stdout: JSON.stringify(state.tool), stderr: "" };
    }
    if (cmd[0] === "tool" && cmd[1] === "start") {
      state.startCalls = (state.startCalls || 0) + 1;
      if (state.startCmdFails) return { exitCode: 1, stdout: JSON.stringify({ error: state.startCmdFails }), stderr: "" };
      state.tool = { ...state.tool, running: true };
      return { exitCode: 0, stdout: JSON.stringify(state.tool), stderr: "" };
    }
    if (cmd[0] === "tool" && cmd[1] === "connection") {
      state.connectionAsked = (state.connectionAsked || 0) + 1;
      const conn = { url: "http://127.0.0.1:5030", apiKey: "r".repeat(48) };
      if (state.webLogin) conn.webLogin = state.webLogin;
      return { exitCode: 0, stdout: JSON.stringify(conn), stderr: "" };
    }
    return { exitCode: 3, stdout: "", stderr: "roadie: unknown command" };
  };
}

// Activate a plugin against a fake host, run `fn`, and always deactivate —
// a failing assertion must not leave the readiness timer holding the run open.
async function withPlugin(hostOpts, fn) {
  const host = fakeHost(hostOpts);
  const p = loadPlugin();
  try {
    await p.activate(host.api);
    await fn(host, p);
  } finally {
    p.deactivate();
  }
}

const until = async (cond, ms = 500) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 2));
};
const lastView = (host) => JSON.stringify(host.calls.views.filter((v) => v.viewId === "slskd-browse").at(-1));
const fillAccount = async (host) => {
  await host.actions["roadie-set-user"]({ value: "bj" });
  await host.actions["roadie-set-pass"]({ value: "secret" });
};
const openAutoInstall = async (host) => {
  await host.actions["setup-page"]({ page: "install-auto" });
  await until(() => lastView(host).includes("roadie-set-user"));
};
const roadieHere = { roadie: { name: "roadie", installed: true, version: "0.1.0", origin: "managed" } };

test("setup steps: progress lines move forward only, and a failure stops the list", () => {
  const s = plugin._newSetup(" outcast1000 ");
  assert.equal(s.username, "outcast1000");
  assert.deepEqual(plugin._setupStepForLine("roadie: asking the user in a dialog…"), { step: "approve" });
  assert.deepEqual(plugin._setupStepForLine("roadie: downloading 42%"), { step: "download", percent: 42 });
  assert.deepEqual(plugin._setupStepForLine("roadie: extracting"), { step: "unpack" });
  assert.deepEqual(plugin._setupStepForLine("roadie: verifying"), { step: "unpack" });
  assert.equal(plugin._setupStepForLine("roadie: something else"), null);

  plugin._advanceSetup(s, "unpack");
  plugin._advanceSetup(s, "download"); // a late line never moves it back
  let rows = plugin._setupChecklist(s);
  assert.deepEqual(rows.map((r) => r.state), ["done", "done", "active", "pending", "pending", "pending"]);
  assert.equal(rows[5].label, "Sign in to Soulseek as outcast1000");

  plugin._failSetup(s, "boom");
  plugin._advanceSetup(s, "start"); // nothing moves past a failure
  rows = plugin._setupChecklist(s);
  assert.deepEqual(rows.map((r) => r.state), ["done", "done", "failed", "pending", "pending", "pending"]);
  assert.equal(rows[2].detail, "boom");
});

test("setup steps: the approval step says where the dialog is; sign-in failures say why", () => {
  const rows = plugin._setupChecklist(plugin._newSetup(""));
  assert.match(rows[0].detail, /dialog/);
  assert.equal(rows[5].label, "Sign in to Soulseek");
  assert.match(plugin._signinFailure("connecting", "bj"), /VPN or firewall/);
  assert.match(plugin._signinFailure("disconnected", "bj"), /keeps trying/);
  assert.match(plugin._signinFailure("disconnected", null), /No Soulseek account/);
});

test("integration: a fresh plugin adopts an approved Roadie connection on its first readiness pass", async () => {
  const state = { tool: installedApproved };
  await withPlugin({ store: { url: "", apiKey: "" }, dependencies: roadieHere, exec: fakeRoadie(state) }, async (host) => {
    assert.equal(host.store.url, "http://127.0.0.1:5030");
    assert.equal(host.store.apiKey, "r".repeat(48));
    assert.equal(host.store.managedBy, "roadie");
    assert.equal(host.store.insecure, false);
  });
});

test("integration: a user-typed address is left alone even when Roadie has an approved slskd", async () => {
  const state = { tool: installedApproved };
  await withPlugin({
    store: { url: "http://nas.local:5030", apiKey: "mine" },
    responses: { "/api/v0/application": { server: {} } }, // not logged in → not ready → Roadie is asked
    dependencies: roadieHere,
    exec: fakeRoadie(state)
  }, async (host) => {
    assert.equal(host.store.url, "http://nas.local:5030");
    assert.equal(host.store.apiKey, "mine");
    assert.equal(host.store.managedBy, undefined);
    assert.equal(state.connectionAsked, undefined, "never asked Roadie for a connection");
  });
});

test("integration: Roadie missing → the button asks the host's install modal, and no exec runs", async () => {
  await withPlugin({
    store: { url: "", apiKey: "" },
    dependencies: { roadie: { name: "roadie", installed: false } },
    exec: async () => { throw new Error("must not exec a missing binary"); }
  }, async (host) => {
    await host.actions["roadie-get"]();
    assert.deepEqual(host.calls.requestAction.at(-1), { action: "require-dependency", payload: { name: "roadie", feature: "Soulseek" } });
    assert.equal(host.calls.exec.length, 0);
  });
});

test("integration: a host without Roadie in its registry never runs it", async () => {
  await withPlugin({ store: { url: "", apiKey: "" }, dependencies: {}, exec: async () => { throw new Error("no exec"); } }, async (host) => {
    assert.equal(host.calls.exec.length, 0);
  });
});

test("integration: Install slskd walks the checklist to the end, then the view is the plugin itself", async () => {
  const state = { tool: notInstalled };
  await withPlugin({ store: { url: "", apiKey: "" }, dependencies: roadieHere, exec: fakeRoadie(state) }, async (host) => {
    assert.equal(host.store.managedBy, undefined, "nothing installed or adopted on its own");
    assert.ok(!lastView(host).includes("roadie-set-user"), "the hub doesn't show the account form");
    await openAutoInstall(host);
    const form = lastView(host);
    assert.ok(/"action":"roadie-set-autostart","checked":false/.test(form), "the login-item switch is on screen and off");
    await host.actions["roadie-set-user"]({ value: "bj" });
    await host.actions["roadie-set-pass"]({ value: "secret" });
    const viewsBefore = host.calls.views.length;
    await fillAccount(host);
    await host.actions["roadie-install"]();
    await until(() => host.store.managedBy === "roadie" && !lastView(host).includes("Setting up slskd"));
    assert.deepEqual(state.installArgs, ["tool", "install", "slskd", "--consumer", "viboplr", "--set", "soulseekUsername=bj", "--set", "soulseekPassword=secret", "--set", "autostart=false"]);
    const during = host.calls.views.slice(viewsBefore).map((v) => JSON.stringify(v.data)).filter((d) => d.includes("Setting up slskd"));
    assert.ok(during.some((d) => d.includes("Roadie is showing a dialog")), "the approval step said where to look");
    assert.ok(during.some((d) => d.includes('"type":"progress-bar","value":60')), "the download showed its percent");
    assert.ok(during.every((d) => !d.includes("slskd address") && !d.includes("API key")), "no connection fields while it runs");
    assert.ok(during.some((d) => d.includes("Sign in to Soulseek as bj")));
    assert.equal(host.store.url, "http://127.0.0.1:5030");
    assert.equal(host.store.soulseekPassword, undefined, "the account is never stored by the plugin");
    assert.ok(lastView(host).includes('"type":"tabs"'), "ready → the search tabs, no leftover setup screen");
    assert.equal(host.calls.notifications.length, 0, "no toasts on top of the checklist");
  });
});

test("integration: the login-item switch's answer is what Roadie gets", async () => {
  const state = { tool: notInstalled };
  await withPlugin({ store: { url: "", apiKey: "" }, dependencies: roadieHere, exec: fakeRoadie(state) }, async (host) => {
    await host.actions["roadie-set-autostart"]({ value: true });
    await fillAccount(host);
    await host.actions["roadie-install"]();
    await until(() => state.installArgs);
    assert.equal(state.installArgs.at(-1), "autostart=true");
  });
});

test("integration: a declined install stops at the approval step, and Back returns to the untouched form", async () => {
  const state = { tool: notInstalled, decline: true };
  await withPlugin({ store: { url: "", apiKey: "" }, dependencies: roadieHere, exec: fakeRoadie(state) }, async (host) => {
    await openAutoInstall(host);
    await host.actions["roadie-set-user"]({ value: "bj" });
    await fillAccount(host);
    await host.actions["roadie-install"]();
    await until(() => lastView(host).includes("✗"));
    const v = lastView(host);
    assert.ok(v.includes("✗  Approve in Roadie") && v.includes("You declined it in Roadie"), v.slice(0, 500));
    assert.ok(v.includes('"action":"roadie-setup-close"'));
    assert.equal(host.store.url, "");
    assert.equal(host.store.managedBy, undefined);
    await host.actions["roadie-setup-close"]();
    const form = lastView(host);
    assert.ok(form.includes("Install slskd automatically") && form.includes('"value":"bj"'), "back on the same page, the form keeps what was typed");
  });
});

test("integration: an install Roadie fails says so on the step it reached", async () => {
  const state = { tool: notInstalled, failInstall: "The download was cut off." };
  await withPlugin({ store: { url: "", apiKey: "" }, dependencies: roadieHere, exec: fakeRoadie(state) }, async (host) => {
    await fillAccount(host);
    await host.actions["roadie-install"]();
    await until(() => lastView(host).includes("✗"));
    assert.ok(lastView(host).includes("✗  Unpack and check it") && lastView(host).includes("The download was cut off."));
  });
});

test("integration: slskd that won't start fails the Start step with Roadie's reason, and Try again re-checks", async () => {
  const state = { tool: notInstalled, startFails: true };
  await withPlugin({ store: { url: "", apiKey: "" }, dependencies: roadieHere, exec: fakeRoadie(state) }, async (host) => {
    await fillAccount(host);
    await host.actions["roadie-install"]();
    await until(() => lastView(host).includes("✗"));
    assert.ok(lastView(host).includes("✗  Start slskd") && lastView(host).includes("Another copy of slskd is running"));
    state.tool = installedApproved; // the user quit the other copy
    await host.actions["roadie-setup-retry"]();
    await until(() => host.store.managedBy === "roadie" && !lastView(host).includes("Setting up slskd"));
    assert.ok(lastView(host).includes('"type":"tabs"'));
  });
});

test("integration: no Soulseek sign-in within the wait → the last step explains, Close shows the plugin", async () => {
  const state = { tool: notInstalled };
  await withPlugin({
    store: { url: "", apiKey: "" },
    responses: { "/api/v0/application": { server: { state: "Connecting", isLoggedIn: false, isTransitioning: true }, version: { current: "0.26.0" } } },
    dependencies: roadieHere,
    exec: fakeRoadie(state)
  }, async (host, p) => {
    p._setSigninTiming(60, 10);
    await host.actions["roadie-set-user"]({ value: "bj" });
    await fillAccount(host);
    await host.actions["roadie-install"]();
    await until(() => lastView(host).includes("✗"), 2000);
    const v = lastView(host);
    assert.ok(v.includes("✗  Sign in to Soulseek as bj") && v.includes("VPN or firewall"), v.slice(0, 600));
    assert.ok(v.includes('"action":"roadie-setup-retry"') && v.includes("Check again"));
    assert.equal(host.store.managedBy, "roadie", "connected, only the sign-in is outstanding");
    assert.equal(host.calls.notifications.length, 0, "the checklist says it; no toast");
    await host.actions["roadie-setup-close"]();
    assert.ok(!lastView(host).includes("Setting up slskd"));
  });
});

test("integration: a Roadie-managed slskd offers the login-item switch and changes it through Roadie", async () => {
  const state = { tool: { ...installedApproved, autostart: true } };
  await withPlugin({
    store: { url: "http://127.0.0.1:5030", apiKey: "r".repeat(48), managedBy: "roadie" },
    dependencies: roadieHere,
    exec: fakeRoadie(state)
  }, async (host) => {
    const views = () => JSON.stringify(host.calls.views.slice(-4));
    host.actions["main-tab"]({ tabId: "settings" });
    assert.ok(/"action":"roadie-autostart","checked":true/.test(views()), "shows Roadie's current answer");
    await host.actions["roadie-autostart"]({ value: false });
    await until(() => /"action":"roadie-autostart","checked":false/.test(views()));
    assert.deepEqual(host.calls.exec.at(-1).args.slice(2), ["tool", "autostart", "slskd", "off"]);
    assert.ok(/"action":"roadie-autostart","checked":false/.test(views()), "the switch follows Roadie's reply");
  });
});

// Real lines from slskd 0.26's log, as `roadie tool logs slskd` returns them.
const LOG_TIMEOUT = [
  "[12:15:25 INF] Listening for incoming connections on 0.0.0.0:50300",
  "[12:15:31 ERR] Failed to execute post-login actions",
  "[12:16:33 ERR] Disconnected from the Soulseek server: Unable to read data from the transport connection: Operation timed out."
];
const LOG_REJECTED = [
  "[12:15:25 INF] Listening for incoming connections on 0.0.0.0:50300",
  "[12:15:26 ERR] Failed to log in to the Soulseek server: The server rejected login attempt: INVALIDPASS"
];

test("an account is required: both fields, or no install", () => {
  const ok = plugin._roadieCredsComplete;
  assert.equal(ok({ username: "bj", password: "x" }), true);
  assert.equal(ok({ username: "  ", password: "x" }), false);
  assert.equal(ok({ username: "bj", password: "" }), false);
  assert.equal(ok(null), false);
});

test("sign-in: the live line follows slskd's server state; the log names the reason", () => {
  const prog = plugin._signinProgress;
  assert.equal(prog("Connecting", 12), "Connecting to the Soulseek server… 12s");
  assert.equal(prog("Connected, LoggingIn", 3), "Connected; signing in… 3s");
  assert.equal(prog("Disconnected", 20), "Waiting for slskd to reach the Soulseek server… 20s");
  assert.equal(prog(null, 0), "Waiting for slskd to reach the Soulseek server…");

  const why = plugin._signinReasonFromLog;
  assert.equal(why(LOG_TIMEOUT, "bj").kind, "network");
  assert.match(why(LOG_TIMEOUT, "bj").message, /timed out\. A VPN, a work network or a firewall/);
  assert.equal(why(LOG_REJECTED, "bj").kind, "rejected");
  assert.match(why(LOG_REJECTED, "bj").message, /refused to sign in as bj: the password is wrong, or someone else already uses that username/);
  assert.equal(why(["[12:00:00 INF] all quiet"], "bj"), null);
  assert.equal(why(null, "bj"), null);
});

test("integration: without an account the Install button is off and does nothing; directions are on screen", async () => {
  const state = { tool: notInstalled };
  await withPlugin({ store: { url: "", apiKey: "" }, dependencies: roadieHere, exec: fakeRoadie(state) }, async (host) => {
    await openAutoInstall(host);
    const form = lastView(host);
    assert.ok(form.includes("Soulseek has no sign-up page"), "tells a user without an account how to get one");
    assert.ok(/"action":"roadie-install","variant":"accent","disabled":true/.test(form), "Install starts disabled");
    await host.actions["roadie-install"]();
    await host.actions["roadie-set-pass:submit"]({ value: "secret" }); // Enter with no username
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(state.installArgs, undefined, "nothing ran");
    await host.actions["roadie-set-user"]({ value: "bj" });
    assert.ok(/"action":"roadie-install","variant":"accent","disabled":false/.test(lastView(host)), "both filled → enabled");
  });
});

test("integration: behind a VPN the sign-in step shows live progress, then slskd's own reason", async () => {
  const state = { tool: notInstalled, logLines: LOG_TIMEOUT };
  await withPlugin({
    store: { url: "", apiKey: "" },
    responses: { "/api/v0/application": { server: { state: "Connecting", isLoggedIn: false, isTransitioning: true }, version: { current: "0.26.0" } } },
    dependencies: roadieHere,
    exec: fakeRoadie(state)
  }, async (host, p) => {
    p._setSigninTiming(80, 10);
    await fillAccount(host);
    await host.actions["roadie-install"]();
    await until(() => lastView(host).includes("✗"), 2000);
    const all = host.calls.views.map((v) => JSON.stringify(v.data)).join("\n");
    assert.ok(all.includes("Connecting to the Soulseek server…"), "the wait said what it was waiting for");
    const v = lastView(host);
    assert.ok(v.includes("slskd can't reach the Soulseek server: the connection timed out"), v.slice(0, 700));
    assert.ok(v.includes("Check again"));
  });
});

test("integration: a refused sign-in stops the wait early with the reason", async () => {
  const state = { tool: notInstalled, logLines: LOG_REJECTED };
  await withPlugin({
    store: { url: "", apiKey: "" },
    responses: { "/api/v0/application": { server: { state: "Disconnected", isLoggedIn: false }, version: { current: "0.26.0" } } },
    dependencies: roadieHere,
    exec: fakeRoadie(state)
  }, async (host, p) => {
    p._setSigninTiming(60000, 5); // a full minute's wait — it must not run out
    await fillAccount(host);
    const t0 = Date.now();
    await host.actions["roadie-install"]();
    await until(() => lastView(host).includes("✗"), 2000);
    assert.ok(Date.now() - t0 < 2000, "stopped long before the wait ran out");
    assert.ok(lastView(host).includes("refused to sign in as bj"));
  });
});

test("integration: a step that throws fails on screen instead of spinning forever", async () => {
  const state = { tool: notInstalled, statusThrowsAfterInstall: true };
  await withPlugin({ store: { url: "", apiKey: "" }, dependencies: roadieHere, exec: fakeRoadie(state) }, async (host) => {
    await fillAccount(host);
    await host.actions["roadie-install"]();
    await until(() => lastView(host).includes("✗"), 2000);
    const v = lastView(host);
    assert.ok(v.includes("✗  Start slskd") && v.includes("exec exploded"), v.slice(0, 600));
  });
});

// slskd's own web page asks for a sign-in that isn't the API key.
// Settings live in the view's Settings tab; the setup screens show the same
// sections when slskd isn't ready.
const settingsView = (host) => {
  host.actions["main-tab"]({ tabId: "settings" });
  return lastView(host);
};

test("the web login comes out of Roadie's connection answer, or not at all", () => {
  const from = plugin._webLoginFromRoadie;
  assert.deepEqual(from({ url: "u", apiKey: "k", webLogin: { username: "roadie", password: "p" } }), { username: "roadie", password: "p" });
  assert.equal(from({ url: "u", apiKey: "k" }), null, "an older Roadie sends none");
  assert.equal(from({ webLogin: { username: "roadie" } }), null);
  assert.equal(from(null), null);
});

test("integration: Show login on a Roadie slskd asks Roadie and shows its generated login", async () => {
  const state = { tool: installedApproved, webLogin: { username: "roadie", password: "f".repeat(32) } };
  await withPlugin({
    store: { url: "http://127.0.0.1:5030", apiKey: "r".repeat(48), managedBy: "roadie" },
    dependencies: roadieHere,
    exec: fakeRoadie(state)
  }, async (host) => {
    assert.ok(settingsView(host).includes('"action":"open-slskd"'), "the page can be opened from Settings");
    assert.ok(!settingsView(host).includes("f".repeat(32)), "hidden until asked");
    await host.actions["slskd-show-login"]();
    await until(() => settingsView(host).includes("f".repeat(32)));
    const v = settingsView(host);
    assert.ok(v.includes('"value":"roadie"') && v.includes("Roadie generated"), v.slice(0, 800));
    assert.equal(host.store.webPassword, undefined, "never stored");
    await host.actions["slskd-hide-login"]();
    assert.ok(!settingsView(host).includes("f".repeat(32)));
  });
});

test("integration: an older Roadie without the login says so instead of guessing", async () => {
  const state = { tool: installedApproved };
  await withPlugin({
    store: { url: "http://127.0.0.1:5030", apiKey: "r".repeat(48), managedBy: "roadie" },
    dependencies: roadieHere,
    exec: fakeRoadie(state)
  }, async (host) => {
    await host.actions["slskd-show-login"]();
    await until(() => settingsView(host).includes("doesn't hand out"));
    assert.ok(!settingsView(host).includes('"value":"slskd"'), "slskd's defaults are not Roadie's login");
  });
});

test("integration: a slskd the user set up shows slskd's default login, with the caveat", async () => {
  await withPlugin({ store: { url: "http://localhost:5030", apiKey: "k".repeat(40) }, dependencies: {}, exec: async () => { throw new Error("no exec"); } }, async (host) => {
    await host.actions["slskd-show-login"]();
    const v = settingsView(host);
    assert.ok(v.includes('"label":"Username"') && v.includes('"value":"slskd"') && v.includes("slskd.yml"), v.slice(0, 800));
    assert.equal(host.calls.exec.length, 0, "nothing to ask Roadie");
  });
});

// Shared folders: a Roadie install shares the user's Viboplr collections by
// default, like the manual guide pre-ticks them.
const canShare = { ...notInstalled, config: { shareDownloads: true, "shares.directories": [] } };

test("the install shares the collections by default, only where Roadie can take the list", () => {
  const cols = [{ path: "/Users/me/Music" }, { path: "/Volumes/NAS/Rock" }, { path: "/Users/me/Music" }, { name: "no path" }];
  assert.deepEqual(plugin._collectionPaths(cols), ["/Users/me/Music", "/Volumes/NAS/Rock"], "deduped, pathless skipped");
  const on = { shareCollections: true };
  assert.deepEqual(plugin._installShareDirs(on, canShare, cols), ["/Users/me/Music", "/Volumes/NAS/Rock"]);
  assert.equal(plugin._installShareDirs({ shareCollections: false }, canShare, cols), null, "turned off → nothing extra");
  assert.equal(plugin._installShareDirs(on, notInstalled, cols), null, "an older Roadie would reject the unknown key and fail the install");
  assert.equal(plugin._installShareDirs(on, canShare, []), null, "no collections → nothing to send");
  const args = plugin._roadieInstallArgs({ username: "bj", password: "pw" }, ["/a", "/b c"]);
  assert.deepEqual(args.slice(-2), ["--set", 'shares.directories=["/a","/b c"]'], "slskd's own setting name; a JSON array, so spaces and Windows paths survive");
  assert.equal(plugin._describeFolders(["/a", "/b", "/c", "/d", "/e"]), "/a, /b, /c and 2 more");
});

test("integration: the form lists the folders it will share, and the switch decides what Roadie gets", async () => {
  const state = { tool: canShare };
  await withPlugin({
    store: { url: "", apiKey: "" },
    dependencies: roadieHere,
    collections: [{ id: 1, name: "Music", path: "/Users/me/Music" }, { id: 2, name: "Rock", path: "/Volumes/NAS/Rock" }],
    exec: fakeRoadie(state)
  }, async (host) => {
    await openAutoInstall(host);
    await until(() => lastView(host).includes("Share my Viboplr collections"));
    const form = lastView(host);
    assert.ok(form.includes("2 folders: /Users/me/Music, /Volumes/NAS/Rock"), form.slice(0, 1200));
    assert.ok(/"action":"roadie-set-share","checked":true/.test(form), "on by default");
    await fillAccount(host);
    await host.actions["roadie-install"]();
    await until(() => state.installArgs);
    assert.ok(state.installArgs.includes('shares.directories=["/Users/me/Music","/Volumes/NAS/Rock"]'), state.installArgs.join(" "));
  });
});

test("integration: turned off, the install shares no collections", async () => {
  const state = { tool: canShare };
  await withPlugin({ store: { url: "", apiKey: "" }, dependencies: roadieHere, exec: fakeRoadie(state) }, async (host) => {
    await openAutoInstall(host);
    await host.actions["roadie-set-share"]({ value: false });
    await fillAccount(host);
    await host.actions["roadie-install"]();
    await until(() => state.installArgs);
    assert.ok(!state.installArgs.some((a) => a.startsWith("shares.directories=")), state.installArgs.join(" "));
  });
});

// The launch warning carries the one click that fixes it.
const stopped = { ...installedApproved, running: false };
const nothingAnswers = async (url) => { if (url.includes("/api/v0/application")) throw new Error("connection refused"); };
const managedStore = { url: "http://127.0.0.1:5030", apiKey: "r".repeat(48), managedBy: "roadie" };

test("the warning offers Start for a stopped Roadie slskd, Open Soulseek for everything else", () => {
  const note = plugin._notificationFor;
  const r = { supported: true, installed: true, tool: stopped };
  assert.deepEqual(note("unreachable", { managedBy: "roadie" }, r).action, { label: "Start slskd", id: "roadie-start-from-notice" });
  assert.equal(note("unreachable", { managedBy: null }, r).action.id, "open-soulseek-view", "a slskd the user runs: Viboplr can't start it");
  assert.equal(note("unreachable", { managedBy: "roadie" }, { ...r, tool: notInstalled }).action.id, "open-soulseek-view", "Roadie says it's gone: nothing to start");
  assert.equal(note("unreachable", { managedBy: "roadie" }, { supported: true, installed: false }).action.id, "open-soulseek-view");
  assert.equal(note("unauthorized", {}, r).action.id, "open-soulseek-view");
  assert.equal(note("ready", {}, r), null);
  assert.match(note("unreachable", { managedBy: "roadie" }, r).message, /start it from Soulseek/, "the text still says what to do on a host that drops the button");
});

test("integration: at launch a stopped Roadie slskd warns with Start, and Start runs Roadie", async () => {
  const state = { tool: stopped };
  await withPlugin({ store: managedStore, fetch: nothingAnswers, dependencies: roadieHere, exec: fakeRoadie(state) }, async (host) => {
    await until(() => host.calls.notices.length > 0);
    const notice = host.calls.notices[0];
    assert.equal(notice.options.action.label, "Start slskd", JSON.stringify(notice));
    await host.actions[notice.options.action.id]();
    await until(() => state.startCalls);
    assert.equal(state.startCalls, 1);
    assert.ok(host.calls.notifications.includes("Starting slskd…"), "says it's starting where the user is");
  });
});

test("integration: a start Roadie refuses says why, where the user is", async () => {
  const state = { tool: stopped, startCmdFails: "Another copy of slskd is running on this computer." };
  await withPlugin({ store: managedStore, fetch: nothingAnswers, dependencies: roadieHere, exec: fakeRoadie(state) }, async (host) => {
    await until(() => host.calls.notices.length > 0);
    await host.actions["roadie-start-from-notice"]();
    await until(() => host.calls.notifications.some((m) => m.startsWith("Roadie couldn't start slskd")));
    const fail = host.calls.notices.find((n) => n.message.startsWith("Roadie couldn't start slskd"));
    assert.ok(fail.message.includes("Another copy of slskd"), fail.message);
    assert.equal(fail.options.action.id, "open-soulseek-view");
  });
});

test("integration: the user's own first Connect that finds nothing raises no toast", async () => {
  await withPlugin({ store: { url: "", apiKey: "" }, fetch: nothingAnswers, dependencies: {}, exec: async () => { throw new Error("no exec"); } }, async (host) => {
    await host.actions["setup-connect"]();
    await until(() => lastView(host).includes("Nothing answered"));
    assert.equal(host.calls.notices.length, 0, "the screen they clicked in already says it");
  });
});

test("integration: a slskd the user runs warns with Open Soulseek, which opens the view", async () => {
  await withPlugin({ store: { url: "http://localhost:5030", apiKey: "k".repeat(40) }, fetch: nothingAnswers, dependencies: {}, exec: async () => { throw new Error("no exec"); } }, async (host) => {
    await until(() => host.calls.notices.length > 0);
    const notice = host.calls.notices[0];
    assert.equal(notice.options.action.label, "Open Soulseek");
    await host.actions[notice.options.action.id]();
    assert.deepEqual(host.calls.navigated, ["slskd-browse"]);
  });
});
