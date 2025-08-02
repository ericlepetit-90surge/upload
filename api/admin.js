import fs from "fs";
import path from "path";
import { google } from "googleapis";
import { createClient } from "redis";

const ADMIN_PASS = process.env.ADMIN_PASS;
const MODERATOR_PASS = process.env.MODERATOR_PASS;
const uploadsPath = path.join(process.cwd(), "uploads.json");
const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

const oauthClient = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "oauth-client.json"), "utf8")
);
const tokenData = JSON.parse(process.env.GOOGLE_TOKEN_JSON || "{}");

const auth = new google.auth.OAuth2(
  oauthClient.web.client_id,
  oauthClient.web.client_secret,
  oauthClient.web.redirect_uris[0]
);
auth.setCredentials(tokenData);

// 🔁 Reuse Redis connection
let globalForRedis = globalThis.__redis || null;
if (!globalForRedis && process.env.REDIS_URL) {
  const client = createClient({ url: process.env.REDIS_URL });
  globalForRedis = client;
  globalThis.__redis = client;
  client.connect().catch(console.error);
}
const redis = globalForRedis;

export default async function handler(req, res) {
  const action = req.query.action;
  const isLocal = process.env.VERCEL_ENV !== "production";

  // Manual JSON body parser
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
    } catch (e) {
      return res.status(400).json({ error: "Invalid JSON" });
    }
  }

  // ----------------- LOGIN -----------------
  if (action === "login" && req.method === "POST") {
    const { password } = req.body;
    if (password === ADMIN_PASS)
      return res.json({ success: true, role: "admin" });
    if (password === MODERATOR_PASS)
      return res.json({ success: true, role: "moderator" });
    return res.status(401).json({ success: false, error: "Invalid password" });
  }

  // ----------------- CONFIG -----------------
  if (action === "config" && req.method === "GET") {
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
    } catch (err) {
      return res.status(500).json({ error: "Failed to load config" });
    }
  }

  if (action === "config" && req.method === "POST") {
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
    } catch (err) {
      return res.status(500).json({ error: "Failed to save config" });
    }
  }

  // ----------------- PICK WINNER -----------------
  if (action === "pick-winner") {
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

      const drive = google.drive({ version: "v3", auth });
      const resp = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: "files(id)",
      });

      const liveFileIds = new Set(resp.data.files.map((f) => f.id));

      const eligibleUploads = allUploads.filter((entry) => {
        const id = entry.driveFileId || entry.fileId;
        return id && liveFileIds.has(id);
      });

      const allEntries = [];
      eligibleUploads.forEach((entry) => {
        const name = entry.name || entry.userName;
        const count = parseInt(entry.count || 1);
        if (!name) return;
        for (let i = 0; i < count; i++) allEntries.push(name);
      });

      if (allEntries.length === 0) {
        return res
          .status(400)
          .json({ error: "No valid entries with active files" });
      }

      const winner = allEntries[Math.floor(Math.random() * allEntries.length)];

      if (!isLocal) {
        await redis.set(
          "raffle_winner",
          JSON.stringify({
            name: winner,
            timestamp: Date.now(),
          })
        );
      }

      return res.json({ winner });
    } catch (err) {
      console.error("🔥 pick-winner failed:", err);
      return res.status(500).json({ error: "Failed to pick winner" });
    }
  }

  // ----------------- DELETE FILE -----------------
  if (action === "delete-file" && req.method === "POST") {
    const { fileId } = req.body;
    if (!fileId) return res.status(400).json({ error: "Missing file ID" });

    try {
      const drive = google.drive({ version: "v3", auth });
      await drive.files.delete({ fileId });
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: "Failed to delete file" });
    }
  }

  // ----------------- DUMP UPLOADS -----------------
  if (action === "dump-uploads") {
    try {
      if (!isLocal) {
        const raw = await redis.lRange("uploads", 0, -1);
        const parsed = raw.map(JSON.parse);
        return res.json(parsed);
      } else {
        const fileData = fs.readFileSync(uploadsPath, "utf8");
        return res.json(JSON.parse(fileData));
      }
    } catch (err) {
      return res.status(500).json({ error: "Failed to dump uploads" });
    }
  }

  // ----------------- CLEAR ALL -----------------
  if (action === "clear-all" && req.method === "POST") {
    const { role } = req.body;
    if (role !== "admin") {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      if (!isLocal) {
        await redis.del("uploads");
      } else {
        fs.writeFileSync(uploadsPath, "[]");
      }

      const drive = google.drive({ version: "v3", auth });
      const resp = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: "files(id)",
      });

      const deletePromises = resp.data.files.map((file) =>
        drive.files.delete({ fileId: file.id })
      );
      await Promise.all(deletePromises);

      return res.json({ success: true });
    } catch (err) {
      console.error("🔥 clear-all error:", err);
      return res.status(500).json({ error: "Failed to clear all data" });
    }
  }

  // ----------------- GET WINNER -----------------
  if (action === "winner" && req.method === "GET") {
    try {
      if (isLocal) {
        return res.json({ winner: null });
      }

      const redisClient = createClient({ url: process.env.REDIS_URL });
      await redisClient.connect();
      const winnerData = await redisClient.getDel("raffle_winner");
      await redisClient.disconnect();

      if (!winnerData) {
        return res.json({ winner: null });
      }

      const parsed = JSON.parse(winnerData);
      return res.json({ winner: parsed });
    } catch (err) {
      console.error("🔥 /api/admin?action=winner error:", err);
      return res.status(500).json({ error: "Failed to fetch winner" });
    }
  }

  // ----------------- UPVOTE -----------------
  if (action === "upvote" && req.method === "POST") {
    try {
      const { fileId } = req.body;
      if (!fileId) return res.status(400).json({ error: "Missing fileId" });

      const key = `votes:${fileId}`;
      const newCount = await redis.incr(key);
      return res.json({ success: true, votes: newCount });
    } catch (err) {
      console.error("🔥 upvote error:", err);
      return res.status(500).json({ error: "Failed to upvote" });
    }
  }

  // ----------------- RESET ALL VOTES -----------------
  if (action === "reset-votes" && req.method === "POST") {
    try {
      const { role } = req.body;
      if (role !== "admin") {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const keys = await redis.keys("votes:*");
      if (keys.length > 0) {
        await redis.del(keys);
      }

      await redis.set("resetVotesTimestamp", Date.now().toString());

      return res.json({ success: true });
    } catch (err) {
      console.error("🔥 reset-votes error:", err);
      return res.status(500).json({ error: "Failed to reset votes" });
    }
  }

  // ----------------- LIST FILES -----------------
  if (action === "list-drive-files" && req.method === "GET") {
    try {
      const drive = google.drive({ version: "v3", auth });
      const resp = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: "files(id, name, mimeType, createdTime)",
      });

      let uploads = [];

      if (!isLocal) {
        try {
          const raw = await redis.lRange("uploads", 0, -1);
          uploads = raw.map((entry) => JSON.parse(entry));
        } catch (err) {
          console.warn("⚠️ Failed to fetch uploads from Redis:", err);
        }
      } else {
        try {
          if (fs.existsSync(uploadsPath)) {
            uploads = JSON.parse(fs.readFileSync(uploadsPath, "utf8"));
          }
        } catch (err) {
          console.warn("⚠️ Failed to read uploads.json:", err);
        }
      }

      const files = await Promise.all(
        resp.data.files.map(async (file) => {
          console.log("🔍 Searching metadata for file.id:", file.id);
console.log("📦 All uploads:", uploads);
          const matchingMeta = uploads.find((u) => u.driveFileId === file.id);
const fullName = matchingMeta?.userName ?? "Anonymous";

console.log("✅ Matched metadata:", matchingMeta);
          let votes = 0;
          try {
            votes = (await redis.get(`votes:${file.id}`)) || 0;
          } catch {}

          return {
            id: file.id,
            userName: fullName,
            name: fullName,
            type: file.mimeType.startsWith("image") ? "image" : "video",
            fileUrl: `/api/proxy?id=${file.id}`,
            driveFileId: file.id,
            createdTime: file.createdTime,
            votes: parseInt(votes, 10),
          };
        })
      );

      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.json(files);
    } catch (err) {
      console.error("🔥 list-drive-files error:", err);
      return res.status(500).json({ error: "Failed to list files" });
    }
  }

  // ----------------- CHECK RESET -----------------
  if (action === "check-reset" && req.method === "GET") {
    try {
      const resetTimestamp = await redis.get("resetVotesTimestamp");
      return res.json({ resetTimestamp });
    } catch (err) {
      console.error("🔥 check-reset error:", err);
      return res.status(500).json({ error: "Failed to check reset timestamp" });
    }
  }

  // ----------------- SOCIAL COUNTS (Mock) -----------------
  if (action === "social-counts" && req.method === "GET") {
    return res.status(200).json({
      facebook: { followers: 1234 },
      instagram: { followers: 5678 },
    });
  }

  // ----------------- REAL SOCIAL FOLLOWER COUNTS -----------------
  if (action === "followers" && req.method === "GET") {
    try {
      const token = process.env.FB_PAGE_TOKEN;
      const fbPageId = process.env.FB_PAGE_ID;
      const igAccountId = process.env.IG_ACCOUNT_ID;

      const fbRes = await fetch(`https://graph.facebook.com/v19.0/${fbPageId}?fields=fan_count&access_token=${token}`);
      const fbJson = await fbRes.json();

      const igRes = await fetch(`https://graph.facebook.com/v19.0/${igAccountId}?fields=followers_count&access_token=${token}`);
      const igJson = await igRes.json();

      return res.json({
        facebook: fbJson.fan_count || 0,
        instagram: igJson.followers_count || 0,
      });
    } catch (err) {
      console.error("🔥 followers fetch error:", err);
      return res.status(500).json({ error: "Failed to fetch follower counts" });
    }
  }
  // ----------------- SAVE UPLOAD METADATA -----------------
  if (action === "save-upload" && req.method === "POST") {
    try {
      const { fileId, fileName, mimeType, userName } = req.body;
      if (!fileId || !mimeType || !userName) {
        console.warn("❌ Missing userName or fileId", req.body);
        return res.status(400).json({ error: "Missing userName or fileId" });
      }

      const uploadData = {
        userName,
        driveFileId: fileId,
        mimeType,
        timestamp: Date.now(),
      };

      if (isLocal) {
        let uploads = [];
        if (fs.existsSync(uploadsPath)) {
          uploads = JSON.parse(fs.readFileSync(uploadsPath, "utf8"));
        }
        uploads.push(uploadData);
        fs.writeFileSync(uploadsPath, JSON.stringify(uploads, null, 2));
      } else {
        await redis.rPush("uploads", JSON.stringify(uploadData));
      }

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("🔥 save-upload error:", err);
      return res.status(500).json({ error: "Failed to save metadata" });
    }
  }

  res.status(400).json({ error: "Invalid action" });
}
