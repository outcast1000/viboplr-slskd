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

## Surfaces this plugin registers (manifest `contributes`)

| Surface | Where | Notes |
|---|---|---|
| Sidebar view `slskd-browse` | Search / Downloads / Upgrades / Fallback / Settings tabs | `render()`; one job per tab (see *View layout*) |
| Settings tab | last tab of `slskd-browse` (no host settings panel) | `settingsTab()`: Status checklist + Connection + Downloads; `renderSettings()` also redraws Upgrades / Fallback, which hold their own settings |
| Stream resolver `slskd-fallback` | `api.playback.onStreamResolve` | the **playback fallback**, see below |
| URI scheme `slsk://` | `api.playback.onResolveStreamByUri` | plays a finished download |
| Download provider `slskd-import` | `api.downloads.onResolveByUri` | "Add to library…" via the host modal |
| Context menu `slskd-search` | track / album / artist | "Search…" (shown as "Soulseek: Search…") |
| Context menu `slskd-upgrade` | track, multi-track | "Upgrade" (shown as "Soulseek: Upgrade") — **automatic**: `queueUpgrade` adds an entry to the Upgrades tab, which finds, downloads and checks a better copy (see *Automatic upgrades* below); "Choose the source myself (N)" (`upgrade-sources-toggle`, per-entry `sourcesOpen`) unfolds the entry's own sources; only an entry at rest with **no** sources offers "Search Soulseek myself…", the old interactive search (`startUpgrade`, filtered by `isUpgradeOver`). Both stamp the download `upgrade: { trackId }`, and "Compare & replace…" / the Downloads row's "Replace in library…" hand the host modal `libraryTrackId` |
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
  the plugin, *Try again*) plus *Fix…*, which opens the Settings tab where `fixNodes` puts the full
  explanation above the Connection card. The first run (`unconfigured`) and the hub's own pages
  stay full-page (`wantsSetupScreen`). The sidebar dot (`badgeFor`) is the only signal outside the
  view. Do not bring back a readiness `showNotification`, at launch or on a state change.
- **The host view header carries the status word, the banner carries the fix.** `viewHeaderFor`
  (pure) → `pushViewHeader`, called at the top of `render()` and change-gated on the JSON, since
  `render()` runs on every poll tick and each `api.ui.setViewHeader` re-renders the host. It is
  feature-detected (older hosts have no header), so it needs no `minAppVersion` bump; the manifest's
  `viewHeader.subtitle` is the fallback before the first render. Keep the header to state + where
  slskd is + *Open slskd*; a fix button belongs in `readinessBanner`, not in the header.
- **Find slskd first; installing is only for when none is found** (owner, 2026-09-29). The
  first run looks for a slskd already running here (`discoverSlskd`: `GET /api/v0/session/enabled`
  on 127.0.0.1:5030–5040 and https:5031, which slskd answers without a key with `true`/`false`)
  before offering anything else. Found: the plugin's own key is tried, then the user is asked for
  one of slskd's keys (`discoveryNodes`). The whole setup must work without installing anything.
