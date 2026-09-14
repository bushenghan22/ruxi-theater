/* fix-achievements.mjs —— 成就挂靠器
   问题：outline 阶段定义了成就，分幕生成时却没挂到任何节点，图鉴永远差几个。
   修法：让 LLM 依据成就名/描述与该篇剧情，为每个落单成就挑一个语义匹配的节点挂上。
        （只挑尚未挂过成就的可达节点，一个节点最多挂一个）

   用法: node scripts/fix-achievements.mjs [--dry-run]
*/
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "data", "plays");
const DRY = process.argv.includes("--dry-run");

const stripBOM = (s) => s.replace(/^\uFEFF/, "");
const readJson = async (p) => JSON.parse(stripBOM(await readFile(p, "utf8")));

const env = { ...process.env };
for (const line of (await readFile(path.join(ROOT, ".env"), "utf8")).split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)\s*$/);
  if (m && !env[m[1]]) env[m[1]] = m[2].trim();
}
const MODEL = env.DEEPSEEK_MODEL || "deepseek-chat";

async function llm(messages, { maxTokens = 3000, temperature = 0.3 } = {}) {
  const body = {
    model: MODEL, messages, temperature, max_tokens: maxTokens, stream: false,
    thinking: { type: "disabled" }, response_format: { type: "json_object" },
  };
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`deepseek ${r.status}`);
  return (await r.json()).choices?.[0]?.message?.content ?? "";
}

const brief = (n) => {
  const s = (n.segments || [])[0];
  if (!s) return "";
  return (s.type === "narration" ? s.text : `${s.speaker}：${s.text}`).slice(0, 40);
};

const files = (await readdir(DIR)).filter((f) => f.endsWith(".json"));
let totalFixed = 0;

for (const f of files) {
  const p = path.join(DIR, f);
  const play = await readJson(p);
  const N = play.nodes;

  const used = new Set();
  for (const n of Object.values(N)) {
    if (n.achievement) used.add(n.achievement);
    if (n.ending?.achievement) used.add(n.ending.achievement);
  }
  const dead = (play.achievements || []).filter((a) => !used.has(a.id));
  if (!dead.length) continue;

  /* 可达节点里挑还没挂成就的作为候选 */
  const seen = new Set([play.start]);
  const q = [play.start];
  while (q.length) {
    const n = N[q.shift()];
    if (!n) continue;
    const r = [];
    if (n.next) r.push(n.next);
    for (const c of n.choices || []) r.push(c.next);
    for (const x of r) if (!seen.has(x)) { seen.add(x); q.push(x); }
  }
  const cands = Object.entries(N)
    .filter(([k, n]) => seen.has(k) && !n.achievement && !n._stitch)
    .map(([k, n]) => ({ id: k, hint: brief(n) + (n.ending ? `【结局：${n.ending.name}】` : "") }));

  process.stdout.write(`《${play.title.slice(0, 10)}》${dead.length} 个落单成就… `);

  let out = null;
  for (let a = 1; a <= 3 && !out; a++) {
    try {
      out = JSON.parse(await llm([
        {
          role: "system",
          content: `你是互动剧成就系统的配置器。给定若干未挂载的成就和一篇剧本的节点清单，为每个成就挑选**剧情语义最匹配**的一个节点。

规则：
- 成就名/描述暗示的是"到达某场景""做出某选择""达成某结局"——按描述选节点
- 若描述指向某个结局，优先选标记为【结局：xxx】的节点
- 必须且只能从候选清单里选 id，不得编造
- 同一节点只能挂一个成就，已被占用的会排除在候选外
输出 JSON：{ "assign":[{"achId":"...","nodeId":"...","why":"一句话理由"}] }`,
        },
        {
          role: "user",
          content: `剧本：《${play.title}》\n一句话剧情：${play.logline || ""}

待挂载成就：
${JSON.stringify(dead.map((a) => ({ id: a.id, name: a.name, desc: a.desc, hidden: !!a.hidden })), null, 1)}

候选节点（id + 首句摘要）：
${JSON.stringify(cands.map((c) => `${c.id} :: ${c.hint}`), null, 1)}`,
        },
      ]));
    } catch { /* retry */ }
  }

  if (!out?.assign?.length) { console.log("生成失败，跳过"); continue; }

  let fixed = 0;
  const taken = new Set();
  for (const as of out.assign) {
    const node = N[as.nodeId];
    if (!node || node.achievement || taken.has(as.nodeId)) continue;
    if (!dead.some((a) => a.id === as.achId)) continue;
    if (!seen.has(as.nodeId)) continue;
    node.achievement = as.achId;
    taken.add(as.nodeId);
    fixed++;
  }
  totalFixed += fixed;
  console.log(`挂上 ${fixed} 个`);

  if (!DRY) await writeFile(p, JSON.stringify(play, null, 2), "utf8");
}

console.log(DRY ? "\n[dry-run] 未写盘" : "\n✓ 已写回 data/plays/");
console.log(`共挂载成就 ${totalFixed} 个`);
