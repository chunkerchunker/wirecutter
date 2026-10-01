import { MM_PER_DEG, MAX_FEED } from './machine.js';
import { initSimPanel } from './sim/panel.js';
import { FIELDS, getPath, builtinSettings, loadSettings, SETTINGS_URL } from './settings.js';

// FluidNC (v4) serves its WebSocket at "/" on the HTTP port, the same endpoint
// ESP3D-WEBUI uses. Output arrives as binary frames; text frames are control
// messages (currentID:, PING:, ...). When this page is served by the
// controller itself, default to that host.
const DEFAULT_HOST = location.protocol.startsWith('http') && location.hostname ? location.host : 'hotwire.local';

// FluidNC realtime commands (single bytes, no newline, no "ok" response)
const RT_STATUS = '?';
const RT_JOG_CANCEL = '\x85';
const RT_FEED_HOLD = '!';
const RT_CYCLE_START = '~';
const RT_RESET = '\x18';

let ws = null;
let isConnecting = false;
let pendingOks = 0;
let rxBuffer = '';
let rxDecoder = new TextDecoder();

let activeBtn = null;
let holdTimer = null;
let isHoldJogging = false;
const HOLD_MS = 250;           // press longer than this => continuous jog until release
const CONTINUOUS_JOG = 1000;   // jog distance for press-and-hold; cancelled on release
let maxTerminalLines;  // oldest lines are dropped beyond this (from settings)

const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const connectBtn = document.getElementById('connect-btn');
const hostInput = document.getElementById('host-input');
const connWrap = document.getElementById('conn');
const connIcon = document.getElementById('conn-icon');
const connTooltip = document.getElementById('conn-tooltip');
const connPopup = document.getElementById('conn-popup');
let connState = 'disconnected';
let connectedHost = null;
const terminalOutput = document.getElementById('terminal-output');
const terminalForm = document.getElementById('terminal-form');
const terminalInput = document.getElementById('terminal-input');
const terminalClear = document.getElementById('terminal-clear');
const homeBtn = document.getElementById('btn-home');

const knifeUpBtn = document.getElementById('btn-knife-up');
const knifeDownBtn = document.getElementById('btn-knife-down');
const bedUpBtn = document.getElementById('btn-bed-up');
const bedDownBtn = document.getElementById('btn-bed-down');
const rotaryCcwBtn = document.getElementById('btn-rotary-ccw');
const rotaryCwBtn = document.getElementById('btn-rotary-cw');

const speedInputs = (kind) => ({
  rapid: document.getElementById(`rapid-${kind}`),
  cut: document.getElementById(`cut-${kind}`),
});
const inputKnifeDistance = document.getElementById('distance-knife');
const inputBedDistance = document.getElementById('distance-bed');
const inputRotaryDistance = document.getElementById('distance-rotary');

// Jogs and moves use the rapid or cut speed of each axis, per the Speed toggle
const settingsBar = document.getElementById('settings-bar');
const speedSwitch = document.getElementById('speed-switch');
let speedMode = 'rapid';

const posEl = (id) => ({ m: document.getElementById(`${id}-m`), w: document.getElementById(`${id}-w`) });
const posKnifeZ = posEl('pos-knife-z');
const posBedY = posEl('pos-bed-y');
const posRotaryA = posEl('pos-rotary-a');

const inputHotwirePwm = document.getElementById('hotwire-pwm');
const btnHotwireToggle = document.getElementById('hotwire-toggle');
let isHotwireOn = false;

try {
  hostInput.value = localStorage.getItem('fluidnc-host') || DEFAULT_HOST;
} catch (e) { }

function getHost() {
  return hostInput.value.trim() || DEFAULT_HOST;
}

// --- DIFFERENTIAL KINEMATICS ---
// Y and A motors drive a differential: moving Y and A together by equal
// amounts translates the platform without rotating it; moving A alone rotates
// it. So bed position = Y, platform rotation = A - Y (work coordinates).
// Assumes y and a share the same steps_per_mm in config.yaml.
const workPos = { X: 0, Y: 0, Z: 0, A: 0 };
const machinePos = { X: 0, Y: 0, Z: 0, A: 0 };
let wco = [0, 0, 0, 0];
let machineState = '';
let statusWaiters = [];

// --- SOFT LIMITS ---
// FluidNC clamps each axis of a jog to its soft limits independently, so a
// synced Y+A bed jog that runs into Y's limit would keep moving A and rotate
// the platform. Read the limits on connect ($/axes/<axis>) and cap bed jogs
// to the travel both axes have left.
const axisLimits = {};  // axis -> { min, max } in machine coords
let axisCapture = null;  // { axis, cfg } while a $/axes/<axis> dump is streaming
const LIMIT_MARGIN = 0.01;

// Mirrors limitsMinPosition/limitsMaxPosition in FluidNC's Limit.cpp (minus the 1-step slop)
function computeLimits(cfg) {
  if (cfg.soft_limits !== 'true') return { min: -Infinity, max: Infinity };
  const travel = parseFloat(cfg.max_travel_mm);
  const homed = 'homing' in cfg;
  const mpos = homed ? (parseFloat(cfg.mpos_mm) || 0) : 0;
  if (!homed || cfg.positive_direction === 'true') return { min: mpos - travel, max: mpos };
  return { min: mpos, max: mpos + travel };
}

// Consumes lines of a "$/axes/y" response; returns true if the line was part of it
function parseAxisConfigLine(text) {
  const head = text.match(/^\/axes\/([a-z]):$/i);
  if (head) {
    axisCapture = { axis: head[1].toUpperCase(), cfg: {} };
    return true;
  }
  if (!axisCapture) return false;
  if (text.startsWith('ok') || text.startsWith('error')) {
    const { axis, cfg } = axisCapture;
    axisCapture = null;
    axisLimits[axis] = computeLimits(cfg);
    setHomingAvailable(axis, 'homing' in cfg);
    logTerminal(`${axis} soft limits: [${axisLimits[axis].min}, ${axisLimits[axis].max}]`, 'system');
    return false;
  }
  const kv = text.match(/^(\w+):\s*(.*)$/);
  if (kv) axisCapture.cfg[kv[1]] = kv[2];  // section headers like "homing:" store ''
  return !text.startsWith('[');
}

