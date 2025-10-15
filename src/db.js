const DB_NAME = "prodlog"; const STORE = "queue"; const VERSION = 1;
let db;


function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "localId", autoIncrement: true });
    };
    req.onsuccess = () => { db = req.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
}

export async function addQueue(rec) {
if (!db) await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).add(rec);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function listQueue(limit = 50) {
  if (!db) await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const out = [];
    store.openCursor().onsuccess = (e) => {
      const cur = e.target.result; if (!cur) { res(out); return; }
      out.push(cur.value); if (out.length >= limit) { res(out); return; }
      cur.continue();
    };
    tx.onerror = () => rej(tx.error);
  });
}

export async function removeQueue(ids) {
  if (!db) await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    const st = tx.objectStore(STORE);
    ids.forEach((id) => st.delete(id));
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}


export async function countQueue() {
  if (!db) await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).count();
    req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
  });
}