// /public/app.js
import confetti from "https://cdn.skypack.dev/canvas-confetti";

let isWindowOpen = false;
let r2AccountId = "";
let r2BucketName = "";
let hasShownWinner = false;

// Namespaced follow + "already shown winner" keys (per show window)
let FOLLOW_KEY = "followed";
let SHOWN_WINNER_KEY = "shownWinnerName";

// Winner/banner state
let lastKnownWinner = null; // last winner name we rendered
let sseInitialized = false; // ignore the first SSE replay
let originalRaffleText = ""; // to restore banner on reset
let initialWinnerFromRest = null; // null = none, string = winner we hydrated

// Track live vote streams to close on reload
const voteStreams = new Map();

// ==== Social constants ====
const FB_PAGE_ID = "130023783530481";
const FB_PAGE_URL = "https://www.facebook.com/90surge";
const IG_USERNAME = "90_surge";
const IG_WEB_URL = "https://www.instagram.com/90_surge";

// ----------------- Helpers -----------------
async function fetchEnv() {
  try {
    const res = await fetch("/api/env");
    const data = await res.json();
    r2AccountId = data.r2AccountId;
    r2BucketName = data.r2BucketName;
  } catch (err) {
    console.error("❌ Failed to fetch R2 env vars:", err);
  }
}

function isiOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}
function isAndroid() {
  return /android/i.test(navigator.userAgent);
}

// Small, manual fallback chip (does not hijack current tab)
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

/**
 * iOS: try native app via location to scheme; if we never leave page, show *manual* fallback.
 * Android: open web FIRST in a new tab; then try intent in that tab (no blank page if not installed).
 * Desktop: open web in a new tab.
 * This never auto-navigates the current tab to web on iOS, so no "back" problem or double-open.
 */
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

    // Try to open the native app
    window.location.href = iosScheme;

    // If app didn’t open, offer manual web link (don’t auto-nav this tab)
    timerId = setTimeout(() => {
      if (!left) showManualFallback(webUrl, webLabel);
      cleanup();
    }, 1400);

    return false;
  }

  // Android / Desktop
  let tab = null;
  try {
    tab = window.open(webUrl, "_blank", "noopener");
  } catch {}
  if (!tab) {
    showManualFallback(webUrl, webLabel);
    return false;
  }

  if (isAndroid()) {
    // If the app isn't installed, this simply leaves the tab on the web profile.
    setTimeout(() => {
      try {
        tab.location = androidIntent;
      } catch {}
    }, 80);
  }
  return false;
}

// Facebook
async function openFacebook(e) {
  try {
    await followClick("fb");
  } catch {}
  return openWithDeepLink(e, {
    iosScheme: `fb://page/${FB_PAGE_ID}`,
    androidIntent: `intent://page/${FB_PAGE_ID}#Intent;scheme=fb;package=com.facebook.katana;end`,
    webUrl: FB_PAGE_URL,
    webLabel: "Open Facebook",
  });
}
window.openFacebook = openFacebook;

// Instagram
async function openInstagram(e) {
  try {
    await followClick("ig");
  } catch {}
  return openWithDeepLink(e, {
    iosScheme: `instagram://user?username=${IG_USERNAME}`,
    androidIntent: `intent://instagram.com/_u/${IG_USERNAME}#Intent;scheme=https;package=com.instagram.android;end`,
    webUrl: IG_WEB_URL,
    webLabel: "Open Instagram",
  });
}
window.openInstagram = openInstagram;

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
    originalRaffleText ||
    "<strong>ENTER OUR RAFFLE FOR A CHANCE TO WIN A 90 SURGE TEE!</strong>";
  hasShownWinner = false;
  lastKnownWinner = null;
  localStorage.removeItem(SHOWN_WINNER_KEY);
}

async function setHeadline() {
  try {
    const res = await fetch("/api/admin?action=config");
    if (!res.ok) throw new Error("Failed to fetch config");
    const config = await res.json();
    document.getElementById("headline").textContent =
      config.showName || "90 Surge";
  } catch (err) {
    console.error("Error setting headline:", err);
    document.getElementById("headline").textContent = "LIVE!";
  }
}

