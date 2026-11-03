# LocalTube

A private, local video library that runs in your browser. Browse a folder of videos, search and sort your library, preview frames, and keep watching progress on your device. Your videos are never uploaded.

## Get started

1. Download or clone this repository.
2. Open `index.html` in a recent version of Chrome or Edge.
3. Choose a video folder.

Folder selection uses the browser's `webkitdirectory` file picker. The browser does not retain access to a selected folder after the page closes, so select it again the next time you use LocalTube.

## Features

- Search by video name or folder path; sort by name, recently added, duration, or file size.
- Generate local thumbnails and hover over a thumbnail to preview frames.
- Continue playback from locally saved progress; keep a Watch later list.
- Seek with frame and time previews, adjust volume and playback speed, and use theater or fullscreen mode.
- Keep unsupported video formats visible and show when the browser cannot preview or play them.
- Use a custom SVG icon set without external assets, fonts, services, or build tools.

## Browser support and privacy

LocalTube is a static web app with no install step, server, or third-party dependencies. Recent Chromium-based browsers are recommended. Folder selection requires a browser that supports `webkitdirectory`; playback and thumbnail generation depend on that browser's supported codecs, so compatibility can vary by browser and video format.

Video files are read locally by the browser. Watch progress and Watch later choices are stored in that browser's local storage; video data, folder access, and temporary preview URLs are not saved there. Clearing browser data removes saved progress.

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
