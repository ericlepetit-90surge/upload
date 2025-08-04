export default function handler(req, res) {
  return res.status(200).json({
    r2AccountId: process.env.R2_ACCOUNT_ID,
    r2BucketName: process.env.R2_BUCKET_NAME,
  });
}