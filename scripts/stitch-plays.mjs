/* stitch-plays.mjs —— 《入戏》叙事图缝合器
   修复两类断链：
   A. 幕末回指：某幕最下游节点把出口指回更早的幕（如 a2_n22 → a1_n5_end），
      该幕因此成为封闭死循环。语义上幕末必须通向下一幕，直接改指。
   B. 终止节点：非末幕里没有出边的节点（多为 LLM 给该幕写的 ending），
      改造为二选一选择点，原结局原封不动搬到新节点。
   效果：主线贯通 + 零内容丢失 + 把「被迫结束」变成玩家主动选择，反而增加 agency。

   用法:
     node scripts/stitch-plays.mjs --dry-run   # 只报告，不写盘
     node scripts/stitch-plays.mjs             # 执行修复
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

const BRIDGE = "……到这里，似乎已经可以画上句号了。可你心里清楚，故事未必只有这一个走向。";
const BRIDGE_PASS = "前路分成了两条：一条顺着眼前的事继续走下去，另一条，通向更深的漩涡。";
const OPT_GO = { text: "（继续走下去）", hint: "故事还没结束", tone: "good" };
const OPT_STOP = { text: "（就停在这里）", hint: "接受这个结局", tone: "bad" };
const OPT_DEEP = { text: "（走向更深处）", hint: "踏入下一幕", tone: "good" };
const OPT_ON = { text: "（顺着眼前的事走）", hint: "继续当前线索", tone: "good" };

const actOf = (id) => {
  const m = id.match(/^a(\d+)_/);
  return m ? +m[1] : null;
};
const numOf = (id) => {
  const m = id.match(/_n(\d+)/);
  return m ? +m[1] : -1;
};
const uniqueId = (base, taken) => {
  let id = base, i = 2;
  while (taken.has(id)) id = `${base}${i++}`;
  return id;
};

function reachable(N, start) {
  const seen = new Set([start]);
  const q = [start];
  while (q.length) {
    const n = N[q.shift()];
    if (!n) continue;
    const refs = [];
    if (n.next) refs.push(n.next);
    for (const c of n.choices || []) refs.push(c.next);
    for (const r of refs) if (!seen.has(r)) { seen.add(r); q.push(r); }
  }
  return seen;
}

function stitch(play) {
  const N = play.nodes;
  const stats = { stitched: 0, backfix: 0, passfix: 0, deadFixed: 0, orphans: 0 };
  const notes = [];

  /* ===== B. 先缝合终止节点 =====
     顺序很关键：ending 节点缝合后自己会长出通往下一幕的分支，
     那些"指向本幕 ending"的边因此自然成为通路，无需改边。
     若先改边，反而会把该 ending 变成无人可达的孤儿。 */
  for (let no = 1; no <= 4; no++) {
    const nextEntry = `a${no + 1}_n1`;
    if (!N[nextEntry]) continue;
    /* 跳过上一轮缝合生成的结局副本（id 以 _end 结尾），否则会被反复缝合，
       玩家要连点好几次"就停在这里"才能拿到结局 */
    const ids = Object.keys(N).filter((k) => actOf(k) === no && !N[k]._stitch);
    for (const id of ids.filter((k) => !N[k].next && !(N[k].choices || []).length)) {
      const node = N[id];
      if (node.ending) {
        const endId = uniqueId(`${id}_end`, new Set(Object.keys(N)));
        N[endId] = { segments: node.segments, ending: node.ending, _stitch: true };
        if (node.achievement) { N[endId].achievement = node.achievement; delete node.achievement; }
        delete node.ending;
        node.segments = [...node.segments, { type: "narration", text: BRIDGE }];
        node.choices = [
          { ...OPT_GO, next: nextEntry },
          { ...OPT_STOP, next: endId },
        ];
        stats.stitched++;
      } else {
        node.next = nextEntry;
        stats.deadFixed++;
      }
    }
  }

  /* ===== A. 再处理缝合后仍然封闭的幕 ===== */
  for (let no = 1; no <= 4; no++) {
    const nextEntry = `a${no + 1}_n1`;
    if (!N[nextEntry]) { notes.push(`第${no}幕：入口 ${nextEntry} 缺失`); continue; }

    const ids = Object.keys(N).filter((k) => actOf(k) === no);
    if (!ids.length) continue;
    const linked = ids.some(
      (k) => N[k].next === nextEntry || (N[k].choices || []).some((c) => c.next === nextEntry)
    );
    if (linked) continue;

    const tail = ids.slice().sort((a, b) => numOf(b) - numOf(a))[0];
    const tn = N[tail];
    const tgt = tn.next;
    const tAct = tgt ? actOf(tgt) : null;

    /* A1. 跨幕回指（指向更早的幕）——语义错误，直接改指下一幕 */
    if (tgt && tAct !== null && tAct < no) {
      notes.push(`第${no}幕：幕末 ${tail} 跨幕回指 ${tgt} → 改指 ${nextEntry}`);
      tn.next = nextEntry;
      stats.backfix++;
      continue;
    }
    /* A2. 同幕内部成环——插入过场节点，保留原路并开一条新路 */
    if (tgt && tAct === no) {
      const passId = uniqueId(`${tail}_pass`, new Set(Object.keys(N)));
      N[passId] = {
        _stitch: true,
        segments: [{ type: "narration", text: BRIDGE_PASS }],
        choices: [
          { ...OPT_ON, next: tgt },
          { ...OPT_DEEP, next: nextEntry },
        ],
      };
      tn.next = passId;
      stats.passfix++;
      notes.push(`第${no}幕：幕末 ${tail} 内部成环 → 插入过场 ${passId}`);
      continue;
    }
    /* A3. 幕末是选择点但无一路通向下一幕——追加一条 */
    if ((tn.choices || []).length) {
      tn.choices.push({ ...OPT_DEEP, next: nextEntry });
      stats.passfix++;
      notes.push(`第${no}幕：幕末 ${tail} 追加通往 ${nextEntry} 的选项`);
    }
  }

  /* ===== C. 孤儿救援 =====
     LLM 生成了分支/结局却忘了把它们写进上游的 choices，形成无人指向的子图。
     按 id 前缀找宿主（a2_n1_direct → 宿主 a2_n1），找不到就挂到同幕的可达节点，
     统一走"过场节点"接入，不破坏宿主原有路径。 */
  let live = reachable(N, play.start);
  const orphans = Object.keys(N).filter((k) => !live.has(k));
  const groups = new Map(); // host -> orphan[]

  for (const id of orphans) {
    let host = null;
    const parts = id.split("_");
    for (let i = parts.length - 1; i > 1; i--) {
      const cand = parts.slice(0, i).join("_");
      if (N[cand] && live.has(cand)) { host = cand; break; }
    }
    if (!host) {
      const act = actOf(id);
      host = Object.keys(N).find(
        (k) => actOf(k) === act && live.has(k) && !N[k].ending
      ) || null;
    }
    if (!host) { notes.push(`孤儿 ${id} 找不到宿主，跳过`); continue; }
    if (!groups.has(host)) groups.set(host, []);
    groups.get(host).push(id);
  }

  for (const [host, list] of groups) {
    const H = N[host];
    const branchId = uniqueId(`${host}_branch`, new Set(Object.keys(N)));
    const opts = [];
    if (H.next) opts.push({ ...OPT_ON, next: H.next });
    for (const c of H.choices || []) opts.push(c);
    for (const oid of list) {
      const oe = N[oid].ending;
      opts.push({
        text: oe ? `（走向「${oe.name}」）` : "（走上另一条路）",
        next: oid,
        hint: oe ? "未知结局" : "未知道路",
        tone: oe ? "bad" : "good",
      });
    }
    N[branchId] = {
      _stitch: true,
      segments: [{ type: "narration", text: "……就在此时，眼前分出了几条岔路。" }],
      choices: opts,
    };
    delete H.next;
    delete H.choices;
    H.next = branchId;
    stats.orphans = (stats.orphans || 0) + list.length;
    notes.push(`孤儿 ${list.length} 个 → 经 ${branchId} 接入 ${host}`);
  }

  play._meta = { ...(play._meta || {}), stitched_at: new Date().toISOString(), stitched_by: "stitch-plays.mjs" };
  return { stats, notes };
}

