import { google } from 'googleapis';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

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
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { fileId } = req.body;

  if (!fileId) {
    return res.status(400).json({ error: 'Missing file ID' });
  }

  try {
    await drive.files.delete({ fileId });
    res.status(200).json({ message: 'File deleted successfully' });
  } catch (err) {
    console.error('❌ Failed to delete file:', err);
    res.status(500).json({ error: 'Failed to delete file from Drive' });
  }
}
