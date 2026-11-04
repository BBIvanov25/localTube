---
description: Preserve local-file privacy and lifecycle behavior when changing LocalTube's browser video handling.
applyTo: '{app.js,index.html}'
---

# Local video handling

- Browser playback and thumbnail decoding depend on the actual codecs supported by the browser, not just the filename extension or `File.type`. Keep unsupported files visible in the library and show an explicit preview or playback error instead of silently dropping them.
- Load and display duration and resolution as soon as media metadata is available; do not wait for midpoint seeking or thumbnail capture to finish. Generate default thumbnails from around the midpoint only for cards near the viewport, one video at a time. Prefer user-selected thumbnails, cache generated thumbnails and file details, and release the media source immediately after metadata or frame capture.
- Treat `URL.createObjectURL()` results and media elements as temporary resources: revoke object URLs when replacing the selected folder or unloading, and invalidate asynchronous thumbnail/preview callbacks when their source files are replaced.
- Folder-picker access itself does not survive closing the page. LocalTube may retain selected `File`/`Blob` data in IndexedDB so the library can be restored after a same-tab refresh, but must clear that temporary cache when the app is opened in a new navigation. Never persist object URLs, which are temporary and must be recreated. Surface storage-quota failures, and provide a clear way to remove retained media. Clearing browser data removes the retained library.
- Verify media flows with a genuinely encoded, browser-decodable fixture. A file containing arbitrary bytes but named `.mp4`/`.webm` only tests the unsupported-format path, not successful decoding or thumbnail generation.
