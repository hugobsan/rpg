"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Skeleton from "@/components/ui/Skeleton";
import Loader from "@/components/ui/Loader";
import type { Agg, DayRow, LogPage, Summary } from "./data";
import s from "./usage.module.css";

// cor fixa por agente (paleta categórica validada no fundo escuro: scripts/validate_palette da skill dataviz);
// a ordem é a do empilhamento e não muda com os filtros
const AGENT_ORDER = ["gm", "npc", "chronicler", "scriptwriter", "director", "decider", "image", "voice", "pixel", "scribe", "interpreter", "characters", "abilities", "items", "adventure", "suggest", "referee"];
// 7 cores da paleta + 1 extra para o Pixel artista (aposentado; fica pelo histórico de custo, como Cronista, Árbitro e Ações
// rápidas) + 1 do Anotador + 1 do Intérprete;
// os criadores grátis ficam no cinza de "outros"
const COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#a8875c", "#7fb3a0", "#22b0c8"];
const colorOf = (id: string | null) => COLORS[AGENT_ORDER.indexOf(id ?? "")] ?? "#898781";
const rank = (id: string | null) => { const i = AGENT_ORDER.indexOf(id ?? ""); return i < 0 ? 99 : i; };

const RANGES = [["24h", "24 h"], ["7d", "7 dias"], ["30d", "30 dias"], ["all", "Tudo"], ["custom", "Personalizado"]];
const usd = (n: number | null) => (n == null ? "-" : `$${n.toFixed(n < 0.01 ? 5 : 4)}`);
const fmtInt = (n: number) => Math.round(n).toLocaleString("pt-BR");
const compact = (n: number) => n.toLocaleString("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
const secs = (ms: number | null) => (ms ? `${(ms / 1000).toFixed(1).replace(".", ",")} s` : "-");
// fuso fixo (o mesmo das consultas): o HTML do servidor e o navegador mostram a mesma hora
const when = (s: string | null) => (s ? new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "-");
const ddmm = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const pct = (a: number, b: number) => `${((a / b) * 100).toFixed(1).replace(".", ",")}%`;
// % dos tokens de entrada lidos do cache, só nas chamadas que informam o cache
const cachePct = (r: { cached: number; cache_base: number }) => (r.cache_base ? pct(r.cached, r.cache_base) : "-");
// cobrado = tudo menos o estimado da assinatura ChatGPT (gasta a cota, não é cobrado)
const billed = (r: { cost: number; sub_cost: number }) => r.cost - r.sub_cost;
const SUB_HINT = "Estimado pelo preço do OpenRouter: assinatura ChatGPT, gasta a cota e não é cobrado";
const num: React.CSSProperties = { textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };

/** tira paginação e ordenação: o que sobra são os filtros, que valem para o resumo */
function filterQuery(qs: string) {
  const fp = new URLSearchParams(qs);
  for (const k of ["page", "size", "sort", "dir"]) fp.delete(k);
  return fp.toString();
}

export default function UsageClient({ initial }: { initial: { qs: string; summary: Summary; logs: LogPage } }) {
  const sp = useSearchParams();
  const qs = sp.toString();
  const filterQs = filterQuery(qs);

  // a 1ª carga veio do servidor; os refs guardam de qual recorte são os dados na tela
  const [summary, setSummary] = useState<Summary>(initial.summary);
  const [logs, setLogs] = useState<LogPage>(initial.logs);
  const shown = useRef({ f: filterQuery(initial.qs), q: initial.qs });
  const [loading, setLoading] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [details, setDetails] = useState<Record<number, { request: unknown; response: unknown } | "erro">>({});
  const [metric, setMetric] = useState<"cost" | "calls">("cost");
  const [refreshing, setRefreshing] = useState(false);
  // hora da última busca (só no cliente: a hora do servidor no HTML não bateria na hidratação)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  useEffect(() => setUpdatedAt(new Date()), []);

  // botão Atualizar: busca de novo o mesmo recorte (painel e histórico)
  const refresh = async () => {
    setRefreshing(true);
    try {
      const [sum, lg] = await Promise.all([
        fetch(`/api/usage/summary?${filterQs}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Erro ${r.status}`)))),
        fetch(`/api/usage/logs?${qs}`).then((r) => (r.ok ? r.json() : null)),
      ]);
      setSummary(sum);
      if (lg) setLogs(lg);
      setError("");
      setUpdatedAt(new Date());
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (filterQs === shown.current.f) return;
    let alive = true;
    setLoading(true);
    fetch(`/api/usage/summary?${filterQs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Erro ${r.status}`))))
      .then((d) => alive && (setSummary(d), setError(""), setUpdatedAt(new Date()), (shown.current.f = filterQs)))
      .catch((e) => alive && setError(String(e.message || e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [filterQs]);

  useEffect(() => {
    if (qs === shown.current.q) return;
    let alive = true;
    setLogsLoading(true);
    fetch(`/api/usage/logs?${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && d && (setLogs(d), (shown.current.q = qs)))
      .finally(() => alive && setLogsLoading(false));
    return () => { alive = false; };
  }, [qs]);

  // request/response só ao abrir a linha (a lista vem sem eles: ~3 KB em vez de ~80 KB)
  const toggleRow = (id: number) => {
    const open = expanded === id ? null : id;
    setExpanded(open);
    if (open != null && !details[open])
      fetch(`/api/usage/logs/${open}`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => setDetails((m) => ({ ...m, [open]: d })))
        .catch(() => setDetails((m) => ({ ...m, [open]: "erro" })));
  };

  // filtros vivem na URL: pushState nativo (o Next sincroniza o useSearchParams) dá para voltar e
  // compartilhar sem refazer a página no servidor; os efeitos acima buscam o recorte novo
  const set = (patch: Record<string, string | null>, keepPage = false) => {
    const p = new URLSearchParams(qs);
    for (const [k, v] of Object.entries(patch)) (v ? p.set(k, v) : p.delete(k));
    if (!keepPage) p.delete("page");
    const next = p.toString();
    window.history.pushState(null, "", next ? `/usage?${next}` : "/usage");
  };

  const selected = (sp.get("agent") || "").split(",").filter(Boolean);
  const from = sp.get("from") || "";
  const to = sp.get("to") || "";
  const range = from || to ? "custom" : sp.get("range") || "30d";
  const opts = summary.options;
  const agentName = (id: string | null) => opts.agents.find((a) => a.id === id)?.name ?? id ?? "(sem agente)";
  const srcName = (id: string) => opts.providers.find((p) => p.id === id)?.name ?? id;
  const isSub = (id: string) => !!opts.providers.find((p) => p.id === id)?.sub;
  const agentList = [...opts.agents].sort((a, b) => rank(a.id) - rank(b.id));
  const toggleAgent = (id: string) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    set({ agent: next.length ? next.join(",") : null });
  };

  const t = summary.totals;
  const pages = Math.max(Math.ceil(logs.total / logs.pageSize), 1);
  const page = logs.page;
  // ordenação do histórico: no servidor (é paginado) e na URL; padrão = mais recentes primeiro
  const logSort: Sort = { key: sp.get("sort") || "when", dir: sp.get("dir") === "asc" ? "asc" : "desc" };
  const sortLogs = (key: string, dir: Dir) => set({ sort: key === "when" ? null : key, dir: key === "when" && dir === "desc" ? null : dir });
  const tb = billed(t);
  const shares = [...summary.byAgent].filter((r) => billed(r) > 0).sort((a, b) => rank(a.agent_id) - rank(b.agent_id));

  return (
    <>
      <div className={s.toolbar}>
        <span className={s.updated} aria-live="polite">
          {updatedAt && <>Atualizado às <b className="num">{updatedAt.toLocaleTimeString("pt-BR")}</b></>}
        </span>
        <button className="btn ghost small" onClick={refresh} disabled={refreshing} title="Buscar as chamadas mais recentes">
          {refreshing ? <Loader size={14} label="Atualizando" /> : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4" />
            </svg>
          )}
          Atualizar
        </button>
      </div>
      <div className={`card ${s.filters}`}>
        <div className={s.chips}>
          <span className={s.label}>Agentes</span>
          <button className={`pill filter-pill${selected.length ? "" : " on"}`} aria-pressed={!selected.length} onClick={() => set({ agent: null })}>Todos</button>
          {agentList.map((a) => {
            const on = selected.includes(a.id);
            return (
              <button key={a.id} className={`pill filter-pill${on ? " on" : ""}`} aria-pressed={on} onClick={() => toggleAgent(a.id)}>
                <Swatch color={colorOf(a.id)} />{a.name}
              </button>
            );
          })}
        </div>
        <div className={s.fields}>
          <label className="field">
            <span>Período</span>
            <select value={range} onChange={(e) => set({ range: e.target.value, from: null, to: null })}>
              {RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          {range === "custom" && (["from", "to"] as const).map((k) => (
            <label key={k} className="field">
              <span>{k === "from" ? "De" : "Até"}</span>
              <input type="date" className={s.date} value={k === "from" ? from : to} max={summary.today}
                onChange={(e) => set({ range: "custom", [k]: e.target.value || null })} />
            </label>
          ))}
          <label className="field">
            <span>Campanha</span>
            <select value={sp.get("campaign") || ""} onChange={(e) => set({ campaign: e.target.value || null })}>
              <option value="">Todas</option>
              {opts.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="field" style={{ flexBasis: 200 }}>
            <span>Modelo</span>
            <select value={sp.get("model") || ""} onChange={(e) => set({ model: e.target.value || null })}>
              <option value="">Todos</option>
              {opts.models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Fonte</span>
            <select value={sp.get("provider") || ""} onChange={(e) => set({ provider: e.target.value || null })}>
              <option value="">Todas</option>
              {opts.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className={s.only}>
            <input type="checkbox" checked={sp.get("errors") === "1"} onChange={(e) => set({ errors: e.target.checked ? "1" : null })} />
            Só erros
          </label>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      {/* recarregando: mantém o quadro anterior esmaecido, sem pulo de layout */}
      <div className={`${s.board} ${loading ? s.stale : ""}`} aria-busy={loading}>
        <div className={s.kpis}>
          <div className={`card ${s.tile} ${s.hero}`}>
            <span className={s.tileLabel}>Custo cobrado</span>
            <span className={s.tileValue} title={usd(tb)}>${tb.toFixed(2)}</span>
            {t.sub_cost > 0 && <span className={s.tileSub} title={SUB_HINT}>+ ≈ ${t.sub_cost.toFixed(2)} na assinatura ChatGPT (estimado, não cobrado)</span>}
            {shares.length > 0 && (
              <>
                <div className={s.share} role="img" aria-label={`Custo cobrado por agente: ${shares.map((r) => `${agentName(r.agent_id)} ${pct(billed(r), tb)}`).join(", ")}`}>
                  {shares.map((r) => (
                    <span key={r.agent_id ?? "-"} title={`${agentName(r.agent_id)}: ${usd(billed(r))} (${pct(billed(r), tb)})`}
                      style={{ flex: `${(billed(r) / tb) * 1000} 1 0`, background: colorOf(r.agent_id) }} />
                  ))}
                </div>
                <div className={s.shareLegend}>
                  {shares.map((r) => <span key={r.agent_id ?? "-"}><Swatch color={colorOf(r.agent_id)} />{agentName(r.agent_id)}</span>)}
                </div>
              </>
            )}
          </div>
          <Tile label="Chamadas" value={fmtInt(t.calls)} sub={t.calls ? `${usd(t.cost / t.calls)} por chamada${t.sub_cost ? " (com o estimado)" : ""}` : undefined} />
          <Tile label="Tempo médio" value={secs(t.avg_ms)} sub="sem contar erros" />
          <Tile label="Erros" value={fmtInt(t.errors)} sub={t.calls ? `${pct(t.errors, t.calls)} das chamadas` : undefined} danger={t.errors > 0} />
          <Tile label="Tokens" value={compact(t.prompt_tokens + t.completion_tokens)} sub={`${compact(t.prompt_tokens)} entrada · ${compact(t.completion_tokens)} saída`} />
          <Tile label="Cache" value={cachePct(t)} sub={t.cache_base ? `${compact(t.cached)} de ${compact(t.cache_base)} tokens de entrada` : "nenhuma chamada informa o cache"} />
        </div>
        <p className={s.facts}>Uso mais recente: <b>{when(t.last_at)}</b></p>

        <section className={`card ${s.panel}`}>
          <div className={s.panelHead}>
            <h2>{metric === "cost" ? "Custo cobrado por dia" : "Chamadas por dia"}</h2>
            <button className={`pill filter-pill${metric === "cost" ? " on" : ""}`} aria-pressed={metric === "cost"} onClick={() => setMetric("cost")}>Custo</button>
            <button className={`pill filter-pill${metric === "calls" ? " on" : ""}`} aria-pressed={metric === "calls"} onClick={() => setMetric("calls")}>Chamadas</button>
          </div>
          <DailyChart summary={summary} from={from} to={to} metric={metric} agentName={agentName} />
        </section>

        <section className={`card ${s.panel}`}>
          <div className={s.panelHead}><h2>Por agente</h2></div>
          <Breakdown label="Agente" total={tb}
            rows={summary.byAgent.map((r) => ({ ...r, key: r.agent_id ?? "-", name: agentName(r.agent_id), color: colorOf(r.agent_id) }))} />
        </section>
        <section className={`card ${s.panel}`}>
          <div className={s.panelHead}><h2>Por modelo</h2></div>
          <Breakdown label="Modelo" total={tb} rows={summary.byModel.map((r) => ({ ...r, key: `${r.provider}:${r.model}`, name: r.provider === "openrouter" ? r.model : `${r.model} (${srcName(r.provider)})` }))} />
        </section>
      </div>

      <section className={`card ${s.panel}`}>
        <div className={s.panelHead}>
          <h2>Histórico de chamadas</h2>
          <label className="muted" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            por página
            <select value={sp.get("size") === "20" ? "20" : "10"} onChange={(e) => set({ size: e.target.value === "10" ? null : e.target.value })} style={{ width: "auto", padding: "4px 8px" }}>
              <option value="10">10</option>
              <option value="20">20</option>
            </select>
          </label>
        </div>
        {logs.rows.length === 0 && <p className={s.empty}>Nenhuma chamada no recorte.</p>}
        {logs.rows.length > 0 && (
          <div className={`${s.scroll} ${s.board} ${logsLoading ? s.stale : ""}`} aria-busy={logsLoading}>
            <table className="plain">
              <thead>
                <tr>
                  {LOG_COLS.map(([key, label, right]) => (
                    <SortTh key={key} col={key} label={label} right={right} sort={logSort} onSort={sortLogs} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {logs.rows.map((l) => {
                  const d = details[l.id];
                  return (
                    <Fragment key={l.id}>
                      <tr className={s.row} tabIndex={0} aria-expanded={expanded === l.id}
                        onClick={() => toggleRow(l.id)}
                        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggleRow(l.id))}>
                        <td style={{ whiteSpace: "nowrap" }}>{when(l.created_at)}</td>
                        <td style={{ whiteSpace: "nowrap" }}><Swatch color={colorOf(l.agent_id)} />{agentName(l.agent_id)}</td>
                        <td>{l.purpose}</td>
                        <td>{l.model}{l.provider !== "openrouter" && <> <span className="pill">{srcName(l.provider)}</span></>}</td>
                        <td style={num}>{l.prompt_tokens ?? "-"} / {l.completion_tokens ?? "-"}</td>
                        {/* fora do OpenRouter, custo só existe estimado pelo catálogo (opção do agente); na assinatura nem é cobrado */}
                        <td style={num} className={isSub(l.provider) ? "muted" : undefined}
                          title={l.provider !== "openrouter" && l.cost != null ? (isSub(l.provider) ? SUB_HINT : "Estimado pelo preço do OpenRouter") : undefined}>
                          {l.provider !== "openrouter" && l.cost != null && "≈ "}{usd(l.cost)}
                        </td>
                        <td style={num}>{secs(l.duration_ms)}</td>
                        <td>{l.error ? <span className="pill err">erro</span> : <span className="pill on">ok</span>}</td>
                      </tr>
                      {expanded === l.id && (
                        <tr className={s.detail}>
                          <td colSpan={8} style={{ maxWidth: 0 }}>
                            {l.error && <div className="error-box">{l.error}</div>}
                            {!d && <div aria-busy="true"><Skeleton lines={4} /></div>}
                            {d === "erro" && <div className="error-box">Não foi possível carregar o request e a resposta.</div>}
                            {d && d !== "erro" && (
                              <>
                                <b>Request</b>
                                <pre className="log-json">{JSON.stringify(d.request, null, 2)}</pre>
                                <b>Response</b>
                                <pre className="log-json">{JSON.stringify(d.response, null, 2)}</pre>
                              </>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {logs.total > 0 && (
          <div className={s.pager}>
            <button className="btn small" disabled={page <= 1} onClick={() => set({ page: page > 2 ? String(page - 1) : null }, true)}>← anterior</button>
            <span className="muted">página {page} de {pages} · {fmtInt(logs.total)} chamadas</span>
            <button className="btn small" disabled={page >= pages} onClick={() => set({ page: String(page + 1) }, true)}>próxima →</button>
          </div>
        )}
      </section>
    </>
  );
}

function Tile({ label, value, sub, danger }: { label: string; value: string; sub?: string; danger?: boolean }) {
  return (
    <div className={`card ${s.tile}`}>
      <span className={s.tileLabel}>{label}</span>
      <span className={`${s.tileValue} ${danger ? s.errOn : ""}`}>{value}</span>
      {sub && <span className={s.tileSub}>{sub}</span>}
    </div>
  );
}

function Swatch({ color }: { color: string }) {
  return <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: color, marginRight: 6, flexShrink: 0 }} />;
}

type Dir = "asc" | "desc";
interface Sort { key: string; dir: Dir }
// colunas do histórico: chave (a mesma da whitelist da rota), título, alinhada à direita
const LOG_COLS: [string, string, boolean][] = [
  ["when", "Quando", false], ["agent", "Agente", false], ["purpose", "Propósito", false], ["model", "Modelo", false],
  ["tokens", "Tokens (in/out)", true], ["cost", "Custo", true], ["duration", "Duração", true], ["status", "Status", false],
];

/** cabeçalho clicável: 1º clique ordena (texto ▲, número ▼), o seguinte inverte */
function SortTh({ col, label, right, sort, onSort }: { col: string; label: string; right?: boolean; sort: Sort; onSort: (key: string, dir: Dir) => void }) {
  const active = sort.key === col;
  const first: Dir = right || col === "when" || col === "last_at" ? "desc" : "asc";
  return (
    <th style={right ? num : undefined} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button className={`${s.sortBtn} ${active ? s.sortOn : ""}`} onClick={() => onSort(col, active ? (sort.dir === "asc" ? "desc" : "asc") : first)}>
        {label}{active ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );
}

type BRow = Agg & { key: string; name: string; color?: string };
// valor de cada coluna das quebras para ordenar no cliente (% do custo segue o custo)
const B_VAL: Record<string, (r: BRow) => number | string> = {
  name: (r) => r.name.toLowerCase(), calls: (r) => r.calls, cost: billed, pct: (r) => billed(r),
  cache: (r) => (r.cache_base ? r.cached / r.cache_base : -1),
  tokens: (r) => r.prompt_tokens + r.completion_tokens, avg_ms: (r) => r.avg_ms ?? -1, last_at: (r) => r.last_at ?? "",
};

function Breakdown({ label, total, rows: raw }: { label: string; total: number; rows: BRow[] }) {
  const [sort, setSort] = useState<Sort>({ key: "cost", dir: "desc" }); // padrão = ordem da API
  const v = B_VAL[sort.key];
  const rows = [...raw].sort((a, b) => (v(a) < v(b) ? -1 : v(a) > v(b) ? 1 : 0) * (sort.dir === "asc" ? 1 : -1));
  const th = (col: string, text: string, right = true) => (
    <SortTh col={col} label={text} right={right} sort={sort} onSort={(key, dir) => setSort({ key, dir })} />
  );
  if (!rows.length) return <p className={s.empty}>Nenhuma chamada no recorte.</p>;
  return (
    <div className={s.scroll}>
      <table className="plain">
        <thead>
          <tr>
            {th("name", label, false)}{th("calls", "Chamadas")}{th("cost", "Custo cobrado")}{th("pct", "% do cobrado")}
            {th("tokens", "Tokens (in/out)")}{th("cache", "Cache")}{th("avg_ms", "Tempo médio")}{th("last_at", "Último uso", false)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td style={{ whiteSpace: "nowrap" }}>{r.color && <Swatch color={r.color} />}{r.name}</td>
              <td style={num}>{fmtInt(r.calls)}{r.errors > 0 && <span className="muted"> ({r.errors} erro{r.errors > 1 ? "s" : ""})</span>}</td>
              <td style={num}>
                {(billed(r) > 0 || !r.sub_cost) && usd(billed(r))}
                {r.sub_cost > 0 && <span className="muted" title={SUB_HINT}>{billed(r) > 0 && " + "}≈ {usd(r.sub_cost)} assinatura</span>}
              </td>
              <td style={num}>{total ? pct(billed(r), total) : "-"}</td>
              <td style={num}>{fmtInt(r.prompt_tokens)} / {fmtInt(r.completion_tokens)}</td>
              <td style={num}>{cachePct(r)}</td>
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
  return [1, 2, 5, 10].map((m) => m * p).find((x) => x >= raw)!;
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
  if (!hasData) return <p className={s.empty}>Sem chamadas no período.</p>;

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
  const val = (r: DayRow) => (metric === "cost" ? billed(r) : r.calls);
  const total = (rows: DayRow[] = []) => rows.reduce((sum, r) => sum + val(r), 0);
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
      <div className={s.legend}>
        {agentIds.map((id) => <span key={id ?? "-"}><Swatch color={colorOf(id)} />{agentName(id)}</span>)}
      </div>
      <div ref={box} style={{ position: "relative", width: "100%" }} onPointerLeave={() => setHover(null)}>
        {W > 0 ? (
          <svg width={W} height={H} role="img" aria-label={`${metric === "cost" ? "Custo" : "Chamadas"} por dia, empilhado por agente`} style={{ display: "block" }}>
            {Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step).map((v) => (
              <g key={v}>
                <line x1={ml} x2={W - mr} y1={y(v)} y2={y(v)} stroke={v === 0 ? "var(--border-strong)" : "var(--border)"} strokeWidth={1} shapeRendering="crispEdges" />
                <text x={ml - 6} y={y(v) + 4} textAnchor="end" fontSize={11} fill="var(--text-dim)" style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(v)}</text>
              </g>
            ))}
            {days.map((d, i) => {
              const cx = ml + band * i + band / 2;
              const rows = (byDay.get(d) ?? []).filter((r) => val(r) > 0);
              let acc = 0;
              return (
                <g key={d} tabIndex={0} aria-label={`${ddmm(d)}: ${fmtFull(total(rows))}`} style={{ outline: "none" }}
                  onPointerEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
                  {/* alvo do hover: a faixa inteira do dia, maior que a coluna */}
                  <rect x={ml + band * i} y={mt} width={band} height={ph} fill={hover === i ? "color-mix(in srgb, var(--text) 5%, transparent)" : "transparent"} />
                  {rows.map((r, k) => {
                    const y0 = y(acc), y1 = y((acc += val(r)));
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
        ) : (
          <Skeleton h={H} />
        )}
        {hd && hover != null && (
          <div role="tooltip" className={s.tooltip} style={{ left: Math.min(Math.max(ml + band * hover + band / 2, 90), W - 90) }}>
            <div className="muted" style={{ marginBottom: 4 }}>{new Date(`${hd}T12:00:00Z`).toLocaleDateString("pt-BR")} · total <b style={{ color: "var(--text)" }}>{fmtFull(total(byDay.get(hd)))}</b></div>
            {(byDay.get(hd) ?? []).map((r) => (
              <div key={r.agent_id ?? "-"} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 10, height: 2, background: colorOf(r.agent_id), flexShrink: 0 }} />
                <b style={{ fontVariantNumeric: "tabular-nums" }}>{fmtFull(val(r))}</b>
                <span className="muted">{agentName(r.agent_id)}</span>
              </div>
            ))}
            {!byDay.get(hd) && <div className="muted">Sem chamadas</div>}
          </div>
        )}
      </div>
      <details className={s.tableToggle}>
        <summary>Ver como tabela</summary>
        <div className={s.scroll}>
          <table className="plain">
            <thead><tr><th>Dia</th><th style={num}>Chamadas</th><th style={num}>Cobrado</th><th style={num} title={SUB_HINT}>≈ Assinatura</th><th style={num}>Cache</th></tr></thead>
            <tbody>
              {days.filter((d) => byDay.has(d)).map((d) => {
                const rows = byDay.get(d)!;
                const sum = (f: (r: DayRow) => number) => rows.reduce((a, r) => a + f(r), 0);
                return (
                  <tr key={d}>
                    <td>{ddmm(d)}</td><td style={num}>{fmtInt(sum((r) => r.calls))}</td><td style={num}>{usd(sum(billed))}</td>
                    <td style={num} className="muted">{sum((r) => r.sub_cost) ? usd(sum((r) => r.sub_cost)) : "-"}</td>
                    <td style={num}>{cachePct({ cached: sum((r) => r.cached), cache_base: sum((r) => r.cache_base) })}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