/* ---------- main ---------- */
const files = (await readdir(DIR)).filter((f) => f.endsWith(".json"));
const rows = [];
const T = { b: { n: 0, r: 0, e: 0, er: 0 }, a: { n: 0, r: 0, e: 0, er: 0 } };

for (const f of files) {
  const p = path.join(DIR, f);
  const play = await readJson(p);
  const N = play.nodes;
  const ends = Object.keys(N).filter((k) => N[k].ending);
  const before = reachable(N, play.start);
  const b = { n: Object.keys(N).length, r: before.size, e: ends.length, er: ends.filter((k) => before.has(k)).length };

  const { stats, notes } = stitch(play);

  const after = reachable(play.nodes, play.start);
  const ends2 = Object.keys(play.nodes).filter((k) => play.nodes[k].ending);
  const a = { n: Object.keys(play.nodes).length, r: after.size, e: ends2.length, er: ends2.filter((k) => after.has(k)).length };

  for (const k of Object.keys(T.b)) { T.b[k] += b[k]; T.a[k] += a[k]; }
  rows.push({
    title: play.title.slice(0, 11),
    "节点可达": `${b.r}/${b.n} → ${a.r}/${a.n}`,
    "结局可达": `${b.er}/${b.e} → ${a.er}/${a.e}`,
    缝合: stats.stitched, 改回指: stats.backfix, 过场: stats.passfix, 救孤儿: stats.orphans,
  });
  notes.forEach((n) => console.log(`   · ${play.title.slice(0, 8)}: ${n}`));
  if (!DRY) await writeFile(p, JSON.stringify(play, null, 2), "utf8");
}

console.table(rows);
const pct = (x, y) => `${((100 * x) / y).toFixed(1)}%`;
console.log(DRY ? "\n[dry-run] 未写入磁盘" : "\n✓ 已写回 data/plays/");
console.log(`节点可达: ${T.b.r}/${T.b.n} (${pct(T.b.r, T.b.n)})  →  ${T.a.r}/${T.a.n} (${pct(T.a.r, T.a.n)})`);
console.log(`结局可达: ${T.b.er}/${T.b.e} (${pct(T.b.er, T.b.e)})  →  ${T.a.er}/${T.a.e} (${pct(T.a.er, T.a.e)})`);
