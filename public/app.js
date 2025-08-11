// /public/app.js
import confetti from "https://cdn.skypack.dev/canvas-confetti";

let isWindowOpen = false;
let hasShownWinner = false;

// Namespaced follow + "already shown winner" keys (per show window)
let FOLLOW_KEY = "followed";
let SHOWN_WINNER_KEY = "shownWinnerName";

// Winner/banner state
let lastKnownWinner = null;
let sseInitialized = false;
let originalRaffleText = "";
let initialWinnerFromRest = null;

// ==== Social constants ====
const FB_PAGE_ID = "130023783530481";
const FB_PAGE_URL = "https://www.facebook.com/90surge";
const IG_USERNAME = "90_surge";
const IG_WEB_URL = "https://www.instagram.com/90_surge";

// ---- Facebook SDK loader (robust + logs) ----
async function loadFacebookSDK() {
  const appId = (typeof window !== "undefined" && window.FB_APP_ID) || null;
  if (!appId) {
    console.warn(
      "[FB] window.FB_APP_ID is missing (needs a real Facebook App ID)."
    );
    return false;
  }

  // If SDK already present, just init (or assume already inited)
  if (typeof window.FB !== "undefined" && window.FB?.init) {
    try {
      window.FB.init({ appId, cookie: true, xfbml: false, version: "v19.0" });
      console.log("[FB] SDK already present; initialized with appId:", appId);
      return true;
    } catch (e) {
      console.warn("[FB] Init failed on existing SDK:", e?.message || e);
      // fall through to re-inject
    }
  }

  // Prepare fbAsyncInit so the SDK calls it
  // ---- Facebook SDK init (robust) ----
window.fbAsyncInit = function () {
  try {
    const appId = (typeof window !== "undefined" && window.FB_APP_ID) || null;
    if (!appId) {
      console.warn("[FB] window.FB_APP_ID is missing.");
      return;
    }
    if (typeof window.FB === "undefined") {
      console.warn("[FB] SDK not on window yet.");
      return;
    }
    window.FB.init({ appId, cookie: true, xfbml: false, version: "v19.0" });
    console.log("[FB] SDK initialized with appId:", appId);
  } catch (e) {
    console.warn("[FB] Init failed:", e?.message || e);
  }
};

  // Inject SDK tag once
  if (!document.getElementById("fb-jssdk")) {
    const s = document.createElement("script");
    s.id = "fb-jssdk";
    s.async = true;
    s.defer = true;
    s.crossOrigin = "anonymous";
    s.src = "https://connect.facebook.net/en_US/sdk.js";
    s.onload = () => console.log("[FB] SDK script downloaded");
    s.onerror = (e) => console.error("[FB] SDK script failed to load", e);
    document.head.appendChild(s);
    console.log("[FB] SDK script tag injected");
  }

  return true;
}
/* ----------------- Deep links ----------------- */
function isiOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}
function isAndroid() {
  return /android/i.test(navigator.userAgent);
}

function showManualFallback(webUrl, label) {
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
  a.href = webUrl;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = label || "Open in browser";
  a.style.cssText = "color:#7dd3fc; text-decoration:none;";
  inner.appendChild(a);
  bar.appendChild(inner);
  document.body.appendChild(bar);
  setTimeout(() => bar.remove(), 7000);
}

function openWithDeepLink(
  e,
  { iosScheme, androidIntent, webUrl, webLabel = "Open in browser" }
) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }

  if (isiOS()) {
    let left = false;
    let timerId = null;
    const cleanup = () => {
      document.removeEventListener("visibilitychange", onVis, true);
      window.removeEventListener("pagehide", onHide, true);
      window.removeEventListener("blur", onHide, true);
      if (timerId) clearTimeout(timerId);
    };
    const onHide = () => {
      left = true;
      cleanup();
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") onHide();
    };

    document.addEventListener("visibilitychange", onVis, {
      once: true,
      capture: true,
    });
    window.addEventListener("pagehide", onHide, { once: true, capture: true });
    window.addEventListener("blur", onHide, { once: true, capture: true });

    window.location.href = iosScheme;
    timerId = setTimeout(() => {
      if (!left) showManualFallback(webUrl, webLabel);
      cleanup();
    }, 1400);
    return false;
  }

  // Android/Desktop
  let tab = null;
  try {
    tab = window.open(webUrl, "_blank", "noopener");
  } catch {}
  if (!tab) {
    showManualFallback(webUrl, webLabel);
    return false;
  }
  if (isAndroid())
    setTimeout(() => {
      try {
        tab.location = androidIntent;
      } catch {}
    }, 80);
  return false;
}

