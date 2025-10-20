/// <reference types="@cloudflare/workers-types" />

export interface Env {
  KINTONE_BASE: string;       // 例: https://xxxxx.cybozu.com（末尾/なし）
  KINTONE_LOG_APP: string;    // 実績アプリID（数値文字列）
  KINTONE_TOKEN_LOG: string;  // 実績アプリのAPIトークン（追加権限）
  KINTONE_TOKEN_LOG_UPDATE?: string; // 実績アプリのAPIトークン（更新権限）
  KINTONE_TOKEN_LUP?: string; // 参照元(lookup)アプリのAPIトークン（閲覧権限）
  KINTONE_FORM_SCHEMA?: string; // form APIが使えない場合のフォールバックJSON
  KINTONE_LOOKUP_CONFIG?: string; // ルックアップ設定のフォールバックJSON
}
function safeJson(s: string) {
  try { return JSON.parse(s); } catch { return s; }
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

type KintoneFieldValue = { value: unknown } & Record<string, unknown>;
type KintoneRecordLike = Record<string, KintoneFieldValue>;

function isKintoneFieldValue(v: unknown): v is KintoneFieldValue {
  return !!v && typeof v === "object" && Object.prototype.hasOwnProperty.call(v, "value");
}

function isKintoneRecordLike(record: unknown): record is KintoneRecordLike {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const values = Object.values(record as Record<string, unknown>);
  return values.every(isKintoneFieldValue);
}

export function isKintoneNativePayload(raw: unknown): raw is { app?: string; record?: KintoneRecordLike; records?: KintoneRecordLike[] } {
  if (!raw || typeof raw !== "object") return false;

  const maybeRecord = (raw as Record<string, unknown>).record;
  if (maybeRecord !== undefined) {
    if (isKintoneRecordLike(maybeRecord)) return true;
    return false;
  }

  const maybeRecords = (raw as Record<string, unknown>).records;
  if (Array.isArray(maybeRecords)) {
    return maybeRecords.every(isKintoneRecordLike);
  }

  return false;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
} as const;

const JSON_CORS_HEADERS = { "Content-Type": "application/json", ...CORS_HEADERS } as const;

type RequestContext = Parameters<PagesFunction<Env>>[0];

type FormProperties = Record<string, any> & {
  properties?: Record<string, any>;
  warning?: { message: string };
};

let cachedFormDefinition: FormProperties | null = null;
let cachedFormFetchedAt = 0;
const FORM_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

type FieldMapping = { field: string; relatedField: string };
type ResolvedLookupConfig = {
  fieldCode: string;
  relatedApp: string;
  relatedKeyField: string;
  pickerFields: string[];
  displayFields: string[];
  fieldMappings: FieldMapping[];
  fieldSet: string[];
};

function coerceFieldList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const result: string[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed) result.push(trimmed);
      continue;
    }
    if (entry && typeof entry === "object") {
      const maybeField = (entry as any).field ?? (entry as any).code ?? (entry as any).fieldCode;
      if (typeof maybeField === "string") {
        const trimmed = maybeField.trim();
        if (trimmed) result.push(trimmed);
      }
    }
  }
  return result;
}

function normalizeMappings(list: unknown): FieldMapping[] {
  if (!Array.isArray(list)) return [];
  const result: FieldMapping[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const field = typeof (entry as any).field === "string" ? (entry as any).field.trim() : "";
    const relatedField = typeof (entry as any).relatedField === "string" ? (entry as any).relatedField.trim() : "";
    if (field && relatedField) {
      result.push({ field, relatedField });
    }
  }
  return result;
}

function loadStaticFormDefinition(env: Env): FormProperties | null {
  const raw = env.KINTONE_FORM_SCHEMA;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.properties) {
      return parsed as FormProperties;
    }
  } catch (err) {
    console.warn("failed to parse KINTONE_FORM_SCHEMA", err);
  }
  return null;
}

