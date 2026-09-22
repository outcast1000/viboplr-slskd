const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

// The install guide is a web page (docs/index.html on GitHub Pages). The
// plugin's part is the key, the link that carries it, and the Connect step.

test("randomApiKey is 40 lowercase hex chars and not constant", () => {
  const a = plugin._randomApiKey();
  const b = plugin._randomApiKey();
  assert.match(a, /^[0-9a-f]{40}$/);
  assert.notEqual(a, b);
});

test("the guide URL carries the key in the fragment, never the query", () => {
  const u = plugin._setupGuideUrl("abc123");
  assert.equal(u, "https://outcast1000.github.io/viboplr-slskd/#key=abc123");
  assert.ok(!u.includes("?"), "a query string would reach the server; a fragment does not");
  // Encoded, so an odd key can't break the URL.
  assert.ok(plugin._setupGuideUrl("a&b=c").endsWith("#key=a%26b%3Dc"));
});

test("the setup block offers the guide, connect and a new key, and shows the key", () => {
  const b = plugin._setupBlock("k".repeat(40));
  assert.equal(b.type, "section");
  const bar = b.children.find((c) => c.type === "toolbar");
  assert.deepEqual(bar.buttons.map((x) => x.action), ["setup-open-guide", "setup-connect", "setup-new-key"]);
  assert.ok(bar.status.includes("k".repeat(40)));
  assert.equal(bar.buttons[1].label, "Connect to http://localhost:5030");
});
