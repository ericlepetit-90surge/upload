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
let lastKnownWinner = null; // last name we rendered
let sseInitialized = false; // ignore the first SSE replay
let originalRaffleText = ""; // to restore banner on reset
let initialWinnerFromRest = null; // null = none, string = winner we hydrated

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

// ==== Deep-link helpers (prevents double-open) ====
function isiOS(){ return /iPad|iPhone|iPod/.test(navigator.userAgent); }
function isAndroid(){ return /android/i.test(navigator.userAgent); }

function showManualFallback(webUrl, label) {
  let bar = document.getElementById('deeplink-fallback');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'deeplink-fallback';
    bar.style.cssText = `
      position: fixed; left: 0; right: 0; bottom: 12px; z-index: 99999;
      display:flex; justify-content:center;
    `;
    const inner = document.createElement('div');
    inner.style.cssText = `
      background: rgba(20,20,24,.95); color:#fff; border:1px solid rgba(255,255,255,.15);
      padding: 10px 14px; border-radius: 10px; font-weight: 700;
    `;
    const a = document.createElement('a');
    a.href = webUrl; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = label || 'Open in browser';
    a.style.cssText = 'color:#7dd3fc; text-decoration:none;';
    inner.appendChild(a);
    bar.appendChild(inner);
    document.body.appendChild(bar);
    setTimeout(()=> bar.remove(), 7000);
  }
}

/**
 * iOS: try app scheme; if it fails, show *manual* fallback (no auto navigation).
 * Android/desktop: use placeholder-tab fallback so current tab never navigates.
 */
function openWithDeepLink(e, { iosScheme, androidIntent, webUrl }) {
  if (e) e.preventDefault();

  // iOS: never navigate current tab as fallback
  if (isiOS()) {
    let leftPage = false;
    const cleanup = () => {
      document.removeEventListener('visibilitychange', onHide, true);
      window.removeEventListener('pagehide', onHide, true);
      window.removeEventListener('blur', onHide, true);
      clearTimeout(t);
    };
    const onHide = () => { leftPage = true; cleanup(); };

    document.addEventListener('visibilitychange', onHide, { once:true, capture:true });
    window.addEventListener('pagehide', onHide, { once:true, capture:true });
    window.addEventListener('blur', onHide, { once:true, capture:true });

    const t = setTimeout(() => {
      if (!leftPage) {
        // App didn't open: show a small CTA instead of hijacking this tab
        showManualFallback(webUrl, 'Open in Facebook');
      }
      cleanup();
    }, 1400);

    // Try to open native app
    window.location.href = iosScheme;
    return;
  }

  // Android / Desktop: placeholder tab that we close if app opens
  let fallbackTab = null;
  try { fallbackTab = window.open('about:blank', '_blank', 'noopener'); } catch {}

  let left = false;
  const cleanup = () => {
    document.removeEventListener('visibilitychange', onHide, true);
    window.removeEventListener('pagehide', onHide, true);
    window.removeEventListener('blur', onHide, true);
    clearTimeout(timer);
  };
  const onHide = () => { left = true; cleanup(); };

  document.addEventListener('visibilitychange', onHide, { once:true, capture:true });
  window.addEventListener('pagehide', onHide, { once:true, capture:true });
  window.addEventListener('blur', onHide, { once:true, capture:true });

  const timer = setTimeout(() => {
    if (!left) {
      if (fallbackTab) {
        try { fallbackTab.location = webUrl; } catch { /* ignore */ }
      } else {
        // last resort if popup blocked: don’t touch current tab
        showManualFallback(webUrl, 'Open in browser');
      }
    } else {
      try { fallbackTab && fallbackTab.close(); } catch {}
    }
    cleanup();
  }, 1400);

  if (isAndroid()) {
    window.location.href = androidIntent;
  } else {
    // desktop: just use the web in the placeholder tab
    if (fallbackTab) { try { fallbackTab.location = webUrl; } catch {} }
    cleanup();
  }
}

// Facebook
async function openFacebook(e){
  try { await followClick('fb'); } catch {}
  openWithDeepLink(e, {
    iosScheme: `fb://page/130023783530481`,
    androidIntent: `intent://page/130023783530481#Intent;scheme=fb;package=com.facebook.katana;end`,
    webUrl: `https://www.facebook.com/90surge`
  });
}
window.openFacebook = openFacebook;

