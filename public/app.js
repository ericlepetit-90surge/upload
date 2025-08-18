// /public/app.js
(() => {
  const FACEBOOK_URL  = "https://facebook.com/90Surge";
  const INSTAGRAM_URL = "https://instagram.com/90_Surge";

  const NAME_KEY = "raffle_display_name";
  const $ = (s, r=document)=>r.querySelector(s);

  const nameEl = () => $("#user-display-name");
  const getName = () => (nameEl()?.value || "").trim().slice(0,80);

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

  // ──────────────────────────────────────────────────────────────
  // Entries submission (server dedupes per IP per source per window)
  // ──────────────────────────────────────────────────────────────
  async function submitEntryOnce(source) {
    const name = getName();
    if (!name) return { ok:false, error:"Missing name" };
    try {
      const out = await postJSON("/api/admin?action=enter", { name, source });
      if (out?.already) {
        console.debug(`[entry] already for ${source}`);
        // still refresh totals in case another client added in-between
        refreshEntryStats().catch(()=>{});
        return { ok:true, already:true };
      }
      console.debug(`[entry] recorded for ${source}`);
      // refresh counts immediately after a new ticket
      refreshEntryStats().catch(()=>{});
      return { ok:true, already:false };
    } catch (e) {
      console.error(`[entry] failed ${source}:`, e?.message||e);
      return { ok:false, error:e?.message||"submit failed" };
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Social mark (does NOT create entries)
  // ──────────────────────────────────────────────────────────────
  async function markFollow(platform) {
    const url = `/api/admin?action=mark-follow&platform=${encodeURIComponent(platform)}`;
    const res = await fetch(url, { method:"POST" });
    // 200 OK even when throttled (server returns {throttled:true})
    if (!res.ok) {
      let msg="mark-follow failed";
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Followers counts
  // ──────────────────────────────────────────────────────────────
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

  // ──────────────────────────────────────────────────────────────
  // Prize/spin logging (optional, safe to fail)
  // ──────────────────────────────────────────────────────────────
  async function logSpin(targets, jackpot) {
    const name = getName() || "(anonymous)";
    try { await postJSON("/api/admin?action=prize-log", { name, targets, jackpot: !!jackpot }); }
    catch {}
  }

  // ──────────────────────────────────────────────────────────────
  // Entry Stats UI (Your entries + Total entries)
  // ──────────────────────────────────────────────────────────────
  function ensureEntryStatsUI() {
    if ($("#entry-stats")) return;

    // CSS
    if (!$("#entry-stats-css")) {
      const style = document.createElement("style");
      style.id = "entry-stats-css";
      style.textContent = `
        .entry-stats-card{
          width:100%; margin:16px auto 8px; padding:14px 16px;
          border-radius:14px; background:linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,.02));
          border:1px solid rgba(255,255,255,.10); color:#eef2ff;
          display:grid; grid-template-columns: 1fr 1fr; gap:12px;
        }
        .entry-stat{ display:grid; grid-template-rows:auto 1fr; align-items:center; background:rgba(0,0,0,.2);
          border-radius:10px; padding:10px 12px; border:1px solid rgba(255,255,255,.06);
        }
        .entry-stat-label{ font-size:.85rem; opacity:.8; letter-spacing:.2px }
        .entry-stat-value{ font-size:1.6rem; font-weight:900; line-height:1.1; }
        .entry-bump{ animation: entry-bump .35s ease-out; }
        @keyframes entry-bump {
          0%{ transform:scale(1); }
          40%{ transform:scale(1.12); }
          100%{ transform:scale(1); }
        }
        @media (max-width:420px){
          .entry-stats-card{ grid-template-columns: 1fr; }
        }
      `;
      document.head.appendChild(style);
    }

    // Card
    const card = document.createElement("div");
    card.id = "entry-stats";
    card.className = "entry-stats-card";
    card.innerHTML = `
      <div class="entry-stat">
        <div class="entry-stat-label">Your entries</div>
        <div class="entry-stat-value" id="your-entries-count">0</div>
      </div>
      <div class="entry-stat">
        <div class="entry-stat-label">Total entries</div>
        <div class="entry-stat-value" id="total-entries-count">0</div>
      </div>
    `;

    // Insert just below followers or above slot
    const anchor = $(".followers-wrapper") || $("#slot-root") || document.body;
    anchor.parentNode.insertBefore(card, anchor.nextSibling);
  }

  let prevYour = 0, prevTotal = 0;

  function bump(el) {
    if (!el) return;
    el.classList.remove("entry-bump");
    // reflow to restart animation
    // eslint-disable-next-line no-unused-expressions
    el.offsetWidth;
    el.classList.add("entry-bump");
    setTimeout(()=>el.classList.remove("entry-bump"), 400);
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
  } catch {}

  // Fallback: compute total from /entries and ignore "your" (shows 0 if we can't determine)
  try {
    const res = await fetch("/api/admin?action=entries", { cache:"no-store" });
    const j = await res.json().catch(()=>({ entries:[], count:0 }));
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
      await markFollow(platform);       // server has an additional per-IP throttling lock
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
    const fb0 = $(".follow-btn-fb");
    const ig0 = $(".follow-btn-ig");

    // Wipe inline & old listeners
    fbBtn = wipeInlineAndListeners(fb0);
    igBtn = wipeInlineAndListeners(ig0);

    // Fresh single handlers (pointerup avoids extra synthetic click on mobile)
    if (fbBtn) fbBtn.addEventListener("pointerup", (e) => {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      handleFollow("fb", fbBtn);
    }, { capture:true });

    if (igBtn) igBtn.addEventListener("pointerup", (e) => {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      handleFollow("ig", igBtn);
    }, { capture:true });

    // Backward-compat if HTML still calls these
    window.openFacebook  = (ev) => { ev?.preventDefault?.(); return fbBtn ? fbBtn.dispatchEvent(new PointerEvent("pointerup", {bubbles:true})) : false; };
    window.openInstagram = (ev) => { ev?.preventDefault?.(); return igBtn ? igBtn.dispatchEvent(new PointerEvent("pointerup", {bubbles:true})) : false; };
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
    ensureEntryStatsUI();    // mount the stats card
    wireFollowButtons();

    refreshFollowers();
    setInterval(refreshFollowers, 60_000);

    refreshEntryStats();
    setInterval(refreshEntryStats, 15_000);

    initSlot();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once:true });
  } else {
    boot();
  }
})();
