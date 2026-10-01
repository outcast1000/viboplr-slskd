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
  assert.deepEqual(clickable(hub), ["page:install-auto", "page:install-manual", "page:connect", "discover-again", "setup-open-about"]);
  const text = JSON.stringify(hub);
  assert.ok(!text.includes("text-input"), "no address/key fields and no account form on the hub");
  const noRoadie = plugin._setupHomeView("unconfigured", { url: "", managedBy: null }, { supported: false });
  assert.deepEqual(clickable(noRoadie), ["page:install-manual", "page:connect", "discover-again", "setup-open-about"], "no Roadie → no automatic option");
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
    if (cmd[0] === "tool" && cmd[1] === "options") {
      if (!state.options) return { exitCode: 3, stdout: "", stderr: "roadie: unknown command `tool options slskd`" };
      return { exitCode: 0, stdout: JSON.stringify(state.options), stderr: "" };
    }
    if (cmd[0] === "tool" && cmd[1] === "upgrade") {
      state.upgradeAsked = (state.upgradeAsked || 0) + 1;
      if (opts && opts.onStart) opts.onStart({ cancel() { state.cancelled = true; } });
      opts && opts.onOutput && opts.onOutput("roadie: asking the user in a dialog…", "stderr");
      if (state.decline) return { exitCode: 2, stdout: JSON.stringify({ status: "declined" }), stderr: "" };
      state.tool = { ...state.tool, revision: state.tool.recipeUpdate.revision, recipeUpdate: null, configurable: false };
      state.key = "s".repeat(48); // the new setup hands out a new (shared) key
      return { exitCode: 0, stdout: JSON.stringify({ status: "done" }), stderr: "" };
    }
    if (cmd[0] === "tool" && cmd[1] === "install" && state.tool && state.tool.installed) {
      state.reinstallArgs = cmd;
      if (opts && opts.onStart) opts.onStart({ cancel() { state.cancelled = true; } });
      opts && opts.onOutput && opts.onOutput("roadie: asking the user in a dialog…", "stderr");
      if (state.decline) return { exitCode: 2, stdout: JSON.stringify({ status: "declined" }), stderr: "" };
      const i = cmd.indexOf("--set");
      const kv = cmd[i + 1];
      const eq = kv.indexOf("=");
      state.tool = { ...state.tool, config: { ...state.tool.config, [kv.slice(0, eq)]: JSON.parse(kv.slice(eq + 1)) } };
      return { exitCode: 0, stdout: JSON.stringify({ status: "done" }), stderr: "" };
    }
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
    if (cmd[0] === "tool" && cmd[1] === "uninstall") {
      state.uninstallArgs = cmd;
      if (opts && opts.onStart) opts.onStart({ cancel() { state.cancelled = true; } });
      opts && opts.onOutput && opts.onOutput("roadie: asking the user in a dialog…", "stderr");
      if (state.decline) return { exitCode: 2, stdout: JSON.stringify({ status: "declined" }), stderr: "" };
      state.tool = { ...notInstalled };
      return { exitCode: 0, stdout: JSON.stringify({ status: "done" }), stderr: "" };
    }
    if (cmd[0] === "tool" && cmd[1] === "autostart") {
      state.tool = { ...state.tool, autostart: cmd[3] === "on" };
      return { exitCode: 0, stdout: JSON.stringify(state.tool), stderr: "" };
    }
    if (cmd[0] === "tool" && cmd[1] === "restart") {
      state.restartCalls = (state.restartCalls || 0) + 1;
      if (state.onRestart) state.onRestart();
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
      const conn = { url: "http://127.0.0.1:5030", apiKey: state.key || "r".repeat(48) };
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

test("integration: with no slskd found by itself, a fresh plugin adopts an approved Roadie connection", async () => {
  const state = { tool: installedApproved };
  await withPlugin({ store: { url: "", apiKey: "" }, dependencies: roadieHere, exec: fakeRoadie(state) }, async (host) => {
    await until(() => host.store.managedBy === "roadie", 2000);
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

test("remove: the two choices Roadie's own window offers, then Roadie's progress in place of the button", () => {
  assert.deepEqual(plugin._roadieUninstallArgs(true), ["tool", "uninstall", "slskd", "--keep-data"]);
  assert.deepEqual(plugin._roadieUninstallArgs(false), ["tool", "uninstall", "slskd"]);
  const rows = plugin._roadieRemoveRows;
  assert.deepEqual(clickable(rows({ asking: false, error: null }, null)), ["roadie-remove-ask"]);
  const asking = rows({ asking: true, error: null }, null);
  assert.deepEqual(clickable(asking), ["roadie-remove", "roadie-remove", "roadie-remove-cancel"]);
  assert.ok(JSON.stringify(asking).includes("downloads and shared folders stay"), "says what is never deleted");
  const running = rows({ asking: false, error: null }, { kind: "uninstall", line: "Waiting…", cancel() {} });
  assert.deepEqual(clickable(running), ["roadie-cancel"]);
  assert.ok(JSON.stringify(rows({ asking: false, error: "You declined it in Roadie's dialog." }, null)).includes("Roadie: You declined"));
  const other = rows({ asking: false, error: null }, { kind: "start", line: "Starting slskd…" });
  assert.ok(JSON.stringify(other).includes('"disabled":true'), "one Roadie command at a time");
});

test("files: each place Roadie reports gets a row; the settings file is revealed, never opened", () => {
  const rows = plugin._roadieFileRows;
  const tool = { ...installedApproved, installDir: "/r/tools/slskd/versions/0.26.0", dataDir: "/r/tools/slskd/data",
    logsDir: "/r/tools/slskd/logs", configFiles: [{ path: "/r/tools/slskd/data/slskd.yml", secret: true }] };
  assert.deepEqual(clickable(rows(tool, true, false)), ["roadie-files-toggle"], "folded: one row, one Show");
  const out = rows(tool, true, true);
  const buttons = [];
  const walk = (n) => { if (!n || typeof n !== "object") return; if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === "button" && n.action === "roadie-open-path") buttons.push(n); walk(n.children); walk(n.control); };
  walk(out);
  assert.equal(out.length, 5, "one row per place plus the toggle; buttons ride on the rows");
  assert.deepEqual(buttons.map((b) => [b.label, b.data.path, b.data.reveal]), [
    ["Show in folder", "/r/tools/slskd/data/slskd.yml", true],
    ["Open folder", "/r/tools/slskd/versions/0.26.0", false],
    ["Open folder", "/r/tools/slskd/data", false],
    ["Open folder", "/r/tools/slskd/logs", false]
  ]);
  assert.deepEqual(rows(installedApproved, true, true), [], "an older Roadie reports no paths → no rows");
  assert.deepEqual(rows(tool, false, true), [], "a host that can't open paths → no rows");
});

test("integration: Open folder goes through the host, and a failure says so", async () => {
  const state = { tool: { ...installedApproved, dataDir: "/r/data", configFiles: [{ path: "/r/data/slskd.yml", secret: true }] } };
  const opened = [];
  const host = fakeHost({
    store: { url: "http://127.0.0.1:5030", apiKey: "r".repeat(48), managedBy: "roadie" },
    dependencies: roadieHere,
    exec: fakeRoadie(state)
  });
  host.api.system.openPath = async (p) => { opened.push(["open", p]); if (p === "/r/data") throw new Error("no such folder"); };
  host.api.system.revealPath = async (p) => { opened.push(["reveal", p]); };
  const p = loadPlugin();
  try {
    await p.activate(host.api);
    host.actions["main-tab"]({ tabId: "settings" });
    assert.ok(!lastView(host).includes('"action":"roadie-open-path"'), "folded until asked");
    host.actions["roadie-files-toggle"]();
    assert.ok(lastView(host).includes('"action":"roadie-open-path"'), "rows shown for a Roadie-managed slskd");
    await host.actions["roadie-open-path"]({ path: "/r/data/slskd.yml", reveal: true });
    await host.actions["roadie-open-path"]({ path: "/r/data", reveal: false });
    await until(() => host.calls.notifications.length > 0);
    assert.deepEqual(opened, [["reveal", "/r/data/slskd.yml"], ["open", "/r/data"]]);
    assert.match(JSON.stringify(host.calls.notifications.at(-1)), /Couldn't open \/r\/data: no such folder/);
  } finally {
    p.deactivate();
  }
});

test("integration: Remove slskd uninstalls through Roadie and forgets the managed connection", async () => {
  const state = { tool: { ...installedApproved } };
  await withPlugin({
    store: { url: "http://127.0.0.1:5030", apiKey: "r".repeat(48), managedBy: "roadie" },
    dependencies: roadieHere,
    exec: fakeRoadie(state)
  }, async (host) => {
    host.actions["main-tab"]({ tabId: "settings" });
    assert.ok(lastView(host).includes('"action":"roadie-remove-ask"'), "offered for a slskd Roadie manages");
    host.actions["roadie-remove-ask"]();
    assert.ok(lastView(host).includes("Remove everything"));
    await host.actions["roadie-remove"]({ keepData: true });
    await until(() => host.store.managedBy === null);
    assert.deepEqual(state.uninstallArgs, ["tool", "uninstall", "slskd", "--keep-data"]);
    assert.equal(host.store.managedBy, null);
    assert.equal(host.store.url, "");
    assert.notEqual(host.store.apiKey, "r".repeat(48), "Roadie's key is dropped (the setup guide mints its own)");
    await until(() => !lastView(host).includes("roadie-remove-ask"));
    assert.ok(!lastView(host).includes("roadie-remove-ask"), "nothing left to remove");
    assert.equal(host.calls.notifications.length, 0, "success is the view changing, not a toast");
  });
});

test("integration: declining Roadie's dialog keeps slskd and says so under the button", async () => {
  const state = { tool: { ...installedApproved }, decline: true };
  await withPlugin({
    store: { url: "http://127.0.0.1:5030", apiKey: "r".repeat(48), managedBy: "roadie" },
    dependencies: roadieHere,
    exec: fakeRoadie(state)
  }, async (host) => {
    host.actions["main-tab"]({ tabId: "settings" });
    host.actions["roadie-remove-ask"]();
    await host.actions["roadie-remove"]({ keepData: false });
    await until(() => lastView(host).includes("Roadie: You declined"));
    assert.deepEqual(state.uninstallArgs, ["tool", "uninstall", "slskd"]);
    assert.ok(lastView(host).includes("Roadie: You declined"));
    assert.equal(host.store.managedBy, "roadie", "still connected");
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
    assert.ok(v.includes('"value":"roadie"') && v.includes("Roadie set up"), v.slice(0, 800));
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

// Not ready is a banner on top of the normal view, like yt-dlp's — never a
// toast, at launch or later.
const stopped = { ...installedApproved, running: false };
const nothingAnswers = async (url) => { if (url.includes("/api/v0/application")) throw new Error("connection refused"); };
const managedStore = { url: "http://127.0.0.1:5030", apiKey: "r".repeat(48), managedBy: "roadie" };
const findNodes = (n, pred, out = []) => {
  if (!n || typeof n !== "object") return out;
  if (Array.isArray(n)) { n.forEach((c) => findNodes(c, pred, out)); return out; }
  if (pred(n)) out.push(n);
  findNodes(n.children, pred, out);
  return out;
};
const bannerOf = (host) => {
  const view = host.calls.views.filter((v) => v.viewId === "slskd-browse").at(-1).data;
  return findNodes(view, (n) => /\bds-banner\b/.test(n.className || ""))[0] || null;
};

test("the banner: Start for a stopped Roadie slskd, Try again + Fix for everything else, nothing when ready", () => {
  const banner = plugin._readinessBanner;
  const r = { supported: true, installed: true, tool: stopped };
  const roadieCfg = { url: "http://127.0.0.1:5030", managedBy: "roadie" };
  assert.deepEqual(clickable(banner("unreachable", roadieCfg, r)), ["roadie-start"]);
  assert.match(banner("unreachable", roadieCfg, r).className, /ds-banner--warning/);
  assert.deepEqual(clickable(banner("unreachable", { url: "http://nas:5030", managedBy: null }, r)), ["test-connection", "slskd-show-fix"], "a slskd the user runs: Viboplr can't start it");
  assert.match(JSON.stringify(banner("unreachable", { url: "http://nas:5030", managedBy: null }, r)), /Can't reach slskd at http:\/\/nas:5030/);
  assert.deepEqual(clickable(banner("unreachable", roadieCfg, { ...r, tool: notInstalled })), ["test-connection", "slskd-show-fix"], "Roadie says it's gone: nothing to start");
  assert.deepEqual(clickable(banner("unauthorized", roadieCfg, r)), ["slskd-show-fix"]);
  assert.deepEqual(clickable(banner("disconnected", roadieCfg, r)), ["roadie-restart", "slskd-show-fix"], "Roadie's slskd restarts to sign in again");
  assert.deepEqual(clickable(banner("disconnected", { url: "http://nas:5030" }, r)), ["test-connection", "slskd-show-fix"], "nothing to restart: check again");
  assert.deepEqual(clickable(banner("unauthorized", roadieCfg, r, null, true)), [], "on Settings, Fix… has nowhere to go");
  assert.deepEqual(clickable(banner("unreachable", { url: "http://nas:5030" }, r, null, true)), ["test-connection"]);
  assert.deepEqual(clickable(banner("connecting", roadieCfg, r)), []);
  assert.equal(banner("ready", roadieCfg, r), null);
  assert.equal(banner("unconfigured", roadieCfg, r), null, "the first run is the setup hub, not a banner");
  assert.equal(banner("unreachable", roadieCfg, { ...r, job: { kind: "start" } }).children[1].children[0].disabled, true, "no second start while one runs");
});

// The host's view header says whether slskd works in one word; the fix stays
// in the banner below the tabs.
test("the header: one status word per state, the address, and Open slskd when there's a page to open", () => {
  const header = plugin._viewHeaderFor;
  const user = { url: "http://localhost:5030", managedBy: null };
  const roadieCfg = { url: "http://127.0.0.1:5030", managedBy: "roadie" };
  const r = { supported: true, installed: true, tool: stopped };

  const ready = header({ state: "ready", username: "outcast1000", version: "0.26.0" }, user, r, "local", null);
  assert.deepEqual(ready, {
    subtitle: "Connected as outcast1000 · slskd 0.26.0",
    status: { variant: "success", label: "Ready" },
    actions: [{ label: "Open slskd", action: "open-slskd" }]
  });
  assert.match(header({ state: "ready", username: "me" }, user, r, "remote", null).subtitle, /on another computer$/);

  const label = (st, cfg) => header({ state: st }, cfg, r, "local", null).status;
  assert.deepEqual(label("unreachable", roadieCfg), { variant: "warning", label: "Not running" }, "Roadie's slskd is only stopped");
  assert.deepEqual(label("unreachable", user), { variant: "error", label: "Unreachable" });
  assert.deepEqual(label("unauthorized", user), { variant: "error", label: "Key rejected" });
  assert.deepEqual(label("disconnected", roadieCfg), { variant: "warning", label: "Signed out" });
  assert.deepEqual(label("connecting", user), { variant: "muted", label: "Connecting…" });
  assert.deepEqual(label("unconfigured", { url: "" }), { variant: "muted", label: "Not set up" });

  assert.equal(header({ state: "unreachable" }, roadieCfg, r, "local", null).subtitle, "slskd from Roadie · http://127.0.0.1:5030");
  assert.deepEqual(header({ state: "unreachable" }, user, r, "local", null).actions, [], "nothing answers, so no page to open");
  assert.deepEqual(header({ state: "unconfigured" }, { url: "" }, r, "local", { step: 1 }).status, { variant: "muted", label: "Setting up" });
});

test("integration: the header follows readiness and is sent only when it changes", async () => {
  let up = true;
  await withPlugin({
    store: { url: "http://localhost:5030", apiKey: "k".repeat(40) },
    dependencies: {}, exec: async () => { throw new Error("no exec"); },
    fetch: async (url) => {
      if (!url.includes("/api/v0/application")) return undefined;
      if (!up) throw new Error("connection refused");
      return { status: 200, text: async () => JSON.stringify({ server: { state: "Connected, LoggedIn", isLoggedIn: true, isTransitioning: false, username: "me" }, version: { current: "0.26.0" }, shares: { directories: 1 } }) };
    }
  }, async (host) => {
    await until(() => host.calls.headers.some((h) => h.header.status.label === "Ready"));
    const last = host.calls.headers.at(-1);
    assert.equal(last.viewId, "slskd-browse");
    assert.equal(last.header.subtitle, "Connected as me · slskd 0.26.0");
    const sent = host.calls.headers.length;
    host.actions["main-tab"]({ tabId: "settings" });
    host.actions["main-tab"]({ tabId: "search" });
    assert.equal(host.calls.headers.length, sent, "re-rendering the same state sends nothing new");

    up = false;
    await host.actions["test-connection"]();
    await until(() => host.calls.headers.at(-1).header.status.label === "Unreachable");
    assert.ok(bannerOf(host), "the problem and its fix are still the banner");
  });
});

test("integration: Test says Checking… while it runs and when it last ran; Fix… opens Settings at the top", async () => {
  let release = null;
  await withPlugin({
    store: { url: "http://localhost:5030", apiKey: "k".repeat(40) },
    dependencies: {}, exec: async () => { throw new Error("no exec"); },
    fetch: async (url) => {
      if (url.includes("/api/v0/logs")) return { status: 200, text: async () => JSON.stringify(API_LOG_BLOCKED) };
      if (!url.includes("/api/v0/application")) return undefined;
      if (release) await new Promise((res) => { const r = release; release = null; r.wait = res; });
      return { status: 200, text: async () => JSON.stringify({ server: { state: "Disconnected", isLoggedIn: false, isTransitioning: false }, version: { current: "0.26.0" } }) };
    }
  }, async (host) => {
    await until(() => /This network blocks Soulseek/.test(JSON.stringify(bannerOf(host) || {})));
    const lastView = () => host.calls.views.filter((v) => v.viewId === "slskd-browse").at(-1);

    host.actions["slskd-show-fix"]();
    const fixed = lastView();
    assert.match(fixed.opts.scrollKey, /^settings:fix:/, "a fresh key → the explanation at the top");
    assert.match(JSON.stringify(fixed.data), /web filter/, "the reason is on Settings");
    assert.ok(!clickable(bannerOf(host)).includes("slskd-show-fix"), "no dead Fix… on Settings itself");

    release = {};
    const gate = release;
    const done = host.actions["test-connection"]();
    await until(() => JSON.stringify(lastView().data).includes("Checking…"));
    assert.equal(findNodes(lastView().data, (n) => n.action === "test-connection").every((b) => b.disabled), true, "no double check");
    await until(() => gate.wait);
    gate.wait();
    await done;
    assert.match(JSON.stringify(lastView().data), /checked just now/);
  });
});

test("integration: an older host without setViewHeader just doesn't get a header", async () => {
  await withPlugin({ store: managedStore, fetch: nothingAnswers, dependencies: roadieHere, exec: fakeRoadie({ tool: stopped }), noViewHeader: true }, async (host) => {
    await until(() => bannerOf(host));
    assert.equal(host.calls.headers.length, 0);
  });
});

test("the full-page setup screen is the first run, or a setup page the user opened", () => {
  const wants = plugin._wantsSetupScreen;
  assert.equal(wants("unconfigured", "home"), true);
  assert.equal(wants("unreachable", "home"), false, "stopped after it worked → the tabs with a banner");
  assert.equal(wants("unreachable", "connect"), true);
  assert.equal(wants("unauthorized", "connect"), false);
  assert.equal(wants("ready", "home"), false);
});

test("integration: at launch a stopped Roadie slskd shows the banner, no toast, and Start runs Roadie", async () => {
  const state = { tool: stopped };
  await withPlugin({ store: managedStore, fetch: nothingAnswers, dependencies: roadieHere, exec: fakeRoadie(state) }, async (host) => {
    await until(() => bannerOf(host));
    assert.ok(lastView(host).includes('"type":"tabs"'), "the view stays usable");
    assert.deepEqual(clickable(bannerOf(host)), ["roadie-start"]);
    await host.actions["roadie-start"]();
    await until(() => state.startCalls);
    assert.equal(state.startCalls, 1);
    assert.equal(host.calls.notices.length, 0, "never a toast");
  });
});

test("integration: a start Roadie refuses says why, under the banner", async () => {
  const state = { tool: stopped, startCmdFails: "Another copy of slskd is running on this computer." };
  await withPlugin({ store: managedStore, fetch: nothingAnswers, dependencies: roadieHere, exec: fakeRoadie(state) }, async (host) => {
    await until(() => bannerOf(host));
    await host.actions["roadie-start"]();
    await until(() => lastView(host).includes("Roadie: Another copy of slskd"));
    assert.ok(bannerOf(host), "still not running, still says so");
    assert.equal(host.calls.notices.length, 0);
  });
});

test("integration: the user's own first Connect that finds nothing raises no toast", async () => {
  await withPlugin({ store: { url: "", apiKey: "" }, fetch: nothingAnswers, dependencies: {}, exec: async () => { throw new Error("no exec"); } }, async (host) => {
    await host.actions["setup-page"]({ page: "install-manual" });
    await host.actions["setup-connect"]();
    await until(() => lastView(host).includes("Nothing answered"));
    assert.ok(!lastView(host).includes('"type":"tabs"'), "still on the page they clicked in");
    assert.equal(host.calls.notices.length, 0, "the screen they clicked in already says it");
  });
});

test("integration: a slskd the user runs that stopped answering: banner, Fix opens the explanation in Settings", async () => {
  await withPlugin({ store: { url: "http://localhost:5030", apiKey: "k".repeat(40) }, fetch: nothingAnswers, dependencies: {}, exec: async () => { throw new Error("no exec"); } }, async (host) => {
    await until(() => bannerOf(host));
    assert.match(JSON.stringify(bannerOf(host)), /Can't reach slskd at http:\/\/localhost:5030/);
    host.actions["slskd-show-fix"]();
    const v = lastView(host);
    assert.ok(v.includes("Not installed any more?") && v.includes('"action":"set-url"'), "the hub's ways forward, then the Connection form");
    assert.equal(host.calls.notices.length, 0);
  });
});

test("integration: slskd dying mid-session turns into the banner, not a toast", async () => {
  let up = true;
  await withPlugin({
    store: { url: "http://localhost:5030", apiKey: "k".repeat(40) },
    dependencies: {}, exec: async () => { throw new Error("no exec"); },
    fetch: async (url) => {
      if (!url.includes("/api/v0/application")) return undefined;
      if (!up) throw new Error("connection refused");
      return { status: 200, text: async () => JSON.stringify({ server: { state: "Connected, LoggedIn", isLoggedIn: true, isTransitioning: false, username: "me" }, version: { current: "0.26.0" }, shares: { directories: 1 } }) };
    }
  }, async (host) => {
    await until(() => lastView(host).includes('"type":"tabs"') && !bannerOf(host));
    up = false;
    await host.actions["test-connection"]();
    await until(() => bannerOf(host));
    assert.equal(host.calls.notices.length, 0);
  });
});

// Lines from the owner's slskd on 2026-09-27: kicked by another client using
// the same account, after which slskd never signed in again.
const LOG_KICKED = [
  "[03:03:01 INF] Logged in to the Soulseek server as outcast1000",
  "[08:47:10 INF] Kicked from server.",
  "[08:47:10 ERR] Disconnected from the Soulseek server: Remote connection closed",
  "[08:47:12 INF] Logged in to the Soulseek server as outcast1000",
  "[08:47:20 INF] Kicked from server.",
  "[08:47:20 ERR] Disconnected from the Soulseek server: another client logged in using the same username",
  "[08:48:18 WRN] Unauthorized request from IP address 127.0.0.1: Unknown API key beginning with: 544e"
];

test("sign-in reason: a kick is named as a kick, not a firewall; a newer sign-in clears old failures", () => {
  const why = plugin._signinReasonFromLog;
  const kicked = why(LOG_KICKED, "outcast1000");
  assert.equal(kicked.kind, "kicked");
  assert.match(kicked.message, /another app signed in as outcast1000/);
  assert.match(kicked.message, /restart slskd/);
  assert.equal(why(LOG_KICKED.slice(0, 4), "outcast1000"), null, "signed in again after the first drop → nothing to report");
  assert.equal(why(LOG_TIMEOUT.concat(["[12:20:00 INF] Logged in to the Soulseek server as bj"]), "bj"), null);
});

test("Roadie's slskd is recognised whatever loopback name the address uses", () => {
  const owns = plugin._roadieOwnsAddress;
  const tool = { installed: true, url: "http://127.0.0.1:5030" };
  assert.equal(owns("http://localhost:5030", tool), true);
  assert.equal(owns("http://127.0.0.1:5030/", tool), true);
  assert.equal(owns("http://localhost:5031", tool), false, "another port is another slskd");
  assert.equal(owns("http://nas.local:5030", tool), false);
  assert.equal(owns("http://localhost:5030", { ...tool, installed: false }), false);
});

test("key rejected + an approved Roadie slskd → Use Roadie's slskd, not a yml edit", () => {
  const r = { installed: true, tool: { ...installedApproved } };
  const nodes = plugin._unauthorizedNodes({ url: "http://localhost:5030", managedBy: null }, r);
  assert.deepEqual(clickable(nodes), ["roadie-connect", "setup-open-guide"]);
  assert.ok(!JSON.stringify(nodes).includes("api_keys in slskd.yml"), "no advice to edit a file Roadie rewrites");
  const plain = plugin._unauthorizedNodes({ url: "http://localhost:5030", managedBy: null }, { installed: false });
  assert.deepEqual(clickable(plain), ["setup-open-guide"], "no Roadie → the guide, as before");
});

test("signed out, Roadie's slskd → the log's reason and Restart slskd", () => {
  const r = { installed: true, tool: { ...installedApproved } };
  const why = plugin._signinReasonFromLog(LOG_KICKED, "outcast1000");
  const nodes = plugin._disconnectedNodes({ url: "http://127.0.0.1:5030" }, r, why);
  assert.deepEqual(clickable(nodes), ["roadie-restart", "open-slskd"]);
  assert.ok(JSON.stringify(nodes).includes("another app signed in as outcast1000"));
  const own = plugin._disconnectedNodes({ url: "http://nas.local:5030" }, r, why);
  assert.deepEqual(clickable(own), ["setup-open-guide", "open-slskd", "test-connection"], "a slskd the user runs keeps the yml advice");
  assert.ok(JSON.stringify(own).includes("another app signed in as outcast1000"), "its log's reason too");
});

// The owner's work Mac: Zscaler takes the TCP connection to the Soulseek
// server and answers the login with an HTTP 403, so slskd logs connect-then-
// closed forever. As slskd's GET /api/v0/logs returns it (note the stray quote).
const API_LOG_BLOCKED = [
  { level: "Information", message: "Attempting to connect to the Soulseek server (#8)..." },
  { level: "Information", message: "Connected to the Soulseek server" },
  { level: "Error", message: "Disconnected from the Soulseek server: \"Remote connection closed" },
  { level: "Error", message: "Failed to reconnect: \"The wait timed out after 5000 milliseconds" },
  { level: "Information", message: "Waiting about 256 seconds before attempting to reconnect" }
];

test("sign-in reason: connect-then-closed is a blocking network, and a restart isn't offered for it", () => {
  const lines = plugin._apiLogMessages(API_LOG_BLOCKED);
  assert.equal(lines.length, 5);
  assert.deepEqual(plugin._apiLogMessages({ nope: 1 }), []);
  const why = plugin._signinReasonFromLog(lines, null);
  assert.equal(why.kind, "blocked");
  assert.match(why.message, /web filter/);
  const r = { installed: true, tool: { ...installedApproved } };
  const nodes = plugin._disconnectedNodes({ url: "http://127.0.0.1:5030" }, r, why);
  assert.deepEqual(clickable(nodes), ["test-connection", "open-slskd"], "Roadie's slskd too: restarting won't get past the network");
  const banner = plugin._readinessBanner("disconnected", { url: "http://127.0.0.1:5030" }, r, why);
  assert.deepEqual(clickable(banner), ["test-connection", "slskd-show-fix"]);
  assert.match(JSON.stringify(banner), /This network blocks Soulseek/);
  // A plain drop with no connect right before it stays the generic network case.
  assert.equal(plugin._signinReasonFromLog(lines.slice(2), null).kind, "network");
});

test("checked-ago text", () => {
  assert.equal(plugin._checkedAgo(0, 1000), "");
  assert.equal(plugin._checkedAgo(1000, 30000), "checked just now");
  assert.equal(plugin._checkedAgo(0 + 1, 3 * 60000), "checked 3 min ago");
});

test("integration: the owner's case — a guide key on Roadie's slskd, then a kick, fixed from the screen", async () => {
  const state = { tool: { ...installedApproved, config: { soulseekUsername: "outcast1000" },
    installDir: "/r/versions/0.26.0", dataDir: "/r/data", logsDir: "/r/logs", configFiles: [{ path: "/r/data/slskd.yml", secret: true }] },
    logLines: LOG_KICKED };
  let loggedIn = false;
  const roadieKey = "r".repeat(48);
  const keyOf = (init) => {
    const h = (init && init.headers) || {};
    for (const k of Object.keys(h)) if (k.toLowerCase() === "x-api-key") return h[k];
    return null;
  };
  await withPlugin({
    store: { url: "http://localhost:5030", apiKey: "544e" + "0".repeat(38), managedBy: null },
    dependencies: roadieHere,
    exec: fakeRoadie(state),
    fetch: async (url, init) => {
      if (!url.includes("/api/v0/application")) return undefined;
      if (keyOf(init) !== roadieKey) return { status: 401, text: async () => JSON.stringify("unauthorized") };
      const server = loggedIn ? { state: "Connected, LoggedIn", isLoggedIn: true, isTransitioning: false, username: "outcast1000" }
        : { state: "Disconnected", isLoggedIn: false, isTransitioning: false };
      return { status: 200, text: async () => JSON.stringify({ server, version: { current: "0.26.0" }, shares: { directories: 1 } }) };
    }
  }, async (host) => {
    await until(() => lastView(host).includes("slskd rejected the API key"));
    assert.deepEqual(clickable(bannerOf(host)), ["slskd-show-fix"]);
    host.actions["slskd-show-fix"]();
    const v = lastView(host);
    assert.ok(v.includes('"action":"roadie-connect"'), "offers Roadie's slskd");
    assert.ok(v.includes('"action":"roadie-files-toggle"'), "and offers where Roadie keeps it, though not connected through Roadie");
    assert.ok(!v.includes('"action":"roadie-remove-ask"'), "Remove stays with a Roadie-managed connection");

    await host.actions["roadie-connect"]();
    await until(() => lastView(host).includes("slskd isn't signed in to Soulseek"));
    assert.equal(host.store.managedBy, "roadie");
    assert.equal(host.store.apiKey, roadieKey);
    const signedOut = lastView(host);
    assert.ok(signedOut.includes("another app signed in as outcast1000"), signedOut.slice(0, 400));
    assert.ok(signedOut.includes('"action":"roadie-restart"'));

    state.onRestart = () => { loggedIn = true; };
    await host.actions["roadie-restart"]();
    await until(() => !lastView(host).includes("isn't signed in"));
    assert.equal(state.restartCalls, 1);
    assert.ok(!lastView(host).includes("isn't signed in"), "signed in after the restart");
  });
});

test("Roadie's slskd, signed out: the fix on top, one short card, no address/key form", async () => {
  const state = { tool: { ...installedApproved, config: { soulseekUsername: "outcast1000" },
    installDir: "/r/versions/0.26.0", dataDir: "/r/data", logsDir: "/r/logs", configFiles: [{ path: "/r/data/slskd.yml", secret: true }] },
    logLines: LOG_KICKED };
  await withPlugin({
    store: { url: "http://127.0.0.1:5030", apiKey: "r".repeat(48), managedBy: "roadie" },
    dependencies: roadieHere,
    exec: fakeRoadie(state),
    responses: { "/api/v0/application": { server: { state: "Disconnected", isLoggedIn: false, isTransitioning: false }, version: { current: "0.26.0" } } }
  }, async (host) => {
    await until(() => bannerOf(host));
    assert.deepEqual(clickable(bannerOf(host)), ["roadie-restart", "slskd-show-fix"], "the one-click fix is on top of every tab");
    host.actions["slskd-show-fix"]();
    await until(() => lastView(host).includes("another app signed in"));
    const view = host.calls.views.filter((v) => v.viewId === "slskd-browse").at(-1).data;
    const settings = view.children.at(-1);
    assert.deepEqual(clickable(settings).slice(0, 8), ["roadie-restart", "open-slskd", "test-connection", "roadie-files-toggle",
      "roadie-details-toggle", "roadie-remove-ask", "open-slskd", "slskd-show-login"], "Settings: fix, then the card top to bottom, Remove last");
    const text = JSON.stringify(view);
    assert.ok(text.includes('"title":"slskd from Roadie"'));
    assert.ok(!text.includes('"action":"set-url"') && !text.includes('"action":"set-key"'), "no address/key form until Connection details is opened");
    host.actions["roadie-details-toggle"]();
    assert.ok(lastView(host).includes('"action":"set-key"'), "the form is one click away");
  });
});

const sharingTool = (dirs, extra) => ({ ...installedApproved,
  config: { downloadsDir: "/Users/a/Music/Soulseek", shareDownloads: true, soulseekUsername: "bj", "shares.directories": dirs }, ...(extra || {}) });

test("sharing: the gap is the collections slskd doesn't cover yet", () => {
  const gap = plugin._shareGap;
  const cols = [{ id: 1, name: "Downloads", path: "/Users/a/Downloads" }, { id: 2, name: "Music", path: "/Volumes/NAS/Music/" }];
  assert.deepEqual(gap(cols, sharingTool([])), ["/Users/a/Downloads", "/Volumes/NAS/Music/"]);
  assert.deepEqual(gap(cols, sharingTool(["/Volumes/NAS/Music"])), ["/Users/a/Downloads"], "trailing slash is the same folder");
  assert.deepEqual(gap(cols, sharingTool(["/Users/a"])), ["/Volumes/NAS/Music/"], "inside a shared folder is shared");
  assert.deepEqual(gap([{ path: "/Users/a/Music/Soulseek/rock" }], sharingTool([])), [], "inside the shared downloads folder");
  assert.deepEqual(gap(cols, { ...installedApproved, config: {} }), [], "a Roadie without the setting → nothing to offer");
  assert.deepEqual(plugin._sharedDirsWith(sharingTool(["/x"]), ["/y", "/x"]), ["/x", "/y"], "adds, never drops");
});

test("sharing row: offers the gap, then says what's shared; a running change shows on the row", () => {
  const rows = plugin._sharingRows;
  const cols = [{ path: "/Users/a/Downloads" }];
  const offer = rows(sharingTool([]), cols, null, { error: null });
  assert.deepEqual(clickable(offer), ["roadie-share-collections"]);
  assert.ok(JSON.stringify(offer).includes("Not shared yet: /Users/a/Downloads"));
  const done = rows(sharingTool(["/Users/a/Downloads"]), cols, null, { error: null });
  assert.deepEqual(clickable(done), []);
  assert.ok(JSON.stringify(done).includes("Shared: /Users/a/Music/Soulseek, /Users/a/Downloads"));
  assert.deepEqual(clickable(rows(sharingTool([]), cols, { kind: "share", line: "Waiting…", cancel() {} }, { error: null })), ["roadie-cancel"]);
  assert.ok(JSON.stringify(rows(sharingTool([]), cols, null, { error: "You declined it in Roadie's dialog." })).includes("Roadie: You declined"));
});

test("integration: Share… sends Roadie the folder list, then slskd is asked to rescan", async () => {
  const state = { tool: sharingTool([]) };
  const puts = [];
  await withPlugin({
    store: { url: "http://127.0.0.1:5030", apiKey: "r".repeat(48), managedBy: "roadie" },
    dependencies: roadieHere,
    exec: fakeRoadie(state),
    collections: [{ id: 1, name: "Downloads", path: "/Users/a/Downloads" }],
    fetch: async (url, init) => {
      if (url.includes("/api/v0/shares") && init && init.method === "PUT") { puts.push(url); return { status: 204, text: async () => "" }; }
      return undefined;
    }
  }, async (host) => {
    host.actions["main-tab"]({ tabId: "settings" });
    await until(() => lastView(host).includes('"action":"roadie-share-collections"'));
    assert.ok(lastView(host).includes("Not shared yet: /Users/a/Downloads"));
    await host.actions["roadie-share-collections"]();
    await until(() => puts.length > 0);
    assert.deepEqual(state.reinstallArgs, ["tool", "install", "slskd", "--set", 'shares.directories=["/Users/a/Downloads"]']);
    assert.equal(puts.length, 1, "one rescan after the change");
    assert.ok(!lastView(host).includes('"action":"roadie-share-collections"'), "nothing left to share");
    assert.ok(lastView(host).includes("Shared: /Users/a/Music/Soulseek, /Users/a/Downloads"));
    assert.equal(host.calls.notifications.length, 0, "success is the row changing");
  });
});


// ---- Roadie 0.6: one shared key, slskd owns its settings, another copy ----

test("auto-config: a managed key slskd rejects is read again from Roadie, once per key", () => {
  const act = plugin._roadieAutoConfigAction;
  const managed = { url: "http://127.0.0.1:5030", apiKey: "k", managedBy: "roadie" };
  assert.equal(act(managed, installedApproved, "unauthorized"), "rekey", "Roadie's slskd changed its key (a new setup): fetch it, no dialog");
  assert.equal(act(managed, installedApproved, "ok"), null);
  assert.equal(act({ ...managed, managedBy: null }, installedApproved, "unauthorized"), null, "a typed connection is never re-keyed behind the user's back");
  assert.equal(act(managed, { ...installedApproved, approvedConsumers: [] }, "unauthorized"), null, "unapproved: fetching would open Roadie's dialog");
});

test("integration: after Roadie's new slskd setup, the old key's 401 heals itself with the shared key", async () => {
  const state = { tool: installedApproved, key: "s".repeat(48) };
  await withPlugin({
    store: { url: "http://127.0.0.1:5030", apiKey: "r".repeat(48), managedBy: "roadie" },
    dependencies: roadieHere,
    exec: fakeRoadie(state),
    fetch: async (url, init) => {
      if (url.endsWith("/api/v0/application") && init.headers["X-API-Key"] !== "s".repeat(48)) return { status: 401, text: async () => "" };
    }
  }, async (host) => {
    await until(() => host.store.apiKey === "s".repeat(48), 1000);
    assert.equal(host.store.apiKey, "s".repeat(48), "the new key is in");
    assert.ok(!lastView(host).includes("Key rejected"), "the user never saw a rejected key");
    assert.equal(state.connectionAsked, 1, "asked Roadie once");
  });
});

test("an offline Roadie that doesn't know slskd yet says why, not 'unknown tool'", () => {
  const msg = plugin._roadieFailure(1, { error: "unknown tool: slskd" }, "");
  assert.match(msg, /online catalog/);
  assert.match(msg, /internet connection/);
  assert.equal(plugin._roadieFailure(1, { error: "boom" }, ""), "boom");
});

test("slskd's settings file: folders are added under shares → directories and nothing else changes", () => {
  const add = plugin._yamlWithShares;
  const roadieYaml = 'headless: false\nshares:\n  directories:\n    - "/Users/me/Music/Soulseek"\nweb:\n  port: 5030\n';
  assert.equal(add(roadieYaml, ["/Users/me/Music/Rock"]),
    'headless: false\nshares:\n  directories:\n    - "/Users/me/Music/Soulseek"\n    - "/Users/me/Music/Rock"\nweb:\n  port: 5030\n');
  assert.equal(add(roadieYaml, ["/Users/me/Music/Soulseek/"]), roadieYaml, "already shared (a trailing / is the same folder): unchanged");
  assert.equal(add('shares:\n  directories: []\n', ["D:\\Rock"]), 'shares:\n  directories:\n    - "D:\\\\Rock"\n', "an empty list becomes a block list; Windows paths are escaped");
  assert.equal(add('shares:\n  directories: ["/a"]\n', ["/b"]), 'shares:\n  directories:\n    - "/a"\n    - "/b"\n');
  assert.equal(add('a: 1\r\nshares:\r\n  directories:\r\n    - /a\r\n', ["/b"]), 'a: 1\r\nshares:\r\n  directories:\r\n    - /a\r\n    - "/b"\r\n', "CRLF and unquoted items kept");
  assert.equal(add('web:\n  port: 1\n', ["/b"]), 'web:\n  port: 1\nshares:\n  directories:\n    - "/b"\n', "no shares section: one is added");
  assert.equal(add('shares:\n  filters:\n    - x\n', ["/b"]), 'shares:\n  directories:\n    - "/b"\n  filters:\n    - x\n');
  assert.equal(add('shares: { directories: [] }\n', ["/b"]), null, "an inline section: left to the user");
  assert.equal(add('shares:\n  directories:\n    - path: /a\n      alias: x\n', ["/b"]), null, "a shape we don't understand: left to the user");
});

test("slskd's own share list: what it reports, minus excluded folders", () => {
  assert.deepEqual(plugin._sharedFromSlskd({ local: [{ localPath: "/a" }, { localPath: "/b", isExcluded: true }] }), ["/a"]);
  assert.deepEqual(plugin._sharedFromSlskd(null), []);
  const owned = { installed: true, configurable: false, config: { "shares.directories": [] } };
  const cols = [{ kind: "local", path: "/a" }, { kind: "local", path: "/c" }];
  assert.deepEqual(plugin._shareGap(cols, owned, ["/a"]), ["/c"], "measured against slskd, not Roadie's install-time record");
  assert.deepEqual(plugin._shareGap(cols, owned, null), [], "not read yet: no gap claimed");
});

test("sharing into slskd's own settings asks here first, listing the folders", () => {
  const owned = { installed: true, configurable: false, config: { "shares.directories": [] } };
  const rows = JSON.stringify(plugin._sharingRows(owned, [], null, { confirm: ["/Users/me/Music/Rock"] }, []));
  assert.ok(rows.includes("Share these folders?") && rows.includes("/Users/me/Music/Rock") && rows.includes("roadie-share-confirm") && rows.includes("roadie-share-cancel"), rows);
  assert.ok(rows.includes("Everyone on Soulseek"), "says what sharing means");
});

test("integration: Share… on a slskd that owns its settings confirms, edits slskd's file through slskd, then rescans", async () => {
  const tool = { ...installedApproved, configurable: false, config: { "shares.directories": [], downloadsDir: "/Users/me/Music/Soulseek", shareDownloads: true } };
  const state = { tool, webLogin: { username: "slskd", password: "slskd" } };
  let yaml = 'shares:\n  directories:\n    - "/Users/me/Music/Soulseek"\n';
  const seen = [];
  await withPlugin({
    store: { url: "http://127.0.0.1:5030", apiKey: "r".repeat(48), managedBy: "roadie" },
    dependencies: roadieHere,
    exec: fakeRoadie(state),
    collections: [{ id: 1, kind: "local", path: "/Users/me/Music/Rock" }],
    fetch: async (url, init) => {
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      seen.push(init.method + " " + path);
      if (path === "/api/v0/shares" && init.method === "GET") {
        return { status: 200, text: async () => JSON.stringify({ local: yaml.split("\n").filter((l) => l.includes("- ")).map((l) => ({ localPath: JSON.parse(l.trim().slice(2)) })) }) };
      }
      if (path === "/api/v0/session") return { status: 200, text: async () => JSON.stringify({ token: "jwt" }) };
      if (path.startsWith("/api/v0/options/yaml")) assert.equal(init.headers.Authorization, "Bearer jwt", "slskd's settings API wants the admin sign-in");
      if (path === "/api/v0/options/yaml" && init.method === "GET") return { status: 200, text: async () => JSON.stringify(yaml) };
      if (path === "/api/v0/options/yaml/validate") return { status: 200, text: async () => "" };
      if (path === "/api/v0/options/yaml" && init.method === "PUT") { yaml = JSON.parse(init.body); return { status: 200, text: async () => "" }; }
      if (path === "/api/v0/shares" && init.method === "PUT") return { status: 200, text: async () => "" };
    }
  }, async (host) => {
    host.actions["main-tab"]({ tabId: "settings" });
    await until(() => settingsView(host).includes("roadie-share-collections"), 1000);
    await host.actions["roadie-share-collections"]();
    await until(() => settingsView(host).includes("Share these folders?"));
    assert.ok(!seen.some((s) => s.startsWith("PUT")), "nothing changes before the user says yes");
    await host.actions["roadie-share-confirm"]();
    await until(() => seen.includes("PUT /api/v0/shares"), 1000);
    assert.ok(yaml.includes('- "/Users/me/Music/Rock"') && yaml.includes('- "/Users/me/Music/Soulseek"'), yaml);
    assert.ok(seen.indexOf("POST /api/v0/options/yaml/validate") < seen.indexOf("PUT /api/v0/options/yaml"), "slskd validates before it saves");
    assert.ok(!state.reinstallArgs, "Roadie isn't asked to change a file slskd owns");
  });
});

test("integration: a settings file the plugin won't edit is left alone, with the folders to add by hand", async () => {
  const tool = { ...installedApproved, configurable: false, config: { "shares.directories": [] } };
  const state = { tool };
  const seen = [];
  await withPlugin({
    store: { url: "http://127.0.0.1:5030", apiKey: "r".repeat(48), managedBy: "roadie" },
    dependencies: roadieHere,
    exec: fakeRoadie(state),
    collections: [{ id: 1, kind: "local", path: "/Users/me/Music/Rock" }],
    fetch: async (url, init) => {
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      seen.push(init.method + " " + path);
      if (path === "/api/v0/shares") return { status: 200, text: async () => JSON.stringify({ local: [] }) };
      if (path === "/api/v0/session") return { status: 200, text: async () => JSON.stringify({ token: "jwt" }) };
      if (path === "/api/v0/options/yaml") return { status: 200, text: async () => JSON.stringify("shares: { directories: [] }\n") };
    }
  }, async (host) => {
    host.actions["main-tab"]({ tabId: "settings" });
    await until(() => settingsView(host).includes("roadie-share-collections"), 1000);
    await host.actions["roadie-share-collections"]();
    await until(() => settingsView(host).includes("Share these folders?"));
    await host.actions["roadie-share-confirm"]();
    await until(() => settingsView(host).includes("shares → directories"), 1000);
    const v = settingsView(host);
    assert.ok(v.includes("/Users/me/Music/Rock") && v.includes("Open slskd's settings"), v.slice(0, 1500));
    assert.ok(!seen.some((s) => s.startsWith("PUT /api/v0/options")), "nothing written");
  });
});

test("recipe update: offered on the card, reviewed in Roadie's dialog, then the new key is picked up", async () => {
  const tool = { ...installedApproved, revision: 5, recipeUpdate: { revision: 6, changedKeys: ["connection", "files"] } };
  const state = { tool };
  await withPlugin({
    store: { url: "http://127.0.0.1:5030", apiKey: "r".repeat(48), managedBy: "roadie" },
    dependencies: roadieHere,
    exec: fakeRoadie(state)
  }, async (host) => {
    host.actions["main-tab"]({ tabId: "settings" });
    await until(() => settingsView(host).includes("roadie-recipe-update"), 1000);
    assert.ok(settingsView(host).includes("setup 5 → 6") && settingsView(host).includes("nothing changes until you approve it"));
    await host.actions["roadie-recipe-update"]();
    await until(() => host.store.apiKey === "s".repeat(48), 1000);
    assert.equal(state.upgradeAsked, 1);
    assert.ok(!settingsView(host).includes("roadie-recipe-update"), "the offer is gone once applied");
  });
});

test("recipe update: declined in Roadie's dialog, the offer stays and nothing changes", async () => {
  const tool = { ...installedApproved, revision: 5, recipeUpdate: { revision: 6, changedKeys: [] } };
  const state = { tool, decline: true };
  await withPlugin({
    store: { url: "http://127.0.0.1:5030", apiKey: "r".repeat(48), managedBy: "roadie" },
    dependencies: roadieHere,
    exec: fakeRoadie(state)
  }, async (host) => {
    host.actions["main-tab"]({ tabId: "settings" });
    await until(() => settingsView(host).includes("roadie-recipe-update"), 1000);
    await host.actions["roadie-recipe-update"]();
    await until(() => state.upgradeAsked === 1);
    await until(() => settingsView(host).includes("roadie-recipe-update"));
    assert.equal(host.store.apiKey, "r".repeat(48), "same key");
    assert.ok(!settingsView(host).includes("declined"), "a no is not an error");
  });
});

test("another slskd already running: the install page says so and offers to connect to it instead", async () => {
  const oi = { url: "http://127.0.0.1:5030", blocksStart: true, message: "Another slskd is already running on this computer (http://127.0.0.1:5030)." };
  const nodes = JSON.stringify(plugin._otherInstanceNodes(oi));
  assert.ok(nodes.includes("slskd is already running here") && nodes.includes("one copy per computer") && nodes.includes("roadie-use-other"), nodes);
  assert.deepEqual(plugin._otherInstanceNodes(null), []);

  const state = { tool: notInstalled, options: { tool: "slskd", options: [], otherInstance: oi } };
  await withPlugin({ store: { url: "", apiKey: "" }, dependencies: roadieHere, exec: fakeRoadie(state) }, async (host) => {
    await openAutoInstall(host);
    await until(() => lastView(host).includes("slskd is already running here"), 1000);
    assert.ok(lastView(host).includes("roadie-set-user"), "the install form stays: the user may quit the other copy first");
    await host.actions["roadie-use-other"]();
    await until(() => host.store.url === "http://127.0.0.1:5030", 1000);
    assert.equal(host.store.url, "http://127.0.0.1:5030", "the connect page starts from the other copy's address");
  });

  // An older Roadie without `tool options`: no notice, the form as before.
  const old = { tool: notInstalled };
  await withPlugin({ store: { url: "", apiKey: "" }, dependencies: roadieHere, exec: fakeRoadie(old) }, async (host) => {
    await openAutoInstall(host);
    assert.ok(!lastView(host).includes("already running here"));
  });
});


// ---- First run: find slskd by itself, before any Roadie ------------------

// A slskd on `port` that wants `key` (or none with authEnabled false).
const slskdAt = (port, key, authEnabled = true) => async (url, init) => {
  const m = /^https?:\/\/127\.0\.0\.1:(\d+)(\/[^?]*)/.exec(url);
  if (!m || Number(m[1]) !== port) return { status: 599, text: async () => "" }; // nothing listens
  if (m[2] === "/api/v0/session/enabled") return { status: 200, text: async () => (authEnabled ? "true" : "false") };
  if (authEnabled && init.headers["X-API-Key"] !== key) return { status: 401, text: async () => "" };
};

test("discovery: slskd's anonymous session/enabled answer tells it apart; the usual ports are tried first", () => {
  assert.deepEqual(plugin._slskdFingerprint(200, "true"), { authEnabled: true });
  assert.deepEqual(plugin._slskdFingerprint(200, " False\n"), { authEnabled: false });
  assert.equal(plugin._slskdFingerprint(200, "<html>"), null, "something else on the port");
  assert.equal(plugin._slskdFingerprint(401, "true"), null);
  const c = plugin._discoveryCandidates().map((x) => x.url);
  assert.deepEqual(c.slice(0, 3), ["http://127.0.0.1:5030", "http://127.0.0.1:5031", "https://127.0.0.1:5031"]);
  assert.ok(c.includes("http://127.0.0.1:5040"));
});

test("integration: a slskd running here with the plugin's key connects on first run, no Roadie asked", async () => {
  const key = "g".repeat(40);
  await withPlugin({ store: { url: "", apiKey: key }, dependencies: roadieHere, exec: fakeRoadie({ tool: installedApproved }), fetch: slskdAt(5030, key) }, async (host) => {
    await until(() => host.store.url === "http://127.0.0.1:5030", 2000);
    assert.equal(host.store.managedBy, null, "the user's own slskd");
    assert.equal(host.calls.exec.length, 0, "Roadie is never reached");
  });
});

test("integration: a slskd here that wants another key asks for it, and only a key slskd accepts is kept", async () => {
  const theirs = "t".repeat(40);
  await withPlugin({ store: { url: "", apiKey: "" }, fetch: slskdAt(5032, theirs) }, async (host) => {
    await until(() => lastView(host).includes("Found slskd on this computer"), 2000);
    const v = lastView(host);
    assert.ok(v.includes("http://127.0.0.1:5032") && v.includes("discover-set-key") && v.includes("api_keys"), v.slice(0, 1200));
    assert.ok(!v.includes("Install automatically"), "found: no install offer in the way");
    assert.ok(!v.includes("Get the key from Roadie"), "no Roadie here: not offered");
    await host.actions["discover-set-key"]({ value: "wrong" });
    await host.actions["discover-connect"]();
    await until(() => lastView(host).includes("didn't accept that key"));
    assert.equal(host.store.url, "", "a wrong key saves nothing");
    await host.actions["discover-set-key"]({ value: theirs });
    await host.actions["discover-connect"]();
    await until(() => host.store.apiKey === theirs, 1000);
    assert.equal(host.store.url, "http://127.0.0.1:5032");
  });
});

test("integration: a slskd here with authentication off connects without a key", async () => {
  await withPlugin({ store: { url: "", apiKey: "" }, fetch: slskdAt(5030, null, false) }, async (host) => {
    await until(() => host.store.url === "http://127.0.0.1:5030", 2000);
  });
});

test("integration: no slskd and no Roadie: the whole setup still works (guide or address)", async () => {
  await withPlugin({ store: { url: "", apiKey: "" }, fetch: async () => ({ status: 599, text: async () => "" }) }, async (host) => {
    await until(() => lastView(host).includes("No slskd is running on this computer"), 2000);
    const v = lastView(host);
    assert.ok(v.includes("install-manual") && v.includes('"page":"connect"') && v.includes("discover-again"), v.slice(0, 1200));
    assert.equal(host.calls.exec.length, 0);
  });
});

test("integration: a Roadie-run slskd found here offers Roadie's key as a second way, never instead of typing one", async () => {
  const state = { tool: { ...installedApproved, approvedConsumers: [] } };
  await withPlugin({ store: { url: "", apiKey: "" }, dependencies: roadieHere, exec: fakeRoadie(state), fetch: slskdAt(5030, "r".repeat(48)) }, async (host) => {
    await until(() => lastView(host).includes("Get the key from Roadie"), 2000);
    assert.ok(lastView(host).includes("discover-set-key"), "the key box is still there");
    assert.ok(!state.connectionAsked, "Roadie's dialog isn't opened unasked");
  });
});
