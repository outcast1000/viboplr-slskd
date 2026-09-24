const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { fakeHost } = require("./harness/host.js");

const plugin = loadPlugin();

// Roadie (https://github.com/outcast1000/roadie) can install and run slskd.
// The plugin only advertises it and follows its answers; these pin the rules
// that keep it from ever overwriting a user's own connection.

const installedApproved = { installed: true, running: true, url: "http://127.0.0.1:5030", approvedConsumers: ["viboplr"] };

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
  assert.equal(act(managed, { installed: false, approvedConsumers: [] }), "release");
  assert.equal(act(managed, null), null, "Roadie closed is not Roadie saying slskd is gone");
  assert.equal(act({ url: "", apiKey: "", managedBy: null }, { installed: true, url: "http://127.0.0.1:5030", approvedConsumers: [] }), null, "not approved yet → wait for consent");
  assert.equal(act({ url: "", apiKey: "", managedBy: null }, { installed: false, approvedConsumers: [] }), null, "not installed → nothing to adopt");
});

test("setup buttons depend on what Roadie says", () => {
  const btn = plugin._roadieSetupButtons;
  const actions = (list) => list.map((b) => b.action);
  assert.deepEqual(actions(btn("unconfigured", { managedBy: null }, { present: false })), ["roadie-get"]);
  assert.deepEqual(actions(btn("unreachable", { managedBy: null }, { present: false })), [], "a typed address that fails is not a Roadie problem");
  assert.deepEqual(actions(btn("unconfigured", { managedBy: null }, { present: true, tool: { installed: false } })), ["roadie-install"]);
  assert.deepEqual(actions(btn("unconfigured", { managedBy: null }, { present: true, tool: { installed: true } })), ["roadie-connect"]);
  assert.deepEqual(actions(btn("unreachable", { managedBy: "roadie" }, { present: true, tool: { installed: true } })), ["roadie-open"]);
  assert.deepEqual(actions(btn("unauthorized", { managedBy: "roadie" }, { present: true, tool: { installed: true } })), []);
});

test("deep-link return parsing and the outgoing link shape", () => {
  const p = plugin._parseRoadieReturn;
  assert.deepEqual(p("viboplr://plugin/slskd/roadie?status=connected&tool=slskd"), { status: "connected", tool: "slskd" });
  assert.deepEqual(p("viboplr://plugin/slskd/roadie?status=declined&tool=slskd"), { status: "declined", tool: "slskd" });
  assert.equal(p("viboplr://plugin/other/roadie?status=connected"), null);
  assert.equal(p("viboplr://install-plugin?url=x"), null);
  assert.equal(plugin._roadieLink("install"), "roadie://install/slskd?consumer=viboplr&return=viboplr%3A%2F%2Fplugin%2Fslskd%2Froadie");
});

test("integration: a fresh plugin adopts an approved Roadie connection on its first readiness pass", async () => {
  const host = fakeHost({
    store: { url: "", apiKey: "" },
    fetch: async (url) => {
      if (url.startsWith("http://127.0.0.1:47630/v1/health")) return { status: 200, text: async () => JSON.stringify({ app: "roadie" }) };
      if (url.startsWith("http://127.0.0.1:47630/v1/tools/slskd/connection")) return { status: 200, text: async () => JSON.stringify({ url: "http://127.0.0.1:5030", apiKey: "r".repeat(48) }) };
      if (url.startsWith("http://127.0.0.1:47630/v1/tools/slskd")) return { status: 200, text: async () => JSON.stringify(installedApproved) };
      if (/^http:\/\/127\.0\.0\.1:4763[1-9]/.test(url)) throw new Error("ECONNREFUSED");
      return undefined; // slskd's own endpoints come from the response map
    }
  });
  const p = loadPlugin();
  await p.activate(host.api);
  assert.equal(host.store.url, "http://127.0.0.1:5030");
  assert.equal(host.store.apiKey, "r".repeat(48));
  assert.equal(host.store.managedBy, "roadie");
  assert.equal(host.store.insecure, false);
  p.deactivate();
});

test("integration: a user-typed address is left alone even when Roadie has an approved slskd", async () => {
  const host = fakeHost({
    store: { url: "http://nas.local:5030", apiKey: "mine" },
    responses: { "/api/v0/application": { server: {} } }, // not logged in → not ready → Roadie is probed
    fetch: async (url) => {
      if (url.startsWith("http://127.0.0.1:47630/v1/health")) return { status: 200, text: async () => JSON.stringify({ app: "roadie" }) };
      if (url.startsWith("http://127.0.0.1:47630/v1/tools/slskd")) return { status: 200, text: async () => JSON.stringify(installedApproved) };
      if (/^http:\/\/127\.0\.0\.1:4763[1-9]/.test(url)) throw new Error("ECONNREFUSED");
      return undefined;
    }
  });
  const p = loadPlugin();
  await p.activate(host.api);
  assert.equal(host.store.url, "http://nas.local:5030");
  assert.equal(host.store.apiKey, "mine");
  assert.equal(host.store.managedBy, undefined);
  p.deactivate();
});
