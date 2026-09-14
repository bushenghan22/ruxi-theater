/* 诊断 DeepSeek 输出：看 finish_reason 与内容长度 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const env = { ...process.env };
try {
  const dot = await readFile(path.join(ROOT, ".env"), "utf8");
  for (const line of dot.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2].trim();
  }
} catch {}

const r = await fetch("https://api.deepseek.com/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
  body: JSON.stringify({
    model: env.DEEPSEEK_MODEL || "deepseek-v4-flash",
    messages: [
      { role: "system", content: "输出合法 JSON。" },
      { role: "user", content: '生成一个 JSON：{"cast":{"崇祯":"人物卡50字"},"choice_plan":[{"id":"a1_n3","where":"位置","question":"抉择"} x 16 项],"endings":[{"name":"结局","quote":"金句","type":"original"} x 4 项]}，内容按穿越大明故事发挥。' },
    ],
    temperature: 1.0,
    max_tokens: 8000,
    stream: false,
    thinking: { type: "disabled" },
    response_format: { type: "json_object" },
  }),
});
console.log("HTTP", r.status);
const data = await r.json();
console.log("finish_reason:", data.choices?.[0]?.finish_reason);
console.log("usage:", JSON.stringify(data.usage));
console.log("content length:", data.choices?.[0]?.message?.content?.length);
console.log("content head:", data.choices?.[0]?.message?.content?.slice(0, 200));
