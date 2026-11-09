(() => {
  "use strict";
  const tokenKey = "localtube-lan-token";
  const status = document.getElementById("status");
  const login = document.getElementById("login");
  const library = document.getElementById("library");
  const grid = document.getElementById("grid");
  const search = document.getElementById("search");
  const sort = document.getElementById("sort");
  const player = document.getElementById("player");
  const video = document.getElementById("video");
  const items = [];
  let token = sessionStorage.getItem(tokenKey) || "";
  let retryTimer = 0;

  const api = async (path, options = {}) => {
    const response = await fetch(path, {
      ...options,
      headers: { ...(options.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }
    });
    if (!response.ok) throw new Error(response.status === 401 ? "The password was rejected or sharing has stopped." : "The shared library could not be loaded.");
    return response;
  };
  const formatTime = seconds => {
    if (!Number.isFinite(seconds) || seconds <= 0) return "Unknown duration";
    const total = Math.floor(seconds);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  };
  const formatSize = bytes => {
    if (!bytes) return "Unknown size";
    if (bytes < 1024) return `${bytes} B`;
    const power = bytes > 1024 ** 3 ? 3 : bytes > 1024 ** 2 ? 2 : 1;
    return `${(bytes / (1024 ** power)).toFixed(1)} ${["", "KB", "MB", "GB"][power]}`;
  };
  const render = () => {
    const term = search.value.trim().toLocaleLowerCase();
    const result = items.filter(item => !term || `${item.title} ${item.path}`.toLocaleLowerCase().includes(term));
    result.sort((a, b) => sort.value === "duration" ? b.duration - a.duration : sort.value === "size" ? b.size - a.size : sort.value === "recent" ? b.modified - a.modified : a.title.localeCompare(b.title));
    grid.replaceChildren(...result.map(item => {
      const card = document.createElement("article");
      card.className = "card";
      const image = item.thumbnail ? Object.assign(document.createElement("img"), { src: item.thumbnail, alt: "" }) : Object.assign(document.createElement("div"), { className: "placeholder", textContent: "▶" });
      const body = document.createElement("div");
      body.className = "card-body";
      const title = document.createElement("h2");
      title.textContent = item.title;
      const meta = document.createElement("p");
      meta.className = "meta";
      meta.textContent = `${formatTime(item.duration)} · ${item.width && item.height ? `${item.width}×${item.height}` : "Resolution unknown"} · ${formatSize(item.size)}`;
      body.append(title, meta);
      card.append(image, body);
      card.addEventListener("click", () => {
        document.getElementById("player-title").textContent = item.title;
        document.getElementById("player-details").textContent = `${item.path} · ${meta.textContent}`;
        video.src = item.video;
        player.showModal();
        video.play().catch(() => {});
      });
      return card;
    }));
    document.getElementById("empty").hidden = result.length !== 0;
  };
  const loadLibrary = async () => {
    const data = await api("/api/library").then(response => response.json());
    items.splice(0, items.length, ...data);
    login.hidden = true;
    library.hidden = false;
    status.textContent = `${items.length} videos shared from the host.`;
    render();
  };
  const connect = async password => {
    const response = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    if (!response.ok) throw new Error("The password was rejected.");
    token = (await response.json()).token;
    sessionStorage.setItem(tokenKey, token);
    await loadLibrary();
  };
  login.addEventListener("submit", event => {
    event.preventDefault();
    connect(document.getElementById("password").value).catch(error => {
      sessionStorage.removeItem(tokenKey);
      token = "";
      status.textContent = error.message;
    });
  });
  search.addEventListener("input", render);
  sort.addEventListener("change", render);
  document.getElementById("close").addEventListener("click", () => {
    clearTimeout(retryTimer);
    video.pause();
    video.removeAttribute("src");
    video.load();
    player.close();
  });
  video.addEventListener("error", () => {
    clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => {
      if (!player.open) return;
      video.load();
      video.play().catch(() => {});
    }, 1500);
  });
  if (token) loadLibrary().catch(() => { sessionStorage.removeItem(tokenKey); token = ""; });
})();
