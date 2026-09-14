/* fix-audit.mjs —— 对抗性审计问题专项修复
   1. 成就重复挂载：每个成就 id 只保留第一个挂载节点，其余删除
   2. 结局成就未定义：删除不在 achievements 定义表里的 ending.achievement 引用
   3. 同目标重复选项：去重（保留第一个）
   用法: node scripts/fix-audit.mjs [--dry-run]
*/
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, "..", "data", "plays");
const DRY = process.argv.includes("--dry-run");
const stripBOM = (s) => s.replace(/^\uFEFF/, "");

const files = (await readdir(DIR)).filter((f) => f.endsWith(".json"));
const totals = { achDup: 0, undefRef: 0, dupChoice: 0 };

for (const f of files) {
  const p = path.join(DIR, f);
  const play = JSON.parse(stripBOM(await readFile(p, "utf8")));
  const N = play.nodes;
  const defs = new Set((play.achievements || []).map((a) => a.id));
  const log = [];

  /* 1. 成就重复挂载：保留第一个 */
  const seenAch = new Set();
  for (const [id, n] of Object.entries(N)) {
    if (n.achievement) {
      if (seenAch.has(n.achievement)) {
        delete n.achievement;
        totals.achDup++;
        log.push(`成就去重: ${id} 移除重复 ${n.achievement || ""}`.trim());
      } else seenAch.add(n.achievement);
    }
    if (n.ending?.achievement) {
      if (seenAch.has(n.ending.achievement)) {
        delete n.ending.achievement;
        totals.achDup++;
        log.push(`结局成就去重: ${id}`);
      } else seenAch.add(n.ending.achievement);
    }
  }

  /* 2. 未定义的 ending.achievement 删除 */
  for (const [id, n] of Object.entries(N)) {
    if (n.ending?.achievement && !defs.has(n.ending.achievement)) {
      delete n.ending.achievement;
      totals.undefRef++;
      log.push(`删未定义结局成就: ${id}`);
    }
  }

  /* 3. 同目标重复选项去重 */
  for (const [id, n] of Object.entries(N)) {
    const cs = n.choices || [];
    if (cs.length < 2) continue;
    const seen = new Set();
    const keep = [];
    let deduped = false;
    for (const c of cs) {
      if (seen.has(c.next)) { deduped = true; totals.dupChoice++; continue; }
      seen.add(c.next);
      keep.push(c);
    }
    if (deduped) {
      if (keep.length === 1) {
        // 只剩一个选项：转为线性节点（单选项无意义）
        n.next = keep[0].next;
        delete n.choices;
        log.push(`假选择去重: ${id} 单选项转线性 → ${n.next}`);
      } else {
        n.choices = keep;
        log.push(`假选择去重: ${id} ${cs.length}→${keep.length}`);
      }
    }
  }

  if (log.length) {
    console.log(`《${(play.title || f).slice(0, 10)}》修复 ${log.length} 处:`);
    log.forEach((l) => console.log(`   · ${l}`));
    if (!DRY) await writeFile(p, JSON.stringify(play, null, 2), "utf8");
  }
}

console.log(DRY ? "\n[dry-run] 未写盘" : "\n✓ 已写回");
console.log(`成就去重 ${totals.achDup} ｜ 删未定义引用 ${totals.undefRef} ｜ 选项去重 ${totals.dupChoice}`);
