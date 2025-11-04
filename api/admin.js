// /api/admin.js
import fs from "fs";
import path from "path";
import crypto from "crypto";
import dns from "dns";
import { createClient } from "redis";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import 'dotenv/config';

try {
  dns.setDefaultResultOrder?.("ipv4first");
} catch {}

export const config = { runtime: "nodejs" };

/* ──────────────────────────────────────────────
   ENVIRONMENT + GLOBAL SETTINGS
────────────────────────────────────────────── */
const ADMIN_PASS = process.env.ADMIN_PASS || "";
const MODERATOR_PASS = process.env.MODERATOR_PASS || "";
const REDIS_URL = process.env.REDIS_URL || "";
const R2_BUCKET = process.env.R2_BUCKET || "";
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || "";
const IS_LOCAL =
  (!process.env.VERCEL && process.env.NODE_ENV !== "production") ||
  process.env.VERCEL_ENV === "development";

/* ──────────────────────────────────────────────
   REDIS INITIALIZATION (GLOBAL SINGLETON)
────────────────────────────────────────────── */
let redis;

if (!globalThis.__redis) {
  const client = createClient({
    url: process.env.REDIS_URL,
    socket: {
      tls: false,          // redis:// uses plain TCP
      family: 4,           // force IPv4 on macOS
      connectTimeout: 15000,
      keepAlive: 5000,
    },
  });

  client.on("error", (err) => {
    console.error("❌ Redis error:", err.message);
  });

  client
    .connect()
    .then(() => console.log("✅ Redis connected"))
    .catch((err) => console.error("❌ Redis connection failed:", err));

  globalThis.__redis = client;
}

redis = globalThis.__redis;


async function ensureRedisConnected() {
  if (!redis?.isOpen) {
    console.warn("🔄 Reconnecting Redis...");
    try {
      await redis.connect();
    } catch (err) {
      console.error("❌ Redis reconnect failed:", err.message);
    }
  }
}

async function withRedis(op, timeoutMs = 5000) {
  await ensureRedisConnected();
  const task = op(redis);
  return await Promise.race([
    task,
    new Promise((_, rej) => setTimeout(() => rej(new Error("Redis op timeout")), timeoutMs)),
  ]);
}


/* ──────────────────────────────────────────────
   CLOUDFLARE R2 CLIENT
────────────────────────────────────────────── */
const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

/* ──────────────────────────────────────────────
   HELPERS
────────────────────────────────────────────── */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
function noCache(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}
function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function detectJackpot(targets = [], clientFlag = false) {
  if (clientFlag) return true;
  const norm = targets.map((s) => s.toLowerCase().trim()).filter(Boolean);
  if (norm.length >= 3 && new Set(norm.slice(0, 3)).size === 1) return true;
  if (norm.join(" ").includes("jackpot")) return true;
  return false;
}
function isAdmin(req) {
  const h = req.headers.authorization || "";
  return !!ADMIN_PASS && h === `Bearer:super:${ADMIN_PASS}`;
}
function isModerator(req) {
  const h = req.headers.authorization || "";
  return !!MODERATOR_PASS && h === `Bearer:mod:${MODERATOR_PASS}`;
}
async function scanKeys(r, pattern, { count = 500, limit = 10000 } = {}) {
  let keys = [];
  let cursor = "0";
  do {
    const reply = await r.scan(cursor, { MATCH: pattern, COUNT: count });
    cursor = Array.isArray(reply) ? reply[0] : reply.cursor;
    const batch = Array.isArray(reply) ? reply[1] : reply.keys;
    for (const k of batch) {
      keys.push(k);
      if (keys.length >= limit) return keys;
    }
  } while (cursor !== "0");
  return keys;
}

