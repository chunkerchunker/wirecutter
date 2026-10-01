// Config page: edit the UI defaults in settings.json on the controller (see settings.js).

import { FIELDS, getPath, setPath, validate, builtinSettings, loadSettings, saveSettings, SETTINGS_VERSION, SETTINGS_URL } from './settings.js';

const $ = (id) => document.getElementById(id);
const form = $('config-form');
const statusEl = $('config-status');
const saveBtn = $('config-save');
const rawEl = $('config-raw');

let saved = null;  // settings as last loaded from (or saved to) the controller
let needsSave = false;  // the stored file is broken or has invalid values, so saving fixes it
const inputs = new Map();  // path -> input/select

// One card per group, one row per field
for (const f of FIELDS) {
  let card = form.querySelector(`[data-group="${f.group}"]`);
  if (!card) {
    card = document.createElement('fieldset');
    card.className = 'config-card';
    card.dataset.group = f.group;
    card.innerHTML = `<legend>${f.group}</legend>`;
    form.append(card);
  }
  const row = document.createElement('label');
  row.className = 'setting-row';
  row.innerHTML = `<span class="setting-label">${f.label}</span>`;
  let input;
  if (f.options) {
    input = document.createElement('select');
    input.className = 'config-select';
    for (const [value, text] of Object.entries(f.options)) input.add(new Option(text, value));
    row.append(input);
  } else {
    const wrap = document.createElement('span');
    wrap.className = 'input-with-unit';
    input = document.createElement('input');
    Object.assign(input, { type: 'number', min: f.min, max: f.max, step: 'any' });
    wrap.append(input, Object.assign(document.createElement('span'), { className: 'unit', textContent: f.unit }));
    row.append(wrap);
  }
  inputs.set(f.path, input);
  card.append(row);
}

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = `config-status ${kind}`;
}

function fillForm(settings) {
  for (const f of FIELDS) inputs.get(f.path).value = getPath(settings, f.path);
  onEdit();
}

// { settings, errors }; marks invalid fields
function readForm() {
  const settings = { version: SETTINGS_VERSION };
  const errors = [];
  for (const f of FIELDS) {
    const input = inputs.get(f.path);
    const value = f.options ? input.value : (input.value.trim() === '' ? NaN : Number(input.value));
    const err = validate(f, value);
    const box = input.closest('.input-with-unit') || input;
    box.classList.toggle('invalid', !!err);
    input.title = err ? `${f.label} ${err}` : '';
    if (err) errors.push({ f, err, input });
    setPath(settings, f.path, value);
  }
  return { settings, errors };
}

function isDirty() {
  return needsSave || (saved !== null && JSON.stringify(readForm().settings) !== JSON.stringify(saved));
}

function onEdit() {
  const { errors } = readForm();
  const dirty = isDirty();
  saveBtn.disabled = !dirty || errors.length > 0;
  if (errors.length) setStatus(`${errors.length} invalid value${errors.length > 1 ? 's' : ''}`, 'error');
  else if (dirty) setStatus('Unsaved changes');
  else if (statusEl.classList.contains('error')) setStatus('');
}

async function load(message = '') {
  setStatus('Loading...');
  try {
    const { settings, problems, found } = await loadSettings();
    saved = settings;
    needsSave = problems.length > 0;
    fillForm(settings);
    rawEl.textContent = JSON.stringify(settings, null, 2);
    if (problems.length) setStatus(`Ignored invalid values in ${SETTINGS_URL}: ${problems.join('; ')}`, 'error');
    else if (!found) setStatus('No settings saved yet; showing built-in defaults.');
    else setStatus(message, message ? 'ok' : '');
  } catch (err) {
    // Unreadable file: start from the built-ins so saving replaces it
    saved = builtinSettings();
    needsSave = true;
    fillForm(saved);
    rawEl.textContent = '';
    setStatus(`Couldn't load ${SETTINGS_URL}: ${err.message}. Showing built-in defaults.`, 'error');
  }
}

form.addEventListener('input', onEdit);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const { settings, errors } = readForm();
  if (errors.length) {
    errors[0].input.focus();
    setStatus(`${errors[0].f.group} ${errors[0].f.label.toLowerCase()} ${errors[0].err}`, 'error');
    return;
  }
  saveBtn.disabled = true;
  setStatus('Saving...');
  try {
    await saveSettings(settings);
  } catch (err) {
    setStatus(`Save failed: ${err.message} (saving only works when this page is served by the controller)`, 'error');
    saveBtn.disabled = false;
    return;
  }
  await load('Saved.');  // read back to confirm what the controller stored
});

$('config-revert').addEventListener('click', () => load());
$('config-builtin').addEventListener('click', () => fillForm(builtinSettings()));

window.addEventListener('beforeunload', (e) => {
  if (!isDirty()) return;
  e.preventDefault();
  e.returnValue = '';
});

load();
