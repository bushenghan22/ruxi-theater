/* hall.js —— 大厅：演示台 + 欢迎回来 + AI 片场/题材分组海报栏 */
(function () {
  const groupsEl = document.getElementById("hallGroups");
  const resumeEl = document.getElementById("hallResume");
  const resumeTxt = document.getElementById("hallResumeTxt");
  const resumeGo = document.getElementById("hallResumeGo");
  let ALL = [], STATS = {};

  /* 题材分组（每篇取第一个命中的组；AI 篇单独成组） */
  const GROUPS = [
    { key: "qimo", name: "权谋剧场", sub: "INTRIGUE", kws: ["权谋", "历史", "争霸", "后宫"] },
    { key: "xuanyi", name: "悬疑剧场", sub: "MYSTERY", kws: ["悬疑", "惊悚", "犯罪", "病娇", "克苏鲁", "反转", "无限流"] },
    { key: "tianchong", name: "甜宠剧场", sub: "ROMANCE", kws: ["言情", "甜宠", "豪门霸总", "校园", "学霸", "娱乐圈", "暗恋", "青梅竹马", "追妻火葬场", "雄竞"] },
    { key: "zhiru", name: "治愈人间", sub: "HEALING", kws: ["治愈", "现实情感", "家庭", "草根", "励志", "动物主角", "团宠", "女配", "医生"] },
    { key: "shuangwen", name: "爽文脑洞", sub: "FANTASY", kws: ["脑洞", "穿越", "系统", "末世", "丧尸", "科幻", "爽文", "西游", "玄幻奇幻", "仙侠", "架空", "穿书", "玄学", "求生", "囤物资"] },
  ];
  const matchGroup = (s) => {
    const hay = (s.labels || []).join(",") + "," + (s.title || "");
    return GROUPS.find((g) => g.kws.some((k) => hay.includes(k))) || GROUPS[GROUPS.length - 1];
  };

  const readEndings = (id) => {
    try { return (JSON.parse(localStorage.getItem("ruxi-endings") || "{}")[id] || []).length; } catch { return 0; }
  };
  const isAI = (s) => !!(window.GameAI && window.GameAI.available(s.work_id));
  const modern = (src, ext) => String(src || "").replace(/\.jpe?g($|[?#])/i, `.${ext}$1`);

  function cardHTML(s, i) {
    const st = STATS[s.work_id] || {};
    const done = readEndings(s.work_id);
    const progress = st.endings ? `<span class="pv-prog card-progress">结局 ${done}/${st.endings}${done >= st.endings ? " · 满" : ""}</span>` : "";
    const ai = isAI(s) ? `<span class="card-ai-badge">✦ AI 演绎</span>` : "";
    return `
      <article class="card gold-ring" data-id="${s.work_id}" tabindex="0" role="button" aria-label="进入《${s.title}》" style="animation-delay:${Math.min(i, 8) * 0.06}s">
        <div class="card-cover">
          ${s.tagline ? `<span class="card-tagline">${s.tagline}</span>` : ""}
          ${progress}${ai}
          <img src="${s.cover}" srcset="${modern(s.cover, "webp")} 1x" alt="${s.title}" loading="lazy" decoding="async">
        </div>
        <span class="sheen"></span>
        <div class="card-body">
          <h3 class="card-title">${s.title}</h3>
          <div class="card-author">作者 · <b>${s.author}</b></div>
          <span class="card-enter">入戏扮演 →</span>
        </div>
      </article>`;
  }

  function renderGroups() {
    const aiList = ALL.filter(isAI);
    let html = "";
    if (aiList.length) {
      html += `
        <div class="grp-sep"><div class="gk"><span class="gmark"><i>✦</i></span><h3>AI 片场</h3><span class="gsub">LIVE IMPROV · 你的每句话都算数</span></div><span class="l"></span><span class="d">◆</span></div>
        <div class="grp-grid">${aiList.map(cardHTML).join("")}</div>`;
    }
    for (const g of GROUPS) {
      const list = ALL.filter((s) => !isAI(s) && matchGroup(s) === g);
      if (!list.length) continue;
      html += `
        <div class="grp-sep"><div class="gk"><span class="gmark"><i>${g.name[0]}</i></span><h3>${g.name}</h3><span class="gsub">${g.sub}</span></div><span class="l"></span><span class="d">◆</span></div>
        <div class="grp-grid">${list.map(cardHTML).join("")}</div>`;
    }
    groupsEl.innerHTML = html || `<div class="grp-empty">剧目排演中，稍候片刻……</div>`;
    bindTiltAndClick();
  }

  function bindTiltAndClick() {
    groupsEl.querySelectorAll(".card").forEach((card) => {
      // 3D 倾斜 + 高光跟随（桌面鼠标；触屏自动忽略）
      card.addEventListener("mousemove", (e) => {
        const r = card.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        card.style.transform = `perspective(900px) rotateY(${(px * 10).toFixed(2)}deg) rotateX(${(py * -8).toFixed(2)}deg) translateY(-4px)`;
        card.style.setProperty("--shx", `${((px + 0.5) * 100).toFixed(1)}%`);
        card.style.setProperty("--shy", `${((py + 0.5) * 100).toFixed(1)}%`);
      });
      card.addEventListener("mouseleave", () => { card.style.transform = ""; });
      const enterCard = () => {
        const story = ALL.find((x) => x.work_id === card.dataset.id);
        if (!story || card.classList.contains("entering")) return;
        card.classList.add("entering");
        Promise.resolve(window.Game.start(story))
          .catch(() => {})
          .finally(() => card.classList.remove("entering"));
      };
      card.addEventListener("click", enterCard);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); enterCard(); }
      });
    });
  }

  function randomPlay() {
    if (!ALL.length) return;
    const story = ALL[Math.floor(Math.random() * ALL.length)];
    document.getElementById("randomPlayBtn")?.blur();
    window.Game?.start(story);
  }

  /* 欢迎回来条：AI 演绎存档 → 一键续演 */
  function renderResume() {
    try {
      const sv = JSON.parse(localStorage.getItem("ruxi-ai-save") || "null");
      if (sv && sv.story_id && sv.state && sv.state.turn > 0) {
        const st = ALL.find((x) => x.work_id === sv.story_id);
        if (st) {
          resumeTxt.innerHTML = `上次演到 <b>《${st.title}》</b> 第 ${sv.state.act || 1} 幕 · 回合 ${sv.state.turn || 0} —— 大幕为您留着`;
          resumeGo.onclick = () => window.GameAI.start(st);
          resumeEl.style.display = "";
          return;
        }
      }
    } catch { /* ignore */ }
    resumeEl.style.display = "none";
  }

  async function render() {
    const { stories, stats } = await API.listStories();
    ALL = stories; STATS = stats || {};
    window.__ruxiStats = STATS;
    window.__ruxiAiCount = ALL.filter(isAI).length;
    const randomBtn = document.getElementById("randomPlayBtn");
    if (randomBtn) {
      randomBtn.disabled = !ALL.length;
      randomBtn.setAttribute("aria-disabled", String(!ALL.length));
    }
    const heroMeta = document.getElementById("heroMeta");
    if (heroMeta) heroMeta.textContent = ALL.length + " 出故事 · " + window.__ruxiAiCount + " 出支持 AI 演绎";
    const aiCount = document.getElementById("ticketAiCount");
    if (aiCount) aiCount.textContent = window.__ruxiAiCount + " 篇已就绪";
    renderResume();
    renderGroups();
    startDemo();
  }

  /* ---------- 现场演示台（打字机场景循环） ---------- */
  const PAUSE = { "，": 150, "、": 130, "。": 210, "！": 210, "？": 210, "…": 180, "；": 170, "：": 140 };
  const DEMO_SCENES = [
    {
      story: "《穿越大明，我被崇祯偷听心声》",
      scene: "崇祯：（朱笔一顿）昨夜三更，你在心里喊的那句话——再说与朕听一遍。\n……御书房里，只有烛火在响。下一个开口的，是你。",
      opA: "【跪下求饶】\"臣、臣罪该万死……\"",
      opB: "【心声】（完了，这位爷比史书上还难糊弄）",
      endA: ["结局 · 疯癫外戚", "真话说得太早，也是一种错。"],
      endB: ["结局 · 暗夜同谋", "两个各怀心思的人，朝同一个方向走了一步。"],
    },
    {
      story: "《吃人心的小妖怪》",
      scene: "破土庙。病危的女童，哭求的母亲。\n娘说过：吃一颗人心，就能成仙。可她们……管你叫神仙。",
      opA: "【闻心：毓娘】——闻闻这位母亲的心，是什么味道。",
      opB: "【转身入夜】成仙要紧，凡人的事少管。",
      endA: ["结局 · 人间烟火", "酸得牙都倒了，可底下有一小块甜。"],
      endB: ["结局 · 山雨埋庙", "破庙塌了的那夜，山里再没那双亮亮的眼睛。"],
    },
    {
      story: "《学科修仙》",
      scene: "大师兄：（呃…这个…）4×8÷2﹣3……是十三还是十四？！\n演武场一片死寂。落榜的代价，是重伤除名。",
      opA: "【答题】先乘除后加减——答案是 13，大师兄稳住！",
      opB: "【报 14】跟着感觉走，反正大家都不会。",
      endA: ["结局 · 真·学科之神", "知识不是题库，是抬头的那一瞬间。"],
      endB: ["结局 · 走火入题", "这个世界的题，把她吃了。"],
    },
  ];
  const demoPaused = () => document.hidden || !document.getElementById("view-hall")?.classList.contains("active");
  function typeText(el, text, cps = 40) {
    return new Promise((done) => {
      el.innerHTML = '<span class="tx"></span><span class="hd-caret"></span>';
      const tx = el.querySelector(".tx") || el;
      let i = 0;
      (function step() {
        if (i >= text.length) { done(); return; }
        if (demoPaused()) { setTimeout(step, 240); return; }
        tx.textContent = text.slice(0, ++i);
        setTimeout(step, PAUSE[text[i - 1]] || cps);
      })();
    });
  }
  const wait = (ms) => new Promise((resolve) => {
    const started = performance.now();
    const tick = () => {
      const now = performance.now();
      if (!demoPaused() && now - started >= ms) return resolve();
      setTimeout(tick, demoPaused() ? 240 : Math.min(80, Math.max(16, ms - (now - started))));
    };
    tick();
  });
  async function demoLoop() {
    const S = {
      name: document.getElementById("demoName"), scene: document.getElementById("demoScene"),
      opA: document.getElementById("demoOpA"), opB: document.getElementById("demoOpB"),
      endA: document.getElementById("demoEndA"), endB: document.getElementById("demoEndB"),
    };
    if (!S.scene) return;
    let i = 0;
    for (;;) {
      const sc = DEMO_SCENES[i % DEMO_SCENES.length]; i++;
      S.name.textContent = sc.story;
      S.opA.textContent = ""; S.opB.textContent = "";
      S.opA.classList.remove("on"); S.opB.classList.remove("on");
      S.endA.classList.remove("in"); S.endB.classList.remove("in");
      S.endA.innerHTML = ""; S.endB.innerHTML = "";
      await typeText(S.scene, sc.scene);
      await wait(480);
      S.opA.textContent = sc.opA; S.opB.textContent = sc.opB;
      await wait(850);
      S.opB.classList.add("on");
      await wait(1350);
      S.endB.innerHTML = `<b>${sc.endB[0]}</b>${sc.endB[1]}`; S.endB.classList.add("in");
      await wait(1750);
      S.opA.classList.add("on"); S.opB.classList.remove("on");
      S.endA.innerHTML = `<b>${sc.endA[0]}</b>${sc.endA[1]}`; S.endA.classList.add("in");
      await wait(2400);
    }
  }
  let demoStarted = false;
  function startDemo() { if (!demoStarted) { demoStarted = true; demoLoop().catch(() => {}); } }

  document.getElementById("randomPlayBtn")?.addEventListener("click", randomPlay);

  window.Hall = { render };
})();
