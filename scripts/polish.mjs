/* polish.mjs —— 文案打磨
   1) 孤儿选项文案：救援孤儿时统一用了「（走上另一条路）」，同一节点出现十几个一模一样
      的选项，玩家无法分辨。改成按各分支实际内容生成的具体行动描述。
   2) 过渡旁白变体：缝合产生的 43 处过渡旁白原本是同一句，改成 8 种轮换。

   用法: node scripts/polish.mjs [--dry-run]
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

async function llm(messages, { maxTokens = 3000, temperature = 0.7 } = {}) {
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

const segText = (n) => (n.segments || []).map((s) => (s.type === "narration" ? s.text : `${s.speaker}：${s.text}`)).join("\n");

const BRIDGE_OLD = "……到这里，似乎已经可以画上句号了。可你心里清楚，故事未必只有这一个走向。";
const BRIDGES = [
  "……到这里，似乎已经可以画上句号了。可你心里清楚，故事未必只有这一个走向。",
  "……这一段路，好像已经走到了头。但真的就要停在这儿吗？",
  "……眼前这一幕，像是个结局。可结局这种东西，从来不止一个。",
  "……你以为故事到这里就该收尾了——除非，你还想再往里看一眼。",
  "……风停了，话也说尽了。但这未必就是终点。",
  "……到这里，一切似乎尘埃落定。只是你心里还有一个声音，迟迟没有落下。",
  "……这一页翻过去，本该是全文终。可笔还握在你手里。",
  "……像是该说再见了。可你还没想好，要不要真的转身。",
];

const files = (await readdir(DIR)).filter((f) => f.endsWith(".json"));
let totalLabel = 0, totalBridge = 0;

for (const f of files) {
  const p = path.join(DIR, f);
  const play = await readJson(p);
  const N = play.nodes;

  /* ---- 1. 孤儿选项文案 ---- */
  const targets = [];
  for (const [id, n] of Object.entries(N)) {
    for (const c of n.choices || []) {
      if (c.text === "（走上另一条路）") targets.push({ host: id, next: c.next });
    }
  }

  if (targets.length) {
    process.stdout.write(`《${play.title.slice(0, 8)}》${targets.length} 个占位选项… `);
    const payload = targets.map((t) => ({
      next: t.next,
      该分支内容: segText(N[t.next] || {}).slice(0, 220),
      是结局: !!(N[t.next]?.ending),
    }));

    let out = null;
    for (let a = 1; a <= 3 && !out; a++) {
      try {
        out = JSON.parse(await llm([
          {
            role: "system",
            content: `你给互动剧的选择项写文案。每个文案 6-14 字，必须是**玩家的具体行动或说出的话**，第一人称视角，有画面感。
要求：
- 直接写行动本身，不要写"（…）"括号，不要写"选择""选项"这类元叙述
- 各条之间必须明显不同，能让玩家一眼看出走这条路会做什么
- 如果该分支是结局，用「听完XX把话说完」这类能通向结局的动作，不要直接剧透结局名
输出 JSON：{ "labels":[{"next":"…","text":"…"}] }，next 必须与输入完全一致`,
          },
          { role: "user", content: `剧本《${play.title}》\n${JSON.stringify(payload, null, 1)}` },
        ]));
      } catch { /* retry */ }
    }

    let n1 = 0;
    if (out?.labels?.length) {
      const map = new Map(out.labels.map((l) => [l.next, l.text]));
      for (const [id, n] of Object.entries(N)) {
        for (const c of n.choices || []) {
          if (c.text === "（走上另一条路）") {
            const t = map.get(c.next);
            if (t && t.length <= 20) { c.text = t; n1++; }
          }
        }
      }
    }
    totalLabel += n1;
    console.log(`改写 ${n1} 条`);
  }

  /* ---- 2. 过渡旁白变体 ---- */
  let i = 0, n2 = 0;
  for (const n of Object.values(N)) {
    for (const s of n.segments || []) {
      if (s.type === "narration" && s.text === BRIDGE_OLD) {
        s.text = BRIDGES[i % BRIDGES.length];
        i++; n2++;
      }
    }
  }
  if (n2) totalBridge += n2;

  if (!DRY) await writeFile(p, JSON.stringify(play, null, 2), "utf8");
}

console.log(DRY ? "\n[dry-run] 未写盘" : "\n✓ 已写回 data/plays/");
console.log(`选项文案改写 ${totalLabel} 条 ｜ 过渡旁白变体 ${totalBridge} 处`);
