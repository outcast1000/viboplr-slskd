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
| Sidebar view `slskd-browse` | Search / Downloads / Fallback tabs | `render()` |
| Settings panel `slskd-settings` | Settings → Soulseek | `renderSettings()` |
| Stream resolver `slskd-fallback` | `api.playback.onStreamResolve` | the **playback fallback**, see below |
| URI scheme `slsk://` | `api.playback.onResolveStreamByUri` | plays a finished download |
| Download provider `slskd-import` | `api.downloads.onResolveByUri` | "Add to library…" via the host modal |
| Context menu `slskd-search` | track / album / artist | "Search on Soulseek…" |
| Assistant tools | `status`, `search`, `download`, `list_downloads` | for the host's control API / MCP |

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
  quality per the *Fallback quality* setting → speed → queue → size.
- The **sharer ledger** (`sharers`, per username: delivered / failed / stalled) is fed by
  every download the plugin watches and is a ranking key in the Search tab too. Two
  observers see each transfer (the poll and the race); `ledgerSeen` claim/counted marks
  keep an outcome from being counted twice or re-counted after a restart.
- Audio only (declines `opts.preferVideo`); needs slskd on this computer (`tier === "local"`).
- Delete of kept files: slskd Files API `DELETE /api/v0/files/downloads/directories/{b64}`,
  gated by slskd's **top-level** `remote_file_management: true` (not under `flags:`;
  hot-reloaded). A 403 is explained to the user, never swallowed.

Owner decisions that must hold:

- **The user owns slskd.** The host never installs, launches, supervises or configures a
  third-party daemon; the plugin gives guided instructions (the GitHub Pages setup guide in
  `docs/`) and detects state. A host-managed slskd sidecar was built and rejected.
- **No metadata-based download provider.** A download the user asks for by hand gets a
  file they picked, not the fallback's best guess.
- The plugin deletes only files the **fallback** fetched, and only when asked. The
  Downloads tab's "Remove" drops slskd's row and leaves the file.
- Nothing installs itself; a successful operation announces nothing; failures stay visible.

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

- `POST /v1/assistant/invoke {"pluginId":"slskd","tool":"status"|"search"|"download"|"list_downloads","args":{…}}`
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
