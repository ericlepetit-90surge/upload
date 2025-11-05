// /api/admin.js
import fs from "fs";
import path from "path";
import { createClient } from "redis";
import dns from "dns";
try {
  dns.setDefaultResultOrder?.("ipv4first");
} catch {}

export const config = { runtime: "nodejs" };

// Minimum total entries shown publicly
const PUBLIC_TOTAL_FLOOR = 12;

/* ──────────────────────────────────────────────────────────────
   ENV + mode
────────────────────────────────────────────────────────────── */
const ADMIN_PASS = process.env.ADMIN_PASS || "";
const MODERATOR_PASS = process.env.MODERATOR_PASS || "";

// Treat Vercel preview like prod; only true local dev is "local"
const isLocal =
  (!process.env.VERCEL && process.env.NODE_ENV !== "production") ||
  process.env.VERCEL_ENV === "development";

/* Local ledger file (dev fallback) */
const DATA_DIR = path.join(process.cwd(), ".data");
const LOCAL_LEDGER_FILE = path.join(DATA_DIR, "winners-local.json");

/* ──────────────────────────────────────────────────────────────
   Redis — GLOBAL SINGLETON
────────────────────────────────────────────────────────────── */
const REDIS_URL = (process.env.REDIS_URL || "").trim();

let _redis = null;
let _connecting = null;

function _makeRedis() {
  if (!REDIS_URL) return null;
  const useTLS = REDIS_URL.startsWith("rediss://");
  const c = createClient({
    url: REDIS_URL,
    maxRetriesPerRequest: 1,
    disableOfflineQueue: true,
    socket: {
      tls: useTLS,
      noDelay: true,
      keepAlive: 30_000,
      connectTimeout: 1500,
      reconnectStrategy: (retries) => Math.min(300 + retries * 200, 2000),
    },
  });
  c.on("error", (e) => console.error("Redis error:", e?.message || e));
  return c;
}

async function getRedis() {
  if (!REDIS_URL) return null;
  if (_redis?.isOpen) return _redis;
  if (_connecting) {
    try {
      await _connecting;
    } catch {}
    return _redis?.isOpen ? _redis : null;
  }
  _redis = _makeRedis();
  if (!_redis) return null;
  _connecting = _redis
    .connect()
    .catch((e) => {
      console.error("Redis connect failed:", e?.message || e);
      throw e;
    })
    .finally(() => {
      _connecting = null;
    });
  try {
    await _connecting;
    return _redis;
  } catch {
    return null;
  }
}
function hasRedis(c) {
  return !!(c && c.isOpen);
}

async function getRedisFast(timeoutMs = 1200) {
  return await Promise.race([
    getRedis(),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("Redis connect timeout")), timeoutMs)
    ),
  ]);
}

async function withRedis(op, opTimeoutMs = 2000) {
  let c = await getRedisFast().catch(() => null);
  if (!hasRedis(c)) {
    await new Promise((r) => setTimeout(r, 50));
    c = await getRedisFast().catch(() => null);
  }
  if (!hasRedis(c)) throw new Error("Redis not ready");

  const run = async (client) => {
    const task = op(client);
    return await Promise.race([
      task,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("Redis op timeout")), opTimeoutMs)
      ),
    ]);
  };

  try {
    return await run(c);
  } catch (e) {
    const msg = (e && (e.message || e.toString())) || "";
    if (/client is closed/i.test(msg) || e?.name === "ClientClosedError") {
      await new Promise((r) => setTimeout(r, 100));
      const c2 = await getRedisFast().catch(() => null);
      if (!hasRedis(c2)) throw e;
      return await run(c2);
    }
    throw e;
  }
}

/* ──────────────────────────────────────────────────────────────
   Helpers
────────────────────────────────────────────────────────────── */
const g = globalThis;
if (!g.__surgeMem)
  g.__surgeMem = { winners: [], currentWinner: null, noWinner: false };
const MEM = g.__surgeMem;

function isAdmin(req) {
  const h = req.headers.authorization || "";
  const pref = "Bearer:super:";
  if (!h.startsWith(pref)) return false;
  const token = h.slice(pref.length);
  return !!ADMIN_PASS && token === ADMIN_PASS;
}
function isSuperAdmin(req) {
  const auth =
    (req.headers && (req.headers.authorization || req.headers.Authorization)) ||
    "";
  return isAdmin(req) && auth.startsWith("Bearer:super:");
}

async function readJson(req) {
  if (req?.body && typeof req.body === "object") return req.body;
  return {};
}

import crypto from "crypto";
const APP_SECRET = (process.env.FB_APP_SECRET || "").trim();

function isFollowAllowed(raw) {
  if (!raw) return false;
  if (raw === "true") return true;
  try {
    return !!JSON.parse(raw)?.followed;
  } catch {
    return false;
  }
}
function timeout(ms) {
  return new Promise((_, rej) =>
    setTimeout(() => rej(new Error("Timeout " + ms + "ms")), ms)
  );
}
function noCache(res) {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("CDN-Cache-Control", "no-store");
  res.setHeader("Vercel-CDN-Cache-Control", "no-store");
}
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// Time-boxed SCAN helper
async function scanKeys(
  r,
  pattern,
  { count = 500, limit = 5000, budgetMs = 900 } = {}
) {
  const keys = [];
  let cursor = "0";
  const deadline = Date.now() + budgetMs;

  while (true) {
    let reply;
    try {
      reply = await r.scan(cursor, { MATCH: pattern, COUNT: count });
    } catch {
      break;
    }

    let nextCursor, batch;
    if (Array.isArray(reply)) {
      nextCursor = reply[0];
      batch = reply[1] || [];
    } else {
      nextCursor = reply?.cursor ?? "0";
      batch = reply?.keys ?? [];
    }

    for (const k of batch) {
      if (typeof k === "string" && k) keys.push(k);
      if (keys.length >= limit) break;
    }
    cursor = String(nextCursor || "0");
    if (cursor === "0" || keys.length >= limit || Date.now() > deadline) break;
  }
  return keys;
}

function ensureLocalDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
}
function readLocalLedgerSafe() {
  try {
    ensureLocalDir();
    if (!fs.existsSync(LOCAL_LEDGER_FILE)) return [];
    const txt = fs.readFileSync(LOCAL_LEDGER_FILE, "utf8");
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function writeLocalLedgerSafe(rows) {
  try {
    ensureLocalDir();
    fs.writeFileSync(LOCAL_LEDGER_FILE, JSON.stringify(rows, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}
function appendLocalLedgerRow(row) {
  const arr = readLocalLedgerSafe();
  arr.push(row);
  if (arr.length > 500) arr.splice(0, arr.length - 500);
  writeLocalLedgerSafe(arr);
}

async function isShutdown(r) {
  try {
    const v = await r.get("shutdown");
    return v === "1" || v === "true";
  } catch {
    return false;
  }
}

// --- Poll freeze controls ---
const IS_PROD = process.env.NODE_ENV === "production";
const FREEZE_POLLS = process.env.FREEZE_POLLS === "1"; // set to 1 in prod to freeze
const POLL_SEED_VER = process.env.POLL_SEED_VERSION || "2025-01";

const POLL_SONGS_KEY = (id) => `poll:${id}:songs`;
const POLL_SEEDED_KEY = (id) => `poll:${id}:seeded:${POLL_SEED_VER}`;

// seed **only if** not frozen AND empty AND not seeded for this version
async function ensurePollSeed(kv, pollId, defaultSongs) {
  if (IS_PROD && FREEZE_POLLS) return; // hard-freeze in prod
  const existing = await kv.get(POLL_SONGS_KEY(pollId));
  if (Array.isArray(existing) && existing.length) return; // don’t overwrite
  if (await kv.get(POLL_SEEDED_KEY(pollId))) return; // seeded already
  if (Array.isArray(defaultSongs) && defaultSongs.length) {
    await kv.set(POLL_SONGS_KEY(pollId), defaultSongs);
    await kv.set(POLL_SEEDED_KEY(pollId), Date.now());
  }
}

/* ───────── Monthly window helpers ───────── */

function parseMs(s) {
  const t = Date.parse(s || "");
  return Number.isFinite(t) ? t : NaN;
}
function toIso(d) {
  try {
    return new Date(d).toISOString();
  } catch {
    return null;
  }
}

// Given an ISO `endTime`, derive the month start (local first day 00:00)
function monthStartFromEnd(endTimeIso) {
  const d = new Date(endTimeIso);
  if (isNaN(d)) return null;
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}
// Given an ISO `endTime`, compute pickAt at LOCAL noon of that date
function computeMonthlyPickAtNoon(endTimeIso) {
  if (!endTimeIso) return null;
  const d = new Date(endTimeIso);
  if (isNaN(d)) return null;
  const noon = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    12,
    0,
    0,
    0
  );
  return noon.getTime();
}

async function getWindowInfo(r) {
  let showName = "90 Surge";
  let startTime = null;
  let endTime = null;
  try {
    if (hasRedis(r)) {
      const [sn, st, et] = await Promise.all([
        r.get("showName").catch(() => ""),
        r.get("startTime").catch(() => ""),
        r.get("endTime").catch(() => ""),
      ]);
      if (sn) showName = sn;
      if (st) startTime = st;
      if (et) endTime = et;
    } else if (isLocal) {
      const cfgPath = path.join(process.cwd(), "config.json");
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        showName = cfg.showName || showName;
        startTime = cfg.startTime || startTime;
        endTime = cfg.endTime || endTime;
      }
    }
  } catch {}

  // Monthly defaulting:
  // If you provide only endTime (set to the last day of the month),
  // we derive startTime as the first day of that month 00:00 local.
  if (endTime && !startTime) {
    const mStart = monthStartFromEnd(endTime);
    if (mStart) startTime = toIso(mStart);
  }

  // If still missing, fallback to "today → tomorrow"
  if (!startTime || !endTime) {
    const now = new Date();
    const start = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      0,
      0,
      0,
      0
    );
    const end = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      0,
      0,
      0,
      0
    );
    startTime = toIso(start);
    endTime = toIso(end);
  }

  const windowKey = `${startTime}|${endTime}`;
  let ttlSeconds = Math.floor((new Date(endTime) - Date.now()) / 1000);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) ttlSeconds = 8 * 60 * 60;

  return { showName, startTime, endTime, windowKey, ttlSeconds };
}

/* Winners persistence with robust fallback */
async function appendWinnerRow(r, row) {
  MEM.winners.push(row);
  if (MEM.winners.length > 500) MEM.winners = MEM.winners.slice(-500);
  try {
    if (hasRedis(r)) {
      await r.rPush("raffle:winners:all", JSON.stringify(row));
      await r.lTrim("raffle:winners:all", -500, -1);
      if (isLocal) appendLocalLedgerRow(row);
    } else if (isLocal) {
      appendLocalLedgerRow(row);
    }
    return { where: hasRedis(r) ? "redis" : isLocal ? "file" : "memory" };
  } catch {
    if (isLocal) appendLocalLedgerRow(row);
    return { where: "file (fallback)" };
  }
}

function normalizeSymbol(s) {
  try {
    return String(s || "")
      .toLowerCase()
      .replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}/gu, "")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }
}
function detectJackpot(targets = [], clientFlag = false) {
  if (clientFlag) return true;
  const norm = targets.slice(0, 3).map(normalizeSymbol).filter(Boolean);
  if (norm.length >= 3 && new Set(norm.slice(0, 3)).size === 1) return true;
  if (normalizeSymbol(targets.join(" ")).includes("jackpot")) return true;
  return false;
}

