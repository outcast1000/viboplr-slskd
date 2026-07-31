# Releasing

The gallery (`outcast1000/viboplr-plugins`) is index-only: it points at this
repo's `update.json`, which points at this repo's `slskd.zip`. So a release here
is what actually ships to users.

## Steps

1. Add a new `## <version>` section at the top of `CHANGELOG.md`.
2. Bump and package:
   ```bash
   scripts/bump.sh 0.2.0
   ```
   This rewrites `manifest.json`, then builds `slskd.zip` + `update.json`.
3. Commit the version bump and changelog.
4. Tag and push:
   ```bash
   git tag v0.2.0 && git push origin main --tags
   ```
   The release workflow re-runs the tests, verifies the tag matches
   `manifest.json`, repackages, and publishes the GitHub release.

## Requirements the installer enforces

- `manifest.json` must be at the **root** of the zip — `install_plugin_from_zip`
  does not strip a wrapper directory. `scripts/package.sh` handles this.
- `update.json` must name the permanent asset URL
  (`releases/latest/download/slskd.zip`), not a version-pinned one.
- `minAppVersion` is enforced at install time from the **live** `update.json`,
  regardless of what the gallery index displays.

## Gallery registration (once, for the first release)

Add an entry to `outcast1000/viboplr-plugins` `index.json`:

```json
{
  "id": "slskd",
  "name": "Soulseek",
  "author": "Viboplr",
  "description": "Search and download from the Soulseek network via a slskd daemon.",
  "stability": "experimental",
  "updateUrl": "https://github.com/outcast1000/viboplr-slskd/releases/latest/download/update.json"
}
```

Omit `version` and `minAppVersion` — the gallery's reconcile bot backfills and
maintains them from the live `update.json`. After that, installed copies
auto-update on their own; touch `index.json` again only for renames or
description changes.
