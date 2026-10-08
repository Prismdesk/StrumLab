'use strict';

/* ---------- Settings ---------- */
const DEFAULTS = {
  theme: 'system', size: 'medium', guitar: 'acoustic', capo: 0, noteColor: 'note', frets: '6',
  tuning: 'standard', customTuning: [40, 45, 50, 55, 59, 64],
  reverb: 'off', chorus: 'off', compressor: 'low', diagram: 'vertical'
};
let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('strumlab.settings') || '{}')); } catch (e) {}

function saveSettings() {
  try { localStorage.setItem('strumlab.settings', JSON.stringify(settings)); } catch (e) {}
}

function currentTuning() {
  if (settings.tuning === 'custom' && Array.isArray(settings.customTuning) && settings.customTuning.length === 6)
    return settings.customTuning.map(Number);
  return [...(TUNINGS.find(t => t.id === settings.tuning) || TUNINGS[0]).midi];
}

function setTuningMidis(arr) {
  const p = TUNINGS.find(t => t.midi.join() === arr.join());
  if (p) settings.tuning = p.id; else { settings.tuning = 'custom'; settings.customTuning = [...arr]; }
  saveSettings();
  applySettings();
  document.dispatchEvent(new Event('settingschange'));
}

function applySettings() {
  const root = document.documentElement;
  if (settings.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', settings.theme);
  root.setAttribute('data-size', settings.size);
  Engine.type = settings.guitar;
  Engine.midi = currentTuning();
  Engine.setFx();
  document.querySelectorAll('.seg').forEach(seg => {
    const key = seg.dataset.setting;
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.value === String(settings[key])));
  });
  buildStrings();
}

document.querySelectorAll('.seg').forEach(seg => {
  seg.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const key = seg.dataset.setting;
    settings[key] = b.dataset.value;
    saveSettings();
    applySettings();
    document.dispatchEvent(new Event('settingschange'));
    if (key === 'guitar') Engine.play([Engine.midi[2]]);
    if (key === 'reverb' || key === 'chorus' || key === 'compressor') Engine.play(Engine.midi.slice(1, 5), 0.04);
  });
});

