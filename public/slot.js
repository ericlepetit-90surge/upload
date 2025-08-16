// /public/slot.js
(function () {
  // ---------- Config ----------
  const REELS = 3;
  const ITEM_H = 58;     // must match CSS we inject
  const REPEAT = 12;     // how many times we repeat the base strip in the DOM (tall reel)
  const REEL_W = 120;
  const REEL_GAP = 12;

  // Weighted symbols (no empties)
  const SYMBOLS = [
    { label: "T-Shirt",        weight: 0.5 },
    { label: "Free Drink",     weight: 0.5 },
    { label: "Sticker",        weight: 3 },
    { label: "Sing a song",    weight: 1 },
    { label: "Extra raffle entry", weight: 2}
    //{ label: "VIP Seat",       weight: 1 },
  ];

  // % of spins that force all three to align (so you don’t always win)
  const CHANCE_ALIGN = 0.28;

  // ---------- Utils ----------
  function pickWeighted(arr) {
    const total = arr.reduce((s, x) => s + x.weight, 0);
    let r = Math.random() * total;
    for (const x of arr) {
      r -= x.weight;
      if (r <= 0) return x.label;
    }
    return arr[arr.length - 1].label;
  }

  function ensureStyles() {
    if (document.getElementById("slot-css")) return;
    const css = `
    :root{
      --reel-w:${REEL_W}px; --reel-gap:${REEL_GAP}px; --item-h:${ITEM_H}px;
      --accent:#e91e63; --bg:#0f0f12; --card:#17181c; --text:#eef2ff; --muted:#a3a7b3; --good:#10b981;
    }
    .slot-card{ width:min(440px,96vw); background:var(--card); border:1px solid rgba(255,255,255,.08);
      border-radius:14px; padding:18px; margin:16px auto; color:var(--text); box-shadow:0 8px 18px rgba(0,0,0,.25);}
    .slot-title{ margin:0 0 .5rem 0; text-align:center; }
    .slot-machine{ display:flex; justify-content:center; gap:var(--reel-gap); padding:12px; background:#0c0d11;
      border:1px solid rgba(255,255,255,.06); border-radius:12px; position:relative; }
    .slot-window{ width:var(--reel-w); height:var(--item-h); overflow:hidden; border-radius:10px; background:#0a0b0f;
      border:1px solid rgba(255,255,255,.06); position:relative; }
    .slot-reel{ will-change: transform; transform: translateY(0); }
    .slot-cell{ height:var(--item-h); display:grid; place-items:center; border-bottom:1px solid rgba(255,255,255,.05);
      color:var(--text); font-weight:800; letter-spacing:.2px; padding:0 10px; white-space:nowrap; text-overflow:ellipsis; overflow:hidden; text-align:center; }
    .slot-cell:last-child{ border-bottom:0; }
    .slot-controls{ display:flex; justify-content:center; gap:10px; margin-top:14px; }
    .slot-spin{ padding:12px 18px; border:0; border-radius:10px; background:var(--accent); color:#fff; font-weight:900;
      cursor:pointer; box-shadow:0 6px 16px rgba(233,30,99,.35); }
    .slot-spin[disabled]{ opacity:.6; cursor:not-allowed; box-shadow:none; }
    .slot-result{ margin-top:12px; text-align:center; font-weight:900; color:var(--good); min-height:1.6em; }
    `;
    const style = document.createElement("style");
    style.id = "slot-css";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function makeStrip(symbols, minLen = 24) {
    // Build a base strip with no identical neighbors (no empties)
    const labels = [];
    while (labels.length < minLen) {
      const next = pickWeighted(symbols);
      if (!labels.length || labels[labels.length - 1] !== next) labels.push(next);
    }
    if (labels[0] === labels[labels.length - 1]) {
      const alt = symbols.find((s) => s.label !== labels[0])?.label || labels[0];
      labels[labels.length - 1] = alt;
    }
    return labels;
  }

  // ---------- Builder ----------
  function buildMachine(root) {
    ensureStyles();

    const card = document.createElement("div");
    card.className = "slot-card";

    const title = document.createElement("h2");
    title.className = "slot-title";
    title.textContent = "🎰 Slot to Win";
    card.appendChild(title);

    const machine = document.createElement("div");
    machine.className = "slot-machine";

    const reels = [];
    for (let i = 0; i < REELS; i++) {
      const w = document.createElement("div");
      w.className = "slot-window";
      const r = document.createElement("div");
      r.className = "slot-reel";
      r.id = `slot-reel-${i}`;
      w.appendChild(r);
      machine.appendChild(w);
      reels.push(r);
    }
    card.appendChild(machine);

    const controls = document.createElement("div");
    controls.className = "slot-controls";
    const btn = document.createElement("button");
    btn.id = "slot-spin-btn";
    btn.className = "slot-spin";
    btn.textContent = "Spin";
    controls.appendChild(btn);
    card.appendChild(controls);

    const result = document.createElement("div");
    result.id = "slot-result";
    result.className = "slot-result";
    card.appendChild(result);

    root.innerHTML = "";
    root.appendChild(card);

    return { reels, btn, result };
  }

  function fillReel(reelEl, strip) {
    reelEl.innerHTML = "";
    for (const label of strip) {
      const cell = document.createElement("div");
      cell.className = "slot-cell";
      cell.textContent = label;
      reelEl.appendChild(cell);
    }
  }

  function setReelTransform(reelEl, rows) {
    reelEl.style.transform = `translateY(${-rows * ITEM_H}px)`;
  }

  // ---------- Spin engine (with wrap-safe math) ----------
  function initSlotMachine(rootSelector = "#slot-root", opts = {}) {
    const root = document.querySelector(rootSelector);
    if (!root) {
      console.warn("initSlotMachine: mount point not found:", rootSelector);
      return;
    }

    const { reels, btn, result } = buildMachine(root);

    const baseStrip = makeStrip(SYMBOLS, 32);      // logical strip
    const len = baseStrip.length;
    const DOM_LEN = len * REPEAT;                  // rows in the DOM strip
    const BASE = len * Math.floor(REPEAT / 2);     // center offset (keeps us away from edges)

    // Build the tall DOM strip
    const tallStrip = Array.from({ length: REPEAT }, () => baseStrip).flat();
    reels.forEach((el) => fillReel(el, tallStrip));

    // Per-reel state: logical position 0..len-1 (NOT absolute DOM rows)
    const state = reels.map(() => ({ pos: 0 }));

    // Initialize transform to centered position
    reels.forEach((el, i) => {
      el.style.transition = "none";
      setReelTransform(el, BASE + state[i].pos);
    });

    function spinOnce() {
      if (btn.disabled) return;
      btn.disabled = true;
      result.textContent = "";

      // Decide targets (aligned or independent)
      const align = Math.random() < CHANCE_ALIGN;
      const chosen = align ? pickWeighted(SYMBOLS) : null;

      const targets = Array.from({ length: REELS }, (_, i) =>
        align ? chosen : pickWeighted(SYMBOLS)
      );

      // Find target indices in the base strip
      const targetIdxs = targets.map((t) => {
        let idx = baseStrip.findIndex((x) => x === t);
        if (idx < 0) idx = 0;
        return idx;
      });

      // Spin parameters (safe within REPEAT window)
      const LOOPS = [3, 4, 5];                 // number of full strip loops per reel
      const DUR   = [1000, 1300, 1600];        // stagger durations

      reels.forEach((reelEl, i) => {
        const st = state[i];
        // Current DOM row we’re sitting at (center band + logical pos)
        const currentDom = BASE + (st.pos % len + len) % len;

        // Distance to target index on base strip
        const delta = (targetIdxs[i] - st.pos + len) % len;

        // Final DOM row: many loops + delta, still safely below DOM_LEN
        const finalDom = currentDom + LOOPS[i] * len + delta;

        // Animate to finalDom
        reelEl.style.transition = `transform ${DUR[i]}ms cubic-bezier(.16,.84,.44,1)`;
        requestAnimationFrame(() => setReelTransform(reelEl, finalDom));

        // Save new logical position
        st.pos = targetIdxs[i];
      });

      // When the last reel finishes…
      const doneIn = Math.max(...[1000, 1300, 1600]) + 30;
      setTimeout(() => {
        // Snap back to the middle band at same logical position (no visual jump)
        reels.forEach((reelEl, i) => {
          reelEl.style.transition = "none";
          setReelTransform(reelEl, BASE + state[i].pos);
        });

        const win = targets.every((t) => t === targets[0]); // only win if all match
        result.textContent = win ? `🎉 JACKPOT! ${targets[0]} 🎉 Take a screenshot and show it to us during the break of after the show` : "";

        if (typeof opts.onResult === "function") {
          opts.onResult({ targets, win });
        }
        btn.disabled = false;
      }, doneIn);
    }

    // Hook up button
    document.getElementById("slot-spin-btn").addEventListener("click", spinOnce);

    // Optional API
    return { spin: spinOnce };
  }

  // Expose globally
  window.initSlotMachine = initSlotMachine;
})();