function loadAxisLimits() {
  for (const axis of ['y', 'a', 'z']) sendGcode(`$/axes/${axis}`, true);
}

// Travel left in `direction` before either Y or A reaches a soft limit
function bedTravelRemaining(direction) {
  let room = Infinity;
  for (const axis of ['Y', 'A']) {
    const lim = axisLimits[axis];
    if (!lim) {
      logTerminal(`Warning: ${axis} soft limits unknown; bed jog not capped.`, 'error');
      continue;
    }
    room = Math.min(room, direction > 0 ? lim.max - machinePos[axis] : machinePos[axis] - lim.min);
  }
  return Math.max(0, room - LIMIT_MARGIN);
}

function nextStatus(timeoutMs = 500) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    statusWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
    sendRealtime(RT_STATUS);
  });
}

// Positions are only trustworthy for planning once a previous jog has decelerated
async function waitForNotJogging(timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs;
  do {
    await nextStatus();
  } while (machineState.startsWith('Jog') && performance.now() < deadline);
}

// Zero work coordinates. Bed and rotation are coupled (rotation = A - Y), so
// zeroing the bed shifts A by the same amount to keep the rotation reading.
const ZERO_COMMANDS = {
  knife: () => 'G10 L20 P0 Z0',
  bed: () => `G10 L20 P0 Y0 A${(workPos.A - workPos.Y).toFixed(3)}`,
  rotary: () => `G10 L20 P0 A${workPos.Y.toFixed(3)}`,
};

document.querySelectorAll('[data-zero]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    await sendGcode(ZERO_COMMANDS[btn.dataset.zero]());
    sendRealtime(RT_STATUS);
  });
});

// Per-axis homing; enabled once $/axes/<axis> shows a homing section
document.querySelectorAll('[data-home]').forEach((btn) => {
  btn.addEventListener('click', () => sendGcode(`$H${btn.dataset.home}`));
});

function setHomingAvailable(axis, available) {
  const btn = document.querySelector(`[data-home="${axis}"]`);
  if (!btn) return;
  btn.disabled = !available;
  btn.title = available ? `Home ${axis} ($H${axis})` : `No homing configured for ${axis}`;
}

// The hotwire is FluidNC's PWM spindle, with speed_map making S the duty cycle in %
async function updateHotwireState() {
  let pwmVal = parseFloat(inputHotwirePwm.value);
  if (isNaN(pwmVal)) pwmVal = 0;
  pwmVal = Math.min(100, Math.max(0, pwmVal));

  if (isHotwireOn) {
    await sendGcode(`M3 S${pwmVal}`);
  } else {
    await sendGcode('M5');
  }
}

function showHotwireState(on) {
  isHotwireOn = on;
  btnHotwireToggle.textContent = on ? 'ON' : 'OFF';
  btnHotwireToggle.classList.toggle('active', on);
}

btnHotwireToggle.addEventListener('click', async () => {
  showHotwireState(!isHotwireOn);
  await updateHotwireState();
});

inputHotwirePwm.addEventListener('change', async () => {
  if (isHotwireOn) {
    await updateHotwireState();
  }
});

function updateStatus(state, message) {
  connState = state;
  statusDot.className = 'dot ' + state;
  setStatusMessage(message);
  updateConnectButton();
  hostInput.disabled = state === 'connecting';
}

function setStatusMessage(message) {
  statusText.textContent = message;
  connTooltip.textContent = message;
  const alarm = connState === 'connected' && machineState.startsWith('Alarm');
  connIcon.className = `conn-icon ${connState}${alarm ? ' alarm' : ''}`;
  document.getElementById('btn-unlock').classList.toggle('attention', alarm);
}

// Connected + same host => Disconnect; connected + edited host => Reconnect
function updateConnectButton() {
  const connected = connState === 'connected';
  const changed = connected && getHost() !== connectedHost;
  connectBtn.textContent = !connected ? 'Connect' : changed ? 'Reconnect' : 'Disconnect';
  connectBtn.classList.toggle('connected', connected && !changed);
}

function openConnPopup(open) {
  connPopup.hidden = !open;
  connIcon.setAttribute('aria-expanded', String(open));
  connWrap.toggleAttribute('data-open', open);
  if (open) hostInput.focus();
}

// Parse a FluidNC status report, e.g. <Idle|MPos:0.000,1.000,2.000,3.000|FS:0,0|WCO:0,0,0,0>
// Axes are reported in X,Y,Z,A order up to the highest configured axis.
function parseStatusReport(text) {
  const m = text.match(/^<(.*)>$/);
  if (!m) return false;
  const fields = m[1].split('|');
  machineState = fields[0];
  let mpos = null, wpos = null;
  let hasOverrides = false, spindleOn = false;
  for (const f of fields.slice(1)) {
    const [key, val] = f.split(':');
    const nums = (val || '').split(',').map(parseFloat);
    if (key === 'MPos') mpos = nums;
    else if (key === 'WPos') wpos = nums;
    else if (key === 'WCO') wco = nums;
    else if (key === 'Ov') hasOverrides = true;
    else if (key === 'A') spindleOn = /[SC]/.test(val || '');
  }
  // Accessory state (A:) is only reported alongside overrides (Ov:), and omitted when
  // nothing is on; follow it so the toggle reflects M5/reset/alarm from elsewhere
  if (hasOverrides && spindleOn !== isHotwireOn) showHotwireState(spindleOn);
  const pos = wpos || (mpos && mpos.map((v, i) => v - (wco[i] || 0)));
  const mach = mpos || (wpos && wpos.map((v, i) => v + (wco[i] || 0)));
  if (mach) {
    ['X', 'Y', 'Z', 'A'].forEach((axis, i) => {
      if (i < mach.length && !isNaN(mach[i])) machinePos[axis] = mach[i];
    });
  }
  if (pos) {
    ['X', 'Y', 'Z', 'A'].forEach((axis, i) => {
      if (i < pos.length && !isNaN(pos[i])) workPos[axis] = pos[i];
    });
  }
  const rotation = (p) => `${((p.A - p.Y) / MM_PER_DEG).toFixed(1)}°`;
  for (const [el, p] of [['m', machinePos], ['w', workPos]]) {
    posKnifeZ[el].textContent = `${p.Z.toFixed(2)}mm`;
    posBedY[el].textContent = `${p.Y.toFixed(2)}mm`;
    posRotaryA[el].textContent = rotation(p);
  }
  if (ws) setStatusMessage(`Connected to ${connectedHost} · ${machineState}`);
  const waiters = statusWaiters;
  statusWaiters = [];
  waiters.forEach((fn) => fn());
  return true;
}

