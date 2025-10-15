import { addQueue, listQueue, removeQueue, countQueue } from "./db.js";

const els = {
  planId: document.getElementById("planId"),
  start: document.getElementById("startBtn"),
  end: document.getElementById("endBtn"),
  qty: document.getElementById("qty"),
  downReason: document.getElementById("downReason"),
  downMin: document.getElementById("downMin"),
  pending: document.getElementById("pendingCount"),
  sync: document.getElementById("syncBtn"),
};

let currentStart = null;
const deviceId = localStorage.getItem("deviceId") || (()=>{ const v = crypto.randomUUID(); localStorage.setItem("deviceId", v); return v; })();

function nowISO(){ return new Date().toISOString(); }
async function refreshPending(){ els.pending.textContent = String(await countQueue()); }

async function saveLocal(payload){
  await addQueue(payload);
  await refreshPending();
}

els.start.onclick = async () => {
  currentStart = nowISO();
  // 任意: 計画ステータス更新（開始）
  // fetch("/api/plan-status", { method: "POST", body: JSON.stringify({ planId: els.planId.value, status: "進行中" }) });
  alert("開始を記録しました");
};

els.end.onclick = async () => {
  if (!currentStart) { alert("先に開始を押してください"); return; }
  const rec = {
    planId: els.planId.value,
    startAt: currentStart,
    endAt: nowISO(),
    qty: Number(els.qty.value || 0),
    downtimeMin: Number(els.downMin.value || 0),
    downtimeReason: els.downReason.value,
    operator: "", // 任意: ログイン名等
    equipment: "",
    deviceId,
  };
  await saveLocal(rec);
  currentStart = null;
  alert("終了を記録（未送信キューへ保存）");
};

els.sync.onclick = async () => { await trySync(); };

async function trySync(){
  const batch = await listQueue(100);
  if (!batch.length) { await refreshPending(); return; }
  try {
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });
    if (res.ok) {
      await removeQueue(batch.map(b => b.localId));
    }
  } catch(e){ /* offlineなど */ }
  await refreshPending();
}


window.addEventListener("online", trySync);
window.addEventListener("load", refreshPending);