- **Installing slskd is ONE option, never required** (owner, 2026-10-19 — Roadie removed from
  Viboplr). The user can install slskd themselves (the GitHub Pages guide in `docs/`) or run it
  anywhere and just configure the plugin. *Install automatically* is **Viboplr installing slskd as
  one of its own tools** (0.26.0, Viboplr 1.0.113+; owner plan 2026-10-20, "one host update flow"):
  - **The manifest defines the tool**: `binaryDependencies: [{ name: "slskd", required: false,
    definition }]` — a folder tool (`layout: "folder"`, `entry: "slskd"`) from `slskd/slskd`'s
    GitHub releases, arch-specific asset templates, `checksum: { github: true }` (GitHub's recorded
    sha256 — slskd publishes no checksums file), `probeEnv` for .NET's extraction folder. **Keep it
    byte-identical to the host's fixture** (`src-tauri/tests/fixtures/plugin-dependencies/slskd.json`
    in the app repo): the host's tests validate and fingerprint that entry, and a changed source
    reads as "came from another source" (Reinstall) for every installed copy. **No version, no
    pins**: the host follows `releases/latest`, announces updates in its update notice and
    Extensions → Tools, and installs them only on the user's click — stopping slskd (SIGTERM),
    swapping `{bin}/slskd/`, and starting it again with the stored registration. The plugin has
    **no update code**; don't add one back.
  - **Install** = `api.ui.requestAction("require-dependency", { name: "slskd" })` (Viboplr's own
    "slskd is needed … It works without it" dialog), then `ensureHostTool` polls
    `api.system.getDependency("slskd")` every `TOOL_POLL_MS` (3s) for up to `TOOL_WAIT_MS` (5 min)
    until it is `installed` with `origin: "managed"`. The host says nothing when its dialog closes,
    so a dialog turned down is the wait running out ("slskd wasn't installed"); the checklist's
    first step has **Cancel**. A slskd on PATH (`origin: "system"`) is the user's: never started,
    the step says to connect to it.
  - **Running** it: `programs.start("slskd", { dependency: "slskd", args, env, outliveApp })`
    (`managedStartSpec`; the host resolves Viboplr's copy, `cwd` defaults to the plugin's store).
    The first start asks "Run slskd in the background?" (host `DependencyRunConfirm`, once per
    source); "Don't allow" rejects with `"Run declined"` → `managedFailure` → back to the form, and
    the half-made record is dropped.
  - Everything else is slskd-specific and stays here: `renderSlskdYml` writes the config once (web
    on 127.0.0.1, a **random** web sign-in kept in the `managedSlskd` storage record, the plugin's
    API key with a loopback CIDR, `remote_configuration` and `remote_file_management` on, partial
    downloads inside the plugin's store), and `stopManagedProcess` stops it gracefully (JWT from that
    web login → `DELETE /api/v0/application`) before the host's signal.
  - **The record**: `{ source: "host", port, webUsername, webPassword, downloadsDir, installedAt }`.
    The version is the host's (`managed.dep.version`), shown on the card's Version row.
  - **Legacy store copies** (plugin ≤ 0.25.0 downloaded slskd into `slskd/<version>/` itself; the
    record has `version` + `asset`, no `source`) keep starting from the store by `path`. The card
    shows **Move slskd to Viboplr's copy** (`managedVersionRows` → `moveManaged`): install via the
    host as above, stop the old copy, rewrite the record to `source: "host"`, start by `dependency`
    with the same `slskd.yml` and data, then delete `slskd/<old>/`. If the new copy won't start, the
    legacy record comes back and the old copy starts again; nothing is deleted. A legacy copy gets
    no updates until it moves.
  - **Downloads folder**: starts as `<Downloads>/Soulseek` (`api.system.userFolders`,
    `prefillDownloadsDir`), so the form needs no picking; *Change…* opens the picker on the current
    one. The row says whether finished files reach the library (`downloadsFolderText`: only inside
    a local collection) — never "pick a folder inside one of your collections" as the instruction,
    which on a profile without one points at nothing. slskd is given the path in `slskd.yml`; the
    plugin can't create folders outside its store.
  - **Permission:** `programs:run` is in the manifest's **`optionalPermissions`**, so a user who runs
    their own slskd is never asked. The host asks the first time a start needs it (and warns for an
    unsigned copy).
  - **Lifetime:** slskd keeps running after Viboplr quits (`outliveApp`, off only via the card's
    *Keep slskd running when Viboplr quits* → `settings.stopWithViboplr`, applied at the next start)
    and the plugin starts it on activation when the host knows it (`registered`) and it isn't
    running (`shouldStartWithViboplr`, `settings.startWithViboplr`, on by default, the install
    form's and the card's switch). With *Keep running* off, Viboplr's quit asks the plugin first
    (`api.system.programs.onAppQuitting` → `stopManagedProcess`), and the host stops whatever is
    left after its wait. The host has **no login items**; a user who wants slskd without Viboplr adds
    it to the OS themselves. Uninstalling the plugin makes the host stop it.
  - `managedBy: "plugin"` + the `managedSlskd` record mark the connection as this plugin's slskd;
    `usesManaged` is the one test. A typed address/key clears it. A stored `"roadie"` from older
    versions is cleared at load (the address stays, it is just a slskd now).
  - The **"slskd on this computer" card** (`managedConnectionSection`): address + Test, Version (or
    Move for a legacy copy), start with Viboplr, keep running, **Sharing**, files (folded; the
    settings file is only revealed — it holds the Soulseek password), connection details (folded),
    Remove last (stop → `programs.remove` → delete `slskd/` and `logs/`; downloads and shares
    untouched; Viboplr's copy of the program stays in Extensions → Tools).
  - **Sharing** more folders goes through slskd's own settings API (`shareThroughSlskd`: admin JWT,
    `yamlWithShares`, slskd validates, then `PUT /api/v0/shares`), after a confirm on the card,
    because the folders become public. The gap is measured against what slskd reports (`shareGap`).
  - Sign-in reasons come from slskd's `GET /api/v0/logs`, falling back to the output the host
    captured (`logs/slskd.log` in the plugin's store, `managedLogLines`). A **kick** ("another client
    logged in using the same username") is final until slskd restarts — the card and banner offer
    *Restart slskd*.
  - `managedCapable` needs `api.system.programs`, `api.system.getDependency`, `api.ui.pickFolder`
    and `api.ui.requestAction`; *Install automatically* also needs slskd's definition in force
    (`canInstallHere`: `getDependency` answers non-null). `minAppVersion` is **1.0.113**, the first
    host with folder tools, `checksum.github`, `start({ dependency })`, `onAppQuitting` and
    `userFolders` — not a `1.0.112-beta.N`: the host's `semverSatisfies` drops the pre-release
    part, so a beta minimum would admit 1.0.112-beta.3, which has none of them.
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
  at the target but a better copy exists → **alternative** (chip *Better copy found*, panel button
  *Take <quality>*). **none** means nothing beats your copy at any target, so it offers no
  "try a lower target".
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
  the user's call, not the sharer's failure), *Try another source* (`skipUpgradeSource`, the next
  untried candidate without waiting out the stall timer) and a **Sources found** list
  (`upgradeSources` = the picks plus the alternative; row ids `t<id>#<index>`) where *Use this*
  (`useUpgradeSource`) downloads exactly that file — past the 4-sharer cap, and a pick below the
  target lowers it to `best` for this upgrade, as taking the alternative does. The rows carry
  *Details* (points the panel at that upgrade), Replace / Take the better copy / Search again
  when they apply, *Cancel* and Remove; *Try another source* and the sources toggle are on the
  panel only (UX review, 2026-10-06 — five verbs on a row is a row nobody reads). The sources
  list is folded by default (UX pass, 2026-10-11): choosing a source by hand stays inside the
  entry instead of detouring through a filtered search and the Downloads tab.
