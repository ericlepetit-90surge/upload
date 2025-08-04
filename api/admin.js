import fs from "fs";
import path from "path";
import { createClient } from "redis";
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

const ADMIN_PASS = process.env.ADMIN_PASS;
const MODERATOR_PASS = process.env.MODERATOR_PASS;
const uploadsPath = path.join(process.cwd(), "uploads.json");

// Redis client
let globalForRedis = globalThis.__redis || null;
if (!globalForRedis && process.env.REDIS_URL) {
  const client = createClient({ url: process.env.REDIS_URL });
  globalForRedis = client;
  globalThis.__redis = client;
  client.connect().catch(console.error);
}
const redis = globalForRedis;

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

export default async function handler(req, res) {
  const action = req.query.action;
  const isLocal = process.env.NODE_ENV !== "production";

  console.log("➡️ Incoming admin action:", req.method, action);

  // JSON body parser for POST requests
  if (
    req.method === "POST" &&
    req.headers["content-type"]?.includes("application/json")
  ) {
    let body = "";
    await new Promise((resolve) => {
      req.on("data", (chunk) => (body += chunk));
      req.on("end", resolve);
    });
    try {
      req.body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }
  }

  // Login
  if (action === "login" && req.method === "POST") {
    const { password } = req.body;
    if (password === ADMIN_PASS)
      return res.json({ success: true, role: "admin" });
    if (password === MODERATOR_PASS)
      return res.json({ success: true, role: "moderator" });
    return res.status(401).json({ success: false, error: "Invalid password" });
  }

  // Config load/save
  if (action === "config") {
    if (req.method === "GET") {
      try {
        if (isLocal) {
          const config = JSON.parse(
            fs.readFileSync(path.join(process.cwd(), "config.json"), "utf8")
          );
          return res.status(200).json(config);
        } else {
          const showName = await redis.get("showName");
          const startTime = await redis.get("startTime");
          const endTime = await redis.get("endTime");
          return res.status(200).json({ showName, startTime, endTime });
        }
      } catch {
        return res.status(500).json({ error: "Failed to load config" });
      }
    }

    if (req.method === "POST") {
      try {
        const { showName, startTime, endTime } = req.body;
        if (isLocal) {
          fs.writeFileSync(
            path.join(process.cwd(), "config.json"),
            JSON.stringify({ showName, startTime, endTime }, null, 2)
          );
        } else {
          await redis.set("showName", showName || "");
          await redis.set("startTime", startTime || "");
          await redis.set("endTime", endTime || "");
        }
        return res.status(200).json({ success: true });
      } catch {
        return res.status(500).json({ error: "Failed to save config" });
      }
    }
  }

  // Load saved winner
  if (action === "winner" && req.method === "GET") {
    try {
      const winnerData = await redis.get("raffle_winner");
      if (!winnerData) {
        return res.status(200).json({ winner: null });
      }
      return res.status(200).json({ winner: JSON.parse(winnerData) });
    } catch (err) {
      console.error("❌ Failed to fetch winner:", err);
      return res.status(500).json({ error: "Failed to get winner" });
    }
  }

  // Pick random winner (R2-based)
  if (action === "pick-winner" && req.method === "POST") {
    try {
      let allUploads = [];

      if (isLocal) {
        const fileData = fs.readFileSync(uploadsPath, "utf8");
        allUploads = JSON.parse(fileData);
      } else {
        const raw = await redis.lRange("uploads", 0, -1);
        allUploads = raw.map((entry) => JSON.parse(entry));
      }

      if (!Array.isArray(allUploads) || allUploads.length === 0) {
        return res.status(404).json({ error: "No entries found" });
      }

      const eligibleUploads = allUploads.filter((entry) => {
        const isValid = entry.userName && entry.fileUrl;
        console.log(
          `🔍 Checking entry "${entry.userName}" → ${isValid ? "✅" : "❌"}`
        );
        return isValid;
      });

      const allEntries = [];
      for (const entry of eligibleUploads) {
        const name = entry.userName || entry.name;
        if (!name) continue;

        const fileId = entry.fileName;
        const voteKey = `votes:${fileId}`;
        let count = parseInt(await redis.get(voteKey));
        if (isNaN(count) || count < 1) count = 1;

        console.log(`🎟️ ${name} gets ${count} entries`);
        for (let i = 0; i < count; i++) {
          allEntries.push(name);
        }
      }

      if (allEntries.length === 0) {
        return res
          .status(400)
          .json({ error: "No valid entries with active files" });
      }

      const winner = allEntries[Math.floor(Math.random() * allEntries.length)];
      console.log("🎉 Winner picked:", winner);

      if (!isLocal) {
        await redis.set(
          "raffle_winner",
          JSON.stringify({ name: winner, timestamp: Date.now() })
        );
      }

      return res.json({ winner });
    } catch (err) {
      console.error("🔥 pick-winner failed:", err);
      return res.status(500).json({ error: "Failed to pick winner" });
    }
  }

  // Save upload metadata
  if (action === "save-upload" && req.method === "POST") {
    try {
      const { fileName, mimeType, userName } = req.body;
      if (!fileName || !mimeType || !userName) {
        console.warn("❌ Missing fields:", { fileName, mimeType, userName });
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

      console.log("📥 Saving upload metadata:", upload);

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
      } else {
        console.log("⏩ Already exists in Redis:", fileName);
      }

      if (isLocal) {
        const fileData = fs.existsSync(uploadsPath)
          ? JSON.parse(fs.readFileSync(uploadsPath, "utf8"))
          : [];

        const alreadyInFile = fileData.some(
          (item) => item.fileName === fileName
        );
        if (!alreadyInFile) {
          fileData.push(upload);
          fs.writeFileSync(uploadsPath, JSON.stringify(fileData, null, 2));
          console.log("💾 Also saved locally:", upload.fileName);
        }
      }

      const voteKey = `votes:${fileName}`;
      const existingVotes = await redis.get(voteKey);
      if (!existingVotes) {
        await redis.set(voteKey, "1");
      }

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("❌ Failed to save upload:", err);
      return res.status(500).json({ error: "Failed to save upload" });
    }
  }

  // 🔥 Clear all uploads (super admin only)
  if ((action === "clear" || action === "clear-all") && req.method === "POST") {
    try {
      const auth = req.headers.authorization || "";
      const isSuperAdmin =
        auth.startsWith("Bearer:super:") &&
        auth.split("Bearer:super:")[1] === ADMIN_PASS;

      if (!isSuperAdmin) {
        console.warn("⛔ Unauthorized clear-all attempt:", auth);
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      // 🔥 Clear Redis
      await redis.del("uploads", "raffle_winner", "resetVotesTimestamp");
      const voteKeys = await redis.keys("votes:*");
      if (voteKeys.length > 0) {
        await redis.del(voteKeys);
      }

      // 🗑️ Delete all files from R2 bucket
      try {
        const list = await s3.send(
          new ListObjectsV2Command({
            Bucket: process.env.R2_BUCKET_NAME,
          })
        );

        if (list.Contents?.length) {
          for (const item of list.Contents) {
            try {
              await s3.send(
                new DeleteObjectCommand({
                  Bucket: process.env.R2_BUCKET_NAME,
                  Key: item.Key,
                })
              );
              console.log("🗑️ Deleted from R2:", item.Key);
            } catch (err) {
              console.warn(
                "⚠️ Failed to delete R2 object:",
                item.Key,
                err.message
              );
            }
          }
        } else {
          console.log("📭 No objects found in R2 to delete.");
        }
      } catch (err) {
        console.error("❌ Failed to list R2 objects:", err.message);
      }

      // 💾 Clear local uploads.json if in local mode
      if (isLocal && fs.existsSync(uploadsPath)) {
        fs.writeFileSync(uploadsPath, "[]");
        console.log("🧹 Local uploads.json cleared");
      }

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("🔥 clear-all error:", err);
      return res.status(500).json({ success: false, error: "Server error" });
    }
  }

  // uploads

  if (action === "uploads" && req.method === "GET") {
  const raw = await redis.lRange("uploads", 0, -1);
  const uploads = raw.map((entry) => JSON.parse(entry));
  return res.json(uploads);
}

if (action === "list-r2-files" && req.method === "GET") {
  try {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET_NAME,
      })
    );
    return res.status(200).json({ files: list.Contents || [] });
  } catch (err) {
    return res.status(500).json({ error: "Failed to list R2 files" });
  }
}

