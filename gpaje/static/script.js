const API_BASE = ""; // same origin or reverse-proxy path (e.g., "/api")
let I18N = {
  "ru": {
    "app_title": "Экспорт Google Photos → JSON",
    "signin": "Войти с Google",
    "signout": "Выйти",
    "export": "Экспортировать альбомы Google Photos в JSON",
    "download": "Скачать JSON",
    "disabled_download": "Скачать JSON",
    "short_goal": "Цель: быстро и приватно экспортировать ваши альбомы и медиа из Google Фото в JSON.",
    "example_title": "Пример экспортируемого JSON",
    "privacy_note": "Данные не сохраняются на сервере после экспорта.",
    "footer_copy": "© {year} Все права защищены.",
    "footer_repo": "GitHub",
    "footer_commit": "Коммит",
    "user_menu": "Аккаунт",
    "loading_albums": "Загрузка списка альбомов…",
    "loading_media": "Загрузка медиа…",
    "albums": "Альбомы",
    "items": "элементов",
    "summary": "Готово: {albums} альбом(ов), {items} элементов. Время: {seconds} сек.",
    "not_signed_in": "Вы не авторизованы. Пожалуйста, войдите.",
    "export_ready": "Экспорт завершён. Теперь можно скачать JSON.",
    "lang_ru": "Рус",
    "lang_en": "Eng",
    "spinner_loading": "Загрузка…",
    "profile": "Профиль",
    "export_in_progress": "Идёт экспорт…",
    "signin_tip": "Нажмите, чтобы войти через Google и начать экспорт.",
    "export_tip": "Нажмите, чтобы получить список альбомов и их содержимое.",
    "downloading_tip": "Нажмите, чтобы скачать результат как файл JSON."
  },
  "en": {
    "app_title": "Export Google Photos → JSON",
    "signin": "Sign in with Google",
    "signin_details": "By logging in, you agree to the use of cookies and accept our Terms of Service and Privacy Policy.",
    "signout": "Sign out",
    "export": "Export Google Photos albums to JSON",
    "download": "Download JSON",
    "disabled_download": "Download JSON",
    "short_goal": "Dump Google Photos Albums to JSON",
    "example_title": "Example of exported JSON",
    "privacy_note": "No data is stored on the server after export.",
    "footer_copy": "© {year} All rights reserved.",
    "footer_repo": "GitHub",
    "footer_commit": "Commit",
    "user_menu": "Account",
    "loading_albums": "Loading albums list…",
    "loading_media": "Loading media…",
    "albums": "Albums",
    "items": "items",
    "summary": "Done: {albums} album(s), {items} items. Time: {seconds}s.",
    "not_signed_in": "You are not signed in. Please sign in.",
    "export_ready": "Export finished. You can now download the JSON.",
    "lang_ru": "Рус",
    "lang_en": "Eng",
    "spinner_loading": "Loading…",
    "profile": "Profile",
    "export_in_progress": "Export in progress…",
    "signin_tip": "Click to sign in with Google and start export.",
    "export_tip": "Click to fetch albums and their contents.",
    "downloading_tip": "Click to download the result as a JSON file."
  }
};
let LANG = "en";
let USER = null;
let exportedData = null;
let exportStart = 0;

async function loadI18n() {
  const urlLang = new URLSearchParams(location.search).get("lang");
  LANG = (urlLang || navigator.language || "en").toLowerCase().startsWith("ru") ? "ru" : "en";
  applyLang();
}

