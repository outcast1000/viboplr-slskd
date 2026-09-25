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

test("setup buttons depend on what the host and Roadie say", () => {
  const btn = plugin._roadieSetupButtons;
  const actions = (list) => list.map((b) => b.action);
  const cfg = { managedBy: null };
  assert.deepEqual(actions(btn("unconfigured", cfg, { supported: false })), [], "a host without Roadie shows nothing");
  assert.deepEqual(actions(btn("unconfigured", cfg, { supported: true, installed: false })), ["roadie-get"]);
  assert.deepEqual(actions(btn("unreachable", cfg, { supported: true, installed: false })), [], "a typed address that fails is not a Roadie problem");
  assert.deepEqual(actions(btn("unconfigured", cfg, { supported: true, installed: true, tool: notInstalled })), [], "the install form carries its own button");
  assert.deepEqual(actions(btn("unconfigured", cfg, { supported: true, installed: true, tool: installedApproved })), ["roadie-connect"]);
  assert.deepEqual(actions(btn("unreachable", { managedBy: "roadie" }, { supported: true, installed: true, tool: installedApproved })), ["roadie-start"]);
  assert.deepEqual(actions(btn("unauthorized", { managedBy: "roadie" }, { supported: true, installed: true, tool: installedApproved })), []);
  assert.deepEqual(actions(btn("unconfigured", cfg, { supported: true, installed: true, job: { cancel() {} } })), ["roadie-cancel"]);
});

test("the install form shows only while Roadie could install slskd and nothing answers", () => {
  const show = plugin._showRoadieInstallForm;
  const r = { supported: true, installed: true, tool: notInstalled };
  assert.equal(show("unconfigured", { managedBy: null }, r), true);
  assert.equal(show("unreachable", { managedBy: null }, r), true);
  assert.equal(show("ready", { managedBy: null }, r), false);
  assert.equal(show("unconfigured", { managedBy: null }, { ...r, installed: false }), false, "Roadie itself missing → the Set up button instead");
  assert.equal(show("unconfigured", { managedBy: null }, { ...r, tool: installedApproved }), false);
  assert.equal(show("unconfigured", { managedBy: null }, { ...r, job: {} }), false);
});

test("install arguments carry the account only when typed, and always the login-item answer (off by default)", () => {
  assert.deepEqual(plugin._roadieInstallArgs({ username: "", password: "" }),
    ["tool", "install", "slskd", "--consumer", "viboplr", "--set", "autostart=false"], "the recipe's own default (on) never decides it");
  assert.deepEqual(plugin._roadieInstallArgs({ username: " bj ", password: "pw=1", autostart: true }),
    ["tool", "install", "slskd", "--consumer", "viboplr", "--set", "soulseekUsername=bj", "--set", "soulseekPassword=pw=1", "--set", "autostart=true"]);
  assert.deepEqual(plugin._parseRoadieJson('{\n "url": "x"\n}\n'), { url: "x" });
  assert.equal(plugin._parseRoadieJson("not json"), null);
  assert.deepEqual(plugin._roadieProgress("roadie: downloading 42%"), { text: "Downloading slskd…", percent: 42 });
  assert.equal(plugin._roadieProgress("roadie: asking the user in a dialog…").percent, null);
  assert.equal(plugin._roadieProgress("roadie: verifying").text, "Verifying…");
  assert.equal(plugin._roadieProgress("   "), null);
  assert.equal(plugin._roadieFailure(2, null, ""), "You declined it in Roadie's dialog.");
  assert.equal(plugin._roadieFailure(1, { error: "slskd is not installed" }, ""), "slskd is not installed");
  assert.equal(plugin._roadieFailure(3, null, "roadie: first\nroadie: unknown command"), "unknown command");
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
    if (cmd[0] === "tool" && cmd[1] === "connection") {
      state.connectionAsked = (state.connectionAsked || 0) + 1;
      return { exitCode: 0, stdout: JSON.stringify({ url: "http://127.0.0.1:5030", apiKey: "r".repeat(48) }), stderr: "" };
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
    assert.ok(form.includes("Install slskd with Roadie") && form.includes('"value":"bj"'), "the form keeps what was typed");
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
