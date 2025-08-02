// /api/upload-resumable.js
const { google } = require("googleapis");
const path = require("path");
const fs = require("fs");
const axios = require("axios");

const oauthPath = path.join(process.cwd(), "oauth-client.json");
const oauthClient = JSON.parse(fs.readFileSync(oauthPath, "utf8"));
const tokenData = JSON.parse(process.env.GOOGLE_TOKEN_JSON || "{}");

const oauth2Client = new google.auth.OAuth2(
  oauthClient.web.client_id,
  oauthClient.web.client_secret,
  oauthClient.web.redirect_uris[0]
);
oauth2Client.setCredentials(tokenData);

module.exports.config = {
  api: { bodyParser: true }, // allow JSON body
};

function sanitizeFileName(name) {
  return name
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "_")
    .substring(0, 100);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { fileName, mimeType, userName } = req.body;

  if (!fileName || !mimeType || !userName) {
    console.warn("❌ Missing fields:", { fileName, mimeType, userName });
    return res.status(400).json({ error: "Missing fileName, mimeType, or userName" });
  }

  try {
    const { token } = await oauth2Client.getAccessToken();
    if (!token) throw new Error("No access token");

    const cleanFileName = sanitizeFileName(`${userName}_${Date.now()}_${fileName}`);

    console.log("🚀 Creating resumable upload session for:", cleanFileName);
    console.log("📁 Target folder:", process.env.GOOGLE_DRIVE_FOLDER_ID);
    console.log("🔐 Token:", token.slice(0, 10) + "...");

    const sessionRes = await axios.post(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
      {
        name: cleanFileName,
        mimeType,
        parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Upload-Content-Type": mimeType,
        },
      }
    );

    const uploadUrl = sessionRes.headers.location;

    if (!uploadUrl) {
      console.error("❌ No upload URL returned");
      return res.status(500).json({ error: "Failed to get upload URL" });
    }

    console.log("✅ Upload URL:", uploadUrl);

    return res.status(200).json({ uploadUrl });
  } catch (err) {
    console.error("🔥 Error creating resumable upload URL:", err.response?.data || err.message || err);
    return res.status(500).json({ error: "Upload session creation failed" });
  }
};
