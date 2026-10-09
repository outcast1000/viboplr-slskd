# CLAUDE.md — viboplr-slskd

Guidance for AI agents working in this repository. `AGENTS.md` points here.

## What this is

A plugin for **Viboplr**, a Tauri 2 desktop music player (Rust backend, React/TypeScript
frontend in a native webview) by the same owner, at `outcast1000/viboplr` — locally
`/Users/alex/Code/viboplr` (work happens in `.claude/worktrees/1`). The plugin lets Viboplr
search and download from the Soulseek network through **slskd**, a headless Soulseek daemon
the user runs themselves, and acts as one of Viboplr's **playback fallback** sources.

The host's own plugin documentation is the reference for anything about the API:
`.claude/rules/plugins.md` in the app repo (API surface, manifest format, stream-resolver
chain, download providers, declarative view nodes, assistant tools), and
`src/types/plugin.ts` for the canonical TypeScript types. Read those before guessing at a
call's shape.

## How Viboplr runs a plugin

- `index.js` is a **bare function body** the host evaluates with `new Function(...)`; it
  ends with `return { activate, deactivate, ... }`. No `module.exports`, no IIFE.
- **Sandbox:** there is no `fetch`, `require`, `process`, `Map`, `Set`, `btoa`, `atob`,
  `TextEncoder`, `URL`, `crypto`, `localStorage` or `WebSocket`. `test/harness/sandbox.js`
  shadows every one of these with a throwing proxy, so a test fails the moment new code
  touches one. Base64 and UTF-8 are hand-rolled here for that reason. `String.prototype`
  methods (including `normalize`) are fine.
- HTTP goes through `api.network.fetch(url, init)` (proxied by Rust; returns
  `{ status, headers, text(), json() }`). Set `timeoutMs` on anything that polls — there is
  no default timeout and a plugin cannot cancel an in-flight request.
- Persistence is `api.storage.get/set/delete` (SQLite, per plugin). Files the plugin may
  read/write/delete are only those under its own data directory (`api.storage.files`).
  **A plugin cannot delete anything in slskd's downloads folder itself** — that is why
  "Delete file" goes through slskd's Files API.
- Views are **declarative node trees** handed to `api.ui.setViewData(viewId, node, opts)`:
  `layout`, `text`, `button`, `toolbar`, `section`, `settings-row` (+ `text-input`,
  `toggle`, `select` controls), `search-input`, `tabs`, `loading`, `progress-bar`,
  `card-grid`, `track-row-list`. No HTML strings. Actions come back through
  `api.ui.onAction(id, fn)`; a tabs node sends `{ tabId }`, a list action sends
  `{ itemId }` / `{ selectedIds }`, a select sends `{ value }`.
- `track-row-list` gotcha: `columns` render **only when `selectable: true`** — the host's
  non-selectable body hardcodes Album/Duration and ignores them.
- Menus: any context menu is the host's native menu; a plugin contributes items via the
  manifest's `contextMenuItems`, never a DOM dropdown.
- `api.log(level, message, section)` lines are readable from outside the app (see *Live
  testing*); prefer it over `console.log` for anything a later debugging session will want.

## Surfaces this plugin registers (manifest `contributes` + `apiUsage`)

