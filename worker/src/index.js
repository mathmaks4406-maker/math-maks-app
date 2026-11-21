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
  "1925 реальных задач College Board по всем разделам, проверка ответа и разбор на русском. Формулы как в Bluebook, черновик, подсказки, тест как на экзамене.\n\n" +
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
        reply_markup: { inline_keyboard: [[{ text: "🚀 Открыть тренажёр", web_app: { url: env.TRAINER_URL } }]] } }),
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
    this.sql.exec(`CREATE INDEX IF NOT EXISTS attempts_u ON attempts(uid, task, ts)`);
    try { this.sql.exec(`ALTER TABLE users ADD COLUMN streak INTEGER DEFAULT 0`); } catch (e) {}
  }

  upsertUser(u, name) {
    const now = Date.now();
    const nm = String(name || u.first || "Ученик").replace(/\s+/g, " ").trim().slice(0, 30) || "Ученик";
    this.sql.exec(`INSERT INTO users(uid, name, username, created, last) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(uid) DO UPDATE SET name = CASE WHEN ? THEN excluded.name ELSE name END, username = excluded.username, last = excluded.last`,
      u.id, nm, u.username, now, now, String(name || "").trim() ? 1 : 0);
  }

  // Рейтинг. Место считается по числу разных задач, решённых верно: у кого поровну — одно и то же место
  // (1, 2, 2, 4). Внутри равных порядок постоянный: меньше попыток, потом по имени, потом по uid —
  // поэтому строки больше не «скачут» между открытиями.
  board(meId) {
    const users = this.sql.exec(`SELECT uid, name, hidden, streak FROM users`).toArray();
    const byUid = Object.fromEntries(users.map(r => [r.uid, r]));
    const allRows = this.sql.exec(`SELECT uid, SUM(CASE WHEN ok > 0 THEN 1 ELSE 0 END) AS solved, SUM(n) AS tries
      FROM results GROUP BY uid`).toArray();
    const now = Date.now(), since = now - 7 * 86400e3, since2 = now - 14 * 86400e3;
    const wkRows = this.sql.exec(`SELECT uid, COUNT(DISTINCT CASE WHEN ok = 1 THEN task END) AS solved, COUNT(*) AS tries
      FROM attempts WHERE ts > ? GROUP BY uid`, since).toArray();
    const prevRows = this.sql.exec(`SELECT uid, COUNT(DISTINCT CASE WHEN ok = 1 THEN task END) AS solved
      FROM attempts WHERE ts > ? AND ts <= ? GROUP BY uid`, since2, since).toArray();
    const prev = Object.fromEntries(prevRows.map(r => [r.uid, r.solved]));
    const LIMIT = 50;
    const mk = list => {
      const visible = list.filter(r => byUid[r.uid] && !byUid[r.uid].hidden && r.solved > 0)
        .map(r => ({ ...r, name: byUid[r.uid].name || "Ученик" }))
        .sort((a, b) => b.solved - a.solved || a.tries - b.tries || a.name.localeCompare(b.name, "ru") || a.uid - b.uid);
      let place = 0;
      visible.forEach((r, i) => { if (i === 0 || r.solved !== visible[i - 1].solved) place = i + 1; r.place = place; });
      const row = r => ({ place: r.place, name: r.name, solved: r.solved, tries: r.tries, streak: byUid[r.uid].streak || 0, me: r.uid === meId });
      const mine = visible.find(r => r.uid === meId);
      return { top: visible.slice(0, LIMIT).map(row), me: mine ? row(mine) : null, total: visible.length };
    };
    const all = mk(allRows), week = mk(wkRows);
    // «Лучший прогресс недели»: кто прибавил больше всех относительно прошлой недели — шанс и для новичков
    const growth = wkRows.filter(r => byUid[r.uid] && !byUid[r.uid].hidden)
      .map(r => ({ uid: r.uid, name: byUid[r.uid].name || "Ученик", d: r.solved - (prev[r.uid] || 0), now: r.solved }))
      .filter(r => r.d > 0).sort((a, b) => b.d - a.d || b.now - a.now || a.uid - b.uid).slice(0, 3)
      .map(r => ({ name: r.name, d: r.d, me: r.uid === meId }));
    const myWeek = wkRows.find(r => r.uid === meId);
    return { top: all.top, me: all.me, total: all.total, week: week.top, meWeek: week.me, weekTotal: week.total,
      growth, myGrowth: { now: myWeek ? myWeek.solved : 0, prev: prev[meId] || 0 } };
  }

  async handle(path, body, u, isAdmin) {
    if (path === "/api/sync") {
      this.upsertUser(u, body.name);
      // Формат записи от приложения: id:n:ok:last[:day[:st]]. С 03.11 приложение шлёт 5–6 частей,
      // а сервер принимал ровно 4 — поэтому новые решения в общий рейтинг не попадали. Берём первые 4.
      // Значения не уменьшаем: если ученик открывал тренажёр из двух ботов, сохраняется лучшее.
      const done = String(body.done || "").split(";").slice(0, 2500);
      for (const x of done) {
        const p = x.split(":").slice(0, 4).map(Number);
        if (p.length !== 4 || !(p[0] > 0) || p.some(v => !Number.isFinite(v))) continue;
        const n = Math.min(Math.max(p[1], 0), 999), ok = Math.min(Math.max(p[2], 0), 999), last = p[3] ? 1 : 0;
        this.sql.exec(`INSERT INTO results(uid, task, n, ok, last) VALUES(?, ?, ?, ?, ?)
          ON CONFLICT(uid, task) DO UPDATE SET n = MAX(n, excluded.n), ok = MAX(ok, excluded.ok),
            last = CASE WHEN excluded.n >= n THEN excluded.last ELSE last END
          WHERE excluded.n > n OR excluded.ok > ok OR (excluded.n = n AND excluded.last != last)`,
          u.id, p[0], n, ok, last);
      }
      const ev = Array.isArray(body.ev) ? body.ev.slice(0, 300) : [];
      const now = Date.now();
      for (const e of ev) {
        if (!Array.isArray(e) || !(e[0] > 0) || !Number.isFinite(e[2])) continue;
        // одна и та же попытка могла прийти дважды (связь оборвалась после записи) — не дублируем
        const ts = Math.min(Number(e[2]), now), task = Number(e[0]);
        this.sql.exec(`INSERT INTO attempts(uid, task, ok, ts) SELECT ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM attempts WHERE uid = ? AND task = ? AND ts = ?)`, u.id, task, e[1] ? 1 : 0, ts, u.id, task, ts);
      }
      if (Number.isFinite(body.streak)) this.sql.exec(`UPDATE users SET streak = ? WHERE uid = ?`, Math.max(0, Math.min(9999, Number(body.streak))), u.id);
      const out = { ...this.board(u.id), admin: isAdmin };
      // при первом обмене за сессию отдаём ученику его же результаты с сервера: приложение
      // дольёт задачи, которых нет на этом устройстве (другой бот, сбой хранилища Telegram)
      if (body.full) out.mine = this.sql.exec(`SELECT task, n, ok, last FROM results WHERE uid = ?`, u.id).toArray()
        .map(r => `${r.task}:${r.n}:${r.ok}:${r.last}`).join(";");
      return out;
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
