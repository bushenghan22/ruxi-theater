/* expand-choices.mjs —— 假选择展开器
   问题：部分节点写了多个选项，但所有选项都指向同一个 next（选择幻觉）。
   修法：为「非首选」的每个选项补 1-2 个真实的新节点，走完这段独有的剧情后
        再汇回原目标节点——既让选择真的有后果，又不破坏后续已有的剧情结构。

   用法: node scripts/expand-choices.mjs [--dry-run]
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
if (!env.DEEPSEEK_API_KEY) { console.error("缺少 DEEPSEEK_API_KEY"); process.exit(1); }
const MODEL = env.DEEPSEEK_MODEL || "deepseek-chat";

async function llm(messages, { maxTokens = 6000, temperature = 0.85 } = {}) {
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

const STYLE = `你深谙知乎盐言故事的方法论：钩子前置、500 字一个转折、第一人称"我"、台词极简有张力、用（动作/神态）补舞台感、不写大段内心独白。`;
const QUALITY = `质量红线（违反即不合格）：
1. 人物一致性：严格按人物卡说话，口癖、称呼、立场前后统一。
2. 语域一致：古代题材严禁现代词汇；现代题材符合人物身份。
3. 旁白纪律：narration 只做场景转换与氛围，不超过本节点 segments 的 1/3。
4. 潜台词张力：不直白说尽，用停顿、回避、反问制造张力；禁止说教。
5. 风格校准：句式长短、称谓习惯、情绪节奏与原著一致。
6. 反转纪律：伏笔要提前埋，禁止无铺垫的"突然精神分裂/一切是梦"。`;

const segText = (n) => (n.segments || []).map((s) => (s.type === "narration" ? s.text : `${s.speaker}：${s.text}`)).join("\n");

/* ---------- 主流程 ---------- */
const files = (await readdir(DIR)).filter((f) => f.endsWith(".json"));
let totalFixed = 0, totalNodes = 0;

for (const f of files) {
  const p = path.join(DIR, f);
  const play = await readJson(p);
  const N = play.nodes;

  /* 找出假选择：多选项却指向同一目标 */
  const fakes = [];
  for (const [id, n] of Object.entries(N)) {
    const cs = n.choices || [];
    if (cs.length > 1 && new Set(cs.map((c) => c.next)).size === 1) {
      fakes.push({ id, target: cs[0].next, alts: cs.slice(1) });
    }
  }
  if (!fakes.length) continue;

  const payload = fakes.map((fk) => ({
    nodeId: fk.id,
    当前剧情: segText(N[fk.id]),
    其他选项: fk.alts.map((a) => a.text),
    汇回目标: fk.target,
    汇回目标的开头: segText(N[fk.target] || {}).slice(0, 120),
  }));

  process.stdout.write(`《${play.title.slice(0, 10)}》${fakes.length} 处假选择… `);

  let out = null;
  for (let attempt = 1; attempt <= 3 && !out; attempt++) {
    try {
      out = JSON.parse(await llm([
        {
          role: "system",
          content: `${STYLE}\n\n你负责把互动剧里的"假选择"改造成真选择。\n\n${QUALITY}\n\n输出 JSON：{ "branches": [ { "nodeId": "...", "choiceText": "要改造的那个选项原文，必须与输入完全一致", "segments": [ {"type":"narration","text":"..."} 或 {"type":"say","speaker":"角色名或我","text":"..."} ] } ] }`,
        },
        {
          role: "user",
          content: `《${play.title}》人物卡：${JSON.stringify(play.cast || {})}

以下是若干"假选择"节点：玩家选了不同选项，却都跳到同一个后续节点，选择没有意义。

${JSON.stringify(payload, null, 2)}

请为每一项的「其他选项」逐个补写一段**该选项独有的剧情**（2-4 条 segments，台词每条 ≤60 字）。

硬性要求：
- 这段剧情必须是选了这个选项才会发生的独特内容，要能体现该选项的行动/态度带来的**不同后果**（哪怕只是别人的反应、一句不同的对白、一个不同的细节），绝不能换个说法讲同一件事。
- 剧情要顺着原本的走向发展，写完这段之后自然过渡到「汇回目标」的开头，不要自创新的结局或推翻已有设定。
- 不要修改「其他选项」的文案，只补它后面的内容；也不要改动第一个选项。
- 每条 branch 的 choiceText 必须与输入的「其他选项」文案完全一致。`,
        },
      ]));
    } catch (e) { /* retry */ }
  }

  if (!out?.branches?.length) { console.log("生成失败，跳过"); continue; }

  let fixed = 0, added = 0;
  for (const br of out.branches) {
    const host = N[br.nodeId];
    if (!host?.choices) continue;
    const opt = host.choices.find((c) => c.text === br.choiceText);
    if (!opt || !Array.isArray(br.segments) || !br.segments.length) continue;

    const original = opt.next;
    const newId = uniqueId(`${br.nodeId}_x${fixed + 1}`, new Set(Object.keys(N)));
    N[newId] = { _stitch: true, segments: br.segments, next: original };
    opt.next = newId;
    fixed++; added++;
  }
  totalFixed += fixed; totalNodes += added;
  console.log(`补 ${fixed} 条分支 / 新增 ${added} 节点`);

  play._meta = { ...(play._meta || {}), expanded_at: new Date().toISOString() };
  if (!DRY) await writeFile(p, JSON.stringify(play, null, 2), "utf8");
}

function uniqueId(base, taken) {
  let id = base, i = 2;
  while (taken.has(id)) id = `${base}_${i++}`;
  return id;
}

console.log(DRY ? "\n[dry-run] 未写盘" : "\n✓ 已写回 data/plays/");
console.log(`共改造假选择 ${totalFixed} 处，新增节点 ${totalNodes} 个`);