- **Upgrade on a selection** (`multi-track` → `queueUpgrades`, 2026-10-06): one entry per
  local track, origin **`batch`**, at most `UPGRADE_BATCH_MAX` (100) per click; not-local,
  missing, and already busy **or ready** rows are skipped (a ready file is kept) and named in one
  notice (`batchUpgradeNote`; silent when nothing was skipped). Searches still run one at a time.
  A batch entry **never raises the Replace dialog by itself** — thirty dialogs at random over an
  hour would be thirty interruptions — it waits at Ready; *Replace all ready (N)…* on the
  Needs you bar (shown from **one** ready entry, owner 2026-10-28; or Replace on a selection) walks
  the host's compare dialogs in turn (`replaceAllReady`, *Stop after this one*). Every group's list
  is selectable, so its actions reach many rows at once.
- **Grouped, not one "Pending" list** (UX pass, owner-approved 2026-10-28, from a mockup):
  `upgradeGroup` → **Needs you** (ready, alternative; *Replace all ready*) · **In progress**
  (searching, downloading, checking) · **Didn't work out** (none, failed, cancelled; *Search all
  again* `upgrade-retry-ended`, *Clear* `upgrade-clear-ended`) · History (folded: *Show* / *Clear*,
  `showUpgradeHistory`, memory only). Each list declares its own actions (`UPGRADE_LIST_ACTIONS`).
  The tab count (`upgradesTabCount`) is what needs you, else what runs.
- **A queued search says it is waiting.** slskd runs one search at a time, so a batch's entries
  queue: `upgradeSearchQueue` (running one = `upgradeSearchKey`, then key order, which is the order
  `advanceUpgradesNow` starts them) gives each its place → "Waiting to search · N ahead", chip
  *Up next* / *Waiting*. Thirty rows all saying *Searching* read as stuck.
