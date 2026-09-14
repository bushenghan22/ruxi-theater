/* audit-ai-mode.mjs —— AI 演绎模式配置对抗性筛查
   检查所有 data/ai-mode/*.json 的结构性/语义性问题：
   1. 必填字段完整性（story_id/player_role/mechanics/prologue/stat_names/placeholder/…）
   2. 三幕结构完整（opening/goal/goal_detail/fail_ending/turn_limit/flags）
   3. flag 代号泄漏：玩家可见文案（goal_detail/prologue）中不得出现内部 flag id
   4. flag 唯一性（跨幕不重复、每幕 ≤1 个）
   5. 结局体系一致（act3 三结局带 cond；fail 三幕对齐；fail_ending 引用存在；名字全局唯一）
   6. cast 健康（≥2 角色、不含玩家角色名、opening 说话人可演）
   7. facts 含"禁止事项"红线；stats_init 三键齐全且 danger 初始 ≤60
   8. 文案卫生：goal_detail/prologue 混入 4 连以上英文字母（排除白名单词）

   用法: node scripts/audit-ai-mode.mjs
*/
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, "..", "data", "ai-mode");
const stripBOM = (s) => s.replace(/^\uFEFF/, "");

/* 英文白名单：出现在中文文案里属正常 */
const EN_WHITELIST = new Set(["OS", "Yes", "PUA", "AI", "AK", "bug", "BUG", "Boss"]);

const files = (await readdir(DIR)).filter((f) => f.endsWith(".json"));
let totalIssues = 0;
const report = [];

