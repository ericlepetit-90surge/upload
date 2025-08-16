// /public/app.js
import confetti from "https://cdn.skypack.dev/canvas-confetti";

/* ----------------- State ----------------- */
let isWindowOpen = false;
let hasShownWinner = false;

let SHOWN_WINNER_KEY = "shownWinner"; // namespaced per show window at runtime
let lastKnownWinner = null;
let originalRaffleText = "";
let initialWinnerFromRest = null;
let sseInitialized = false;

/* ----------------- Social constants ----------------- */
const FB_PAGE_ID = "130023783530481";
const FB_PAGE_URL = "https://www.facebook.com/90surge";
const IG_USERNAME = "90_surge";
const IG_WEB_URL = "https://www.instagram.com/90_surge";

// Put near the top of /public/app.js, with your other consts
const WINNER_SSE_URL =
  location.hostname === 'localhost'
    ? 'http://localhost:3000/events'
    : 'https://winner-sse-server.onrender.com/events';

function startWinnerStream() {
  if (window.__winnerSSE) return; // don’t double-connect
  try {
    const es = new EventSource(WINNER_SSE_URL);
    window.__winnerSSE = es;

    es.onmessage = (ev) => {
      // Expecting { "winner": "Name" }
      try {
        const data = JSON.parse(ev.data || '{}');
        if (data.winner) {
          setWinnerBanner(data.winner);
          showWinnerModal(data.winner);
        }
      } catch {}
    };

    es.addEventListener('reset', () => {
      clearWinnerBanner();
    });

    es.onerror = () => {
      // stop the console spam if the SSE host is down
      es.close();
      window.__winnerSSE = null;
    };
  } catch {
    // ignore; we’ll keep polling via hydrateWinnerBanner()
  }
}


/* ----------------- Helpers ----------------- */
function isiOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent); }

function setMessage(text = "", color = "#aab") {
  const el = document.getElementById("message");
  if (!el) return;
  el.style.color = color;
  el.textContent = text || "";
  clearTimeout(setMessage._t);
  if (text) setMessage._t = setTimeout(() => (el.textContent = ""), 2000);
}

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (s) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[s]));
}

function setWinnerBanner(name) {
  const banner = document.querySelector(".raffle-title"); if (!banner) return;
  banner.classList.remove("blink");
  banner.innerHTML = `<strong>Tonight's winner is: ${escapeHtml(name)}</strong>`;
}
function clearWinnerBanner() {
  const banner = document.querySelector(".raffle-title"); if (!banner) return;
  banner.classList.add("blink");
  banner.innerHTML = "<strong>ENTER OUR RAFFLE FOR A CHANCE TO WIN A 90 SURGE TEE!</strong>";
  hasShownWinner = false; lastKnownWinner = null; localStorage.removeItem(SHOWN_WINNER_KEY);
}

/* ----------------- Config / headline ----------------- */
function setFollowKeyFromConfig(config) {
  const k = `${config.startTime || ""}|${config.endTime || ""}`;
  SHOWN_WINNER_KEY = `shownWinnerName:${k}`;
}
async function setHeadline() {
  try {
    const res = await fetch("/api/admin?action=config");
    if (!res.ok) throw new Error("config fail");
    const config = await res.json();
    document.getElementById("headline").textContent = config.showName || "90 Surge";
    setFollowKeyFromConfig(config);
    const now = Date.now();
    const start = new Date(config.startTime).getTime();
    const end = new Date(config.endTime).getTime();
    isWindowOpen = now >= start && now <= end;
  } catch {
    document.getElementById("headline").textContent = "LIVE!";
  }
}

/* ----------------- Deep link handling ----------------- */
function openInNewTab(url) {
  try {
    const a = document.createElement("a");
    a.href = url; a.target = "_blank"; a.rel = "noopener";
    a.style.display = "none"; document.body.appendChild(a); a.click(); a.remove();
  } catch {
    try { const w = window.open(url, "_blank", "noopener"); if (!w) location.href = url; }
    catch { location.href = url; }
  }
}
function showManualFallback(webUrl, label) {
  if (!isiOS()) return;
  let bar = document.getElementById("deeplink-fallback");
  if (bar) return;
  bar = document.createElement("div");
  bar.id = "deeplink-fallback";
  bar.style.cssText = `
    position: fixed; left: 0; right: 0; bottom: 12px; z-index: 99999;
    display:flex; justify-content:center;`;
  const inner = document.createElement("div");
  inner.style.cssText = `
    background: rgba(20,20,24,.95); color:#fff; border:1px solid rgba(255,255,255,.15);
    padding: 10px 14px; border-radius: 10px; font-weight: 700;`;
  const a = document.createElement("a");
  a.href = webUrl; a.target = "_blank"; a.rel = "noopener";
  a.textContent = label || "Open in browser";
  a.style.cssText = "color:#7dd3fc; text-decoration:none;";
  inner.appendChild(a); bar.appendChild(inner); document.body.appendChild(bar);
  setTimeout(() => bar.remove(), 7000);
}
function openWithDeepLink(e, { iosScheme, webUrl, webLabel = "Open in browser" }) {
  if (!isiOS()) { openInNewTab(webUrl); return false; }
  if (e) { e.preventDefault(); e.stopPropagation(); }
  let left = false; let timerId = null;
  const cleanup = () => {
    document.removeEventListener("visibilitychange", onVis, true);
    window.removeEventListener("pagehide", onHide, true);
    window.removeEventListener("blur", onHide, true);
    if (timerId) clearTimeout(timerId);
  };
  const onHide = () => { left = true; cleanup(); };
  const onVis = () => { if (document.visibilityState === "hidden") onHide(); };
  document.addEventListener("visibilitychange", onVis, { once: true, capture: true });
  window.addEventListener("pagehide", onHide, { once: true, capture: true });
  window.addEventListener("blur", onHide, { once: true, capture: true });

  window.location.href = iosScheme;
  timerId = setTimeout(() => { if (!left) showManualFallback(webUrl, webLabel); cleanup(); }, 1400);
  return false;
}

