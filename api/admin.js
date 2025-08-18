// /api/admin.js
import fs from "fs";
import path from "path";
import { createClient } from "redis";

// ───────────────────────────────────────────────────────────────
// ENV + paths
// ───────────────────────────────────────────────────────────────
const ADMIN_PASS = process.env.ADMIN_PASS;
const MODERATOR_PASS = process.env.MODERATOR_PASS;

// Treat Vercel preview like prod; only true local dev is "local"
const isLocal =
  (!process.env.VERCEL && process.env.NODE_ENV !== "production") ||
  process.env.VERCEL_ENV === "development";

// ───────────────────────────────────────────────────────────────
// Redis singleton
// ───────────────────────────────────────────────────────────────
let redis;
if (!globalThis.__redis && process.env.REDIS_URL) {
  const client = createClient({
    url: process.env.REDIS_URL,
    socket: {
      connectTimeout: 5000,
      reconnectStrategy: (retries) => Math.min(retries * 200, 3000),
    },
  });
  client.on("error", (e) => console.error("Redis error:", e?.message || e));
  globalThis.__redis = client;
  client
    .connect()
    .then(() => console.log("✅ Redis connected"))
    .catch((err) => console.error("❌ Redis initial connect failed:", err));
}
redis = globalThis.__redis;

export async function ensureRedisConnected() {
  if (!redis) return false;
  if (redis.isOpen) return true;
  try {
    await redis.connect();
    console.log("✅ Redis reconnected");
    return true;
  } catch (err) {
    console.error("❌ Redis reconnect failed:", err?.message || err);
    return false;
  }
}

// Helper: interpret follow state from Redis (legacy or JSON)
function isFollowAllowed(raw) {
  if (!raw) return false;
  if (raw === "true") return true; // legacy
  try {
    const obj = JSON.parse(raw);
    return !!obj?.followed;
  } catch {
    return false;
  }
}

async function scanAll(match) {
  const out = [];
  for await (const k of redis.scanIterator({ MATCH: match, COUNT: 1000 })) out.push(k);
  return out;
}

