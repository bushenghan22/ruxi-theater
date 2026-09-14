/* app.js —— 路由、主题、全局舞台组件（大幕/幕点/退场确认/首访引导） */
(function () {
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* 主题切换（记忆到 localStorage） */
  const saved = localStorage.getItem("ruxi-theme") || "night";
  applyTheme(saved);
  document.getElementById("themeSwitch").addEventListener("click", (e) => {
    const t = e.target.dataset.t;
    if (t) applyTheme(t);
  });
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    localStorage.setItem("ruxi-theme", t);
    document.querySelectorAll("#themeSwitch button").forEach((b) =>
      b.classList.toggle("on", b.dataset.t === t)
    );
  }

  /* 音效开关 */
  const soundBtn = document.getElementById("soundToggle");
  const renderSound = () => (soundBtn.textContent = window.Sound.on ? "🔊" : "🔇");
  renderSound();
  soundBtn.addEventListener("click", () => { window.Sound.toggle(); renderSound(); });

  /* 图鉴 */
  document.getElementById("codexBtn").addEventListener("click", () => window.Codex.open());
  document.getElementById("btnBackGame").addEventListener("click", () => window.Codex.backToGame());

  /* ---------- 开幕大幕：合幕 → 幕卡 → 开幕，返回 Promise ---------- */
  async function curtainShow(label, sub) {
    const c = $("curtain");
    c.querySelector(".curtain-label").textContent = label || "";
    c.querySelector(".curtain-sub").textContent = sub || "";
    // 只在真正进入全屏幕布时触发；模式选择和入戏手册不会播放这段音效。
    window.Sound?.curtain();
    c.classList.add("closed");
    await wait(620);                       // 合幕
    c.classList.add("label-on");
    await wait(560);                       // 幕卡停留
    c.classList.remove("label-on");
    await wait(180);
    c.classList.remove("closed");          // 开幕
    await wait(560);
  }

  /* ---------- 幕数圆点 ---------- */
  function dotsSet(n, total = 3) {
    const box = $("actDots");
    if (!box) return;
    box.innerHTML = Array.from({ length: total }, (_, i) => `<i class="${i < n ? "on" : ""}"></i>`).join("");
  }

  /* ---------- 顶部品牌 → 回大厅（带退场确认） ---------- */
  function requestBack() {
    // 结局浮层/手册打开时不拦；剧情未开始（还在大厅）也不拦
    if (!$("view-game").classList.contains("active")) { window.Game.back(); return; }
    if (window.Ending && document.getElementById("endingOverlay").classList.contains("show")) { window.Game.back(); return; }
    $("quitOverlay").classList.add("show");
  }
  $("quitStay").addEventListener("click", () => $("quitOverlay").classList.remove("show"));
  $("quitYes").addEventListener("click", () => {
    $("quitOverlay").classList.remove("show");
    window.Game.back();
  });
  document.getElementById("brandHome").addEventListener("click", requestBack);
  document.getElementById("btnBack").addEventListener("click", requestBack);
  document.getElementById("brandHome").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); requestBack(); }
  });

  /* ---------- 首次访客引导（只出一次） ---------- */
  if (!localStorage.getItem("ruxi-onboarded")) {
    $("guideOverlay").classList.add("show");
    $("guideEnter").addEventListener("click", () => {
      localStorage.setItem("ruxi-onboarded", "1");
      $("guideOverlay").classList.remove("show");
    }, { once: true });
  }

  /* ---------- 等待演出指示（B1）：NPC"正在回应/演绎"三点气泡 ---------- */
  let typingEl = null;
  const Typing = {
    show(speaker, word) {
      this.hide();
      const wrap = document.createElement("div");
      wrap.className = "msg-typing msg-say";
      wrap.innerHTML = `<span class="msg-name"></span><div class="msg-bubble"><span class="t-dot"></span><span class="t-dot"></span><span class="t-dot"></span><span class="t-word"></span></div>`;
      wrap.querySelector(".msg-name").textContent = speaker || "对方";
      wrap.querySelector(".t-word").textContent = word || "正在回应";
      $("streamInner").appendChild(wrap);
      $("stream").scrollTop = $("stream").scrollHeight;
      typingEl = wrap;
    },
    hide() { typingEl?.remove(); typingEl = null; },
  };

  /* 统一 Escape 退路：从最上层浮层开始关闭，避免键盘用户被困在多步流程里。 */
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const ending = document.getElementById("endingOverlay");
    const quit = document.getElementById("quitOverlay");
    const prologue = document.getElementById("prologueOverlay");
    const mode = document.getElementById("modeOverlay");
    const save = document.getElementById("saveOverlay");
    const kanshan = document.getElementById("kanshanPanel");
    if (ending?.classList.contains("show")) { window.Ending?.hide(); return; }
    if (quit?.classList.contains("show")) { quit.classList.remove("show"); return; }
    if (prologue?.classList.contains("show") || mode?.classList.contains("show")) {
      window.Game?.back();
      return;
    }
    if (save?.classList.contains("show")) { save.classList.remove("show"); return; }
    if (kanshan?.classList.contains("open")) { kanshan.classList.remove("open"); return; }
  });

  /* 启动 */
  window.Stage = { curtainShow, dotsSet, Typing };
  window.Hall.render();
})();
