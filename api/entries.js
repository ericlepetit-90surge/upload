export default function handler(req, res) {
  const entries = global.raffleEntries || [];
  res.status(200).json(entries);
}
