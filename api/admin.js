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

// Redis connection (robust + timeout-safe)
let redis;

if (!globalThis.__redis && process.env.REDIS_URL) {
  const client = createClient({
    url: process.env.REDIS_URL,
    socket: {
      connectTimeout: 5000, // ⏱ prevents 10s stalls
      reconnectStrategy: retries => Math.min(retries * 200, 3000), // 🔁 retry quickly then slow
    },
  });

  client
    .connect()
    .then(() => console.log("✅ Redis connected"))
    .catch(err => console.error("❌ Redis connection failed:", err));

  globalThis.__redis = client;
}

redis = globalThis.__redis;


// 🛠 Ensure Redis is always connected
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

// R2 (Cloudflare S3-compatible) client
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// Helper to add a timeout to async operations
function timeout(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Timeout after " + ms + "ms")), ms)
  );
}

export default async function handler(req, res) {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const action = url.searchParams.get("action");
  console.log("➡️ Incoming admin action:", req.method, action);

  // JSON parser for POST
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
      req.body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }
  }

  // ────── 🔐 AUTH ──────
  if (action === "login" && req.method === "POST") {
    const { password } = req.body;
    if (password === ADMIN_PASS)
      return res.json({ success: true, role: "admin" });
    if (password === MODERATOR_PASS)
      return res.json({ success: true, role: "moderator" });
    return res.status(401).json({ success: false, error: "Invalid password" });
  }

  // ────── ⚙️ CONFIG ──────
  if (action === "config") {
  if (req.method === "GET") {
    await ensureRedisConnected();

    // ✅ NEW: fallback if Redis still isn't connected
    if (!redis?.isOpen) {
      console.warn("❌ Redis is not connected. Using fallback config.");
      return res.status(200).json({
        showName: "90 Surge",
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(), // 3h later
      });
    }

      try {
        if (isLocal) {
          const config = JSON.parse(
            fs.readFileSync(path.join(process.cwd(), "config.json"), "utf8")
          );
          return res.json(config);
        } else {
          console.log("📡 Loading config from Redis...");

          const [showName, startTime, endTime] = await Promise.race([
            Promise.all([
              redis.get("showName").catch(() => ""),
              redis.get("startTime").catch(() => ""),
              redis.get("endTime").catch(() => ""),
            ]),
            timeout(10000),
          ]);

          console.log("⚙️ Responding with config:", {
            showName,
            startTime,
            endTime,
          });

          return res.json({ showName, startTime, endTime });
        }
      } catch (err) {
        console.error("❌ Config load error:", err.message);
        return res.status(500).json({ error: "Failed to load config" });
      }
    }

    if (req.method === "POST") {
      const { showName, startTime, endTime } = req.body;
      try {
        if (isLocal) {
          fs.writeFileSync(
            path.join(process.cwd(), "config.json"),
            JSON.stringify({ showName, startTime, endTime }, null, 2)
          );
        } else {
          await ensureRedisConnected();

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

  // ────── 💾 UPLOAD ──────
  if (action === "save-upload" && req.method === "POST") {
    await ensureRedisConnected();
    const { fileName, mimeType, userName } = req.body;
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
      createdTime: new Date().toISOString(),
      votes: 0,
      count: 1,
    };

    try {
      const existing = await redis.lRange("uploads", 0, -1);
      const alreadyExists = existing.some((item) => {
        try {
          return JSON.parse(item).fileName === fileName;
        } catch {
          return false;
        }
      });

      if (!alreadyExists) {
        await redis.rPush("uploads", JSON.stringify(upload));
        console.log("✅ Saved to Redis:", fileName);
      }

      if (isLocal) {
        const fileData = fs.existsSync(uploadsPath)
          ? JSON.parse(fs.readFileSync(uploadsPath, "utf8"))
          : [];

        if (!fileData.some((item) => item.fileName === fileName)) {
          fileData.push(upload);
          fs.writeFileSync(uploadsPath, JSON.stringify(fileData, null, 2));
          console.log("💾 Saved locally:", fileName);
        }
      }

      const voteKey = `votes:${fileName}`;
      if (!(await redis.get(voteKey))) await redis.set(voteKey, "0");

      return res.json({ success: true });
    } catch (err) {
      console.error("❌ Failed to save upload:", err);
      return res.status(500).json({ error: "Failed to save upload" });
    }
  }

  if (action === "uploads" && req.method === "GET") {
    await ensureRedisConnected();
    const raw = await redis.lRange("uploads", 0, -1);
    const uploads = raw.map((e) => JSON.parse(e));

    for (const u of uploads) {
      await new Promise((r) => setTimeout(r, 10)); // 10ms
      const voteKey = `votes:${u.fileName}`;
      const count = parseInt(await redis.get(voteKey)) || 0;
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

  // ────── 👍 VOTES ──────
  if (action === "upvote" && req.method === "POST") {
    await ensureRedisConnected();
    const { fileId } = req.body;
    if (!fileId) return res.status(400).json({ error: "Missing fileId" });

    const voteKey = `votes:${fileId}`;
    const newVoteCount = await redis.incr(voteKey);

    // ✅ Now publish the update
    await redis.publish(`vote:${fileId}`, newVoteCount.toString());

    // Optional: update the uploads list as before...
    const raw = await redis.lRange("uploads", 0, -1);
    let currentVotes = 0;

    const updated = raw.map((str) => {
      const entry = JSON.parse(str);
      if (entry.fileName === fileId || entry.id === fileId) {
        entry.votes = newVoteCount;
        currentVotes = entry.votes;
      }
      return entry;
    });

    await redis.del("uploads");
    await redis.rPush(
      "uploads",
      updated.map((e) => JSON.stringify(e))
    );

    return res.json({
      success: true,
      votes: newVoteCount,
    });
  }

  if (req.method === "GET" && req.query.action === "get-votes") {
    const fileId = req.query.fileId;
    console.log("🔍 Fetching vote count for:", fileId);
    if (!fileId) return res.status(400).json({ error: "Missing fileId" });

    const count = await redis.get(`votes:${fileId}`);
    return res.status(200).json({ votes: parseInt(count || "0", 10) });
  }

  // ------ RESET VOTES ------
  if (action === "reset-votes" && req.method === "POST") {
    await ensureRedisConnected();
    const { role } = req.body;

    if (role !== "admin") {
      return res.status(400).json({ error: "Unauthorized" });
    }

    try {
      // Clear all vote counts
      const voteKeys = await redis.keys("votes:*");
      if (voteKeys.length > 0) await redis.del(voteKeys);

      // Reset timestamps
      await redis.set("resetVotesTimestamp", Date.now().toString());

      try {
        await fetch("https://vote-stream-server.onrender.com/reset", {
          method: "POST",
        });
      } catch (err) {
        console.warn("⚠️ Failed to notify SSE server of reset", err.message);
      }

      return res.json({ success: true });
    } catch (err) {
      console.error("❌ Error resetting votes:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  // ────── 🏆 WINNER ──────
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

  // ────── 🎉 PICK WINNER ──────

  if (action === "pick-winner" && req.method === "POST") {
    await ensureRedisConnected();
    const { role } = req.body;
    if (role !== "admin") {
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      const raw = await redis.lRange("uploads", 0, -1);
      const uploads = raw.map((e) => JSON.parse(e));

      console.log("🔍 Raw uploads from Redis:", uploads);

      const entries = [];

      for (const u of uploads) {
        await new Promise((r) => setTimeout(r, 10)); // 10ms
        const voteKey = `votes:${u.fileName}`;
        const voteCount = parseInt(await redis.get(voteKey)) || 0;
        const totalEntries = 1 + voteCount;

        console.log(
          `🗳 ${u.userName} – ${u.fileName} – votes: ${voteCount} – total entries: ${totalEntries}`
        );

        for (let i = 0; i < totalEntries; i++) {
          entries.push({ name: u.userName, fileId: u.fileName });
        }
      }

      if (entries.length === 0) {
        console.warn(
          "❌ No eligible entries found. All uploads may be missing userName or votes."
        );
        return res.status(400).json({ error: "No eligible entries" });
      }

      const winner = entries[Math.floor(Math.random() * entries.length)];
      await redis.set("raffle_winner", JSON.stringify(winner));

      // 🔔 Broadcast to SSE server
      try {
        await fetch("https://winner-sse-server.onrender.com/broadcast", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ winner: winner.name }),
        });
      } catch (broadcastErr) {
        console.warn("⚠️ Failed to broadcast winner:", broadcastErr.message);
      }

      return res.json({ success: true, winner });
    } catch (err) {
      console.error("❌ Error picking winner:", err);
      return res.status(500).json({ error: "Failed to pick winner" });
    }
  }

  // ────── 🧹 DELETE FILES ──────

  if (action === "delete-file" && req.method === "POST") {
    await ensureRedisConnected();
    const { fileId } = req.body;
    if (!fileId) return res.status(400).json({ error: "Missing fileId" });

    try {
      const uploadItems = await redis.sendCommand([
        "LRANGE",
        "uploads",
        "0",
        "-1",
      ]);
      const uploads = uploadItems
        .map((i) => {
          try {
            return JSON.parse(i);
          } catch {
            return null;
          }
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

  if (action === "clear-all" && req.method === "POST") {
    await ensureRedisConnected();
    const auth = req.headers.authorization || "";
    const isSuperAdmin =
      auth.startsWith("Bearer:super:") &&
      auth.split("Bearer:super:")[1] === ADMIN_PASS;

    if (!isSuperAdmin) return res.status(401).json({ error: "Unauthorized" });

    try {
      // Clear Redis data
      await redis.del("uploads", "raffle_winner", "resetVotesTimestamp");
      const voteKeys = await redis.keys("votes:*");
      if (voteKeys.length > 0) await redis.del(...voteKeys);

      // Clear R2 bucket
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

      // Optional: clear local file if running locally
      if (isLocal && fs.existsSync(uploadsPath)) {
        fs.writeFileSync(uploadsPath, "[]");
      }

      return res.json({ success: true });
    } catch (err) {
      console.error("🔥 clear-all error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  }

  // ────── 📣 SOCIAL STATS ──────
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

  // ────── ❌ UNKNOWN ──────
  return res.status(400).json({ error: "Invalid action or method" });
}
