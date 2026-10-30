import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { parseFilter } from "@/lib/usage";

export const dynamic = "force-dynamic";

// whitelist de ordenação: chave da URL → expressão SQL fixa
const SORTS: Record<string, string> = {
  when: "created_at",
  agent: "agent_id",
  purpose: "purpose",
  model: "model",
  tokens: "COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)",
  cost: "cost",
  duration: "duration_ms",
  status: "(error IS NOT NULL)",
};

// histórico paginado do recorte filtrado
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const { where, params } = parseFilter(sp);
  const pageSize = sp.get("size") === "20" ? 20 : 10;
  const page = Math.min(Math.max(Math.floor(Number(sp.get("page")) || 1), 1), 100000);
  const n = params.length;
  const dir = sp.get("dir") === "asc" ? "ASC" : "DESC";
  const sort = SORTS[sp.get("sort") ?? ""];
  // desempate por id para a paginação ser estável; sem sort = mais recentes primeiro (id)
  const order = sort ? `${sort} ${dir} NULLS LAST, id ${dir}` : `id ${dir}`;
  const [rows, [{ total }]] = await Promise.all([
    q(
      `SELECT id, agent_id, campaign_id, model, purpose, request, response, prompt_tokens,
              completion_tokens, duration_ms, error, cost::float, created_at::text
       FROM api_logs ${where} ORDER BY ${order} LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    ),
    q<{ total: number }>(`SELECT COUNT(*)::int AS total FROM api_logs ${where}`, params),
  ]);
  return NextResponse.json({ rows, total, page, pageSize });
}
