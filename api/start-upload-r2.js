// /api/start-upload-r2.js

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { IncomingForm } from "formidable";
import path from "path";
import fs from "fs";
import crypto from "crypto";

export const config = {
  api: {
    bodyParser: false,
  },
};

function sanitize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "");
}

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const form = new IncomingForm();

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error("❌ Form parsing error:", err);
      return res.status(400).json({ error: "Form parsing error" });
    }

    const userName = (fields.userName || "").toString().trim();
    const file = files.file?.[0] || files.file;

    if (!userName || !file) {
      return res.status(400).json({ error: "Missing file or userName" });
    }

    const mimeType = file.mimetype || "application/octet-stream";
    const originalName = file.originalFilename || file.name || "upload.jpg";
    const fileName = `${sanitize(userName)}_${Date.now()}_${sanitize(originalName)}`;

    try {
      const fileStream = fs.createReadStream(file.filepath);

      const upload = new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: fileName,
        Body: fileStream,
        ContentType: mimeType,
        ACL: "public-read",
      });

      await r2.send(upload);

      const publicUrl = `https://${process.env.R2_PUBLIC_DOMAIN}/${fileName}`;
return res.status(200).json({ fileName, uploadUrl: publicUrl });
    } catch (err) {
      console.error("🔥 Failed to upload to R2:", err);
      return res.status(500).json({ error: "Upload failed" });
    }
  });
}
