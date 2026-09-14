/* compile-story.mjs —— 《入戏》剧本化引擎
   把官方 3000 字故事原文改编为大节点量互动剧剧本（≥15 个选择点、3-4 个结局）。
   策略：DeepSeek 分 4 次生成（大纲 + 三幕），规避单次输出截断；本地合并 + 引用完整性校验。
   官方授权边界：前 3000 字为原著锚定；3000 字外由 AI 续写（知乎黑客松官方已确认许可）。

   用法:
     node scripts/compile-story.mjs 1654134122145320960   # 编译单篇
     node scripts/compile-story.mjs --all                 # 编译全部 P0 四篇
*/
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

/* ---------- .env ---------- */
const env = { ...process.env };
try {
  const dot = await readFile(path.join(ROOT, ".env"), "utf8");
  for (const line of dot.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2].trim();
  }
} catch { /* optional */ }

if (!env.DEEPSEEK_API_KEY) { console.error("✗ .env 缺少 DEEPSEEK_API_KEY"); process.exit(1); }

const MODEL = env.DEEPSEEK_MODEL || "deepseek-v4-flash";

/* PowerShell 写出的 UTF-8 文件带 BOM，JSON.parse 会炸 */
const stripBOM = (s) => s.replace(/^\uFEFF/, "");
const readJson = async (p) => JSON.parse(stripBOM(await readFile(p, "utf8")));
const P0_IDS = [
  "1654134122145320960", // 穿越大明（权谋，唯一全文）
  "2025684191967294692", // 蓝血（悬疑反转）
  "2025333783608537435", // 同时被两个精神病追杀（惊悚）
  "1981680284933063553", // 网恋对象真是霸总（甜宠）
];

