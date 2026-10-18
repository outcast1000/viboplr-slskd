const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { fakeHost } = require("./harness/host.js");

const plugin = loadPlugin();

// Getting slskd: find one already running, install it here through Viboplr's
// api.system.programs (the host asks the user before each install), follow the
// manual guide, or connect to one elsewhere. These pin the rules that keep the
// install honest — nothing runs unasked, a typed connection is never
// overwritten — and the screens around a slskd that isn't ready.

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

const findNodes = (n, pred, out = []) => {
  if (!n || typeof n !== "object") return out;
  if (Array.isArray(n)) { n.forEach((c) => findNodes(c, pred, out)); return out; }
  if (pred(n)) out.push(n);
  findNodes(n.children, pred, out);
  return out;
};

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
const bannerOf = (host) => {
  const view = host.calls.views.filter((v) => v.viewId === "slskd-browse").at(-1).data;
  return findNodes(view, (n) => /\bds-banner\b/.test(n.className || ""))[0] || null;
};
const settingsView = (host) => {
  host.actions["main-tab"]({ tabId: "settings" });
  return lastView(host);
};
const ops = (host) => host.calls.programs.map((c) => c.op);

// slskd's state as GET /api/v0/application reports it.
const app = (loggedIn, username = "bj") => ({
  server: loggedIn ? { state: "Connected, LoggedIn", isLoggedIn: true, isTransitioning: false, username }
    : { state: "Disconnected", isLoggedIn: false, isTransitioning: false },
  version: { current: "0.26.1" },
  shares: { directories: 1 }
});

// A computer with nothing on slskd's ports until `ready()` says the installed
// slskd answers. Root-path probes (the port picker) are refused while free.
function freeComputer(opts = {}) {
  const st = { up: false, loggedIn: opts.loggedIn !== false, takenPorts: opts.takenPorts || [] };
  st.fetch = async (url, init) => {
    const m = /^https?:\/\/127\.0\.0\.1:(\d+)(\/[^?]*)?/.exec(url);
    if (!m) return undefined;
    const port = Number(m[1]);
    const path = m[2] || "/";
    if (st.takenPorts.includes(port)) return { status: 200, text: async () => "<html>something else</html>" };
    if (!st.up || port !== (st.port || 5030)) throw new Error("connection refused");
    if (path === "/") return { status: 200, text: async () => "<html>slskd</html>" };
    if (path === "/api/v0/application" && init && init.method === "DELETE") { st.up = false; return { status: 204, text: async () => "" }; }
    if (path === "/api/v0/application") return { status: 200, text: async () => JSON.stringify(app(st.loggedIn)) };
    if (path === "/api/v0/session") return { status: 200, text: async () => JSON.stringify({ token: "jwt" }) };
    if (path === "/api/v0/logs") return { status: 200, text: async () => JSON.stringify(opts.apiLog || []) };
    if (path === "/api/v0/shares") return { status: 200, text: async () => JSON.stringify({ local: (opts.shared || []).map((p) => ({ localPath: p })) }) };
    return undefined;
  };
  return st;
}

// A host whose programs.start makes the fake slskd answer.
const installHost = (comp, extra = {}) => ({
  store: { url: "", apiKey: "" },
  fetch: comp.fetch,
  programs: Object.assign({
    start: async () => { comp.up = true; return { name: "slskd", registered: true, running: true, pid: 1, startedAt: 1, outliveApp: true, logPath: "/store/logs/slskd.log" }; }
  }, extra.programs || {}),
  ...extra.host
});

const fill = async (host) => {
  await host.actions["setup-page"]({ page: "install-auto" });
  await until(() => lastView(host).includes("install-set-user"));
  await host.actions["install-set-user"]({ value: "bj" });
  await host.actions["install-set-pass"]({ value: "secret" });
  await host.actions["install-pick-folder"]();
  await until(() => lastView(host).includes("/Users/me/Music/Soulseek"));
};

// ---- What is installed, and how ------------------------------------------

test("the build: one pinned, checksummed asset per supported platform, none for Linux", () => {
  const asset = plugin._slskdAssetFor;
  assert.equal(asset({ os: "macos", arch: "arm64" }), "osx-arm64");
  assert.equal(asset({ os: "macos", arch: "x64" }), "osx-x64");
  assert.equal(asset({ os: "windows", arch: "x64" }), "win-x64");
  assert.equal(asset({ os: "windows", arch: "arm64" }), "win-arm64");
  assert.equal(asset({ os: "linux", arch: "x64" }), null);
  assert.equal(asset({ os: "macos", arch: "riscv64" }), null);
  assert.equal(asset(null), null);
  const d = plugin._slskdDownloadFor("osx-arm64");
  assert.equal(d.url, "https://github.com/slskd/slskd/releases/download/0.26.1/slskd-0.26.1-osx-arm64.zip");
  assert.equal(d.file, "slskd-0.26.1-osx-arm64.zip");
  assert.match(d.sha256, /^[0-9a-f]{64}$/);
  for (const a of Object.keys(plugin._SLSKD_RELEASE.sha256)) assert.match(plugin._SLSKD_RELEASE.sha256[a], /^[0-9a-f]{64}$/, a);
  assert.equal(plugin._slskdBinaryName("win-x64"), "slskd.exe");
  assert.equal(plugin._slskdBinaryName("osx-arm64"), "slskd");
});

test("slskd.yml: loopback only, the plugin's key limited to this computer, every string quoted safely", () => {
  const yml = plugin._renderSlskdYml({
    downloadsDir: "C:\\Users\\a b\\Music\\Soulseek", incompleteDir: "/store/slskd/data/incomplete",
    shares: ["C:\\Users\\a b\\Music\\Soulseek", "/Volumes/NAS/Rock"], port: 5031,
    webUsername: "viboplr", webPassword: 'p"w', apiKey: "k".repeat(40), soulseekUsername: "bj", soulseekPassword: "s: #x"
  });
  assert.ok(yml.includes('  downloads: "C:\\\\Users\\\\a b\\\\Music\\\\Soulseek"'), "a Windows path survives as a JSON string");
  assert.ok(yml.includes('  incomplete: "/store/slskd/data/incomplete"'));
  assert.ok(yml.includes("  port: 5031") && yml.includes('  ip_address: "127.0.0.1"'));
  assert.ok(yml.includes("    disabled: true"), "no HTTPS");
  assert.ok(yml.includes('        key: "' + "k".repeat(40) + '"') && yml.includes('cidr: "127.0.0.1/32,::1/128"'));
  assert.ok(yml.includes('    password: "p\\"w"'), "a quote in the web password can't end the string");
  assert.ok(yml.includes('  password: "s: #x"'), "a YAML-special Soulseek password stays one value");
  assert.ok(yml.includes("remote_configuration: true") && yml.includes("remote_file_management: true"));
  assert.ok(yml.includes('    - "/Volumes/NAS/Rock"'));
  const none = plugin._renderSlskdYml({ downloadsDir: "/d", incompleteDir: "/i", shares: [], port: 5030, webUsername: "u", webPassword: "p", apiKey: "k", soulseekUsername: "a", soulseekPassword: "b" });
  assert.ok(none.includes("  directories: []"));
});

