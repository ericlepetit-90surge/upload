// /api/start-resumable-upload.js
import { google } from 'googleapis';
import path from 'path';
import fs from 'fs';

export const config = {
  api: {
    bodyParser: true,
  },
};

const oauthPath = path.join(process.cwd(), 'oauth-client.json');
const oauthClient = JSON.parse(fs.readFileSync(oauthPath, 'utf8'));
const tokenData = JSON.parse(process.env.GOOGLE_TOKEN_JSON || '{}');
const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

const oauth2Client = new google.auth.OAuth2(
  oauthClient.web.client_id,
  oauthClient.web.client_secret,
  oauthClient.web.redirect_uris[0]
);

oauth2Client.setCredentials(tokenData);

function sanitizeFileName(name) {
  return name.replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '_').substring(0, 100);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { fileName, mimeType, userName } = req.body;

  if (!fileName || !mimeType || !userName) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    const { token } = await oauth2Client.getAccessToken();
    const cleanFileName = sanitizeFileName(`${userName}_${Date.now()}_${fileName}`);

    // Step 1: Create upload session
    const sessionRes = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': mimeType,
        },
        body: JSON.stringify({
          name: cleanFileName,
          parents: [folderId],
          mimeType,
        }),
      }
    );

    if (!sessionRes.ok) {
      const errText = await sessionRes.text();
      throw new Error(`Drive session creation failed: ${errText}`);
    }

    const uploadUrl = sessionRes.headers.get('location');
    if (!uploadUrl) {
      throw new Error('Upload URL not returned from Google');
    }

    // Respond with upload URL and clean filename
    res.status(200).json({ uploadUrl, fileName: cleanFileName });
  } catch (err) {
    console.error('❌ Resumable session error:', err);
    res.status(500).json({ error: 'Upload session creation failed', details: err.message });
  }
}
