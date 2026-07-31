# Soulseek for Viboplr

Search and download from the [Soulseek](https://www.slsknet.org/) network inside
Viboplr.

Viboplr can't speak Soulseek directly — it's a custom binary TCP protocol, and
plugins only get HTTP. So this plugin drives **[slskd](https://slskd.com/)**, a
free, open-source headless Soulseek daemon that you run yourself. You never need
to open slskd's own web interface.

## What you need

1. **slskd**, running somewhere you can reach. Download it from
   [slskd.com](https://slskd.com/) (a ~56 MB zip, ~128 MB installed) or run the
   Docker image.
2. A **Soulseek account**, signed in inside slskd.
3. slskd's **API key** — in slskd under Settings → Options → Web.

Then open **Soulseek** in the Viboplr sidebar and paste the address
(e.g. `http://localhost:5030`) and the API key.

## What it does

- Search the Soulseek network, with results ranked by quality first and then by
  who can actually send them fastest.
- Browse results as individual **Files** or as whole **Folders** — Soulseek users
  mostly share complete albums.
- Queue downloads and watch their progress, including your position in the other
  user's upload queue.
- Play finished downloads, or import them into a library collection with tags and
  cover art written by Viboplr's own downloader.

## Where slskd runs matters

Search and downloading work the same either way. The difference is only what
happens *after* a download finishes.

| slskd location | Finished downloads |
|---|---|
| **Same computer as Viboplr** | Playable immediately; **Add to library** imports them into a collection |
| **Docker / NAS / another machine** | Land in slskd's downloads folder. Add that folder (or its mount) as a music source in Collections |

The plugin guesses from the address you enter and you can override it with
**"slskd runs on this computer"** in Settings → Soulseek. If a play or import
fails because the file isn't reachable, it corrects itself and tells you.

## What it deliberately doesn't do

- **Stream before the download finishes.** Soulseek sends whole files, and you can
  sit in a stranger's queue for a long time. It's "download, then play."
- **Automatically find tracks on Soulseek in the background.** Soulseek waits are
  unbounded, so the plugin never inserts itself into Viboplr's automatic playback
  or download fallback chains. You always start a search yourself.
- **Manage your shares.** Do that in slskd.

## Sharing

Soulseek is reciprocal — users who share get priority in queues. If slskd isn't
sharing anything, the plugin says so once, because the resulting slowness looks
like a broken plugin rather than a slow queue.

## Privacy note

Your slskd address and API key are stored in Viboplr's plugin storage, which is a
plain SQLite table — the same way every other plugin stores its credentials. It is
not encrypted.

## Development

```bash
node --check index.js   # syntax
node --test             # unit tests
scripts/package.sh      # build slskd.zip + update.json
```

The plugin is just `manifest.json` + `index.js`. Tests run the real `index.js`
through a sandbox harness that shadows every global the Viboplr host does *not*
provide (`fetch`, `Map`, `Set`, `btoa`, `WebSocket`, …), so anything that would
work in Node but break in the app fails loudly in CI.
