/// <reference types="@cloudflare/workers-types" />
export interface Env {
  KINTONE_BASE: string;
  KINTONE_PLAN_APP: string; // 計画アプリID
  KINTONE_TOKEN_PLAN: string; // 計画アプリ用トークン（更新権限最小）
}

 type PlanStatusBody = { planId: string; status: string };
 function isPlanBody(x: unknown): x is PlanStatusBody {
   if (typeof x !== 'object' || x === null) return false;
   const o = x as Record<string, unknown>;
   return typeof o.planId === 'string' && typeof o.status === 'string';
 }

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const raw: unknown = await context.request.json();
  if (!isPlanBody(raw)) return new Response('bad request', { status: 400 });
  const { planId, status } = raw;

  // 計画IDでレコード特定 → ステータス更新（例: ドロップダウン/文字列）
  const endpoint = `${context.env.KINTONE_BASE}/k/v1/records.json`;
  const query = `計画ID = "${planId}"`;

  // 1) 該当レコードの取得
  const getRes = await fetch(`${endpoint}?app=${context.env.KINTONE_PLAN_APP}&query=${encodeURIComponent(query)}`, {
    headers: { "X-Cybozu-API-Token": context.env.KINTONE_TOKEN_PLAN },
  });
  if (!getRes.ok) return new Response('get failed', { status: 502 });
  const data = (await getRes.json()) as { records?: any[] };
  const rec = data.records?.[0];
  if (!rec) return new Response("not found", { status: 404 });

  // 2) 更新
  const putRes = await fetch(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Cybozu-API-Token": context.env.KINTONE_TOKEN_PLAN },
    body: JSON.stringify({
      app: context.env.KINTONE_PLAN_APP,
      records: [
        {
          id: rec.$id.value,
          record: { ステータス: { value: status } },
        },
      ],
    }),
  });

  if (!putRes.ok) return new Response("update failed", { status: 502 });
  return new Response(JSON.stringify({ ok: true }));
};