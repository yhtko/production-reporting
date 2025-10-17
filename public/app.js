(() => {
const API_ENDPOINT = 'https://production-reporting.pages.dev/api/sync';

// --- 簡易IndexedDB（キュー用）---
const DB_NAME = 'prod-reporting';
const STORE = 'queue';
function dbp() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { autoIncrement: true });
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function enqueue(item) {
  const db = await dbp();
  await new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add(item);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function allAndClear() {
  const db = await dbp();
  const items = await new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
  await new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  return items;
}

// --- ユーティリティ ---
const $ = (id) => document.getElementById(id);
const msg = (t, ok = false) => {
  const m = $('msg');
  if (!m) return;
  m.textContent = t;
  m.className = ok ? 'ok' : 'err';
};

const form = $('reportForm');
const entryModeInputs = Array.from(document.querySelectorAll('input[name="entryType"]'));
const formRows = Array.from(document.querySelectorAll('#reportForm .row'));
const startLinkSelect = $('startLink');
const startSummary = $('startSummary');
const planSummary = $('planSummary');
const planInput = $('planId');
const planOptionsList = $('planOptions');
const operatorInput = $('operator');
const operatorOptionsList = $('operatorOptions');
const equipmentInput = $('equipment');
const equipmentOptionsList = $('equipmentOptions');

const OPEN_STARTS_KEY = 'open-start-records';
const FORM_META_KEY = 'kintone-form-meta';
const LOOKUP_CACHE_PREFIX = 'lookup-cache:';

const getEntryMode = () => document.querySelector('input[name="entryType"]:checked')?.value || 'start';

function currentLocalDateTimeValue() {
  const now = new Date();
  now.setSeconds(0, 0);
  const offsetMinutes = now.getTimezoneOffset();
  const local = new Date(now.getTime() - offsetMinutes * 60000);
  return local.toISOString().slice(0, 16);
}

function ensureDateTimeValue(input) {
  if (!input) return;
  if (!input.value) {
    input.value = currentLocalDateTimeValue();
  }
}

function setDateTimeToNow(input) {
  if (!input) return;
  input.value = currentLocalDateTimeValue();
}

function uniqueList(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

// --- LocalStorage helpers ---
function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn(`failed to persist ${key}`, e);
  }
}

function loadOpenStarts() {
  const list = loadJson(OPEN_STARTS_KEY, []);
  return Array.isArray(list) ? list : [];
}

function saveOpenStarts(list) {
  saveJson(OPEN_STARTS_KEY, list);
}

// --- kintone メタ/lookup 関連 ---
let formProperties = {};
const lookupStates = new Map();

function createLookupState(fieldCode, input, listEl, options = {}) {
  if (!fieldCode || !input || !listEl) return null;
  const state = {
    fieldCode,
    input,
    listEl,
    config: null,
    cache: new Map(),
    cacheLoaded: false,
    lastSuggestions: [],
    labelLookup: new Map(),
    suggestionTimer: null,
    selectionToken: 0,
    applyData: options.applyData || (() => {}),
    afterCacheUpdate: options.afterCacheUpdate || (() => {}),
    storageKey: options.storageKey || `${LOOKUP_CACHE_PREFIX}${fieldCode}`,
  };
  lookupStates.set(fieldCode, state);
  return state;
}

const planFieldCode = planInput?.dataset.kintoneCode || 'plan_id';
const planLookupState = createLookupState(planFieldCode, planInput, planOptionsList, {
  afterCacheUpdate: () => renderStartOptions(),
  storageKey: 'plan-lookup-cache',
});
if (planLookupState) {
  planLookupState.applyData = (data) => {
    if (!data) {
      renderPlanSummary(null);
      return;
    }
    if (data.values) {
      renderPlanSummary(data);
      applyPlanDefaults(data);
    } else if (data.key) {
      renderPlanSummary(data);
    }
  };
}

const operatorFieldCode = operatorInput?.dataset.kintoneCode || 'operator';
const operatorLookupState = createLookupState(operatorFieldCode, operatorInput, operatorOptionsList);

const equipmentFieldCode = equipmentInput?.dataset.kintoneCode || 'equipment';
const equipmentLookupState = createLookupState(equipmentFieldCode, equipmentInput, equipmentOptionsList);

function loadCachedFormProperties() {
  const cached = loadJson(FORM_META_KEY, null);
  if (cached && typeof cached === 'object' && cached.properties) {
    formProperties = cached.properties;
    refreshLookupConfigs();
    applyFormOptions();
    if (planInput?.value) {
      applyPlanSelection(planInput.value.trim(), false);
    }
    if (operatorInput?.value) {
      applyLookupSelection(operatorLookupState, operatorInput.value.trim(), false);
    }
    if (equipmentInput?.value) {
      applyLookupSelection(equipmentLookupState, equipmentInput.value.trim(), false);
    }
  }
}

function persistFormProperties(full) {
  saveJson(FORM_META_KEY, full);
}

function deriveLookupConfig(fieldCode) {
  if (!fieldCode || !formProperties || typeof formProperties !== 'object') return null;
  for (const key of Object.keys(formProperties)) {
    const prop = formProperties[key];
    if (!prop || prop.type !== 'LOOKUP' || !prop.lookup) continue;
    const mappings = Array.isArray(prop.lookup.fieldMappings) ? prop.lookup.fieldMappings : [];
    if (!mappings.some((m) => m?.field === fieldCode)) continue;
    const relatedApp = prop.lookup.relatedApp?.app;
    const relatedKeyField = prop.lookup.relatedKeyField;
    if (!relatedApp || !relatedKeyField) continue;
    const pickerFields = Array.isArray(prop.lookup.lookupPickerFields)
      ? prop.lookup.lookupPickerFields.filter((v) => typeof v === 'string')
      : [];
    const fieldMappings = mappings
      .filter((m) => m && typeof m.field === 'string' && typeof m.relatedField === 'string')
      .map((m) => ({ field: m.field, relatedField: m.relatedField }));
    const mappedFields = fieldMappings.map((m) => m.relatedField);
    const fieldSet = uniqueList([relatedKeyField, ...pickerFields, ...mappedFields, '$id']);
    return { fieldCode, relatedApp, relatedKeyField, pickerFields, fieldMappings, fieldSet };
  }
  return null;
}

function refreshLookupConfigs() {
  lookupStates.forEach((state) => {
    if (!state) return;
    state.config = deriveLookupConfig(state.fieldCode);
    if (!state.config) {
      state.labelLookup = new Map();
      return;
    }
    if (!state.cacheLoaded) {
      loadLookupCache(state);
      state.cacheLoaded = true;
    } else if (state.cache.size) {
      const sample = Array.from(state.cache.values()).slice(0, 30);
      renderLookupOptionList(state, sample);
      state.afterCacheUpdate();
    }
    if (!state.cache.size) {
      fetchLookupOptions(state, '');
    }
  });
}

function loadLookupCache(state) {
  if (!state) return;
  const cached = loadJson(state.storageKey, []);
  if (!Array.isArray(cached)) return;
  state.cache.clear();
  cached.forEach((entry) => {
    if (!entry || !entry.key || !entry.values) return;
    state.cache.set(entry.key, { key: entry.key, values: entry.values });
  });
  if (state.cache.size) {
    const sample = Array.from(state.cache.values()).slice(0, 30);
    renderLookupOptionList(state, sample);
    state.afterCacheUpdate();
  }
}

function persistLookupCache(state) {
  if (!state) return;
  const items = Array.from(state.cache.entries()).map(([key, data]) => ({ key, values: data.values }));
  saveJson(state.storageKey, items);
}

function trimLookupCache(state, limit = 200) {
  if (!state) return;
  while (state.cache.size > limit) {
    const firstKey = state.cache.keys().next().value;
    state.cache.delete(firstKey);
  }
}

function normalizeLookupRecord(state, record) {
  if (!state?.config || !record) return null;
  const values = {};
  state.config.fieldSet.forEach((code) => {
    if (record[code] && typeof record[code] === 'object' && 'value' in record[code]) {
      values[code] = record[code].value;
    } else if (code === '$id' && record.$id?.value) {
      values[code] = record.$id.value;
    } else {
      values[code] = '';
    }
  });
  const key = values[state.config.relatedKeyField] || '';
  return key ? { key, values } : null;
}

function lookupLabelFromData(state, data) {
  if (!state || !data) return '';
  if (!state.config?.pickerFields?.length) {
    return data.key || '';
  }
  const fields = state.config.pickerFields;
  const parts = fields
    .map((code) => data.values?.[code])
    .filter((v, idx) => typeof v === 'string' && (idx === 0 || v !== data.values?.[state.config.relatedKeyField]));
  const display = parts.filter(Boolean).join(' / ');
  if (!display) return data.key || '';
  return display.includes(data.key) ? display : `${data.key} / ${display}`;
}

function renderLookupOptionList(state, list) {
  if (!state?.listEl) return;
  state.listEl.innerHTML = '';
  state.labelLookup = new Map();
  list.forEach((item) => {
    if (!item || !item.key) return;
    const option = document.createElement('option');
    option.value = item.key;
    const label = lookupLabelFromData(state, item);
    if (label && label !== item.key) {
      option.label = label;
      state.labelLookup.set(label.toLowerCase(), item.key);
      state.labelLookup.set(`${item.key} / ${label}`.toLowerCase(), item.key);
    }
    state.labelLookup.set(item.key.toLowerCase(), item.key);
    state.listEl.appendChild(option);
  });
  state.lastSuggestions = list;
}

function populateDatalist(listEl, options) {
  if (!listEl) return;
  listEl.innerHTML = '';
  options.forEach((label) => {
    if (!label) return;
    const opt = document.createElement('option');
    opt.value = label;
    listEl.appendChild(opt);
  });
}

function applyFormOptions() {
  const apply = (input, listEl) => {
    if (!input || !listEl) return;
    const code = input.dataset.kintoneCode;
    if (!code || !formProperties || !formProperties[code]) return;
    const field = formProperties[code];
    if (field.type === 'DROP_DOWN' && field.options) {
      const opts = Object.values(field.options)
        .filter((o) => o && typeof o.label === 'string')
        .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
        .map((o) => o.label);
      populateDatalist(listEl, opts);
    }
  };
  apply(operatorInput, operatorOptionsList);
  apply(equipmentInput, equipmentOptionsList);
}

async function fetchFormProperties() {
  try {
    const res = await fetch(`${API_ENDPOINT}?type=form`);
    if (!res.ok) throw new Error(await res.text());
    const json = await res.json();
    if (!json || typeof json !== 'object' || !json.properties) return;
    formProperties = json.properties;
    persistFormProperties(json);
    refreshLookupConfigs();
    applyFormOptions();
    if (planInput?.value) {
      applyPlanSelection(planInput.value.trim(), true);
    }
    if (operatorInput?.value) {
      applyLookupSelection(operatorLookupState, operatorInput.value.trim(), true);
    }
    if (equipmentInput?.value) {
      applyLookupSelection(equipmentLookupState, equipmentInput.value.trim(), true);
    }
  } catch (e) {
    console.warn('failed to fetch form properties', e);
  }
}

async function fetchLookupOptions(state, term = '') {
  if (!state?.config) return;
  const params = new URLSearchParams({ type: 'lookup-options', field: state.fieldCode });
  if (term) params.set('term', term);
  try {
    const res = await fetch(`${API_ENDPOINT}?${params.toString()}`);
    if (!res.ok) throw new Error(await res.text());
    const json = await res.json();
    const records = Array.isArray(json?.records) ? json.records : [];
    const normalized = records
      .map((rec) => normalizeLookupRecord(state, rec))
      .filter((rec) => rec && rec.key);
    normalized.forEach((item) => {
      state.cache.set(item.key, item);
    });
    trimLookupCache(state);
    persistLookupCache(state);
    if (normalized.length) {
      renderLookupOptionList(state, normalized);
    } else if (!term && state.cache.size) {
      const sample = Array.from(state.cache.values()).slice(0, 30);
      renderLookupOptionList(state, sample);
    }
    state.afterCacheUpdate();
  } catch (e) {
    console.warn('failed to fetch lookup options', e);
  }
}

async function fetchLookupRecord(state, value) {
  if (!state?.config || !value) return null;
  const params = new URLSearchParams({ type: 'lookup-record', field: state.fieldCode, value });
  try {
    const res = await fetch(`${API_ENDPOINT}?${params.toString()}`);
    if (!res.ok) throw new Error(await res.text());
    const json = await res.json();
    if (!json || typeof json !== 'object' || !json.record) return null;
    const normalized = normalizeLookupRecord(state, json.record);
    if (normalized) {
      state.cache.set(normalized.key, normalized);
      trimLookupCache(state);
      persistLookupCache(state);
      const sample = Array.from(state.cache.values()).slice(0, 30);
      renderLookupOptionList(state, sample);
      state.afterCacheUpdate();
    }
    return normalized;
  } catch (e) {
    console.warn('failed to fetch lookup record', e);
    return null;
  }
}

function scheduleLookupSuggestion(state, term) {
  if (!state?.config) return;
  if (state.suggestionTimer) clearTimeout(state.suggestionTimer);
  state.suggestionTimer = setTimeout(() => {
    fetchLookupOptions(state, term);
  }, 250);
}

async function applyLookupSelection(state, rawValue, fetchIfMissing = true) {
  if (!state || !state.input) return;
  const valueStr = typeof rawValue === 'string' ? rawValue.trim() : String(rawValue ?? '').trim();
  if (!valueStr) {
    state.applyData(null);
    return;
  }
  if (!state.config) {
    state.applyData({ key: valueStr });
    return;
  }

  const resolveMatch = (candidate) => {
    let key = candidate;
    let match = state.cache.get(key) || null;
    const lower = key.toLowerCase();
    if (!match && state.labelLookup.has(lower)) {
      const mapped = state.labelLookup.get(lower);
      if (mapped) {
        key = mapped;
        match = state.cache.get(mapped) || null;
      }
    }
    if (!match && key.includes('/')) {
      const first = key.split('/')[0].trim();
      if (first) {
        key = first;
        match = state.cache.get(first) || null;
      }
    }
    return { key, match };
  };

  let { key: value, match: data } = resolveMatch(valueStr);
  if (!data && fetchIfMissing) {
    await fetchLookupOptions(state, valueStr);
    ({ key: value, match: data } = resolveMatch(valueStr));
  }

  state.selectionToken += 1;
  const token = state.selectionToken;

  state.input.value = value;

  if (data) {
    state.applyData(data);
    return;
  }

  state.applyData({ key: value });
  if (!fetchIfMissing) return;

  const fetched = await fetchLookupRecord(state, value);
  if (token !== state.selectionToken) return;
  if (fetched) {
    state.input.value = fetched.key;
    state.applyData(fetched);
  }
}

function renderPlanSummary(data) {
  if (!planSummary) return;
  if (data && data.values) {
    const label = lookupLabelFromData(planLookupState, data) || data.key;
    planSummary.textContent = label || '-';
    return;
  }
  if (data && data.key) {
    planSummary.textContent = data.key;
    return;
  }
  const current = planInput?.value?.trim();
  planSummary.textContent = current || '-';
}

function applyPlanDefaults(planData) {
  if (!planLookupState?.config || !planData || !planData.values) return;
  if (getEntryMode() !== 'start') return;
  planLookupState.config.fieldMappings.forEach((mapping) => {
    if (!mapping || !mapping.field || mapping.field === planLookupState.fieldCode) return;
    const input = document.querySelector(`[data-kintone-code="${mapping.field}"]`);
    if (!input) return;
    if (input.value) return;
    const value = planData.values?.[mapping.relatedField];
    if (value === undefined || value === null || value === '') return;
    input.value = value;
    const linkedState = lookupStates.get(mapping.field);
    if (linkedState) {
      applyLookupSelection(linkedState, String(value), false);
    }
  });
}

async function applyPlanSelection(planId, fetchIfMissing = true) {
  await applyLookupSelection(planLookupState, planId, fetchIfMissing);
}

// --- 作業開始レコード管理 ---
function renderStartOptions() {
  if (!startLinkSelect) return;
  const prev = startLinkSelect.value;
  startLinkSelect.innerHTML = '<option value="">選択してください</option>';
  const list = loadOpenStarts().filter((item) => !item.pendingCompletion);
  list.forEach((item) => {
    const opt = document.createElement('option');
    opt.value = item.recordId;
    const ts = item.startAt ? new Date(item.startAt).toLocaleString() : '開始日時未設定';
    const operatorLabel = item.operator ? `作業者: ${item.operator}` : '作業者: -';
    const equipmentLabel = item.equipment ? `設備: ${item.equipment}` : '設備: -';
    const planLabel = item.planId ? `Plan ${item.planId}` : 'Plan 未設定';
    const planInfo = item.planId && planLookupState ? planLookupState.cache.get(item.planId) : null;
    const planText = planInfo ? lookupLabelFromData(planLookupState, planInfo) : planLabel;
    opt.textContent = `${planText} / ${operatorLabel} / ${equipmentLabel} / 開始: ${ts}`;
    startLinkSelect.appendChild(opt);
  });
  if (list.some((item) => item.recordId === prev)) {
    startLinkSelect.value = prev;
  } else {
    startLinkSelect.value = '';
  }
  updateStartSummary();
  syncPlanIdWithSelection();
}

function upsertOpenStart(info) {
  const list = loadOpenStarts();
  const idx = list.findIndex((item) => item.recordId === info.recordId);
  const next = { pendingCompletion: false, ...info };
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...next };
  } else {
    list.push(next);
  }
  saveOpenStarts(list);
  renderStartOptions();
}