for (const f of files) {
  const cfg = JSON.parse(stripBOM(await readFile(path.join(DIR, f), "utf8")));
  const issues = [];
  const push = (type, detail) => issues.push(`${type}: ${detail}`);
  const T = cfg.title || f;

  /* 1. 必填字段 */
  const needTop = ["story_id", "title", "author", "cover", "mode", "player_role", "mechanics", "stat_names", "placeholder", "world_bible", "facts", "cast", "stats_init", "acts", "endings", "era"];
  for (const k of needTop) if (cfg[k] === undefined || cfg[k] === "" ) push("缺字段", `顶层 ${k}`);
  if (cfg.era && !["ancient", "modern"].includes(cfg.era)) push("era", `非法值 ${cfg.era}（ancient/modern）`);
  /* 教学配置合法性（可选字段，但结构必须对） */
  if (cfg.tutorial !== undefined) {
    if (!Array.isArray(cfg.tutorial) || cfg.tutorial.length < 2) push("tutorial", `段数 ${cfg.tutorial?.length}（应≥2）`);
    for (const [i, seg] of (cfg.tutorial || []).entries()) {
      if (seg.type !== "narration" && seg.type !== "say") push("tutorial", `第${i + 1}段 type=${seg.type}`);
      if (seg.type === "say" && seg.speaker !== "我" && !(cfg.cast || {})[seg.speaker]) push("tutorial", `第${i + 1}段 speaker「${seg.speaker}」不在 cast`);
      if (!seg.text) push("tutorial", `第${i + 1}段缺 text`);
    }
  }
  const pro = cfg.prologue || {};
  for (const k of ["background", "role", "tip"]) if (!pro[k]) push("缺字段", `prologue.${k}`);
  const sn = cfg.stat_names || {};
  for (const k of ["trust", "danger", "sincerity"]) if (!sn[k]) push("缺字段", `stat_names.${k}`);
  if (!cfg.placeholder) push("缺字段", "placeholder（每篇专属输入提示）");

  /* 2. 三幕结构 */
  if (!Array.isArray(cfg.acts) || cfg.acts.length !== 3) push("幕结构", `acts 应为 3 幕，实际 ${cfg.acts?.length}`);
  const flagIds = [];
  (cfg.acts || []).forEach((a, i) => {
    const no = i + 1;
    if (a.act !== no) push("幕结构", `第${no}幕 act 字段=${a.act}`);
    if (!a.name) push("缺字段", `第${no}幕 name`);
    if (!Array.isArray(a.opening) || a.opening.length < 2) push("幕结构", `第${no}幕 opening 段数 ${a.opening?.length}（应≥2）`);
    (a.opening || []).forEach((s, j) => {
      if (s.type !== "narration" && s.type !== "say") push("opening", `第${no}幕第${j + 1}段 type=${s.type}`);
      if (s.type === "say" && !s.speaker) push("opening", `第${no}幕第${j + 1}段 say 缺 speaker`);
      if (s.type === "say" && s.speaker !== "我" && !(cfg.cast || {})[s.speaker]) push("casting", `第${no}幕第${j + 1}段 speaker「${s.speaker}」不在 cast`);
    });
    if (!a.goal) push("缺字段", `第${no}幕 goal`);
    if (!a.goal_detail) push("缺字段", `第${no}幕 goal_detail`);
    if (!a.fail_ending?.name || !a.fail_ending?.quote) push("缺字段", `第${no}幕 fail_ending`);
    if (!Number.isInteger(a.turn_limit) || a.turn_limit < 8 || a.turn_limit > 16) push("turn_limit", `第${no}幕 ${a.turn_limit}（应 8-16）`);
    if (!a.success_hint) push("缺字段", `第${no}幕 success_hint`);
    const fl = a.flags || [];
    if (fl.length > 1) push("flag", `第${no}幕挂了 ${fl.length} 个 flag（应≤1）`);
    for (const x of fl) {
      if (!x.flag || !x.desc) push("flag", `第${no}幕 flag 缺 flag/desc`);
      flagIds.push(x.flag);
    }
    if (no < 3 && !fl.length) push("flag", `第${no}幕无 flag（幕1/2 应有判定锚点）`);
  });
  /* 4. flag 唯一性 */
  const dup = flagIds.filter((x, i) => flagIds.indexOf(x) !== i);
  if (dup.length) push("flag", `跨幕重复: ${[...new Set(dup)].join(",")}`);

  /* 3. flag 代号泄漏到玩家可见文案 */
  const visible = [
    ...cfg.acts.map((a) => a.goal_detail || ""),
    pro.background || "", pro.role || "", pro.tip || "",
  ].join("\n");
  for (const id of flagIds) if (id && visible.includes(id)) push("flag泄漏", `玩家文案含内部代号「${id}」`);
  if (visible.includes("（触发")) push("flag泄漏", "玩家文案含「（触发 …）」字样");

  /* 5. 结局体系 */
  const E = cfg.endings || {};
  if (!Array.isArray(E.act3) || E.act3.length !== 3) push("结局", `act3 应 3 个，实际 ${E.act3?.length}`);
  for (const e of E.act3 || []) {
    if (!e.name || !e.quote) push("结局", `act3 结局缺 name/quote`);
    if (!e.cond) push("结局", `act3「${e.name}」缺 cond（数值判据）`);
  }
  if (!Array.isArray(E.fail) || E.fail.length !== 3) push("结局", `fail 应 3 个，实际 ${E.fail?.length}`);
  const failByAct = new Map((E.fail || []).map((e) => [e.act, e]));
  for (const no of [1, 2, 3]) if (!failByAct.has(no)) push("结局", `fail 缺第 ${no} 幕坏结局`);
  const act3 = cfg.acts[2] || {};
  for (const no of [1, 2, 3]) {
    const fe = (cfg.acts[no - 1] || {}).fail_ending?.name;
    const ef = failByAct.get(no)?.name;
    if (fe && ef && fe !== ef) push("结局", `第${no}幕 fail_ending「${fe}」与 endings.fail「${ef}」不一致`);
  }
  const allEndNames = [...(E.act3 || []).map((e) => e.name), ...(E.fail || []).map((e) => e.name)];
  const dupEnd = allEndNames.filter((x, i) => allEndNames.indexOf(x) !== i);
  if (dupEnd.length) push("结局", `结局名重复: ${[...new Set(dupEnd)].join(",")}`);

  /* 6. cast */
  const castKeys = Object.keys(cfg.cast || {});
  if (castKeys.length < 2) push("cast", `角色数 ${castKeys.length}（应≥2）`);
  const playerSelf = (cfg.player_role || "").match(/^玩家就是(.+?)本人/);
  if (playerSelf) {
    const self = playerSelf[1].replace(/^(朱玉润|王红梅|杜曼笙|周鉴|宋柠柠).*$/, "$1");
    if (castKeys.some((k) => self.startsWith(k))) push("cast", `玩家角色「${self}」不应出现在 cast（会被导演当成 NPC）`);
  }

  /* 7. facts / stats_init */
  if (!Array.isArray(cfg.facts) || cfg.facts.length < 4) push("facts", `条数 ${cfg.facts?.length}（应≥4）`);
  if (!cfg.facts?.some((x) => x.includes("禁止"))) push("facts", "缺『禁止事项』红线条目（防剧透/OOC）");
  const si = cfg.stats_init || {};
  for (const k of ["trust", "danger", "sincerity"]) {
    const v = si[k];
    if (typeof v !== "number" || v < 0 || v > 100) push("stats_init", `${k}=${v}（应 0-100）`);
  }
  if (si.danger > 60) push("stats_init", `danger 初始 ${si.danger}（>60 开局压迫感过强）`);

  /* 8. 文案卫生：4 连以上英文字母（白名单外） */
  const textBlob = visible + (cfg.player_role || "") + (cfg.mechanics || "") + castKeys.join("");
  const badEn = [...new Set(textBlob.match(/[A-Za-z]{4,}/g) || [])].filter((w) => !EN_WHITELIST.has(w));
  if (badEn.length) push("文案卫生", `混入英文: ${badEn.join(",")}`);

  totalIssues += issues.length;
  report.push({ file: f, title: T.slice(0, 12), issues });
}

/* 汇总 */
for (const r of report) {
  if (r.issues.length) {
    console.log(`✗ ${r.title}（${r.file}）—— ${r.issues.length} 个问题`);
    for (const i of r.issues) console.log(`    - ${i}`);
  } else {
    console.log(`✓ ${r.title}（${r.file}）—— 0 问题`);
  }
}
console.log(`\n筛查完成：${report.length} 份配置，共 ${totalIssues} 个问题`);
process.exit(totalIssues ? 1 : 0);
