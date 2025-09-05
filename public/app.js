// /public/app.js
(() => {
  const FACEBOOK_URL = "https://facebook.com/90Surge";
  const INSTAGRAM_URL = "https://instagram.com/90_Surge";

  // Derive handles for deep links
  const FB_HANDLE = "90Surge";
  const IG_USERNAME = "90_Surge";

  // Provide your numeric FB Page ID via either:
  //   window.__FB_PAGE_ID = "1234567890"
  // or <html data-fb-page-id="1234567890">
  const FB_PAGE_ID =
    (typeof window !== "undefined" && window.__FB_PAGE_ID) ||
    document.documentElement.getAttribute("data-fb-page-id") ||
    "";

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
        refreshEntryStats().catch(() => {});
        return { ok: true, already: true };
      }
      console.debug(`[entry] recorded for ${source}`);
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
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform }),
    });
    if (!res.ok) {
      let msg = "mark-follow failed";
      try {
        msg = (await res.json()).error || msg;
      } catch {}
      throw new Error(msg);
    }
  }

  function markFollowBeacon(platform) {
    const url = `/api/admin?action=mark-follow&platform=${encodeURIComponent(
      platform
    )}`;
    const blob = new Blob([JSON.stringify({ platform })], {
      type: "application/json",
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, blob);
    } else {
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: blob,
        keepalive: true,
      }).catch(() => {});
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
  // Prize helpers + jackpot logging
  // ──────────────────────────────────────────────────────────────
  const KNOWN_PRIZES = new Set([
    "Sticker",
    "T-Shirt",
    "VIP Seat",
    "Extra Entry",
    "Jackpot", // allowed in data, but we won't choose it as a fallback
  ]);

  // Only consider these in the weak/fallback scan for the observer
  const OBSERVER_FALLBACK_PRIZES = new Set([
    "Sticker",
    "VIP Seat",
    "Extra Entry",
  ]);

  const EMOJI_MAP = new Map([
    ["🍒", "Cherry"],
    ["🍌", "Banana"],
    ["🍋", "Lemon"],
    ["⭐", "Star"],
    ["💎", "Diamond"],
    ["🔔", "Bell"],
    ["🍇", "Grape"],
    ["🍊", "Orange"],
    ["7", "Seven"],
  ]);

  function toTitle(s) {
    return String(s || "").replace(
      /\w\S*/g,
      (t) => t[0].toUpperCase() + t.slice(1).toLowerCase()
    );
  }

  function stringifyTarget(t) {
    if (t == null) return "";
    if (typeof t === "string") return t.trim();
    if (typeof t === "object") {
      // prefer human labels; fall back to emoji/symbol; else stringify
      return (
        t.text ||
        t.label ||
        t.name ||
        t.title ||
        t.prize ||
        t.emoji ||
        t.symbol ||
        t.value ||
        String(t)
      )
        .toString()
        .trim();
    }
    return String(t).trim();
  }

  function coercePrizeLabel(raw) {
    let s = (raw || "").toString().trim();
    if (!s) return "";
    if (EMOJI_MAP.has(s)) s = EMOJI_MAP.get(s); // map emoji
    // normalize common variants
    s = s.replace(/\btee\s*-?\s*shirt\b/i, "T-Shirt");
    if (/shirt/i.test(s)) s = "T-Shirt";
    if (/sticker/i.test(s)) s = "Sticker";
    if (/extra/i.test(s)) s = "Extra Entry";
    if (/^vip(\s*seat|s)?$/i.test(s)) s = "VIP Seat";

    s = toTitle(s);
    s = s.replace(/\bVip\b/g, "VIP");
    return s;
  }

  function isConfidentPrize(s) {
    const x = coercePrizeLabel(s);
    if (!x) return false;
    // must be known or look like a clean label/emoji (avoid random words like "Help")
    return KNOWN_PRIZES.has(x) || /[\p{Extended_Pictographic}\w]{2,}/u.test(x);
  }

  // Keep last resolved targets in memory for any fallbacks
  let __lastSpinTargets = [];

  // jackpots only; beacon GET first, then POST fallback (with timestamp)
  async function logSpin(targets, jackpot) {
    if (!jackpot) return;
    const name = getName() || "(anonymous)";
    const safeTargets = (Array.isArray(targets) ? targets : [])
      .map(coercePrizeLabel)
      .filter(Boolean);
    const ts = Date.now();

    // Try beacon GET
    let sent = false;
    try {
      const params = new URLSearchParams({
        name,
        jackpot: "true",
        targets: safeTargets.join(","),
        ts: String(ts),
      });
      const url = `/api/admin?action=prize-log&${params}`;
      if ("sendBeacon" in navigator) {
        sent = navigator.sendBeacon(
          url,
          new Blob([""], { type: "text/plain" })
        );
      }
    } catch {}

    if (!sent) {
      try {
        await postJSON("/api/admin?action=prize-log", {
          name,
          targets: safeTargets,
          jackpot: true,
          ts,
        });
      } catch (e) {
        console.warn("logSpin POST failed:", e?.message || e);
      }
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Entry Stats (Your entries + Total entries)
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
  // Device helpers + robust FB deep links (native-only)
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

  function getAppSchemes(platform) {
    if (platform === "ig") {
      return [`instagram://user?username=${IG_USERNAME}`];
    }
    // Facebook
    const schemes = [];
    const id = (FB_PAGE_ID || "").trim();

    if (id) {
      if (isIOS()) {
        // Most reliable on iOS: profile by numeric id, then page id variants
        schemes.push(`fb://profile/${id}`);
        schemes.push(`fb://page/?id=${id}`);
        schemes.push(`fb://page/${id}`);
      } else {
        // Android tends to prefer page/<id>; try a couple variants
        schemes.push(`fb://page/${id}`);
        schemes.push(`fb://profile/${id}`);
        schemes.push(`fb://page/?id=${id}`);
      }
    } else {
      // No numeric id provided — fall back to app internal facewebmodal link
      schemes.push(
        `fb://facewebmodal/f?href=${encodeURIComponent(FACEBOOK_URL)}`
      );
    }
    return schemes;
  }

  // Try to open the native app ONLY. We attempt multiple candidate schemes.
  // We only log a follow if the page goes to background (app actually opened).
  function openAppAndTrack(platform, { timeout = 1800 } = {}) {
    return new Promise((resolve) => {
      const schemes = getAppSchemes(platform);
      let done = false;
      let iframe = null;
      let attemptIdx = 0;

      const cleanup = () => {
        document.removeEventListener("visibilitychange", onVis, true);
        window.removeEventListener("pagehide", onHidden, true);
        window.removeEventListener("blur", onBlur, true);
        clearTimeout(timer);
        clearTimeout(stepper);
        if (iframe && iframe.parentNode) {
          try {
            document.body.removeChild(iframe);
          } catch {}
        }
      };

      const onHidden = () => {
        if (done) return;
        done = true;
        // Count only when we *actually* background → app likely opened
        try {
          markFollowBeacon(platform);
        } catch {}
        try {
          submitEntryOnceBeacon(platform);
        } catch {}
        cleanup();
        resolve(true);
      };

      const onVis = () => {
        if (document.visibilityState === "hidden") onHidden();
      };

      const onBlur = () => {
        // iOS often blurs tab when handing off to app
        setTimeout(onHidden, 0);
      };

      document.addEventListener("visibilitychange", onVis, {
        once: true,
        capture: true,
      });
      window.addEventListener("pagehide", onHidden, {
        once: true,
        capture: true,
      });
      window.addEventListener("blur", onBlur, { once: true, capture: true });

      const tryOne = (url) => {
        try {
          if (isAndroid()) {
            iframe = document.createElement("iframe");
            iframe.style.display = "none";
            iframe.src = url;
            document.body.appendChild(iframe);
            setTimeout(() => {
              try {
                if (iframe && iframe.parentNode)
                  document.body.removeChild(iframe);
              } catch {}
            }, 2000);
          } else {
            window.location.href = url; // iOS
          }
        } catch {}
      };

      // Step through candidates every ~600ms until timeout or backgrounding
      const step = () => {
        if (done || attemptIdx >= schemes.length) return;
        tryOne(schemes[attemptIdx++]);
        if (!done && attemptIdx < schemes.length) {
          stepper = setTimeout(step, 600);
        }
      };

      let stepper = setTimeout(step, 0);

      const timer = setTimeout(() => {
        if (done) return; // app launched
        done = true; // app likely NOT installed → don't count follow
        cleanup();
        resolve(false);
      }, timeout);
    });
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
        // Mobile: open native app only; count follow ONLY if app launch detected
        await openAppAndTrack(platform);
      } else {
        // Desktop: open site immediately (sync) then async logging
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
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      document.querySelectorAll('a[href^="intent://"]').forEach((a) => {
        const href = a.getAttribute("href") || "";
        const isFb = /facebook|katana|\/profile\//i.test(href);
        a.setAttribute(
          "href",
          isFb
            ? "https://facebook.com/90Surge"
            : "https://instagram.com/90_Surge"
        );
        a.classList.add(isFb ? "follow-btn-fb" : "follow-btn-ig");
      });
    },
    { once: true }
  );

  // 2) Catch any remaining intent:// clicks and route through our controlled flow
  document.addEventListener(
    "click",
    (e) => {
      const a = e.target.closest('a[href^="intent://"]');
      if (!a) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const isFb = /facebook|katana|\/profile\//i.test(
        a.getAttribute("href") || ""
      );
      const platform = isFb ? "fb" : "ig";
      handleFollow(platform, isFb ? fbBtn : igBtn);
    },
    true
  );

  // 3) Wire follow buttons and plain anchors to fb/ig
  function wireFollowButtons() {
    // Tag plain anchors first
    document
      .querySelectorAll('a[href*="facebook.com"]')
      .forEach((a) => a.classList.add("follow-btn-fb"));
    document
      .querySelectorAll('a[href*="instagram.com"]')
      .forEach((a) => a.classList.add("follow-btn-ig"));

    // (re)select after tagging
    let fb0 = document.querySelector(".follow-btn-fb");
    let ig0 = document.querySelector(".follow-btn-ig");

    // wipe & rebind
    fbBtn = wipeInlineAndListeners(fb0);
    igBtn = wipeInlineAndListeners(ig0);

    const bind = (el, platform) => {
      if (!el) return;
      const go = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        handleFollow(platform, el);
      };
      el.addEventListener("pointerup", go, { capture: true });
      el.addEventListener("click", go, { capture: true });
    };

    bind(fbBtn, "fb");
    bind(igBtn, "ig");

    // Back-compat for any old HTML onclicks
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
  // Slot hookup (jackpot => extra entry) + universal hooks
  // ──────────────────────────────────────────────────────────────
  function initSlot() {
    if (typeof window.initSlotMachine !== "function") {
      console.warn("[slot] initSlotMachine missing; skipping hook");
      return;
    }

    const handleResult = async (result) => {
      try {
        // 1) Collect targets from engine (objects → labels)
        const targetsRaw = Array.isArray(result?.targets) ? result.targets : [];
        const targets = targetsRaw
          .map((t) => coercePrizeLabel(stringifyTarget(t)))
          .filter(Boolean);

        // 2) If engine exposes a single prize, use it to fill
        if (!targets.length && result?.prize) {
          const p = coercePrizeLabel(stringifyTarget(result.prize));
          if (p) targets.push(p, p, p);
        }

        // 3) Save for any message-based fallback
        __lastSpinTargets = targets.slice();

        // 4) Jackpot detection (trust engine flag OR triple-same OR textual hint)
        const lcase = targets.map((t) => t.toLowerCase());
        const hitJackpot =
          !!(
            result?.jackpot ||
            result?.isJackpot ||
            result?.align ||
            result?.win
          ) ||
          (lcase.length >= 3 && new Set(lcase.slice(0, 3)).size === 1) ||
          /jackpot/i.test(
            String(result?.message || result?.text || targets.join(" "))
          );

        // 5) Log winners only (server ignores non-jackpots anyway)
        await logSpin(targets, hitJackpot);

        // Identify primary prize (if it's a real triple)
        const primaryPrize =
          targets.length >= 3 &&
          targets[0] &&
          targets[0] === targets[1] &&
          targets[1] === targets[2]
            ? targets[0]
            : "";

        // Small guard so engine + observer can’t double-award within a second
        window.__lastBonusAwardAt ??= 0;
        const canAwardBonus = () => {
          const now = Date.now();
          if (now - window.__lastBonusAwardAt < 1000) return false;
          window.__lastBonusAwardAt = now;
          return true;
        };

        if (hitJackpot) {
          // Standard 1-per-window jackpot ticket (deduped)
          if (getName()) await submitEntryOnce("jackpot");

          // Extra Entry jackpot → add a non-deduped bonus
          if (primaryPrize === "Extra Entry" && getName() && canAwardBonus()) {
            try {
              await postJSON("/api/admin?action=bonus-entry", {
                name: getName(),
                targets,
              });
              refreshEntryStats().catch(() => {});
            } catch (e) {
              console.warn("[slot] bonus-entry failed:", e?.message || e);
            }
          }
        }

      
      } catch (err) {
        console.warn("[slot] handleResult error:", err?.message || err);
      }
    };

    // Cover multiple callback names the engine might use
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

    // Also listen to a potential custom event
    window.addEventListener(
      "slot:result",
      (e) => handleResult(e?.detail || e),
      { passive: true }
    );
  }

  // Backup logger: observe the UI JACKPOT message and log if needed
  function observeJackpotMessage() {
    const el = document.querySelector(
      "#slot-result, .slot-result, [data-slot-result]"
    );
    if (!el) return;

    // tiny throttle to avoid double DOM fires
    let lastSentAt = 0;

    function extractPrizeFromText(text) {
      // Focus only on the part after “JACKPOT!”
      const focus = String(text || "")
        .split(/JACKPOT!?/i)
        .pop();

      // 1) “Quoted” or "quoted"
      let m = focus.match(/["“]([^"”]+)["”]/);
      if (m && isConfidentPrize(m[1])) return coercePrizeLabel(m[1]);

      // 2) [Bracketed]
      m = focus.match(/\[([^\]]+)\]/);
      if (m && isConfidentPrize(m[1])) return coercePrizeLabel(m[1]);

      // 3) NAME x3 / ×3
      m = focus.match(/hit\s+([A-Za-z0-9 _-]{2,30})\s*(?:×|x)\s*3/i);
      if (m && isConfidentPrize(m[1])) return coercePrizeLabel(m[1]);

      // 4) Triple identical emoji
      try {
        const em = Array.from(
          focus.matchAll(
            /(\p{Extended_Pictographic}|\p{Emoji_Presentation})\s*\1\s*\1/gu
          )
        );
        if (em.length) {
          const mapped = coercePrizeLabel(em[0][1]);
          if (isConfidentPrize(mapped)) return mapped;
        }
      } catch {}

      // 5) Explicit phrases we expect from the UI text
      if (/extra\s*entry/i.test(focus)) return "Extra Entry";
      if (/^|\bvip\b/i.test(focus) && /seat/i.test(focus)) return "VIP Seat";
      if (/sticker/i.test(focus)) return "Sticker";

      // 6) Weak fallback: only scan the safe allow-list (NEVER T-Shirt here)
      for (const k of OBSERVER_FALLBACK_PRIZES) {
        if (new RegExp(`\\b${k}\\b`, "i").test(focus)) return k;
      }

      return ""; // refuse weak guesses (prevents “Free T-Shirt” leakage)
    }

    const maybeLogFromMessage = () => {
      const text = (el.textContent || "").trim();
      if (!text) return;
      if (!/JACKPOT!/i.test(text)) return;

      const now = Date.now();
      if (now - lastSentAt < 600) return; // tiny throttle
      lastSentAt = now;

      // Prefer last engine-provided targets if they look like a triple
      let prize = "";
      if (__lastSpinTargets.length >= 3) {
        const [a, b, c] = __lastSpinTargets.slice(0, 3);
        if (a && a === b && b === c) prize = a;
      }
      // Otherwise parse from the text (strict)
      if (!prize) prize = extractPrizeFromText(text);
      if (!prize) return; // give up rather than logging "Help"

      const name = getName() || "(anonymous)";
      const nowTs = Date.now();

      // Log the jackpot in the winners ledger
      postJSON("/api/admin?action=prize-log", {
        name,
        targets: [prize, prize, prize],
        jackpot: true,
        ts: nowTs,
      })
        .then(() => {
          console.debug("[slot] jackpot logged via message observer:", prize);

          // If the parsed prize is Extra Entry, award bonus (guarded) — put INSIDE this function
          if (prize === "Extra Entry" && getName()) {
            window.__lastBonusAwardAt ??= 0;
            const t = Date.now();
            if (t - window.__lastBonusAwardAt > 1000) {
              window.__lastBonusAwardAt = t;
              postJSON("/api/admin?action=bonus-entry", {
                name: getName(),
                targets: [prize, prize, prize],
              })
                .then(() => refreshEntryStats().catch(() => {}))
                .catch(() => {});
            }
          }
        })
        .catch(() => {});
    };

    const obs = new MutationObserver(maybeLogFromMessage);
    obs.observe(el, { childList: true, characterData: true, subtree: true });
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
<script>
(function(){
  const ENTRIES_EL = document.getElementById("raffle-entries"); // ensure this id exists
  async function refreshEntries() {
    try {
      const fileId = localStorage.getItem("lastUploadFileId") || "";
      const qs = fileId ? `&fileId=${encodeURIComponent(fileId)}` : "";
      const res = await fetch(`/api/admin?action=my-entries${qs}`);
      const data = await res.json();
      ENTRIES_EL.textContent = String(Number(data.entries || 1));
    } catch {
      ENTRIES_EL.textContent = "1";
    }
  }

  // Initial load
  refreshEntries();

})();
</script>

  // ──────────────────────────────────────────────────────────────
  // Winner UI (modal + banner) — auto-fire + live update
  // ──────────────────────────────────────────────────────────────
  const SHOWN_WINNER_KEY = "shownWinnerName";
  let lastWinner = null;

  function winnerBannerEl() {
    return (
      document.querySelector(".raffle.raffle-title.blink") ||
      document.querySelector("[data-winner-banner]")
    );
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

  function startWinnerPolling() {
    const T = 4000;
    async function tick() {
      try {
        const r = await fetch("/api/admin?action=winner", {
          cache: "no-store",
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
        try {
          es.close();
        } catch {}
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

    // headline init/refresh — only affects headline text
    initConfigHeadline();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") initConfigHeadline();
    });

    // winner modal + banner (auto-fire + live)
    (function initWinnerBannerDefault() {
      const el =
        document.querySelector(".raffle.raffle-title.blink") ||
        document.querySelector("[data-winner-banner]");
      if (el && !el.getAttribute("data-default")) {
        el.setAttribute(
          "data-default",
          el.textContent || "Free T-shirt raffle!"
        );
      }
    })();
    fetchWinnerOnce()
      .then((name) => {
        maybeDisplayWinner(name);
      })
      .catch(() => {});

    // jackpot message observer (safety net)
    observeJackpotMessage();

    // slot hooks
    initSlot();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