test("slskd.yml: the file the install writes is one the share editor can extend later", () => {
  const yml = plugin._renderSlskdYml({ downloadsDir: "/d", incompleteDir: "/i", shares: ["/d"], port: 5030, webUsername: "u", webPassword: "p", apiKey: "k", soulseekUsername: "a", soulseekPassword: "b" });
  const more = plugin._yamlWithShares(yml, ["/Users/me/Music"]);
  assert.ok(more && more.includes('    - "/d"\n    - "/Users/me/Music"'), more);
  const empty = plugin._renderSlskdYml({ downloadsDir: "/d", incompleteDir: "/i", shares: [], port: 5030, webUsername: "u", webPassword: "p", apiKey: "k", soulseekUsername: "a", soulseekPassword: "b" });
  assert.ok(plugin._yamlWithShares(empty, ["/x"]).includes('  directories:\n    - "/x"'));
});

test("shared at install: the downloads folder, then the collections unless turned off, each once", () => {
  const cols = [{ path: "/Users/me/Music" }, { path: "/Volumes/NAS/Rock" }, { path: "/Users/me/Music" }, { name: "no path" }];
  assert.deepEqual(plugin._collectionPaths(cols), ["/Users/me/Music", "/Volumes/NAS/Rock"], "deduped, pathless skipped");
  assert.deepEqual(plugin._installShares({ downloadsDir: "/Users/me/Music/", shareCollections: true }, cols), ["/Users/me/Music", "/Volumes/NAS/Rock"]);
  assert.deepEqual(plugin._installShares({ downloadsDir: "/dl", shareCollections: false }, cols), ["/dl"]);
  assert.equal(plugin._describeFolders(["/a", "/b", "/c", "/d", "/e"]), "/a, /b, /c and 2 more");
});

test("the form needs the account and a downloads folder", () => {
  const ok = plugin._installFormComplete;
  assert.equal(ok({ username: "bj", password: "x", downloadsDir: "/d" }), true);
  assert.equal(ok({ username: "  ", password: "x", downloadsDir: "/d" }), false);
  assert.equal(ok({ username: "bj", password: "", downloadsDir: "/d" }), false);
  assert.equal(ok({ username: "bj", password: "x", downloadsDir: "" }), false);
  assert.equal(ok(null), false);
});

test("what a failure means: the user's no is not an error; the singleton gets its own words", () => {
  const f = plugin._managedFailure;
  assert.deepEqual(f(new Error("Install declined")), { declined: true, message: "You cancelled the install." });
  assert.equal(f(new Error('Permission denied: plugin "slskd" needs "programs:run" to call api.system.programs.download')).declined, true);
  assert.match(f(new Error("slskd exited as soon as it started:\nslskd is already running")).message, /Another copy of slskd/);
  assert.equal(f(new Error("disk full")).message, "disk full");
});

test("the start spec: the pinned version's binary, everything .NET writes kept in the plugin's folder", () => {
  const spec = plugin._managedStartSpec({ version: "0.26.1", asset: "win-x64" }, { app: "C:\\s\\app", config: "C:\\s\\slskd.yml", extract: "C:\\s\\extract" }, false);
  assert.deepEqual(spec.path, ["slskd", "0.26.1", "slskd.exe"]);
  assert.deepEqual(spec.args, ["--app-dir", "C:\\s\\app", "--config", "C:\\s\\slskd.yml", "--no-logo"]);
  assert.equal(spec.env.DOTNET_BUNDLE_EXTRACT_BASE_DIR, "C:\\s\\extract");
  assert.equal(spec.outliveApp, false);
  assert.equal(plugin._managedStartSpec({ version: "0.26.1", asset: "osx-arm64" }, { app: "a", config: "c", extract: "e" }).outliveApp, true, "independent unless the setting says otherwise");
});

test("a host that can't install programs offers only the guide and connecting", () => {
  assert.equal(plugin._managedCapable({ system: {}, ui: {} }), false);
  assert.equal(plugin._managedCapable({ system: { programs: { start() {} }, platform() {} }, ui: { pickFolder() {} } }), true);
  const hub = plugin._setupHomeView("unconfigured", { url: "", managedBy: null }, { supported: false });
  assert.deepEqual(clickable(hub), ["page:install-manual", "page:connect", "discover-again", "setup-open-about"]);
  const linux = plugin._setupHomeView("unconfigured", { url: "", managedBy: null }, { supported: true, platform: { os: "linux", arch: "x64" } });
  assert.deepEqual(clickable(linux), ["page:install-manual", "page:connect", "discover-again", "setup-open-about"], "no build for this computer → no automatic option");
});

test("a port is free only when the connection is refused, never when it just doesn't answer", () => {
  const free = plugin._portLooksFree;
  assert.equal(free(new Error("error sending request for url (http://127.0.0.1:5030/): Connection refused (os error 61)")), true);
  assert.equal(free(new Error("No connection could be made because the target machine actively refused it. (os error 10061)")), true);
  assert.equal(free(new Error("Request timed out")), false);
  assert.equal(free(null), false);
});

test("versions: the update row appears only for an older install", () => {
  assert.equal(plugin._versionLess("0.26.0", "0.26.1"), true);
  assert.equal(plugin._versionLess("0.26.1", "0.26.1"), false);
  assert.equal(plugin._versionLess("0.27.0", "0.26.1"), false);
  assert.equal(plugin._versionLess("0.9.9", "0.10.0"), true);
  assert.deepEqual(clickable(plugin._managedUpdateRows({ version: "0.26.0" }, null)), ["managed-update"]);
  assert.deepEqual(plugin._managedUpdateRows({ version: "0.26.1" }, null), []);
  assert.deepEqual(plugin._managedUpdateRows(null, null), []);
});

// ---- The hub and the not-ready screens -----------------------------------

const installed = { supported: true, platform: { os: "macos", arch: "arm64" }, record: { version: "0.26.1", asset: "osx-arm64", port: 5030 }, status: { running: false } };
const managedCfg = { url: "http://127.0.0.1:5030", managedBy: "plugin" };

test("first-run hub: install here, install by hand, or connect — nothing else on screen", () => {
  const hub = plugin._setupHomeView("unconfigured", { url: "", managedBy: null }, { supported: true, platform: { os: "macos", arch: "arm64" } });
  assert.deepEqual(clickable(hub), ["page:install-auto", "page:install-manual", "page:connect", "discover-again", "setup-open-about"]);
  assert.ok(!JSON.stringify(hub).includes("text-input"), "no address/key fields and no account form on the hub");
});