async function fetchFormDefinition(context: RequestContext, forceRefresh = false): Promise<FormProperties> {
  const now = Date.now();
  if (!forceRefresh && cachedFormDefinition && now - cachedFormFetchedAt < FORM_CACHE_TTL_MS) {
    return cachedFormDefinition;
  }
  const endpoint = `${context.env.KINTONE_BASE}/k/v1/app/form/fields.json?app=${encodeURIComponent(context.env.KINTONE_LOG_APP)}`;
  const headers = buildKintoneHeaders(context.env);
  const res = await fetch(endpoint, { method: "GET", headers });
  if (!res.ok) {
    const detailText = await res.text();
    const detail = safeJson(detailText);
    const fallback = loadStaticFormDefinition(context.env);
    if (fallback) {
      if (!fallback.warning) {
        fallback.warning = { message: "returned static form schema" };
      }
      cachedFormDefinition = fallback;
      cachedFormFetchedAt = now;
      return fallback;
    }
    if (
      res.status === 400 &&
      detail &&
      typeof detail === "object" &&
      (detail as any).code === "CB_IL02"
    ) {
      cachedFormDefinition = {
        properties: {},
        warning: { message: "form API unavailable for provided token" },
      };
      cachedFormFetchedAt = now;
      return cachedFormDefinition;
    }
    throw new Response(JSON.stringify({
      error: "kintone error",
      detail,
    }), { status: res.status, headers: JSON_CORS_HEADERS });
  }
  const json = await res.json();
  if (!json || typeof json !== "object" || !json.properties) {
    throw new Response(JSON.stringify({ error: "unexpected form definition" }), { status: 500, headers: JSON_CORS_HEADERS });
  }
  cachedFormDefinition = json as FormProperties;
  cachedFormFetchedAt = now;
  return cachedFormDefinition;
}

function buildKintoneHeaders(env: Env, primaryToken?: string) {
  const tokens = [primaryToken ?? env.KINTONE_TOKEN_LOG, env.KINTONE_TOKEN_LUP]
    .filter(Boolean)
    .join(",");
  return {
    "Content-Type": "application/json",
    "X-Cybozu-API-Token": tokens,
  } as Record<string, string>;
}

function encodeFields(params: URLSearchParams, fields: string[]) {
  fields.forEach((field, idx) => {
    params.append(`fields[${idx}]`, field);
  });
}

function escapeKintoneValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function unique<T>(arr: Iterable<T>): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const item of arr) {
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function normalizeFieldList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const result: string[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed) result.push(trimmed);
      continue;
    }
    if (entry && typeof entry === "object") {
      const maybeField = (entry as any).field ?? (entry as any).code ?? (entry as any).fieldCode;
      if (typeof maybeField === "string") {
        const trimmed = maybeField.trim();
        if (trimmed) result.push(trimmed);
      }
    }
  }
  return result;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const url = new URL(context.request.url);
    const type = url.searchParams.get("type");
    if (!type) {
      return new Response(JSON.stringify({ error: "missing type" }), { status: 400, headers: JSON_CORS_HEADERS });
    }

    const forceRefresh = url.searchParams.has("cacheBust");

    if (type === "form") {
      try {
        const body = await fetchFormDefinition(context, forceRefresh);
        return new Response(JSON.stringify(body), { status: 200, headers: JSON_CORS_HEADERS });
      } catch (err) {
        if (err instanceof Response) return err;
        return new Response(JSON.stringify({ error: (err as Error).message || String(err) }), { status: 500, headers: JSON_CORS_HEADERS });
      }
    }

    if (type === "open-starts") {
      const fields = ["plan_id", "start_at", "operator", "equipment", "end_at", "$id"];
      const params = new URLSearchParams();
      params.set("app", context.env.KINTONE_LOG_APP);
      params.set("query", "end_at = \"\" order by start_at asc");
      encodeFields(params, fields);
      params.set("size", "500");
      const endpoint = `${context.env.KINTONE_BASE}/k/v1/records.json?${params.toString()}`;
      const res = await fetch(endpoint, { method: "GET", headers: buildKintoneHeaders(context.env) });
      if (!res.ok) {
        const detail = await res.text();
        return new Response(JSON.stringify({ error: "kintone error", detail: safeJson(detail) }), { status: res.status, headers: JSON_CORS_HEADERS });
      }
      const json = await res.json();
      const records = Array.isArray(json?.records) ? json.records : [];
      const simplified = records.map((rec: any) => ({
        recordId: rec?.$id?.value ?? "",
        planId: rec?.plan_id?.value ?? "",
        startAt: rec?.start_at?.value ?? "",
        operator: rec?.operator?.value ?? "",
        equipment: rec?.equipment?.value ?? "",
      }));
      return new Response(JSON.stringify({ records: simplified }), { status: 200, headers: JSON_CORS_HEADERS });
    }

    const formDef = await fetchFormDefinition(context, forceRefresh);
    const properties = formDef.properties as Record<string, any>;

    const planFieldCode = url.searchParams.get("field") ?? "";
    const term = url.searchParams.get("term") ?? "";
    if (!planFieldCode) {
      return new Response(JSON.stringify({ error: "missing field" }), { status: 400, headers: JSON_CORS_HEADERS });
    }

    const lookupEntry = Object.values(properties).find((prop: any) => {
      if (!prop || !prop.lookup) return false;
      const mappings = Array.isArray(prop.lookup?.fieldMappings) ? prop.lookup.fieldMappings : [];
      return mappings.some((m: any) => m?.field === planFieldCode);
    });

    let resolved: ResolvedLookupConfig | null = null;
    if (lookupEntry && lookupEntry.lookup) {
      const lookup = lookupEntry.lookup;
      const relatedApp = lookup?.relatedApp?.app;
      const relatedKeyField = lookup?.relatedKeyField;
      if (relatedApp && relatedKeyField) {
        const pickerFields: string[] = coerceFieldList(lookup?.lookupPickerFields);
        const fieldMappings = normalizeMappings(lookup?.fieldMappings);
        const mappedFields = fieldMappings.map((m) => m.relatedField);
        const displayFields = unique([
          ...pickerFields,
          ...mappedFields,
        ]);
        const fieldSet = unique([relatedKeyField, ...displayFields, "$id"]);
        resolved = {
          fieldCode: planFieldCode,
          relatedApp,
          relatedKeyField,
          pickerFields,
          displayFields,
          fieldMappings,
          fieldSet,
        };
      }
    }

    if (!resolved) {
      return new Response(JSON.stringify({ error: "lookup not configured for field" }), { status: 404, headers: JSON_CORS_HEADERS });
    }

    const { relatedApp, relatedKeyField, pickerFields, fieldSet } = resolved;

    if (type === "lookup-record") {
      const value = url.searchParams.get("value") ?? "";
      if (!value) {
        return new Response(JSON.stringify({ error: "missing value" }), { status: 400, headers: JSON_CORS_HEADERS });
      }
      const params = new URLSearchParams();
      params.set("app", relatedApp);
      const query = `${relatedKeyField} = "${escapeKintoneValue(value)}" limit 1`;
      params.set("query", query);
      encodeFields(params, fieldSet);
      const endpoint = `${context.env.KINTONE_BASE}/k/v1/records.json?${params.toString()}`;
      const res = await fetch(endpoint, { method: "GET", headers: buildKintoneHeaders(context.env) });
      if (!res.ok) {
        const detail = await res.text();
        return new Response(JSON.stringify({ error: "kintone error", detail: safeJson(detail) }), { status: res.status, headers: JSON_CORS_HEADERS });
      }
      const json = await res.json();
      const rec = Array.isArray(json?.records) ? json.records[0] : undefined;
      return new Response(JSON.stringify({ record: rec ?? null }), { status: 200, headers: JSON_CORS_HEADERS });
    }

    if (type === "lookup-options") {
      const params = new URLSearchParams();
      params.set("app", relatedApp);
      let query = "";
      if (term) {
        const escapedTerm = escapeKintoneValue(term);
        const clauses = unique([relatedKeyField, ...pickerFields]).map((field) => `${field} like "${escapedTerm}"`);
        query = `${clauses.join(" or ")} order by ${relatedKeyField} asc limit 30`;
      } else {
        query = `order by ${relatedKeyField} asc limit 30`;
      }
      params.set("query", query);
      encodeFields(params, fieldSet);
      const endpoint = `${context.env.KINTONE_BASE}/k/v1/records.json?${params.toString()}`;
      const res = await fetch(endpoint, { method: "GET", headers: buildKintoneHeaders(context.env) });
      if (!res.ok) {
        const detail = await res.text();
        return new Response(JSON.stringify({ error: "kintone error", detail: safeJson(detail) }), { status: res.status, headers: JSON_CORS_HEADERS });
      }
      const json = await res.json();
      return new Response(JSON.stringify({ records: json?.records ?? [] }), { status: 200, headers: JSON_CORS_HEADERS });
    }

    return new Response(JSON.stringify({ error: "unsupported type" }), { status: 400, headers: JSON_CORS_HEADERS });
  } catch (err) {
    if (err instanceof Response) return err;
    return new Response(JSON.stringify({ error: (err as Error).message || String(err) }), { status: 500, headers: JSON_CORS_HEADERS });
  }
};

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
    const createHeaders = buildKintoneHeaders(context.env, context.env.KINTONE_TOKEN_LOG);
    const updateHeaders = buildKintoneHeaders(context.env, context.env.KINTONE_TOKEN_LOG_UPDATE);

    // ---- ① kintoneネイティブ形式ならそのまま透過 ----
    if (isKintoneNativePayload(raw)) {
      const hasRecord = "record" in raw && raw.record !== undefined;
      const endpoint = `${context.env.KINTONE_BASE}/k/v1/${hasRecord ? "record" : "records"}.json`;
      const app = raw.app ?? context.env.KINTONE_LOG_APP;
      const payload = hasRecord ? { app, record: raw.record } : { app, records: raw.records };
      const payloadText = JSON.stringify(payload);

      const res = await fetch(endpoint, { method: "POST", headers: createHeaders, body: payloadText });
      if (!res.ok) {
        const err = await res.text();
        return new Response(JSON.stringify({
          error: "kintone error",
          detail: safeJson(err),
          sentPayloadPreview: payloadText.slice(0, 400),
        }), { status: res.status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
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

    const asNum = (v: any) => {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const startRecords: KintoneRecordLike[] = [];
    const completionUpdates: { id: string; record: KintoneRecordLike }[] = [];

    for (const item of arr) {
      const entryType = item?.entryType === "complete" ? "complete" : "start";
      const planId = String(item?.planId ?? "").trim();
      const downtimeReason = String(item?.downtimeReason ?? "");

      if (entryType === "complete") {
        const startRecordId = String(item?.startRecordId ?? "").trim();
        const endAt = String(item?.endAt ?? "").trim();
        if (!startRecordId || !endAt) continue;
        const qty = asNum(item?.qty ?? 0);
        const downtime = asNum(item?.downtimeMin ?? 0);
        if (!Number.isFinite(qty) || qty < 0) continue;
        if (!Number.isFinite(downtime) || downtime < 0) continue;

        const updateRecord: KintoneRecordLike = {
          end_at: { value: endAt },
          quantity: { value: qty },
          downtime_min: { value: downtime },
          downtime_reason: { value: downtimeReason },
        };
        completionUpdates.push({ id: startRecordId, record: updateRecord });
        continue;
      }

      if (!planId) continue;
      const startAt = String(item?.startAt ?? "").trim();
      if (!startAt) continue;
      const operator = String(item?.operator ?? "").trim();
      if (!operator) continue;
      const equipment = (String(item?.equipment ?? "").trim() || "-");
      const record: KintoneRecordLike = {
        plan_id: { value: planId },
        start_at: { value: startAt },
        end_at: { value: String(item?.endAt ?? "") },
        quantity: { value: asNum(item?.qty ?? 0) },
        downtime_min: { value: asNum(item?.downtimeMin ?? 0) },
        downtime_reason: { value: downtimeReason },
        operator: { value: operator || "-" },
        equipment: { value: equipment },
      };
      startRecords.push(record);
    }

    if (!startRecords.length && !completionUpdates.length) {
      return new Response(JSON.stringify({ error: "bad payload (required fields missing)" }), { status: 400, headers: CORS_HEADERS });
    }

    const created: RecResp = { ids: [], revisions: [] };
    if (startRecords.length) {
      const endpoint = `${context.env.KINTONE_BASE}/k/v1/records.json`;
      const payload = { app: context.env.KINTONE_LOG_APP, records: startRecords };
      const payloadText = JSON.stringify(payload);
      const res = await fetch(endpoint, { method: "POST", headers: createHeaders, body: payloadText });
      if (!res.ok) {
        const err = await res.text();
        return new Response(JSON.stringify({
          error: "kintone error",
          detail: safeJson(err),
          sentPayloadPreview: payloadText.slice(0, 400),
        }), { status: res.status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
      }
      const k = toRecResp(await res.json());
      created.ids.push(...k.ids);
      created.revisions.push(...k.revisions);
    }

    const updated: RecResp = { ids: [], revisions: [] };
    if (completionUpdates.length) {
      const endpoint = `${context.env.KINTONE_BASE}/k/v1/records.json`;
      const payload = {
        app: context.env.KINTONE_LOG_APP,
        records: completionUpdates.map((c) => ({ id: c.id, record: c.record })),
      };
      const payloadText = JSON.stringify(payload);
      const res = await fetch(endpoint, { method: "PUT", headers: updateHeaders, body: payloadText });
      if (!res.ok) {
        const err = await res.text();
        const detail = safeJson(err);
        const extra: Record<string, unknown> = {};
        if (
          res.status === 403 &&
          detail &&
          typeof detail === "object" &&
          (detail as Record<string, unknown>).code === "GAIA_NO01"
        ) {
          extra.hint = "Set KINTONE_TOKEN_LOG_UPDATE to an API token that has update permission for the log app.";
        }
        return new Response(JSON.stringify({
          error: "kintone error",
          detail,
          sentPayloadPreview: payloadText.slice(0, 400),
          ...extra,
        }), { status: res.status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
      }
      const body = await res.json();
      const records = Array.isArray(body?.records) ? body.records : [];
      for (const rec of records) {
        if (rec && typeof rec.id === "string" && typeof rec.revision === "string") {
          updated.ids.push(rec.id);
          updated.revisions.push(rec.revision);
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, ids: created.ids, revisions: created.revisions, created, updated }), {
      status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || String(e) }), { status: 400, headers: CORS_HEADERS });
  }
};