// Open FB/IG (do NOT auto-mark follow)
async function openFacebook(e) {
  return openWithDeepLink(e, {
    iosScheme: `fb://page/${FB_PAGE_ID}`,
    androidIntent: `intent://page/${FB_PAGE_ID}#Intent;scheme=fb;package=com.facebook.katana;end`,
    webUrl: FB_PAGE_URL,
    webLabel: "Open Facebook",
  });
}
async function openInstagram(e) {
  return openWithDeepLink(e, {
    iosScheme: `instagram://user?username=${IG_USERNAME}`,
    androidIntent: `intent://instagram.com/_u/${IG_USERNAME}#Intent;scheme=https;package=com.instagram.android;end`,
    webUrl: IG_WEB_URL,
    webLabel: "Open Instagram",
  });
}
window.openFacebook = openFacebook;
window.openInstagram = openInstagram;

/* ----------------- UI helpers ----------------- */
function escapeHtml(str = "") {
  return String(str).replace(
    /[&<>"']/g,
    (s) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        s
      ])
  );
}

function setWinnerBanner(name) {
  const banner = document.querySelector(".raffle-title");
  if (!banner) return;
  banner.classList.remove("blink");
  banner.innerHTML = `<strong>Tonight's winner is: ${escapeHtml(
    name
  )}</strong>`;
}
function clearWinnerBanner() {
  const banner = document.querySelector(".raffle-title");
  if (!banner) return;
  banner.classList.add("blink");
  banner.innerHTML =
    "<strong>ENTER OUR RAFFLE FOR A CHANCE TO WIN A 90 SURGE TEE!</strong>";
  hasShownWinner = false;
  lastKnownWinner = null;
  localStorage.removeItem(SHOWN_WINNER_KEY);
}

/* ----------------- FB verify button ----------------- */
function verifyFacebookFollow() {
  console.log("[FB] verifyFacebookFollow clicked; FB present?", typeof FB !== "undefined");

  const nameEntered = document.getElementById("user-display-name")?.value.trim() !== "";
  if (!nameEntered) { setCtaMessage("Enter your name first.", "orange"); return; }
  if (typeof FB === "undefined") { setCtaMessage("Facebook SDK not loaded yet. Try again in a sec.", "orange"); return; }

  FB.login(function(resp){
    if (!resp || !resp.authResponse || !resp.authResponse.accessToken) {
      setCtaMessage("Facebook login cancelled.", "orange");
      return;
    }
    const accessToken = resp.authResponse.accessToken;

    (async () => {
      try {
        const r = await fetch("/api/admin?action=fb-verify-like", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken }),
        });
        const j = await r.json();

        if (r.ok && j?.success && j?.liked) {
          await syncFollowState();
          renderCTA();
          setCtaMessage("✅ Verified! You can enter now.", "#10b981");
        } else {
          setCtaMessage("We couldn't verify yet. If you just liked us, try again.", "orange");
        }
      } catch (e) {
        console.error(e);
        setCtaMessage("FB verify failed. Please try again.", "red");
      }
    })();
  }, { scope: "user_likes" });
}
window.verifyFacebookFollow = verifyFacebookFollow;

/* ----------------- Headline + config ----------------- */
async function setHeadline() {
  try {
    const res = await fetch("/api/admin?action=config");
    if (!res.ok) throw new Error("config fail");
    const config = await res.json();
    document.getElementById("headline").textContent =
      config.showName || "90 Surge";
    setFollowKeyFromConfig(config);
    const now = Date.now();
    const start = new Date(config.startTime).getTime();
    const end = new Date(config.endTime).getTime();
    isWindowOpen = now >= start && now <= end;
  } catch {
    document.getElementById("headline").textContent = "LIVE!";
  }
}

function ensureCtaMessageSlot() {
  let slot = document.getElementById("cta-message");
  if (!slot) {
    const locked = document.getElementById("cta-locked");
    const unlocked = document.getElementById("cta-unlocked");
    const ref = locked || unlocked;
    if (ref && ref.parentNode) {
      slot = document.createElement("div");
      slot.id = "cta-message";
      slot.className = "message cta-message";
      slot.setAttribute("aria-live", "polite");
      ref.parentNode.insertBefore(slot, ref);
    }
  }
  return slot;
}
function setCtaMessage(text = "", color = "orange") {
  const el = document.getElementById("cta-message");
  if (!el) return;
  if (!text) {
    el.textContent = "";
    el.classList.remove("show");
    return;
  }
  el.style.color = color;
  el.textContent = text;
  el.classList.add("show");
}

function setFollowKeyFromConfig(config) {
  const k = `${config.startTime || ""}|${config.endTime || ""}`;
  FOLLOW_KEY = `followed:${k}`;
  SHOWN_WINNER_KEY = `shownWinnerName:${k}`;
}