function logTerminal(text, type = '') {
  if (type === '') {
    if (text.startsWith('ok') || text.startsWith('error')) {
      pendingOks = Math.max(0, pendingOks - 1);
    }
    if (parseStatusReport(text)) return; // don't flood the log with ? responses
    if (parseAxisConfigLine(text)) return;
  }

  const line = document.createElement('div');
  line.className = 'terminal-line ' + type;
  line.textContent = text;
  terminalOutput.appendChild(line);
  while (terminalOutput.childElementCount > maxTerminalLines) terminalOutput.firstElementChild.remove();
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

function isConnected() {
  return ws && ws.readyState === WebSocket.OPEN;
}

async function connectController() {
  if (isConnected()) return true;
  if (isConnecting) return false;

  const host = getHost();
  try {
    localStorage.setItem('fluidnc-host', host);
  } catch (e) { }

  isConnecting = true;
  updateStatus('connecting', `Connecting to ${host}...`);
  logTerminal(`Connecting to ws://${host}/ ...`, 'system');

  return new Promise((resolve) => {
    let socket;
    try {
      socket = new WebSocket(`ws://${host}/`);
      socket.binaryType = 'arraybuffer';
    } catch (err) {
      isConnecting = false;
      updateStatus('disconnected', 'Connection error');
      logTerminal('Connection error: ' + err.message, 'error');
      resolve(false);
      return;
    }

    let opened = false;
    const timeout = setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) socket.close();
    }, 2500);

    socket.onopen = () => {
      opened = true;
      clearTimeout(timeout);
      ws = socket;
      connectedHost = host;
      isConnecting = false;
      pendingOks = 0;
      rxBuffer = '';
      rxDecoder = new TextDecoder();
      updateStatus('connected', `Connected to ${host}`);
      logTerminal(`Connected to ${host}.`, 'system');
      loadAxisLimits();
      resolve(true);
    };

    socket.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) {
        // Control message; only surface the ones meant for humans
        const msg = event.data.trim();
        if (/^(NOTIFICATION|ERROR):/i.test(msg)) logTerminal(msg, 'system');
        return;
      }
      rxBuffer += rxDecoder.decode(event.data, { stream: true });
      const lines = rxBuffer.split('\n');
      rxBuffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) logTerminal(trimmed);
      }
    };

    socket.onclose = (event) => {
      clearTimeout(timeout);
      if (ws === socket) {
        ws = null;
        pendingOks = 0;
        stopJog();
        updateStatus('disconnected', 'Disconnected');
        logTerminal('Connection closed' + (event.reason ? `: ${event.reason}` : '.'), 'system');
      } else if (!opened) {
        // Only a socket that never opened ends the pending attempt; a socket
        // closed by Reconnect must not clobber the new connection's state.
        isConnecting = false;
        updateStatus('disconnected', 'Disconnected');
        logTerminal(`Could not connect to ws://${host}/ (is the controller on the network?)`, 'error');
        resolve(false);
      }
    };
  });
}

function disconnectAll() {
  stopJog();
  if (ws) {
    ws.close();
    ws = null;
  }
  updateStatus('disconnected', 'Disconnected');
  logTerminal('Disconnected.', 'system');
}

async function sendGcode(gcode, silent = false) {
  const trimmed = gcode.trim();
  if (!trimmed) return;

  if (!isConnected()) {
    const ok = await connectController();
    if (!ok) return;
  }

  try {
    pendingOks++;
    ws.send(trimmed + '\n');
    if (!silent) logTerminal('> ' + trimmed, 'sent');
  } catch (err) {
    console.error('Send error:', err);
    logTerminal('Failed to send: ' + err.message, 'error');
  }
}

// Realtime commands bypass the line queue and get no "ok". Text frames are
// UTF-8, which FluidNC decodes, so bytes >= 0x80 (e.g. jog cancel) arrive intact.
function sendRealtime(ch) {
  if (isConnected()) ws.send(ch);
}

// --- STATUS POLLING ---
let statusTimer = null;
let isPollingEnabled = true;
const togglePoll = document.getElementById('toggle-poll');

function startStatusPolling() {
  if (!isPollingEnabled || statusTimer) return;
  statusTimer = setInterval(() => {
    if (isPollingEnabled) sendRealtime(RT_STATUS);
  }, 250);
}

function stopStatusPolling() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
}

if (togglePoll) {
  togglePoll.addEventListener('change', () => {
    isPollingEnabled = togglePoll.checked;
    if (isPollingEnabled) {
      startStatusPolling();
      logTerminal('Status polling enabled.', 'system');
    } else {
      stopStatusPolling();
      logTerminal('Status polling disabled.', 'system');
    }
  });
}