/* ---------- Audio engine (synthesized plucked string, no audio files) ---------- */
const Engine = {
  ctx: null, master: null, cache: new Map(), type: 'acoustic', fx: null,
  midi: [...STD_TUNING],

  init() {
    if (this.ctx) return;
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const g = v => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const master = this.master = g(0.85);
    // chorus: dry + modulated short delay
    const cDry = g(1), cWet = g(0), cOut = g(1), delay = ctx.createDelay(0.05);
    delay.delayTime.value = 0.02;
    const lfo = ctx.createOscillator(), lfoGain = g(0.004);
    lfo.frequency.value = 0.9; lfo.connect(lfoGain); lfoGain.connect(delay.delayTime); lfo.start();
    master.connect(cDry); cDry.connect(cOut);
    master.connect(delay); delay.connect(cWet); cWet.connect(cOut);
    // compressor
    const comp = ctx.createDynamicsCompressor(), makeup = g(1);
    cOut.connect(comp); comp.connect(makeup);
    // reverb: generated impulse response (no files)
    const rDry = g(1), rWet = g(0), conv = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 1.8), ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
    conv.buffer = ir;
    makeup.connect(rDry); rDry.connect(ctx.destination);
    makeup.connect(conv); conv.connect(rWet); rWet.connect(ctx.destination);
    this.fx = { cDry, cWet, comp, makeup, rDry, rWet };
    this.setFx();
  },

  setFx() {
    if (!this.fx) return;
    const L = v => Math.max(0, ['off', 'low', 'med', 'high'].indexOf(v));
    const rv = [0, 0.18, 0.35, 0.55][L(settings.reverb)], ch = [0, 0.25, 0.45, 0.65][L(settings.chorus)], cp = L(settings.compressor);
    const f = this.fx;
    f.rWet.gain.value = rv; f.rDry.gain.value = 1 - rv * 0.5;
    f.cWet.gain.value = ch; f.cDry.gain.value = 1 - ch * 0.4;
    f.comp.threshold.value = [0, -18, -26, -34][cp];
    f.comp.ratio.value = [1, 3, 6, 12][cp];
    f.makeup.gain.value = [1, 1.15, 1.35, 1.6][cp];
  },

  async unlock() {
    this.init();
    if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch (e) {} }
  },

  buffer(midi) {
    const key = this.type + midi;
    if (this.cache.has(key)) return this.cache.get(key);
    const sr = this.ctx.sampleRate, freq = mtof(midi);
    const N = Math.max(2, Math.round(sr / freq));
    const len = Math.floor(sr * 3);
    const buf = this.ctx.createBuffer(1, len, sr);
    const out = buf.getChannelData(0);
    const line = new Float32Array(N);
    const electric = this.type === 'electric';
    const damp = electric ? 0.9993 : 0.9975;      // electric sustains longer
    let prev = 0;
    for (let i = 0; i < N; i++) {                   // initial noise burst
      const n = Math.random() * 2 - 1;
      prev = electric ? prev * 0.55 + n * 0.45 : n; // electric = softer pluck
      line[i] = prev;
    }
    for (let i = 0; i < len; i++) {
      const j = i % N, k = (i + 1) % N;
      out[i] = line[j];
      line[j] = 0.5 * (line[j] + line[k]) * damp;
    }
    const fade = Math.floor(sr * 0.25);
    for (let i = 0; i < fade; i++) out[len - 1 - i] *= i / fade;
    this.cache.set(key, buf);
    return buf;
  },

  pluck(midi, when = 0, vel = 1) {
    const src = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    src.buffer = this.buffer(midi);
    g.gain.value = 0.55 * vel;
    src.connect(g); g.connect(this.master);
    src.start(this.ctx.currentTime + when);
  },

  // gap in seconds between notes: ~0.035 strum, ~0.22 arpeggio
  async play(midis, gap = 0.04) {
    await this.unlock();
    midis.forEach((m, i) => this.pluck(m, i * gap, Math.max(0.5, 1 - i * 0.03)));
  }
};

/* ---------- Sound check ---------- */
function buildStrings() {
  const el = document.getElementById('strings');
  el.innerHTML = '';
  Engine.midi.forEach(m => {
    const b = document.createElement('button');
    b.textContent = noteLabel(m);
    b.setAttribute('aria-label', 'Play string ' + noteLabel(m));
    b.addEventListener('click', () => {
      Engine.play([m]);
      b.classList.add('hit'); setTimeout(() => b.classList.remove('hit'), 180);
    });
    el.appendChild(b);
  });
}
document.getElementById('strum-test').addEventListener('click', () => Engine.play(Engine.midi, 0.045));

/* ---------- Tabs ---------- */
const tabButtons = document.querySelectorAll('#tabbar button');
function showTab(name) {
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== 'tab-' + name; });
  tabButtons.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  window.scrollTo(0, 0);
  document.dispatchEvent(new CustomEvent('tabshown', { detail: name }));
  try { localStorage.setItem('strumlab.tab', name); } catch (e) {}
}
tabButtons.forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
let startTab = 'chords';
try { startTab = localStorage.getItem('strumlab.tab') || 'chords'; } catch (e) {}
if (!document.getElementById('tab-' + startTab)) startTab = 'chords';
showTab(startTab);
applySettings();

/* ---------- Offline / service worker ---------- */
const offlineEl = document.getElementById('offline-status');
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then(() => { offlineEl.textContent = 'Ready. The app and all sounds work without internet.'; offlineEl.classList.add('ok'); })
    .catch(() => { offlineEl.textContent = 'Offline mode could not start. Open the app once with internet and reload.'; });
} else {
  offlineEl.textContent = 'This browser does not support offline mode.';
}