test("unreachable hub: retry and settings first, then start it, then reinstall", () => {
  const m = { supported: true, platform: { os: "macos", arch: "arm64" } };
  const hub = plugin._setupHomeView("unreachable", { url: "http://localhost:5030", managedBy: null }, m, "connection refused");
  assert.deepEqual(clickable(hub), ["test-connection", "page:connect", "setup-open-guide", "page:install-auto", "page:install-manual"]);
  const text = JSON.stringify(hub);
  assert.ok(text.includes("http://localhost:5030"));
  assert.ok(!text.includes("connection refused"), "a transport error only repeats the address");
  assert.ok(JSON.stringify(plugin._setupHomeView("unreachable", { url: "http://localhost:5030", managedBy: null }, m, "HTTP 502")).includes("(HTTP 502)"));
});

test("a stopped slskd this plugin installed is one Start button", () => {
  assert.deepEqual(clickable(plugin._setupHomeView("unreachable", managedCfg, installed)), ["managed-start", "page:connect"]);
});

test("the banner: Start for the installed slskd, Try again + Fix for everything else, nothing when ready", () => {
  const banner = plugin._readinessBanner;
  assert.deepEqual(clickable(banner("unreachable", managedCfg, installed)), ["managed-start"]);
  assert.match(banner("unreachable", managedCfg, installed).className, /ds-banner--warning/);
  assert.deepEqual(clickable(banner("unreachable", { url: "http://nas:5030", managedBy: null }, installed)), ["test-connection", "slskd-show-fix"], "a slskd the user runs: Viboplr can't start it");
  assert.deepEqual(clickable(banner("unauthorized", managedCfg, installed)), ["slskd-show-fix"]);
  assert.deepEqual(clickable(banner("disconnected", managedCfg, installed)), ["managed-restart", "slskd-show-fix"], "the installed slskd restarts to sign in again");
  assert.deepEqual(clickable(banner("disconnected", { url: "http://nas:5030" }, installed)), ["test-connection", "slskd-show-fix"]);
  assert.deepEqual(clickable(banner("unauthorized", managedCfg, installed, null, true)), [], "on Settings, Fix… has nowhere to go");
  assert.deepEqual(clickable(banner("connecting", managedCfg, installed)), []);
  assert.equal(banner("ready", managedCfg, installed), null);
  assert.equal(banner("unconfigured", managedCfg, installed), null, "the first run is the setup hub, not a banner");
  assert.equal(banner("unreachable", managedCfg, { ...installed, job: { kind: "start" } }).children[1].children[0].disabled, true, "no second start while one runs");
});

test("the header: one status word per state, the address, and Open slskd when there's a page to open", () => {
  const header = plugin._viewHeaderFor;
  const user = { url: "http://localhost:5030", managedBy: null };
  const ready = header({ state: "ready", username: "outcast1000", version: "0.26.0" }, user, installed, "local", null);
  assert.deepEqual(ready, {
    subtitle: "Connected as outcast1000 · slskd 0.26.0",
    status: { variant: "success", label: "Ready" },
    actions: [{ label: "Open slskd", action: "open-slskd" }]
  });
  assert.match(header({ state: "ready", username: "me" }, user, installed, "remote", null).subtitle, /on another computer$/);
  const label = (st, cfg) => header({ state: st }, cfg, installed, "local", null).status;
  assert.deepEqual(label("unreachable", managedCfg), { variant: "warning", label: "Not running" }, "the installed slskd is only stopped");
  assert.deepEqual(label("unreachable", user), { variant: "error", label: "Unreachable" });
  assert.deepEqual(label("unauthorized", user), { variant: "error", label: "Key rejected" });
  assert.deepEqual(label("disconnected", managedCfg), { variant: "warning", label: "Signed out" });
  assert.deepEqual(label("connecting", user), { variant: "muted", label: "Connecting…" });
  assert.deepEqual(label("unconfigured", { url: "" }), { variant: "muted", label: "Not set up" });
  assert.equal(header({ state: "unreachable" }, managedCfg, installed, "local", null).subtitle, "slskd installed here · http://127.0.0.1:5030");
  assert.deepEqual(header({ state: "unconfigured" }, { url: "" }, installed, "local", { at: 1 }).status, { variant: "muted", label: "Setting up" });
});

test("the installed slskd is recognised whatever loopback name the address uses", () => {
  const owns = plugin._managedOwnsAddress;
  const rec = { port: 5030 };
  assert.equal(owns("http://localhost:5030", rec), true);
  assert.equal(owns("http://127.0.0.1:5030/", rec), true);
  assert.equal(owns("http://localhost:5031", rec), false, "another port is another slskd");
  assert.equal(owns("http://nas.local:5030", rec), false);
  assert.equal(owns("http://localhost:5030", null), false);
});

test("key rejected: the installed slskd's keys were changed in its settings; a slskd the user runs gets the guide", () => {
  assert.deepEqual(clickable(plugin._unauthorizedNodes(managedCfg, installed)), ["open-slskd", "test-connection"]);
  assert.deepEqual(clickable(plugin._unauthorizedNodes({ url: "http://localhost:5030", managedBy: null }, installed)), ["setup-open-guide"]);
});

test("the full-page setup screen is the first run, or a setup page the user opened", () => {
  const wants = plugin._wantsSetupScreen;
  assert.equal(wants("unconfigured", "home"), true);
  assert.equal(wants("unreachable", "home"), false, "stopped after it worked → the tabs with a banner");
  assert.equal(wants("unreachable", "connect"), true);
  assert.equal(wants("unauthorized", "connect"), false);
  assert.equal(wants("ready", "home"), false);
});

// ---- Sign-in ----------------------------------------------------------------

// Real lines from slskd 0.26's log.
const LOG_TIMEOUT = [
  "[12:15:25 INF] Listening for incoming connections on 0.0.0.0:50300",
  "[12:15:31 ERR] Failed to execute post-login actions",
  "[12:16:33 ERR] Disconnected from the Soulseek server: Unable to read data from the transport connection: Operation timed out."
];
const LOG_REJECTED = [
  "[12:15:25 INF] Listening for incoming connections on 0.0.0.0:50300",
  "[12:15:26 ERR] Failed to log in to the Soulseek server: The server rejected login attempt: INVALIDPASS"
];
// The owner's slskd on 2026-09-27: kicked by another client using the same
// account, after which slskd never signed in again.
const LOG_KICKED = [
  "[03:03:01 INF] Logged in to the Soulseek server as outcast1000",
  "[08:47:10 INF] Kicked from server.",
  "[08:47:10 ERR] Disconnected from the Soulseek server: Remote connection closed",
  "[08:47:12 INF] Logged in to the Soulseek server as outcast1000",
  "[08:47:20 INF] Kicked from server.",
  "[08:47:20 ERR] Disconnected from the Soulseek server: another client logged in using the same username",
  "[08:48:18 WRN] Unauthorized request from IP address 127.0.0.1: Unknown API key beginning with: 544e"
];
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

