/// <reference types="@cloudflare/workers-types" />
export interface Env {
  KINTONE_BASE: string; // 例: https://xxxxx.cybozu.com
  KINTONE_LOG_APP: string; // 実績ログアプリID（数値文字列）
  KINTONE_TOKEN_LOG: string; // 実績ログAPIトークン（追加のみ）
  KINTONE_TOKEN_LUP: string; //計画アプリAPIトークン（閲覧のみ）
}

// kintoneの /records.json と /record.json を両対応にまとめる
type RecResp = { ids: string[]; revisions: string[] };      // /records.json
type OneResp = { id: string; revision: string };            // /record.json
function toRecResp(x: unknown): RecResp {
  const a = x as any;
  if (a && Array.isArray(a.ids) && Array.isArray(a.revisions)) return a as RecResp;
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

export const onRequestOptions: PagesFunction<Env> = async () => {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    // 文字列でもJSONでも受ける
    let bodyText = "";
    try { bodyText = await context.request.text(); } catch {}
    let raw: any;
    try { raw = bodyText ? JSON.parse(bodyText) : await context.request.json(); }
    catch { return new Response(JSON.stringify({ error: "bad payload (not json)" }), { status: 400 }); }


    // まずは kintoneネイティブ形式なら透過（record/records があり、fieldCode:{value} っぽい）
    if (raw && typeof raw === "object" && ("record" in raw || "records" in raw)) {
      const looksNative =
        ("record" in raw && raw.record && typeof raw.record === "object") ||
        ("records" in raw && Array.isArray(raw.records) &&
          raw.records.length > 0 &&
          typeof raw.records[0] === "object" &&
          raw.records[0] !== null &&
          // 先頭要素が fieldCode:{value:...} を1つ以上含んでいるかざっくり判定
          Object.values(raw.records[0] as Record<string, any>).some((v) => v && typeof v === "object" && "value" in v)
        );
      if (looksNative) {
        const app = raw.app ?? context.env.KINTONE_LOG_APP;
        const hasRecord = "record" in raw;
        const endpoint = `${context.env.KINTONE_BASE}/k/v1/${hasRecord ? "record" : "records"}.json`;
        const payload = hasRecord ? { app, record: raw.record } : { app, records: raw.records };
        const payloadText = JSON.stringify(payload);
        const tokens = [context.env.KINTONE_TOKEN_LOG, context.env.KINTONE_TOKEN_LUP]
          .filter(Boolean)
          .join(",");

        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Cybozu-API-Token": tokens,
          },
          body: payloadText,
        });
        if (!res.ok) {
          const errText = await res.text();
          return new Response(errText, { status: res.status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
        }
        const kRaw: unknown = await res.json();
        const k = toRecResp(kRaw);
        return new Response(JSON.stringify({ ok: true, ids: k.ids, revisions: k.revisions }), {
          status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    // ---- 簡易形式として配列に正規化（{records:[…]} も配列にする／数値へ強制変換）----
    let arr: any[] = [];
    if (Array.isArray(raw)) {
      arr = raw;
    } else if (raw && typeof raw === "object" && Array.isArray(raw.records)) {
      arr = raw.records;
    } else {
      return new Response(JSON.stringify({ error: "bad payload (array or {records:[]} expected)" }), { status: 400 });
    }

    const toNumber = (v: any) => (typeof v === "number" ? v : Number(v));
    const records = arr.map((r) => ({
      planId: String((r as any).planId ?? ""),
      startAt: String((r as any).startAt ?? ""),
      endAt: String((r as any).endAt ?? ""),
      qty: toNumber((r as any).qty ?? 0),
      downtimeMin: toNumber((r as any).downtimeMin ?? 0),
      downtimeReason: (r as any).downtimeReason ?? "",
      operator: (r as any).operator ?? "",
      equipment: (r as any).equipment ?? "",
      deviceId: (r as any).deviceId ?? "",
    })).filter((r) => r.planId && r.startAt && r.endAt);

    if (!records.length) {
      return new Response(JSON.stringify({ error: "bad payload (required fields missing)" }), { status: 400 });
    }

    // kintoneレコード形式に変換
    const kintoneRecords = records.map((r) => ({
      plan_id:        { value: r.planId },
      start_at:       { value: r.startAt },
      end_at:         { value: r.endAt },
      quantity:       { value: Number(r.qty) },
      downtime_min:   { value: Number(r.downtimeMin) },
      downtime_reason:{ value: r.downtimeReason ?? '' },
      operator:       { value: r.operator ?? '' },
      equipment:      { value: r.equipment ?? '' },
      device_id:      { value: r.deviceId ?? '' },
    }));


    const endpoint = `${context.env.KINTONE_BASE}/k/v1/records.json`;
    const payloadText = JSON.stringify({ app: context.env.KINTONE_LOG_APP, records: kintoneRecords });
    const tokens = [context.env.KINTONE_TOKEN_LOG, context.env.KINTONE_TOKEN_LUP]
      .filter(Boolean)
      .join(",");

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cybozu-API-Token": tokens,
      },
      body: payloadText,
    });

    if (!res.ok) {
      const errText = await res.text();
      return new Response(errText, { status: res.status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
    }
    const kRaw: unknown = await res.json();
    const k = toRecResp(kRaw);
    return new Response(JSON.stringify({ ok: true, ids: k.ids, revisions: k.revisions }), {
      status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || String(e) }), { status: 400 });
  }
};