// Utility: current show window key + TTL
async function getWindowInfo() {
  let showName = "90 Surge";
  let startTime = new Date().toISOString();
  let endTime = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

  try {
    const ok = await ensureRedisConnected();
    if (ok && redis?.isOpen) {
      const [sn, st, et] = await Promise.all([
        redis.get("showName").catch(() => ""),
        redis.get("startTime").catch(() => ""),
        redis.get("endTime").catch(() => ""),
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

  const windowKey = `${startTime || ""}|${endTime || ""}`;
  let ttlSeconds = Math.floor((new Date(endTime) - Date.now()) / 1000);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) ttlSeconds = 8 * 60 * 60; // 8h fallback

  return { showName, startTime, endTime, windowKey, ttlSeconds };
}

function timeout(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Timeout after " + ms + "ms")), ms)
  );
}

// small helpers for key scanning/deletion
async function collectKeys(match) {
  const out = [];
  for await (const k of redis.scanIterator({ MATCH: match, COUNT: 500 })) {
    out.push(k);
  }
  return out;
}
async function delKeys(keys) {
  return keys.length ? await redis.del(...keys) : 0;
}

// ───────────────────────────────────────────────────────────────
// Main handler
// ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const action = url.searchParams.get("action");
  console.log("➡️ Incoming admin action:", req.method, action);

  // Parse JSON bodies
  if (
    req.method === "POST" &&
    req.headers["content-type"]?.includes("application/json")
  ) {
    try {
      let body = "";
      await new Promise((resolve) => {
        req.on("data", (chunk) => (body += chunk));
        req.on("end", resolve);
      });
      req.body = body ? JSON.parse(body) : {};
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }
  }

  // ────── AUTH ──────
  if (action === "login" && req.method === "POST") {
    const { password } = req.body || {};
    if (password === ADMIN_PASS) return res.json({ success: true, role: "admin" });
    if (password === MODERATOR_PASS) return res.json({ success: true, role: "moderator" });
    return res.status(401).json({ success: false, error: "Invalid password" });
  }

  // ────── REDIS STATUS / WARM ──────
  if (req.method === "GET" && action === "redis-status") {
    try {
      if (!(await ensureRedisConnected())) {
        return res.status(200).json({ status: "idle" });
      }
      const t0 = Date.now();
      await redis.ping();
      const pingMs = Date.now() - t0;

      const [keyCount, lastWarmAt, seeded, hitRate] = await Promise.all([
        redis.dbSize().catch(() => null),
        redis.get("lastWarmAt").catch(() => null),
        redis.get("warm_seeded").catch(() => null),
        redis.get("cache:hitRate").catch(() => null),
      ]);

      return res.status(200).json({
        status: "active",
        pingMs,
        keyCount,
        lastWarmAt,
        seeded: seeded === "true" ? true : (seeded ?? null),
        hitRate: hitRate ? Number(hitRate) : null,
      });
    } catch {
      return res.status(200).json({ status: "idle" });
    }
  }

  if (req.method === "POST" && action === "warm-redis") {
    const authHeader = req.headers.authorization || "";
    const isAdmin =
      authHeader.startsWith("Bearer:super:") &&
      authHeader.endsWith(process.env.ADMIN_PASS);
    if (!isAdmin) return res.status(403).json({ error: "Forbidden" });

    try {
      const ok = await ensureRedisConnected();
      if (!ok) throw new Error("connect failed");

      await Promise.all([
        redis.set("warm_probe", String(Date.now()), { EX: 300 }),
        redis.set("warm_seeded", "true", { EX: 3600 }),
        redis.set("lastWarmAt", new Date().toISOString(), { EX: 3600 }),
        redis.ping(),
      ]);

      const t0 = Date.now();
      await redis.ping();
      const pingMs = Date.now() - t0;
      const keyCount = await redis.dbSize().catch(() => null);

      return res.status(200).json({ success: true, pong: "PONG", pingMs, keyCount });
    } catch (err) {
      console.error("❌ Redis warm-up failed:", err);
      return res.status(500).json({ error: "Warm-up failed" });
    }
  }

  // ────── CONFIG ──────
  if (action === "config") {
    if (req.method === "GET") {
      await ensureRedisConnected();
      if (!redis?.isOpen) {
        return res.status(200).json({
          showName: "90 Surge",
          startTime: new Date().toISOString(),
          endTime: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
        });
      }
      try {
        if (isLocal) {
          const config = JSON.parse(
            fs.readFileSync(path.join(process.cwd(), "config.json"), "utf8")
          );
        return res.json(config);
        } else {
          const [showName, startTime, endTime] = await Promise.race([
            Promise.all([
              redis.get("showName").catch(() => ""),
              redis.get("startTime").catch(() => ""),
              redis.get("endTime").catch(() => ""),
            ]),
            timeout(10000),
          ]);
          return res.json({ showName, startTime, endTime });
        }
      } catch (err) {
        console.error("❌ Config load error:", err.message);
        return res.status(500).json({ error: "Failed to load config" });
      }
    }

    if (req.method === "POST") {
      const { showName, startTime, endTime } = req.body || {};
      try {
        if (isLocal) {
          fs.writeFileSync(
            path.join(process.cwd(), "config.json"),
            JSON.stringify({ showName, startTime, endTime }, null, 2)
          );
        } else {
          const ok = await ensureRedisConnected();
          if (!ok) return res.status(503).json({ error: "Redis not ready" });
          await Promise.all([
            redis.set("showName", showName || ""),
            redis.set("startTime", startTime || ""),
            redis.set("endTime", endTime || ""),
          ]);
        }
        return res.json({ success: true });
      } catch {
        return res.status(500).json({ error: "Failed to save config" });
      }
    }
  }

  // ───────────────────────────────────────────────────────────────
  // RAFFLE FLOW
  // ───────────────────────────────────────────────────────────────

  // Per-source enter (fb | ig | jackpot). One entry per source per IP per window.
  if (action === "enter" && req.method === "POST") {
    const ok = await ensureRedisConnected();
    if (!ok) return res.status(503).json({ error: "Redis not ready" });

    const nameRaw = (req.body?.name || "").trim();
    if (!nameRaw) return res.status(400).json({ error: "Missing name" });
    const name = nameRaw.slice(0, 80);

    const rawSource = (req.body?.source || "").toString().toLowerCase();
    const source = ["fb", "ig", "jackpot"].includes(rawSource)
      ? rawSource
      : "other";

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";

    const { windowKey, ttlSeconds } = await getWindowInfo();

    const setKey = `raffle:entered:${windowKey}:${source}`; // dedupe per source
    const listKey = `raffle:entries:${windowKey}`; // all tickets

    const already = await redis.sIsMember(setKey, ip);
    if (already) {
      // self-heal: if dedupe says already but log row missing, append now
      try {
        const tail = await redis.lRange(listKey, -300, -1);
        let found = false;
        for (const s of tail) {
          try {
            const e = JSON.parse(s);
            if (e && e.ip === ip && e.source === source) { found = true; break; }
          } catch {}
        }
        if (!found) {
          const entry = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
            name,
            ip,
            source,
            createdTime: new Date().toISOString(),
          };
          await redis.rPush(listKey, JSON.stringify(entry));
          await redis.expire(listKey, ttlSeconds);
          return res.status(200).json({ success: true, already: true, repaired: true, entry });
        }
      } catch {}
      return res.status(200).json({ success: true, already: true, source });
    }

    const entry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      name,
      ip,
      source,
      createdTime: new Date().toISOString(),
    };

    await redis
      .multi()
      .sAdd(setKey, ip)
      .expire(setKey, ttlSeconds)
      .rPush(listKey, JSON.stringify(entry))
      .expire(listKey, ttlSeconds)
      .exec();

    return res.status(200).json({ success: true, entry });
  }

  if (action === "entries" && req.method === "GET") {
    const ok = await ensureRedisConnected();
    if (!ok) return res.status(200).json({ entries: [], count: 0 });

    const { windowKey } = await getWindowInfo();
    const listKey = `raffle:entries:${windowKey}`;
    const raw = await redis.lRange(listKey, 0, -1);
    const entries = raw
      .map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean);

    return res.status(200).json({ entries, count: entries.length });
  }

  // GET action=my-entries -> { mine, total, sources:{fb, ig, jackpot} }