- **The panel** is titled by state (`upgradeBadge` label, never a fixed "Upgrading"), ends with
  *Close* (`upgrade-panel-close` → `focusedUpgrade = false`; Details or a new upgrade opens it), and
  its row in the list says "Shown above" with no Details. Downloads show "about N left"
  (`transferEta`) and a remote queue how long it has waited (`waitedFor`).

## View layout (UX review, owner-approved 2026-10-06)

Each tab owns one job, and a setting lives next to what it controls:

- **Search** — search box; **recent searches** (`recentSearches`, storage, last 6 plain
  searches; modes aren't remembered) as buttons; a **results toolbar** (`resultsToolbar`:
  counts, Files / Folders as accent/secondary buttons on the old `result-mode` action, and
  "sorted by X · Best match" once a column re-sorted). Files / Folders used to be a second
  `tabs` node right under the main tabs; the owner had never noticed Folders existed. Don't
  bring the second tab bar back.
- **Format tiles** (`formatTile`, v0.15.0) are the thumbnail wherever the cover would be a
  guess: folder rows, an open folder's files, upgrade sources, downloads not yet finished. Real
  covers stay on finished downloads, kept files and the Upgrades list. **Not on Files rows**
  (owner, 2026-10-18): the Quality column says the same, and 1,000 tiles at ~620 bytes made
  every re-render a ~1 MB worker→host payload, the main cause of lag on a big result list.
- **Folders is a table, not a card grid** (owner, 2026-10-18): a card is built around a cover a
  folder doesn't have, its facts were one truncated line, and nothing could be sorted. It's a
  `track-row-list` (`folderRows`) with `FOLDER_LIST_COLUMNS` (Quality via `folderQualityLabel` ·
  Tracks · Size · Availability), its own sort (`search.folderSortColumn`, `sort-folders`,
  `FOLDER_SORTS`; *Best match* resets whichever list is showing), `selectionMode: "single"`
  (columns and hover buttons need `selectable`; single drops the bulk toolbar),
  `openOnClick: "title"` and `contextMenu: false` (a folder isn't a track). Subtitle = sharer
  (in Fill: what the album lacks). Hover actions: `folder-row-download` (`folderRowFiles` — all,
  or in Fill the missing ones, minus anything queued) then `open-folder`. The row chip
  (`folderRowStatus`) says how far the folder got. `folderSubtitle` is now only the open
  folder's toolbar line.
- **Add to library** (owner, 2026-10-18): one action, `IMPORT_ACTION` (♫ — never ＋, the host's
  Enqueue glyph), on finished Downloads rows, Done search / open-folder rows (`rowTransferStatus`)
  and the Finished toolbar's *Add all N to library…*. The handler reads `transferKeys`, so `f:` /
  `o:` ids and mixed selections work; `openImport` skips anything not finished. It sends
  `purpose: "import"` with `download-tracks` so the host modal says Add, not Download (hosts
  before that ignore it). `fetchTransfers` sorts newest first (`transferTime`: ended → started
  → enqueued → requested), so every group reads that way.
- **Downloads** — grouped by `transferGroup`: Needs attention (failed, with *Retry all*) ·
  Downloading · Waiting · Finished (*Clear*, folded past 10) · Cancelled. Failures read in
  plain words (`plainTransferError`, raw text kept for anything unrecognised); waiting rows say
  for how long (`waitedFor`) and offer *Another source* when queued **remotely**. "Remove" is
  labelled **Clear from list** with ✕ — the bin icon is only for *Delete file*, which deletes.
- **Upgrades** — the *Upgrade to* select on top (moved from Settings); the panel shows the
  four steps (`upgradeStepper`), your copy beside the one on its way, *Cancel upgrade* then
  *Close* last; Sources found is a selectable list so its columns render.
- **Fallback** — the whole feature: `stats-grid` (played N of M, median time to start, kept
  files, sharers), the last resolve as a summary with the step trace and candidates behind
  *Show trace*, **Recent** (`resolveHistory`, storage, last 50, one small record per resolve
  from `finishResolve`), **Kept files** (moved from Downloads; *Delete all…* goes through a
  `confirm` node), and the fallback's settings.
- **Settings** — `fixNodes` when not ready; when ready a **Status** checklist
  (`statusChecklist`: connected · sharing · downloads reach the library, each fix on its row),
  then the Connection card (the installed slskd's card when it is this plugin's), slskd's web page,
  Downloads. The old Library and Sharing sections became checklist rows.

- **Row chips and bars** (host `track-row-list` `badge` / `progress`, hosts after 1.0.90; older
  hosts ignore them, so every subtitle still says the same thing in text). A chip only where rows of
  different states share a list — Upgrades (`upgradeBadge`), Sources found (Downloading / Tried /
  Below target), a kept file still downloading — or where a row is special in its group (an
  **Upgrade** chip on a download fetched as one). Never a "Downloading" chip under the Downloading
  group title. Bars only while bytes move (`transferRowProgress`), never a 0% bar for a queued file.

### UX pass (owner-approved 2026-10-11)

Priorities, in the owner's words: search for new files, upgrade existing files, transparency on
the fallback; download history matters less. Each rule replaced a complaint:

- **A download never moves the view and never toasts** (`enqueueFiles`). The row it came from
  shows its state instead (`rowTransferStatus`: Queued · #n → Downloading n% with a bar → Done
  with Play / Failed with Retry; a cancelled one is a result again, with Download). The row's
  `actions` follow the state, so a queued file can't be queued twice (`notYetQueued` also filters
  selections). Only a refusal toasts — no row will ever change for it. A just-queued file counts
  as Queued for `JUST_QUEUED_MS` before slskd's list first carries it (`rec.queuedAt`).
