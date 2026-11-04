# LocalTube

A private, local video library that runs in your browser. Browse a folder of videos, search and sort your library, preview frames, and keep watching progress on your device. Your videos are never uploaded.

## Get started

1. Download or clone this repository.
2. Open `index.html` in a recent version of Chrome, Edge, Firefox, or Safari.
3. Choose a video folder.

Folder selection uses the browser's directory picker. Current Chrome, Edge, Firefox, and Safari support it. Browsers with writable folder access (such as current Chrome and Edge) can automatically save `localtube-metadata.json` beside the videos as you edit metadata. The library displays its first batch of videos while it continues loading the rest. Other browsers keep metadata in this browser; use **Export metadata** to save a portable copy. If a browser does not provide folder selection, choose multiple video files instead. LocalTube temporarily saves selected video files so the library survives a page refresh in the same tab. Starting the app again clears those temporary video copies; select the folder again to use the library.

For HDD-friendly browsing, LocalTube reads one video at a time only as its card approaches the viewport, then releases the file as soon as its details and (when needed) a midpoint thumbnail are ready. User-selected thumbnails always take priority, and generated thumbnails plus duration and resolution are cached in browser metadata so they do not need to be decoded again on the next visit. The first library save copies selected video data into browser storage for refresh recovery, so the source drive may stay active until the status confirms saving is complete.

## Features

- Search by video name or folder path; sort by name, recently added, duration, or file size.
- Load duration and resolution as soon as a video's metadata is available; capture its default midpoint thumbnail afterward when its card is reached. A user-selected thumbnail always takes priority, and hover previews become available as details load.
- Continue playback from locally saved progress; keep a Watch later list.
- Create named, playable time segments, customize display titles, and choose a frame for each thumbnail without changing the source videos.
- Automatically save metadata to a `localtube-metadata.json` sidecar in the selected folder when writable folder access is supported; otherwise use browser storage or import/export the sidecar manually.
- Create playlists, add videos, skip through a queue, and shuffle playback.
- Load local WebVTT or SubRip subtitles; show duration, resolution, format, size, path, and modified date.
- Seek with frame and time previews, adjust volume and playback speed, and use full-width theater or fullscreen mode.
- Keep unsupported video formats visible and show when the browser cannot preview or play them.
- Use a custom SVG icon set without external assets, fonts, services, or build tools.

## Browser support and privacy

LocalTube is a static web app with no install step, build step, or third-party dependencies. It is designed for current Chrome, Edge, Firefox, and Safari, as well as other modern browsers. Browsers without folder selection can still load multiple video files at once.

Video playback and thumbnail generation depend on the browser's built-in codec support. A video may appear in the library even if that browser cannot play or create a thumbnail for its format; codec availability varies by browser, operating system, and file.

Selected video files are stored temporarily in this tab's IndexedDB session cache so a page refresh can restore them; starting the app in a new navigation clears that cache. Watch progress, Watch later choices, playlists, and metadata use browser storage and remain across app starts. When a browser supports writable folder access, LocalTube requests access to the selected folder and writes metadata there; videos and other files are never uploaded. The folder permission may need to be granted again after reopening the app. The browser's storage quota may limit how much video can be retained; LocalTube reports when saving fails. Use **Forget library** to remove the saved video files, metadata, playlists, and watch history, or clear this site's browser data. Temporary playback and subtitle URLs are not persisted.

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
- **Thumbnails and previews:** visible cards are processed sequentially with one reusable video element. It seeks to the midpoint only when no user-selected or cached thumbnail exists, then releases the source; hover and seek previews also release their sources when dismissed.
- **Player:** playback, seeking, subtitles, recommendations, keyboard shortcuts, and progress saving are connected to the player elements in `index.html`.

### Thumbnail selection

When a card approaches the viewport, LocalTube reads its duration and resolution and captures one frame near the video's midpoint if no thumbnail is already available. These details and generated thumbnails are cached in browser metadata and included when metadata is exported or saved to a writable sidecar. Open a video and pause on the frame you want, then choose **Use current frame as thumbnail** to override the default. **Reset thumbnail** removes that override and reveals the generated default again.

### Titles, segments, and custom thumbnails

Open a video to edit its **Display title**, capture the current player frame as its thumbnail, or mark a segment start and end and save the named range. Selecting a saved segment seeks to its start and plays through its end. These are playback annotations: the original video is never cut, rewritten, or exported.

Edits are saved in IndexedDB on this browser and, when writable folder access is available, automatically written to `localtube-metadata.json` in the selected video folder. Choose that folder again after reopening the app if the browser asks for permission. Use **Export metadata** for a portable backup, or **Import metadata** to load a sidecar manually. Metadata is matched using each video's relative path, file size, and modified time, so moving/renaming a video or changing its file can require recreating its annotations. **Forget library** removes browser-saved metadata as well as saved videos and watch data; it does not delete the sidecar file in your video folder.

### Styling and markup

The SVG symbols in `index.html` are referenced by their `#icon-*` IDs. Reuse an existing symbol when possible; add a symbol there before referencing it from a control. CSS variables at the top of `styles.css` define the shared palette, while the media queries near the end adjust the library/player layout for narrower screens, touch input, and reduced motion.

## License

LocalTube is released under the [MIT License](LICENSE).