// Ensure we have a message slot *above* the CTA.
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

async function loadFollowerCounts() {
  try {
    const res = await fetch("/api/admin?action=followers");
    const data = await res.json();
    const fbCount = parseInt(data.facebook || 0, 10);
    const igCount = parseInt(data.instagram || 0, 10);
    document.getElementById("fb-followers").textContent =
      fbCount > 0 ? String(fbCount) : "—";
    document.getElementById("ig-followers").textContent =
      igCount > 0 ? String(igCount) : "—";
  } catch (err) {
    console.warn("⚠️ Failed to fetch follower counts", err);
  }
}

// Fetch config, set window open + namespaced follow key
async function checkUploadWindow() {
  try {
    const res = await fetch("/api/admin?action=config");
    if (!res.ok) throw new Error("Config fetch failed");
    const config = await res.json();

    setFollowKeyFromConfig(config);

    const now = Date.now();
    const start = new Date(config.startTime).getTime();
    const end = new Date(config.endTime).getTime();
    isWindowOpen = now >= start && now <= end;
  } catch (err) {
    console.error("Failed to check upload window", err);
  }
}

// Build/refresh the follow gate (BUTTONS, not anchors)
function buildFollowGate() {
  const gate = document.getElementById("follow-gate");
  if (!gate) return;
  gate.innerHTML = `
    <div class="follow-links" style="display:flex; justify-content:center; gap:1rem;">
      <button type="button" class="follow-btn-fb" role="link" onclick="return openFacebook(event)">Facebook</button>
      <button type="button" class="follow-btn-ig" role="link" onclick="return openInstagram(event)">Instagram</button>
    </div>`;
  gate.style.display = "block";
}

// Fetch with timeout (longer so cold-starts don't spam errors)
async function getWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new DOMException("Timeout", "AbortError")),
    ms
  );
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Ask server if this IP is allowed for THIS show; sync localStorage
async function syncFollowState() {
  try {
    const res = await fetch("/api/admin?action=check-follow", {
      cache: "no-store",
    });
    const json = await res.json();
    if (json && json.allowed) {
      localStorage.setItem(FOLLOW_KEY, "true");
    } else {
      localStorage.removeItem(FOLLOW_KEY);
    }
  } catch {
    localStorage.removeItem(FOLLOW_KEY);
  }
}

// ----------------- Upload gating UI -----------------
function canUpload() {
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
  else if (!isWindowOpen) text = "Uploads are closed right now.";
  else text = "Forgot a step?";

  setCtaMessage(text, "orange");

  clearTimeout(handleGuardClick._t);
  handleGuardClick._t = setTimeout(() => setCtaMessage(""), 2500);
}

