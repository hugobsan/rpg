import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { AGG, TZ, parseFilter } from "@/lib/usage";

export const dynamic = "force-dynamic";

// totais, quebras por agente/modelo/dia do recorte filtrado + opções dos filtros
export async function GET(req: NextRequest) {
  const { where, params, interval } = parseFilter(req.nextUrl.searchParams);
  const [[totals], byAgent, byModel, byDay, [bounds], agents, campaigns, models] = await Promise.all([
    q(`SELECT ${AGG} FROM api_logs ${where}`, params),
    q(`SELECT agent_id, ${AGG} FROM api_logs ${where} GROUP BY agent_id ORDER BY cost DESC, calls DESC`, params),
    q(`SELECT model, ${AGG} FROM api_logs ${where} GROUP BY model ORDER BY cost DESC, calls DESC`, params),
    q(
      `SELECT to_char((created_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS day, agent_id,
              COUNT(*)::int AS calls, COALESCE(SUM(cost), 0)::float AS cost
       FROM api_logs ${where} GROUP BY 1, 2 ORDER BY 1`,
      params
    ),
    // primeiro dia do preset e "hoje", no fuso do usuário, para o eixo do gráfico
    q(
      `SELECT to_char(((now() - $1::interval) AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS start,
              to_char((now() AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS today`,
      [interval ?? "0 days"]
    ),
    q(`SELECT id, name FROM agents`),
    q(`SELECT id, name FROM campaigns ORDER BY created_at DESC`),
    q<{ model: string }>(`SELECT DISTINCT model FROM api_logs ORDER BY model`),
  ]);
  return NextResponse.json({
    totals,
    byAgent,
    byModel,
    byDay,
    start: interval ? bounds.start : null,
    today: bounds.today,
    options: { agents, campaigns, models: models.map((m) => m.model) },
  });
}