| Surface | Where | Notes |
|---|---|---|
| Sidebar view `slskd-browse` | Search / Downloads / Upgrades / Fallback / Settings tabs | `render()`; one job per tab (see *View layout*) |
| Settings tab | last tab of `slskd-browse` (no host settings panel) | `settingsTab()`: Status checklist + Connection + Downloads; `renderSettings()` also redraws Upgrades / Fallback, which hold their own settings |
| Stream resolver `slskd-fallback` | `api.playback.onStreamResolve` | the **playback fallback**, see below |
| URI scheme `slsk://` | `api.playback.onResolveStreamByUri` | plays a finished download |
| Download provider `slskd-import` | `api.downloads.onResolveByUri` | "Add to library…" via the host modal |
| Context menu `slskd-search` | track / album / artist | "Search…" (shown as "Soulseek: Search…") |
| Context menu `slskd-upgrade` | track, multi-track | "Upgrade" (shown as "Soulseek: Upgrade") — **automatic**: `queueUpgrade` adds an entry to the Upgrades tab, which finds, downloads and checks a better copy (see *Automatic upgrades* below); "Choose myself…" on the row opens the old interactive search (`startUpgrade`, filtered by `isUpgradeOver`). Both stamp the download `upgrade: { trackId }`, and "Compare & replace…" / the Downloads row's "Replace in library…" hand the host modal `libraryTrackId` |
| Context menu `slskd-fill-album` | album | "Fill missing tracks…" (shown as "Soulseek: Fill missing tracks…") — folders compared against the album's library rows (`ownedTrackFor`); "Fill" downloads only the missing files |
| Assistant tools | `status`, `search` (+ `upgradeFor`), `download`, `list_downloads` (+ `uri`), `upgrade`, `list_upgrades` | for the host's control API / MCP; uris are `toolUri` (percent-encoded), resolvers `decodeRef` them |

`test/transfers.test.js` ("activate registers every surface the manifest declares") fails
if a declared surface has no handler — add both together.

## The playback fallback (the load-bearing design)

When a track has no playable source, the host walks its **stream resolvers** in the order
the user set in *Settings → Providers → Playback fallback* (default: the built-in Library
resolver, then plugins in load order) and gives each one **60 seconds**. Everything in
`resolveFallback` / `raceSharers` is carved out of that:

- 55 s total budget; 20 s search share (slskd is stopped at the deadline and what arrived
  is ranked); **hedged** fetch — best sharer at once, a second, different sharer after 5 s
  with no bytes, at most two in flight, first byte wins and the other is cancelled, a moving
  transfer is never second-guessed; "no bytes for 12 s" drops an attempt (measured on
  **bytes**, not state — slskd flickers Queued → Initializing → InProgress at 0 bytes);
  up to four sharers per resolve.
- What lands in time plays (`file://` under `<downloads>/viboplr/fallback/…`). What does
  not keeps downloading; the `fallback` index (keyed by normalized title|artist) makes the
  next request for the same song instant, and `reconcilePendingFallbacks` on every poll
  turns a finished background download into a kept file or forgets a failed one.
- Ranking (`rankFallback`): match score (title words in the filename, artist words in the
  path, variant-word penalties) → **sharer ledger tier** → advertised availability →
  quality per the *Fallback quality* setting → speed → queue → size. That setting
  (`fallbackQuality`, `FALLBACK_MODES`) is `fast` | `best` | `lossless` | `high`; the last two
  also **filter** through `meetsQualityTarget`, the same test the Upgrade target uses, and a
  resolve they empty reports "no lossless file — N other matching files skipped…" instead
  of "nothing matched".
- The **sharer ledger** (`sharers`, per username: delivered / failed / stalled) is fed by
  every download the plugin watches and is a ranking key in the Search tab too. Two
  observers see each transfer (the poll and the race); `ledgerSeen` claim/counted marks
  keep an outcome from being counted twice or re-counted after a restart.
- Audio only (declines `opts.preferVideo`); needs slskd on this computer (`tier === "local"`).
- Delete of kept files: slskd Files API `DELETE /api/v0/files/downloads/directories/{b64}`,
  gated by slskd's **top-level** `remote_file_management: true` (not under `flags:`;
  hot-reloaded). A 403 is explained to the user, never swallowed. With no transfer record,
  `fallbackDirB64` rebuilds the address from the kept path (each fetch has its own folder);
  a delete that can't be addressed throws rather than forgetting a file that is still on disk.