/* ---------- DeepSeek ---------- */
async function llm(messages, { maxTokens = 4096, jsonMode = true, temperature = 0.85 } = {}) {
  const body = {
    model: MODEL, messages, temperature, max_tokens: maxTokens, stream: false,
    thinking: { type: "disabled" },  // v4-flash 默认思考会吞 max_tokens，创意任务关闭
  };
  if (jsonMode) body.response_format = { type: "json_object" };
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`deepseek ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content ?? "";
}

async function llmJson(messages, opts) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const raw = await llm(messages, opts);
      return JSON.parse(raw);
    } catch (e) {
      console.warn(`  ⚠ JSON 解析失败（第 ${attempt} 次）：${String(e.message).slice(0, 120)}`);
      if (attempt === 3) throw e;
      messages = [...messages, { role: "user", content: "上面的输出不是合法 JSON 或结构不对。请重新输出完整、合法、可直接 JSON.parse 的 JSON，不要任何多余文本。" }];
    }
  }
}

/* ---------- Prompts ---------- */
const STYLE = `你深谙知乎盐言故事的方法论：
- 钩子前置：导语与第一句 3 秒定生死（极端人设 + 极端处境 + 悬念钩子）
- 节奏：500 字一个转折，每 1000 字含 1 个新信息 + 1 个情绪爆点 + 1 个钩子
- 第一人称"我"，信息受限产生天然悬念
- 三大反转类型：身份反转 / 时间反转 / 视角反转；前 30% 撒烟雾弹，最后 20% 掀桌
- 情绪曲线：压抑 → 微光 → 更压抑 → 爆发爽点 → 温柔刀 → 终极反转
- 台词极简有张力，用（动作/神态）补舞台感，不写大段内心独白`;

const NODE_SPEC = `节点 JSON 格式（严格遵守）：
{
  "节点id": {
    "segments": [
      { "type": "narration", "text": "旁白/场景描写，1-2 句" },
      { "type": "say", "speaker": "角色名或我", "text": "台词，≤60 字，口语化" }
    ],
    "next": "下一节点id",                    // 无选择点时必填
    "choices": [                              // 选择点（与 next 二选一）
      { "text": "选项文案（第一人称，≤30字）", "next": "目标节点id", "hint": "结果飘字提示，≤14字", "tone": "good|bad" }
    ],
    "achievement": "成就id",                  // 本节点触发该成就（仅分配到的节点标注）
    "free": true,                             // 仅少数关键节点标注（全剧 4-5 个）
    "ending": { "name": "结局名(4-6字)", "quote": "结局金句(≤40字)", "achievement": "结局成就id(可选)" }
  }
}
硬性规则：
- 每个节点 segments 为 2-5 条；台词每条 ≤60 字
- 所有 choices.next / next 引用的节点 id 必须存在于本次输出的 nodes 中（或使用指定的跨幕衔接 id）
- 选择点的选项文案必须是"玩家的行动或话语"，不是旁述
- 结局节点的 segments 播完后触发 ending；结局节点不要再有 choices/next`;

const QUALITY = `质量红线（违反任何一条即为不合格输出）：
1. 人物一致性（防 OOC）：每个角色严格按人物卡说话，口癖、称呼、立场前后统一；角色绝不会说出违背其立场的话。
2. 语域一致（防出戏）：历史/古代题材严禁出现现代词汇（如"心理阴影""社死""系统 bug"）；现代题材符合人物学历与身份的用语水平。
3. 旁白纪律：narration 只做场景转换与必要氛围，不超过本节点 segments 的 1/3；叙事主要靠对话与（动作）推进。
4. 台词必须有"潜台词张力"：人物不会直白说出全部想法，用停顿、回避、反问制造张力；禁止说教式台词。
5. 风格校准：续写部分模仿原文的句式长短、称谓习惯、情绪节奏——读者应该感觉"这就是同一个作者写的"。
6. 反转纪律：伏笔必须提前埋（前期烟雾弹），结局揭示时读者能回溯找到线索；禁止无铺垫的"突然精神分裂/一切是梦"。`;

/* ---------- 编译单篇 ---------- */
async function compile(workId) {
  console.log(`\n ========== 编译 ${workId} ==========`);
  const raw = await readJson(path.join(ROOT, "data", "stories", `${workId}.json`));
  const list = await readJson(path.join(ROOT, "data", "stories.json"));
  const meta = list.stories.find((s) => s.work_id === workId);
  const content = raw.content;

  console.log(`  《${raw.chapter_name}》原文 ${content.length} 字 · 标签 ${raw.labels.join("/")}`);

  /* 1. 大纲 */
  console.log("  [1/6] 生成剧本大纲…");
  const outline = await llmJson([
    { role: "system", content: `${STYLE}\n\n你是互动叙事剧本架构师。基于知乎盐言故事原文，把一篇 3000 字短篇改编为大型文字互动剧。官方授权规则：原文前 3000 字须忠实改编（为树干主线）；3000 字之后的剧情由你续写补充（已获官方许可），人物性格必须与原文一致。\n\n${QUALITY}` },
    { role: "user", content: `《${raw.chapter_name}》作者：${raw.author_name}；标签：${raw.labels.join("/")}
导语：${raw.introduction}
原文全文：
${content}

请设计五幕互动剧大纲，要求：
- 总选择点 ≥ 20 个：第一幕 4-5 个（忠实改编原文前半），第二幕 4-5 个（原文后半），第三幕 4-5 个（延展发展），第四幕 4-5 个（高潮铺垫），第五幕 4-5 个（终极反转与收束）
- 结局 6-8 个：原著向结局 1 个 + 偏航结局 2-3 个 + 好坏对情侣配 + 隐藏结局 1 个；各结局从第四/五幕的选择分岔抵达
- 成就 8-10 个：分配到具体幕（act 字段），类型包括"到达关键节点""触发特殊选择""达成特定结局"；其中 1-2 个为隐藏成就
- 给出人物卡 cast（每个有台词的角色：性格、口癖、说话风格，各 ≤50 字）
- 给出开局前置介绍 prologue：background（背景故事，120-160 字，让没读过原文的玩家快速入戏）、role（你将扮演谁，80-120 字，第一人称视角说明）、tip（一句玩法提示）
- 五幕衔接节点 id 固定为：a1_n1 / a2_n1 / a3_n1 / a4_n1 / a5_n1
输出 JSON：
{
  "cast": { "角色名": "人物卡" },
  "logline": "一句话剧情",
  "prologue": { "background": "...", "role": "...", "tip": "..." },
  "acts": [ { "act": 1, "summary": "本幕剧情摘要(≤80字)", "choices": 5 }, ... 共5幕 ],
  "choice_plan": [ { "id": "a1_n?", "where": "出现位置说明", "question": "玩家面对的抉择" }, ... 共20-24个 ],
  "achievements": [ { "id": "ach_xxx", "name": "成就名(4-8字)", "desc": "达成条件说明", "act": 3, "hidden": false }, ... 共8-10个 ],
  "endings": [ { "name": "结局名", "quote": "金句", "type": "original|branch|hidden" } ]
}` }],
    { maxTokens: 8000, temperature: 1.0 });

  const plan = outline.choice_plan || [];
  const endings = outline.endings || [];
  console.log(`  ✓ 大纲：${plan.length} 个选择点规划，${endings.length} 个结局，cast ${Object.keys(outline.cast || {}).length} 人`);
  if (plan.length < 15) console.warn(`  ⚠ 选择点 ${plan.length} < 15，将在幕生成时补充`);

  /* 2-6. 五幕 */
  const actBriefs = {
    1: "第一幕：忠实改编原文前半部分。原文情节是唯一事实，人物言行不得违背原文；把原文叙事改写为对话流，玩家以第一人称'我'经历。选择点在此幕埋设烟雾弹（读者以为走向 A，实际埋真线索）。",
    2: "第二幕：改编原文后半部分并开始延展。可引入原文中的烟雾弹与真线索对抗，情绪曲线进入'更压抑 → 爆发爽点'。",
    3: "第三幕：原文耗尽处的 AI 续写（官方已许可）。严格按人物卡与已发生事实延展，出现第一个小高潮，并埋下通往大反转的关键伏笔。",
    4: "第四幕：高潮铺垫。所有伏笔开始收紧，误会与信息差推向顶点，玩家明显感到'真相就在眼前'但还差一块拼图。",
    5: "第五幕：终极反转与收束。掀开全部底牌（呼应前期伏笔），按玩家此前的选择分岔，通向各个不同结局。",
  };

  const nodesAll = {};
  for (let no = 1; no <= 5; no++) {
    console.log(`  [${no + 1}/6] 生成第 ${no} 幕节点…`);
    const actPlan = plan.filter((_, i) => i >= (no - 1) * 4 && i < no * 4 + (no === 5 ? plan.length - 20 : 1));
    const actAch = (outline.achievements || []).filter((a) => a.act === no);
    const isLast = no === 5;
    const hasEndings = no >= 4;
    const data = await llmJson([
      { role: "system", content: `${STYLE}\n\n你是互动剧本编剧，负责编写其中一幕的节点。${NODE_SPEC}\n\n${QUALITY}` },
      { role: "user", content: `《${raw.chapter_name}》人物卡：${JSON.stringify(outline.cast)}
全剧大纲：${JSON.stringify({ acts: outline.acts, endings })}
已解锁伏笔清单（本幕必须呼应或收紧）：${JSON.stringify((outline.acts || []).slice(0, no))}

原文全文（第一、二幕改编素材，之后各幕为人物与事实参考）：
${content}

本次任务：编写第 ${no} 幕。${actBriefs[no]}
本幕计划的选择点：${JSON.stringify(actPlan)}
${actAch.length ? `本幕需要触发的成就（在合适节点加 "achievement": "id" 字段，一个节点最多一个）：${JSON.stringify(actAch)}` : "本幕无成就触发。"}
入口节点 id 固定为 "a${no}_n1"。
${hasEndings ? (isLast ? `结局收束：本幕（或与第四幕衔接处）必须包含全部 ${endings.length} 个结局节点（id 建议 a${no}_end_1..N），每个结局由具体选择抵达，结局金句要"掀桌"有余韵。` : `本幕可以开启 1-2 个结局分支（部分结局可在此提前抵达）。`) : ""}
数量要求：本幕 14-22 个节点，其中选择点节点 4-5 个${isLast ? "，并包含全部结局节点" : ""}。
${no < 5 ? `出口纪律（违反即为不合格输出）：本幕禁止出现任何 "ending" 字段（结局只在第五幕收束）；本幕的收尾节点必须写 "next": "a${no + 1}_n1"，把主线交还给下一幕。上一幕会有人指向 "a${no}_n1"，你只需保证自己这一幕能走出去。` : ""}
输出 JSON：{ "nodes": { ... } }` }],
      { maxTokens: 12000, temperature: 0.8 });

      const nodes = data.nodes || {};
      let n = 0;
      for (const [id, node] of Object.entries(nodes)) {
        if (nodesAll[id]) console.warn(`  ⚠ 节点 id 冲突，跳过：${id}`);
        else { nodesAll[id] = node; n++; }
      }
      console.log(`  ✓ 第 ${no} 幕：${n} 个节点`);
    }

  /* 3. 合并与校验 */
  const play = {
    story_id: workId,
    title: raw.chapter_name,
    author: raw.author_name,
    cover: meta?.cover || `/assets/covers/${workId}.jpg`,
    cast: outline.cast || {},
    logline: outline.logline || "",
    prologue: outline.prologue || null,
    achievements: (outline.achievements || []).map((a) => ({ id: a.id, name: a.name, desc: a.desc, hidden: !!a.hidden })),
    start: "a1_n1",
    nodes: nodesAll,
    _meta: { compiled_at: new Date().toISOString(), model: MODEL },
  };

  const broken = [];
  for (const [id, node] of Object.entries(nodesAll)) {
    const refs = [];
    if (node.next) refs.push(node.next);
    for (const c of node.choices || []) refs.push(c.next);
    for (const r of refs) if (!nodesAll[r]) broken.push(`${id} → ${r}`);
  }
  if (broken.length) {
    console.warn(`  ⚠ ${broken.length} 处悬空引用：${broken.slice(0, 8).join("；")}`);
    const fallback = Object.keys(nodesAll).find((k) => nodesAll[k].ending) || "a3_n1";
    for (const [id, node] of Object.entries(nodesAll)) {
      if (node.next && !nodesAll[node.next]) node.next = fallback;
      for (const c of node.choices || []) if (!nodesAll[c.next]) c.next = fallback;
    }
    console.warn(`  → 已把悬空引用重定向到 ${fallback}`);
  }

  const nChoices = Object.values(nodesAll).filter((n) => n.choices?.length).length;
  const nEndings = Object.values(nodesAll).filter((n) => n.ending).length;
  console.log(`  ★ 编译完成：节点 ${Object.keys(nodesAll).length} ｜ 选择点 ${nChoices} ｜ 结局 ${nEndings} ｜ 成就 ${(play.achievements || []).length}`);

  if (nChoices < 18) console.warn(`  ⚠⚠ 选择点 ${nChoices} 少于 18 —— 可考虑重跑或人工补节点`);

  /* 可达性门禁：悬空引用合法 ≠ 图连通。分块生成最典型的失效是"每块都自洽、整张图断成孤岛" */
  const seen = new Set([play.start]);
  const queue = [play.start];
  while (queue.length) {
    const cur = nodesAll[queue.shift()];
    if (!cur) continue;
    const refs = [];
    if (cur.next) refs.push(cur.next);
    for (const c of cur.choices || []) refs.push(c.next);
    for (const r of refs) if (!seen.has(r)) { seen.add(r); queue.push(r); }
  }
  const allEnds = Object.keys(nodesAll).filter((k) => nodesAll[k].ending);
  const endLost = allEnds.filter((k) => !seen.has(k));
  const rate = seen.size / Object.keys(nodesAll).length;
  const actsOk = [1, 2, 3, 4, 5].filter((n) => seen.has(`a${n}_n1`)).length;
  console.log(`  ◆ 可达性：节点 ${seen.size}/${Object.keys(nodesAll).length} (${(rate * 100).toFixed(1)}%) ｜ 可达结局 ${allEnds.length - endLost.length}/${allEnds.length} ｜ 五幕入口可达 ${actsOk}/5`);
  if (rate < 0.95 || endLost.length || actsOk < 5) {
    console.warn(`  ⚠⚠ 可达性门禁未通过 —— 建议重跑本剧；若仍失败，可先执行 node scripts/stitch-plays.mjs 做离线缝合`);
    if (endLost.length) console.warn(`     走不到的结局：${endLost.slice(0, 5).join(", ")}`);
    play._meta = { ...(play._meta || {}), gate: "FAILED", gate_rate: +rate.toFixed(3) };
  } else {
    play._meta = { ...(play._meta || {}), gate: "PASSED", gate_rate: +rate.toFixed(3) };
  }

  await writeFile(path.join(ROOT, "data", "plays", `${workId}.json`), JSON.stringify(play, null, 2), "utf8");
  console.log(`  → data/plays/${workId}.json`);
  return { nodes: Object.keys(nodesAll).length, choices: nChoices, endings: nEndings };
}

/* ---------- CLI ---------- */
const arg = process.argv[2];
const ids = arg === "--all" ? P0_IDS : arg ? [arg] : P0_IDS;
const results = {};
for (const id of ids) {
  try { results[id] = await compile(id); }
  catch (e) { console.error(`✗ ${id} 编译失败：${e.message}`); }
}
console.log("\n===== 汇总 =====");
for (const [id, r] of Object.entries(results)) console.log(`${id}: 节点 ${r.nodes} · 选择点 ${r.choices} · 结局 ${r.endings}`);
