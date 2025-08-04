// /api/uploads.js
import fs from "fs";
import path from "path";
import { createClient } from "redis";

const uploadsPath = path.join(process.cwd(), "uploads.json");

export default async function handler(req, res) {
  const isLocal = process.env.VERCEL_ENV !== "production";
  const accountId = process.env.R2_ACCOUNT_ID;
  const bucketName = process.env.R2_BUCKET_NAME;
  let entries = [];

  try {
    if (isLocal) {
      if (fs.existsSync(uploadsPath)) {
        const raw = fs.readFileSync(uploadsPath, "utf8");
        entries = JSON.parse(raw);
      }
    } else {
      const redis = createClient({ url: process.env.REDIS_URL });
      await redis.connect();
      const raw = await redis.lRange("uploads", 0, -1);
      await redis.disconnect();
      entries = raw.map((e) => JSON.parse(e));
    }

    const result = entries
  .sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime))
  .map((entry) => {
    const fileName = entry.fileName;
    return {
      ...entry,
      fileUrl: `https://${process.env.R2_PUBLIC_DOMAIN}/${fileName}`,
      type: entry.mimeType?.startsWith("video/") ? "video" : "image",
    };
  });


    res.status(200).json(result);
  } catch (err) {
    console.error("❌ Failed to load uploads:", err);
    res.status(500).json({ error: "Could not load uploads" });
  }
}