// "mine" is per-IP and per-source for the current window (fb + ig + jackpot)
if (action === "my-entries" && req.method === "GET") {
  const ok = await ensureRedisConnected();
  if (!ok) {
    return res.status(200).json({
      mine: 0,
      total: 0,
      sources: { fb: false, ig: false, jackpot: false },
    });
  }

  const { windowKey } = await getWindowInfo();
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown";

  const setFb = `raffle:entered:${windowKey}:fb`;
  const setIg = `raffle:entered:${windowKey}:ig`;
  const setJp = `raffle:entered:${windowKey}:jackpot`;
  const listKey = `raffle:entries:${windowKey}`;

  const [fb, ig, jp, total] = await Promise.all([
    redis.sIsMember(setFb, ip),
    redis.sIsMember(setIg, ip),
    redis.sIsMember(setJp, ip),
    redis.lLen(listKey).catch(() => 0),
  ]);

  const mine = (fb ? 1 : 0) + (ig ? 1 : 0) + (jp ? 1 : 0);

  return res.status(200).json({
    mine,
    total: Number(total || 0),
    sources: { fb: !!fb, ig: !!ig, jackpot: !!jp },
  });
}

  // Admin table: Name + total entries (sum of rows)
  if (action === "entries-summary" && req.method === "GET") {
    const ok = await ensureRedisConnected();
    if (!ok) return res.status(200).json({ rows: [] });

    const { windowKey } = await getWindowInfo();
    const listKey = `raffle:entries:${windowKey}`;
    const raw = await redis.lRange(listKey, 0, -1);
    const rowsMap = new Map(); // name -> count
    for (const s of raw) {
      try {
        const e = JSON.parse(s);
        const name = (e?.name || "").trim();
        if (!name) continue;
        rowsMap.set(name, (rowsMap.get(name) || 0) + 1);
      } catch {}
    }
    const rows = Array.from(rowsMap, ([name, entries]) => ({ name, entries }))
      .sort((a,b)=> b.entries - a.entries || a.name.localeCompare(b.name));
    return res.status(200).json({ rows });
  }

  /// Reset EVERYTHING for this show window:
