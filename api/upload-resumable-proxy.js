// /api/upload-resumable-proxy.js
import formidable from 'formidable';
import { readFile } from 'fs/promises';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  const uploadUrl = req.headers['x-upload-url'];

  if (!uploadUrl) {
    return res.status(400).json({ error: 'Missing upload URL' });
  }

  const form = formidable({ multiples: false });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error("❌ Form parsing failed:", err);
      return res.status(500).json({ error: 'Failed to parse form data' });
    }

    const fileData = files.file?.[0] || files.file; // depending on whether it's an array or object
    if (!fileData || !fileData.filepath) {
      return res.status(400).json({ error: 'File upload failed — no filepath found' });
    }

    try {
      const buffer = await readFile(fileData.filepath);

      console.log("➡️ Uploading to:", uploadUrl);
      console.log("📦 File name:", fileData.originalFilename);
      console.log("📦 File type:", fileData.mimetype);
      console.log("🧱 Buffer size:", buffer.length);

      const googleRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': fileData.mimetype,
          'Content-Length': buffer.length.toString(),
        },
        body: buffer,
      });

      const text = await googleRes.text();
      console.log("✅ Upload success:", googleRes.status);
      res.status(googleRes.status).send(text);
    } catch (uploadErr) {
      console.error("❌ Upload to Google failed:", uploadErr);
      res.status(500).json({ error: 'Upload proxy error', details: uploadErr.message });
    }
  });
}