test("setup steps: they move forward only, and a failure stops the list", () => {
  const s = plugin._newSetup(" outcast1000 ");
  assert.equal(s.username, "outcast1000");
  plugin._advanceSetup(s, "unpack");
  plugin._advanceSetup(s, "download"); // a late report never moves it back
  let rows = plugin._setupChecklist(s);
  assert.deepEqual(rows.map((r) => r.state), ["done", "done", "active", "pending", "pending", "pending"]);
  assert.equal(rows[5].label, "Sign in to Soulseek as outcast1000");
  plugin._failSetup(s, "boom");
  plugin._advanceSetup(s, "start"); // nothing moves past a failure
  rows = plugin._setupChecklist(s);
  assert.deepEqual(rows.map((r) => r.state), ["done", "done", "failed", "pending", "pending", "pending"]);
  assert.equal(rows[2].detail, "boom");
  assert.match(plugin._setupChecklist(plugin._newSetup(""))[0].detail, /asks before it installs/);
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
  assert.match(why(LOG_REJECTED, "bj").message, /refused to sign in as bj/);
  assert.equal(why(["[12:00:00 INF] all quiet"], "bj"), null);
  assert.equal(why(null, "bj"), null);
  assert.match(plugin._signinFailure("connecting", "bj"), /VPN or firewall/);
  assert.match(plugin._signinFailure("disconnected", null), /No Soulseek account/);
});

test("sign-in reason: a kick is named as a kick, not a firewall; a newer sign-in clears old failures", () => {
  const why = plugin._signinReasonFromLog;
  const kicked = why(LOG_KICKED, "outcast1000");
  assert.equal(kicked.kind, "kicked");
  assert.match(kicked.message, /another app signed in as outcast1000/);
  assert.equal(why(LOG_KICKED.slice(0, 4), "outcast1000"), null, "signed in again after the first drop → nothing to report");
});

test("sign-in reason: connect-then-closed is a blocking network, and a restart isn't offered for it", () => {
  const lines = plugin._apiLogMessages(API_LOG_BLOCKED);
  assert.equal(lines.length, 5);
  assert.deepEqual(plugin._apiLogMessages({ nope: 1 }), []);
  const why = plugin._signinReasonFromLog(lines, null);
  assert.equal(why.kind, "blocked");
  assert.deepEqual(clickable(plugin._disconnectedNodes(managedCfg, installed, why)), ["test-connection", "open-slskd"], "restarting won't get past the network");
  const banner = plugin._readinessBanner("disconnected", managedCfg, installed, why);
  assert.deepEqual(clickable(banner), ["test-connection", "slskd-show-fix"]);
  assert.match(JSON.stringify(banner), /This network blocks Soulseek/);
  assert.equal(plugin._signinReasonFromLog(lines.slice(2), null).kind, "network");
});

test("signed out: the installed slskd restarts; one the user runs keeps the yml advice", () => {
  const why = plugin._signinReasonFromLog(LOG_KICKED, "outcast1000");
  assert.deepEqual(clickable(plugin._disconnectedNodes(managedCfg, installed, why)), ["managed-restart", "open-slskd"]);
  const own = plugin._disconnectedNodes({ url: "http://nas.local:5030" }, installed, why);
  assert.deepEqual(clickable(own), ["setup-open-guide", "open-slskd", "test-connection"]);
  assert.ok(JSON.stringify(own).includes("another app signed in as outcast1000"));
});

test("checked-ago text", () => {
  assert.equal(plugin._checkedAgo(0, 1000), "");
  assert.equal(plugin._checkedAgo(1000, 30000), "checked just now");
  assert.equal(plugin._checkedAgo(1, 3 * 60000), "checked 3 min ago");
});

// ---- Sharing --------------------------------------------------------------

test("sharing: the gap is the collections slskd doesn't cover, read from slskd itself", () => {
  const gap = plugin._shareGap;
  const cols = [{ path: "/Users/a/Downloads" }, { path: "/Volumes/NAS/Music/" }];
  assert.deepEqual(gap(cols, []), ["/Users/a/Downloads", "/Volumes/NAS/Music/"]);
  assert.deepEqual(gap(cols, ["/Volumes/NAS/Music"]), ["/Users/a/Downloads"], "trailing slash is the same folder");
  assert.deepEqual(gap(cols, ["/Users/a"]), ["/Volumes/NAS/Music/"], "inside a shared folder is shared");
  assert.deepEqual(gap(cols, null), [], "not read yet: no gap claimed");
  assert.deepEqual(plugin._sharedFromSlskd({ local: [{ localPath: "/a" }, { localPath: "/b", isExcluded: true }] }), ["/a"]);
  assert.deepEqual(plugin._sharedFromSlskd(null), []);
});

test("sharing row: offers the gap and asks before anything becomes public", () => {
  const rows = plugin._sharingRows;
  const cols = [{ path: "/Users/a/Downloads" }];
  assert.deepEqual(clickable(rows(cols, null, { error: null }, [])), ["share-collections"]);
  assert.ok(JSON.stringify(rows(cols, null, { error: null }, [])).includes("Not shared yet: /Users/a/Downloads"));
  assert.ok(JSON.stringify(rows(cols, null, { error: null }, ["/Users/a/Downloads"])).includes("Shared: /Users/a/Downloads"));
  const ask = JSON.stringify(rows(cols, null, { confirm: ["/Users/a/Downloads"] }, []));
  assert.ok(ask.includes("Share these folders?") && ask.includes("share-confirm") && ask.includes("Everyone on Soulseek"), ask);
  assert.deepEqual(rows(cols, null, { error: null }, null), [], "not read yet: no row");
});

