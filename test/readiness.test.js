const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

// --- hasFlag ---------------------------------------------------------------
// slskd registers JsonStringEnumConverter (Program.cs:980), so [Flags] enums
// arrive as comma-separated strings. Equality comparison would silently fail.

test("hasFlag reads comma-separated flag strings", () => {
  assert.equal(plugin._hasFlag("Connected, LoggedIn", "LoggedIn"), true);
  assert.equal(plugin._hasFlag("Connected, LoggedIn", "Connected"), true);
  assert.equal(plugin._hasFlag("Connected", "LoggedIn"), false);
});

test("hasFlag is whitespace- and case-insensitive, and null-safe", () => {
  assert.equal(plugin._hasFlag("Completed,   Succeeded", "succeeded"), true);
  assert.equal(plugin._hasFlag(null, "LoggedIn"), false);
  assert.equal(plugin._hasFlag("", "LoggedIn"), false);
  assert.equal(plugin._hasFlag("LoggedIn", null), false);
});

test("hasFlag does not match on substrings", () => {
  // "LoggedIn" must not be found inside "LoggingIn".
  assert.equal(plugin._hasFlag("Connecting, LoggingIn", "LoggedIn"), false);
});

// --- transferPhase ---------------------------------------------------------

test("transferPhase distinguishes success from failure — both say Completed", () => {
  assert.equal(plugin._transferPhase("Completed, Succeeded"), "succeeded");
  assert.equal(plugin._transferPhase("Completed, Errored"), "failed");
  assert.equal(plugin._transferPhase("Completed, TimedOut"), "failed");
  assert.equal(plugin._transferPhase("Completed, Rejected"), "failed");
  assert.equal(plugin._transferPhase("Completed, Cancelled"), "cancelled");
});

test("transferPhase maps in-flight states", () => {
  assert.equal(plugin._transferPhase("Requested"), "requested");
  assert.equal(plugin._transferPhase("Queued, Remotely"), "queued");
  assert.equal(plugin._transferPhase("Initializing"), "starting");
  assert.equal(plugin._transferPhase("InProgress"), "downloading");
  assert.equal(plugin._transferPhase(""), "pending");
});

test("transferPhase treats a bare Completed as failure, not success", () => {
  assert.equal(plugin._transferPhase("Completed"), "failed");
});

// --- nextReadiness ---------------------------------------------------------

test("nextReadiness maps each probe kind to a state", () => {
  assert.equal(plugin._nextReadiness({ kind: "unconfigured" }, null).state, "unconfigured");
  assert.equal(plugin._nextReadiness({ kind: "unreachable" }, null).state, "unreachable");
  assert.equal(plugin._nextReadiness({ kind: "unauthorized" }, null).state, "unauthorized");
  assert.equal(plugin._nextReadiness({ kind: "ok", serverState: "Connected, LoggedIn" }, null).state, "ready");
  assert.equal(plugin._nextReadiness({ kind: "ok", serverState: "Disconnected" }, null).state, "disconnected");
});

test("nextReadiness treats Connecting/LoggingIn as transitional, not disconnected", () => {
  const a = plugin._nextReadiness({ kind: "ok", serverState: "Connecting" }, null);
  const b = plugin._nextReadiness({ kind: "ok", serverState: "Connected, LoggingIn" }, null);
  assert.equal(a.state, "connecting");
  assert.equal(b.state, "connecting");
  assert.equal(a.notify, false, "a transitional state must never alarm the user");
  assert.equal(b.notify, false);
});

test("nextReadiness notifies only on a transition INTO a bad state", () => {
  const first = plugin._nextReadiness({ kind: "unreachable" }, { state: "ready" });
  assert.equal(first.notify, true, "ready -> unreachable should notify");

  const repeat = plugin._nextReadiness({ kind: "unreachable" }, { state: "unreachable" });
  assert.equal(repeat.notify, false, "polling the same bad state must not re-notify");
  assert.equal(repeat.changed, false);
});

test("nextReadiness does not notify when entering a good state", () => {
  const r = plugin._nextReadiness({ kind: "ok", serverState: "Connected, LoggedIn" }, { state: "unreachable" });
  assert.equal(r.state, "ready");
  assert.equal(r.notify, false);
  assert.equal(r.changed, true);
});

test("nextReadiness notifies again when one bad state becomes a different bad state", () => {
  const r = plugin._nextReadiness({ kind: "unauthorized" }, { state: "unreachable" });
  assert.equal(r.notify, true);
});

test("nextReadiness passes through identity and share details", () => {
  const r = plugin._nextReadiness(
    { kind: "ok", serverState: "Connected, LoggedIn", username: "me", version: "0.26.0", shareCount: 0 },
    null
  );
  assert.equal(r.username, "me");
  assert.equal(r.version, "0.26.0");
  assert.equal(r.shareCount, 0);
});

test("nextReadiness handles a null probe", () => {
  assert.equal(plugin._nextReadiness(null, null).state, "unconfigured");
});
