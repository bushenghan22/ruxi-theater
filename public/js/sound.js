/* sound.js —— WebAudio 合成音效（零素材、零版权风险）
   音效：打字 tick / 消息出现 / 选项点击 / 飘字 / 结局琶音
   开关：右上角 🔊 按钮，状态存 localStorage */
(function () {
  let ctx = null;
  let enabled = localStorage.getItem("ruxi-sound") !== "off";
  let lastType = 0;

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  /* 基础音：oscillator + gain 包络 */
  function tone(freq, dur, { type = "sine", gain = 0.12, slide = 0, delay = 0 } = {}) {
    if (!enabled) return;
    const c = ac(); if (!c) return;
    const t0 = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  window.Sound = {
    get on() { return enabled; },
    toggle() {
      enabled = !enabled;
      localStorage.setItem("ruxi-sound", enabled ? "on" : "off");
      if (enabled) this.click();
      return enabled;
    },
    /* 打字机：每 ~70ms 至多一响，随机微移音高 */
    type() {
      if (!enabled) return;
      const now = performance.now();
      if (now - lastType < 70) return;
      lastType = now;
      tone(1750 + Math.random() * 250, 0.03, { type: "triangle", gain: 0.028 });
    },
    /* 旁白/消息出现 */
    msg(low) {
      tone(low ? 340 : 520, 0.12, { type: "sine", gain: 0.07, slide: low ? -60 : 60 });
    },
    /* 选项点击 */
    click() {
      tone(660, 0.07, { type: "triangle", gain: 0.1 });
      tone(990, 0.09, { type: "triangle", gain: 0.07, delay: 0.06 });
    },
    /* 飘字（好感变化） */
    hint(good) {
      tone(good ? 880 : 440, 0.1, { type: "sine", gain: 0.09, slide: good ? 220 : -140 });
    },
    /* 结局琶音 */
    ending() {
      if (!enabled) return;
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
        tone(f, 0.5, { type: "sine", gain: 0.1, delay: i * 0.13 })
      );
    },
    /* 开幕大幕：低频合幕 + 开幕时的金色上扬音，时长与 curtainShow 对齐 */
    curtain() {
      if (!enabled) return;
      tone(112, 0.72, { type: "sine", gain: 0.075, slide: -38 });
      tone(78, 0.9, { type: "triangle", gain: 0.032, slide: -18, delay: 0.04 });
      tone(176, 0.24, { type: "triangle", gain: 0.025, slide: -54, delay: 0.62 });
      tone(392, 0.34, { type: "sine", gain: 0.028, slide: 150, delay: 1.28 });
      tone(587.33, 0.42, { type: "sine", gain: 0.022, slide: 190, delay: 1.36 });
    },
  };
})();