// --- PRESS & HOLD JOGGING LOGIC ---
// Tap: one $J step of the configured distance.
// Hold: after HOLD_MS a long $J is queued behind the step; release sends jog-cancel.
const JOG_AXES = {
  knife: { feed: speedInputs('knife'), dist: inputKnifeDistance },
  bed: { feed: speedInputs('bed'), dist: inputBedDistance },
  rotary: { feed: speedInputs('rotary'), dist: inputRotaryDistance },
};

// delta in mm, feed in mm/min (rotary values are converted from degrees before this)
function jogCommand(kind, delta, feed) {
  const d = delta.toFixed(3);
  switch (kind) {
    case 'knife':
      return `$J=G91 Z${d} F${feed.toFixed(0)}`;
    case 'bed':
      // Y and A move together so the platform translates without rotating.
      // F is the vector feed over both axes; scale by sqrt(2) so each axis runs at `feed`.
      return `$J=G91 Y${d} A${d} F${(feed * Math.SQRT2).toFixed(0)}`;
    case 'rotary':
      return `$J=G91 A${d} F${feed.toFixed(0)}`;
  }
}

function setSpeedMode(mode) {
  speedMode = mode;
  settingsBar.dataset.speedMode = mode;
  for (const btn of speedSwitch.querySelectorAll('[data-mode]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode));
  }
}

speedSwitch.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-mode]');
  if (btn) setSpeedMode(btn.dataset.mode);
});

// Speed input for `kind` (in the current speed mode) in mm/min, clamped to the axis max rate
function jogFeed(kind) {
  let feed = parseFloat(JOG_AXES[kind].feed[speedMode].value);
  if (kind === 'rotary') feed *= 60 * MM_PER_DEG;  // °/s -> mm/min
  if (isNaN(feed) || feed <= 0) feed = MAX_FEED;
  return Math.min(feed, MAX_FEED);
}

async function startJog(btn, kind, direction) {
  stopJog();

  activeBtn = btn;
  activeBtn.classList.add('active-press');

  if (!isConnected()) {
    const connected = await connectController();
    if (!connected || activeBtn !== btn) {
      stopJog();
      return;
    }
  }

  const feed = jogFeed(kind);
  let stepDist = parseFloat(JOG_AXES[kind].dist.value);
  if (kind === 'rotary') stepDist *= MM_PER_DEG;  // ° -> mm
  if (isNaN(stepDist) || stepDist <= 0) stepDist = 1;

  let holdDist = CONTINUOUS_JOG;
  if (kind === 'bed') {
    await waitForNotJogging();
    if (activeBtn !== btn) return;
    const room = bedTravelRemaining(direction);
    if (room <= 0) {
      logTerminal('Bed is at its soft limit.', 'system');
      stopJog();
      return;
    }
    stepDist = Math.min(stepDist, room);
    holdDist = room - stepDist;  // the hold jog is relative to the end of the step
  }

  await sendGcode(jogCommand(kind, direction * stepDist, feed));

  holdTimer = setTimeout(() => {
    holdTimer = null;
    if (activeBtn !== btn || holdDist <= 0) return;
    isHoldJogging = true;
    sendGcode(jogCommand(kind, direction * holdDist, feed));
  }, HOLD_MS);
}

function stopJog() {
  if (holdTimer) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
  if (activeBtn) {
    activeBtn.classList.remove('active-press');
    activeBtn = null;
  }
  if (isHoldJogging) {
    isHoldJogging = false;
    sendRealtime(RT_JOG_CANCEL);
  }
}

function attachJogEvents(btn, kind, direction) {
  const startHandler = (e) => {
    e.preventDefault();
    startJog(btn, kind, direction);
  };

  const stopHandler = (e) => {
    e.preventDefault();
    if (activeBtn === btn) stopJog();
  };

  btn.addEventListener('mousedown', startHandler);
  btn.addEventListener('touchstart', startHandler);

  btn.addEventListener('mouseup', stopHandler);
  btn.addEventListener('mouseleave', stopHandler);
  btn.addEventListener('touchend', stopHandler);
  btn.addEventListener('touchcancel', stopHandler);
}

// Knife: Z axis (Up: +1, Down: -1)
attachJogEvents(knifeUpBtn, 'knife', 1);
attachJogEvents(knifeDownBtn, 'knife', -1);

// Bed: Y+A together (Up: +1, Down: -1)
attachJogEvents(bedUpBtn, 'bed', 1);
attachJogEvents(bedDownBtn, 'bed', -1);

// Rotary: A only (CCW: +1, CW: -1)
attachJogEvents(rotaryCcwBtn, 'rotary', 1);
attachJogEvents(rotaryCwBtn, 'rotary', -1);

// Other Event Listeners
async function onConnectAction() {
  if (isConnected()) {
    const reconnect = getHost() !== connectedHost;
    disconnectAll();
    if (!reconnect) return;
  }
  if (await connectController()) openConnPopup(false);
}

connectBtn.addEventListener('click', onConnectAction);

hostInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') onConnectAction();
});

hostInput.addEventListener('input', updateConnectButton);

connIcon.addEventListener('click', () => openConnPopup(connPopup.hidden));

document.addEventListener('click', (e) => {
  if (!connPopup.hidden && !connWrap.contains(e.target)) openConnPopup(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !connPopup.hidden) {
    openConnPopup(false);
    connIcon.focus();
  }
});

homeBtn.addEventListener('click', async () => {
  homeBtn.classList.add('active-press');
  setTimeout(() => homeBtn.classList.remove('active-press'), 200);
  await sendGcode('$H');
});

// Command history, shell-style: Up/Down step through sent commands; stepping past
// the newest restores the unsent draft. Persisted across reloads.
let maxHistory;  // from settings
let cmdHistory = [];
let historyIndex = 0;  // == cmdHistory.length when not browsing
let historyDraft = '';

try {
  cmdHistory = JSON.parse(localStorage.getItem('terminal-history')) || [];
} catch (e) { }
historyIndex = cmdHistory.length;

