// /api/admin.js
import fs from "fs";
import path from "path";
import { createClient } from "redis";

export const config = { runtime: "nodejs" };

/* ──────────────────────────────────────────────────────────────
   ENV + mode
────────────────────────────────────────────────────────────── */
const ADMIN_PASS     = process.env.ADMIN_PASS || "";
const MODERATOR_PASS = process.env.MODERATOR_PASS || "";

// Treat Vercel preview like prod; only true local dev is "local"
const isLocal =
  (!process.env.VERCEL && process.env.NODE_ENV !== "production") ||
  process.env.VERCEL_ENV === "development";

/* ──────────────────────────────────────────────────────────────
   Redis singleton
────────────────────────────────────────────────────────────── */
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
  client.connect()
    .then(() => console.log("✅ Redis connected"))
    .catch((err) => console.error("❌ Redis initial connect failed:", err));
}
redis = globalThis.__redis;

async function ensureRedisConnected() {
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

/* ──────────────────────────────────────────────────────────────
   Helpers
────────────────────────────────────────────────────────────── */
const g = globalThis;
if (!g.__surgeMem) g.__surgeMem = { winners: [], currentWinner: null };
const MEM = g.__surgeMem;

function isAdmin(req) {
  const h = req.headers.authorization || "";
  const pref = "Bearer:super:";
  if (!h.startsWith(pref)) return false;
  const token = h.slice(pref.length);
  return !!ADMIN_PASS && token === ADMIN_PASS;
}

async function scanAll(match) {
  const out = [];
  if (!redis?.scanIterator) return out;
  for await (const k of redis.scanIterator({ MATCH: match, COUNT: 1000 })) out.push(k);
  return out;
}

function isFollowAllowed(raw) {
  if (!raw) return false;
  if (raw === "true") return true;
  try { return !!JSON.parse(raw)?.followed; } catch { return false; }
}

function timeout(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Timeout after " + ms + "ms")), ms)
  );
}

function noCache(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("CDN-Cache-Control", "no-store");
  res.setHeader("Vercel-CDN-Cache-Control", "no-store");
}

// window key for current show (fallback = current UTC day)
async function getWindowInfo() {
  let showName = "90 Surge";
  let startTime = null;
  let endTime = null;

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
        showName  = cfg.showName  || showName;
        startTime = cfg.startTime || startTime;
        endTime   = cfg.endTime   || endTime;
      }
    }
  } catch {}

  if (!startTime || !endTime) {
    const now = new Date();
    const start = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0
    ));
    const end = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0
    ));
    startTime = start.toISOString();
    endTime   = end.toISOString();
  }

  const windowKey = `${startTime}|${endTime}`;
  let ttlSeconds = Math.floor((new Date(endTime) - Date.now()) / 1000);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) ttlSeconds = 8 * 60 * 60;

  return { showName, startTime, endTime, windowKey, ttlSeconds };
}

