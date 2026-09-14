/* server.mjs —— 《入戏》本地服务器（零 npm 依赖）
   - 静态资源：public/
   - GET  /api/health      健康检查
   - GET  /api/stories     故事元数据
   - GET  /api/play/:id    剧本 JSON（离线剧本化产物）
   - POST /api/say         自由输入 → DeepSeek 即兴接话（密钥仅存后端）
   用法: node server.mjs  →  http://127.0.0.1:4173/
*/
import { createServer } from "node:http";
import { readFile, readdir, appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, "public");
const ANALYTICS_DIR = path.join(__dirname, "data", "analytics");
const PORT = process.env.PORT || 4173;
mkdir(ANALYTICS_DIR, { recursive: true }).catch(() => {});

/* ---------- .env 加载（零依赖） ---------- */
const env = { ...process.env };
try {
  const dot = await readFile(path.join(__dirname, ".env"), "utf8");
  for (const line of dot.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2].trim();
  }
} catch { /* .env 可选 */ }

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".webp": "image/webp", ".avif": "image/avif",
};

function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
function json(res, code, obj) { send(res, code, JSON.stringify(obj)); }

async function serveStatic(res, urlPath) {
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const rel = safe === "/" || safe === "\\" ? "index.html" : safe;
  const file = path.join(PUB, rel);
  if (!file.startsWith(PUB)) return json(res, 403, { error: "forbidden" });
  try {
    const data = await readFile(file);
    const ext = path.extname(file).toLowerCase();
    send(res, 200, data, MIME[ext] || "application/octet-stream");
  } catch {
    json(res, 404, { error: "not found" });
  }
}

