// /public/app.js
import confetti from "https://cdn.skypack.dev/canvas-confetti";

/* ----------------- State ----------------- */
let isWindowOpen = false;
let hasShownWinner = false;

let SHOWN_WINNER_KEY = "shownWinner"; // namespaced per show window at runtime

/* ----------------- Social constants ----------------- */
const FB_PAGE_ID = "130023783530481";
const FB_PAGE_URL = "https://www.facebook.com/90surge";
const IG_USERNAME = "90_surge";
const IG_WEB_URL = "https://www.instagram.com/90_surge";

/* ----------------- Deep links ----------------- */
function isiOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent); }

// Open HTTPS in a fresh tab without blocking the click gesture
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
  if (!isiOS()) return; // only iOS gets helper bar
  let bar = document.getElementById("deeplink-fallback");
  if (bar) return;
  bar = document.createElement("div");
  bar.id = "deeplink-fallback";
  bar.style.cssText = `
    position: fixed; left: 0; right: 0; bottom: 12px; z-index: 99999;
    display:flex; justify-content:center;
  `;
  const inner = document.createElement("div");
  inner.style.cssText = `
    background: rgba(20,20,24,.95); color:#fff; border:1px solid rgba(255,255,255,.15);
    padding: 10px 14px; border-radius: 10px; font-weight: 700;
  `;
  const a = document.createElement("a");
  a.href = webUrl; a.target = "_blank"; a.rel = "noopener";
  a.textContent = label || "Open in browser";
  a.style.cssText = "color:#7dd3fc; text-decoration:none;";
  inner.appendChild(a); bar.appendChild(inner); document.body.appendChild(bar);
  setTimeout(() => bar.remove(), 7000);
}

function openWithDeepLink(e, { iosScheme, webUrl, webLabel = "Open in browser" }) {
  // Desktop/Android -> open HTTPS in a new tab immediately
  if (!isiOS()) { openInNewTab(webUrl); return false; }

  // iOS: try app scheme, then show a tiny fallback bar if it didn't switch
  if (e) { e.preventDefault(); e.stopPropagation(); }
  let left = false; let timerId = null;
  const cleanup = () => {
    document.removeEventListener("visibilitychange", onVis, true);
    window.removeEventListener("pagehide", onHide, true);
    window.removeEventListener("blur", onHide, true);
    if (timerId) clearTimeout(timerId);
  };
  const onHide = () => { left = true; cleanup(); };
  const onVis  = () => { if (document.visibilityState === "hidden") onHide(); };
  document.addEventListener("visibilitychange", onVis, { once:true, capture:true });
  window.addEventListener("pagehide", onHide, { once:true, capture:true });
  window.addEventListener("blur", onHide, { once:true, capture:true });

  window.location.href = iosScheme;
  timerId = setTimeout(() => { if (!left) showManualFallback(webUrl, webLabel); cleanup(); }, 1400);
  return false;
}

/* ----------------- UI helpers ----------------- */
function escapeHtml(str=""){return String(str).replace(/[&<>"']/g,(s)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[s]));}

function setWinnerBanner(name){
  const banner = document.querySelector(".raffle-title"); if (!banner) return;
  banner.classList.remove("blink");
  banner.innerHTML = `<strong>Tonight's winner is: ${escapeHtml(name)}</strong>`;
}
function clearWinnerBanner(){
  const banner = document.querySelector(".raffle-title"); if (!banner) return;
  banner.classList.add("blink");
  banner.innerHTML = "<strong>ENTER OUR RAFFLE FOR A CHANCE TO WIN A 90 SURGE TEE!</strong>";
  hasShownWinner = false; localStorage.removeItem(SHOWN_WINNER_KEY);
}

function setCtaMessage(text="", color="orange"){
  const el = document.getElementById("message"); if(!el) return;
  if(!text){ el.textContent=""; el.classList.remove("show"); return; }
  el.style.color = color; el.textContent = text; el.classList.add("show");
}

/* ----------------- Config / headline ----------------- */
function setKeysFromConfig(config){
  const k = `${config.startTime || ""}|${config.endTime || ""}`;
  SHOWN_WINNER_KEY = `shownWinnerName:${k}`;
}
async function setHeadline(){
  try{
    const res = await fetch("/api/admin?action=config");
    if(!res.ok) throw new Error("config fail");
    const config = await res.json();
    document.getElementById("headline").textContent = config.showName || "90 Surge";
    setKeysFromConfig(config);
    const now = Date.now();
    const start = new Date(config.startTime).getTime();
    const end = new Date(config.endTime).getTime();
    isWindowOpen = now >= start && now <= end;
  }catch{
    document.getElementById("headline").textContent = "LIVE!";
  }
}

/* ----------------- Entry: only from FB/IG clicks ----------------- */
function getName(){ return document.getElementById("user-display-name")?.value.trim() || ""; }

function recordEntry(platform){
  const name = getName();
  if (!name){ setCtaMessage("Add your name first.", "orange"); return; }
  if (!isWindowOpen){ setCtaMessage("Raffle closed right now.", "orange"); return; }

  const payload = JSON.stringify({ name, platform, fast: true });
  const url = "/api/admin?action=enter";

  try{
    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: "application/json" });
      navigator.sendBeacon(url, blob);
    } else {
      fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: payload, keepalive:true })
        .catch(()=>{});
    }
    setCtaMessage("🎉 Entry recorded!", "#10b981");
    setTimeout(()=>setCtaMessage(""), 2500);
  }catch{
    setCtaMessage("Network issue—try again.", "orange");
  }
}

