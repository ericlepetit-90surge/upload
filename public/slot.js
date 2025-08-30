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
    { label: "T-Shirt",     weight: 0.15 },
   // { label: "Free Drink",  weight: 0.8 },
    { label: "Sticker",     weight: 1 },
    { label: "Extra entry", weight: 0.5 },
    { label: "VIP Seat",    weight: 1 },
  ];

  // % of spins that force an aligned jackpot (all 3 the same)
  const CHANCE_ALIGN = 0.28;

  // Jackpot instructions
  const JACKPOT_TEXT = {
    "T-Shirt":     "WOW, Come see us at the break or after the show to get your t-shirt!",
    "Free Drink":  "This one is on us — show it to the bartender!",
    "Sticker":     "FInd the box and help yourself!",
    "Extra entry": "Awesome, you got yourself an extra raffle entry to win a 90 Surge t-shirt!",
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
    } catch (e) {}
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

  // ---------- Server extra entry (only for JACKPOT "Extra entry") ----------
  async function awardExtraEntry(name) {
    try {
      const res = await fetch("/api/admin?action=enter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, source: "jackpot" }),
      });
      if (!res.ok) return { awarded: false, already: false };
      const json = await res.json().catch(() => ({}));
      if (json.already) return { awarded: false, already: true };
      return { awarded: true, already: false };
    } catch (e) {
      return { awarded: false, already: false };
    }
  }

  // ---------- Spin engine ----------
  function initSlotMachine(rootSelector = "#slot-root", opts = {}) {
    const root = document.querySelector(rootSelector);
    if (!root) { console.warn("initSlotMachine: mount point not found:", rootSelector); return; }

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

    function spinOnce() {
      const spinsLeft = loadSpinsLeft();
      if (spinsLeft <= 0 || btn.disabled) return;

      btn.disabled = true;
      result.textContent = ""; // clear only at start of a spin

      // This coin flip only biases toward jackpots; it no longer *defines* a win.
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
        // Jackpot if all reels show the same symbol, regardless of how we got there
        const isJackpot = targets.length >= 3 && targets.every(t => t === targets[0]);
        

        if (isJackpot) {
          const label = targets[0];
          let msg = `🎉 JACKPOT! ${label}`;
          const extra = JACKPOT_TEXT[label] || "";

          if (label === "Extra entry") {
            const nameEl = document.querySelector("#user-display-name");
            const name = (nameEl?.value || "").trim();
            if (!name) {
              msg = `🎉 JACKPOT! Extra entry — Enter your name above to claim your extra raffle entry!`;
            } else {
              const { awarded, already } = await awardExtraEntry(name);
              if (awarded) {
                msg = `🎉 JACKPOT! Extra entry — ${JACKPOT_TEXT["Extra entry"]}`;
              } else if (already) {
                msg = `🎉 JACKPOT! Extra entry — Already counted for this device.`;
              } else {
                msg = `🎉 JACKPOT! Extra entry — (Could not record, please try again.)`;
              }
            }
          } else if (extra) {
            msg = `🎉 JACKPOT! ${label} — ${extra}`;
          }
          result.textContent = msg;
        } else {
          result.textContent = ""; // keep blank for non-jackpot
        }

        btn.disabled = loadSpinsLeft() <= 0;

        // Keep outer app.js logging behavior intact
        if (typeof opts.onResult === "function") {
          opts.onResult({ targets, win: isJackpot });
        }
      }, settleMs);
    }

    btn.addEventListener("click", spinOnce);
    return { spin: spinOnce };
  }

  window.initSlotMachine = initSlotMachine;
})();