test("slskd's settings file: folders are added under shares → directories and nothing else changes", () => {
  const add = plugin._yamlWithShares;
  const y = 'headless: false\nshares:\n  directories:\n    - "/Users/me/Music/Soulseek"\nweb:\n  port: 5030\n';
  assert.equal(add(y, ["/Users/me/Music/Rock"]),
    'headless: false\nshares:\n  directories:\n    - "/Users/me/Music/Soulseek"\n    - "/Users/me/Music/Rock"\nweb:\n  port: 5030\n');
  assert.equal(add(y, ["/Users/me/Music/Soulseek/"]), y, "already shared: unchanged");
  assert.equal(add('shares:\n  directories: []\n', ["D:\\Rock"]), 'shares:\n  directories:\n    - "D:\\\\Rock"\n');
  assert.equal(add('a: 1\r\nshares:\r\n  directories:\r\n    - /a\r\n', ["/b"]), 'a: 1\r\nshares:\r\n  directories:\r\n    - /a\r\n    - "/b"\r\n', "CRLF and unquoted items kept");
  assert.equal(add('web:\n  port: 1\n', ["/b"]), 'web:\n  port: 1\nshares:\n  directories:\n    - "/b"\n');
  assert.equal(add('shares: { directories: [] }\n', ["/b"]), null, "an inline section: left to the user");
  assert.equal(add('shares:\n  directories:\n    - path: /a\n      alias: x\n', ["/b"]), null);
});

// ---- Discovery ------------------------------------------------------------

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
  assert.equal(plugin._slskdFingerprint(200, "<html>"), null);
  assert.equal(plugin._slskdFingerprint(401, "true"), null);
  const c = plugin._discoveryCandidates().map((x) => x.url);
  assert.deepEqual(c.slice(0, 3), ["http://127.0.0.1:5030", "http://127.0.0.1:5031", "https://127.0.0.1:5031"]);
});

test("integration: a slskd running here with the plugin's key connects on first run, nothing installed", async () => {
  const key = "g".repeat(40);
  await withPlugin({ store: { url: "", apiKey: key }, fetch: slskdAt(5030, key) }, async (host) => {
    await until(() => host.store.url === "http://127.0.0.1:5030", 2000);
    assert.equal(host.store.managedBy, null, "the user's own slskd");
    assert.equal(host.calls.programs.filter((c) => c.op !== "status").length, 0, "nothing installed or started");
  });
});

test("integration: a slskd here that wants another key asks for it, and only a key slskd accepts is kept", async () => {
  const theirs = "t".repeat(40);
  await withPlugin({ store: { url: "", apiKey: "" }, fetch: slskdAt(5032, theirs) }, async (host) => {
    await until(() => lastView(host).includes("Found slskd on this computer"), 2000);
    const v = lastView(host);
    assert.ok(v.includes("http://127.0.0.1:5032") && v.includes("discover-set-key"), v.slice(0, 1200));
    assert.ok(!v.includes("Install automatically"), "found: no install offer in the way");
    await host.actions["discover-set-key"]({ value: "wrong" });
    await host.actions["discover-connect"]();
    await until(() => lastView(host).includes("didn't accept that key"));
    assert.equal(host.store.url, "");
    await host.actions["discover-set-key"]({ value: theirs });
    await host.actions["discover-connect"]();
    await until(() => host.store.apiKey === theirs, 1000);
    assert.equal(host.store.url, "http://127.0.0.1:5032");
  });
});

test("integration: no slskd and an older host: the setup still works (guide or address)", async () => {
  await withPlugin({ store: { url: "", apiKey: "" }, noPrograms: true, fetch: async () => ({ status: 599, text: async () => "" }) }, async (host) => {
    await until(() => lastView(host).includes("No slskd is running on this computer"), 2000);
    const v = lastView(host);
    assert.ok(v.includes("install-manual") && v.includes('"page":"connect"') && !v.includes("install-auto"), v.slice(0, 1200));
  });
});

// ---- The install, end to end ------------------------------------------------

test("integration: Install downloads the pinned build, writes slskd.yml, starts it and connects", async () => {
  const comp = freeComputer();
  await withPlugin(installHost(comp, { host: { collections: [{ id: 1, name: "Music", path: "/Users/me/Music" }] } }), async (host, p) => {
    p._setSigninTiming(2000, 5);
    await fill(host);
    const form = lastView(host);
    assert.ok(form.includes("Share my Viboplr collections") && form.includes("1 folder: /Users/me/Music"), "says what becomes public");
    await host.actions["install"]();
    await until(() => host.store.managedBy === "plugin" && !lastView(host).includes("Setting up slskd"), 3000);

    const dl = host.calls.programs.find((c) => c.op === "download");
    assert.deepEqual(dl.args[0], ["slskd", "download", "slskd-0.26.1-osx-arm64.zip"]);
    assert.equal(dl.args[1], "https://github.com/slskd/slskd/releases/download/0.26.1/slskd-0.26.1-osx-arm64.zip");
    assert.equal(dl.args[2].sha256, "5cf79a4d41ad40906aababc6bd05585899f102e7c544e38157df747f01cb6f4b", "the pinned checksum goes to the host");
    assert.equal(dl.args[2].label, "slskd 0.26.1", "the host's install dialog names it");
    const order = ops(host).filter((o) => o !== "status");
    assert.deepEqual(order.slice(0, 6), ["files.remove", "download", "extract", "files.remove", "run", "start"], order.join(" "));
    assert.deepEqual(host.calls.programs.find((c) => c.op === "run").args[1], ["--version"]);
    assert.equal(host.store.startWithViboplr, true, "starting with Viboplr is on by default");

    const yml = host.files["slskd/data/slskd.yml"];
    assert.ok(yml.includes('  username: "bj"') && yml.includes('  password: "secret"'), "the account goes into slskd.yml");
    assert.ok(yml.includes('  downloads: "/Users/me/Music/Soulseek"'));
    assert.ok(yml.includes('    - "/Users/me/Music/Soulseek"') && yml.includes('    - "/Users/me/Music"'), "downloads + collections shared");
    assert.ok(yml.includes('        key: "' + host.store.apiKey + '"'), "slskd accepts the key the plugin uses");

    const rec = host.store.managedSlskd;
    assert.equal(rec.version, "0.26.1");
    assert.equal(rec.port, 5030);
    assert.match(rec.webPassword, /^[A-Za-z0-9]{24}$/, "a random web sign-in, not slskd/slskd");
    assert.equal(host.store.url, "http://127.0.0.1:5030");
    assert.equal(host.store.soulseekPassword, undefined, "the password is never kept by the plugin");
    const start = host.calls.programs.find((c) => c.op === "start").args[1];
    assert.equal(start.outliveApp, true, "keeps running after Viboplr quits");
    assert.ok(start.args.includes("--config"));
    assert.ok(lastView(host).includes('"type":"tabs"'), "the view is the plugin itself once signed in");
    assert.equal(host.calls.notifications.length, 0, "success announces nothing");
  });
});

test("integration: a taken port moves slskd to the next free one", async () => {
  const comp = freeComputer({ takenPorts: [5030] });
  comp.port = 5031;
  await withPlugin(installHost(comp), async (host, p) => {
    p._setSigninTiming(2000, 5);
    await fill(host);
    await host.actions["install"]();
    await until(() => host.store.managedBy === "plugin", 3000);
    assert.equal(host.store.managedSlskd.port, 5031);
    assert.ok(host.files["slskd/data/slskd.yml"].includes("  port: 5031"));
    assert.equal(host.store.url, "http://127.0.0.1:5031");
  });
});