function renderCTA() {
  const locked = document.getElementById("cta-locked");
  const unlocked = document.getElementById("cta-unlocked");
  const allow = canUpload();

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

// Called by the follow buttons (inline onclick in HTML)
async function followClick(platform) {
  try {
    await fetch(
      `/api/admin?action=mark-follow&platform=${encodeURIComponent(platform)}`,
      {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (_) {}
  localStorage.setItem(FOLLOW_KEY, "true");
  renderCTA();
}
window.followClick = followClick; // expose for inline HTML

// ----- shutdown real time ----
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
      <p style="margin:.25rem 0;">We'll be back soon.</p>
    `;
    document.body.appendChild(ov);
  }
  return ov;
}

function applyShutdownState(on) {
  const ov = getShutdownOverlay();
  ov.style.display = on ? "flex" : "none";
}

async function checkShutdownStatus() {
  try {
    const res = await fetch("/api/admin?action=shutdown-status", {
      cache: "no-store",
    });
    if (!res.ok) throw new Error("status fetch failed");
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

// ----------------- Gallery / Votes (robust) -----------------
async function loadGallery() {
  const gallery = document.getElementById("gallery");
  if (!gallery) return;
  gallery.innerHTML = "";

  // Close any previous vote streams to avoid leaks
  for (const s of voteStreams.values()) {
    try { s.close(); } catch {}
  }
  voteStreams.clear();

  // Helpers
  const keyFromUrl = (url = "") => {
    try { return new URL(url).pathname.split("/").pop() || url; }
    catch { return url || Math.random().toString(36).slice(2); }
  };
  const parseEpochFromName = (name = "") => {
    const m = name.match(/_(\d{10,13})_/);
    if (!m) return 0;
    const n = m[1].length === 13 ? Number(m[1]) : Number(m[1]) * 1000;
    return Number.isFinite(n) ? n : 0;
  };
  const bust = (u) => u + (u.includes("?") ? "&" : "?") + "v=" + Date.now();

  // 1) primary: uploads metadata
  let uploads = [];
  try {
    const uploadsRes = await fetch("/api/admin?action=uploads", { cache: "no-store" });
    uploads = await uploadsRes.json();
    if (!Array.isArray(uploads)) uploads = [];
  } catch (e) {
    console.warn("uploads fetch failed", e);
    uploads = [];
  }

  // 2) dedupe by fileName (fallback fileUrl basename)
  const byKey = new Map();
  for (const u of uploads) {
    const k = u.fileName || keyFromUrl(u.fileUrl);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, u);
  }

  // 3) optional R2 fallback if list looks sparse (e.g., after Redis clears)
  try {
    if (byKey.size < 8 && r2AccountId && r2BucketName) {
      const r2Res = await fetch("/api/admin?action=list-r2-files", { cache: "no-store" });
      if (r2Res.ok) {
        const r2 = await r2Res.json();
        const files = Array.isArray(r2.files) ? r2.files : [];
        for (const f of files) {
          const k = f.key;
          if (!k || byKey.has(k)) continue;
          const fileUrl = `https://${r2AccountId}.r2.cloudflarestorage.com/${r2BucketName}/${k}`;
          byKey.set(k, {
            id: k,
            fileName: k,
            fileUrl,
            userName: "(unknown)",
            userNameRaw: "(unknown)",
            votes: 0,
            createdTime: f.lastModified || null,
            _r2LastMod: f.lastModified || null,
          });
        }
      }
    }
  } catch (e) {
    console.warn("R2 fallback listing failed (non-fatal)", e);
  }

  // 4) sort newest first
  const items = Array.from(byKey.values()).sort((a, b) => {
    const ta =
      new Date(a.createdTime || 0).getTime() ||
      parseEpochFromName(a.fileName || "") ||
      new Date(a._r2LastMod || 0).getTime() ||
      0;
    const tb =
      new Date(b.createdTime || 0).getTime() ||
      parseEpochFromName(b.fileName || "") ||
      new Date(b._r2LastMod || 0).getTime() ||
      0;
    return tb - ta;
  });

  if (!items.length) {
    gallery.textContent = "Nothing here yet. Be the first to upload!";
    return;
  }

  // 5) preload each image; append only on load success (skip deleted/404)
  for (const upload of items) {
    const id = upload.id || upload.fileName || keyFromUrl(upload.fileUrl);
    const fileUrl = upload.fileUrl;

    const imgEl = new Image();
    imgEl.decoding = "async";
    imgEl.loading = "lazy";

    await new Promise((resolve) => {
      let retried = false;
      const addCard = () => {
        const card = document.createElement("div");
        card.className = "card";
        card.dataset.id = id;

        const wrapper = document.createElement("div");
        wrapper.style.position = "relative";

        // adopt preloaded image
        imgEl.style.cursor = "pointer";
        imgEl.style.height = "200px";
        imgEl.style.width = "100%";
        imgEl.style.objectFit = "cover";
        imgEl.style.filter = "blur(8px)";
        imgEl.style.transition = "filter 0.5s";
        imgEl.addEventListener("load", () => (imgEl.style.filter = "none"));
        imgEl.addEventListener("click", () => {
          const modal = document.getElementById("imageModal");
          document.getElementById("fullImage").src = fileUrl;
          modal.classList.remove("hidden");
        });

        // footer: row1 name + likes, row2 button
        const info = document.createElement("div");
        info.className = "info";

        const displayName = upload.userName || upload.userNameRaw || "Anonymous";
        const nameEl = document.createElement("span");
        nameEl.textContent = `@${displayName}`;

        const voteInfo = document.createElement("span");
        voteInfo.className = "vote-info";
        voteInfo.textContent = `${upload.votes || 0} ❤️`;

        const voteRow = document.createElement("div");
        voteRow.className = "vote-row";

        const voteKey = `voted_${id}`;
        const hasVoted = localStorage.getItem(voteKey) === "1";

        if (!hasVoted) {
          const upvoteBtn = document.createElement("button");
          upvoteBtn.className = "btn-compact";
          upvoteBtn.textContent = "Love it!";
          upvoteBtn.addEventListener("click", async () => {
            upvoteBtn.disabled = true;
            try {
              const res = await fetch("/api/admin?action=upvote", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ fileId: id }),
              });
              const result = await res.json();
              if (!res.ok || !result.success) throw new Error("Vote failed");

              localStorage.setItem(voteKey, "1");
              voteInfo.textContent = `${result.votes} ❤️`;
              upvoteBtn.remove();
            } catch (err) {
              console.error(err);
              upvoteBtn.disabled = false;
              upvoteBtn.textContent = "Love it!";
            }
          });
          voteRow.appendChild(upvoteBtn);
        }

        info.appendChild(nameEl);
        info.appendChild(voteInfo);
        info.appendChild(voteRow);

        wrapper.appendChild(imgEl);
        card.appendChild(wrapper);
        card.appendChild(info);
        gallery.appendChild(card);

        // Live vote updates (one stream per id)
        try {
          const es = new EventSource(
            `https://vote-stream-server.onrender.com/votes/${encodeURIComponent(id)}`
          );
          es.onmessage = (event) => {
            try {
              const { votes } = JSON.parse(event.data || "{}");
              if (typeof votes === "number") voteInfo.textContent = `${votes} ❤️`;
            } catch {}
          };
          es.onerror = () => {
            try { es.close(); } catch {}
            voteStreams.delete(id);
          };
          voteStreams.set(id, es);
        } catch {}
        resolve();
      };

      imgEl.onload = addCard;
      imgEl.onerror = () => {
        if (!retried) {
          retried = true;
          imgEl.src = bust(fileUrl); // one retry with cache-bust
        } else {
          // skip this tile entirely (deleted/missing)
          resolve();
        }
      };
      // initial load with cache-bust too (handles R2 eventual consistency)
      imgEl.src = bust(fileUrl);
    });
  }

  // Edge: if everything skipped but uploads existed, try a gentle refresh once
  if (uploads.length && !gallery.children.length) {
    setTimeout(() => loadGallery(), 1200);
  }
}

