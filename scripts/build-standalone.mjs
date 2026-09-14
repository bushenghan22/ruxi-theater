/* build-standalone.mjs —— 打包《入戏》离线分享版单文件 HTML
   产物：D:\知乎黑客松个人\入戏-离线分享版.html（双击即玩，零依赖、零外部请求）
   - 内嵌 CSS/JS/封面图(base64)/10 篇剧本 JSON
   - 看山替换为 stub（需服务端支持，离线版提示）
   用法: node scripts/build-standalone.mjs
*/
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PUB = path.join(ROOT, "public");
const OUT = path.join(ROOT, "..", "入戏-离线分享版.html");

const stripBOM = (s) => s.replace(/^\uFEFF/, "");
const read = async (p) => stripBOM(await readFile(p, "utf8"));

/* 1. 数据 */
const storiesRaw = JSON.parse(stripBOM(await readFile(path.join(ROOT, "data", "stories.json"), "utf8")));

/* 2. 封面 → base64 data URI（优先用 covers_small 压缩版，控制单文件体积） */
async function coverToDataUri(relPath) {
  const small = relPath.replace("/covers/", "/covers_small/");
  let file;
  try {
    file = path.join(PUB, small);
    await readFile(file);
  } catch {
    file = path.join(PUB, relPath);
  }
  const buf = await readFile(file);
  const ext = path.extname(file).slice(1).toLowerCase();
  return `data:image/${ext === "jpg" ? "jpeg" : ext};base64,${buf.toString("base64")}`;
}

const stories = [];
const plays = {};
for (const s of storiesRaw.stories) {
  const dataUri = await coverToDataUri(s.cover);
  stories.push({ ...s, cover: dataUri });
  try {
    plays[s.work_id] = { ...JSON.parse(stripBOM(await readFile(path.join(ROOT, "data", "plays", `${s.work_id}.json`), "utf8"))), cover: dataUri };
  } catch { /* 未编译的篇目跳过 */ }
}
console.log(`数据就绪：${stories.length} 篇 / 剧本 ${Object.keys(plays).length} 份`);

/* 3. 离线 api.js 替换体 */
const offlineApiJs = `
/* api.js —— 离线分享版：全部数据内嵌，无网络依赖 */
window.API = (() => {
  const S = window.__RUXI_DATA__.stories;
  const P = window.__RUXI_DATA__.plays;
  return {
    listStories: async () => S,
    getPlay: async (id) => {
      const p = P[id];
      if (!p) throw new Error("play_not_ready");
      return p;
    },
    say: async () => { throw new Error("offline"); },
  };
})();
`;

const kanshanStubJs = `
/* kanshan.js —— 离线分享版 stub：看山需要服务端 + 官方 API 凭证，不随单文件分发 */
(function () {
  const $ = (id) => document.getElementById(id);
  const fab = $("kanshanFab"), panel = $("kanshanPanel"), log = $("kanshanLog");
  const input = $("kanshanInput"), send = $("kanshanSend");
  if (!fab || !panel) return;

  fab.addEventListener("click", () => {
    panel.classList.toggle("open");
    if (panel.classList.contains("open") && !log.dataset.noticed) {
      log.dataset.noticed = "1";
      const warn = document.createElement("div");
      warn.className = "kanshan-msg bot";
      warn.textContent = "⚠ 离线分享版不含看山服务——看山依赖知乎直答 API 与服务端凭证，出于安全考虑未随单文件分发。完整体验请使用线上部署版。";
      log.appendChild(warn);
      log.scrollTop = log.scrollHeight;
      input.disabled = true; send.disabled = true;
      input.placeholder = "离线版不可用";
    }
  });
  $("kanshanClose").addEventListener("click", () => panel.classList.remove("open"));
})();
`;

/* 4. 组装 */
const indexHtml = await read(path.join(PUB, "index.html"));
const css = (await read(path.join(PUB, "css", "themes.css"))) + "\n" + (await read(path.join(PUB, "css", "main.css")));

const jsFiles = ["hall.js", "codex.js", "game.js", "ending.js", "app.js"];
const jsInline = {};
for (const f of jsFiles) jsInline[f] = await read(path.join(PUB, "js", f));

const dataJs = `window.__RUXI_DATA__ = ${JSON.stringify({ stories, plays }).replace(/<\//g, "<\\/")};`;

let html = indexHtml
  // CSS 内联
  .replace('<link rel="stylesheet" href="/css/themes.css">', `<style>\n${css}\n</style>`)
  .replace('<link rel="stylesheet" href="/css/main.css">', "")
  // 数据内联（放在最前）
  .replace(
    '<script src="/js/api.js"></script>',
    `<script>\n${dataJs}\n${offlineApiJs}\n</script>`
  )
  // 其余脚本内联
  .replace('<script src="/js/sound.js"></script>', `<script>\n${await read(path.join(PUB, "js", "sound.js"))}\n</script>`)
  .replace('<script src="/js/hall.js"></script>', `<script>\n${jsInline["hall.js"]}\n</script>`)
  .replace('<script src="/js/codex.js"></script>', `<script>\n${jsInline["codex.js"]}\n</script>`)
  .replace('<script src="/js/game.js"></script>', `<script>\n${jsInline["game.js"]}\n</script>`)
  .replace('<script src="/js/kanshan.js"></script>', `<script>\n${kanshanStubJs}\n</script>`)
  .replace('<script src="/js/ending.js"></script>', `<script>\n${jsInline["ending.js"]}\n</script>`)
  .replace('<script src="/js/app.js"></script>', `<script>\n${jsInline["app.js"]}\n</script>`);

/* 5. 离线版标识 + 残留外部引用检查 */
html = html.replace("<title>入戏 · 知乎故事互动剧场</title>", "<title>入戏 · 知乎故事互动剧场（离线分享版）</title>");
const leftovers = [...html.matchAll(/(?:src|href)="\/(?!\/)([^"]+)"/g)].map((m) => m[0]);
if (leftovers.length) {
  console.error("✗ 存在未内联的外部引用：", leftovers);
  process.exit(1);
}
const externalHttp = [...html.matchAll(/(?:src|href)="https?:\/\/[^"]+"/g)].map((m) => m[0]);
if (externalHttp.length) console.warn("⚠ 保留的外部引用（favicon/svg data 除外应为 0）：", externalHttp);

await writeFile(OUT, html, "utf8");
const kb = Math.round((await writeFile ? 0 : 0));
const size = Buffer.byteLength(html) / 1024;
console.log(`✓ 已生成: ${OUT}`);
console.log(`  大小: ${Math.round(size)} KB ｜ 剧本 ${Object.keys(plays).length} 份 ｜ 封面 ${stories.length} 张已内嵌`);
