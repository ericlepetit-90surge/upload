// /api/upload-resumable.js
const { google } = require("googleapis");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const formidable = require("formidable");

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
  api: {
    bodyParser: false,
  },
};

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const form = new formidable.IncomingForm({
  keepExtensions: true,
  allowEmptyFiles: true
});

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error("❌ Form parse error:", err);
      return res.status(400).json({ error: "Failed to parse form data" });
    }

    const userName = fields.userName?.toString().trim();
    const file = Array.isArray(files.file) ? files.file[0] : files.file;

    if (!userName || !file) {
      console.error("❌ Missing userName or file");
      return res.status(400).json({ error: "Missing userName or file" });
    }

    const filePath = file?.filepath || file?.path;
    if (!filePath) {
      console.error("❌ Filepath missing in file object:", file);
      return res.status(400).json({ error: "Invalid file upload" });
    }

    const fileName = `${userName}_${Date.now()}_${file.originalFilename || file.name}`;
    const mimeType = file.mimetype || "application/octet-stream";

    try {
      const { token } = await oauth2Client.getAccessToken();
      if (!token) throw new Error("No access token");

      // Step 1: Create upload session
      const session = await axios.post(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
        {
          name: fileName,
          mimeType: mimeType,
          parents: [process.env.GOOGLE_DRIVE_FOLDER_ID], // ✅ assign to folder
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Upload-Content-Type": mimeType,
          },
        }
      );

      const uploadUrl = session.headers.location;
      if (!uploadUrl) {
        console.error("❌ No upload URL returned:", session.headers);
        throw new Error("Upload session failed");
      }

      // Step 2: Upload file
      const fileStream = fs.createReadStream(filePath);
      await axios.put(uploadUrl, fileStream, {
        headers: {
          "Content-Type": mimeType,
          "Content-Length": fs.statSync(filePath).size,
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });

      res.status(200).json({ success: true });
    } catch (err) {
      console.error("🔥 Upload error:", err.response?.data || err.message || err);
      res.status(500).json({ error: "Upload failed" });
    }
  });
};