function markStartPending(recordId, pending) {
  if (!recordId) return;
  const list = loadOpenStarts();
  let changed = false;
  list.forEach((item) => {
    if (item.recordId === recordId) {
      item.pendingCompletion = pending;
      changed = true;
    }
  });
  if (changed) {
    saveOpenStarts(list);
    renderStartOptions();
  }
}

function removeOpenStart(recordId) {
  if (!recordId) return;
  const list = loadOpenStarts();
  const next = list.filter((item) => item.recordId !== recordId);
  if (next.length !== list.length) {
    saveOpenStarts(next);
    renderStartOptions();
  }
}

function mergeOpenStartsFromServer(records) {
  if (!Array.isArray(records)) return;
  const local = loadOpenStarts();
  const pendingMap = new Map(local.filter((item) => item.pendingCompletion).map((item) => [item.recordId, true]));
  const merged = records.map((rec) => ({
    recordId: rec.recordId,
    planId: rec.planId,
    startAt: rec.startAt,
    operator: rec.operator,
    equipment: rec.equipment,
    pendingCompletion: pendingMap.get(rec.recordId) || false,
  }));
  const stillPending = local.filter((item) => item.pendingCompletion && !merged.some((rec) => rec.recordId === item.recordId));
  saveOpenStarts([...merged, ...stillPending]);
  renderStartOptions();
}

