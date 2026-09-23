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

test("the about page URL carries the key the same way", () => {
  assert.equal(plugin._whatIsThisUrl("abc"), "https://outcast1000.github.io/viboplr-slskd/what-is-this.html#key=abc");
});

test("the setup bar is two buttons: the guide and connect", () => {
  const bar = plugin._setupBar();
  assert.equal(bar.type, "toolbar");
  assert.deepEqual(bar.buttons.map((x) => x.action), ["setup-open-about", "setup-connect"]);
  assert.equal(bar.buttons[0].label, "What is this?");
  assert.equal(bar.buttons[1].label, "Connect to http://localhost:5030");
});

test("local collections ride in the fragment as newline-joined share paths, deduped", () => {
  const u = plugin._setupGuideUrl("abc", [
    { id: 1, name: "Music", path: "D:\\music" },
    { id: 2, name: "Dup", path: "D:\\music" },
    { id: 3, name: "No path" },
    { id: 4, name: "Rock", path: "E:\\Rock & Roll" }
  ]);
  assert.ok(!u.includes("?"), "still fragment-only");
  const frag = u.slice(u.indexOf("#") + 1);
  const params = Object.fromEntries(frag.split("&").map((kv) => kv.split("=").map(decodeURIComponent)));
  assert.equal(params.key, "abc");
  assert.deepEqual(params.share.split("\n"), ["D:\\music", "E:\\Rock & Roll"]);
  // The about page forwards its fragment to the guide, so it carries them too.
  assert.ok(plugin._whatIsThisUrl("abc", [{ path: "/m" }]).endsWith("#key=abc&share=%2Fm"));
  // No collections, no share param.
  assert.equal(plugin._setupGuideUrl("abc", []), "https://outcast1000.github.io/viboplr-slskd/#key=abc");
});

test("the Connection section always offers the guide, whatever state the plugin is in", () => {
  const sec = plugin._connectionSection();
  const bar = sec.children.find((c) => c.type === "toolbar");
  assert.deepEqual(bar.buttons.map((x) => x.action), ["test-connection", "setup-open-guide"]);
  const key = sec.children.find((c) => c.label === "API key");
  assert.match(key.description, /slskd\.yml/, "the key goes INTO slskd's file; it is not copied out of slskd");
});
