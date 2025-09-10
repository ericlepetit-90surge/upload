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

  const NAME_KEY = "raffle_display_name";
  const $ = (s, r = document) => r.querySelector(s);

  const nameEl = () => $("#user-display-name");
  const getName = () => (nameEl()?.value || "").trim().slice(0, 80);

  const WINNER_SSE_URL = ""; // optional SSE server

  // ── Round-start override (only used when server startTime is missing) ──
  const ROUND_START_KEY = "roundStartAtMs";
  const autoPickGuard = new Set();

  function getRoundStartOverride() {
    const v = Number(sessionStorage.getItem(ROUND_START_KEY));
    return Number.isFinite(v) ? v : null;
  }
  function setRoundStartOverride(ms = Date.now()) {
    try {
      sessionStorage.setItem(ROUND_START_KEY, String(ms));
    } catch {}
    autoPickGuard.clear();
    clearEffectiveStartPin(); // also clear the pin so we can re-pin
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
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive,
      body: JSON.stringify(body || {}),
    });
    let json = {};
    try {
      json = await res.json();
    } catch {}
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
      refreshEntryStats().catch(() => {});
      startWinnerCountdown(true); // refresh countdown text from fresh config
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
    const url = "/api/admin?action=enter";
    const data = JSON.stringify({ name, source });
    const blob = new Blob([data], { type: "application/json" });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, blob);
    } else {
      postJSON(url, { name, source }, { keepalive: true }).catch(() => {});
    }
    setTimeout(() => {
      refreshEntryStats().catch(() => {});
      startWinnerCountdown(true);
    }, 600);
  }

  // expose for slot.js helper (back-compat)
  window.submitEntryOnce = submitEntryOnce;
  window.canSubmitFor = (source) => !!getName();

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
    } catch {
      if (fbEl) fbEl.textContent = "—";
      if (igEl) igEl.textContent = "—";
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Prize helpers + jackpot logging (STRICT, no cross-swaps)
  // ──────────────────────────────────────────────────────────────
  const KNOWN_PRIZES = new Set([
    "Sticker",
    "T-Shirt",
    "VIP Seat",
    "Extra Entry",
    "Jackpot",
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

  // Extract the most "prize-ish" text from a token
  function extractTargetText(t) {
    if (t == null) return "";
    if (typeof t === "string") return t.trim();
    if (typeof t === "object") {
      const fields = [
        "prize",
        "label",
        "title",
        "name",
        "text",
        "emoji",
        "symbol",
        "value",
      ];
      for (const k of fields) {
        if (t[k] != null && String(t[k]).trim()) return String(t[k]).trim();
      }
      try {
        return String(t).trim();
      } catch {
        return "";
      }
    }
    return String(t).trim();
  }

  // Canonicalize a single token coming from a reel cell or single field
  function canonicalFromSingle(raw) {
    let s = (raw || "").toString().trim();
    if (!s) return "";
    if (EMOJI_MAP.has(s)) s = EMOJI_MAP.get(s);
    s = s.replace(/\btee\s*-?\s*shirt\b/i, "T-Shirt");
    const lower = s.toLowerCase();

    if (/^vip(\s*seat|s)?$/.test(lower) || lower === "vip") return "VIP Seat";
    if (/^(t-?\s*shirt|tshirt|t\s*shirt|tee\s*shirt|shirt)$/.test(lower))
      return "T-Shirt";
    if (/^stickers?$/.test(lower)) return "Sticker";
    if (/^(extra\s*entry|bonus\s*entry|free\s*entry|extra)$/.test(lower))
      return "Extra Entry";
    if (/^jackpot$/.test(lower)) return "Jackpot";

    // exact-title fallback
    const title = toTitle(s).replace(/\bVip\b/g, "VIP");
    return KNOWN_PRIZES.has(title) ? title : "";
  }

  // Determine prize strictly from the three reel tokens
  // Determine prize strictly from the three reel tokens (canonicalize first)
function prizeFromReelTargets(targets) {
  const raw = Array.isArray(targets) ? targets : [];
  const labels = raw.map(extractTargetText).filter(Boolean);
  if (labels.length < 3) return "";

  // Canonicalize each of the first three
  const canon = labels.slice(0, 3).map(canonicalFromSingle);

  // A valid triple only if all three canonical forms are the same known prize
  if (canon.every(Boolean) && new Set(canon).size === 1 && KNOWN_PRIZES.has(canon[0])) {
    return canon[0];
  }
  return "";
}


  // Parse only the HEADLINE of the UI text: the words right after "JACKPOT!" and before the dash.
  function headlinePrizeFromUIText(uiText) {
    const txt = String(uiText || "");
    const m = txt.match(/JACKPOT!\s*([^\n—–-]{2,40})/i);
    if (!m) return "";
    const head = m[1].trim().replace(/[.!]+$/, "");
    const canon = canonicalFromSingle(head);
    return KNOWN_PRIZES.has(canon) ? canon : "";
  }

  let __lastSpinTargets = []; // definitive [p,p,p] only

  // ensure extra-entry bonus happens once per spin
  let __awardedExtraThisSpin = false;
  let __awardResetTimer = null;
  function markExtraAwardedOnce() {
    __awardedExtraThisSpin = true;
    clearTimeout(__awardResetTimer);
    __awardResetTimer = setTimeout(() => {
      __awardedExtraThisSpin = false;
    }, 5000);
  }

  async function logSpin(triple, jackpot) {
    if (!jackpot) return;
    if (!Array.isArray(triple) || triple.length < 3) return;
    const p = triple[0];
    if (!p || new Set(triple.slice(0, 3)).size !== 1) return;
    if (!KNOWN_PRIZES.has(p)) return;

    const name = getName() || "(anonymous)";
    const ts = Date.now();

    // try beacon
    try {
      const params = new URLSearchParams({
        name,
        jackpot: "true",
        targets: triple.join(","),
        ts: String(ts),
      });
      const url = `/api/admin?action=prize-log&${params}`;
      if (
        "sendBeacon" in navigator &&
        navigator.sendBeacon(url, new Blob([""], { type: "text/plain" }))
      ) {
        return;
      }
    } catch {}
    // fallback POST
    try {
      await postJSON("/api/admin?action=prize-log", {
        name,
        targets: triple,
        jackpot: true,
        ts,
      });
    } catch (e) {
      console.warn("logSpin POST failed:", e?.message || e);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Entry Stats
  // ──────────────────────────────────────────────────────────────
  function ensureEntryStatsUI() {
    if (!$("#entry-stats")) {
      console.warn("[entry-stats] #entry-stats container not found.");
    }
  }

  let prevYour = 0,
    prevTotal = 0;

  function bump(el) {
    if (!el) return;
    el.classList.remove("entry-bump");
    // reflow
    // eslint-disable-next-line no-unused-expressions
    el.offsetWidth;
    el.classList.add("entry-bump");
    setTimeout(() => el.classList.remove("entry-bump"), 400);
  }

  async function refreshEntryStats() {
    ensureEntryStatsUI();
    const yourEl = $("#your-entries-count") || $("#raffle-entries");
    const totalEl = $("#total-entries-count");

    try {
      const res = await fetch("/api/admin?action=my-entries", {
        cache: "no-store",
      });
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

    // Fallback path
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
      if (yourEl) {
        if (total === 0) {
          prevYour = 0;
        }
        yourEl.textContent = prevYour.toLocaleString();
      }
    } catch {
      if (totalEl) totalEl.textContent = "—";
      if (yourEl) yourEl.textContent = "0";
    }
  }

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
    if (platform === "ig") return [`instagram://user?username=${IG_USERNAME}`];
    const schemes = [];
    const id = (FB_PAGE_ID || "").trim();
    if (id) {
      if (isIOS()) {
        schemes.push(
          `fb://profile/${id}`,
          `fb://page/?id=${id}`,
          `fb://page/${id}`
        );
      } else {
        schemes.push(
          `fb://page/${id}`,
          `fb://profile/${id}`,
          `fb://page/?id=${id}`
        );
      }
    } else {
      schemes.push(
        `fb://facewebmodal/f?href=${encodeURIComponent(FACEBOOK_URL)}`
      );
    }
    return schemes;
  }

  // Try to open the native app ONLY.
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

      if (schemes.length) {
        tryOne(schemes[0]);
        attemptIdx = 1;
      }

      const step = () => {
        if (done || attemptIdx >= schemes.length) return;
        tryOne(schemes[attemptIdx++]);
        if (!done && attemptIdx < schemes.length)
          stepper = setTimeout(step, 600);
      };
      let stepper = setTimeout(step, 600);

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        resolve(false);
      }, timeout);
    });
  }

  // ──────────────────────────────────────────────────────────────
  // Follow buttons — single-click, delegated
  // ──────────────────────────────────────────────────────────────
  let globalFollowLock = false;

  function wireFollowButtons() {
    document
      .querySelectorAll('a[href*="facebook.com"]')
      .forEach((a) => a.classList.add("follow-btn-fb"));
    document
      .querySelectorAll('a[href*="instagram.com"]')
      .forEach((a) => a.classList.add("follow-btn-ig"));

    const onClick = (platform) => (e) => {
      const sel =
        platform === "fb"
          ? '.follow-btn-fb, a[href*="facebook.com"]'
          : '.follow-btn-ig, a[href*="instagram.com"]';
      const el = e.target.closest(sel);
      if (!el) return;

      if (!requireName()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (globalFollowLock) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      globalFollowLock = true;

      try {
        if (!isMobile()) {
          e.preventDefault();
          e.stopPropagation();
          const url = platform === "fb" ? FACEBOOK_URL : INSTAGRAM_URL;
          if (url) window.open(url, "_blank", "noopener");
          markFollowBeacon(platform);
          submitEntryOnceBeacon(platform);
          setTimeout(() => (globalFollowLock = false), 300);
        } else {
          e.preventDefault();
          e.stopPropagation();
          openAppAndTrack(platform)
            .catch(() => {})
            .finally(() => {
              setTimeout(() => (globalFollowLock = false), 300);
            });
        }
      } catch {
        globalFollowLock = false;
      }
    };

    document.addEventListener("click", onClick("fb"), true);
    document.addEventListener("click", onClick("ig"), true);

    window.openFacebook = (ev) => {
      ev?.preventDefault?.();
      const a = document.querySelector(".follow-btn-fb");
      if (a) a.click();
      return false;
    };
    window.openInstagram = (ev) => {
      ev?.preventDefault?.();
      const a = document.querySelector(".follow-btn-ig");
      if (a) a.click();
      return false;
    };
  }

  // ──────────────────────────────────────────────────────────────
  // Slot hookup (jackpot => extra entry) — authoritative prize detect
  // ──────────────────────────────────────────────────────────────
  function initSlot() {
    if (typeof window.initSlotMachine !== "function") {
      console.warn("[slot] initSlotMachine missing; skipping hook");
      return;
    }

    const handleResult = async (result) => {
      try {
        // Priority: reels x3 → result.prize (single-field) → UI headline
        let primary = prizeFromReelTargets(result?.targets);
        if (!primary) primary = canonicalFromSingle(extractTargetText(result?.prize));
        if (!primary) primary = headlinePrizeFromUIText(result?.message || result?.text);

        const hitJackpot =
          !!(
            result?.jackpot ||
            result?.isJackpot ||
            result?.align ||
            result?.win
          ) || !!primary;

        __lastSpinTargets = primary ? [primary, primary, primary] : [];

        if (hitJackpot && primary) {
          await logSpin(__lastSpinTargets, true);

          if (primary === "Extra Entry") {
            if (getName() && !__awardedExtraThisSpin) {
              markExtraAwardedOnce();
              try {
                await postJSON("/api/admin?action=bonus-entry", {
                  name: getName(),
                  targets: __lastSpinTargets,
                });
                refreshEntryStats().catch(() => {});
              } catch (e) {
                console.warn("[slot] bonus-entry failed:", e?.message || e);
              }
            }
          } else {
            if (getName()) await submitEntryOnce("jackpot");
          }
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

    window.addEventListener(
      "slot:result",
      (e) => handleResult(e?.detail || e),
      { passive: true }
    );

    // Optional: dump next jackpot RESULT event for debugging
    window.__dumpNextJackpotEvent = () => {
      const handler = (e) => {
        const r = e?.detail || e;
        const primary =
          prizeFromReelTargets(r?.targets) ||
          canonicalFromSingle(extractTargetText(r?.prize)) ||
          headlinePrizeFromUIText(r?.message || r?.text);
        const msg = r?.message || r?.text || "";
        const isJackpot =
          r?.jackpot || r?.isJackpot || r?.align || r?.win || !!primary;
        if (!isJackpot) return;
        console.group("JACKPOT dump (result event)");
        console.log("result.targets:", r?.targets);
        console.log("primary (resolved):", primary);
        console.log("raw prize field:", r?.prize);
        console.log("raw message/text:", msg);
        console.log("full result:", r);
        console.groupEnd();
        window.removeEventListener("slot:result", handler, true);
      };
      window.addEventListener("slot:result", handler, true);
      console.log("Will dump the next JACKPOT result event…");
    };
  }

  // Backup logger — now parses UI HEADLINE when event data is missing
  function observeJackpotMessage() {
    const el = document.querySelector(
      "#slot-result, .slot-result, [data-slot-result]"
    );
    if (!el) return;

    let lastSentAt = 0;
    let lastKey = "";

    const maybeLogFromMessage = () => {
      const text = (el.textContent || "").trim();
      if (!text || !/JACKPOT!/i.test(text)) return;

      // Prefer primary from reels (if the event handler already captured)
      let primary = __lastSpinTargets.length === 3 ? __lastSpinTargets[0] : "";

      // Otherwise, parse only the headline (avoid tail-descriptions like “to win a T-shirt”)
      if (!primary) primary = headlinePrizeFromUIText(text);
      if (!primary || !KNOWN_PRIZES.has(primary)) return;

      const triple = [primary, primary, primary];
      const key = JSON.stringify(triple);
      const now = Date.now();
      if (key === lastKey && now - lastSentAt < 800) return; // dedupe

      lastKey = key;
      lastSentAt = now;

      const name = getName() || "(anonymous)";
      postJSON("/api/admin?action=prize-log", {
        name,
        targets: triple,
        jackpot: true,
        ts: Date.now(),
      }).catch(() => {});
    };

    const obs = new MutationObserver(maybeLogFromMessage);
    obs.observe(el, { childList: true, characterData: true, subtree: true });
  }

  // ──────────────────────────────────────────────────────────────
  // HEADLINE CONFIG + CACHE
  // ──────────────────────────────────────────────────────────────
  const CFG_CACHE_KEY = "cfg";
  const HEADLINE_SELECTORS = ["#headline", ".show-name", "[data-headline]"];

  function setHeadlineText(name) {
    const text = name && name.trim() ? name : "90 Surge";
    HEADLINE_SELECTORS.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => (el.textContent = text));
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
    if (cached?.showName) setHeadlineText(cached.showName || "90 Surge");
    try {
      const fresh = await fetchConfigFresh();
      if (
        !cached ||
        fresh.version !== cached.version ||
        fresh.showName !== cached.showName
      ) {
        writeCfgCache(fresh);
        setHeadlineText(fresh.showName || "90 Surge");
      }
    } catch (e) {
      console.debug("[config] headline refresh skipped:", e?.message || e);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Winner countdown (auto pick ≈ 2h30 after start) — pin once per round
  // ──────────────────────────────────────────────────────────────
  const WINNER_DELAY_MS = 2.5 * 60 * 60 * 1000;
  let __countdownTimer = null;
  let __ensurePickTimer = null;

  // In-memory config + pickAt (authoritative)
  let cfgMem = null;
  let pickAtMem = null;

  function parseStartMs(startTime) {
    if (!startTime) return NaN;
    let t = Date.parse(startTime);
    if (Number.isFinite(t)) return t;
    const m = String(startTime).trim().match(
      /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/
    );
    if (m) return new Date(`${m[1]}T${m[2]}`).getTime();
    return NaN;
  }

  const EFFECTIVE_START_KEY = "effectiveStartMs";
  const EFFECTIVE_VER_KEY = "effectiveStartVer";

  function clearEffectiveStartPin() {
    try {
      sessionStorage.removeItem(EFFECTIVE_START_KEY);
      sessionStorage.removeItem(EFFECTIVE_VER_KEY);
    } catch {}
  }

  // PIN **once per version**. On same version, never change the start.
  function getEffectiveStartMs(cfg) {
    const ver = String(cfg?.version ?? "nov");
    const cachedVer = sessionStorage.getItem(EFFECTIVE_VER_KEY);
    const pinnedRaw = sessionStorage.getItem(EFFECTIVE_START_KEY);
    let pinned = Number(pinnedRaw);
    if (cachedVer === ver && Number.isFinite(pinned)) return pinned;

    const serverMs = parseStartMs(cfg?.startTime);
    const clientMs = getRoundStartOverride();
    const startMs = Number.isFinite(serverMs)
      ? serverMs
      : Number.isFinite(clientMs)
      ? clientMs
      : Date.now();
    try {
      sessionStorage.setItem(EFFECTIVE_START_KEY, String(startMs));
      sessionStorage.setItem(EFFECTIVE_VER_KEY, ver);
    } catch {}
    return startMs;
  }

  function computePickAtFromCfg(cfg) {
    const startMs = getEffectiveStartMs(cfg);
    return startMs ? startMs + WINNER_DELAY_MS : null;
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
    document
      .querySelectorAll(
        "#winner-countdown, [data-winner-countdown], #winner-countdown-text"
      )
      .forEach((el) => {
        el.style.display = visible ? "" : "none";
      });
  }

  function stopWinnerCountdownTimers() {
    if (__countdownTimer) {
      clearInterval(__countdownTimer);
      __countdownTimer = null;
    }
    if (__ensurePickTimer) {
      clearInterval(__ensurePickTimer);
      __ensurePickTimer = null;
    }
  }

  async function triggerAutoPick() {
    try {
      await fetch("/api/admin?action=maybe-auto-pick", {
        method: "POST",
        keepalive: true,
      });
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

  async function verifyAndMaybeAutoPick() {
    await refreshConfigAuthoritative();
    if (!Number.isFinite(pickAtMem)) {
      const el =
        document.getElementById("winner-countdown-text") ||
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
    const guardKey =
      cfgMem?.version ?? `ts:${Math.floor(pickAtMem / 60000)}`;
    if (!autoPickGuard.has(guardKey)) {
      autoPickGuard.add(guardKey);
      await triggerAutoPick();
    }
    stopWinnerCountdownTimers();
  }

  async function startWinnerCountdown(forceRefresh = false) {
    const textEl =
      document.getElementById("winner-countdown-text") ||
      document.querySelector("[data-winner-countdown]") ||
      document.getElementById("winner-countdown");
    if (!textEl) return;

    stopWinnerCountdownTimers();

    if (forceRefresh || !cfgMem) {
      await refreshConfigAuthoritative();
    } else if (!Number.isFinite(pickAtMem)) {
      pickAtMem = computePickAtFromCfg(cfgMem || {});
    }

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
      const nowPickAt = pickAtMem;
      const diff = nowPickAt - Date.now();
      if (diff <= 0) {
        write("Picking...");
        stopWinnerCountdownTimers();
        await verifyAndMaybeAutoPick();
        return;
      }
      const sec = Math.floor(diff / 1000);
      const d = Math.floor(sec / 86400);
      const h = Math.floor((sec % 86400) / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      write(
        d > 0
          ? `${d}d ${h}h ${m}m ${s}s`
          : h > 0
          ? `${h}h ${m}m ${s}s`
          : `${m}m ${s}s`
      );
    };

    await tick();
    __countdownTimer = setInterval(tick, 1000);

    __ensurePickTimer = setInterval(async () => {
      if (Date.now() >= pickAtMem) {
        stopWinnerCountdownTimers();
        await verifyAndMaybeAutoPick();
      }
    }, 30000);
  }

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
      setCountdownVisible(true);
      startWinnerCountdown(true);
      return;
    }

    stopWinnerCountdownTimers();
    setCountdownVisible(false);
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
        const r = await fetch(`/api/admin?action=winner&_=${Date.now()}`, {
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
            clearEffectiveStartPin();
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
            clearEffectiveStartPin();
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
  async function boot() {
    initNamePersistence();
    ensureEntryStatsUI();
    wireFollowButtons();

    refreshFollowers();
    setInterval(refreshFollowers, 60_000);

    await refreshConfigAuthoritative();

    setCountdownVisible(true);

    initWinnerRealtime();

    refreshEntryStats();
    setInterval(refreshEntryStats, 15_000);

    // headline init/refresh
    initConfigHeadline();

    // countdown init/refresh
    startWinnerCountdown(false);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        initConfigHeadline(true);
        startWinnerCountdown(true);
      }
    });

    // periodic refresh so countdown adopts server changes (but keeps the same pin)
    setInterval(() => startWinnerCountdown(true), 10_000);

    // winner modal + banner default
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
      .then(maybeDisplayWinner)
      .catch(() => {});
    observeJackpotMessage();
    initSlot();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => boot(), { once: true });
  } else {
    boot();
  }
})();
