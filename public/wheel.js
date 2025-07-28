const canvas = document.getElementById('wheel');
const ctx = canvas.getContext('2d');
const spinBtn = document.getElementById('spinBtn');
const resultDiv = document.getElementById('result');

const prizeWeights = [
  { label: 'Sorry, Next Time', weight: 10 },
  { label: 'T-Shirt', weight: 1 },
  { label: 'Free Drink', weight: 1 },
  { label: 'Sticker', weight: 3 },
  { label: 'Pick a Song', weight: 2 },
  { label: 'Band Shoutout', weight: 4 },
  { label: 'Photo with Band', weight: 2 },
  { label: 'VIP Seat', weight: 1 }
];

// 🎯 TOTAL max slices
const MAX_SLICES =16;

// 1. Normalize weights to slice counts
const totalWeight = prizeWeights.reduce((sum, p) => sum + p.weight, 0);
const sliceCounts = prizeWeights.map(p => ({
  label: p.label,
  count: Math.max(1, Math.round((p.weight / totalWeight) * MAX_SLICES))
}));

// 2. Build slice list
let rawSlices = [];
sliceCounts.forEach(p => {
  for (let i = 0; i < p.count; i++) {
    rawSlices.push(p.label);
  }
});

// 3. Shuffle slices ensuring no identical neighbors
function shuffledNonRepeating(array) {
  const maxAttempts = 100;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const shuffled = array.slice().sort(() => Math.random() - 0.5);
    let valid = true;
    for (let i = 0; i < shuffled.length; i++) {
      if (shuffled[i] === shuffled[(i + 1) % shuffled.length]) {
        valid = false;
        break;
      }
    }
    if (valid) return shuffled;
  }
  return array; // fallback
}

const prizes = shuffledNonRepeating(rawSlices);
const slices = prizes.length;
const colors = ['#ff6384', '#36a2eb', '#ffce56', '#4bc0c0', '#9966ff', '#f67019', '#c9cbcf', '#00a86b'];
const sliceAngle = 2 * Math.PI / slices;
let angle = 0;
let isSpinning = false;

function drawWheel() {
  for (let i = 0; i < slices; i++) {
    const start = i * sliceAngle;
    const end = start + sliceAngle;

    ctx.beginPath();
    ctx.moveTo(200, 200);
    ctx.arc(200, 200, 200, start, end);
    ctx.fillStyle = colors[i % colors.length];
    ctx.fill();

    ctx.save();
    ctx.translate(200, 200);
    ctx.rotate(start + sliceAngle / 2);
    ctx.fillStyle = 'white';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(prizes[i], 180, 0);
    ctx.restore();
  }

  ctx.beginPath();
  ctx.arc(200, 200, 20, 0, 2 * Math.PI);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.stroke();
}

function spinWheel() {
  if (isSpinning) return;
  isSpinning = true;
  resultDiv.classList.add('hidden');

  const winningIndex = Math.floor(Math.random() * slices);
  const degreesPerSlice = 360 / slices;

  // Target center of slice, align under top marker
  const targetAngle = (360 - ((winningIndex + 0.5) * degreesPerSlice) + 270) % 360;
  const fullSpins = 360 * 5;
  const finalAngle = fullSpins + targetAngle;

  const duration = 5000;
  const start = Date.now();

  function animate() {
    const elapsed = Date.now() - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = easeOutCubic(progress);
    angle = (finalAngle * eased) % 360;

    ctx.clearRect(0, 0, 400, 400);
    ctx.save();
    ctx.translate(200, 200);
    ctx.rotate((angle * Math.PI) / 180);
    ctx.translate(-200, -200);
    drawWheel();
    ctx.restore();

    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      isSpinning = false;
      const selected = prizes[winningIndex];
      resultDiv.textContent = `🎁 You won: ${selected}!`;
      resultDiv.classList.remove('hidden');
    }
  }

  animate();
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

drawWheel();
spinBtn.addEventListener('click', spinWheel);
