#!/usr/bin/env node
"use strict";
// Run a fake slskd for testing the plugin where Soulseek is unreachable.
//
//   npm run fake-slskd -- [--scenario normal] [--port 5039] [--downloads DIR]
//                         [--api-key KEY] [--speed 1] [--source FILE] [--stub] [--quiet]
//   record (off the VPN):  --record [DIR] --upstream http://127.0.0.1:5030 [--api-key REAL_KEY]
//   replay (on the VPN):   --replay DIR
//
// Then in Viboplr: Soulseek → Settings → Connection, address
// http://127.0.0.1:5039 and any API key (or the --api-key you passed; when
// recording, the real slskd's key unless --upstream-key is given).
// Point --downloads inside one of your local collections and finished files
// reach the library like real ones. See docs/fake-slskd.md.

const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { createFakeSlskd, SCENARIOS, PEERS } = require("../test/harness/fakeSlskd.js");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error("unexpected argument: " + a);
    const [k, inline] = a.slice(2).split("=", 2);
    if (["stub", "quiet", "help", "list", "upstream-insecure"].includes(k)) { out[k] = true; continue; }
    // --record takes an optional folder.
    if (k === "record" && inline === undefined && (argv[i + 1] === undefined || argv[i + 1].startsWith("--"))) { out.record = true; continue; }
    const v = inline !== undefined ? inline : argv[++i];
    if (v === undefined) throw new Error("--" + k + " needs a value");
    out[k] = v;
  }
  return out;
}

function usage() {
  console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(2, 15).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  console.log("Scenarios:");
  for (const [k, v] of Object.entries(SCENARIOS)) console.log("  " + k.padEnd(13) + v);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    usage();
    process.exit(2);
  }
  if (args.help || args.list) { usage(); return; }

  if (args.record && !args.upstream) { console.error("--record needs --upstream <your real slskd's address>"); process.exit(2); }
  if (args.record && args.replay) { console.error("--record and --replay don't combine"); process.exit(2); }
  const record = args.record === true
    ? path.join(__dirname, "..", "recordings", new Date().toISOString().slice(0, 10))
    : (args.record ? path.resolve(args.record) : null);
  if (args.replay && !fs.existsSync(path.join(args.replay, "searches")) && !fs.existsSync(path.join(args.replay, "transfers.json"))) {
    console.error("--replay: " + args.replay + " doesn't look like a recording (no searches/ or transfers.json)");
    process.exit(2);
  }

  const speed = args.speed != null ? Number(args.speed) : 1;
  if (!(speed > 0)) { console.error("--speed must be a positive number"); process.exit(2); }

  let audio = "ffmpeg";
  if (args.stub) audio = "stub";
  else if (args.source) {
    if (!fs.existsSync(args.source)) { console.error("--source: no such file " + args.source); process.exit(2); }
    audio = { source: path.resolve(args.source) };
  } else if (!args.upstream && spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) {
    console.error("ffmpeg isn't on PATH, so finished downloads can't be real audio.\n" +
      "Install it, pass --source <an audio file> to copy for every download, or --stub for placeholder files that won't play.");
    process.exit(2);
  }

  const fake = await createFakeSlskd({
    port: args.port != null ? Number(args.port) : 5039,
    scenario: args.scenario || "normal",
    apiKey: args["api-key"] || null,
    scale: 1 / speed,
    downloads: args.downloads ? path.resolve(args.downloads) : undefined,
    audio,
    upstream: args.upstream || null,
    // Proxying, --api-key is the real slskd's key (what the plugin sends is then ignored).
    upstreamKey: args["upstream-key"] || (args.upstream ? args["api-key"] || null : null),
    upstreamInsecure: !!args["upstream-insecure"],
    record,
    replay: args.replay ? path.resolve(args.replay) : null,
    log: args.quiet ? undefined : (line) => console.log(new Date().toISOString().slice(11, 19) + "  " + line)
  });

  if (args.upstream) {
    console.log("fake slskd proxying " + fake.url + " → " + args.upstream);
    if (record) console.log("recording into " + record + " (anonymised; review before sharing or committing)");
    console.log("API key: " + ((args["upstream-key"] || args["api-key"]) ? "the plugin's is replaced with the one you passed" : "the plugin's own is forwarded — use the real slskd's key"));
  } else {
    console.log("fake slskd listening on " + fake.url + "  (scenario: " + (args.scenario || "normal") + ")");
    if (args.replay) console.log("replaying " + path.resolve(args.replay) + "; queries not in it get generated results");
    console.log("downloads folder: " + fake.downloads);
    console.log("API key: " + (args["api-key"] ? "must be " + args["api-key"] : "anything"));
    console.log("generated sharers: " + PEERS.map((p) => p.username).join(", "));
  }
  console.log("Ctrl+C to stop. Files it wrote stay in the downloads folder.");

  const stop = () => { fake.close().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e && e.code === "EADDRINUSE" ? "That port is taken — pass --port." : e);
  process.exit(1);
});
