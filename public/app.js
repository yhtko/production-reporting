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
const msg = (t, ok=false) => { const m=$('msg'); m.textContent=t; m.className= ok? 'ok':'err'; };

const form = $('reportForm');
const entryModeInputs = Array.from(document.querySelectorAll('input[name="entryType"]'));
const formRows = Array.from(document.querySelectorAll('#reportForm .row'));
const startLinkSelect = $('startLink');
const startSummary = $('startSummary');

const OPEN_STARTS_KEY = 'open-start-records';

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

function loadOpenStarts() {
  try {
    const raw = localStorage.getItem(OPEN_STARTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function saveOpenStarts(list) {
  try {
    localStorage.setItem(OPEN_STARTS_KEY, JSON.stringify(list));
  } catch (e) {
    console.warn('failed to persist open starts', e);
  }
}

function renderStartOptions() {
  if (!startLinkSelect) return;
  const prev = startLinkSelect.value;
  startLinkSelect.innerHTML = '<option value="">選択してください</option>';
  const list = loadOpenStarts().filter((item) => !item.pendingCompletion);
  list.forEach((item) => {
    const opt = document.createElement('option');
    opt.value = item.recordId;
    const ts = item.startAt ? new Date(item.startAt).toLocaleString() : '開始日時未設定';
    const operator = item.operator ? `作業者: ${item.operator}` : '作業者: -';
    const equipment = item.equipment ? `設備: ${item.equipment}` : '設備: -';
    const plan = item.planId ? `Plan ${item.planId}` : 'Plan 未設定';
    opt.textContent = `${plan} / ${operator} / ${equipment} / 開始: ${ts}`;
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

function syncPlanIdWithSelection() {
  if (!startLinkSelect) return;
  const selected = startLinkSelect.value;
  if (!selected) {
    if (getEntryMode() === 'complete') {
      $('planId').value = '';
    }
    updateStartSummary();
    return;
  }
  const list = loadOpenStarts();
  const found = list.find((item) => item.recordId === selected);
  if (found) {
    $('planId').value = found.planId || '';
  }
  updateStartSummary(found);
}

function applyEntryMode(mode) {
  formRows.forEach((row) => {
    const modes = (row.dataset.modes || '').split(',').map((m) => m.trim()).filter(Boolean);
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

  const planInput = $('planId');
  if (mode === 'complete') {
    planInput.setAttribute('readonly', 'readonly');
    syncPlanIdWithSelection();
    ensureDateTimeValue($('endAt'));
  } else {
    planInput.removeAttribute('readonly');
    ensureDateTimeValue($('startAt'));
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

renderStartOptions();
applyEntryMode(getEntryMode());
ensureDateTimeValue($('startAt'));
ensureDateTimeValue($('endAt'));

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
  const parts = [
    details.planId ? `Plan ${details.planId}` : null,
    details.operator ? `作業者: ${details.operator}` : null,
    details.equipment ? `設備: ${details.equipment}` : null,
    ts ? `開始: ${ts}` : null,
  ].filter(Boolean);
  startSummary.textContent = parts.join(' / ') || '未選択';
}

// --- 送信本体 ---
async function postRecords(records) {
  const res = await fetch('https://production-reporting.pages.dev/api/sync', {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ records })
  });
   const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  try { return JSON.parse(text); } catch { return { ok:true, raw:text }; }
}

function handleSyncResponse(sentRecords, response) {
  if (!response || typeof response !== 'object') return;
  const startItems = sentRecords.filter((item) => (item.entryType || 'start') !== 'complete');
  const completionItems = sentRecords.filter((item) => (item.entryType || 'start') === 'complete');

  const createdIds = Array.isArray(response?.created?.ids)
    ? response.created.ids
    : Array.isArray(response?.ids) ? response.ids : [];
  const createdRevisions = Array.isArray(response?.created?.revisions)
    ? response.created.revisions
    : Array.isArray(response?.revisions) ? response.revisions : [];
  createdIds.forEach((id, idx) => {
    const src = startItems[idx];
    if (!src) return;
    upsertOpenStart({
      recordId: id,
      planId: src.planId,
      startAt: src.startAt,
      operator: src.operator,
      equipment: src.equipment,
      revision: createdRevisions[idx],
    });
  });

  const updatedIds = Array.isArray(response?.updated?.ids) ? response.updated.ids : [];
  if (updatedIds.length) {
    updatedIds.forEach((id) => removeOpenStart(id));
  } else {
    completionItems.forEach((item) => {
      if (item.startRecordId) removeOpenStart(item.startRecordId);
    });
  }
}

// --- 送信処理 ---
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const entryType = getEntryMode();
    // 入力取得
    const toIso = (val) => {
      // datetime-localをISOに。空なら空文字
      if (!val) return '';
      // そのまま送る（サーバ側はUTC/オフセットどちらでも受ける）
      const d = new Date(val);
      return d.toISOString();
    };
    const planInput = $('planId');
    let planId = planInput.value.trim();

    const operator = $('operator').value.trim();
    const equipment = $('equipment').value.trim();

    const startAt = entryType === 'start' ? toIso($('startAt').value) : '';
    const endAt = entryType === 'complete' ? toIso($('endAt').value) : '';

    if (entryType === 'start' && !planId) { msg('Plan ID は必須です'); return; }
    if (entryType === 'start' && !startAt) { msg('作業開始日時を入力してください'); return; }
    if (entryType === 'start' && !operator) { msg('作業者を入力してください'); return; }
    if (entryType === 'start' && !equipment) { msg('設備を入力してください'); return; }
    if (entryType === 'complete' && !endAt) { msg('作業完了日時を入力してください'); return; }

    if (startAt && endAt && new Date(startAt) > new Date(endAt)) {
      msg('完了日時は開始日時以降にしてください'); return;
    }

    const qty = entryType === 'complete' ? Number($('qty').value || 0) : 0;
    const downtimeMin = entryType === 'complete' ? Number($('downtimeMin').value || 0) : 0;

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
      const startRecordId = $('startLink').value;
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
    console.log('POST payload', { entryType, records:[record] });
    const successText = entryType === 'start' ? '作業開始を登録しました' : '作業完了を登録しました';
    const queuedText = entryType === 'start' ? '作業開始をキューへ保存しました' : '作業完了をキューへ保存しました';
    // オンラインなら即送信、失敗したらキューへ
    if (navigator.onLine) {
      try {
        const response = await postRecords([record]);
        handleSyncResponse([record], response);
        msg(successText, true);
      } catch (e) {
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
      $('operator').value = '';
      $('equipment').value = '';
      renderStartOptions();
    } else {
      setDateTimeToNow($('endAt'));
      $('qty').value = '0';
      $('downtimeMin').value = '0';
      if (startLinkSelect) {
        startLinkSelect.value = '';
        updateStartSummary();
      }
      $('planId').value = '';
    }
  } catch (e) {
    msg('送信エラー: ' + (e?.message || e));
    console.error(e);
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
    // 失敗したら戻す
    for (const it of items) {
      await enqueue(it);
      if ((it.entryType || 'start') === 'complete' && it.startRecordId) {
        markStartPending(it.startRecordId, false);
      }
    }
    msg('再送失敗。次回オンライン時に再試行します');
  }
}
window.addEventListener('online', flushQueue);
document.addEventListener('visibilitychange', () => { if (navigator.onLine && !document.hidden) flushQueue(); });

// --- SW登録 ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(()=>{});
}