// - entries list
// - per-source dedupe sets (fb/ig/jackpot)
// - bonus/prize logs for this window
// - cached winner
// - ALL social:* keys (including social:ips and social:lock:*)
// We delete keys ONE-BY-ONE to avoid cluster/multi-key pitfalls.
if (action === "reset-entries" && req.method === "POST") {
  const authHeader = req.headers.authorization || "";
  const isAdmin =
    authHeader.startsWith("Bearer:super:") &&
    authHeader.endsWith(process.env.ADMIN_PASS);
  if (!isAdmin) return res.status(403).json({ error: "Forbidden" });

  const ok = await ensureRedisConnected();
  if (!ok) return res.status(503).json({ error: "Redis not ready" });

  // helpers
  async function scanAll(match) {
    const out = [];
    for await (const k of redis.scanIterator({ MATCH: match, COUNT: 1000 })) {
      out.push(k);
    }
    return out;
  }
  async function delKey(k) {
    try { return await redis.unlink(k); } catch { return await redis.del(k); }
  }

  try {
    const { windowKey } = await getWindowInfo();

    // Window-scoped keys
    const listKey   = `raffle:entries:${windowKey}`;
    const prizeKey  = `raffle:prizes:${windowKey}`;
    const dedupes   = await scanAll(`raffle:entered:${windowKey}:*`);
    const bonuses   = await scanAll(`raffle:bonus:${windowKey}:*`);

    // Winner
    const winnerKey = `raffle_winner`;

    // Social via index
    const ips = await redis.sMembers("social:ips").catch(() => []);
    const socialFromIndex = [];
    for (const ip of ips) {
      socialFromIndex.push(`social:${ip}`);
      socialFromIndex.push(`social:lock:${ip}`);
    }
    // Include the index set itself
    socialFromIndex.push("social:ips");

    // Social catch-all (anything not indexed)
    const socialWildcard = await scanAll("social:*");

    // Unique deletion list
    const toDelete = Array.from(
      new Set([
        listKey,
        prizeKey,
        winnerKey,
        ...dedupes,
        ...bonuses,
        ...socialFromIndex,
        ...socialWildcard,
      ].filter(Boolean))
    );

    // Delete ONE BY ONE (prevents cluster cross-slot & arg count issues)
    let deleted = 0;
    for (const key of toDelete) {
      try {
        deleted += await delKey(key);
      } catch (e) {
        console.warn("reset-entries: failed to delete", key, e?.message || e);
      }
    }

    // Belt & suspenders: ensure social:ips is completely gone
    try { await delKey("social:ips"); } catch {}

    // Sanity pass: see what (if anything) survived
    const remainingSocial = await scanAll("social:*");
    const remainingRaffleEntered = await scanAll(`raffle:entered:${windowKey}:*`);

    return res.status(200).json({
      success: true,
      windowKey,
      deletedKeys: deleted,
      remaining: {
        social: remainingSocial,
        raffleEntered: remainingRaffleEntered,
      },
    });
  } catch (e) {
    console.error("❌ reset-entries failed:", e);
    return res.status(500).json({
      success: false,
      error: "Reset entries failed",
      details: e?.message || String(e),
    });
  }
}


  // ────── PRIZE/SPIN LOGGING ──────
  if (action === "prize-log" && req.method === "POST") {
    const ok = await ensureRedisConnected();
    if (!ok) return res.status(503).json({ error: "Redis not ready" });

    const { windowKey, ttlSeconds } = await getWindowInfo();
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";

    const name = (req.body?.name || "").toString().slice(0, 80);
    const targets = Array.isArray(req.body?.targets)
      ? req.body.targets.map(String)
      : [];
    const jackpot = !!req.body?.jackpot;

    const log = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      name: name || "(anonymous)",
      ip,
      jackpot,
      targets,
      ts: new Date().toISOString(),
    };

    const listKey = `raffle:prizes:${windowKey}`;
    try {
      await redis.rPush(listKey, JSON.stringify(log));
      await redis.expire(listKey, ttlSeconds);
      await redis.lTrim(listKey, -300, -1);
      console.log("🧾 Spin:", log);
      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("prize-log failed:", e);
      return res.status(500).json({ success: false, error: "prize-log failed" });
    }
  }

  if (action === "prize-logs" && req.method === "GET") {
    const ok = await ensureRedisConnected();
    if (!ok) return res.status(200).json({ logs: [] });

    const { windowKey } = await getWindowInfo();
    const listKey = `raffle:prizes:${windowKey}`;
    try {
      const raw = await redis.lRange(listKey, 0, -1);
      const logs = raw
        .map((s) => { try { return JSON.parse(s); } catch { return null; } })
        .filter(Boolean)
        .reverse();
      return res.status(200).json({ logs });
    } catch (e) {
      console.error("prize-logs failed:", e);
      return res.status(500).json({ logs: [], error: "fetch failed" });
    }
  }

  if (action === "winner" && req.method === "GET") {
    await ensureRedisConnected();
    try {
      const winner = await redis.get("raffle_winner");
      return res.json({ winner: winner ? JSON.parse(winner) : null });
    } catch (err) {
      console.error("❌ Failed to fetch winner:", err);
      return res.status(500).json({ error: "Failed to get winner" });
    }
  }

  // Uniform pick across rows (each row is a ticket)
  if (action === "pick-winner" && req.method === "POST") {
    await ensureRedisConnected();
    const { role } = req.body || {};
    if (role !== "admin") return res.status(401).json({ error: "Unauthorized" });

    try {
      const { windowKey } = await getWindowInfo();
      const listKey = `raffle:entries:${windowKey}`;
      const raw = await redis.lRange(listKey, 0, -1);
      const entries = raw
        .map((s) => { try { return JSON.parse(s); } catch { return null; } })
        .filter(Boolean);

      if (!entries.length) {
        return res.status(400).json({ error: "No eligible entries" });
      }

      const idx = Math.floor(Math.random() * entries.length);
      const winner = entries[idx];

      const payload = {
        id: winner.id,
        name: winner.name,
        source: winner.source || null,
      };

      await redis.set("raffle_winner", JSON.stringify(payload));

      try {
        await fetch("https://winner-sse-server.onrender.com/broadcast", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ winner: payload.name }),
        });
      } catch (broadcastErr) {
        console.warn("⚠️ Broadcast winner failed:", broadcastErr?.message || broadcastErr);
      }

      return res.json({ success: true, winner: payload });
    } catch (err) {
      console.error("❌ Error picking winner:", err);
      return res.status(500).json({ error: "Failed to pick winner" });
    }
  }

  if (action === "reset-winner" && req.method === "POST") {
    await ensureRedisConnected();

    const authHeader = req.headers.authorization || "";
    const isAdmin =
      authHeader.startsWith("Bearer:super:") &&
      authHeader.endsWith(process.env.ADMIN_PASS);

    if (!isAdmin) {
      return res.status(403).json({ error: "Forbidden" });
    }

    try {
      await redis.del("raffle_winner");
      try {
        await fetch("https://winner-sse-server.onrender.com/reset", { method: "POST" });
      } catch (e) {
        console.warn("⚠️ SSE reset broadcast failed:", e?.message || e);
      }
      return res.json({ success: true });
    } catch (err) {
      console.error("❌ Failed to reset winner:", err);
      return res.status(500).json({ success: false, error: "Failed to reset winner" });
    }
  }

  // ────── LIVE FOLLOWER #s (FB/IG) ──────
  if (action === "followers" && req.method === "GET") {
    try {
      const token = process.env.FB_PAGE_TOKEN;
      const pageId = process.env.FB_PAGE_ID;
      const igId = process.env.IG_ACCOUNT_ID;

      if (!token || !pageId || !igId) {
        // soft fallback
        return res.status(200).json({ facebook: 0, instagram: 0, _note: "missing env" });
      }

      const fbRes = await fetch(
        `https://graph.facebook.com/v19.0/${pageId}?fields=fan_count&access_token=${token}`
      );
      const igRes = await fetch(
        `https://graph.facebook.com/v19.0/${igId}?fields=followers_count&access_token=${token}`
      );
      const fbJson = await fbRes.json().catch(() => ({}));
      const igJson = await igRes.json().catch(() => ({}));

      const facebook = Number(fbJson?.fan_count || 0);
      const instagram = Number(igJson?.followers_count || 0);

      return res.status(200).json({ facebook, instagram });
    } catch (err) {
      console.error("❌ Follower fetch failed:", err?.message || err);
      return res.status(200).json({ facebook: 0, instagram: 0 });
    }
  }

  // ────── CHECK FOLLOW STATUS (window-scoped) ──────
  if (req.method === "GET" && action === "check-follow") {
    await ensureRedisConnected();

    const { windowKey } = await getWindowInfo();
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0] ||
      req.socket.remoteAddress ||
      "unknown";

    // prefer window-scoped key
    let raw = await redis.get(`social:${windowKey}:${ip}`).catch(() => null);

    // legacy fallback (read-only)
    if (!raw) raw = await redis.get(`social:${ip}`).catch(() => null);

    return res.status(200).json({ allowed: isFollowAllowed(raw) });
  }

