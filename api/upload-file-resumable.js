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

// Setup OAuth client
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


// ✅ Define Drive client
const drive = google.drive({ version: 'v3', auth: oauth2Client });

// Utility: clean up user input
function sanitizePart(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end('Method not allowed');

  const form = formidable({ multiples: false, maxFileSize: 2 * 1024 * 1024 * 1024 }); // 2GB max

  const [fields, files] = await new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve([fields, files]);
    });
  });

  if (!files.file || !fields.name) {
    console.log('Missing uploaded file or name');
    return res.status(400).json({ error: 'Missing uploaded file or name' });
  }

let file = files.file;
if (Array.isArray(file)) file = file[0]; // Normalize if array

const filePath = file?.filepath;

if (!filePath || !fs.existsSync(filePath)) {
  console.error('❌ Uploaded file missing or invalid filepath:', file);
  return res.status(400).json({ error: 'Invalid uploaded file' });
}

const fileStream = fs.createReadStream(filePath);


  const safeName = sanitizePart(fields.name);
  const showName = sanitizePart(process.env.SHOW_NAME || '90surge');
  const shortTimestamp = String(Date.now()).slice(-4);
  const fileExtension = path.extname(file.originalFilename || '.jpg');
  const fileName = `${safeName}-${showName}-${shortTimestamp}${fileExtension}`;

  const fileMeta = {
    name: fileName,
    parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
  };

  const media = {
    mimeType: file.mimetype,
    body: fileStream,
  };

  try {
    const response = await drive.files.create({
      resource: fileMeta,
      media,
      fields: 'id',
    });

    console.log(`✅ Uploaded to Drive as ${fileName}`);
    res.status(200).json({ success: true, fileId: response.data.id });
  } catch (err) {
    console.error('Drive upload error:', err);
    res.status(500).json({ error: 'Failed to upload file to Drive' });
  }
}