- **Automatic cleanup** (owner, 2026-10-05): `fallbackMaxGb` / `fallbackMaxAgeDays`, both **off
  by default** so an update never deletes anything unasked. `fallbackEvictions` (pure) drops
  past-age files, then the least recently played (`lastUsedAt || at`) until the kept total fits.
  Never picked: a file inside a collection (it is a library track — deleting it leaves a row with
  no file), one played in the last 15 min (may be playing), a pending download.
  `enforceFallbackLimits` runs from the poll at most every 10 min and on a setting change; the
  first refusal stops the run, and the outcome shows under the setting (`fallbackCleanup`),
  never as a toast — it runs unattended.

Owner decisions that must hold:

- **slskd not ready is a banner, never a toast** (2026-09-28). The owner found the launch toast
  ("slskd isn't running…") annoying and asked for the yt-dlp / TIDAL pattern: once slskd has been
  set up, a state that isn't ready keeps the tabbed view and puts a `ds-banner` row on top
  (`readinessBanner`) with the one click that fixes it (*Start slskd* / *Restart slskd* through
  Roadie, *Try again*) plus *Fix…*, which opens the Settings tab where `fixNodes` puts the full
  explanation above the Connection card. The first run (`unconfigured`) and the hub's own pages
  stay full-page (`wantsSetupScreen`). The sidebar dot (`badgeFor`) is the only signal outside the
  view. Do not bring back a readiness `showNotification`, at launch or on a state change.
- **The host view header carries the status word, the banner carries the fix.** `viewHeaderFor`
  (pure) → `pushViewHeader`, called at the top of `render()` and change-gated on the JSON, since
  `render()` runs on every poll tick and each `api.ui.setViewHeader` re-renders the host. It is
  feature-detected (older hosts have no header), so it needs no `minAppVersion` bump; the manifest's
  `viewHeader.subtitle` is the fallback before the first render. Keep the header to state + where
  slskd is + *Open slskd*; a fix button belongs in `readinessBanner`, not in the header.
- **Find slskd first; Roadie is only for installing it** (owner, 2026-09-29). The first run
  looks for a slskd already running here (`discoverSlskd`: `GET /api/v0/session/enabled` on
  127.0.0.1:5030–5040 and https:5031, which slskd answers without a key with `true`/`false`)
  before any Roadie call. `refreshReadiness` doesn't reach Roadie while `discovery.state` isn't
  `none`. Found: the plugin's own key is tried, then the user is asked for one of slskd's keys
  (`discoveryNodes`). "Get the key from Roadie" is a second way, shown only when Roadie runs that
  very slskd. The whole setup must work with no Roadie at all. Roadie's role is installing slskd
  when none is found and the user chooses the automatic install.
