# Changelog

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
