/* saves.js —— 存档戏折：手动 5 档存读档（剧情模式 + AI 演绎通用）
   - 顶栏「继续上次」→ 存档面板：最近一档一键续演 + 5 档管理（读取/存入/删除）
   - 存储在 localStorage["ruxi-saves-v1"]；与两模式的自动续局互不干扰 */
(function () {
  const $ = (id) => document.getElementById(id);
  const KEY = "ruxi-saves-v1";
  const MAX = 5;
  const SLOT_CN = ["一", "二", "三", "四", "五"];
  let metaList = []; // 故事元数据缓存（续演时取最新封面等）

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const list = () => { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; } };
  const write = (arr) => { try { localStorage.setItem(KEY, JSON.stringify(arr.slice(0, MAX))); } catch {} };

  function fmtTime(ts) {
    const d = new Date(ts), p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function slotAct(sv) {
    if (sv.mode === "ai" && sv.state) return `第${sv.state.act || 1}幕 · 回合 ${sv.state.turn || 0}`;
    const m = String(sv.node_id || "").match(/^a(\d+)_/);
    return m ? `第${Math.min(+m[1], 3)}幕 · 进行中` : "剧情进行中";
  }

  /* 当前正在进行的局：游戏页激活、过场浮层都关着，才可「存入」 */
  function currentRun() {
    if (!$("view-game").classList.contains("active")) return null;
    if ($("prologueOverlay").classList.contains("show") || $("modeOverlay").classList.contains("show")) return null;
    if (window.__ruxiMode === "ai" && window.GameAI?.snapshot) {
      const s = window.GameAI.snapshot();
      if (s) return { mode: "ai", story_id: s.story_id, title: s.title, author: s.author, cover: s.cover, state: s.state };
    }
    if (window.__ruxiMode === "story" && window.Game?.current) {
      const c = window.Game.current;
      if (c.node_id) return { mode: "story", story_id: c.story.work_id, title: c.story.title, author: c.story.author, cover: c.story.cover, node_id: c.node_id, trail: c.trail };
    }
    return null;
  }

  async function findMeta(sv) {
    if (!metaList.length) { try { metaList = (await API.listStories()).stories || []; } catch { /* 离线兜底 */ } }
    return metaList.find((x) => x.work_id === sv.story_id) ||
      { work_id: sv.story_id, title: sv.title, author: sv.author, cover: sv.cover };
  }

  /* 续演：AI 存档写回自动续局槽后走 GameAI.start（手册确认后接续）；
     剧情存档直接跳进存档节点 */
  async function resume(sv) {
    $("saveOverlay").classList.remove("show");
    const meta = await findMeta(sv);
    if (sv.mode === "ai") {
      try { localStorage.setItem("ruxi-ai-save", JSON.stringify({ story_id: sv.story_id, state: sv.state })); } catch {}
      window.GameAI.start(meta);
    } else {
      window.Game.resumeFromSave(meta, sv);
    }
  }

  function saveTo(slotId) {
    const run = currentRun();
    if (!run) return;
    const arr = list();
    const sv = { id: slotId, time: Date.now(), ...run };
    const i = arr.findIndex((s) => s.id === slotId);
    if (i >= 0) arr[i] = sv; else arr.push(sv);
    write(arr);
    render();
  }

  function remove(slotId) {
    write(list().filter((s) => s.id !== slotId));
    render();
  }

  /* ---------- 渲染 ---------- */
  function render() {
    const arr = list();
    const run = currentRun();

    /* 最近一档 = 一键续演主按钮 */
    const latest = arr.slice().sort((a, b) => b.time - a.time)[0];
    const hero = $("saveResumeBtn");
    if (latest) {
      hero.disabled = false;
      hero.innerHTML = `<span class="sr-go">▶</span> 继续上次 ·《${esc(latest.title)}》<i>${esc(slotAct(latest))} · ${fmtTime(latest.time)}</i>`;
      hero.onclick = () => resume(latest);
    } else {
      hero.disabled = true;
      hero.innerHTML = `<span class="sr-go">▶</span> 还没有存档 —— 开演后在档位里「存入」即可`;
      hero.onclick = null;
    }

    /* 5 个档位 */
    $("saveSlots").innerHTML = Array.from({ length: MAX }, (_, i) => {
      const id = i + 1, sv = arr.find((s) => s.id === id);
      const ops = [];
      if (sv) ops.push(`<button class="slot-btn read" data-act="read" data-slot="${id}">读取</button>`);
      if (run) ops.push(`<button class="slot-btn write" data-act="write" data-slot="${id}">存入</button>`);
      if (sv) ops.push(`<button class="slot-btn del" data-act="del" data-slot="${id}">删除</button>`);
      return `<div class="save-slot${sv ? "" : " empty"}">
        <div class="slot-stub">档${SLOT_CN[i]}</div>
        <div class="slot-body">${sv
          ? `<div class="slot-head"><b>《${esc(sv.title)}》</b><span class="slot-badge${sv.mode === "ai" ? " ai" : ""}">${sv.mode === "ai" ? "AI 演绎" : "剧情模式"}</span></div>
             <div class="slot-meta">${esc(slotAct(sv))} ｜ 存于 ${fmtTime(sv.time)}</div>`
          : `<div class="slot-head"><b>空档位</b></div><div class="slot-meta">${run ? "把当前进度存进这一档" : "开演后可存入当前进度"}</div>`}
        </div>
        <div class="slot-ops">${ops.join("")}</div>
      </div>`;
    }).join("");
  }

  /* ---------- 事件 ---------- */
  $("saveMgrBtn").addEventListener("click", () => {
    render();
    $("saveOverlay").classList.add("show");
    requestAnimationFrame(() => ($("saveResumeBtn").disabled ? $("saveClose") : $("saveResumeBtn")).focus());
  });
  $("saveClose").addEventListener("click", () => $("saveOverlay").classList.remove("show"));
  $("saveOverlay").addEventListener("click", (e) => {
    if (e.target.id === "saveOverlay") $("saveOverlay").classList.remove("show");
  });
  $("saveSlots").addEventListener("click", (e) => {
    const b = e.target.closest(".slot-btn");
    if (!b) return;
    const id = +b.dataset.slot;
    if (b.dataset.act === "read") {
      const sv = list().find((s) => s.id === id);
      if (sv) resume(sv);
    } else if (b.dataset.act === "write") {
      saveTo(id);
    } else if (b.dataset.act === "del") {
      if (b.dataset.armed) remove(id); // 二次点击确认，防手滑
      else {
        b.dataset.armed = "1"; b.textContent = "确认？";
        setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = "删除"; } }, 5000);
      }
    }
  });

  window.Saves = { render };
})();
