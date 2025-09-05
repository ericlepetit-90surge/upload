// /api/admin.js
import fs from "fs";
import path from "path";
import { createClient } from "redis";

export const config = { runtime: "nodejs" };

/* ──────────────────────────────────────────────────────────────
   ENV + mode
────────────────────────────────────────────────────────────── */
const ADMIN_PASS = process.env.ADMIN_PASS || "";
const MODERATOR_PASS = process.env.MODERATOR_PASS || "";

// Treat Vercel preview like prod; only true local dev is "local"
const isLocal =
  (!process.env.VERCEL && process.env.NODE_ENV !== "production") ||
  process.env.VERCEL_ENV === "development";

/* Local ledger file (dev fallback) */
const DATA_DIR = path.join(process.cwd(), ".data");
const LOCAL_LEDGER_FILE = path.join(DATA_DIR, "winners-local.json");

/* ──────────────────────────────────────────────────────────────
   Redis singleton
────────────────────────────────────────────────────────────── */
let redis;
if (!globalThis.__redis && process.env.REDIS_URL) {
  const client = createClient({
    url: process.env.REDIS_URL,
    socket: {
      connectTimeout: 5000,
      reconnectStrategy: (r) => Math.min(r * 200, 3000),
    },
  });
  client.on("error", (e) => console.error("Redis error:", e?.message || e));
  globalThis.__redis = client;
  client
    .connect()
    .then(() => console.log("✅ Redis connected"))
    .catch((err) => console.error("❌ Redis initial connect failed:", err));
}
redis = globalThis.__redis;

async function ensureRedisConnected() {
  if (!redis) return false;
  if (redis.isOpen) return true;
  try {
    await redis.connect();
    console.log("✅ Redis reconnected");
    return true;
  } catch (err) {
    console.error("❌ Redis reconnect failed:", err?.message || err);
    return false;
  }
}

/* ──────────────────────────────────────────────────────────────
   Helpers
────────────────────────────────────────────────────────────── */
const g = globalThis;
// In-memory mirror (safety net in same process)
if (!g.__surgeMem) g.__surgeMem = { winners: [], currentWinner: null };
const MEM = g.__surgeMem;

function isAdmin(req) {
  const h = req.headers.authorization || "";
  const pref = "Bearer:super:";
  if (!h.startsWith(pref)) return false;
  const token = h.slice(pref.length);
  return !!ADMIN_PASS && token === ADMIN_PASS;
}

async function scanAll(match) {
  const out = [];
  if (!redis?.scanIterator) return out;
  for await (const k of redis.scanIterator({ MATCH: match, COUNT: 1000 }))
    out.push(k);
  return out;
}

function isFollowAllowed(raw) {
  if (!raw) return false;
  if (raw === "true") return true;
  try {
    return !!JSON.parse(raw)?.followed;
  } catch {
    return false;
  }
}

function timeout(ms) {
  return new Promise((_, rej) =>
    setTimeout(() => rej(new Error("Timeout " + ms + "ms")), ms)
  );
}

function noCache(res) {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("CDN-Cache-Control", "no-store");
  res.setHeader("Vercel-CDN-Cache-Control", "no-store");
}

function ensureLocalDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
}
function readLocalLedgerSafe() {
  try {
    ensureLocalDir();
    if (!fs.existsSync(LOCAL_LEDGER_FILE)) return [];
    const txt = fs.readFileSync(LOCAL_LEDGER_FILE, "utf8");
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function writeLocalLedgerSafe(rows) {
  try {
    ensureLocalDir();
    fs.writeFileSync(LOCAL_LEDGER_FILE, JSON.stringify(rows, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}
function appendLocalLedgerRow(row) {
  const arr = readLocalLedgerSafe();
  arr.push(row);
  if (arr.length > 500) arr.splice(0, arr.length - 500);
  writeLocalLedgerSafe(arr);
}

async function getWindowInfo() {
  let showName = "90 Surge";
  let startTime = null;
  let endTime = null;

  try {
    const ok = await ensureRedisConnected();
    if (ok && redis?.isOpen) {
      const [sn, st, et] = await Promise.all([
        redis.get("showName").catch(() => ""),
        redis.get("startTime").catch(() => ""),
        redis.get("endTime").catch(() => ""),
      ]);
      if (sn) showName = sn;
      if (st) startTime = st;
      if (et) endTime = et;
    } else if (isLocal) {
      const cfgPath = path.join(process.cwd(), "config.json");
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        showName = cfg.showName || showName;
        startTime = cfg.startTime || startTime;
        endTime = cfg.endTime || endTime;
      }
    }
  } catch {}

  if (!startTime || !endTime) {
    const now = new Date();
    const start = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        0,
        0,
        0
      )
    );
    const end = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0,
        0,
        0
      )
    );
    startTime = start.toISOString();
    endTime = end.toISOString();
  }

  const windowKey = `${startTime}|${endTime}`;
  let ttlSeconds = Math.floor((new Date(endTime) - Date.now()) / 1000);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) ttlSeconds = 8 * 60 * 60;

  return { showName, startTime, endTime, windowKey, ttlSeconds };
}

