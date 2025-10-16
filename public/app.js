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

// --- 送信本体 ---
async function postRecords(records) {
  const res = await fetch('/api/sync', {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ records })
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// --- 送信処理 ---
$('reportForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    // 入力取得
    const toIso = (val) => {
      // datetime-localをISOに。空なら空文字
      if (!val) return '';
      // そのまま送る（サーバ側はUTC/オフセットどちらでも受ける）
      const d = new Date(val);
      return d.toISOString();
    };
    const planId = $('planId').value.trim();
    const startAt = toIso($('startAt').value);
    const endAt   = toIso($('endAt').value);
    const qty = Number($('qty').value || 0);
    const downtimeMin = Number($('downtimeMin').value || 0);
    const operator = $('operator').value.trim();
    const equipment = $('equipment').value.trim();
    const deviceId = $('deviceId').value.trim() || (navigator.userAgent || 'device');

    if (!planId || !startAt || !endAt) {
      msg('Plan/Start/End は必須です'); return;
    }
    if (new Date(startAt) > new Date(endAt)) {
      msg('End は Start 以降にしてください'); return;
    }

    const record = { planId, startAt, endAt, qty, downtimeMin, operator, equipment, deviceId };
    // オンラインなら即送信、失敗したらキューへ
    if (navigator.onLine) {
      try {
        await postRecords([record]);
        msg('送信しました', true);
      } catch (e) {
        await enqueue(record);
        msg('一時的に失敗。キューへ保存しました（オンライン復帰で自動送信）');
      }
    } else {
      await enqueue(record);
      msg('オフラインのためキューへ保存しました');
    }
    // フォームを軽くクリア（必要に応じて）
    // $('qty').value = 0; $('downtimeMin').value = 0;
  } catch (e) {
    msg('送信エラー: ' + (e?.message || e));
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
