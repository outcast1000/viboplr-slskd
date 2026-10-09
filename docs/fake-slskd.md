# Fake slskd

A local stand-in for slskd, for working on this plugin where the Soulseek network can't be
reached (a work VPN or web filter) or when a failure has to happen on cue. It answers the
slskd REST endpoints the plugin calls, so the plugin runs unchanged against it. It is a dev
tool only: the release zip is `manifest.json` + `index.js`.

No checkout needed. With Node.js installed:

```bash
npx github:outcast1000/viboplr-slskd                               # generated results, port 5039
npx github:outcast1000/viboplr-slskd --scenario vpn-blocked        # see "Scenarios"
npx github:outcast1000/viboplr-slskd --downloads ~/Music/fake-slskd --speed 4
```

npx asks once before fetching it. In a checkout of this repo, `npm run fake-slskd -- <options>`
does the same. Add `--help` for every option.

Then in Viboplr, open **Soulseek → Settings**:

1. With no fake running, the **Test server** section sits at the bottom of the tab and shows the
   command above. Press **Look again** after starting the fake (it's also noticed by itself
   within about a minute).
2. Once the fake answers, the section moves above Connection with a switch. Turn **Use the test
   server** on, and searches and downloads go to the fake.
3. Turn it off to go back to your own slskd.

The plugin recognises the fake by the `X-Fake-Slskd` header on its answers, so a real slskd is
never mistaken for one.

- **Your real connection is kept.** The address, key and Roadie link stay as they were, and
  the switch only changes which server the plugin talks to.
- **The fake gets its own state.** Downloads, kept fallback files, sharer history, upgrades
  and the fallback log are stored separately while the switch is on. Otherwise the fake's
  transfer list, which holds none of your real downloads, would make the plugin drop them as
  vanished. Switching back brings the real ones back.
- **Ports:** the address defaults to `http://127.0.0.1:5039`. A fake on this computer started
  with `--port` anywhere from 5039 to 5049 is found by itself and its address saved, including
  when it restarts on another port while the switch is on. For another port or another
  machine, type it into **Test server address**.

**No switch, only the command?** The plugin hasn't heard from the fake yet:

1. **Is it running?** Check with `curl -i http://127.0.0.1:5039/api/v0/session/enabled` (use
   your port). The reply should include an `X-Fake-Slskd` header. Then press **Look again**.
2. **No Test server section at all?** Viboplr runs a plugin build older than 0.17.0. Update
   it from Extensions, or load this checkout: **Settings → Debug → Debug mode** on, then
   **Developer → Dev plugin folder** set to this repo, then **Reload**.

You can also point the normal Connection address at the fake. It works, but it's shared
state, which is what the switch avoids.

Put `--downloads` inside one of your local collections and finished files reach the library
the way real ones do (the plugin rescans that collection).

## Generated mode

- **Results are deterministic:** the same query always gets the same ten sharers, with the
  same files. Every word of the query appears in every path, because Soulseek only returns
  files whose path holds every word. A query written `Artist - Title` gives tidy
  `Artist - Album` folders. Anything else becomes the title.
- **The sharers each exercise something:** 24/96 FLAC, 16/44 FLAC, a CD rip that also
  offers an "(Instrumental)", MP3 320, V0, a busy sharer that keeps you in its queue for 30
  seconds, one that never sends a byte (a stall), one that fails at 40%, a "(Live)" version
  95 seconds longer (for the duration filter) and one whose files are locked.
- **Sizes match the advertised bitrate,** so the plugin's size-over-duration upgrade check
  sees what the search promised.
- **Finished files are real audio:** ffmpeg writes a quiet tone at the advertised duration,
  sample rate and bit depth, tagged from the filename. `--source FILE` copies one file
  instead, and `--stub` writes placeholders that won't play (that's what the tests use).
- `--speed N` runs every timeline N times faster.

## Scenarios

| `--scenario` | What it pretends |
|---|---|
| `normal` | Signed in, the ten sharers above. |
| `empty` | Every search finds nothing. |
| `slow` | Results trickle in over about 25 s, past the playback fallback's 20 s search share. |
| `peer-fails` | Every transfer fails part-way. |
| `vpn-blocked` | Not signed in: the connection opens and is closed before Soulseek answers, which is what a work filter does. Its log carries the lines the plugin turns into the "network blocks Soulseek" banner. |
| `bad-password` | Not signed in: Soulseek rejected the login. |
| `unauthorized` | slskd rejects the API key. |

## Record and replay

Recording captures what a real slskd answers, so you can work with real results on a network
that can't reach Soulseek.

**1. Record, off the VPN** (a phone hotspot or your home network), in front of your real
slskd:

```bash
npm run fake-slskd -- --record --upstream http://127.0.0.1:5030 --api-key <real slskd key>
```

Point the plugin at the fake as usual and use the app normally. Every request goes to the
real slskd and its answer comes back unchanged. Alongside, the fake saves into
`recordings/<date>/` in the folder you ran it from (or `--record DIR`):

- `application.json`: the signed-in status.
- `searches/<query>-<hash>.json`: one file per query. It holds every poll with its time
  since the search started (state and counts), then the final responses.
- `transfers.json`: one timeline per download, with each state change (queue position,
  bytes, errors) and its time since the download was queued. Downloads queued before
  recording started are skipped, since there's no start time to measure from.

Other options: `--upstream-key` (if it differs from `--api-key`) and `--upstream-insecure`
(for slskd's self-signed HTTPS port).

**2. Replay, on the VPN:**

```bash
npm run fake-slskd -- --replay recordings/2026-10-07
```

A search for a recorded query (compared case- and whitespace-insensitively) returns the
recorded responses on the recorded clock. Downloading a recorded file follows its recorded
timeline, including queue positions, stalls and failures. A timeline that ends mid-transfer
holds its last state, which is a stall. Anything not recorded falls back to generated
results, and `--speed` applies to replays too.

### What anonymising does, and doesn't do

Real answers carry other Soulseek users' names and the folders they share from, so a
recording goes through these steps before anything is saved:

- **Whitelisted fields only:** every field not named in `slskdRecording.js` is dropped, so a
  new field in a future slskd can't leak through.
- **Usernames** become `peer-<8 hex>`, an HMAC keyed by a salt in
  `~/.config/fake-slskd/salt`. That gives the same sharer the same name across recordings on
  this machine. The salt is never written into a recording, so names can't be checked by
  trying candidates.
- **Paths keep only their last two segments,** the album folder and the file, re-rooted
  under the fake sharer. Share roots, drive letters and home folders all sit above that.
- **IP addresses, email addresses and recorded usernames** are replaced in whatever text
  survives (folder and file names, error messages).
- **Your own** search queries and slskd version are kept, since they're yours.

`recordings/` is gitignored. Before committing a recording as a fixture, read it: a folder
name can still say who ripped it ("[ripped by …]").