test("integration: the form is off until complete, and turning sharing / start-with-Viboplr off is what is kept", async () => {
  const comp = freeComputer();
  await withPlugin(installHost(comp, { host: { collections: [{ id: 1, name: "Music", path: "/Users/me/Music" }] } }), async (host, p) => {
    p._setSigninTiming(2000, 5);
    await host.actions["setup-page"]({ page: "install-auto" });
    await until(() => lastView(host).includes("install-set-user"));
    assert.ok(/"action":"install","variant":"accent","disabled":true/.test(lastView(host)), "Install starts disabled");
    assert.ok(lastView(host).includes("Soulseek has no sign-up page"));
    await host.actions["install"]();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(host.calls.programs.filter((c) => c.op === "download").length, 0, "nothing ran");
    await host.actions["install-set-user"]({ value: "bj" });
    await host.actions["install-set-pass"]({ value: "secret" });
    assert.ok(/"action":"install","variant":"accent","disabled":true/.test(lastView(host)), "still needs a folder");
    await host.actions["install-pick-folder"]();
    await host.actions["install-set-share"]({ value: false });
    await host.actions["install-set-autostart"]({ value: false });
    await host.actions["install"]();
    await until(() => host.store.managedBy === "plugin", 3000);
    assert.ok(!host.files["slskd/data/slskd.yml"].includes('"/Users/me/Music"\n'), "collections not shared");
    assert.equal(host.store.startWithViboplr, false, "won't start with Viboplr");
  });
});

test("integration: turning the install down in Viboplr's dialog returns to the untouched form", async () => {
  const comp = freeComputer();
  await withPlugin(installHost(comp, { programs: { download: async () => { throw new Error("Install declined"); } } }), async (host) => {
    await fill(host);
    await host.actions["install"]();
    await until(() => lastView(host).includes("You cancelled the install."), 2000);
    const v = lastView(host);
    assert.ok(v.includes("install-set-user") && v.includes('"value":"bj"'), "the form, still filled in");
    assert.equal(host.store.managedSlskd, undefined, "nothing recorded");
    assert.equal(host.calls.programs.filter((c) => c.op === "start").length, 0);
  });
});

test("integration: a failure after the download keeps the form filled for Back", async () => {
  const comp = freeComputer();
  await withPlugin(installHost(comp, { programs: { run: async () => ({ exitCode: 1, stdout: "", stderr: "bad CPU type" }) } }), async (host) => {
    await fill(host);
    await host.actions["install"]();
    await until(() => lastView(host).includes("✗"), 2000);
    assert.ok(lastView(host).includes("slskd didn't run on this computer: bad CPU type"));
    await host.actions["install-close"]();
    await host.actions["setup-page"]({ page: "install-auto" });
    const v = lastView(host);
    assert.ok(v.includes('"value":"bj"') && v.includes("/Users/me/Music/Soulseek"), "what the user typed is still there");
  });
});

test("integration: a slskd that won't start fails the Start step with its own words, and Try again starts it", async () => {
  const comp = freeComputer();
  let fail = true;
  await withPlugin(installHost(comp, { programs: {
    start: async () => {
      if (fail) throw new Error("slskd exited as soon as it started:\n[ERR] slskd is already running");
      comp.up = true;
      return { name: "slskd", registered: true, running: true };
    }
  } }), async (host, p) => {
    p._setSigninTiming(2000, 5);
    await fill(host);
    await host.actions["install"]();
    await until(() => lastView(host).includes("✗"), 2000);
    const v = lastView(host);
    assert.ok(v.includes("✗  Start slskd") && v.includes("Another copy of slskd"), v.slice(0, 800));
    fail = false;
    await host.actions["install-retry"]();
    await until(() => host.store.managedBy === "plugin" && !lastView(host).includes("Setting up slskd"), 3000);
    assert.ok(lastView(host).includes('"type":"tabs"'));
  });
});

test("integration: behind a VPN the sign-in step shows live progress, then slskd's own reason from its log", async () => {
  const comp = freeComputer({ loggedIn: false });
  await withPlugin(installHost(comp, { host: { files: { "logs/slskd.log": LOG_TIMEOUT.join("\n") } } }), async (host, p) => {
    p._setSigninTiming(80, 10);
    await fill(host);
    await host.actions["install"]();
    await until(() => lastView(host).includes("✗"), 3000);
    const all = host.calls.views.map((v) => JSON.stringify(v.data)).join("\n");
    assert.ok(all.includes("Waiting for slskd to reach the Soulseek server"), "the wait said what it was waiting for");
    assert.ok(lastView(host).includes("slskd can't reach the Soulseek server: the connection timed out"));
    assert.ok(lastView(host).includes("Check again"));
  });
});

test("integration: a refused sign-in stops the wait early with the reason", async () => {
  const comp = freeComputer({ loggedIn: false });
  await withPlugin(installHost(comp, { host: { files: { "logs/slskd.log": LOG_REJECTED.join("\n") } } }), async (host, p) => {
    p._setSigninTiming(60000, 5);
    await fill(host);
    const t0 = Date.now();
    await host.actions["install"]();
    await until(() => lastView(host).includes("✗"), 3000);
    assert.ok(Date.now() - t0 < 3000, "stopped long before the wait ran out");
    assert.ok(lastView(host).includes("refused to sign in as bj"));
  });
});

// ---- Running, updating and removing it -------------------------------------

const managedStore = (extra = {}) => ({
  url: "http://127.0.0.1:5030", apiKey: "k".repeat(40), managedBy: "plugin",
  managedSlskd: { version: "0.26.1", asset: "osx-arm64", port: 5030, webUsername: "viboplr", webPassword: "w".repeat(24), downloadsDir: "/Users/me/Music/Soulseek", installedAt: 1 },
  ...extra
});
const filesInstalled = { "slskd/data/slskd.yml": "x", "slskd/0.26.1/slskd": "bin" };

test("integration: at launch a stopped installed slskd shows the banner, no toast, and Start starts it", async () => {
  const comp = freeComputer();
  await withPlugin({ store: managedStore(), files: filesInstalled, fetch: comp.fetch,
    programs: { start: async () => { comp.up = true; return { name: "slskd", registered: true, running: true }; } } }, async (host, p) => {
    p._setSigninTiming(2000, 5, 20);
    await until(() => bannerOf(host));
    assert.ok(lastView(host).includes('"type":"tabs"'), "the view stays usable");
    assert.deepEqual(clickable(bannerOf(host)), ["managed-start"]);
    host.actions["managed-start"]();
    await until(() => !bannerOf(host), 2000);
    assert.equal(bannerOf(host), null, "ready without a second click");
    assert.equal(host.calls.programs.filter((c) => c.op === "start").length, 1);
    assert.equal(host.calls.notices.length, 0, "never a toast");
  });
});

