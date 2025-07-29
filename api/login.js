// /api/login.js
export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { password } = req.body;
  const ADMIN_PASS = process.env.ADMIN_PASS;
  const MODERATOR_PASS = process.env.MODERATOR_PASS;

  if (password === ADMIN_PASS) {
    return res.json({ success: true, role: 'admin' });
  } else if (password === MODERATOR_PASS) {
    return res.json({ success: true, role: 'moderator' });
  } else {
    return res.status(401).json({ success: false, error: 'Invalid password' });
  }
}