- **Review fixes (2026-10-11)**: a finished file with `rec.upgrade` offers `replace-transfer`
  first on its search row — staying put lost the route to Replace the Downloads tab had.
  Selections sweep in rows an action doesn't fit, so handlers filter: Retry `retryableKey`
  (failed / cancelled, or forgotten by slskd), Cancel `cancellablePhase`, Replace finished
  located files only. Rows expose `phase` (`rowPhase`): a **failed** file is free again
  (`notYetQueued`). Recent row ids are `historyRowId` (time + title), never a list position.
  `fallbackLastUsedAt` (storage) outlives Clear. A merge never follows a play that played.
- **Transfer actions on search rows**: rows are `f:<key>` (Files) or `o:<key>` (open folder);
  Play / Retry / Cancel read ids through `transferKeys`, which strips the prefix only when the
  raw id isn't itself a known key (a username may begin with "f:").
- **A folder row's name opens the folder** (`open-folder` → `folderView`); a click never queues —
  only the row's labelled *Download folder* hover button does. Inside: the
  tracklist (sorted by file name, no column sort), songs the library has marked *In library*
  (Fill: from its mode; a plain search: one `libraryRowByName` per file, at most
  `FOLDER_OWNED_LOOKUPS_MAX`, once per folder), and `folder-download` with `which: "missing"`
  or `"all"`. `fill-folder` / `download-folder` are gone. *Search…* on an album opens on
  Folders (`extra.folders`).
- **Two host facts the live test turned up** (2026-10-11): the host draws *every* declared list
  action in the selection bar (greyed until something is selected), so lists declare only what
  some row offers (`declaredActions`) — declaring all four put Play / Retry / Cancel over a fresh
  search. And only a **`selectable`** track-row-list draws a row's hover actions; a plain list
  shows none, which is why Recent (fallback) is selectable.
- **Tab order**: Search · Upgrades · Fallback · Downloads · Settings. The Downloads count is
  `liveTransferCount` (attention + active + waiting) — counting finished files kept it lit forever.
- **Upgrades**: Sources found is folded behind *Choose the source myself (N)*. The *Upgrade to*
  row went to the foot of the tab here and came back to the **top** on 2026-10-28: an MP3 library
  left at the FLAC default read "Nothing better" everywhere with the reason below the fold. Its
  description says new upgrades use it and running ones keep theirs.
- **Fallback**: the top line is `fallbackStatusNode` — the plugin can't see whether the user
  switched it on or where it sits in the order (the host doesn't say), so it reports its own
  history and names where the switch lives. Recent resolves are track rows (`historyRows`) with
  an outcome chip; a miss offers *Search Soulseek for it* (`fallback-search`). While a resolve
  runs the sidebar item carries an accent dot (`sidebarBadge`; a readiness problem wins).
  What it can't do without the host: say anything in the **player bar**, which reads
  "Loading..." through the whole resolve. That needs a host API (resolver status text) — not
  built, owner's call.

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
