---
description: Preserve local-file privacy and lifecycle behavior when changing LocalTube's browser video handling.
applyTo: '{app.js,index.html}'
---

# Local video handling

- Browser playback and thumbnail decoding depend on the actual codecs supported by the browser, not just the filename extension or `File.type`. Keep unsupported files visible in the library and show an explicit preview or playback error instead of silently dropping them.
- Treat `URL.createObjectURL()` results and media elements as temporary resources: revoke object URLs when replacing the selected folder or unloading, and invalidate asynchronous thumbnail/preview callbacks when their source files are replaced.
- Folder-picker file access does not survive closing the page. Persist user preferences and playback positions only; do not persist blob URLs as if they were reusable file access, and let users know they must select the folder again.
- Verify media flows with a genuinely encoded, browser-decodable fixture. A file containing arbitrary bytes but named `.mp4`/`.webm` only tests the unsupported-format path, not successful decoding or thumbnail generation.
