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

// Small helpers
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
function timeout(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Timeout after " + ms + "ms")), ms)
  );
}
function normName(s) {
  return String(s || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
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

// Read urlencoded body if needed (for sendBeacon/fallback)
async function readUrlencodedBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const params = new URLSearchParams(body);
        const obj = {};
        for (const [k, v] of params.entries()) obj[k] = v;
        resolve(obj);
      } catch {
        resolve({});
      }
    });
  });
}

// 1×1 GIF for optional GET pixel (we don't actively use it in the client)
const PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==",
  "base64"
);

// ───────────────────────────────────────────────────────────────
// Main handler
// ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const action = url.searchParams.get("action");
  console.log("➡️ Incoming admin action:", req.method, action);

  // Parse JSON bodies globally (urlencoded handled ad-hoc)
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
  // RAFFLE-ONLY FLOW
  //   GET  action=entries           -> list raw entries (name, platform, time)
  //   GET  action=entries-summary   -> {rows:[{name, entries}]}
  //   POST action=reset-entries     -> clear entries + dedupe for this show
  //   GET  action=winner            -> get current winner
  //   POST action=pick-winner       -> weighted by number of recorded entries
  //   POST action=reset-winner      -> clear winner + broadcast reset
  //   POST action=mark-follow       -> record social click + add an entry once per platform
  // ───────────────────────────────────────────────────────────────

  if (action === "entries" && req.method === "GET") {
    const ok = await ensureRedisConnected();
    if (!ok) return res.status(200).json({ entries: [], count: 0 });

    const { windowKey } = await getWindowInfo();
    const listKey = `raffle:entries:${windowKey}`;
    const raw = await redis.lRange(listKey, 0, -1);
    const entries = raw.map((s) => {
      try { return JSON.parse(s); } catch { return null; }
    }).filter(Boolean);

    return res.status(200).json({ entries, count: entries.length });
  }

  // Summarized table: sum recorded entries per name
  if (action === "entries-summary" && req.method === "GET") {
    const ok = await ensureRedisConnected();
    if (!ok) return res.status(200).json({ rows: [] });

    const { windowKey } = await getWindowInfo();
    const listKey = `raffle:entries:${windowKey}`;
    const raw = await redis.lRange(listKey, 0, -1);

    const map = new Map();
    for (const s of raw) {
      try {
        const e = JSON.parse(s);
        if (!e?.name) continue;
        const n = String(e.name).trim();
        map.set(n, (map.get(n) || 0) + 1);
      } catch {}
    }
    const rows = Array.from(map, ([name, entries]) => ({ name, entries }))
      .sort((a, b) => b.entries - a.entries || a.name.localeCompare(b.name));

    return res.status(200).json({ rows });
  }

  // ────── RESET ENTRIES (also clears social trackers; winner stays) ──────