function t(key, vars={}) {
  const s = (I18N[LANG] && I18N[LANG][key]) || key;
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

function applyLang() {
  document.getElementById("signinBtn").textContent = t("signin");
  document.getElementById("signinBtn").title = t("signin_tip");
  document.getElementById("exportBtn").textContent = t("export");
  document.getElementById("exportBtn").title = t("export_tip");
  document.getElementById("downloadBtn").textContent = t("download");
  document.getElementById("downloadBtn").title = t("downloading_tip");
  document.getElementById("shortGoal").textContent = t("short_goal");
  document.getElementById("exampleTitle").textContent = t("example_title");
  document.getElementById("privacyNote").textContent = t("privacy_note");
  document.getElementById("signoutBtn").textContent = t("signout");
  document.getElementById("spinner").title = t("spinner_loading");
  document.getElementById("lang-ru").textContent = t("lang_ru");
  document.getElementById("lang-en").textContent = t("lang_en");
  updateStatus("");
}

function updateStatus(text) {
  document.getElementById("loadingStatus").textContent = text || "";
}

async function fetchJSON(url, opts={}) {
  const r = await fetch(url, Object.assign({credentials: "include"}, opts));
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function checkMe() {
  try {
    const me = await fetchJSON(API_BASE + "/api/me");
    USER = me;
    showUser(me);
    document.getElementById("signinBtn").style.display = "none";
    document.getElementById("exportBtn").style.display = "inline-block";
    document.getElementById("downloadBtn").style.display = "inline-block";
  } catch (e) {
    // not signed in
  }
}

function showUser(me) {
  const userEl = document.getElementById("user");
  userEl.style.display = "flex";
  document.getElementById("userName").textContent = me.name;
  document.getElementById("userPic").src = me.picture || "";
}

function toggleMenu() {
  const m = document.getElementById("menu");
  m.classList.toggle("show");
}

async function signOut() {
  await fetch(API_BASE + "/api/logout", {method:"POST", credentials:"include"});
  location.reload();
}

function startExport() {
  exportedData = { albums: [] };
  exportStart = Date.now();
  const list = document.getElementById("list");
  list.innerHTML = "";
  updateStatus(t("export_in_progress"));
  const spinner = document.getElementById("spinner");
  spinner.style.display = "block";

  const es = new EventSource(API_BASE + "/api/export-stream");
  const bars = new Map();

  es.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "albums_count") {
        // optional
      } else if (msg.type === "album") {
        // add album row
        const li = document.createElement("li");
        li.className = "album";
        li.id = "album-" + msg.album.id;
        li.innerHTML = `
          <div class="album-title"></div>
          <div class="bar-wrap"><div class="bar"></div></div>
        `;
        li.querySelector(".album-title").innerHTML = (
              msg.album.title
              + ' <span style="color: #60a5fa;">•</span> '
              + '<span class="muted">'
              + (msg.album.mediaItemsCount || 0)
              + " "
              + t("items")
              + "</span>"
        );
        list.appendChild(li);
        bars.set(msg.album.id, li.querySelector(".bar"));
        exportedData.albums.push(Object.assign(msg.album, { items: [] }));
      } else if (msg.type === "progress") {
        const bar = bars.get(msg.albumId);
        if (bar) {
          const total = msg.total || 1;
          const pct = Math.min(100, Math.ceil((msg.loaded/total)*100));
          console.log(pct, msg.loaded, total)
          bar.style.width = pct + "%";
        }
        const target = exportedData.albums.find(a => a.id === msg.albumId);
        if (target && Array.isArray(msg.items) && msg.items.length) {
          target.items.push(...msg.items);
        }
      } else if (msg.type === "done") {
        es.close();
        spinner.style.display = "none";
        exportedData = msg.result || exportedData;
        const secs = Math.round((Date.now() - exportStart)/1000);
        const albums = exportedData.albums.length;
        const items = exportedData.albums.reduce((s,a)=> s + (a.items?.length||0), 0);
        updateStatus(t("summary", {albums, items, seconds: secs}));
        const dlBtn = document.getElementById("downloadBtn");
        dlBtn.disabled = false;
        dlBtn.onclick = () => downloadJSON(exportedData);
      }
    } catch (err) { console.error(err); }
  });

  es.addEventListener("error", (e) => { console.error("SSE error", e); es.close(); spinner.style.display="none"; });
}

function downloadJSON(data) {
  const blob = new Blob([JSON.stringify(data["albums"], null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "google_photos_export.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// wiring
window.addEventListener("click", (e) => {
  const m = document.getElementById("menu");
  if (m.classList.contains("show") && !m.contains(e.target) && !document.getElementById("user").contains(e.target)) {
    m.classList.remove("show");
  }
});

document.addEventListener("DOMContentLoaded", async () => {
  await loadI18n();
  document.getElementById("lang-ru").onclick = () => { LANG="ru"; document.querySelectorAll(".lang-btn").forEach(b=>b.classList.remove("active")); document.getElementById("lang-ru").classList.add("active"); applyLang(); };
  document.getElementById("lang-en").onclick = () => { LANG="en"; document.querySelectorAll(".lang-btn").forEach(b=>b.classList.remove("active")); document.getElementById("lang-en").classList.add("active"); applyLang(); };

  document.getElementById("signinBtn").onclick = () => { location.href = API_BASE + "/api/login"; };
  document.getElementById("exportBtn").onclick = () => {
    document.getElementById("exportBtn").disabled = true;
    const btn = document.getElementById("downloadBtn");
    btn.disabled = true;
    startExport();
  };
  document.getElementById("downloadBtn").onclick = () => { if (exportedData) downloadJSON(exportedData); };

  document.getElementById("user").onclick = toggleMenu;
  document.getElementById("signoutBtn").onclick = signOut;

  await checkMe();
});
