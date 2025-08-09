import http from 'k6/http';
import { sleep } from 'k6';
import { check } from 'k6';
import encoding from 'k6/encoding';
import { scenario } from 'k6/execution';

export const options = {
  scenarios: {
    // Realistic “people browsing” load
    browsing: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 30 }, // ramp to 30
        { duration: '2m',  target: 30 }, // hold
        { duration: '20s', target: 0  }, // ramp down
      ],
      exec: 'browseFlow',
    },
    // Strictly 50 uploads total (1 per VU)
    uploads: {
      executor: 'per-vu-iterations',
      vus: 50,
      iterations: 1,
      startTime: '10s', // start after browsing ramps
      exec: 'uploadFlow',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<1000'],
  },
};

const BASE = __ENV.BASE_URL || 'https://upload.90surge.com';
const ADMIN_KEY = __ENV.ADMIN_KEY || ''; // optional, enables cleanup
let RUN_ID = ''; // set in setup()

// 1×1 PNG (very small)
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/wwAAgMBApTY1bQAAAAASUVORK5CYII=';
const TINY_PNG_BYTES = encoding.b64decode(TINY_PNG_B64, 'std', 'binary');

export function setup () {
  // Unique run id so we can cleanup only our test files
  RUN_ID = `loadtest_${Date.now().toString(36)}`;
  return { runId: RUN_ID };
}

function jget(path) {
  const r = http.get(`${BASE}${path}`, { headers: { 'Cache-Control': 'no-store' } });
  check(r, { 'GET 200': res => res.status === 200 });
  try { return r.json(); } catch { return {}; }
}
function jpost(path, body, extraHeaders = {}) {
  const r = http.post(`${BASE}${path}`, JSON.stringify(body || {}), {
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
  check(r, { 'POST 2xx': res => res.status >= 200 && res.status < 300 });
  try { return r.json(); } catch { return {}; }
}

// ---------- Normal browsing flow (no uploads) ----------
export function browseFlow () {
  // Load config like the page would
  jget('/api/admin?action=config');

  // Simulate follow gate
  jpost('/api/admin?action=mark-follow&platform=fb', {});
  jget('/api/admin?action=check-follow');

  // Hit gallery, randomly upvote one
  const uploads = jget('/api/admin?action=uploads') || [];
  if (uploads.length) {
    const pick = uploads[Math.floor(Math.random() * uploads.length)];
    const fileId = pick?.id || pick?.fileName;
    if (fileId) jpost('/api/admin?action=upvote', { fileId });
  }

  sleep(0.5 + Math.random() * 2.0);
}

// ---------- Upload flow (R2 presign -> PUT -> save-upload) ----------
export function uploadFlow (data) {
  const runId = data.runId || RUN_ID;

  // 0) Get env to build fileUrl (matches your frontend)
  const env = jget('/api/env');
  const r2AccountId = env?.r2AccountId || '';
  const r2BucketName = env?.r2BucketName || '';

  // 1) Make a unique-ish filename
  const vu = scenario.vu.idInTest; // 1..50 here
  const now = Date.now();
  const fileName = `loadtest_${runId}_vu${vu}_${now}.png`;
  const mimeType = 'image/png';
  const userName = `k6_user_${vu}`;

  // 2) Presign
  const presigned = jpost('/api/get-upload-url', { fileName, mimeType });
  const url = presigned?.url;
  check(url, { 'presigned URL present': v => !!v });

  // 3) PUT raw bytes to R2
  if (url) {
    const putRes = http.put(url, TINY_PNG_BYTES, { headers: { 'Content-Type': mimeType } });
    check(putRes, { 'R2 PUT 2xx': r => r.status >= 200 && r.status < 300 });
  }

  // 4) Save metadata (so it shows in gallery)
  const fileUrl = `https://${r2AccountId}.r2.cloudflarestorage.com/${r2BucketName}/${fileName}`;
  jpost('/api/admin?action=save-upload', {
    fileName,
    fileUrl,
    mimeType,
    userName,
    originalFileName: 'k6.png',
  });

  // 5) Optional: a quick like, to exercise that path too
  // (the saved upload won’t have an ID yet in Redis list, so skip)
  sleep(0.3 + Math.random() * 0.8);
}

// ---------- Optional cleanup (delete our test files) ----------
export function teardown (data) {
  if (!ADMIN_KEY) {
    console.log('No ADMIN_KEY provided; skipping cleanup.');
    return;
  }
  const runId = data.runId || RUN_ID;
  const list = jget('/api/admin?action=list-r2-files');
  const files = (list?.files || []).map(f => f.key).filter(k => k && k.includes(`loadtest_${runId}_`));

  const headers = { Authorization: `Bearer:super:${ADMIN_KEY}`, 'Content-Type': 'application/json' };
  for (const key of files) {
    const res = http.post(`${BASE}/api/admin?action=delete-file`, JSON.stringify({ fileId: key }), { headers });
    check(res, { 'cleanup delete 2xx': r => r.status >= 200 && r.status < 300 });
  }
  console.log(`Cleanup complete. Deleted ${files.length} test files.`);
}
