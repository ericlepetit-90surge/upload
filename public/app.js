// /public/app.js
(() => {
  const FACEBOOK_URL = "https://facebook.com/90Surge";
  const INSTAGRAM_URL = "https://instagram.com/90_Surge";

  // Derive handles for deep links
  const FB_HANDLE = "90Surge";
  const IG_USERNAME = "90_Surge";

  const NAME_KEY = "raffle_display_name";
  const $ = (s, r = document) => r.querySelector(s);

  const nameEl = () => $("#user-display-name");
  const getName = () => (nameEl()?.value || "").trim().slice(0, 80);

  const WINNER_SSE_URL = ""; // "https://winner-sse-server.onrender.com/stream" (if/when you turn it on)

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
      // live-update the "Your entries" when the name changes
      debounceRefreshStats();
    });
  }

  function requireName() {
    const n = getName();
    if (!n) {
      try {
        nameEl()?.focus();
        nameEl()?.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch (e) {}
      alert("Please enter your name first 🙂");
      return false;
    }
    return true;
  }

  async function postJSON(url, body, { keepalive = false } = {}) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive,
      body: JSON.stringify(body || {}),
    });
    let json = {};
    try {
      json = await res.json();
    } catch (e) {}
    if (!res.ok)
      throw new Error(json?.error || `Request failed (${res.status})`);
    return json;
  }

  // ──────────────────────────────────────────────────────────────
  // Fallback jackpot logger + last-spin memory
  // ──────────────────────────────────────────────────────────────
  let __lastSpinTargets = [];
  let __lastJackpotLoggedAt = 0;

  async function logJackpotFallback() {
    const now = Date.now();
    if (now - __lastJackpotLoggedAt < 2500) return; // throttle to avoid doubles
    __lastJackpotLoggedAt = now;

    const name = getName() || "(anonymous)";
    const targets = Array.isArray(__lastSpinTargets) ? __lastSpinTargets : [];
    try {
      await postJSON("/api/admin?action=prize-log", { name, targets, jackpot: true });
      console.debug("[jackpot] fallback prize-log posted");
    } catch (e) {
      console.warn("[jackpot] fallback prize-log failed:", e?.message || e);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Entries submission (server dedupes per IP per source per window)
  // ──────────────────────────────────────────────────────────────
  async function submitEntryOnce(source) {
    const name = getName();
    if (!name) return { ok: false, error: "Missing name" };
    try {
      const out = await postJSON("/api/admin?action=enter", { name, source });
      if (out?.already) {
        console.debug(`[entry] already for ${source}`);
        refreshEntryStats().catch(() => {});
        if (source === "jackpot") { logJackpotFallback().catch(()=>{}); }
        return { ok: true, already: true };
      }
      console.debug(`[entry] recorded for ${source}`);
      refreshEntryStats().catch(() => {});
      if (source === "jackpot") { logJackpotFallback().catch(()=>{}); }
      return { ok: true, already: false };
    } catch (e) {
      console.error(`[entry] failed ${source}:`, e?.message || e);
      return { ok: false, error: e?.message || "submit failed" };
    }
  }

  // Beacon variant (safe when navigating away to the app)
  function submitEntryOnceBeacon(source) {
    const name = getName();
    if (!name) return;
    const url = "/api/admin?action=enter";
    const data = JSON.stringify({ name, source });
    const blob = new Blob([data], { type: "application/json" });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, blob);
    } else {
      // fallback: keepalive fetch
      postJSON(url, { name, source }, { keepalive: true }).catch(() => {});
    }
    // best-effort UI refresh if we’re still on the page shortly after
    setTimeout(() => refreshEntryStats().catch(() => {}), 600);
  }

  // ──────────────────────────────────────────────────────────────
  // Social mark (does NOT create entries)
  // ──────────────────────────────────────────────────────────────
  async function markFollow(platform) {
    const url = `/api/admin?action=mark-follow&platform=${encodeURIComponent(platform)}`;
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
    const url = `/api/admin?action=mark-follow&platform=${encodeURIComponent(platform)}`;
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
    try {
      const res = await fetch("/api/admin?action=followers", { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      const fb = Number(j?.facebook ?? 0);
      const ig = Number(j?.instagram ?? 0);
      if (fbEl) fbEl.textContent = Number.isFinite(fb) ? fb.toLocaleString() : "—";
      if (igEl) igEl.textContent = Number.isFinite(ig) ? ig.toLocaleString() : "—";
    } catch {
      if (fbEl) fbEl.textContent = "—";
      if (igEl) igEl.textContent = "—";
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Prize/spin logging — winners only (fix: sendBeacon as JSON POST)
  // ──────────────────────────────────────────────────────────────
  async function logSpin(targets, jackpot) {
    if (!jackpot) return; // winners only

    const name = getName() || "(anonymous)";
    const payload = { name, targets: Array.isArray(targets) ? targets : [], jackpot: true };

    // 1) Beacon with JSON (server expects application/json)
    let sent = false;
    try {
      if ("sendBeacon" in navigator) {
        const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
        sent = navigator.sendBeacon("/api/admin?action=prize-log", blob);
      }
    } catch {}

    // 2) Fallback POST visible in Network
    if (!sent) {
      try {
        await postJSON("/api/admin?action=prize-log", payload);
      } catch (e) {
        console.warn("logSpin POST failed:", e?.message || e);
      }
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Entry Stats (Your entries + Total entries) — expects static markup
  // ──────────────────────────────────────────────────────────────
  function ensureEntryStatsUI() {
    if (!$("#entry-stats")) {
      console.warn("[entry-stats] #entry-stats container not found. Add the static markup to your HTML.");
    }
  }

  let prevYour = 0, prevTotal = 0;

  function bump(el) {
    if (!el) return;
    el.classList.remove("entry-bump");
    // reflow to restart animation
    // eslint-disable-next-line no-unused-expressions
    el.offsetWidth;
    el.classList.add("entry-bump");
    setTimeout(() => el.classList.remove("entry-bump"), 400);
  }

  async function refreshEntryStats() {
    ensureEntryStatsUI();
    const yourEl = $("#your-entries-count");
    const totalEl = $("#total-entries-count");

    // Prefer per-IP/server truth:
    try {
      const res = await fetch("/api/admin?action=my-entries", { cache: "no-store" });
      if (res.ok) {
        const j = await res.json();
        const mine = Number(j?.mine ?? 0);
        const total = Number(j?.total ?? 0);

        if (totalEl) {
          const old = prevTotal;
          totalEl.textContent = Number.isFinite(total) ? total.toLocaleString() : "—";
          if (total > old) bump(totalEl);
          prevTotal = total;
        }
        if (yourEl) {
          const old = prevYour;
          yourEl.textContent = Number.isFinite(mine) ? mine.toLocaleString() : "0";
          if (mine > old) bump(yourEl);
          prevYour = mine;
        }
        return; // done
      }
    } catch {}

    // Fallback: compute total from /entries and ignore "your"
    try {
      const res = await fetch("/api/admin?action=entries", { cache: "no-store" });
      const j = await res.json().catch(() => ({ entries: [], count: 0 }));
      const total = Number(j?.count || 0);

      if (totalEl) {
        const old = prevTotal;
        totalEl.textContent = total.toLocaleString();
        if (total > old) bump(totalEl);
        prevTotal = total;
      }
      if (yourEl) yourEl.textContent = prevYour.toString();
    } catch {
      if (totalEl) totalEl.textContent = "—";
      if (yourEl) yourEl.textContent = "0";
    }
  }

  // small debounce for name-change refresh
  let _nameDebounce;
  function debounceRefreshStats() {
    clearTimeout(_nameDebounce);
    _nameDebounce = setTimeout(refreshEntryStats, 250);
  }

  // ──────────────────────────────────────────────────────────────
  // Deep-link helpers: open ONLY the app on mobile; web on desktop
  // ──────────────────────────────────────────────────────────────
  function isAndroid() { return /\bAndroid\b/i.test(navigator.userAgent); }
  function isIOS() { return /\b(iPhone|iPad|iPod)\b/i.test(navigator.userAgent); }
  function isMobile() { return isAndroid() || isIOS(); }

  function appLink(platform) {
    if (platform === "ig") {
      return { scheme: `instagram://user?username=${IG_USERNAME}`, web: INSTAGRAM_URL };
    } else {
      return { scheme: `fb://facewebmodal/f?href=${encodeURIComponent(FACEBOOK_URL)}`, web: FACEBOOK_URL };
    }
  }

  function openSocialOnly(platform) {
    const { scheme, web } = appLink(platform);

    if (isMobile()) {
      try {
        if (isAndroid()) {
          const iframe = document.createElement("iframe");
          iframe.style.display = "none";
          iframe.src = scheme;
          document.body.appendChild(iframe);
          setTimeout(() => { try { document.body.removeChild(iframe); } catch {} }, 2000);
        } else {
          window.location.href = scheme;
        }
      } catch {}
      return;
    }

    try { window.open(web, "_blank", "noopener,noreferrer"); } catch {}
  }

  // ──────────────────────────────────────────────────────────────
  // Harden follow buttons (single-fire; no cross-platform double)
  // ──────────────────────────────────────────────────────────────
  let globalFollowLock = false; // blocks cross-platform double firing
  let fbBtn = null, igBtn = null;

  function wipeInlineAndListeners(btn) {
    if (!btn) return null;
    btn.onclick = null;
    btn.removeAttribute("onclick");
    const clone = btn.cloneNode(true); // nukes any previously attached listeners
    btn.replaceWith(clone);
    return clone;
  }

  async function handleFollow(platform, btn) {
    if (!requireName()) return;

    if (globalFollowLock) return;
    globalFollowLock = true;

    if (fbBtn) fbBtn.disabled = true;
    if (igBtn) igBtn.disabled = true;

    try {
      if (isMobile()) {
        markFollowBeacon(platform);
        submitEntryOnceBeacon(platform);
        openSocialOnly(platform);
      } else {
        try {
          const url = platform === "fb" ? FACEBOOK_URL : INSTAGRAM_URL;
          if (url) window.open(url, "_blank", "noopener");
        } catch {}
        await markFollow(platform);
        await submitEntryOnce(platform);
      }
    } catch (err) {
      console.warn(`[follow] ${platform} flow error:`, err?.message || err);
    } finally {
      setTimeout(() => {
        globalFollowLock = false;
        if (fbBtn) fbBtn.disabled = false;
        if (igBtn) igBtn.disabled = false;
      }, 700);
    }
  }

  // 1) Rewrite any existing intent:// anchors to safe https + tag them
  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll('a[href^="intent://"]').forEach(a => {
      const href = a.getAttribute("href") || "";
      const isFb = /facebook|katana|\/profile\//i.test(href);
      a.setAttribute("href", isFb ? "https://facebook.com/90Surge"
                                  : "https://instagram.com/90_Surge");
      a.classList.add(isFb ? "follow-btn-fb" : "follow-btn-ig");
    });
  }, { once: true });

  // 2) Catch any remaining intent:// clicks just in case and reroute
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="intent://"]');
    if (!a) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const isFb = /facebook|katana|\/profile\//i.test(a.getAttribute("href") || "");
    const platform = isFb ? "fb" : "ig";
    try { markFollowBeacon(platform); } catch {}
    try { submitEntryOnceBeacon(platform); } catch {}
    openSocialOnly(platform);
  }, true);

  // 3) Make wireFollowButtons also pick up plain <a> links to fb/ig
  function wireFollowButtons() {
    let fb0 = document.querySelector(".follow-btn-fb");
    let ig0 = document.querySelector(".follow-btn-ig");

    document.querySelectorAll('a[href*="facebook.com"]').forEach(a => a.classList.add('follow-btn-fb'));
    document.querySelectorAll('a[href*="instagram.com"]').forEach(a => a.classList.add('follow-btn-ig'));

    fb0 = document.querySelector(".follow-btn-fb");
    ig0 = document.querySelector(".follow-btn-ig");

    fbBtn = wipeInlineAndListeners(fb0);
    igBtn = wipeInlineAndListeners(ig0);

    if (fbBtn) fbBtn.addEventListener("pointerup", (e) => {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      handleFollow("fb", fbBtn);
    }, { capture: true });

    if (igBtn) igBtn.addEventListener("pointerup", (e) => {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      handleFollow("ig", igBtn);
    }, { capture: true });

    // Back-compat for any old HTML onclicks
    window.openFacebook  = (ev) => { ev?.preventDefault?.(); return fbBtn ? fbBtn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })) : false; };
    window.openInstagram = (ev) => { ev?.preventDefault?.(); return igBtn ? igBtn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })) : false; };
  }

  // ──────────────────────────────────────────────────────────────
  // Slot hookup (jackpot => extra entry)
  // ──────────────────────────────────────────────────────────────
  function initSlot() {
    if (typeof window.initSlotMachine !== "function") {
      console.warn("[slot] initSlotMachine missing; skipping hook");
      return;
    }

    const handleResult = async (result) => {
      try {
        const targets = Array.isArray(result?.targets) ? result.targets : [];
        __lastSpinTargets = targets.slice(); // remember for fallback

        const lcase = targets.map((t) => String(t).toLowerCase());

        // Prefer any truthy engine flag; then triple-match; then text fallback
        const hitJackpot =
          !!(result?.jackpot || result?.isJackpot || result?.align || result?.win) ||
          (targets.length >= 3 && new Set(lcase.slice(0, 3)).size === 1) ||
          /jackpot/i.test(String(targets.join(" ")));

        // Always log (server only records winners)
        await logSpin(targets, hitJackpot);

        // Give extra entry only on real jackpots (and ensure ledger row exists)
        if (hitJackpot && getName()) {
          await submitEntryOnce("jackpot"); // server dedupes by IP per window
          logJackpotFallback().catch(()=>{});
        }
      } catch (err) {
        console.warn("[slot] handleResult error:", err?.message || err);
      }
    };

    const opts = {
      onResult: handleResult,
      onStop: handleResult,
      onSpinEnd: handleResult,
      onComplete: handleResult,
      onFinish: handleResult,
    };

    try {
      window.initSlotMachine("#slot-root", opts);
    } catch (e) {
      console.warn("[slot] initSlotMachine threw:", e?.message || e);
    }

    window.addEventListener("slot:result", (e) => handleResult(e?.detail || e), { passive: true });
  }

  // ──────────────────────────────────────────────────────────────
  // HEADLINE CONFIG (existing behavior)
  // ──────────────────────────────────────────────────────────────
  const CFG_CACHE_KEY = "cfg";
  const HEADLINE_SELECTORS = ["#headline", ".show-name", "[data-headline]"];

  function setHeadlineText(name) {
    const text = name && name.trim() ? name : "90 Surge";
    HEADLINE_SELECTORS.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => { el.textContent = text; });
    });
  }

  function readCfgCache() {
    try { return JSON.parse(sessionStorage.getItem(CFG_CACHE_KEY) || "null"); }
    catch { return null; }
  }
  function writeCfgCache(cfg) {
    try { sessionStorage.setItem(CFG_CACHE_KEY, JSON.stringify(cfg)); }
    catch {}
  }

  async function fetchConfigFresh() {
    const res = await fetch(`/api/admin?action=config&_=${Date.now()}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
    });
    if (!res.ok) throw new Error(`config fetch failed: ${res.status}`);
    return await res.json();
  }

  async function initConfigHeadline(force = false) {
    const cached = force ? null : readCfgCache();
    if (cached?.showName) setHeadlineText(cached.showName);

    try {
      const fresh = await fetchConfigFresh();
      if (!cached || fresh.version !== cached.version || fresh.showName !== cached.showName) {
        writeCfgCache(fresh);
        setHeadlineText(fresh.showName);
      }
    } catch (e) {
      console.debug("[config] headline refresh skipped:", e?.message || e);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Winner UI (modal + banner)
  // ──────────────────────────────────────────────────────────────
  const SHOWN_WINNER_KEY = "shownWinnerName";
  let lastWinner = null;

  function winnerBannerEl() {
    return (
      document.querySelector(".raffle.raffle-title.blink") ||
      document.querySelector("[data-winner-banner]")
    );
  }

  function formatWinnerMessage(name) {
    const n = (name || "").trim();
    return n ? `Woohooo! Tonight's winner is ${n}!` : "";
  }

  function initWinnerBannerDefault() {
    const el = winnerBannerEl();
    if (!el) return;
    if (!el.getAttribute("data-default")) {
      el.setAttribute("data-default", el.textContent || "Free T-shirt raffle!");
    }
  }
  function initWinnerWatchers() {
    initWinnerBannerDefault();
    fetchWinnerOnce().then((name) => { maybeDisplayWinner(name); }).catch(() => {});
  }

  function setWinnerBanner(name) {
    const el = winnerBannerEl();
    if (!el) return;
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

  function showWinnerModal(name) {
    const modal = document.getElementById("winner-modal") || document.querySelector(".winner-modal");
    const nameSpans = modal ? modal.querySelectorAll(".winner-name, [data-winner-name]") : null;

    if (nameSpans && nameSpans.length) nameSpans.forEach((n) => (n.textContent = name));
    if (modal) {
      modal.classList.remove("hidden");
      modal.removeAttribute("aria-hidden");

      const close = modal.querySelector(".winner-close, [data-close], .modal-close");
      const overlay = modal.querySelector(".modal-overlay, [data-overlay]");
      const hide = () => { modal.classList.add("hidden"); modal.setAttribute("aria-hidden", "true"); };
      if (close) close.addEventListener("click", hide, { once: true });
      if (overlay) overlay.addEventListener("click", hide, { once: true });
    } else {
      alert(`Winner: ${name}`);
    }
  }

  async function fetchWinnerOnce() {
    const res = await fetch("/api/admin?action=winner&_=" + Date.now(), { cache: "no-store" });
    if (!res.ok) return null;
    const j = await res.json().catch(() => ({}));
    return j?.winner?.name || null;
  }

  function maybeDisplayWinner(name) {
    if (!name) {
      lastWinner = null;
      localStorage.removeItem(SHOWN_WINNER_KEY);
      setWinnerBanner(null);
      return;
    }
    setWinnerBanner(name);
    const already = localStorage.getItem(SHOWN_WINNER_KEY);
    if (already !== name) {
      localStorage.setItem(SHOWN_WINNER_KEY, name);
      showWinnerModal(name);
    }
    lastWinner = name;
  }

  function startWinnerPolling() {
    const T = 4000;
    async function tick() {
      try {
        const r = await fetch("/api/admin?action=winner", { cache: "no-store" });
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
            maybeDisplayWinner(null);
          } else if (data?.winner || data?.name) {
            maybeDisplayWinner(data.winner || data.name);
          }
        } catch {
          const raw = (e?.data ?? "").toString().trim();
          if (/^reset$/i.test(raw)) maybeDisplayWinner(null);
          else if (raw) maybeDisplayWinner(raw);
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
  // Boot
  // ──────────────────────────────────────────────────────────────
  function boot() {
    initNamePersistence();
    ensureEntryStatsUI();
    wireFollowButtons();

    refreshFollowers();
    setInterval(refreshFollowers, 60_000);

    initWinnerRealtime();

    refreshEntryStats();
    setInterval(refreshEntryStats, 15_000);

    initConfigHeadline();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") initConfigHeadline();
    });

    initWinnerWatchers();

    initSlot();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
