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

## Publishing a GitHub release

The `Release Windows` workflow runs when a version tag such as `v1.2.0` is pushed. It installs the pinned npm dependencies, builds the Windows NSIS installer and portable executable, and publishes both files to a GitHub release with generated release notes.

1. Update the version in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`.
2. Run `npm ci`, `node --check app.js`, `npm run build`, and `npm run build:windows` from an x64 Visual Studio Developer Command Prompt.
3. Confirm that `release/LocalTube_1.2.0_x64-setup.exe` and `release/LocalTube-Portable.exe` exist and launch as expected.
4. Commit the version change, push `main`, and push the matching tag:

   ```powershell
   git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json CONTRIBUTING.md .github/workflows/release.yml
   git commit -m "release: v1.2.0"
   git push origin main
   git tag -a v1.2.0 -m "Release v1.2.0"
   git push origin v1.2.0
   ```

5. Watch the `Release Windows` workflow and verify the release assets and generated notes on GitHub. Do not reuse a tag: correct the source, create a new tag, and delete the failed release only if necessary.
