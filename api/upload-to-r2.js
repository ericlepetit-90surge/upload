// /api/upload-to-r2.js

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { IncomingForm } from "formidable";
import fs from "fs";
import path from "path";

export const config = {
  api: {
    bodyParser: false,
  },
};

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

function sanitize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const form = new IncomingForm();
  form.uploadDir = path.join(process.cwd(), "/tmp");
  form.keepExtensions = true;

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error("❌ Form error:", err);
      return res.status(400).json({ error: "Form parse error" });
    }

    const userName = (fields.userName || "").toString().trim();
    const file = files.file?.[0] || files.file;

    if (!userName || !file) {
      return res.status(400).json({ error: "Missing file or userName" });
    }

    const fileStream = fs.createReadStream(file.filepath);
    const fileName = `${sanitize(userName)}_${Date.now()}_${sanitize(file.originalFilename)}`;
    const mimeType = file.mimetype || "application/octet-stream";

    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: fileName,
          Body: fileStream,
          ContentType: mimeType,
        })
      );

      return res.status(200).json({ fileName, mimeType });
    } catch (err) {
      console.error("❌ Upload to R2 failed:", err);
      return res.status(500).json({ error: "Upload to R2 failed" });
    }
  });
}
