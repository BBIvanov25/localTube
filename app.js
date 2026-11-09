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
  const supportsWebkitDirectoryInput = "webkitdirectory" in HTMLInputElement.prototype;
  const supportsWritableDirectoryPicker = typeof window.showDirectoryPicker === "function";
  const isDesktopApp = Boolean(window.__TAURI_INTERNALS__);
  const platformLabel = isDesktopApp ? "app" : "browser";
  const storageLabel = isDesktopApp ? "the app" : "this browser";
  const mediaSessionLabel = isDesktopApp ? "this app session" : "this browser tab session";
  const tauriInvoke = isDesktopApp && typeof window.__TAURI_INTERNALS__.invoke === "function"
    ? window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__)
    : null;
  let videos = [];
  let activeFilter = "all";
  let activeVideo = null;
  let objectUrls = [];
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
  let metadataDirectoryHandle = null;
  let metadataSidecarWriteQueue = Promise.resolve();
  let loadingVideosTotal = 0;
  let videoMetadataObserver = null;
  let metadataWorker = null;
  let metadataQueue = [];
  let metadataProcessing = false;
  let metadataGeneration = 0;
  let cancelActiveMetadataLoad = null;
  let generatedMetadataDirty = false;
  let metadataFallbackScroll = null;
  let lanSharingStarted = false;
  let lanPreparationTimer = 0;
  const lanPreparingKeys = new Set();

  if (!supportsWebkitDirectoryInput) {
    fileInput.removeAttribute("webkitdirectory");
    fileInput.removeAttribute("directory");
  }

  function shareableFilePaths() {
    return Object.fromEntries(videos.map(video => [
      video.key,
      typeof video.file.path === "string" && (/^[a-zA-Z]:[\\/]/.test(video.file.path) || video.file.path.startsWith("\\\\")) ? video.file.path : ""
    ]).filter(([, path]) => path));
  }
  if (!supportsWebkitDirectoryInput && !supportsWritableDirectoryPicker) {
    byId("choose-folder").querySelector(".button-label").textContent = "Choose videos";
    byId("welcome-choose").querySelector(".button-label").textContent = "Choose video files";
    byId("support-note").textContent = `Select multiple video files at once; folder selection is unavailable in this ${platformLabel}.`;
  }
  if (supportsWritableDirectoryPicker) {
    byId("support-note").textContent = "Choose a folder to automatically save metadata beside your videos. Video format support varies.";
  } else {
    byId("support-note").textContent += ` Metadata stays in ${storageLabel}; use Export metadata for a portable copy.`;
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
      showStatus(`Playlist changes could not be saved in ${storageLabel}.`);
    }
  }

  function persistState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(savedState));
    } catch (error) {
      console.warn("Could not save LocalTube progress.", error);
      showStatus(`Playback progress could not be saved in ${storageLabel}.`);
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

  function updateLanSharingControls(message = "") {
    const container = byId("lan-sharing");
    if (!container) return;
    container.hidden = !isDesktopApp;
    byId("start-lan-sharing").hidden = lanSharingStarted;
    byId("stop-lan-sharing").hidden = !lanSharingStarted;
    byId("lan-sharing-status").textContent = message;
  }

  async function startLanSharing() {
    if (!tauriInvoke || !videos.length) return;
    const password = window.prompt("Choose a password for LAN sharing (at least 4 characters):", "");
    if (password === null) return;
    if (password.trim().length < 4) {
      updateLanSharingControls("Use a password with at least 4 characters.");
      return;
    }
    try {
      const result = await tauriInvoke("start_lan_share", {
        password,
        libraryJson: JSON.stringify(shareableLibrary()),
        filePathsJson: JSON.stringify(shareableFilePaths())
      });
      lanSharingStarted = true;
      startLanPreparationPolling();
      const urls = Array.isArray(result.urls) && result.urls.length ? result.urls : [result.url];
      updateLanSharingControls(`Open ${urls.join(" or ")} on another device. If it does not open, allow LocalTube through Windows Firewall on private networks.`);
    } catch (error) {
      console.warn("Could not start LAN sharing.", error);
      updateLanSharingControls(typeof error === "string" ? error : error.message || "LAN sharing could not be started.");
    }
  }

  async function stopLanSharing() {
    if (!tauriInvoke || !lanSharingStarted) return;
    try {
      await tauriInvoke("stop_lan_share");
      lanSharingStarted = false;
      clearInterval(lanPreparationTimer);
      lanPreparationTimer = 0;
      lanPreparingKeys.clear();
      updateLanSharingControls("LAN sharing stopped.");
    } catch (error) {
      console.warn("Could not stop LAN sharing.", error);
      updateLanSharingControls(error.message || "LAN sharing could not be stopped.");
    }

  }

  function startLanPreparationPolling() {
    clearInterval(lanPreparationTimer);
    lanPreparationTimer = window.setInterval(async () => {
      if (!lanSharingStarted || !tauriInvoke) return;
      try {
        const requests = await tauriInvoke("get_lan_prepare_requests");
        for (const request of requests) {
          if (!lanPreparingKeys.has(request.key)) prepareLanVideo(request);
        }
      } catch (error) {
        console.warn("Could not check LAN video preparation requests.", error);
      }
    }, 500);
  }

  async function prepareLanVideo(request) {
    const video = videos.find(item => item.key === request.key);
    if (!video || !(video.file instanceof Blob)) return;
    lanPreparingKeys.add(request.key);
    try {
      updateLanSharingControls(`Streaming "${video.title}" segment ${request.start}-${request.end}…`);
      const bytes = new Uint8Array(await video.file.slice(request.start, request.end + 1).arrayBuffer());
      const extension = video.file.name.includes(".") ? video.file.name.slice(video.file.name.lastIndexOf(".")) : ".video";
      const fileName = `${request.key.replace(/[^a-z0-9_-]/gi, "").slice(0, 40)}${extension}`;
      await tauriInvoke("stage_lan_share_file", {
        key: request.key,
        fileName,
        offset: request.start,
        totalSize: video.file.size,
        data: Array.from(bytes)
      });
      updateLanSharingControls("LAN sharing is active.");
    } catch (error) {
      console.warn("Could not prepare the requested LAN video.", error);
      updateLanSharingControls(typeof error === "string" ? error : error.message || "A requested LAN video could not be prepared.");
    } finally {
      lanPreparingKeys.delete(request.key);
    }
  }

  function stableKey(file, path = file.webkitRelativePath || file.name) {
    return `${path}|${file.size}|${file.lastModified}`;
  }

  // Keep selected file data in IndexedDB; object URLs are created only for the current page session.
  function openMediaDatabase() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error(`This ${platformLabel} does not support persistent local video storage.`));
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
      showStatus(`Video metadata could not be saved in ${storageLabel}. Export a metadata file to keep a portable copy.`);
      throw error;
    });
  }

  function readPersistedDirectoryHandle() {
    return openMediaDatabase().then(database => new Promise((resolve, reject) => {
      const transaction = database.transaction(METADATA_STORE, "readonly");
      const request = transaction.objectStore(METADATA_STORE).get("metadata-directory");
      request.onsuccess = () => resolve(request.result?.value || null);
      request.onerror = () => reject(request.error || new Error("Could not restore the selected video folder."));
      transaction.oncomplete = () => database.close();
      transaction.onerror = () => {
        database.close();
        reject(transaction.error || new Error("Could not restore the selected video folder."));
      };
    }));
  }

  function persistDirectoryHandle(handle) {
    return openMediaDatabase().then(database => new Promise((resolve, reject) => {
      const transaction = database.transaction(METADATA_STORE, "readwrite");
      const store = transaction.objectStore(METADATA_STORE);
      if (handle) store.put({ key: "metadata-directory", value: handle });
      else store.delete("metadata-directory");
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error || new Error("Could not save the selected video folder."));
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error || new Error("Could not save the selected video folder."));
      };
    }));
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

  function storePersistedMedia(entries) {
    const records = entries.map(({ file, path }) => ({
      key: stableKey(file, path),
      blob: file,
      name: file.name,
      type: file.type,
      lastModified: file.lastModified,
      path
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
        reject(transaction.error || new Error(`The ${platformLabel} could not store these videos.`));
      };
    }));
    const operation = mediaWriteQueue.then(write);
    mediaWriteQueue = operation.catch(error => {
      console.warn("Could not persist LocalTube video files.", error);
    });
    return operation;
  }

  function retainLoadedMedia(entries, generation) {
    if (isDesktopApp) {
      persistenceNotice = "";
      showStatus(`Video files are available for this ${platformLabel} session.`);
      processNextVideoMetadata(metadataGeneration);
      return;
    }
    persistenceNotice = `Saving video files for ${mediaSessionLabel}…`;
    showStatus(persistenceNotice);
    Promise.resolve().then(() => storePersistedMedia(entries)).then(() => {
      if (generation !== selectionGeneration) return;
      persistenceNotice = "";
      showStatus(`Video files are saved for ${mediaSessionLabel} and will be available after a refresh.`);
      processNextVideoMetadata(metadataGeneration);
    }).catch(error => {
      console.warn("The selected videos could not be retained after refresh.", error);
      if (generation !== selectionGeneration) return;
      persistenceNotice = `Videos are available for this visit, but the ${platformLabel} could not retain them after refresh. Check available storage and ${platformLabel} permissions.`;
      showStatus(persistenceNotice);
      processNextVideoMetadata(metadataGeneration);
    });
  }

  function clearPersistedMedia(clearMetadata = true) {
    const clear = () => openMediaDatabase().then(database => new Promise((resolve, reject) => {
      const storeNames = clearMetadata ? [MEDIA_STORE, METADATA_STORE] : [MEDIA_STORE];
      let transaction;
      try {
        transaction = database.transaction(storeNames, "readwrite");
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
        storeNames.forEach(name => transaction.objectStore(name).clear());
      } catch (error) {
        database.close();
        reject(error);
      }
    }));
    const operation = mediaWriteQueue.then(clear);
    mediaWriteQueue = operation.catch(error => console.warn("Could not clear the local video library.", error));
    return operation;
  }

  function isPageRefresh() {
    const navigation = performance.getEntriesByType("navigation")[0];
    return navigation ? navigation.type === "reload" : performance.navigation?.type === 1;
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
    const validThumbnail = thumbnail => typeof thumbnail === "string" &&
      /^data:image\/jpeg;base64,[\da-z+/=]+$/i.test(thumbnail) &&
      thumbnail.length <= 1_000_000 ? thumbnail : "";
    return {
      title: typeof record.title === "string" ? record.title.slice(0, 160) : "",
      segments,
      thumbnail: validThumbnail(record.thumbnail),
      defaultThumbnail: validThumbnail(record.defaultThumbnail),
      duration: Number.isFinite(record.duration) && record.duration > 0 ? Math.min(record.duration, 1_000_000_000) : 0,
      width: Number.isInteger(record.width) && record.width > 0 && record.width <= 100_000 ? record.width : 0,
      height: Number.isInteger(record.height) && record.height > 0 && record.height <= 100_000 ? record.height : 0,
      mediaMetadataLoaded: record.mediaMetadataLoaded === true
    };
  }

  function hasVideoMetadata(record) {
    return Boolean(record && (
      record.title || record.segments.length || record.thumbnail || record.defaultThumbnail ||
      record.duration || record.width || record.height
    ));
  }

  function metadataFor(video) {
    return videoMetadata[video.key] || {
      title: "",
      segments: [],
      thumbnail: "",
      defaultThumbnail: "",
      duration: 0,
      width: 0,
      height: 0,
      mediaMetadataLoaded: false
    };
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
    saveMetadataSidecar();
    publishLanMetadata();
  }

  function shareableLibrary() {
    return videos.map(video => ({
      key: video.key,
      path: video.path,
      title: video.title,
      duration: video.duration || 0,
      width: video.width || 0,
      height: video.height || 0,
      size: video.file.size || 0,
      modified: video.file.lastModified || 0,
      thumbnail: video.thumbnail || ""
    }));
  }

  async function publishLanMetadata() {
    if (!tauriInvoke || !lanSharingStarted) return;
    try {
      await tauriInvoke("update_lan_share_metadata", { libraryJson: JSON.stringify(shareableLibrary()) });
    } catch (error) {
      console.warn("Could not refresh LAN sharing metadata.", error);
    }
  }

  function serializeVideoMetadata(onlyVideos = null) {
    const records = {};
    const entries = onlyVideos
      ? onlyVideos.map(video => [video.key, videoMetadata[video.key]])
      : Object.entries(videoMetadata);
    entries.forEach(([key, record]) => {
      const cleanRecord = sanitizeVideoMetadata(record);
      if (hasVideoMetadata(cleanRecord)) records[key] = cleanRecord;
    });
    return JSON.stringify({ format: METADATA_FORMAT, version: 1, videos: records }, null, 2);
  }

  function saveMetadataSidecar() {
    if (!metadataDirectoryHandle) return Promise.resolve();
    const directoryHandle = metadataDirectoryHandle;
    const contents = serializeVideoMetadata(videos);
    const operation = metadataSidecarWriteQueue.then(async () => {
      const permission = await directoryHandle.queryPermission({ mode: "readwrite" });
      if (permission !== "granted") {
        throw new Error("Write permission for the selected video folder is no longer available.");
      }
      const fileHandle = await directoryHandle.getFileHandle(METADATA_FILE, { create: true });
      const writable = await fileHandle.createWritable();
      try {
        await writable.write(contents);
        await writable.close();
      } catch (error) {
        try {
          await writable.abort();
        } catch (abortError) {
          console.warn("Could not discard the incomplete LocalTube metadata sidecar.", abortError);
        }
        throw error;
      }
    });
    metadataSidecarWriteQueue = operation.catch(error => {
      console.warn("Could not save the LocalTube metadata sidecar.", error);
      showStatus("Metadata could not be saved beside the videos. Check folder permissions or use Export metadata.");
    });
    return metadataSidecarWriteQueue;
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
        const existing = sanitizeVideoMetadata(videoMetadata[key]) || metadataFor({ key });
        videoMetadata[key] = {
          title: cleanRecord.title || existing.title,
          segments: cleanRecord.segments.length ? cleanRecord.segments : existing.segments,
          thumbnail: cleanRecord.thumbnail || existing.thumbnail,
          defaultThumbnail: cleanRecord.defaultThumbnail || existing.defaultThumbnail,
          duration: cleanRecord.duration || existing.duration,
          width: cleanRecord.width || existing.width,
          height: cleanRecord.height || existing.height,
          mediaMetadataLoaded: cleanRecord.mediaMetadataLoaded || existing.mediaMetadataLoaded
        };
      }
    });
    try { await persistVideoMetadata(); } catch { /* Keep imported metadata available for this session and export. */ }
    videos.forEach(applyVideoMetadata);
    if (!playerModal.hidden && activeVideo) refreshPlayerMetadata();
    updateLibrary();
    if (notify) saveMetadataSidecar();
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
      key: stableKey(file, path),
      title: file.name.replace(VIDEO_EXTENSIONS, ""),
      path,
      duration: 0,
      width: 0,
      height: 0,
      thumbnail: "",
      customThumbnail: "",
      defaultThumbnail: "",
      mediaMetadataLoaded: false,
      metadataPending: false,
      metadataError: false,
      thumbnailError: false,
      segments: [],
    };
    applyVideoMetadata(video);
    return video;
  }

  function applyVideoMetadata(video) {
    const metadata = metadataFor(video);
    video.title = metadata.title || video.file.name.replace(VIDEO_EXTENSIONS, "");
    video.customThumbnail = metadata.thumbnail || "";
    video.defaultThumbnail = metadata.defaultThumbnail || "";
    video.thumbnail = video.customThumbnail || video.defaultThumbnail;
    video.duration = metadata.duration || 0;
    video.width = metadata.width || 0;
    video.height = metadata.height || 0;
    video.mediaMetadataLoaded = Boolean(metadata.mediaMetadataLoaded || video.duration);
    video.segments = metadata.segments;
  }

  function releaseCurrentMedia() {
    stopVideoMetadataLoading();
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
    renderPlaylists();
    welcome.hidden = true;
    library.hidden = false;
    searchInput.value = "";
    updateLibrary();
    buildVideoMetadataObserver();
  }

  function appendLibraryVideos(nextVideos) {
    nextVideos.forEach(video => {
      const loaded = makeVideo(video.file, video.path);
      objectUrls.push(loaded.url);
      videos.push(loaded);
    });
    renderPlaylists();
    // During the default import view, keep existing cards in place and append
    // just the new batch. Rebuilding and sorting the entire grid for every
    // batch made large libraries progressively slower to load.
    if (activeFilter === "all" && !searchInput.value.trim() && byId("sort").value === "name") {
      const fragment = document.createDocumentFragment();
      videos.slice(-nextVideos.length).forEach(video => fragment.append(createCard(video)));
      grid.append(fragment);
      byId("all-count").textContent = loadingVideosTotal ? `${videos.length}/${loadingVideosTotal}` : videos.length || "";
      byId("library-subtitle").textContent = loadingVideosTotal
        ? `${videos.length} of ${loadingVideosTotal} videos loaded`
        : `${videos.length} ${videos.length === 1 ? "video" : "videos"}`;
      byId("forget-library").hidden = videos.length === 0;
      byId("no-results").hidden = videos.length !== 0;
    } else {
      updateLibrary();
    }
    observeVisibleVideoMetadata();
  }

  async function restoreLibrary() {
    let metadataPermissionNotice = "";
    try {
      if (!isPageRefresh()) await clearPersistedMedia(false);
      try {
        videoMetadata = sanitizeMetadataMap(await readPersistedMetadata());
      } catch (error) {
        console.warn("Could not restore saved LocalTube video metadata.", error);
      }
      if (selectionGeneration) return;
      try {
        const directoryHandle = await readPersistedDirectoryHandle();
        if (directoryHandle) {
          if (await directoryHandle.queryPermission({ mode: "readwrite" }) === "granted") {
            metadataDirectoryHandle = directoryHandle;
          } else {
            metadataPermissionNotice = "Choose the video folder again to resume automatic metadata saving.";
          }
        }
      } catch (error) {
        console.warn("Could not restore automatic metadata saving for the selected folder.", error);
        metadataPermissionNotice = "Choose the video folder again to resume automatic metadata saving.";
      }
      if (selectionGeneration) return;
      if (isDesktopApp) return;
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
      if (metadataPermissionNotice) showStatus(metadataPermissionNotice);
    } catch (error) {
      console.warn("Could not restore the saved LocalTube library.", error);
      byId("welcome-status").textContent = "The saved library could not be restored. Choose your video folder again.";
      byId("welcome-status").hidden = false;
    }
  }

  // Import flow and the derived library view (filtering, sorting, and navigation).
  async function collectDirectoryVideos(directoryHandle) {
    const fileHandles = [];
    let metadataFile = null;
    async function visit(handle, relativePath) {
      const directories = [];
      for await (const [name, entry] of handle.entries()) {
        if (entry.kind === "directory") {
          directories.push(visit(entry, `${relativePath}${name}/`));
        } else if (entry.kind === "file") {
          if (handle === directoryHandle && name.toLowerCase() === METADATA_FILE) {
            metadataFile = await entry.getFile();
          } else if (VIDEO_EXTENSIONS.test(name)) {
            fileHandles.push({ handle: entry, path: `${relativePath}${name}` });
          }
        }
      }
      await Promise.all(directories);
    }
    await visit(directoryHandle, `${directoryHandle.name}/`);
    return { fileHandles, metadataFile };
  }

  async function readDirectoryFileBatch(fileHandles) {
    const entries = new Array(fileHandles.length);
    let nextIndex = 0;
    const readFiles = async () => {
      while (nextIndex < fileHandles.length) {
        const index = nextIndex++;
        const { handle, path } = fileHandles[index];
        entries[index] = { file: await handle.getFile(), path };
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(8, fileHandles.length) },
      readFiles
    ));
    return entries;
  }

  async function loadDirectoryVideos(fileHandles, metadataFile, directoryHandle) {
    stopVideoMetadataLoading();
    const generation = ++selectionGeneration;
    try {
      videoMetadata = sanitizeMetadataMap(await readPersistedMetadata());
    } catch (error) {
      console.warn("Could not load saved video metadata before importing videos.", error);
    }
    if (generation !== selectionGeneration) return;
    if (metadataFile) await importMetadataFile(metadataFile, false);
    if (generation !== selectionGeneration) return;

    const firstBatchSize = Math.min(24, fileHandles.length);
    const entries = await readDirectoryFileBatch(fileHandles.slice(0, firstBatchSize));
    if (generation !== selectionGeneration) return;
    loadingVideosTotal = fileHandles.length;
    persistenceNotice = "";
    activateLibrary(entries);
    metadataDirectoryHandle = directoryHandle;
    showStatus(`Loading videos… ${entries.length} of ${loadingVideosTotal}`);

    for (let offset = firstBatchSize; offset < fileHandles.length; offset += 32) {
      const nextEntries = await readDirectoryFileBatch(fileHandles.slice(offset, offset + 32));
      if (generation !== selectionGeneration) return;
      entries.push(...nextEntries);
      appendLibraryVideos(nextEntries);
      showStatus(`Loading videos… ${entries.length} of ${loadingVideosTotal}`);
    }

    loadingVideosTotal = 0;
    updateLibrary();
    retainLoadedMedia(entries, generation);
    persistDirectoryHandle(directoryHandle).catch(error => {
      console.warn("Could not remember the selected LocalTube folder.", error);
      if (generation !== selectionGeneration) return;
      showStatus("Metadata can be saved beside your videos during this visit, but the folder could not be remembered for next time.");
    });
  }

  async function loadVideoEntries(entries, metadataFile, directoryHandle = null) {
    stopVideoMetadataLoading();
    const generation = ++selectionGeneration;
    try {
      videoMetadata = sanitizeMetadataMap(await readPersistedMetadata());
    } catch (error) {
      console.warn("Could not load saved video metadata before importing videos.", error);
    }
    if (generation !== selectionGeneration) return;
    if (metadataFile) await importMetadataFile(metadataFile, false);
    if (generation !== selectionGeneration) return;
    loadingVideosTotal = 0;
    if (videos.length) {
      showStatus(persistenceNotice);
    } else {
      byId("welcome-status").textContent = persistenceNotice;
      byId("welcome-status").hidden = false;
    }
    byId("welcome-status").hidden = true;
    activateLibrary(entries);
    metadataDirectoryHandle = directoryHandle;
    retainLoadedMedia(entries, generation);
    persistDirectoryHandle(directoryHandle).catch(error => {
      console.warn("Could not remember the selected LocalTube folder.", error);
      if (generation !== selectionGeneration) return;
      if (directoryHandle) {
        showStatus("Metadata can be saved beside your videos during this visit, but the folder could not be remembered for next time.");
      } else if (!metadataDirectoryHandle) {
        showStatus(`The previous folder permission could not be cleared from local ${platformLabel} storage. Choose the new folder again if automatic saving resumes in the wrong location.`);
      }
    });
  }

  async function chooseFolder() {
    if (!supportsWritableDirectoryPicker) {
      fileInput.click();
      return;
    }
    let directoryHandle;
    try {
      directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    } catch (error) {
      if (error.name !== "AbortError") {
        console.warn("Could not open the LocalTube video folder.", error);
        showStatus(`The video folder could not be opened. Check ${platformLabel} permissions and try again.`);
      }
      return;
    }
    try {
      if (library.hidden) {
        byId("welcome-status").textContent = "Reading video files in that folder…";
        byId("welcome-status").hidden = false;
      } else {
        showStatus("Reading video files in that folder…");
      }
      const { fileHandles, metadataFile } = await collectDirectoryVideos(directoryHandle);
      if (!fileHandles.length) {
        if (library.hidden) {
          byId("welcome-status").textContent = "No video files found in that folder. Choose a folder with video files to get started.";
          byId("welcome-status").hidden = false;
        } else {
          showStatus("No video files were found in that folder. Your current library is unchanged.");
        }
        return;
      }
      await loadDirectoryVideos(fileHandles, metadataFile, directoryHandle);
    } catch (error) {
      console.warn("Could not read the selected LocalTube video folder.", error);
      showStatus(`The selected folder could not be read. Check ${platformLabel} permissions and try again.`);
    }
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
      welcomeStatus.textContent = supportsWebkitDirectoryInput
        ? "No video files found in that folder. Choose a folder with video files to get started."
        : "No video files selected. Choose one or more video files to get started.";
      welcomeStatus.hidden = false;
      return;
    }
    await loadVideoEntries(
      files.map(file => ({ file, path: file.webkitRelativePath || file.name })),
      metadataFile
    );
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
      button.dataset.playlistId = playlist.id;
      button.disabled = videos.length === 0;
      button.addEventListener("click", () => {
        activeFilter = "playlist";
        activePlaylistId = playlist.id;
        syncNavigation();
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
    syncNavigation();
  }

  function syncNavigation() {
    document.querySelectorAll(".sidebar .nav-item").forEach(item => {
      const selected = item.dataset.filter
        ? item.dataset.filter === activeFilter
        : activeFilter === "playlist" && item.dataset.playlistId === activePlaylistId;
      item.classList.toggle("active", selected);
      if (selected) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
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
    if (!videos.length || !await confirmAction(`Remove the saved video files, metadata, playlists, and watch history from ${storageLabel}?`)) return;
    if (lanSharingStarted) await stopLanSharing();
    stopVideoMetadataLoading(false, true);
    try {
      await clearPersistedMedia();
    } catch (error) {
      console.warn("Could not forget the saved LocalTube video files.", error);
      showStatus(`The saved video files could not be removed. ${error.message || `Check local ${platformLabel} storage and try again.`}`);
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
      loadingVideosTotal = 0;
      videoMetadata = {};
      metadataDirectoryHandle = null;
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
      renderPlaylists();
      library.hidden = true;
      welcome.hidden = false;
      byId("welcome-status").textContent = removalWarning || `Saved videos and library data were removed from ${storageLabel}.`;
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
    byId("all-count").textContent = loadingVideosTotal ? `${videos.length}/${loadingVideosTotal}` : videos.length || "";
    const filtered = filteredVideos();
    const totalDuration = videos.reduce((sum, video) => sum + (video.duration || 0), 0);
    byId("library-subtitle").textContent = loadingVideosTotal
      ? `${videos.length} of ${loadingVideosTotal} videos loaded`
      : activeFilter === "all"
        ? `${videos.length} ${videos.length === 1 ? "video" : "videos"}${totalDuration ? ` · ${formatTime(totalDuration)} total` : ""}`
      : `${filtered.length} ${filtered.length === 1 ? "video" : "videos"}`;
    byId("shuffle-playlist").hidden = !playlist || !filtered.length;
    byId("delete-active-playlist").hidden = !playlist;
    byId("forget-library").hidden = videos.length === 0;
    byId("browse-library").hidden = !playlist || playlist.videoKeys.length > 0;
    grid.replaceChildren();
    filtered.forEach(video => grid.append(createCard(video)));
    observeVisibleVideoMetadata();
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
      syncNavigation();
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
  byId("start-lan-sharing").addEventListener("click", startLanSharing);
  byId("stop-lan-sharing").addEventListener("click", stopLanSharing);
  updateLanSharingControls();
  byId("browse-library").addEventListener("click", () => {
    activeFilter = "all";
    activePlaylistId = null;
    syncNavigation();
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
    meta.textContent = videoCardMetadata(video);
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

  function updateCardDuration(card, video) {
    card.querySelector(".duration-badge").textContent = video.duration ? formatTime(video.duration) : "--:--";
  }

  function videoCardMetadata(video) {
    const folder = video.path.includes("/") ? video.path.slice(0, video.path.lastIndexOf("/")) : "";
    return [
      formatSize(video.file.size),
      video.width && video.height ? `${video.width} × ${video.height}` : "",
      folder
    ].filter(Boolean).join(" · ");
  }

  function updateCardThumbnail(card, video) {
    const image = card.querySelector(".thumb-image");
    const skeleton = card.querySelector(".thumb-skeleton");
    if (video.thumbnail) {
      image.src = video.thumbnail;
      image.hidden = false;
      skeleton.hidden = true;
    } else {
      image.removeAttribute("src");
      image.hidden = true;
      skeleton.hidden = false;
    }
    card.querySelector(".video-meta").textContent = videoCardMetadata(video);
    updateCardDuration(card, video);
  }

  function buildVideoMetadataObserver() {
    stopVideoMetadataLoading();
    if (!videos.length) return;
    const generation = metadataGeneration;
    metadataWorker = document.createElement("video");
    metadataWorker.muted = true;
    metadataWorker.preload = "metadata";
    if ("IntersectionObserver" in window) {
      videoMetadataObserver = new IntersectionObserver(entries => {
        if (generation !== metadataGeneration) return;
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          videoMetadataObserver.unobserve(entry.target);
          const card = entry.target.closest(".video-card");
          const video = videos.find(candidate => candidate.key === card?.dataset.videoKey);
          if (!video || video.metadataPending || video.metadataError || video.thumbnailError) return;
          if (video.mediaMetadataLoaded && (video.customThumbnail || video.defaultThumbnail)) return;
          video.metadataPending = true;
          metadataQueue.push(video);
        });
        processNextVideoMetadata(generation);
      }, { rootMargin: "160px 0px" });
    } else {
      metadataFallbackScroll = observeVisibleVideoMetadata;
      window.addEventListener("scroll", metadataFallbackScroll, { passive: true });
    }
    observeVisibleVideoMetadata();
  }

  function stopVideoMetadataLoading(persistChanges = true, discardChanges = false) {
    metadataGeneration++;
    videoMetadataObserver?.disconnect();
    videoMetadataObserver = null;
    if (metadataFallbackScroll) {
      window.removeEventListener("scroll", metadataFallbackScroll);
      metadataFallbackScroll = null;
    }
    metadataQueue = [];
    videos.forEach(video => { video.metadataPending = false; });
    cancelActiveMetadataLoad?.();
    cancelActiveMetadataLoad = null;
    metadataProcessing = false;
    if (metadataWorker) {
      metadataWorker.pause();
      metadataWorker.removeAttribute("src");
      metadataWorker.load();
      metadataWorker = null;
    }
    if (persistChanges) flushGeneratedMetadata();
    else if (discardChanges) generatedMetadataDirty = false;
  }

  function observeVisibleVideoMetadata() {
    if (!metadataWorker || !playerModal.hidden) return;
    const generation = metadataGeneration;
    grid.querySelectorAll(".thumb-wrap").forEach(thumb => {
      const card = thumb.closest(".video-card");
      const video = videos.find(candidate => candidate.key === card?.dataset.videoKey);
      if (!video || video.metadataPending || video.metadataError || video.thumbnailError) return;
      if (video.mediaMetadataLoaded && (video.customThumbnail || video.defaultThumbnail)) return;
      if (videoMetadataObserver) {
        videoMetadataObserver.observe(thumb);
      } else {
        const bounds = thumb.getBoundingClientRect();
        if (bounds.bottom >= 0 && bounds.top <= window.innerHeight) {
          video.metadataPending = true;
          metadataQueue.push(video);
        }
      }
    });
    processNextVideoMetadata(generation);
  }

  function processNextVideoMetadata(generation) {
    if (generation !== metadataGeneration || metadataProcessing || !metadataQueue.length || !playerModal.hidden) {
      if (generation === metadataGeneration && !metadataProcessing && !metadataQueue.length) flushGeneratedMetadata();
      return;
    }
    const video = metadataQueue.shift();
    const card = Array.from(grid.children).find(element => element.dataset.videoKey === video.key);
    if (!card) {
      video.metadataPending = false;
      processNextVideoMetadata(generation);
      return;
    }
    const bounds = card.querySelector(".thumb-wrap").getBoundingClientRect();
    if (bounds.bottom < -160 || bounds.top > window.innerHeight + 160) {
      video.metadataPending = false;
      if (videoMetadataObserver) videoMetadataObserver.observe(card.querySelector(".thumb-wrap"));
      processNextVideoMetadata(generation);
      return;
    }
    metadataProcessing = true;
    processVideoMetadata(metadataWorker, video).then(() => {
      if (generation !== metadataGeneration) return;
      metadataProcessing = false;
      const card = Array.from(grid.children).find(element => element.dataset.videoKey === video.key);
      if (card) updateCardThumbnail(card, video);
      if (byId("sort").value === "duration") updateLibrary();
      else updateLibrarySubtitle();
      processNextVideoMetadata(generation);
    }).catch(error => {
      if (generation !== metadataGeneration) return;
      console.warn(`Could not load metadata for ${video.file.name}.`, error);
      video.metadataPending = false;
      video.metadataError = true;
      video.thumbnailError = !video.customThumbnail && !video.defaultThumbnail;
      metadataProcessing = false;
      const card = Array.from(grid.children).find(element => element.dataset.videoKey === video.key);
      if (card) updateCardThumbnail(card, video);
      processNextVideoMetadata(generation);
    });
  }

  function processVideoMetadata(worker, video) {
    return new Promise(resolve => {
      let settled = false;
      let metadataReady = false;
      const needsThumbnail = !video.customThumbnail && !video.defaultThumbnail;
      const finish = thumbnail => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        worker.removeEventListener("loadedmetadata", onMetadata);
        worker.removeEventListener("loadeddata", onFrameReady);
        worker.removeEventListener("seeked", onFrameReady);
        worker.removeEventListener("error", onError);
        cancelActiveMetadataLoad = null;
        worker.pause();
        worker.removeAttribute("src");
        worker.load();
        video.metadataPending = false;
        if (thumbnail) {
          video.defaultThumbnail = thumbnail;
          video.thumbnail = video.customThumbnail || thumbnail;
          video.thumbnailError = false;
        } else if (needsThumbnail && !video.defaultThumbnail) {
          video.thumbnailError = true;
        }
        if (video.mediaMetadataLoaded) {
          cacheVideoMediaMetadata(video);
        } else {
          video.metadataError = true;
        }
        resolve();
      };
      const captureFrame = () => {
        if (!metadataReady || worker.seeking || worker.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
        try {
          if (!worker.videoWidth || !worker.videoHeight) {
            finish("");
            return;
          }
          const canvas = document.createElement("canvas");
          canvas.width = 480;
          canvas.height = 270;
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) {
            finish("");
            return;
          }
          const sourceRatio = worker.videoWidth / worker.videoHeight;
          const targetRatio = canvas.width / canvas.height;
          const sourceWidth = sourceRatio > targetRatio ? worker.videoHeight * targetRatio : worker.videoWidth;
          const sourceHeight = sourceRatio > targetRatio ? worker.videoHeight : worker.videoWidth / targetRatio;
          context.drawImage(
            worker,
            (worker.videoWidth - sourceWidth) / 2,
            (worker.videoHeight - sourceHeight) / 2,
            sourceWidth,
            sourceHeight,
            0, 0, canvas.width, canvas.height
          );
          finish(canvas.toDataURL("image/jpeg", .78));
        } catch (error) {
          console.info(`Could not create a default thumbnail for ${video.file.name}.`, error);
          finish("");
        }
      };
      const onMetadata = () => {
        metadataReady = true;
        video.duration = Number.isFinite(worker.duration) && worker.duration > 0 ? worker.duration : 0;
        video.width = worker.videoWidth || 0;
        video.height = worker.videoHeight || 0;
        video.mediaMetadataLoaded = true;
        cacheVideoMediaMetadata(video);
        const card = Array.from(grid.children).find(element => element.dataset.videoKey === video.key);
        if (card) updateCardThumbnail(card, video);
        if (byId("sort").value === "duration") updateLibrary();
        else updateLibrarySubtitle();
        if (!needsThumbnail || !video.duration) {
          finish("");
          return;
        }
        const midpoint = Math.min(worker.duration - 0.1, worker.duration / 2);
        if (midpoint > 0.05) {
          try {
            worker.currentTime = midpoint;
          } catch (error) {
            console.info(`Could not seek to the middle of ${video.file.name}.`, error);
            finish("");
          }
        } else {
          captureFrame();
        }
      };
      const onFrameReady = () => captureFrame();
      const onError = () => finish("");
      const timeout = setTimeout(() => finish(""), 30000);
      cancelActiveMetadataLoad = () => finish("");
      worker.addEventListener("loadedmetadata", onMetadata, { once: true });
      worker.addEventListener("loadeddata", onFrameReady);
      worker.addEventListener("seeked", onFrameReady);
      worker.addEventListener("error", onError, { once: true });
      worker.src = video.url;
      worker.load();
    });
  }

  function cacheVideoMediaMetadata(video) {
    const metadata = metadataFor(video);
    metadata.duration = video.duration;
    metadata.width = video.width;
    metadata.height = video.height;
    metadata.mediaMetadataLoaded = true;
    metadata.defaultThumbnail = video.defaultThumbnail;
    videoMetadata[video.key] = metadata;
    generatedMetadataDirty = true;
  }

  function flushGeneratedMetadata() {
    if (!generatedMetadataDirty) return;
    if (!playerModal.hidden) return;
    generatedMetadataDirty = false;
    persistVideoMetadata().catch(() => {});
    saveMetadataSidecar();
    publishLanMetadata();
  }

  function updateLibrarySubtitle() {
    if (activeFilter !== "all" || loadingVideosTotal) return;
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
    if (!activeVideo) return;
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
    if (seekPreviewVideo.getAttribute("src") !== activeVideo.url) {
      seekPreviewVideo.src = activeVideo.url;
      seekPreviewVideo.load();
    }
    if (duration && seekPreviewVideo.readyState >= HTMLMediaElement.HAVE_METADATA &&
        Math.abs(seekPreviewVideo.currentTime - target) > 0.8 && !seekPreviewVideo.seeking) {
      try { seekPreviewVideo.currentTime = Math.min(duration - 0.05, target); } catch { /* Wait for another pointer movement. */ }
    }
  }

  function hideSeekPreview() {
    seekPreview.hidden = true;
    seekPreviewVideo.pause();
    seekPreviewVideo.removeAttribute("src");
    seekPreviewVideo.load();
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
    stopVideoMetadataLoading(false);
    hideSeekPreview();
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
    player.preload = "metadata";
    player.src = video.url;
    player.load();
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
      video.mediaMetadataLoaded = true;
      const metadata = metadataFor(video);
      metadata.duration = video.duration;
      metadata.width = video.width;
      metadata.height = video.height;
      metadata.mediaMetadataLoaded = true;
      videoMetadata[video.key] = metadata;
      generatedMetadataDirty = true;
      flushGeneratedMetadata();
      const card = Array.from(grid.children).find(element => element.dataset.videoKey === video.key);
      if (card) updateCardDuration(card, video);
      if (byId("sort").value === "duration") updateLibrary();
      updateLibrarySubtitle();
      renderRecommendations(video);
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
    hideSeekPreview();
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
    buildVideoMetadataObserver();
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
    if (!seekTrack.matches(":hover")) hideSeekPreview();
  });
  seekTrack.addEventListener("pointerleave", () => {
    if (!draggingSeek) hideSeekPreview();
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
    if (lanSharingStarted && tauriInvoke) tauriInvoke("stop_lan_share").catch(() => {});
    stopVideoMetadataLoading();
    if (activeVideo) savePlaybackProgress();
    objectUrls.forEach(URL.revokeObjectURL);
  });
  // Rebuild persistent playlist navigation before restoring the selected video files.
  renderPlaylists();
  restoreLibrary();
})();
