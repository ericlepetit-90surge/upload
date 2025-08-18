// /public/app.js
(() => {
  const FACEBOOK_URL  = "https://facebook.com/90Surge";
  const INSTAGRAM_URL = "https://instagram.com/90_Surge";

  const NAME_KEY = "raffle_display_name";
  const $ = (s, r=document)=>r.querySelector(s);

  const nameEl = () => $("#user-display-name");
  const getName = () => (nameEl()?.value || "").trim().slice(0,80);

  // persist name across refresh
  function initNamePersistence() {
    const el = nameEl();
    if (!el) return;
    const saved = localStorage.getItem(NAME_KEY);
    if (saved) el.value = saved;
    el.addEventListener("input", () => {
      localStorage.setItem(NAME_KEY, getName());
    });
  }

  function requireName() {
    const n = getName();
    if (!n) {
      try { nameEl()?.focus(); nameEl()?.scrollIntoView({behavior:"smooth", block:"center"}); } catch {}
      alert("Please enter your name first 🙂");
      return false;
    }
    return true;
  }

  async function postJSON(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(body||{})
    });
    let json={};
    try { json = await res.json(); } catch {}
    if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
    return json;
  }

  // One entry per source per IP per window (server dedupes)
  async function submitEntryOnce(source) {
    const name = getName();
    if (!name) return { ok:false, error:"Missing name" };
    try {
      const out = await postJSON("/api/admin?action=enter", { name, source });
      if (out?.already) {
        console.debug(`[entry] already for ${source}`);
        return { ok:true, already:true };
      }
      console.debug(`[entry] recorded for ${source}`);
      return { ok:true, already:false };
    } catch (e) {
      console.error(`[entry] failed ${source}:`, e?.message||e);
      return { ok:false, error:e?.message||"submit failed" };
    }
  }

  // mark social click; does not create entries itself
  async function markFollow(platform) {
    const url = `/api/admin?action=mark-follow&platform=${encodeURIComponent(platform)}`;
    const res = await fetch(url, { method:"POST" });
    // server may return {throttled:true}; still 200
    if (!res.ok) {
      let msg="mark-follow failed";
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }
  }

  // followers counts
  async function refreshFollowers() {
    const fbEl = $("#fb-followers"), igEl = $("#ig-followers");
    try {
      const res = await fetch("/api/admin?action=followers", { cache:"no-store" });
      const j = await res.json().catch(()=>({}));
      const fb = Number(j?.facebook ?? 0);
      const ig = Number(j?.instagram ?? 0);
      if (fbEl) fbEl.textContent = Number.isFinite(fb) ? fb.toLocaleString() : "—";
      if (igEl) igEl.textContent = Number.isFinite(ig) ? ig.toLocaleString() : "—";
    } catch {
      if (fbEl) fbEl.textContent = "—";
      if (igEl) igEl.textContent = "—";
    }
  }

  // spin logging (optional, safe to fail)
  async function logSpin(targets, jackpot) {
    const name = getName() || "(anonymous)";
    try { await postJSON("/api/admin?action=prize-log", { name, targets, jackpot: !!jackpot }); }
    catch {}
  }

  // ---- Harden follow buttons -------------------------------------------------
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

  async function handleFollow(platform) {
    if (!requireName()) return;

    if (globalFollowLock) return;       // hard block for any second button
    globalFollowLock = true;

    // disable both buttons briefly
    if (fbBtn) fbBtn.disabled = true;
    if (igBtn) igBtn.disabled = true;

    // open the real social page first (keeps popup allowed)
    try {
      const url = platform === "fb" ? FACEBOOK_URL : INSTAGRAM_URL;
      if (url) window.open(url, "_blank", "noopener");
    } catch {}

    try {
      await markFollow(platform);       // server has a per-IP throttle too
      await submitEntryOnce(platform);
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
    const fb0 = document.querySelector(".follow-btn-fb");
    const ig0 = document.querySelector(".follow-btn-ig");

    // Wipe inline & old listeners
    fbBtn = wipeInlineAndListeners(fb0);
    igBtn = wipeInlineAndListeners(ig0);

    // Fresh single handlers (pointerup avoids extra synthetic click on mobile)
    if (fbBtn) fbBtn.addEventListener("pointerup", (e) => {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      handleFollow("fb");
    }, { capture:true });

    if (igBtn) igBtn.addEventListener("pointerup", (e) => {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      handleFollow("ig");
    }, { capture:true });

    // Backward-compat if HTML still calls these (after we removed inline attrs)
    window.openFacebook  = (ev) => { ev?.preventDefault?.(); return fbBtn ? fbBtn.dispatchEvent(new PointerEvent("pointerup", {bubbles:true})) : false; };
    window.openInstagram = (ev) => { ev?.preventDefault?.(); return igBtn ? igBtn.dispatchEvent(new PointerEvent("pointerup", {bubbles:true})) : false; };
  }

  // ---- Slot hookup (jackpot => extra entry) ---------------------------------
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

  function boot() {
    initNamePersistence();
    wireFollowButtons();
    refreshFollowers();
    setInterval(refreshFollowers, 60_000);
    initSlot();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once:true });
  } else {
    boot();
  }
})();
