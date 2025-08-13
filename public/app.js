// /public/app.js
import confetti from "https://cdn.skypack.dev/canvas-confetti";

/* ----------------- State ----------------- */
let isWindowOpen = false;
let hasShownWinner = false;

const LEGACY_FOLLOW_KEY = "followed"; // legacy (non-namespaced)
let FOLLOW_KEY = "followed";          // namespaced per show window at runtime
let SHOWN_WINNER_KEY = "shownWinner"; // namespaced per show window at runtime

// Per-platform follow keys + delay-unlock timestamp (all namespaced at runtime)
let FOLLOWED_FB_KEY = "followedFB";
let FOLLOWED_IG_KEY = "followedIG";
let FOLLOW_ENABLE_TS_KEY = "followEnableAt";

let lastKnownWinner = null;
let sseInitialized = false;
let originalRaffleText = "";
let initialWinnerFromRest = null;

const FOLLOW_UNLOCK_DELAY_MS = 1200;  // mobile-only UX messaging delay
const FOLLOW_ACTIVATION_DELAY_MS = 3000; // hard gate: 3s before CTA unlock
let unlockTimer = null;

/* ----------------- Social constants ----------------- */
const FB_PAGE_ID = "130023783530481";
const FB_PAGE_URL = "https://www.facebook.com/90surge";
const IG_USERNAME = "90_surge";
const IG_WEB_URL = "https://www.instagram.com/90_surge";

/* ----------------- Deep links ----------------- */
function isiOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent); }
function isAndroid() { return /android/i.test(navigator.userAgent); }
function isMobile() { return isiOS() || isAndroid(); }

