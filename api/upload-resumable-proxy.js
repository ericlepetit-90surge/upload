// /api/upload-resumable-proxy.js

import { IncomingForm } from 'formidable';
import fs from 'fs';

export const config = {
  api: {
    bodyParser: false,
  },
};

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

    if (!filePath) {
      return res.status(400).json({ error: 'File path not found' });
    }

    try {
      const stat = await fs.promises.stat(filePath);
      const stream = fs.createReadStream(filePath);

      const response = await fetch(uploadUrl, {
  method: 'PUT',
  headers: {
    'Content-Length': stat.size,
    'Content-Type': file.mimetype || 'application/octet-stream',
  },
  body: stream,
  duplex: 'half', // ✅ Required for ReadableStream in Node.js
});

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Upload failed: ${response.status} ${errorText}`);
      }

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("🔥 Upload to Google failed:", err);
      return res.status(500).json({ error: 'Upload failed' });
    }
  });
}
