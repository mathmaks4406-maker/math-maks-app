// API тренажёра Math Maks: прогресс учеников, таблица лидеров и админка.
// Все запросы подписаны Telegram (initData) и проверяются токеном бота.
import { DurableObject } from "cloudflare:workers";

const enc = new TextEncoder();

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}
const hex = b => [...b].map(x => x.toString(16).padStart(2, "0")).join("");

// Проверка подписи Telegram Mini App: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
async function checkInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = await hmac("WebAppData", botToken);
  if (hex(await hmac(secret, dcs)) !== hash) return null;
  const authDate = Number(p.get("auth_date") || 0);
  if (Date.now() / 1000 - authDate > 30 * 24 * 3600) return null;
  try { return JSON.parse(p.get("user")); } catch { return null; }
}

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}
const json = (env, data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors(env) } });

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(env) });
    const url = new URL(req.url);
    if (req.method !== "POST" || !url.pathname.startsWith("/api/")) return json(env, { ok: true, service: "math-maks-api" });
    let body;
    try { body = await req.json(); } catch { return json(env, { error: "bad json" }, 400); }
    const user = await checkInitData(body.initData, env.BOT_TOKEN);
    if (!user || !user.id) return json(env, { error: "unauthorized" }, 401);
    const admins = String(env.ADMIN_IDS || "").split(/[,\s]+/).filter(Boolean).map(Number);
    const stub = env.BOARD.get(env.BOARD.idFromName("main"));
    const res = await stub.handle(url.pathname, body, { id: user.id, username: user.username || "", first: user.first_name || "" },
      admins.includes(user.id));
    return json(env, res, res && res.error ? 400 : 200);
  },
};

export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS users(
      uid INTEGER PRIMARY KEY, name TEXT, username TEXT, hidden INTEGER DEFAULT 0,
      created INTEGER, last INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS results(
      uid INTEGER, task INTEGER, n INTEGER, ok INTEGER, last INTEGER, PRIMARY KEY(uid, task))`);
  }

  upsertUser(u, name) {
    const now = Date.now();
    const nm = String(name || u.first || "Ученик").slice(0, 30);
    this.sql.exec(`INSERT INTO users(uid, name, username, created, last) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(uid) DO UPDATE SET name = excluded.name, username = excluded.username, last = excluded.last`,
      u.id, nm, u.username, now, now);
  }

  board(meId) {
    const rows = this.sql.exec(`SELECT u.uid, u.name, u.hidden,
        COALESCE(SUM(CASE WHEN r.ok > 0 THEN 1 ELSE 0 END), 0) AS solved,
        COALESCE(SUM(r.n), 0) AS tries
      FROM users u LEFT JOIN results r ON r.uid = u.uid
      GROUP BY u.uid ORDER BY solved DESC, tries ASC`).toArray();
    const visible = rows.filter(r => !r.hidden && r.solved > 0);
    const top = visible.slice(0, 20).map((r, i) => ({ place: i + 1, name: r.name, solved: r.solved, tries: r.tries, me: r.uid === meId }));
    const myIdx = visible.findIndex(r => r.uid === meId);
    const me = myIdx >= 0 ? { place: myIdx + 1, solved: visible[myIdx].solved } : null;
    return { top, me, total: visible.length };
  }

  async handle(path, body, u, isAdmin) {
    if (path === "/api/sync") {
      this.upsertUser(u, body.name);
      const done = String(body.done || "").split(";").slice(0, 2000);
      for (const x of done) {
        const p = x.split(":").map(Number);
        if (p.length !== 4 || !(p[0] > 0) || p.some(v => !Number.isFinite(v))) continue;
        this.sql.exec(`INSERT INTO results(uid, task, n, ok, last) VALUES(?, ?, ?, ?, ?)
          ON CONFLICT(uid, task) DO UPDATE SET n = excluded.n, ok = excluded.ok, last = excluded.last`,
          u.id, p[0], Math.min(p[1], 999), Math.min(p[2], 999), p[3] ? 1 : 0);
      }
      return { ...this.board(u.id), admin: isAdmin };
    }
    if (path === "/api/board") return { ...this.board(u.id), admin: isAdmin };

    if (!isAdmin) return { error: "forbidden" };
    if (path === "/api/admin/users") {
      const users = this.sql.exec(`SELECT uid, name, username, hidden, created, last FROM users ORDER BY last DESC`).toArray();
      const res = this.sql.exec(`SELECT uid, task, n, ok, last FROM results`).toArray();
      const by = {};
      for (const r of res) (by[r.uid] ||= []).push([r.task, r.n, r.ok, r.last]);
      return { users: users.map(x => ({ ...x, results: by[x.uid] || [] })) };
    }
    if (path === "/api/admin/hide") {
      this.sql.exec(`UPDATE users SET hidden = ? WHERE uid = ?`, body.hidden ? 1 : 0, Number(body.uid));
      return { ok: true };
    }
    if (path === "/api/admin/rename") {
      this.sql.exec(`UPDATE users SET name = ? WHERE uid = ?`, String(body.name || "").slice(0, 30), Number(body.uid));
      return { ok: true };
    }
    if (path === "/api/admin/delete") {
      this.sql.exec(`DELETE FROM results WHERE uid = ?`, Number(body.uid));
      this.sql.exec(`DELETE FROM users WHERE uid = ?`, Number(body.uid));
      return { ok: true };
    }
    return { error: "unknown" };
  }
}
