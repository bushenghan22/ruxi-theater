/* game-ai.js —— AI 演绎模式引擎（导演 Agent + 目标状态机）
   状态常驻前端（localStorage 可续局）；后端 /api/director 无会话。
   结算规则：LLM 提议，代码拍板。详见 docs/AI演绎模式技术方案.md */
(function () {
  const $ = (id) => document.getElementById(id);
  const el = {
    stream: $("stream"), inner: $("streamInner"),
    freeInput: $("freeInput"), freeSend: $("freeSend"), inputBar: $("inputBar"),
    floatHints: $("floatHints"), stageTitle: $("stageTitle"), stageBg: $("stageBg"),
  };

  const END_KEY = "ruxi-endings", SAVE_KEY = "ruxi-ai-save";
  const clamp = (v) => Math.max(0, Math.min(100, v));

  /* AI 演绎篇目自动发现：以服务端 /api/stories 的 stats[.ai] 为准（data/ai-mode/ 目录即已开放），
     hall.js 渲染时会写入 window.__ruxiStats；未就绪时兜底拉取一次 */
  let statsLoading = false;
  function ensureStats() {
    if (statsLoading || window.__ruxiStats) return;
    statsLoading = true;
    API.listStories().then(({ stats }) => { window.__ruxiStats = stats; statsLoading = false; })
      .catch(() => { statsLoading = false; });
  }
  function available(storyId) {
    const st = window.__ruxiStats;
    if (st && st[storyId]) return !!st[storyId].ai;
    ensureStats();
    return false;
  }

  let cfg = null, story = null, state = null, act = null;
  let busy = false, ended = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- 滚动流（复用剧情模式 DOM） ---------- */
  function nearBottom() { return el.stream.scrollHeight - el.stream.scrollTop - el.stream.clientHeight < 140; }
  function scrollDown(force) { if (force || nearBottom()) el.stream.scrollTop = el.stream.scrollHeight; }
  function addNarration(text) {
    const d = document.createElement("div");
    d.className = "msg-narration"; d.textContent = text;
    el.inner.appendChild(d); scrollDown();
  }
  async function addSay(speaker, text, mine) {
    const wrap = document.createElement("div");
    wrap.className = "msg-say" + (mine ? " mine" : "");
    wrap.innerHTML = `<span class="msg-name"></span><div class="msg-bubble"><span class="txt"></span></div>`;
    wrap.querySelector(".msg-name").textContent = speaker;
    el.inner.appendChild(wrap);
    const txt = wrap.querySelector(".txt");
    if (mine) { txt.textContent = text; Sound.msg(false); scrollDown(); return; }
    const caret = document.createElement("span"); caret.className = "dialog-caret"; txt.appendChild(caret);
    // 打字机：标点停顿，念台词的呼吸感
    const PAUSE = { "，": 170, "、": 150, "。": 230, "！": 230, "？": 230, "…": 200, "；": 190, "：": 150 };
    let i = 0;
    await new Promise((r) => {
      let timer;
      const step = () => {
        i += 1; txt.textContent = text.slice(0, i); Sound.type();
        if (i >= text.length) { caret.remove(); Sound.msg(false); r(); return; }
        scrollDown();
        timer = setTimeout(step, PAUSE[text[i - 1]] || 40);
      };
      timer = setTimeout(step, 40);
    });
  }

  /* ---------- HUD ---------- */
  /* 数值显示名按篇配置（每篇 AI 配置自己的语义标签） */
  const statNames = () => (cfg && cfg.stat_names) || { trust: "信任", danger: "危机", sincerity: "坦白" };
  const defaultSpeaker = () => {
    const configured = cfg && (cfg.default_speaker || cfg.npc_default);
    if (configured && cfg.cast && cfg.cast[configured]) return configured;
    return Object.keys((cfg && cfg.cast) || {})[0] || "对方";
  };

  const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const statKeyFor = (label) => {
    const names = statNames();
    return Object.keys(names).find((key) => key === label || names[key] === label) || null;
  };
  const statEntries = () => Object.keys(statNames()).map((key) => ({ key, labels: [key, statNames()[key]].filter(Boolean) }));

  /* 读取配置中的自然语言条件（如“信任 ≥ 75 且 坦白 ≥ 50”）。
     这样过幕与结局都由 AI 配置决定，不再把某一篇故事的角色名/数值写死在引擎里。 */
  function conditionAtom(atom, contextAct = null) {
    const text = String(atom || "").trim();
    if (!text) return false;

    /* 先解析数值条件，再解析 flag 语义。
       “trust 达到 60”里的“达到”是比较操作符，不能先被自然语言 flag 分支截走。 */
    for (const { key, labels } of statEntries()) {
      const label = labels.map(escapeRegExp).join("|");
      const m = text.match(new RegExp(`(?:${label})\\s*(?:达到|至少|不低于|大于等于|不小于|大于|≥|>=|>|低于|小于|不超过|≤|<=|<)?\\s*(\\d+)(?:\\s*[-—~至]\\s*(\\d+))?`));
      if (!m || state?.stats?.[key] === undefined) continue;
      const value = +state.stats[key], first = +m[1], second = m[2] == null ? null : +m[2];
      const before = text.slice(0, m.index + m[0].length);
      const opMatch = before.match(/(达到|至少|不低于|大于等于|不小于|大于|≥|>=|>|低于|小于|不超过|≤|<=|<)\s*\d+(?:\s*[-—~至]\s*\d+)?$/);
      const op = opMatch ? opMatch[1] : (second != null ? "range" : ">=");
      if (op === "range") return value >= first && value <= second;
      if (["低于", "小于", "<"].includes(op)) return value < first;
      if (["不超过", "≤", "<="].includes(op)) return value <= first;
      if ([">" , "大于"].includes(op)) return value > first;
      return value >= first;
    }

    if (!Array.isArray(state?.flags)) return false;

    /* 显式 flag：支持 flag 'evidence_given' 与中文引号写法。 */
    const explicitFlag = text.match(/flag\s*[`'“”‘’]([^`'“”‘’]+)[`'“”‘’]/i);
    if (explicitFlag) return state.flags.includes(explicitFlag[1].trim());
    const quoted = text.match(/[\u0027\u2018\u2019\u201c\u201d]([^\u0027\u2018\u2019\u201c\u201d]+)[\u0027\u2018\u2019\u201c\u201d]/);
    if (quoted && state.flags.includes(quoted[1].trim())) return true;

    /* 自然语言 flag（如“让崇祯说出‘说下去’”）来自当前幕配置。
       每幕通常只有一个 flag；多 flag 时只有在文案明确提到 flag/token 才命中，避免串条件。 */
    const semantic = /(达成|说出|确认|抓到|找到|拿到|识破|攒齐|查明|形成|听进|救出|守住|护住|问出)/.test(text);
    const contextFlags = Array.isArray(contextAct?.flags) ? contextAct.flags.filter((f) => f?.flag) : [];
    if (semantic && contextFlags.length === 1) return state.flags.includes(contextFlags[0].flag);
    if (contextFlags.length > 1) {
      return contextFlags.some((f) => text.includes(f.flag) && state.flags.includes(f.flag));
    }
    return false;
  }
  function conditionText(text, contextAct = null) {
    const raw = String(text || "").replace(/[（）()]/g, "");
    if (!raw) return false;
    return raw.split(/或/).some((orPart) =>
      orPart.split(/(?:且|并且)/).every((andPart) => conditionAtom(andPart, contextAct))
    );
  }
  function finalEnding() {
    const endings = cfg?.endings?.act3 || [];
    return endings.find((ending) => ending && conditionText(ending.cond)) || endings[endings.length - 1] || {
      name: "未完的戏", quote: "故事还在等待一个结尾。"
    };
  }
  function failEndingFor(actNo = state.act) {
    return cfg?.endings?.fail?.find((ending) => ending.act === actNo) || cfg?.acts?.[actNo - 1]?.fail_ending || {
      name: "演出中止", quote: "这一幕暂时无法继续。"
    };
  }
  function nextActNo() {
    const ref = act?.success_to;
    if (ref) {
      const m = String(ref).match(/(?:act|a)?\s*(\d+)/i);
      if (m) return +m[1];
    }
    return state.act + 1;
  }
  function renderHUD() {
    let hud = document.getElementById("aiHud");
    if (!hud) { hud = document.createElement("div"); hud.id = "aiHud"; hud.className = "ai-hud"; document.querySelector(".stage-top").after(hud); }
    const a = cfg.acts[state.act - 1];
    const sn = statNames();
    hud.innerHTML = `
      <span class="ai-hud-goal" title="${a.goal_detail || a.goal}">🎯 ${a.goal}</span>
      <span class="ai-hud-stat">${sn.trust} <b class="${state.stats.trust >= 50 ? "hi" : "lo"}">${state.stats.trust}</b></span>
      <span class="ai-hud-stat">${sn.danger} <b class="${state.stats.danger >= 80 ? "hi bad" : "lo"}">${state.stats.danger}</b></span>
      <span class="ai-hud-stat">${sn.sincerity} <b>${state.stats.sincerity}</b></span>
      <span class="ai-hud-turn">第${state.act}幕 · 回合 ${state.turn}/${a.turn_limit}</span>
      <button class="ai-hud-restart" id="aiRestart" title="清空进度，重新开始" aria-label="清空进度，重新开始">↺</button>`;
    document.getElementById("aiRestart").onclick = () => {
      if (ended || busy) return;
      clearSave();
      el.inner.innerHTML = "";
      ended = false; busy = false;
      state = { act: 1, turn: 0, stats: { ...cfg.stats_init }, flags: [], memory: [] };
      enterAct(1);
    };
  }

  function floatHint(text, bad) {
    const t = document.createElement("div");
    t.className = "float-hint" + (bad ? " bad" : "");
    t.textContent = text;
    el.floatHints.appendChild(t);
    Sound.hint(!bad);
    setTimeout(() => t.remove(), 2400);
  }

  /* ---------- 存档 ---------- */
  function save() { try { localStorage.setItem(SAVE_KEY, JSON.stringify({ story_id: story.work_id, state })); } catch {} }
  function loadSave() {
    try {
      const sv = JSON.parse(localStorage.getItem(SAVE_KEY) || "null");
      // 兼容旧存档：memory 曾经是字符串数组，统一迁移为 {t, who, text}
      if (sv?.state?.memory) sv.state.memory = sv.state.memory.map((m) => (typeof m === "string" ? { t: 0, who: "记忆", text: m } : m));
      return sv;
    } catch { return null; }
  }
  function clearSave() { try { localStorage.removeItem(SAVE_KEY); } catch {} }

  /* ---------- 结局 ---------- */
  function recordEnding(name) {
    try {
      const store = JSON.parse(localStorage.getItem(END_KEY) || "{}");
      const arr = store[story.work_id] = store[story.work_id] || [];
      if (!arr.includes(name)) arr.push(name);
      localStorage.setItem(END_KEY, JSON.stringify(store));
    } catch {}
  }
  function judgeFinal() {
    return finalEnding();
  }
  function finish(ending) {
    ended = true;
    ending = ending || failEndingFor();
    recordEnding(ending.name);
    API.track("ending", { story_id: story.work_id, mode: "ai", ending: ending.name, act: state.act }); // 埋点：结局
    clearSave();
    Sound.ending();
    window.Ending.show({
      story,
      ending: { name: ending.name, quote: ending.quote },
      trail: state.memory.slice(-4).map((m) => (typeof m === "string" ? m : m.text)),
      ach: { unlocked: 0, total: 0, thisRun: 0 },
    });
  }

  /* ---------- 幕 ---------- */
  async function enterAct(no, silent) {
    state.act = no; state.turn = 0;
    act = cfg.acts[no - 1];
    if (!act) return finish(finalEnding());
    save(); renderHUD();
    // 幕间转场：合幕 → 幕卡 → 开幕（开场幕由"开演"大幕负责，silent 跳过）
    if (!silent) await window.Stage.curtainShow(`第${["一", "二", "三"][no - 1]}幕 · ${act.name}`, "幕 间");
    window.Stage.dotsSet(no);
    addNarration(`—— 第${["一", "二", "三"][no - 1]}幕 · ${act.name} ——`);
    addNarration(`本幕目标：${act.goal}（回合上限 ${act.turn_limit}）`);
    // 详细目标：处境 + 要做的事 + 达成/失败判据 + 策略提示
    if (act.goal_detail) addNarration(act.goal_detail);
    for (const seg of act.opening) {
      if (seg.type === "narration") addNarration(seg.text);
      else await addSay(seg.speaker, seg.text, false);
      await sleep(500);
    }
    if (no === 1) await maybeTutorial(); // 首回合交互教学（产品 #3）
    el.freeInput.focus();
  }

  /* ---------- 首回合交互教学：按篇配置逐条演出，最后引导玩家实际输入一次 ---------- */
  async function maybeTutorial() {
    if (state.tutorialDone || !Array.isArray(cfg.tutorial) || !cfg.tutorial.length) return;
    for (const seg of cfg.tutorial) {
      if (seg.type === "narration") addNarration(seg.text);
      else await addSay(seg.speaker || defaultSpeaker(), seg.text, false);
      await sleep(420);
    }
    let bar = document.getElementById("tutBar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "tutBar"; bar.className = "tut-bar";
      el.inputBar.before(bar);
    }
    bar.innerHTML = `<span class="tut-tip">🎯 ${cfg.tutorial_hint || "照上面的格式试一句吧"}</span><button class="tut-skip" id="tutSkip">跳过教学</button>`;
    document.getElementById("tutSkip").onclick = () => endTutorial(false);
  }
  function endTutorial(learned) {
    state.tutorialDone = true; save();
    document.getElementById("tutBar")?.remove();
    if (learned) floatHint("✓ 学会了！正式开演");
  }

  /* 幕目标判定（代码拍板）：success / fail / ongoing */
  function judgeActGoal() {
    const names = statNames();
    const dangerKey = Object.keys(state.stats).find((key) => key === "danger" || /危机|腐化|压力|穿帮/.test(names[key] || ""));
    const trustKey = Object.keys(state.stats).find((key) => key === "trust" || /信任|道心|好感|家人缘|声望|威望|羁绊|善念|真爱/.test(names[key] || ""));
    if ((dangerKey && state.stats[dangerKey] >= 100) || (trustKey && state.stats[trustKey] <= 0)) return "fail";
    if (state.act >= cfg.acts.length) return lastTurn() ? "success" : "ongoing";
    return conditionText(act.success_hint, act) ? "success" : "ongoing";
  }
  const lastTurn = () => state.turn >= act.turn_limit;

  /* 最近一位发言的 NPC；没有历史记录时回到本篇配置的默认角色。 */
  function lastNpcSpeaker() {
    for (let i = state.memory.length - 1; i >= 0; i--) {
      const m = state.memory[i];
      if (typeof m === "object" && m.who && m.who !== "我") return m.who;
    }
    return defaultSpeaker();
  }

  /* ---------- 回合 ---------- */
  async function turn(playerText) {
    if (busy || ended) return;
    busy = true; el.freeSend.disabled = true;
    const stateBefore = JSON.parse(JSON.stringify(state));
    const domCountBefore = el.inner.childElementCount;
    state.turn++;
    await addSay("我", playerText, true);
    save(); renderHUD();
    window.Stage.Typing.show(lastNpcSpeaker(), "正在演绎"); // B1 等待演出化
    try {
      const r = await fetch("/api/director", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 精简 payload：goal/cast/facts/world_bible/flags_menu 全部由服务端读配置（事实源唯一，防伪造）
        body: JSON.stringify({
          story_id: story.work_id,
          state: {
            act: state.act, turn: state.turn,
            trust: state.stats.trust, danger: state.stats.danger,
            sincerity: state.stats.sincerity, flags: state.flags,
          },
          recent: state.memory.slice(-10).map((m) => (typeof m === "string" ? { speaker: "记忆", text: m } : { speaker: m.who, text: m.text })),
          text: playerText,
          speaker: lastNpcSpeaker(),
        }),
      });
      const data = await r.json();
      window.Stage.Typing.hide();
      if (!r.ok) throw new Error(data.message || "导演未响应");
      if (!state.tutorialDone) endTutorial(true); // 仅在导演成功响应后结束教学，失败可完整回滚
      // 数值（代码 clamp，LLM 只提议）
      const d = data.stat_delta || {};
      const statKeys = Object.keys(statNames());
      for (const k of statKeys) {
        const dv = Math.max(-15, Math.min(15, +d[k] || 0));
        if (dv) {
          state.stats[k] = clamp(state.stats[k] + dv);
          floatHint(`${statNames()[k]} ${dv > 0 ? "+" : ""}${dv}`, dv < 0 && k !== "danger");
        }
      }
      for (const f of data.new_flags || []) if (!state.flags.includes(f)) state.flags.push(f);
      // 记忆：玩家的话（echo 优先）+ NPC 回复都入档，下一轮带给导演
      state.memory.push({ t: state.turn, who: "我", text: data.echo || playerText });
      for (const rep of data.replies || []) state.memory.push({ t: state.turn, who: rep.speaker || defaultSpeaker(), text: rep.text });
      // NPC 回应逐条演出
      for (const rep of data.replies || []) await addSay(rep.speaker || defaultSpeaker(), rep.text, false);
      // 即时坏结局：危机爆表
      const dangerKey = Object.keys(state.stats).find((key) => key === "danger" || /危机|腐化|压力|穿帮/.test(statNames()[key] || ""));
      if (dangerKey && state.stats[dangerKey] >= 100) return finish(failEndingFor(state.act));
      save(); renderHUD();
      // 幕结算
      const cond = judgeActGoal();
      const gpStatus = data.goal_progress?.status;
      const failNow = cond === "fail" || gpStatus === "fail";
      const passNow = cond === "success" || gpStatus === "success";
      if (failNow) return finish(failEndingFor(state.act));
      if (passNow || lastTurn()) {
        if (state.act >= cfg.acts.length) return finish(judgeFinal());
        floatHint("🎯 本幕目标达成");
        API.track("act_clear", { story_id: story.work_id, mode: "ai", act: state.act }); // 埋点：过幕
        await sleep(700);
        await enterAct(nextActNo());
        busy = false; el.freeSend.disabled = false; // 进新幕后解锁输入，否则卡死
        el.freeInput.focus();
        return;
      }
    } catch (e) {
      window.Stage.Typing.hide();
      state = stateBefore;
      act = cfg.acts[state.act - 1];
      while (el.inner.childElementCount > domCountBefore) el.inner.lastElementChild.remove();
      save(); renderHUD();
      el.freeInput.value = playerText;
      floatHint(`⚠ ${e.message || "导演未响应，稍后再试"}`, true);
    }
    busy = false; el.freeSend.disabled = false;
    el.freeInput.focus();
  }
  function submitFree() {
    if (busy || ended) return;
    if (window.__ruxiMode !== "ai") return; // 非本模式不响应（game.js 也绑了同一输入框）
    const t = el.freeInput.value.trim();
    if (!t) return;
    el.freeInput.value = "";
    turn(t);
  }
  el.freeSend.addEventListener("click", submitFree);
  el.freeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitFree(); });

  /* ---------- 对外入口 ---------- */
  /* 存档快照（saves.js 用）：导出当前局可序列化状态，供写入手动存档档位 */
  function snapshot() {
    if (window.__ruxiMode !== "ai" || !story || !state || ended) return null;
    return {
      story_id: story.work_id, title: story.title, author: story.author, cover: story.cover || "",
      state: JSON.parse(JSON.stringify(state)),
    };
  }

  async function start(storyMeta) {
    story = storyMeta; ended = false; busy = false;
    window.__ruxiMode = "ai"; // 模式守卫：剧情模式的输入监听器让路
    const stageCover = storyMeta.cover_large || storyMeta.cover || "";
    el.stageBg.style.backgroundImage = stageCover ? `url("${stageCover}")` : "";
    const stageWebp = stageCover.replace(/\.jpe?g($|[?#])/i, ".webp$1");
    if (stageWebp !== stageCover && window.CSS?.supports?.("background-image", `image-set(url("${stageWebp}") type("image/webp"), url("${stageCover}") type("image/jpeg"))`)) {
      el.stageBg.style.backgroundImage = `image-set(url("${stageWebp}") type("image/webp"), url("${stageCover}") type("image/jpeg"))`;
    }
    el.stageTitle.innerHTML = `AI 演绎 · <b>${storyMeta.title}</b> ／ 原著 · ${storyMeta.author}`;
    el.inner.innerHTML = "";
    el.inputBar.style.display = "";
    el.freeInput.disabled = false;
    el.freeSend.disabled = false;
    show("view-game"); // 先进舞台：手册稍后透出舞台背景（节目单时刻）
    document.getElementById("aiHud")?.remove();

    // 先开幕再手册：大幕动画与配置拉取并行，把网络延迟藏进演出里
    const curtain = window.Stage.curtainShow(story.title, "AI 演绎 · 开演");
    try {
      cfg = await (await fetch(`/api/ai-config/${storyMeta.work_id}`)).json();
    } catch {
      await curtain;
      window.Game.back();
      alert("这一篇的 AI 演绎配置暂时拉取不到，先看看别的戏吧。");
      return;
    }
    await curtain;

    el.freeInput.placeholder = cfg.placeholder || "台词直接说……（你的每句话都会真实影响角色态度）";
    const sv = loadSave();
    // 续局判定：turn>0，或已过幕（act>1 且 turn=0，刚进新幕就存/退的情形）——否则会误清第 2/3 幕进度
    if (sv && sv.story_id === storyMeta.work_id && (sv.state.turn > 0 || (sv.state.act || 1) > 1)) {
      state = sv.state; // 有进度默认续局；重开用 HUD 的 ↺ 按钮
    } else {
      clearSave();
      state = { act: 1, turn: 0, stats: { ...cfg.stats_init }, flags: [], memory: [] };
    }
    act = cfg.acts[state.act - 1];
    renderHUD();
    window.Stage.dotsSet(Math.min(state.act || 1, 3));

    // 详细入戏手册：舞台亮起后浮现，读设定像看布景读场刊；点"开演"直接开演
    const p = cfg.prologue || {};
    $("prologueStory").textContent = `《${story.title}》`;
    $("prologueAuthor").textContent = `原著 · ${story.author} ｜ AI 演绎模式`;
    $("prologueBg").textContent = p.background || cfg.world_bible || "";
    $("prologueRole").textContent = p.role || cfg.player_role || "你将以第一人称扮演故事主角。";
    $("prologueTip").textContent = p.tip || "台词直接说；（心声：……）为内心独白。你的每句话都会真实影响角色态度。";
    $("prologueOverlay").classList.add("show");
    requestAnimationFrame(() => $("btnEnterPlay")?.focus());
    API.track("game_start", { story_id: storyMeta.work_id, mode: "ai" }); // 埋点：开演
    window.Game.setEnterHandler(async () => {
      renderHUD();
      if (state.turn > 0) {
        // C3 续局温度：告诉玩家上次演到哪，并回放最近一轮对话帮助接戏
        addNarration(`（接续上次的演绎：第${state.act}幕 · 回合 ${state.turn}。想重开可点 HUD 右侧 ↺）`);
        const lastT = state.memory.length ? state.memory[state.memory.length - 1].t : 0;
        const replay = lastT > 0 ? state.memory.filter((m) => m.t >= lastT) : state.memory.slice(-4);
        if (replay.length) {
          addNarration("—— 上 次 演 到 ——");
          for (const m of replay) await addSay(m.who || "旁白", m.text, m.who === "我");
        }
        el.freeInput.focus();
      } else {
        await enterAct(state.act, true); // 大幕已在手册前开过：开场幕不再重复合幕
      }
    });
  }
  function resume() { show("view-game"); }
  function show(id) {
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    $(id).classList.add("active");
  }

  window.GameAI = { start, available, resume, snapshot };
})();