async function refreshOpenStartsFromServer() {
  if (!navigator.onLine) return;
  try {
    const res = await fetch(`${API_ENDPOINT}?type=open-starts`);
    if (!res.ok) throw new Error(await res.text());
    const json = await res.json();
    mergeOpenStartsFromServer(Array.isArray(json?.records) ? json.records : []);
  } catch (e) {
    console.warn('failed to refresh open starts', e);
  }
}

function syncPlanIdWithSelection() {
  if (!startLinkSelect || !planInput) return;
  const selected = startLinkSelect.value;
  if (!selected) {
    if (getEntryMode() === 'complete') {
      planInput.value = '';
    }
    if (getEntryMode() === 'start') {
      applyPlanSelection(planInput.value.trim(), false);
    }
    updateStartSummary();
    return;
  }
  const list = loadOpenStarts();
  const found = list.find((item) => item.recordId === selected);
  if (found) {
    if (getEntryMode() === 'complete') {
      planInput.value = found.planId || '';
    }
    updateStartSummary(found);
    applyPlanSelection(found.planId || '', true);
  } else {
    updateStartSummary();
  }
}

function applyEntryMode(mode) {
  formRows.forEach((row) => {
    const modes = (row.dataset.modes || '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    const shouldShow = !modes.length || modes.includes(mode);
    row.classList.toggle('hidden', !shouldShow);
    const control = row.querySelector('input, select, textarea');
    if (!control) return;
    control.disabled = !shouldShow;
    if (shouldShow && row.dataset.required === 'true') {
      control.setAttribute('required', '');
    } else {
      control.removeAttribute('required');
    }
    if (!shouldShow) {
      if (control.type === 'number') {
        control.value = control.defaultValue ?? '';
      } else if (control.type === 'datetime-local') {
        control.value = '';
      } else if (control instanceof HTMLSelectElement) {
        control.value = '';
      }
    }
  });

  if (!planInput) return;
  if (mode === 'complete') {
    planInput.setAttribute('readonly', 'readonly');
    syncPlanIdWithSelection();
    ensureDateTimeValue($('endAt'));
  } else {
    planInput.removeAttribute('readonly');
    ensureDateTimeValue($('startAt'));
    applyPlanSelection(planInput.value.trim(), false);
  }
  renderStartOptions();
}

entryModeInputs.forEach((input) => {
  input.addEventListener('change', () => applyEntryMode(input.value));
});

if (startLinkSelect) {
  startLinkSelect.addEventListener('change', () => {
    syncPlanIdWithSelection();
  });
}

if (planInput) {
  planInput.addEventListener('input', () => {
    const term = planInput.value.trim();
    scheduleLookupSuggestion(planLookupState, term);
  });
  planInput.addEventListener('change', () => {
    applyPlanSelection(planInput.value.trim(), true);
  });
  planInput.addEventListener('blur', () => {
    applyPlanSelection(planInput.value.trim(), true);
  });
}

if (operatorInput) {
  operatorInput.addEventListener('input', () => {
    const term = operatorInput.value.trim();
    scheduleLookupSuggestion(operatorLookupState, term);
  });
  operatorInput.addEventListener('change', () => {
    applyLookupSelection(operatorLookupState, operatorInput.value.trim(), true);
  });
  operatorInput.addEventListener('blur', () => {
    applyLookupSelection(operatorLookupState, operatorInput.value.trim(), true);
  });
}

if (equipmentInput) {
  equipmentInput.addEventListener('input', () => {
    const term = equipmentInput.value.trim();
    scheduleLookupSuggestion(equipmentLookupState, term);
  });
  equipmentInput.addEventListener('change', () => {
    applyLookupSelection(equipmentLookupState, equipmentInput.value.trim(), true);
  });
  equipmentInput.addEventListener('blur', () => {
    applyLookupSelection(equipmentLookupState, equipmentInput.value.trim(), true);
  });
}

loadCachedFormProperties();
renderPlanSummary(null);
renderStartOptions();
applyEntryMode(getEntryMode());
ensureDateTimeValue($('startAt'));
ensureDateTimeValue($('endAt'));

// --- 送信本体 ---
async function postRecords(records) {
  const res = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records })
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  try { return JSON.parse(text); } catch { return { ok: true, raw: text }; }
}