// Always open a fresh tab right away (preserves click gesture)
function openInNewTab(url) {
  try {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch {
    try {
      const w = window.open(url, "_blank", "noopener");
      if (!w) location.href = url;
    } catch {
      location.href = url;
    }
  }
}

function showManualFallback(webUrl, label) {
  if (!isiOS()) return; // only iOS gets the helper bar
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
  if (!isiOS()) {
    openInNewTab(webUrl);
    return false;
  }
  // iOS: try app scheme, then show tiny fallback bar if it didn't switch
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
function escapeHtml(str=""){return String(str).replace(/[&<>"']/g,(s)=>({"&":"&amp;","<":"&lt;","&gt;":"&gt;",'"':"&quot;","'":"&#39;"}[s]));}

function setWinnerBanner(name){
  const banner = document.querySelector(".raffle-title"); if (!banner) return;
  banner.classList.remove("blink");
  banner.innerHTML = `<strong>Tonight's winner is: ${escapeHtml(name)}</strong>`;
}
function clearWinnerBanner(){
  const banner = document.querySelector(".raffle-title"); if (!banner) return;
  banner.classList.add("blink");
  banner.innerHTML = "<strong>ENTER OUR RAFFLE FOR A CHANCE TO WIN A 90 SURGE TEE!</strong>";
  hasShownWinner = false; lastKnownWinner = null; localStorage.removeItem(SHOWN_WINNER_KEY);
}

function ensureCtaMessageSlot(){
  let slot = document.getElementById("cta-message");
  if (!slot){
    const locked = document.getElementById("cta-locked");
    const unlocked = document.getElementById("cta-unlocked");
    const ref = locked || unlocked;
    if (ref && ref.parentNode){
      slot = document.createElement("div");
      slot.id = "cta-message";
      slot.className = "message cta-message";
      slot.setAttribute("aria-live","polite");
      ref.parentNode.insertBefore(slot, ref);
    }
  }
  return slot;
}
function setCtaMessage(text="", color="orange"){
  const el = document.getElementById("cta-message"); if(!el) return;
  if(!text){ el.textContent=""; el.classList.remove("show"); return; }
  el.style.color = color; el.textContent = text; el.classList.add("show");
}

/* ----------------- Config / headline ----------------- */
function setFollowKeyFromConfig(config){
  const k = `${config.startTime || ""}|${config.endTime || ""}`;
  FOLLOW_KEY = `followed:${k}`;
  SHOWN_WINNER_KEY = `shownWinnerName:${k}`;

  // Namespaced per-platform keys + the unlock timestamp
  FOLLOWED_FB_KEY = `followedFB:${k}`;
  FOLLOWED_IG_KEY = `followedIG:${k}`;
  FOLLOW_ENABLE_TS_KEY = `followEnableAt:${k}`;

  // Migrate legacy "followed" to the namespaced key if present
  try {
    const legacy = localStorage.getItem(LEGACY_FOLLOW_KEY);
    if (legacy === "true" && !localStorage.getItem(FOLLOW_KEY)) {
      localStorage.setItem(FOLLOW_KEY, "true");
    }
  } catch {}
}
async function setHeadline(){
  try{
    const res = await fetch("/api/admin?action=config");
    if(!res.ok) throw new Error("config fail");
    const config = await res.json();
    document.getElementById("headline").textContent = config.showName || "90 Surge";
    setFollowKeyFromConfig(config);
    const now = Date.now();
    const start = new Date(config.startTime).getTime();
    const end = new Date(config.endTime).getTime();
    isWindowOpen = now >= start && now <= end;
  }catch{
    document.getElementById("headline").textContent = "LIVE!";
  }
}

/* ----------------- Follow state helpers ----------------- */
function markFollowPlatform(platform){
  try {
    if (platform === "fb") localStorage.setItem(FOLLOWED_FB_KEY, "true");
    if (platform === "ig") localStorage.setItem(FOLLOWED_IG_KEY, "true");
    // Keep both general flags too
    localStorage.setItem(LEGACY_FOLLOW_KEY, "true");
    localStorage.setItem(FOLLOW_KEY, "true");
  } catch {}
}

function setFollowEnableAfter(ms){
  try {
    const now = Date.now();
    const current = parseInt(localStorage.getItem(FOLLOW_ENABLE_TS_KEY) || "0", 10);
    // Only set if not already unlocked; don't push the time out if it's already elapsed
    if (!current || current < now) {
      localStorage.setItem(FOLLOW_ENABLE_TS_KEY, String(now + ms));
    }
  } catch {}
}

function isFollowDelayElapsed(){
  try {
    const ts = parseInt(localStorage.getItem(FOLLOW_ENABLE_TS_KEY) || "0", 10);
    return !ts || Date.now() >= ts;
  } catch { return true; }
}

function getFollowBonus(){
  const fb = localStorage.getItem(FOLLOWED_FB_KEY) === "true";
  const ig = localStorage.getItem(FOLLOWED_IG_KEY) === "true";
  return (fb ? 1 : 0) + (ig ? 1 : 0); // 0..2 entries from follows
}

/* ----------------- Follow gate (honor-system + server mark) ----------------- */
async function syncFollowState(){
  try{
    const res = await fetch("/api/admin?action=check-follow", { cache: "no-store" });
    const json = await res.json();
    if (json && json.allowed) {
      localStorage.setItem(FOLLOW_KEY, "true");
      localStorage.setItem(LEGACY_FOLLOW_KEY, "true");
      // don't guess platform-specific on server confirm
    } else {
      localStorage.removeItem(FOLLOW_KEY);
      localStorage.removeItem(LEGACY_FOLLOW_KEY);
    }
  }catch{
    localStorage.removeItem(FOLLOW_KEY);
    localStorage.removeItem(LEGACY_FOLLOW_KEY);
  }
}

function immediateUnlock(platform){
  // 1) Record the platform follow locally (for bonus count)
  markFollowPlatform(platform);

  // 2) Start/keep the 3s unlock timer (only if not already elapsed)
  setFollowEnableAfter(FOLLOW_ACTIVATION_DELAY_MS);

  // 3) Update UI now (still locked until 3s passes)
  renderCTA();

  // 4) Fire-and-forget server mark
  const url = `/api/admin?action=mark-follow&platform=${encodeURIComponent(platform)}`;
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify({ ts: Date.now() })], { type: "application/json" });
      navigator.sendBeacon(url, blob);
    } else {
      fetch(url, { method:"POST", keepalive:true, headers:{ "Content-Type":"application/json" } })
        .catch(()=>{});
    }
  } catch {}

  // 5) Optional mobile UX + state sync
  const delay = isMobile() ? FOLLOW_UNLOCK_DELAY_MS : 0;
  if (delay > 0) setCtaMessage("Opening app… then we’ll enable the button.", "#aab");
  clearTimeout(unlockTimer);
  unlockTimer = setTimeout(async ()=>{
    if (delay > 0) setCtaMessage("Checking…", "#aab");
    await syncFollowState();
    renderCTA();
    if (delay > 0) {
      const ok = (localStorage.getItem(FOLLOW_KEY) === "true") || (localStorage.getItem(LEGACY_FOLLOW_KEY) === "true");
      setCtaMessage(ok ? "✅ You’re good—enter soon!" : "If you just followed, tap again.", ok ? "#10b981" : "orange");
      setTimeout(()=>setCtaMessage(""), 2200);
    } else {
      setCtaMessage("");
    }
  }, delay);
}

/* Deep link wrappers — do NOT await before opening */
function openFacebook(e) {
  immediateUnlock("fb");
  return openWithDeepLink(e, {
    iosScheme: `fb://page/${FB_PAGE_ID}`,
    webUrl: FB_PAGE_URL,
    webLabel: "Open Facebook",
  });
}
function openInstagram(e) {
  immediateUnlock("ig");
  return openWithDeepLink(e, {
    iosScheme: `instagram://user?username=${IG_USERNAME}`,
    webUrl: IG_WEB_URL,
    webLabel: "Open Instagram",
  });
}
window.openFacebook = openFacebook;
window.openInstagram = openInstagram;

function canEnterRaffle(){
  const followed =
    localStorage.getItem(FOLLOW_KEY) === "true" ||
    localStorage.getItem(LEGACY_FOLLOW_KEY) === "true";
  const nameEntered = document.getElementById("user-display-name")?.value.trim() !== "";
  const delayElapsed = isFollowDelayElapsed(); // <-- 3s gate
  return followed && isWindowOpen && nameEntered && delayElapsed;
}
function handleGuardClick(){
  const followed =
    localStorage.getItem(FOLLOW_KEY) === "true" ||
    localStorage.getItem(LEGACY_FOLLOW_KEY) === "true";
  const nameEntered = document.getElementById("user-display-name")?.value.trim() !== "";
  let text = "";
  if (!followed) text = "Tap one of the Facebook/Instagram buttons first.";
  else if (!nameEntered) text = "Enter your name";
  else if (!isWindowOpen) text = "Raffle entries are closed right now.";
  else {
    // Only remaining lock is the 3s timer
    const ts = parseInt(localStorage.getItem(FOLLOW_ENABLE_TS_KEY) || "0", 10);
    const left = Math.max(0, Math.ceil((ts - Date.now()) / 1000));
    text = left > 0 ? `Unlocks in ${left}s…` : "Almost there!";
  }
  setCtaMessage(text, "orange");
  clearTimeout(handleGuardClick._t);
  handleGuardClick._t = setTimeout(() => setCtaMessage(""), 2500);
}
function renderCTA(){
  const locked = document.getElementById("cta-locked");
  const unlocked = document.getElementById("cta-unlocked");
  const allow = canEnterRaffle();
  locked?.classList.toggle("hidden", allow);
  unlocked?.classList.toggle("hidden", !allow);
  if (allow) setCtaMessage("");

  if (!allow){
    const guard = document.getElementById("cta-guard");
    if (guard && !guard.dataset.bound){
      guard.addEventListener("click", handleGuardClick);
      guard.addEventListener("keydown", (e)=>{
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleGuardClick(); }
      });
      guard.dataset.bound = "1";
    }
  }
}

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
  } catch (err) {
    // fall through to dummy
  }

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
    initialWinnerFromRest = winnerName || null;
    if (winnerName){ setWinnerBanner(winnerName); lastKnownWinner = winnerName; }
    else { clearWinnerBanner(); }
  }catch{ initialWinnerFromRest = null; }
}

