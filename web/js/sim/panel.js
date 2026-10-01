// Simulation panel in the G-code view: parses the loaded program, runs the carving
// simulation in a worker, and drives the 3D viewer with playback controls.

import { parseGcode } from './gcode.js';
import { autoStock } from './carve.js';
import { MM_PER_DEG } from '../machine.js';

const $ = (id) => document.getElementById(id);

export function initSimPanel() {
  const panel = $('sim');
  const viewEl = $('sim-view');
  const overlay = $('sim-overlay');
  const playBtn = $('sim-play');
  const scrub = $('sim-scrub');
  const timeLabel = $('sim-time');
  const speedSel = $('sim-speed');
  const stockInputs = { w: $('sim-stock-w'), d: $('sim-stock-d'), h: $('sim-stock-h') };
  const autoBtn = $('sim-stock-auto');
  const status = $('sim-status');
  const syncCb = $('sim-sync');

  let worker = null;  // created on first use, to keep it out of the page-load requests
  let viewer = null;
  let lines = [];
  let moves = [];
  let cumTime = [0];  // cumTime[i] = seconds at the start of move i
  let simId = 0;
  let playing = false;
  let lastFrame = 0;
  let time = 0;
  let rerunTimer = null;
  let running = false;
  let paused = false;

  async function ensureViewer() {
    if (viewer) return viewer;
    const { SimViewer } = await import('./viewer.js');
    viewer = new SimViewer(viewEl);
    return viewer;
  }

  function readStock() {
    const s = {};
    for (const [k, el] of Object.entries(stockInputs)) s[k] = Math.max(1, parseFloat(el.value) || 1);
    return s;
  }

  function writeStock(stock) {
    for (const [k, el] of Object.entries(stockInputs)) el.value = stock[k];
  }

  // Program time for each move, from its length (all axes) and feed rate
  function computeTimes() {
    cumTime = [0];
    for (const m of moves) {
      const dist = Math.hypot(m.to.X - m.from.X, m.to.Y - m.from.Y, m.to.Z - m.from.Z, m.to.A - m.from.A);
      cumTime.push(cumTime[cumTime.length - 1] + (dist / m.feed) * 60);
    }
  }

  // Seconds -> fractional move index
  function moveIndexAt(seconds) {
    let lo = 0;
    let hi = moves.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cumTime[mid] <= seconds) lo = mid;
      else hi = mid - 1;
    }
    if (lo >= moves.length) return moves.length;
    const span = cumTime[lo + 1] - cumTime[lo];
    return lo + (span > 0 ? (seconds - cumTime[lo]) / span : 1);
  }

  // Program time at the end of the last move produced by file lines <= fileLine
  function lineEndTime(fileLine) {
    let lo = 0;
    let hi = moves.length;  // first move with line > fileLine
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (moves[mid].line <= fileLine) lo = mid + 1;
      else hi = mid;
    }
    return cumTime[lo];
  }

  // While synced to a running (not paused) program, playback is driven by the
  // sender, so the manual controls are disabled
  function updateLock() {
    const locked = syncCb.checked && running && !paused;
    playBtn.disabled = locked;
    scrub.disabled = locked;
    speedSel.disabled = locked;
    if (locked) setPlaying(false);
  }

  function totalTime() {
    return cumTime[cumTime.length - 1];
  }

  function showTime(seconds) {
    time = Math.max(0, Math.min(totalTime(), seconds));
    scrub.value = String(time);
    timeLabel.textContent = `${formatTime(time)} / ${formatTime(totalTime())}`;
    if (!viewer || !viewer.program) return;
    const t = moveIndexAt(time);
    const pos = viewer.setTime(t);
    const move = moves[Math.min(Math.floor(t), moves.length - 1)];
    if (move && pos) {
      const rot = (pos.A - pos.Y) / MM_PER_DEG;
      overlay.textContent =
        `Line ${move.line + 1}: ${lines[move.line].trim()}\n` +
        `Y ${pos.Y.toFixed(2)}  Z ${pos.Z.toFixed(2)}  rot ${rot.toFixed(1)}°`;
    }
  }

  function setPlaying(on) {
    playing = on && moves.length > 0;
    playBtn.textContent = playing ? '❚❚' : '▶';
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if (playing) {
      if (time >= totalTime()) showTime(0);
      lastFrame = performance.now();
      requestAnimationFrame(tick);
    }
  }

  function tick(now) {
    if (!playing) return;
    const dt = (now - lastFrame) / 1000;
    lastFrame = now;
    showTime(time + dt * parseFloat(speedSel.value));
    if (time >= totalTime()) setPlaying(false);
    else requestAnimationFrame(tick);
  }

  function runSimulation() {
    if (!moves.length) return;
    const id = ++simId;
    status.textContent = 'Simulating…';
    ensureWorker().postMessage({ id, moves, stock: readStock() });
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

    worker.onmessage = async ({ data }) => {
      if (data.id !== simId) return;  // stale result from an earlier stock size
      const v = await ensureViewer();
      v.setProgram({ moves, grid: data.grid, removedAt: data.removedAt });
      status.textContent = `${moves.length} moves · voxel ${data.grid.cs.toFixed(2)} mm`;
      showTime(time);
    };

    worker.onerror = (e) => {
      status.textContent = `Simulation failed: ${e.message}`;
    };
    return worker;
  }

  playBtn.addEventListener('click', () => setPlaying(!playing));
  scrub.addEventListener('input', () => {
    setPlaying(false);
    showTime(parseFloat(scrub.value));
  });

  for (const el of Object.values(stockInputs)) {
    el.addEventListener('input', () => {
      clearTimeout(rerunTimer);
      rerunTimer = setTimeout(runSimulation, 300);
    });
  }

  autoBtn.addEventListener('click', () => {
    writeStock(autoStock(moves));
    runSimulation();
  });

  $('sim-reset-view').addEventListener('click', () => viewer && viewer.fitView());
  syncCb.addEventListener('change', updateLock);

  return {
    /** @param {string[]} programLines lines exactly as they will be sent */
    load(programLines) {
      lines = programLines;
      const parsed = parseGcode(lines);
      moves = parsed.moves;
      setPlaying(false);
      panel.hidden = moves.length === 0;
      if (!moves.length) return;
      computeTimes();
      scrub.max = String(totalTime());
      writeStock(autoStock(moves));
      time = 0;
      showTime(0);
      if (parsed.warnings.length) console.warn('G-code simulation:', parsed.warnings);
      runSimulation();
    },

    /** Drop the loaded program and hide the panel */
    clear() {
      clearTimeout(rerunTimer);
      simId++;  // ignore any simulation still in flight
      setPlaying(false);
      lines = [];
      moves = [];
      cumTime = [0];
      time = 0;
      overlay.textContent = '';
      status.textContent = '';
      panel.hidden = true;
    },

    /** Called by the sender with the program's running/paused state */
    setRunState(isRunning, isPaused) {
      running = isRunning;
      paused = isPaused;
      updateLock();
    },

    /** Called after each line is sent; -1 = program start */
    follow(fileLine) {
      if (!syncCb.checked || !moves.length) return;
      showTime(fileLine < 0 ? 0 : lineEndTime(fileLine));
    },
  };
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}