/* ──────────────────────────────────────────────────────────────
   Main handler
────────────────────────────────────────────────────────────── */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  // tolerant JSON body parsing
  if (req.method === "POST") {
    const isJson = (req.headers["content-type"] || "").includes(
      "application/json"
    );
    try {
      if (isJson) {
        let body = "";
        await new Promise((resolve) => {
          req.on("data", (c) => (body += c));
          req.on("end", resolve);
        });
        try {
          req.body = body ? JSON.parse(body) : {};
        } catch {
          req.body = {};
        }
      } else {
        req.body = req.body && typeof req.body === "object" ? req.body : {};
      }
    } catch {
      req.body = {};
    }
  }

  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const action = url.searchParams.get("action");

  /* ───── AUTH ───── */
  if (action === "login" && req.method === "POST") {
    const { password } = req.body || {};
    if (password === ADMIN_PASS)
      return res.json({ success: true, role: "admin" });
    if (password === MODERATOR_PASS)
      return res.json({ success: true, role: "moderator" });
    return res.status(401).json({ success: false, error: "Invalid password" });
  }

  /* ───── PING ───── */
  if (req.method === "GET" && action === "ping") {
    noCache(res);
    return res.status(200).json({ ok: true, now: new Date().toISOString() });
  }

  /* ───── REDIS STATUS / WARM (optional) ───── */
  if (req.method === "GET" && action === "redis-status") {
    try {
      return await withRedis(async (r) => {
        const t0 = Date.now();
        await r.ping();
        const pingMs = Date.now() - t0;
        const [keyCount, lastWarmAt, seeded, hitRate] = await Promise.all([
          r.dbSize().catch(() => null),
          r.get("lastWarmAt").catch(() => null),
          r.get("warm_seeded").catch(() => null),
          r.get("cache:hitRate").catch(() => null),
        ]);
        return res.status(200).json({
          status: "active",
          pingMs,
          keyCount,
          lastWarmAt,
          seeded: seeded === "true" ? true : seeded ?? null,
          hitRate: hitRate ? Number(hitRate) : null,
        });
      });
    } catch {
      return res.status(200).json({ status: "idle" });
    }
  }

  if (req.method === "POST" && action === "warm-redis") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    try {
      return await withRedis(async (r) => {
        const pong = await r.ping();
        await r.set("lastWarmAt", new Date().toISOString());
        await r.set("warm_seeded", "true");
        return res.status(200).json({ success: true, pong });
      });
    } catch {
      return res.status(503).json({ error: "Redis not ready" });
    }
  }

  /* ───── CONFIG (monthly: compute autoPickAt = noon on endTime day) ───── */
  if (action === "config") {
    if (req.method === "GET") {
      noCache(res);
      try {
        if (isLocal) {
          try {
            const filePath = path.join(process.cwd(), "config.json");
            const cfg = JSON.parse(fs.readFileSync(filePath, "utf8"));
            const showName = cfg.showName ?? "90 Surge";
            const startTime = cfg.startTime ?? null;
            const endTime = cfg.endTime ?? null;
            const version = Number(cfg.version || 0);
            let autoPickAt = cfg.autoPickAt || "";
            if (!autoPickAt && endTime) {
              const ts = computeMonthlyPickAtNoon(endTime);
              if (ts) autoPickAt = new Date(ts).toISOString();
            }
            return res
              .status(200)
              .json({ showName, startTime, endTime, version, autoPickAt });
          } catch {}
        }
        return await withRedis(async (r) => {
          let [showName, startTime, endTime, version, autoPickAt] =
            await Promise.race([
              Promise.all([
                r.get("showName").catch(() => ""),
                r.get("startTime").catch(() => ""),
                r.get("endTime").catch(() => ""),
                r.get("config:version").catch(() => "0"),
                r.get("autoPickAt").catch(() => ""),
              ]),
              timeout(3000),
            ]);

          if ((!autoPickAt || !autoPickAt.trim()) && endTime) {
            const ts = computeMonthlyPickAtNoon(endTime);
            if (ts) autoPickAt = new Date(ts).toISOString();
          }

          return res.status(200).json({
            showName,
            startTime,
            endTime,
            version: Number(version || 0),
            autoPickAt,
          });
        }, 3500);
      } catch {
        return res.status(500).json({ error: "Failed to load config" });
      }
    }

    if (req.method === "POST") {
      const { showName, startTime, endTime } = req.body || {};
      try {
        let computedAuto = "";
        try {
          if (endTime) {
            const ts = computeMonthlyPickAtNoon(endTime);
            if (ts) computedAuto = new Date(ts).toISOString();
          }
        } catch {}
        if (isLocal) {
          const filePath = path.join(process.cwd(), "config.json");
          let existing = {};
          try {
            existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
          } catch {}
          const version = Number(existing.version || 0) + 1;
          fs.writeFileSync(
            filePath,
            JSON.stringify(
              {
                showName,
                startTime,
                endTime,
                version,
                autoPickAt: computedAuto,
              },
              null,
              2
            )
          );
          noCache(res);
          return res.status(200).json({
            success: true,
            showName,
            startTime,
            endTime,
            version,
            autoPickAt: computedAuto,
          });
        }
        return await withRedis(async (r) => {
          await Promise.all([
            r.set("showName", showName || ""),
            r.set("startTime", startTime || ""),
            r.set("endTime", endTime || ""),
            r.set("autoPickAt", computedAuto || ""),
            r.set("autoPickArmed", computedAuto ? "true" : "false"),
          ]);
          const version = await r.incr("config:version");
          noCache(res);
          return res.status(200).json({
            success: true,
            showName,
            startTime,
            endTime,
            version,
            autoPickAt: computedAuto,
          });
        }, 4000);
      } catch {
        return res.status(500).json({ error: "Failed to save config" });
      }
    }
    return res.status(405).json({ error: "Method not allowed" });
  }

  /* ────────────────────────────────────────────────────────────
     RAFFLE: enter / list / summary / my-entries
     (name now optional; email allowed)
  ───────────────────────────────────────────────────────────── */
  if (action === "enter" && req.method === "POST") {
    try {
      return await withRedis(async (r) => {
        // ── read + normalize inputs
        const rawEmail = String(req.body?.email || "")
          .trim()
          .toLowerCase();
        let rawSource = (req.body?.source || "").toString().toLowerCase();

        // allow "base"/"email" as explicit initial-entry source,
        // keep your legacy/extra sources
        const allowed = new Set([
          "fb",
          "ig",
          "jackpot",
          "email",
          "base",
          "other",
        ]);
        const source = allowed.has(rawSource) ? rawSource : "other";

        const ip =
          req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
          req.socket.remoteAddress ||
          "unknown";

        // identify the current month/show window
        const { windowKey, ttlSeconds } = await getWindowInfo(r);

        const listKey = `raffle:entries:${windowKey}`;
        const totalKey = `raffle:total:${windowKey}`;
        const emailSet = `raffle:emailSeen:${windowKey}`; // per-window unique emails

        // ── JACKPOT path (still allowed, email optional)
        if (source === "jackpot") {
          const entry = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
            name: rawEmail || "(jackpot)", // keep name field for UI compatibility
            email: rawEmail || "",
            ip,
            source,
            createdTime: new Date().toISOString(),
          };
          const jpKey = `raffle:jackpotCount:${windowKey}:${ip}`;
          const setKeyJ = `raffle:entered:${windowKey}:jackpot`;
          await r
            .multi()
            .sAdd(setKeyJ, ip)
            .expire(setKeyJ, ttlSeconds)
            .rPush(listKey, JSON.stringify(entry))
            .expire(listKey, ttlSeconds)
            .incr(totalKey)
            .expire(totalKey, ttlSeconds) // total counter
            .incr(jpKey)
            .expire(jpKey, ttlSeconds)
            .exec();
          return res.status(200).json({ success: true, entry, jackpot: true });
        }

        // "Base" entries (the email form) must include a valid email
        const isBaseEntry =
          source === "email" || source === "base" || source === "other";
        const emailLooksValid = !!rawEmail && /.+@.+\..+/.test(rawEmail);

        if (isBaseEntry && !emailLooksValid) {
          return res.status(400).json({ error: "Missing or invalid email" });
        }

        // per-source IP dedupe (still applies to fb/ig)
        const setKey = `raffle:entered:${windowKey}:${source}`;

        if (isBaseEntry && rawEmail) {
          // hard email dedupe ONLY for the base entry
          const alreadyEmail = await r.sIsMember(emailSet, rawEmail);
          if (alreadyEmail) {
            return res.status(409).json({ error: "Email already entered" });
          }
        }

        // fb/ig repeat clicks return "already"
        const alreadyIP = await r.sIsMember(setKey, ip);
        if (alreadyIP && !isBaseEntry) {
          return res.status(200).json({ success: true, already: true, source });
        }

        // create entry — store email in both fields (name kept for legacy UI)
        const entry = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: rawEmail || "(anonymous)", // ← name = email
          email: rawEmail || "",
          ip,
          source,
          createdTime: new Date().toISOString(),
        };

        const pipe = r.multi();

        // record email in the uniqueness set (idempotent)
        if (rawEmail) {
          pipe.sAdd(emailSet, rawEmail);
          pipe.expire(emailSet, ttlSeconds);
        }

        // per-source IP lock + main list + total counter
        pipe.sAdd(setKey, ip);
        pipe.expire(setKey, ttlSeconds);
        pipe.rPush(listKey, JSON.stringify(entry));
        pipe.expire(listKey, ttlSeconds);
        pipe.incr(totalKey);
        pipe.expire(totalKey, ttlSeconds);

        await pipe.exec();

        return res.status(200).json({ success: true, entry });
      }, 3000);
    } catch {
      return res.status(503).json({ error: "Redis not ready" });
    }
  }

  if (action === "entries" && req.method === "GET") {
    try {
      return await withRedis(async (r) => {
        const { windowKey } = await getWindowInfo(r);
        const listKey = `raffle:entries:${windowKey}`;
        const totalKey = `raffle:total:${windowKey}`;

        const [raw, totalCounterRaw] = await Promise.all([
          r.lRange(listKey, 0, -1),
          r.get(totalKey).catch(() => "0"),
        ]);

        const entries = raw
          .map((s) => {
            try {
              return JSON.parse(s);
            } catch {
              return null;
            }
          })
          .filter(Boolean);

        const totalCounter = Number(totalCounterRaw || 0) || 0;
        const count = Math.max(entries.length, totalCounter);

        return res.status(200).json({ entries, count, total: count });
      }, 2500);
    } catch {
      return res.status(200).json({ entries: [], count: 0, total: 0 });
    }
  }

  if (action === "my-entries" && req.method === "GET") {
    try {
      return await withRedis(async (r) => {
        const { windowKey } = await getWindowInfo(r);
        const ip =
          req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
          req.socket.remoteAddress ||
          "unknown";

        const setFb = `raffle:entered:${windowKey}:fb`;
        const setIg = `raffle:entered:${windowKey}:ig`;
        const setJp = `raffle:entered:${windowKey}:jackpot`;
        const listKey = `raffle:entries:${windowKey}`;
        const bonusKey = `raffle:bonus:${windowKey}:${ip}`;
        const totalKey = `raffle:total:${windowKey}`;

        const [fb, ig, jp, listLen, bonusRaw, totalCounterRaw] =
          await Promise.all([
            r.sIsMember(setFb, ip),
            r.sIsMember(setIg, ip),
            r.sIsMember(setJp, ip),
            r.lLen(listKey).catch(() => 0),
            r.get(bonusKey).catch(() => "0"),
            r.get(totalKey).catch(() => "0"),
          ]);

        const bonus = Number(bonusRaw || 0) || 0;
        const mine = (fb ? 1 : 0) + (ig ? 1 : 0) + (jp ? 1 : 0) + bonus;

        const totalCounter = Number(totalCounterRaw || 0) || 0;
        const totalRaw = Math.max(Number(listLen || 0), totalCounter);
        const total = Math.max(PUBLIC_TOTAL_FLOOR, totalRaw);

        return res.status(200).json({
          mine,
          total,
          sources: { fb: !!fb, ig: !!ig, jackpot: !!jp },
          bonus,
        });
      }, 2500);
    } catch {
      return res.status(200).json({
        mine: 0,
        total: PUBLIC_TOTAL_FLOOR,
        sources: { fb: false, ig: false, jackpot: false },
        bonus: 0,
      });
    }
  }

  if (action === "entries-summary" && req.method === "GET") {
    try {
      return await withRedis(async (r) => {
        const { windowKey } = await getWindowInfo(r);
        const listKey = `raffle:entries:${windowKey}`;
        const raw = await r.lRange(listKey, 0, -1);
        const rowsMap = new Map();
        for (const s of raw) {
          try {
            const e = JSON.parse(s);
            const name = (e?.name || "").trim();
            if (!name) continue;
            rowsMap.set(name, (rowsMap.get(name) || 0) + 1);
          } catch {}
        }
        const rows = Array.from(rowsMap, ([name, entries]) => ({
          name,
          entries,
        })).sort(
          (a, b) => b.entries - a.entries || a.name.localeCompare(b.name)
        );
        return res.status(200).json({ rows });
      }, 2500);
    } catch {
      return res.status(200).json({ rows: [] });
    }
  }

  /* ────────────────────────────────────────────────────────────
   RESET RAFFLE ENTRIES ONLY (no winners, no poll)
  ───────────────────────────────────────────────────────────── */
  if (action === "reset-entries" && req.method === "POST") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    try {
      return await withRedis(async (r) => {
        const { windowKey } = await getWindowInfo(r);

        const listKey = `raffle:entries:${windowKey}`;
        const totalKey = `raffle:total:${windowKey}`; // ← new
        const dedupes = await scanKeys(r, `raffle:entered:${windowKey}:*`, {
          budgetMs: 800,
        });
        const bonuses = await scanKeys(r, `raffle:bonus:${windowKey}:*`, {
          budgetMs: 800,
        });
        const jpCounts = await scanKeys(
          r,
          `raffle:jackpotCount:${windowKey}*`,
          { budgetMs: 800 }
        );

        const toDelete = Array.from(
          new Set([listKey, totalKey, ...dedupes, ...bonuses, ...jpCounts])
        ); // ← include totalKey
        let deleted = 0;
        for (const k of toDelete) {
          try {
            deleted += (await r.unlink(k)) || 0;
          } catch {
            try {
              deleted += (await r.del(k)) || 0;
            } catch {}
          }
        }

        return res.status(200).json({
          success: true,
          windowKey,
          deletedKeys: deleted,
          note: "Raffle entries cleared. Winners, social, and poll data left intact.",
        });
      }, 6000);
    } catch {
      return res.status(503).json({ ok: false, error: "Redis not ready" });
    }
  }

  // ────────────────────────────────────────────────────────────
  // Social status (per-window aggregate for Admin UI)
  // ────────────────────────────────────────────────────────────
  if (req.method === "GET" && action === "social-status") {
    try {
      return await withRedis(async (r) => {
        const { windowKey } = await getWindowInfo(r);
        const setKey = `social:ips:${windowKey}`;
        const ips = await r.sMembers(setKey);

        const entries = [];
        let totalUnlocked = 0,
          fbClicks = 0,
          igClicks = 0;

        for (const ip of ips) {
          const key = `social:${windowKey}:${ip}`;
          const raw = await r.get(key);
          if (!raw) continue;
          let s;
          try {
            s = JSON.parse(raw);
          } catch {
            s = { followed: raw === "true", platforms: {} };
          }
          const ttlSeconds = await r.ttl(key);
          if (s.followed) totalUnlocked += 1;
          if (s.platforms?.fb) fbClicks += 1;
          if (s.platforms?.ig) igClicks += 1;
          entries.push({
            ip,
            firstSeen: s.firstSeen || null,
            lastSeen: s.lastSeen || null,
            followed: !!s.followed,
            platforms: s.platforms || {},
            count: s.count || 1,
            ttlSeconds,
          });
        }

        return res.status(200).json({
          totals: {
            uniqueIPsTracked: entries.length,
            unlocked: totalUnlocked,
            facebookClicks: fbClicks,
            instagramClicks: igClicks,
          },
          entries,
        });
      }, 3500);
    } catch {
      return res.status(200).json({
        totals: {
          uniqueIPsTracked: 0,
          unlocked: 0,
          facebookClicks: 0,
          instagramClicks: 0,
        },
        entries: [],
        _fallback: true,
      });
    }
  }

  /* ────────────────────────────────────────────────────────────
     WINNER (current) + PICK + RESET
     (auto-pick at noon on endTime date; record "no winner" flag)
  ───────────────────────────────────────────────────────────── */
  if (action === "winner" && req.method === "GET") {
    try {
      return await withRedis(async (r) => {
        const [winnerStr, noneStr] = await Promise.all([
          r.get("raffle_winner").catch(() => null),
          r.get("raffle_no_winner").catch(() => null),
        ]);
        const noWinner = noneStr === "true";
        return res.json({
          winner: winnerStr ? JSON.parse(winnerStr) : null,
          noWinner,
        });
      }, 2000);
    } catch {
      return res.json({
        winner: MEM.currentWinner ? { name: MEM.currentWinner } : null,
        noWinner: !!MEM.noWinner,
        _fallback: true,
      });
    }
  }

  if (
    (req.method === "POST" || req.method === "GET") &&
    action === "maybe-auto-pick"
  ) {
    try {
      return await withRedis(async (r) => {
        const { windowKey, endTime, ttlSeconds } = await getWindowInfo(r);
        const pickAtMs = endTime ? computeMonthlyPickAtNoon(endTime) : null;
        if (!pickAtMs)
          return res.status(200).json({ ok: false, reason: "no_end_time" });

        const now = Date.now();
        if (now < pickAtMs)
          return res
            .status(200)
            .json({ ok: false, reason: "too_early", msLeft: pickAtMs - now });

        const already = await r.get("raffle_winner").catch(() => null);
        const flaggedNone = await r.get("raffle_no_winner").catch(() => null);
        if (already || flaggedNone === "true") {
          const winner = already ? JSON.parse(already) : null;
          return res.status(200).json({
            ok: true,
            already: true,
            winner,
            noWinner: flaggedNone === "true",
          });
        }

        const lockKey = `autoPick:lock:${windowKey}`;
        const gotLock = await r.set(lockKey, String(now), {
          NX: true,
          PX: 8000,
        });
        if (!gotLock)
          return res.status(200).json({ ok: false, reason: "locked" });

        const listKey = `raffle:entries:${windowKey}`;
        const raw = await r.lRange(listKey, 0, -1);
        const entries = raw
          .map((s) => {
            try {
              return JSON.parse(s);
            } catch {
              return null;
            }
          })
          .filter(Boolean);

        if (!entries.length) {
          await r.set("raffle_no_winner", "true", {
            EX: Math.max(3600, ttlSeconds),
          });
          MEM.noWinner = true;
          return res
            .status(200)
            .json({ ok: true, noWinner: true, reason: "no_entries" });
        }

        const idx = Math.floor(Math.random() * entries.length);
        const w = entries[idx];
        const label =
          w.email && w.email.trim() ? w.email.trim() : w.name || "(anonymous)";
        const payload = {
          id: w.id,
          name: label,
          email: w.email || "",
          source: w.source || null,
        };

        await r.set("raffle_winner", JSON.stringify(payload));
        await r.del("raffle_no_winner").catch(() => {});
        MEM.currentWinner = payload.name;
        MEM.noWinner = false;

        const row = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: payload.name,
          prize: "Monthly Raffle Winner — T-Shirt",
          source: "raffle(auto)",
          windowKey,
          ts: new Date().toISOString(),
        };
        await appendWinnerRow(r, row);

        return res
          .status(200)
          .json({ ok: true, autoPicked: true, winner: payload });
      }, 3500);
    } catch {
      return res.status(503).json({ ok: false, error: "Redis not ready" });
    }
  }

  if (action === "pick-winner" && req.method === "POST") {
    const { role } = req.body || {};
    if (role !== "admin" && role !== "moderator")
      return res.status(401).json({ error: "Unauthorized" });
    try {
      return await withRedis(async (r) => {
        const { windowKey } = await getWindowInfo(r);
        const listKey = `raffle:entries:${windowKey}`;
        const raw = await r.lRange(listKey, 0, -1);
        const entries = raw
          .map((s) => {
            try {
              return JSON.parse(s);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        if (!entries.length)
          return res.status(400).json({ error: "No eligible entries" });

        const idx = Math.floor(Math.random() * entries.length);
        const winner = entries[idx];
        const label =
          winner.email && winner.email.trim()
            ? winner.email.trim()
            : winner.name || "(anonymous)";
        const payload = {
          id: winner.id,
          name: label,
          email: winner.email || "",
          source: winner.source || null,
        };

        await r.set("raffle_winner", JSON.stringify(payload));
        await r.del("raffle_no_winner").catch(() => {});
        MEM.currentWinner = payload.name;
        MEM.noWinner = false;

        const row = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: payload.name,
          prize: "Monthly Raffle Winner — T-Shirt",
          source: "raffle",
          windowKey,
          ts: new Date().toISOString(),
        };
        await appendWinnerRow(r, row);

        return res.json({ success: true, winner: payload });
      }, 3500);
    } catch {
      return res.status(503).json({ error: "Redis not ready" });
    }
  }

  if (action === "reset-winner" && req.method === "POST") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    const keepLedgerQP = /^true|1|yes$/i.test(
      url.searchParams.get("keepLedger") || ""
    );
    const clearLedgerBody =
      typeof req.body?.clearLedger === "boolean"
        ? req.body.clearLedger
        : undefined;
    const clearLedger =
      clearLedgerBody !== undefined ? clearLedgerBody : !keepLedgerQP;

    try {
      return await withRedis(async (r) => {
        await Promise.all([r.del("raffle_winner"), r.del("raffle_no_winner")]);
        MEM.currentWinner = null;
        MEM.noWinner = false;

        let ledgerCleared = false;
        if (clearLedger) {
          try {
            await r.del("raffle:winners:all");
            MEM.winners = [];
            try {
              const localFilePath = path.join(
                process.cwd(),
                ".data",
                "winners-local.json"
              );
              if (fs.existsSync(localFilePath))
                fs.writeFileSync(localFilePath, "[]");
            } catch {}
            ledgerCleared = true;
          } catch {}
        }

        return res.json({
          success: true,
          ledgerCleared,
          note: ledgerCleared
            ? "Current winner/no-winner flag and Winners Ledger cleared."
            : "Current winner/no-winner flag cleared. Ledger kept.",
        });
      }, 3000);
    } catch {
      return res.status(503).json({ success: false, error: "Redis not ready" });
    }
  }

  /* WINNERS LEDGER (manual + list) */
  if (action === "winner-log" && req.method === "POST") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    const { name, prize } = req.body || {};
    const cleanName = (name || "").toString().trim().slice(0, 120);
    const cleanPrize = (prize || "").toString().trim().slice(0, 160);
    if (!cleanName || !cleanPrize)
      return res.status(400).json({ error: "name and prize required" });

    const row = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      name: cleanName,
      prize: cleanPrize,
      source: "manual",
      ts: new Date().toISOString(),
    };
    try {
      return await withRedis(async (r) => {
        await appendWinnerRow(r, row);
        noCache(res);
        return res.status(200).json({ success: true, row });
      }, 2500);
    } catch {
      return res.status(500).json({ error: "winner-log failed" });
    }
  }

  if (action === "winner-logs" && req.method === "GET") {
    try {
      let redisRows = [];
      try {
        await withRedis(async (r) => {
          const raw = await r.lRange("raffle:winners:all", -400, -1);
          redisRows = raw
            .map((s) => {
              try {
                return JSON.parse(s);
              } catch {
                return null;
              }
            })
            .filter(Boolean);
        }, 2500);
      } catch {}
      const memRows = Array.isArray(MEM.winners) ? MEM.winners : [];
      const fileRows = isLocal ? readLocalLedgerSafe() : [];

      const byId = new Map();
      for (const ro of [...redisRows, ...fileRows, ...memRows])
        if (ro && ro.id) byId.set(ro.id, ro);
      const rows = Array.from(byId.values())
        .sort((a, b) => new Date(b.ts) - new Date(a.ts))
        .slice(0, 200);

      noCache(res);
      return res.status(200).json({ rows });
    } catch {
      return res.status(500).json({ rows: [], error: "fetch failed" });
    }
  }

  // ────────────────────────────────────────────────────────────
  // FOLLOWERS / SOCIAL  (with dev fallback + cache)
  // ────────────────────────────────────────────────────────────
  if (action === "followers" && req.method === "GET") {
    const q = new URL(req.url, `http://${req.headers.host}`);
    const debug = String(q.searchParams.get("debug") || "") === "1";
    const reveal = String(q.searchParams.get("reveal") || "") === "1";

    const timedFetch = async (url, ms = 6000) => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), ms);
      try {
        const res2 = await fetch(url, { signal: ctl.signal });
        const json = await res2.json().catch(() => ({}));
        return { ok: res2.ok, status: res2.status, json };
      } catch (e) {
        return {
          ok: false,
          status: 0,
          json: { error: String(e?.message || e) },
        };
      } finally {
        clearTimeout(t);
      }
    };

    const mask = (t) => (t ? `${t.slice(0, 6)}…${t.slice(-4)}` : "");
    const tail = (t) => (t ? t.slice(-8) : "");

    const readCache = async () => {
      let fb = 0,
        ig = 0;
      try {
        await withRedis(async (r) => {
          fb = Number(await r.get("cache:fbFollowers")) || 0;
          ig = Number(await r.get("cache:igFollowers")) || 0;
        }, 1200);
      } catch {}
      return { fb, ig };
    };
    const writeCache = async (fb, ig) => {
      try {
        await withRedis(async (r) => {
          const ops = [];
          if (Number.isFinite(fb) && fb > 0)
            ops.push(r.set("cache:fbFollowers", String(fb), { EX: 600 }));
          if (Number.isFinite(ig) && ig > 0)
            ops.push(r.set("cache:igFollowers", String(ig), { EX: 600 }));
          if (ops.length) await Promise.all(ops);
        }, 1200);
      } catch {}
    };

    try {
      const token = (process.env.FB_PAGE_TOKEN || "").trim();
      const pageId = (process.env.FB_PAGE_ID || "").trim();
      let igId = (process.env.IG_ACCOUNT_ID || "").trim();

      // ⬇️ Local dev fallback: no token/page → return sample numbers
      if (isLocal && (!token || !pageId)) {
        const fbDev =
          Number(
            process.env.DEV_FB_FOLLOWERS || q.searchParams.get("fb") || 1234
          ) || 0;
        const igDev =
          Number(
            process.env.DEV_IG_FOLLOWERS || q.searchParams.get("ig") || 567
          ) || 0;
        try {
          await withRedis(async (r) => {
            await Promise.all([
              r.set("cache:fbFollowers", String(fbDev), { EX: 600 }),
              r.set("cache:igFollowers", String(igDev), { EX: 600 }),
            ]);
          }, 1200);
        } catch {}
        return res.status(200).json({
          facebook: fbDev,
          instagram: igDev,
          _dev: true,
          note: "Local dev fallback (no FB_PAGE_TOKEN / FB_PAGE_ID set).",
        });
      }

      const missing = [];
      if (!token) missing.push("FB_PAGE_TOKEN");
      if (!pageId) missing.push("FB_PAGE_ID");

      if (missing.length) {
        const cache = await readCache();
        const out = {
          facebook: cache.fb,
          instagram: cache.ig,
          error: "missing_env",
          missing,
          note: "Set env vars; IG id can be auto-discovered if the Page is linked.",
        };
        if (debug) out.tokenPreview = mask(token);
        return res.status(200).json(out);
      }

      // appsecret_proof (recommended)
      let proof = "";
      if (APP_SECRET && token) {
        proof = crypto
          .createHmac("sha256", APP_SECRET)
          .update(token)
          .digest("hex");
      }
      const ap = `access_token=${encodeURIComponent(token)}${
        proof ? `&appsecret_proof=${proof}` : ""
      }`;

      // 1) Page call
      const pageBase = `https://graph.facebook.com/v19.0/${encodeURIComponent(
        pageId
      )}`;
      const urlFull = `${pageBase}?fields=fan_count,followers_count,instagram_business_account&${ap}`;
      let pageRes = await timedFetch(urlFull, 6000);

      // Fallback fields if 400
      if (!pageRes.ok && pageRes.status === 400) {
        const urlFans = `${pageBase}?fields=fan_count,instagram_business_account&${ap}`;
        pageRes = await timedFetch(urlFans, 6000);
      }

      let facebookCount = 0;
      let pageDiag = { status: pageRes.status };
      if (pageRes.ok && pageRes.json) {
        const pj = pageRes.json || {};
        facebookCount = Number(pj.followers_count ?? pj.fan_count ?? 0) || 0;
        if (!igId && pj.instagram_business_account?.id)
          igId = String(pj.instagram_business_account.id);
        pageDiag = {
          status: pageRes.status,
          hasFollowers: "followers_count" in pj,
          hasFans: "fan_count" in pj,
          hasIGLink: !!igId,
        };
      } else {
        const cache = await readCache();
        const out = {
          facebook: cache.fb,
          instagram: cache.ig,
          error: "page_fetch_failed",
        };
        if (debug) {
          out.pageURL = urlFull;
          out.tokenPreview = mask(token);
          out.details = pageRes.json;
        }
        return res.status(200).json(out);
      }

      // 2) IG call (if not linked, return FB count + hint)
      if (!igId) {
        await writeCache(facebookCount, 0);
        const out = {
          facebook: facebookCount,
          instagram: 0,
          warn: "no_ig_account_id",
          hint: "Link the Page to an Instagram Professional account or set IG_ACCOUNT_ID.",
        };
        if (debug) {
          out.pageDiag = pageDiag;
          out.tokenPreview = mask(token);
        }
        return res.status(200).json(out);
      }

      const igURL = `https://graph.facebook.com/v19.0/${encodeURIComponent(
        igId
      )}?fields=followers_count,username&${ap}`;
      const igRes = await timedFetch(igURL, 6000);

      let instagramCount = 0;
      if (igRes.ok && igRes.json) {
        instagramCount = Number(igRes.json.followers_count ?? 0) || 0;
      } else {
        const cache = await readCache();
        const out = {
          facebook: facebookCount,
          instagram: cache.ig,
          error: "ig_fetch_failed",
        };
        if (debug) {
          out.igURL = igURL;
          out.pageDiag = pageDiag;
          out.details = igRes.json;
        }
        return res.status(200).json(out);
      }

      await writeCache(facebookCount, instagramCount);
      const out = { facebook: facebookCount, instagram: instagramCount };
      if (debug) {
        out.pageDiag = pageDiag;
        out.igId = igId;
      }
      return res.status(200).json(out);
    } catch (err) {
      return res.status(200).json({
        facebook: 0,
        instagram: 0,
        error: "exception",
        message: String(err?.message || err),
      });
    }
  }

  if (req.method === "GET" && action === "check-follow") {
    try {
      return await withRedis(async (r) => {
        const { windowKey } = await getWindowInfo(r);
        const ip =
          req.headers["x-forwarded-for"]?.split(",")[0] ||
          req.socket.remoteAddress ||
          "unknown";
        let raw = null;
        try {
          raw = await r.get(`social:${windowKey}:${ip}`);
        } catch {}
        if (!raw)
          try {
            raw = await r.get(`social:${ip}`);
          } catch {}
        return res.status(200).json({ allowed: isFollowAllowed(raw) });
      }, 2000);
    } catch {
      return res.status(200).json({ allowed: false });
    }
  }

  if (
    (req.method === "POST" || req.method === "GET") &&
    action === "mark-follow"
  ) {
    try {
      return await withRedis(async (r) => {
        let platform =
          new URL(req.url, `http://${req.headers.host}`).searchParams.get(
            "platform"
          ) ||
          (typeof req.body === "object" && req.body ? req.body.platform : null);
        platform = (platform || "").toString().trim().toLowerCase();
        if (platform !== "fb" && platform !== "ig")
          return res.status(400).json({ error: "Invalid platform" });

        const { windowKey, ttlSeconds } = await getWindowInfo(r);
        const ip =
          req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
          req.socket.remoteAddress ||
          "unknown";

        const lockKey = `social:lock:${windowKey}:${ip}`;
        try {
          const got = await r.set(lockKey, platform, { NX: true, PX: 1000 });
          if (!got)
            return res.status(200).json({ success: true, throttled: true });
        } catch {}

        const key = `social:${windowKey}:${ip}`;
        const setKey = `social:ips:${windowKey}`;
        const now = new Date().toISOString();

        let state = {
          firstSeen: now,
          lastSeen: now,
          followed: true,
          count: 0,
          platforms: { fb: false, ig: false },
        };
        try {
          const prev = await r.get(key);
          if (prev) {
            try {
              const p = JSON.parse(prev);
              state.firstSeen = p.firstSeen || state.firstSeen;
              state.count = Number(p.count || 0);
              state.platforms = {
                fb: !!p.platforms?.fb,
                ig: !!p.platforms?.ig,
              };
            } catch {}
          }
        } catch {}

        state.lastSeen = now;
        state.followed = true;
        state.count += 1;
        state.platforms[platform] = true;

        await r.set(key, JSON.stringify(state), { EX: ttlSeconds });
        await r.sAdd(setKey, ip);

        return res.status(200).json({ success: true, state });
      }, 2500);
    } catch {
      return res.status(503).json({ error: "Redis not ready" });
    }
  }

  if (action === "slot-spins-version" && req.method === "GET") {
    try {
      return await withRedis(async (r) => {
        const v =
          Number(await r.get("slot:spinsResetVersion").catch(() => 0)) || 0;
        return res.status(200).json({ version: v });
      }, 2000);
    } catch {
      return res.status(200).json({ version: 0 });
    }
  }
  if (action === "reset-slot-spins" && req.method === "POST") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    try {
      return await withRedis(async (r) => {
        const version = await r.incr("slot:spinsResetVersion");
        await r.set("slot:spinsResetAt", new Date().toISOString(), {
          EX: 60 * 60 * 24 * 7,
        });
        return res.status(200).json({ success: true, version });
      }, 2500);
    } catch {
      return res.status(503).json({ error: "Redis not ready" });
    }
  }

  /* ────────────────────────────────────────────────────────────
     SHUTDOWN toggle
  ───────────────────────────────────────────────────────────── */
  if (req.method === "GET" && action === "shutdown-status") {
    try {
      return await withRedis(async (r) => {
        const raw = await r.get("shutdown").catch(() => null);
        const isShutdownFlag = raw === "true";
        return res.status(200).json({ isShutdown: isShutdownFlag });
      }, 2000);
    } catch {
      return res.status(200).json({ isShutdown: false, _warning: "fallback" });
    }
  }

  if (req.method === "POST" && action === "toggle-shutdown") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    try {
      return await withRedis(async (r) => {
        const current = await r.get("shutdown");
        const newStatus = current !== "true";
        await r.set("shutdown", newStatus ? "true" : "false");
        return res.status(200).json({ success: true, isShutdown: newStatus });
      }, 2500);
    } catch {
      return res.status(503).json({ error: "Redis not ready" });
    }
  }

  if (req.method === "POST" && action === "shutdown") {
    if (!isSuperAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    try {
      return await withRedis(async (r) => {
        let body = {};
        try {
          body = await readJson(req);
        } catch {}
        let { enabled, toggle } = body;
        if (typeof enabled === "undefined") {
          if (toggle) {
            const cur = await isShutdown(r);
            enabled = !cur;
          } else {
            enabled = true;
          }
        }
        await r.set("shutdown", enabled ? "1" : "0");
        return res.status(200).json({ ok: true, enabled });
      }, 2500);
    } catch {
      return res.status(503).json({ error: "Redis unavailable" });
    }
  }

  if (action === "auto-pick-status" && req.method === "GET") {
    try {
      return await withRedis(async (r) => {
        let [autoPickAt, armed, winner, noWinner] = ["", "false", null, false];
        [autoPickAt, armed] = await Promise.all([
          r.get("autoPickAt").catch(() => ""),
          r.get("autoPickArmed").catch(() => "false"),
        ]);
        try {
          const w = await r.get("raffle_winner");
          winner = w ? JSON.parse(w) : null;
        } catch {}
        try {
          const f = await r.get("raffle_no_winner");
          noWinner = f === "true";
        } catch {}
        return res.status(200).json({
          autoPickAt,
          armed: armed === "true",
          now: new Date().toISOString(),
          alreadyPicked: !!winner || noWinner,
          winner,
          noWinner,
        });
      }, 2500);
    } catch {
      return res.status(200).json({
        autoPickAt: "",
        armed: false,
        now: new Date().toISOString(),
        alreadyPicked: !!MEM.currentWinner || !!MEM.noWinner,
        winner: MEM.currentWinner ? { name: MEM.currentWinner } : null,
        noWinner: !!MEM.noWinner,
      });
    }
  }

  // SLOT → prize-log (log email as display name)
  if (
    action === "prize-log" &&
    (req.method === "POST" || req.method === "GET")
  ) {
    try {
      return await withRedis(async (r) => {
        const { windowKey } = await getWindowInfo(r);
        const body = req.body && typeof req.body === "object" ? req.body : {};

        const email = (body.email || "").toString().trim().toLowerCase();
        const targets = Array.isArray(body.targets)
          ? body.targets.map(String)
          : [];
        const explicit = body.jackpot === true || body.jackpot === "true";
        const isJackpot = detectJackpot(targets, explicit);

        if (!isJackpot) {
          noCache(res);
          return res
            .status(200)
            .json({ success: true, ignored: true, isJackpot: false });
        }

        const prizeName = targets[0]?.trim() || "Jackpot";
        const display = email || "(anonymous)"; // ← use email as “name”

        const row = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: display,
          prize: `${prizeName}`,
          source: "slot",
          windowKey,
          ts: new Date().toISOString(),
        };

        await appendWinnerRow(r, row);
        noCache(res);
        return res.status(200).json({ success: true, isJackpot: true, row });
      }, 3000);
    } catch {
      return res.status(503).json({ success: false, error: "Redis not ready" });
    }
  }

  // BONUS ENTRY — for "Extra Entry" jackpots (email only; bumps total counter)
  if (action === "bonus-entry" && req.method === "POST") {
    try {
      return await withRedis(async (r) => {
        const rawEmail = (req.body?.email || "")
          .toString()
          .trim()
          .toLowerCase();
        if (!rawEmail || !/.+@.+\..+/.test(rawEmail)) {
          return res.status(400).json({ error: "Missing or invalid email" });
        }

        const ip =
          req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
          req.socket.remoteAddress ||
          "unknown";

        const { windowKey, ttlSeconds } = await getWindowInfo(r);
        const listKey = `raffle:entries:${windowKey}`;
        const totalKey = `raffle:total:${windowKey}`;
        const bonusKey = `raffle:bonus:${windowKey}:${ip}`;

        // Store email in both fields for backward-compat display
        const entry = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: rawEmail,
          email: rawEmail,
          ip,
          source: "jackpot-bonus",
          createdTime: new Date().toISOString(),
        };

        await r
          .multi()
          .rPush(listKey, JSON.stringify(entry))
          .expire(listKey, ttlSeconds)
          .incr(bonusKey)
          .expire(bonusKey, ttlSeconds)
          .incr(totalKey)
          .expire(totalKey, ttlSeconds) // ← bump the counter
          .exec();

        return res.status(200).json({ success: true, entry });
      }, 3000);
    } catch {
      return res.status(503).json({ error: "Redis not ready" });
    }
  }

  // POLL: get songs
  if (action === "poll" && req.method === "GET") {
    try {
      return await withRedis(async (r) => {
        const pollId = String(
          new URL(req.url, `http://${req.headers.host}`).searchParams.get(
            "pollId"
          ) || "top10"
        );
        const raw = await r.get(`poll:songs:${pollId}`);
        let songs = [];
        try {
          const v = JSON.parse(raw || "[]");
          songs = Array.isArray(v) ? v : [];
        } catch {}
        noCache(res);
        return res.status(200).json({ pollId, songs });
      }, 2500);
    } catch {
      return res.status(200).json({ pollId: "top10", songs: [] });
    }
  }

  /* POLL: setup songs */
  if (action === "poll-setup" && req.method === "POST") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    try {
      return await withRedis(async (r) => {
        const { pollId = "top10", songs = [] } = req.body || {};
        if (!Array.isArray(songs) || songs.length === 0)
          return res
            .status(400)
            .json({ error: "songs must be a non-empty array" });

        const norm = songs
          .map((s, i) => ({
            id: String(
              s.id ??
                s.slug ??
                s.title?.toLowerCase().replace(/[^a-z0-9]+/g, "-") ??
                i + 1
            ),
            title: String(s.title || "").trim(),
            artist: s.artist ? String(s.artist).trim() : "",
          }))
          .filter((s) => s.id && s.title);

        await r.set(`poll:songs:${pollId}`, JSON.stringify(norm));
        noCache(res);
        return res
          .status(200)
          .json({ ok: true, pollId, count: norm.length, songs: norm });
      }, 3000);
    } catch {
      return res.status(503).json({ error: "Redis not ready" });
    }
  }

  /* POLL: vote */
  if (action === "poll-vote" && req.method === "POST") {
    try {
      return await withRedis(async (r) => {
        const {
          pollId = "top10",
          picks,
          songId,
          clientId = "",
          name = "",
        } = req.body || {};
        let chosen = Array.isArray(picks) ? picks.map(String) : [];
        if (!chosen.length && songId) chosen = [String(songId)];
        chosen = Array.from(new Set(chosen)).slice(0, 3);
        if (chosen.length === 0)
          return res.status(400).json({ error: "No picks" });

        // Validate picks against configured songs
        let songs = [];
        try {
          const raw = await r.get(`poll:songs:${pollId}`);
          const arr = JSON.parse(raw || "[]");
          if (Array.isArray(arr)) songs = arr;
        } catch {}
        const valid = new Set(songs.map((s) => String(s.id || "")));
        if (!chosen.every((id) => valid.has(id)))
          return res.status(400).json({ error: "Invalid pick(s)" });

        const ip =
          req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
          req.socket.remoteAddress ||
          "unknown";

        // Use configured window
        const { windowKey, ttlSeconds, startTime, endTime } =
          await getWindowInfo(r);
        const now = Date.now();
        const startMs = parseMs(startTime || "");
        const endMs = parseMs(endTime || "");
        const IS_LIVE =
          Number.isFinite(startMs) &&
          Number.isFinite(endMs) &&
          now >= startMs &&
          now <= endMs;

        const voterToken = clientId ? `${ip}:${clientId}` : ip;

        const dedupeKey = `poll:voted:${windowKey}:${pollId}`;
        const ballotsKey = `poll:ballots:${windowKey}:${pollId}`;
        const listKey = `raffle:entries:${windowKey}`;
        const totalKey = `raffle:total:${windowKey}`; // NEW
        const bonusKey = `raffle:bonus:${windowKey}:${ip}`;

        const already = await r.sIsMember(dedupeKey, voterToken);
        if (already)
          return res.status(200).json({ ok: true, alreadyVoted: true });

        const displayName = (name || "").toString().trim().slice(0, 80);

        const pipe = r.multi();

        // increment vote counters (scoped to window) + TTL
        for (const id of chosen) {
          const vk = `poll:votes:${windowKey}:${pollId}:${id}`;
          pipe.incr(vk);
          pipe.expire(vk, ttlSeconds);
        }

        // lock this voter
        pipe.sAdd(dedupeKey, voterToken);
        pipe.expire(dedupeKey, ttlSeconds);

        // store ballot (for audit)
        pipe.rPush(
          ballotsKey,
          JSON.stringify({
            at: new Date().toISOString(),
            ip,
            clientId,
            name: displayName,
            picks: chosen,
          })
        );
        pipe.expire(ballotsKey, ttlSeconds);

        // BONUS ENTRY ONLY WHEN WITHIN WINDOW
        let bonusGranted = false;
        if (IS_LIVE && displayName) {
          pipe.rPush(
            listKey,
            JSON.stringify({
              id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
              name: displayName,
              ip,
              source: "poll-bonus",
              createdTime: new Date().toISOString(),
            })
          );
          pipe.expire(listKey, ttlSeconds);

          pipe.incr(totalKey); // NEW: total counter
          pipe.expire(totalKey, ttlSeconds); // NEW

          pipe.incr(bonusKey);
          pipe.expire(bonusKey, ttlSeconds);
          bonusGranted = true;
        }

        await pipe.exec();
        noCache(res);
        return res
          .status(200)
          .json({ ok: true, picks: chosen, bonus: bonusGranted });
      }, 3500);
    } catch {
      return res.status(503).json({ error: "Redis not ready" });
    }
  }

  /* POLL: results */
  if (action === "poll-results" && req.method === "GET") {
    try {
      return await withRedis(async (r) => {
        const pollId = String(
          new URL(req.url, `http://${req.headers.host}`).searchParams.get(
            "pollId"
          ) || "top10"
        );
        let songs = [];
        try {
          const raw = await r.get(`poll:songs:${pollId}`);
          const arr = JSON.parse(raw || "[]");
          if (Array.isArray(arr)) songs = arr;
        } catch {}

        const { windowKey } = await getWindowInfo(r);
        let counts = {};
        if (songs.length) {
          const keys = songs.map(
            (s) => `poll:votes:${windowKey}:${pollId}:${s.id}`
          );
          const vals = await r.mGet(keys);
          counts = Object.fromEntries(
            songs.map((s, i) => [s.id, Number(vals?.[i] || 0)])
          );
        }

        const order = [...songs]
          .sort(
            (a, b) =>
              Number(counts[b.id] || 0) - Number(counts[a.id] || 0) ||
              a.title.localeCompare(b.title)
          )
          .map((s) => s.id);

        noCache(res);
        return res.status(200).json({ pollId, counts, order, songs });
      }, 2500);
    } catch {
      return res
        .status(200)
        .json({ pollId: "top10", counts: {}, order: [], songs: [] });
    }
  }

  /* POLL: reset voters ONLY (keep counts) */
  if (action === "poll-reset-voters" && req.method === "POST") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    try {
      return await withRedis(async (r) => {
        const {
          pollId = "top10",
          scope = "all",
          clientId = "",
        } = req.body || {};
        const { windowKey } = await getWindowInfo(r);
        const dedupeKey = `poll:voted:${windowKey}:${pollId}`;
        const ip =
          req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
          req.socket.remoteAddress ||
          "unknown";

        if (scope === "all") {
          try {
            await r.unlink(dedupeKey);
          } catch {
            await r.del(dedupeKey).catch(() => {});
          }
          return res
            .status(200)
            .json({ ok: true, scope: "all", pollId, windowKey });
        }
        const token = scope === "token" && clientId ? `${ip}:${clientId}` : ip;
        const removed = await r.sRem(dedupeKey, token).catch(() => 0);
        return res.status(200).json({
          ok: true,
          scope: scope === "token" ? "token" : "ip",
          removed,
          pollId,
          windowKey,
          token,
        });
      }, 3000);
    } catch {
      return res.status(503).json({ ok: false, error: "Redis not ready" });
    }
  }

  /* POLL: HARD RESET — delete legacy/broad vote keys (admin) */
  if (action === "poll-hard-reset" && req.method === "POST") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    try {
      return await withRedis(async (r) => {
        const patterns = [
          "poll:votes:*",
          "poll:ballots:*",
          "poll:voted:*",
          "poll:*vote*",
          "poll:*ballot*",
          "*poll*votes*",
          "*poll*voted*",
          "votes:*",
          "ballots:*",
          "voted:*",
        ];

        const toDelete = new Set();
        for (const p of patterns) {
          const keys = await scanKeys(r, p, { budgetMs: 900, limit: 20000 });
          for (const k of keys)
            if (!k.startsWith("poll:songs:")) toDelete.add(k);
        }

        let deleted = 0;
        for (const k of toDelete) {
          try {
            deleted += (await r.unlink(k)) || 0;
          } catch {
            try {
              deleted += (await r.del(k)) || 0;
            } catch {}
          }
        }

        const [remVotes, remBallots, remVoted] = await Promise.all([
          scanKeys(r, "*votes*", { budgetMs: 700 }),
          scanKeys(r, "*ballot*", { budgetMs: 700 }),
          scanKeys(r, "*voted*", { budgetMs: 700 }),
        ]);

        return res.status(200).json({
          success: true,
          deletedKeys: deleted,
          matchedCount: toDelete.size,
          remainingCounts: {
            votes: remVotes.filter((k) => !k.startsWith("poll:songs:")).length,
            ballots: remBallots.filter((k) => !k.startsWith("poll:songs:"))
              .length,
            votedLocks: remVoted.filter((k) => !k.startsWith("poll:songs:"))
              .length,
          },
          note: "Legacy/broad poll keys cleared. poll:songs preserved.",
        });
      }, 8000);
    } catch {
      return res.status(503).json({ error: "Redis not ready" });
    }
  }

  /* POLL: DUMP — broad scan */
  if (action === "poll-dump" && req.method === "GET") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    try {
      return await withRedis(async (r) => {
        const patterns = [
          "poll:votes:*",
          "poll:ballots:*",
          "poll:voted:*",
          "poll:*vote*",
          "poll:*ballot*",
          "*poll*votes*",
          "*poll*voted*",
          "*poll*ballot*",
          "votes:*",
          "ballots:*",
          "voted:*",
        ];

        const found = new Set();
        for (const p of patterns) {
          const keys = await scanKeys(r, p, { budgetMs: 900, limit: 20000 });
          for (const k of keys) found.add(k);
        }

        const describe = async (k) => {
          let type = "unknown",
            ttl = null,
            size = null,
            sample = null;
          try {
            type = await r.type(k);
          } catch {}
          try {
            ttl = await r.ttl(k);
          } catch {}
          try {
            if (type === "string") {
              sample = await r.get(k);
              size = sample ? sample.length : 0;
              if (sample && sample.length > 120)
                sample = sample.slice(0, 120) + "…";
            } else if (type === "list") {
              size = await r.lLen(k);
              const head = await r.lRange(k, 0, 1);
              sample =
                head && head[0]
                  ? head[0].length > 120
                    ? head[0].slice(0, 120) + "…"
                    : head[0]
                  : null;
            } else if (type === "set") {
              size = await r.sCard(k);
              const members = await r.sMembers(k);
              sample = members && members[0] ? members[0] : null;
            } else if (type === "zset") {
              size = await r.zCard(k);
            } else if (type === "hash") {
              size = await r.hLen(k);
            }
          } catch {}
          return { key: k, type, size, ttl, sample };
        };

        const all = Array.from(found);
        const sampleDesc = [];
        for (const k of all.slice(0, 50)) sampleDesc.push(await describe(k));

        const counts = { votes: 0, ballots: 0, voted: 0, other: 0 };
        for (const k of all) {
          if (k.includes(":votes:") || /(^|:)votes(:|$)/.test(k))
            counts.votes++;
          else if (k.includes(":ballots:") || /(^|:)ballots(:|$)/.test(k))
            counts.ballots++;
          else if (k.includes(":voted:") || /(^|:)voted(:|$)/.test(k))
            counts.voted++;
          else counts.other++;
        }

        noCache(res);
        return res
          .status(200)
          .json({ totalKeys: all.length, counts, sample: sampleDesc });
      }, 6000);
    } catch {
      return res.status(503).json({ error: "Redis not ready" });
    }
  }

  if (req.method === "GET" && action === "env-dump") {
    const mask = (t) =>
      t ? `${String(t).slice(0, 6)}…${String(t).slice(-4)}` : "";
    return res.status(200).json({
      envSeen: {
        FB_PAGE_ID: process.env.FB_PAGE_ID || null,
        IG_ACCOUNT_ID: process.env.IG_ACCOUNT_ID || null,
        FB_PAGE_TOKEN_present: !!process.env.FB_PAGE_TOKEN,
        FB_PAGE_TOKEN_preview: process.env.FB_PAGE_TOKEN
          ? mask(process.env.FB_PAGE_TOKEN)
          : null,
        NODE_ENV: process.env.NODE_ENV,
        VERCEL: !!process.env.VERCEL,
        CWD: process.cwd(),
      },
    });
  }

  /* ───── UNKNOWN ───── */
  return res.status(400).json({ error: "Invalid action or method" });
}