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

// ───────────────────────────────────────────────────────────────
// Main handler
// ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  theAction: {
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
        res.status(400).json({ error: "Invalid JSON" });
        break theAction;
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
    //   POST action=enter             -> add one entry PER platform click (fb/ig); at most 1 each per IP/show
    //   GET  action=entries           -> list raw entries
    //   GET  action=entries-summary   -> {rows:[{name, entries}]}
    //   GET  action=winner            -> get current winner
    //   POST action=pick-winner       -> random among entries (users with 2 clicks appear twice)
    //   POST action=reset-winner      -> clear winner + broadcast reset
    //   POST action=reset-entries     -> clear entries for current show window
    // ───────────────────────────────────────────────────────────────

    if (action === "enter" && req.method === "POST") {
      const ok = await ensureRedisConnected();
      if (!ok) return res.status(503).json({ error: "Redis not ready" });

      const nameRaw = (req.body?.name || "").trim();
      if (!nameRaw) return res.status(400).json({ error: "Missing name" });
      const name = nameRaw.slice(0, 80);

      const platform = String(req.body?.platform || url.searchParams.get("platform") || "").toLowerCase();
      if (platform !== "fb" && platform !== "ig") {
        return res.status(400).json({ error: "Missing platform" });
      }

      const ip =
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        req.socket.remoteAddress ||
        "unknown";

      // Optional "fast" flag retained for compatibility; we don't enforce follow in fast mode.
      const fast = !!req.body?.fast;
      if (!fast) {
        const rawFollow = await redis.get(`social:${ip}`).catch(() => null);
        if (!isFollowAllowed(rawFollow)) {
          return res.status(403).json({ error: "Follow us on FB or IG to enter." });
        }
      }

      const { windowKey, ttlSeconds } = await getWindowInfo();
      const listKey = `raffle:entries:${windowKey}`;
      const setKey = `raffle:entered:${windowKey}:${platform}`; // de-dupe per platform

      // Only 1 entry per IP per platform
      const already = await redis.sIsMember(setKey, ip);
      if (already) {
        return res.status(200).json({ success: true, already: true, platform });
      }

      const entry = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
        name,
        ip,
        platform, // "fb" | "ig"
        createdTime: new Date().toISOString(),
      };

      await redis
        .multi()
        .sAdd(setKey, ip)
        .rPush(listKey, JSON.stringify(entry))
        .expire(setKey, ttlSeconds)
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
        .map((s) => {
          try {
            return JSON.parse(s);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      return res.status(200).json({ entries, count: entries.length });
    }

    // Summarized admin table: Name + total Entries (each click is an entry)
    if (action === "entries-summary" && req.method === "GET") {
      const ok = await ensureRedisConnected();
      if (!ok) return res.status(200).json({ rows: [] });

      const { windowKey } = await getWindowInfo();
      const listKey = `raffle:entries:${windowKey}`;
      const raw = await redis.lRange(listKey, 0, -1);

      const map = new Map(); // name -> count
      for (const s of raw) {
        try {
          const e = JSON.parse(s);
          const name = String(e?.name || "").trim();
          if (!name) continue;
          map.set(name, (map.get(name) || 0) + 1);
        } catch {}
      }

      const rows = Array.from(map, ([name, entries]) => ({ name, entries }))
        .sort((a, b) => b.entries - a.entries || a.name.localeCompare(b.name));

      return res.status(200).json({ rows });
    }

    // ────── RESET ENTRIES (no winner change) ──────
    if (action === "reset-entries" && req.method === "POST") {
      const authHeader = req.headers.authorization || "";
      const isAdmin =
        authHeader.startsWith("Bearer:super:") &&
        authHeader.endsWith(process.env.ADMIN_PASS);
      if (!isAdmin) return res.status(403).json({ error: "Forbidden" });

      const ok = await ensureRedisConnected();
      if (!ok) return res.status(503).json({ error: "Redis not ready" });

      const { windowKey } = await getWindowInfo();
      const listKey = `raffle:entries:${windowKey}`;
      const setKeyFb = `raffle:entered:${windowKey}:fb`;
      const setKeyIg = `raffle:entered:${windowKey}:ig`;

      try {
        await redis.del(listKey, setKeyFb, setKeyIg);
        return res.status(200).json({ success: true });
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

    // Random among entries (users with 2 clicks appear twice)
    if (action === "pick-winner" && req.method === "POST") {
      await ensureRedisConnected();
      const { role } = req.body || {};
      if (role !== "admin") return res.status(401).json({ error: "Unauthorized" });

      try {
        const { windowKey } = await getWindowInfo();
        const listKey = `raffle:entries:${windowKey}`;
        const raw = await redis.lRange(listKey, 0, -1);
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
          return res.status(400).json({ error: "No eligible entries" });
        }

        const idx = Math.floor(Math.random() * entries.length);
        const winner = entries[idx];

        const payload = {
          id: winner.id,
          name: winner.name,
          weight: 1,
          platforms: { [winner.platform]: true },
        };

        await redis.set("raffle_winner", JSON.stringify(payload));

        try {
          await fetch("https://winner-sse-server.onrender.com/broadcast", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ winner: payload.name }),
          });
        } catch (broadcastErr) {
          console.warn("⚠️ Broadcast winner failed:", broadcastErr.message);
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

    // ────── RESET SOCIAL (safe even if Redis is cold) ──────
    if (req.method === "POST" && action === "reset-social") {
      try {
        const ok = await ensureRedisConnected();
        if (ok) {
          const toDel = [];
          for await (const key of redis.scanIterator({ MATCH: "social:*", COUNT: 200 })) {
            toDel.push(key);
          }
          if (toDel.length) await redis.del(...toDel);
          await redis.del("social:ips");
          return res.status(200).json({ success: true, deleted: toDel.length });
        }
        return res.status(200).json({ success: true, deleted: 0, note: "redis not ready" });
      } catch (err) {
        console.error("❌ Reset social error:", err);
        return res.status(500).json({
          success: false,
          error: "Failed to reset social follow tracking",
          details: err.message,
        });
      }
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

    // ────── MARK FOLLOW (per IP + platform) ──────
    if (req.method === "POST" && action === "mark-follow") {
      const ok = await ensureRedisConnected();
      if (!ok) return res.status(503).json({ error: "Redis not ready" });

      const urlPlatform = url.searchParams.get("platform");
      const bodyPlatform = (req.body && req.body.platform) || null;
      const platform = (urlPlatform || bodyPlatform || "").toLowerCase(); // "fb" | "ig" | ""

      const ip =
        req.headers["x-forwarded-for"]?.split(",")[0] ||
        req.socket.remoteAddress ||
        "unknown";

      const key = `social:${ip}`;
      const now = new Date().toISOString();
      const EX_SECONDS = 60 * 60 * 8; // 8 hours

      let state = {
        firstSeen: now,
        lastSeen: now,
        followed: true,  // gate opens after first click
        count: 0,
        platforms: {},
      };

      const prev = await redis.get(key).catch(() => null);
      if (prev) {
        try {
          state = JSON.parse(prev);
        } catch {
          state = { ...state, firstSeen: now, lastSeen: now, followed: true };
        }
      }

      state.firstSeen = state.firstSeen || now;
      state.lastSeen = now;
      state.followed = true;
      state.count = (state.count || 0) + 1;
      state.platforms = state.platforms || {};
      if (platform === "fb" || platform === "ig") state.platforms[platform] = true;

      await redis.set(key, JSON.stringify(state), { EX: EX_SECONDS });
      await redis.sAdd("social:ips", ip);

      return res.status(200).json({ success: true });
    }

    // (Optional; safe to keep even if unused)
    if (req.method === "POST" && action === "fb-verify-like") {
      const { accessToken } = req.body || {};
      if (!accessToken) return res.status(400).json({ success: false, error: "Missing access token" });
      try {
        const pageId = process.env.FB_PAGE_ID || "130023783530481";
        const resp = await fetch(
          `https://graph.facebook.com/v19.0/me/likes?target_id=${pageId}&access_token=${encodeURIComponent(
            accessToken
          )}`
        );
        const data = await resp.json();
        if (!resp.ok) {
          console.error("FB verify error:", data);
          return res.status(400).json({ success: false, error: data?.error?.message || "FB error" });
        }
        const liked = Array.isArray(data.data) && data.data.length > 0;

        if (liked) {
          const ok = await ensureRedisConnected();
          if (ok) {
            const ip =
              req.headers["x-forwarded-for"]?.split(",")[0] ||
              req.socket.remoteAddress ||
              "unknown";
            const key = `social:${ip}`;
            const now = new Date().toISOString();
            const EX_SECONDS = 60 * 60 * 8;
            let state = {
              firstSeen: now,
              lastSeen: now,
              followed: true,
              count: 1,
              platforms: { fb: true },
            };
            const prev = await redis.get(key).catch(() => null);
            if (prev) {
              try {
                const p = JSON.parse(prev);
                state = {
                  ...p,
                  lastSeen: now,
                  followed: true,
                  platforms: { ...(p.platforms || {}), fb: true },
                  count: (p.count || 0) + 1,
                };
              } catch {}
            }
            await redis.set(key, JSON.stringify(state), { EX: EX_SECONDS });
            await redis.sAdd("social:ips", ip);
          }
        }
        return res.json({ success: true, liked });
      } catch (err) {
        console.error("fb-verify-like failed:", err);
        return res.status(500).json({ success: false, error: "Server error" });
      }
    }

    // ────── UNKNOWN ──────
    return res.status(400).json({ error: "Invalid action or method" });
  }
}