/* ----------------- Click handlers ----------------- */
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

/* ----------------- Follower counts ----------------- */
async function loadFollowerCounts() {
  const setCounts = (fb, ig) => {
    const fbEl = document.getElementById("fb-followers");
    const igEl = document.getElementById("ig-followers");
    if (fbEl) fbEl.textContent = fb > 0 ? String(fb) : "—";
    if (igEl) igEl.textContent = ig > 0 ? String(ig) : "—";
  };

  try {
    const res = await fetch("/api/admin?action=followers", { cache: "no-store" });
    if (!res.ok) throw new Error("followers fetch failed");
    const data = await res.json();
    const fbCount = parseInt(data.facebook || 0, 10);
    const igCount = parseInt(data.instagram || 0, 10);
    setCounts(fbCount, igCount);
    return;
  } catch {}

  try {
    const res2 = await fetch("/api/admin?action=social-counts", { cache: "no-store" });
    if (res2.ok) {
      const d = await res2.json();
      setCounts(
        parseInt(d.facebook?.followers || 0, 10),
        parseInt(d.instagram?.followers || 0, 10)
      );
    }
  } catch {}
}

/* ----------------- Shutdown overlay ----------------- */
function getShutdownOverlay(){
  let ov = document.getElementById("shutdown-overlay");
  if (!ov){
    ov = document.createElement("div");
    ov.id = "shutdown-overlay";
    ov.style.cssText = `
      position: fixed; inset: 0; z-index: 99999;
      display: none; align-items: center; justify-content: center; flex-direction: column;
      background: rgba(0,0,0,0.96); color: #ccc; text-align: center; padding: 24px;
    `;
    ov.innerHTML = `
      <div class="logo-wrap" style="margin-bottom:16px;">
        <img src="https://pub-d919971fb927454bab9481eee8a435e3.r2.dev/logo-horizontal-white.png" width="200" height="auto" alt="90 Surge">
      </div>
      <h1 style="font-size:2rem; margin:.25rem 0;">⚠️ Sorry, the raffle is closed.</h1>
      <p style="margin:.25rem 0;">Enjoy the show!!</p>
    `;
    document.body.appendChild(ov);
  }
  return ov;
}
function applyShutdownState(on){ getShutdownOverlay().style.display = on ? "flex" : "none"; }
async function checkShutdownStatus(){
  try{
    const res = await fetch("/api/admin?action=shutdown-status", { cache:"no-store" });
    if(!res.ok) throw new Error();
    const { isShutdown } = await res.json();
    applyShutdownState(!!isShutdown);
  }catch{}
}
let shutdownWatcherStarted = false;
function startShutdownWatcher(){
  if (shutdownWatcherStarted) return;
  shutdownWatcherStarted = true;
  checkShutdownStatus(); setInterval(checkShutdownStatus, 10000);
  window.addEventListener("storage", (e)=>{ if (e.key === "shutdownToggle") checkShutdownStatus(); });
  document.addEventListener("visibilitychange", ()=>{ if(!document.hidden) checkShutdownStatus(); });
}

/* ----------------- Winner modal + banner ----------------- */
function showWinnerModal(name){
  if (hasShownWinner) return;
  hasShownWinner = true;
  localStorage.setItem(SHOWN_WINNER_KEY, name);
  document.getElementById("winnerName").textContent = name;
  document.getElementById("winnerModal").classList.remove("hidden");
  triggerConfetti();
}
function hideWinnerModal(){ document.getElementById("winnerModal").classList.add("hidden"); }
window.hideWinnerModal = hideWinnerModal;

function triggerConfetti(){
  const duration = 3000; const end = Date.now() + duration;
  (function frame(){
    confetti({ particleCount: 5, angle: 60, spread: 55, origin: { x: 0 } });
    confetti({ particleCount: 5, angle: 120, spread: 55, origin: { x: 1 } });
    if (Date.now() < end) requestAnimationFrame(frame);
  })();
}

async function hydrateWinnerBanner(){
  try{
    const res = await fetch("/api/admin?action=winner", { cache:"no-store" });
    const data = await res.json();
    const winnerName = data?.winner?.name || "";
    if (winnerName){ setWinnerBanner(winnerName); }
    else { clearWinnerBanner(); }
  }catch{}
}

/* ----------------- Init ----------------- */
async function init(){
  startShutdownWatcher();
  await setHeadline();
  await hydrateWinnerBanner();

  // Make the follow gate visible
  const gate = document.getElementById("follow-gate");
  if (gate) gate.style.display = "block";

  // Name field: just save locally
  const nameInput = document.getElementById("user-display-name");
  const savedName = localStorage.getItem("userName");
  if (savedName) nameInput.value = savedName;
  nameInput.addEventListener("input", () => {
    localStorage.setItem("userName", nameInput.value.trim());
  });

  // follower counts
  loadFollowerCounts();
  setInterval(loadFollowerCounts, 60000);
}

window.addEventListener("DOMContentLoaded", init);
