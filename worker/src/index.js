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

// Бот-тренажёр (@MathMaks_SAT_bot) без своего сервера: Telegram шлёт сюда апдейты (webhook),
// на любое сообщение в личке отвечаем приветствием и кнопкой Mini App.
const WELCOME = "👋 Привет! Это <b>Math Maks</b> — тренажёр SAT Math.\n\n" +
  "368 реальных задач College Board по всем разделам, проверка ответа и разбор на русском.\n\n" +
  "<b>Как пользоваться:</b>\n" +
  "1. Нажми «🚀 Открыть тренажёр» ниже (или кнопку «Тренажёр» слева от поля ввода).\n" +
  "2. Впиши имя — под ним сохранятся прогресс и место в рейтинге.\n" +
  "3. Выбери раздел и тему, решай и смотри разбор.\n\n" +
  "Задача дня и приёмы SAT Math — в канале @Math_Maks";

async function hookSecret(token) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(token)))).slice(0, 40);
}

async function telegramHook(req, env) {
  if (!env.BOT_TOKEN_SAT || req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== await hookSecret(env.BOT_TOKEN_SAT))
    return new Response("forbidden", { status: 403 });
  let upd;
  try { upd = await req.json(); } catch { return new Response("ok"); }
  const msg = upd.message;
  if (msg && msg.chat && msg.chat.type === "private") {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN_SAT}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: msg.chat.id, text: WELCOME, parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: "🚀 Открыть тренажёр", web_app: { url: env.TRAINER_URL } }],
          [{ text: "🎓 Интенсив к SAT 5 декабря", url: env.KURS_URL || "https://mathmaks4406-maker.github.io/math-maks-app/kurs.html" }],
        ] } }),
    });
  }
  return new Response("ok");
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(env) });
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/tg/hook") return telegramHook(req, env);
    if (req.method !== "POST" || !url.pathname.startsWith("/api/")) return json(env, { ok: true, service: "math-maks-api" });
    let body;
    try { body = await req.json(); } catch { return json(env, { error: "bad json" }, 400); }
    const user = await checkInitData(body.initData, env.BOT_TOKEN) || await checkInitData(body.initData, env.BOT_TOKEN_SAT);
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
    // журнал попыток — для рейтинга за неделю
    this.sql.exec(`CREATE TABLE IF NOT EXISTS attempts(uid INTEGER, task INTEGER, ok INTEGER, ts INTEGER)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS attempts_ts ON attempts(ts)`);
    try { this.sql.exec(`ALTER TABLE users ADD COLUMN streak INTEGER DEFAULT 0`); } catch (e) {}
  }

  upsertUser(u, name) {
    const now = Date.now();
    const nm = String(name || u.first || "Ученик").slice(0, 30);
    this.sql.exec(`INSERT INTO users(uid, name, username, created, last) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(uid) DO UPDATE SET name = excluded.name, username = excluded.username, last = excluded.last`,
      u.id, nm, u.username, now, now);
  }

  board(meId) {
    const rows = this.sql.exec(`SELECT u.uid, u.name, u.hidden, u.streak,
        COALESCE(SUM(CASE WHEN r.ok > 0 THEN 1 ELSE 0 END), 0) AS solved,
        COALESCE(SUM(r.n), 0) AS tries
      FROM users u LEFT JOIN results r ON r.uid = u.uid
      GROUP BY u.uid ORDER BY solved DESC, tries ASC`).toArray();
    const since = Date.now() - 7 * 86400e3;
    const wk = this.sql.exec(`SELECT uid, COUNT(DISTINCT task) AS solved, COUNT(*) AS tries FROM attempts WHERE ts > ? AND ok = 1 GROUP BY uid`, since).toArray();
    const wkTries = this.sql.exec(`SELECT uid, COUNT(*) AS tries FROM attempts WHERE ts > ? GROUP BY uid`, since).toArray();
    const byUid = Object.fromEntries(rows.map(r => [r.uid, r]));
    const mk = (list, key) => {
      const visible = list.filter(r => byUid[r.uid] && !byUid[r.uid].hidden && r.solved > 0).sort((a, b) => b.solved - a.solved || a.tries - b.tries);
      const top = visible.slice(0, 20).map((r, i) => ({ place: i + 1, name: byUid[r.uid].name, solved: r.solved, tries: r.tries, streak: byUid[r.uid].streak || 0, me: r.uid === meId }));
      const myIdx = visible.findIndex(r => r.uid === meId);
      return { top, me: myIdx >= 0 ? { place: myIdx + 1, solved: visible[myIdx].solved } : null, total: visible.length };
    };
    const all = mk(rows), week = mk(wk.map(w => ({ uid: w.uid, solved: w.solved, tries: (wkTries.find(x => x.uid === w.uid) || {}).tries || w.tries })));
    return { top: all.top, me: all.me, total: all.total, week: week.top, meWeek: week.me, weekTotal: week.total };
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
      const ev = Array.isArray(body.ev) ? body.ev.slice(0, 300) : [];
      const now = Date.now();
      for (const e of ev) {
        if (!Array.isArray(e) || !(e[0] > 0) || !Number.isFinite(e[2])) continue;
        this.sql.exec(`INSERT INTO attempts(uid, task, ok, ts) VALUES(?, ?, ?, ?)`, u.id, Number(e[0]), e[1] ? 1 : 0, Math.min(Number(e[2]), now));
      }
      if (Number.isFinite(body.streak)) this.sql.exec(`UPDATE users SET streak = ? WHERE uid = ?`, Math.max(0, Math.min(9999, Number(body.streak))), u.id);
      return { ...this.board(u.id), admin: isAdmin };
    }
    if (path === "/api/board") return { ...this.board(u.id), admin: isAdmin };

    if (!isAdmin) return { error: "forbidden" };
    if (path === "/api/admin/users") {
      const users = this.sql.exec(`SELECT uid, name, username, hidden, created, last, streak FROM users ORDER BY last DESC`).toArray();
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
      this.sql.exec(`DELETE FROM attempts WHERE uid = ?`, Number(body.uid));
      this.sql.exec(`DELETE FROM users WHERE uid = ?`, Number(body.uid));
      return { ok: true };
    }
    return { error: "unknown" };
  }
}
