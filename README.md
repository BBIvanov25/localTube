# LocalTube

A private, local video library that runs in your browser. Browse a folder of videos, search and sort your library, preview frames, and keep watching progress on your device. Your videos are never uploaded.

## Get started

1. Download or clone this repository.
2. Open `index.html` in a recent version of Chrome, Edge, Firefox, or Safari.
3. Choose a video folder.

Folder selection uses the browser's directory picker. Current Chrome, Edge, Firefox, and Safari support it. If a browser does not provide folder selection, choose multiple video files instead. LocalTube saves the selected video files in this browser so the library survives a page refresh. You do not need to keep the original folder picker open.

## Features

- Search by video name or folder path; sort by name, recently added, duration, or file size.
- Generate a lightweight thumbnail from a frame around 5–7.5 seconds in (or halfway through shorter videos); if that frame is mostly one color, check a frame 5 seconds later for a better thumbnail. Hover over thumbnails to preview frames.
- Continue playback from locally saved progress; keep a Watch later list.
- Create named, playable time segments, customize display titles, and choose a frame for each thumbnail without changing the source videos.
- Keep video metadata in this browser and import/export a `localtube-metadata.json` sidecar for backups or use with another browser/device.
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

- `index.html` — semantic app structure, accessible controls, and inline SVG icon sprite
- `styles.css` — design tokens, library/player layouts, and responsive breakpoints
- `app.js` — application state, persistence, rendering, previews, playlists, and playback
- `CONTRIBUTING.md` — local development and release checks

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development and release checks. LocalTube has no build step; to check the JavaScript syntax, run `node --check app.js`.

## Codebase guide

The app is a dependency-free page: `index.html` supplies the DOM, `styles.css` styles it, and `app.js` wires browser APIs and user interactions. Keep IDs used by `byId()` in sync with the HTML when adding or renaming controls. The app script is loaded at the end of the body so those DOM elements exist before it initializes.

### Main JavaScript areas

- **State and persistence:** small watch-progress and playlist records use `localStorage`; selected video `Blob` data uses IndexedDB.
- **Library lifecycle:** imported files are normalized into video records with temporary object URLs. Replacing the selection or unloading the page revokes those URLs.
- **Library and playlists:** filtering, sorting, cards, playlist membership, and the play queue are managed in memory and rendered into the HTML containers.
- **Thumbnails and previews:** a reusable, muted video element generates thumbnails sequentially. Cards also create temporary video elements for hover previews.
- **Player:** playback, seeking, subtitles, recommendations, keyboard shortcuts, and progress saving are connected to the player elements in `index.html`.

### Thumbnail selection

Thumbnail capture uses a 480 × 270 canvas and samples every fourth pixel. The initial frame is captured around 5–7.5 seconds in (or halfway through shorter videos). If at least 90% of its samples are similar to the dominant color, the generator checks up to six more frames, 5 seconds apart. A later frame is accepted when at least 10% of its samples differ from the first frame by more than 40 levels in an RGB channel and fewer than 90% of its samples resemble one dominant color. This avoids settling on a second black title card. If no frame passes both checks, the generator keeps the most detailed candidate that differs enough from the initial frame, or the initial frame if none do.

These are heuristics, not a visual-quality guarantee. The similarity tolerance (24 RGB levels), uniform-frame ratio (90%), per-pixel difference (40 levels), changed-pixel ratio (10%), and six-frame look-ahead are visible near the sampling logic in `app.js` so they can be tuned together. Thumbnails are generated in memory and are not saved to browser storage.

### Titles, segments, and custom thumbnails

Open a video to edit its **Display title**, capture the current player frame as its thumbnail, or mark a segment start and end and save the named range. Selecting a saved segment seeks to its start and plays through its end. These are playback annotations: the original video is never cut, rewritten, or exported.

Edits are saved in IndexedDB on this browser and applied again when the same video is loaded. Use **Export metadata** to download `localtube-metadata.json`; keep that file beside the videos as a portable backup. To use it on another browser/device, select it along with the video folder (when the browser includes it in the folder selection) or choose **Import metadata** after loading the library. Metadata is matched using each video's relative path, file size, and modified time, so moving/renaming a video or changing its file can require recreating its annotations. **Forget library** removes browser-saved metadata as well as saved videos and watch data; export first if you want to keep a backup.

### Styling and markup

The SVG symbols in `index.html` are referenced by their `#icon-*` IDs. Reuse an existing symbol when possible; add a symbol there before referencing it from a control. CSS variables at the top of `styles.css` define the shared palette, while the media queries near the end adjust the library/player layout for narrower screens, touch input, and reduced motion.

## License

LocalTube is released under the [MIT License](LICENSE).
