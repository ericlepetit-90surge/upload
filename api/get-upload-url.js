import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { fileName, mimeType } = req.body;
  if (!fileName || !mimeType) {
    return res.status(400).json({ error: "Missing fileName or mimeType" });
  }

  try {
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileName,
      ContentType: mimeType,
    });

    const url = await getSignedUrl(s3, command, { expiresIn: 60 });

    return res.status(200).json({ url });
  } catch (err) {
    console.error("❌ Failed to get presigned URL:", err);
    return res.status(500).json({ error: "Failed to generate upload URL" });
  }
}
