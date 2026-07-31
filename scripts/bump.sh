#!/usr/bin/env bash
# Bump the plugin version in manifest.json, then repackage.
# Usage: scripts/bump.sh 0.2.0
set -euo pipefail
cd "$(dirname "$0")/.."

NEW="${1:-}"
if [ -z "$NEW" ]; then echo "usage: scripts/bump.sh <version>" >&2; exit 1; fi
if ! echo "$NEW" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "version must be semver (e.g. 0.2.0)" >&2; exit 1
fi

NEW="$NEW" node -e '
const fs=require("fs");
const m=JSON.parse(fs.readFileSync("manifest.json","utf8"));
m.version=process.env.NEW;
fs.writeFileSync("manifest.json", JSON.stringify(m,null,2)+"\n");
console.log("manifest.json -> "+m.version);
'
scripts/package.sh
