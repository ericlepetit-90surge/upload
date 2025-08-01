// /api/upload-resumable.js

const { google } = require("googleapis");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const formidable = require("formidable");
const mime = require("mime-types");

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
  api: { bodyParser: false },
};

function sanitizeFileName(name) {
  return name
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "_")
    .substring(0, 100);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const form = new formidable.IncomingForm({ keepExtensions: true });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error("❌ Form parse error:", err);
      return res.status(400).json({ error: "Failed to parse form data" });
    }

    const userNameRaw = Array.isArray(fields.userName)
      ? fields.userName[0]?.toString().trim()
      : fields.userName?.toString().trim();

    const file = Array.isArray(files.file) ? files.file[0] : files.file;

    if (!userNameRaw || !file) {
      console.error("❌ Missing userName or file");
      return res.status(400).json({ error: "Missing userName or file" });
    }

    const sanitizedUserName = sanitizeFileName(userNameRaw);
    const originalFileName = sanitizeFileName(file.originalFilename || file.name || "upload");
    const filePath = file?.filepath || file?.path;

    if (!filePath) {
      console.error("❌ Filepath missing:", file);
      return res.status(400).json({ error: "Invalid file upload" });
    }

    const fileName = `${sanitizedUserName}_${Date.now()}_${originalFileName}`;
    const mimeType = file.mimetype || mime.lookup(filePath) || "application/octet-stream";
    const fileSize = fs.statSync(filePath).size;

    try {
      const { token } = await oauth2Client.getAccessToken();
      if (!token) throw new Error("No access token");

      // 1. Start resumable upload session
      const session = await axios.post(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
        {
          name: fileName,
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

      const uploadUrl = session.headers.location;
      if (!uploadUrl) throw new Error("No upload URL returned");

      // 2. Upload the file to the session
      const stream = fs.createReadStream(filePath);
      await axios.put(uploadUrl, stream, {
        headers: {
          "Content-Length": fileSize,
          "Content-Type": mimeType,
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });

      // 3. Get uploaded file ID
      const drive = google.drive({ version: "v3", auth: oauth2Client });
      const listRes = await drive.files.list({
        q: `name='${fileName}' and '${process.env.GOOGLE_DRIVE_FOLDER_ID}' in parents`,
        fields: "files(id)",
        orderBy: "createdTime desc",
        pageSize: 1,
      });

      const fileId = listRes.data.files[0]?.id;
      if (!fileId) throw new Error("Could not retrieve uploaded file ID");

      // 4. Make the file public
      await drive.permissions.create({
        fileId,
        requestBody: { role: "reader", type: "anyone" },
      });

      // 5. Save metadata using original (unsanitized) user name
      const saveRes = await axios.post(
        `${req.headers.origin || "http://localhost:3000"}/api/save-upload-metadata`,
        {
          userName: userNameRaw,
          driveFileId: fileId,
          mimeType,
        },
        { headers: { "Content-Type": "application/json" } }
      );

      if (!saveRes.data.success) {
        console.warn("⚠️ Metadata save failed:", saveRes.data);
      }

      return res.status(200).json({ success: true, driveFileId: fileId });
    } catch (err) {
      console.error("🔥 Upload error:", err.response?.data || err.message || err);
      return res.status(500).json({ error: "Upload failed" });
    }
  });
};
