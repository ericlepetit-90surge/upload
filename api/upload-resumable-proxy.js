// /api/upload-resumable-proxy.js

import { IncomingForm } from 'formidable';
import fs from 'fs';
import { google } from 'googleapis';

export const config = {
  api: {
    bodyParser: false,
  },
};

// Setup Google Drive client
const oauth2Client = new google.auth.OAuth2();
const tokenData = JSON.parse(process.env.GOOGLE_TOKEN_JSON || "{}");
oauth2Client.setCredentials(tokenData);
const drive = google.drive({ version: 'v3', auth: oauth2Client });

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uploadUrl = req.headers['x-upload-url'];
  if (!uploadUrl) {
    return res.status(400).json({ error: 'Missing upload URL' });
  }

  const form = new IncomingForm();

  form.parse(req, async (err, fields, files) => {
    if (err || !files.file || !files.file[0]) {
      console.error("❌ Error parsing file:", err);
      return res.status(400).json({ error: 'Missing or invalid file' });
    }

    const file = files.file[0];
    const filePath = file.filepath;

    try {
      const stat = await fs.promises.stat(filePath);
      const stream = fs.createReadStream(filePath);

      // Upload to Google Drive
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': stat.size,
          'Content-Type': file.mimetype || 'application/octet-stream',
        },
        body: stream,
        duplex: 'half',
      });

      if (!putRes.ok) {
        const errText = await putRes.text();
        throw new Error(`Upload failed: ${putRes.status} ${errText}`);
      }

      // ✅ Extract file ID from uploadUrl
      const fileId = new URL(uploadUrl).pathname.split("/").pop();
      if (!fileId) {
        console.warn("⚠️ Upload succeeded but Drive file ID could not be extracted.");
        return res.status(200).json({ success: true });
      }

      console.log("✅ Uploaded file ID:", fileId);
      return res.status(200).json({ success: true, driveFileId: fileId });
    } catch (err) {
      console.error("🔥 Upload to Drive failed:", err);
      return res.status(500).json({ error: 'Upload failed' });
    }
  });
}
