// /api/votes-stream.js
import { createClient } from "redis";

let globalForRedis = globalThis.__redis || null;
if (!globalForRedis && process.env.REDIS_URL) {
  const client = createClient({ url: process.env.REDIS_URL });
  globalForRedis = client;
  globalThis.__redis = client;
  client.connect().catch(console.error);
}
const redis = globalForRedis;

export default async function handler(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sub = redis.duplicate();
  await sub.connect();

  await sub.pSubscribe("vote:*", (message, channel) => {
    const fileId = channel.split("vote:")[1];
    res.write(`data: ${JSON.stringify({ fileId, votes: Number(message) })}\n\n`);
  });

  req.on("close", () => {
    sub.quit();
    res.end();
  });
}
