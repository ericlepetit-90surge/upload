import fs from 'fs';
import path from 'path';

export const config = {
  api: {
    bodyParser: true, // Allow JSON parsing
  },
};

export default async function handler(req, res) {
  const configPath = path.join(process.cwd(), 'config.json');

  try {
    if (req.method === 'GET') {
      const raw = fs.readFileSync(configPath, 'utf8');
      const data = JSON.parse(raw);
      return res.status(200).json(data);
    }

    if (req.method === 'POST') {
      const { showName, startTime, endTime } = req.body;

      if (!showName || typeof showName !== 'string') {
        return res.status(400).json({ error: 'Invalid showName format' });
      }

      const updatedConfig = {
        showName,
        startTime: startTime || null,
        endTime: endTime || null,
      };

      fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2), 'utf8');
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (err) {
    console.error('❌ Error in /api/config:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
