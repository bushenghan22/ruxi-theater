/* ending.js —— 结局卡展示 + canvas 保存为图片 */
(function () {
  const $ = (id) => document.getElementById(id);
  const overlay = $("endingOverlay");
  let current = null;

  function show({ story, ending, trail, ach }) {
    current = {
      story, ending, trail,
      mode: window.__ruxiMode || "story",
      ach: ach || { unlocked: 0, total: 0, thisRun: 0 },
    };
    const cover = story.cover_large || story.cover || "";
    $("endingCover").src = cover;
    $("endingCover").srcset = cover.replace(/\.jpe?g($|[?#])/i, ".webp$1");
    $("endingCover").alt = story.title ? `《${story.title}》封面` : "故事封面";
    $("endingName").textContent = ending.name;
    $("endingQuote").textContent = ending.quote ? `「${ending.quote}」` : "";
    $("endingTrail").innerHTML = trail.length
      ? trail.map((t, i) => `<div class="ending-trail-item"><span class="no">${String(i + 1).padStart(2, "0")}</span>${t}</div>`).join("")
      : '<div class="ending-trail-item">你全程未偏航，沿原著走完了这场戏。</div>';
    $("endingAch").innerHTML = current.ach.total
      ? `🏆 本局成就 ${current.ach.thisRun} 个 ｜ 累计收集 ${current.ach.unlocked} / ${current.ach.total}`
      : "";
    // C2 集齐庆祝：该篇结局全收集 → 徽章升级 + 彩带
    let allDone = false;
    try {
      const done = (JSON.parse(localStorage.getItem("ruxi-endings") || "{}")[story.work_id] || []).length;
      const total = window.__ruxiStats?.[story.work_id]?.endings || 0;
      allDone = !!(total && done >= total);
    } catch { /* ignore */ }
    document.querySelector(".ending-badge").textContent = allDone ? "— 功 德 圆 满 · 结 局 集 满 —" : "— 结 局 达 成 —";
    if (allDone) confetti();
    overlay.classList.add("show");
    requestAnimationFrame(() => $("btnRetry")?.focus());
  }

  /* 简易彩带：30 个小色块从顶部飘落 */
  function confetti() {
    const colors = ["#d4a373", "#e8c39a", "#a03a2f", "#b8524a", "#ece7db", "#7fa87f"];
    for (let i = 0; i < 30; i++) {
      const p = document.createElement("i");
      p.className = "confetti-bit";
      p.style.cssText = `left:${Math.random() * 100}%;background:${colors[i % colors.length]};
        animation-delay:${Math.random() * 0.6}s;animation-duration:${1.4 + Math.random() * 1.2}s;
        transform:rotate(${Math.random() * 360}deg);width:${6 + Math.random() * 6}px;height:${8 + Math.random() * 8}px`;
      overlay.appendChild(p);
      setTimeout(() => p.remove(), 3200);
    }
  }
  function hide() { overlay.classList.remove("show"); }

  /* ---------- canvas 绘制结局卡（750×1050 竖版） ---------- */
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function wrapText(ctx, text, maxWidth) {
    const lines = [];
    let line = "";
    for (const ch of text) {
      if (ch === "\n") { lines.push(line); line = ""; continue; }
      if (ctx.measureText(line + ch).width > maxWidth) { lines.push(line); line = ch; }
      else line += ch;
    }
    if (line) lines.push(line);
    return lines;
  }

  function loadImg(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  async function drawCard() {
    const W = 750, H = 1050;
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    const accent = cssVar("--accent", "#a03a2f");
    const bg = cssVar("--bg-panel", "#141824");
    const textHi = cssVar("--text-hi", "#ece7db");
    const textDim = cssVar("--text-dim", "#7a8194");
    const serif = '"Noto Serif SC","STZhongsong","SimSun",serif';
    const ui = '"PingFang SC","Microsoft YaHei",sans-serif';

    // 背景
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, bg);
    grad.addColorStop(1, cssVar("--bg-base", "#0b0d13"));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // 封面（上 420px，压暗）
    const coverImg = await loadImg(current.story.cover_large || current.story.cover);
    if (coverImg) {
      const scale = Math.max(W / coverImg.width, 420 / coverImg.height);
      const cw = coverImg.width * scale, chh = coverImg.height * scale;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, W, 420); ctx.clip();
      ctx.globalAlpha = 0.9;
      ctx.drawImage(coverImg, (W - cw) / 2, (420 - chh) / 2, cw, chh);
      ctx.globalAlpha = 1;
      const fade = ctx.createLinearGradient(0, 240, 0, 430);
      fade.addColorStop(0, "rgba(0,0,0,0)");
      fade.addColorStop(1, bg);
      ctx.fillStyle = fade; ctx.fillRect(0, 240, W, 190);
      ctx.restore();
    }

    // 徽章
    ctx.font = `500 20px ${ui}`;
    ctx.textAlign = "center";
    ctx.fillStyle = accent;
    ctx.fillText("—  结  局  达  成  —", W / 2, 470);

    // 故事名（小）
    ctx.font = `400 22px ${serif}`;
    ctx.fillStyle = textDim;
    ctx.fillText(`《${current.story.title}》`, W / 2, 520);

    // 结局名（大）
    ctx.font = `900 64px ${serif}`;
    ctx.fillStyle = accent;
    ctx.fillText(current.ending.name, W / 2, 610);

    // 金句
    if (current.ending.quote) {
      ctx.font = `italic 400 24px ${serif}`;
      ctx.fillStyle = textHi;
      const lines = wrapText(ctx, `「${current.ending.quote}」`, W - 140);
      lines.slice(0, 3).forEach((l, i) => ctx.fillText(l, W / 2, 680 + i * 40));
    }

    // 轨迹
    ctx.font = `500 18px ${ui}`;
    ctx.fillStyle = textDim;
    ctx.fillText("你 的 入 戏 轨 迹", W / 2, 810);
    ctx.font = `400 19px ${ui}`;
    const trailLines = current.trail.length
      ? current.trail.slice(0, 4).map((t, i) => `${String(i + 1).padStart(2, "0")}  ${t}`)
      : ["你全程未偏航，沿原著走完了这场戏。"];
    let ty = 848;
    for (const line of trailLines) {
      const parts = wrapText(ctx, line, W - 130);
      for (const p of parts) { ctx.fillStyle = current.trail.length ? textDim : textHi; ctx.fillText(p, W / 2, ty); ty += 30; }
    }
    // 成就行
    if (current.ach.total) {
      ctx.font = `500 17px ${ui}`;
      ctx.fillStyle = accent;
      ctx.fillText(`🏆 本局成就 ${current.ach.thisRun} 个 ｜ 累计 ${current.ach.unlocked}/${current.ach.total}`, W / 2, ty + 8);
      ty += 40;
    }

    // 底部水印
    ctx.strokeStyle = cssVar("--border", "rgba(255,255,255,0.15)");
    ctx.beginPath(); ctx.moveTo(120, 968); ctx.lineTo(W - 120, 968); ctx.stroke();
    ctx.font = `400 17px ${ui}`;
    ctx.fillStyle = textDim;
    ctx.fillText("入戏 · 知乎故事互动剧场", W / 2, 1000);
    ctx.font = `400 13px ${ui}`;
    ctx.fillStyle = cssVar("--text-faint", "#4d5464");
    ctx.fillText(`原著 · ${current.story.author} ／ 官方授权改编 + AI 续写 ｜ 知乎黑客松 2026`, W / 2, 1028);

    return c;
  }

  $("btnSaveCard").addEventListener("click", async () => {
    const btn = $("btnSaveCard");
    btn.textContent = "生成中…";
    try {
      const canvas = await drawCard();
      const a = document.createElement("a");
      a.download = `入戏-${current.ending.name}.png`;
      a.href = canvas.toDataURL("image/png");
      a.click();
      btn.textContent = "✓ 已保存";
    } catch (e) {
      btn.textContent = "生成失败";
    }
    setTimeout(() => (btn.textContent = "保存结局卡"), 1800);
  });
  $("btnReplay").addEventListener("click", () => { hide(); window.Game.back(); });
  $("btnRetry").addEventListener("click", () => {
    if (!current?.story) return;
    const replayStory = current.story;
    const replayMode = current.mode;
    hide();
    if (replayMode === "ai" && window.GameAI?.start) window.GameAI.start(replayStory);
    else window.Game?.start(replayStory);
  });
  $("btnOpenCodex").addEventListener("click", () => {
    hide();
    window.Codex?.open();
  });

  window.Ending = { show, hide };
})();
