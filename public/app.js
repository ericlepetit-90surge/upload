// /public/app.js
(() => {
  const FACEBOOK_URL  = "https://facebook.com/90Surge";
  const INSTAGRAM_URL = "https://instagram.com/90_Surge";

  // Derive handles for deep links
  const FB_HANDLE = "90Surge";
  const IG_USERNAME = "90_Surge";

  const NAME_KEY = "raffle_display_name";
  const $ = (s, r = document) => r.querySelector(s);

  const nameEl  = () => $("#user-display-name");
  const getName = () => (nameEl()?.value || "").trim().slice(0, 80);

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
    try { json = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
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
    const url = `/api/admin?action=mark-follow&platform=${encodeURIComponent(platform)}`;
    const res = await fetch(url, { method: "POST" });
    // 200 OK even when throttled (server returns {throttled:true})
    if (!res.ok) {
      let msg = "mark-follow failed";
      try { msg = (await res.json()).error || msg; } catch (e) {}
      throw new Error(msg);
    }
  }

  // Beacon variant (safe when navigating away to the app)
  function markFollowBeacon(platform) {
    const url = `/api/admin?action=mark-follow&platform=${encodeURIComponent(platform)}`;
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
    const fbEl = $("#fb-followers"), igEl = $("#ig-followers");
    try {
      const res = await fetch("/api/admin?action=followers", { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      const fb = Number(j?.facebook ?? 0);
      const ig = Number(j?.instagram ?? 0);
      if (fbEl) fbEl.textContent = Number.isFinite(fb) ? fb.toLocaleString() : "—";
      if (igEl) igEl.textContent = Number.isFinite(ig) ? ig.toLocaleString() : "—";
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
    try { await postJSON("/api/admin?action=prize-log", { name, targets, jackpot: !!jackpot }); }
    catch (e) {}
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
    const yourEl  = $("#your-entries-count");
    const totalEl = $("#total-entries-count");

    // Prefer per-IP/server truth:
    try {
      const res = await fetch("/api/admin?action=my-entries", { cache: "no-store" });
      if (res.ok) {
        const j = await res.json();
        const mine  = Number(j?.mine  ?? 0);
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
    } catch (e) {}

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
    } catch (e) {
      if (totalEl) totalEl.textContent = "—";
      if (yourEl)  yourEl.textContent  = "0";
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
  function isAndroid() { return /Android/i.test(navigator.userAgent); }
  function isIOS()     { return /iPhone|iPad|iPod/i.test(navigator.userAgent); }
  function isMobile()  { return isAndroid() || isIOS(); }

  function appLink(platform) {
    if (platform === "ig") {
      if (isAndroid()) return `intent://instagram.com/_u/${IG_USERNAME}#Intent;package=com.instagram.android;scheme=https;end`;
      if (isIOS())     return `instagram://user?username=${IG_USERNAME}`;
      return INSTAGRAM_URL;
    } else {
      // Facebook: use app-only paths. If we don't have numeric ID, facewebmodal is a solid iOS option.
      if (isAndroid()) return `intent://facebook.com/${FB_HANDLE}#Intent;package=com.facebook.katana;scheme=https;end`;
      if (isIOS())     return `fb://facewebmodal/f?href=${encodeURIComponent(FACEBOOK_URL)}`;
      return FACEBOOK_URL;
    }
  }

  function openSocialOnly(platform) {
    const url = appLink(platform);
    if (isMobile()) {
      // Use same-tab navigation to avoid creating an extra web tab
      try { window.location.href = url; } catch (e) { /* ignore */ }
    } else {
      // Desktop: open the regular site in a new tab
      try { window.open(url, "_blank", "noopener,noreferrer"); } catch (e) {}
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Harden follow buttons (single-fire; no cross-platform double)
  // ──────────────────────────────────────────────────────────────
  let globalFollowLock = false;   // blocks cross-platform double firing
  let fbBtn = null, igBtn = null;

  function wipeInlineAndListeners(btn) {
    if (!btn) return null;
    btn.onclick = null;
    btn.removeAttribute("onclick");
    const clone = btn.cloneNode(true);  // nukes any previously attached listeners
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

  function wireFollowButtons() {
    // Find originals
    const fb0 = $(".follow-btn-fb");
    const ig0 = $(".follow-btn-ig");

    // Wipe inline & old listeners
    fbBtn = wipeInlineAndListeners(fb0);
    igBtn = wipeInlineAndListeners(ig0);

    // Fresh single handlers (pointerup avoids extra synthetic click on mobile)
    if (fbBtn) fbBtn.addEventListener("pointerup", (e) => {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      handleFollow("fb", fbBtn);
    }, { capture: true });

    if (igBtn) igBtn.addEventListener("pointerup", (e) => {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      handleFollow("ig", igBtn);
    }, { capture: true });

    // Backward-compat if HTML still calls these
    window.openFacebook  = (ev) => { ev?.preventDefault?.(); return fbBtn ? fbBtn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })) : false; };
    window.openInstagram = (ev) => { ev?.preventDefault?.(); return igBtn ? igBtn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })) : false; };
  }

  // ──────────────────────────────────────────────────────────────
  // Slot hookup (jackpot => extra entry)
  // ──────────────────────────────────────────────────────────────
  function initSlot() {
    if (typeof window.initSlotMachine !== "function") return;
    window.initSlotMachine("#slot-root", {
      onResult: async ({ targets, win }) => {
        logSpin(targets, win);
        if (win && getName()) {
          await submitEntryOnce("jackpot"); // server dedupes per IP per window
        }
      }
    });
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

    refreshEntryStats();
    setInterval(refreshEntryStats, 15_000);

    initSlot();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
