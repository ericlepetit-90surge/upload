import fs from "fs";
import path from "path";
import { google } from "googleapis";
import { createClient } from "redis";

let globalForRedis = globalThis.__redis || null;

if (!globalForRedis && process.env.REDIS_URL) {
  const client = createClient({ url: process.env.REDIS_URL });
  globalForRedis = client;
  globalThis.__redis = client;
  client.connect().catch(console.error);
}

const redis = globalForRedis;

const ADMIN_PASS = process.env.ADMIN_PASS;
const MODERATOR_PASS = process.env.MODERATOR_PASS;
const uploadsPath = path.join(process.cwd(), "uploads.json");
const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

const oauthClient = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "oauth-client.json"), "utf8")
);
const tokenData = JSON.parse(process.env.GOOGLE_TOKEN_JSON || "{}");

const oauth2Client = new google.auth.OAuth2(
  oauthClient.web.client_id,
  oauthClient.web.client_secret,
  oauthClient.web.redirect_uris[0]
);
oauth2Client.setCredentials(tokenData);

export default async function handler(req, res) {
  const action = req.query.action;
  const isLocal = true;

  console.log("➡️ Incoming admin action:", req.method, action);


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

  if (action === "login" && req.method === "POST") {
    const { password } = req.body;
    if (password === ADMIN_PASS)
      return res.json({ success: true, role: "admin" });
    if (password === MODERATOR_PASS)
      return res.json({ success: true, role: "moderator" });
    return res.status(401).json({ success: false, error: "Invalid password" });
  }

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
    } catch {
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
    } catch {
      return res.status(500).json({ error: "Failed to save config" });
    }
  }

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

      const drive = google.drive({ version: "v3", auth: oauth2Client });
      const resp = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: "files(id, name)",
      });

      const liveFileIds = new Set(resp.data.files.map((f) => String(f.id)));

      // Add logs for debugging
      console.log("📂 Live files on Drive:", [...liveFileIds]);

      const eligibleUploads = allUploads.filter((entry) => {
        const id = String(
          entry.driveFileId || entry.fileId || entry.id || ""
        ).trim();
        const isLive = id && liveFileIds.has(id);
        console.log(
          `🔍 Checking entry "${entry.userName}" with id "${id}" → ${
            isLive ? "✅" : "❌"
          }`
        );
        return isLive;
      });

      const allEntries = [];
      for (const entry of eligibleUploads) {
        const name = entry.userName || entry.name;
        if (!name) continue;

        const fileId = entry.driveFileId || entry.fileId || entry.id;
        const voteKey = `votes:${fileId}`;
        let count = parseInt((await redis.get(voteKey)) || "1");
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

  if (action === "winner" && req.method === "GET") {
    try {
      const winnerData = await redis.get("raffle_winner");
      if (!winnerData) {
        return res.status(404).json({ error: "No winner yet" });
      }
      return res.status(200).json(JSON.parse(winnerData));
    } catch (err) {
      console.error("❌ Failed to fetch winner:", err);
      return res.status(500).json({ error: "Failed to get winner" });
    }
  }

  if (req.method === "GET" && action === "winner") {
      console.log("🟡 GET /api/admin?action=winner hit");

    try {
      const winner = await redis.get("raffle_winner");
      if (!winner) {
        return res.status(404).json({ error: "No winner picked yet" });
      }
      return res.status(200).json({ winner: { name: JSON.parse(winner)} });
    } catch (err) {
      console.error("❌ Failed to fetch winner:", err);
      return res.status(500).json({ error: "Failed to load winner" });
    }
  }

  if (action === "delete-file" && req.method === "POST") {
    const { fileId } = req.body;
    if (!fileId) return res.status(400).json({ error: "Missing file ID" });

    try {
      const drive = google.drive({ version: "v3", auth: oauth2Client });
      await drive.files.delete({ fileId });
      return res.json({ success: true });
    } catch {
      return res.status(500).json({ error: "Failed to delete file" });
    }
  }

  if (action === "dump-uploads") {
    try {
      if (!isLocal) {
        const raw = await redis.lRange("uploads", 0, -1);
        return res.json(raw.map(JSON.parse));
      } else {
        const fileData = fs.readFileSync(uploadsPath, "utf8");
        return res.json(JSON.parse(fileData));
      }
    } catch {
      return res.status(500).json({ error: "Failed to dump uploads" });
    }
  }

  if (action === "clear-all" && req.method === "POST") {
    const { role } = req.body;
    if (role !== "admin")
      return res.status(403).json({ error: "Unauthorized" });

    try {
      if (!isLocal) {
        await redis.del("uploads");
      } else {
        fs.writeFileSync(uploadsPath, "[]");
      }

      const drive = google.drive({ version: "v3", auth: oauth2Client });
      const result = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "files(id)",
      });

      await Promise.all(
        result.data.files.map((file) => drive.files.delete({ fileId: file.id }))
      );

      return res.json({ success: true });
    } catch (err) {
      console.error("🔥 clear-all error:", err);
      return res.status(500).json({ error: "Failed to clear all data" });
    }
  }

  if (action === "list-drive-files" && req.method === "GET") {
    try {
      const drive = google.drive({ version: "v3", auth: oauth2Client });
      const filesRes = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "files(id, name, mimeType, createdTime)",
      });

      const rawUploads = await redis.lRange("uploads", 0, -1);
      const uploads = rawUploads.map((entry) => JSON.parse(entry));
      const uploadMap = Object.fromEntries(uploads.map((u) => [u.fileId, u]));

      const result = filesRes.data.files.map((file) => {
        const meta = uploadMap[file.id];

        console.log(
          "🧩 FILE:",
          file.name,
          "→ matched to:",
          meta?.userName || "❌ no match"
        );

        return {
          id: file.id,
          fileUrl: `https://lh3.googleusercontent.com/d/${file.id}`,
          userName: meta?.userName || "Anonymous",
          type: file.mimeType.startsWith("video") ? "video" : "image",
          createdTime: file.createdTime,
          votes: meta?.votes || 0,
        };
      });

      return res.status(200).json(result);
    } catch (err) {
      console.error("🔥 list-drive-files error:", err);
      return res.status(500).json({ error: "Failed to list drive files" });
    }
  }

  if (action === "save-upload" && req.method === "POST") {
    try {
      const { fileName, mimeType, userName } = req.body;
      if (!fileName || !mimeType || !userName) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const drive = google.drive({ version: "v3", auth: oauth2Client });
      const lookup = await drive.files.list({
        q: `name = '${fileName}' and '${folderId}' in parents and trashed = false`,
        fields: "files(id)",
      });

      const fileId = lookup.data.files?.[0]?.id;
      if (!fileId) {
        return res.status(404).json({ error: "File not found on Drive" });
      }

      try {
        await drive.permissions.create({
          fileId,
          requestBody: { role: "reader", type: "anyone" },
        });
      } catch (err) {
        console.warn("⚠️ Could not make file public:", err.message);
      }

      const upload = {
        id: fileId,
        fileId,
        fileName,
        mimeType,
        userName,
        fileUrl: `https://drive.google.com/uc?id=${fileId}`,
        createdTime: new Date().toISOString(),
        votes: 0,
        count: 1, // 🟢 Raffle count starts at 1
      };

      console.log("📥 Saving upload metadata:", upload);

      // Save to Redis always
      const existing = await redis.lRange("uploads", 0, -1);
      const alreadyExists = existing.some((item) => {
        try {
          return JSON.parse(item).fileId === fileId;
        } catch {
          return false;
        }
      });

      if (!alreadyExists) {
        await redis.rPush("uploads", JSON.stringify(upload));
        console.log("✅ Saved to Redis:", fileId);
      } else {
        console.log("⏩ Already exists in Redis:", fileId);
      }

      // Optional: also save locally for debugging
      if (isLocal) {
        const fileData = fs.existsSync(uploadsPath)
          ? JSON.parse(fs.readFileSync(uploadsPath, "utf8"))
          : [];

        const alreadyInFile = fileData.some((item) => item.fileId === fileId);
        if (!alreadyInFile) {
          fileData.push(upload);
          fs.writeFileSync(uploadsPath, JSON.stringify(fileData, null, 2));
          console.log("💾 Also saved locally:", upload.fileName);
        }
      }

      const voteKey = `votes:${fileId}`;
      const existingVotes = await redis.get(voteKey);
      if (!existingVotes) {
        await redis.set(voteKey, "0");
      }

      return res.status(200).json({ success: true, upload });
    } catch (err) {
      console.error("❌ Failed to save upload metadata:", err);
      return res.status(500).json({ error: "Failed to save metadata" });
    }
  }

  if (action === "check-reset" && req.method === "GET") {
    try {
      const resetTimestamp = await redis.get("resetVotesTimestamp");
      return res.json({ resetTimestamp });
    } catch (err) {
      return res.status(500).json({ error: "Failed to check reset timestamp" });
    }
  }

  if (action === "social-counts" && req.method === "GET") {
    return res.status(200).json({
      facebook: { followers: 1234 },
      instagram: { followers: 5678 },
    });
  }

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

  if (action === "upvote" && req.method === "POST") {
    try {
      const { fileId } = req.body;
      if (!fileId) return res.status(400).json({ error: "Missing fileId" });

      const key = `votes:${fileId}`;
      const newCount = await redis.incr(key);
      return res.json({ success: true, votes: newCount });
    } catch {
      return res.status(500).json({ error: "Failed to upvote" });
    }
  }

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

  return res.status(400).json({ error: "Invalid action" });
}