function addToHistory(cmd) {
  if (cmdHistory[cmdHistory.length - 1] !== cmd) {
    cmdHistory.push(cmd);
    cmdHistory.splice(0, cmdHistory.length - maxHistory);
    try {
      localStorage.setItem('terminal-history', JSON.stringify(cmdHistory));
    } catch (e) { }
  }
  historyIndex = cmdHistory.length;
  historyDraft = '';
}

// The input grows with its content (up to its CSS max-height)
function setTerminalInput(text) {
  terminalInput.value = text;
  autosizeTerminalInput();
}

function autosizeTerminalInput() {
  terminalInput.style.height = 'auto';
  terminalInput.style.height = `${terminalInput.scrollHeight}px`;
}

terminalInput.addEventListener('input', autosizeTerminalInput);

terminalInput.addEventListener('keydown', (e) => {
  if (e.isComposing) return;

  // Enter sends; Option-Enter inserts a newline (Shift-Enter does natively)
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (e.altKey) {
      terminalInput.setRangeText('\n', terminalInput.selectionStart, terminalInput.selectionEnd, 'end');
      autosizeTerminalInput();
    } else {
      terminalForm.requestSubmit();
    }
    return;
  }

  // Up/Down browse history only from the first/last line, so multi-line input stays editable
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  const { value, selectionStart, selectionEnd } = terminalInput;
  if (selectionStart !== selectionEnd) return;
  if (e.key === 'ArrowUp' ? value.lastIndexOf('\n', selectionStart - 1) !== -1 : value.indexOf('\n', selectionStart) !== -1) return;
  const next = historyIndex + (e.key === 'ArrowUp' ? -1 : 1);
  if (next < 0 || next > cmdHistory.length) return;
  e.preventDefault();
  if (historyIndex === cmdHistory.length) historyDraft = value;
  historyIndex = next;
  setTerminalInput(next === cmdHistory.length ? historyDraft : cmdHistory[next]);
  terminalInput.setSelectionRange(terminalInput.value.length, terminalInput.value.length);
});

// Multi-line input is sent one line at a time, paced like a G-code run and with the
// same lockout; STOP or Reset aborts it
async function sendTerminalInput(text) {
  const lines = text.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) {
    if (lines.length) await sendGcode(lines[0]);
    return;
  }
  if (isStreaming) return;
  if (!isConnected() && !(await connectController())) return;

  isStreaming = true;
  stopRequested = false;
  setRunLock(true);
  runGcodeBtn.disabled = true;
  if (!(await streamLines(lines, { silent: false }))) {
    logTerminal('--- Terminal send aborted ---', 'error');
  }
  isStreaming = false;
  setRunLock(false);
  runGcodeBtn.disabled = gcodeLines.length === 0;
}

terminalForm.addEventListener('submit', (e) => {
  e.preventDefault();
  // While streaming, the Send button is a Stop button
  if (isStreaming) {
    terminalSend.disabled = true;
    terminalSend.textContent = 'Stopping...';
    stopMotion();
    return;
  }
  const text = terminalInput.value;
  if (text.trim()) {
    addToHistory(text.trim());
    setTerminalInput('');
    sendTerminalInput(text);
  }
});

terminalClear.addEventListener('click', () => {
  terminalOutput.innerHTML = '';
});

// Maximize: the terminal card covers the whole window until restored (button or Esc)
const terminalCard = document.getElementById('terminal-card');
const terminalMaxBtn = document.getElementById('terminal-max');

function setTerminalMaximized(max) {
  const atBottom = terminalOutput.scrollHeight - terminalOutput.scrollTop - terminalOutput.clientHeight < 2;
  terminalCard.classList.toggle('maximized', max);
  document.body.classList.toggle('terminal-maximized', max);
  const label = max ? 'Restore terminal' : 'Maximize terminal';
  terminalMaxBtn.title = label;
  terminalMaxBtn.setAttribute('aria-label', label);
  terminalMaxBtn.setAttribute('aria-pressed', String(max));
  if (atBottom) terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

terminalMaxBtn.addEventListener('click', () => {
  setTerminalMaximized(!terminalCard.classList.contains('maximized'));
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && terminalCard.classList.contains('maximized')) setTerminalMaximized(false);
});

// --- MOVE TO POSITION ---
// Clicking a readout opens a popover to move that axis to an absolute position
// in machine (G53) or work coordinates, using $J so it can't disturb modal state.
const movePopup = document.getElementById('move-popup');
const moveTitle = document.getElementById('move-title');
const moveInput = document.getElementById('move-input');
const moveUnit = document.getElementById('move-unit');
const moveGo = document.getElementById('move-go');
const moveCancel = document.getElementById('move-cancel');
const MOVE_LABELS = { knife: 'knife (Z)', bed: 'bed (Y)', rotary: 'rotary (A)' };
let moveTarget = null;  // { kind, coord: 'm' | 'w' }

function readout(kind, p) {
  if (kind === 'knife') return p.Z;
  if (kind === 'bed') return p.Y;
  return (p.A - p.Y) / MM_PER_DEG;
}

function openMovePopup(badge, kind, coord) {
  moveTarget = { kind, coord };
  moveTitle.textContent = `Move ${MOVE_LABELS[kind]} to ${coord === 'm' ? 'machine' : 'work'} position`;
  moveUnit.textContent = kind === 'rotary' ? '°' : 'mm';
  moveInput.value = readout(kind, coord === 'm' ? machinePos : workPos).toFixed(kind === 'rotary' ? 1 : 2);
  movePopup.hidden = false;
  const rect = badge.getBoundingClientRect();
  const left = rect.right + window.scrollX - movePopup.offsetWidth;
  movePopup.style.left = `${Math.max(8, left)}px`;
  movePopup.style.top = `${rect.bottom + window.scrollY + 6}px`;
  moveInput.focus();
  moveInput.select();
}