test("integration: Restart asks slskd to shut down first, then starts it again", async () => {
  const comp = freeComputer({ loggedIn: false });
  comp.up = true;
  const seen = [];
  await withPlugin({ store: managedStore(), files: filesInstalled,
    fetch: async (url, init) => { seen.push(((init && init.method) || "GET") + " " + url.replace(/^https?:\/\/[^/]+/, "")); return comp.fetch(url, init); },
    programs: { start: async () => { comp.up = true; comp.loggedIn = true; return { name: "slskd", registered: true, running: true }; } } }, async (host, p) => {
    p._setSigninTiming(2000, 5, 20);
    await until(() => bannerOf(host) && clickable(bannerOf(host)).includes("managed-restart"));
    await host.actions["managed-restart"]();
    await until(() => !bannerOf(host), 2000);
    assert.ok(seen.includes("POST /api/v0/session") && seen.includes("DELETE /api/v0/application"), "graceful: slskd's own shutdown");
    const order = ops(host).filter((o) => o === "stop" || o === "start");
    assert.deepEqual(order, ["stop", "start"]);
    const login = seen.indexOf("POST /api/v0/session");
    assert.ok(login >= 0);
  });
});

test("integration: the card — update, start with Viboplr, keep running, files, details, remove last; no address form", async () => {
  const comp = freeComputer();
  comp.up = true;
  await withPlugin({ store: managedStore({ managedSlskd: { ...managedStore().managedSlskd, version: "0.26.0" } }), files: { ...filesInstalled, "slskd/0.26.0/slskd": "bin" }, fetch: comp.fetch }, async (host) => {
    await until(() => settingsView(host).includes("slskd on this computer"), 1000);
    const view = host.calls.views.filter((v) => v.viewId === "slskd-browse").at(-1).data;
    const card = findNodes(view, (n) => n.type === "section" && n.title === "slskd on this computer")[0];
    assert.deepEqual(clickable(card), ["test-connection", "managed-update", "share-collections",
      "managed-files-toggle", "managed-details-toggle", "managed-remove-ask"], "Remove last");
    const toggles = findNodes(card, (n) => n.type === "settings-row" && n.control && n.control.type === "toggle").map((n) => n.control.action);
    assert.deepEqual(toggles, ["managed-autostart", "managed-set-keep-running"]);
    assert.ok(!JSON.stringify(view).includes('"action":"set-url"'), "no address/key form until Connection details is opened");
    host.actions["managed-details-toggle"]();
    assert.ok(lastView(host).includes('"action":"set-key"'));
    await host.actions["managed-files-toggle"]();
    await until(() => lastView(host).includes("Show in folder"));
    assert.ok(lastView(host).includes("holds your Soulseek password"));
  });
});

test("integration: Update downloads the newer build (the host asks), restarts on it and removes the old one", async () => {
  const comp = freeComputer();
  comp.up = true;
  await withPlugin({ store: managedStore({ managedSlskd: { ...managedStore().managedSlskd, version: "0.26.0" } }), files: { ...filesInstalled, "slskd/0.26.0/slskd": "bin" }, fetch: comp.fetch,
    programs: { start: async () => { comp.up = true; return { name: "slskd", registered: true, running: true }; } } }, async (host, p) => {
    p._setSigninTiming(2000, 5, 20);
    await until(() => settingsView(host).includes("managed-update"), 1000);
    await host.actions["managed-update"]();
    await until(() => host.store.managedSlskd.version === "0.26.1", 2000);
    const order = ops(host).filter((o) => ["download", "extract", "run", "stop", "start"].includes(o));
    assert.deepEqual(order, ["download", "extract", "run", "stop", "start"]);
    assert.ok(host.calls.programs.some((c) => c.op === "files.remove" && c.path === "slskd/0.26.0"), "the old version is deleted");
    assert.ok(!settingsView(host).includes("managed-update"), "nothing left to update");
  });
});

test("integration: Keep running off makes the next start tied to Viboplr", async () => {
  const comp = freeComputer();
  await withPlugin({ store: managedStore(), files: filesInstalled, fetch: comp.fetch,
    programs: { start: async () => { comp.up = true; return { name: "slskd", registered: true, running: true }; } } }, async (host, p) => {
    p._setSigninTiming(2000, 5, 20);
    await until(() => bannerOf(host));
    await host.actions["managed-set-keep-running"]({ value: false });
    assert.equal(host.store.stopWithViboplr, true);
    host.actions["managed-start"]();
    await until(() => host.calls.programs.some((c) => c.op === "start"), 1000);
    const spec = host.calls.programs.find((c) => c.op === "start").args[1];
    assert.equal(spec.outliveApp, false);
    await until(() => !bannerOf(host), 1000);
  });
});

test("integration: Remove stops slskd, deletes its folder and forgets the connection; downloads are not touched", async () => {
  const comp = freeComputer();
  comp.up = true;
  await withPlugin({ store: managedStore(), files: { ...filesInstalled, "logs/slskd.log": "x" }, fetch: comp.fetch }, async (host) => {
    await until(() => settingsView(host).includes("managed-remove-ask"), 1000);
    host.actions["managed-remove-ask"]();
    assert.ok(lastView(host).includes("Your downloads and shared folders stay where they are"));
    await host.actions["managed-remove"]();
    await until(() => host.store.managedBy === null, 2000);
    const order = ops(host).filter((o) => ["stop", "remove", "files.remove"].includes(o));
    assert.deepEqual(order, ["stop", "remove", "files.remove", "files.remove"]);
    assert.ok(host.calls.programs.some((c) => c.op === "files.remove" && c.path === "slskd"));
    assert.equal(host.store.managedSlskd, undefined);
    assert.equal(host.store.url, "");
    assert.equal(host.calls.notifications.length, 0, "success is the view changing, not a toast");
  });
});

test("integration: the start-with-Viboplr switch is saved by the plugin, never a host login item", async () => {
  const comp = freeComputer();
  comp.up = true;
  await withPlugin({ store: managedStore(), files: filesInstalled, fetch: comp.fetch }, async (host) => {
    await until(() => settingsView(host).includes("managed-autostart"), 1000);
    await host.actions["managed-autostart"]({ value: false });
    assert.equal(host.store.startWithViboplr, false);
    await host.actions["managed-autostart"]({ value: true });
    assert.equal(host.store.startWithViboplr, true);
    assert.ok(!ops(host).includes("setLoginItem"));
  });
});

