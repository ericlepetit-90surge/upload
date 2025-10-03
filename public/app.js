// /public/app.js
(() => {
  const FACEBOOK_URL = "https://facebook.com/90Surge";
  const INSTAGRAM_URL = "https://instagram.com/90_Surge";

  const FB_HANDLE = "90Surge";
  const IG_USERNAME = "90_Surge";

  const FB_PAGE_ID =
    (typeof window !== "undefined" && window.__FB_PAGE_ID) ||
    document.documentElement.getAttribute("data-fb-page-id") ||
    "";

  // Prefer the local Next API on 3000 when the page is served from a different port/origin.
  const API_BASE =
    (typeof window.API_BASE === "string" && window.API_BASE) ||
    ((location.hostname === "localhost" || location.hostname === "127.0.0.1")
      ? (location.port === "3000" ? "" : "http://localhost:3000")
      : "");

  // Helper to prefix relative /api/... paths with API_BASE when needed
  const fullUrl = (u) => (u && u.startsWith("/api/") ? `${API_BASE}${u}` : u);

  const NAME_KEY = "raffle_display_name";
  const $ = (s, r = document) => r.querySelector(s);

  const nameEl = () => $("#user-display-name");
  const getName = () => (nameEl()?.value || "").trim().slice(0, 80);

  const WINNER_SSE_URL = ""; // optional SSE server

  // ── Round-start override (only used when server startTime is missing) ──
  const ROUND_START_KEY = "roundStartAtMs";
  const autoPickGuard = new Set(); // holds version keys to avoid duplicate triggers

  let __winnerLocked = false;

  function getRoundStartOverride() {
    const v = Number(sessionStorage.getItem(ROUND_START_KEY));
    return Number.isFinite(v) ? v : null;
  }
  function setRoundStartOverride(ms = Date.now()) {
    try { sessionStorage.setItem(ROUND_START_KEY, String(ms)); } catch {}
    autoPickGuard.clear();
    clearEffectiveStartPin();
  }

  // Smooth, iOS-safe scroll lock for modals
  let __scrollY_at_lock = 0;
  function lockScroll() {
    __scrollY_at_lock = window.scrollY || document.documentElement.scrollTop || 0;
    document.documentElement.classList.add("modal-open");
    document.body.classList.add("modal-open");
    document.body.style.position = "fixed";
    document.body.style.top = `-${__scrollY_at_lock}px`;
    document.body.style.width = "100%";
  }
  function unlockScroll() {
    document.documentElement.classList.remove("modal-open");
    document.body.classList.remove("modal-open");
    document.body.style.position = "";
    document.body.style.top = "";
    document.body.style.width = "";
    try { void document.body.offsetHeight; } catch {}
    window.scrollTo(0, __scrollY_at_lock || 0);
  }

  // ──────────────────────────────────────────────────────────────
  // Name persistence
  // ──────────────────────────────────────────────────────────────
  function initNamePersistence() {
    const el = nameEl();
    if (!el) return;
    const saved = localStorage.getItem(NAME_KEY);
    if (saved) el.value = saved;
    el.addEventListener("input", () => {
      localStorage.setItem(NAME_KEY, getName());
      debounceRefreshStats();
    });
  }
  function requireName() {
    const n = getName();
    if (!n) {
      try {
        nameEl()?.focus();
        nameEl()?.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch {}
      alert("Please enter your name first 🙂");
      return false;
    }
    return true;
  }

  async function postJSON(url, body, { keepalive = false } = {}) {
    const full = fullUrl(url);
    const res = await fetch(full, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive,
      body: JSON.stringify(body || {}),
    });
    let json = {};
    try { json = await res.json(); } catch {}
    if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
    return json;
  }

  // ──────────────────────────────────────────────────────────────
  // Entries submission
  // ──────────────────────────────────────────────────────────────
  async function submitEntryOnce(source) {
    const name = getName();
    if (!name) return { ok: false, error: "Missing name" };
    try {
      const out = await postJSON("/api/admin?action=enter", { name, source });
      refreshEntryStats().catch(() => {});
      if (!__winnerLocked) startWinnerCountdown(true);
      if (out?.already) return { ok: true, already: true };
      return { ok: true, already: false };
    } catch (e) {
      console.error(`[entry] failed ${source}:`, e?.message || e);
      return { ok: false, error: e?.message || "submit failed" };
    }
  }
  function submitEntryOnceBeacon(source) {
    const name = getName();
    if (!name) return;
    const url = fullUrl("/api/admin?action=enter");
    const data = JSON.stringify({ name, source });
    const blob = new Blob([data], { type: "application/json" });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, blob);
    } else {
      postJSON(url, { name, source }, { keepalive: true }).catch(() => {});
    }
    setTimeout(() => {
      refreshEntryStats().catch(() => {});
      if (!__winnerLocked) startWinnerCountdown(true);
    }, 600);
  }

  window.submitEntryOnce = submitEntryOnce;
  window.canSubmitFor = (source) => !!getName();

  // ──────────────────────────────────────────────────────────────
  // Social mark
  // ──────────────────────────────────────────────────────────────
  async function markFollow(platform) {
    const url = fullUrl(`/api/admin?action=mark-follow&platform=${encodeURIComponent(platform)}`);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform }),
    });
    if (!res.ok) {
      let msg = "mark-follow failed";
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }
  }
  function markFollowBeacon(platform) {
    const url = fullUrl(`/api/admin?action=mark-follow&platform=${encodeURIComponent(platform)}`);
    const blob = new Blob([JSON.stringify({ platform })], { type: "application/json" });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, blob);
    } else {
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: blob, keepalive: true }).catch(() => {});
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Followers counts
  // ──────────────────────────────────────────────────────────────
  async function refreshFollowers() {
    const fbEl = $("#fb-followers"), igEl = $("#ig-followers");
    const url = `${API_BASE}/api/admin?action=followers&debug=1&_=${Date.now()}`;

    try {
      const res = await fetch(url, { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      const fb = Number(j?.facebook ?? 0);
      const ig = Number(j?.instagram ?? 0);
      if (fbEl) fbEl.textContent = Number.isFinite(fb) ? fb.toLocaleString() : "—";
      if (igEl) igEl.textContent = Number.isFinite(ig) ? ig.toLocaleString() : "—";
      console.log("[followers]", { url, ok: res.ok, status: res.status, data: j });
    } catch (e) {
      if (fbEl) fbEl.textContent = "—";
      if (igEl) igEl.textContent = "—";
      console.warn("[followers] fetch failed", e?.message || e);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Prize helpers + jackpot logging (STRICT from result only)
  // ──────────────────────────────────────────────────────────────
  const KNOWN_PRIZES = new Set(["Sticker", "T-Shirt", "VIP Seat", "Extra Entry", "Jackpot"]);
  const EMOJI_MAP = new Map([
    ["🍒", "Cherry"], ["🍌", "Banana"], ["🍋", "Lemon"], ["⭐", "Star"],
    ["💎", "Diamond"], ["🔔", "Bell"], ["🍇", "Grape"], ["🍊", "Orange"], ["7", "Seven"],
  ]);

  function extractTargetText(t) {
    if (t == null) return "";
    if (typeof t === "string") return t.trim();
    if (typeof t === "object") {
      const fields = ["prize","label","title","name","text","emoji","symbol","value"];
      for (const k of fields) if (t[k] != null && String(t[k]).trim()) return String(t[k]).trim();
      try { return String(t).trim(); } catch { return ""; }
    }
    return String(t).trim();
  }
  function canonicalFromReelToken(raw) {
    let s = (raw || "").toString().trim();
    if (!s) return "";
    if (EMOJI_MAP.has(s)) s = EMOJI_MAP.get(s);
    s = s.replace(/\btee\s*-?\s*shirt\b/i, "T-Shirt");
    const lower = s.toLowerCase();
    if (/^vip(\s*seat|s)?$/.test(lower) || lower === "vip" || lower === "vip seat") return "VIP Seat";
    if (/^(t-?\s*shirt|tshirt|t\s*shirt|tee\s*shirt|tee|shirt)$/.test(lower))   return "T-Shirt";
    if (/^stickers?$/.test(lower))                                             return "Sticker";
    if (/^(extra\s*entry|extra|bonus\s*entry|free\s*entry)$/.test(lower) ||
        lower === "extra entry")                                               return "Extra Entry";
    if (/^jackpot$/.test(lower))                                               return "Jackpot";
    return "";
  }

  // HTML escape for safe winner injection
  function escHtml(s) {
    return String(s ?? '')
      .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
      .replaceAll('"','&quot;').replaceAll("'",'&#39;');
  }

  let __awardedExtraThisSpin = false;
  let __awardResetTimer = null;
  function markExtraAwardedOnce() {
    __awardedExtraThisSpin = true;
    clearTimeout(__awardResetTimer);
    __awardResetTimer = setTimeout(() => { __awardedExtraThisSpin = false; }, 5000);
  }

  async function logSpin(targets, jackpot) {
    if (!jackpot) return;
    if (!Array.isArray(targets) || targets.length < 3) return;

    const name = getName() || "(anonymous)";
    const ts = Date.now();
    const payload = { name, targets, jackpot: true, ts, source: "slot" };

    // Beacon first
    let sent = false;
    try {
      if ("sendBeacon" in navigator) {
        const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
        sent = navigator.sendBeacon(fullUrl("/api/admin?action=prize-log"), blob);
      }
    } catch {}
    if (sent) return;

    try { await postJSON("/api/admin?action=prize-log", payload); }
    catch (e) { console.warn("logSpin POST failed:", e?.message || e); }
  }

  // ──────────────────────────────────────────────────────────────
  // Entry Stats
  // ──────────────────────────────────────────────────────────────
  function ensureEntryStatsUI() {
    if (!$("#entry-stats")) console.warn("[entry-stats] #entry-stats container not found.");
  }

  let prevYour = 0, prevTotal = 0;

  function bump(el) {
    if (!el) return;
    el.classList.remove("entry-bump");
    el.offsetWidth; // reflow
    el.classList.add("entry-bump");
    setTimeout(() => el.classList.remove("entry-bump"), 400);
  }

  async function refreshEntryStats() {
    ensureEntryStatsUI();
    const yourEl = $("#your-entries-count") || $("#raffle-entries");
    const totalEl = $("#total-entries-count");

    try {
      const res = await fetch(fullUrl("/api/admin?action=my-entries"), { cache: "no-store" });
      if (res.ok) {
        const j = await res.json();
        let mine = Number(j?.mine ?? 0);
        let total = Number(j?.total ?? 0);
        if (!Number.isFinite(mine)) mine = 0;
        if (!Number.isFinite(total)) total = 0;
        if (total <= 0) mine = 0;
        else if (mine > total) mine = total;

        const cfg = cfgMem || readCfgCache();
        const serverStartOk = Number.isFinite(parseStartMs(cfg?.startTime));
        if (!serverStartOk && total === 0 && !lastWinner && !getRoundStartOverride()) {
          setRoundStartOverride(Date.now());
        }

        if (totalEl) {
          const old = prevTotal;
          totalEl.textContent = total.toLocaleString();
          if (total > old) bump(totalEl);
          prevTotal = total;
        }
        if (yourEl) {
          const old = prevYour;
          yourEl.textContent = mine.toLocaleString();
          if (mine > old) bump(yourEl);
          prevYour = mine;
        }
        return;
      }
    } catch {}

    // Fallback
    try {
      const res = await fetch(fullUrl("/api/admin?action=entries"), { cache: "no-store" });
      const j = await res.json().catch(() => ({ entries: [], count: 0 }));
      const total = Number(j?.count || 0);

      const totalEl2 = $("#total-entries-count");
      if (totalEl2) {
        const old = prevTotal;
        totalEl2.textContent = total.toLocaleString();
        if (total > old) bump(totalEl2);
        prevTotal = total;
      }
      const yourEl2 = $("#your-entries-count") || $("#raffle-entries");
      if (yourEl2) {
        if (total === 0) prevYour = 0;
        yourEl2.textContent = prevYour.toLocaleString();
      }
    } catch {
      const totalEl2 = $("#total-entries-count");
      if (totalEl2) totalEl2.textContent = "—";
      const yourEl2 = $("#your-entries-count") || $("#raffle-entries");
      if (yourEl2) yourEl2.textContent = "0";
    }
  }

  let _nameDebounce;
  function debounceRefreshStats() {
    clearTimeout(_nameDebounce);
    _nameDebounce = setTimeout(refreshEntryStats, 250);
  }

  // ──────────────────────────────────────────────────────────────
  // Device helpers + follow buttons
  // ──────────────────────────────────────────────────────────────
  function isAndroid() { return /\bAndroid\b/i.test(navigator.userAgent); }
  function isIOS()     { return /\b(iPhone|iPad|iPod)\b/i.test(navigator.userAgent); }

  function getAppSchemes(platform) {
    if (platform === "ig") return [`instagram://user?username=${IG_USERNAME}`];
    const schemes = [];
    const id = (FB_PAGE_ID || "").trim();
    if (id) {
      if (isIOS()) {
        schemes.push(`fb://profile/${id}`, `fb://page/?id=${id}`, `fb://page/${id}`);
      } else {
        schemes.push(`fb://page/${id}`, `fb://profile/${id}`, `fb://page/?id=${id}`);
      }
    } else {
      schemes.push(`fb://facewebmodal/f?href=${encodeURIComponent(FACEBOOK_URL)}`);
    }
    return schemes;
  }

  function openAppAndTrack(platform, { timeout = 1800 } = {}) {
    return new Promise((resolve) => {
      const schemes = getAppSchemes(platform);
      let done = false, iframe = null, attemptIdx = 0;

      const cleanup = () => {
        document.removeEventListener("visibilitychange", onVis, true);
        window.removeEventListener("pagehide", onHidden, true);
        window.removeEventListener("blur", onBlur, true);
        clearTimeout(timer); clearTimeout(stepper);
        if (iframe && iframe.parentNode) { try { document.body.removeChild(iframe); } catch {} }
      };

      const onHidden = () => {
        if (done) return; done = true;
        try { markFollowBeacon(platform); } catch {}
        try { submitEntryOnceBeacon(platform); } catch {}
        cleanup(); resolve(true);
      };
      const onVis  = () => { if (document.visibilityState === "hidden") onHidden(); };
      const onBlur = () => { setTimeout(onHidden, 0); };

      document.addEventListener("visibilitychange", onVis, { once: true, capture: true });
      window.addEventListener("pagehide", onHidden, { once: true, capture: true });
      window.addEventListener("blur", onBlur, { once: true, capture: true });

      const tryOne = (url) => {
        try {
          if (isAndroid()) {
            iframe = document.createElement("iframe");
            iframe.style.display = "none";
            iframe.src = url;
            document.body.appendChild(iframe);
            setTimeout(() => { try { if (iframe && iframe.parentNode) document.body.removeChild(iframe); } catch {} }, 2000);
          } else {
            window.location.href = url; // iOS
          }
        } catch {}
      };

      if (schemes.length) { tryOne(schemes[0]); attemptIdx = 1; }
      const step = () => {
        if (done || attemptIdx >= schemes.length) return;
        tryOne(schemes[attemptIdx++]);
        if (!done && attemptIdx < schemes.length) stepper = setTimeout(step, 600);
      };
      let stepper = setTimeout(step, 600);

      const timer = setTimeout(() => { if (done) return; done = true; cleanup(); resolve(false); }, timeout);
    });
  }

  let globalFollowLock = false;
  function setDisabled(el, val) { if (!el) return; try { el.disabled = !!val; } catch {} el.classList.toggle("is-disabled", !!val); }
  async function handleFollow(platform, btn) {
    if (!requireName()) return;
    if (globalFollowLock) return;
    globalFollowLock = true;
    setDisabled(btn, true);
    try {
      if (isAndroid() || isIOS()) {
        await openAppAndTrack(platform);
      } else {
        try { const url = platform === "fb" ? FACEBOOK_URL : INSTAGRAM_URL; if (url) window.open(url, "_blank", "noopener"); } catch {}
        await markFollow(platform);
        await submitEntryOnce(platform);
      }
    } catch (err) {
      console.warn(`[follow] ${platform} flow error:`, err?.message || err);
    } finally {
      setTimeout(() => { globalFollowLock = false; setDisabled(btn, false); }, 700);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll('a[href^="intent://"]').forEach((a) => {
      const href = a.getAttribute("href") || "";
      const isFb = /facebook|katana|\/profile\//i.test(href);
      a.setAttribute("href", isFb ? FACEBOOK_URL : INSTAGRAM_URL);
      a.classList.add(isFb ? "follow-btn-fb" : "follow-btn-ig");
    });
  }, { once: true });

  // unified delegated click listener
  document.addEventListener("click", (e) => {
    const fbSel = '.follow-btn-fb, a[href*="facebook.com"]';
    const igSel = '.follow-btn-ig, a[href*="instagram.com"]';
    const a = e.target.closest(fbSel) || e.target.closest(igSel) || null;
    if (!a) return;
    const isFb = !!e.target.closest(fbSel) || /facebook|katana|\/profile\//i.test(a.getAttribute("href") || "");
    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();
    handleFollow(isFb ? "fb" : "ig", a);
  }, true);

  window.openFacebook = (ev) => { ev?.preventDefault?.(); const el = document.querySelector(".follow-btn-fb") || document.querySelector('a[href*="facebook.com"]'); if (el) handleFollow("fb", el); return false; };
  window.openInstagram = (ev) => { ev?.preventDefault?.(); const el = document.querySelector(".follow-btn-ig") || document.querySelector('a[href*="instagram.com"]'); if (el) handleFollow("ig", el); return false; };

  // --- Jackpot modal wiring ---
  function ensureJackpotModal() {
    const modal = document.getElementById("jackpot-modal");
    if (!modal) return null;
    if (modal.__wired) return modal;
    modal.__wired = true;

    const close = () => {
      modal.classList.add("hidden");
      modal.setAttribute("aria-hidden", "true");
      unlockScroll();
    };

    modal.addEventListener("click", (e) => {
      if (
        e.target.classList.contains("modal-overlay") ||
        e.target.matches("[data-close]") ||
        e.target.closest?.("[data-close]")
      ) {
        e.preventDefault();
        close();
      }
    }, true);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.classList.contains("hidden")) close();
    });

    modal.__close = close;
    return modal;
  }

  function showJackpotModal(label, message) {
    const modal = ensureJackpotModal();
    if (!modal) { alert(`🎰 JACKPOT!\n${label}\n\n${message || ""}`); return; }
    const prizeEl = document.getElementById("jackpot-prize");
    const msgEl   = document.getElementById("jackpot-message");
    if (prizeEl) prizeEl.textContent = label || "";
    if (msgEl)   msgEl.textContent = message || "";
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    lockScroll();
    try { modal.querySelector("[data-close]")?.focus(); } catch {}
  }

  window.__showJackpotModal = showJackpotModal;

  // ──────────────────────────────────────────────────────────────
  // Slot hookup (modal instead of inline)
  // ──────────────────────────────────────────────────────────────
  function initSlot() {
    if (typeof window.initSlotMachine !== "function") {
      console.warn("[slot] initSlotMachine missing; skipping hook");
      return;
    }

    let lastHandledAt = 0;
    const handleResult = async (result) => {
      try {
        const now = Date.now();
        if (now - lastHandledAt < 150) return;
        lastHandledAt = now;

        const rawTargets = Array.isArray(result?.targets) ? result.targets : [];
        const labels = rawTargets.map(extractTargetText).filter(Boolean);
        const norm = labels.map(canonicalFromReelToken).filter(Boolean);

        const okTriple =
          norm.length >= 3 &&
          norm[0] && norm[0] === norm[1] && norm[1] === norm[2] &&
          KNOWN_PRIZES.has(norm[0]);

        if (!okTriple) return;

        const primary = norm[0];
        const triple = [primary, primary, primary];

        // Log jackpot (server ledger)
        await logSpin(triple, true);

        // Grab inline text that slot.js wrote, then clear it
        const resultEl = document.getElementById("slot-result");
        const inlineMsg = (resultEl?.textContent || "").trim();
        if (resultEl) resultEl.textContent = ""; // hide inline

        // Show modal with whatever message slot.js produced
        window.__showJackpotModal(primary, inlineMsg || `${primary}`);

        if (primary === "Extra Entry") {
          refreshEntryStats().catch(() => {});
        }
      } catch (err) {
        console.warn("[slot] handleResult error:", err?.message || err);
      }
    };

    window.initSlotMachine("#slot-root", { onResult: handleResult });
  }

  // ──────────────────────────────────────────────────────────────
  // HEADLINE CONFIG + CACHE
  // ──────────────────────────────────────────────────────────────
  const CFG_CACHE_KEY = "cfg";
  function readCfgCache() { try { return JSON.parse(sessionStorage.getItem(CFG_CACHE_KEY) || "null"); } catch { return null; } }
  function writeCfgCache(cfg) { try { sessionStorage.setItem(CFG_CACHE_KEY, JSON.stringify(cfg)); } catch {} }

  async function fetchConfigFresh() {
    const res = await fetch(fullUrl(`/api/admin?action=config&_=${Date.now()}`), {
      cache: "no-store",
      headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
    });
    if (!res.ok) throw new Error(`config fetch failed: ${res.status}`);
    return await res.json();
  }

  const HEADLINE_SELECTORS = ["#headline", ".show-name", "[data-headline]"];
  function setHeadlineText(name) {
    const text = name && name.trim() ? name : "90 Surge";
    HEADLINE_SELECTORS.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => (el.textContent = text));
    });
  }

  async function initConfigHeadline(force = false) {
    const cached = force ? null : readCfgCache();
    if (cached?.showName) setHeadlineText(cached.showName || "90 Surge");
    try {
      const fresh = await fetchConfigFresh();
      if (!cached || fresh.version !== cached.version || fresh.showName !== cached.showName) {
        writeCfgCache(fresh); setHeadlineText(fresh.showName || "90 Surge");
      }
    } catch (e) {
      console.debug("[config] headline refresh skipped:", e?.message || e);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Winner countdown (TOP-LEVEL again)
  // ──────────────────────────────────────────────────────────────
  const WINNER_DELAY_MS = 2.5 * 60 * 60 * 1000;
  let __countdownTimer = null;
  let __ensurePickTimer = null;

  let cfgMem = null;
  let pickAtMem = null;

  function parseStartMs(startTime) {
    if (!startTime) return NaN;
    let t = Date.parse(startTime);
    if (Number.isFinite(t)) return t;
    const m = String(startTime).trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/);
    if (m) return new Date(`${m[1]}T${m[2]}`).getTime();
    return NaN;
  }

  const EFFECTIVE_START_KEY = "effectiveStartMs";
  const EFFECTIVE_VER_KEY   = "effectiveStartVer";

  function clearEffectiveStartPin() {
    try {
      sessionStorage.removeItem(EFFECTIVE_START_KEY);
      sessionStorage.removeItem(EFFECTIVE_VER_KEY);
    } catch {}
  }

  function getEffectiveStartMs(cfg) {
    const serverMs = parseStartMs(cfg?.startTime);
    if (Number.isFinite(serverMs)) {
      try {
        sessionStorage.setItem(EFFECTIVE_START_KEY, String(serverMs));
        sessionStorage.setItem(EFFECTIVE_VER_KEY, String(cfg?.version ?? "nov"));
      } catch {}
      return serverMs;
    }
    const ver = String(cfg?.version ?? "nov");
    const cachedVer = sessionStorage.getItem(EFFECTIVE_VER_KEY);
    let pinned = Number(sessionStorage.getItem(EFFECTIVE_START_KEY));
    if (cachedVer !== ver || !Number.isFinite(pinned)) {
      const clientMs = getRoundStartOverride();
      pinned = Number.isFinite(clientMs) ? clientMs : Date.now();
      try {
        sessionStorage.setItem(EFFECTIVE_START_KEY, String(pinned));
        sessionStorage.setItem(EFFECTIVE_VER_KEY, ver);
      } catch {}
    }
    return pinned;
  }

  // Prefer server-provided autoPickAt when available; fallback to startTime + 2h30
  function computePickAtFromCfg(cfg) {
    const ap = Date.parse(cfg?.autoPickAt || "");
    if (Number.isFinite(ap)) return ap;
    const startMs = getEffectiveStartMs(cfg);
    return Number.isFinite(startMs) ? startMs + WINNER_DELAY_MS : NaN;
  }

  function setCfgMem(cfg) {
    cfgMem = cfg;
    writeCfgCache(cfg);
    pickAtMem = computePickAtFromCfg(cfgMem);
  }

  let __countdownVisible = null;
  function setCountdownVisible(visible) {
    if (__countdownVisible === visible) return;
    __countdownVisible = visible;
    document.querySelectorAll("#winner-countdown, [data-winner-countdown], #winner-countdown-text")
      .forEach((el) => { el.style.display = visible ? "" : "none"; });
  }

  function stopWinnerCountdownTimers() {
    if (__countdownTimer)  { clearInterval(__countdownTimer);  __countdownTimer  = null; }
    if (__ensurePickTimer) { clearInterval(__ensurePickTimer); __ensurePickTimer = null; }
  }

  async function triggerAutoPick() {
    try {
      await fetch(fullUrl("/api/admin?action=maybe-auto-pick"), { method: "POST", keepalive: true });
    } catch {}
  }

  async function refreshConfigAuthoritative() {
    try {
      const fresh = await fetchConfigFresh();
      setCfgMem(fresh);
    } catch {
      if (!cfgMem) cfgMem = readCfgCache() || null;
      pickAtMem = computePickAtFromCfg(cfgMem || {});
    }
  }

  // After triggering, poll for the winner briefly to avoid “Picking…” hang
  async function verifyAndMaybeAutoPick() {
    await refreshConfigAuthoritative();

    if (!Number.isFinite(pickAtMem)) {
      const el = document.getElementById("winner-countdown-text") ||
                 document.querySelector("[data-winner-countdown]") ||
                 document.getElementById("winner-countdown");
      if (el) el.textContent = "—";
      stopWinnerCountdownTimers();
      return;
    }

    if (Date.now() < pickAtMem) {
      startWinnerCountdown(false);
      return;
    }

    const guardKey = cfgMem?.version ?? `ts:${Math.floor(pickAtMem / 60000)}`;
    let triggered = false;
    if (!autoPickGuard.has(guardKey)) {
      autoPickGuard.add(guardKey);
      await triggerAutoPick();
      triggered = true;
    }

    // Fast local poll: up to ~6s total
    for (let i = 0; i < 8; i++) {
      const name = await fetchWinnerOnce();
      if (name) { maybeDisplayWinner(name); return; }
      await new Promise((r) => setTimeout(r, 750));
    }

    // Still no winner — release guard so we can try again on the next tick
    if (triggered) autoPickGuard.delete(guardKey);

    const textEl =
      document.getElementById("winner-countdown-text") ||
      document.querySelector("[data-winner-countdown]") ||
      document.getElementById("winner-countdown");
    if (textEl) textEl.textContent = "Picking…";
    setTimeout(() => startWinnerCountdown(true), 3000);
  }

  // ⬇️ TOP-LEVEL startWinnerCountdown (accessible to all callers)
  async function startWinnerCountdown(forceRefresh = false) {
    const textEl =
      document.getElementById("winner-countdown-text") ||
      document.querySelector("[data-winner-countdown]") ||
      document.getElementById("winner-countdown");
    if (!textEl) return;

    // Only hide when an actual winner is on screen
    const hasWinner = !!lastWinner && __winnerLocked;
    if (hasWinner) {
      setCountdownVisible(false);
      stopWinnerCountdownTimers();
      return;
    }

    stopWinnerCountdownTimers();

    if (forceRefresh || !cfgMem) {
      await refreshConfigAuthoritative();
    } else if (!Number.isFinite(pickAtMem)) {
      pickAtMem = computePickAtFromCfg(cfgMem || {});
    }

    // Always show the widget while counting down
    setCountdownVisible(true);

    if (!Number.isFinite(pickAtMem)) {
      textEl.textContent = "—";
      return;
    }

    const write = (s) => {
      if (textEl.id === "winner-countdown-text") textEl.textContent = s;
      else textEl.textContent = `Winner picked in: ${s}`;
    };

    const tick = async () => {
      if (lastWinner && __winnerLocked) {
        setCountdownVisible(false);
        stopWinnerCountdownTimers();
        return;
      }
      const diff = pickAtMem - Date.now();
      if (diff <= 0) {
        write("Picking…");
        stopWinnerCountdownTimers();
        await verifyAndMaybeAutoPick();
        return;
      }
      const sec = Math.floor(diff / 1000);
      const d = Math.floor(sec / 86400);
      const h = Math.floor((sec % 86400) / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      write(d > 0 ? `${d}d ${h}h ${m}m ${s}s` : h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`);
    };

    await tick();
    __countdownTimer = setInterval(tick, 1000);
    __ensurePickTimer = setInterval(async () => {
      if (lastWinner && __winnerLocked) {
        setCountdownVisible(false);
        stopWinnerCountdownTimers();
        return;
      }
      if (Date.now() >= pickAtMem) {
        stopWinnerCountdownTimers();
        await verifyAndMaybeAutoPick();
      }
    }, 30000);
  }

  // ──────────────────────────────────────────────────────────────
  // Winner UI
  // ──────────────────────────────────────────────────────────────
  const SHOWN_WINNER_KEY = "shownWinnerName";
  let lastWinner = null;

  function winnerBannerEl() {
    return document.querySelector(".raffle.raffle-title.blink") ||
           document.querySelector("[data-winner-banner]");
  }
  function setWinnerBanner(name) {
    const el = winnerBannerEl();
    if (!el.getAttribute("data-default")) {
      el.setAttribute("data-default", el.textContent || "Free T-shirt raffle!");
    }
    if (name) {
      el.textContent = `Woohooo! Tonight's winner is ${name}!`;
      el.classList.add("has-winner");
    } else {
      const fallback = el.getAttribute("data-default") || "Free T-shirt raffle!";
      el.textContent = fallback;
      el.classList.remove("has-winner");
    }
  }

  function ensureWinnerModal() {
    const modal =
      document.getElementById("winnerModal") ||
      document.getElementById("winner-modal") ||
      document.querySelector(".winner-modal");
    if (!modal) return null;
    if (modal.__wired) return modal;
    modal.__wired = true;

    const close = () => {
      modal.classList.add("hidden");
      modal.setAttribute("aria-hidden", "true");
      unlockScroll();
    };

    modal.addEventListener("click", (e) => {
      if (
        e.target.classList.contains("modal-overlay") ||
        e.target.matches("[data-close], .btn-modal-close, .winner-close, .modal-close") ||
        e.target.closest?.("[data-close], .btn-modal-close, .winner-close, .modal-close")
      ) {
        e.preventDefault();
        close();
      }
    }, true);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.classList.contains("hidden")) close();
    });

    modal.__close = close;
    return modal;
  }

  function showWinnerModal(name) {
    const modal = ensureWinnerModal();
    if (!modal) { alert(`Winner: ${name}`); return; }

    // Set name
    modal.querySelectorAll(".winner-name, [data-winner-name]").forEach((n) => (n.textContent = name || ""));

    // Confetti burst
    try {
      const root = modal.querySelector(".confetti");
      if (root) {
        root.innerHTML = "";
        const N = 80;
        for (let i = 0; i < N; i++) {
          const p = document.createElement("i");
          p.className = "confetti-piece";
          const size = 6 + Math.random() * 8;
          p.style.width  = `${size}px`;
          p.style.height = `${Math.max(3, size * 0.45)}px`;
          p.style.left   = `${Math.random() * 100}%`;
          p.style.background = `hsl(${Math.floor(Math.random()*360)}, 90%, 60%)`;
          p.style.setProperty("--dur", `${2 + Math.random()*1.8}s`);
          p.style.setProperty("--rot", `${(Math.random()*60 - 30)}deg`);
          p.style.animationDelay = `${Math.random() * 0.2}s`;
          root.appendChild(p);
        }
      }
    } catch {}

    // Show modal
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    lockScroll();
    try { modal.querySelector("[data-close], .btn-modal-close, .winner-close, .modal-close")?.focus(); } catch {}
  }

  async function fetchWinnerOnce() {
    const res = await fetch(fullUrl("/api/admin?action=winner&_=" + Date.now()), { cache: "no-store" });
    if (!res.ok) return null;
    const j = await res.json().catch(() => ({}));
    return j?.winner?.name || null;
  }

  function maybeDisplayWinner(name) {
    if (!name) {
      __winnerLocked = false;
      document.body.classList.remove("winner-locked");
      lastWinner = null;
      localStorage.removeItem(SHOWN_WINNER_KEY);
      setWinnerBanner(null);
      setCountdownVisible(true);
      startWinnerCountdown(true);
      return;
    }

    __winnerLocked = true;
    document.body.classList.add("winner-locked");
    stopWinnerCountdownTimers();
    setCountdownVisible(false);
    setWinnerBanner(name);

    const already = localStorage.getItem(SHOWN_WINNER_KEY);
    if (already !== name) {
      localStorage.setItem(SHOWN_WINNER_KEY, name);
      showWinnerModal(name);           // 🎊 fun modal with confetti
    }

    // 🔒 Immediately close the app UI and show thank-you + winner
    showWinnerThanksGate(name);

    lastWinner = name;
  }

  function startWinnerPolling() {
    const T = 4000;
    async function tick() {
      try {
        const r = await fetch(fullUrl(`/api/admin?action=winner&_=${Date.now()}`), {
          cache: "no-store",
          headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
        });
        const j = await r.json().catch(() => ({}));
        const name = j?.winner?.name || null;
        maybeDisplayWinner(name);
      } catch {}
    }
    tick();
    return setInterval(tick, T);
  }

  function initWinnerRealtime() {
    if (!WINNER_SSE_URL || !("EventSource" in window)) {
      startWinnerPolling();
      return;
    }
    try {
      const es = new EventSource(WINNER_SSE_URL);
      let pollingTimer = null;

      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data || "{}");
          if (data?.reset) {
            const cfg = cfgMem || readCfgCache();
            if (!Number.isFinite(parseStartMs(cfg?.startTime))) {
              setRoundStartOverride(Date.now());
            }
            maybeDisplayWinner(null);
          } else if (data?.winner || data?.name) {
            maybeDisplayWinner(data.winner || data.name);
          }
        } catch {
          const raw = (e?.data ?? "").toString().trim();
          if (/^reset$/i.test(raw)) {
            const cfg = cfgMem || readCfgCache();
            if (!Number.isFinite(parseStartMs(cfg?.startTime))) {
              setRoundStartOverride(Date.now());
            }
            maybeDisplayWinner(null);
          } else if (raw) {
            maybeDisplayWinner(raw);
          }
        }
      };

      es.onerror = () => {
        try { es.close(); } catch {}
        if (!pollingTimer) pollingTimer = startWinnerPolling();
      };
    } catch {
      startWinnerPolling();
    }
  }

  // ──────────────────────────────────────────────────────────────
  // LIVE-WINDOW GATE (open 1h before; close 1h after)
  // ──────────────────────────────────────────────────────────────
  const OPEN_BEFORE_MS = 60 * 60 * 1000; // 1h before start
  const CLOSE_AFTER_MS = 60 * 60 * 1000; // 1h after end
  let __gateTimer = null;
  let __countdownToStartTimer = null;
  let __gateWinnerFetched = false;

  function parseISOms(t) {
    const x = Date.parse(t || "");
    return Number.isFinite(x) ? x : NaN;
  }
  function fmtLocalDateTime(ms) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        weekday: "short", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit"
      }).format(new Date(ms));
    } catch {
      return new Date(ms).toLocaleString();
    }
  }
  function getShowTimesFromCfg() {
    const c = cfgMem || readCfgCache() || {};
    const s = parseISOms(c.startTime);
    const e = parseISOms(c.endTime);
    return { startMs: s, endMs: e };
  }
  function getShowPhase(now = Date.now()) {
    const { startMs, endMs } = getShowTimesFromCfg();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "OPEN"; // permissive if missing
    if (now < startMs - OPEN_BEFORE_MS) return "PRE";
    if (now > endMs + CLOSE_AFTER_MS) return "POST";
    return "OPEN";
  }

  function ensureGateUI() {
    let gate = document.getElementById("app-gate");
    if (!gate) {
      gate = document.createElement("div");
      gate.id = "app-gate";
      gate.className = "hidden";
      gate.innerHTML = `
        <div class="gate-wrap">
          <div class="gate-card" role="status" aria-live="polite">
            <h2 id="gate-title" class="gate-title"></h2>
            <div id="gate-body" class="gate-body"></div>
          </div>
        </div>`;
      document.body.appendChild(gate);

      const css = document.createElement("style");
      css.textContent = `
        #app-gate.hidden{display:none!important;}
        #app-gate .gate-wrap{display:flex;align-items:center;justify-content:center;min-height:60vh;}
        #app-gate .gate-card{
          max-width:min(92vw,560px);
          border-radius:16px;
          padding:18px 20px;
          background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.02));
          border:1px solid rgba(255,255,255,.08);
          color:#fff; text-align:center; box-shadow:0 18px 60px rgba(0,0,0,.35);
        }
        #app-gate .gate-title{margin:0 0 8px;font-size:22px;font-weight:900;}
        #app-gate .gate-body{font-size:16px;opacity:.95}
        #app-gate .gate-sub{margin-top:6px;opacity:.95}
        #app-gate .gate-count{font-size:20px;font-weight:800;margin-top:6px}
      `;
      document.head.appendChild(css);
    }
    return gate;
  }
  function showGate({ title, html }) {
    const gate = ensureGateUI();
    const main = document.getElementById("app-main") || document.body;
    if (main) main.style.display = "none";     // hide app
    setCountdownVisible(false);                // hide winner countdown
    gate.classList.remove("hidden");
    const t = document.getElementById("gate-title");
    const b = document.getElementById("gate-body");
    if (t) t.textContent = title || "";
    if (b) b.innerHTML = html || "";
  }
  function hideGate() {
    const gate = ensureGateUI();
    const main = document.getElementById("app-main") || document.body;
    gate.classList.add("hidden");
    if (main) main.style.display = "";
    startWinnerCountdown(true); // restore countdown behavior
  }
  // 🔔 winner gate shown immediately after pick
  function showWinnerThanksGate(name) {
    const title = "Raffle closed 🎉";
    const html  = `
      <div>Thanks for tuning in! 🙌</div>
      <div class="gate-sub">Tonight’s T-shirt winner is <strong>${escHtml(name)}</strong>.</div>
    `;
    showGate({ title, html });
  }

  function fmtCountdown(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "0m 0s";
    const sec = Math.floor(ms / 1000);
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return d > 0 ? `${d}d ${h}h ${m}m ${s}s` : h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
  }
  async function updateGateUIOnce() {
    if (!cfgMem) await refreshConfigAuthoritative();

    const phase = getShowPhase();
    const { startMs, endMs } = getShowTimesFromCfg();

    if (__countdownToStartTimer) {
      clearInterval(__countdownToStartTimer);
      __countdownToStartTimer = null;
    }

    if (phase === "PRE") {
      const openMs = Number.isFinite(startMs) ? (startMs - OPEN_BEFORE_MS) : NaN;
      const showStr = Number.isFinite(startMs) ? fmtLocalDateTime(startMs) : "—";
      const write = () => {
        const now = Date.now();
        const diffToOpen = Number.isFinite(openMs) ? (openMs - now) : NaN;
        if (Number.isFinite(diffToOpen) && diffToOpen <= 0) { updateGateUIOnce(); return; }
        const countdown = Number.isFinite(diffToOpen) ? fmtCountdown(diffToOpen) : "—";
        const html = `
          <div>Show is at <strong>${showStr}</strong>.</div>
          <div class="gate-sub">The raffle will open in:</div>
          <div class="gate-count" id="gate-open-eta">${countdown}</div>`;
        showGate({ title: "We’re not live yet", html });
      };
      write();
      __countdownToStartTimer = setInterval(write, 1000);
      return;
    }

    if (phase === "POST") {
      let name = lastWinner;
      if (!name && !__gateWinnerFetched) {
        try { name = await fetchWinnerOnce(); } catch {}
        __gateWinnerFetched = true;
      }
      const label = name
        ? `the last show’s T-shirt winner is <strong>${escHtml(name)}</strong>.`
        : `we’ll post the winner shortly.`;
      showGate({ title: "Thanks for tuning in! 🙌", html: `And ${label}` });
      return;
    }

    hideGate(); // OPEN
  }
  function startGateLoop() {
    if (__gateTimer) clearInterval(__gateTimer);
    __gateTimer = setInterval(updateGateUIOnce, 15_000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") updateGateUIOnce();
    });
  }

  // ──────────────────────────────────────────────────────────────
  // Boot
  // ──────────────────────────────────────────────────────────────
  async function boot() {
    initNamePersistence();
    ensureEntryStatsUI();

    refreshFollowers();
    setInterval(refreshFollowers, 60_000);

    await refreshConfigAuthoritative();

    // ▼ Gate the app based on show times
    await updateGateUIOnce();
    startGateLoop();

    setCountdownVisible(true);
    initWinnerRealtime();

    refreshEntryStats();
    setInterval(refreshEntryStats, 15_000);

    initConfigHeadline();

    // init slot AFTER slot.js is loaded (index.html loads slot.js before app.js now)
    initSlot();

    // show countdown immediately
    startWinnerCountdown(false);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        initConfigHeadline(true);
        startWinnerCountdown(true);
        updateGateUIOnce();
      }
    });

    setInterval(() => startWinnerCountdown(true), 10_000);

    (function initWinnerBannerDefault() {
      const el = document.querySelector(".raffle.raffle-title.blink") ||
                 document.querySelector("[data-winner-banner]");
      if (el && !el.getAttribute("data-default")) {
        el.setAttribute("data-default", el.textContent || "Free T-shirt raffle!");
      }
    })();

    fetchWinnerOnce().then(maybeDisplayWinner).catch(() => {});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => boot(), { once: true });
  } else {
    boot();
  }
})();