if (action === "list-r2-files" && req.method === "GET") {
  try {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET_NAME,
      })
    );

    const files = (list.Contents || []).map((item) => ({
      key: item.Key,
      url: `https://${process.env.R2_PUBLIC_DOMAIN}/${item.Key}`,
      lastModified: item.LastModified,
      size: item.Size,
    }));

    return res.status(200).json({ files });
  } catch (err) {
    console.error("❌ Failed to list R2 files:", err.message);
    return res.status(500).json({ error: "Failed to list R2 files" });
  }
}


if (action === "list-r2-files" && req.method === "GET") {
  try {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET_NAME,
      })
    );

    const files = (list.Contents || []).map((item) => ({
      key: item.Key,
      url: `https://${process.env.R2_PUBLIC_DOMAIN}/${item.Key}`,
      lastModified: item.LastModified,
      size: item.Size,
    }));

    return res.status(200).json({ files });
  } catch (err) {
    console.error("❌ Failed to list R2 files:", err.message);
    return res.status(500).json({ error: "Failed to list R2 files" });
  }
}
  // Upvote file
  if (req.method === "POST" && action === "upvote") {
  const { fileId } = req.body;
  if (!fileId) return res.status(400).json({ error: "Missing fileId" });

  if (isLocal) {
    const raw = fs.readFileSync(uploadsPath, "utf8");
    const entries = JSON.parse(raw);
    let currentVotes = 0;

    const updated = entries.map((entry) => {
      if (entry.fileName === fileId || entry.id === fileId) {
        entry.votes = (entry.votes || 0) + 1;
        currentVotes = entry.votes;
      }
      return entry;
    });

    fs.writeFileSync(uploadsPath, JSON.stringify(updated, null, 2));
    return res.status(200).json({ success: true, votes: currentVotes });
  } else {
    const voteKey = `votes:${fileId}`;
    await redis.incr(voteKey); // ✅ increment actual Redis vote count

    const raw = await redis.lRange("uploads", 0, -1);
    let currentVotes = 0;

    const updated = raw
      .map((str) => JSON.parse(str))
      .map((entry) => {
        if (entry.fileName === fileId || entry.id === fileId) {
          entry.votes = (entry.votes || 0) + 1;
          currentVotes = entry.votes;
        }
        return entry;
      });

    await redis.del("uploads");
    await redis.rPush("uploads", updated.map((e) => JSON.stringify(e)));

    const updatedVotes = await redis.get(voteKey);
    return res.status(200).json({ success: true, votes: parseInt(updatedVotes || "0") });
  }
}


  // Reset all votes
  if (action === "reset-votes" && req.method === "POST") {
    try {
      const { role } = req.body;
      if (role !== "admin")
        return res.status(403).json({ error: "Unauthorized" });

      const keys = await redis.keys("votes:*");
      if (keys.length > 0) await redis.del(keys);
      await redis.set("resetVotesTimestamp", Date.now().toString());

      return res.json({ success: true });
    } catch {
      return res.status(500).json({ error: "Failed to reset votes" });
    }
  }

    // get vote
  if (action === "get-vote" && req.method === "GET") {
  const fileId = req.query.fileId;
  if (!fileId) return res.status(400).json({ error: "Missing fileId" });
  const key = `votes:${fileId}`;
  const count = await redis.get(key);
  return res.json({ votes: parseInt(count || "0") });
}

  // Check reset timestamp
  if (action === "check-reset" && req.method === "GET") {
    try {
      const resetTimestamp = await redis.get("resetVotesTimestamp");
      return res.json({ resetTimestamp });
    } catch (err) {
      return res.status(500).json({ error: "Failed to check reset timestamp" });
    }
  }

  // Dummy fallback follower counts
  if (action === "social-counts" && req.method === "GET") {
    return res.status(200).json({
      facebook: { followers: 1234 },
      instagram: { followers: 5678 },
    });
  }

  // Fetch real follower counts
  if (action === "followers" && req.method === "GET") {
    try {
      const token = process.env.FB_PAGE_TOKEN;
      const fbPageId = process.env.FB_PAGE_ID;
      const igAccountId = process.env.IG_ACCOUNT_ID;

      const fbRes = await fetch(
        `https://graph.facebook.com/v19.0/${fbPageId}?fields=fan_count&access_token=${token}`
      );
      const fbJson = await fbRes.json();

      const igRes = await fetch(
        `https://graph.facebook.com/v19.0/${igAccountId}?fields=followers_count&access_token=${token}`
      );
      const igJson = await igRes.json();

      return res.json({
        facebook: fbJson.fan_count || 0,
        instagram: igJson.followers_count || 0,
      });
    } catch (err) {
      return res.status(500).json({ error: "Failed to fetch follower counts" });
    }
  }

  // Catch-all fallback
  return res.status(400).json({ error: "Invalid action" });
}
