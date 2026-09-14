/* probe-director.mjs —— 复现导演调用的真实错误 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
for (const l of (await readFile(path.join(ROOT, ".env"), "utf8")).split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)\s*$/);
  if (m && !env[m[1]]) env[m[1]] = m[2].trim();
}
const body = {
  model: env.DEEPSEEK_MODEL || "deepseek-v4-flash",
  messages: [
    { role: "system", content: '你是导演。输出 JSON：{"replies":[{"speaker":"崇祯","text":"…"}],"stat_delta":{"trust":0},"new_flags":[],"echo":""}' },
    { role: "user", content: "玩家说：姐夫，我在梦里看见了你上吊的样子。煤山的树已经选好了。" },
  ],
  temperature: 0.9, max_tokens: 900, stream: false,
  thinking: { type: "disabled" }, response_format: { type: "json_object" },
};
try {
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  console.log("HTTP", r.status);
  const d = await r.json();
  console.log("finish:", d.choices?.[0]?.finish_reason);
  console.log("content:", d.choices?.[0]?.message?.content?.slice(0, 300));
  console.log("usage:", JSON.stringify(d.usage));
} catch (e) {
  console.log("FETCH ERR:", e.name, e.message);
}