// ----------------- Winner modal + banner -----------------
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

// hydrate winner on load (NO modal here)
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

// ----------------- Main init -----------------
async function init() {
  startShutdownWatcher();
  await setHeadline();

  const bannerEl = document.querySelector(".raffle-title");
  if (bannerEl && !originalRaffleText) originalRaffleText = bannerEl.innerHTML;

  await fetchEnv();

  await hydrateWinnerBanner();
  await checkUploadWindow();
  buildFollowGate();

  ensureCtaMessageSlot();

  await syncFollowState();
  renderCTA();
  await loadGallery();
  await loadFollowerCounts();

  // Refresh gallery instantly when admin deletes (admin sets localStorage 'galleryRefresh')
  window.addEventListener("storage", (e) => {
    if (e.key === "galleryRefresh") loadGallery();
  });

  const form = document.getElementById("upload-form");
  const message = document.getElementById("message");
  const fileInput = document.getElementById("file");
  const nameInput = document.getElementById("user-display-name");
  const progress = document.getElementById("progress");

  const filePicked = document.getElementById("file-picked");
  if (filePicked && fileInput) {
    fileInput.addEventListener("change", () => {
      const f = fileInput.files[0];
      filePicked.textContent = f ? f.name : "";
    });
  }

  const savedName = localStorage.getItem("userName");
  if (savedName) nameInput.value = savedName;

  // Submit handler (shows guard message immediately if blocked)
  form.addEventListener("submit", async (e) => {
    if (!canUpload()) {
      e.preventDefault();
      handleGuardClick();
      return;
    }

    e.preventDefault();
    message.textContent = "";
    const file = fileInput.files[0];
    const userName = nameInput.value.trim();

    if (!file || !userName) {
      message.style.color = "orange";
      message.textContent = "Name and file are required.";
      return;
    }

    const originalName = file.name.toLowerCase().replace(/\s+/g, "_");
    const uploadKey = `uploaded_${userName.toLowerCase()}_${originalName}`;
    if (localStorage.getItem(uploadKey)) {
      message.style.color = "orange";
      message.textContent = "⚠️ You've already uploaded this file.";
      return;
    }

    localStorage.setItem("userName", userName);

    const sanitize = (str) =>
      String(str || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/gi, "_")
        .replace(/^_+|_+$/g, "");
    const fileName = `${sanitize(userName)}_${Date.now()}_${sanitize(
      file.name
    )}`;
    const fileUrl = `https://${r2AccountId}.r2.cloudflarestorage.com/${r2BucketName}/${fileName}`;
    const mimeType = file.type;

    progress.style.display = "block";
    progress.value = 0;
    message.style.color = "#999";
    message.textContent = "⏳ Uploading...";

    try {
      // 1) get presigned URL
      const presignRes = await fetch("/api/get-upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName, mimeType }),
      });
      const { url } = await presignRes.json();
      if (!url) throw new Error("Failed to get presigned URL");

      // 2) PUT to R2
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", url, true);
        xhr.setRequestHeader("Content-Type", mimeType);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            progress.value = Math.round((e.loaded / e.total) * 100);
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error("Upload failed with status " + xhr.status));
        };
        xhr.onerror = () => reject(new Error("Network error during upload"));
        xhr.send(file);
      });

      // 3) save metadata
      const metadata = {
        fileName,
        fileUrl,
        mimeType,
        userName,
        originalFileName: file.name,
      };
      const metaRes = await fetch("/api/admin?action=save-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(metadata),
      });
      const metaData = await metaRes.json();
      if (!metaData.success) {
        await fetch("/api/admin?action=delete-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileId: fileName }),
        });
        throw new Error("Metadata save failed. File deleted.");
      }

      message.style.color = "#4caf50";
      message.textContent = "✅ Upload complete!";
      fileInput.value = "";
      progress.value = 100;
      localStorage.setItem(uploadKey, "1");
      loadGallery();

      // hide success message + progress bar after 3s
      setTimeout(() => {
        message.textContent = "";
        progress.style.display = "none";
        progress.value = 0;
      }, 3000);
    } catch (err) {
      console.error("❌ Upload error:", err);
      message.style.color = "red";
      message.textContent = "❌ Upload failed: " + err.message;
      progress.style.display = "none";
    }
  });

  // Live UI updates
  nameInput.addEventListener("input", renderCTA);
  fileInput.addEventListener("change", renderCTA);

  // ===== Winner SSE (robust first-pick handling) =====
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

  let winnerSSE;
  try {
    const url =
      location.hostname === "localhost"
        ? "http://localhost:3001/events"
        : "https://winner-sse-server.onrender.com/events";

    winnerSSE = new EventSource(url);
    const sseConnectAt = Date.now();

    winnerSSE.addEventListener("winner", (evt) => {
      let data = {};
      try { data = JSON.parse(evt.data || "{}"); } catch {}
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
          // likely a replay
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

    winnerSSE.onerror = (e) => {
      console.warn("Winner SSE error; will fall back to polling.", e?.message || e);
    };
  } catch (e) {
    console.warn("Failed to start Winner SSE; will use polling.", e?.message || e);
  }

  // Fallback polling (keeps banner in sync if SSE down)
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

  // ===== Vote reset SSE (unchanged) =====
  const evtSource = new EventSource("https://vote-stream-server.onrender.com");
  evtSource.addEventListener("reset", () => {
    Object.keys(localStorage).forEach((k) => {
      if (k.startsWith("voted_")) localStorage.removeItem(k);
    });
    loadGallery();
    console.log("🎯 Votes reset via SSE. Local votes cleared.");
  });
}

// Entry point
window.addEventListener("DOMContentLoaded", init);
