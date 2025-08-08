import fs from "fs";
import path from "path";
import { createClient } from "redis";
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

// ENV constants
const ADMIN_PASS = process.env.ADMIN_PASS;
const MODERATOR_PASS = process.env.MODERATOR_PASS;
const uploadsPath = path.join(process.cwd(), "uploads.json");

const isLocal = process.env.VERCEL_ENV !== "production";

// ---------- Redis (singleton) ----------
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

// Return a boolean (important!)
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

// R2 (Cloudflare S3-compatible) client
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// small helper
function timeout(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Timeout after " + ms + "ms")), ms)
  );
}

export default async function handler(req, res) {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const action = url.searchParams.get("action");
  console.log("➡️ Incoming admin action:", req.method, action);

  // parse JSON bodies
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

  // ────── Redis warm/status ──────
  if (req.method === "GET" && action === "redis-status") {
    try {
      if (!(await ensureRedisConnected())) return res.status(200).json({ status: "idle" });
      const ping = await redis.ping();
      return res.status(200).json({ status: ping === "PONG" ? "active" : "unknown" });
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
      const pong = await redis.ping();
      return res.status(200).json({ success: true, pong });
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
        // fallback to reasonable defaults
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

  // ────── SAVE UPLOAD ──────
  if (action === "save-upload" && req.method === "POST") {
    const ok = await ensureRedisConnected();
    if (!ok) return res.status(503).json({ error: "Redis not ready" });

    // Server-side follow enforcement
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0] ||
      req.socket.remoteAddress ||
      "unknown";
    const rawFollow = await redis.get(`social:${ip}`).catch(() => null);
    if (!isFollowAllowed(rawFollow)) {
      return res.status(403).json({ error: "Follow us first to upload." });
    }

    const { fileName, mimeType, userName, originalFileName } = req.body || {};
    if (!fileName || !mimeType || !userName) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const fileUrl = `https://${process.env.R2_PUBLIC_DOMAIN}/${fileName}`;
    const upload = {
      id: fileName,
      fileName,
      mimeType,
      userName,
      fileUrl,
      originalFileName: originalFileName || fileName,
      createdTime: new Date().toISOString(),
      votes: 0,
      count: 1,
    };

    try {
      const existing = await redis.lRange("uploads", 0, -1);
      const already = existing.some((x) => {
        try {
          return JSON.parse(x).fileName === fileName;
        } catch {
          return false;
        }
      });
      if (!already) await redis.rPush("uploads", JSON.stringify(upload));

      // local mirror for dev
      if (isLocal) {
        const arr = fs.existsSync(uploadsPath)
          ? JSON.parse(fs.readFileSync(uploadsPath, "utf8"))
          : [];
        if (!arr.some((x) => x.fileName === fileName)) {
          arr.push(upload);
          fs.writeFileSync(uploadsPath, JSON.stringify(arr, null, 2));
        }
      }

      // ensure vote key exists
      const voteKey = `votes:${fileName}`;
      if (!(await redis.get(voteKey))) await redis.set(voteKey, "0");

      return res.json({ success: true });
    } catch (err) {
      console.error("❌ Failed to save upload:", err);
      return res.status(500).json({ error: "Failed to save upload" });
    }
  }

  // ────── LIST UPLOADS / R2 FILES ──────
  if (action === "uploads" && req.method === "GET") {
    await ensureRedisConnected();
    const raw = (await redis?.lRange?.("uploads", 0, -1)) || [];
    const uploads = raw.map((e) => {
      try { return JSON.parse(e); } catch { return null; }
    }).filter(Boolean);

    for (const u of uploads) {
      const voteKey = `votes:${u.fileName}`;
      const count = parseInt((await redis.get(voteKey)) || "0", 10);
      u.votes = count;
    }
    return res.json(uploads);
  }

  if (action === "list-r2-files" && req.method === "GET") {
    try {
      const list = await s3.send(
        new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME })
      );
      const files = (list.Contents || []).map((item) => ({
        key: item.Key,
        url: `https://${process.env.R2_PUBLIC_DOMAIN}/${item.Key}`,
        lastModified: item.LastModified,
        size: item.Size,
      }));
      return res.json({ files });
    } catch (err) {
      console.error("❌ Failed to list R2 files:", err.message);
      return res.status(500).json({ error: "Failed to list R2 files" });
    }
  }

  // ────── VOTES ──────
  if (action === "upvote" && req.method === "POST") {
    await ensureRedisConnected();
    const { fileId } = req.body || {};
    if (!fileId) return res.status(400).json({ error: "Missing fileId" });

    const voteKey = `votes:${fileId}`;
    const newVoteCount = await redis.incr(voteKey);
    await redis.publish(`vote:${fileId}`, String(newVoteCount));

    const raw = await redis.lRange("uploads", 0, -1);
    const updated = raw.map((str) => {
      const entry = JSON.parse(str);
      if (entry.fileName === fileId || entry.id === fileId) {
        entry.votes = newVoteCount;
      }
      return entry;
    });
    await redis.del("uploads");
    await redis.rPush("uploads", updated.map((e) => JSON.stringify(e)));

    return res.json({ success: true, votes: newVoteCount });
  }

  if (req.method === "GET" && url.searchParams.get("action") === "get-votes") {
    const fileId = url.searchParams.get("fileId");
    if (!fileId) return res.status(400).json({ error: "Missing fileId" });
    const count = await redis.get(`votes:${fileId}`);
    return res.status(200).json({ votes: parseInt(count || "0", 10) });
  }

  // ────── RESET VOTES ──────
  if (action === "reset-votes" && req.method === "POST") {
    await ensureRedisConnected();
    const { role } = req.body || {};
    if (role !== "admin") return res.status(400).json({ error: "Unauthorized" });

    try {
      const voteKeys = await redis.keys("votes:*");
      if (voteKeys.length > 0) await redis.del(voteKeys);
      await redis.set("resetVotesTimestamp", Date.now().toString());

      try {
        await fetch("https://vote-stream-server.onrender.com/reset", { method: "POST" });
      } catch (err) {
        console.warn("⚠️ Failed to notify SSE server of reset", err.message);
      }
      return res.json({ success: true });
    } catch (err) {
      console.error("❌ Error resetting votes:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  // ────── WINNER ──────
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

  // ────── PICK WINNER ──────
  if (action === "pick-winner" && req.method === "POST") {
    await ensureRedisConnected();
    const { role } = req.body || {};
    if (role !== "admin") return res.status(401).json({ error: "Unauthorized" });

    try {
      const raw = await redis.lRange("uploads", 0, -1);
      const uploads = raw.map((e) => JSON.parse(e));

      const entries = [];
      for (const u of uploads) {
        const voteKey = `votes:${u.fileName}`;
        const voteCount = parseInt((await redis.get(voteKey)) || "0", 10);
        const totalEntries = 1 + voteCount;
        for (let i = 0; i < totalEntries; i++) {
          entries.push({ name: u.userName, fileId: u.fileName });
        }
      }

      if (!entries.length) return res.status(400).json({ error: "No eligible entries" });

      const winner = entries[Math.floor(Math.random() * entries.length)];
      await redis.set("raffle_winner", JSON.stringify(winner));

      try {
        await fetch("https://winner-sse-server.onrender.com/broadcast", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ winner: winner.name }),
        });
      } catch (broadcastErr) {
        console.warn("⚠️ Broadcast winner failed:", broadcastErr.message);
      }

      return res.json({ success: true, winner });
    } catch (err) {
      console.error("❌ Error picking winner:", err);
      return res.status(500).json({ error: "Failed to pick winner" });
    }
  }

  // ────── 🧹 RESET WINNER ──────
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
    // Optionally notify SSE listeners that winner was cleared (if your SSE server supports it)
    // await fetch("https://winner-sse-server.onrender.com/announce-winner", {
    //   method: "POST",
    //   headers: { "Content-Type": "application/json" },
    //   body: JSON.stringify({ winner: "" })
    // });

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ Failed to reset winner:", err);
    return res.status(500).json({ success:false, error: "Failed to reset winner" });
  }
}


  // ────── DELETE FILE ──────
  if (action === "delete-file" && req.method === "POST") {
    await ensureRedisConnected();
    const { fileId } = req.body || {};
    if (!fileId) return res.status(400).json({ error: "Missing fileId" });

    try {
      const uploadItems = await redis.sendCommand(["LRANGE", "uploads", "0", "-1"]);
      const uploads = uploadItems
        .map((i) => {
          try { return JSON.parse(i); } catch { return null; }
        })
        .filter(Boolean);

      const remaining = uploads.filter((u) => u.fileName !== fileId);
      await redis.del("uploads");
      for (const u of remaining) {
        await redis.rPush("uploads", JSON.stringify(u));
      }

      await redis.del(`votes:${fileId}`);

      await s3.send(
        new DeleteObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: fileId,
        })
      );

      return res.json({ success: true });
    } catch (err) {
      console.error("❌ Failed to delete file:", err);
      return res.status(500).json({ error: "Delete failed" });
    }
  }

  // ────── CLEAR ALL ──────
  if (action === "clear-all" && req.method === "POST") {
    await ensureRedisConnected();
    const auth = req.headers.authorization || "";
    const isSuperAdmin =
      auth.startsWith("Bearer:super:") &&
      auth.split("Bearer:super:")[1] === ADMIN_PASS;
    if (!isSuperAdmin) return res.status(401).json({ error: "Unauthorized" });

    try {
      await redis.del("uploads", "raffle_winner", "resetVotesTimestamp");
      const voteKeys = await redis.keys("votes:*");
      if (voteKeys.length > 0) await redis.del(...voteKeys);

      const list = await s3.send(
        new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME })
      );
      for (const item of list.Contents || []) {
        try {
          await s3.send(
            new DeleteObjectCommand({
              Bucket: process.env.R2_BUCKET_NAME,
              Key: item.Key,
            })
          );
        } catch (err) {
          console.warn("⚠️ Failed to delete R2 object:", item.Key, err.message);
        }
      }

      if (isLocal && fs.existsSync(uploadsPath)) {
        fs.writeFileSync(uploadsPath, "[]");
      }

      return res.json({ success: true });
    } catch (err) {
      console.error("🔥 clear-all error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  }

  // ────── SOCIAL STATS (FB/IG follower counts) ──────
  if (action === "social-counts" && req.method === "GET") {
    return res.json({
      facebook: { followers: 1234 },
      instagram: { followers: 5678 },
    });
  }

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
      // Redis not ready — succeed without error so admin UI doesn't fail
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

  // ────── CHECK FOLLOW STATUS ──────
  if (req.method === "GET" && action === "check-follow") {
    await ensureRedisConnected();
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0] ||
      req.socket.remoteAddress ||
      "unknown";
    const raw = await redis.get(`social:${ip}`).catch(() => null);
    return res.status(200).json({ allowed: isFollowAllowed(raw) });
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
      // Graceful fallback to keep the client running
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
      followed: true,
      count: 0,
      platforms: {},
    };

    const prev = await redis.get(key).catch(() => null);
    if (prev) {
      try {
        state = JSON.parse(prev);
      } catch {
        // legacy "true"
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

  // ────── SOCIAL STATUS (admin view) ──────
  if (req.method === "GET" && action === "social-status") {
    const ok = await ensureRedisConnected();
    if (!ok) {
      // Graceful empty response so UI doesn't error
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

  // ────── UNKNOWN ──────
  return res.status(400).json({ error: "Invalid action or method" });
}
