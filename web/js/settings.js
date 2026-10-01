// UI defaults, stored as settings.json next to the page on the controller's SD card.
// It lives outside web/, so deploys never overwrite (or gzip-shadow) it. The control
// page loads it at startup; the config page edits it. A missing, partial or invalid
// file falls back to the built-in defaults below, field by field.

import { MM_PER_DEG, MAX_FEED } from './machine.js';

export const SETTINGS_URL = 'settings.json';
export const SETTINGS_VERSION = 1;

const MAX_ROTARY_SPEED = Math.floor(MAX_FEED / 60 / MM_PER_DEG);  // °/s

// path: location in settings.json; input: element id on the control page (if any)
export const FIELDS = [
  { group: 'Knife (Z)', path: 'axes.knife.rapid', input: 'rapid-knife', label: 'Rapid speed', unit: 'mm/min', min: 10, max: MAX_FEED, step: 100, default: MAX_FEED },
  { group: 'Knife (Z)', path: 'axes.knife.cut', input: 'cut-knife', label: 'Cut speed', unit: 'mm/min', min: 10, max: MAX_FEED, step: 100, default: 300 },
  { group: 'Knife (Z)', path: 'axes.knife.distance', input: 'distance-knife', label: 'Jog distance', unit: 'mm', min: 0.01, max: 100, step: 0.05, default: 10 },
  { group: 'Bed (Y)', path: 'axes.bed.rapid', input: 'rapid-bed', label: 'Rapid speed', unit: 'mm/min', min: 100, max: MAX_FEED, step: 100, default: MAX_FEED },
  { group: 'Bed (Y)', path: 'axes.bed.cut', input: 'cut-bed', label: 'Cut speed', unit: 'mm/min', min: 100, max: MAX_FEED, step: 100, default: 300 },
  { group: 'Bed (Y)', path: 'axes.bed.distance', input: 'distance-bed', label: 'Jog distance', unit: 'mm', min: 0.1, max: 500, step: 1, default: 10 },
  { group: 'Rotary (A)', path: 'axes.rotary.rapid', input: 'rapid-rotary', label: 'Rapid speed', unit: '°/s', min: 1, max: MAX_ROTARY_SPEED, step: 5, default: MAX_ROTARY_SPEED },
  { group: 'Rotary (A)', path: 'axes.rotary.cut', input: 'cut-rotary', label: 'Cut speed', unit: '°/s', min: 1, max: MAX_ROTARY_SPEED, step: 5, default: 10 },
  { group: 'Rotary (A)', path: 'axes.rotary.distance', input: 'distance-rotary', label: 'Jog angle', unit: '°', min: 0.1, max: 360, step: 1, default: 1 },
  { group: 'Hotwire', path: 'hotwire.pwm', input: 'hotwire-pwm', label: 'PWM', unit: '%', min: 0, max: 100, step: 1, default: 75 },
  { group: 'Hotwire', path: 'speedMode', label: 'Jog speed', options: { rapid: 'Rapid', cut: 'Cut' }, default: 'rapid' },
  { group: 'Terminal', path: 'terminal.maxLines', label: 'Max lines', unit: 'lines', min: 100, max: 20000, step: 100, integer: true, default: 2000 },
  { group: 'Terminal', path: 'terminal.maxHistory', label: 'Max history', unit: 'cmds', min: 10, max: 1000, step: 10, integer: true, default: 100 },
];

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o != null ? o[k] : undefined), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  for (const k of keys) obj = obj[k] ??= {};
  obj[last] = value;
}

// Error message if `value` isn't acceptable for `field`, else null
export function validate(field, value) {
  if (field.options) return value in field.options ? null : `must be one of: ${Object.keys(field.options).join(', ')}`;
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
  if (field.integer && !Number.isInteger(value)) return 'must be a whole number';
  if (value < field.min || value > field.max) return `must be between ${field.min} and ${field.max}`;
  return null;
}

export function builtinSettings() {
  const s = { version: SETTINGS_VERSION };
  for (const f of FIELDS) setPath(s, f.path, f.default);
  return s;
}

// Full settings from a parsed file: valid values from the file, defaults for the rest.
// `problems` lists the fields that fell back.
export function mergeSettings(file) {
  const settings = builtinSettings();
  const problems = [];
  for (const f of FIELDS) {
    const value = getPath(file, f.path);
    if (value === undefined) continue;
    const err = validate(f, value);
    if (err) problems.push(`${f.path} ${err}`);
    else setPath(settings, f.path, value);
  }
  return { settings, problems };
}

// The controller answers 404 when it's already serving two files, so a 404 is
// retried a few times before it's taken to mean the file doesn't exist
async function fetchSettings() {
  for (let attempt = 1; ; attempt++) {
    const resp = await fetch(SETTINGS_URL, { cache: 'no-store' });
    if (resp.status !== 404 || attempt === 3) return resp;
    await new Promise((r) => setTimeout(r, 300 * attempt));
  }
}

// { settings, problems, found }; found is false when the file doesn't exist
export async function loadSettings() {
  const resp = await fetchSettings();
  if (resp.status === 404) return { settings: builtinSettings(), problems: [], found: false };
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  let file;
  try {
    file = JSON.parse(await resp.text());
  } catch (e) {
    throw new Error(`${SETTINGS_URL} is not valid JSON (${e.message})`);
  }
  return { ...mergeSettings(file), found: true };
}

// FluidNC's WebDAV drops PUT bodies sent as form data, so send them as octet-stream
export async function saveSettings(settings) {
  const resp = await fetch(SETTINGS_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: JSON.stringify(settings, null, 2) + '\n',
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
}