/* ----------------- Init + raffle entry ----------------- */
async function init(){
  startShutdownWatcher();
  await setHeadline();
  const bannerEl = document.querySelector(".raffle-title");
  if (bannerEl && !originalRaffleText) originalRaffleText = bannerEl.innerHTML;

  await hydrateWinnerBanner();

  const gate = document.getElementById("follow-gate");
  if (gate) gate.style.display = "block";

  ensureCtaMessageSlot();
  await syncFollowState();
  renderCTA();

  // Re-check when returning from IG/FB app
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { syncFollowState().finally(renderCTA); }
  });

  // follower counts
  loadFollowerCounts();
  setInterval(loadFollowerCounts, 60000);

  const form = document.getElementById("raffle-form");
  const message = document.getElementById("message");
  const nameInput = document.getElementById("user-display-name");

  const savedName = localStorage.getItem("userName");
  if (savedName) nameInput.value = savedName;

  nameInput.addEventListener("input", renderCTA);

  // Submit (server re-checks follow state)
  form.addEventListener("submit", async (e)=>{
    e.preventDefault();
    if (!canEnterRaffle()){ handleGuardClick(); return; }

    // Double-check with server right now
    try{
      const chk = await fetch("/api/admin?action=check-follow", { cache:"no-store" });
      const j = await chk.json();
      if (!j?.allowed){
        localStorage.removeItem(FOLLOW_KEY);
        localStorage.removeItem(LEGACY_FOLLOW_KEY);
        renderCTA();
        setCtaMessage("Please tap one of the Follow buttons first.", "orange");
        return;
      }
    }catch{
      setCtaMessage("Network issue—try again.", "orange"); return;
    }

    const name = nameInput.value.trim();
    localStorage.setItem("userName", name);

    try{
      const r = await fetch("/api/admin?action=enter", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ name, followBonus: getFollowBonus() }) // <-- send 0..2
      });
      const j = await r.json();
      if (!r.ok || !j?.success) throw new Error(j?.error || "Entry failed");

      if (message){ message.style.color = "#4caf50"; message.textContent = "🎉 You're in! Good luck!"; }
      renderCTA();
      setTimeout(()=>{ if (message) message.textContent=""; }, 3000);
    }catch(err){
      if (message){ message.style.color = "red"; message.textContent = "❌ " + err.message; }
    }
  });

  /* Winner SSE */
  const extractWinner = (p={}) => (p.winner ?? p.name ?? "").trim();
  const onIncomingWinner = (name)=>{
    if (!name) return;
    if (name !== lastKnownWinner){ setWinnerBanner(name); lastKnownWinner = name; }
    if (!hasShownWinner && name !== localStorage.getItem(SHOWN_WINNER_KEY)){
      showWinnerModal(name);
    }
  };
  const onResetWinner = ()=>{ clearWinnerBanner(); lastKnownWinner = null; };

  try{
    const url = location.hostname === "localhost"
      ? "http://localhost:3001/events"
      : "https://winner-sse-server.onrender.com/events";
    const winnerSSE = new EventSource(url);
    const sseConnectAt = Date.now();

    winnerSSE.addEventListener("winner", (evt)=>{
      let data = {}; try { data = JSON.parse(evt.data||"{}"); } catch {}
      const name = extractWinner(data);
      if (!sseInitialized){
        sseInitialized = true;
        if (initialWinnerFromRest && name === initialWinnerFromRest){
          setWinnerBanner(name); lastKnownWinner = name; return;
        }
        const sinceConnect = Date.now() - sseConnectAt;
        if (!initialWinnerFromRest && name && sinceConnect < 600){ return; }
        if (name) return onIncomingWinner(name);
        return;
      }
      if (name) onIncomingWinner(name);
    });
    const resetHandler = ()=>{ if (!sseInitialized) sseInitialized = true; onResetWinner(); };
    winnerSSE.addEventListener("reset-winner", resetHandler);
    winnerSSE.addEventListener("reset", resetHandler);
    winnerSSE.onerror = ()=>{/*silent*/};
  }catch{}
  // Poll fallback
  setInterval(async ()=>{
    try{
      const r = await fetch("/api/admin?action=winner", { cache:"no-store" });
      if (!r.ok) return;
      const j = await r.json();
      const name = j?.winner?.name?.trim();
      if (!name && lastKnownWinner) onResetWinner();
      if (name && name !== lastKnownWinner) onIncomingWinner(name);
    }catch{}
  }, 10000);
}

window.addEventListener("DOMContentLoaded", init);
