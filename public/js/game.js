/* game.js —— 对话 AVG 游玩引擎（滚动对话流版）
   剧本结构（与 scripts/compile-story.mjs 输出一致）：
   { story_id, title, author, cover, start, cast?: {角色: 人物卡}, nodes: { id: {
       segments: [ {type:"narration"|"say", speaker?, text} ],
       next, choices: [{text,next,hint?,tone?}], free?: bool, ending?: {name, quote}
   } } }
   交互：节点自动流式播出（打字机），点击剧情区=跳过打字/加速；
        过去情节在剧情流中可上下滑动回看；自由输入仅在 AI 演绎模式开放。
*/
(function () {
  const $ = (id) => document.getElementById(id);
  const el = {
    viewGame: $("view-game"), stageBg: $("stageBg"), stageTitle: $("stageTitle"),
    stream: $("stream"), inner: $("streamInner"),
    choiceBox: $("choiceBox"), freeInput: $("freeInput"), freeSend: $("freeSend"),
    floatHints: $("floatHints"),
  };

  let play = null, story = null, nodeId = null;
  let playToken = 0;          // 播放令牌：切节点时使旧播放任务失效
  let typing = null;          // 当前打字机 {timer, full, done, node}
  let wake = null;            // 段间等待的提前唤醒器
  let trail = [];             // 选择轨迹
  let log = [];               // 全部对话记录（供 AI 上下文）
  let lastNpc = "对方";        // 最近说话的 NPC
  let unlocked = new Set();   // 本局已解锁成就
  let ended = false;          // 是否已到结局（结局后禁止再发言）
  let starting = false;       // start 防重入（大厅快速双击卡片）

  /* 节奏（偏沉浸：段间隔长、打字慢；点击剧情区可跳过） */
  const TEMPO = { segGap: 950, typeMs: 52, typeStep: 1 };

  const sleep = (ms) => new Promise((r) => { wake = r; setTimeout(() => { if (wake === r) { wake = null; r(); } }, ms); });

  /* ---------- 滚动 ---------- */
  function nearBottom() {
    return el.stream.scrollHeight - el.stream.scrollTop - el.stream.clientHeight < 140;
  }
  function scrollDown(force) {
    if (force || nearBottom()) el.stream.scrollTop = el.stream.scrollHeight;
  }

  /* ---------- 打字机（作用于最新消息气泡） ---------- */
/* 标点处停顿：念台词的呼吸感 */
const TYPE_PAUSE = { "，": 170, "、": 150, "。": 230, "！": 230, "？": 230, "…": 200, "；": 190, "：": 150, "\n": 240 };
function typeInto(textNode, text, my) {
  return new Promise((resolve) => {
    const caret = document.createElement("span");
    caret.className = "dialog-caret";
    textNode.parentNode.appendChild(caret);
    let i = 0, timer = null;
    const step = () => {
      if (my !== playToken) { resolve(); return; }
      i += TEMPO.typeStep;
      textNode.textContent = text.slice(0, i);
      Sound.type();
      if (i >= text.length) {
        caret.remove(); typing = null; resolve();
      } else {
        scrollDown();
        timer = setTimeout(step, TYPE_PAUSE[text[i - 1]] || TEMPO.typeMs);
      }
    };
    timer = setTimeout(step, TEMPO.typeMs);
    typing = { cancel: () => clearTimeout(timer), full: text, resolve, textNode, caret };
  });
}
function finishTyping() {
  if (!typing) return false;
  typing.cancel();
  typing.textNode.textContent = typing.full;
  typing.caret.remove();
  const r = typing.resolve; typing = null; r();
  return true;
}

  /* ---------- 消息追加 ---------- */
  function addNarration(text) {
    const d = document.createElement("div");
    d.className = "msg-narration";
    d.textContent = text;
    el.inner.appendChild(d);
    log.push({ speaker: "旁白", text });
    Sound.msg(true);
    scrollDown();
  }
  async function addSay(speaker, text, mine, my) {
    lastNpc = mine ? lastNpc : (speaker || lastNpc);
    const wrap = document.createElement("div");
    wrap.className = "msg-say" + (mine ? " mine" : "");
    wrap.innerHTML = `<span class="msg-name"></span><div class="msg-bubble"><span class="txt"></span></div>`;
    wrap.querySelector(".msg-name").textContent = speaker;
    el.inner.appendChild(wrap);
    log.push({ speaker, text });
    scrollDown();
    const txt = wrap.querySelector(".txt");
    if (mine) { txt.textContent = text; Sound.msg(false); scrollDown(); }
    else {
      await typeInto(txt, text, my);
      Sound.msg(false);
    }
  }
  function addChoiceRecord(text) {
    const d = document.createElement("div");
    d.className = "msg-choices";
    d.innerHTML = `<div class="choices-title">— 你 的 抉 择 —</div>
      <button class="choice-btn picked"><span class="choice-key">✓</span>${text}</button>`;
    el.inner.appendChild(d);
    scrollDown();
  }

  /* ---------- 选项 ---------- */
  function appendChoices(choices) {
    const box = document.createElement("div");
    box.className = "msg-choices";
    box.innerHTML = `<div class="choices-title">—— 作 出 你 的 抉 择 ——</div>`;
    choices.forEach((c, i) => {
      const b = document.createElement("button");
      b.className = "choice-btn";
      b.innerHTML = `<span class="choice-key">${i + 1}</span>${c.text}`;
      b.addEventListener("click", () => {
        if (el.inner.contains(box) && box.dataset.done) return;
        box.dataset.done = "1";
        Sound.click();
        box.querySelectorAll(".choice-btn").forEach((x) => (x !== b ? x.classList.add("dimmed") : x.classList.add("picked")));
        if (c.hint) floatHint(c.hint, c.tone === "bad");
        trail.push(c.text);
        log.push({ speaker: "我（抉择）", text: c.text });
        setTimeout(() => goto(c.next), 550);
      });
      box.appendChild(b);
    });
    el.inner.appendChild(box);
    scrollDown(true);
  }

  function floatHint(text, bad) {
    const t = document.createElement("div");
    t.className = "float-hint" + (bad ? " bad" : "");
    t.textContent = text;
    el.floatHints.appendChild(t);
    Sound.hint(!bad);
    setTimeout(() => t.remove(), 2400);
  }

  /* ---------- 结局图鉴记录 ---------- */
  const END_KEY = "ruxi-endings";
  function recordEnding(name) {
    try {
      const store = JSON.parse(localStorage.getItem(END_KEY) || "{}");
      const arr = store[story.work_id] = store[story.work_id] || [];
      if (!arr.includes(name)) arr.push(name);
      localStorage.setItem(END_KEY, JSON.stringify(store));
    } catch { /* storage 不可用时忽略 */ }
    API.track("ending", { story_id: story.work_id, mode: "story", ending: name }); // 埋点：结局
  }

  /* ---------- 成就系统 ---------- */
  const ACH_KEY = "ruxi-ach";
  function achStore() { try { return JSON.parse(localStorage.getItem(ACH_KEY) || "{}"); } catch { return {}; } }
  function achDef(id) { return (play.achievements || []).find((a) => a.id === id); }
  function unlockAch(id) {
    if (!id || unlocked.has(id)) return;
    const def = achDef(id);
    if (!def) return;
    unlocked.add(id);
    const store = achStore();
    const arr = store[story.work_id] = store[story.work_id] || [];
    if (!arr.includes(id)) arr.push(id);
    localStorage.setItem(ACH_KEY, JSON.stringify(store));
    floatHint(`🏆 成就解锁 · ${def.name}`);
  }
  function achStats() {
    const total = (play.achievements || []).length;
    const before = (achStore()[story.work_id] || []).length; // 含历史局
    const union = new Set([...(achStore()[story.work_id] || []), ...unlocked]).size;
    return { unlocked: union, total, thisRun: unlocked.size };
  }

  /* ---------- 节点播放 ---------- */
  async function goto(id) {
    const my = ++playToken;
    nodeId = id;
    const node = play.nodes[id];
    // 幕数圆点（B4）：按节点前缀更新当前幕
    const actNoM = String(id).match(/^a(\d+)_/);
    if (actNoM) window.Stage.dotsSet(Math.min(+actNoM[1], 3));
    // 首次游玩：提示可点击加速（只出一次）
    if (!localStorage.getItem("ruxi-tempo-hint")) {
      localStorage.setItem("ruxi-tempo-hint", "1");
      floatHint("💡 点击画面可加速演出");
    }
    // 兜底：节点缺失（编译异常/引用断裂）时给出可恢复提示，不静默卡死
    if (!node || !Array.isArray(node.segments) || !node.segments.length) {
      addNarration("（剧情在这里出现了一点意外……请点右上角退出剧场后重新进入，我们会把这一幕补上。）");
      return;
    }
    if (node.achievement) unlockAch(node.achievement);
    if (node.ending && node.ending.achievement) unlockAch(node.ending.achievement);
    for (const seg of node.segments) {
      if (my !== playToken) return;
      if (seg.type === "narration") addNarration(seg.text);
      else await addSay(seg.speaker, seg.text, seg.speaker === "我", my);
      if (my !== playToken) return;
      await sleep(TEMPO.segGap);
    }
    if (my !== playToken) return;
    if (node.ending) {
      Sound.ending();
      ended = true;
      if (node.ending.achievement) unlockAch(node.ending.achievement);
      recordEnding(node.ending.name);
      return window.Ending.show({ story, ending: node.ending, trail, ach: achStats() });
    }
    if (node.choices && node.choices.length) return appendChoices(node.choices);
    if (node.next) return goto(node.next);

    /* 兜底：编译期若又出现断链，按当前幕号推断下一幕入口，不让玩家卡在没有出口的节点上 */
    const actNo = (x) => {
      const m = String(x).match(/^a(\d+)_/);
      return m ? +m[1] : null;
    };
    const no = actNo(id);
    if (no && no < 5 && play.nodes[`a${no + 1}_n1`]) {
      addNarration("（剧情在这里拐了个弯，继续往深处走去……）");
      return goto(`a${no + 1}_n1`);
    }
    /* 确实走到了没有出路的地方：给一个可收束的结局，而不是白屏卡死 */
    ended = true;
    return window.Ending.show({
      story,
      ending: { name: "未完的戏", quote: "故事似乎还欠一个结尾，也许下一次入戏会补上。" },
      trail,
      ach: achStats(),
    });
  }

  /* 点击剧情区：跳过打字 / 提前唤醒段间等待 */
  el.stream.addEventListener("click", () => {
    if (finishTyping()) return;
    if (wake) { const r = wake; wake = null; r(); }
  });

  /* 键盘 1-3 选选项 */
  document.addEventListener("keydown", (e) => {
    if (!play || !el.viewGame.classList.contains("active")) return;
    if (/^[1-3]$/.test(e.key)) {
      const btns = [...el.inner.querySelectorAll(".msg-choices:last-child .choice-btn:not(.dimmed):not(.picked)")];
      const b = btns[+e.key - 1];
      if (b) b.click();
    }
  });

  /* ---------- 自由输入（常驻） ---------- */
  let busy = false;
  async function sendFree() {
    if (window.__ruxiMode === "ai") return; // AI 演绎模式时让路（game-ai.js 也绑了同一输入框）
    const text = el.freeInput.value.trim();
    if (!text || busy || !play || ended) return;
    busy = true; el.freeSend.disabled = true;
    el.freeInput.value = "";
    await addSay("我", text, true, playToken);
    window.Stage.Typing.show(lastNpc, "正在回应"); // B1 等待演出化
    try {
      const r = await API.say({
        story_id: story.work_id, node_id: nodeId, text,
        recent: log.slice(-9, -1), cast: play.cast || {}, speaker: lastNpc,
      });
      window.Stage.Typing.hide();
      floatHint(`${r.speaker} 回应了你`);
      await addSay(r.speaker, r.reply, false, playToken);
    } catch (e) {
      window.Stage.Typing.hide();
      floatHint(e.message ? `⚠ ${e.message}` : "对方似乎没听见……", true);
    }
    busy = false; el.freeSend.disabled = false;
    el.freeInput.focus();
  }
  el.freeSend.addEventListener("click", sendFree);
  el.freeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendFree(); });

  /* ---------- 对外入口 ---------- */
  function setStageBackground(src) {
    const fallback = String(src || "");
    el.stageBg.style.backgroundImage = fallback ? `url("${fallback}")` : "";
    const webp = fallback.replace(/\.jpe?g($|[?#])/i, ".webp$1");
    if (webp !== fallback && window.CSS?.supports?.("background-image", `image-set(url("${webp}") type("image/webp"), url("${fallback}") type("image/jpeg"))`)) {
      el.stageBg.style.backgroundImage = `image-set(url("${webp}") type("image/webp"), url("${fallback}") type("image/jpeg"))`;
    }
  }
  async function start(storyMeta) {
    if (starting) return; // 大厅快速双击防重入
    starting = true;
    try {
      story = storyMeta;
      setStageBackground(storyMeta.cover_large || storyMeta.cover);
      el.stageTitle.innerHTML = `正在入戏 · <b>${storyMeta.title}</b> ／ 原著 · ${storyMeta.author}`;
      trail = []; log = []; lastNpc = "对方"; unlocked = new Set(); ended = false;
      el.inner.innerHTML = "";
      play = await API.getPlay(storyMeta.work_id);
      show("view-game");
      showModeSelect();
    } catch (e) {
      show("view-hall");
      alert("这本的剧本还在排演中，先体验其他故事吧。");
    } finally {
      starting = false;
    }
  }

  /* ---------- 模式选择（剧情 / AI 演绎，撕票式票根） ---------- */
  function showModeSelect() {
    $("modeStory").textContent = `《${story.title}》`;
    $("modeAuthor").textContent = `原著 · ${story.author} ｜ 官方授权改编 · AI 补全后续`;
    $("ticketStoryDesc").textContent = play.logline || "官方授权原著 + 精排演的分支剧本。你的抉择决定走向，解锁不同结局与成就。";
    const aiOk = window.GameAI && window.GameAI.available(story.work_id);
    $("modeAiBtn").classList.toggle("locked", !aiOk);
    const aiCount = Number(window.__ruxiAiCount || 0);
    const aiCountEl = document.getElementById("ticketAiCount");
    if (aiCountEl) aiCountEl.textContent = aiCount + " 篇已就绪";
    $("ticketAiDesc").textContent = aiOk
      ? "AI 实时即兴演绎：你说的每句话都真正影响角色态度与剧情走向。"
      : "这一篇的 AI 演绎还在筹备中，先看剧情模式吧。";
    $("modeOverlay").classList.add("show");
    requestAnimationFrame(() => $("modeStoryBtn")?.focus());
  }

  $("modeStoryBtn").addEventListener("click", async () => {
    $("modeOverlay").classList.remove("show");
    window.__ruxiMode = "story"; // 模式守卫：AI 演绎的输入监听器让路
    // 剧情模式只有编排好的选项：同时隐藏并禁用自由输入，避免文案暗示“可以自由聊天”。
    $("inputBar").style.display = "none";
    $("freeInput").disabled = true;
    $("freeSend").disabled = true;
    $("freeInput").placeholder = "剧情模式请点击选项推进";
    // 先开幕再手册：舞台亮起后手册才浮现（节目单时刻），点"开演"直接开演
    await window.Stage.curtainShow(story.title, "剧情模式 · 开演");
    window.Stage.dotsSet(1);
    API.track("game_start", { story_id: story.work_id, mode: "story" }); // 埋点：开演
    showPrologue();
  });

  $("modeAiBtn").addEventListener("click", () => {
    if (window.GameAI && window.GameAI.available(story.work_id)) {
      // AI 演绎模式（当前开放首篇）
      $("modeOverlay").classList.remove("show");
      window.GameAI.start(story);
    } else {
      const card = $("modeAiBtn");
      card.style.borderColor = "var(--accent)";
      setTimeout(() => (card.style.borderColor = ""), 700);
      floatHint("这一篇的 AI 演绎还在筹备中，先去已开放的几篇体验吧");
    }
  });

  /* 开局前置：背景故事 + 角色介绍，点击"开始入戏"才开演 */
  function showPrologue() {
    const p = play.prologue || {};
    $("prologueStory").textContent = `《${story.title}》`;
    $("prologueAuthor").textContent = `原著 · ${story.author} ｜ 官方授权改编 · AI 补全后续`;
    $("prologueBg").textContent = p.background || (play.logline || story.labels.join("、") + "题材。剧情即将展开……");
    $("prologueRole").textContent = p.role || `你将以第一人称扮演故事主角"我"，亲历这段剧情。`;
    $("prologueTip").textContent = p.tip || "玩法：剧情自动展开，点击画面可加速；遇到抉择做出你的选择。剧情模式不开放自由输入，想即兴对话可选择 AI 演绎。";
    $("prologueOverlay").classList.add("show");
    requestAnimationFrame(() => $("btnEnterPlay")?.focus());
  }

  /* 开局前置：背景故事 + 角色介绍，点击"开始入戏"才开演。
     onEnter 可被其他模式（如 AI 演绎）临时接管，用后即焚 */
  let onEnter = null;
  $("btnEnterPlay").addEventListener("click", () => {
    $("prologueOverlay").classList.remove("show");
    if (onEnter) { const f = onEnter; onEnter = null; f(); return; }
    // 剧情模式：大幕已在撕票后开过（先开幕再手册），这里直接开演
    goto(play.start);
  });

  /* ---------- 存档续演（saves.js 调用）：跳过选模式/手册，直接续到存档节点 ---------- */
  async function resumeFromSave(storyMeta, sv) {
    if (starting) return;
    starting = true;
    try {
      story = storyMeta;
      setStageBackground(storyMeta.cover_large || storyMeta.cover);
      el.stageTitle.innerHTML = `正在入戏 · <b>${storyMeta.title}</b> ／ 原著 · ${storyMeta.author}`;
      trail = Array.isArray(sv.trail) ? sv.trail.slice(-8) : [];
      log = []; lastNpc = "对方"; unlocked = new Set(); ended = false;
      el.inner.innerHTML = "";
      play = await API.getPlay(storyMeta.work_id);
      window.__ruxiMode = "story";
      document.getElementById("aiHud")?.remove();
      $("inputBar").style.display = "none";
      const target = play.nodes[sv.node_id] ? sv.node_id : play.start; // 节点失效则回开头
      show("view-game");
      await window.Stage.curtainShow(storyMeta.title, "剧情模式 · 续演");
      const am = String(target).match(/^a(\d+)_/);
      if (am) window.Stage.dotsSet(Math.min(+am[1], 3));
      API.track("game_start", { story_id: storyMeta.work_id, mode: "story", resumed: true });
      goto(target);
    } catch (e) {
      show("view-hall");
      alert("这份存档的剧本暂时取不到，先看看别的戏吧。");
    } finally {
      starting = false;
    }
  }

  function back() {
    playToken++; play = null; story = null; ended = false;
    window.__ruxiMode = null; // 清除模式守卫
    document.getElementById("aiHud")?.remove(); // 移除 AI 演绎 HUD，避免残留到剧情模式
    $("inputBar").style.display = ""; // 恢复输入区（下次按模式重新决定显隐）
    $("freeInput").disabled = false;
    $("freeSend").disabled = false;
    $("freeInput").placeholder = "对角色说点什么……";
    $("prologueOverlay").classList.remove("show");
    $("modeOverlay").classList.remove("show");
    show("view-hall");
  }
  function show(id) {
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    $(id).classList.add("active");
    if (id === "view-game") el.freeInput.focus();
  }

  window.Game = { start, back, resumeFromSave, setEnterHandler: (fn) => (onEnter = fn), get current() { return story ? { story, play, node_id: nodeId, trail: trail.slice() } : null; } };
})();
