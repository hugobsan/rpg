import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 10;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const page = Math.max(Number(req.nextUrl.searchParams.get("page") || 1), 1);
  // totais do agente inteiro (não só da página)
  const [totals] = await q(
    `SELECT COUNT(*)::int AS calls,
            COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS errors,
            MAX(created_at)::text AS last_at,
            COALESCE(SUM(cost) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::float AS day,
            COALESCE(SUM(cost), 0)::float AS total,
            AVG(duration_ms) FILTER (WHERE error IS NULL)::float AS avg_ms,
            COALESCE(SUM(prompt_tokens), 0)::bigint::float AS prompt_tokens,
            COALESCE(SUM(completion_tokens), 0)::bigint::float AS completion_tokens
     FROM api_logs WHERE agent_id = $1`,
    [id]
  );
  const rows = await q(
    `SELECT id, campaign_id, model, purpose, request, response, prompt_tokens,
            completion_tokens, duration_ms, error, cost::float, created_at::text
     FROM api_logs WHERE agent_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3`,
    [id, PAGE_SIZE, (page - 1) * PAGE_SIZE]
  );
  return NextResponse.json({ rows, totals, page, pageSize: PAGE_SIZE });
}
