// Slot machine (3 reels) — no placeholders; no blank flash before stop.

(() => {
  const prizeWeights = [
    { label: 'T-Shirt',         weight: 1  },
    { label: 'Free Drink',      weight: 1  },
    { label: 'Sticker',         weight: 3  },
    { label: 'VIP Seat',        weight: 1  }
  ];

  const REELS = 3;
  const MIN_SPINS = 18;
  const SPIN_VARIANCE = 6;
  const EASING = 'cubic-bezier(.17,.67,.32,1.31)';

  const spinBtn  = document.getElementById('spinBtn');
  const resultEl = document.getElementById('result');

  let ITEM_H = 58; // will be measured from DOM after first render

  // ----- weighted RNG -----
  function pickWeighted(list){
    const total = list.reduce((a,b)=>a + b.weight, 0);
    let r = Math.random() * total;
    for (const item of list){
      r -= item.weight;
      if (r <= 0) return item.label;
    }
    return list[list.length - 1].label;
  }
  function buildWeightedPool(list, cap = 48) {
    const total = list.reduce((a,b) => a + (b.weight||0), 0) || 1;
    const pool = [];
    for (const p of list) {
      let n = Math.round((p.weight / total) * cap);
      if (n < 1) n = 1;
      for (let i=0;i<n;i++) pool.push(p.label);
    }
    return pool;
  }

  // ----- DOM helpers -----
  const qs = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function buildReelDom(reelEl, names){
    reelEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const name of names) {
      const div = document.createElement('div');
      div.className = 'cell';
      div.textContent = name;
      frag.appendChild(div);
    }
    reelEl.appendChild(frag);
  }
  function setTransform(el, y){ el.style.transform = `translate3d(0, ${y}px, 0)`; }

  function ensureItemHeight() {
    if (ITEM_H && ITEM_H > 0) return;
    const anyCell = document.querySelector('.reel .cell');
    const h = anyCell?.getBoundingClientRect().height;
    if (h) ITEM_H = Math.round(h);
  }

  function setResult(text, good=true){
    resultEl.textContent = text || '';
    resultEl.style.color = good ? 'var(--good)' : '#ff7272';
    resultEl.classList.remove('hidden');
  }

  function isWin(symbols){
    if (symbols.length !== REELS) return false;
    const allSame = symbols.every(s => s === symbols[0]);
    return allSame && symbols[0] !== 'Sorry, Next Time';
  }

  // ----- spin -----
  async function spinToTargets(targets, fillerPool) {
    const reels = [];
    const rowsPerReel = [];
    const durations = [];
    const delays    = [];

    for (let i=0;i<REELS;i++){
      const el = qs(`reel-${i}`);

      // build a scrolling list ending with target, plus a sentinel (duplicate target)
      // so even if we overshoot by <1px we still see the same symbol (no blank).
      const loops = MIN_SPINS + Math.floor(Math.random() * SPIN_VARIANCE);
      const rows = [];
      while (rows.length < loops) {
        rows.push(fillerPool[Math.floor(Math.random()*fillerPool.length)]);
      }
      rows.push(targets[i]);      // actual stop
      rows.push(targets[i]);      // sentinel

      buildReelDom(el, rows);
      el.style.transition = 'none';
      setTransform(el, 0);
      void el.offsetHeight; // reflow

      reels.push(el);
      rowsPerReel.push(rows);

      const base = 2200 + i*320;
      durations.push(base + Math.floor(Math.random()*220));
      delays.push(i === 0 ? 0 : 80 + Math.floor(Math.random()*80));
    }

    ensureItemHeight();

    // animate to the *second last* row (the real target)
    reels.forEach((el, i) => {
      const targetIndex = rowsPerReel[i].length - 2; // stop on the real target
      const targetY = -(targetIndex * ITEM_H);
      el.style.transition = `transform ${durations[i]}ms ${EASING} ${delays[i]}ms`;
      setTransform(el, targetY);
    });

    const maxT = Math.max(...durations.map((d,i)=>d+delays[i]));
    await sleep(maxT + 40);
  }

  async function onSpin(){
    spinBtn.disabled = true;
    setResult('', true); // clear

    // decide each reel independently (weighted)
    const targets = Array.from({length: REELS}, () => pickWeighted(prizeWeights));

    // filler pool: real symbols only (no blanks)
    const pool = Array.from(new Set(buildWeightedPool(prizeWeights, 36)));

    await spinToTargets(targets, pool);

    if (isWin(targets)) {
      setResult(`🎉 JACKPOT! You won: ${targets[0]}!`, true);
    } else {
      setResult('No match — try again!', false);
    }

    spinBtn.disabled = false;
  }

  // ----- init: show REAL symbols (no placeholders) -----
  function initReelsWithRandomFaces(){
    for (let i=0;i<REELS;i++){
      const sym = pickWeighted(prizeWeights);
      buildReelDom(qs(`reel-${i}`), [sym]); // single visible row
      setTransform(qs(`reel-${i}`), 0);
    }
    ensureItemHeight();
  }

  document.addEventListener('DOMContentLoaded', () => {
    initReelsWithRandomFaces();
    spinBtn.addEventListener('click', onSpin);
  });
})();
