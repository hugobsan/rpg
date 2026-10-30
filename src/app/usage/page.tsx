"use client";
import { Fragment, Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

interface Agg {
  calls: number;
  errors: number;
  cost: number;
  prompt_tokens: number;
  completion_tokens: number;
  avg_ms: number | null;
  last_at: string | null;
}
interface DayRow { day: string; agent_id: string | null; calls: number; cost: number }
interface Summary {
  totals: Agg;
  byAgent: (Agg & { agent_id: string | null })[];
  byModel: (Agg & { model: string })[];
  byDay: DayRow[];
  start: string | null;
  today: string;
  options: { agents: { id: string; name: string }[]; campaigns: { id: string; name: string }[]; models: string[] };
}
interface LogRow {
  id: number;
  agent_id: string | null;
  model: string;
  purpose: string;
  request: unknown;
  response: unknown;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  duration_ms: number | null;
  cost: number | null;
  error: string | null;
  created_at: string;
}

// cor fixa por agente (paleta categórica validada no fundo escuro); a ordem é a do empilhamento
const AGENT_ORDER = ["gm", "npc", "chronicler", "scriptwriter", "decider", "image", "voice"];
const COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9"];
const colorOf = (id: string | null) => COLORS[AGENT_ORDER.indexOf(id ?? "")] ?? "#898781";
const rank = (id: string | null) => { const i = AGENT_ORDER.indexOf(id ?? ""); return i < 0 ? 99 : i; };

const RANGES = [["24h", "24 h"], ["7d", "7 dias"], ["30d", "30 dias"], ["all", "Tudo"], ["custom", "Personalizado"]];
const usd = (n: number | null) => (n == null ? "-" : `$${n.toFixed(n < 0.01 ? 5 : 4)}`);
const fmtInt = (n: number) => Math.round(n).toLocaleString("pt-BR");
const secs = (ms: number | null) => (ms ? `${(ms / 1000).toFixed(1)}s` : "-");
const when = (s: string | null) => (s ? new Date(s).toLocaleString("pt-BR") : "-");
const ddmm = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const num: React.CSSProperties = { textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
const scroll: React.CSSProperties = { overflowX: "auto", maxWidth: "100%" };

export default function UsagePage() {
  // useSearchParams exige Suspense no App Router
  return <Suspense><Usage /></Suspense>;
}

function Usage() {
  const sp = useSearchParams();
  const router = useRouter();
  const qs = sp.toString();
  const fp = new URLSearchParams(qs);
  fp.delete("page");
  fp.delete("size");
  const filterQs = fp.toString();

  const [summary, setSummary] = useState<Summary | null>(null);
  const [logs, setLogs] = useState<{ rows: LogRow[]; total: number; page: number; pageSize: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [metric, setMetric] = useState<"cost" | "calls">("cost");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/usage/summary?${filterQs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Erro ${r.status}`))))
      .then((d) => alive && (setSummary(d), setError("")))
      .catch((e) => alive && setError(String(e.message || e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [filterQs]);

  useEffect(() => {
    let alive = true;
    fetch(`/api/usage/logs?${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && d && setLogs(d));
    return () => { alive = false; };
  }, [qs]);

  // filtros vivem na URL: push para dar para voltar e compartilhar
  const set = (patch: Record<string, string | null>, keepPage = false) => {
    const p = new URLSearchParams(qs);
    for (const [k, v] of Object.entries(patch)) (v ? p.set(k, v) : p.delete(k));
    if (!keepPage) p.delete("page");
    const s = p.toString();
    router.push(s ? `/usage?${s}` : "/usage", { scroll: false });
  };

  const selected = (sp.get("agent") || "").split(",").filter(Boolean);
  const from = sp.get("from") || "";
  const to = sp.get("to") || "";
  const range = from || to ? "custom" : sp.get("range") || "30d";
  const opts = summary?.options;
  const agentName = (id: string | null) => opts?.agents.find((a) => a.id === id)?.name ?? id ?? "(sem agente)";
  const agentList = [...(opts?.agents ?? [])].sort((a, b) => rank(a.id) - rank(b.id));
  const toggleAgent = (id: string) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    set({ agent: next.length ? next.join(",") : null });
  };

  const t = summary?.totals;
  const pages = logs ? Math.max(Math.ceil(logs.total / logs.pageSize), 1) : 1;
  const page = logs?.page ?? 1;

  return (
    <div className="container">
      <h1>Custos e uso</h1>
      <p className="muted">Todas as chamadas de IA ao OpenRouter, somadas no recorte dos filtros abaixo.</p>

      {/* filtros: uma faixa acima de tudo; valem para todos os números da tela */}
      <div className="card" style={{ marginBottom: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <span className="muted" style={{ marginRight: 4 }}>Agentes:</span>
          <button className={`btn small${selected.length ? " ghost" : ""}`} onClick={() => set({ agent: null })}>Todos</button>
          {agentList.map((a) => {
            const on = selected.includes(a.id);
            return (
              <button key={a.id} className={`btn small${on ? "" : " ghost"}`} aria-pressed={on} onClick={() => toggleAgent(a.id)}>
                <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: colorOf(a.id), marginRight: 6 }} />
                {a.name}
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
          <label className="field" style={{ margin: 0, flex: "1 1 140px" }}>
            <span>Período</span>
            <select value={range} onChange={(e) => set({ range: e.target.value, from: null, to: null })}>
              {RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          {range === "custom" && (["from", "to"] as const).map((k) => (
            <label key={k} className="field" style={{ margin: 0, flex: "1 1 140px" }}>
              <span>{k === "from" ? "De" : "Até"}</span>
              <input type="date" value={k === "from" ? from : to} max={summary?.today}
                onChange={(e) => set({ range: "custom", [k]: e.target.value || null })}
                style={{ width: "100%", background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "7px 10px", colorScheme: "dark" }} />
            </label>
          ))}
          <label className="field" style={{ margin: 0, flex: "1 1 160px" }}>
            <span>Campanha</span>
            <select value={sp.get("campaign") || ""} onChange={(e) => set({ campaign: e.target.value || null })}>
              <option value="">Todas</option>
              {opts?.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="field" style={{ margin: 0, flex: "1 1 200px" }}>
            <span>Modelo</span>
            <select value={sp.get("model") || ""} onChange={(e) => set({ model: e.target.value || null })}>
              <option value="">Todos</option>
              {opts?.models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-dim)", paddingBottom: 9 }}>
            <input type="checkbox" checked={sp.get("errors") === "1"} onChange={(e) => set({ errors: e.target.checked ? "1" : null })} />
            Só erros
          </label>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}
      {!summary && !error && <p className="muted">Carregando...</p>}

      {summary && t && (
        // recarregando: mantém o quadro anterior esmaecido, sem pulo de layout
        <div style={{ opacity: loading ? 0.5 : 1, transition: "opacity 0.15s" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginBottom: 14 }}>
            {[
              ["Custo total", usd(t.cost)],
              ["Custo médio por chamada", t.calls ? usd(t.cost / t.calls) : "-"],
              ["Chamadas", fmtInt(t.calls)],
              ["Erros", t.calls ? `${t.errors} (${((t.errors / t.calls) * 100).toFixed(1).replace(".", ",")}%)` : "-"],
              ["Tempo médio (sem erros)", secs(t.avg_ms)],
              ["Tokens de entrada", fmtInt(t.prompt_tokens)],
              ["Tokens de saída", fmtInt(t.completion_tokens)],
              ["Uso mais recente", when(t.last_at)],
            ].map(([label, value]) => (
              <div key={label} className="card" style={{ padding: "10px 12px" }}>
                <div className="muted" style={{ fontSize: 11.5 }}>{label}</div>
                <div style={{ fontWeight: 600, fontSize: 17, marginTop: 2 }}>{value}</div>
              </div>
            ))}
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <h3 style={{ margin: 0, flex: 1 }}>{metric === "cost" ? "Custo por dia" : "Chamadas por dia"}</h3>
              <button className={`btn small${metric === "cost" ? "" : " ghost"}`} onClick={() => setMetric("cost")}>Custo</button>
              <button className={`btn small${metric === "calls" ? "" : " ghost"}`} onClick={() => setMetric("calls")}>Chamadas</button>
            </div>
            <DailyChart summary={summary} from={from} to={to} metric={metric} agentName={agentName} />
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <h3 style={{ marginTop: 0 }}>Por agente</h3>
            <Breakdown label="Agente" total={t.cost}
              rows={summary.byAgent.map((r) => ({ ...r, key: r.agent_id ?? "-", name: agentName(r.agent_id), color: colorOf(r.agent_id) }))} />
          </div>
          <div className="card" style={{ marginBottom: 14 }}>
            <h3 style={{ marginTop: 0 }}>Por modelo</h3>
            <Breakdown label="Modelo" total={t.cost} rows={summary.byModel.map((r) => ({ ...r, key: r.model, name: r.model }))} />
          </div>
        </div>
      )}

      <div className="card">
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <h3 style={{ margin: 0, flex: 1 }}>Histórico de chamadas</h3>
          <label className="muted" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            por página
            <select value={sp.get("size") === "20" ? "20" : "10"} onChange={(e) => set({ size: e.target.value === "10" ? null : e.target.value })} style={{ width: "auto", padding: "4px 8px" }}>
              <option value="10">10</option>
              <option value="20">20</option>
            </select>
          </label>
        </div>
        {logs === null && <p className="muted">Carregando...</p>}
        {logs?.rows.length === 0 && <p className="muted">Nenhuma chamada no recorte.</p>}
        {logs && logs.rows.length > 0 && (
          <div style={scroll}>
            <table className="plain">
              <thead>
                <tr><th>Quando</th><th>Agente</th><th>Propósito</th><th>Modelo</th><th style={num}>Tokens (in/out)</th><th style={num}>Custo</th><th style={num}>Duração</th><th>Status</th></tr>
              </thead>
              <tbody>
                {logs.rows.map((l) => (
                  <Fragment key={l.id}>
                    <tr style={{ cursor: "pointer" }} tabIndex={0} aria-expanded={expanded === l.id}
                      onClick={() => setExpanded(expanded === l.id ? null : l.id)}
                      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setExpanded(expanded === l.id ? null : l.id))}>
                      <td style={{ whiteSpace: "nowrap" }}>{when(l.created_at)}</td>
                      <td style={{ whiteSpace: "nowrap" }}><Swatch color={colorOf(l.agent_id)} />{agentName(l.agent_id)}</td>
                      <td>{l.purpose}</td>
                      <td>{l.model}</td>
                      <td style={num}>{l.prompt_tokens ?? "-"} / {l.completion_tokens ?? "-"}</td>
                      <td style={num}>{usd(l.cost)}</td>
                      <td style={num}>{secs(l.duration_ms)}</td>
                      <td>{l.error ? <span className="pill err">erro</span> : <span className="pill on">ok</span>}</td>
                    </tr>
                    {expanded === l.id && (
                      <tr>
                        <td colSpan={8} style={{ maxWidth: 0 }}>
                          {l.error && <div className="error-box">{l.error}</div>}
                          <b className="muted">Request</b>
                          <pre className="log-json">{JSON.stringify(l.request, null, 2)}</pre>
                          <b className="muted">Response</b>
                          <pre className="log-json">{JSON.stringify(l.response, null, 2)}</pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {logs && logs.total > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginTop: 10 }}>
            <button className="btn small" disabled={page <= 1} onClick={() => set({ page: page > 2 ? String(page - 1) : null }, true)}>← anterior</button>
            <span className="muted">página {page} de {pages} · {fmtInt(logs.total)} chamadas</span>
            <button className="btn small" disabled={page >= pages} onClick={() => set({ page: String(page + 1) }, true)}>próxima →</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Swatch({ color }: { color: string }) {
  return <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: color, marginRight: 6 }} />;
}

function Breakdown({ label, total, rows }: { label: string; total: number; rows: (Agg & { key: string; name: string; color?: string })[] }) {
  if (!rows.length) return <p className="muted">Nenhuma chamada no recorte.</p>;
  return (
    <div style={scroll}>
      <table className="plain">
        <thead>
          <tr><th>{label}</th><th style={num}>Chamadas</th><th style={num}>Custo</th><th style={num}>% do custo</th><th style={num}>Tokens (in/out)</th><th style={num}>Tempo médio</th><th>Último uso</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td style={{ whiteSpace: "nowrap" }}>{r.color && <Swatch color={r.color} />}{r.name}</td>
              <td style={num}>{fmtInt(r.calls)}{r.errors > 0 && <span className="muted"> ({r.errors} erro{r.errors > 1 ? "s" : ""})</span>}</td>
              <td style={num}>{usd(r.cost)}</td>
              <td style={num}>{total ? `${((r.cost / total) * 100).toFixed(1).replace(".", ",")}%` : "-"}</td>
              <td style={num}>{fmtInt(r.prompt_tokens)} / {fmtInt(r.completion_tokens)}</td>
              <td style={num}>{secs(r.avg_ms)}</td>
              <td style={{ whiteSpace: "nowrap" }}>{when(r.last_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** passo "redondo" (1, 2, 5 × 10^k) para ~4 linhas de grade */
function niceStep(max: number) {
  const raw = max / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw)!;
}

/** colunas empilhadas por agente, um dia por coluna, em SVG */
function DailyChart({ summary, from, to, metric, agentName }: {
  summary: Summary; from: string; to: string; metric: "cost" | "calls"; agentName: (id: string | null) => string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const hasData = summary.byDay.length > 0; // o div do gráfico só existe quando há dados
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasData]);

  const data = summary.byDay;
  if (!hasData) return <p className="muted">Sem chamadas no período.</p>;

  // eixo: do início do período (ou do 1º dia com dados, em "tudo"/datas largas) até o fim
  const first = data[0].day;
  let start = from || summary.start || first;
  if (!summary.start && start < first) start = first;
  const end = to && to < summary.today ? to : summary.today;
  const days: string[] = [];
  for (let d = Date.parse(`${start}T00:00:00Z`); d <= Date.parse(`${end}T00:00:00Z`); d += 864e5) days.push(new Date(d).toISOString().slice(0, 10));
  // ponytail: mostra no máximo os últimos 400 dias; agrupar por semana/mês se o histórico crescer
  days.splice(0, Math.max(days.length - 400, 0));

  const agentIds = [...new Set(data.map((r) => r.agent_id))].sort((a, b) => rank(a) - rank(b));
  const byDay = new Map<string, DayRow[]>();
  for (const r of data) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  for (const rows of byDay.values()) rows.sort((a, b) => rank(a.agent_id) - rank(b.agent_id));
  const total = (rows: DayRow[] = []) => rows.reduce((s, r) => s + r[metric], 0);
  const max = Math.max(...days.map((d) => total(byDay.get(d))), metric === "calls" ? 1 : 1e-6);
  const step = metric === "calls" ? Math.max(1, Math.ceil(niceStep(max))) : niceStep(max);
  const top = Math.ceil(max / step) * step;
  const decimals = metric === "cost" ? Math.max(0, -Math.floor(Math.log10(step))) : 0;
  const fmt = (v: number) => (metric === "cost" ? `$${v.toFixed(decimals)}` : fmtInt(v));
  const fmtFull = (v: number) => (metric === "cost" ? usd(v) : fmtInt(v));

  const H = 220, ml = 8 + fmt(top).length * 6.5, mb = 22, mt = 8, mr = 4;
  const pw = Math.max(W - ml - mr, 10), ph = H - mt - mb;
  const band = pw / days.length;
  const bw = Math.max(Math.min(24, band * 0.7), 1);
  const y = (v: number) => mt + ph - (v / top) * ph;
  const every = Math.max(1, Math.ceil((days.length * 40) / pw));
  const hd = hover == null ? null : days[hover];

  return (
    <>
      {/* legenda: identidade nunca só pela cor no gráfico */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", marginBottom: 6, fontSize: 12.5, color: "var(--text-dim)" }}>
        {agentIds.map((id) => <span key={id ?? "-"}><Swatch color={colorOf(id)} />{agentName(id)}</span>)}
      </div>
      <div ref={box} style={{ position: "relative", width: "100%" }} onPointerLeave={() => setHover(null)}>
        {W > 0 && (
          <svg width={W} height={H} role="img" aria-label={`${metric === "cost" ? "Custo" : "Chamadas"} por dia, empilhado por agente`} style={{ display: "block" }}>
            {Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step).map((v) => (
              <g key={v}>
                <line x1={ml} x2={W - mr} y1={y(v)} y2={y(v)} stroke={v === 0 ? "#3a3a4a" : "var(--border)"} strokeWidth={1} shapeRendering="crispEdges" />
                <text x={ml - 6} y={y(v) + 4} textAnchor="end" fontSize={11} fill="var(--text-dim)" style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(v)}</text>
              </g>
            ))}
            {days.map((d, i) => {
              const cx = ml + band * i + band / 2;
              const rows = (byDay.get(d) ?? []).filter((r) => r[metric] > 0);
              let acc = 0;
              return (
                <g key={d} tabIndex={0} aria-label={`${ddmm(d)}: ${fmtFull(total(rows))}`} style={{ outline: "none" }}
                  onPointerEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
                  {/* alvo do hover: a faixa inteira do dia, maior que a coluna */}
                  <rect x={ml + band * i} y={mt} width={band} height={ph} fill={hover === i ? "rgba(255,255,255,0.04)" : "transparent"} />
                  {rows.map((r, k) => {
                    const y0 = y(acc), y1 = y((acc += r[metric]));
                    const isTop = k === rows.length - 1;
                    const h = Math.max(y0 - y1 - (isTop ? 0 : 2), 0); // 2px de fundo entre segmentos
                    if (h <= 0) return null;
                    const x = cx - bw / 2, rr = isTop ? Math.min(4, h, bw / 2) : 0;
                    // topo arredondado só no último segmento; base reta
                    const dPath = `M${x},${y1 + h} V${y1 + rr} Q${x},${y1} ${x + rr},${y1} H${x + bw - rr} Q${x + bw},${y1} ${x + bw},${y1 + rr} V${y1 + h} Z`;
                    return <path key={r.agent_id ?? "-"} d={dPath} fill={colorOf(r.agent_id)} />;
                  })}
                  {i % every === 0 && (
                    <text x={cx} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--text-dim)">{ddmm(d)}</text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
        {hd && hover != null && (
          <div role="tooltip" style={{
            position: "absolute", top: 0, pointerEvents: "none", zIndex: 5,
            left: Math.min(Math.max(ml + band * hover + band / 2, 90), W - 90), transform: "translateX(-50%)",
            background: "var(--bg-raise)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px",
            fontSize: 12.5, minWidth: 160, boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
          }}>
            <div className="muted" style={{ marginBottom: 4 }}>{new Date(`${hd}T12:00:00Z`).toLocaleDateString("pt-BR")} · total <b style={{ color: "var(--text)" }}>{fmtFull(total(byDay.get(hd)))}</b></div>
            {(byDay.get(hd) ?? []).map((r) => (
              <div key={r.agent_id ?? "-"} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 10, height: 2, background: colorOf(r.agent_id), flexShrink: 0 }} />
                <b style={{ fontVariantNumeric: "tabular-nums" }}>{fmtFull(r[metric])}</b>
                <span className="muted">{agentName(r.agent_id)}</span>
              </div>
            ))}
            {!byDay.get(hd) && <div className="muted">Sem chamadas</div>}
          </div>
        )}
      </div>
      <details style={{ marginTop: 8 }}>
        <summary className="muted" style={{ cursor: "pointer" }}>Ver como tabela</summary>
        <div style={scroll}>
          <table className="plain">
            <thead><tr><th>Dia</th><th style={num}>Chamadas</th><th style={num}>Custo</th></tr></thead>
            <tbody>
              {days.filter((d) => byDay.has(d)).map((d) => {
                const rows = byDay.get(d)!;
                return <tr key={d}><td>{ddmm(d)}</td><td style={num}>{fmtInt(rows.reduce((s, r) => s + r.calls, 0))}</td><td style={num}>{usd(rows.reduce((s, r) => s + r.cost, 0))}</td></tr>;
              })}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