function handleSyncResponse(sentRecords, response) {
  if (!response || typeof response !== 'object') return;
  const startItems = sentRecords.filter((item) => (item.entryType || 'start') !== 'complete');
  const completionItems = sentRecords.filter((item) => (item.entryType || 'start') === 'complete');

  const createdIds = Array.isArray(response?.created?.ids)
    ? response.created.ids
    : Array.isArray(response?.ids) ? response.ids : [];
  createdIds.forEach((id, idx) => {
    const src = startItems[idx];
    if (!src) return;
    upsertOpenStart({
      recordId: id,
      planId: src.planId,
      startAt: src.startAt,
      operator: src.operator,
      equipment: src.equipment,
    });
  });

  const updatedIds = Array.isArray(response?.updated?.ids)
    ? response.updated.ids
    : [];
  completionItems.forEach((item) => {
    const targetId = item.startRecordId;
    if (!targetId) return;
    if (updatedIds.includes(targetId)) {
      removeOpenStart(targetId);
    } else {
      markStartPending(targetId, false);
    }
  });

  if (navigator.onLine) {
    refreshOpenStartsFromServer();
  }
}

// --- 送信処理 ---
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const entryType = getEntryMode();
    const toIso = (val) => {
      if (!val) return '';
      const d = new Date(val);
      return d.toISOString();
    };
    if (!planInput) throw new Error('Plan input missing');
    let planId = planInput.value.trim();

    const operator = operatorInput?.value?.trim() || '';
    const equipment = equipmentInput?.value?.trim() || '';

    const startAt = entryType === 'start' ? toIso($('startAt')?.value) : '';
    const endAt = entryType === 'complete' ? toIso($('endAt')?.value) : '';

    if (entryType === 'start' && !planId) { msg('Plan ID は必須です'); return; }
    if (entryType === 'start' && !startAt) { msg('作業開始日時を入力してください'); return; }
    if (entryType === 'start' && !operator) { msg('作業者を入力してください'); return; }
    if (entryType === 'start' && !equipment) { msg('設備を入力してください'); return; }
    if (entryType === 'complete' && !endAt) { msg('作業完了日時を入力してください'); return; }

    if (startAt && endAt && new Date(startAt) > new Date(endAt)) {
      msg('完了日時は開始日時以降にしてください'); return;
    }

    const qty = entryType === 'complete' ? Number($('qty')?.value || 0) : 0;
    const downtimeMin = entryType === 'complete' ? Number($('downtimeMin')?.value || 0) : 0;

    if (entryType === 'complete' && (!Number.isFinite(qty) || qty < 0)) {
      msg('個数は0以上の数値で入力してください'); return;
    }
    if (entryType === 'complete' && (!Number.isFinite(downtimeMin) || downtimeMin < 0)) {
      msg('ダウンタイムは0以上の数値で入力してください'); return;
    }

    const record = { entryType };
    if (planId) record.planId = planId;

    if (entryType === 'start') {
      record.startAt = startAt;
      record.operator = operator;
      record.equipment = equipment;
    } else {
      const startRecordId = $('startLink')?.value;
      if (!startRecordId) {
        msg('開始レポートを選択してください');
        return;
      }
      const list = loadOpenStarts();
      const found = list.find((item) => item.recordId === startRecordId);
      if (found && found.planId) {
        planId = found.planId;
        record.planId = planId;
      }
      record.startRecordId = startRecordId;
      record.endAt = endAt;
      record.qty = qty;
      record.downtimeMin = downtimeMin;
    }

    const successText = entryType === 'start' ? '作業開始を登録しました' : '作業完了を登録しました';
    const queuedText = entryType === 'start' ? '作業開始をキューへ保存しました' : '作業完了をキューへ保存しました';
    if (navigator.onLine) {
      try {
        const response = await postRecords([record]);
        handleSyncResponse([record], response);
        msg(successText, true);
      } catch (err) {
        if (entryType === 'complete') markStartPending(record.startRecordId, true);
        await enqueue(record);
        msg('一時的に失敗。入力内容をキューへ保存しました（オンライン復帰で自動送信）');
      }
    } else {
      if (entryType === 'complete') markStartPending(record.startRecordId, true);
      await enqueue(record);
      msg(`オフラインのため${queuedText}`);
    }

    if (entryType === 'start') {
      setDateTimeToNow($('startAt'));
      if (operatorInput) operatorInput.value = '';
      if (equipmentInput) equipmentInput.value = '';
      renderStartOptions();
      if (planId) applyPlanSelection(planId, true);
    } else {
      setDateTimeToNow($('endAt'));
      $('qty').value = '0';
      $('downtimeMin').value = '0';
      if (startLinkSelect) {
        startLinkSelect.value = '';
        updateStartSummary();
      }
      planInput.value = '';
      renderPlanSummary(null);
    }
  } catch (err) {
    msg('送信エラー: ' + (err?.message || err));
    console.error(err);
  }
});

