import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") || 30), 100);
  const rows = await q(
    `SELECT id, campaign_id, model, purpose, request, response, prompt_tokens,
            completion_tokens, duration_ms, error, created_at::text
     FROM api_logs WHERE agent_id = $1 ORDER BY id DESC LIMIT $2`,
    [id, limit]
  );
  return NextResponse.json(rows);
}
