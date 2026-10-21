/* Gym Chronograph — cronómetro, cuenta atrás, AMRAP, EMOM y Tabata */
"use strict";

const MODES = {
  crono:     { label: "Cronómetro" },
  countdown: { label: "Cuenta atrás" },
  amrap:     { label: "AMRAP" },
  emom:      { label: "EMOM" },
  tabata:    { label: "Tabata" },
};

const state = {
  mode: "crono",
  running: false,
  startStamp: 0,
  accumulated: 0,
  finished: false,
  // config
  countdownMin: 1, countdownSec: 0,
  amrapMin: 10,
  emomRounds: 10,
  tabataRounds: 8, tabataWork: 20, tabataRest: 10,
  // live
  rounds: 0,
  emomMinute: -1,
  tabataPhase: null, // {type:'work'|'rest', index}
  lastTickSecond: -1,
};

const $ = (sel) => document.querySelector(sel);
const clockEl = $("#clock");
const phaseEl = $("#phase");
const subinfoEl = $("#subinfo");
const progressEl = $("#progress-bar");
const configEl = $("#config");
const btnMain = $("#btn-main");
const btnReset = $("#btn-reset");
const btnRound = $("#btn-round");

let rafId = null;
let audioCtx = null;
let wakeLock = null;

/* ---------- audio ---------- */
function ensureAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* sin audio */ }
  }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
}

function beep(freq = 880, duration = 0.15, volume = 0.25) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "square";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + duration);
}

const shortBeep = () => beep(880, 0.12);
const finalTone = () => { beep(660, 0.5, 0.3); setTimeout(() => beep(880, 0.6, 0.3), 250); };

/* ---------- time helpers ---------- */
function elapsed(now = Date.now()) {
  return state.accumulated + (state.running ? now - state.startStamp : 0);
}

function formatTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const tenths = Math.floor((ms % 1000) / 100);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}.${tenths}`;
}

function totalConfigMs() {
  switch (state.mode) {
    case "countdown": return (state.countdownMin * 60 + state.countdownSec) * 1000;
    case "amrap": return state.amrapMin * 60 * 1000;
    case "emom": return state.emomRounds * 60 * 1000;
    default: return 0;
  }
}

/* ---------- tabata sequencing ---------- */
function tabataTimeline() {
  // [{type, durationMs, round}] — work/rest pairs; no rest after final round
  const items = [];
  for (let i = 1; i <= state.tabataRounds; i++) {
    items.push({ type: "work", durationMs: state.tabataWork * 1000, round: i });
    if (i < state.tabataRounds) items.push({ type: "rest", durationMs: state.tabataRest * 1000, round: i });
  }
  return items;
}

function tabataPhaseAt(el) {
  let acc = 0;
  for (const item of tabataTimeline()) {
    if (el < acc + item.durationMs) return { ...item, elapsedInPhase: el - acc, startsAt: acc };
    acc += item.durationMs;
  }
  return null; // finished
}

/* ---------- rendering ---------- */
function renderConfig() {
  const rows = [];
  const stepper = (label, value, onMinus, onPlus) => `
    <div class="config-row">
      <span class="config-label">${label}</span>
      <div class="stepper">
        <button class="step-btn" data-act="${onMinus}">−</button>
        <span class="config-value">${value}</span>
        <button class="step-btn" data-act="${onPlus}">+</button>
      </div>
    </div>`;

  if (state.mode === "countdown") {
    rows.push(stepper("Duración",
      `${state.countdownMin} min ${String(state.countdownSec).padStart(2, "0")} s`,
      "cd-down", "cd-up"));
  } else if (state.mode === "amrap") {
    rows.push(stepper("Tiempo total", `${state.amrapMin} min`, "am-down", "am-up"));
  } else if (state.mode === "emom") {
    rows.push(stepper("Rondas (cada minuto)", `${state.emomRounds}`, "em-down", "em-up"));
  } else if (state.mode === "tabata") {
    rows.push(stepper("Rondas", `${state.tabataRounds}`, "tb-r-down", "tb-r-up"));
    rows.push(stepper("Trabajo (seg)", `${state.tabataWork}`, "tb-w-down", "tb-w-up"));
    rows.push(stepper("Descanso (seg)", `${state.tabataRest}`, "tb-b-down", "tb-b-up"));
  }

  configEl.hidden = rows.length === 0;
  configEl.innerHTML = rows.join("");
}

function render(now = Date.now()) {
  const el = elapsed(now);
  const total = totalConfigMs();
  let display = el;
  let fraction = null;
  let subinfo = "";
  let phase = null;

  if (state.mode === "crono") {
    display = el;
  } else if (state.mode === "countdown") {
    const remaining = Math.max(0, total - el);
    display = state.finished ? 0 : remaining;
    fraction = total > 0 ? Math.min(el / total, 1) : 0;
  } else if (state.mode === "amrap") {
    const remaining = Math.max(0, total - el);
    display = state.finished ? 0 : remaining;
    fraction = total > 0 ? Math.min(el / total, 1) : 0;
    subinfo = `Rondas completadas: ${state.rounds}`;
  } else if (state.mode === "emom") {
    const remaining = Math.max(0, total - el);
    display = state.finished ? 0 : remaining;
    if (!state.finished) {
      const minute = Math.floor(el / 60000);
      const round = Math.min(minute + 1, state.emomRounds);
      const secInto = Math.floor((el % 60000) / 1000);
      subinfo = `Ronda ${round} de ${state.emomRounds} · segundo ${secInto}`;
      fraction = (el % 60000) / 60000;
    }
  } else if (state.mode === "tabata") {
    const ph = state.finished ? null : tabataPhaseAt(el);
    if (ph) {
      state.tabataPhase = ph;
      display = ph.durationMs - ph.elapsedInPhase;
      fraction = ph.elapsedInPhase / ph.durationMs;
      phase = { text: ph.type === "work" ? "Trabajo" : "Descanso", work: ph.type === "work" };
      subinfo = `Ronda ${ph.round} de ${state.tabataRounds}`;
    }
  }

  clockEl.textContent = formatTime(display);
  clockEl.classList.toggle("finished", state.finished);
  progressEl.style.width = `${(fraction === null ? 0 : fraction) * 100}%`;

  if (phase) {
    phaseEl.hidden = false;
    phaseEl.textContent = phase.text;
    phaseEl.classList.toggle("work", phase.work);
  } else {
    phaseEl.hidden = true;
  }

  if (state.finished) {
    subinfo = {
      countdown: "¡Tiempo!",
      amrap: `AMRAP completado · ${state.rounds} rondas`,
      emom: "EMOM completado",
      tabata: "Tabata completado",
      crono: "",
    }[state.mode];
  }
  subinfoEl.textContent = subinfo;

  btnMain.textContent = state.running ? "Pausar" : (state.finished ? "Reiniciar" : "Iniciar");
  btnRound.hidden = !(state.mode === "amrap" && !state.finished && (state.running || el > 0));
}

function loop() {
  const now = Date.now();
  handleBeeps(now);
  render(now);
}

/* setInterval (no requestAnimationFrame) para que el temporizador siga
   corriendo aunque la pestaña pierda el foco. */
setInterval(loop, 200);

/* ---------- beeps / transitions ---------- */
function handleBeeps(now) {
  if (!state.running || state.finished) return;
  const el = elapsed(now);

  if (state.mode === "countdown") {
    const remaining = totalConfigMs() - el;
    if (remaining <= 0) {
      finish();
    } else {
      const sec = Math.ceil(remaining / 1000);
      if (sec <= 3 && sec !== state.lastTickSecond) { state.lastTickSecond = sec; shortBeep(); }
    }
  } else if (state.mode === "amrap") {
    if (el >= totalConfigMs()) finish();
  } else if (state.mode === "emom") {
    const minute = Math.floor(el / 60000);
    if (el > 0 && minute !== state.emomMinute) {
      state.emomMinute = minute;
      if (minute >= state.emomRounds) finish();
      else shortBeep();
    }
  } else if (state.mode === "tabata") {
    const ph = tabataPhaseAt(el);
    if (!ph) { finish(); return; }
    // beep on phase change
    const key = `${ph.type}-${ph.round}`;
    if (state.phaseKey !== key) {
      state.phaseKey = key;
      if (ph.type === "work") { beep(990, 0.25); } else { beep(550, 0.2); }
    }
    // 3-2-1 during the last 3 s of rest
    if (ph.type === "rest") {
      const left = Math.ceil((ph.durationMs - ph.elapsedInPhase) / 1000);
      if (left <= 3 && left !== state.lastTickSecond) { state.lastTickSecond = left; shortBeep(); }
    }
  }
}

function finish() {
  state.finished = true;
  state.running = false;
  state.accumulated = totalConfigMs() || state.accumulated;
  finalTone();
  releaseWakeLock();
}

/* ---------- controls ---------- */
function startPause() {
  ensureAudio();
  if (state.finished) reset();
  if (state.running) {
    state.accumulated += Date.now() - state.startStamp;
    state.running = false;
    releaseWakeLock();
  } else {
    state.startStamp = Date.now();
    state.running = true;
    requestWakeLock();
  }
  render();
}

function reset() {
  state.running = false;
  state.accumulated = 0;
  state.startStamp = Date.now();
  state.finished = false;
  state.rounds = 0;
  state.emomMinute = -1;
  state.lastTickSecond = -1;
  state.phaseKey = null;
  releaseWakeLock();
  render();
}

function switchMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode));
  reset();
  renderConfig();
}

/* ---------- wake lock ---------- */
async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch (e) { /* no disponible */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

/* ---------- events ---------- */
btnMain.addEventListener("click", startPause);
btnReset.addEventListener("click", reset);
btnRound.addEventListener("click", () => { state.rounds++; beep(990, 0.1); render(); });

document.querySelectorAll(".mode-btn").forEach((b) =>
  b.addEventListener("click", () => switchMode(b.dataset.mode)));

configEl.addEventListener("click", (e) => {
  const act = e.target.dataset && e.target.dataset.act;
  if (!act) return;
  const acts = {
    "cd-up":   () => { let s = state.countdownSec + 15, m = state.countdownMin; if (s >= 60) { s = 0; m++; } state.countdownSec = s; state.countdownMin = m; },
    "cd-down": () => { let s = state.countdownSec - 15, m = state.countdownMin; if (s < 0) { s = 45; m = Math.max(0, m - 1); } state.countdownSec = s; state.countdownMin = m; },
    "am-up":   () => { state.amrapMin = Math.min(60, state.amrapMin + 5); },
    "am-down": () => { state.amrapMin = Math.max(5, state.amrapMin - 5); },
    "em-up":   () => { state.emomRounds = Math.min(60, state.emomRounds + 1); },
    "em-down": () => { state.emomRounds = Math.max(2, state.emomRounds - 1); },
    "tb-r-up": () => { state.tabataRounds = Math.min(30, state.tabataRounds + 1); },
    "tb-r-down": () => { state.tabataRounds = Math.max(2, state.tabataRounds - 1); },
    "tb-w-up": () => { state.tabataWork = Math.min(120, state.tabataWork + 5); },
    "tb-w-down": () => { state.tabataWork = Math.max(5, state.tabataWork - 5); },
    "tb-b-up": () => { state.tabataRest = Math.min(120, state.tabataRest + 5); },
    "tb-b-down": () => { state.tabataRest = Math.max(5, state.tabataRest - 5); },
  };
  if (acts[act]) { acts[act](); renderConfig(); }
});

/* ---------- service worker / init ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.running) requestWakeLock();
});

switchMode("crono");
