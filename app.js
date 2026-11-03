(() => {
  "use strict";

  const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|webm|ogv|ogg|mkv|avi|mpg|mpeg|wmv|3gp|mts|m2ts)$/i;
  const STORAGE_KEY = "localtube-library-v1";
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

  if (!supportsDirectoryPicker) {
    fileInput.removeAttribute("webkitdirectory");
    fileInput.removeAttribute("directory");
    byId("choose-folder").querySelector(".button-label").textContent = "Choose videos";
    byId("welcome-choose").querySelector(".button-label").textContent = "Choose video files";
    byId("support-note").textContent = "Select multiple video files at once; folder selection is unavailable in this browser.";
  }

  function readSavedState() {
    try {
      const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return state && typeof state === "object" ? state : {};
    } catch (error) {
      console.warn("Could not read saved LocalTube progress.", error);
      return {};
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

  function showStatus(message) {
    status.textContent = message;
    status.hidden = !message;
  }

  function stableKey(file) {
    return `${file.webkitRelativePath || file.name}|${file.size}|${file.lastModified}`;
  }

  function chooseFolder() {
    fileInput.click();
  }

  byId("choose-folder").addEventListener("click", chooseFolder);
  byId("welcome-choose").addEventListener("click", chooseFolder);
  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files || []).filter(file => file.type.startsWith("video/") || VIDEO_EXTENSIONS.test(file.name));
    if (!files.length) {
      const welcomeStatus = byId("welcome-status");
      welcomeStatus.textContent = supportsDirectoryPicker
        ? "No video files found in that folder. Choose a folder with video files to get started."
        : "No video files selected. Choose one or more video files to get started.";
      welcomeStatus.hidden = false;
      return;
    }

    byId("welcome-status").hidden = true;
    thumbGeneration++;
    hoverGeneration++;
    objectUrls.forEach(URL.revokeObjectURL);
    objectUrls = [];
    videos = files.map(file => {
      const url = URL.createObjectURL(file);
      objectUrls.push(url);
      return {
        file,
        url,
        key: stableKey(file),
        title: file.name.replace(VIDEO_EXTENSIONS, ""),
        path: file.webkitRelativePath || file.name,
        duration: 0,
        thumbnail: "",
        mimeUnsupported: false
      };
    });
    activeFilter = "all";
    document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.filter === "all"));
    welcome.hidden = true;
    library.hidden = false;
    searchInput.value = "";
    updateLibrary();
    buildThumbnails(thumbGeneration);
    fileInput.value = "";
  });

  document.querySelectorAll(".nav-item").forEach(item => {
    item.addEventListener("click", () => {
      activeFilter = item.dataset.filter;
      document.querySelectorAll(".nav-item").forEach(nav => nav.classList.toggle("active", nav === item));
      updateLibrary();
    });
  });
  searchInput.addEventListener("input", updateLibrary);
  byId("sort").addEventListener("change", updateLibrary);

  function filteredVideos() {
    const term = searchInput.value.trim().toLocaleLowerCase();
    let result = videos.filter(video => {
      const saved = getSaved(video);
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

  function updateLibrary() {
    const labels = { all: "All videos", continue: "Continue watching", watchlater: "Watch later", watched: "Watched" };
    const title = labels[activeFilter] || labels.all;
    byId("page-title").textContent = title;
    byId("library-eyebrow").textContent = activeFilter === "all" ? "YOUR LIBRARY" : "YOUR COLLECTION";
    byId("all-count").textContent = videos.length || "";
    const filtered = filteredVideos();
    const totalDuration = videos.reduce((sum, video) => sum + (video.duration || 0), 0);
    byId("library-subtitle").textContent = activeFilter === "all"
      ? `${videos.length} ${videos.length === 1 ? "video" : "videos"}${totalDuration ? ` · ${formatTime(totalDuration)} total` : ""}`
      : `${filtered.length} ${filtered.length === 1 ? "video" : "videos"}`;
    grid.replaceChildren();
    filtered.forEach(video => grid.append(createCard(video)));
    byId("no-results").hidden = filtered.length !== 0;
    if (!filtered.length && videos.length) {
      const message = activeFilter === "watchlater" ? "Add videos to Watch later using the bookmark button." :
        activeFilter === "continue" ? "Videos you start watching will show up here." :
          activeFilter === "watched" ? "Videos you finish watching will show up here." : "Try a different search or choose another section.";
      byId("no-results").querySelector("p").textContent = message;
    }
  }

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
    const progress = document.createElement("div");
    progress.className = "watch-progress";
    const progressFill = document.createElement("span");
    const saved = getSaved(video);
    const percent = video.duration > 0 ? Math.max(0, Math.min(100, (saved.currentTime / video.duration) * 100)) : 0;
    progressFill.style.width = `${saved.watched ? 100 : percent}%`;
    progress.append(progressFill);
    thumb.append(skeleton, image, duration, later, progress);

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

  function buildThumbnails(generation) {
    if (!videos.length) return;
    showStatus(`Creating previews… 0 of ${videos.length}`);
    const worker = document.createElement("video");
    worker.muted = true;
    worker.preload = "auto";
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
        showStatus(unavailable
          ? `Previews unavailable for ${unavailable} ${unavailable === 1 ? "video" : "videos"}. The browser may not support ${unavailable === 1 ? "its" : "their"} format.`
          : "");
        return;
      }
      const video = videos[index++];
      processThumbnail(worker, video).then(() => {
        if (generation !== thumbGeneration) return;
        if (video.previewError) unavailable++;
        const card = Array.from(grid.children).find(element => element.dataset.videoKey === video.key);
        if (card) updateCardThumbnail(card, video);
        if (activeVideo && !playerModal.hidden) renderRecommendations(activeVideo);
        showStatus(`Creating previews… ${index} of ${videos.length}`);
        updateLibrarySubtitle();
        loadNext();
      }).catch(error => {
        if (generation !== thumbGeneration) return;
        console.info(`Preview unavailable for ${video.file.name}:`, error);
        unavailable++;
        showStatus(`Creating previews… ${index} of ${videos.length}`);
        loadNext();
      });
    };
    loadNext();
  }

  function processThumbnail(worker, video) {
    return new Promise(resolve => {
      let settled = false;
      const finish = (thumbnail = "", duration = 0) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        worker.removeEventListener("loadedmetadata", onMetadata);
        worker.removeEventListener("seeked", onSeeked);
        worker.removeEventListener("error", onError);
        video.previewError = !thumbnail;
        video.duration = Number.isFinite(duration) ? duration : 0;
        video.thumbnail = thumbnail;
        resolve();
      };
      const capture = () => {
        try {
          const canvas = document.createElement("canvas");
          const ratio = worker.videoWidth / worker.videoHeight || 16 / 9;
          canvas.width = 480;
          canvas.height = Math.round(canvas.width / ratio);
          const context = canvas.getContext("2d", { alpha: false });
          context.drawImage(worker, 0, 0, canvas.width, canvas.height);
          finish(canvas.toDataURL("image/jpeg", .78), worker.duration);
        } catch (error) {
          finish("", worker.duration);
        }
      };
      const onMetadata = () => {
        if (Number.isFinite(worker.duration) && worker.duration > 0.2) {
          const target = Math.min(worker.duration * .12, Math.max(.1, worker.duration - .1));
          try { worker.currentTime = target; } catch { capture(); }
        } else {
          capture();
        }
      };
      const onSeeked = capture;
      const onError = () => finish("", 0);
      const timeout = setTimeout(() => finish("", 0), 15000);
      worker.addEventListener("loadedmetadata", onMetadata, { once: true });
      worker.addEventListener("seeked", onSeeked, { once: true });
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

  function seekToPointer(event) {
    if (!Number.isFinite(player.duration) || !player.duration) return 0;
    const rect = seekTrack.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    player.currentTime = fraction * player.duration;
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

  function openPlayer(video) {
    if (activeVideo && activeVideo !== video) savePlaybackProgress();
    if (activeVideo !== video) lastProgressSave = -1;
    player.pause();
    activeVideo = video;
    byId("player-title").textContent = video.title;
    byId("player-file-info").textContent = `${video.path} · ${formatSize(video.file.size)}${video.duration ? ` · ${formatTime(video.duration)}` : ""}`;
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
    renderRecommendations(video);
    player.onloadedmetadata = () => {
      const saved = getSaved(video);
      if (saved.currentTime > 5 && (!video.duration || saved.currentTime < video.duration - 3)) {
        try { player.currentTime = saved.currentTime; } catch (error) { console.info("Could not resume video at saved position.", error); }
      }
      if (Number.isFinite(player.duration) && player.duration > 0) video.duration = player.duration;
      byId("player-file-info").textContent = `${video.path} · ${formatSize(video.file.size)} · ${formatTime(player.duration)}`;
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

  byId("close-player").addEventListener("click", closePlayer);
  byId("player-later").addEventListener("click", () => {
    if (activeVideo) toggleLater(activeVideo);
  });
  byId("play-toggle").addEventListener("click", togglePlayback);
  byId("center-play").addEventListener("click", togglePlayback);
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
})();