/* ----------------- Record entry on click ----------------- */
function getName() {
  return (document.getElementById("user-display-name")?.value || "").trim();
}
function recordEntry(platform) {
  const name = getName();
  if (!isWindowOpen) { setMessage("Raffle is closed right now.", "orange"); return false; }
  if (!name) { setMessage("Enter your name first.", "orange"); return false; }

  // Prefer beacon (works during navigation), fallback to keepalive POST
  let sent = false;
  try {
    if ("sendBeacon" in navigator) {
      const body = new Blob(
        [new URLSearchParams({ platform, name }).toString()],
        { type: "application/x-www-form-urlencoded;charset=UTF-8" }
      );
      sent = navigator.sendBeacon("/api/admin?action=mark-follow", body);
    }
  } catch {}
  if (!sent) {
    try {
      fetch("/api/admin?action=mark-follow", {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ platform, name }).toString(),
      }).catch(() => {});
    } catch {}
  }

  setMessage("🎉 Entry recorded!", "#10b981");
  return true;
}

/* ----------------- Click wrappers ----------------- */
function openFacebook(e) {
  recordEntry("fb");
  return openWithDeepLink(e, {
    iosScheme: `fb://page/${FB_PAGE_ID}`,
    webUrl: FB_PAGE_URL,
    webLabel: "Open Facebook",
  });
}
function openInstagram(e) {
  recordEntry("ig");
  return openWithDeepLink(e, {
    iosScheme: `instagram://user?username=${IG_USERNAME}`,
    webUrl: IG_WEB_URL,
    webLabel: "Open Instagram",
  });
}
window.openFacebook = openFacebook;
window.openInstagram = openInstagram;

/* ----------------- Winner modal + banner ----------------- */
function showWinnerModal(name) {
  if (hasShownWinner) return;
  hasShownWinner = true;
  localStorage.setItem(SHOWN_WINNER_KEY, name);
  document.getElementById("winnerName").textContent = name;
  document.getElementById("winnerModal").classList.remove("hidden");
  triggerConfetti();
}
function hideWinnerModal() { document.getElementById("winnerModal").classList.add("hidden"); }
window.hideWinnerModal = hideWinnerModal;

function triggerConfetti() {
  const duration = 3000; const end = Date.now() + duration;
  (function frame() {
    confetti({ particleCount: 5, angle: 60, spread: 55, origin: { x: 0 } });
    confetti({ particleCount: 5, angle: 120, spread: 55, origin: { x: 1 } });
    if (Date.now() < end) requestAnimationFrame(frame);
  })();
}

async function hydrateWinnerBanner() {
  try {
    const res = await fetch("/api/admin?action=winner", { cache: "no-store" });
    const data = await res.json();
    const winnerName = data?.winner?.name || "";
    initialWinnerFromRest = winnerName || null;
    if (winnerName) { setWinnerBanner(winnerName); lastKnownWinner = winnerName; }
    else { clearWinnerBanner(); }
  } catch { initialWinnerFromRest = null; }
}

function handleIncomingWinner(name) {
  if (!name) return;
  if (name !== lastKnownWinner) { setWinnerBanner(name); lastKnownWinner = name; }
  const shown = localStorage.getItem(SHOWN_WINNER_KEY);
  if (!shown || shown !== name) showWinnerModal(name);
}

