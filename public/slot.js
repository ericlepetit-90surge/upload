// /public/slot.js
(function () {
  // ---------- Config ----------
  const REELS = 3;

  // Ensure we never run out of cells during the animation
  const STRIP_LEN    = 24;  // unique sequence length
  const STRIP_REPEAT = 8;   // 24 * 8 = 192 cells per reel

  const MAX_SPINS = 5;      // per-day

  // Symbols: only "-" and "Extra Entry"
  const SYMBOL_EXTRA = "Extra Entry";
  const SYMBOL_NONE  = "-";

  // Per-reel random probability of Extra Entry (when not forcing a jackpot)
  const WEIGHT_EXTRA = 0.12;  // 12% per reel
  const WEIGHT_NONE  = 1 - WEIGHT_EXTRA;

  // Independent forced jackpot rate (all three = Extra Entry)
  const JACKPOT_RATE = 0.15; // ~3.5%

  const JACKPOT_TEXT = "Awesome—+1 raffle entry added!";

  // Spin travel (must stay well under STRIP_LEN * STRIP_REPEAT)
  const BASE_LOOPS = [3, 4, 5]; // full base-strip loops per reel
  const EXTRA_ROWS = [3, 5, 7]; // small offsets for staggered stops
  const DUR        = [1000, 1300, 1600];

  // ---------- Utils ----------
  const todayKey = () => new Date().toISOString().slice(0, 10);
  const spinsKey = () => `slot:spinsLeft:${todayKey()}`;

  function loadSpinsLeft() {
    const n = parseInt(localStorage.getItem(spinsKey()) ?? "", 10);
    if (Number.isFinite(n) && n >= 0 && n <= MAX_SPINS) return n;
    localStorage.setItem(spinsKey(), String(MAX_SPINS));
    return MAX_SPINS;
  }
  function saveSpinsLeft(n) { localStorage.setItem(spinsKey(), String(Math.max(0, Math.min(MAX_SPINS, n)))); }

  async function maybeApplyServerSpinReset(max) {
    try {
      const r = await fetch("/api/admin?action=slot-spins-version", { cache: "no-store" });
      const j = await r.json().catch(() => ({ version: 0 }));
      const serverV = Number(j?.version || 0);
      const localK  = "slot:spinsResetVersionSeen";
      const seenV   = Number(localStorage.getItem(localK) || "0");
      if (serverV > seenV) {
        localStorage.setItem(spinsKey(), String(max));
        localStorage.setItem(localK, String(serverV));
      }
    } catch {}
  }

  function twoLineLabel(s) {
    const parts = String(s || "").trim().split(/\s+/);
    if (parts.length <= 1) return s;
    const mid = Math.ceil(parts.length / 2);
    return parts.slice(0, mid).join(" ") + "\n" + parts.slice(mid).join(" ");
  }

  function getDisplayName() {
    return (
      document.querySelector('#user-display-name')?.value ||
      localStorage.getItem('raffle_display_name') ||
      ''
    ).trim().slice(0, 80);
  }

  function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((e || "").trim()); }
  function getEmail() {
    return (
      document.querySelector('#user-email')?.value ||
      localStorage.getItem('raffle_email') ||
      ''
    ).trim().toLowerCase();
  }

  // 🔐 Winners ledger: log EMAIL (no name)
  async function logJackpot(email, targets) {
    try {
      await fetch('/api/admin?action=prize-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: (email || ""), targets, jackpot: true })
      });
    } catch {}
  }

  // POST name + email so backend can credit the right person + totals
 async function awardExtraEntry(email) {
  try {
    const base =
      (typeof window !== "undefined" && typeof window.API_BASE === "string" && window.API_BASE) || "";

    // simple validation — avoids useless requests
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((email || "").trim());
    if (!ok) return { awarded: false, reason: "invalid_email" };

    const res = await fetch(`${base}/api/admin?action=bonus-entry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ email }),
    });

    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.success) {
      return { awarded: false, reason: j?.error || `status_${res.status}` };
    }
    return { awarded: true, entry: j?.entry || null };
  } catch (e) {
    return { awarded: false, reason: "network_error" };
  }
}


  // After awarding, pull fresh counts and update the UI
  async function refreshEntryStatsUI() {
    try {
      const r = await fetch(`/api/admin?action=my-entries&_=${Date.now()}`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      const mine  = Number(j?.mine ?? NaN);
      const total = Number(j?.total ?? NaN);
      const yourEl  = document.getElementById('your-entries-count') || document.getElementById('raffle-entries');
      const totalEl = document.getElementById('total-entries-count');
      if (yourEl  && Number.isFinite(mine))  yourEl.textContent  = mine.toLocaleString();
      if (totalEl && Number.isFinite(total)) totalEl.textContent = total.toLocaleString();
      try { window.dispatchEvent(new CustomEvent('raffle:entries:updated', { detail: j })); } catch {}
    } catch {}
  }

  // ---------- DOM helpers ----------
  function bindMachine(root) {
    const reels  = Array.from(root.querySelectorAll(".slot-reel"));
    const btn    = root.querySelector("#slot-spin-btn");
    const left   = root.querySelector("#slot-spins-left");
    const result = root.querySelector("#slot-result");
    if (reels.length !== REELS || !btn || !left || !result) return null;
    reels.forEach(el => { el.style.willChange = "transform"; }); // GPU hint
    return { reels, btn, left, result };
  }

  function buildBaseStrip(len) {
    const out = [];
    for (let i = 0; i < len; i++) {
      const prev = out[out.length - 1];
      let pick = (Math.random() < WEIGHT_EXTRA) ? SYMBOL_EXTRA : SYMBOL_NONE;
      if (prev && prev === pick && Math.random() < 0.45) {
        pick = (pick === SYMBOL_EXTRA) ? SYMBOL_NONE : SYMBOL_EXTRA;
      }
      out.push(pick);
    }
    if (!out.includes(SYMBOL_EXTRA)) {
      out[Math.floor(Math.random() * out.length)] = SYMBOL_EXTRA;
    }
    if (out[0] === out[out.length - 1]) {
      out[out.length - 1] = (out[0] === SYMBOL_EXTRA) ? SYMBOL_NONE : SYMBOL_EXTRA;
    }
    return out;
  }

  function repeatStrip(base, times) { return Array.from({ length: times }, () => base).flat(); }

  function fillReel(reelEl, strip) {
    reelEl.innerHTML = "";
    for (const label of strip) {
      const cell = document.createElement("div");
      cell.className = "slot-cell";
      cell.style.whiteSpace = "pre-line";
      cell.textContent = twoLineLabel(label);
      reelEl.appendChild(cell);
    }
  }

  function translateToIndex(reelEl, index) {
    const idx = Math.max(0, Math.min(index, reelEl.children.length - 1));
    const cell = reelEl.children[idx];
    const y = cell ? cell.offsetTop : 0;
    reelEl.style.transform = `translate3d(0, ${-y}px, 0)`;
  }

  function nextIndexForSymbol(baseStrip, startModIndex, symbol) {
    const len = baseStrip.length;
    for (let step = 1; step <= len; step++) {
      const idx = (startModIndex + step) % len;
      if (baseStrip[idx] === symbol) return idx;
    }
    return (startModIndex + 1) % len;
  }

  // ---------- Engine ----------
  function initSlotMachine(rootSelector = "#slot-root", opts = {}) {
    const root = document.querySelector(rootSelector);
    if (!root) { console.warn("initSlotMachine: mount point not found:", rootSelector); return; }
    if (root.__slotApi) { root.__slotApi.setCallbacks(opts); return root.__slotApi; }

    const bound = bindMachine(root);
    if (!bound) { console.warn("[slot] required elements missing"); return; }
    const { reels, btn, result, left } = bound;

    const baseStrip = buildBaseStrip(STRIP_LEN);
    const strip     = repeatStrip(baseStrip, STRIP_REPEAT);
    const len       = baseStrip.length;

    reels.forEach((el) => fillReel(el, strip));

    const state = reels.map(() => ({ absIndex: 0 }));

    function renderSpinsLeft(n) {
      left.textContent = `Spins left: ${n}`;
      btn.disabled = n <= 0;
    }

    maybeApplyServerSpinReset(MAX_SPINS).finally(() => renderSpinsLeft(loadSpinsLeft()));
    const totalCells = len * STRIP_REPEAT;

    function syncSpins() { maybeApplyServerSpinReset(MAX_SPINS).finally(() => renderSpinsLeft(loadSpinsLeft())); }
    document.addEventListener("visibilitychange", () => { if (!document.hidden) syncSpins(); });
    window.addEventListener("focus", syncSpins);
    window.addEventListener("storage", (e) => {
      if (e && e.key && e.key === spinsKey()) renderSpinsLeft(loadSpinsLeft());
    });

    let onResultCb = null, onFinishCb = null;
    function setCallbacks(o) {
      onResultCb = typeof o?.onResult === "function" ? o.onResult : null;
      onFinishCb = typeof o?.onFinish === "function" ? o.onFinish : null;
    }
    setCallbacks(opts);

    function weightedPick() { return Math.random() < WEIGHT_EXTRA ? SYMBOL_EXTRA : SYMBOL_NONE; }

    function spinOnce() {
      const spinsLeft = loadSpinsLeft();
      if (spinsLeft <= 0 || btn.disabled) return;

      btn.disabled = true;
      result.textContent = "";

      const forceJackpot = Math.random() < JACKPOT_RATE;
      const targets = forceJackpot
        ? [SYMBOL_EXTRA, SYMBOL_EXTRA, SYMBOL_EXTRA]
        : [weightedPick(), weightedPick(), weightedPick()];

      reels.forEach((reelEl, i) => {
        const st = state[i];
        const currentMod = st.absIndex % len;
        const targetMod  = nextIndexForSymbol(baseStrip, currentMod, targets[i]);

        const deltaToTarget = (targetMod - currentMod + len) % len;
        const travelRows = BASE_LOOPS[i] * len + deltaToTarget;

        const finalAbsIndex = (st.absIndex + travelRows) % totalCells;

        reelEl.style.transition = `transform ${DUR[i]}ms cubic-bezier(.16,.84,.44,1)`;
        requestAnimationFrame(() => translateToIndex(reelEl, finalAbsIndex));
        st.absIndex = finalAbsIndex;
      });

      const settleMs = Math.max(...DUR) + 60;

      setTimeout(async () => {
        reels.forEach((reelEl, i) => {
          reelEl.style.transition = "none";
          translateToIndex(reelEl, state[i].absIndex);
        });

        const newLeft = loadSpinsLeft() - 1;
        saveSpinsLeft(newLeft);
        renderSpinsLeft(newLeft);

        // Visible symbols at stop
        const mods = state.map(s => (s.absIndex % len));
        const finalSymbols = mods.map(m => baseStrip[m]);
        const isJackpot = finalSymbols.every(s => s === SYMBOL_EXTRA);

        let uiMsg = "";
        if (isJackpot) {
          const email = getEmail();

          // Winners ledger: log EMAIL only
          logJackpot(email, [SYMBOL_EXTRA, SYMBOL_EXTRA, SYMBOL_EXTRA]);

          if (!isValidEmail(email)) {
            uiMsg = 'Enter your email above to claim your extra raffle entry!';
          } else {
            const { awarded } = await awardExtraEntry(email);
            uiMsg = awarded ? JACKPOT_TEXT : '(Could not record, please try again.)';
            setTimeout(() => { refreshEntryStatsUI(); }, 150);
          }
          result.textContent = uiMsg;
        } else {
          result.textContent = "";
        }

        btn.disabled = loadSpinsLeft() <= 0;

        const payload = {
          targets: finalSymbols.slice(),
          prize: isJackpot ? SYMBOL_EXTRA : null,
          jackpot: isJackpot,
          win: isJackpot,
          text: uiMsg,
          align: isJackpot,
          time: Date.now()
        };

        if (onResultCb)  { try { onResultCb(payload); }  catch(e){ console.warn("slot onResult error:", e); } }
        if (onFinishCb && onFinishCb !== onResultCb) {
          try { onFinishCb(payload); } catch(e){ console.warn("slot onFinish error:", e); }
        }
        try { window.dispatchEvent(new CustomEvent("slot:result", { detail: payload })); } catch {}

      }, settleMs);
    }

    btn.addEventListener("click", spinOnce);

    const api = { spin: spinOnce, setCallbacks };
    Object.defineProperty(root, "__slotApi", { value: api, enumerable: false });
    return api;
  }

  window.initSlotMachine = initSlotMachine;
  window.__slotSetCallback = (opts) => {
    const root = document.querySelector("#slot-root");
    if (root && root.__slotApi) root.__slotApi.setCallbacks(opts || {});
  };
})();
