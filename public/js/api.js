/* api.js —— 后端 API 客户端 */
window.API = (() => {
  // 本地回退：/api/stories 不可用时展示的保底清单
  const FALLBACK = [
    { work_id: "1654134122145320960", title: "穿越大明，我被崇祯偷听心声", author: "凉风有信", labels: ["权谋", "脑洞", "穿越"], tagline: "权谋 · 穿越", cover: "/assets/covers/1654134122145320960.jpg" },
    { work_id: "2025684191967294692", title: "蓝血", author: "桃花先生", labels: ["悬疑", "反转"], tagline: "悬疑 · 反转", cover: "/assets/covers/2025684191967294692.jpg" },
    { work_id: "2025333783608537435", title: "李冬原著：同时被两个精神病追杀", author: "写小说的秃头老张", labels: ["惊悚", "病娇"], tagline: "惊悚 · 病娇", cover: "/assets/covers/2025333783608537435.jpg" },
    { work_id: "1981680284933063553", title: "网恋对象真是霸总", author: "年年", labels: ["甜宠", "沙雕"], tagline: "甜宠 · 沙雕", cover: "/assets/covers/1981680284933063553.jpg" },
  ];

  async function listStories() {
    try {
      const res = await fetch("/api/stories");
      if (!res.ok) throw new Error("stories request failed");
      const data = await res.json();
      const stories = Array.isArray(data) ? data : data.stories;
      if (Array.isArray(stories) && stories.length) {
        return { stories: stories.map(normalizeStory), stats: data.stats || data._stats || {} };
      }
    } catch { /* fallthrough */ }
    return { stories: FALLBACK.map(normalizeStory), stats: {} };
  }

  /* 大厅卡片使用小图，舞台/结局使用大图；旧数据或离线保底没有 cover_large 时自动推导。 */
  function normalizeStory(story) {
    const cover = String(story?.cover || "");
    return { ...story, cover_large: story?.cover_large || cover.replace("/covers_small/", "/covers/") };
  }

  // 剧本数据：P0 阶段内置一份《穿越大明》演示剧本（结构与将来自动剧本化引擎一致）
  async function getPlay(storyId) {
    const res = await fetch(`/api/play/${storyId}`);
    if (!res.ok) throw new Error("play not found");
    return res.json();
  }

  // 自由输入 → 后端转发 DeepSeek（密钥仅存后端）
  async function say(payload) {
    const res = await fetch("/api/say", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(50000), // 与后端上游超时对齐，防止永久转圈
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || "say failed");
    }
    return res.json();
  }

  // 埋点上报（fire-and-forget，不阻塞交互）
  async function track(type, data = {}) {
    try {
      await fetch("/api/track", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, ...data }), keepalive: true,
      });
    } catch { /* 埋点失败静默 */ }
  }

  return { listStories, getPlay, say, track };
})();