if (action === "reset-entries" && req.method === "POST") {
  const authHeader = req.headers.authorization || "";
  const isAdmin =
    authHeader.startsWith("Bearer:super:") &&
    authHeader.endsWith(process.env.ADMIN_PASS);
  if (!isAdmin) return res.status(403).json({ error: "Forbidden" });

  const ok = await ensureRedisConnected();
  if (!ok) return res.status(503).json({ error: "Redis not ready" });

  const { windowKey } = await getWindowInfo();
  const setKey = `raffle:entered:${windowKey}`;
  const listKey = `raffle:entries:${windowKey}`;

  try {
    // Clear entries (set + list)
    const deletedEntries = await redis.del(setKey, listKey);

    // Also clear follower trackers
    const toDel = [];
    for await (const key of redis.scanIterator({ MATCH: "social:*", COUNT: 200 })) {
      toDel.push(key);
    }
    if (toDel.length) await redis.del(...toDel);
    await redis.del("social:ips");

    return res.status(200).json({
      success: true,
      deletedEntries,
      deletedSocialKeys: toDel.length
    });
  } catch (e) {
    console.error("❌ reset-entries failed:", e);
    return res.status(500).json({ success: false, error: "Reset entries failed" });
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

  // Weighted by number of recorded entries
  if (action === "pick-winner" && req.method === "POST") {
    await ensureRedisConnected();
    const { role } = req.body || {};
    if (role !== "admin") return res.status(401).json({ error: "Unauthorized" });

    try {
      const { windowKey } = await getWindowInfo();
      const listKey = `raffle:entries:${windowKey}`;
      const raw = await redis.lRange(listKey, 0, -1);
      const rows = raw.map((s) => {
        try { return JSON.parse(s); } catch { return null; }
      }).filter(Boolean);

      if (!rows.length) return res.status(400).json({ error: "No eligible entries" });

      // Build weights per name + track platforms they used
      const weights = new Map();   // name -> count
      const platforms = new Map(); // name -> {fb:boolean, ig:boolean}
      for (const e of rows) {
        const n = String(e.name).trim();
        weights.set(n, (weights.get(n) || 0) + 1);
        const p = platforms.get(n) || { fb: false, ig: false };
        if (e.platform === "fb") p.fb = true;
        if (e.platform === "ig") p.ig = true;
        platforms.set(n, p);
      }

      const items = Array.from(weights.entries()); // [name, count]
      const total = items.reduce((a, [, c]) => a + c, 0);
      let r = Math.random() * total;
      let picked = items[0][0];
      for (const [name, count] of items) {
        r -= count;
        if (r <= 0) { picked = name; break; }
      }

      const payload = {
        name: picked,
        weight: weights.get(picked) || 1,
        platforms: platforms.get(picked) || { fb: false, ig: false },
      };

      await redis.set("raffle_winner", JSON.stringify(payload));

      // Best-effort broadcast to clients
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

    if (!isAdmin) return res.status(403).json({ error: "Forbidden" });

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
      const fbRes = await fetch(
        `https://graph.facebook.com/v19.0/${process.env.FB_PAGE_ID}?fields=fan_count&access_token=${token}`
      );
      const igRes = await fetch(
        `https://graph.facebook.com/v19.0/${process.env.IG_ACCOUNT_ID}?fields=followers_count&access_token=${token}`
      );
      const fbJson = await fbRes.json();
      const igJson = await igRes.json();
      return res.json({
        facebook: fbJson.fan_count || 0,
        instagram: igJson.followers_count || 0,
      });
    } catch (err) {
      console.error("❌ Follower fetch failed:", err.message);
      return res.status(500).json({ error: "Failed to fetch follower counts" });
    }
  }

  // ────── CHECK FOLLOW STATUS (kept; harmless) ──────
  if (req.method === "GET" && action === "check-follow") {
    await ensureRedisConnected();
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0] ||
      req.socket.remoteAddress ||
      "unknown";
    const raw = await redis.get(`social:${ip}`).catch(() => null);
    return res.status(200).json({ allowed: isFollowAllowed(raw) });
  }

  // ────── SOCIAL STATUS (admin view) ──────
  if (req.method === "GET" && action === "social-status") {
    const ok = await ensureRedisConnected();
    if (!ok) {
      return res.status(200).json({
        totals: { uniqueIPsTracked: 0, unlocked: 0, facebookClicks: 0, instagramClicks: 0 },
        entries: [],
      });
    }

    const ips = await redis.sMembers("social:ips");
    const entries = [];
    let totalUnlocked = 0;
    let fbClicks = 0;
    let igClicks = 0;

    for (const ip of ips) {
      const key = `social:${ip}`;
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

  // ────── MARK FOLLOW (per IP + platform) + RECORD ENTRY ──────
  // Accepts:
  //   - POST application/json: { platform, name }
  //   - POST x-www-form-urlencoded: platform=..&name=..
  //   - GET  ...?platform=..&name=..   (returns 1×1 gif)
  if ((req.method === "POST" || req.method === "GET") && action === "mark-follow") {
    const ok = await ensureRedisConnected();
    if (!ok) {
      if (req.method === "GET") {
        res.setHeader("Content-Type", "image/gif");
        res.setHeader("Cache-Control", "no-store");
        return res.end(PIXEL_GIF);
      }
      return res.status(503).json({ error: "Redis not ready" });
    }

    const urlPlatform = url.searchParams.get("platform");
    const urlName = url.searchParams.get("name");

    let bodyPlatform = null;
    let bodyName = null;

    if (req.method === "POST") {
      const ct = req.headers["content-type"] || "";
      if (ct.includes("application/json")) {
        bodyPlatform = req.body?.platform ?? null;
        bodyName = req.body?.name ?? null;
      } else if (ct.includes("application/x-www-form-urlencoded")) {
        const form = await readUrlencodedBody(req);
        bodyPlatform = form.platform || null;
        bodyName = form.name || null;
      }
    }

    const platform = String(urlPlatform || bodyPlatform || "").toLowerCase(); // "fb" | "ig"
    const rawName = urlName || bodyName || "";
    const name = String(rawName || "").trim();
    const norm = normName(name);

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";

    const socialKey = `social:${ip}`;
    const now = new Date().toISOString();
    const EX_SECONDS = 60 * 60 * 8; // 8 hours

    // Update social (IP) state (admin "Social Follows" box)
    let state = {
      firstSeen: now,
      lastSeen: now,
      followed: true,
      count: 0,
      platforms: {},
    };
    const prev = await redis.get(socialKey).catch(() => null);
    if (prev) {
      try { state = JSON.parse(prev) || state; } catch {}
    }
    state.firstSeen = state.firstSeen || now;
    state.lastSeen = now;
    state.followed = true;
    state.count = (state.count || 0) + 1;
    state.platforms = state.platforms || {};
    if (platform === "fb" || platform === "ig") state.platforms[platform] = true;

    await redis.multi()
      .set(socialKey, JSON.stringify(state), { EX: EX_SECONDS })
      .sAdd("social:ips", ip)
      .exec();

    // If name missing, just update social state and return
    if (!norm) {
      if (req.method === "GET") {
        res.setHeader("Content-Type", "image/gif");
        res.setHeader("Cache-Control", "no-store");
        return res.end(PIXEL_GIF);
      }
      return res.json({ success: true, note: "social updated; name empty" });
    }

    // Add a single recorded entry per (name, platform, show) using atomic SADD gate
    const { windowKey, ttlSeconds } = await getWindowInfo();
    const listKey  = `raffle:entries:${windowKey}`;
    const dedupeNS = `raffle:dedupe:${windowKey}:${platform}`;

    // Only record on fb/ig platforms
    if (platform === "fb" || platform === "ig") {
      const added = await redis.sAdd(dedupeNS, norm); // 1 if new, 0 if duplicate
      if (added === 1) {
        await redis.expire(dedupeNS, ttlSeconds);
        await redis.rPush(
          listKey,
          JSON.stringify({
            id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
            name,
            platform,
            createdTime: now,
          })
        );
        await redis.expire(listKey, ttlSeconds);
      }
    }

    if (req.method === "GET") {
      res.setHeader("Content-Type", "image/gif");
      res.setHeader("Cache-Control", "no-store");
      return res.end(PIXEL_GIF);
    }
    return res.json({ success: true });
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
  // ────── UNKNOWN ──────
  return res.status(400).json({ error: "Invalid action or method" });
}