function closeMovePopup() {
  movePopup.hidden = true;
  moveTarget = null;
}

async function moveTo(kind, coord, value) {
  if (!isConnected() && !(await connectController())) return;
  await waitForNotJogging();

  const pos = coord === 'm' ? machinePos : workPos;
  let feed = jogFeed(kind);
  let targets;  // axis -> target, in the chosen coordinate system
  if (kind === 'knife') {
    targets = { Z: value };
  } else if (kind === 'bed') {
    // Move Y and A by the same delta so the platform doesn't rotate
    const delta = value - pos.Y;
    targets = { Y: value, A: pos.A + delta };
    feed *= Math.SQRT2;
  } else {
    targets = { A: pos.Y + value * MM_PER_DEG };
  }

  // Refuse rather than let FluidNC clamp an axis (which would break the Y/A sync)
  for (const [axis, t] of Object.entries(targets)) {
    const lim = axisLimits[axis];
    const machineTarget = t + (machinePos[axis] - pos[axis]);
    if (lim && (machineTarget < lim.min || machineTarget > lim.max)) {
      logTerminal(`Move rejected: ${axis} would reach ${machineTarget.toFixed(3)} (machine), outside soft limits [${lim.min}, ${lim.max}].`, 'error');
      return;
    }
  }

  const words = Object.entries(targets).map(([axis, t]) => `${axis}${t.toFixed(3)}`).join(' ');
  await sendGcode(`$J=${coord === 'm' ? 'G53 ' : ''}G90 ${words} F${feed.toFixed(0)}`);
}

function submitMove() {
  if (!moveTarget) return;
  const value = parseFloat(moveInput.value);
  if (isNaN(value)) {
    moveInput.focus();
    return;
  }
  const { kind, coord } = moveTarget;
  closeMovePopup();
  moveTo(kind, coord, value);
}

for (const [kind, els] of [['knife', posKnifeZ], ['bed', posBedY], ['rotary', posRotaryA]]) {
  for (const coord of ['m', 'w']) {
    els[coord].addEventListener('click', (e) => {
      e.stopPropagation();
      openMovePopup(els[coord], kind, coord);
    });
  }
}

moveGo.addEventListener('click', submitMove);
moveCancel.addEventListener('click', closeMovePopup);
moveInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitMove();
  else if (e.key === 'Escape') closeMovePopup();
});
document.addEventListener('click', (e) => {
  if (!movePopup.hidden && !movePopup.contains(e.target)) closeMovePopup();
});

// --- TABS LOGIC ---
const tabBtnControl = document.getElementById('tab-btn-control');
const tabBtnGcode = document.getElementById('tab-btn-gcode');
const tabControl = document.getElementById('tab-control');
const tabGcode = document.getElementById('tab-gcode');

function switchTab(tab) {
  const isControl = tab === 'control';
  tabBtnControl.setAttribute('aria-selected', String(isControl));
  tabBtnGcode.setAttribute('aria-selected', String(!isControl));
  tabControl.classList.toggle('active', isControl);
  tabGcode.classList.toggle('active', !isControl);
}

tabBtnControl.addEventListener('click', () => switchTab('control'));
tabBtnGcode.addEventListener('click', () => switchTab('gcode'));

// Modal confirmation; resolves true if the action button was chosen (Esc/Cancel = false)
const confirmDialog = document.getElementById('confirm-dialog');

function confirmAction(title, text, actionLabel) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-text').textContent = text;
  document.getElementById('confirm-ok').textContent = actionLabel;
  confirmDialog.returnValue = '';
  confirmDialog.showModal();
  return new Promise((resolve) => {
    confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'ok'), { once: true });
  });
}

// --- G-CODE SENDER LOGIC ---
const gcodeFileInput = document.getElementById('gcode-file-input');
const gcodeInfo = document.getElementById('gcode-info');
const runGcodeBtn = document.getElementById('run-gcode-btn');
const stopGcodeBtn = document.getElementById('stop-gcode-btn');
const gcodeProgressFill = document.getElementById('gcode-progress-fill');
const gcodeStatusText = document.getElementById('gcode-status-text');

let gcodeLines = [];
let gcodeLineNumbers = [];  // file line index of each entry in gcodeLines, for simulation sync
let isRunningGcode = false;
let isStreaming = false;  // a G-code run or a multi-line terminal send is in progress
let isPaused = false;
let stopRequested = false;

const gcodeCard = document.getElementById('gcode-card');
const simPanel = initSimPanel();

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function loadGcodeFile(file) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    const fileLines = ev.target.result.split('\n');
    simPanel.load(fileLines);
    const program = fileLines
      .map((line, i) => ({ text: line.split(';')[0].trim(), line: i }))
      .filter((l) => l.text);
    gcodeLines = program.map((l) => l.text);
    gcodeLineNumbers = program.map((l) => l.line);
    gcodeCard.classList.add('loaded');

    gcodeInfo.innerHTML = `
      <strong>File:</strong> ${escapeHtml(file.name)} <br>
      <strong>Size:</strong> ${(file.size / 1024).toFixed(2)} KB <br>
      <strong>Commands:</strong> ${gcodeLines.length}
    `;

    runGcodeBtn.disabled = gcodeLines.length === 0 || isStreaming;
    if (gcodeLines.length === 0) {
      gcodeInfo.innerHTML += '<br><span style="color: var(--danger-color);">No valid G-code commands found.</span>';
    }
  };
  reader.readAsText(file);
}

const gcodeClearBtn = document.getElementById('gcode-clear-btn');

function clearGcode() {
  if (isRunningGcode) return;
  gcodeLines = [];
  gcodeLineNumbers = [];
  simPanel.clear();
  gcodeFileInput.value = '';
  gcodeCard.classList.remove('loaded');
  gcodeInfo.textContent = 'No file loaded.';
  runGcodeBtn.disabled = true;
  gcodeProgressFill.style.width = '0%';
  gcodeStatusText.textContent = 'Ready';
}

