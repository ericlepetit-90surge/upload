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
  // Entries submission (server dedupes per IP per source per window)
  // ──────────────────────────────────────────────────────────────
  async function submitEntryOnce(source) {
    const name = getName();
    if (!name) return { ok: false, error: "Missing name" };
    try {
      const out = await postJSON("/api/admin?action=enter", { name, source });
      if (out?.already) {
        console.debug(`[entry] already for ${source}`);
        // still refresh totals in case another client added in-between
        refreshEntryStats().catch(() => {});
        return { ok: true, already: true };
      }
      console.debug(`[entry] recorded for ${source}`);
      // refresh counts immediately after a new ticket
      refreshEntryStats().catch(() => {});
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
    const url = `/api/admin?action=mark-follow&platform=${encodeURIComponent(
      platform
    )}`;
    const res = await fetch(url, { method: "POST" });
    // 200 OK even when throttled (server returns {throttled:true})
    if (!res.ok) {
      let msg = "mark-follow failed";
      try {
        msg = (await res.json()).error || msg;
      } catch (e) {}
      throw new Error(msg);
    }
  }

  // Beacon variant (safe when navigating away to the app)
  function markFollowBeacon(platform) {
    const url = `/api/admin?action=mark-follow&platform=${encodeURIComponent(
      platform
    )}`;
    if (navigator.sendBeacon) {
      // empty body is fine for this endpoint
      navigator.sendBeacon(url, new Blob([""], { type: "text/plain" }));
    } else {
      fetch(url, { method: "POST", keepalive: true }).catch(() => {});
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Followers counts
  // ──────────────────────────────────────────────────────────────
  async function refreshFollowers() {
    const fbEl = $("#fb-followers"),
      igEl = $("#ig-followers");
    try {
      const res = await fetch("/api/admin?action=followers", {
        cache: "no-store",
      });
      const j = await res.json().catch(() => ({}));
      const fb = Number(j?.facebook ?? 0);
      const ig = Number(j?.instagram ?? 0);
      if (fbEl)
        fbEl.textContent = Number.isFinite(fb) ? fb.toLocaleString() : "—";
      if (igEl)
        igEl.textContent = Number.isFinite(ig) ? ig.toLocaleString() : "—";
    } catch (e) {
      if (fbEl) fbEl.textContent = "—";
      if (igEl) igEl.textContent = "—";
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Prize/spin logging (optional, safe to fail)
  // ──────────────────────────────────────────────────────────────
  async function logSpin(targets, jackpot) {
    const name = getName() || "(anonymous)";
    try {
      await postJSON("/api/admin?action=prize-log", {
        name,
        targets,
        jackpot: !!jackpot,
      });
    } catch (e) {}
  }

  // ──────────────────────────────────────────────────────────────
  // Entry Stats (Your entries + Total entries) — expects static markup
  // ──────────────────────────────────────────────────────────────
  function ensureEntryStatsUI() {
    if (!$("#entry-stats")) {
      console.warn(
        "[entry-stats] #entry-stats container not found. Add the static markup to your HTML."
      );
    }
  }

  let prevYour = 0,
    prevTotal = 0;

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
      const res = await fetch("/api/admin?action=my-entries", {
        cache: "no-store",
      });
      if (res.ok) {
        const j = await res.json();
        const mine = Number(j?.mine ?? 0);
        const total = Number(j?.total ?? 0);

        if (totalEl) {
          const old = prevTotal;
          totalEl.textContent = Number.isFinite(total)
            ? total.toLocaleString()
            : "—";
          if (total > old) bump(totalEl);
          prevTotal = total;
        }
        if (yourEl) {
          const old = prevYour;
          yourEl.textContent = Number.isFinite(mine)
            ? mine.toLocaleString()
            : "0";
          if (mine > old) bump(yourEl);
          prevYour = mine;
        }
        return; // done
      }
    } catch (e) {}

    // Fallback: compute total from /entries and ignore "your"
    try {
      const res = await fetch("/api/admin?action=entries", {
        cache: "no-store",
      });
      const j = await res.json().catch(() => ({ entries: [], count: 0 }));
      const total = Number(j?.count || 0);

      if (totalEl) {
        const old = prevTotal;
        totalEl.textContent = total.toLocaleString();
        if (total > old) bump(totalEl);
        prevTotal = total;
      }
      if (yourEl) yourEl.textContent = prevYour.toString();
    } catch (e) {
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
  function isAndroid() {
    return /\bAndroid\b/i.test(navigator.userAgent);
  }
  function isIOS() {
    return /\b(iPhone|iPad|iPod)\b/i.test(navigator.userAgent);
  }
  function isMobile() {
    return isAndroid() || isIOS();
  }

  // New: universal app schemes + guaranteed web fallback (no intent://)
  function appLink(platform) {
    if (platform === "ig") {
      return {
        scheme: `instagram://user?username=${IG_USERNAME}`, // works iOS + most Androids
        web: INSTAGRAM_URL,
      };
    } else {
      // Facebook: use facewebmodal scheme (works on iOS and many Android builds)
      // If the app isn't installed, we’ll fall back to HTTPS.
      return {
        scheme: `fb://facewebmodal/f?href=${encodeURIComponent(FACEBOOK_URL)}`,
        web: FACEBOOK_URL,
      };
    }
  }

  // Attempt to open an app-scheme; if nothing handles it, fall back to the website.
  // Uses visibility change as a signal that we successfully backgrounded into the app.
  function openSocialOnly(platform) {
    const { scheme, web } = appLink(platform);

    if (isMobile()) {
      let switched = false;
      const onVis = () => {
        if (document.visibilityState === "hidden") switched = true;
      };
      document.addEventListener("visibilitychange", onVis, { once: true });

      // Try the app:
      try {
        window.location.href = scheme;
      } catch (e) {
        /* ignore */
      }

      // If the app didn't take over shortly, fall back to the web page:
      setTimeout(() => {
        document.removeEventListener("visibilitychange", onVis);
        if (!switched) {
          try {
            window.location.href = web;
          } catch (e) {
            /* ignore */
          }
        }
      }, 700);
    } else {
      // Desktop → open the site in a new tab
      try {
        window.open(web, "_blank", "noopener,noreferrer");
      } catch (e) {}
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Harden follow buttons (single-fire; no cross-platform double)
  // ──────────────────────────────────────────────────────────────
  let globalFollowLock = false; // blocks cross-platform double firing
  let fbBtn = null,
    igBtn = null;

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

    if (globalFollowLock) return; // hard block for any second button
    globalFollowLock = true;

    // disable both buttons briefly
    if (fbBtn) fbBtn.disabled = true;
    if (igBtn) igBtn.disabled = true;

    try {
      if (isMobile()) {
        // Queue tracking with beacons first (so it persists through navigation)
        markFollowBeacon(platform);
        submitEntryOnceBeacon(platform);

        // Then deep-link straight into the app (no web tab)
        openSocialOnly(platform);
      } else {
        // Desktop: open site and do normal async logging
        try {
          const url = platform === "fb" ? FACEBOOK_URL : INSTAGRAM_URL;
          if (url) window.open(url, "_blank", "noopener");
        } catch (e) {}
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
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('a[href^="intent://"]').forEach(a => {
    const href = a.getAttribute('href') || '';
    const isFb = /facebook|katana|\/profile\//i.test(href);
    a.setAttribute('href', isFb ? "https://facebook.com/90Surge"
                                : "https://instagram.com/90_Surge");
    a.classList.add(isFb ? 'follow-btn-fb' : 'follow-btn-ig');
  });
}, { once: true });

// 2) Catch any remaining intent:// clicks just in case and reroute
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="intent://"]');
  if (!a) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const isFb = /facebook|katana|\/profile\//i.test(a.getAttribute('href') || '');
  const platform = isFb ? 'fb' : 'ig';
  // track + give entry (beacon so it survives navigation) then open app/https
  try { markFollowBeacon(platform); } catch {}
  try { submitEntryOnceBeacon(platform); } catch {}
  openSocialOnly(platform);
}, true);

// 3) Make wireFollowButtons also pick up plain <a> links to fb/ig
function wireFollowButtons() {
  // Existing buttons
  let fb0 = document.querySelector(".follow-btn-fb");
  let ig0 = document.querySelector(".follow-btn-ig");

  // Also sweep plain anchors that point to fb/ig and tag them
  document.querySelectorAll('a[href*="facebook.com"]').forEach(a => a.classList.add('follow-btn-fb'));
  document.querySelectorAll('a[href*="instagram.com"]').forEach(a => a.classList.add('follow-btn-ig'));

  // (re)select after tagging
  fb0 = document.querySelector(".follow-btn-fb");
  ig0 = document.querySelector(".follow-btn-ig");

  // wipe & rebind (your existing logic)
  function wipeInlineAndListeners(btn) {
    if (!btn) return null;
    btn.onclick = null;
    btn.removeAttribute("onclick");
    const clone = btn.cloneNode(true);
    btn.replaceWith(clone);
    return clone;
  }
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

  function wireFollowButtons() {
    // Find originals
    const fb0 = $(".follow-btn-fb");
    const ig0 = $(".follow-btn-ig");

    // Wipe inline & old listeners
    fbBtn = wipeInlineAndListeners(fb0);
    igBtn = wipeInlineAndListeners(ig0);

    // Fresh single handlers (pointerup avoids extra synthetic click on mobile)
    if (fbBtn)
      fbBtn.addEventListener(
        "pointerup",
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          handleFollow("fb", fbBtn);
        },
        { capture: true }
      );

    if (igBtn)
      igBtn.addEventListener(
        "pointerup",
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          handleFollow("ig", igBtn);
        },
        { capture: true }
      );

    // Backward-compat if HTML still calls these
    window.openFacebook = (ev) => {
      ev?.preventDefault?.();
      return fbBtn
        ? fbBtn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
        : false;
    };
    window.openInstagram = (ev) => {
      ev?.preventDefault?.();
      return igBtn
        ? igBtn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
        : false;
    };
  }

  // ──────────────────────────────────────────────────────────────
  // Slot hookup (jackpot => extra entry)
  // ──────────────────────────────────────────────────────────────
  function initSlot() {
  if (typeof window.initSlotMachine !== "function") return;

  window.initSlotMachine("#slot-root", {
    onResult: async (result) => {
      // result may look like:
      // { targets: [...], win: boolean, jackpot: boolean, align: boolean, isJackpot: boolean }
      const targets = Array.isArray(result?.targets) ? result.targets : [];
      const lcase = targets.map((t) => String(t).toLowerCase());

      // Heuristics: prefer explicit flags; otherwise detect triple match
      const hitJackpot =
        !!(result?.jackpot ?? result?.isJackpot ?? result?.align) ||
        (targets.length >= 3 && new Set(lcase.slice(0, 3)).size === 1) ||
        /jackpot/i.test(String(targets.join(" ")));

      // Always log the spin (with our computed jackpot boolean)
      await logSpin(targets, hitJackpot);

      // Only grant the extra raffle ticket on actual jackpots
      if (hitJackpot && getName()) {
        await submitEntryOnce("jackpot"); // server dedupes per IP per window
      }
    },
  });
}


  // ──────────────────────────────────────────────────────────────
  // HEADLINE CONFIG (existing behavior)
  // ──────────────────────────────────────────────────────────────
  const CFG_CACHE_KEY = "cfg";
  const HEADLINE_SELECTORS = ["#headline", ".show-name", "[data-headline]"];

  function setHeadlineText(name) {
    const text = name && name.trim() ? name : "90 Surge";
    HEADLINE_SELECTORS.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        el.textContent = text;
      });
    });
  }

  function readCfgCache() {
    try {
      return JSON.parse(sessionStorage.getItem(CFG_CACHE_KEY) || "null");
    } catch {
      return null;
    }
  }
  function writeCfgCache(cfg) {
    try {
      sessionStorage.setItem(CFG_CACHE_KEY, JSON.stringify(cfg));
    } catch {}
  }

  async function fetchConfigFresh() {
    const res = await fetch(`/api/admin?action=config&_=${Date.now()}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-store", "Pragma": "no-cache" },
    });
    if (!res.ok) throw new Error(`config fetch failed: ${res.status}`);
    return await res.json();
  }

  async function initConfigHeadline(force = false) {
    const cached = force ? null : readCfgCache();
    if (cached?.showName) setHeadlineText(cached.showName);

    try {
      const fresh = await fetchConfigFresh();
      if (
        !cached ||
        fresh.version !== cached.version ||
        fresh.showName !== cached.showName
      ) {
        writeCfgCache(fresh);
        setHeadlineText(fresh.showName);
      }
    } catch (e) {
      // leave whatever headline is currently shown
      console.debug("[config] headline refresh skipped:", e?.message || e);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Winner UI (modal + banner) — fixed to auto-fire + live update
  // ──────────────────────────────────────────────────────────────
  const SHOWN_WINNER_KEY = "shownWinnerName";
  let lastWinner = null;
  let winnerPollTimer = null;

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
    const el =
      document.querySelector(".raffle.raffle-title.blink") ||
      document.querySelector("[data-winner-banner]");
    if (!el) return;
    // Capture the very first, original copy so we can always restore it
    if (!el.getAttribute("data-default")) {
      el.setAttribute("data-default", el.textContent || "Free T-shirt raffle!");
    }
  }
  // Ensure we capture the default banner copy once
  function initWinnerWatchers() {
    initWinnerBannerDefault();
    // sync headline once on load
    fetchWinnerOnce()
      .then((name) => {
        maybeDisplayWinner(name);
      })
      .catch(() => {});
  }

  function setWinnerBanner(name) {
    const el =
      document.querySelector(".raffle.raffle-title.blink") ||
      document.querySelector("[data-winner-banner]");
    if (!el) return;

    // Ensure we’ve stored the original banner text for resets
    if (!el.getAttribute("data-default")) {
      el.setAttribute("data-default", el.textContent || "Free T-shirt raffle!");
    }

    if (name) {
      el.textContent = `Woohooo! Tonight's winner is ${name}!`;
      el.classList.add("has-winner");
    } else {
      const fallback =
        el.getAttribute("data-default") || "Free T-shirt raffle!";
      el.textContent = fallback;
      el.classList.remove("has-winner");
    }
  }

  function showWinnerModal(name) {
    const modal =
      document.getElementById("winner-modal") ||
      document.querySelector(".winner-modal");
    const nameSpans = modal
      ? modal.querySelectorAll(".winner-name, [data-winner-name]")
      : null;

    if (nameSpans && nameSpans.length)
      nameSpans.forEach((n) => (n.textContent = name));
    if (modal) {
      modal.classList.remove("hidden");
      modal.removeAttribute("aria-hidden");

      const close = modal.querySelector(
        ".winner-close, [data-close], .modal-close"
      );
      const overlay = modal.querySelector(".modal-overlay, [data-overlay]");
      const hide = () => {
        modal.classList.add("hidden");
        modal.setAttribute("aria-hidden", "true");
      };
      if (close) close.addEventListener("click", hide, { once: true });
      if (overlay) overlay.addEventListener("click", hide, { once: true });
    } else {
      // Fallback if no modal exists in markup
      alert(`Winner: ${name}`);
    }
  }

  async function fetchWinnerOnce() {
    const res = await fetch("/api/admin?action=winner&_=" + Date.now(), {
      cache: "no-store",
    });
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

    // Show once per unique winner per browser
    const already = localStorage.getItem(SHOWN_WINNER_KEY);
    if (already !== name) {
      localStorage.setItem(SHOWN_WINNER_KEY, name);
      showWinnerModal(name);
    }
    lastWinner = name;
  }


  // ──────────────────────────────────────────────────────────────
  // Winner realtime + polling (SSE optional; polling always on)
  // ──────────────────────────────────────────────────────────────
  function startWinnerPolling() {
    const T = 4000;
    async function tick() {
      try {
        const r = await fetch("/api/admin?action=winner", {
          cache: "no-store",
        });
        const j = await r.json().catch(() => ({}));
        const name = j?.winner?.name || null;
        // Single source of truth (handles banner + modal + reset)
        maybeDisplayWinner(name);
      } catch {}
    }
    tick();
    return setInterval(tick, T);
  }

  function initWinnerRealtime() {
  // If SSE not configured, just poll.
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
    ensureEntryStatsUI(); // verifies presence / warns if missing
    wireFollowButtons();

    refreshFollowers();
    setInterval(refreshFollowers, 60_000);

    initWinnerRealtime();

    refreshEntryStats();
    setInterval(refreshEntryStats, 15_000);

    // headline init/refresh — only affects headline text
    initConfigHeadline();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") initConfigHeadline();
    });

    // winner modal + banner (auto-fire + live)
    initWinnerWatchers();

    initSlot();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