test("integration: on activation the plugin starts the installed slskd the host knows, if it is stopped", async () => {
  const comp = freeComputer();
  await withPlugin({ store: managedStore(), files: filesInstalled, fetch: comp.fetch, progState: { registered: true },
    programs: { start: async () => { comp.up = true; return { name: "slskd", registered: true, running: true }; } } }, async (host, p) => {
    p._setSigninTiming(2000, 5, 20);
    await until(() => ops(host).includes("start"), 1000);
    await until(() => !bannerOf(host), 1000);
  });
});

test("integration: no start on activation when the switch is off, slskd already runs, or it never ran", async () => {
  const cases = [
    { store: managedStore({ startWithViboplr: false }), progState: { registered: true } },
    { store: managedStore(), progState: { registered: true, running: true } },
    { store: managedStore(), progState: { registered: false } }
  ];
  for (const c of cases) {
    const comp = freeComputer();
    await withPlugin({ store: c.store, files: filesInstalled, fetch: comp.fetch, progState: c.progState }, async (host) => {
      await until(() => ops(host).includes("status"), 1000);
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(!ops(host).includes("start"), JSON.stringify(c));
    });
  }
});

test("integration: Share… on the installed slskd confirms, edits slskd's file through slskd, then rescans", async () => {
  let yaml = 'shares:\n  directories:\n    - "/Users/me/Music/Soulseek"\n';
  const seen = [];
  const comp = freeComputer();
  comp.up = true;
  await withPlugin({
    store: managedStore(), files: filesInstalled,
    collections: [{ id: 1, kind: "local", path: "/Users/me/Music/Rock" }],
    fetch: async (url, init) => {
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      seen.push(init.method + " " + path);
      if (path === "/api/v0/shares" && init.method === "GET") {
        return { status: 200, text: async () => JSON.stringify({ local: yaml.split("\n").filter((l) => l.includes("- ")).map((l) => ({ localPath: JSON.parse(l.trim().slice(2)) })) }) };
      }
      if (path === "/api/v0/session") {
        assert.deepEqual(JSON.parse(init.body), { username: "viboplr", password: "w".repeat(24) }, "the web login the install wrote");
        return { status: 200, text: async () => JSON.stringify({ token: "jwt" }) };
      }
      if (path.startsWith("/api/v0/options/yaml")) assert.equal(init.headers.Authorization, "Bearer jwt");
      if (path === "/api/v0/options/yaml" && init.method === "GET") return { status: 200, text: async () => JSON.stringify(yaml) };
      if (path === "/api/v0/options/yaml/validate") return { status: 200, text: async () => "" };
      if (path === "/api/v0/options/yaml" && init.method === "PUT") { yaml = JSON.parse(init.body); return { status: 200, text: async () => "" }; }
      if (path === "/api/v0/shares" && init.method === "PUT") return { status: 200, text: async () => "" };
      return comp.fetch(url, init);
    }
  }, async (host) => {
    await until(() => settingsView(host).includes('"action":"share-collections"'), 1000);
    await host.actions["share-collections"]();
    await until(() => settingsView(host).includes("Share these folders?"));
    assert.ok(!seen.some((s) => s.startsWith("PUT")), "nothing changes before the user says yes");
    await host.actions["share-confirm"]();
    await until(() => seen.includes("PUT /api/v0/shares"), 1000);
    assert.ok(yaml.includes('- "/Users/me/Music/Rock"') && yaml.includes('- "/Users/me/Music/Soulseek"'), yaml);
    assert.ok(seen.indexOf("POST /api/v0/options/yaml/validate") < seen.indexOf("PUT /api/v0/options/yaml"), "slskd validates before it saves");
  });
});

test("integration: Show login shows the sign-in the install wrote; a slskd the user runs gets slskd's defaults", async () => {
  const comp = freeComputer();
  comp.up = true;
  await withPlugin({ store: managedStore(), files: filesInstalled, fetch: comp.fetch }, async (host) => {
    assert.ok(!settingsView(host).includes("w".repeat(24)), "hidden until asked");
    await host.actions["slskd-show-login"]();
    const v = settingsView(host);
    assert.ok(v.includes('"value":"viboplr"') && v.includes("w".repeat(24)) && v.includes("Viboplr set up"), v.slice(0, 800));
  });
  await withPlugin({ store: { url: "http://localhost:5030", apiKey: "k".repeat(40) } }, async (host) => {
    await host.actions["slskd-show-login"]();
    const v = settingsView(host);
    assert.ok(v.includes('"value":"slskd"') && v.includes("slskd.yml"), v.slice(0, 800));
  });
});

test("integration: an old 'roadie' connection becomes a plain one at launch", async () => {
  await withPlugin({ store: { url: "http://127.0.0.1:5030", apiKey: "r".repeat(48), managedBy: "roadie" } }, async (host) => {
    assert.equal(host.store.managedBy, null);
    assert.equal(host.store.url, "http://127.0.0.1:5030", "the address stays");
  });
});

test("integration: Test says Checking… while it runs and when it last ran; Fix… opens Settings at the top", async () => {
  let release = null;
  await withPlugin({
    store: { url: "http://localhost:5030", apiKey: "k".repeat(40) },
    fetch: async (url) => {
      if (url.includes("/api/v0/logs")) return { status: 200, text: async () => JSON.stringify(API_LOG_BLOCKED) };
      if (!url.includes("/api/v0/application")) return undefined;
      if (release) await new Promise((res) => { const r = release; release = null; r.wait = res; });
      return { status: 200, text: async () => JSON.stringify({ server: { state: "Disconnected", isLoggedIn: false, isTransitioning: false }, version: { current: "0.26.0" } }) };
    }
  }, async (host) => {
    await until(() => /This network blocks Soulseek/.test(JSON.stringify(bannerOf(host) || {})));
    const latest = () => host.calls.views.filter((v) => v.viewId === "slskd-browse").at(-1);
    host.actions["slskd-show-fix"]();
    assert.match(latest().opts.scrollKey, /^settings:fix:/);
    assert.match(JSON.stringify(latest().data), /web filter/);
    release = {};
    const gate = release;
    const done = host.actions["test-connection"]();
    await until(() => JSON.stringify(latest().data).includes("Checking…"));
    await until(() => gate.wait);
    gate.wait();
    await done;
    assert.match(JSON.stringify(latest().data), /checked just now/);
  });
});

test("integration: an older host without setViewHeader just doesn't get a header", async () => {
  await withPlugin({ store: { url: "http://localhost:5030", apiKey: "k".repeat(40) }, fetch: async (url) => { if (url.includes("/api/v0/application")) throw new Error("refused"); }, noViewHeader: true }, async (host) => {
    await until(() => bannerOf(host));
    assert.equal(host.calls.headers.length, 0);
  });
});