// Instagram
async function openInstagram(e){
  try { await followClick('ig'); } catch {}
  openWithDeepLink(e, {
    iosScheme: `instagram://user?username=90_surge`,
    androidIntent: `intent://instagram.com/_u/90_surge#Intent;scheme=https;package=com.instagram.android;end`,
    webUrl: `https://www.instagram.com/90_surge`
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

// Build/refresh the follow gate with clickable links
function buildFollowGate() {
  const gate = document.getElementById("follow-gate");
  if (!gate) return;
  gate.innerHTML = `
    <div class="follow-links" style="display:flex; justify-content:center; gap:1rem;">
      <a href="${FB_PAGE_URL}" class="follow-btn-fb" onclick="openFacebook(event)">Facebook</a>
      <a href="${IG_WEB_URL}" class="follow-btn-ig" onclick="openInstagram(event)">Instagram</a>
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

// Called by the follow links (inline onclick in HTML)
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
let shutdownIntervalId = null;

function startShutdownWatcher() {
  if (shutdownWatcherStarted) return;
  shutdownWatcherStarted = true;
  checkShutdownStatus();
  shutdownIntervalId = setInterval(checkShutdownStatus, 10000);
  window.addEventListener("storage", (e) => {
    if (e.key === "shutdownToggle") checkShutdownStatus();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkShutdownStatus();
  });
}

// ----------------- Gallery / Votes -----------------
async function loadGallery() {
  try {
    const uploadsRes = await fetch("/api/admin?action=uploads");
    const uploads = await uploadsRes.json();
    const gallery = document.getElementById("gallery");
    gallery.innerHTML = "";

    // unique by id/fileName
    const uniqueMap = new Map();
    uploads.forEach((upload) => {
      const id = upload.id || upload.fileName;
      if (!uniqueMap.has(id)) uniqueMap.set(id, upload);
    });

    const uniqueUploads = Array.from(uniqueMap.values()).sort((a, b) => {
      const aTime = new Date(a.createdTime || 0).getTime();
      const bTime = new Date(b.createdTime || 0).getTime();
      return bTime - aTime;
    });

    uniqueUploads.forEach((upload) => {
      const id = upload.id || upload.fileName;

      const card = document.createElement("div");
      card.className = "card";
      card.dataset.id = id;

      const wrapper = document.createElement("div");
      wrapper.style.position = "relative";

      const img = document.createElement("img");
      img.src = upload.fileUrl;
      img.loading = "lazy";
      img.style.cursor = "pointer";
      img.style.height = "200px";
      img.style.width = "100%";
      img.style.objectFit = "cover";
      img.style.filter = "blur(8px)";
      img.style.transition = "filter 0.5s";
      img.addEventListener("load", () => (img.style.filter = "none"));
      img.addEventListener("click", () => {
        const modal = document.getElementById("imageModal");
        document.getElementById("fullImage").src = upload.fileUrl;
        modal.classList.remove("hidden");
      });

      // footer (two rows: name+likes on top, button below)
      const info = document.createElement("div");
      info.className = "info";

      const displayName = upload.userName || upload.userNameRaw || "Anonymous";
      const nameEl = document.createElement("span");
      nameEl.textContent = `@${displayName}`;

      // ❤️ count (right side of row 1)
      const voteInfo = document.createElement("span");
      voteInfo.className = "vote-info";
      voteInfo.textContent = `${upload.votes || 0} ❤️`;

      // row 2 container for the vote button
      const voteRow = document.createElement("div");
      voteRow.className = "vote-row";

      // upvote button (removed after vote)
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

      // assemble footer
      info.appendChild(nameEl); // row 1, left
      info.appendChild(voteInfo); // row 1, right
      info.appendChild(voteRow); // row 2, spans both

      wrapper.appendChild(img);
      card.appendChild(wrapper);
      card.appendChild(info);
      gallery.appendChild(card);

      // Live vote updates (SSE) — update the hearts count inline
      const voteStream = new EventSource(
        `https://vote-stream-server.onrender.com/votes/${id}`
      );
      voteStream.onmessage = (event) => {
        const { votes } = JSON.parse(event.data);
        voteInfo.textContent = `${votes} ❤️`;
      };
      voteStream.onerror = () => {
        console.warn(`❌ Vote stream error for ${id}`);
        voteStream.close();
      };
    });
  } catch (err) {
    console.error("❌ Failed to load gallery", err);
    document.getElementById("gallery").textContent = "Failed to load gallery.";
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

  await hydrateWinnerBanner();
  await checkUploadWindow();
  buildFollowGate();

  ensureCtaMessageSlot();

  await syncFollowState();
  renderCTA();
  await loadGallery();
  await loadFollowerCounts();
  await fetchEnv();

  const form = document.getElementById("upload-form");
  const message = document.getElementById("message");
  const fileInput = document.getElementById("file");
  const nameInput = document.getElementById("user-display-name");
  const progress = document.getElementById("progress");

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

  // ===== Winner SSE (single handler; ignore stale replays) =====
  const extractWinner = (p = {}) => (p.winner ?? p.name ?? "").trim();

  const onIncomingWinner = (name, { isFirst = false } = {}) => {
    if (!name) return;
    if (name !== lastKnownWinner) {
      setWinnerBanner(name);
      lastKnownWinner = name;
    }
    if (
      !isFirst &&
      !hasShownWinner &&
      name !== localStorage.getItem(SHOWN_WINNER_KEY)
    ) {
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

    // Named winner event only
    winnerSSE.addEventListener("winner", (evt) => {
      let data = {};
      try {
        data = JSON.parse(evt.data || "{}");
      } catch {}
      const name = extractWinner(data);

      if (!sseInitialized) {
        sseInitialized = true;

        // If REST said "no winner", treat the first replayed winner as stale and ignore it
        if (!initialWinnerFromRest && name) {
          return; // ignore stale replay
        }

        if (name) {
          return onIncomingWinner(name, { isFirst: true });
        }
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
      console.warn(
        "Winner SSE error; will fall back to polling.",
        e?.message || e
      );
      // EventSource retries automatically
    };
  } catch (e) {
    console.warn(
      "Failed to start Winner SSE; will use polling.",
      e?.message || e
    );
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