// GET current spins reset version
if (action === "slot-spins-version" && req.method === "GET") {
  const ok = await ensureRedisConnected();
  if (!ok) return res.status(200).json({ version: 0, at: null });
  const [v, at] = await Promise.all([
    redis.get("slot:spinsResetVersion").catch(() => "0"),
    redis.get("slot:spinsResetAt").catch(() => null),
  ]);
  return res.status(200).json({ version: Number(v || 0), at });
}

// ADMIN: bump the spins reset version → all clients will reset on next load/poll
if (action === "reset-slot-spins" && req.method === "POST") {
  const authHeader = req.headers.authorization || "";
  const isAdmin =
    authHeader.startsWith("Bearer:super:") &&
    authHeader.endsWith(process.env.ADMIN_PASS);
  if (!isAdmin) return res.status(403).json({ error: "Forbidden" });

  const ok = await ensureRedisConnected();
  if (!ok) return res.status(503).json({ error: "Redis not ready" });

  const version = await redis.incr("slot:spinsResetVersion");
  await redis.set("slot:spinsResetAt", new Date().toISOString(), { EX: 60 * 60 * 24 * 7 });
  return res.status(200).json({ success: true, version });
}

  // ────── SOCIAL STATUS (admin view, window-scoped) ──────
  if (req.method === "GET" && action === "social-status") {
    const ok = await ensureRedisConnected();
    if (!ok) {
      return res.status(200).json({
        totals: { uniqueIPsTracked: 0, unlocked: 0, facebookClicks: 0, instagramClicks: 0 },
        entries: [],
      });
    }

    const { windowKey } = await getWindowInfo();
    const setKey = `social:ips:${windowKey}`;
    const ips = await redis.sMembers(setKey);

    const entries = [];
    let totalUnlocked = 0;
    let fbClicks = 0;
    let igClicks = 0;

    for (const ip of ips) {
      const key = `social:${windowKey}:${ip}`;
      const raw = await redis.get(key);
      if (!raw) continue; // TTL expired
      let s;
      try {
        s = JSON.parse(raw);
      } catch {
        s = { followed: raw === "true", platforms: {} };
      }
      const ttlSeconds = await redis.ttl(key);

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
  }

  // ────── SHUTDOWN STATUS / TOGGLE ──────
  if (req.method === "GET" && action === "shutdown-status") {
    try {
      await ensureRedisConnected();
      const raw = await redis.get("shutdown").catch(() => null);
      const isShutdown = raw === "true";
      return res.status(200).json({ isShutdown });
    } catch (e) {
      console.error("shutdown-status error:", e);
      return res.status(200).json({ isShutdown: false, _warning: "fallback" });
    }
  }

  if (req.method === "POST" && action === "toggle-shutdown") {
    const authHeader = req.headers.authorization || "";
    const isAdmin =
      authHeader.startsWith("Bearer:super:") &&
      authHeader.endsWith(process.env.ADMIN_PASS);
    if (!isAdmin) return res.status(403).json({ error: "Forbidden" });

    const ok = await ensureRedisConnected();
    if (!ok) return res.status(503).json({ error: "Redis not ready" });

    const current = await redis.get("shutdown");
    const newStatus = current !== "true";
    await redis.set("shutdown", newStatus ? "true" : "false");
    return res.status(200).json({ success: true, isShutdown: newStatus });
  }

  // ────── MARK FOLLOW (per IP + platform) — union, window-scoped ──────
  if (req.method === "POST" && action === "mark-follow") {
    const ok = await ensureRedisConnected();
    if (!ok) return res.status(503).json({ error: "Redis not ready" });

    const urlPlatform = url.searchParams.get("platform");
    const bodyPlatform = (req.body && req.body.platform) || null;
    const platform = (urlPlatform || bodyPlatform || "").toLowerCase(); // "fb" | "ig"
    if (platform !== "fb" && platform !== "ig") {
      return res.status(400).json({ error: "Invalid platform" });
    }

    const { windowKey, ttlSeconds } = await getWindowInfo();
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";

    // short per-IP lock within window to prevent cross-fire from a single tap
    const lockKey = `social:lock:${windowKey}:${ip}`;
    try {
      const got = await redis.set(lockKey, platform, { NX: true, PX: 1000 });
      if (!got) {
        return res.status(200).json({ success: true, throttled: true });
      }
    } catch {}

    const key = `social:${windowKey}:${ip}`;
    const setKey = `social:ips:${windowKey}`;
    const now = new Date().toISOString();

    // UNION state
    let state = {
      firstSeen: now,
      lastSeen: now,
      followed: true,
      count: 0,
      platforms: { fb: false, ig: false },
    };

    const prev = await redis.get(key).catch(() => null);
    if (prev) {
      try {
        const p = JSON.parse(prev);
        state.firstSeen = p.firstSeen || state.firstSeen;
        state.count = Number(p.count || 0);
        state.platforms = {
          fb: !!(p.platforms?.fb),
          ig: !!(p.platforms?.ig),
        };
      } catch {}
    }

    state.lastSeen = now;
    state.followed = true;
    state.count += 1;
    state.platforms[platform] = true; // union

    await redis.set(key, JSON.stringify(state), { EX: ttlSeconds });
    await redis.sAdd(setKey, ip);

    return res.status(200).json({ success: true, state });
  }

  // ────── UNKNOWN ──────
  return res.status(400).json({ error: "Invalid action or method" });
}