// --- オンライン復帰時にキューを再送 ---
async function flushQueue() {
  const items = await allAndClear();
  if (!items.length) return;
  try {
    const response = await postRecords(items);
    handleSyncResponse(items, response);
    msg(`キュー ${items.length} 件を送信しました`, true);
  } catch (e) {
    for (const it of items) {
      await enqueue(it);
      if ((it.entryType || 'start') === 'complete' && it.startRecordId) {
        markStartPending(it.startRecordId, false);
      }
    }
    msg('再送失敗。次回オンライン時に再試行します');
  }
}

window.addEventListener('online', () => {
  flushQueue();
  refreshOpenStartsFromServer();
  fetchFormProperties();
  if (planInput?.value) {
    applyPlanSelection(planInput.value.trim(), true);
  }
});

document.addEventListener('visibilitychange', () => {
  if (navigator.onLine && !document.hidden) {
    flushQueue();
    refreshOpenStartsFromServer();
  }
});

// --- 初期ロードでサーバ同期を試行 ---
if (navigator.onLine) {
  refreshOpenStartsFromServer();
  fetchFormProperties();
  flushQueue();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// --- start summary ---
function updateStartSummary(info) {
  if (!startSummary) return;
  const details = info;
  if (!details) {
    const selected = startLinkSelect?.value;
    if (selected) {
      const list = loadOpenStarts();
      const found = list.find((item) => item.recordId === selected);
      if (found) {
        return updateStartSummary(found);
      }
    }
    startSummary.textContent = '未選択';
    return;
  }
  const ts = details.startAt ? new Date(details.startAt).toLocaleString() : '開始日時未設定';
  const planInfo = details.planId && planLookupState ? planLookupState.cache.get(details.planId) : null;
  const planLabel = planInfo ? lookupLabelFromData(planLookupState, planInfo) : (details.planId ? `Plan ${details.planId}` : null);
  const parts = [
    planLabel,
    details.operator ? `作業者: ${details.operator}` : null,
    details.equipment ? `設備: ${details.equipment}` : null,
    ts ? `開始: ${ts}` : null,
  ].filter(Boolean);
  startSummary.textContent = parts.join(' / ') || '未選択';
}

window.addEventListener('offline', () => {
  msg('オフラインです。入力はキューに保存されます。');
});

})();
