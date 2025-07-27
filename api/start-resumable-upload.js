// /api/upload-resumable.js
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import formidable from 'formidable';
import axios from 'axios';
\export const config = {
  api: {
    bodyParser: false,
  },
};

const oauthClientPath = path.join(process.cwd(), 'oauth-client.json');
const oauthClient = JSON.parse(fs.readFileSync(oauthClientPath, 'utf8'));

const oauth2Client = new google.auth.OAuth2(
  oauthClient.web.client_id,
  oauthClient.web.client_secret,
  oauthClient.web.redirect_uris[0]
);

const tokenJson = process.env.GOOGLE_TOKEN_JSON;
if (!tokenJson) throw new Error('Missing GOOGLE_TOKEN_JSON in env');
oauth2Client.setCredentials(JSON.parse(tokenJson));

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const form = formidable({ keepExtensions: true });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error('Form parse error:', err);
      return res.status(400).json({ error: 'Bad form data' });
    }

    const userName = fields.userName?.toString().trim();
    const file = Array.isArray(files.file) ? files.file[0] : files.file;

    if (!userName || !file?.filepath) {
      return res.status(400).json({ error: 'Missing file or user name' });
    }

    const filePath = file.filepath;
    const fileName = `${userName}--${Date.now()}--${file.originalFilename || 'upload'}`;
    const mimeType = file.mimetype || 'application/octet-stream';

    try {
      const { token } = await oauth2Client.getAccessToken();
      if (!token) throw new Error('No access token');

      // Step 1: Start resumable upload session
      const startRes = await axios.post(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
        {
          name: fileName,
          mimeType,
          parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Upload-Content-Type': mimeType,
          },
        }
      );

      const uploadUrl = startRes.headers.location;
      if (!uploadUrl) throw new Error('Failed to get upload URL');

      // Step 2: PUT file to Google via stream
      const fileSize = fs.statSync(filePath).size;
      const stream = fs.createReadStream(filePath);

      await axios.put(uploadUrl, stream, {
        headers: {
          'Content-Length': fileSize,
          'Content-Type': mimeType,
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });

      res.status(200).json({ success: true });
    } catch (err) {
      console.error('🔥 Upload error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Upload failed' });
    }
  });
}
