# LocalTube

A private, local video library that runs in your browser. Browse a folder of videos, search and sort your library, preview frames, and keep watching progress on your device. Your videos are never uploaded.

## Get started

1. Download or clone this repository.
2. Open `index.html` in a recent version of Chrome, Edge, Firefox, or Safari.
3. Choose a video folder.

Folder selection uses the browser's directory picker. Current Chrome, Edge, Firefox, and Safari support it. If a browser does not provide folder selection, choose multiple video files instead. LocalTube saves the selected video files in this browser so the library survives a page refresh. You do not need to keep the original folder picker open.

## Features

- Search by video name or folder path; sort by name, recently added, duration, or file size.
- Generate a lightweight thumbnail from a frame around 5–7.5 seconds in (or halfway through shorter videos) and hover over it to preview frames.
- Continue playback from locally saved progress; keep a Watch later list.
- Create playlists, add videos, skip through a queue, and shuffle playback.
- Load local WebVTT or SubRip subtitles; show duration, resolution, format, size, path, and modified date.
- Seek with frame and time previews, adjust volume and playback speed, and use full-width theater or fullscreen mode.
- Keep unsupported video formats visible and show when the browser cannot preview or play them.
- Use a custom SVG icon set without external assets, fonts, services, or build tools.

## Browser support and privacy

LocalTube is a static web app with no install step, build step, or third-party dependencies. It is designed for current Chrome, Edge, Firefox, and Safari, as well as other modern browsers. Browsers without folder selection can still load multiple video files at once.

Video playback and thumbnail generation depend on the browser's built-in codec support. A video may appear in the library even if that browser cannot preview or play its format; codec availability varies by browser, operating system, and file.

Selected video files are stored in this browser's IndexedDB database, while watch progress, Watch later choices, and playlists use local storage. Everything stays on this device and is never uploaded. The browser's storage quota may limit how much video can be retained; LocalTube reports when saving fails. Use **Forget library** to remove the saved video files, playlists, and watch history, or clear this site's browser data. Temporary playback and subtitle URLs are not persisted.

## Keyboard shortcuts

While the player is open:

| Key | Action |
| --- | --- |
| **Space** or **K** | Play or pause |
| **←** / **→** | Seek 5 seconds |
| **↑** / **↓** | Adjust volume |
| **M** | Mute or unmute |
| **T** | Toggle theater mode |
| **F** | Toggle fullscreen |
| **Esc** | Return to the library |

## Project files

- `index.html` — app structure and inline SVG icon sprite
- `styles.css` — layout, themes, and responsive styling
- `app.js` — library, local media previews, and playback behavior

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development and release checks. LocalTube has no build step; to check the JavaScript syntax, run `node --check app.js`.

## License

LocalTube is released under the [MIT License](LICENSE).