gcodeClearBtn.addEventListener('click', async () => {
  if (isRunningGcode) return;
  const ok = await confirmAction('Clear loaded G-code?', 'The program and its simulation will be removed.', 'Clear');
  if (ok) clearGcode();
});

// A cancelled picker can report no file; keep the current program in that case
gcodeFileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) loadGcodeFile(e.target.files[0]);
});

// The whole G-code panel accepts drops (the drop zone before a file is loaded, the
// card outline after). dragenter/dragleave also fire for child elements, so count
// depth to know when the drag has left the panel.
let dragDepth = 0;
gcodeCard.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  if (!isRunningGcode) gcodeCard.classList.add('dragover');
});
gcodeCard.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) gcodeCard.classList.remove('dragover');
});
gcodeCard.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = isRunningGcode ? 'none' : 'copy';
});
gcodeCard.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  gcodeCard.classList.remove('dragover');
  if (isRunningGcode) return;
  const file = e.dataTransfer.files[0];
  if (file) {
    gcodeFileInput.value = '';  // keep the input from showing a stale selection
    loadGcodeFile(file);
  }
});

// A drop that misses the panel would otherwise navigate the browser to the file
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (!gcodeCard.contains(e.target)) e.dataTransfer.dropEffect = 'none';
});
window.addEventListener('drop', (e) => e.preventDefault());

// The Run button doubles as Pause/Resume while a program is streaming. Pause is a
// feed hold (motion decelerates and waits) plus holding back further lines; Resume
// is cycle start.
function setPaused(paused) {
  isPaused = paused;
  sendRealtime(paused ? RT_FEED_HOLD : RT_CYCLE_START);
  runGcodeBtn.textContent = paused ? 'Resume' : 'Pause';
  logTerminal(paused ? 'Paused (feed hold).' : 'Resumed.', 'system');
  if (paused) gcodeStatusText.textContent = 'Paused';
  simPanel.setRunState(true, paused);
}

runGcodeBtn.addEventListener('click', () => {
  if (isRunningGcode) setPaused(!isPaused);
  else runProgram();
});

async function runProgram() {
  if (gcodeLines.length === 0 || isStreaming) return;

  if (!isConnected()) {
    const ok = await connectController();
    if (!ok) return;
  }

  isRunningGcode = true;
  isStreaming = true;
  isPaused = false;
  stopRequested = false;
  runGcodeBtn.textContent = 'Pause';
  gcodeFileInput.disabled = true;  // the Run button now means Pause; don't swap files mid-run
  gcodeClearBtn.disabled = true;
  setRunLock(true);
  stopGcodeBtn.disabled = false;
  stopGcodeBtn.style.background = 'var(--danger-color)';
  stopGcodeBtn.style.color = '#fff';

  const linesToSend = [...gcodeLines];
  const fileLineOf = [...gcodeLineNumbers];
  simPanel.setRunState(true, false);
  simPanel.follow(-1);

  const total = linesToSend.length;
  let sent = 0;
  const startTime = performance.now();

  gcodeProgressFill.style.width = '0%';
  gcodeStatusText.textContent = `Starting...`;
  
  // Stop polling to reduce serial noise
  const wasPolling = isPollingEnabled;
  if (wasPolling && togglePoll) {
     togglePoll.checked = false;
     togglePoll.dispatchEvent(new Event('change'));
  }

  logTerminal(`--- Starting G-code file (${total} commands) ---`, 'system');

  // Send a newline to clear buffer
  await sendGcode('', true);

  const completed = await streamLines(linesToSend, {
    onSent: (i) => {
      simPanel.follow(fileLineOf[i]);
      const sent = i + 1;
      if (i % 5 === 0 || sent === total) {
        const percent = ((sent / total) * 100).toFixed(1);
        const elapsed = ((performance.now() - startTime) / 1000);
        gcodeProgressFill.style.width = percent + '%';
        gcodeStatusText.textContent = `Sent ${sent}/${total} (${percent}%) | Elapsed: ${elapsed.toFixed(1)}s`;
      }
    },
  });
  if (!completed) logTerminal('--- G-code run aborted by user ---', 'error');

  isRunningGcode = false;
  isStreaming = false;
  isPaused = false;
  runGcodeBtn.textContent = 'Run G-code';
  gcodeFileInput.disabled = false;
  gcodeClearBtn.disabled = false;
  setRunLock(false);
  simPanel.setRunState(false, false);
  stopGcodeBtn.disabled = true;
  stopGcodeBtn.textContent = 'Stop';
  stopGcodeBtn.style.background = 'rgba(239, 68, 68, 0.2)';
  stopGcodeBtn.style.color = 'var(--danger-color)';

  if (!stopRequested) {
    gcodeStatusText.textContent = `Finished in ${((performance.now() - startTime) / 1000).toFixed(1)}s`;
    logTerminal('--- G-code run completed ---', 'system');
  }
  
  // Restore polling
  if (wasPolling && togglePoll) {
     togglePoll.checked = true;
     togglePoll.dispatchEvent(new Event('change'));
  }
}

// Send lines in order, keeping at most two unacknowledged so the controller's input
// buffer can't overflow. Lines are held back while paused, checked right before
// sending so a line waiting on backpressure doesn't slip out after the feed hold.
// Returns false if a stop was requested before every line was sent.
async function streamLines(lines, { silent = true, onSent } = {}) {
  for (let i = 0; i < lines.length; i++) {
    while (pendingOks >= 2 && !stopRequested) {
      await new Promise(r => setTimeout(r, 10));
    }
    while (isPaused && !stopRequested) {
      await new Promise(r => setTimeout(r, 50));
    }
    if (stopRequested) return false;
    await sendGcode(lines[i], silent);
    onSent?.(i);
  }
  return true;
}

