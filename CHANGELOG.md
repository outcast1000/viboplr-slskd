# Changelog

## 0.9.4

- **Your local collections are shared by default, old installs included.** New installs already
  shared them; an slskd installed before Roadie 0.3.0, or a collection added since, was left out.
  The slskd card now lists what isn't shared yet with a *Share…* button. Roadie's dialog shows the
  folders before anything becomes public, and once you approve, slskd is asked to rescan so the
  files count right away. The "not sharing any folders" warning offers the same button.
- **A calmer screen when slskd isn't ready.** For the slskd Roadie runs, the problem and its fix sit
  on top, and everything else is one short "slskd from Roadie" card: address and Test, start at
  login, sharing, slskd's files (folded), connection details (folded: Roadie filled them in, and
  editing them stops using Roadie's slskd), and Remove last. The Settings tab uses the same card.

## 0.9.3

- **"slskd rejected the API key" now fixes itself in one click when Roadie has slskd.** A key
  from the manual setup guide doesn't work on the slskd Roadie installed, and the old advice
  (add it to `slskd.yml`) couldn't stick, because Roadie rewrites that file. The screen now offers
  *Use Roadie's slskd*, which switches to Roadie's address and key without asking anything (Viboplr
  is already allowed).
- **Signed out of Soulseek says why, and Restart slskd signs it back in.** When another app signs
  in with the same account (Nicotine+, SoulseekQt, slskd on another computer), Soulseek signs slskd
  out and slskd stays out. The screen now says so, instead of pointing at your password or a
  firewall, and *Restart slskd* restarts it through Roadie.
- **slskd's files are listed whenever Roadie has slskd**, including while the connection is
  broken, which is when you go looking for them.

## 0.9.2

- **See where slskd lives.** When Roadie installed your slskd, Settings → Connection lists its
  files: the settings file (*Show in folder*), the install folder, Roadie's data folder for it and
  its logs (*Open folder*). The settings file is only ever shown in its folder, never opened: it
  holds your Soulseek password, and Roadie rewrites it, so change settings through Roadie. Needs
  Roadie 0.5.0, which Viboplr fetches on its own; with an older Roadie the list stays hidden.

## 0.9.1

- **Remove slskd from the plugin.** When Roadie installed your slskd, Settings → Connection has a
  *Remove slskd…* button with the same two choices as Roadie's own window: *Remove, keep
  settings* (your Soulseek login stays for a reinstall) or *Remove everything*. Roadie still asks
  you in its dialog before anything is removed, and your downloads and shared folders are never
  deleted. Once it's gone the plugin forgets the connection and returns to the setup screen; a
  declined or failed removal says why under the button.

## 0.9.0

Needs Viboplr 1.0.72 or newer, which names the owning plugin on every plugin menu item — the
menu entries are now just *Search…*, *Upgrade* and *Fill missing tracks…*, shown as
"Soulseek: …".