/* ----------------- Follow gate (server-verified) ----------------- */
async function syncFollowState() {
  try {
    const res = await fetch("/api/admin?action=check-follow", {
      cache: "no-store",
    });
    const json = await res.json();
    if (json && json.allowed) localStorage.setItem(FOLLOW_KEY, "true");
    else localStorage.removeItem(FOLLOW_KEY);
  } catch {
    localStorage.removeItem(FOLLOW_KEY);
  }
}

function canEnterRaffle() {
  const followed = localStorage.getItem(FOLLOW_KEY) === "true";
  const nameEntered =
    document.getElementById("user-display-name")?.value.trim() !== "";
  return followed && isWindowOpen && nameEntered;
}

function handleGuardClick() {
  const followed = localStorage.getItem(FOLLOW_KEY) === "true";
  const nameEntered =
    document.getElementById("user-display-name")?.value.trim() !== "";
  let text = "";
  if (!followed) text = "But first, follow us on Facebook or Insta :)";
  else if (!nameEntered) text = "Enter your name";
  else if (!isWindowOpen) text = "Raffle entries are closed right now.";
  else text = "Almost there!";
  setCtaMessage(text, "orange");
  clearTimeout(handleGuardClick._t);
  handleGuardClick._t = setTimeout(() => setCtaMessage(""), 2500);
}

function renderCTA() {
  const locked = document.getElementById("cta-locked");
  const unlocked = document.getElementById("cta-unlocked");
  const allow = canEnterRaffle();
  locked?.classList.toggle("hidden", allow);
  unlocked?.classList.toggle("hidden", !allow);
  if (allow) setCtaMessage("");

  if (!allow) {
    const guard = document.getElementById("cta-guard");
    if (guard && !guard.dataset.bound) {
      guard.addEventListener("click", handleGuardClick);
      guard.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleGuardClick();
        }
      });
      guard.dataset.bound = "1";
    }
  }
}

