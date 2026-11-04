# Contributing

Thanks for helping improve LocalTube. Bug reports, thoughtful feature requests, and pull requests are welcome.

## Before opening a pull request

- Keep the app dependency-free and usable by opening `index.html` directly.
- Preserve the local-only media model: never upload video files or persist blob URLs. Selected file data may be retained in IndexedDB for same-tab refresh recovery, but clear it when the app is opened in a new navigation; never claim that the original folder picker permission itself survives.
- Keep unsupported videos visible and report preview or playback errors clearly.
- Run `node --check app.js` and manually test the affected flow in Chrome, Firefox, and Safari when available.
- Keep comments focused on intent, lifecycle constraints, and non-obvious heuristics; update the README when architecture or user-visible behavior changes.

For changes to video handling, test with a browser-decodable video as well as an unsupported format. Check writable folder selection and automatic sidecar saving where supported, the folder/multiple-file fallback, midpoint default and user-selected thumbnails, title changes, named segment playback, metadata import/export, playback, subtitles, playlists and queue controls, Watch later, saved progress, and library restoration after refresh when those flows are affected. Process only cards near the viewport, one video at a time, and release media sources when processing or previews finish.

## Release checks

Before tagging a GitHub release, verify the README and license, run the syntax check, and smoke-test the app in current Chrome, Firefox, and Safari when available. Confirm that the release contains only the static app files and documentation; no build or package installation is required.
