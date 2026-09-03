'use strict';
/**
 * Stonk Packs effects: synthesized sound (Web Audio, no files), canvas particles,
 * count-ups and screen shake. Everything degrades to nothing when the browser says
 * it prefers reduced motion, and sound stays off until the user has clicked something.
 */
(function (global) {
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // ---------------------------------------------------------------------------
  // Sound
  // ---------------------------------------------------------------------------
  let ctx = null;
  let master = null;
  let muted = false;
  try { muted = localStorage.getItem('stonkpacks:muted') === '1'; } catch { /* ignore */ }

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }
  const unlock = () => { ac(); };
  const setMuted = (m) => { muted = !!m; try { localStorage.setItem('stonkpacks:muted', muted ? '1' : '0'); } catch { /* ignore */ } };
  const isMuted = () => muted;

  function tone({ freq, type = 'sine', at = 0, dur = 0.2, gain = 0.2, attack = 0.005, release = 0.12, slideTo = null, detune = 0 }) {
    const c = ac();
    if (!c || muted) return;
    const t0 = c.currentTime + at;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    o.detune.value = detune;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.setValueAtTime(gain, t0 + Math.max(attack, dur - release));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  let noiseBuf = null;
  function noise({ at = 0, dur = 0.2, gain = 0.2, from = 2000, to = 500, q = 0.7, type = 'lowpass' }) {
    const c = ac();
    if (!c || muted) return;
    if (!noiseBuf) {
      noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t0 = c.currentTime + at;
    const src = c.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(from, t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, to), t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  // A pentatonic ladder: every rarity climbs further up it.
  const LADDER = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.7, 1318.5, 1568.0];
  const SOUNDS = {
    tick: () => tone({ freq: 1400, type: 'square', dur: 0.035, gain: 0.05, release: 0.03 }),
    count: (i) => tone({ freq: 700 + (i % 7) * 60, type: 'triangle', dur: 0.04, gain: 0.06, release: 0.03 }),
    rumble: (dur = 0.7) => noise({ dur, gain: 0.35, from: 90, to: 260, type: 'lowpass' }),
    tear: () => { noise({ dur: 0.32, gain: 0.5, from: 4000, to: 700, type: 'bandpass', q: 0.9 }); noise({ at: 0.05, dur: 0.25, gain: 0.3, from: 1200, to: 200 }); },
    deal: () => noise({ dur: 0.11, gain: 0.14, from: 2500, to: 900, type: 'bandpass', q: 1.2 }),
    flip: () => { noise({ dur: 0.07, gain: 0.16, from: 5000, to: 1800, type: 'bandpass' }); tone({ freq: 260, type: 'triangle', dur: 0.05, gain: 0.12, release: 0.04 }); },
    riser: (dur) => {
      tone({ freq: 160, slideTo: 720, type: 'sawtooth', dur, gain: 0.06, release: 0.05 });
      const n = Math.floor(dur / 0.09);
      for (let i = 0; i < n; i++) {
        const at = (i * i) / (n * n) * dur; // ticks accelerate
        tone({ freq: 900 + i * 40, type: 'square', at, dur: 0.03, gain: 0.04, release: 0.02 });
      }
    },
    hit: (tier) => {
      const steps = [1, 2, 3, 4, 6, 9][Math.min(tier, 5)];
      const start = [0, 1, 2, 3, 4, 5][Math.min(tier, 5)];
      const gap = tier >= 4 ? 0.07 : 0.09;
      for (let i = 0; i < steps; i++) {
        const f = LADDER[Math.min(LADDER.length - 1, start + i)];
        tone({ freq: f, type: tier >= 3 ? 'square' : 'triangle', at: i * gap, dur: 0.22 + i * 0.03, gain: tier >= 3 ? 0.09 : 0.12, release: 0.15 });
        if (tier >= 2) tone({ freq: f * 2, type: 'sine', at: i * gap, dur: 0.2, gain: 0.05 });
      }
      if (tier >= 3) tone({ freq: 55, type: 'sine', dur: 0.35, gain: 0.35, release: 0.3 }); // sub thump
      if (tier >= 4) { noise({ dur: 0.5, gain: 0.18, from: 8000, to: 2000, type: 'highpass' }); tone({ freq: LADDER[13], type: 'sine', at: steps * gap, dur: 1.2, gain: 0.1, release: 1.0 }); }
      if (tier >= 5) {
        for (let i = 0; i < 12; i++) tone({ freq: LADDER[8 + (i % 6)] * 2, type: 'sine', at: 0.6 + i * 0.05, dur: 0.5, gain: 0.05, release: 0.4, detune: rand(-12, 12) });
        tone({ freq: 65, slideTo: 40, type: 'sine', at: 0.05, dur: 0.9, gain: 0.4, release: 0.8 });
      }
    },
    cash: () => {
      tone({ freq: 1568, type: 'sine', dur: 0.35, gain: 0.16, release: 0.3 });
      tone({ freq: 2093, type: 'sine', at: 0.07, dur: 0.6, gain: 0.14, release: 0.5 });
      noise({ dur: 0.12, gain: 0.2, from: 9000, to: 4000, type: 'highpass' });
    },
    sad: () => { tone({ freq: 330, slideTo: 262, type: 'triangle', dur: 0.35, gain: 0.08, release: 0.2 }); },
  };
  const sound = (name, ...args) => { try { const f = SOUNDS[name]; if (f) f(...args); } catch { /* audio is optional */ } };

  // ---------------------------------------------------------------------------
  // Particles on a canvas that sits over the arena
  // ---------------------------------------------------------------------------
  let canvas = null;
  let cctx = null;
  let parts = [];
  let emitters = [];
  let raf = null;
  let dpr = 1;

  function prepare(cv) {
    canvas = cv;
    cctx = canvas.getContext('2d');
    resize();
  }
  function resize() {
    if (!canvas) return;
    const r = canvas.parentElement.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(r.width * dpr);
    canvas.height = Math.floor(r.height * dpr);
    canvas.style.width = r.width + 'px';
    canvas.style.height = r.height + 'px';
  }
  function localPoint(el) {
    const a = canvas.parentElement.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    return { x: b.left - a.left + b.width / 2, y: b.top - a.top + b.height / 2 };
  }
  function spawn(x, y, opt) {
    const { n = 30, colors = ['#141311'], speed = [2, 8], gravity = 0.22, life = [45, 80], size = [4, 9], spread = Math.PI * 2, angle = -Math.PI / 2, drag = 0.985, shapes = ['rect'] } = opt;
    for (let i = 0; i < n; i++) {
      const a = angle + (Math.random() - 0.5) * spread;
      const v = rand(speed[0], speed[1]);
      parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: gravity, drag, rot: rand(0, Math.PI * 2), vr: rand(-0.3, 0.3), life: rand(life[0], life[1]), age: 0, size: rand(size[0], size[1]), color: pick(colors), shape: pick(shapes), foil: !!opt.foil });
    }
  }
  function burst(el, opt) {
    if (!canvas || reduced) return;
    const p = localPoint(el);
    spawn(p.x, p.y, opt);
    run();
  }
  function ring(el, opt = {}) {
    if (!canvas || reduced) return;
    const p = localPoint(el);
    parts.push({ ring: true, x: p.x, y: p.y, r: 10, vr: opt.speed || 9, life: opt.life || 26, age: 0, color: opt.color || '#141311', width: opt.width || 4 });
    run();
  }
  function rain(opt) {
    if (!canvas || reduced) return;
    const { duration = 2500, rate = 6, colors = ['#c9a227', '#fff2c8', '#e9c96a'], foil = true } = opt;
    emitters.push({ until: performance.now() + duration, rate, colors, foil });
    run();
  }
  function step() {
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const now = performance.now();
    emitters = emitters.filter((e) => e.until > now);
    for (const e of emitters) {
      for (let i = 0; i < e.rate; i++) parts.push({ x: rand(0, w), y: -10, vx: rand(-0.6, 0.6), vy: rand(1, 3), g: 0.05, drag: 0.995, rot: rand(0, 6.28), vr: rand(-0.2, 0.2), life: rand(120, 200), age: 0, size: rand(5, 11), color: pick(e.colors), shape: 'rect', foil: e.foil, sway: rand(0, 6.28) });
    }
    cctx.clearRect(0, 0, canvas.width, canvas.height);
    cctx.save();
    cctx.scale(dpr, dpr);
    parts = parts.filter((p) => p.age < p.life);
    for (const p of parts) {
      p.age++;
      const t = p.age / p.life;
      const alpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      if (p.ring) {
        p.r += p.vr;
        p.vr *= 0.93;
        cctx.globalAlpha = alpha * 0.9;
        cctx.strokeStyle = p.color;
        cctx.lineWidth = p.width * (1 - t * 0.6);
        cctx.beginPath();
        cctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        cctx.stroke();
        continue;
      }
      p.vy += p.g;
      p.vx *= p.drag;
      p.vy *= p.drag;
      p.x += p.vx + (p.sway !== undefined ? Math.sin(p.age / 12 + p.sway) * 0.8 : 0);
      p.y += p.vy;
      p.rot += p.vr;
      cctx.globalAlpha = alpha;
      cctx.save();
      cctx.translate(p.x, p.y);
      cctx.rotate(p.rot);
      const shade = p.foil ? 0.6 + 0.4 * Math.abs(Math.cos(p.rot * 2)) : 1;
      cctx.fillStyle = p.color;
      if (p.foil) { cctx.globalAlpha = alpha * shade; }
      if (p.shape === 'dot') { cctx.beginPath(); cctx.arc(0, 0, p.size / 2, 0, Math.PI * 2); cctx.fill(); }
      else cctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      cctx.restore();
    }
    cctx.restore();
    if (parts.length || emitters.length) raf = requestAnimationFrame(step);
    else { raf = null; cctx.clearRect(0, 0, canvas.width, canvas.height); }
  }
  function run() { if (!raf) raf = requestAnimationFrame(step); }
  function clear() { parts = []; emitters = []; if (cctx && canvas) cctx.clearRect(0, 0, canvas.width, canvas.height); }

  // ---------------------------------------------------------------------------
  // Screen shake and count-ups
  // ---------------------------------------------------------------------------
  function shake(el, level = 1, ms = 450) {
    if (reduced || !el) return;
    el.classList.remove('shake-1', 'shake-2', 'shake-3');
    void el.offsetWidth; // restart the animation
    el.classList.add('shake-' + Math.min(3, Math.max(1, level)));
    setTimeout(() => el.classList.remove('shake-1', 'shake-2', 'shake-3'), ms);
  }

  function countUp(el, cents, ms, format, withSound = true) {
    return new Promise((resolve) => {
      if (reduced || ms <= 0) { el.textContent = format(cents); resolve(); return; }
      const t0 = performance.now();
      let lastTick = 0;
      let i = 0;
      const frame = (now) => {
        const t = Math.min(1, (now - t0) / ms);
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = format(Math.round(cents * eased));
        if (withSound && now - lastTick > 45 && t < 1) { sound('count', i++); lastTick = now; }
        if (t < 1) requestAnimationFrame(frame); else resolve();
      };
      requestAnimationFrame(frame);
    });
  }

  global.FX = { reduced, unlock, setMuted, isMuted, sound, prepare, resize, burst, ring, rain, clear, shake, countUp };
})(window);