// Pull live follower counts (with a safe fallback)
async function loadFollowerCounts() {
  const setCounts = (fb, ig) => {
    const fbEl = document.getElementById("fb-followers");
    const igEl = document.getElementById("ig-followers");
    if (fbEl) fbEl.textContent = fb > 0 ? String(fb) : "—";
    if (igEl) igEl.textContent = ig > 0 ? String(ig) : "—";
  };

  try {
    const res = await fetch("/api/admin?action=followers", {
      cache: "no-store",
    });
    if (!res.ok) throw new Error("followers fetch failed");
    const data = await res.json();
    const fbCount = parseInt(data.facebook || 0, 10);
    const igCount = parseInt(data.instagram || 0, 10);
    setCounts(fbCount, igCount);
    return;
  } catch (err) {
    console.warn(
      "⚠️ Live follower fetch failed, falling back:",
      err?.message || err
    );
  }

  // Fallback (dev/local dummy)
  try {
    const res2 = await fetch("/api/admin?action=social-counts", {
      cache: "no-store",
    });
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
function getShutdownOverlay() {
  let ov = document.getElementById("shutdown-overlay");
  if (!ov) {
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
function applyShutdownState(on) {
  getShutdownOverlay().style.display = on ? "flex" : "none";
}
async function checkShutdownStatus() {
  try {
    const res = await fetch("/api/admin?action=shutdown-status", {
      cache: "no-store",
    });
    if (!res.ok) throw new Error();
    const { isShutdown } = await res.json();
    applyShutdownState(!!isShutdown);
  } catch {}
}
let shutdownWatcherStarted = false;
function startShutdownWatcher() {
  if (shutdownWatcherStarted) return;
  shutdownWatcherStarted = true;
  checkShutdownStatus();
  setInterval(checkShutdownStatus, 10000);
  window.addEventListener("storage", (e) => {
    if (e.key === "shutdownToggle") checkShutdownStatus();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkShutdownStatus();
  });
}

/* ----------------- Winner modal + banner ----------------- */
function showWinnerModal(name) {
  if (hasShownWinner) return;
  hasShownWinner = true;
  localStorage.setItem(SHOWN_WINNER_KEY, name);
  document.getElementById("winnerName").textContent = name;
  document.getElementById("winnerModal").classList.remove("hidden");
  triggerConfetti();
}
function hideWinnerModal() {
  document.getElementById("winnerModal").classList.add("hidden");
}
window.hideWinnerModal = hideWinnerModal;

function triggerConfetti() {
  const duration = 3000;
  const end = Date.now() + duration;
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
    if (winnerName) {
      setWinnerBanner(winnerName);
      lastKnownWinner = winnerName;
    } else {
      clearWinnerBanner();
    }
  } catch {
    initialWinnerFromRest = null;
  }
}

/* ----------------- Init + raffle entry ----------------- */
async function init() {
  await loadFacebookSDK();
  startShutdownWatcher();
  await setHeadline();
  const bannerEl = document.querySelector(".raffle-title");
  if (bannerEl && !originalRaffleText) originalRaffleText = bannerEl.innerHTML;

  await hydrateWinnerBanner();

  // Ensure follow gate is visible (HTML already contains the buttons + verify)
  const gate = document.getElementById("follow-gate");
  if (gate) gate.style.display = "block";

  ensureCtaMessageSlot();
  await syncFollowState();
  renderCTA();

  // Follower counts
  loadFollowerCounts();
  setInterval(loadFollowerCounts, 60000);

  const form =
    document.getElementById("raffle-form") ||
    document.getElementById("upload-form");
  const message = document.getElementById("message");
  const nameInput = document.getElementById("user-display-name");

  const savedName = localStorage.getItem("userName");
  if (savedName) nameInput.value = savedName;

  nameInput.addEventListener("input", renderCTA);

  // Raffle submit (server-verified follow)
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!canEnterRaffle()) {
      handleGuardClick();
      return;
    }

    // Double-check with server right now
    try {
      const chk = await fetch("/api/admin?action=check-follow", {
        cache: "no-store",
      });
      const j = await chk.json();
      if (!j?.allowed) {
        localStorage.removeItem(FOLLOW_KEY);
        renderCTA();
        setCtaMessage(
          "Please tap Verify after following us on Facebook.",
          "orange"
        );
        return;
      }
    } catch {
      setCtaMessage("Network issue—try again.", "orange");
      return;
    }

    const name = nameInput.value.trim();
    localStorage.setItem("userName", name);

    try {
      // Adjust endpoint if you changed it (admin.js expects /api/admin?action=enter)
      const r = await fetch("/api/admin?action=enter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const j = await r.json();
      if (!r.ok || !j?.success) throw new Error(j?.error || "Entry failed");

      if (message) {
        message.style.color = "#4caf50";
        message.textContent = "🎉 You're in! Good luck!";
      }
      renderCTA();
      setTimeout(() => {
        if (message) message.textContent = "";
      }, 3000);
    } catch (err) {
      if (message) {
        message.style.color = "red";
        message.textContent = "❌ " + err.message;
      }
    }
  });

  /* Winner SSE */
  const extractWinner = (p = {}) => (p.winner ?? p.name ?? "").trim();
  const onIncomingWinner = (name) => {
    if (!name) return;
    if (name !== lastKnownWinner) {
      setWinnerBanner(name);
      lastKnownWinner = name;
    }
    if (!hasShownWinner && name !== localStorage.getItem(SHOWN_WINNER_KEY)) {
      showWinnerModal(name);
    }
  };
  const onResetWinner = () => {
    clearWinnerBanner();
    lastKnownWinner = null;
  };

  try {
    const url =
      location.hostname === "localhost"
        ? "http://localhost:3001/events"
        : "https://winner-sse-server.onrender.com/events";
    const winnerSSE = new EventSource(url);
    const sseConnectAt = Date.now();

    winnerSSE.addEventListener("winner", (evt) => {
      let data = {};
      try {
        data = JSON.parse(evt.data || "{}");
      } catch {}
      const name = extractWinner(data);
      if (!sseInitialized) {
        sseInitialized = true;
        if (initialWinnerFromRest && name === initialWinnerFromRest) {
          setWinnerBanner(name);
          lastKnownWinner = name;
          return;
        }
        const sinceConnect = Date.now() - sseConnectAt;
        if (!initialWinnerFromRest && name && sinceConnect < 600) {
          return;
        }
        if (name) return onIncomingWinner(name);
        return;
      }
      if (name) onIncomingWinner(name);
    });
    const resetHandler = () => {
      if (!sseInitialized) sseInitialized = true;
      onResetWinner();
    };
    winnerSSE.addEventListener("reset-winner", resetHandler);
    winnerSSE.addEventListener("reset", resetHandler);
    winnerSSE.onerror = () => {
      /* silent */
    };
  } catch {}
  // Poll fallback
  setInterval(async () => {
    try {
      const r = await fetch("/api/admin?action=winner", { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      const name = j?.winner?.name?.trim();
      if (!name && lastKnownWinner) onResetWinner();
      if (name && name !== lastKnownWinner) onIncomingWinner(name);
    } catch {}
  }, 10000);
  const verifyBtn = document.getElementById("verify-fb-btn");
  if (verifyBtn && !verifyBtn.dataset.bound) {
    verifyBtn.addEventListener("click", verifyFacebookFollow);
    verifyBtn.dataset.bound = "1";
  }

}


window.addEventListener("DOMContentLoaded", init);
