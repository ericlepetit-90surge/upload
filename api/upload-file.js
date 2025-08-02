// /api/upload-file.js
import { google } from 'googleapis';
import { IncomingForm } from 'formidable';
import fs from 'fs';
import path from 'path';
import { createClient } from 'redis';

export const config = {
  api: {
    bodyParser: false,
  },
};

const oauthClientPath = path.join(process.cwd(), 'oauth-client.json');
const credentials = JSON.parse(fs.readFileSync(oauthClientPath, 'utf8'));
const tokenData = JSON.parse(process.env.GOOGLE_TOKEN_JSON);

const { client_id, client_secret, redirect_uris } = credentials.web;
const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
oauth2Client.setCredentials(tokenData);

const redis = createClient({ url: process.env.REDIS_URL });
if (!globalThis.__redisConnected) {
  redis.connect().catch(console.error);
  globalThis.__redisConnected = true;
}

function sanitize(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 80);
}

export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const form = new IncomingForm({ keepExtensions: true });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error('❌ Form parse error:', err);
      return res.status(500).json({ error: 'Form error' });
    }

    const { userName } = fields;
    const file = files.file;

    if (!file || !userName) {
      return res.status(400).json({ error: 'Missing file or name' });
    }

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    try {
      const fileMetadata = {
        name: `${sanitize(userName)}_${Date.now()}_${file.originalFilename}`,
        parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
      };

      const media = {
        mimeType: file.mimetype,
        body: fs.createReadStream(file.filepath),
      };

      const uploadRes = await drive.files.create({
        requestBody: fileMetadata,
        media,
        fields: 'id',
      });

      const fileId = uploadRes.data.id;

      // ✅ Save metadata to Redis
      const record = {
        fileId,
        fileName: file.originalFilename,
        mimeType: file.mimetype,
        userName,
        createdTime: new Date().toISOString(),
      };
      await redis.lpush('uploads', JSON.stringify(record));

      console.log('✅ Uploaded & saved:', record);
      res.status(200).json({ success: true, fileId });
    } catch (uploadErr) {
      console.error('❌ Upload failed:', uploadErr);
      res.status(500).json({ error: 'Upload to Drive failed' });
    }
  });
}