/* ──────────────────────────────────────────────
   MAIN HANDLER
────────────────────────────────────────────── */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get("action");

  /* ─────────────── AUTH: LOGIN ─────────────── */
  if (action === "login" && req.method === "POST") {
    const body = await new Promise((resolve) => {
      let buf = "";
      req.on("data", (c) => (buf += c));
      req.on("end", () => resolve(parseJson(buf) || {}));
    });
    const { password } = body;
    if (password === ADMIN_PASS) return res.json({ success: true, role: "admin" });
    if (password === MODERATOR_PASS) return res.json({ success: true, role: "moderator" });
    return res.status(401).json({ success: false, error: "Invalid password" });
  }

  /* ──────────────────────────────────────────────
     RAFFLE: ENTRIES / WINNER / RESET / JACKPOT
  ─────────────────────────────────────────────── */
  if (action === "enter" && req.method === "POST") {
    try {
      const body = await new Promise((resolve) => {
        let buf = "";
        req.on("data", (c) => (buf += c));
        req.on("end", () => resolve(parseJson(buf) || {}));
      });
      const rawEmail = (body.email || "").toLowerCase().trim();
      const name = (body.name || "").trim();
      const source = (body.source || "base").toLowerCase();
      const ip =
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        req.socket.remoteAddress ||
        "unknown";
      if (!rawEmail || !/.+@.+\..+/.test(rawEmail))
        return res.status(400).json({ error: "Invalid email" });

      return await withRedis(async (r) => {
        const entry = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name,
          email: rawEmail,
          ip,
          source,
          createdTime: new Date().toISOString(),
        };
        await r.lPush("uploads", JSON.stringify(entry));
        return res.status(200).json({ success: true, entry });
      });
    } catch (err) {
      console.error("enter failed:", err);
      return res.status(500).json({ error: "entry failed" });
    }
  }

  if (action === "entries" && req.method === "GET") {
    try {
      return await withRedis(async (r) => {
        const raw = await r.lRange("uploads", 0, -1);
        const entries = raw.map(parseJson).filter((x) => x && x.email && x.name);
        return res.json({ count: entries.length, rows: entries });
      });
    } catch (err) {
      console.error("entries failed:", err);
      return res.json({ count: 0, rows: [] });
    }
  }

  if (action === "pick-winner" && req.method === "POST") {
    const body = await new Promise((resolve) => {
      let buf = "";
      req.on("data", (c) => (buf += c));
      req.on("end", () => resolve(parseJson(buf) || {}));
    });
    const { role } = body;
    if (role !== "admin" && role !== "moderator")
      return res.status(403).json({ error: "Forbidden" });
    return await withRedis(async (r) => {
      const raw = await r.lRange("uploads", 0, -1);
      const entries = raw.map(parseJson).filter((x) => x && x.email && x.name);
      if (!entries.length) return res.status(404).json({ error: "No entries" });
      const winner = entries[Math.floor(Math.random() * entries.length)];
      await r.set("raffle_winner", JSON.stringify(winner));
      return res.json({ success: true, winner });
    });
  }

  if (action === "winner" && req.method === "GET") {
    try {
      return await withRedis(async (r) => {
        const val = await r.get("raffle_winner");
        return res.json({ winner: val ? JSON.parse(val) : null });
      });
    } catch {
      return res.json({ winner: null });
    }
  }

  if (action === "reset-winner" && req.method === "POST") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    try {
      await withRedis((r) => r.del("raffle_winner"));
      return res.json({ success: true });
    } catch {
      return res.json({ success: false });
    }
  }

  /* ──────────────────────────────────────────────
     SLOT MACHINE / JACKPOT PRIZE LOG
  ─────────────────────────────────────────────── */
  if (action === "prize-log" && req.method === "POST") {
    try {
      const body = await new Promise((resolve) => {
        let buf = "";
        req.on("data", (c) => (buf += c));
        req.on("end", () => resolve(parseJson(buf) || {}));
      });
      const { email = "", targets = [], jackpot = false } = body;
      const lower = (email || "").toLowerCase().trim();
      const isJackpot = detectJackpot(targets, jackpot);
      if (!isJackpot) return res.json({ success: true, ignored: true });
      return await withRedis(async (r) => {
        const entry = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: lower || "(anonymous)",
          prize: targets[0] || "Jackpot",
          source: "slot",
          createdTime: new Date().toISOString(),
        };
        await r.rPush("raffle:winners:all", JSON.stringify(entry));
        return res.json({ success: true, jackpot: true, entry });
      });
    } catch (err) {
      console.error("prize-log error", err);
      return res.status(500).json({ success: false });
    }
  }

  if (action === "bonus-entry" && req.method === "POST") {
    try {
      const body = await new Promise((resolve) => {
        let buf = "";
        req.on("data", (c) => (buf += c));
        req.on("end", () => resolve(parseJson(buf) || {}));
      });
      const email = (body.email || "").toLowerCase().trim();
      if (!email) return res.status(400).json({ error: "missing email" });
      return await withRedis(async (r) => {
        const entry = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: email,
          email,
          source: "bonus",
          createdTime: new Date().toISOString(),
        };
        await r.lPush("uploads", JSON.stringify(entry));
        return res.json({ success: true, entry });
      });
    } catch (err) {
      console.error("bonus-entry failed", err);
      return res.status(500).json({ error: "failed" });
    }
  }

  /* ──────────────────────────────────────────────
     WINNERS LOG (LIST)
  ─────────────────────────────────────────────── */
  if (action === "winner-logs" && req.method === "GET") {
    try {
      return await withRedis(async (r) => {
        const raw = await r.lRange("raffle:winners:all", -200, -1);
        const rows = raw.map(parseJson).filter(Boolean).reverse();
        return res.json({ count: rows.length, rows });
      });
    } catch {
      return res.json({ count: 0, rows: [] });
    }
  }

    /* ──────────────────────────────────────────────
     POLL SYSTEM
  ─────────────────────────────────────────────── */
  if (action === "poll" && req.method === "GET") {
    try {
      return await withRedis(async (r) => {
        const pollId = url.searchParams.get("pollId") || "top10";
        const raw = await r.get(`poll:songs:${pollId}`);
        const songs = parseJson(raw) || [];
        noCache(res);
        return res.json({ pollId, songs });
      });
    } catch {
      return res.json({ pollId: "top10", songs: [] });
    }
  }

  if (action === "poll-setup" && req.method === "POST") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    const body = await new Promise((resolve) => {
      let buf = "";
      req.on("data", (c) => (buf += c));
      req.on("end", () => resolve(parseJson(buf) || {}));
    });
    const { pollId = "top10", songs = [] } = body;
    if (!Array.isArray(songs) || !songs.length)
      return res.status(400).json({ error: "songs array required" });
    try {
      return await withRedis(async (r) => {
        await r.set(`poll:songs:${pollId}`, JSON.stringify(songs));
        return res.json({ ok: true, count: songs.length });
      });
    } catch {
      return res.status(500).json({ error: "poll setup failed" });
    }
  }

  if (action === "poll-vote" && req.method === "POST") {
    const body = await new Promise((resolve) => {
      let buf = "";
      req.on("data", (c) => (buf += c));
      req.on("end", () => resolve(parseJson(buf) || {}));
    });
    const { pollId = "top10", picks = [], name = "", clientId = "" } = body;
    const chosen = Array.from(new Set(picks)).slice(0, 3);
    if (!chosen.length) return res.status(400).json({ error: "no picks" });
    try {
      return await withRedis(async (r) => {
        const voter = `${req.socket.remoteAddress || "unknown"}:${clientId}`;
        const dedupeKey = `poll:voted:${pollId}`;
        const already = await r.sIsMember(dedupeKey, voter);
        if (already) return res.json({ ok: true, already: true });

        const pipe = r.multi();
        for (const id of chosen) {
          const key = `poll:votes:${pollId}:${id}`;
          pipe.incr(key);
          pipe.expire(key, 60 * 60 * 24 * 14);
        }
        pipe.sAdd(dedupeKey, voter);
        pipe.expire(dedupeKey, 60 * 60 * 24 * 14);
        pipe.exec();
        return res.json({ ok: true, picks: chosen });
      });
    } catch {
      return res.status(500).json({ error: "vote failed" });
    }
  }

  if (action === "poll-results" && req.method === "GET") {
    try {
      return await withRedis(async (r) => {
        const pollId = url.searchParams.get("pollId") || "top10";
        const songs = parseJson(await r.get(`poll:songs:${pollId}`)) || [];
        const keys = songs.map((s) => `poll:votes:${pollId}:${s.id}`);
        const vals = await r.mGet(keys);
        const counts = Object.fromEntries(
          songs.map((s, i) => [s.id, Number(vals?.[i] || 0)])
        );
        noCache(res);
        return res.json({ pollId, counts, songs });
      });
    } catch {
      return res.json({ pollId: "top10", counts: {}, songs: [] });
    }
  }

  /* ──────────────────────────────────────────────
     SOCIAL / FOLLOW STATUS
  ─────────────────────────────────────────────── */
  if (action === "mark-follow" && req.method === "POST") {
    try {
      const body = await new Promise((resolve) => {
        let buf = "";
        req.on("data", (c) => (buf += c));
        req.on("end", () => resolve(parseJson(buf) || {}));
      });
      const { platform } = body;
      const ip =
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        req.socket.remoteAddress ||
        "unknown";
      return await withRedis(async (r) => {
        const key = `social:${ip}`;
        const raw = await r.get(key);
        let s = parseJson(raw) || { followed: false, platforms: {} };
        s.followed = true;
        s.platforms[platform] = true;
        s.lastSeen = new Date().toISOString();
        await r.set(key, JSON.stringify(s), { EX: 60 * 60 * 24 });
        return res.json({ success: true, state: s });
      });
    } catch {
      return res.status(500).json({ error: "social update failed" });
    }
  }

  if (action === "check-follow" && req.method === "GET") {
    try {
      return await withRedis(async (r) => {
        const ip =
          req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
          req.socket.remoteAddress ||
          "unknown";
        const raw = await r.get(`social:${ip}`);
        const s = parseJson(raw);
        return res.json({ allowed: !!s?.followed });
      });
    } catch {
      return res.json({ allowed: false });
    }
  }

  /* ──────────────────────────────────────────────
     UPLOADS + CONTACTS EXPORT
  ─────────────────────────────────────────────── */
  if (action === "uploads-with-email" && req.method === "GET") {
    try {
      return await withRedis(async (r) => {
        const raw = await r.lRange("uploads", 0, -1);
        const rows = raw.map(parseJson).filter((x) => x && x.email);
        return res.json({ count: rows.length, rows });
      });
    } catch {
      return res.json({ count: 0, rows: [] });
    }
  }

  if (action === "contacts" && req.method === "GET") {
    try {
      return await withRedis(async (r) => {
        const raw = await r.lRange("uploads", 0, -1);
        const unique = new Map();
        for (const s of raw) {
          const e = parseJson(s);
          if (e?.email) unique.set(e.email, e);
        }
        return res.json({ count: unique.size, contacts: Array.from(unique.values()) });
      });
    } catch {
      return res.json({ count: 0, contacts: [] });
    }
  }

  /* ──────────────────────────────────────────────
     SHUTDOWN / REDIS STATUS / WARM-UP
  ─────────────────────────────────────────────── */
  if (action === "shutdown-status" && req.method === "GET") {
    try {
      const flag = await withRedis((r) => r.get("shutdown"));
      return res.json({ isShutdown: flag === "true" });
    } catch {
      return res.json({ isShutdown: false });
    }
  }

  if (action === "toggle-shutdown" && req.method === "POST") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    try {
      return await withRedis(async (r) => {
        const cur = await r.get("shutdown");
        const newVal = cur === "true" ? "false" : "true";
        await r.set("shutdown", newVal);
        return res.json({ success: true, isShutdown: newVal === "true" });
      });
    } catch {
      return res.status(500).json({ error: "Redis unavailable" });
    }
  }

  if (action === "redis-status" && req.method === "GET") {
    try {
      return await withRedis(async (r) => {
        const t0 = Date.now();
        await r.ping();
        return res.json({ status: "ok", pingMs: Date.now() - t0 });
      });
    } catch {
      return res.json({ status: "offline" });
    }
  }

  if (action === "warm-redis" && req.method === "POST") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    try {
      await withRedis((r) => r.set("lastWarmAt", new Date().toISOString()));
      return res.json({ success: true });
    } catch {
      return res.status(500).json({ error: "warm failed" });
    }
  }

  /* ──────────────────────────────────────────────
     DUMP UPLOADS (DEBUG)
  ─────────────────────────────────────────────── */
  if (action === "dump-uploads" && req.method === "GET") {
    try {
      await ensureRedisConnected();
      const uploads = await redis.lRange("uploads", 0, -1);
      const parsed = uploads.map(parseJson).filter(Boolean);
      return res.json({ count: parsed.length, rows: parsed });
    } catch (err) {
      console.error("dump-uploads error:", err);
      return res.status(500).json({ error: "dump failed" });
    }
  }

  /* ──────────────────────────────────────────────
     FALLBACK: UNKNOWN ACTION
  ─────────────────────────────────────────────── */
  return res.status(400).json({ error: "Invalid action or method" });
}
