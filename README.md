# LocalTube

A private, local video library that runs in your browser. Choose a folder to browse its video files, generate thumbnails, preview frames by hovering over the timeline, and watch without uploading anything.

## Run it

Open `index.html` in Chrome or Edge, then choose a video folder. Folder selection works in modern browsers that support the `webkitdirectory` file picker. Videos and generated previews stay on your device.

The browser remembers watch progress and your Watch later list in local storage. Because browsers do not retain folder file access after a page is closed, choose the folder again the next time you open LocalTube.

Playback and thumbnail generation depend on the video codecs supported by your browser. If a format cannot be decoded, LocalTube will still list the file and explain that its preview is unavailable.

## Playback

- Hover over a thumbnail and move left or right to preview a frame at that point in the video.
- The watch page shows the video, file details, and similar-title/folder recommendations. Its custom controls include a seek bar with frame/time previews, a volume slider, playback speed, theater mode, and fullscreen.
- Keyboard shortcuts while the player is open: **Space/K** play or pause, **←/→** seek 5 seconds, **↑/↓** adjust volume, **M** mute, **T** theater mode, **F** fullscreen, **Esc** close.
- Search by video name or folder path; sort by name, date, duration, or file size.
