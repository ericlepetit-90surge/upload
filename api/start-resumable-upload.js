import { google } from 'googleapis';
import path from 'path';
import fs from 'fs';
import axios from 'axios';

const oauthPath = path.join(process.cwd(), 'oauth-client.json');
const oauthClient = JSON.parse(fs.readFileSync(oauthPath, 'utf8'));
const tokenData = JSON.parse(process.env.GOOGLE_TOKEN_JSON || '{}');

const oauth2Client = new google.auth.OAuth2(
  oauthClient.web.client_id,
  oauthClient.web.client_secret,
  oauthClient.web.redirect_uris[0]
);

// Preload credentials (including refresh_token)
oauth2Client.setCredentials(tokenData);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');

  const { fileName, mimeType } = req.body;

  if (!fileName || !mimeType) {
    return res.status(400).json({ error: 'Missing fileName or mimeType' });
  }

  try {
    // ✅ Refresh the access token using the refresh_token
    const { token } = await oauth2Client.getAccessToken();

    if (!token) {
      console.error('❌ Failed to refresh access token');
      return res.status(500).json({ error: 'Could not refresh access token' });
    }

    // ✅ Use axios to initiate a resumable upload
    const response = await axios.post(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
      {
        name: fileName,
        mimeType: mimeType,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': mimeType,
        },
      }
    );

    const uploadUrl = response?.headers?.location;

    if (!uploadUrl) {
      console.error('❌ Missing upload URL. Headers:', response.headers);
      return res.status(500).json({ error: 'Upload URL not returned from Google' });
    }

    res.status(200).json({ uploadUrl });
  } catch (err) {
    console.error('🔥 Upload init error:', err.response?.data || err.message || err);
    return res.status(500).json({ error: 'Upload session failed' });
  }
}
