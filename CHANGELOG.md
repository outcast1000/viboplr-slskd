# Changelog

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
