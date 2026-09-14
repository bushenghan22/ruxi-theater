/* audit.mjs —— 《入戏》20 篇对抗性审计
   检查项：悬空引用 / 不可达节点 / 死节点 / 假选择 / 空段 / 超长文本 /
   重复选项文案 / 自环 / 成就重复挂载 / 成就孤儿 / ending 带出口 / segments 空数组
   用法: node scripts/audit.mjs
*/
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, "..", "data", "plays");
const stripBOM = (s) => s.replace(/^\uFEFF/, "");

const files = (await readdir(DIR)).filter((f) => f.endsWith(".json"));
let totalIssues = 0;
const report = [];

for (const f of files) {
  const play = JSON.parse(stripBOM(await readFile(path.join(DIR, f), "utf8")));
  const N = play.nodes;
  const issues = [];
  const push = (type, detail) => issues.push(`${type}: ${detail}`);

  /* 1. 悬空引用 */
  for (const [id, n] of Object.entries(N)) {
    if (n.next && !N[n.next]) push("悬空next", `${id} → ${n.next}`);
    for (const c of n.choices || []) if (!N[c.next]) push("悬空choice", `${id} → ${c.next}`);
  }
  /* 2. 可达性 */
  const seen = new Set([play.start]);
  const q = [play.start];
  while (q.length) {
    const n = N[q.shift()];
    if (!n) continue;
    const refs = [];
    if (n.next) refs.push(n.next);
    for (const c of n.choices || []) refs.push(c.next);
    for (const r of refs) if (!seen.has(r)) { seen.add(r); q.push(r); }
  }
  const orphans = Object.keys(N).filter((k) => !seen.has(k));
  if (orphans.length) push("不可达节点", `${orphans.length} 个: ${orphans.slice(0, 5).join(",")}`);
  /* 3. 死节点（无出边且非结局） */
  for (const [id, n] of Object.entries(N)) {
    if (!n.ending && !n.next && !(n.choices || []).length) push("死节点", id);
  }
  /* 4. 假选择（多选项同目标） */
  for (const [id, n] of Object.entries(N)) {
    const cs = n.choices || [];
    if (cs.length > 1 && new Set(cs.map((c) => c.next)).size < cs.length)
      push("假选择", `${id}（${cs.map((c) => c.next).join("=")}）`);
  }
  /* 5. 空 segments / 空文本 / 超长文本 */
  for (const [id, n] of Object.entries(N)) {
    if (!Array.isArray(n.segments) || !n.segments.length) push("空segments", id);
    for (const s of n.segments || []) {
      if (!s.text || !s.text.trim()) push("空文本", id);
      if (s.text && s.text.length > 400) push("超长文本", `${id}（${s.text.length}字）`);
    }
  }
  /* 6. 同节点重复选项文案 */
  for (const [id, n] of Object.entries(N)) {
    const texts = (n.choices || []).map((c) => c.text);
    const dup = texts.filter((t, i) => texts.indexOf(t) !== i);
    if (dup.length) push("重复选项", `${id}: ${dup[0].slice(0, 20)}`);
  }
  /* 7. 自环 */
  for (const [id, n] of Object.entries(N)) {
    if (n.next === id) push("自环", id);
    for (const c of n.choices || []) if (c.next === id) push("自环choice", id);
  }
  /* 8. 成就：重复挂载 / 挂载孤儿节点 / 未定义 id */
  const defs = new Set((play.achievements || []).map((a) => a.id));
  const mounted = new Map();
  for (const [id, n] of Object.entries(N)) {
    if (n.achievement) {
      if (mounted.has(n.achievement)) push("成就重复挂载", `${n.achievement} @ ${id} 和 ${mounted.get(n.achievement)}`);
      mounted.set(n.achievement, id);
      if (!defs.has(n.achievement)) push("成就未定义", `${id}: ${n.achievement}`);
      if (!seen.has(id)) push("成就挂在不可达节点", `${n.achievement} @ ${id}`);
    }
    if (n.ending?.achievement) {
      if (!defs.has(n.ending.achievement)) push("结局成就未定义", `${id}: ${n.ending.achievement}`);
    }
  }
  const deadAch = [...defs].filter((d) => !mounted.has(d) && ![...Object.values(N)].some((n) => n.ending?.achievement === d));
  if (deadAch.length) push("成就无法达成", deadAch.join(","));
  /* 9. ending 节点带出口 */
  for (const [id, n] of Object.entries(N)) {
    if (n.ending && (n.next || (n.choices || []).length)) push("ending带出口", id);
  }
  /* 10. start 缺失 */
  if (!N[play.start]) push("start缺失", play.start);

  totalIssues += issues.length;
  report.push({ file: f.replace(".json", "").slice(0, 12) + "…", title: (play.title || "").slice(0, 10), issues });
}

console.log("========== 对抗性审计报告 ==========");
let clean = 0;
for (const r of report) {
  if (!r.issues.length) { clean++; console.log(`✓ ${r.title.padEnd(12)} 无问题`); continue; }
  console.log(`✗ ${r.title.padEnd(12)} ${r.issues.length} 个问题`);
  r.issues.forEach((i) => console.log(`    · ${i}`));
}
console.log(`\n===== 汇总：${report.length} 篇 / 问题 ${totalIssues} 个 / 干净 ${clean} 篇 =====`);
