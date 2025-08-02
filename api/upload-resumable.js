// /api/upload-resumable.js
const { google } = require("googleapis");
const path = require("path");
const fs = require("fs");

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
  api: { bodyParser: true }, // allow JSON
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
    return res.status(400).json({ error: "Missing fileName, mimeType, or userName" });
  }

  try {
    const { token } = await oauth2Client.getAccessToken();
    if (!token) throw new Error("No access token");

    const cleanFileName = sanitizeFileName(`${userName}_${Date.now()}_${fileName}`);

    // Start resumable upload session
    const drive = google.drive({ version: "v3", auth: oauth2Client });

    const fileMetadata = {
      name: cleanFileName,
      mimeType,
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
    };

    const resUpload = await drive.files.create(
      {
        requestBody: fileMetadata,
        media: {
          mimeType,
          body: null, // No file yet
        },
        fields: "id",
      },
      {
        headers: {
          "X-Upload-Content-Type": mimeType,
        },
      }
    );

    const uploadUrl = resUpload?.headers?.location;

    if (!uploadUrl) {
      return res.status(500).json({ error: "Failed to obtain upload URL" });
    }

    res.status(200).json({ uploadUrl });
  } catch (err) {
    console.error("🔥 Error creating resumable upload URL:", err.message || err);
    res.status(500).json({ error: "Upload session creation failed" });
  }
};
