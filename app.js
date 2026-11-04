(() => {
  "use strict";

  // Configuration and shared in-memory state for the single-page app.
  const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|webm|ogv|ogg|mkv|avi|mpg|mpeg|wmv|3gp|mts|m2ts)$/i;
  const STORAGE_KEY = "localtube-library-v1";
  const PLAYLIST_STORAGE_KEY = "localtube-playlists-v1";
  const METADATA_FILE = "localtube-metadata.json";
  const METADATA_FORMAT = "localtube-metadata";
  const MEDIA_DATABASE = "localtube-media-v1";
  const MEDIA_STORE = "files";
  const METADATA_STORE = "metadata";
  const byId = (id) => document.getElementById(id);
  const createIcon = (name, className = "icon") => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    svg.setAttribute("class", className);
    svg.setAttribute("aria-hidden", "true");
    use.setAttribute("href", `#icon-${name}`);
    svg.append(use);
    return svg;
  };
  const fileInput = byId("folder-input");
  const searchInput = byId("search");
  const grid = byId("video-grid");
  const welcome = byId("welcome");
  const library = byId("library");
  const status = byId("status");
  const playerModal = byId("player-modal");
  const player = byId("main-player");
  const playerShell = byId("player-shell");
  const seekTrack = byId("seek-track");
  const seekPreview = byId("seek-preview");
  const seekPreviewVideo = byId("seek-preview-video");
  const metadataInput = byId("metadata-input");
  const supportsDirectoryPicker = "webkitdirectory" in HTMLInputElement.prototype;
  let videos = [];
  let activeFilter = "all";
  let activeVideo = null;
  let objectUrls = [];
  let thumbGeneration = 0;
  let hoverGeneration = 0;
  let controlsTimer = 0;
  let draggingSeek = false;
  let lastVolume = 1;
  let lastProgressSave = -1;
  let savedState = readSavedState();
  let playlists = readPlaylists();
  let videoMetadata = {};
  let activePlaylistId = null;
  let playQueue = [];
  let queueIndex = -1;
  let shuffleEnabled = false;
  let pendingSegmentStart = null;
  let pendingSegmentEnd = null;
  let playingSegment = null;
  let subtitleUrl = "";
  let persistenceNotice = "";
  let selectionGeneration = 0;
  let mediaWriteQueue = Promise.resolve();

  if (!supportsDirectoryPicker) {
    fileInput.removeAttribute("webkitdirectory");
    fileInput.removeAttribute("directory");
    byId("choose-folder").querySelector(".button-label").textContent = "Choose videos";
    byId("welcome-choose").querySelector(".button-label").textContent = "Choose video files";
    byId("support-note").textContent = "Select multiple video files at once; folder selection is unavailable in this browser.";
  }

  // Watch progress and playlists are small localStorage records, separate from video blobs.
  function readSavedState() {
    try {
      const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return state && typeof state === "object" ? state : {};
    } catch (error) {
      console.warn("Could not read saved LocalTube progress.", error);
      return {};
    }
  }

  function readPlaylists() {
    try {
      const state = JSON.parse(localStorage.getItem(PLAYLIST_STORAGE_KEY) || "[]");
      return Array.isArray(state) ? state.filter(playlist =>
        playlist && typeof playlist.id === "string" && typeof playlist.name === "string" && Array.isArray(playlist.videoKeys)
      ) : [];
    } catch (error) {
      console.warn("Could not read LocalTube playlists.", error);
      return [];
    }
  }

  function persistPlaylists() {
    try {
      localStorage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify(playlists));
    } catch (error) {
      console.warn("Could not save LocalTube playlists.", error);
      showStatus("Playlist changes could not be saved in this browser.");
    }
  }

  function persistState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(savedState));
    } catch (error) {
      console.warn("Could not save LocalTube progress.", error);
      showStatus("Playback progress could not be saved in this browser.");
    }
  }

  function getSaved(video) {
    return savedState[video.key] || { currentTime: 0, watched: false, later: false };
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}` : `${minutes}:${String(secs).padStart(2, "0")}`;
  }

  function formatSize(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / (1024 ** power)).toFixed(power ? 1 : 0)} ${units[power]}`;
  }

  function formatDate(timestamp) {
    return timestamp ? new Date(timestamp).toLocaleString() : "Unknown";
  }

  function updateVideoDetails(video) {
    const format = video.file.type || video.file.name.split(".").pop().toUpperCase();
    const details = [
      ["Duration", video.duration ? formatTime(video.duration) : "Unavailable"],
      ["Resolution", video.width && video.height ? `${video.width} × ${video.height}` : "Unavailable"],
      ["Format", format || "Unknown"],
      ["File size", formatSize(video.file.size)],
      ["Modified", formatDate(video.file.lastModified)]
    ];
    const list = byId("video-properties");
    list.replaceChildren();
    details.forEach(([label, value]) => {
      const term = document.createElement("dt");
      term.textContent = label;
      const description = document.createElement("dd");
      description.textContent = value;
      list.append(term, description);
    });
  }

  function refreshPlayerMetadata() {
    if (!activeVideo) return;
    byId("player-title").textContent = activeVideo.title;
    byId("custom-video-title").value = metadataFor(activeVideo).title || activeVideo.file.name.replace(VIDEO_EXTENSIONS, "");
    updateVideoDetails(activeVideo);
    renderVideoSegments();
  }

  function saveCustomTitle(title) {
    if (!activeVideo) return;
    const cleanTitle = title.trim().slice(0, 160);
    const metadata = metadataFor(activeVideo);
    metadata.title = cleanTitle;
    videoMetadata[activeVideo.key] = metadata;
    applyVideoMetadata(activeVideo);
    refreshPlayerMetadata();
    updateLibrary();
    if (!playerModal.hidden) renderRecommendations(activeVideo);
    saveMetadataChanges();
    showStatus(cleanTitle ? "Custom video title saved." : "Using the original filename.");
  }

  function markSegmentBoundary(boundary) {
    if (!activeVideo || !Number.isFinite(player.currentTime)) return;
    if (boundary === "start") {
      pendingSegmentStart = player.currentTime;
      pendingSegmentEnd = null;
    }
    else if (pendingSegmentStart === null || player.currentTime <= pendingSegmentStart) {
      showStatus("Set a segment start before setting an end time after it.");
      return;
    } else {
      pendingSegmentEnd = player.currentTime;
      byId("segment-end-time").textContent = formatTime(pendingSegmentEnd);
      byId("save-segment").disabled = false;
      return;
    }
    byId("segment-start-time").textContent = formatTime(pendingSegmentStart);
    byId("segment-end-time").textContent = "End not set";
    byId("save-segment").disabled = true;
  }

  function saveSegment() {
    if (!activeVideo || pendingSegmentStart === null || pendingSegmentEnd === null ||
        pendingSegmentEnd <= pendingSegmentStart) return;
    const name = byId("segment-name").value.trim();
    if (!name) {
      showStatus("Enter a name for this segment.");
      byId("segment-name").focus();
      return;
    }
    const metadata = metadataFor(activeVideo);
    metadata.segments.push({
      id: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: name.slice(0, 100),
      start: pendingSegmentStart,
      end: pendingSegmentEnd
    });
    metadata.segments.sort((left, right) => left.start - right.start);
    videoMetadata[activeVideo.key] = metadata;
    applyVideoMetadata(activeVideo);
    pendingSegmentStart = null;
    pendingSegmentEnd = null;
    byId("segment-name").value = "";
    byId("segment-start-time").textContent = "Start not set";
    byId("segment-end-time").textContent = "End not set";
    byId("save-segment").disabled = true;
    renderVideoSegments();
    saveMetadataChanges();
    showStatus("Named segment saved.");
  }

  function playVideoSegment(segment) {
    if (!activeVideo) return;
    playingSegment = { videoKey: activeVideo.key, start: segment.start, end: segment.end };
    player.currentTime = segment.start;
    player.play().catch(error => console.info("Could not start the selected video segment.", error));
  }

  function renderVideoSegments() {
    const list = byId("segment-list");
    if (!list) return;
    list.replaceChildren();
    if (!activeVideo) return;
    activeVideo.segments.forEach(segment => {
      const row = document.createElement("div");
      row.className = "segment-row";
      const play = document.createElement("button");
      play.type = "button";
      play.className = "segment-play";
      play.textContent = `${segment.name} · ${formatTime(segment.start)}–${formatTime(segment.end)}`;
      play.addEventListener("click", () => playVideoSegment(segment));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "segment-remove";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove segment ${segment.name}`);
      remove.addEventListener("click", () => {
        const metadata = metadataFor(activeVideo);
        metadata.segments = metadata.segments.filter(item => item.id !== segment.id);
        videoMetadata[activeVideo.key] = metadata;
        applyVideoMetadata(activeVideo);
        renderVideoSegments();
        saveMetadataChanges();
      });
      row.append(play, remove);
      list.append(row);
    });
  }

  function setThumbnailFromCurrentFrame() {
    if (!activeVideo || !player.videoWidth || !player.videoHeight ||
        player.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      showStatus("Wait for a video frame to load before saving a thumbnail.");
      return;
    }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 480;
      canvas.height = 270;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Could not create a thumbnail canvas.");
      const sourceRatio = player.videoWidth / player.videoHeight;
      const targetRatio = canvas.width / canvas.height;
      const sourceWidth = sourceRatio > targetRatio ? player.videoHeight * targetRatio : player.videoWidth;
      const sourceHeight = sourceRatio > targetRatio ? player.videoHeight : player.videoWidth / targetRatio;
      context.drawImage(
        player,
        (player.videoWidth - sourceWidth) / 2,
        (player.videoHeight - sourceHeight) / 2,
        sourceWidth,
        sourceHeight,
        0, 0, canvas.width, canvas.height
      );
      const thumbnail = canvas.toDataURL("image/jpeg", .82);
      const metadata = metadataFor(activeVideo);
      metadata.thumbnail = thumbnail;
      videoMetadata[activeVideo.key] = metadata;
      applyVideoMetadata(activeVideo);
      updateLibrary();
      renderRecommendations(activeVideo);
      saveMetadataChanges();
      showStatus(`Custom thumbnail saved at ${formatTime(player.currentTime)}.`);
    } catch (error) {
      console.warn("Could not capture the selected video frame as a thumbnail.", error);
      showStatus("This frame could not be saved as a thumbnail.");
    }
  }

  function resetCustomThumbnail() {
    if (!activeVideo) return;
    const metadata = metadataFor(activeVideo);
    metadata.thumbnail = "";
    videoMetadata[activeVideo.key] = metadata;
    applyVideoMetadata(activeVideo);
    updateLibrary();
    renderRecommendations(activeVideo);
    saveMetadataChanges();
    showStatus("Custom thumbnail removed.");
  }

  function showStatus(message) {
    status.textContent = message;
    status.hidden = !message;
  }

  function stableKey(file) {
    return `${file.webkitRelativePath || file.name}|${file.size}|${file.lastModified}`;
  }

  // Keep selected file data in IndexedDB; object URLs are created only for the current page session.
  function openMediaDatabase() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("This browser does not support persistent local video storage."));
        return;
      }
      const request = indexedDB.open(MEDIA_DATABASE, 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(MEDIA_STORE)) {
          request.result.createObjectStore(MEDIA_STORE, { keyPath: "key" });
        }
        if (!request.result.objectStoreNames.contains(METADATA_STORE)) {
          request.result.createObjectStore(METADATA_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open the local video library."));
    });
  }

  function readPersistedMetadata() {
    return openMediaDatabase().then(database => new Promise((resolve, reject) => {
      const transaction = database.transaction(METADATA_STORE, "readonly");
      const request = transaction.objectStore(METADATA_STORE).get("video-metadata");
      request.onsuccess = () => resolve(request.result?.value || {});
      request.onerror = () => reject(request.error || new Error("Could not restore video metadata."));
      transaction.oncomplete = () => database.close();
      transaction.onerror = () => {
        database.close();
        reject(transaction.error || new Error("Could not restore video metadata."));
      };
    }));
  }

  function persistVideoMetadata() {
    return openMediaDatabase().then(database => new Promise((resolve, reject) => {
      const transaction = database.transaction(METADATA_STORE, "readwrite");
      transaction.objectStore(METADATA_STORE).put({ key: "video-metadata", value: videoMetadata });
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error || new Error("Could not save video metadata."));
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error || new Error("Could not save video metadata."));
      };
    })).catch(error => {
      console.warn("Could not save LocalTube video metadata.", error);
      showStatus("Video metadata could not be saved in this browser. Export a metadata file to keep a portable copy.");
      throw error;
    });
  }

  function readPersistedMedia() {
    return openMediaDatabase().then(database => new Promise((resolve, reject) => {
      const transaction = database.transaction(MEDIA_STORE, "readonly");
      const request = transaction.objectStore(MEDIA_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error("Could not restore the local video library."));
      transaction.oncomplete = () => database.close();
      transaction.onerror = () => {
        database.close();
        reject(transaction.error || new Error("Could not restore the local video library."));
      };
    }));
  }

  function storePersistedMedia(files) {
    const records = files.map(file => ({
      key: stableKey(file),
      blob: file,
      name: file.name,
      type: file.type,
      lastModified: file.lastModified,
      path: file.webkitRelativePath || file.name
    }));
    const write = () => openMediaDatabase().then(database => new Promise((resolve, reject) => {
      const transaction = database.transaction(MEDIA_STORE, "readwrite");
      const store = transaction.objectStore(MEDIA_STORE);
      store.clear();
      records.forEach(record => store.put(record));
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error || new Error("Could not save the selected videos."));
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error || new Error("The browser could not store these videos."));
      };
    }));
    const operation = mediaWriteQueue.then(write);
    mediaWriteQueue = operation.catch(error => {
      console.warn("Could not persist LocalTube video files.", error);
    });
    return operation;
  }

  function clearPersistedMedia() {
    const clear = () => openMediaDatabase().then(database => new Promise((resolve, reject) => {
      const transaction = database.transaction(MEDIA_STORE, "readwrite");
      transaction.objectStore(MEDIA_STORE).clear();
      transaction.objectStore(METADATA_STORE).clear();
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error || new Error("Could not remove the saved videos."));
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error || new Error("Could not remove the saved videos."));
      };
    }));
    const operation = mediaWriteQueue.then(clear);
    mediaWriteQueue = operation.catch(error => console.warn("Could not clear the local video library.", error));
    return operation;
  }

  function sanitizeVideoMetadata(record) {
    if (!record || typeof record !== "object") return null;
    const segments = Array.isArray(record.segments) ? record.segments.slice(0, 1000).filter(segment =>
      segment && typeof segment.id === "string" && typeof segment.name === "string" &&
      Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.start >= 0 && segment.end > segment.start
    ).map(segment => ({
      id: segment.id,
      name: segment.name.slice(0, 100),
      start: segment.start,
      end: segment.end
    })) : [];
    return {
      title: typeof record.title === "string" ? record.title.slice(0, 160) : "",
      segments,
      thumbnail: typeof record.thumbnail === "string" &&
        /^data:image\/jpeg;base64,[\da-z+/=]+$/i.test(record.thumbnail) &&
        record.thumbnail.length <= 1_000_000 ? record.thumbnail : ""
    };
  }

  function hasVideoMetadata(record) {
    return Boolean(record && (record.title || record.segments.length || record.thumbnail));
  }

  function metadataFor(video) {
    return videoMetadata[video.key] || { title: "", segments: [], thumbnail: "" };
  }

  function sanitizeMetadataMap(records) {
    if (!records || typeof records !== "object" || Array.isArray(records)) return {};
    return Object.fromEntries(Object.entries(records).flatMap(([key, record]) => {
      const cleanRecord = sanitizeVideoMetadata(record);
      return cleanRecord && key.length <= 2048 ? [[key, cleanRecord]] : [];
    }));
  }

  function saveMetadataChanges() {
    persistVideoMetadata().catch(() => {});
  }

  function serializeVideoMetadata() {
    const records = {};
    Object.entries(videoMetadata).forEach(([key, record]) => {
      const cleanRecord = sanitizeVideoMetadata(record);
      if (hasVideoMetadata(cleanRecord)) records[key] = cleanRecord;
    });
    return JSON.stringify({ format: METADATA_FORMAT, version: 1, videos: records }, null, 2);
  }

  async function importMetadataFile(file, notify = true) {
    let imported;
    try {
      imported = JSON.parse(await file.text());
    } catch (error) {
      console.warn("Could not read the selected LocalTube metadata file.", error);
      showStatus("The metadata file is not valid JSON.");
      return false;
    }
    if (!imported || imported.format !== METADATA_FORMAT || imported.version !== 1 ||
        !imported.videos || typeof imported.videos !== "object" || Array.isArray(imported.videos)) {
      showStatus("This is not a supported LocalTube metadata file.");
      return false;
    }
    Object.entries(imported.videos).forEach(([key, record]) => {
      const cleanRecord = sanitizeVideoMetadata(record);
      if (cleanRecord && key.length <= 2048) {
        const existing = sanitizeVideoMetadata(videoMetadata[key]) || { title: "", segments: [], thumbnail: "" };
        videoMetadata[key] = {
          title: cleanRecord.title || existing.title,
          segments: cleanRecord.segments.length ? cleanRecord.segments : existing.segments,
          thumbnail: cleanRecord.thumbnail || existing.thumbnail
        };
      }
    });
    try { await persistVideoMetadata(); } catch { /* Keep imported metadata available for this session and export. */ }
    videos.forEach(applyVideoMetadata);
    if (!playerModal.hidden && activeVideo) refreshPlayerMetadata();
    updateLibrary();
    if (notify) showStatus("LocalTube metadata imported.");
    return true;
  }

  function exportVideoMetadata() {
    const blob = new Blob([serializeVideoMetadata()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = METADATA_FILE;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showStatus(`Metadata exported as ${METADATA_FILE}. Save it beside your videos for a portable backup.`);
  }

  // Library lifecycle: build temporary media URLs, replace the active selection, and restore saved files.
  function makeVideo(file, path = file.webkitRelativePath || file.name) {
    const video = {
      file,
      url: URL.createObjectURL(file),
      key: stableKey(file),
      title: file.name.replace(VIDEO_EXTENSIONS, ""),
      path,
      duration: 0,
      width: 0,
      height: 0,
      thumbnail: "",
      generatedThumbnail: "",
      customThumbnail: "",
      segments: [],
      previewError: false
    };
    applyVideoMetadata(video);
    return video;
  }

  function applyVideoMetadata(video) {
    const metadata = metadataFor(video);
    video.title = metadata.title || video.file.name.replace(VIDEO_EXTENSIONS, "");
    video.customThumbnail = metadata.thumbnail || "";
    video.thumbnail = video.customThumbnail || video.generatedThumbnail || "";
    video.segments = metadata.segments;
  }

  function releaseCurrentMedia() {
    thumbGeneration++;
    hoverGeneration++;
    objectUrls.forEach(URL.revokeObjectURL);
    objectUrls = [];
  }

  function activateLibrary(nextVideos) {
    releaseCurrentMedia();
    videos = nextVideos.map(video => {
      const restored = makeVideo(video.file, video.path);
      restored.key = video.key || restored.key;
      objectUrls.push(restored.url);
      return restored;
    });
    activeFilter = "all";
    activePlaylistId = null;
    document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.filter === "all"));
    renderPlaylists();
    welcome.hidden = true;
    library.hidden = false;
    searchInput.value = "";
    updateLibrary();
    buildThumbnails(thumbGeneration);
  }

  async function restoreLibrary() {
    try {
      try {
        videoMetadata = sanitizeMetadataMap(await readPersistedMetadata());
      } catch (error) {
        console.warn("Could not restore saved LocalTube video metadata.", error);
      }
      if (selectionGeneration) return;
      const records = await readPersistedMedia();
      if (selectionGeneration || !records.length) return;
      const restored = records.map(record => {
        const file = record.file instanceof File
          ? record.file
          : record.blob instanceof Blob && typeof record.name === "string"
            ? new File([record.blob], record.name, { type: record.type || "", lastModified: record.lastModified || 0 })
            : null;
        return file && typeof record.path === "string" ? { file, path: record.path, key: record.key } : null;
      }).filter(Boolean);
      if (!restored.length) return;
      persistenceNotice = "";
      activateLibrary(restored);
    } catch (error) {
      console.warn("Could not restore the saved LocalTube library.", error);
      byId("welcome-status").textContent = "The saved library could not be restored. Choose your video folder again.";
      byId("welcome-status").hidden = false;
    }
  }

  // Import flow and the derived library view (filtering, sorting, and navigation).
  function chooseFolder() {
    fileInput.click();
  }

  byId("choose-folder").addEventListener("click", chooseFolder);
  byId("welcome-choose").addEventListener("click", chooseFolder);
  fileInput.addEventListener("change", async () => {
    const selectedFiles = Array.from(fileInput.files || []);
    const metadataFile = selectedFiles.find(file => file.name.toLowerCase() === METADATA_FILE);
    const files = selectedFiles.filter(file => file.type.startsWith("video/") || VIDEO_EXTENSIONS.test(file.name));
    if (!files.length) {
      if (metadataFile) {
        await importMetadataFile(metadataFile);
        fileInput.value = "";
        return;
      }
      const welcomeStatus = byId("welcome-status");
      welcomeStatus.textContent = supportsDirectoryPicker
        ? "No video files found in that folder. Choose a folder with video files to get started."
        : "No video files selected. Choose one or more video files to get started.";
      welcomeStatus.hidden = false;
      return;
    }

    const generation = ++selectionGeneration;
    try {
      videoMetadata = sanitizeMetadataMap(await readPersistedMetadata());
    } catch (error) {
      console.warn("Could not load saved video metadata before importing videos.", error);
    }
    if (generation !== selectionGeneration) return;
    if (metadataFile) await importMetadataFile(metadataFile, false);
    if (generation !== selectionGeneration) return;
    persistenceNotice = "";
    if (videos.length) {
      showStatus("Saving selected video files in this browser…");
    } else {
      byId("welcome-status").textContent = "Saving selected video files in this browser…";
      byId("welcome-status").hidden = false;
    }
    let persistenceFailed = false;
    try {
      await storePersistedMedia(files);
    } catch (error) {
      console.warn("The selected videos could not be retained after refresh.", error);
      persistenceFailed = true;
    }
    if (generation !== selectionGeneration) return;
    persistenceNotice = persistenceFailed
      ? "Videos are available for this visit, but the browser could not retain them after refresh. Check available storage and browser permissions."
      : "";
    byId("welcome-status").hidden = true;
    activateLibrary(files.map(file => ({ file, path: file.webkitRelativePath || file.name })));
    fileInput.value = "";
  });

  searchInput.addEventListener("input", updateLibrary);
  byId("sort").addEventListener("change", updateLibrary);
  byId("export-metadata").addEventListener("click", exportVideoMetadata);
  byId("import-metadata").addEventListener("click", () => metadataInput.click());
  metadataInput.addEventListener("change", async () => {
    const file = metadataInput.files && metadataInput.files[0];
    metadataInput.value = "";
    if (file) await importMetadataFile(file);
  });

  function filteredVideos() {
    const term = searchInput.value.trim().toLocaleLowerCase();
    const activePlaylist = activeFilter === "playlist"
      ? playlists.find(playlist => playlist.id === activePlaylistId)
      : null;
    let result = videos.filter(video => {
      const saved = getSaved(video);
      if (activeFilter === "playlist" && (!activePlaylist || !activePlaylist.videoKeys.includes(video.key))) return false;
      if (activeFilter === "continue" && (!saved.currentTime || saved.watched)) return false;
      if (activeFilter === "watchlater" && !saved.later) return false;
      if (activeFilter === "watched" && !saved.watched) return false;
      return !term || video.title.toLocaleLowerCase().includes(term) || video.path.toLocaleLowerCase().includes(term);
    });
    const sort = byId("sort").value;
    result = result.slice().sort((a, b) => {
      if (sort === "recent") return b.file.lastModified - a.file.lastModified;
      if (sort === "duration") return b.duration - a.duration;
      if (sort === "size") return b.file.size - a.file.size;
      return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
    });
    return result;
  }

  function renderPlaylists() {
    const list = byId("playlist-list");
    list.replaceChildren();
    byId("create-playlist").disabled = videos.length === 0;
    playlists.forEach(playlist => {
      const row = document.createElement("div");
      row.className = "playlist-row";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "nav-item playlist-nav-item";
      button.textContent = playlist.name;
      button.disabled = videos.length === 0;
      button.classList.toggle("active", activeFilter === "playlist" && activePlaylistId === playlist.id);
      button.setAttribute("aria-current", activeFilter === "playlist" && activePlaylistId === playlist.id ? "page" : "false");
      button.addEventListener("click", () => {
        activeFilter = "playlist";
        activePlaylistId = playlist.id;
        document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item === button));
        updateLibrary();
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "playlist-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Delete playlist ${playlist.name}`);
      remove.addEventListener("click", () => deletePlaylist(playlist.id));
      row.append(button, remove);
      list.append(row);
    });
  }

  // Playlist editing and queue state are kept in memory; playlist membership uses stable video keys.
  function showPlaylistForm() {
    const form = byId("playlist-form");
    form.hidden = false;
    byId("playlist-name").value = "";
    byId("playlist-name").focus();
  }

  function createPlaylist(name) {
    if (!name || !name.trim()) return;
    if (playlists.some(playlist => playlist.name.localeCompare(name.trim(), undefined, { sensitivity: "base" }) === 0)) {
      showStatus("A playlist with that name already exists. Choose a different name.");
      byId("playlist-name").focus();
      return;
    }
    const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    playlists.push({ id, name: name.trim(), videoKeys: [] });
    persistPlaylists();
    byId("playlist-form").hidden = true;
    activeFilter = "playlist";
    activePlaylistId = id;
    renderPlaylists();
    updateLibrary();
  }

  function confirmAction(message) {
    const dialog = byId("confirm-dialog");
    byId("confirm-message").textContent = message;
    dialog.returnValue = "";
    return new Promise(resolve => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
      dialog.showModal();
    });
  }

  async function deletePlaylist(id) {
    const playlist = playlists.find(item => item.id === id);
    if (!playlist || !await confirmAction(`Delete the playlist "${playlist.name}"?`)) return;
    playlists = playlists.filter(item => item.id !== id);
    if (activePlaylistId === id) {
      activePlaylistId = null;
      activeFilter = "all";
      document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.filter === "all"));
    }
    persistPlaylists();
    renderPlaylists();
    updateLibrary();
  }

  function addVideoToPlaylist(video, playlistId) {
    const playlist = playlists.find(item => item.id === playlistId);
    if (!playlist || playlist.videoKeys.includes(video.key)) return;
    playlist.videoKeys.push(video.key);
    persistPlaylists();
    showStatus(`Added "${video.title}" to ${playlist.name}.`);
    updateLibrary();
  }

  function shuffleItems(items) {
    const shuffled = items.slice();
    for (let index = shuffled.length - 1; index > 0; index--) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
    }
    return shuffled;
  }

  function initializeQueue(video) {
    const playlist = activeFilter === "playlist"
      ? playlists.find(item => item.id === activePlaylistId)
      : null;
    playQueue = playlist
      ? playlist.videoKeys.map(key => videos.find(item => item.key === key)).filter(Boolean)
      : filteredVideos();
    if (!playQueue.includes(video) && !playlist) playQueue.unshift(video);
    queueIndex = playQueue.indexOf(video);
    shuffleEnabled = false;
  }

  function updateQueueControls() {
    byId("previous-video").disabled = queueIndex <= 0;
    byId("next-video").disabled = queueIndex < 0 || queueIndex >= playQueue.length - 1;
    byId("queue-shuffle").disabled = playQueue.length < 2;
    byId("queue-shuffle").setAttribute("aria-pressed", String(shuffleEnabled));
    byId("queue-shuffle").title = shuffleEnabled ? "Turn shuffle off" : "Shuffle play queue";
    byId("queue-shuffle").classList.toggle("selected", shuffleEnabled);
  }

  function toggleQueueShuffle() {
    if (!activeVideo) return;
    if (shuffleEnabled) {
      const playlist = activeFilter === "playlist"
        ? playlists.find(item => item.id === activePlaylistId)
        : null;
      playQueue = playlist
        ? playlist.videoKeys.map(key => videos.find(item => item.key === key)).filter(Boolean)
        : filteredVideos();
      if (!playQueue.includes(activeVideo) && !playlist) playQueue.unshift(activeVideo);
      queueIndex = playQueue.indexOf(activeVideo);
      shuffleEnabled = false;
    } else {
      const remaining = playQueue.filter(video => video !== activeVideo);
      playQueue = [activeVideo, ...shuffleItems(remaining)];
      queueIndex = 0;
      shuffleEnabled = true;
    }
    updateQueueControls();
  }

  function skipVideo(offset) {
    const nextIndex = queueIndex + offset;
    if (nextIndex < 0 || nextIndex >= playQueue.length) return;
    queueIndex = nextIndex;
    openPlayer(playQueue[queueIndex], true);
  }

  function startShuffledPlaylist() {
    const playlist = playlists.find(item => item.id === activePlaylistId);
    if (!playlist) return;
    const queue = shuffleItems(playlist.videoKeys.map(key => videos.find(item => item.key === key)).filter(Boolean));
    if (!queue.length) return;
    playQueue = queue;
    queueIndex = 0;
    shuffleEnabled = true;
    openPlayer(queue[0], true);
    updateQueueControls();
  }

  async function forgetLibrary() {
    if (!videos.length || !await confirmAction("Remove the saved video files, metadata, playlists, and watch history from this browser?")) return;
    try {
      await clearPersistedMedia();
    } catch (error) {
      console.warn("Could not forget the saved LocalTube video files.", error);
      showStatus("The saved video files could not be removed. Check browser storage permissions and try again.");
      return;
    }
    let removalWarning = "";
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(PLAYLIST_STORAGE_KEY);
    } catch (error) {
      console.warn("Could not remove all saved LocalTube watch data.", error);
      removalWarning = "Video files were removed, but some saved watch data could not be cleared.";
    }
    try {
      selectionGeneration++;
      releaseCurrentMedia();
      videos = [];
      videoMetadata = {};
      playlists = [];
      savedState = {};
      persistenceNotice = "";
      activeFilter = "all";
      activePlaylistId = null;
      playQueue = [];
      queueIndex = -1;
      grid.replaceChildren();
      byId("all-count").textContent = "";
      showStatus("");
      document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.filter === "all"));
      renderPlaylists();
      library.hidden = true;
      welcome.hidden = false;
      byId("welcome-status").textContent = removalWarning || "Saved videos and library data were removed from this browser.";
      byId("welcome-status").hidden = false;
    } catch (error) {
      console.warn("Could not finish clearing LocalTube library data.", error);
      byId("welcome-status").textContent = "Video files were removed, but LocalTube could not finish clearing the library view.";
      byId("welcome-status").hidden = false;
    }
  }

  function updateLibrary() {
    const labels = { all: "All videos", continue: "Continue watching", watchlater: "Watch later", watched: "Watched" };
    const playlist = activeFilter === "playlist" ? playlists.find(item => item.id === activePlaylistId) : null;
    const title = playlist ? playlist.name : (labels[activeFilter] || labels.all);
    byId("page-title").textContent = title;
    byId("library-eyebrow").textContent = activeFilter === "all" ? "YOUR LIBRARY" : activeFilter === "playlist" ? "YOUR PLAYLIST" : "YOUR COLLECTION";
    byId("all-count").textContent = videos.length || "";
    const filtered = filteredVideos();
    const totalDuration = videos.reduce((sum, video) => sum + (video.duration || 0), 0);
    byId("library-subtitle").textContent = activeFilter === "all"
      ? `${videos.length} ${videos.length === 1 ? "video" : "videos"}${totalDuration ? ` · ${formatTime(totalDuration)} total` : ""}`
      : `${filtered.length} ${filtered.length === 1 ? "video" : "videos"}`;
    byId("shuffle-playlist").hidden = !playlist || !filtered.length;
    byId("delete-active-playlist").hidden = !playlist;
    byId("forget-library").hidden = videos.length === 0;
    byId("browse-library").hidden = !playlist || playlist.videoKeys.length > 0;
    grid.replaceChildren();
    filtered.forEach(video => grid.append(createCard(video)));
    byId("no-results").hidden = filtered.length !== 0;
    if (!filtered.length && videos.length) {
      const message = activeFilter === "watchlater" ? "Add videos to Watch later using the bookmark button." :
        activeFilter === "continue" ? "Videos you start watching will show up here." :
          activeFilter === "watched" ? "Videos you finish watching will show up here." :
            playlist && !playlist.videoKeys.length ? "Add videos to this playlist from their card menus." : "Try a different search or choose another section.";
      byId("no-results").querySelector("p").textContent = message;
    }
  }

  // Bind library navigation after the render helpers are defined.
  document.querySelectorAll(".nav-item[data-filter]").forEach(item => {
    item.addEventListener("click", () => {
      activeFilter = item.dataset.filter;
      activePlaylistId = null;
      document.querySelectorAll(".nav-item").forEach(nav => nav.classList.toggle("active", nav === item));
      updateLibrary();
    });
  });
  byId("create-playlist").addEventListener("click", showPlaylistForm);
  byId("playlist-form").addEventListener("submit", event => {
    event.preventDefault();
    createPlaylist(byId("playlist-name").value);
  });
  byId("cancel-playlist").addEventListener("click", () => {
    byId("playlist-form").hidden = true;
  });
  byId("shuffle-playlist").addEventListener("click", startShuffledPlaylist);
  byId("delete-active-playlist").addEventListener("click", () => {
    if (activePlaylistId) deletePlaylist(activePlaylistId);
  });
  byId("forget-library").addEventListener("click", forgetLibrary);
  byId("browse-library").addEventListener("click", () => {
    activeFilter = "all";
    activePlaylistId = null;
    document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.filter === "all"));
    updateLibrary();
  });

  function createCard(video) {
    const card = document.createElement("article");
    card.className = "video-card";
    card.dataset.videoKey = video.key;
    card.tabIndex = 0;
    card.setAttribute("aria-label", `Play ${video.title}`);
    const thumb = document.createElement("div");
    thumb.className = "thumb-wrap";
    const skeleton = document.createElement("div");
    skeleton.className = "thumb-skeleton";
    skeleton.append(createIcon("play", "icon icon-filled"));
    const image = document.createElement("img");
    image.className = "thumb-image";
    image.alt = "";
    image.hidden = true;
    if (video.thumbnail) {
      image.src = video.thumbnail;
      image.hidden = false;
      skeleton.hidden = true;
    }
    const duration = document.createElement("span");
    duration.className = "duration-badge";
    duration.textContent = video.duration ? formatTime(video.duration) : "--:--";
    const later = document.createElement("button");
    later.type = "button";
    later.className = "card-later";
    later.setAttribute("aria-label", getSaved(video).later ? "Remove from watch later" : "Add to watch later");
    later.title = later.getAttribute("aria-label");
    later.append(createIcon("bookmark"));
    const laterLabel = document.createElement("span");
    laterLabel.textContent = getSaved(video).later ? "Saved" : "Save";
    later.append(laterLabel);
    later.classList.toggle("saved", getSaved(video).later);
    later.addEventListener("click", event => {
      event.stopPropagation();
      toggleLater(video);
    });
    const addToPlaylist = document.createElement("select");
    addToPlaylist.className = "card-playlist-select";
    addToPlaylist.setAttribute("aria-label", `Add ${video.title} to a playlist`);
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "+ Playlist";
    addToPlaylist.append(defaultOption);
    playlists.forEach(playlist => {
      const option = document.createElement("option");
      option.value = playlist.id;
      option.textContent = playlist.name;
      addToPlaylist.append(option);
    });
    addToPlaylist.hidden = playlists.length === 0;
    addToPlaylist.addEventListener("click", event => event.stopPropagation());
    addToPlaylist.addEventListener("change", event => {
      event.stopPropagation();
      addVideoToPlaylist(video, addToPlaylist.value);
    });
    const progress = document.createElement("div");
    progress.className = "watch-progress";
    const progressFill = document.createElement("span");
    const saved = getSaved(video);
    const percent = video.duration > 0 ? Math.max(0, Math.min(100, (saved.currentTime / video.duration) * 100)) : 0;
    progressFill.style.width = `${saved.watched ? 100 : percent}%`;
    progress.append(progressFill);
    thumb.append(skeleton, image, duration, later, addToPlaylist, progress);

    const details = document.createElement("div");
    details.className = "video-details";
    const avatar = document.createElement("div");
    avatar.className = "video-avatar";
    avatar.textContent = (video.title.trim()[0] || "▶").toLocaleUpperCase();
    const text = document.createElement("div");
    text.className = "video-text";
    const title = document.createElement("h2");
    title.className = "video-title";
    title.textContent = video.title;
    title.title = video.title;
    const meta = document.createElement("div");
    meta.className = "video-meta";
    meta.textContent = `${video.path.includes("/") ? video.path.slice(0, video.path.lastIndexOf("/")) : formatSize(video.file.size)}${video.path.includes("/") ? ` · ${formatSize(video.file.size)}` : ""}`;
    text.append(title, meta);
    details.append(avatar, text);
    card.append(thumb, details);

    card.addEventListener("click", () => openPlayer(video));
    card.addEventListener("keydown", event => {
      if (event.target === card && event.key === "Enter") openPlayer(video);
    });
    card.addEventListener("pointerenter", event => beginHoverPreview(card, thumb, video, event));
    card.addEventListener("pointermove", event => updateHoverPreview(card, thumb, video, event));
    card.addEventListener("pointerleave", () => endHoverPreview(card));
    return card;
  }

  // Generate previews one video at a time so a single media element can be reused.
  function buildThumbnails(generation) {
    if (!videos.length) return;
    showStatus(`Creating previews… 0 of ${videos.length}`);
    const worker = document.createElement("video");
    worker.muted = true;
    worker.preload = "metadata";
    let index = 0;
    let unavailable = 0;

    const loadNext = () => {
      if (generation !== thumbGeneration) {
        worker.removeAttribute("src");
        worker.load();
        return;
      }
      if (index >= videos.length) {
        worker.removeAttribute("src");
        worker.load();
        updateLibrary();
        const previewMessage = unavailable
          ? `Previews unavailable for ${unavailable} ${unavailable === 1 ? "video" : "videos"}. The browser may not support ${unavailable === 1 ? "its" : "their"} format.`
          : "";
        showStatus([previewMessage, persistenceNotice].filter(Boolean).join(" "));
        return;
      }
      const video = videos[index++];
      processThumbnail(worker, video).then(() => {
        if (generation !== thumbGeneration) return;
        if (video.previewError) unavailable++;
        const card = Array.from(grid.children).find(element => element.dataset.videoKey === video.key);
        if (card) updateCardThumbnail(card, video);
        if (activeVideo === video) updateVideoDetails(video);
        if (activeVideo && !playerModal.hidden) renderRecommendations(activeVideo);
        showStatus(`Creating previews… ${index} of ${videos.length}${persistenceNotice ? ` · ${persistenceNotice}` : ""}`);
        updateLibrarySubtitle();
        loadNext();
      }).catch(error => {
        if (generation !== thumbGeneration) return;
        console.info(`Preview unavailable for ${video.file.name}:`, error);
        unavailable++;
        showStatus(`Creating previews… ${index} of ${videos.length}${persistenceNotice ? ` · ${persistenceNotice}` : ""}`);
        loadNext();
      });
    };
    loadNext();
  }

  function processThumbnail(worker, video) {
    return new Promise(resolve => {
      let settled = false;
      let targetTime = 0;
      let firstFrame = null;
      let fallbackThumbnail = "";
      let bestThumbnail = "";
      let bestDetailScore = -1;
      let additionalFrameChecks = 0;
      const finish = (thumbnail = "", duration = 0) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        worker.removeEventListener("loadedmetadata", onMetadata);
        worker.removeEventListener("loadeddata", onLoadedData);
        worker.removeEventListener("seeked", onSeeked);
        worker.removeEventListener("error", onError);
        video.previewError = !thumbnail;
        video.duration = Number.isFinite(duration) ? duration : 0;
        video.width = worker.videoWidth || 0;
        video.height = worker.videoHeight || 0;
        video.generatedThumbnail = thumbnail;
        video.thumbnail = video.customThumbnail || thumbnail;
        resolve();
      };
      const captureFrame = () => {
        if (worker.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || worker.seeking) return;
        if (targetTime > 0 && Math.abs(worker.currentTime - targetTime) > 0.25) return;
        try {
          if (!worker.videoWidth || !worker.videoHeight) {
            finish("", worker.duration);
            return;
          }
          const canvas = document.createElement("canvas");
          canvas.width = 480;
          canvas.height = 270;
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) {
            finish("", worker.duration);
            return;
          }
          const sourceRatio = worker.videoWidth / worker.videoHeight;
          const targetRatio = canvas.width / canvas.height;
          let sourceWidth = worker.videoWidth;
          let sourceHeight = worker.videoHeight;
          if (sourceRatio > targetRatio) {
            sourceWidth = sourceHeight * targetRatio;
          } else {
            sourceHeight = sourceWidth / targetRatio;
          }
          const sourceX = (worker.videoWidth - sourceWidth) / 2;
          const sourceY = (worker.videoHeight - sourceHeight) / 2;
          context.drawImage(
            worker,
            sourceX, sourceY, sourceWidth, sourceHeight,
            0, 0, canvas.width, canvas.height
          );
          const pixels = [];
          const frame = context.getImageData(0, 0, canvas.width, canvas.height).data;
          const colorCounts = new Uint16Array(4096);
          for (let y = 0; y < canvas.height; y += 4) {
            for (let x = 0; x < canvas.width; x += 4) {
              const offset = (y * canvas.width + x) * 4;
              const red = frame[offset];
              const green = frame[offset + 1];
              const blue = frame[offset + 2];
              pixels.push(red, green, blue);
              colorCounts[((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4)]++;
            }
          }
          const dominantColor = colorCounts.indexOf(Math.max(...colorCounts));
          const dominantRed = ((dominantColor >> 8) & 15) * 16 + 8;
          const dominantGreen = ((dominantColor >> 4) & 15) * 16 + 8;
          const dominantBlue = (dominantColor & 15) * 16 + 8;
          let similarPixels = 0;
          for (let index = 0; index < pixels.length; index += 3) {
            // Treat colors within 24 levels per RGB channel as similar; raise this to be more forgiving.
            if (Math.abs(pixels[index] - dominantRed) <= 24 &&
                Math.abs(pixels[index + 1] - dominantGreen) <= 24 &&
                Math.abs(pixels[index + 2] - dominantBlue) <= 24) {
              similarPixels++;
            }
          }
          const thumbnail = canvas.toDataURL("image/jpeg", .78);
          if (!firstFrame) {
            // A mostly single-color opening frame may be a title card rather than useful video content.
            const mostlyUniform = similarPixels / (pixels.length / 3) >= 0.9;
            if (!mostlyUniform) {
              finish(thumbnail, worker.duration);
              return;
            }
            fallbackThumbnail = thumbnail;
            firstFrame = pixels;
            bestThumbnail = thumbnail;
            bestDetailScore = 1 - similarPixels / (pixels.length / 3);
          } else {
            let changedPixels = 0;
            for (let index = 0; index < pixels.length; index += 3) {
              // Count pixels whose largest RGB-channel change exceeds 40 levels.
              if (Math.max(
                Math.abs(pixels[index] - firstFrame[index]),
                Math.abs(pixels[index + 1] - firstFrame[index + 1]),
                Math.abs(pixels[index + 2] - firstFrame[index + 2])
              ) > 40) {
                changedPixels++;
              }
            }
            const changedRatio = changedPixels / (pixels.length / 3);
            const detailScore = 1 - similarPixels / (pixels.length / 3);
            // Prefer a changed frame with detail; keep searching if it is still mostly a title card.
            if (changedRatio >= 0.1 && detailScore > bestDetailScore) {
              bestThumbnail = thumbnail;
              bestDetailScore = detailScore;
            }
            if (changedRatio >= 0.1 && detailScore > 0.1) {
              finish(thumbnail, worker.duration);
              return;
            }
          }

          // Keep sampling short title cards, but cap the look-ahead so huge libraries stay responsive.
          const nextTime = Math.min(targetTime + 5, worker.duration - 0.1);
          if (additionalFrameChecks < 6 && Number.isFinite(nextTime) && nextTime > targetTime + 0.25) {
            additionalFrameChecks++;
            targetTime = nextTime;
            worker.currentTime = targetTime;
            return;
          }
          if (firstFrame) {
            finish(bestThumbnail || fallbackThumbnail, worker.duration);
          } else {
            finish("", worker.duration);
          }
        } catch {
          finish(bestThumbnail || fallbackThumbnail, worker.duration);
        }
      };
      const onMetadata = () => {
        video.width = worker.videoWidth || 0;
        video.height = worker.videoHeight || 0;
        video.duration = Number.isFinite(worker.duration) ? worker.duration : 0;
        targetTime = Number.isFinite(worker.duration) && worker.duration > 0.2
          ? Math.min(7.5, worker.duration / 2)
          : 0;
        if (targetTime > 0) {
          try {
            worker.currentTime = targetTime;
          } catch {
            finish("", worker.duration);
          }
        }
      };
      const onLoadedData = () => captureFrame();
      const onSeeked = () => captureFrame();
      const onError = () => finish(bestThumbnail || fallbackThumbnail, worker.duration);
      const timeout = setTimeout(() => finish(bestThumbnail || fallbackThumbnail, worker.duration), 30000);
      worker.addEventListener("loadedmetadata", onMetadata, { once: true });
      worker.addEventListener("loadeddata", onLoadedData, { once: true });
      worker.addEventListener("seeked", onSeeked);
      worker.addEventListener("error", onError, { once: true });
      worker.src = video.url;
      worker.load();
    });
  }

  function updateCardThumbnail(card, video) {
    const image = card.querySelector(".thumb-image");
    const skeleton = card.querySelector(".thumb-skeleton");
    const duration = card.querySelector(".duration-badge");
    if (video.thumbnail) {
      image.src = video.thumbnail;
      image.hidden = false;
      skeleton.hidden = true;
    }
    duration.textContent = video.duration ? formatTime(video.duration) : "--:--";
  }

  function updateLibrarySubtitle() {
    if (activeFilter !== "all") return;
    const totalDuration = videos.reduce((sum, video) => sum + (video.duration || 0), 0);
    byId("library-subtitle").textContent = `${videos.length} ${videos.length === 1 ? "video" : "videos"}${totalDuration ? ` · ${formatTime(totalDuration)} total` : ""}`;
  }

  // Hover previews seek a temporary video element to the pointer position without starting playback.
  function getPointerFraction(thumb, event) {
    const rect = thumb.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  }

  function beginHoverPreview(card, thumb, video, event) {
    const generation = ++hoverGeneration;
    if (!video.duration || !video.url) return;
    let preview = thumb.querySelector(".hover-video");
    if (!preview) {
      preview = document.createElement("video");
      preview.className = "hover-video";
      preview.muted = true;
      preview.playsInline = true;
      preview.preload = "metadata";
      thumb.append(preview);
    }
    const fraction = getPointerFraction(thumb, event);
    preview.dataset.pendingFraction = String(fraction);
    card.classList.add("previewing");
    preview.src = video.url;
    preview.load();
    let previewTime = thumb.querySelector(".preview-time");
    if (!previewTime) {
      previewTime = document.createElement("span");
      previewTime.className = "preview-time";
      thumb.append(previewTime);
    }
    previewTime.textContent = formatTime(video.duration * fraction);
    preview.addEventListener("loadedmetadata", () => {
      if (generation !== hoverGeneration || !card.isConnected) return;
      const pendingFraction = Number(preview.dataset.pendingFraction);
      const target = Math.min(preview.duration - .05, Math.max(0, preview.duration * pendingFraction));
      preview.dataset.pendingTime = String(target);
      preview.currentTime = target;
    }, { once: true });
    preview.addEventListener("seeked", () => {
      if (generation !== hoverGeneration) return;
      previewTime.textContent = formatTime(preview.currentTime);
      const pendingTime = Number(preview.dataset.pendingTime);
      if (Number.isFinite(pendingTime) && Math.abs(preview.currentTime - pendingTime) > 1.25) {
        try { preview.currentTime = pendingTime; } catch { /* Wait for the next pointer movement. */ }
      }
    });
    preview.addEventListener("error", () => {
      card.classList.remove("previewing");
      preview.removeAttribute("src");
    }, { once: true });
  }

  function updateHoverPreview(card, thumb, video, event) {
    if (!card.classList.contains("previewing") || !video.duration) return;
    const preview = thumb.querySelector(".hover-video");
    if (!preview) return;
    const fraction = getPointerFraction(thumb, event);
    preview.dataset.pendingFraction = String(fraction);
    const timeLabel = thumb.querySelector(".preview-time");
    if (timeLabel) timeLabel.textContent = formatTime(video.duration * fraction);
    if (!Number.isFinite(preview.duration) || !preview.duration) return;
    const target = Math.min(preview.duration - .05, Math.max(0, fraction * preview.duration));
    preview.dataset.pendingTime = String(target);
    if (Math.abs(preview.currentTime - target) > 1.25 && !preview.seeking) {
      try { preview.currentTime = target; } catch { /* Browser may not seek until metadata is ready. */ }
    }
  }

  function endHoverPreview(card) {
    ++hoverGeneration;
    card.classList.remove("previewing");
    const preview = card.querySelector(".hover-video");
    if (preview) {
      preview.pause();
      preview.removeAttribute("src");
      preview.load();
    }
  }

  function toggleLater(video) {
    const saved = getSaved(video);
    savedState[video.key] = { ...saved, later: !saved.later };
    persistState();
    updateLibrary();
    if (video === activeVideo) updateLaterButton();
  }

  function updateLaterButton() {
    const saved = activeVideo ? getSaved(activeVideo) : { later: false };
    const button = byId("player-later");
    button.classList.toggle("saved", saved.later);
    button.querySelector(".button-label").textContent = saved.later ? "Saved to Watch later" : "Save to Watch later";
    button.title = saved.later ? "Remove from watch later" : "Add to watch later";
    button.setAttribute("aria-label", button.title);
  }

  // Recommendations use title/path token overlap and shared folders as lightweight local signals.
  function videoTokens(video) {
    const ignored = new Set(["the", "and", "for", "with", "from", "this", "that", "video", "clip", "final", "copy"]);
    return new Set(`${video.title} ${video.path}`.toLocaleLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 2 && !ignored.has(token)));
  }

  function recommendationScore(source, candidate) {
    const sourceTokens = videoTokens(source);
    const candidateTokens = videoTokens(candidate);
    let score = 0;
    for (const token of candidateTokens) {
      if (sourceTokens.has(token)) score += source.title.toLocaleLowerCase().includes(token) ? 3 : 1;
    }
    const sourceFolder = source.path.includes("/") ? source.path.slice(0, source.path.lastIndexOf("/")) : "";
    const candidateFolder = candidate.path.includes("/") ? candidate.path.slice(0, candidate.path.lastIndexOf("/")) : "";
    if (sourceFolder && sourceFolder === candidateFolder) score += 2;
    return score;
  }

  function renderRecommendations(source) {
    const recommendations = videos
      .filter(video => video !== source)
      .map(video => ({ video, score: recommendationScore(source, video) }))
      .sort((a, b) => b.score - a.score || b.video.file.lastModified - a.video.file.lastModified);
    const list = byId("recommendation-list");
    list.replaceChildren();
    byId("recommendation-count").textContent = recommendations.length ? `${recommendations.length} videos` : "";
    byId("no-recommendations").hidden = recommendations.length !== 0;
    recommendations.forEach(({ video, score }) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "recommendation-card";
      card.setAttribute("aria-label", `Play ${video.title}`);
      const thumbnail = document.createElement("span");
      thumbnail.className = "recommendation-thumb";
      if (video.thumbnail) {
        const image = document.createElement("img");
        image.src = video.thumbnail;
        image.alt = "";
        thumbnail.append(image);
      }
      const duration = document.createElement("span");
      duration.className = "duration-badge";
      duration.textContent = video.duration ? formatTime(video.duration) : "--:--";
      thumbnail.append(duration);
      const copy = document.createElement("span");
      copy.className = "recommendation-copy";
      const title = document.createElement("span");
      title.className = "recommendation-title";
      title.textContent = video.title;
      const details = document.createElement("span");
      details.className = "recommendation-meta";
      details.textContent = video.path.includes("/")
        ? video.path.slice(0, video.path.lastIndexOf("/"))
        : "Local video";
      const extra = document.createElement("span");
      extra.className = "recommendation-meta";
      extra.textContent = score ? "Similar title or folder" : formatSize(video.file.size);
      copy.append(title, details, extra);
      card.append(thumbnail, copy);
      card.addEventListener("click", () => openPlayer(video));
      list.append(card);
    });
  }

  function updatePlaybackUI() {
    const duration = Number.isFinite(player.duration) ? player.duration : 0;
    const currentTime = Number.isFinite(player.currentTime) ? player.currentTime : 0;
    const progress = duration ? Math.min(100, (currentTime / duration) * 100) : 0;
    byId("seek-played").style.width = `${progress}%`;
    byId("seek-thumb").style.left = `${progress}%`;
    seekTrack.setAttribute("aria-valuenow", String(Math.round(progress)));
    seekTrack.setAttribute("aria-valuetext", `${formatTime(currentTime)} of ${formatTime(duration)}`);
    byId("current-time").textContent = formatTime(currentTime);
    byId("duration-time").textContent = formatTime(duration);
    if (player.buffered.length && duration) {
      const bufferedEnd = player.buffered.end(player.buffered.length - 1);
      byId("seek-buffered").style.width = `${Math.min(100, (bufferedEnd / duration) * 100)}%`;
    } else {
      byId("seek-buffered").style.width = "0%";
    }
    const playing = !player.paused && !player.ended;
    byId("play-toggle").classList.toggle("is-playing", playing);
    byId("play-toggle").setAttribute("aria-label", playing ? "Pause" : "Play");
    byId("play-toggle").title = playing ? "Pause (Space)" : "Play (Space)";
    byId("center-play").setAttribute("aria-label", playing ? "Pause video" : "Play video");
    playerShell.classList.toggle("paused", !playing);
    byId("volume-slider").value = String(player.muted ? 0 : player.volume);
    byId("volume-slider").style.setProperty("--volume", `${(player.muted ? 0 : player.volume) * 100}%`);
    byId("volume-toggle").setAttribute("aria-label", player.muted || player.volume === 0 ? "Unmute" : "Mute");
    byId("volume-toggle").title = player.muted || player.volume === 0 ? "Unmute (M)" : "Mute (M)";
    byId("volume-toggle").classList.toggle("muted", player.muted || player.volume === 0);
  }

  // Seek-bar helpers keep pointer and keyboard seeking in sync with the preview frame.
  function seekToPointer(event) {
    if (!Number.isFinite(player.duration) || !player.duration) return 0;
    const rect = seekTrack.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const target = fraction * player.duration;
    if (playingSegment && (target < playingSegment.start || target >= playingSegment.end)) playingSegment = null;
    player.currentTime = target;
    return fraction;
  }

  function positionSeekPreview(event) {
    const rect = seekTrack.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const duration = Number.isFinite(player.duration) ? player.duration : 0;
    const target = fraction * duration;
    const shellRect = playerShell.getBoundingClientRect();
    const left = Math.max(80, Math.min(shellRect.width - 80, event.clientX - shellRect.left));
    seekPreview.style.left = `${left}px`;
    seekPreviewVideo.dataset.pendingTime = String(target);
    byId("seek-preview-time").textContent = formatTime(target);
    seekPreview.hidden = false;
    if (duration && seekPreviewVideo.readyState >= HTMLMediaElement.HAVE_METADATA &&
        Math.abs(seekPreviewVideo.currentTime - target) > 0.8 && !seekPreviewVideo.seeking) {
      try { seekPreviewVideo.currentTime = Math.min(duration - 0.05, target); } catch { /* Wait for another pointer movement. */ }
    }
  }

  seekPreviewVideo.addEventListener("loadedmetadata", () => {
    const target = Number(seekPreviewVideo.dataset.pendingTime);
    if (seekPreview.hidden || !Number.isFinite(target) || !seekPreviewVideo.duration) return;
    try { seekPreviewVideo.currentTime = Math.min(seekPreviewVideo.duration - 0.05, Math.max(0, target)); } catch { /* Wait for another pointer movement. */ }
  });
  seekPreviewVideo.addEventListener("seeked", () => {
    const target = Number(seekPreviewVideo.dataset.pendingTime);
    if (seekPreview.hidden || !Number.isFinite(target) || Math.abs(seekPreviewVideo.currentTime - target) < 0.8 || seekPreviewVideo.seeking) return;
    try { seekPreviewVideo.currentTime = Math.min(seekPreviewVideo.duration - 0.05, Math.max(0, target)); } catch { /* Wait for another pointer movement. */ }
  });

  function revealControls() {
    playerShell.classList.remove("controls-hidden");
    clearTimeout(controlsTimer);
    if (!player.paused) {
      controlsTimer = setTimeout(() => {
        if (!player.paused && !playerShell.matches(":focus-within")) {
          playerShell.classList.add("controls-hidden");
        }
      }, 2400);
    }
  }

  function togglePlayback() {
    if (player.paused) player.play().catch(() => {});
    else player.pause();
    revealControls();
  }

  function updateFullscreenButton() {
    const fullscreen = document.fullscreenElement === playerShell;
    const button = byId("fullscreen-toggle");
    button.setAttribute("aria-label", fullscreen ? "Exit full screen" : "Full screen");
    button.title = fullscreen ? "Exit full screen (F)" : "Full screen (F)";
    button.querySelector("use").setAttribute("href", fullscreen ? "#icon-fullscreen-exit" : "#icon-fullscreen");
  }

  // Subtitle files are converted to WebVTT when needed and their temporary URL is revoked on replacement.
  function clearSubtitleTrack() {
    const track = byId("user-subtitle");
    if (track) track.remove();
    if (subtitleUrl) URL.revokeObjectURL(subtitleUrl);
    subtitleUrl = "";
    const selector = byId("subtitle-track");
    selector.replaceChildren(new Option("Subtitles off", ""));
    selector.disabled = true;
    byId("subtitle-status").textContent = "";
  }

  function srtToWebVtt(contents) {
    const cues = contents.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim()
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
    return `WEBVTT\n\n${cues}\n`;
  }

  byId("subtitle-input").addEventListener("change", async event => {
    const file = event.target.files && event.target.files[0];
    const targetVideo = activeVideo;
    event.target.value = "";
    if (!file || !targetVideo) return;
    if (!/\.(vtt|srt)$/i.test(file.name)) {
      byId("subtitle-status").textContent = "Choose a .vtt or .srt subtitle file.";
      return;
    }
    try {
      const contents = await file.text();
      if (activeVideo !== targetVideo) return;
      const webVtt = /\.srt$/i.test(file.name) ? srtToWebVtt(contents) : contents.replace(/^\uFEFF/, "");
      clearSubtitleTrack();
      const track = document.createElement("track");
      track.id = "user-subtitle";
      track.kind = "subtitles";
      track.label = file.name;
      track.srclang = "en";
      subtitleUrl = URL.createObjectURL(new Blob([webVtt], { type: "text/vtt" }));
      track.src = subtitleUrl;
      track.onerror = () => {
        if (!track.isConnected) return;
        byId("subtitle-status").textContent = "The subtitle file could not be loaded. Check that it is valid WebVTT or SubRip text.";
      };
      player.append(track);
      const selector = byId("subtitle-track");
      selector.replaceChildren(new Option("Subtitles off", ""), new Option(file.name, "on"));
      selector.disabled = false;
      selector.value = "on";
      track.track.mode = "showing";
      byId("subtitle-status").textContent = `Subtitles loaded: ${file.name}`;
    } catch (error) {
      console.warn("Could not read the selected subtitle file.", error);
      byId("subtitle-status").textContent = "The subtitle file could not be read.";
    }
  });
  byId("subtitle-track").addEventListener("change", event => {
    const track = byId("user-subtitle");
    if (track) track.track.mode = event.target.value ? "showing" : "disabled";
  });

  byId("video-title-form").addEventListener("submit", event => {
    event.preventDefault();
    saveCustomTitle(byId("custom-video-title").value);
  });
  byId("reset-video-title").addEventListener("click", () => saveCustomTitle(""));
  byId("set-thumbnail").addEventListener("click", setThumbnailFromCurrentFrame);
  byId("reset-thumbnail").addEventListener("click", resetCustomThumbnail);
  byId("segment-mark-start").addEventListener("click", () => markSegmentBoundary("start"));
  byId("segment-mark-end").addEventListener("click", () => markSegmentBoundary("end"));
  byId("save-segment").addEventListener("click", saveSegment);

  // Player lifecycle owns progress saving, active subtitle cleanup, and temporary video sources.
  function openPlayer(video, keepQueue = false) {
    if (activeVideo && activeVideo !== video) savePlaybackProgress();
    if (activeVideo !== video) clearSubtitleTrack();
    if (activeVideo !== video) lastProgressSave = -1;
    pendingSegmentStart = null;
    pendingSegmentEnd = null;
    playingSegment = null;
    player.pause();
    if (!keepQueue) initializeQueue(video);
    else queueIndex = playQueue.indexOf(video);
    activeVideo = video;
    byId("segment-start-time").textContent = "Start not set";
    byId("segment-end-time").textContent = "End not set";
    byId("save-segment").disabled = true;
    byId("player-title").textContent = video.title;
    byId("custom-video-title").value = metadataFor(video).title || video.file.name.replace(VIDEO_EXTENSIONS, "");
    byId("player-file-info").textContent = video.path;
    updateVideoDetails(video);
    renderVideoSegments();
    byId("player-description").textContent = `Playing from your local folder${video.path.includes("/") ? ` · ${video.path.slice(0, video.path.lastIndexOf("/"))}` : ""}. This file stays on your device.`;
    byId("player-error").hidden = true;
    playerShell.classList.remove("error", "controls-hidden");
    player.currentTime = 0;
    player.src = video.url;
    seekPreviewVideo.src = video.url;
    seekPreviewVideo.load();
    byId("seek-played").style.width = "0%";
    byId("seek-buffered").style.width = "0%";
    byId("current-time").textContent = formatTime(0);
    byId("duration-time").textContent = video.duration ? formatTime(video.duration) : "--:--";
    player.playbackRate = Number(byId("playback-speed").value);
    byId("watch-page").classList.toggle("theater", byId("theater-toggle").getAttribute("aria-pressed") === "true");
    playerModal.hidden = false;
    document.body.style.overflow = "hidden";
    updateLaterButton();
    updateQueueControls();
    renderRecommendations(video);
    player.onloadedmetadata = () => {
      const saved = getSaved(video);
      if (saved.currentTime > 5 && (!video.duration || saved.currentTime < video.duration - 3)) {
        try { player.currentTime = saved.currentTime; } catch (error) { console.info("Could not resume video at saved position.", error); }
      }
      if (Number.isFinite(player.duration) && player.duration > 0) video.duration = player.duration;
      video.width = player.videoWidth || video.width;
      video.height = player.videoHeight || video.height;
      updateVideoDetails(video);
      updatePlaybackUI();
    };
    player.onerror = () => {
      byId("player-error").hidden = false;
      playerShell.classList.add("error");
    };
    player.play().catch(() => {});
    updatePlaybackUI();
    revealControls();
  }

  function closePlayer() {
    if (playerModal.hidden) return;
    if (activeVideo) savePlaybackProgress();
    clearTimeout(controlsTimer);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    player.pause();
    player.removeAttribute("src");
    player.load();
    seekPreviewVideo.pause();
    seekPreviewVideo.removeAttribute("src");
    seekPreviewVideo.load();
    clearSubtitleTrack();
    playerModal.hidden = true;
    document.body.style.overflow = "";
    byId("watch-page").classList.remove("theater");
    const theaterToggle = byId("theater-toggle");
    theaterToggle.setAttribute("aria-pressed", "false");
    theaterToggle.setAttribute("aria-label", "Theater mode");
    theaterToggle.title = "Theater mode (T)";
    theaterToggle.querySelector(".button-label").textContent = "Theater";
    theaterToggle.querySelector("use").setAttribute("href", "#icon-theater");
    activeVideo = null;
    playingSegment = null;
    updateLibrary();
  }

  function savePlaybackProgress() {
    if (!activeVideo || !Number.isFinite(player.currentTime)) return;
    const old = getSaved(activeVideo);
    const duration = Number.isFinite(player.duration) ? player.duration : activeVideo.duration;
    const watched = player.ended || (duration > 0 && player.currentTime >= duration - 5);
    savedState[activeVideo.key] = {
      ...old,
      currentTime: watched ? 0 : player.currentTime,
      watched: watched || old.watched
    };
    if (duration > 0) activeVideo.duration = duration;
    persistState();
  }

  // Player event wiring: controls, seeking, keyboard shortcuts, and periodic progress persistence.
  byId("close-player").addEventListener("click", closePlayer);
  byId("player-later").addEventListener("click", () => {
    if (activeVideo) toggleLater(activeVideo);
  });
  byId("play-toggle").addEventListener("click", togglePlayback);
  byId("center-play").addEventListener("click", togglePlayback);
  byId("previous-video").addEventListener("click", () => skipVideo(-1));
  byId("next-video").addEventListener("click", () => skipVideo(1));
  byId("queue-shuffle").addEventListener("click", toggleQueueShuffle);
  player.addEventListener("click", togglePlayback);
  player.addEventListener("play", updatePlaybackUI);
  player.addEventListener("pause", updatePlaybackUI);
  player.addEventListener("durationchange", updatePlaybackUI);
  player.addEventListener("progress", updatePlaybackUI);
  player.addEventListener("volumechange", updatePlaybackUI);
  player.addEventListener("timeupdate", updatePlaybackUI);
  playerShell.addEventListener("pointermove", revealControls);
  playerShell.addEventListener("pointerenter", revealControls);
  playerShell.addEventListener("pointerleave", () => {
    if (!player.paused && !playerShell.matches(":focus-within")) playerShell.classList.add("controls-hidden");
  });
  byId("volume-slider").addEventListener("input", event => {
    player.volume = Number(event.target.value);
    player.muted = player.volume === 0;
    if (player.volume > 0) lastVolume = player.volume;
  });
  byId("volume-toggle").addEventListener("click", () => {
    if (player.muted || player.volume === 0) {
      player.muted = false;
      player.volume = lastVolume || 1;
    } else {
      lastVolume = player.volume;
      player.muted = true;
    }
  });
  seekTrack.addEventListener("pointerdown", event => {
    draggingSeek = true;
    seekTrack.setPointerCapture(event.pointerId);
    seekToPointer(event);
    positionSeekPreview(event);
  });
  seekTrack.addEventListener("pointermove", event => {
    positionSeekPreview(event);
    if (draggingSeek) seekToPointer(event);
  });
  seekTrack.addEventListener("pointerup", event => {
    if (draggingSeek) seekToPointer(event);
    draggingSeek = false;
    if (!seekTrack.matches(":hover")) seekPreview.hidden = true;
  });
  seekTrack.addEventListener("pointerleave", () => {
    if (!draggingSeek) seekPreview.hidden = true;
  });
  seekTrack.addEventListener("keydown", event => {
    const offsets = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5, PageDown: -30, PageUp: 30 };
    if (event.key in offsets && Number.isFinite(player.duration)) {
      event.preventDefault();
      event.stopPropagation();
      player.currentTime = Math.max(0, Math.min(player.duration, player.currentTime + offsets[event.key]));
    } else if (event.key === "Home") {
      event.stopPropagation();
      player.currentTime = 0;
    } else if (event.key === "End" && Number.isFinite(player.duration)) {
      event.stopPropagation();
      player.currentTime = player.duration;
    }
  });
  byId("theater-toggle").addEventListener("click", event => {
    const enabled = event.currentTarget.getAttribute("aria-pressed") !== "true";
    event.currentTarget.setAttribute("aria-pressed", String(enabled));
    event.currentTarget.setAttribute("aria-label", enabled ? "Exit theater mode" : "Theater mode");
    event.currentTarget.title = enabled ? "Exit theater mode (T)" : "Theater mode (T)";
    event.currentTarget.querySelector(".button-label").textContent = enabled ? "Exit theater" : "Theater";
    event.currentTarget.querySelector("use").setAttribute("href", enabled ? "#icon-theater-exit" : "#icon-theater");
    byId("watch-page").classList.toggle("theater", enabled);
    event.currentTarget.focus();
  });
  byId("fullscreen-toggle").addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(error => console.warn("Could not exit fullscreen.", error));
    else playerShell.requestFullscreen?.().catch(error => console.warn("Could not enter fullscreen.", error));
  });
  document.addEventListener("fullscreenchange", updateFullscreenButton);
  byId("playback-speed").addEventListener("change", event => {
    player.playbackRate = Number(event.target.value);
  });
  player.addEventListener("timeupdate", () => {
    if (!activeVideo) return;
    if (playingSegment && playingSegment.videoKey === activeVideo.key && player.currentTime >= playingSegment.end) {
      const segmentEnd = playingSegment.end;
      playingSegment = null;
      player.pause();
      player.currentTime = segmentEnd;
    }
    const saved = getSaved(activeVideo);
    savedState[activeVideo.key] = { ...saved, currentTime: player.currentTime };
    const second = Math.floor(player.currentTime);
    if (second % 5 === 0 && second !== lastProgressSave) {
      lastProgressSave = second;
      persistState();
    }
  });
  player.addEventListener("ended", () => {
    savePlaybackProgress();
    updateLibrary();
    if (queueIndex >= 0 && queueIndex < playQueue.length - 1) skipVideo(1);
  });
  player.addEventListener("error", () => {
    if (player.currentSrc) byId("player-error").hidden = false;
  });

  document.addEventListener("keydown", event => {
    if (playerModal.hidden) return;
    if (event.key === "Escape") {
      closePlayer();
      return;
    }
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLButtonElement) return;
    if (event.key === " " || event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (player.paused) player.play().catch(() => {});
      else player.pause();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      player.currentTime = Math.max(0, player.currentTime - 5);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      player.currentTime = Math.min(player.duration || Infinity, player.currentTime + 5);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      player.volume = Math.min(1, player.volume + .05);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      player.volume = Math.max(0, player.volume - .05);
    } else if (event.key.toLowerCase() === "m") {
      player.muted = !player.muted;
    } else if (event.key.toLowerCase() === "f") {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else playerShell.requestFullscreen?.().catch(error => console.warn("Could not enter fullscreen.", error));
    } else if (event.key.toLowerCase() === "t") {
      byId("theater-toggle").click();
    }
  });

  window.addEventListener("beforeunload", () => {
    if (activeVideo) savePlaybackProgress();
    objectUrls.forEach(URL.revokeObjectURL);
  });
  // Rebuild persistent playlist navigation before restoring the selected video files.
  renderPlaylists();
  restoreLibrary();
})();
