// /api/upload-file-resumable.js

import formidable from 'formidable';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

export const config = {
  api: {
    bodyParser: false,
  },
};

// Read OAuth credentials and token
const oauthClientPath = path.join(process.cwd(), 'oauth-client.json');
const oauthClient = JSON.parse(fs.readFileSync(oauthClientPath, 'utf8'));

const oauth2Client = new google.auth.OAuth2(
  oauthClient.web.client_id,
  oauthClient.web.client_secret,
  oauthClient.web.redirect_uris[0]
);

const tokenData = JSON.parse(process.env.GOOGLE_TOKEN_JSON);
oauth2Client.setCredentials(tokenData);

const drive = google.drive({ version: 'v3', auth: oauth2Client });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');

  const form = formidable({ multiples: false, maxFileSize: 2 * 1024 * 1024 * 1024 }); // 2GB

  let fields, files;
  try {
    [fields, files] = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve([fields, files]);
      });
    });
  } catch (err) {
    console.error('Form parse error:', err);
    return res.status(400).json({ error: 'File parsing failed' });
  }

  if (!files.file || !fields.name) {
    return res.status(400).json({ error: 'Missing uploaded file or name' });
  }

  const file = files.file;
  const fileStream = fs.createReadStream(file.filepath);

  const safeName = String(fields.name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:.]/g, '').slice(0, 15);
  const ext = path.extname(file.originalFilename || '.jpg') || '.jpg';
  const fileName = `${safeName}--${timestamp}${ext}`;

  const fileMeta = {
    name: fileName,
    parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
  };

  const media = {
    mimeType: file.mimetype || 'application/octet-stream',
    body: fileStream,
  };

  try {
    const driveResponse = await drive.files.create({
      resource: fileMeta,
      media,
      fields: 'id',
    });

    console.log(`✅ Uploaded to Drive: ${fileName}`);
    res.status(200).json({ success: true, fileId: driveResponse.data.id });
  } catch (err) {
    console.error('Drive upload error:', err);
    res.status(500).json({ error: 'Failed to upload file to Drive' });
  }
}
