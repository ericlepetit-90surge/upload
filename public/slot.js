// /public/slot.js
(function () {
  // ---------- Config ----------
  const REELS = 3;
  const ITEM_H = 58;      // nominal; we still measure at runtime
  const REEL_W = 120;
  const REEL_GAP = 12;
  const STRIP_MIN = 32;   // base strip length (unique sequence)
  const STRIP_REPEAT = 40; // big buffer for smooth spins
  const MAX_SPINS = 5;    // per-day

  // Weighted symbols (no empties)
  const SYMBOLS = [
    { label: "T-Shirt",     weight: 0.5 },
    { label: "Free Drink",  weight: 0.8 },
    { label: "Sticker",     weight: 3 },
    { label: "Extra entry", weight: 1.5 },
    { label: "VIP Seat",    weight: 1 },
  ];

  // % of spins that force an aligned jackpot (all 3 the same)
  const CHANCE_ALIGN = 0.28;

  // Jackpot instructions
  const JACKPOT_TEXT = {
    "T-Shirt":    "WOW, well done! Take a screenshot and show it to us during the break or after the show to get your tee!",
    "Free Drink": "This one is on us — show it to the bartender!",
    "Sticker":    "Help yourself!",
    "Extra entry":"Awesome, you got an extra raffle entry to win a 90 Surge t-shirt!",
    "VIP Seat":   "Bah, you're already in a VIP section!",
  };

  // ---------- Utils ----------
  const dayKey = () => new Date().toISOString().slice(0,10);
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

  function ensureStyles() {
    const css = `
    :root{
      --reel-w:${REEL_W}px; --reel-gap:${REEL_GAP}px; --item-h:${ITEM_H}px;
      --accent:#e91e63; --bg:#0f0f12; --card:#17181c; --text:#eef2ff; --muted:#a3a7b3; --good:#10b981;
    }
    .slot-card{
      width:min(440px,96vw); background:var(--card);
      border:1px solid rgba(255,255,255,.08); border-radius:14px;
      padding:18px; margin:16px auto; color:var(--text); box-shadow:0 8px 18px rgba(0,0,0,.25);
      user-select:none;
    }
    .slot-title{ margin:0 0 .5rem 0; text-align:center; }
    .slot-machine{
      display:flex; justify-content:center; gap:var(--reel-gap);
      padding:12px; background:#0c0d11; border:1px solid rgba(255,255,255,.06);
      border-radius:12px; position:relative;
    }
    .slot-window{
      width:var(--reel-w); height:var(--item-h); overflow:hidden;
      border-radius:10px; background:#0a0b0f; border:1px solid rgba(255,255,255,.06);
      position:relative;
    }
    .slot-window::before, .slot-window::after{
      content:""; position:absolute; left:0; right:0; height:10px; pointer-events:none;
    }
    .slot-window::before{ top:0; background:linear-gradient(#0a0b0f,transparent); }
    .slot-window::after{ bottom:0; background:linear-gradient(transparent,#0a0b0f); }

    .slot-reel{ will-change:transform; transform:translate3d(0,0,0); }

    .slot-cell{
      height:var(--item-h); box-sizing:border-box;
      display:grid; place-items:center;
      color:var(--text); font-weight:800; letter-spacing:.2px; padding:0 10px;
      white-space:nowrap; text-overflow:ellipsis; overflow:hidden; text-align:center;
      box-shadow: inset 0 -1px rgba(255,255,255,.06);
    }
    .slot-cell:last-child{ box-shadow:none; }

    .slot-controls{ display:flex; justify-content:center; align-items:center; gap:10px; margin-top:14px; flex-wrap:wrap; }
    .slot-spin{
      padding:12px 18px; border:0; border-radius:10px;
      background:var(--accent); color:#fff; font-weight:900; cursor:pointer;
      box-shadow:0 6px 16px rgba(233,30,99,.35);
    }
    .slot-spin[disabled]{ opacity:.6; cursor:not-allowed; box-shadow:none; }
    .slot-left{ color:var(--muted); font-weight:700; }
    .slot-result{ margin-top:12px; text-align:center; font-weight:900; color:var(--good); min-height:1.6em; }
    `;
    let style = document.getElementById("slot-css");
    if (!style) { style = document.createElement("style"); style.id = "slot-css"; document.head.appendChild(style); }
    style.textContent = css;
  }

  function makeStrip(symbols, minLen = STRIP_MIN) {
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

    const left = document.createElement("div");
    left.id = "slot-spins-left";
    left.className = "slot-left";
    controls.appendChild(left);

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

    return { reels, btn, result, left };
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
    } catch {
      return { awarded: false, already: false };
    }
  }

  // ---------- Spin engine ----------
  function initSlotMachine(rootSelector = "#slot-root", opts = {}) {
    const root = document.querySelector(rootSelector);
    if (!root) { console.warn("initSlotMachine: mount point not found:", rootSelector); return; }

    const { reels, btn, result, left } = buildMachine(root);

    const baseStrip = makeStrip(SYMBOLS, STRIP_MIN);
    const len = baseStrip.length;

    const strip = Array.from({ length: STRIP_REPEAT }, () => baseStrip).flat();
    reels.forEach((el) => fillReel(el, strip));

    let CELL_H = measureCellHeight(reels);
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
    renderSpinsLeft(loadSpinsLeft());

    function spinOnce() {
      const spinsLeft = loadSpinsLeft();
      if (spinsLeft <= 0 || btn.disabled) return;

      btn.disabled = true;
      result.textContent = ""; // clear only at start of a spin

      const align = Math.random() < CHANCE_ALIGN;
      const forcedLabel = align ? pickWeighted(SYMBOLS) : null;

      const targets = Array.from({ length: REELS }, () =>
        align ? forcedLabel : pickWeighted(SYMBOLS)
      );

      const targetIdxs = targets.map((t) => {
        const idx = baseStrip.indexOf(t);
        return idx < 0 ? 0 : idx;
      });

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
        // normalize
        reels.forEach((reelEl, i) => {
          const st = state[i];
          st.absIndex = st.absIndex % len;
          reelEl.style.transition = "none";
          setTransformToIndex(reelEl, st.absIndex);
        });

        // decrement spins AFTER a completed spin
        const newLeft = loadSpinsLeft() - 1;
        saveSpinsLeft(newLeft);
        renderSpinsLeft(newLeft);

        const isJackpot = align;
        if (isJackpot) {
          const label = targets[0];
          // Always show a jackpot message
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
                msg = `🎉 JACKPOT! Extra entry — Awesome, you got an extra raffle entry to win a 90 Surge t-shirt!`;
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
          // keep blank for non-jackpot
          result.textContent = "";
        }

        btn.disabled = loadSpinsLeft() <= 0;

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