/* ---------- DeepSeek 调用 ---------- */
async function callDeepSeek(messages, { temperature = 0.9, maxTokens = 2048, jsonMode = false } = {}) {
  if (!env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY not configured");
  const body = {
    model: env.DEEPSEEK_MODEL || "deepseek-v4-flash",
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
    // 关键：v4-flash 的 reasoning_tokens 会吃光 max_tokens（正文 0 字，finish=length），
    // 必须显式关闭思考模式（与 scripts/ 下各编译脚本一致）
    thinking: { type: "disabled" },
  };
  if (jsonMode) body.response_format = { type: "json_object" };
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000), // 防上游挂起导致前端永久转圈
  });
  if (!r.ok) throw new Error(`deepseek ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  const content = data.choices?.[0]?.message?.content ?? "";
  if (!content) console.error("[llm] 空返回:", JSON.stringify({ finish: data.choices?.[0]?.finish_reason, usage: data.usage, err: data.error }).slice(0, 400));
  return content;
}

/* ---------- 简易内存限流（防评委手滑/恶意刷爆额度） ---------- */
const rateBuckets = new Map(); // key -> [timestamps]
function rateLimit(key, windowMs, max) {
  const now = Date.now();
  const arr = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { rateBuckets.set(key, arr); return false; }
  arr.push(now); rateBuckets.set(key, arr);
  if (rateBuckets.size > 5000) rateBuckets.clear(); // 防内存膨胀
  return true;
}
function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "local";
}

/* /api/say：角色即兴接话（不推进主线，只回应） */
async function handleSay(res, payload) {
  const { story_id, node_id, text, recent = [], cast = {}, speaker = "对方" } = payload || {};
  if (!text || typeof text !== "string" || text.length > 200)
    return json(res, 400, { error: "bad_text" });

  const castLine = cast[speaker] ? `人物卡（${speaker}）：${cast[speaker]}` : "";
  const history = (Array.isArray(recent) ? recent : [])
    .slice(-8)
    .map((m) => `${m.speaker || "旁白"}：${m.text}`)
    .join("\n");

  const system = [
    `你在文字互动剧《入戏》中扮演「${speaker}」。该剧改编自知乎盐言故事（story_id=${story_id}，节点=${node_id}）。`,
    castLine,
    "风格要求：知乎盐言文风——口语化、有画面感、情绪浓度高、符合人物口癖。",
    "硬性规则：只回应当前这一句，绝不推进主线情节、不替玩家做决定、不引入新角色；回应 1-3 句话（40-120 字）；可用（动作/神态）补充舞台感。",
  ].filter(Boolean).join("\n");

  const user = history ? `最近剧情：\n${history}\n\n玩家刚才说：${text}` : `玩家刚才说：${text}`;

  try {
    const reply = await callDeepSeek(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature: 0.95, maxTokens: 512 }
    );
    // 空回复兜底（内容风控拦截/上游异常时避免空气泡）
    const safe = (reply || "").trim();
    return json(res, 200, {
      speaker,
      reply: safe || "（对方沉默了片刻，似乎欲言又止……）",
    });
  } catch (e) {
    return json(res, 502, { error: "llm_failed", message: String(e.message || e).slice(0, 200) });
  }
}

/* ---------- 问看山（知乎直答，走官方 zhihu-cli，额度 100 次/天） ---------- */
const ZHIHU_CLI = env.ZHIHU_CLI || "C:\\Users\\lenovo\\AppData\\Local\\ZhihuCLI\\current\\zhihu-cli.exe";

function askKanshan(query) {
  return new Promise((resolve) => {
    execFile(
      ZHIHU_CLI,
      ["answer", "--query", query, "--timeout", "60s"],
      { maxBuffer: 4 * 1024 * 1024, timeout: 70000, windowsHide: true },
      (err, stdout) => {
        if (err && !stdout) return resolve({ ok: false, message: String(err.message || err).slice(0, 200) });
        try {
          const start = stdout.indexOf("{");
          const data = JSON.parse(stdout.slice(start));
          const content = data.choices?.[0]?.message?.content;
          if (!content) return resolve({ ok: false, message: "直答返回为空（可能额度已用尽）" });
          resolve({ ok: true, content });
        } catch (e) {
          resolve({ ok: false, message: `解析失败：${String(e.message).slice(0, 120)}` });
        }
      }
    );
  });
}

/* ---------- AI 演绎模式：导演 Agent（状态在前端，本端无会话） ---------- */

/* 修复 LLM JSON 值内未转义的半角引号/裸换行：
   "text": "（拍案）"放肆。"" → "text": "（拍案）\"放肆。\""
   原理：扫描到字符串内的 " 时，向后看下一个非空白字符——
   若是 , ] } : 则视为真正的收口引号，否则视为值内引号转义掉。 */
function repairJsonQuotes(raw) {
  let out = "", inStr = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (!inStr) {
      if (ch === '"') inStr = true;
      out += ch;
      continue;
    }
    if (ch === "\\") { out += ch + (raw[i + 1] ?? ""); i++; continue; }
    if (ch === "\n") { out += "\\n"; continue; }
    if (ch === '"') {
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw[j])) j++;
      const nxt = raw[j];
      if (nxt === undefined || !",]}:".includes(nxt)) { out += '\\"'; continue; }
      inStr = false;
    }
    out += ch;
  }
  return out;
}

/* ---------- AI 演绎配置缓存 + 埋点 ---------- */
const aiCfgCache = new Map();
async function loadAiConfig(id) {
  if (!/^[\w-]+$/.test(String(id || ""))) return null; // 白名单防路径穿越
  if (aiCfgCache.has(id)) return aiCfgCache.get(id);
  try {
    const cfg = JSON.parse(await readFile(path.join(__dirname, "data", "ai-mode", `${id}.json`), "utf8"));
    aiCfgCache.set(id, cfg);
    return cfg;
  } catch { return null; }
}

/* 基础埋点：追加写 jsonl，零依赖（data/analytics/events.jsonl） */
function trackEvent(type, data = {}) {
  const line = JSON.stringify({ ts: Date.now(), type, ...data }) + "\n";
  appendFile(path.join(ANALYTICS_DIR, "events.jsonl"), line).catch(() => {});
}

/* ---------- 后置质检（polish 管线）：超字截断 + 古代篇现代词重写 ---------- */
const MODERN_WORDS = /(手机|电脑|网络|微信|电话|视频|直播|软件|APP|app|信号|电灯|空调|冰箱|地铁|公交|火车|飞机|游戏机|巧克力|咖啡|可乐|披萨|数据|程序|代码|互联网)/;
function clampText(t) {
  t = String(t || "").trim();
  if (t.length <= 90) return t;
  const cut = t.slice(0, 90);
  const m = cut.match(/^[\s\S]*[。！？…」』]/);
  return m ? m[0] : cut + "……";
}
async function qualityCheck(cfg, out) {
  if (!out || !Array.isArray(out.replies) || !out.replies.length) return out;
  const castKeys = Object.keys(cfg.cast || {});
  let replies = out.replies.slice(0, 3).map((r, i) => ({
    ...r,
    // NPC 名称只能来自本篇配置，避免模型临时创造角色破坏连续性。
    speaker: castKeys.includes(String(r.speaker || "")) ? String(r.speaker) : (castKeys[i % castKeys.length] || "对方"),
    text: clampText(r.text),
  }));
  // 古代篇：台词命中现代词 → 一次 LLM 重写（失败则放行原文，可用性优先）
  if (cfg.era === "ancient" && replies.some((r) => MODERN_WORDS.test(r.text)) && env.DEEPSEEK_API_KEY) {
    try {
      const raw = await callDeepSeek([
        { role: "system", content: `你是古风台词润色器。把台词中的现代词汇改写为符合《${cfg.title}》时代背景的说法（意思转换或删改该句），保持人物口吻，每条≤60字。输出 JSON：{"replies":[{"speaker":"…","text":"…"}]}` },
        { role: "user", content: JSON.stringify(replies.map((r) => ({ speaker: r.speaker, text: r.text }))) },
      ], { temperature: 0.7, maxTokens: 700, jsonMode: true });
      let fixed = null;
      try { fixed = JSON.parse(raw); } catch { try { fixed = JSON.parse(repairJsonQuotes(raw)); } catch { /* 放弃 */ } }
      if (fixed && Array.isArray(fixed.replies) && fixed.replies.length && fixed.replies.every((r) => r && typeof r.text === "string")) {
        replies = fixed.replies.slice(0, 3).map((r, i) => ({
          ...r,
          speaker: castKeys.includes(String(r.speaker || "")) ? String(r.speaker) : (castKeys[i % castKeys.length] || "对方"),
          text: clampText(r.text),
        }));
        trackEvent("quality_rewrite", { story_id: cfg.story_id });
      }
    } catch { /* 质检失败不阻塞演出 */ }
  }
  return { ...out, replies };
}

async function handleDirector(res, payload) {
  const { story_id, state, text, recent = [], speaker } = payload || {};
  if (!text || typeof text !== "string" || text.length > 200)
    return json(res, 400, { error: "bad_text" });
  if (!state || typeof state !== "object") return json(res, 400, { error: "bad_state" });
  /* 服务端以配置为唯一事实源：cast/goal/flags 全部本地读取，不信前端（防伪造） */
  const cfg = await loadAiConfig(story_id);
  if (!cfg) return json(res, 404, { error: "bad_story", message: "该篇的 AI 演绎配置未上线" });
  trackEvent("director_call", { story_id, act: state.act || 1, turn: state.turn || 1 });

  const actNo = Math.min(Math.max(Math.round(+state.act || 1), 1), cfg.acts.length);
  const act = cfg.acts[actNo - 1];

  /* state 清洗：数值 0-100、turn 有界、flags 白名单化 */
  const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? Math.round(Math.max(0, Math.min(100, v))) : d);
  const cleanState = {
    turn: Math.max(1, Math.min(Math.round(+state.turn || 1), act.turn_limit + 2)),
    turn_limit: act.turn_limit,
    trust: num(state.trust, 50), danger: num(state.danger, 30), sincerity: num(state.sincerity, 0),
    flags: Array.isArray(state.flags) ? state.flags.filter((f) => typeof f === "string" && f.length <= 40).slice(0, 20) : [],
  };
  const cleanRecent = (Array.isArray(recent) ? recent : []).slice(-10)
    .filter((m) => m && typeof m.text === "string")
    .map((m) => ({ speaker: String(m.speaker || "旁白").slice(0, 20), text: String(m.text).slice(0, 200) }));

  const history = cleanRecent.map((m) => `${m.speaker}：${m.text}`).join("\n");
  /* 兜底 speaker 必须在 cast 里 */
  const castKeys = Object.keys(cfg.cast || {});
  const safeSpeaker = castKeys.includes(speaker) ? speaker : (castKeys[0] || "对方");

  const system = [
    `你是文字互动剧《入戏》的导演兼全体 NPC，正在演绎改编自知乎盐言故事的《${cfg.title}》（AI 演绎模式）。`,
    `【世界观】${cfg.world_bible}`,
    cfg.player_role ? `【玩家身份】${cfg.player_role}` : "",
    cfg.mechanics ? `【特殊机制】${cfg.mechanics}` : "",
    `【人物卡】${JSON.stringify(cfg.cast)}`,
    `【事实锚点（禁止违背）】${JSON.stringify(cfg.facts)}`,
    `【质量红线】防 OOC（按人物卡说话，口癖称呼立场统一）；旁白只做氛围；潜台词张力（不直白说尽）；台词风格与原著一致；禁止无铺垫反转。`,
    `【演出规则】`,
    `- 玩家的话会真实影响角色态度：信任/怀疑/愤怒必须在回应中体现。`,
    `- 每次回应 = 在场 1-2 个角色的反应，每人 ≤60 字，用（动作/神态）补舞台感。`,
    `- 不替玩家行动、不跳时间。没有人物卡的配角按其身份合理即兴，但不得推动关键剧情、不得透露核心秘密。`,
    `- 玩家输入若涉违规内容：以角色身份柔性化解（皱眉/拂袖/岔开），不得顺违规方向演绎。`,
    `输出 JSON：{ "replies":[{ "speaker":"角色名", "text":"…" }], "stat_delta":{ "trust":0, "danger":0, "sincerity":0 }, "new_flags":["…"], "goal_progress":{ "status":"ongoing|success|fail", "reason":"≤20字" }, "echo":"玩家本轮值得记住的原话，没有则空", "reason":"≤30字 判定依据" }。数值 delta 范围 ±15，必须有剧情依据（玩家的话值多少就是多少）。goal_progress 中 success=本幕目标已实质达成、fail=已到无法挽回的失败（只在确凿时用，平时一律 ongoing）。`,
    `【格式红线】JSON 值内禁止出现半角双引号 " ——台词中的引语一律用「」或“”包裹，否则输出会解析失败。`,
  ].filter(Boolean).join("\n");

  const user = [
    `【当前状态】turn=${cleanState.turn}/${cleanState.turn_limit} trust=${cleanState.trust} danger=${cleanState.danger} sincerity=${cleanState.sincerity} flags=${JSON.stringify(cleanState.flags)}`,
    `【本幕目标】${act.goal}${act.goal_detail ? `\n（判定细则：${act.goal_detail}）` : ""}`,
    Array.isArray(act.flags) && act.flags.length
      ? `【本幕可发放的flag】（这是目标达成的判定依据：仅当剧情确实满足条件时才发放，名字必须一字不差）${act.flags.map((f) => `${f.flag} = ${f.desc}`).join("；")}`
      : "",
    cleanState.turn >= cleanState.turn_limit - 1 ? `⚠ 这是本幕最后回合：请在回应中把局面推向可结算的状态。` : "",
    history ? `【最近剧情】\n${history}` : "",
    `【玩家本轮说】${text}`,
  ].filter(Boolean).join("\n\n");

  try {
    const raw = await callDeepSeek(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature: 0.9, maxTokens: 1400, jsonMode: true } // 话痨人设（唐僧/八戒类）容易顶满预算导致 JSON 截断，留足余量
    );
    let out;
    try { out = JSON.parse(raw); } catch {
      // 兜底：LLM 常在 JSON 值里写未转义的半角引号，先自动修复再解析
      try { out = JSON.parse(repairJsonQuotes(raw)); console.log("[director] JSON 已自动修复"); }
      catch { console.error("[director] JSON 解析失败, raw head:", raw.slice(0, 200)); out = null; }
    }
    if (!out || !Array.isArray(out.replies) || !out.replies.length) {
      console.error("[director] 输出无效, raw head:", raw.slice(0, 200));
      return json(res, 200, { replies: [{ speaker: safeSpeaker, text: "（对方沉默了片刻，似乎欲言又止……）" }], stat_delta: {}, new_flags: [], echo: "" });
    }
    out = await qualityCheck(cfg, out); // 后置质检：超字截断 + 古代篇现代词重写
    return json(res, 200, out);
  } catch (e) {
    console.error("[director] LLM 错误:", String(e.message || e).slice(0, 300));
    return json(res, 502, { error: "llm_failed", message: String(e.message || e).slice(0, 200) });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/health")
    return json(res, 200, {
      ok: true, app: "入戏", version: "P0.3-enhanced",
      llm: env.DEEPSEEK_API_KEY ? "deepseek-v4-flash" : "not-configured",
      kanshan_cli: existsSync(ZHIHU_CLI),
      ts: Date.now(),
    });

  if (url.pathname === "/api/kanshan" && req.method === "POST") {
    const ip = clientIp(req);
    if (!rateLimit(`ks:${ip}`, 60_000, 3))
      return json(res, 429, { error: "rate_limited", message: "看山有点忙，一分钟后再问（直答额度 100 次/天，省着点用）" });
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { question, story_title = "", story_author = "" } = JSON.parse(body || "{}");
        if (!question || typeof question !== "string" || question.length > 100)
          return json(res, 400, { error: "bad_question" });
        // 上下文感知：告知直答玩家正在体验哪篇小说
        let q = question;
        if (story_title) {
          const author = story_author ? `（作者：${story_author}）` : "";
          q = `玩家正在体验改编自知乎盐言故事《${story_title}》${author}的互动剧。他的问题是：${question}`;
        }
        const r = await askKanshan(q);
        return json(res, r.ok ? 200 : 502, r.ok ? { answer: r.content } : { error: "kanshan_failed", message: r.message });
      } catch { return json(res, 400, { error: "bad_json" }); }
    });
    return;
  }

  if (url.pathname === "/api/director" && req.method === "POST") {
    const ip = clientIp(req);
    if (!rateLimit(`dir:${ip}`, 10_000, 8))
      return json(res, 429, { error: "rate_limited", message: "导演喊了暂停，喘口气再说～" });
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try { return await handleDirector(res, JSON.parse(body || "{}")); }
      catch { return json(res, 400, { error: "bad_json" }); }
    });
    return;
  }

  /* AI 演绎模式配置 */
  const aiCfgMatch = url.pathname.match(/^\/api\/ai-config\/([\w-]+)$/);
  if (aiCfgMatch) {
    try {
      const data = await readFile(path.join(__dirname, "data", "ai-mode", `${aiCfgMatch[1]}.json`), "utf8");
      return send(res, 200, data);
    } catch { return json(res, 404, { error: "ai_config_not_found", message: "该篇的 AI 演绎配置未上线" }); }
  }

  if (url.pathname === "/api/stories") {
    try {
      const data = JSON.parse(await readFile(path.join(__dirname, "data", "stories.json"), "utf8"));
      // 注入每篇的结局/成就总数 + AI 演绎可用标记（自动发现：data/ai-mode/ 目录即已开放篇目；启动后缓存）
      if (!data._stats) {
        let aiIds = [];
        try {
          aiIds = (await readdir(path.join(__dirname, "data", "ai-mode")))
            .filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));
        } catch { /* 目录不存在 */ }
        data._stats = {};
        for (const s of data.stories || []) {
          try {
            const play = JSON.parse(await readFile(path.join(__dirname, "data", "plays", `${s.work_id}.json`), "utf8"));
            data._stats[s.work_id] = {
              endings: Object.values(play.nodes || {}).filter((n) => n.ending).length,
              achievements: (play.achievements || []).length,
              ai: aiIds.includes(s.work_id),
            };
          } catch { data._stats[s.work_id] = { endings: 0, achievements: 0, ai: false }; }
        }
      }
      return json(res, 200, { stories: data.stories, stats: data._stats });
    } catch { return json(res, 500, { error: "stories.json missing" }); }
  }

  /* 前端埋点上报（轻量 jsonl 追加） */
  if (url.pathname === "/api/track" && req.method === "POST") {
    const ip = clientIp(req);
    if (!rateLimit(`tk:${ip}`, 60_000, 60))
      return json(res, 429, { error: "rate_limited" });
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const ev = JSON.parse(body || "{}");
        const type = String(ev.type || "").slice(0, 30);
        if (!type) return json(res, 400, { error: "bad_type" });
        const clean = {};
        for (const k of ["story_id", "mode", "ending", "act", "turn"]) {
          if (ev[k] !== undefined) clean[k] = typeof ev[k] === "string" ? ev[k].slice(0, 60) : ev[k];
        }
        trackEvent(type, clean);
        return json(res, 200, { ok: true });
      } catch { return json(res, 400, { error: "bad_json" }); }
    });
    return;
  }

  /* 埋点汇总（比赛期自查用） */
  if (url.pathname === "/api/analytics/summary") {
    try {
      const raw = await readFile(path.join(ANALYTICS_DIR, "events.jsonl"), "utf8");
      const events = raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const byType = {};
      const endings = {};
      const directorByStory = {};
      for (const e of events) {
        byType[e.type] = (byType[e.type] || 0) + 1;
        if (e.type === "ending" && e.story_id) {
          const k = `${e.story_id}::${e.ending || "?"}`;
          endings[k] = (endings[k] || 0) + 1;
        }
        if (e.type === "director_call" && e.story_id) directorByStory[e.story_id] = (directorByStory[e.story_id] || 0) + 1;
      }
      return json(res, 200, { total: events.length, byType, endings, directorByStory });
    } catch { return json(res, 200, { total: 0, byType: {}, endings: {}, directorByStory: {} }); }
  }

  const playMatch = url.pathname.match(/^\/api\/play\/([\w-]+)$/);
  if (playMatch) {
    try {
      const data = await readFile(path.join(__dirname, "data", "plays", `${playMatch[1]}.json`), "utf8");
      return send(res, 200, data);
    } catch {
      return json(res, 404, { error: "play_not_ready", message: "该故事的剧本还在排演中（先运行 scripts/compile-story.mjs）" });
    }
  }

  if (url.pathname === "/api/say" && req.method === "POST") {
    const ip = clientIp(req);
    if (!rateLimit(`say:${ip}`, 10_000, 6))
      return json(res, 429, { error: "rate_limited", message: "说得慢一点～" });
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try { return await handleSay(res, JSON.parse(body || "{}")); }
      catch { return json(res, 400, { error: "bad_json" }); }
    });
    return;
  }

  return serveStatic(res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`\n  入戏 · 知乎故事互动剧场`);
  console.log(`  ➜  http://127.0.0.1:${PORT}/`);
  console.log(`  LLM: ${env.DEEPSEEK_API_KEY ? "deepseek-v4-flash ✓" : "未配置（自由输入将不可用）"}\n`);
});
