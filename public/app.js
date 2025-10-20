(function () {
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
const msgContainer = $('msg');
const msg = (t, ok = false) => {
  if (!msgContainer) return;
  msgContainer.textContent = t;
  msgContainer.className = t ? (ok ? 'ok' : 'err') : '';
};

const mainView = $('mainView');
const startPanel = $('startPanel');
const completePanel = $('completePanel');
const startForm = $('startForm');
const completeForm = $('completeForm');
const activeCardsContainer = $('activeCards');
const completionSummary = $('completionSummary');
const openStartFormBtn = $('openStartForm');
const closeStartFormBtn = $('closeStartForm');
const closeCompleteFormBtn = $('closeCompleteForm');
const refreshActiveBtn = $('refreshActive');
const planSummary = $('planSummary');
const planInput = $('planId');
const planOptionsList = $('planOptions');
const operatorInput = $('operator');
const operatorOptionsList = $('operatorOptions');
const equipmentInput = $('equipment');
const equipmentOptionsList = $('equipmentOptions');

let currentView = 'main';
let selectedStartId = null;
let manualViewPreference = null;
let startFormAutoOpen = false;

const OPEN_STARTS_KEY = 'open-start-records';
const FORM_META_KEY = 'kintone-form-meta';
const LOOKUP_CACHE_PREFIX = 'lookup-cache:';
const LOOKUP_FALLBACK_KEY = 'lookup-fallback-config';

const getEntryMode = () => (currentView === 'start' ? 'start' : 'complete');

function getFormCacheBust() {
  try {
    const key = 'form-cache-bust';
    if (window.sessionStorage) {
      const existing = window.sessionStorage.getItem(key);
      if (existing) return existing;
      const generated = String(Date.now());
      window.sessionStorage.setItem(key, generated);
      return generated;
    }
  } catch (err) {
    console.warn('failed to access sessionStorage', err);
  }
  return String(Date.now());
}

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

function toISOStringValue(localValue) {
  if (!localValue) return '';
  const d = new Date(localValue);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
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

function ensureLabelIndex(state) {
  if (!state || !state.cache?.size) return;
  if (state.labelLookup && state.labelLookup.size) return;
  state.labelLookup = new Map();
  for (const item of state.cache.values()) {
    if (!item || !item.key) continue;
    const label = lookupLabelFromData(state, item);
    const keyLower = item.key.toLowerCase();
    if (keyLower) {
      state.labelLookup.set(keyLower, item.key);
    }
    if (label) {
      state.labelLookup.set(label.toLowerCase(), item.key);
      const combo = `${item.key} / ${label}`.toLowerCase();
      state.labelLookup.set(combo, item.key);
    }
  }
}

function resolveLookupKey(state, rawValue) {
  if (!state || rawValue == null) return rawValue;
  const value = String(rawValue).trim();
  if (!value) return value;
  if (state.cache?.has(value)) {
    const found = state.cache.get(value);
    return (found && found.key) ? found.key : value;
  }
  ensureLabelIndex(state);
  const lower = value.toLowerCase();
  if (state.labelLookup?.has(lower)) {
    return state.labelLookup.get(lower);
  }
  if (value.includes('/')) {
    const first = value.split('/')[0].trim();
    if (first && state.cache?.has(first)) {
      const found = state.cache.get(first);
      return (found && found.key) ? found.key : first;
    }
  }
  if (state.cache) {
    for (const item of state.cache.values()) {
      const label = lookupLabelFromData(state, item);
      if (label && label.toLowerCase() === lower) {
        return item.key;
      }
    }
  }
  return value;
}

function sanitizeRecordForSend(record) {
  if (!record || typeof record !== 'object') return record;
  const entryType = record.entryType === 'complete' ? 'complete' : 'start';
  const base = { ...record, entryType };
  if (entryType === 'start') {
    base.planId = resolveLookupKey(planLookupState, base.planId || '');
    base.operator = resolveLookupKey(operatorLookupState, base.operator || '');
    base.equipment = resolveLookupKey(equipmentLookupState, base.equipment || '');
  } else {
    if (base.planId) {
      base.planId = resolveLookupKey(planLookupState, base.planId);
    }
  }
  if (base.qty !== undefined) {
    const n = Number(base.qty);
    base.qty = Number.isFinite(n) ? n : 0;
  }
  if (base.downtimeMin !== undefined) {
    const n = Number(base.downtimeMin);
    base.downtimeMin = Number.isFinite(n) ? n : 0;
  }
  return base;
}

function validateRecordForSend(record) {
  if (!record || typeof record !== 'object') return false;
  const entryType = record.entryType === 'complete' ? 'complete' : 'start';
  if (entryType === 'start') {
    return Boolean(record.planId && record.startAt && record.operator && record.equipment);
  }
  if (!record.startRecordId || !record.endAt) return false;
  const qty = Number(record.qty ?? 0);
  const downtime = Number(record.downtimeMin ?? 0);
  if (!Number.isFinite(qty) || qty < 0) return false;
  if (!Number.isFinite(downtime) || downtime < 0) return false;
  return true;
}

function splitValidInvalid(records) {
  const valid = [];
  const invalid = [];
  records.forEach((rec) => {
    if (validateRecordForSend(rec)) {
      valid.push(rec);
    } else {
      invalid.push(rec);
    }
  });
  return { valid, invalid };
}

function extractErrorMessage(err) {
  if (!err) return '';
  const body = err.body;
  if (body && typeof body === 'object') {
    const detailMessage = body?.detail?.message || body?.message;
    if (typeof detailMessage === 'string' && detailMessage.trim()) return detailMessage.trim();
    const errorText = body?.error;
    if (typeof errorText === 'string' && errorText.trim()) return errorText.trim();
  }
  if (typeof err.message === 'string' && err.message.trim()) return err.message.trim();
  if (typeof err === 'string') return err;
  return '';
}

function isRetriableError(err) {
  if (!err) return true;
  const status = typeof err.status === 'number' ? err.status : Number(err.status);
  if (!Number.isFinite(status)) return true;
  return status >= 500;
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
const lookupFallbackConfigs = new Map();

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
    hydratingKeys: new Set(),
  };
  lookupStates.set(fieldCode, state);
  return state;
}

const planFieldCode = planInput?.dataset.kintoneCode || 'plan_id';
const planLookupState = createLookupState(planFieldCode, planInput, planOptionsList, {
  afterCacheUpdate: () => renderActiveCards(),
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

function normalizeFieldCodes(list) {
  if (Array.isArray(list)) {
    return uniqueList(
      list
        .map((entry) => {
          if (typeof entry === 'string') return entry.trim();
          if (entry && typeof entry === 'object') {
            const maybe = entry.field || entry.code || entry.fieldCode;
            if (typeof maybe === 'string') return maybe.trim();
          }
          return '';
        })
        .filter(Boolean)
    );
  }
  if (typeof list === 'string') {
    return uniqueList([list.trim()].filter(Boolean));
  }
  return [];
}

function normalizeFieldMappings(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const field = typeof item.field === 'string' ? item.field.trim() : '';
      const relatedField = typeof item.relatedField === 'string' ? item.relatedField.trim() : '';
      if (!field || !relatedField) return null;
      return { field, relatedField };
    })
    .filter(Boolean);
}

function applyLookupFallbacks(raw, options = {}) {
  const { refresh = true } = options;
  lookupFallbackConfigs.clear();
  if (raw && typeof raw === 'object') {
    Object.entries(raw).forEach(([fieldCode, value]) => {
      if (!value || typeof value !== 'object') return;
      const relatedAppRaw = value.relatedApp ?? value.app;
      let relatedApp = '';
      if (typeof relatedAppRaw === 'string') {
        relatedApp = relatedAppRaw.trim();
      } else if (relatedAppRaw && typeof relatedAppRaw === 'object' && typeof relatedAppRaw.app === 'string') {
        relatedApp = relatedAppRaw.app.trim();
      }
      const keyRaw = value.relatedKeyField ?? value.key;
      const relatedKeyField = typeof keyRaw === 'string' ? keyRaw.trim() : '';
      if (!relatedApp || !relatedKeyField) return;
      const displayFields = uniqueList([
        ...normalizeFieldCodes(value.displayFields),
        ...normalizeFieldCodes(value.display),
      ]);
      const pickerFields = uniqueList([
        ...normalizeFieldCodes(value.pickerFields),
        ...normalizeFieldCodes(value.queryFields),
        ...displayFields,
      ]);
      const fieldMappings = normalizeFieldMappings(value.fieldMappings || value.mappings || []);
      const mappedFields = fieldMappings.map((m) => m.relatedField);
      const fieldSet = uniqueList([
        relatedKeyField,
        ...displayFields,
        ...pickerFields,
        ...mappedFields,
        '$id',
      ]);
      lookupFallbackConfigs.set(fieldCode, {
        fieldCode,
        relatedApp,
        relatedKeyField,
        pickerFields,
        displayFields,
        fieldMappings,
        fieldSet,
      });
    });
  }
  if (refresh) {
    refreshLookupConfigs();
  }
}

function loadLookupFallbacks() {
  const cached = loadJson(LOOKUP_FALLBACK_KEY, null);
  if (!cached || typeof cached !== 'object') return;
  const entries = cached.lookups && typeof cached.lookups === 'object' ? cached.lookups : cached;
  applyLookupFallbacks(entries, { refresh: false });
}

function persistLookupFallbacks(raw) {
  saveJson(LOOKUP_FALLBACK_KEY, { lookups: raw });
}

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

function parseDatasetFields(input, attrName) {
  if (!input) return [];
  const value = input.dataset?.[attrName];
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function deriveLookupConfig(state) {
  if (!state?.fieldCode) return null;
  if (!formProperties || typeof formProperties !== 'object') return null;
  const fieldCode = state.fieldCode;
  for (const key of Object.keys(formProperties)) {
    const prop = formProperties[key];
    if (!prop || !prop.lookup) continue;
    const mappings = Array.isArray(prop.lookup.fieldMappings) ? prop.lookup.fieldMappings : [];
    if (!mappings.some((m) => m?.field === fieldCode)) continue;
    const relatedApp = prop.lookup.relatedApp?.app;
    const relatedKeyField = prop.lookup.relatedKeyField;
    if (!relatedApp || !relatedKeyField) continue;
    const pickerFields = Array.isArray(prop.lookup.lookupPickerFields)
      ? prop.lookup.lookupPickerFields
        .map((entry) => {
          if (typeof entry === 'string') return entry.trim();
          if (entry && typeof entry === 'object') {
            const maybeField = entry.field || entry.code || entry.fieldCode;
            if (typeof maybeField === 'string') return maybeField.trim();
          }
          return '';
        })
        .filter(Boolean)
      : [];
    const fieldMappings = mappings
      .filter((m) => m && typeof m.field === 'string' && typeof m.relatedField === 'string')
      .map((m) => ({ field: m.field, relatedField: m.relatedField }));
    const mappedFields = fieldMappings.map((m) => m.relatedField);
    const datasetFields = uniqueList([
      ...parseDatasetFields(state.input, 'displayFields'),
      ...parseDatasetFields(state.input, 'lookupDisplayFields'),
    ]);
    const displayFields = uniqueList([
      ...pickerFields,
      ...datasetFields,
      ...mappedFields,
    ]);
    const fieldSet = uniqueList([relatedKeyField, ...displayFields, '$id']);
    return { fieldCode, relatedApp, relatedKeyField, pickerFields, fieldMappings, fieldSet, displayFields };
  }
  return null;
}

function refreshLookupConfigs() {
  lookupStates.forEach((state) => {
    if (!state) return;
    state.config = deriveLookupConfig(state);
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
  scheduleOpenStartHydration();
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
  const fields = Array.isArray(state.config?.displayFields) ? state.config.displayFields : [];
  if (!fields.length) {
    return data.key || '';
  }
  const parts = fields
    .map((code) => data.values?.[code])
    .filter((v, idx) => typeof v === 'string' && v && (idx === 0 || v !== data.values?.[state.config.relatedKeyField]));
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
    const params = new URLSearchParams({ type: 'form' });
    const bust = getFormCacheBust();
    if (bust) params.set('cacheBust', bust);
    const res = await fetch(`${API_ENDPOINT}?${params.toString()}`);
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

async function fetchLookupFallbacks() {
  try {
    const params = new URLSearchParams({ type: 'lookup-config' });
    const res = await fetch(`${API_ENDPOINT}?${params.toString()}`);
    if (!res.ok) throw new Error(await res.text());
    const json = await res.json();
    if (!json || typeof json !== 'object') return;
    const entries = json.lookups && typeof json.lookups === 'object' ? json.lookups : json;
    applyLookupFallbacks(entries);
    persistLookupFallbacks(entries);
  } catch (e) {
    console.warn('failed to fetch lookup config', e);
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
function describeLookupValue(state, value) {
  if (!state || value == null) return '';
  const key = String(value).trim();
  if (!key) return '';
  const cached = state.cache?.get ? state.cache.get(key) : null;
  if (cached) {
    return lookupLabelFromData(state, cached) || cached.key || key;
  }
  ensureLabelIndex(state);
  const lower = key.toLowerCase();
  if (state.labelLookup?.has?.(lower)) {
    const mapped = state.labelLookup.get(lower);
    if (mapped && state.cache?.has?.(mapped)) {
      const match = state.cache.get(mapped);
      return lookupLabelFromData(state, match) || match?.key || mapped;
    }
    return mapped || key;
  }
  return key;
}

async function ensureLookupValue(state, value) {
  if (!state || !state.config) return false;
  if (!navigator.onLine) return false;
  const key = String(value ?? '').trim();
  if (!key) return false;
  if (state.cache?.has?.(key)) return false;
  if (state.hydratingKeys?.has?.(key)) return false;
  state.hydratingKeys?.add?.(key);
  try {
    const record = await fetchLookupRecord(state, key);
    if (record && record.key) {
      state.cache.set(record.key, record);
      trimLookupCache(state);
      persistLookupCache(state);
      ensureLabelIndex(state);
      state.afterCacheUpdate();
      return true;
    }
  } catch (e) {
    console.warn('failed to hydrate lookup value', state.fieldCode, key, e);
  } finally {
    state.hydratingKeys?.delete?.(key);
  }
  return false;
}

async function hydrateLookupValues(state, values) {
  if (!state || !state.config) return false;
  const list = Array.isArray(values) ? values : [];
  const normalized = uniqueList(
    list
      .map((item) => (item == null ? '' : String(item).trim()))
      .filter((item) => item)
  );
  if (!normalized.length) return false;
  const results = await Promise.all(normalized.map((val) => ensureLookupValue(state, val)));
  return results.some(Boolean);
}

let openStartHydrationTimer = null;
function shouldHydrateOpenStarts(records = loadOpenStarts()) {
  const list = Array.isArray(records) ? records : [];
  if (!list.length) return false;
  const needs = (state, values) => {
    if (!state?.config) return false;
    return values.some((val) => {
      const key = String(val ?? '').trim();
      if (!key) return false;
      return !state.cache?.has?.(key);
    });
  };
  if (needs(planLookupState, list.map((item) => item.planId))) return true;
  if (needs(operatorLookupState, list.map((item) => item.operator))) return true;
  if (needs(equipmentLookupState, list.map((item) => item.equipment))) return true;
  return false;
}

function scheduleOpenStartHydration() {
  if (openStartHydrationTimer) return;
  if (!shouldHydrateOpenStarts()) return;
  openStartHydrationTimer = setTimeout(() => {
    openStartHydrationTimer = null;
    const records = loadOpenStarts();
    if (shouldHydrateOpenStarts(records)) {
      hydrateOpenStartLookups(records);
    }
  }, 0);
}

async function hydrateOpenStartLookups(records) {
  if (!navigator.onLine) return;
  const list = Array.isArray(records) ? records : [];
  const planIds = list.map((item) => item.planId).filter(Boolean);
  const operatorIds = list.map((item) => item.operator).filter(Boolean);
  const equipmentIds = list.map((item) => item.equipment).filter(Boolean);
  const tasks = [];
  if (planLookupState?.config) tasks.push(hydrateLookupValues(planLookupState, planIds));
  if (operatorLookupState?.config) tasks.push(hydrateLookupValues(operatorLookupState, operatorIds));
  if (equipmentLookupState?.config) tasks.push(hydrateLookupValues(equipmentLookupState, equipmentIds));
  if (!tasks.length) return;
  try {
    const results = await Promise.all(tasks);
    if (results.some(Boolean)) {
      renderActiveCards();
      updateCompletionSummary();
    }
  } catch (e) {
    console.warn('failed to hydrate open start lookups', e);
  }
}

function createCardElement(item) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'card';
  if (item.pendingCompletion) card.classList.add('pending');
  if (item.recordId === selectedStartId) card.classList.add('selected');

  const planInfo = item.planId && planLookupState ? planLookupState.cache.get(item.planId) : null;
  const planLabel = planInfo ? lookupLabelFromData(planLookupState, planInfo) : (item.planId ? `Plan ${item.planId}` : 'Plan 未設定');
  const operatorDisplay = item.operator ? describeLookupValue(operatorLookupState, item.operator) : '';
  const equipmentDisplay = item.equipment ? describeLookupValue(equipmentLookupState, item.equipment) : '';
  const startLabel = item.startAt ? new Date(item.startAt).toLocaleString() : '開始日時未設定';

  card.innerHTML = `
    <h3>${planLabel}</h3>
    <p>${operatorDisplay ? `作業者: ${operatorDisplay}` : '作業者: -'}</p>
    <p>${equipmentDisplay ? `設備: ${equipmentDisplay}` : '設備: -'}</p>
    <p>開始: ${startLabel}</p>
    ${item.pendingCompletion ? '<p class="status">送信待ち</p>' : ''}
  `;

  card.addEventListener('click', () => {
    selectStartForCompletion(item.recordId);
  });

  return card;
}

function showCompletionForm() {
  if (completeForm) completeForm.classList.remove('hidden');
  if (completePanel) {
    completePanel.classList.remove('hidden');
    completePanel.setAttribute('aria-hidden', 'false');
  }
}

function renderActiveCards() {
  if (!activeCardsContainer) return;
  const list = loadOpenStarts();
  activeCardsContainer.innerHTML = '';

  if (!list.length) {
    const empty = document.createElement('p');
    empty.textContent = '作業中のカードはありません';
    activeCardsContainer.appendChild(empty);
    hideCompletionForm();
    return;
  }

  list.forEach((item) => {
    const card = createCardElement(item);
    activeCardsContainer.appendChild(card);
  });

  if (selectedStartId) {
    const found = list.find((item) => item.recordId === selectedStartId);
    if (found) {
      updateCompletionSummary(found);
      showCompletionForm();
    } else {
      hideCompletionForm();
    }
  }

  scheduleOpenStartHydration();
}

function upsertOpenStart(info) {
  const list = loadOpenStarts();
  const idx = list.findIndex((item) => item.recordId === info.recordId);
  const next = { pendingCompletion: false, ...info };
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...next };
  } else {
    list.unshift(next);
  }
  saveOpenStarts(list);
  renderActiveCards();
  evaluateAutoView();
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
    renderActiveCards();
    evaluateAutoView();
  }
}

function removeOpenStart(recordId) {
  if (!recordId) return;
  const list = loadOpenStarts();
  const next = list.filter((item) => item.recordId !== recordId);
  if (next.length !== list.length) {
    saveOpenStarts(next);
    if (selectedStartId === recordId) {
      hideCompletionForm();
    }
    renderActiveCards();
    evaluateAutoView();
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
  renderActiveCards();
  evaluateAutoView();
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

function hideCompletionForm() {
  selectedStartId = null;
  if (completeForm) completeForm.classList.add('hidden');
  if (completionSummary) completionSummary.textContent = '作業中カードを選択してください';
  if (completePanel) {
    completePanel.classList.add('hidden');
    completePanel.setAttribute('aria-hidden', 'true');
  }
}

function updateCompletionSummary(info) {
  if (!completionSummary) return;
  const details = info || (selectedStartId ? loadOpenStarts().find((item) => item.recordId === selectedStartId) : null);
  if (!details) {
    completionSummary.textContent = '作業中カードを選択してください';
    return;
  }
  const ts = details.startAt ? new Date(details.startAt).toLocaleString() : '開始日時未設定';
  const planInfo = details.planId && planLookupState ? planLookupState.cache.get(details.planId) : null;
  const planLabel = planInfo ? lookupLabelFromData(planLookupState, planInfo) : (details.planId ? `Plan ${details.planId}` : 'Plan 未設定');
  const operatorDisplay = details.operator ? describeLookupValue(operatorLookupState, details.operator) : '';
  const equipmentDisplay = details.equipment ? describeLookupValue(equipmentLookupState, details.equipment) : '';
  const parts = [
    planLabel,
    operatorDisplay ? `作業者: ${operatorDisplay}` : null,
    equipmentDisplay ? `設備: ${equipmentDisplay}` : null,
    ts ? `開始: ${ts}` : null,
  ].filter(Boolean);
  completionSummary.textContent = parts.join(' / ') || '作業中カードを選択してください';
}

function selectStartForCompletion(recordId) {
  if (!recordId) {
    hideCompletionForm();
    renderActiveCards();
    return;
  }
  const list = loadOpenStarts();
  const found = list.find((item) => item.recordId === recordId);
  if (!found) {
    hideCompletionForm();
    renderActiveCards();
    return;
  }
  selectedStartId = recordId;
  updateCompletionSummary(found);
  showCompletionForm();
  const endAtInput = $('endAt');
  setDateTimeToNow(endAtInput);
  const qtyInput = $('qty');
  const downtimeInput = $('downtimeMin');
  if (qtyInput && !qtyInput.value) qtyInput.value = '0';
  if (downtimeInput && !downtimeInput.value) downtimeInput.value = '0';
  if (endAtInput) {
    setTimeout(() => endAtInput.focus(), 0);
  }
  renderActiveCards();
}

function showMainView(options = {}) {
  const { manual = false } = options;
  currentView = 'main';
  startFormAutoOpen = false;
  if (manual) {
    manualViewPreference = 'main';
  } else if (manualViewPreference === 'main') {
    manualViewPreference = null;
  }
  if (startPanel) {
    startPanel.classList.add('hidden');
    startPanel.setAttribute('aria-hidden', 'true');
  }
  if (mainView) {
    mainView.classList.remove('hidden');
  }
  ensureDateTimeValue($('endAt'));
}

function showStartForm(options = {}) {
  const { manual = false } = options;
  currentView = 'start';
  startFormAutoOpen = !manual;
  if (manual) {
    manualViewPreference = 'start';
  } else if (manualViewPreference === 'start') {
    manualViewPreference = null;
  }
  if (startPanel) {
    startPanel.classList.remove('hidden');
    startPanel.setAttribute('aria-hidden', 'false');
  }
  if (!manual) {
    hideCompletionForm();
  }
  ensureDateTimeValue($('startAt'));
  if (planInput) {
    planInput.removeAttribute('readonly');
    applyPlanSelection(planInput.value.trim(), false);
    setTimeout(() => planInput.focus(), 0);
  }
}

function evaluateAutoView() {
  const list = loadOpenStarts();
  if (!list.length) {
    if (currentView !== 'start' && manualViewPreference !== 'main') {
      showStartForm({ manual: false });
    }
  } else {
    if (currentView === 'start' && startFormAutoOpen) {
      showMainView();
    }
    if (manualViewPreference === 'main') {
      manualViewPreference = null;
    }
  }
}

function hideStartForm(options = {}) {
  showMainView(options);
}

if (openStartFormBtn) {
  openStartFormBtn.addEventListener('click', () => {
    msg('');
    showStartForm({ manual: true });
  });
}

if (closeStartFormBtn) {
  closeStartFormBtn.addEventListener('click', () => {
    msg('');
    hideStartForm({ manual: true });
  });
}

if (startPanel) {
  startPanel.addEventListener('click', (event) => {
    if (event.target === startPanel) {
      hideStartForm({ manual: true });
    }
  });
}

if (closeCompleteFormBtn) {
  closeCompleteFormBtn.addEventListener('click', () => {
    msg('');
    hideCompletionForm();
    renderActiveCards();
  });
}

if (completePanel) {
  completePanel.addEventListener('click', (event) => {
    if (event.target === completePanel) {
      msg('');
      hideCompletionForm();
      renderActiveCards();
    }
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  let handled = false;
  if (startPanel && !startPanel.classList.contains('hidden')) {
    hideStartForm({ manual: true });
    handled = true;
  }
  if (completePanel && !completePanel.classList.contains('hidden')) {
    hideCompletionForm();
    renderActiveCards();
    handled = true;
  }
  if (handled) {
    event.preventDefault();
    msg('');
  }
});

if (refreshActiveBtn) {
  refreshActiveBtn.addEventListener('click', () => {
    refreshOpenStartsFromServer();
    renderActiveCards();
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

loadLookupFallbacks();
loadCachedFormProperties();
refreshLookupConfigs();
renderPlanSummary(null);
renderActiveCards();
showMainView();
evaluateAutoView();
ensureDateTimeValue($('endAt'));

// --- 送信本体 ---
async function postRecords(records) {
  if (!Array.isArray(records) || !records.length) {
    return { ok: true, skipped: 0 };
  }
  const res = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records })
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    const error = new Error(json?.error || `HTTP ${res.status}`);
    error.status = res.status;
    error.body = json ?? text;
    error.raw = text;
    throw error;
  }
  return json ?? { ok: true, raw: text };
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
if (startForm) {
  startForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if (!planInput) throw new Error('Plan input missing');
      let planId = planInput.value.trim();
      const startAt = toISOStringValue($('startAt')?.value);
      const operator = operatorInput?.value?.trim() || '';
      const equipment = equipmentInput?.value?.trim() || '';

      if (!planId) { msg('Plan ID は必須です'); return; }
      if (!startAt) { msg('作業開始日時を入力してください'); return; }
      if (!operator) { msg('作業者を入力してください'); return; }
      if (!equipment) { msg('設備を入力してください'); return; }

      const submission = {
        entryType: 'start',
        planId,
        startAt,
        operator,
        equipment,
      };

      const prepared = sanitizeRecordForSend(submission);
      if (!validateRecordForSend(prepared)) {
        msg('入力内容を確認してください');
        return;
      }

      if (prepared.planId && prepared.planId !== planId) {
        planId = prepared.planId;
        planInput.value = planId;
        applyPlanSelection(planId, true);
      }

      const successText = '作業開始を登録しました';
      const queuedText = '作業開始をキューへ保存しました';
      let shouldReset = false;

      if (navigator.onLine) {
        try {
          const response = await postRecords([prepared]);
          handleSyncResponse([prepared], response);
          msg(successText, true);
          shouldReset = true;
        } catch (err) {
          const retriable = isRetriableError(err);
          const detail = extractErrorMessage(err);
          if (retriable) {
            await enqueue(prepared);
            msg(detail ? `一時的に失敗: ${detail}（オンライン復帰で再送）` : '一時的に失敗。入力内容をキューへ保存しました（オンライン復帰で自動送信）');
            shouldReset = true;
          } else {
            msg(detail ? `送信エラー: ${detail}` : '送信エラーが発生しました。入力内容を確認してください');
          }
        }
      } else {
        await enqueue(prepared);
        msg(`オフラインのため${queuedText}`);
        shouldReset = true;
      }

      if (shouldReset) {
        setDateTimeToNow($('startAt'));
        if (operatorInput) operatorInput.value = '';
        if (equipmentInput) equipmentInput.value = '';
        hideCompletionForm();
        showMainView();
        if (planId) applyPlanSelection(planId, true);
      }
    } catch (err) {
      msg('送信エラー: ' + (err?.message || err));
      console.error(err);
    }
  });
}

if (completeForm) {
  completeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if (!selectedStartId) {
        msg('作業中カードを選択してください');
        return;
      }
      const list = loadOpenStarts();
      const found = list.find((item) => item.recordId === selectedStartId);
      if (!found) {
        msg('対象のレポートが見つかりません。再読み込みしてください');
        hideCompletionForm();
        renderActiveCards();
        return;
      }

      const endAt = toISOStringValue($('endAt')?.value);
      if (!endAt) { msg('作業完了日時を入力してください'); return; }

      if (found.startAt) {
        const startDate = new Date(found.startAt);
        const endDate = new Date(endAt);
        if (!Number.isNaN(startDate.getTime()) && !Number.isNaN(endDate.getTime()) && endDate < startDate) {
          msg('完了日時は開始日時以降にしてください');
          return;
        }
      }

      const qtyInput = $('qty');
      const downtimeInput = $('downtimeMin');
      const qty = Number(qtyInput?.value || 0);
      const downtimeMin = Number(downtimeInput?.value || 0);

      if (!Number.isFinite(qty) || qty < 0) { msg('個数は0以上の数値で入力してください'); return; }
      if (!Number.isFinite(downtimeMin) || downtimeMin < 0) { msg('ダウンタイムは0以上の数値で入力してください'); return; }

      const submission = {
        entryType: 'complete',
        startRecordId: selectedStartId,
        endAt,
        qty,
        downtimeMin,
      };
      if (found.planId) submission.planId = found.planId;

      const prepared = sanitizeRecordForSend(submission);
      if (!validateRecordForSend(prepared)) {
        msg('入力内容を確認してください');
        return;
      }

      const successText = '作業完了を登録しました';
      const queuedText = '作業完了をキューへ保存しました';
      let shouldReset = false;

      if (navigator.onLine) {
        try {
          const response = await postRecords([prepared]);
          handleSyncResponse([prepared], response);
          msg(successText, true);
          shouldReset = true;
        } catch (err) {
          const retriable = isRetriableError(err);
          const detail = extractErrorMessage(err);
          markStartPending(prepared.startRecordId, retriable);
          if (retriable) {
            await enqueue(prepared);
            msg(detail ? `一時的に失敗: ${detail}（オンライン復帰で再送）` : '一時的に失敗。入力内容をキューへ保存しました（オンライン復帰で自動送信）');
            shouldReset = true;
          } else {
            msg(detail ? `送信エラー: ${detail}` : '送信エラーが発生しました。入力内容を確認してください');
          }
        }
      } else {
        markStartPending(prepared.startRecordId, true);
        await enqueue(prepared);
        msg(`オフラインのため${queuedText}`);
        shouldReset = true;
      }

      if (shouldReset) {
        setDateTimeToNow($('endAt'));
        if (qtyInput) qtyInput.value = '0';
        if (downtimeInput) downtimeInput.value = '0';
        hideCompletionForm();
        showMainView();
        renderActiveCards();
      }
    } catch (err) {
      msg('送信エラー: ' + (err?.message || err));
      console.error(err);
    }
  });
}

// --- オンライン復帰時にキューを再送 ---
async function flushQueue() {
  const items = await allAndClear();
  if (!items.length) return;
  const sanitized = items.map(sanitizeRecordForSend);
  const { valid, invalid } = splitValidInvalid(sanitized);

  if (invalid.length) {
    invalid.forEach((rec) => {
      if ((rec?.entryType || 'start') === 'complete' && rec.startRecordId) {
        markStartPending(rec.startRecordId, false);
      }
    });
    console.warn('Skipped invalid queued records', invalid);
  }

  if (!valid.length) {
    msg(`不正なデータ ${invalid.length} 件を破棄しました`, false);
    return;
  }

  try {
    const response = await postRecords(valid);
    handleSyncResponse(valid, response);
    const suffix = invalid.length ? `（不正 ${invalid.length} 件は破棄）` : '';
    msg(`キュー ${valid.length} 件を送信しました${suffix}`, true);
  } catch (e) {
    const retriable = isRetriableError(e);
    const detail = extractErrorMessage(e);
    if (retriable) {
      for (const rec of valid) {
        await enqueue(rec);
        if ((rec.entryType || 'start') === 'complete' && rec.startRecordId) {
          markStartPending(rec.startRecordId, true);
        }
      }
      msg(detail ? `再送失敗: ${detail}` : '再送失敗。次回オンライン時に再試行します');
    } else {
      if ((e?.status || 0) === 403) {
        msg(detail ? `再送失敗: ${detail}` : '再送失敗。権限を確認してください');
      } else {
        msg(detail ? `再送失敗: ${detail}` : '再送失敗。入力内容を確認してください');
      }
      valid.forEach((rec) => {
        if ((rec.entryType || 'start') === 'complete' && rec.startRecordId) {
          markStartPending(rec.startRecordId, false);
        }
      });
    }
  }
}

// --- 初期ロードでサーバ同期を試行 ---
if (navigator.onLine) {
  refreshOpenStartsFromServer();
  fetchLookupFallbacks();
  fetchFormProperties();
  flushQueue();
}

window.addEventListener('online', () => {
  flushQueue();
  refreshOpenStartsFromServer();
  fetchLookupFallbacks();
  fetchFormProperties();
  if (planInput?.value) {
    applyPlanSelection(planInput.value.trim(), true);
  }
  scheduleOpenStartHydration();
});

document.addEventListener('visibilitychange', () => {
  if (navigator.onLine && !document.hidden) {
    flushQueue();
    refreshOpenStartsFromServer();
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SW_RELOAD') {
      window.location.reload();
    }
  });
}

window.addEventListener('offline', () => {
  msg('オフラインです。入力はキューに保存されます。');
});
})();
