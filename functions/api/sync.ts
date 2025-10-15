/// <reference types="@cloudflare/workers-types" />
export interface Env {
  KINTONE_BASE: string; // 例: https://xxxxx.cybozu.com
  KINTONE_LOG_APP: string; // 実績ログアプリID（数値文字列）
  KINTONE_TOKEN_LOG: string; // 実績ログAPIトークン（追加のみ）
}

 // 受信レコードの型
 export type ProdLog = {
   planId: string;
   startAt: string;
   endAt: string;
   qty: number;
   downtimeMin: number;
   downtimeReason?: string;
   operator?: string;
   equipment?: string;
   deviceId?: string;
   localId?: number;
 };

 // 要素検証
 function isRecord(x: unknown): x is ProdLog {
   if (typeof x !== 'object' || x === null) return false;
   const o = x as Record<string, unknown>;
   return typeof o.planId === 'string'
     && typeof o.startAt === 'string'
     && typeof o.endAt === 'string'
     && typeof o.qty === 'number'
     && typeof o.downtimeMin === 'number';
 }

 // 受信ボディを正規化（配列 or {records: [...]})
 function normalizeBody(body: unknown): ProdLog[] {
   if (Array.isArray(body)) {
     const ok = body.filter(isRecord) as ProdLog[];
     if (ok.length !== body.length) throw new Error('invalid item in array');
     return ok;
   }
   if (typeof body === 'object' && body !== null && Array.isArray((body as any).records)) {
     const arr = (body as any).records as unknown[];
     const ok = arr.filter(isRecord) as ProdLog[];
     if (ok.length !== arr.length) throw new Error('invalid item in records');
     return ok;
   }
   throw new Error('bad payload');
 }

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const raw: unknown = await context.request.json(); 
    const records = normalizeBody(raw);                
    if (!records || !Array.isArray(records) || records.length === 0) {
      return new Response(JSON.stringify({ error: "no records" }), { status: 400 });
    }

    // kintoneレコード形式に変換
    const kintoneRecords = records.map((r) => ({
      計画ID: { value: String(r.planId || "") },
      開始日時: { value: r.startAt || null },
      終了日時: { value: r.endAt || null },
      生産数: { value: Number(r.qty || 0) },
      ダウンタイム_分: { value: Number(r.downtimeMin || 0) },
      ダウン理由: { value: r.downtimeReason ?? "" },
      作業者: { value: r.operator ?? "" },
      設備: { value: r.equipment ?? "" },
      端末ID: { value: r.deviceId ?? "" },
    }));


    const endpoint = `${context.env.KINTONE_BASE}/k/v1/records.json`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
      "Content-Type": "application/json",
      "X-Cybozu-API-Token": context.env.KINTONE_TOKEN_LOG,
      },
      body: JSON.stringify({ app: context.env.KINTONE_LOG_APP, records: kintoneRecords }),
    });

  if (!res.ok) {
    const text = await res.text();
    return new Response(JSON.stringify({ error: "kintone error", detail: text }), { status: 502 });
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200 });
} catch (e: any) {
  return new Response(JSON.stringify({ error: e?.message || String(e) }), { status: 400 });
}
};