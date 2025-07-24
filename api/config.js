import dotenv from 'dotenv';

dotenv.config(); // Load environment variables from .env file (for local dev only)

export const config = {
  api: {
    bodyParser: true,  // Ensure the body is parsed properly
  },
};

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      // Fetch the current show name from environment variable
      const showName = process.env.SHOW_NAME || '90 Surge Show';  // Default if not set
      return res.status(200).json({ showName });
    }

    if (req.method === 'POST') {
      const { showName } = req.body;

      // Validate the show name
      if (!showName || typeof showName !== 'string') {
        return res.status(400).json({ error: 'Invalid showName format' });
      }

      // Log the request (since environment variables can't be updated on the fly)
      console.log(`Attempting to change the show name to: ${showName}`);

      // Inform the admin to manually update the environment variable in the Vercel Dashboard
      return res.status(200).json({
        message: 'Show name change request received. Please update it in Vercel dashboard.',
      });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });

  } catch (error) {
    console.error("❌ Error in /api/config:", error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
