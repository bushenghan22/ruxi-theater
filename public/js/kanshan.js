/* kanshan.js —— 问看山面板（知乎直答）
   上下文感知：知道玩家正在体验哪篇小说；回答做 markdown 渲染。 */
(function () {
  const $ = (id) => document.getElementById(id);
  const fab = $("kanshanFab"), panel = $("kanshanPanel"), log = $("kanshanLog");
  const input = $("kanshanInput"), send = $("kanshanSend");
  const status = $("kanshanStatus"), intro = $("kanshanIntro");
  let available = null;

  function renderAvailability(ok, detail = "") {
    available = !!ok;
    fab.classList.toggle("unavailable", !available);
    send.disabled = !available;
    input.disabled = !available;
    if (status) status.textContent = available
      ? "知乎直答在线 · 每日额度 100 次"
      : "看山暂不可用" + (detail ? " · " + detail : " · 未检测到直答服务");
    if (intro) intro.textContent = available
      ? "我是看山。卡关、看不懂伏笔、想知道背景设定，都可以问我（基于知乎直答）。"
      : "看山当前不可用。请先启动知乎直答服务，或稍后再试。";
  }

  async function checkAvailability() {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      const data = await r.json();
      renderAvailability(data.kanshan_cli === true, data.kanshan_cli === false ? "未安装知乎直答命令行" : "");
    } catch {
      renderAvailability(false, "无法连接本地服务");
    }
  }

  fab.addEventListener("click", () => {
    panel.classList.toggle("open");
    if (panel.classList.contains("open")) {
      checkAvailability();
      if (available !== false) input.focus();
    }
  });
  $("kanshanClose").addEventListener("click", () => panel.classList.remove("open"));
  checkAvailability();

  /* 当前游玩上下文（哪篇小说） */
  function currentStoryTitle() {
    try { return window.Game && window.Game.current ? window.Game.current.story.title : ""; } catch { return ""; }
  }
  function currentStoryAuthor() {
    try { return window.Game && window.Game.current ? window.Game.current.story.author : ""; } catch { return ""; }
  }

  /* ---------- 迷你 markdown 渲染（零依赖，先转义再渲染） ---------- */
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function inline(s) {
    return s
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }
  function mdRender(src) {
    const lines = esc(src).split(/\r?\n/);
    const out = [];
    let list = null; // "ul" | "ol" | null
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) { closeList(); continue; }
      let m;
      if ((m = line.match(/^#{1,6}\s+(.*)$/))) {
        closeList();
        const level = m[1].length <= 2 ? 3 : 4;
        out.push(`<h${level}>${inline(m[1])}</h${level}>`);
      } else if ((m = line.match(/^[-*•]\s+(.*)$/))) {
        if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
        out.push(`<li>${inline(m[1])}</li>`);
      } else if ((m = line.match(/^(\d+)[.、)]\s+(.*)$/))) {
        if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
        out.push(`<li>${inline(m[2])}</li>`);
      } else {
        closeList();
        out.push(`<p>${inline(line)}</p>`);
      }
    }
    closeList();
    return out.join("");
  }

  function addMsg(cls, html) {
    const d = document.createElement("div");
    d.className = "kanshan-msg " + cls;
    d.innerHTML = html;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  let busy = false;
  async function ask() {
    const q = input.value.trim();
    if (!q || busy) return;
    if (available === false) {
      addMsg("bot", "看山当前不可用，请先启动知乎直答服务后再试。");
      return;
    }
    busy = true; send.disabled = true;
    input.value = "";
    addMsg("user", esc(q));
    const title = currentStoryTitle();
    const loading = addMsg("bot", title ? `看山正在查《${title}》的相关内容……` : "看山翻阅知乎中……");
    try {
      const r = await fetch("/api/kanshan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, story_title: title, story_author: currentStoryAuthor() }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || "回答失败");
      loading.remove();
      addMsg("bot", mdRender(data.answer));
    } catch (e) {
      loading.textContent = "⚠ " + (e.message || "看山暂时不可用，请稍后重试");
    }
    busy = false; send.disabled = false;
  }
  send.addEventListener("click", ask);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") ask(); });
})();
