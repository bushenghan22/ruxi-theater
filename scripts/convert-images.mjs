/*
 * 将 public/assets/covers 与 covers_small 下的 JPG 生成同名 WebP/AVIF。
 * 运行：node scripts/convert-images.mjs
 *
 * 采用本机 Chrome 的 Canvas 编码器，避免引入原生 npm 依赖；JPG 始终保留作降级格式。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const CHROME = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => p && existsSync(p));

if (!CHROME) throw new Error("未找到 Chrome/Edge，无法使用 Canvas 生成 WebP/AVIF");

const encodePage = `<!doctype html><meta charset="utf-8"><script>
const q = new URLSearchParams(location.search);
const img = new Image();
img.onload = async () => {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  const type = 'image/' + q.get('format');
  /* Canvas 在部分 Chromium 版本不提供 AVIF toDataURL；优先尝试 WebCodecs ImageEncoder。 */
  if (type === 'image/avif' && 'ImageEncoder' in window && 'VideoFrame' in window) {
    try {
      const frame = new VideoFrame(c, { timestamp: 0 });
      const encoder = new ImageEncoder({ type, quality: 0.84 });
      const result = await encoder.encode(frame);
      const chunk = result.image;
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
      document.body.textContent = type + ';base64,' + btoa(binary);
      frame.close(); encoder.close(); return;
    } catch (e) { /* fallback below; caller will skip unsupported AVIF */ }
  }
  try { document.body.textContent = c.toDataURL(type, 0.84); }
  catch (e) { document.body.textContent = 'ERROR:' + e.message; }
};
img.onerror = () => { document.body.textContent = 'ERROR:image load failed'; };
img.src = q.get('src');
</script>`;

async function encode(tempDir, src, format) {
  const page = path.join(tempDir, "encode.html");
  await writeFile(page, encodePage, "utf8");
  const pageUrl = `file:///${page.replaceAll("\\", "/").replace(/^([A-Za-z]):/, "$1:")}?src=${encodeURIComponent(src)}&format=${format}`;
  const profile = path.join(tempDir, `profile-${format}`);
  const { stdout } = await execFileAsync(CHROME, [
    "--headless=new", "--disable-gpu", "--disable-gpu-compositing", "--in-process-gpu", "--no-sandbox",
    "--no-first-run", "--no-default-browser-check",
    "--allow-file-access-from-files", `--user-data-dir=${profile}`,
    "--virtual-time-budget=10000", "--dump-dom", pageUrl,
  ], { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 30000 });
  const match = stdout.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const value = (match ? match[1] : stdout).trim();
  if (!value.startsWith(`data:image/${format};base64,`)) return null;
  return Buffer.from(value.slice(value.indexOf(",") + 1), "base64");
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), "ruxi-image-") );
try {
  let count = 0;
  for (const folder of ["covers", "covers_small"]) {
    const dir = path.join(PUBLIC, "assets", folder);
    const files = (await readdir(dir)).filter((f) => /\.jpe?g$/i.test(f));
    for (const file of files) {
      const src = pathToFileURL(path.join(dir, file)).href;
      for (const format of ["webp", "avif"]) {
        const output = path.join(dir, file.replace(/\.jpe?g$/i, `.${format}`));
        if (existsSync(output)) continue;
        const data = await encode(tempDir, src, format);
        if (!data) {
          if (format === "avif") console.warn("当前浏览器编码器不支持 AVIF，已保留 JPG/WebP 降级：" + file);
          continue;
        }
        await writeFile(output, data);
        count++;
        console.log(`${folder}/${path.basename(output)} ${(data.length / 1024).toFixed(1)} KB`);
      }
    }
  }
  console.log(`完成：生成 ${count} 个优化图片文件`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