function startWinnerWatcher() {
  // SSE (primary)
  try {
    const url =
      location.hostname === "localhost"
        ? "http://localhost:3000/events"
        : "https://winner-sse-server.onrender.com/events";
    const es = new EventSource(url);
    const connectedAt = Date.now();

    es.addEventListener("winner", (evt) => {
      let data = {};
      try { data = JSON.parse(evt.data || "{}"); } catch {}
      const name = (data.winner ?? data.name ?? "").trim();

      if (!sseInitialized) {
        sseInitialized = true;
        // Avoid double-trigger if SSE echoes the same initial winner we already drew from REST
        if (initialWinnerFromRest && name === initialWinnerFromRest) {
          setWinnerBanner(name); lastKnownWinner = name; return;
        }
        // Avoid spurious historical event right after connect
        if (!initialWinnerFromRest && name && Date.now() - connectedAt < 600) return;
      }
      if (name) handleIncomingWinner(name);
    });

    const resetHandler = () => { sseInitialized = true; clearWinnerBanner(); };
    es.addEventListener("reset-winner", resetHandler);
    es.addEventListener("reset", resetHandler);
    es.onerror = () => {/* silent */};
  } catch {}

  // Poll (fallback)
  setInterval(async () => {
    try {
      const r = await fetch("/api/admin?action=winner", { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      const name = (j?.winner?.name || "").trim();
      if (!name && lastKnownWinner) { clearWinnerBanner(); return; }
      if (name && name !== lastKnownWinner) handleIncomingWinner(name);
    } catch {}
  }, 10000);
}

/* ----------------- Follower counts (optional UI) ----------------- */
async function loadFollowerCounts() {
  const setCounts = (fb, ig) => {
    const fbEl = document.getElementById("fb-followers");
    const igEl = document.getElementById("ig-followers");
    if (fbEl) fbEl.textContent = fb > 0 ? String(fb) : "—";
    if (igEl) igEl.textContent = ig > 0 ? String(ig) : "—";
  };

  try {
    const res = await fetch("/api/admin?action=followers", { cache: "no-store" });
    if (!res.ok) throw new Error();
    const data = await res.json();
    const fb = parseInt(data.facebook || 0, 10);
    const ig = parseInt(data.instagram || 0, 10);
    setCounts(fb, ig);
  } catch {
    // silently ignore
  }
}

/* ----------------- Shutdown overlay ----------------- */
function getShutdownOverlay() {
  let ov = document.getElementById("shutdown-overlay");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "shutdown-overlay";
    ov.style.cssText = `
      position: fixed; inset: 0; z-index: 99999;
      display: none; align-items: center; justify-content: center; flex-direction: column;
      background: rgba(0,0,0,0.96); color: #ccc; text-align: center; padding: 24px;`;
    ov.innerHTML = `
      <div class="logo-wrap" style="margin-bottom:16px;">
        <img src="https://pub-d919971fb927454bab9481eee8a435e3.r2.dev/logo-horizontal-white.png" width="200" height="auto" alt="90 Surge">
      </div>
      <h1 style="font-size:2rem; margin:.25rem 0;">⚠️ Sorry, the raffle is closed.</h1>
      <p style="margin:.25rem 0;">See you at our next show!!</p>`;
    document.body.appendChild(ov);
  }
  return ov;
}
function applyShutdownState(on) { getShutdownOverlay().style.display = on ? "flex" : "none"; }
async function checkShutdownStatus() {
  try {
    const res = await fetch("/api/admin?action=shutdown-status", { cache: "no-store" });
    if (!res.ok) throw new Error();
    const { isShutdown } = await res.json();
    applyShutdownState(!!isShutdown);
  } catch {}
}
let shutdownWatcherStarted = false;
function startShutdownWatcher(){
  if (shutdownWatcherStarted) return;
  shutdownWatcherStarted = true;

  const TICK_MS = 2000; // faster poll for snappier toggles
  checkShutdownStatus();
  setInterval(checkShutdownStatus, TICK_MS);

  // same-device instant signal (admin page will post to this)
  let bc = null;
  if ("BroadcastChannel" in window) {
    bc = new BroadcastChannel("surge-admin");
    bc.onmessage = (e) => {
      if (e?.data === "shutdown-toggled") checkShutdownStatus();
    };
  }

  // still keep these for tab/visibility changes
  window.addEventListener("storage", (e)=>{ if (e.key === "shutdownToggle") checkShutdownStatus(); });
  document.addEventListener("visibilitychange", ()=>{ if(!document.hidden) checkShutdownStatus(); });
}


/* ----------------- Init ----------------- */
async function init() {
  startShutdownWatcher();
  await setHeadline();

  const bannerEl = document.querySelector(".raffle-title");
  if (bannerEl && !originalRaffleText) originalRaffleText = bannerEl.innerHTML;

  await hydrateWinnerBanner();
  startWinnerWatcher(); // <-- back in business

  // Name persistence
  const nameInput = document.getElementById("user-display-name");
  const savedName = localStorage.getItem("userName");
  if (savedName) nameInput.value = savedName;
  nameInput.addEventListener("input", () => {
    localStorage.setItem("userName", nameInput.value.trim());
  });

  // follower counts (optional)
  loadFollowerCounts();
  setInterval(loadFollowerCounts, 60000);
}

window.addEventListener("DOMContentLoaded", init);