- **The user owns slskd; Roadie runs it for them, never Viboplr.** The host never installs,
  launches, supervises or configures a third-party daemon itself (a host-managed slskd sidecar
  was built and rejected). The two ways to get slskd are the guided setup (the GitHub Pages
  guide in `docs/`) and **Roadie**, the separate tool manager whose CLI release the host carries
  as a managed dependency (`roadie` in `dependencies.rs`, with Viboplr's own `--data-dir`). The
  plugin drives it with `api.system.exec` (`tool status` / `install --consumer viboplr` /
  `connection` / `start` / `uninstall [--keep-data]`, always `--as Viboplr`). Removal is offered
  only for a slskd Roadie manages (Connection section), goes through Roadie's dialog like an
  install, and on success forgets the managed connection straight away.
  The same section lists slskd's files from `tool status` (`configFiles`, `installDir`, `dataDir`,
  `logsDir` — Roadie 0.5.0+, rows absent before) with `api.system.openPath` / `revealPath`; the
  config file is only ever *revealed*, since it holds the Soulseek password.
  Those rows show whenever Roadie has slskd (`roadieManagedRows`), not only when the connection is
  Roadie's; start-at-login and Remove still need `managedBy === "roadie"`. `roadieOwnsAddress`
  treats any loopback host on Roadie's port as Roadie's slskd (`localhost:5030` = `127.0.0.1:5030`).
  "Key rejected" + an approved Roadie slskd offers *Use Roadie's slskd* (`roadie-connect`) — never
  auto-adopt over a typed address. "Signed out" on Roadie's slskd reads the reason from
  `tool logs` (1000 lines; a refused key logs a warning a minute) and offers `tool restart`: a
  **kick** ("another client logged in using the same username") is final until slskd restarts.
  For Roadie's slskd the Connection section is the **"slskd from Roadie" card**
  (`roadieConnectionSection`): address + Test, start at login, **Sharing**, files (folded), connection
  details (folded; the address/key form, since typing into it ends Roadie's management), Remove last.
  **Sharing:** every local collection is shared by default — the install sends them, and an older
  install or a collection added later shows up as a gap (`shareGap`) on the card with *Share…*,
  which re-runs `tool install slskd --set shares.directories=[current ∪ gap]` (adds only). Roadie's
  dialog lists the folders, so the plugin never raises it unprompted; after approval the plugin
  `PUT /api/v0/shares` once slskd is signed in again (`rescanPending`), because slskd can restore
  an empty share cache from backup instead of scanning. Every install is a click here plus an
  approval in Roadie's dialog, and `tool connection` runs automatically only once Viboplr is
  already approved (`roadieAutoConfigAction`), because an unapproved one opens that dialog.
  Everything is feature-detected: `getDependency("roadie")` is null on hosts without it.
- **No metadata-based download provider.** A download the user asks for by hand gets a
  file they picked, not the fallback's best guess. The one deliberate exception is
  **Upgrade** (owner's decision, 2026-09-27): it picks the file itself, but the *replace*
  always goes through the host's compare dialog, so a wrong pick costs a download, never a
  library file. Don't add an auto-replace.
- The plugin deletes only files the **fallback** fetched, and only when asked. The
  Downloads tab's "Clear from list" drops slskd's row and leaves the file.
- Nothing installs itself; a successful operation announces nothing; failures stay visible.

## Automatic upgrades (the Upgrades tab)

The fallback's machinery with the goal turned around: nobody is listening, so quality leads
and the clock is minutes. `upgrades` (storage key, keyed `t<trackId>`) holds one record per
track, advanced by the transfer poll (`advanceUpgrades`, after `readTagsForResolved`) rather
than by a long-running promise, because a stranger's queue can outlast a restart.

- **searching**: one `performSearch` (30 s cap, through `searchChain`), then `rankUpgrade`:
  `rankFallback`'s word match, **no unasked-for variant at all** (the fallback only marks it
  down), `isUpgradeOver` the library copy, then the **Upgrade target** (`upgradeTarget` setting:
  a `UPGRADE_TARGETS` key, default `flac16`; every target but `best` is a **filter** in
  `meetsQualityTarget`: `flac16` = FLAC, not hi-res (unreported depth counts as 16),
  `hires` = reported 24-bit or >48 kHz, `lossless`, `mp3_320` (≥300 measured), `high` = MP3 320 / V0,
  `lossy256` (≥240); the size-conscious ones deliberately skip better files). Sort: match
  bucket → quality (MP3 first under `high`, FLAC under `lossless`) → sharer ledger → free slot →
  speed → queue. No pick
  at the target but a better copy exists → **alternative** ("Take the best found").
- **downloading**: one sharer at a time into `viboplr/upgrades/`, each sharer once, at most 4.
  No bytes for 10 min → cancelled, counted as a stall, next sharer. **Cancelled** by the user
  stops the upgrade instead of moving on.
- **checking**: size ÷ tag duration, the same estimate `libraryQuality` makes for the library
  copy, so both sides are measured alike. More than 20 % under the advertised rate, no better
  than the copy, or below the target → rejected: `upgrade` is removed from the tracked record
  (no Replace offer) but the file stays — the plugin deletes only fallback files.
- **ready** → toast with *Compare & replace* (`upgrade-replace-notice` opens `lastReadyUpgrade`)
  → `openReplace`. **replaced** is detected when the library row's path or size changes.
- The completion toast in `handleCompletions` stays quiet for `upgrade.auto` records; the
  engine announces after the check.
- **The user steers a pending upgrade** (owner, 2026-10-05: "it is queued and I can do
  nothing"). The panel offers *Cancel* while searching / downloading / checking
  (`cancelUpgrade` → state **cancelled**, transfer dropped in slskd, no ledger strike — it's
  the user's call, not the sharer's failure), *Try another sharer* (`skipUpgradeSource`, the next
  untried candidate without waiting out the stall timer) and a **Sources found** list
  (`upgradeSources` = the picks plus the alternative; row ids `t<id>#<index>`) where *Use this*
  (`useUpgradeSource`) downloads exactly that file — past the 4-sharer cap, and a pick below the
  target lowers it to `best` for this upgrade, as *Take the best found* does. The rows carry
  *Details* (points the panel at that upgrade), Replace / Take the best found / Search again
  when they apply, *Cancel* and Remove; *Try another sharer* and *Choose myself…* are on the
  panel only (UX review, 2026-10-06 — five verbs on a row is a row nobody reads).
- **Upgrade on a selection** (`multi-track` → `queueUpgrades`, 2026-10-06): one entry per
  local track, origin **`batch`**, at most `UPGRADE_BATCH_MAX` (100) per click; not-local,
  missing, and already busy **or ready** rows are skipped (a ready file is kept) and named in one
  notice (`batchUpgradeNote`; silent when nothing was skipped). Searches still run one at a time.
  A batch entry **never raises the Replace dialog by itself** — thirty dialogs at random over an
  hour would be thirty interruptions — it waits at Ready; *Replace all ready (N)…* on the
  Pending bar (or Replace on a selection) walks the host's compare dialogs in turn
  (`replaceAllReady`, *Stop after this one*). The pending list is selectable, so Cancel /
  Search again / Remove / Take the best found reach many rows at once.
- **History is folded.** The tab lists only pending upgrades; **replaced** / **gone** collapse
  into a "History · N finished" toolbar with *Show* / *Clear* (`showUpgradeHistory`, memory only).

## View layout (UX review, owner-approved 2026-10-06)

Each tab owns one job, and a setting lives next to what it controls:

- **Search** — search box; **recent searches** (`recentSearches`, storage, last 6 plain
  searches; modes aren't remembered) as buttons; a **results toolbar** (`resultsToolbar`:
  counts, Files / Folders as accent/secondary buttons on the old `result-mode` action, and
  "sorted by X · Best match" once a column re-sorted). Files / Folders used to be a second
  `tabs` node right under the main tabs; the owner had never noticed Folders existed. Don't
  bring the second tab bar back.
- **Format tiles** (`formatTile`, v0.15.0) are the thumbnail wherever the cover would be a
  guess: search rows, folder cards, upgrade sources, downloads not yet finished. Real covers
  stay on finished downloads, kept files and the Upgrades list. Folder cards carry who / tracks
  / size / slot-or-queue / sharer record (`folderSubtitle`); the format is on the tile.
- **Downloads** — grouped by `transferGroup`: Needs attention (failed, with *Retry all*) ·
  Downloading · Waiting · Finished (*Clear*, folded past 10) · Cancelled. Failures read in
  plain words (`plainTransferError`, raw text kept for anything unrecognised); waiting rows say
  for how long (`waitedFor`) and offer *Another source* when queued **remotely**. "Remove" is
  labelled **Clear from list** with ✕ — the bin icon is only for *Delete file*, which deletes.
- **Upgrades** — the *Upgrade to* select on top (moved from Settings); the panel shows the
  four steps (`upgradeStepper`), your copy beside the one on its way, *Cancel upgrade* last;
  Sources found is a selectable list so its columns render.
- **Fallback** — the whole feature: `stats-grid` (played N of M, median time to start, kept
  files, sharers), the last resolve as a summary with the step trace and candidates behind
  *Show trace*, **Recent** (`resolveHistory`, storage, last 50, one small record per resolve
  from `finishResolve`), **Kept files** (moved from Downloads; *Delete all…* goes through a
  `confirm` node), and the fallback's settings.
- **Settings** — `fixNodes` when not ready; when ready a **Status** checklist
  (`statusChecklist`: connected · sharing · downloads reach the library, each fix on its row),
  then the Connection card (unchanged, Roadie's card order still holds), slskd's web page,
  Downloads. The old Library and Sharing sections became checklist rows.

- **Row chips and bars** (host `track-row-list` `badge` / `progress`, hosts after 1.0.90; older
  hosts ignore them, so every subtitle still says the same thing in text). A chip only where rows of
  different states share a list — Upgrades (`upgradeBadge`), Sources found (Downloading / Tried /
  Below target), a kept file still downloading — or where a row is special in its group (an
  **Upgrade** chip on a download fetched as one). Never a "Downloading" chip under the Downloading
  group title. Bars only while bytes move (`transferRowProgress`), never a 0% bar for a queued file.

## slskd facts that bit

- One search at a time (`POST /api/v0/searches` answers 429 otherwise) — everything goes
  through `performSearch`'s promise chain. Poll counts only; fetch bodies once, after
  completion, retrying an empty first read (bodies land ~70 ms after the state flips).
- State strings are comma-joined flag enums (`"Completed, Succeeded"`); a bare
  `Completed` means failed. `transferPhase` is the one place they are read.
- Transfer records carry only the **remote** filename. The plugin picks its own
  `destination` per batch and finds the local file through the Files API, where
  `fullName` is relative to the directory asked for and `length` is **bytes** (seconds in
  search results).
- macOS app directory for slskd 0.26 on .NET 10 is `~/Library/Application Support/slskd`,
  not `~/.local/share/slskd` as slskd's README says. `slskd.yml` is created at first start
  from `config/slskd.example.yml` beside the binary, all comments.
- Advertised `hasFreeUploadSlot` and `uploadSpeed` are self-reported and were both wrong
  for the sharer that cost the first live run its budget. Never trust them alone.

## Testing

`npm test` = `node --test` (Node 24 in CI), no dependencies. `test/harness/sandbox.js`
loads the plugin; `test/harness/host.js` (`fakeHost`) is a scripted Viboplr + slskd: a path
map of responses plus a per-test `fetch(url, init)` override, recording every handler,
notification, view render and storage write. Pure helpers are exported with a `_` prefix
at the bottom of `index.js` — add one there when you add a pure function.

The fallback suite sleeps real time (polls are 1 s, the hedge 5 s), so it takes ~30 s.
Keep new timing tests short: pass a small `stallMs` to `_waitForTransfer`, script the
transfer to succeed on the second or third poll, and never wait on the 12 s stall.

## Live testing (owner's Mac)

The running app exposes a localhost **control API**; port and bearer token are in
`~/Library/Application Support/com.alex.viboplr/profiles/default/control-api.json`.
Useful calls (`Authorization: Bearer <token>`):

- `POST /v1/assistant/invoke {"pluginId":"slskd","tool":"status"|"search"|"download"|"list_downloads"|"upgrade"|"list_upgrades","args":{…}}`
- `POST /v1/search/plugin {"provider":"spotify-browse:spotify","query":…}` then
  `POST /v1/queue/play-search {"searchId":…,"indices":[0],"mode":"next"}` and
  `POST /v1/playback {"action":"next"}` — a metadata-only track that exercises the
  resolver chain without clearing the user's queue. Pick a song the library lacks
  (`GET /v1/search?q=…` must return nothing) or the Library resolver answers first.
- `GET /v1/logs/frontend` → `pluginLog` (every `api.log` line, incl. the fallback's
  `"fallback: … → …"` trace) and `resolverLog` (per resolver: input, ms, outcome).
- slskd itself: `X-API-Key` from the plugin's storage
  (`sqlite3 …/viboplr.db "select value from plugin_storage where plugin_id='slskd' and key='apiKey'"`),
  `GET /api/v0/transfers/downloads`, `GET /api/v0/options`.

The installed plugin is the released one, not this checkout — a code change needs a
release and an update from Viboplr's Extensions view before a live run reflects it.

**Without a reachable Soulseek network** (the owner's work Mac is behind a VPN that blocks
it): `npm run fake-slskd` (or, with no checkout, `npx github:outcast1000/viboplr-slskd` — the
`bin` in `package.json`, which is why that file carries a `version`) is a local slskd stand-in, either with deterministic generated
results and scenarios (`--scenario vpn-blocked`, `slow`, `peer-fails`, …) or replaying an
anonymised recording of a real slskd made off the VPN (`--record --upstream …`, then
`--replay DIR`). The plugin switches to it from Settings → **Test server** (`settings.debugServer`,
`debugUrl`). That section always exists: while a fake answers (`X-Fake-Slskd` header) or the
switch is on it sits above Connection with the switch; otherwise it sits at the bottom with the
command to start one. `detectDebugServer` tries the saved address and, when it is loopback,
ports 5039–5049 too (`debugCandidates`), saving the address it finds — also while the switch is
on and the fake stopped answering, so a restart on another port is followed. Recordings default
to `./recordings` in the **current** folder, since under npx the script lives in a package cache. Every request and readiness surface reads **`conn()`** — the effective
connection — never `settings.url` / `apiKey` / `insecure` directly; the per-server state
(`tracked`, `fallback`, `sharers`, `upgrades`, `resolveHistory`, `sharesWarned`) is stored
under **`stateKey(k)`** (`debug.` prefix on the test server), so the fake's transfer list can
never make the plugin forget a real download. New per-server state goes through `stateKey`
and is reset in `loadServerState`; new reads of the address go through `conn()`.
Code: `test/harness/fakeSlskd.js` (server) + `slskdRecording.js` (anonymiser, recorder,
replay); `test/fakeSlskd.test.js` drives the real plugin against it, record → replay
included. Usage and the anonymising rules: `docs/fake-slskd.md`. When the plugin starts
calling a new slskd endpoint, teach the fake to answer it too — its catch-all 404 names
the method and path it didn't recognise.

## Releasing

1. Add a `## <version>` section at the top of `CHANGELOG.md` (it becomes `update.json`'s
   changelog — the top section only).
2. Set `"version"` in `manifest.json` by hand. **Do not run `scripts/bump.sh`** — its
   `JSON.stringify(m, null, 2)` reflows the whole manifest.
3. `scripts/package.sh` to validate (zip must have `manifest.json` at the root).
4. Commit. **`git fetch`, push `main`, and only then push the tag `v<version>`, as separate
   pushes.** Another session may have released meanwhile; a tag pushed while `main` is
   rejected still triggers the Release workflow — once, on an older version than the live
   one, and the draft had to be cancelled and deleted by hand.
5. CI is the only publisher (`gh release create` by hand makes the workflow fail on the
   duplicate tag). Verify with `gh run watch`, `gh release list`, and
   `curl -sL …/releases/latest/download/update.json`.

`docs/` is GitHub Pages from `main`; a docs-only change needs a push, not a release.
The gallery (`outcast1000/viboplr-plugins`) is index-only and backfills version /
`minAppVersion` from the live `update.json` — nothing to do there.

## Conventions

- Every `catch` logs with `console.error` and context; an intentionally empty catch says why.
- Anything that hits the network or takes longer than half a second shows feedback; long
  waits show *what* they are waiting for (queue position, speed, ETA), not a spinner.
- Comments explain **why**, especially where a measured failure shaped the code — the
  next reader should not have to re-learn it on the live network.
- Keep `KEY_SEP` as the `"\u0000"` escape; a literal NUL once made the file binary to grep.
