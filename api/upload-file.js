// /api/upload-file.js

import formidable from 'formidable';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

export const config = {
  api: {
    bodyParser: false,
  },
};

// OAuth2 setup
const oauthClientPath = path.join(process.cwd(), 'oauth-client.json');
const oauthClient = JSON.parse(fs.readFileSync(oauthClientPath, 'utf8'));

const oauth2Client = new google.auth.OAuth2(
  oauthClient.web.client_id,
  oauthClient.web.client_secret,
  oauthClient.web.redirect_uris[0]
);

const tokenJson = process.env.GOOGLE_TOKEN_JSON;
if (!tokenJson) {
  throw new Error('Missing GOOGLE_TOKEN_JSON in environment.');
}
const token = JSON.parse(tokenJson);
oauth2Client.setCredentials(token);

const drive = google.drive({ version: 'v3', auth: oauth2Client });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');

  const form = formidable({ multiples: false, maxFileSize: 2 * 1024 * 1024 * 1024 });

  try {
    const [fields, files] = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve([fields, files]);
      });
    });

    console.log("Parsed fields:", fields);
    console.log("Parsed files:", files);

    const uploadedFile = Array.isArray(files.file) ? files.file[0] : files.file;
    const userName = Array.isArray(fields.userName) ? fields.userName[0] : fields.userName;

    if (!uploadedFile || !userName) {
      return res.status(400).json({ error: 'Missing uploaded file or name' });
    }

    const fileStream = fs.createReadStream(uploadedFile.filepath);

    const safeName = String(userName).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const timestamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
    const ext = path.extname(uploadedFile.originalFilename || '.jpg') || '.jpg';
    const fileName = `${safeName}--${timestamp}${ext}`;

    const fileMeta = {
      name: fileName,
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
    };

    const media = {
      mimeType: uploadedFile.mimetype || 'application/octet-stream',
      body: fileStream,
    };

    const driveResponse = await drive.files.create({
      resource: fileMeta,
      media,
      fields: 'id',
    });

    console.log(`✅ Uploaded to Drive: ${fileName}`);
    res.status(200).json({ success: true, fileId: driveResponse.data.id });

  } catch (err) {
    console.error('❌ Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
}
