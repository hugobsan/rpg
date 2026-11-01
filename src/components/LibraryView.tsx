"use client";
import { useEffect, useState, type FormEvent } from "react";
import type { Job, LibraryAbility, LibraryEntry, LibraryItem, LibraryKind, Ruleset } from "@/lib/types";
import Icon from "./game/Icon";
import Loader from "./ui/Loader";
import Skeleton from "./ui/Skeleton";
import SearchBox, { fold } from "./ui/SearchBox";
import { toast } from "./ui/Toast";
import { abilityCost } from "@/lib/ruleset";
import p from "./SidePanels.module.css";
import a from "./AbilitiesView.module.css";
import s from "./LibraryView.module.css";

type Lib = Record<LibraryKind, LibraryEntry[]>;
type Data = LibraryAbility & LibraryItem;
const NO_ELEMENT = "sem elemento";

/**
 * Aba Biblioteca: técnicas e itens do mundo (cânone ou originais) que o Mestre e o Criador de
 * personagens usam. Busca, filtros, detalhe, tirar da biblioteca (some só daqui; as fichas continuam) e "Gerar em segundo plano" (Criador de habilidades/itens).
 */
export default function LibraryView({ campaignId, ruleset, jobs, onChange }: {
  campaignId: string;
  ruleset: Ruleset;
  jobs: Job[]; // tarefas da campanha: relê a lista enquanto um lote avança
  onChange: () => void; // relê a campanha (o cabeçalho passa a acompanhar a tarefa nova)
}) {
  const label = ruleset.abilitiesLabel || "Habilidades";
  const [kind, setKind] = useState<LibraryKind>("ability");
  const [lib, setLib] = useState<Lib | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [type, setType] = useState<string | null>(null);
  const [rank, setRank] = useState<string | null>(null);
  const [element, setElement] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [count, setCount] = useState(10);
  const [focus, setFocus] = useState("");
  const [canon, setCanon] = useState(ruleset.canonBased);
  const [sending, setSending] = useState(false);
  const [genError, setGenError] = useState("");

  const libJobs = jobs.filter((j) => j.kind === "library");
  const jobsKey = libJobs.map((j) => `${j.id}:${j.status}:${j.progress?.done ?? 0}`).join();
  useEffect(() => {
    let alive = true;
    fetch(`/api/campaigns/${campaignId}/library`)
      .then((r) => (r.ok ? (r.json() as Promise<Lib>) : Promise.reject(new Error(`Erro ${r.status}`))))
      .then((d) => alive && (setLib(d), setError("")))
      .catch((e: Error) => alive && setError(`Não deu para abrir a biblioteca (${e.message}).`));
    return () => {
      alive = false;
    };
  }, [campaignId, jobsKey]);

  const pick = (k: LibraryKind) => {
    setKind(k);
    setType(null);
    setRank(null);
    setElement(null);
    setConfirming(null);
    setGenError("");
  };
  const entries = lib?.[kind] ?? [];
  const typeOf = (e: LibraryEntry) => ((kind === "ability" ? (e.data as Data).type : (e.data as Data).category) ?? "");
  const typeLabel = (k: string) => (kind === "ability" ? ruleset.abilityTypes.find((t) => t.key === k)?.label ?? k : k);
  const order = (k: string) => (kind === "ability" ? ruleset.abilityTypes.findIndex((t) => t.key === k) : 0);
  const typeOpts = [...new Set(entries.map(typeOf).filter(Boolean))].sort((x, y) => order(x) - order(y) || x.localeCompare(y));
  const rankOpts = ruleset.abilityRanks.filter((r) => entries.some((e) => e.data.rank === r));
  // elemento (Naruto: natureza do chakra), só nas habilidades e se o mundo define elementos
  const elements = kind === "ability" ? ruleset.abilityElements ?? [] : [];
  const elOf = (e: LibraryEntry) => (e.data as Data).element || NO_ELEMENT;
  const elOpts = elements.length ? [...elements.map((x) => x.key), NO_ELEMENT].filter((k) => entries.some((e) => elOf(e) === k)) : [];
  const elLabel = (k: string) => elements.find((x) => x.key === k)?.label || k;
  const qf = fold(query.trim());
  const shown = entries.filter((e) => {
    const d = e.data as Data;
    return (!type || typeOf(e) === type) && (!rank || d.rank === rank) && (!element || elOf(e) === element) &&
      (!qf || fold(`${e.name} ${d.translation ?? ""} ${d.description ?? ""} ${d.effect ?? ""} ${d.users ?? ""}`).includes(qf));
  });
  const running = libJobs.filter((j) => j.status === "running" && j.target?.startsWith(`${kind}:`));
  const what = kind === "ability" ? label.toLowerCase() : "itens";
  const resLabel = (k: string) => ruleset.resources.find((r) => r.key === k)?.label ?? k;

  const generate = async (ev: FormEvent) => {
    ev.preventDefault();
    setSending(true);
    setGenError("");
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/library`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, count, focus, canon }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
      toast(data.started ? "Acompanhe no cabeçalho; o que ficar pronto já aparece aqui." : "Esse pedido já está rodando.", { title: data.label });
      if (data.started) setFocus("");
      onChange();
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  // otimista: sai da lista na hora; se o DELETE falhar, volta para o mesmo lugar com aviso
  const remove = async (e: LibraryEntry) => {
    const k = kind;
    const at = lib?.[k].findIndex((x) => x.id === e.id) ?? -1;
    setLib((l) => l && { ...l, [k]: l[k].filter((x) => x.id !== e.id) });
    setConfirming(null);
    const res = await fetch(`/api/campaigns/${campaignId}/library/${e.id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      setLib((l) => {
        if (!l) return l;
        const next = [...l[k]];
        next.splice(at < 0 ? next.length : Math.min(at, next.length), 0, e);
        return { ...l, [k]: next };
      });
      return toast("Tente de novo.", { kind: "alerta", title: `Não deu para tirar ${e.name}` });
    }
    toast("Quem já tem continua tendo.", { title: `${e.name} saiu da biblioteca deste mundo` });
  };

  const filterRow = (title: string, opts: string[], value: string | null, set: (v: string | null) => void, get: (e: LibraryEntry) => string | undefined, show: (o: string) => string) =>
    opts.length > 1 && (
      <div className={a.filters} role="group" aria-label={title}>
        <span className={a.filterTitle}>{title}</span>
        {[null, ...opts].map((o) => (
          <button key={o ?? "*"} className={`pill filter-pill${value === o ? " on" : ""}`} aria-pressed={value === o} onClick={() => set(o)}>
            {o === null ? "Todos" : <>{show(o)} <span className="num">{entries.filter((e) => get(e) === o).length}</span></>}
          </button>
        ))}
      </div>
    );

  const entry = (e: LibraryEntry, i: number) => {
    const d = e.data as Data;
    const cost = kind === "ability" ? abilityCost(ruleset, d) : null;
    const marks = d.milestones ?? [];
    return (
      <details key={e.id} className={`${p.card} ${s.entry}`} style={{ animationDelay: `${Math.min(i, 8) * 25}ms` }}
        onToggle={() => confirming === e.id && setConfirming(null)}>
        <summary>
          <div className={p.grow}>
            <div className={p.title}>{e.name}</div>
            {d.translation && <div className={a.tr}>{d.translation}</div>}
            <div className={s.meta}>
              {d.rank && <span className={a.rank}>{d.rank}</span>}
              {typeOf(e) && <span>{typeLabel(typeOf(e))}</span>}
              {d.element && <span>{elLabel(d.element)}</span>}
              {!e.canon && <span className={p.chip}>original</span>}
              {d.incomplete && <span className={`${p.chip} ${a.warn}`} data-tip="Registrada às pressas; o Mestre completa o efeito e os detalhes">incompleta</span>}
            </div>
          </div>
          <Icon name="chevron" size={16} className={s.chev} />
        </summary>
        <div className={s.body}>
          {(cost || d.damage) && (
            <div className={a.stats}>
              {cost && (
                <span className={a.stat} data-tip={d.costFree ? "Não gasta recurso" : "Custo base do rank; varia com o domínio de quem usa"}>
                  <span className={a.statK}>custo</span>
                  {cost.amount ? <span><b className="num">{cost.amount}</b> {resLabel(cost.resource)}</span> : <span>livre</span>}
                </span>
              )}
              {d.damage && <span className={a.stat}><span className={a.statK}>dano</span><b className="num">{d.damage}</b></span>}
            </div>
          )}
          {d.effect && <p className={a.text}>{d.effect}</p>}
          {d.requirements && <p className={a.req}><span>Requisitos</span> {d.requirements}</p>}
          {d.users && <p className={a.req}><span>Quem usa</span> {d.users}</p>}
          {d.description && <p className={a.desc}>{d.description}</p>}
          {marks.length > 0 && (
            <ol className={s.marks} aria-label="Marcos de domínio">
              {marks.map((m) => <li key={m.threshold}><span>{m.threshold}%</span><span>{m.description}</span></li>)}
            </ol>
          )}
          {confirming === e.id ? (
            <div className={p.actions}>
              <span className={p.sub}>Tirar {e.name} da biblioteca? Sai da biblioteca deste mundo; quem já tem continua tendo.</span>
              <button className="btn danger small" onClick={() => remove(e)}>Tirar</button>
              <button className="btn ghost small" onClick={() => setConfirming(null)}>Cancelar</button>
            </div>
          ) : (
            <div className={s.foot}>
              <span className="faint">{e.canon ? "Do cânone" : "Original"} · {e.source === "gm" ? "registrada no jogo" : "Criador"}</span>
              <button className="btn ghost small" onClick={() => setConfirming(e.id)}>Tirar da biblioteca</button>
            </div>
          )}
        </div>
      </details>
    );
  };

  return (
    <div className={p.wrap}>
      <p className={p.note}>
        {label} e itens deste mundo, compartilhados entre as campanhas dele. O Mestre consulta antes de inventar, e o que ele registra de novo também fica aqui.
      </p>
      <div className={s.seg} role="group" aria-label="Seção da biblioteca">
        {(["ability", "item"] as const).map((k) => (
          <button key={k} aria-pressed={kind === k} onClick={() => pick(k)}>
            {k === "ability" ? label : "Itens"}
            {lib && <span className="num">{lib[k].length}</span>}
          </button>
        ))}
      </div>

      <details className={s.gen} open={(lib !== null && !entries.length && !running.length) || undefined}>
        <summary><Icon name="spark" size={15} /> Gerar em segundo plano</summary>
        <form className={s.form} onSubmit={generate}>
          <label className={s.focus}>
            Foco (opcional)
            <input type="text" value={focus} maxLength={300} onChange={(e) => setFocus(e.target.value)}
              placeholder={kind === "ability" ? "Ex.: as de um lugar, escola ou linhagem, até certo ponto da história" : "Ex.: armas e ferramentas comuns de quem está começando"} />
          </label>
          <label>
            Quantidade
            <input className={s.qty} type="number" min={1} max={60} value={count}
              onChange={(e) => setCount(Math.min(60, Math.max(1, Math.round(Number(e.target.value)) || 1)))} />
          </label>
          <label className={s.canon}>
            <input type="checkbox" checked={canon} onChange={(e) => setCanon(e.target.checked)} />
            Só do cânone
          </label>
          <button className="btn primary small" disabled={sending}>
            {sending ? <Loader size={16} label="Começando" /> : <Icon name="spark" size={14} />}
            Gerar {count} {what}
          </button>
          <p className={s.hint}>
            O {kind === "ability" ? "Criador de habilidades" : "Criador de itens"} trabalha em lotes, sem repetir o que já existe, e você pode continuar jogando.
          </p>
          {genError && <div className="error-box" style={{ flex: "1 1 100%" }}>{genError}</div>}
        </form>
      </details>

      {running.map((j) => (
        <div key={j.id} className={s.job} aria-live="polite">
          <div className={s.jobRow}>
            <Loader size={18} label="Gerando" />
            <span>{j.label}</span>
            <b className="num">{j.progress?.done ?? 0}/{j.progress?.total ?? "?"}</b>
          </div>
          <div className={p.progress}><span style={{ transform: `scaleX(${j.progress ? j.progress.done / Math.max(1, j.progress.total) : 0})` }} /></div>
        </div>
      ))}

      {error && <div className="error-box">{error}</div>}
      {!lib && !error && (
        <div aria-busy="true" className={p.wrap}>
          <Skeleton h={38} className="block" />
          {[0, 1, 2].map((i) => <Skeleton key={i} h={52} className="block" />)}
        </div>
      )}

      {lib && entries.length > 0 && (
        <>
          <SearchBox value={query} onChange={setQuery} label="Buscar na biblioteca" placeholder={`Buscar ${what} por nome ou efeito`} />
          {(typeOpts.length > 1 || rankOpts.length > 1 || elOpts.length > 1) && (
            <div className={a.filterBox}>
              {filterRow(kind === "ability" ? "Tipo" : "Categoria", typeOpts, type, setType, typeOf, typeLabel)}
              {filterRow("Rank", rankOpts, rank, setRank, (e) => e.data.rank, (o) => o)}
              {filterRow("Elemento", elOpts, element, setElement, elOf, elLabel)}
            </div>
          )}
          <div className={p.head}>
            <h4>{shown.length === entries.length ? "Todas" : "Encontradas"}</h4>
            <span className={p.count}>{shown.length} de {entries.length}</span>
          </div>
          {!shown.length && <p className="muted">Nada com essa busca ou esses filtros.</p>}
          {shown.map(entry)}
        </>
      )}

      {lib && !entries.length && !running.length && (
        <div className={p.empty}>
          <Icon name="library" size={26} />
          <b>Ainda não há {what} aqui</b>
          {kind === "ability"
            ? "Peça um lote ao Criador de habilidades acima. Cada técnica nova que o Mestre registra no jogo também entra aqui."
            : "Peça um lote ao Criador de itens acima: o Mestre usa a descrição daqui quando dá um item ao personagem."}
        </div>
      )}
    </div>
  );
}
