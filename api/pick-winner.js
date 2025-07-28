import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

const oauthPath = path.join(process.cwd(), 'oauth-client.json');
const oauthClient = JSON.parse(fs.readFileSync(oauthPath, 'utf8'));
const tokenData = JSON.parse(process.env.GOOGLE_TOKEN_JSON || '{}');

const oauth2Client = new google.auth.OAuth2(
  oauthClient.web.client_id,
  oauthClient.web.client_secret,
  oauthClient.web.redirect_uris[0]
);
oauth2Client.setCredentials(tokenData);

const drive = google.drive({ version: 'v3', auth: oauth2Client });

export default async function handler(req, res) {
  try {
    const response = await drive.files.list({
      q: `'${process.env.GOOGLE_DRIVE_FOLDER_ID}' in parents`,
      fields: 'files(name)',
      pageSize: 1000,
    });

    const files = response.data.files || [];

    const names = files
      .map(file => {
        const match = file.name.match(/^(.+?)--\d+/); // match "username--timestamp.ext"
        return match ? match[1] : null;
      })
      .filter(Boolean);

    if (names.length === 0) {
      return res.status(200).json({ winner: null, error: "No uploads found." });
    }

    const winner = names[Math.floor(Math.random() * names.length)];
    return res.status(200).json({ winner });
  } catch (err) {
    console.error("Error picking winner:", err);
    return res.status(500).json({ error: "Failed to pick winner." });
  }
}
