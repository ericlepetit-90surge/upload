// /public/slot.js
(function () {
  // ---------- Config ----------
  const REELS = 3;
  const ITEM_H = 58;          // nominal; we still measure at runtime
  const STRIP_MIN = 32;       // base strip length (unique sequence)
  const STRIP_REPEAT = 40;    // big buffer for smooth spins
  const MAX_SPINS = 5;        // per-day

  // Weighted symbols (no empties)
  const SYMBOLS = [
    { label: "T-Shirt",     weight: 0.05 },
    { label: "Sticker",     weight: 0.5  },
    { label: "Extra entry", weight: 0.6  },
    { label: "VIP Seat",    weight: 0.3  },
  ];

  // % of spins that bias toward an aligned jackpot (all 3 the same)
  const CHANCE_ALIGN = 0.18;

  // Jackpot instructions (UI copy)
  const JACKPOT_TEXT = {
    "T-Shirt":     "WOW, Come see us at the break or after the show to get your t-shirt!",
    "Free Drink":  "This one is on us — show it to the bartender!",
    "Sticker":     "FInd the box and help yourself!",
    "Extra entry": "Awesome—+1 raffle entry added!",
    "VIP Seat":    "Come closer to the stage! Now you're a VIP! :)",
  };

  // ---------- Utils ----------
  const dayKey   = () => new Date().toISOString().slice(0, 10);
  const spinsKey = () => `slot:spinsLeft:${dayKey()}`;

  function loadSpinsLeft() {
    const n = parseInt(localStorage.getItem(spinsKey()) ?? "", 10);
    if (Number.isFinite(n) && n >= 0 && n <= MAX_SPINS) return n;
    localStorage.setItem(spinsKey(), String(MAX_SPINS));
    return MAX_SPINS;
  }
  function saveSpinsLeft(n) {
    localStorage.setItem(spinsKey(), String(Math.max(0, Math.min(MAX_SPINS, n))));
  }

  function pickWeighted(arr) {
    const total = arr.reduce((s, x) => s + x.weight, 0);
    let r = Math.random() * total;
    for (const x of arr) { r -= x.weight; if (r <= 0) return x.label; }
    return arr[arr.length - 1].label;
  }

  function makeStrip(symbols, minLen = STRIP_MIN) {
    const labels = [];
    while (labels.length < minLen) {
      const next = pickWeighted(symbols);
      if (!labels.length || labels[labels.length - 1] !== next) labels.push(next);
    }
    // ensure wrap-around isn’t identical
    if (labels[0] === labels[labels.length - 1]) {
      const alt = symbols.find((s) => s.label !== labels[0])?.label || labels[0];
      labels[labels.length - 1] = alt;
    }
    return labels;
  }

  // Ask server if spins were reset by admin; if so, reset today’s local spins
  async function maybeApplyServerSpinReset(maxSpins) {
    try {
      const res = await fetch("/api/admin?action=slot-spins-version", { cache: "no-store" });
      const j = await res.json().catch(() => ({ version: 0 }));
      const serverV = Number(j?.version || 0);
      const localKey = "slot:spinsResetVersionSeen";
      const seenV = Number(localStorage.getItem(localKey) || "0");
      if (serverV > seenV) {
        const todayKey = new Date().toISOString().slice(0, 10);
        localStorage.setItem(`slot:spinsLeft:${todayKey}`, String(maxSpins));
        localStorage.setItem(localKey, String(serverV));
      }
    } catch {}
  }

  // Render helper: split multi-word labels into two lines
  function twoLineLabel(s) {
    const txt = String(s || "").trim();
    if (!txt.includes(" ")) return txt;               // single word → unchanged
    const parts = txt.split(/\s+/);
    if (parts.length === 2) return parts.join("\n");  // exactly two words
    // 3+ words → balance best we can
    const mid = Math.ceil(parts.length / 2);
    return parts.slice(0, mid).join(" ") + "\n" + parts.slice(mid).join(" ");
  }

  // Read display name consistently (input or localStorage fallback)
  function getDisplayName() {
    return (
      document.querySelector('#user-display-name')?.value ||
      localStorage.getItem('raffle_display_name') ||
      ''
    ).trim().slice(0, 80);
  }

  // Log any jackpot (for the admin Winners Ledger) – fire-and-forget
  async function logJackpot(name, targets) {
    try {
      await fetch('/api/admin?action=prize-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, targets, jackpot: true })
      });
    } catch {}
  }

  // ---------- Server extra entry (only for JACKPOT "Extra entry") ----------
  async function awardExtraEntry(name) {
    try {
      const res = await fetch("/api/admin?action=bonus-entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) return { awarded: false, already: false };
      return { awarded: true, already: false };
    } catch {
      return { awarded: false, already: false };
    }
  }

  // ---------- Binder (bind to static markup) ----------
  function bindMachine(root) {
    const reels  = Array.from(root.querySelectorAll(".slot-reel"));
    const btn    = root.querySelector("#slot-spin-btn");
    const left   = root.querySelector("#slot-spins-left");
    const result = root.querySelector("#slot-result");

    if (reels.length !== REELS) {
      console.error(`[slot] expected ${REELS} .slot-reel elements inside #slot-root`);
      return null;
    }
    if (!btn || !left || !result) {
      console.error("[slot] missing required elements (#slot-spin-btn, #slot-spins-left, #slot-result)");
      return null;
    }
    return { reels, btn, left, result };
  }

  function fillReel(reelEl, strip) {
    reelEl.innerHTML = "";
    for (const label of strip) {
      const cell = document.createElement("div");
      cell.className = "slot-cell";
      // show multi-word labels on 2 lines
      cell.style.whiteSpace = "pre-line";
      cell.textContent = twoLineLabel(label);
      reelEl.appendChild(cell);
    }
  }

  // Measure actual cell height after paint
  function measureCellHeight(reels) {
    const firstCell = reels[0]?.querySelector(".slot-cell");
    if (!firstCell) return ITEM_H;
    const h = firstCell.getBoundingClientRect().height;
    const dpr = window.devicePixelRatio || 1;
    return Math.round(h * dpr) / dpr || ITEM_H;
  }

  // ---------- Spin engine ----------
  function initSlotMachine(rootSelector = "#slot-root", opts = {}) {
    const root = document.querySelector(rootSelector);
    if (!root) { console.warn("initSlotMachine: mount point not found:", rootSelector); return; }

    // If already bound, just swap callbacks and return existing API
    if (root.__slotApi) {
      root.__slotApi.setCallbacks(opts);
      return root.__slotApi;
    }

    const bound = bindMachine(root);
    if (!bound) return;
    const { reels, btn, result, left } = bound;

    const baseStrip = makeStrip(SYMBOLS, STRIP_MIN);
    const len = baseStrip.length;

    // Build a very long strip so our target index always exists
    const strip = Array.from({ length: STRIP_REPEAT }, () => baseStrip).flat();
    reels.forEach((el) => fillReel(el, strip));

    // measure actual cell height after DOM paints (includes two-line height)
    let CELL_H = measureCellHeight(reels);

    // Track absolute index per reel (which cell is aligned at the top)
    const state = reels.map(() => ({ absIndex: 0 }));

    function setTransformToIndex(reelEl, index) {
      const targetCell = reelEl.children[index];
      const px = targetCell ? targetCell.offsetTop : index * CELL_H;
      reelEl.style.transform = `translate3d(0, ${-px}px, 0)`;
    }

    // spins left UI
    function renderSpinsLeft(n) {
      left.textContent = `Spins left: ${n}`;
      btn.disabled = n <= 0;
    }

    // Initial sync with server reset flag, then render
    maybeApplyServerSpinReset(MAX_SPINS).finally(() => {
      renderSpinsLeft(loadSpinsLeft());
    });

    // Keep in sync if admin resets while tab is open (focus/visibility/storage)
    function syncSpinsFromServer() {
      maybeApplyServerSpinReset(MAX_SPINS).finally(() => {
        renderSpinsLeft(loadSpinsLeft());
      });
    }
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) syncSpinsFromServer();
    });
    window.addEventListener("focus", syncSpinsFromServer);
    window.addEventListener("storage", (e) => {
      // another tab changed today's spins
      if (e.key && e.key.endsWith(spinsKey())) {
        renderSpinsLeft(loadSpinsLeft());
      }
    });

    // Hold BOTH callbacks; call them without double-invoking if they’re identical
    let onResultCb = null, onFinishCb = null;
    function setCallbacks(o) {
      onResultCb = typeof o?.onResult === "function" ? o.onResult : null;
      onFinishCb = typeof o?.onFinish === "function" ? o.onFinish : null;
    }
    setCallbacks(opts);

    function spinOnce() {
      const spinsLeft = loadSpinsLeft();
      if (spinsLeft <= 0 || btn.disabled) return;

      btn.disabled = true;
      result.textContent = ""; // clear only at start of a spin

      // Bias toward jackpots; does not *force* detection
      const forceAlign = Math.random() < CHANCE_ALIGN;
      const forcedLabel = forceAlign ? pickWeighted(SYMBOLS) : null;

      // choose targets
      const targets = Array.from({ length: REELS }, () =>
        forceAlign ? forcedLabel : pickWeighted(SYMBOLS)
      );

      // map each target to a base index in baseStrip
      const targetIdxs = targets.map((t) => {
        const idx = baseStrip.indexOf(t);
        return idx < 0 ? 0 : idx;
      });

      // staggered loops/durations (in base-strip rows)
      const SPINS = [len * 5, len * 6, len * 7];
      const DUR   = [1000, 1300, 1600];

      reels.forEach((reelEl, i) => {
        const st = state[i];
        const currentMod = st.absIndex % len;
        const deltaToTarget = (targetIdxs[i] - currentMod + len) % len;
        const travel = SPINS[i] + deltaToTarget;
        const finalIndex = st.absIndex + travel;

        reelEl.style.transition = `transform ${DUR[i]}ms cubic-bezier(.16,.84,.44,1)`;
        const safeIndex = Math.min(finalIndex, strip.length - 1);
        requestAnimationFrame(() => setTransformToIndex(reelEl, safeIndex));
        st.absIndex = finalIndex;
      });

      const settleMs = Math.max(...DUR) + 60;

      setTimeout(async () => {
        // Normalize back into the first base block so we never reach strip end
        reels.forEach((reelEl, i) => {
          const st = state[i];
          st.absIndex = st.absIndex % len; // keep equivalent position
          reelEl.style.transition = "none";
          setTransformToIndex(reelEl, st.absIndex); // snap to normalized cell
        });

        // decrement spins AFTER a completed spin
        const newLeft = loadSpinsLeft() - 1;
        saveSpinsLeft(newLeft);
        renderSpinsLeft(newLeft);

        // ✅ Real jackpot detection: actual reel equality (not the bias flag)
        const isJackpot = targets.length >= 3 && targets.every(t => t === targets[0]);

        // Build UI message + side effects
        let uiMsg = "";
        if (isJackpot) {
          const label = targets[0];
          const name = getDisplayName() || "(anonymous)";

          // Always log jackpots to the Winners Ledger
          logJackpot(name, targets);

          if (/extra\s*entry/i.test(label)) {
            if (!getDisplayName()) {
              uiMsg = 'Enter your name above to claim your extra raffle entry!';
            } else {
              const { awarded } = await awardExtraEntry(getDisplayName());
              uiMsg = awarded
                ? JACKPOT_TEXT["Extra entry"]
                : '(Could not record, please try again.)';
            }
          } else {
            const extra = JACKPOT_TEXT[label] || '';
            uiMsg = extra ? `${label} — ${extra}` : label;
          }
          result.textContent = uiMsg;
        } else {
          result.textContent = ""; // keep blank for non-jackpot
        }

        btn.disabled = loadSpinsLeft() <= 0;

        // Prepare rich payload for callbacks + event listeners
        const payload = {
          targets,                           // ["Sticker","Sticker","Sticker"]
          prize: isJackpot ? targets[0] : null,
          jackpot: isJackpot,
          win: isJackpot,                    // legacy field
          text: uiMsg,                       // what we wrote to the UI
          align: isJackpot,                  // legacy alias used by older code
          time: Date.now()
        };

        // Callbacks (avoid double-calling the same function)
        if (onResultCb)  { try { onResultCb(payload); }  catch (e) { console.warn("slot onResult error:", e); } }
        if (onFinishCb && onFinishCb !== onResultCb) {
          try { onFinishCb(payload); } catch (e) { console.warn("slot onFinish error:", e); }
        }

        // Broadcast for console/debug tools
        try {
          window.dispatchEvent(new CustomEvent("slot:result", { detail: payload }));
        } catch {}

      }, settleMs);
    }

    // Wire button
    btn.addEventListener("click", spinOnce);

    // Public API (allow late-binding of callbacks without reinit)
    const api = {
      spin: spinOnce,
      setCallbacks
    };
    Object.defineProperty(root, "__slotApi", { value: api, enumerable: false });
    return api;
  }

  window.initSlotMachine = initSlotMachine;

  // Optional helper for late-binding callback without re-initting
  window.__slotSetCallback = (opts) => {
    const root = document.querySelector("#slot-root");
    if (root && root.__slotApi) root.__slotApi.setCallbacks(opts || {});
  };
})();