/* Winners persistence with robust fallback */
async function appendWinnerRow(row) {
  // Always mirror in memory
  MEM.winners.push(row);
  if (MEM.winners.length > 500) MEM.winners = MEM.winners.slice(-500);
  // DEBUG: Log where the winner is being saved
  let where = "memory";
  try {
    const ok = await ensureRedisConnected();
    if (ok && redis?.isOpen) {
      await redis.rPush("raffle:winners:all", JSON.stringify(row));
      await redis.lTrim("raffle:winners:all", -500, -1);
      where = "redis";
      if (isLocal) appendLocalLedgerRow(row);
    } else if (isLocal) {
      appendLocalLedgerRow(row);
      where = "file";
    }
    console.log(`// DEBUG: Successfully appended winner row to ${where}.`);
    return { where };
  } catch (e) {
    console.error("// DEBUG: Failed to append winner row:", e?.message || e);
    if (isLocal) {
      appendLocalLedgerRow(row);
      where = "file (fallback)";
      console.log(`// DEBUG: Successfully appended winner row to ${where}.`);
    }
  }
  return { where };
}

function normalizeSymbol(s) {
  try {
    return String(s || "")
      .toLowerCase()
      .replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}/gu, "")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }
}
function detectJackpot(targets = [], clientFlag = false) {
  if (clientFlag) return true;
  const norm = targets.slice(0, 3).map(normalizeSymbol).filter(Boolean);
  if (norm.length >= 3 && new Set(norm.slice(0, 3)).size === 1) return true;
  if (normalizeSymbol(targets.join(" ")).includes("jackpot")) return true;
  return false;
}

