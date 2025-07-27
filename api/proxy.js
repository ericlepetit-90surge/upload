// /api/proxy.js
const { google } = require('googleapis');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

const oauthClientPath = path.join(process.cwd(), 'oauth-client.json');
const credentials = JSON.parse(fs.readFileSync(oauthClientPath, 'utf8'));

const { client_id, client_secret, redirect_uris } = credentials.web;
const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

let token;
if (process.env.GOOGLE_TOKEN_JSON) {
  token = JSON.parse(process.env.GOOGLE_TOKEN_JSON);
} else {
  const tokenPath = path.join(process.cwd(), 'GOOGLE_TOKEN.json');
  token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
}

oauth2Client.setCredentials(token);
const drive = google.drive({ version: 'v3', auth: oauth2Client });

module.exports = async function handler(req, res) {
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'Missing file ID' });
  }

  try {
    const driveRes = await drive.files.get(
      { fileId: id, alt: 'media' },
      { responseType: 'stream' }
    );

    res.setHeader('Content-Type', driveRes.headers['content-type'] || 'application/octet-stream');
    driveRes.data.pipe(res);
  } catch (err) {
    console.error('❌ Proxy failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch file from Drive' });
  }
};
