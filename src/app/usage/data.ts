// Consultas da tela /usage: usadas pela página (Server Component, 1ª carga) e pelas rotas /api/usage/*.
import { q } from "@/lib/db";
import { AGG, TZ, parseFilter } from "@/lib/usage";

export interface Agg {
  calls: number;
  errors: number;
  cost: number;
  prompt_tokens: number;
  completion_tokens: number;
  avg_ms: number | null;
  last_at: string | null;
}
export interface DayRow { day: string; agent_id: string | null; calls: number; cost: number }
export interface Summary {
  totals: Agg;
  byAgent: (Agg & { agent_id: string | null })[];
  byModel: (Agg & { model: string; provider: string })[];
  byDay: DayRow[];
  start: string | null;
  today: string;
  options: { agents: { id: string; name: string }[]; campaigns: { id: string; name: string }[]; models: string[]; providers: string[] };
}
/** Linha do histórico sem request/response (o detalhe vem de /api/usage/logs/[id] ao expandir). */
export interface LogRow {
  id: number;
  agent_id: string | null;
  campaign_id: string | null;
  model: string;
  provider: string; // fonte de modelos (openrouter ou o id de outra fonte)
  purpose: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  duration_ms: number | null;
  cost: number | null;
  error: string | null;
  created_at: string;
}
export interface LogPage { rows: LogRow[]; total: number; page: number; pageSize: number }

/** totais, quebras por agente/modelo/dia do recorte filtrado + opções dos filtros */
export async function usageSummary(sp: URLSearchParams): Promise<Summary> {
  const { where, params, interval } = parseFilter(sp);
  const [[totals], byAgent, byModel, byDay, [bounds], agents, campaigns, models, providers] = await Promise.all([
    q<Agg>(`SELECT ${AGG} FROM api_logs ${where}`, params),
    q<Agg & { agent_id: string | null }>(`SELECT agent_id, ${AGG} FROM api_logs ${where} GROUP BY agent_id ORDER BY cost DESC, calls DESC`, params),
    q<Agg & { model: string; provider: string }>(`SELECT model, provider, ${AGG} FROM api_logs ${where} GROUP BY model, provider ORDER BY cost DESC, calls DESC`, params),
    q<DayRow>(
      `SELECT to_char((created_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS day, agent_id,
              COUNT(*)::int AS calls, COALESCE(SUM(cost), 0)::float AS cost
       FROM api_logs ${where} GROUP BY 1, 2 ORDER BY 1`,
      params
    ),
    // primeiro dia do preset e "hoje", no fuso do usuário, para o eixo do gráfico
    q<{ start: string; today: string }>(
      `SELECT to_char(((now() - $1::interval) AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS start,
              to_char((now() AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS today`,
      [interval ?? "0 days"]
    ),
    q<{ id: string; name: string }>(`SELECT id, name FROM agents`),
    q<{ id: string; name: string }>(`SELECT id, name FROM campaigns ORDER BY created_at DESC`),
    q<{ model: string }>(`SELECT DISTINCT model FROM api_logs ORDER BY model`),
    q<{ provider: string }>(`SELECT DISTINCT provider FROM api_logs ORDER BY provider`),
  ]);
  return {
    totals,
    byAgent,
    byModel,
    byDay,
    start: interval ? bounds.start : null,
    today: bounds.today,
    options: { agents, campaigns, models: models.map((m) => m.model), providers: providers.map((p) => p.provider) },
  };
}

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

/** histórico paginado do recorte filtrado */
export async function usageLogs(sp: URLSearchParams): Promise<LogPage> {
  const { where, params } = parseFilter(sp);
  const pageSize = sp.get("size") === "20" ? 20 : 10;
  const page = Math.min(Math.max(Math.floor(Number(sp.get("page")) || 1), 1), 100000);
  const n = params.length;
  const dir = sp.get("dir") === "asc" ? "ASC" : "DESC";
  const sort = SORTS[sp.get("sort") ?? ""];
  // desempate por id para a paginação ser estável; sem sort = mais recentes primeiro (id)
  const order = sort ? `${sort} ${dir} NULLS LAST, id ${dir}` : `id ${dir}`;
  const [rows, [{ total }]] = await Promise.all([
    q<LogRow>(
      `SELECT id, agent_id, campaign_id, model, provider, purpose, prompt_tokens,
              completion_tokens, duration_ms, error, cost::float, created_at::text
       FROM api_logs ${where} ORDER BY ${order} LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    ),
    q<{ total: number }>(`SELECT COUNT(*)::int AS total FROM api_logs ${where}`, params),
  ]);
  return { rows, total, page, pageSize };
}