- **Upgrade finds the better copy for you.** Right-click → Soulseek: Upgrade no longer opens a
  search to pick from. It adds the track to a new **Upgrades** tab and does the rest: one search,
  the same recording only (same length, no live or remix you didn't ask for), better than your
  copy, from the sharer most likely to deliver, with the next sharer asked if one sends nothing for
  10 minutes. The finished file is **checked** before you hear about it: its real size over its
  real length has to match what was advertised and still beat your copy, so a mislabelled "320"
  is set aside. Then *Compare & replace…* opens Viboplr's compare step, and nothing in your library
  changes until you confirm there. *Choose myself…* still opens the filtered search. (The
  *Compare & replace* / *Show* buttons on the notifications arrive with a later Viboplr; until
  then the notification is text only and the same buttons are on the Upgrades row.)
- **Upgrade to: Best available, Lossless only, or MP3 320 / V0** (Settings). When nothing meets
  it, the Upgrades row offers the best better copy that was found.
- **Fallback quality has the same four choices**, set separately: *Fastest start* (default,
  unchanged), *Best available*, *Lossless only* and *MP3 320 / V0 only*. The last two skip the
  track rather than play anything less, and the Fallback tab says when the setting, not the song,
  was why nothing played.
- **Settings moved into the Soulseek view** as its own tab, beside Search, Downloads, Upgrades and
  Fallback. There is no longer a Soulseek page under Viboplr's Settings.

## 0.8.0

- **"slskd not found" is a short screen with three ways forward.** Never set up: *Install
  automatically* (Roadie, recommended), *Install manually* (the guide) or *Connect to your slskd*
  (address and key). Set up but nothing answers: *Try again* and *Connection settings…*, then how to
  start it, then the two ways to reinstall. Each way is its own page with a *Back*, so the account
  form, the guide and the address fields are never on screen together. A slskd Roadie installed
  and still has reads *slskd is stopped* with one **Start slskd** button. An slskd Roadie already
  has is offered first (*Use Roadie's slskd*). Error details show only when they add something (an
  HTTP status), and the self-signed-certificate hint only for an HTTPS address that is failing.
- **The warning says what to do, with the button that does it.** A stopped slskd that Roadie
  installed warns *slskd isn't running* with **Start slskd**, which starts it through Roadie
  ("Starting slskd…", and Roadie's reason if it can't). Any other problem carries **Open Soulseek**.
  Your own first *Connect* that finds nothing no longer adds a toast on top of the screen you
  clicked in. Needs a Viboplr whose notifications take a button; on older ones the text is the same
  and the button is left out.
- **slskd's own web page, and its login.** Settings → Soulseek has an *slskd web page* section:
  **Open** opens it, **Show login** reveals the username and password in selectable fields
  (hidden again with *Hide login*; never stored). For a slskd Roadie installed, the login is the
  one Roadie generated, read from Roadie (Roadie 0.2.0 or newer; older ones say so). For one you
  run yourself it's slskd's default, `slskd` / `slskd`, unless you changed it in `slskd.yml`.
- **Your Viboplr collections are shared by default.** Installing with Roadie now shares your local
  collections as well as the downloads folder: the install form lists them under *Share my Viboplr
  collections*, on unless you turn it off, and Roadie's approval dialog shows the folders. Needs
  Roadie 0.3.0 or newer (it opens slskd's `shares.directories`); with an older Roadie the install
  goes ahead without them. The manual guide already ticked every collection.
- **Search results no longer download artwork.** Rows show album or artist art Viboplr already
  has, but a search never makes it fetch (and keep) a cover for every album that merely appeared in
  the results, since those names are guesses parsed from other people's file paths. Needs a
  Viboplr that knows the list option; older ones fetch as before.
- **Roadie now comes with Viboplr.** Viboplr carries Roadie's command-line release as a managed
  dependency (Settings → Dependencies), so the empty view no longer needs a separate Roadie app
  running. *Install automatically* first offers Viboplr's own install modal for Roadie when it's
  missing. With Roadie present, it shows the install form (Soulseek account and choices): one Roadie run downloads slskd, asks you in Roadie's dialog, starts it on this
  computer only, and grants Viboplr its own key in the same approval. The plugin then connects by
  itself. The account is passed to Roadie once and never stored by the plugin.
- **Setup is one screen with a checklist.** While Roadie sets slskd up, the view shows only
  *Setting up slskd with Roadie*: approve in Roadie's dialog (with a note that it may be behind
  the window), download (with a progress bar), unpack and check, start slskd, connect Viboplr,
  and sign in to Soulseek as your account. Each step turns ✓ on a real signal. A failure stops on
  its step in plain words: a decline or a broken download offers *Back* to the form (typed values
  kept); slskd not starting shows Roadie's reason with *Try again*. No sign-in within 45 seconds
  explains that slskd keeps trying and a VPN or firewall may be blocking the server, with *Check
  again* / *Close*. The address and key fields, the guide links and readiness toasts stay out
  of the way until setup ends; the view then turns into the plugin itself.
- **An account is required to install.** *Install slskd* stays disabled until both the username
  and password are filled in, and the form explains how to get one: Soulseek has no sign-up page,
  so a username nobody else uses plus a password creates the account on slskd's first sign-in.
- **The sign-in step says what it's doing and, if it can't, why.** While it waits it shows slskd's
  own connection state ("Connecting to the Soulseek server… 12s"). If it can't sign in it reads
  slskd's recent log through Roadie (`roadie tool logs slskd`) and reports the reason: a
  connection that timed out, was refused or can't reach the server is explained as a VPN, work
  network or firewall blocking it (slskd keeps retrying), and a refused sign-in (wrong password,
  or a username someone else owns) stops the wait at once instead of after 45 seconds. Any error
  in the steps after the install turns the current step into ✗ with the error rather than
  leaving it spinning.
- **"Start slskd at login" is asked, and off by default.** The install form carries the switch,
  and the plugin always passes the answer (`--set autostart=…`), so Roadie's recipe default (on)
  never decides it. On means Roadie adds a login item, and macOS announces it as background
  activity. For a Roadie-managed slskd the same switch sits in the Connection section and runs
  `roadie tool autostart slskd on|off`.
- A Roadie-managed slskd that isn't running shows **Start slskd**, which runs `roadie tool start
  slskd`.
- The plugin drives Roadie with `api.system.exec` (`tool status`, `tool install --consumer
  viboplr`, `tool connection`, `tool start`) and only asks Roadie for a connection automatically
  once Viboplr is already approved, so Roadie never opens a dialog you didn't click for. The
  `roadie://` deep links, the loopback probe of the desktop app's API and the
  `viboplr://plugin/slskd/roadie` return link are gone.
- Needs a Viboplr whose dependency registry has `roadie`. On an older Viboplr,
  `getDependency("roadie")` answers null, nothing Roadie-related shows, and the setup guide is
  the way to get slskd, as before.

## 0.7.0

- **Install slskd with Roadie.** When [Roadie](https://github.com/outcast1000/roadie), the
  standalone tool manager, is running on this computer, the empty view offers *Install slskd with
  Roadie* (or *Connect through Roadie* when Roadie already has it). The button opens a `roadie://`
  link; Roadie asks you before installing and before letting Viboplr connect, then sends the
  plugin back a `viboplr://plugin/slskd/roadie` link and the plugin reads the address and its own
  API key from Roadie's loopback API. Without Roadie the view offers *Get Roadie* next to the
  existing guide, and nothing else changes. Needs a Viboplr that can open `roadie://` links
  (1.0.71 or newer); on an older Viboplr the button explains.
- A connection that came from Roadie is marked `managedBy: roadie`: it follows Roadie's port if it
  moves, is forgotten when Roadie reports slskd removed, and shows *slskd is stopped — Open Roadie*
  instead of the generic "not reachable" text. Typing an address or key by hand ends the
  management; a hand-typed connection is never overwritten, and Roadie merely being closed never
  releases anything. Pinned by `test/roadie.test.js`.
- **Upgrade with Soulseek…** (right-click a library track). Runs the usual
  search for the track and shows only files that would be an upgrade over the
  copy you have — a higher tier (lossless over lossy, high over medium) or the
  same lossy tier at least 20% faster; a lossless copy is beaten only by more
  bits or a higher sample rate. Results are held to the same length as your
  copy, so a different version can't pose as a better one. Your copy's quality
  is shown above the list (the bitrate is worked out from size and length, and
  marked approximate). *Show everything found* lifts the filter and marks the
  upgrades with ↑. The file you pick is tagged with the library's own title,
  artist and album, and once it lands its Downloads row offers **Replace in
  library…**, which opens Viboplr's download modal with the row to replace —
  compare, then replace or keep both. (Needs a Viboplr that reads
  `libraryTrackId` on that request; an older one runs the ordinary Add to
  library copy instead.)
- **Fill missing tracks with Soulseek…** (right-click an album). Searches for
  the album and compares every folder found with the tracks you already have,
  matching on title words the way the playback fallback does (edition words
  ignored, a "live" or "remix" the library title lacks counts as a different
  recording). Opens on Folders, hides folders with nothing new, and says per
  folder how many files you lack and what they weigh; **Fill** downloads just
  those, tagged with the library's album. The Files view is filtered the same
  way. Both actions fall back to a plain Soulseek search, with a note saying
  why, when the track isn't a local library file or the album has no tracks in
  the library.

## 0.6.0

- **Hedged fetch.** The best sharer is queued at once; if no byte has arrived
  after 5 s the runner-up — always a different sharer — is queued beside it,
  never more than two at once. The first transfer to move wins and the other is
  cancelled on the spot; a transfer that is sending is never second-guessed,
  however slow. An attempt with no data for 12 s is dropped and its place
  refilled, up to four sharers per resolve. A good sharer, the common case,
  still costs exactly one enqueue. On timeout one transfer is kept running for
  next time and the rest are cancelled, so two strangers' slots aren't held for
  a song nobody is waiting on.
- **Sharer ledger.** Every download the plugin watches — the Search tab's, the
  assistant's, the fallback's — records the sharer's deliveries, failures and
  stalls (a delivery is worth two strikes). Sharers who have delivered rank
  first in the Search tab at equal quality and ahead of an advertised free slot
  in the fallback; sharers who only ever fail sink. The Availability column
  says which is which ("free slot · delivered 3×", "queue 12 · unreliable").
  Settings → Soulseek shows the totals and can forget the history.
- **Fallback quality setting** (Settings → Soulseek → Playback fallback): *Fast*
  (default) puts high-bitrate lossy files first, *Best* puts lossless first as
  the Search tab does; a preferred-formats list overrides both.
- A sharer dropped mid-resolve no longer leaves a bookkeeping record behind.
- `CLAUDE.md` / `AGENTS.md`: a guide for AI agents working in this repository —
  how Viboplr runs a plugin, the fallback design and the decisions behind it,
  slskd facts that bit, unit and live testing, releasing.

## 0.5.3

First release after a run against a live slskd, which found the bug below.

- **Stall is measured on bytes, not state.** A sharer that advertised a free
  slot kept the fallback's transfer in "Queued, Remotely" for the whole budget
  while slskd flickered it through Initializing and InProgress at zero bytes;
  the state-based rule took that flicker for a start and waited 51 s. Now "no
  data for 12 s" means the next sharer, whatever the state says.
- **Background downloads are watched.** A fallback download left running past
  the budget is reconciled on every poll: one that finishes becomes a kept file
  and answers the next request instantly; one that fails or vanishes is removed
  from slskd's list and forgotten, so a flaky sharer leaves neither a stray
  "Failed" row in Downloads nor a stale index entry.
- **The `remote_file_management` hint was wrong.** It is a top-level line in
  `slskd.yml`, not one of `flags:`, and slskd picks it up without a restart. The
  refusal message and the README say so now.
- **Setup guide: "Your Soulseek account".** A note above the config block on
  every tab: there is no sign-up, the first login creates the account, write
  the credentials down (no recovery), a taken name just fails, use a throwaway
  password (the protocol sends it essentially in the clear), the name is
  public, and one client per account — sharing a login with SoulseekQt or
  Nicotine+ makes slskd drop in and out.

## 0.5.2

- **macOS guide: the right settings folder.** slskd 0.26 on .NET 10 keeps its
  files in `~/Library/Application Support/slskd`, not `~/.local/share/slskd` as
  slskd's own README (and this guide) said. Every macOS path on the page now
  points there, quoted where it goes through the shell; the Run it once step
  tells you to read the location off the `Using application directory` log
  line, so an older build still works out.
- **macOS guide: Run it once, step by step.** The download step moves the
  whole unzipped folder to `~/slskd` in one line and says why the `config`
  folder must stay beside the binary. The run step explains the three
  commands, names the `Application started` line to wait for, and adds a check
  (`ls` the settings folder) with the two usual reasons it comes up empty. The
  Configure step says a fresh `slskd.yml` is all comments, so the block is
  pasted at the end — nothing to merge.
- **The guide is reachable from every state.** "Open setup guide" now sits
  next to Test connection in the Connection section (the sidebar view and
  Settings → Soulseek), and on the "key rejected" and "not signed in" screens,
  carrying the plugin's own key. Those two screens now say the fix is in
  `slskd.yml` — the key goes into slskd's file, not out of its web UI, which is
  what the old wording implied. The guide says where the button is.

## 0.5.1

- **The Fallback tab says what it is waiting for.** While a fallback resolve
  runs, the Picked file line and the progress bar show the transfer the way the
  Downloads tab would — "Waiting in peer's queue · position 3", then
  "Downloading 44% · 4 MB of 9 MB · ↓ 1 MB/s · about 0:05 left" — instead of a
  bare percentage. The time left is bytes remaining over slskd's reported
  average speed, and is omitted when there is none.

## 0.5.0

- **The playback fallback no longer throws its search away.** slskd ends a
  search only after a stretch with no new answers, so a popular song keeps
  collecting for 35-40 s — past the fallback's 20 s, where the whole search was
  discarded as "no answer in time" even with hundreds of responses in hand. At
  the deadline the search is now stopped and what slskd collected is ranked and
  used. A search nobody wants any more is also stopped in slskd rather than
  abandoned, so it no longer holds slskd's single search slot for the next one.
- **Fallback tab is a read-out.** A **Picked file** block shows the file the
  resolver went for and what became of it (played / downloading with progress /
  still downloading for next time / dropped). The matching files are plain text
  lines — match, name, quality, size, length, availability, sharer — marked
  ✓ played, ↓ downloading, ✗ tried and dropped: no artwork, nothing to click.
- **Kept files moved to Downloads**, as "Fetched by the playback fallback" below
  slskd's own transfers, with Play, Add to library, Delete file and Delete all.
- **No stray "Failed" rows.** A sharer slskd couldn't even connect to is now
  removed from slskd's list like every other dropped attempt, instead of staying
  in Downloads as Failed until removed by hand.
- **Setup guide: shared folders.** The guide lists your Viboplr local
  collections (passed in the link's fragment, never to a server) as checkboxes
  and writes the ticked ones into the `shares:` block; more can be typed in.
  Docker mounts a music folder read-only at `/music` and shares that.
- **Setup guide: HTTPS off on Windows.** The Windows config adds
  `web.https.disabled: true`, working around slskd's HTTPS bug there; the plugin
  talks plain `http` on the same computer.

## 0.4.0

- **Playback fallback.** The plugin is now a stream resolver: when a track has
  no playable source of its own, Viboplr can ask Soulseek for it (Settings →
  Providers → Playback fallback). One bounded search (20 s), a match that
  requires the title in the filename and the artist in the path and marks down
  live / remix / instrumental / cover variants, then the best file from a
  sharer with a free slot — dropped for the next sharer if it hasn't started in
  12 s, up to three. Everything fits in the host's 60 s; what doesn't finish
  keeps downloading and answers the next request for that song instantly.
  Without a preferred-formats setting the fallback favours high-bitrate lossy
  over lossless, since it arrives in a fraction of the time. Audio only; needs
  slskd on this computer.
- **Fallback tab** in the Soulseek view: the last resolve step by step (query,
  every matching file with its match score, ✓ the one that played, ✗ the ones
  tried and dropped, timings), plus the **kept files** the fallback has fetched
  so far, with Play, Add to library and **Delete file** (also a Delete all).
  Fetched files live under `viboplr/fallback/` in slskd's downloads folder and
  are remembered by normalized title + artist.
- **Deleting kept files** goes through slskd's Files API, which slskd gates
  behind `remote_file_management: true`; a refusal says exactly that instead of
  failing quietly. Settings → Soulseek gains a **Playback fallback** section
  with the count and size of kept files and the same delete.
- Tests: the fake host moved to `test/harness/host.js` and is shared by the
  transfers and fallback suites.

## 0.3.1

- **A quieter empty view.** While slskd isn't connected the view is one line
  and two buttons — **What is this?** and **Connect** —
  above the unchanged Connection section. The paragraph, the visible API key
  and the "Generate a new key" button are gone; the key still travels to the
  guide page in the URL, and the Connection section's API key field can be
  edited as before.
- **"What is this?" is its own page** (`docs/what-is-this.html`): what Soulseek
  and slskd are, why you install slskd yourself, what the plugin does once
  connected, what you need, and what to expect — leading on to the setup guide
  with the key carried along. The two pages share `docs/style.css`.
- **The setup page explains the Connection fields** — the address (same
  computer vs. a NAS / server / Docker on another machine, http vs https), the
  API key, the "slskd runs on this computer" toggle and what it changes for
  finished downloads, a Docker-elsewhere checklist (port reachability, sharing
  the downloads folder back), and what each status line means.

## 0.3.0

**A real setup guide.** Installing slskd — especially on Windows, where it is a
console program with no installer — was where most people gave up. The empty
view's "Get slskd" link is replaced by an **Open setup guide** button that opens
[a guide page](https://outcast1000.github.io/viboplr-slskd/) (`docs/index.html`,
GitHub Pages) with a tab per system, auto-selected from the visitor's OS:

- **Windows / macOS / Docker** steps: where to download, how to run it
  the first time (macOS needs `xattr -dr com.apple.quarantine` for an unsigned
  download — that is in there), the exact `slskd.yml` lines to paste, where
  finished downloads land so you can add the folder as a Collection, and an
  optional copy-paste snippet that starts slskd hidden at every login (a Startup
  shortcut on Windows, a launch agent on macOS).
- **The API key is generated by the plugin** and handed to the page in the URL
  fragment (never sent to a server), so it is already filled into the yml
  snippet there and into the API key field here; the last step is one
  **Connect** button that fills in `http://localhost:5030`. Every snippet on the
  page has a Copy button.
- Nothing is downloaded, written or launched by the plugin. slskd stays the
  user's program.
- The setup block is also shown when a configured slskd stops answering.
- Pure `randomApiKey` / `setupGuideUrl` / `setupBlock`, pinned by
  `test/setupGuide.test.js`.

## 0.2.1

- **New icon**: a note inside a ring — music coming off a network. The old one
  was a *filled* note silhouette, and the host draws plugin icons stroke-only
  (`fill: none`, 24×24, stroke-width 2, in both the sidebar and the Extensions
  view), so it rendered as an outline of a note-shaped blob rather than a note.
- **A finished download plays again.** The local path was built by joining
  slskd's downloads folder to the filename its Files API reported — but a
  *targeted* directory listing relativizes names to the directory that was
  asked for, not to the downloads root, so `viboplr/1-Album/04. Track.flac`
  came back as `04. Track.flac` and the album folders were lost. Playback then
  failed on a path that never existed. Targeted listings are now rebased onto
  the downloads root before anything joins them.
- **A stored path that can't be right any more is re-derived.** slskd's
  downloads folder is the user's to repoint, and a tracked record outlives the
  setting — so play and Download… now check that the remembered path still sits
  under the *current* downloads folder and re-locate the file from a fresh
  listing when it doesn't. This also heals paths written by 0.2.0.
- **Search results are capped at the best 1,000.** A broad query really does come
  back with 20,000+ files across 16,000+ folders, which is neither scrollable nor
  cheap to render. Results were already ranked best-first, so the cap only drops
  a tail nobody reaches; a line above the list says how many matched. Folders are
  grouped from the full list before the cap, so a folder that is shown still
  carries every one of its files and "download folder" gets the whole album.
- **A result row shows its filename, with `user · folder` beneath it.** Everyone
  on Soulseek shares the same album, so a column of basenames looked like one
  track repeated forty times — the sharer and the folder they keep it in are what
  actually tell two candidates apart. The whole remote folder path is shown, not
  just its last segment.
- **Quality, size, length and availability are columns now**, in place of the
  fixed Album / Duration pair, so they line up down the list instead of running
  together in a sentence per row. A fact the sharer never reported is left blank
  (an em dash) rather than shown as zero — plenty of Soulseek clients report no
  bitrate and no duration at all.
- **Results are selectable, and a selection downloads in one go.** Pick files
  from several sharers and hit Download: each sharer gets its own batch, because
  slskd addresses an enqueue to one peer. Clicking a row's *name* still starts
  that one file, so nothing that worked before needs a modifier now. (This is
  also what makes the columns above appear at all — the host renders declared
  columns only on a selectable list.)
- **Those columns sort.** Clicking a header re-orders the list, and `desc` means
  *best* first on every column — lossless at the top of Quality, a free slot at
  the top of Availability — rather than merely largest-first. A file the sharer
  reported nothing for sinks to the bottom whichever way the arrow points, since
  unknown is not zero. Sorting happens in the plugin, on the raw numbers; the
  host only ever sees the formatted text. "Back to best match" restores the
  ranking, which the header toggle alone can't do.
- **A search no longer drags its results along on every poll.** The progress
  poll asked for `includeResponses=true` once a second for up to 30 seconds:
  measured against slskd 0.26.0, that is ~254 bytes of counts versus 2.6 MB of
  bodies, so a broad search pulled ~78 MB through the plugin and parsed it 30
  times to read two integers off it. Bodies are now fetched once, after the
  search completes.
- **A finished search that briefly reads as empty is retried.** slskd writes the
  response bodies a moment *after* the search flips to `Completed` (~68 ms), and
  the old code took whatever the completing poll happened to hold — so a search
  that found thousands of files could report "no downloadable audio found".

## 0.2.0

**Brought in line with the current host and with the yt-dlp and qBittorrent
plugins.** Requires Viboplr 1.0.34+.

- **Add to library works again.** The host removed its background download
  queue (`api.downloads.enqueue`) after 0.1.0 shipped, which left the button
  doing nothing. It now opens Viboplr's own download modal
  (`api.ui.requestAction("download-tracks")`) with this plugin as the provider —
  the same path the yt-dlp plugin uses — so destination, tags, cover art and
  file-exists handling are the host's. Select several finished files and add
  them in one batch.
- **Finished downloads reach the library on their own** when slskd's downloads
  folder sits inside one of your collections: the plugin rescans that collection
  as files finish (`api.collections.resync`, the qBittorrent plugin's pattern),
  deduped per collection so an album finishing is one scan, not twelve.
  Settings → Soulseek → Library says which case you are in and what to do about
  it.
- **Real metadata from the file.** Once a download is located, its embedded
  tags are read in one host call (`api.system.readAudioTags`) and win field by
  field over the filename parse — so a track keeps its number off the
  `03 - ` prefix even when the tag lacks one.
- **Downloads tab is a proper list.** Rows carry a playable `slsk://` path, so
  the host's universal right-click menu, drag-to-queue and **Download…** all work
  on a finished file. Per-row hover actions show only what applies: Play / Add to
  library on a located file, Retry / Another source on a failure, Cancel while it
  runs, Remove for anything at rest. A selection plays as one queue. An overall
  progress bar sums what is in flight.
- **Cancel and Remove.** Cancel stops a live transfer in slskd; Remove drops the
  row from slskd's list. Neither deletes a file from disk.
- **AI assistants can drive the plugin.** Four tools on the host's assistant
  surface (`api.assistant`): `status`, `search` (its own search, never the
  sidebar's state; results carry ids), `download` (by result id, through the
  same core as a clicked download, so the file is tracked and imported
  identically) and `list_downloads`. Guarded on `api.assistant` existing.
- **Cmd+K hands its query over.** The view is tabbed, so it handles the host's
  reserved `host:search` action instead of relying on the host seeding a
  top-level search box that is only there on one tab.
- **Searches are serialized.** slskd runs one search at a time (a second
  `POST /searches` gets a 429), so the view, the context menu and the assistant
  now queue behind one another instead of colliding. A search that outlives the
  30 s cap is stopped in slskd so its slot frees up, and whatever had arrived is
  shown rather than discarded.
- **Another source keeps the duration.** Re-searching after a failure rejects
  candidates more than 5 s off the failed copy's length, so a mislabeled file
  can't be the "other source".
- **Batch enqueue reports refusals.** A 207 from slskd (some files refused —
  already queued, bad name) now tracks the accepted ones and says how many were
  refused, instead of treating the whole batch as queued.
- The API key field is masked. The download provider returns a concrete file
  extension (the host no longer sniffs bytes, and `"auto"` is gone).
- Source hygiene: the transfer-key separator was a literal NUL byte in the
  source, which made `index.js` binary to every text tool. It is now the
  `"\u0000"` escape — same value, so records saved by 0.1.0 still resolve.

## 0.1.0

- Initial release. Search and download from the Soulseek network via a
  user-run [slskd](https://slskd.com/) daemon.
- Sidebar view with Soulseek search, ranked results, and a Folders tab for
  whole-album grabs.
- Downloads tab with live progress, queue position, and retry / try-another-source
  on failure.
- Finished downloads play directly and can be imported into a collection when
  slskd runs on the same machine as Viboplr.
- Four-state setup guidance (not configured / unreachable / bad API key / not
  signed in to Soulseek), each with a specific fix, plus a sidebar badge.
- Results ranked by quality tier first, then free upload slot, queue length and
  upload speed. Optional preferred-format list.
