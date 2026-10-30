// Filtros da tela /usage → cláusula WHERE parametrizada sobre api_logs.

export const TZ = "America/Sao_Paulo";
export const DEFAULT_RANGE = "30d";
const RANGES: Record<string, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// métricas somadas, reaproveitadas no total, por agente e por modelo
export const AGG = `COUNT(*)::int AS calls,
  COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS errors,
  COALESCE(SUM(cost), 0)::float AS cost,
  COALESCE(SUM(prompt_tokens), 0)::float AS prompt_tokens,
  COALESCE(SUM(completion_tokens), 0)::float AS completion_tokens,
  AVG(duration_ms) FILTER (WHERE error IS NULL)::float AS avg_ms,
  MAX(created_at)::text AS last_at`;

/** YYYY-MM-DD válido (rejeita 2026-02-31) ou null. */
function validDate(s: string | null): string | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(+d) && d.toISOString().slice(0, 10) === s ? s : null;
}

export function parseFilter(sp: URLSearchParams) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };

  const agents = (sp.get("agent") || "").split(",").filter((a) => /^[\w-]{1,40}$/.test(a)).slice(0, 20);
  if (agents.length) add("agent_id = ANY(?)", agents);
  const campaign = sp.get("campaign");
  if (campaign && UUID.test(campaign)) add("campaign_id = ?", campaign);
  const model = sp.get("model");
  if (model && model.length <= 200) add("model = ?", model);
  const provider = sp.get("provider");
  if (provider && provider.length <= 60) add("provider = ?", provider);
  if (sp.get("errors") === "1") where.push("error IS NOT NULL");

  // período: datas personalizadas têm prioridade sobre o preset; dias no fuso de São Paulo
  const from = validDate(sp.get("from"));
  const to = validDate(sp.get("to"));
  const interval = from || to ? null : RANGES[sp.get("range") ?? DEFAULT_RANGE] ?? null;
  if (interval) add("created_at > now() - ?::interval", interval);
  if (from) add(`created_at >= ?::date::timestamp AT TIME ZONE '${TZ}'`, from);
  if (to) add(`created_at < (?::date + 1)::timestamp AT TIME ZONE '${TZ}'`, to);

  return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", params, interval };
}