/* ──────────────────────────────────────────────────────────────
   Main handler
────────────────────────────────────────────────────────────── */
export default async function handler(req, res) {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const action = url.searchParams.get("action");

  // tolerant JSON body parsing
  if (req.method === "POST") {
    const isJson = (req.headers["content-type"] || "").includes(
      "application/json"
    );
    try {
      if (isJson) {
        let body = "";
        await new Promise((resolve) => {
          req.on("data", (c) => (body += c));
          req.on("end", resolve);
        });
        try {
          req.body = body ? JSON.parse(body) : {};
        } catch {
          console.warn("JSON parse failed; using {}");
          req.body = {};
        }
      } else {
        req.body = req.body && typeof req.body === "object" ? req.body : {};
      }
    } catch {
      req.body = {};
    }
  }

  /* ───── AUTH ───── */
  if (action === "login" && req.method === "POST") {
    const { password } = req.body || {};
    if (password === ADMIN_PASS)
      return res.json({ success: true, role: "admin" });
    if (password === MODERATOR_PASS)
      return res.json({ success: true, role: "moderator" });
    return res.status(401).json({ success: false, error: "Invalid password" });
  }

  /* ───── REDIS STATUS / WARM ───── */
  if (req.method === "GET" && action === "redis-status") {
    try {
      if (!(await ensureRedisConnected()))
        return res.status(200).json({ status: "idle" });
      const t0 = Date.now();
      await redis.ping();
      const pingMs = Date.now() - t0;
      const [keyCount, lastWarmAt, seeded, hitRate] = await Promise.all([
        redis.dbSize().catch(() => null),
        redis.get("lastWarmAt").catch(() => null),
        redis.get("warm_seeded").catch(() => null),
        redis.get("cache:hitRate").catch(() => null),
      ]);
      return res.status(200).json({
        status: "active",
        pingMs,
        keyCount,
        lastWarmAt,
        seeded: seeded === "true" ? true : seeded ?? null,
        hitRate: hitRate ? Number(hitRate) : null,
      });
    } catch {
      return res.status(200).json({ status: "idle" });
    }
  }

  if (req.method === "POST" && action === "warm-redis") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    try {
      const ok = await ensureRedisConnected();
      if (!ok) throw new Error("connect failed");
      await Promise.all([
        redis.set("warm_probe", String(Date.now()), { EX: 300 }),
        redis.set("warm_seeded", "true", { EX: 3600 }),
        redis.set("lastWarmAt", new Date().toISOString(), { EX: 3600 }),
        redis.ping(),
      ]);
      const t0 = Date.now();
      await redis.ping();
      const pingMs = Date.now() - t0;
      const keyCount = await redis.dbSize().catch(() => null);
      return res
        .status(200)
        .json({ success: true, pong: "PONG", pingMs, keyCount });
    } catch (err) {
      console.error("❌ warm-redis:", err);
      return res.status(500).json({ error: "Warm-up failed" });
    }
  }

  /* ───── CONFIG ───── */
  if (action === "config") {
    if (req.method === "GET") {
      noCache(res);
      await ensureRedisConnected();
      try {
        if (isLocal) {
          try {
            const filePath = path.join(process.cwd(), "config.json");
            const cfg = JSON.parse(fs.readFileSync(filePath, "utf8"));
            const showName = cfg.showName ?? "90 Surge";
            const startTime = cfg.startTime ?? null;
            const endTime = cfg.endTime ?? null;
            const version = Number(cfg.version || 0);
            return res
              .status(200)
              .json({ showName, startTime, endTime, version });
          } catch {}
        }
        if (redis?.isOpen) {
          let [showName, startTime, endTime, version] = await Promise.race([
            Promise.all([
              redis.get("showName").catch(() => ""),
              redis.get("startTime").catch(() => ""),
              redis.get("endTime").catch(() => ""),
              redis.get("config:version").catch(() => "0"),
            ]),
            timeout(10000),
          ]);
          return res.status(200).json({
            showName,
            startTime,
            endTime,
            version: Number(version || 0),
          });
        }
        return res.status(200).json({
          showName: "90 Surge",
          startTime: null,
          endTime: null,
          version: 0,
        });
      } catch (err) {
        console.error("❌ config GET:", err);
        return res.status(500).json({ error: "Failed to load config" });
      }
    }

    if (req.method === "POST") {
      const { showName, startTime, endTime } = req.body || {};
      try {
        await ensureRedisConnected();
        let version = 0;
        if (isLocal) {
          const filePath = path.join(process.cwd(), "config.json");
          let existing = {};
          try {
            existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
          } catch {}
          version = Number(existing.version || 0) + 1;
          fs.writeFileSync(
            filePath,
            JSON.stringify({ showName, startTime, endTime, version }, null, 2)
          );
        } else {
          if (!redis?.isOpen)
            return res.status(503).json({ error: "Redis not ready" });
          await Promise.all([
            redis.set("showName", showName || ""),
            redis.set("startTime", startTime || ""),
            redis.set("endTime", endTime || ""),
          ]);
          version = await redis.incr("config:version");
        }
        try {
          await redis?.publish?.(
            "sse",
            JSON.stringify({
              type: "config",
              config: { showName, startTime, endTime, version },
            })
          );
        } catch {}
        noCache(res);
        return res
          .status(200)
          .json({ success: true, showName, startTime, endTime, version });
      } catch (err) {
        console.error("❌ config POST:", err);
        return res.status(500).json({ error: "Failed to save config" });
      }
    }

    return res.status(405).json({ error: "Method not allowed" });
  }

  /* ────────────────────────────────────────────────────────────
     RAFFLE: enter / list / summary / my-entries
  ───────────────────────────────────────────────────────────── */
  if (action === "enter" && req.method === "POST") {
    const ok = await ensureRedisConnected();
    if (!ok) return res.status(503).json({ error: "Redis not ready" });

    const nameRaw = (req.body?.name || "").trim();
    if (!nameRaw) return res.status(400).json({ error: "Missing name" });
    const name = nameRaw.slice(0, 80);

    const rawSource = (req.body?.source || "").toString().toLowerCase();
    const source = ["fb", "ig", "jackpot"].includes(rawSource)
      ? rawSource
      : "other";

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";
    const { windowKey, ttlSeconds } = await getWindowInfo();

    const setKey = `raffle:entered:${windowKey}:${source}`;
    const listKey = `raffle:entries:${windowKey}`;

    if (source === "jackpot") {
      const entry = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
        name,
        ip,
        source,
        createdTime: new Date().toISOString(),
      };

      const jpKey = `raffle:jackpotCount:${windowKey}:${ip}`;

      await redis
        .multi()
        .rPush(listKey, JSON.stringify(entry))
        .expire(listKey, ttlSeconds)
        .incr(jpKey)
        .expire(jpKey, ttlSeconds)
        .exec();

      return res.status(200).json({ success: true, entry, jackpot: true });
    }
    const already = await redis.sIsMember(setKey, ip);
    if (already) {
      try {
        const tail = await redis.lRange(listKey, -300, -1);
        let found = false;
        for (const s of tail) {
          try {
            const e = JSON.parse(s);
            if (e && e.ip === ip && e.source === source) {
              found = true;
              break;
            }
          } catch {}
        }
        if (!found) {
          const entry = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
            name,
            ip,
            source,
            createdTime: new Date().toISOString(),
          };
          await redis.rPush(listKey, JSON.stringify(entry));
          await redis.expire(listKey, ttlSeconds);
          return res
            .status(200)
            .json({ success: true, already: true, repaired: true, entry });
        }
      } catch {}
      return res.status(200).json({ success: true, already: true, source });
    }

    const entry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      name,
      ip,
      source,
      createdTime: new Date().toISOString(),
    };

    await redis
      .multi()
      .sAdd(setKey, ip)
      .expire(setKey, ttlSeconds)
      .rPush(listKey, JSON.stringify(entry))
      .expire(listKey, ttlSeconds)
      .exec();

    return res.status(200).json({ success: true, entry });
  }

  if (action === "entries" && req.method === "GET") {
    const ok = await ensureRedisConnected();
    if (!ok) return res.status(200).json({ entries: [], count: 0 });

    const { windowKey } = await getWindowInfo();
    const listKey = `raffle:entries:${windowKey}`;
    const raw = await redis.lRange(listKey, 0, -1);
    const entries = raw
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return res.status(200).json({ entries, count: entries.length });
  }

  if (action === "my-entries" && req.method === "GET") {
    const ok = await ensureRedisConnected();
    if (!ok) {
      return res.status(200).json({
        mine: 0,
        total: 0,
        sources: { fb: false, ig: false, jackpot: false },
        bonus: 0,
      });
    }

    const { windowKey } = await getWindowInfo();
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";

    const setFb = `raffle:entered:${windowKey}:fb`;
    const setIg = `raffle:entered:${windowKey}:ig`;
    const setJp = `raffle:entered:${windowKey}:jackpot`;
    const bonusKey = `raffle:bonus:${windowKey}:${ip}`;
    const listKey = `raffle:entries:${windowKey}`;

    const [fb, ig, jp, total, bonusRaw] = await Promise.all([
      redis.sIsMember(setFb, ip),
      redis.sIsMember(setIg, ip),
      redis.sIsMember(setJp, ip),
      redis.lLen(listKey).catch(() => 0),
      redis.get(bonusKey).catch(() => "0"),
    ]);

    const bonus = Number(bonusRaw || 0) || 0;
    const mine = (fb ? 1 : 0) + (ig ? 1 : 0) + (jp ? 1 : 0) + bonus;

    return res.status(200).json({
      mine,
      total: Number(total || 0),
      sources: { fb: !!fb, ig: !!ig, jackpot: !!jp },
      bonus,
    });
  }

  if (action === "entries-summary" && req.method === "GET") {
    const ok = await ensureRedisConnected();
    if (!ok) return res.status(200).json({ rows: [] });

    const { windowKey } = await getWindowInfo();
    const listKey = `raffle:entries:${windowKey}`;
    const raw = await redis.lRange(listKey, 0, -1);
    const rowsMap = new Map();
    for (const s of raw) {
      try {
        const e = JSON.parse(s);
        const name = (e?.name || "").trim();
        if (!name) continue;
        rowsMap.set(name, (rowsMap.get(name) || 0) + 1);
      } catch {}
    }
    const rows = Array.from(rowsMap, ([name, entries]) => ({
      name,
      entries,
    })).sort((a, b) => b.entries - a.entries || a.name.localeCompare(b.name));
    return res.status(200).json({ rows });
  }

  /* ────────────────────────────────────────────────────────────
   RESET EVERYTHING (entries + winners + social)
───────────────────────────────────────────────────────────── */
  if (action === "reset-entries" && req.method === "POST") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });

    // If Redis isn't ready, just clear the in-memory mirrors and return success
    const ok = await ensureRedisConnected();
    if (!ok || !redis?.isOpen) {
      try {
        MEM.winners = [];
        MEM.currentWinner = null;
      } catch {}
      return res.status(200).json({
        success: true,
        windowKey: "(mem)",
        deletedKeys: 0,
        remaining: { social: [], raffleEntered: [], jackpots: [], votes: [] },
        _note: "Redis not ready; cleared memory mirror only",
      });
    }

    // Safe helpers
    const safeScan = async (pattern) => {
      try {
        if (!redis?.scanIterator) return [];
        const out = [];
        for await (const k of redis.scanIterator({
          MATCH: pattern,
          COUNT: 1000,
        })) {
          if (typeof k === "string" && k) out.push(k);
        }
        return out;
      } catch (e) {
        console.warn("scan failed", pattern, e?.message || e);
        return [];
      }
    };

    const delKey = async (k) => {
      if (!k || typeof k !== "string") return 0;
      try {
        // UNLINK is non-blocking if supported
        return (await redis.unlink(k)) || 0;
      } catch {
        try {
          return (await redis.del(k)) || 0;
        } catch {
          return 0;
        }
      }
    };

    try {
      const { windowKey } = await getWindowInfo();

      // ------------------------------
      // Existing window-scoped keys
      // ------------------------------
      const listKey = `raffle:entries:${windowKey}`;
      const dedupes = await safeScan(`raffle:entered:${windowKey}:*`);
      const bonuses = await safeScan(`raffle:bonus:${windowKey}:*`); // keep if you ever used it
      const socialIpsScoped = `social:ips:${windowKey}`;
      const socialStates = await safeScan(`social:${windowKey}:*`);
      const socialLocks = await safeScan(`social:lock:${windowKey}:*`);
      const jpCounts = await safeScan(`raffle:jackpotCount:${windowKey}:*`);

      // Global-ish keys
      const winnersKey = "raffle:winners:all";
      const winnerKey = "raffle_winner";
      const socialIpsLegacy = "social:ips";

      // ------------------------------
      // NEW: Vote/entry cache cleanup
      // ------------------------------

      // A) If you ever namespaced votes by window: votes:${windowKey}:*
      const votesScoped = await safeScan(`votes:${windowKey}:*`);

      // B) Generic per-file vote keys (most common): votes:{fileId}
      //    We'll try to delete only those that belong to the current window.
      const genericVoteKeys = await safeScan(`votes:*`);
      const votesForThisWindow = new Set(votesScoped);

      if (genericVoteKeys.length) {
        try {
          // Load uploads and select those tied to the current window
          // Your uploads list stores JSON per item; adjust property names if needed.
          const uploadsJson = await redis.lrange("uploads", 0, -1);
          const fileIds = new Set();
          for (const s of uploadsJson) {
            try {
              const u = JSON.parse(s);
              // Accept a few possible field names you've used before
              const belongsToWindow =
                u?.windowKey === windowKey ||
                u?.showWindow === windowKey ||
                u?.window === windowKey ||
                u?.window_id === windowKey;
              if (!belongsToWindow) continue;

              const fid = String(
                u?.fileId ||
                  u?.driveFileId ||
                  u?.id ||
                  u?.fileName ||
                  u?.key ||
                  ""
              ).trim();
              if (fid) fileIds.add(fid);
            } catch {}
          }

          // If we found fileIds for this window, include their votes:{fileId}
          if (fileIds.size > 0) {
            for (const k of genericVoteKeys) {
              // Expect format "votes:{fileId}" (no extra colons)
              // Safeguard: only keep those with exactly 2 parts and known suffix.
              const parts = k.split(":");
              if (parts.length === 2) {
                const fid = parts[1];
                if (fileIds.has(fid)) votesForThisWindow.add(k);
              }
            }
          } else {
            // Fallback: if we couldn't resolve fileIds for the window,
            // and you want reset to be absolute, uncomment the next line to nuke ALL votes.
            // genericVoteKeys.forEach(k => votesForThisWindow.add(k));
          }
        } catch (e) {
          console.warn(
            "uploads scan failed; votes may be partially retained",
            e?.message || e
          );
          // Optional hard reset of all votes if you prefer stronger guarantees:
          // genericVoteKeys.forEach(k => votesForThisWindow.add(k));
        }
      }

      // C) Any cached aggregated entries you might have (optional)
      const entriesCaches = await safeScan(`entries:*`); // only if you've introduced these

      // Build unique deletion set
      const toDelete = Array.from(
        new Set([
          listKey,
          winnersKey,
          winnerKey,
          socialIpsScoped,
          socialIpsLegacy,
          ...dedupes,
          ...bonuses,
          ...socialStates,
          ...socialLocks,
          ...jpCounts,
          // NEW
          ...votesForThisWindow,
          ...entriesCaches,
        ])
      );

      let deleted = 0;
      for (const k of toDelete) {
        deleted += await delKey(k);
      }

      // Clear memory mirrors too
      MEM.winners = [];
      MEM.currentWinner = null;

      // For sanity, show what (if anything) remains for this window
      const [remainingSocial, remainingEntered, remainingJp, remainingVotes] =
        await Promise.all([
          safeScan(`social:${windowKey}:*`),
          safeScan(`raffle:entered:${windowKey}:*`),
          safeScan(`raffle:jackpotCount:${windowKey}:*`),
          // Try both scoped and generic vote keys again
          (async () => {
            const leftover = new Set(await safeScan(`votes:${windowKey}:*`));
            const genericLeft = await safeScan(`votes:*`);
            if (genericLeft.length) {
              // If we identified fileIds earlier, we can re-check them;
              // but since we don't retain them here, just list any generic votes left.
              genericLeft.forEach((k) => leftover.add(k));
            }
            return Array.from(leftover);
          })(),
        ]);

      return res.status(200).json({
        success: true,
        windowKey,
        deletedKeys: deleted,
        remaining: {
          social: remainingSocial,
          raffleEntered: remainingEntered,
          jackpots: remainingJp,
          votes: remainingVotes, // ← helpful to verify they're gone
        },
      });
    } catch (e) {
      console.error(
        "❌ reset-entries failed:",
        e?.message || e,
        e?.stack || ""
      );
      return res.status(500).json({
        success: false,
        error: "Reset entries failed",
        details: e?.message || String(e),
      });
    }
  }

  // ────────────────────────────────────────────────────────────
  // Social status (per-window aggregate for Admin UI)
  // ────────────────────────────────────────────────────────────
  if (req.method === "GET" && action === "social-status") {
    const ok = await ensureRedisConnected();
    if (!ok || !redis?.isOpen) {
      return res.status(200).json({
        totals: {
          uniqueIPsTracked: 0,
          unlocked: 0,
          facebookClicks: 0,
          instagramClicks: 0,
        },
        entries: [],
        _fallback: true,
      });
    }

    const { windowKey } = await getWindowInfo();
    const setKey = `social:ips:${windowKey}`;
    const ips = await redis.sMembers(setKey);

    const entries = [];
    let totalUnlocked = 0,
      fbClicks = 0,
      igClicks = 0;

    for (const ip of ips) {
      const key = `social:${windowKey}:${ip}`;
      const raw = await redis.get(key);
      if (!raw) continue;
      let s;
      try {
        s = JSON.parse(raw);
      } catch {
        s = { followed: raw === "true", platforms: {} };
      }
      const ttlSeconds = await redis.ttl(key);
      if (s.followed) totalUnlocked += 1;
      if (s.platforms?.fb) fbClicks += 1;
      if (s.platforms?.ig) igClicks += 1;
      entries.push({
        ip,
        firstSeen: s.firstSeen || null,
        lastSeen: s.lastSeen || null,
        followed: !!s.followed,
        platforms: s.platforms || {},
        count: s.count || 1,
        ttlSeconds,
      });
    }

    return res.status(200).json({
      totals: {
        uniqueIPsTracked: entries.length,
        unlocked: totalUnlocked,
        facebookClicks: fbClicks,
        instagramClicks: igClicks,
      },
      entries,
    });
  }

  /* ────────────────────────────────────────────────────────────
     WINNER (current) + PICK + RESET
  ───────────────────────────────────────────────────────────── */
  if (action === "winner" && req.method === "GET") {
    try {
      const ok = await ensureRedisConnected();
      if (ok && redis?.isOpen) {
        const winner = await redis.get("raffle_winner");
        return res.json({ winner: winner ? JSON.parse(winner) : null });
      }
      return res.json({
        winner: MEM.currentWinner ? { name: MEM.currentWinner } : null,
        _fallback: true,
      });
    } catch (err) {
      console.error("❌ winner GET:", err);
      return res.status(500).json({ error: "Failed to get winner" });
    }
  }

  if (action === "pick-winner" && req.method === "POST") {
    await ensureRedisConnected();
    const { role } = req.body || {};
    if (role !== "admin")
      return res.status(401).json({ error: "Unauthorized" });

    try {
      const { windowKey } = await getWindowInfo();
      if (!redis?.isOpen)
        return res.status(503).json({ error: "Redis not ready" });

      const listKey = `raffle:entries:${windowKey}`;
      const raw = await redis.lRange(listKey, 0, -1);
      const entries = raw
        .map((s) => {
          try {
            return JSON.parse(s);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      if (!entries.length)
        return res.status(400).json({ error: "No eligible entries" });

      const idx = Math.floor(Math.random() * entries.length);
      const winner = entries[idx];
      const payload = {
        id: winner.id,
        name: winner.name,
        source: winner.source || null,
      };

      await redis.set("raffle_winner", JSON.stringify(payload));
      MEM.currentWinner = payload.name;

      const row = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
        name: payload.name,
        prize: "Raffle Winner — T-Shirt",
        source: "raffle",
        windowKey,
        ts: new Date().toISOString(),
      };
      await appendWinnerRow(row);

      try {
        await fetch("https://winner-sse-server.onrender.com/broadcast", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ winner: payload.name }),
        });
      } catch {}
      return res.json({ success: true, winner: payload });
    } catch (err) {
      console.error("❌ pick-winner:", err);
      return res.status(500).json({ error: "Failed to pick winner" });
    }
  }

  /* ────────────────────────────────────────────────────────────
   RESET CURRENT WINNER (+ optionally clear Winners Ledger)
───────────────────────────────────────────────────────────── */
  if (action === "reset-winner" && req.method === "POST") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });

    const u = new URL(req.url || "", `http://${req.headers.host}`);

    // By default we CLEAR the winners ledger too.
    // You can override by calling ?keepLedger=true or body: { clearLedger: false }
    const keepLedgerQP = /^true|1|yes$/i.test(
      u.searchParams.get("keepLedger") || ""
    );
    const clearLedgerBody =
      typeof req.body?.clearLedger === "boolean"
        ? req.body.clearLedger
        : undefined;
    const clearLedger =
      clearLedgerBody !== undefined ? clearLedgerBody : !keepLedgerQP;

    await ensureRedisConnected();

    try {
      // Clear the “current winner” key everywhere
      if (redis?.isOpen) await redis.del("raffle_winner");
      MEM.currentWinner = null;

      // Optionally clear the Winners Ledger as well
      let ledgerCleared = false;
      if (clearLedger) {
        try {
          if (redis?.isOpen) {
            await redis.del("raffle:winners:all");
          }
          MEM.winners = [];

          // If you’re running locally and keep a file fallback, wipe it too
          try {
            const localFilePath = path.join(
              process.cwd(),
              ".data",
              "winners-local.json"
            );
            if (fs.existsSync(localFilePath)) {
              fs.writeFileSync(localFilePath, "[]");
            }
          } catch {}

          ledgerCleared = true;
        } catch (e) {
          console.warn(
            "reset-winner: clearing ledger failed:",
            e?.message || e
          );
        }
      }

      // Optional: broadcast reset for any SSE client you have
      try {
        await fetch("https://winner-sse-server.onrender.com/reset", {
          method: "POST",
        });
      } catch {}

      return res.json({
        success: true,
        ledgerCleared,
        note: ledgerCleared
          ? "Current winner and Winners Ledger cleared."
          : "Current winner cleared. Ledger kept.",
      });
    } catch (err) {
      console.error("❌ reset-winner:", err);
      return res.status(500).json({
        success: false,
        error: "Failed to reset winner",
        details: err?.message || String(err),
      });
    }
  }

  /* ────────────────────────────────────────────────────────────
     WINNERS LEDGER (manual + list)
  ───────────────────────────────────────────────────────────── */
  if (action === "winner-log" && req.method === "POST") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    const { name, prize } = req.body || {};
    const cleanName = (name || "").toString().trim().slice(0, 120);
    const cleanPrize = (prize || "").toString().trim().slice(0, 160);
    if (!cleanName || !cleanPrize)
      return res.status(400).json({ error: "name and prize required" });

    const row = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      name: cleanName,
      prize: cleanPrize,
      source: "manual",
      ts: new Date().toISOString(),
    };
    try {
      await appendWinnerRow(row);
      noCache(res);
      return res.status(200).json({ success: true, row });
    } catch (e) {
      console.error("winner-log failed:", e);
      return res.status(500).json({ error: "winner-log failed" });
    }
  }

  if (action === "winner-logs" && req.method === "GET") {
    try {
      const ok = await ensureRedisConnected();

      let redisRows = [];
      if (ok && redis?.isOpen) {
        const raw = await redis.lRange("raffle:winners:all", -400, -1);
        redisRows = raw
          .map((s) => {
            try {
              return JSON.parse(s);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      }

      const memRows = Array.isArray(MEM.winners) ? MEM.winners : [];
      const fileRows = isLocal ? readLocalLedgerSafe() : [];

      // Merge & dedupe by id
      const byId = new Map();
      for (const r of [...redisRows, ...fileRows, ...memRows]) {
        if (r && r.id) byId.set(r.id, r);
      }

      const rows = Array.from(byId.values())
        .sort((a, b) => new Date(b.ts) - new Date(a.ts))
        .slice(0, 200);

      noCache(res);
      return res.status(200).json({ rows });
    } catch (e) {
      console.error("winner-logs failed:", e);
      return res.status(500).json({ rows: [], error: "fetch failed" });
    }
  }

  /* ────────────────────────────────────────────────────────────
     FOLLOWERS / SOCIAL
  ───────────────────────────────────────────────────────────── */
  if (action === "followers" && req.method === "GET") {
    try {
      const token = process.env.FB_PAGE_TOKEN;
      const pageId = process.env.FB_PAGE_ID;
      const igId = process.env.IG_ACCOUNT_ID;
      if (!token || !pageId || !igId) {
        return res
          .status(200)
          .json({ facebook: 0, instagram: 0, _note: "missing env" });
      }
      const fbRes = await fetch(
        `https://graph.facebook.com/v19.0/${pageId}?fields=fan_count&access_token=${token}`
      );
      const igRes = await fetch(
        `https://graph.facebook.com/v19.0/${igId}?fields=followers_count&access_token=${token}`
      );
      const fbJson = await fbRes.json().catch(() => ({}));
      const igJson = await igRes.json().catch(() => ({}));
      return res.status(200).json({
        facebook: Number(fbJson?.fan_count || 0),
        instagram: Number(igJson?.followers_count || 0),
      });
    } catch (err) {
      console.error("❌ followers:", err?.message || err);
      return res.status(200).json({ facebook: 0, instagram: 0 });
    }
  }

  if (req.method === "GET" && action === "check-follow") {
    await ensureRedisConnected();
    const { windowKey } = await getWindowInfo();
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0] ||
      req.socket.remoteAddress ||
      "unknown";
    let raw = null;
    try {
      raw = await redis.get(`social:${windowKey}:${ip}`);
    } catch {}
    if (!raw)
      try {
        raw = await redis.get(`social:${ip}`);
      } catch {}
    return res.status(200).json({ allowed: isFollowAllowed(raw) });
  }

  if (
    (req.method === "POST" || req.method === "GET") &&
    action === "mark-follow"
  ) {
    await ensureRedisConnected();
    if (!redis?.isOpen)
      return res.status(503).json({ error: "Redis not ready" });

    let platform =
      new URL(req.url, `http://${req.headers.host}`).searchParams.get(
        "platform"
      ) ||
      (typeof req.body === "object" && req.body ? req.body.platform : null);
    platform = (platform || "").toString().trim().toLowerCase();

    if (platform !== "fb" && platform !== "ig") {
      return res.status(400).json({ error: "Invalid platform" });
    }

    const { windowKey, ttlSeconds } = await getWindowInfo();
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";

    const lockKey = `social:lock:${windowKey}:${ip}`;
    try {
      const got = await redis.set(lockKey, platform, { NX: true, PX: 1000 });
      if (!got) return res.status(200).json({ success: true, throttled: true });
    } catch {}

    const key = `social:${windowKey}:${ip}`;
    const setKey = `social:ips:${windowKey}`;
    const now = new Date().toISOString();

    let state = {
      firstSeen: now,
      lastSeen: now,
      followed: true,
      count: 0,
      platforms: { fb: false, ig: false },
    };

    try {
      const prev = await redis.get(key);
      if (prev) {
        try {
          const p = JSON.parse(prev);
          state.firstSeen = p.firstSeen || state.firstSeen;
          state.count = Number(p.count || 0);
          state.platforms = { fb: !!p.platforms?.fb, ig: !!p.platforms?.ig };
        } catch {}
      }
    } catch {}

    state.lastSeen = now;
    state.followed = true;
    state.count += 1;
    state.platforms[platform] = true;

    await redis.set(key, JSON.stringify(state), { EX: ttlSeconds });
    await redis.sAdd(setKey, ip);

    return res.status(200).json({ success: true, state });
  }

  if (action === "slot-spins-version" && req.method === "GET") {
    const ok = await ensureRedisConnected();
    if (!ok || !redis?.isOpen) return res.status(200).json({ version: 0 });
    const v =
      Number(await redis.get("slot:spinsResetVersion").catch(() => 0)) || 0;
    return res.status(200).json({ version: v });
  }
  if (action === "reset-slot-spins" && req.method === "POST") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    const ok = await ensureRedisConnected();
    if (!ok || !redis?.isOpen)
      return res.status(503).json({ error: "Redis not ready" });
    const version = await redis.incr("slot:spinsResetVersion");
    await redis.set("slot:spinsResetAt", new Date().toISOString(), {
      EX: 60 * 60 * 24 * 7,
    });
    return res.status(200).json({ success: true, version });
  }

  /* ────────────────────────────────────────────────────────────
     SHUTDOWN toggle
  ───────────────────────────────────────────────────────────── */
  if (req.method === "GET" && action === "shutdown-status") {
    try {
      await ensureRedisConnected();
      const raw = await redis?.get("shutdown").catch(() => null);
      const isShutdown = raw === "true";
      return res.status(200).json({ isShutdown });
    } catch (e) {
      console.error("shutdown-status error:", e);
      return res.status(200).json({ isShutdown: false, _warning: "fallback" });
    }
  }
  if (req.method === "POST" && action === "toggle-shutdown") {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    const ok = await ensureRedisConnected();
    if (!ok || !redis?.isOpen)
      return res.status(503).json({ error: "Redis not ready" });
    const current = await redis.get("shutdown");
    const newStatus = current !== "true";
    await redis.set("shutdown", newStatus ? "true" : "false");
    return res.status(200).json({ success: true, isShutdown: newStatus });
  }

  /* ────────────────────────────────────────────────────────────
     SLOT → prize-log (WITH DEBUGGING)
  ───────────────────────────────────────────────────────────── */
  if (
    action === "prize-log" &&
    (req.method === "POST" || req.method === "GET")
  ) {
    console.log("// DEBUG: Received request for prize-log.");
    await ensureRedisConnected();
    const { windowKey } = await getWindowInfo();

    const body = req.body && typeof req.body === "object" ? req.body : {};
    console.log("// DEBUG: Request body received:", JSON.stringify(body));

    const name = (body.name || "(anonymous)").toString().slice(0, 80);
    const targets = Array.isArray(body.targets) ? body.targets.map(String) : [];
    const explicit = body.jackpot === true || body.jackpot === "true";

    console.log(
      `// DEBUG: Checking for jackpot. Explicit flag: ${explicit}, Targets: ${targets.join(
        ", "
      )}`
    );
    const isJackpot = detectJackpot(targets, explicit);

    if (!isJackpot) {
      console.log("// DEBUG: Not a jackpot. Ignoring.");
      noCache(res);
      return res
        .status(200)
        .json({ success: true, ignored: true, isJackpot: false });
    }

    console.log("// DEBUG: Jackpot detected! Preparing to save winner.");
    const prizeName = targets[0]?.trim() || "Jackpot";
    const row = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      name,
      prize: `${prizeName}`,
      source: "slot",
      windowKey,
      ts: new Date().toISOString(),
    };

    try {
      console.log(
        "// DEBUG: Appending winner row to ledger:",
        JSON.stringify(row)
      );
      await appendWinnerRow(row);
      noCache(res);
      return res.status(200).json({ success: true, isJackpot: true, row });
    } catch (e) {
      console.error("// DEBUG: prize-log failed during append:", e);
      return res
        .status(500)
        .json({ success: false, error: "prize-log failed" });
    }
  }

  // ────────────────────────────────────────────────────────────
  // BONUS ENTRY (non-deduped) — used for "Extra Entry" jackpots
  // ────────────────────────────────────────────────────────────
  if (action === "bonus-entry" && req.method === "POST") {
    const ok = await ensureRedisConnected();
    if (!ok || !redis?.isOpen) {
      return res.status(503).json({ error: "Redis not ready" });
    }

    const nameRaw = (req.body?.name || "").trim();
    if (!nameRaw) return res.status(400).json({ error: "Missing name" });
    const name = nameRaw.slice(0, 80);

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";

    const { windowKey, ttlSeconds } = await getWindowInfo();
    const listKey = `raffle:entries:${windowKey}`;
    const bonusKey = `raffle:bonus:${windowKey}:${ip}`;

    const entry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      name,
      ip,
      source: "jackpot-bonus",
      createdTime: new Date().toISOString(),
    };

    await redis
      .multi()
      .rPush(listKey, JSON.stringify(entry))
      .expire(listKey, ttlSeconds)
      .incr(bonusKey)
      .expire(bonusKey, ttlSeconds)
      .exec();

    return res.status(200).json({ success: true, entry });
  }

  /* ───── UNKNOWN ───── */
  return res.status(400).json({ error: "Invalid action or method" });
}