// While a program streams, lock out controls that would inject commands between its
// lines (jogs, moves, home/zero, unlock, sleep, terminal). Stop, Reset and
// Pause/Resume stay live.
const RUN_LOCKED = [
  '.axis-actions',
  '.pos-stack',
  '#tab-control .btn:not(.btn-stop)',
  '#btn-unlock',
  '#btn-sleep',
  '#btn-restart',
  '#gcode-open-btn',
].join(', ');
const terminalSend = terminalForm.querySelector('.terminal-send');

function setRunLock(locked) {
  if (locked) {
    stopJog();
    closeMovePopup();
  }
  for (const el of document.querySelectorAll(RUN_LOCKED)) {
    el.inert = locked;
    el.classList.toggle('run-locked', locked);
  }
  // Send turns into Stop, so a run can be stopped from the terminal (even maximized)
  terminalInput.disabled = locked;
  terminalSend.disabled = false;
  terminalSend.textContent = locked ? 'Stop' : 'Send';
  terminalSend.classList.toggle('stop', locked);
  terminalInput.placeholder = locked ? 'Disabled while G-code is sending' : 'Send G-code command...';
}

// Leaving the page mid-run would silently stop streaming partway through the program.
// Ask first (browsers show their own fixed wording); if the user leaves anyway,
// feed-hold on the way out so the machine stops cleanly rather than finishing
// whatever was already queued and halting at an arbitrary point.
window.addEventListener('beforeunload', (e) => {
  if (!isStreaming) return;
  e.preventDefault();
  e.returnValue = '';
});

window.addEventListener('pagehide', () => {
  if (!isStreaming) return;
  sendRealtime(RT_JOG_CANCEL);
  sendRealtime(RT_FEED_HOLD);
});

// --- STOP ---
// Cancel any jog and feed-hold everything else, then once the hold has finished
// decelerating (Hold:0), soft-reset to discard queued motion. Resetting while still
// moving would stop the steppers abruptly and raise an Abort Cycle alarm.
let isStopping = false;

async function stopMotion() {
  stopJog();
  if (isStreaming) stopRequested = true;
  if (isRunningGcode) {
    stopGcodeBtn.textContent = 'Stopping...';
    stopGcodeBtn.disabled = true;
  }
  if (!isConnected() || isStopping) return;
  isStopping = true;
  sendRealtime(RT_JOG_CANCEL);
  sendRealtime(RT_FEED_HOLD);
  logTerminal('Stop requested...', 'system');

  const deadline = performance.now() + 5000;
  do {
    await nextStatus();
  } while (/^(Hold:1|Jog|Run)/.test(machineState) && performance.now() < deadline);

  if (machineState.startsWith('Hold')) {
    sendRealtime(RT_RESET);
    pendingOks = 0;  // commands still queued will never be acknowledged
    logTerminal('Stopped; queued motion discarded.', 'system');
  } else {
    logTerminal(`Stopped (${machineState}).`, 'system');
  }
  isStopping = false;
}

document.getElementById('btn-stop').addEventListener('click', stopMotion);

// --- MACHINE STATE ACTIONS ---
document.getElementById('btn-unlock').addEventListener('click', () => sendGcode('$X'));

// A reset mid-motion would raise Abort Cycle, so route moving machines through stopMotion
document.getElementById('btn-reset').addEventListener('click', async () => {
  if (!isConnected()) return;
  await nextStatus();
  if (/^(Run|Jog|Hold:1|Home)/.test(machineState)) {
    stopMotion();
    return;
  }
  stopJog();
  if (isStreaming) stopRequested = true;
  sendRealtime(RT_RESET);
  pendingOks = 0;
  logTerminal('Soft reset.', 'system');
});

document.getElementById('btn-sleep').addEventListener('click', () => sendGcode('$SLP'));

// $Bye reboots the controller, which is what reloads config.yaml (a soft reset doesn't).
// The socket drops during the reboot; keep trying to reconnect until it's back.
document.getElementById('btn-restart').addEventListener('click', async () => {
  if (!isConnected() || isStreaming) return;
  const ok = await confirmAction(
    'Restart controller?',
    'Reboots the board and reloads config.yaml. Motion and the hotwire stop, and axes will need homing again.',
    'Restart'
  );
  if (!ok || !isConnected()) return;
  const socket = ws;
  stopJog();
  logTerminal('Restarting controller...', 'system');
  await sendGcode('$Bye');
  await new Promise((resolve) => {
    socket.addEventListener('close', resolve, { once: true });
    setTimeout(resolve, 5000);
  });
  for (let i = 0; i < 15 && !isConnected(); i++) {
    await new Promise((r) => setTimeout(r, 2000));
    await connectController();
  }
});
stopGcodeBtn.addEventListener('click', stopMotion);

// --- SETTINGS ---
// Built-in defaults apply immediately; settings.json from the controller (edited on
// config.html) replaces them once loaded. Edits on this page last until reload.
function applySettings(settings) {
  for (const f of FIELDS) {
    if (!f.input) continue;
    const el = document.getElementById(f.input);
    Object.assign(el, { min: f.min, max: f.max, step: f.step, value: getPath(settings, f.path) });
  }
  setSpeedMode(settings.speedMode);
  maxTerminalLines = settings.terminal.maxLines;
  maxHistory = settings.terminal.maxHistory;
  cmdHistory.splice(0, cmdHistory.length - maxHistory);
  historyIndex = cmdHistory.length;
}

applySettings(builtinSettings());
loadSettings()
  .then(({ settings, problems }) => {
    applySettings(settings);
    for (const p of problems) logTerminal(`${SETTINGS_URL}: ${p}; using the built-in default.`, 'error');
  })
  .catch((err) => logTerminal(`Couldn't load ${SETTINGS_URL}: ${err.message}. Using built-in defaults.`, 'error'));

// Attempt auto-connecting on load & start status polling
window.addEventListener('DOMContentLoaded', () => {
  connectController();
  startStatusPolling();
});
