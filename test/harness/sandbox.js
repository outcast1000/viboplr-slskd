const fs = require("node:fs");
const path = require("node:path");

const INDEX_PATH = path.join(__dirname, "..", "..", "index.js");

// Globals the host's frozen sandbox does NOT provide (usePlugins.ts builds an
// allow-list object for window/globalThis/self). Shadowing them as throwing
// bindings means any accidental use inside index.js fails loudly in tests
// instead of silently working in Node and breaking in the app.
//
// NOTE: Math, JSON, Date, Promise, Object, Array, String, Number, RegExp, Error,
// the timers, parseInt/parseFloat, isNaN/isFinite and encodeURIComponent ARE
// provided by the host and must NOT be shadowed here.
const FORBIDDEN = [
  "fetch", "require", "process", "module", "exports",
  "__dirname", "__filename", "global",
  // Absent from the host sandbox even though Node has them — using any of these
  // would work in tests and throw in the app.
  "Map", "Set", "WeakMap", "WeakSet", "btoa", "atob",
  "TextEncoder", "TextDecoder", "Uint8Array", "URL", "URLSearchParams",
  "XMLHttpRequest", "WebSocket", "localStorage", "crypto", "structuredClone"
];

function loadPlugin() {
  const code = fs.readFileSync(INDEX_PATH, "utf8");

  const preamble = FORBIDDEN
    .map(
      (n) =>
        `var ${n} = new Proxy(function(){}, { get: function(){ throw new Error("forbidden global accessed in sandbox: ${n}"); }, apply: function(){ throw new Error("forbidden global called in sandbox: ${n}"); }, construct: function(){ throw new Error("forbidden global constructed in sandbox: ${n}"); } });`
    )
    .join("\n");

  const factory = new Function(
    "api", "window", "globalThis", "self", "document",
    preamble + "\n" + code
  );

  const sandboxGlobal = Object.freeze({});
  return factory(undefined, sandboxGlobal, sandboxGlobal, sandboxGlobal, sandboxGlobal);
}

module.exports = { loadPlugin };
