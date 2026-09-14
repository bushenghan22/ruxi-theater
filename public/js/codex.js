/* codex.js —— 图鉴：结局与成就收集册
   已解锁的展示详情；未解锁的显示"？？？ 待发现"，保留神秘感。 */
(function () {
  const $ = (id) => document.getElementById(id);

  const readStore = (key) => {
    try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; }
  };
  const endingStore = () => readStore("ruxi-endings");
  const achStore = () => readStore("ruxi-ach");

  let stories = [];
  let currentId = null;
  let cameFromGame = false; // 从游玩中打开 → 提供"返回剧场"

  async function open() {
    cameFromGame = !!(window.Game && window.Game.current) &&
      document.getElementById("view-game").classList.contains("active");
    document.getElementById("btnBackGame").style.display = cameFromGame ? "inline-block" : "none";
    show("view-codex");
    // API.listStories 返回 { stories, stats }；这里必须解包，避免把响应对象当数组使用。
    if (!stories.length) {
      const result = await API.listStories();
      stories = Array.isArray(result?.stories) ? result.stories : [];
    }
    if (!stories.length) {
      document.getElementById("codexBody").innerHTML = `<div class="codex-loading">故事目录暂时不可用，请稍后重试。</div>`;
      return;
    }
    if (!currentId) currentId = stories[0].work_id;
    renderPills();
    await renderBody();
  }

  function backToGame() {
    show("view-game");
  }

  function show(id) {
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    $(id).classList.add("active");
  }

  function renderPills() {
    $("codexPills").innerHTML = stories
      .map((s) => `<button class="codex-pill${s.work_id === currentId ? " on" : ""}" data-id="${s.work_id}">${s.title.length > 9 ? s.title.slice(0, 9) + "…" : s.title}</button>`)
      .join("");
    $("codexPills").querySelectorAll(".codex-pill").forEach((b) =>
      b.addEventListener("click", () => { currentId = b.dataset.id; renderPills(); renderBody(); })
    );
  }

  async function renderBody() {
    const body = $("codexBody");
    body.innerHTML = `<div class="codex-loading">翻开图鉴中……</div>`;
    let play;
    try {
      play = await API.getPlay(currentId);
    } catch {
      body.innerHTML = `<div class="codex-loading">这本的剧本还没排演好，先去玩别的吧。</div>`;
      return;
    }
    const story = stories.find((s) => s.work_id === currentId) || {};
    const endDone = (endingStore()[currentId] || []);
    const achDone = (achStore()[currentId] || []);

    // 收集全部结局与成就（遍历节点）
    const endings = [], seenEnd = new Set();
    for (const node of Object.values(play.nodes || {})) {
      if (node.ending && !seenEnd.has(node.ending.name)) {
        seenEnd.add(node.ending.name);
        endings.push(node.ending);
      }
    }
    const achievements = play.achievements || [];

    const eUnlocked = endings.filter((e) => endDone.includes(e.name)).length;
    const aUnlocked = achievements.filter((a) => achDone.includes(a.id)).length;
    const CN = ["壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖", "拾", "拾壹", "拾贰"];

    const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    body.innerHTML = `
      <div class="codex-story-head">
        <img src="${story.cover || ""}" srcset="${String(story.cover || "").replace(/\.jpe?g($|[?#])/i, ".webp$1")} 1x" alt="" class="codex-cover" decoding="async">
        <div class="codex-story-info">
          <div class="codex-story-title">${esc(story.title || "")}</div>
          <div class="codex-story-meta">原著 · ${esc(story.author || "")} ｜ 官方授权改编</div>
          <div class="codex-bars">
            <div class="codex-bar-row">
              <span class="codex-bar-label">结局</span>
              <div class="codex-bar"><i style="width:${endings.length ? (eUnlocked / endings.length) * 100 : 0}%"></i></div>
              <span class="codex-bar-num">${eUnlocked}<i>／${endings.length}</i></span>
            </div>
            <div class="codex-bar-row">
              <span class="codex-bar-label">成就</span>
              <div class="codex-bar"><i style="width:${achievements.length ? (aUnlocked / achievements.length) * 100 : 0}%"></i></div>
              <span class="codex-bar-num">${aUnlocked}<i>／${achievements.length}</i></span>
            </div>
          </div>
        </div>
        <div class="codex-seal">收<br>录</div>
      </div>

      <div class="codex-section"><span class="codex-sec-mark"></span><h3>结局收录</h3><span class="codex-sec-line"></span></div>
      <div class="codex-grid">
        ${endings.map((e, i) => {
          const got = endDone.includes(e.name);
          return got
            ? `<div class="codex-card got">
                 <div class="codex-card-no">${CN[i] || i + 1}</div>
                 <div class="codex-card-name">${esc(e.name)}</div>
                 <div class="codex-card-quote">「${esc(e.quote || "")}」</div>
                 <div class="codex-card-tag">已达</div>
               </div>`
            : `<div class="codex-card locked">
                 <div class="codex-card-no">${CN[i] || i + 1}</div>
                 <div class="codex-card-myst">？</div>
                 <div class="codex-card-quote">待发现 · 换一条路试试</div>
                 <div class="codex-card-tag">未启</div>
               </div>`;
        }).join("")}
      </div>

      <div class="codex-section"><span class="codex-sec-mark"></span><h3>成就收录</h3><span class="codex-sec-line"></span></div>
      <div class="codex-grid">
        ${achievements.map((a, i) => {
          const got = achDone.includes(a.id);
          if (got) return `<div class="codex-card got">
              <div class="codex-card-no">${CN[i] || i + 1}</div>
              <div class="codex-card-name">${esc(a.name)}</div>
              <div class="codex-card-quote">${esc(a.desc)}</div>
              <div class="codex-card-tag">已达</div>
            </div>`;
          return a.hidden
            ? `<div class="codex-card locked hidden-ach">
                 <div class="codex-card-no">${CN[i] || i + 1}</div>
                 <div class="codex-card-myst">密</div>
                 <div class="codex-card-quote">条件保密 · 静待有缘人</div>
                 <div class="codex-card-tag">隐</div>
               </div>`
            : `<div class="codex-card locked">
                 <div class="codex-card-no">${CN[i] || i + 1}</div>
                 <div class="codex-card-myst">？</div>
                 <div class="codex-card-quote">${esc(a.desc)}</div>
                 <div class="codex-card-tag">未启</div>
               </div>`;
        }).join("")}
      </div>`;
  }

  window.Codex = { open, backToGame };
})();
