/// <reference types="@cloudflare/workers-types" />

export interface Env {
  KINTONE_BASE: string;       // 例: https://xxxxx.cybozu.com（末尾/なし）
  KINTONE_LOG_APP: string;    // 実績アプリID（数値文字列）
  KINTONE_TOKEN_LOG: string;  // 実績アプリのAPIトークン（追加権限）
  KINTONE_TOKEN_LUP?: string; // 参照元(lookup)アプリのAPIトークン（閲覧権限）
}

// /records.json と /record.json を同じ形に寄せる
type RecResp = { ids: string[]; revisions: string[] };
function toRecResp(x: unknown): RecResp {
  const a = x as any;
  if (a && Array.isArray(a.ids) && Array.isArray(a.revisions)) return a;
  if (a && typeof a.id === "string" && typeof a.revision === "string") {
    return { ids: [a.id], revisions: [a.revision] };
  }
  throw new Error("unexpected kintone response");
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
} as const;

export const onRequestOptions: PagesFunction<Env> = async () =>
  new Response(null, { status: 204, headers: CORS_HEADERS });

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    // ---- JSONを安全に読む（文字列/JSONどちらでも）----
    let txt = "";
    try { txt = await context.request.text(); } catch {}
    let raw: any;
    try { raw = txt ? JSON.parse(txt) : await context.request.json(); }
    catch { return new Response(JSON.stringify({ error: "bad payload (not json)" }), { status: 400, headers: CORS_HEADERS }); }

    // 共通ヘッダー（複数トークンをカンマ連結）
    const tokens = [context.env.KINTONE_TOKEN_LOG, context.env.KINTONE_TOKEN_LUP].filter(Boolean).join(",");
    const jsonHeaders = { "Content-Type": "application/json", "X-Cybozu-API-Token": tokens };

    // ---- ① kintoneネイティブ形式ならそのまま透過 ----
    if (raw && typeof raw === "object" && ("record" in raw || "records" in raw)) {
      const hasRecord = "record" in raw;
      const endpoint = `${context.env.KINTONE_BASE}/k/v1/${hasRecord ? "record" : "records"}.json`;
      const app = raw.app ?? context.env.KINTONE_LOG_APP;
      const payload = hasRecord ? { app, record: raw.record } : { app, records: raw.records };

      const res = await fetch(endpoint, { method: "POST", headers: jsonHeaders, body: JSON.stringify(payload) });
      if (!res.ok) {
        const err = await res.text();
        return new Response(err, { status: res.status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
      }
      const k = toRecResp(await res.json());
      return new Response(JSON.stringify({ ok: true, ids: k.ids, revisions: k.revisions }), {
        status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    // ---- ② 簡易形式 {records:[{planId,startAt,...}]} or 配列 → kintone形式へ変換 ----
    const arr: any[] =
      Array.isArray(raw) ? raw :
      (raw && typeof raw === "object" && Array.isArray(raw.records)) ? raw.records :
      [];

    if (!arr.length) {
      return new Response(JSON.stringify({ error: "bad payload (array or {records:[]} expected)" }), { status: 400, headers: CORS_HEADERS });
    }

    const asNum = (v: any) => (typeof v === "number" ? v : Number(v));
    const kintoneRecords = arr.map((r) => ({
      plan_id:        { value: String(r?.planId ?? "") },
      start_at:       { value: String(r?.startAt ?? "") },
      end_at:         { value: String(r?.endAt ?? "") },
      quantity:       { value: asNum(r?.qty ?? 0) },
      downtime_min:   { value: asNum(r?.downtimeMin ?? 0) },
      downtime_reason:{ value: String(r?.downtimeReason ?? "") },
      operator:       { value: (String(r?.operator ?? "").trim() || "-")  },
      equipment:      { value: (String(r?.equipment ?? "") .trim() || "-") },
    })).filter(r => r.plan_id.value && r.start_at.value && r.end_at.value);

    if (!kintoneRecords.length) {
      return new Response(JSON.stringify({ error: "bad payload (required fields missing)" }), { status: 400, headers: CORS_HEADERS });
    }

    const endpoint = `${context.env.KINTONE_BASE}/k/v1/records.json`;
    const payload = { app: context.env.KINTONE_LOG_APP, records: kintoneRecords };

    const res = await fetch(endpoint, { method: "POST", headers: jsonHeaders, body: JSON.stringify(payload) });
    if (!res.ok) {
      const err = await res.text();
      return new Response(err, { status: res.status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
    }
    const k = toRecResp(await res.json());
    return new Response(JSON.stringify({ ok: true, ids: k.ids, revisions: k.revisions }), {
      status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || String(e) }), { status: 400, headers: CORS_HEADERS });
  }
};
