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

const getEntryMode = () => document.querySelector('input[name="entryType"]:checked')?.value || 'start';

function applyEntryMode(mode) {
  formRows.forEach((row) => {
    const modes = (row.dataset.modes || '').split(',').map((m) => m.trim()).filter(Boolean);
    const shouldShow = !modes.length || modes.includes(mode);
    row.classList.toggle('hidden', !shouldShow);
    const input = row.querySelector('input');
    if (!input) return;
    input.disabled = !shouldShow;
    if (shouldShow && row.dataset.required === 'true') {
      input.setAttribute('required', '');
    } else {
      input.removeAttribute('required');
    }
    if (!shouldShow) {
      if (input.type === 'number') {
        input.value = input.defaultValue ?? '';
      } else if (input.type === 'datetime-local') {
        input.value = '';
      }
    }
  });
}

entryModeInputs.forEach((input) => {
  input.addEventListener('change', () => applyEntryMode(input.value));
});

applyEntryMode(getEntryMode());

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
    const planId = $('planId').value.trim();
    if (!planId) { msg('Plan ID は必須です'); return; }

    const operator = $('operator').value.trim();
    const equipment = $('equipment').value.trim();

    const startAt = entryType === 'start' ? toIso($('startAt').value) : '';
    const endAt = entryType === 'complete' ? toIso($('endAt').value) : '';

    if (entryType === 'start' && !startAt) { msg('作業開始日時を入力してください'); return; }
    if (entryType === 'complete' && !endAt) { msg('作業完了日時を入力してください'); return; }
    if (entryType === 'start' && !operator) { msg('作業者を入力してください'); return; }

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

    const record = { planId, startAt, endAt, qty, downtimeMin, operator, equipment, entryType };
    console.log('POST payload', { entryType, records:[record] });
    const successText = entryType === 'start' ? '作業開始を登録しました' : '作業完了を登録しました';
    const queuedText = entryType === 'start' ? '作業開始をキューへ保存しました' : '作業完了をキューへ保存しました';
    // オンラインなら即送信、失敗したらキューへ
    if (navigator.onLine) {
      try {
        await postRecords([record]);
        msg(successText, true);
      } catch (e) {
        await enqueue(record);
        msg('一時的に失敗。入力内容をキューへ保存しました（オンライン復帰で自動送信）');
      }
    } else {
      await enqueue(record);
      msg(`オフラインのため${queuedText}`);
    }
    if (entryType === 'start') {
      $('startAt').value = '';
      $('operator').value = '';
    } else {
      $('endAt').value = '';
      $('qty').value = '0';
      $('downtimeMin').value = '0';
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
    await postRecords(items);
    msg(`キュー ${items.length} 件を送信しました`, true);
  } catch (e) {
    // 失敗したら戻す
    for (const it of items) await enqueue(it);
    msg('再送失敗。次回オンライン時に再試行します');
  }
}
window.addEventListener('online', flushQueue);
document.addEventListener('visibilitychange', () => { if (navigator.onLine && !document.hidden) flushQueue(); });

// --- SW登録 ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(()=>{});
}