/* ──────────────────────────────────────────────────────────────
   Main handler
────────────────────────────────────────────────────────────── */
export default async function handler(req, res) {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const action = url.searchParams.get("action");
  console.log("➡️ Admin action:", req.method, action);

  // parse JSON body
  if (req.method === "POST" && req.headers["content-type"]?.includes("application/json")) {
    try {
      let body = "";
      await new Promise((resolve) => {
        req.on("data", (c) => (body += c));
        req.on("end", resolve);
      });
      req.body = body ? JSON.parse(body) : {};
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }
  }

  /* ───── AUTH ───── */
  if (action === "login" && req.method === "POST") {
    const { password } = req.body || {};
    if (password === ADMIN_PASS)     return res.json({ success: true, role: "admin" });
    if (password === MODERATOR_PASS) return res.json({ success: true, role: "moderator" });
    return res.status(401).json({ success: false, error: "Invalid password" });
  }

  /* ───── REDIS STATUS / WARM ───── */
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
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
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
      console.error("❌ warm-redis:", err);
      return res.status(500).json({ error: "Warm-up failed" });
    }
  }

  /* ───── CONFIG ───── */
  if (action === "config") {
    if (req.method === "GET") {
      noCache(res);
      await ensureRedisConnected();

      try {
        if (isLocal) {
          try {
            const filePath = path.join(process.cwd(), "config.json");
            const cfg = JSON.parse(fs.readFileSync(filePath, "utf8"));
            const showName = cfg.showName ?? "90 Surge";
            const startTime = cfg.startTime ?? null;
            const endTime = cfg.endTime ?? null;
            const version = Number(cfg.version || 0);
            return res.status(200).json({ showName, startTime, endTime, version });
          } catch { /* fall through */ }
        }

        if (redis?.isOpen) {
          let [showName, startTime, endTime, version] = await Promise.race([
            Promise.all([
              redis.get("showName").catch(() => ""),
              redis.get("startTime").catch(() => ""),
              redis.get("endTime").catch(() => ""),
              redis.get("config:version").catch(() => "0"),
            ]),
            timeout(10000),
          ]);
          return res.status(200).json({
            showName, startTime, endTime, version: Number(version || 0)
          });
        }

        // fallback
        return res.status(200).json({ showName: "90 Surge", startTime: null, endTime: null, version: 0 });
      } catch (err) {
        console.error("❌ config GET:", err);
        return res.status(500).json({ error: "Failed to load config" });
      }
    }

    if (req.method === "POST") {
      const { showName, startTime, endTime } = req.body || {};
      try {
        await ensureRedisConnected();

        let version = 0;
        if (isLocal) {
          const filePath = path.join(process.cwd(), "config.json");
          let existing = {};
          try { existing = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch {}
          version = Number(existing.version || 0) + 1;
          fs.writeFileSync(
            filePath,
            JSON.stringify({ showName, startTime, endTime, version }, null, 2)
          );
        } else {
          if (!redis?.isOpen) return res.status(503).json({ error: "Redis not ready" });
          await Promise.all([
            redis.set("showName", showName || ""),
            redis.set("startTime", startTime || ""),
            redis.set("endTime", endTime || ""),
          ]);
          version = await redis.incr("config:version");
        }

        try {
          await redis?.publish?.("sse", JSON.stringify({ type: "config", config: { showName, startTime, endTime, version } }));
        } catch {}

        noCache(res);
        return res.status(200).json({ success: true, showName, startTime, endTime, version });
      } catch (err) {
        console.error("❌ config POST:", err);
        return res.status(500).json({ error: "Failed to save config" });
      }
    }

    return res.status(405).json({ error: "Method not allowed" });
  }

  /* ────────────────────────────────────────────────────────────
     RAFFLE: enter / list / summary / my-entries
  ───────────────────────────────────────────────────────────── */
  if (action === "enter" && req.method === "POST") {
    const ok = await ensureRedisConnected();
    if (!ok) return res.status(503).json({ error: "Redis not ready" });

    const nameRaw = (req.body?.name || "").trim();
    if (!nameRaw) return res.status(400).json({ error: "Missing name" });
    const name = nameRaw.slice(0, 80);

    const rawSource = (req.body?.source || "").toString().toLowerCase();
    const source = ["fb", "ig", "jackpot"].includes(rawSource) ? rawSource : "other";

    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    const { windowKey, ttlSeconds } = await getWindowInfo();

    const setKey  = `raffle:entered:${windowKey}:${source}`; // per-source dedupe
    const listKey = `raffle:entries:${windowKey}`;           // all tickets

    const already = await redis.sIsMember(setKey, ip);
    if (already) {
      // self-heal (append if row missing)
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
            name, ip, source, createdTime: new Date().toISOString(),
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
      name, ip, source, createdTime: new Date().toISOString(),
    };

    await redis
      .multi()
      .sAdd(setKey, ip).expire(setKey, ttlSeconds)
      .rPush(listKey, JSON.stringify(entry)).expire(listKey, ttlSeconds)
      .exec();

    return res.status(200).json({ success: true, entry });
  }

  if (action === "entries" && req.method === "GET") {
    const ok = await ensureRedisConnected();
    if (!ok) return res.status(200).json({ entries: [], count: 0 });

    const { windowKey } = await getWindowInfo();
    const listKey = `raffle:entries:${windowKey}`;
    const raw = await redis.lRange(listKey, 0, -1);
    const entries = raw.map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
    return res.status(200).json({ entries, count: entries.length });
  }

  if (action === "my-entries" && req.method === "GET") {
    const ok = await ensureRedisConnected();
    if (!ok) {
      return res.status(200).json({ mine: 0, total: 0, sources: { fb: false, ig: false, jackpot: false } });
    }

    const { windowKey } = await getWindowInfo();
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";

    const setFb = `raffle:entered:${windowKey}:fb`;
    const setIg = `raffle:entered:${windowKey}:ig`;
    const setJp = `raffle:entered:${windowKey}:jackpot}`;
    // Note: We don't actually read setJp here; jackpot entry comes from client "submitEntryOnce('jackpot')" on win.
    const listKey = `raffle:entries:${windowKey}`;

    const [fb, ig, total] = await Promise.all([
      redis.sIsMember(setFb, ip),
      redis.sIsMember(setIg, ip),
      redis.lLen(listKey).catch(() => 0),
    ]);

    const jp = await redis.sIsMember(`raffle:entered:${windowKey}:jackpot`, ip);

    const mine = (fb ? 1 : 0) + (ig ? 1 : 0) + (jp ? 1 : 0);
    return res.status(200).json({ mine, total: Number(total || 0), sources: { fb: !!fb, ig: !!ig, jackpot: !!jp } });
  }

  if (action === "entries-summary" && req.method === "GET") {
    const ok = await ensureRedisConnected();
    if (!ok) return res.status(200).json({ rows: [] });

    const { windowKey } = await getWindowInfo();
    const listKey = `raffle:entries:${windowKey}`;
    const raw = await redis.lRange(listKey, 0, -1);
    const rowsMap = new Map();
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

  /* ────────────────────────────────────────────────────────────
     RESET EVERYTHING (entries + winners + social)
  ───────────────────────────────────────────────────────────── */
  if (action === "reset-entries" && req.method === "POST") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });

    const ok = await ensureRedisConnected();
    if (!ok || !redis?.isOpen) {
      MEM.winners = [];
      MEM.currentWinner = null;
      return res.status(200).json({ success: true, windowKey: "(mem)", deletedKeys: 0, remaining: { social: [], raffleEntered: [] } });
    }

    async function delKey(k) {
      try { return await redis.unlink(k); } catch { try { return await redis.del(k); } catch { return 0; } }
    }

    try {
      const { windowKey } = await getWindowInfo();

      // window-scoped raffle keys
      const listKey   = `raffle:entries:${windowKey}`;
      const dedupes   = await scanAll(`raffle:entered:${windowKey}:*`);
      const bonuses   = await scanAll(`raffle:bonus:${windowKey}:*`);

      // winners
      const winnersKey = "raffle:winners:all";
      const winnerKey  = "raffle_winner";

      // social (scoped + locks) and legacy set
      const socialIpsScoped  = `social:ips:${windowKey}`;
      const socialStates     = await scanAll(`social:${windowKey}:*`);
      const socialLocks      = await scanAll(`social:lock:${windowKey}:*`);
      const socialIpsLegacy  = "social:ips"; // legacy index if present

      const toDelete = Array.from(new Set([
        listKey, winnersKey, winnerKey, socialIpsScoped, socialIpsLegacy,
        ...dedupes, ...bonuses, ...socialStates, ...socialLocks,
      ]));

      let deleted = 0;
      for (const k of toDelete) deleted += await delKey(k);

      // clear in-memory mirrors
      MEM.winners = [];
      MEM.currentWinner = null;

      const remainingSocial        = await scanAll(`social:${windowKey}:*`);
      const remainingRaffleEntered = await scanAll(`raffle:entered:${windowKey}:*`);

      return res.status(200).json({
        success: true,
        windowKey,
        deletedKeys: deleted,
        remaining: { social: remainingSocial, raffleEntered: remainingRaffleEntered },
      });
    } catch (e) {
      console.error("❌ reset-entries failed:", e);
      return res.status(500).json({ success: false, error: "Reset entries failed", details: e?.message || String(e) });
    }
  }

  /* ────────────────────────────────────────────────────────────
     WINNER (current) + PICK + RESET
  ───────────────────────────────────────────────────────────── */
  if (action === "winner" && req.method === "GET") {
    try {
      const ok = await ensureRedisConnected();
      if (ok && redis?.isOpen) {
        const winner = await redis.get("raffle_winner");
        return res.json({ winner: winner ? JSON.parse(winner) : null });
      }
      return res.json({ winner: MEM.currentWinner ? { name: MEM.currentWinner } : null, _fallback: true });
    } catch (err) {
      console.error("❌ winner GET:", err);
      return res.status(500).json({ error: "Failed to get winner" });
    }
  }

  if (action === "pick-winner" && req.method === "POST") {
    await ensureRedisConnected();
    const { role } = req.body || {};
    if (role !== "admin") return res.status(401).json({ error: "Unauthorized" });

    try {
      const { windowKey } = await getWindowInfo();
      if (!redis?.isOpen) return res.status(503).json({ error: "Redis not ready" });

      const listKey = `raffle:entries:${windowKey}`;
      const raw = await redis.lRange(listKey, 0, -1);
      const entries = raw.map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
      if (!entries.length) return res.status(400).json({ error: "No eligible entries" });

      const idx = Math.floor(Math.random() * entries.length);
      const winner = entries[idx];
      const payload = { id: winner.id, name: winner.name, source: winner.source || null };

      await redis.set("raffle_winner", JSON.stringify(payload));
      MEM.currentWinner = payload.name;

      // append to winners ledger
      try {
        const row = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: payload.name,
          prize: "Raffle Winner — T-Shirt",
          source: "raffle",
          windowKey,
          ts: new Date().toISOString(),
        };
        await redis.rPush("raffle:winners:all", JSON.stringify(row));
        await redis.lTrim("raffle:winners:all", -500, -1);
      } catch (e) {
        console.warn("winner ledger append (raffle) failed:", e?.message || e);
      }

      // best-effort broadcast (if you have an SSE relay)
      try {
        await fetch("https://winner-sse-server.onrender.com/broadcast", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ winner: payload.name }),
        });
      } catch {}

      return res.json({ success: true, winner: payload });
    } catch (err) {
      console.error("❌ pick-winner:", err);
      return res.status(500).json({ error: "Failed to pick winner" });
    }
  }

  if (action === "reset-winner" && req.method === "POST") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    await ensureRedisConnected();
    try {
      if (redis?.isOpen) await redis.del("raffle_winner");
      MEM.currentWinner = null;
      try { await fetch("https://winner-sse-server.onrender.com/reset", { method: "POST" }); } catch {}
      return res.json({ success: true });
    } catch (err) {
      console.error("❌ reset-winner:", err);
      return res.status(500).json({ success: false, error: "Failed to reset winner" });
    }
  }

  /* ────────────────────────────────────────────────────────────
     WINNERS LEDGER (only)
  ───────────────────────────────────────────────────────────── */
  if (action === "winner-log" && req.method === "POST") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    const { name, prize } = req.body || {};
    const cleanName  = (name || "").toString().trim().slice(0, 120);
    const cleanPrize = (prize || "").toString().trim().slice(0, 160);
    if (!cleanName || !cleanPrize) return res.status(400).json({ error: "name and prize required" });

    const row = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      name: cleanName,
      prize: cleanPrize,
      ts: new Date().toISOString(),
    };

    try {
      const ok = await ensureRedisConnected();
      if (!ok || !redis?.isOpen) {
        MEM.winners.push(row);
        if (MEM.winners.length > 500) MEM.winners = MEM.winners.slice(-500);
        return res.status(200).json({ success: true, row, _fallback: true });
      }
      await redis.rPush("raffle:winners:all", JSON.stringify(row));
      await redis.lTrim("raffle:winners:all", -500, -1);
      return res.status(200).json({ success: true, row });
    } catch (e) {
      console.error("winner-log failed:", e);
      return res.status(500).json({ error: "winner-log failed" });
    }
  }

  if (action === "winner-logs" && req.method === "GET") {
    try {
      const ok = await ensureRedisConnected();
      if (ok && redis?.isOpen) {
        const raw = await redis.lRange("raffle:winners:all", -200, -1);
        const rows = raw.map(s => { try { return JSON.parse(s); } catch { return null; } })
                        .filter(Boolean)
                        .reverse();
        return res.status(200).json({ rows });
      } else {
        const rows = [...(MEM.winners || [])].slice(-200).reverse();
        return res.status(200).json({ rows, _fallback: true });
      }
    } catch (e) {
      console.error("winner-logs failed:", e);
      return res.status(500).json({ rows: [], error: "fetch failed" });
    }
  }

  /* ────────────────────────────────────────────────────────────
     FOLLOWERS / SOCIAL
  ───────────────────────────────────────────────────────────── */
  if (action === "followers" && req.method === "GET") {
    try {
      const token = process.env.FB_PAGE_TOKEN;
      const pageId = process.env.FB_PAGE_ID;
      const igId   = process.env.IG_ACCOUNT_ID;
      if (!token || !pageId || !igId) {
        return res.status(200).json({ facebook: 0, instagram: 0, _note: "missing env" });
      }
      const fbRes = await fetch(`https://graph.facebook.com/v19.0/${pageId}?fields=fan_count&access_token=${token}`);
      const igRes = await fetch(`https://graph.facebook.com/v19.0/${igId}?fields=followers_count&access_token=${token}`);
      const fbJson = await fbRes.json().catch(() => ({}));
      const igJson = await igRes.json().catch(() => ({}));
      return res.status(200).json({
        facebook: Number(fbJson?.fan_count || 0),
        instagram: Number(igJson?.followers_count || 0)
      });
    } catch (err) {
      console.error("❌ followers:", err?.message || err);
      return res.status(200).json({ facebook: 0, instagram: 0 });
    }
  }

  if (req.method === "GET" && action === "check-follow") {
    await ensureRedisConnected();
    const { windowKey } = await getWindowInfo();
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "unknown";
    let raw = null;
    try { raw = await redis.get(`social:${windowKey}:${ip}`); } catch {}
    if (!raw) try { raw = await redis.get(`social:${ip}`); } catch {}
    return res.status(200).json({ allowed: isFollowAllowed(raw) });
  }

  // Exposed for the admin page button; independent of spin history removal
  if (action === "slot-spins-version" && req.method === "GET") {
    const ok = await ensureRedisConnected();
    if (!ok || !redis?.isOpen) return res.status(200).json({ version: 0 });
    const v = Number(await redis.get("slot:spinsResetVersion").catch(() => 0)) || 0;
    return res.status(200).json({ version: v });
  }

  if (action === "reset-slot-spins" && req.method === "POST") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    const ok = await ensureRedisConnected();
    if (!ok || !redis?.isOpen) return res.status(503).json({ error: "Redis not ready" });
    const version = await redis.incr("slot:spinsResetVersion");
    await redis.set("slot:spinsResetAt", new Date().toISOString(), { EX: 60 * 60 * 24 * 7 });
    return res.status(200).json({ success: true, version });
  }

  if (req.method === "GET" && action === "social-status") {
    const ok = await ensureRedisConnected();
    if (!ok || !redis?.isOpen) {
      return res.status(200).json({
        totals: { uniqueIPsTracked: 0, unlocked: 0, facebookClicks: 0, instagramClicks: 0 },
        entries: [],
        _fallback: true
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
      if (!raw) continue;
      let s;
      try { s = JSON.parse(raw); }
      catch { s = { followed: raw === "true", platforms: {} }; }
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

  if (req.method === "POST" && action === "toggle-shutdown") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    const ok = await ensureRedisConnected();
    if (!ok || !redis?.isOpen) return res.status(503).json({ error: "Redis not ready" });

    const current = await redis.get("shutdown");
    const newStatus = current !== "true";
    await redis.set("shutdown", newStatus ? "true" : "false");
    return res.status(200).json({ success: true, isShutdown: newStatus });
  }

  /* ────────────────────────────────────────────────────────────
     MARK FOLLOW (per IP + platform) — union, window-scoped
  ───────────────────────────────────────────────────────────── */
  if (req.method === "POST" && action === "mark-follow") {
    // Accept platform from query or body; normalize synonyms; never 400 on odd input
    let rawPlat = (url.searchParams.get("platform") ?? req.body?.platform ?? "")
      .toString().trim().toLowerCase();
    const platform = rawPlat === "facebook" ? "fb" : rawPlat === "instagram" ? "ig" : rawPlat;

    if (platform !== "fb" && platform !== "ig") {
      return res.status(200).json({ success: true, ignored: true }); // don't break sendBeacon flow
    }

    const ok = await ensureRedisConnected();
    if (!ok || !redis?.isOpen) {
      return res.status(200).json({ success: true, throttled: true, note: "redis not ready" });
    }

    const { windowKey, ttlSeconds } = await getWindowInfo();
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";

    // Short per-IP lock to prevent double events from one tap
    const lockKey = `social:lock:${windowKey}:${ip}`;
    try {
      const got = await redis.set(lockKey, platform, { NX: true, PX: 1000 });
      if (!got) {
        return res.status(200).json({ success: true, throttled: true });
      }
    } catch {}

    const key    = `social:${windowKey}:${ip}`;
    const setKey = `social:ips:${windowKey}`;
    const now    = new Date().toISOString();

    // Union state
    let state = {
      firstSeen: now,
      lastSeen:  now,
      followed:  true,
      count:     0,
      platforms: { fb: false, ig: false },
    };

    const prev = await redis.get(key).catch(() => null);
    if (prev) {
      try {
        const s = JSON.parse(prev);
        state.firstSeen = s.firstSeen || state.firstSeen;
        state.count     = Number(s.count || 0);
        state.platforms = { fb: !!(s.platforms?.fb), ig: !!(s.platforms?.ig) };
      } catch {}
    }

    state.lastSeen = now;
    state.followed = true;
    state.count += 1;
    state.platforms[platform] = true;

    await redis.set(key, JSON.stringify(state), { EX: ttlSeconds });
    await redis.sAdd(setKey, ip);

    return res.status(200).json({ success: true, state });
  }

  /* ────────────────────────────────────────────────────────────
     SLOT PRIZE LOG → winners only (no spin logs kept)
  ───────────────────────────────────────────────────────────── */
  if (action === "prize-log" && req.method === "POST") {
    // We keep NO spin history. Only append to winners when jackpot.
    const ok = await ensureRedisConnected();
    const { windowKey } = await getWindowInfo();

    const name = (req.body?.name || "").toString().slice(0, 80) || "(anonymous)";
    const rawTargets = Array.isArray(req.body?.targets) ? req.body.targets : [];
    const targets = rawTargets.map((t) => String(t));
    const explicitJackpot = !!req.body?.jackpot;

    const trimmed = targets.map((t) => t.trim()).filter(Boolean);
    const lowered = trimmed.map((t) => t.toLowerCase());
    const tripleSame = trimmed.length >= 3 && new Set(lowered.slice(0, 3)).size === 1;
    const textSaysJackpot = /jackpot/i.test(trimmed.join(" "));
    const isJackpot = explicitJackpot || tripleSame || textSaysJackpot;

    if (!isJackpot) {
      // acknowledge but do not store anything
      return res.status(200).json({ success: true, ignored: true, isJackpot: false });
    }

    // Friendly prize label
    let prizeName = "Jackpot";
    if (tripleSame && trimmed.length) prizeName = trimmed[0];
    else if (trimmed.length) prizeName = trimmed[0];

    try {
      if (ok && redis?.isOpen) {
        const row = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name,
          prize: `Slot Jackpot — ${prizeName}`,
          source: "slot",
          windowKey,
          ts: new Date().toISOString(),
        };
        await redis.rPush("raffle:winners:all", JSON.stringify(row));
        await redis.lTrim("raffle:winners:all", -500, -1);
        return res.status(200).json({ success: true, isJackpot: true });
      } else {
        MEM.winners.push({
          id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name,
          prize: `Slot Jackpot — ${prizeName}`,
          source: "slot",
          windowKey,
          ts: new Date().toISOString(),
        });
        if (MEM.winners.length > 500) MEM.winners = MEM.winners.slice(-500);
        return res.status(200).json({ success: true, _fallback: true, isJackpot: true });
      }
    } catch (e) {
      console.error("prize-log failed:", e);
      return res.status(500).json({ success: false, error: "prize-log failed" });
    }
  }

  /* ───── UNKNOWN ───── */
  return res.status(400).json({ error: "Invalid action or method" });
}
