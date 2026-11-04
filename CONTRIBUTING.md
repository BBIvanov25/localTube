# Contributing

Thanks for helping improve LocalTube. Bug reports, thoughtful feature requests, and pull requests are welcome.

## Windows desktop setup

Install Node.js, the stable Rust MSVC toolchain, and Visual Studio Build Tools with the **Desktop development with C++** workload (including the Windows SDK). From an x64 Visual Studio Developer Command Prompt, run `npm ci` and `npm run build:windows` in the repository root. The command creates the NSIS installer and portable executable in `release/`.

## Before opening a pull request

- Keep the browser edition dependency-free and usable by opening `index.html` directly. Desktop builds use Tauri, Node.js/npm, Rust, and the Windows MSVC build tools.
- Preserve the local-only media model: never upload video files or persist blob URLs. Selected file data may be retained in IndexedDB for same-tab refresh recovery, but clear it when the app is opened in a new navigation; never claim that the original folder picker permission itself survives.
- Keep unsupported videos visible and report preview or playback errors clearly.
- Run `node --check app.js` and `npm run build`; manually test browser flows in Chrome, Firefox, and Safari when available, and desktop flows in the Windows Tauri app when available.
- Keep comments focused on intent, lifecycle constraints, and non-obvious heuristics; update the README when architecture or user-visible behavior changes.

For changes to video handling, test with a browser-decodable video as well as an unsupported format. Check writable folder selection and automatic sidecar saving where supported, the folder/multiple-file fallback, midpoint default and user-selected thumbnails, title changes, named segment playback, metadata import/export, playback, subtitles, playlists and queue controls, Watch later, saved progress, and library restoration after refresh when those flows are affected. Process only cards near the viewport, one video at a time, and release media sources when processing or previews finish.

## Release checks

Before tagging a GitHub release, verify the README and license, run the syntax check and frontend build, and smoke-test the app in current Chrome, Firefox, and Safari when available. On Windows, run `npm run build:windows` and verify that `release/` contains the NSIS installer and portable executable. Test the installer with and without WebView2 installed where practical; the portable executable requires the WebView2 Runtime.
