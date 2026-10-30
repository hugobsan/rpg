"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { AgentConfig, SourceView } from "@/lib/types";
import { presetOf, SOURCE_PRESETS } from "@/lib/sourcePresets";
import Loader from "@/components/ui/Loader";
import { toast } from "@/components/ui/Toast";
import AgentsDiagram from "./AgentsDiagram";
import s from "./agents.module.css";

// do catálogo do OpenRouter vêm contexto, preço e vozes; das outras fontes, só id e nome (GET /models)
interface Model {
  id: string;
  name: string;
  context?: number;
  pricing?: { prompt: string; completion: string };
  speech?: boolean;
  voices?: string[] | null;
}

// agentes que usam mais que o chat: numa fonte que não é o OpenRouter, ela precisa oferecer o mesmo endpoint
const SPECIAL: Record<string, string> = {
  decider: "O Jev usa a Decisions API (no OpenRouter, POST /api/alpha/decisions, ao lado do /api/v1): a fonte precisa oferecer o mesmo endpoint, em {URL}/../alpha/decisions. Se falhar, o jogo segue com as decisões padrão.",
  voice: "A Voz usa POST {URL}/audio/speech, no formato da OpenAI. Fora do OpenRouter as vozes são texto livre e o custo não é informado.",
  image: "O Ilustrador pede a imagem pelo chat com modalities, no formato do OpenRouter (imagens em message.images): a fonte precisa responder igual.",
};

// ordem do fluxo (a mesma de Custos e uso) e cor de cada agente, só por tokens do tema
const ORDER = ["gm", "npc", "chronicler", "scriptwriter", "decider", "characters", "abilities", "items", "pixel", "image", "cartographer", "voice", "adventure"];
const TONE: Record<string, string> = {
  gm: "var(--accent)", npc: "var(--mode-dialogue)", chronicler: "var(--warn)", scriptwriter: "var(--mode-exploration)",
  decider: "var(--info)", image: "var(--ok)", voice: "var(--mode-training)",
  // criadores em segundo plano: tons derivados dos do jogo
  characters: "color-mix(in srgb, var(--mode-dialogue) 55%, var(--accent))", abilities: "var(--mode-battle)",
  items: "color-mix(in srgb, var(--mode-battle) 50%, var(--warn))", pixel: "color-mix(in srgb, var(--ok) 50%, var(--mode-dialogue))",
  cartographer: "var(--mode-downtime)", adventure: "color-mix(in srgb, var(--mode-exploration) 50%, var(--info))",
};
const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : 99);
const usd = (n: number | null | undefined) =>
  n == null ? "?" : n === 0 ? "grátis" : `US$ ${n.toLocaleString("pt-BR", { maximumFractionDigits: 4 })}`;
const ctx = (n: number) => `${Math.round(n / 1000).toLocaleString("pt-BR")} mil`;

export default function AgentsClient({ initialAgents, initialSources }: { initialAgents: AgentConfig[]; initialSources: SourceView[] }) {
  const [agents, setAgents] = useState(() => [...initialAgents].sort((a, b) => rank(a.id) - rank(b.id)));
  const [sources, setSources] = useState(initialSources);
  // modelos por fonte, só para o editor (seletor de modelo e preço ao vivo): ausente = carregando, null = a fonte não listou
  const [models, setModels] = useState<Record<string, Model[] | null>>({});
  const asked = useRef(new Set<string>());
  const [open, setOpen] = useState<string | null>(null);

  const fetchModels = useCallback(async (src: string, fresh = false): Promise<Model[]> => {
    asked.current.add(src);
    const r = await fetch(`/api/models?source=${encodeURIComponent(src)}${fresh ? "&fresh=1" : ""}`).catch(() => null);
    const d = await r?.json().catch(() => null);
    const list: Model[] | null = r?.ok && Array.isArray(d) ? d : null;
    setModels((m) => ({ ...m, [src]: list }));
    if (!list) throw new Error(d?.error || `Erro ${r?.status ?? "de rede"} ao listar os modelos`);
    return list;
  }, []);
  // uma vez por fonte; o OpenRouter já de saída
  const loadModels = useCallback((src: string) => {
    if (!asked.current.has(src)) fetchModels(src).catch(() => {});
  }, [fetchModels]);
  useEffect(() => loadModels("openrouter"), [loadModels]);

  return (
    <>
      <AgentsDiagram />
      <SourcesPanel sources={sources} setSources={setSources} agents={agents} fetchModels={fetchModels} />
      <div className={s.grid}>
        {agents.map((a) => (
          <AgentCard
            key={a.id}
            agent={a}
            sources={sources}
            models={models}
            loadModels={loadModels}
            open={open === a.id}
            onToggle={() => setOpen(open === a.id ? null : a.id)}
            onSaved={(updated) => setAgents((list) => list.map((x) => (x.id === updated.id ? updated : x)))}
          />
        ))}
      </div>
    </>
  );
}

type Draft = { id?: string; kind?: string; name: string; url: string; apiKey: string };

/** Fontes OpenAI-compatíveis: adicionar, editar, testar (GET /models) e remover (só sem uso). */
function SourcesPanel({ sources, setSources, agents, fetchModels }: {
  sources: SourceView[];
  setSources: React.Dispatch<React.SetStateAction<SourceView[]>>;
  agents: AgentConfig[];
  fetchModels: (src: string, fresh?: boolean) => Promise<Model[]>;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDel, setConfirmDel] = useState("");
  const [tests, setTests] = useState<Record<string, { ok: boolean; text: string } | "testing">>({});

  const test = async (id: string) => {
    setTests((t) => ({ ...t, [id]: "testing" }));
    const r = await fetchModels(id, true).then(
      (l) => ({ ok: true, text: `Conectou: ${l.length} ${l.length === 1 ? "modelo" : "modelos"} em GET /models.` }),
      (e: Error) => ({ ok: false, text: `Falhou: ${e.message}` })
    );
    setTests((t) => ({ ...t, [id]: r }));
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError("");
    const res = await fetch("/api/sources", {
      method: draft.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    }).catch(() => null);
    const d = await res?.json().catch(() => null);
    setBusy(false);
    if (!res?.ok) return setError(d?.error || `Erro ${res?.status ?? "de rede"} ao salvar a fonte`);
    setSources((list) => (draft.id ? list.map((x) => (x.id === d.id ? d : x)) : [...list, d]));
    setDraft(null);
    toast(`Fonte ${d.name} salva.`, { kind: "sucesso" });
    test(d.id); // confere a conexão já com a URL e a chave novas
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError("");
    const res = await fetch(`/api/sources?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    const d = await res?.json().catch(() => null);
    setBusy(false);
    setConfirmDel("");
    if (!res?.ok) return setError(d?.error || `Erro ${res?.status ?? "de rede"} ao remover a fonte`);
    setSources((list) => list.filter((x) => x.id !== id));
    toast("Fonte removida.", { kind: "sucesso" });
  };

  const edit = (x: Draft | null) => {
    setDraft(x);
    setError("");
  };

  return (
    <details className={`card ${s.diagram}`}>
      <summary>
        <div>
          <h2>Fontes de modelos</h2>
          <p className="muted">
            OpenRouter (embutida){sources.length ? ` e mais ${sources.length} ${sources.length === 1 ? "fonte" : "fontes"}` : ""}. Cada agente escolhe a sua no editor.
          </p>
        </div>
        <svg className={s.chev} width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className={s.diagramBody}>
        <p className={s.warnBox} role="note">
          A API precisa ser <b>compatível com a da OpenAI</b>: <code>POST {"{URL}"}/chat/completions</code> e, de preferência,{" "}
          <code>GET {"{URL}"}/models</code> para listar os modelos (sem ela, digite o id do modelo). Use a URL base, como{" "}
          <code>https://api.openai.com/v1</code> ou <code>http://localhost:11434/v1</code>. Só o OpenRouter informa o custo: das
          outras fontes, Custos e uso mostra os tokens.
        </p>
        <div className={s.srcRow}>
          <div className={s.srcInfo}>
            <span><b>OpenRouter</b><span className="pill">embutida</span></span>
            <span className={s.srcMeta}><code>https://openrouter.ai/api/v1</code> · chave em <Link href="/settings">Configurações</Link></span>
          </div>
        </div>
        {sources.map((x) => {
          const used = agents.filter((a) => a.source === x.id).map((a) => a.name);
          const t = tests[x.id];
          return (
            <div key={x.id} className={s.srcRow}>
              <div className={s.srcInfo}>
                <span><b>{x.name}</b><span className="pill">{x.id}</span></span>
                <span className={s.srcMeta}>
                  <code>{x.url}</code> · {x.apiKeyMasked ? <>chave <code>{x.apiKeyMasked}</code></> : "sem chave"}
                </span>
                <span className={s.srcMeta}>{used.length ? `Usada por: ${used.join(", ")}` : "Nenhum agente usa esta fonte."}</span>
                {presetOf(x.kind) && <span className={s.srcMeta}>{presetOf(x.kind)!.note}</span>}
              </div>
              <div className={s.srcActions}>
                {confirmDel === x.id ? (
                  <>
                    <span className="muted">Remover {x.name}?</span>
                    <button className="btn small danger" disabled={busy} onClick={() => remove(x.id)}>Remover</button>
                    <button className="btn small ghost" disabled={busy} onClick={() => setConfirmDel("")}>Cancelar</button>
                  </>
                ) : (
                  <>
                    <button className="btn small" disabled={t === "testing"} onClick={() => test(x.id)}>
                      {t === "testing" && <Loader size={14} label="Testando" />} Testar
                    </button>
                    <button className="btn small ghost" onClick={() => edit({ id: x.id, kind: x.kind, name: x.name, url: x.url, apiKey: "" })}>Editar</button>
                    {/* em uso por agente: troque a fonte deles antes (os embeddings o servidor confere) */}
                    {!used.length && <button className="btn small ghost" onClick={() => setConfirmDel(x.id)}>Remover</button>}
                  </>
                )}
              </div>
              {t && t !== "testing" && <p className={`${s.srcTest} ${t.ok ? s.ok : s.err}`} role="status">{t.text}</p>}
            </div>
          );
        })}
        {draft ? (
          <form className={s.srcAdd} onSubmit={(e) => { e.preventDefault(); save(); }}>
            {/* tipo conhecido: nome e URL já vêm preenchidos, só falta a chave; o tipo não muda depois */}
            {!draft.id && (
              <label className={`field ${s.srcKind}`}>
                <span>Tipo</span>
                <select value={draft.kind ?? ""} onChange={(e) => {
                  const p = presetOf(e.target.value);
                  setDraft({ ...draft, kind: p?.kind, name: p?.name ?? "", url: p?.url ?? "" });
                }}>
                  {SOURCE_PRESETS.map((p) => <option key={p.kind} value={p.kind}>{p.name}</option>)}
                  <option value="">Personalizada</option>
                </select>
              </label>
            )}
            {presetOf(draft.kind) && <p className={s.warnBox} role="note">{presetOf(draft.kind)!.note}</p>}
            <div className={s.srcForm}>
              <label className="field">
                <span>Nome</span>
                <input type="text" value={draft.name} maxLength={60} placeholder="Ollama local"
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </label>
              <label className="field">
                <span>URL base</span>
                <input type="url" value={draft.url} spellCheck={false} placeholder="http://localhost:11434/v1"
                  onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
              </label>
              <label className="field">
                <span>API key</span>
                <input type="password" value={draft.apiKey} autoComplete="off" spellCheck={false}
                  placeholder={draft.id ? "em branco: mantém a atual" : draft.kind ? "cole a chave da sua conta" : "opcional (Ollama local não usa)"}
                  onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} />
              </label>
            </div>
            <div className={s.actions}>
              <button type="submit" className="btn primary small"
                disabled={busy || !draft.name.trim() || !draft.url.trim() || (!draft.id && !!draft.kind && !draft.apiKey.trim())}>
                {busy && <Loader size={14} label="Salvando" />} {draft.id ? "Salvar fonte" : "Adicionar fonte"}
              </button>
              <button type="button" className="btn small ghost" disabled={busy} onClick={() => edit(null)}>Cancelar</button>
            </div>
          </form>
        ) : (
          <div className={s.srcRow}>
            <button className="btn small" onClick={() => { const p = SOURCE_PRESETS[0]; edit({ kind: p.kind, name: p.name, url: p.url, apiKey: "" }); }}>Adicionar fonte</button>
          </div>
        )}
        {error && <div className="error-box">{error}</div>}
      </div>
    </details>
  );
}

function AgentCard({ agent, sources, models, loadModels, open, onToggle, onSaved }: {
  agent: AgentConfig;
  sources: SourceView[];
  models: Record<string, Model[] | null>;
  loadModels: (src: string) => void;
  open: boolean;
  onToggle: () => void;
  onSaved: (a: AgentConfig) => void;
}) {
  const [form, setForm] = useState(agent);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const or = form.source === "openrouter";

  const save = async () => {
    setSaving(true);
    setSaveError("");
    const res = await fetch(`/api/agents/${agent.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name,
        source: form.source,
        model: form.model,
        temperature: Number(form.temperature),
        max_tokens: Number(form.max_tokens),
        web_search: or && form.web_search,
        system_prompt: form.system_prompt,
        params: form.params,
      }),
    }).catch(() => null);
    if (res?.ok) {
      const updated = await res.json();
      onSaved(updated);
      setForm(updated);
      toast(`${agent.name} salvo${updated.pricing ? " com o preço atual do catálogo" : ""}.`, { kind: "sucesso" });
    } else {
      setSaveError((await res?.json().catch(() => null))?.error || `Erro ${res?.status ?? "de rede"} ao salvar`);
    }
    setSaving(false);
  };

  const srcName = (id: string) => (id === "openrouter" ? "OpenRouter" : sources.find((x) => x.id === id)?.name ?? id);
  useEffect(() => {
    if (open) loadModels(form.source);
  }, [open, form.source, loadModels]);
  const list = models[form.source];
  const modelInfo = list?.find((m) => m.id === form.model);
  const noPrompt = agent.id === "decider" || agent.id === "voice";
  const dirty = JSON.stringify(form) !== JSON.stringify(agent);
  const p = agent.pricing;

  return (
    <article className={`card ${s.agent} ${open ? s.open : ""}`} style={{ "--tone": TONE[agent.id] ?? "var(--accent)" } as React.CSSProperties}>
      <div className={s.head}>
        <span className={s.mark} aria-hidden="true">{agent.name.slice(0, 1)}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3>{agent.name}</h3>
          <div className={s.badges}>
            <span className="pill">{agent.id}</span>
            {agent.source !== "openrouter" && <span className="pill">{srcName(agent.source)}</span>}
            {agent.web_search && <span className="pill on">busca web</span>}
            {agent.id === "gm" && !!agent.params.complexModel && <span className="pill">2 modelos</span>}
          </div>
        </div>
      </div>
      <p className={s.desc}>{agent.description}</p>

      <div className={s.model}>
        <span className={s.modelId}>{agent.model}</span>
        {!!p?.context && <span className="muted num">contexto {ctx(p.context)}</span>}
        {p ? (
          <span className={s.price}>
            <b>{usd(p.input)}</b> entrada · <b>{usd(p.output)}</b> saída
            {p.cache_read != null && <> · {usd(p.cache_read)} cache</>} por milhão de tokens
          </span>
        ) : agent.source !== "openrouter" ? (
          <span className={s.price}>Sem preço: a fonte não informa custo (em Custos e uso ficam os tokens).</span>
        ) : (
          <span className={s.price}>Preço ainda não consultado: salve o agente para buscar no catálogo.</span>
        )}
        {agent.id === "gm" && !!agent.params.complexModel && (
          <span className={s.price}>Turnos complexos: <span className={s.modelId}>{String(agent.params.complexModel)}</span></span>
        )}
      </div>

      {open && (
        <div>
          <div className={s.form}>
            <div className={s.pick}>
              <label className="field">
                <span>Fonte</span>
                <select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
                  <option value="openrouter">OpenRouter</option>
                  {sources.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Modelo</span>
                <input type="text" list={`models-${agent.id}`} value={form.model} spellCheck={false}
                  onChange={(e) => setForm({ ...form, model: e.target.value })} />
                <datalist id={`models-${agent.id}`}>
                  {/* agente Voz no OpenRouter só lista modelos de fala (as outras fontes não dizem quais são) */}
                  {(list ?? []).filter((m) => agent.id !== "voice" || !or || m.speech).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </datalist>
                <span className={s.hint}>
                  {modelInfo?.pricing
                    ? `contexto ${ctx(modelInfo.context ?? 0)} · ${usd(Number(modelInfo.pricing.prompt) * 1e6)} entrada · ${usd(Number(modelInfo.pricing.completion) * 1e6)} saída por milhão`
                    : list === undefined ? "Carregando os modelos da fonte"
                    : list === null ? (or ? "Não foi possível carregar o catálogo do OpenRouter." : "A fonte não listou os modelos (GET /models): digite o id.")
                    : modelInfo ? `Modelo listado pela fonte (${list.length} em GET /models).`
                    : or ? "Modelo fora do catálogo: escolha um id da lista." : "Modelo fora da lista da fonte: confira o id."}
                </span>
              </label>
            </div>
            {!or && SPECIAL[agent.id] && <p className={`${s.warnBox} ${s.full}`} role="note">{SPECIAL[agent.id]}</p>}
            {/* Jev e Voz só usam o modelo: sem temperatura, tokens, web ou prompt */}
            {!noPrompt && <>
              <label className="field">
                <span>Temperatura</span>
                <input type="number" step={0.1} min={0} max={2} value={form.temperature}
                  onChange={(e) => setForm({ ...form, temperature: Number(e.target.value) })} />
              </label>
              <label className="field">
                <span>Máximo de tokens</span>
                <input type="number" step={100} value={form.max_tokens}
                  onChange={(e) => setForm({ ...form, max_tokens: Number(e.target.value) })} />
              </label>
              {/* :online só existe no OpenRouter */}
              {or && <label className={`${s.check} ${s.full}`}>
                <input type="checkbox" checked={form.web_search} onChange={(e) => setForm({ ...form, web_search: e.target.checked })} />
                Busca web (:online): o modelo pode consultar a internet, cobrada por busca
              </label>}
            </>}
            {agent.id === "gm" && (
              <label className={`field ${s.full}`}>
                <span>Modelo para turnos complexos, na mesma fonte (o Jev decide por turno; vazio = sempre o modelo acima)</span>
                <input type="text" list={`models-${agent.id}`} spellCheck={false}
                  value={String(form.params.complexModel ?? "")}
                  onChange={(e) => setForm({ ...form, params: { ...form.params, complexModel: e.target.value } })} />
              </label>
            )}
            {agent.id === "voice" && ([["maleVoice", "Voz masculina padrão"], ["femaleVoice", "Voz feminina padrão"]] as const).map(([k, label]) => (
              <label key={k} className="field">
                <span>{label}</span>
                {/* vozes do modelo escolhido; sem lista no catálogo, campo livre */}
                {modelInfo?.voices ? (
                  <select value={String(form.params[k] ?? "")}
                    onChange={(e) => setForm({ ...form, params: { ...form.params, [k]: e.target.value } })}>
                    {!modelInfo.voices.includes(String(form.params[k] ?? "")) && <option value="">(escolha)</option>}
                    {modelInfo.voices.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                ) : (
                  <input type="text" value={String(form.params[k] ?? "")}
                    onChange={(e) => setForm({ ...form, params: { ...form.params, [k]: e.target.value } })} />
                )}
              </label>
            ))}
            {!noPrompt && (
              <label className={`field ${s.full}`}>
                <span>System prompt</span>
                <textarea className={s.prompt} rows={18} value={form.system_prompt} spellCheck={false}
                  onChange={(e) => setForm({ ...form, system_prompt: e.target.value })} />
              </label>
            )}
          </div>
          {!noPrompt && (
            <div className={s.promptMeta}>
              <span>{form.system_prompt.length.toLocaleString("pt-BR")} caracteres</span>
              {/* mesma estimativa do servidor: ~3,5 caracteres por token em pt-BR */}
              <span>≈ {Math.ceil(form.system_prompt.length / 3.5).toLocaleString("pt-BR")} tokens por chamada</span>
            </div>
          )}
          {saveError && <div className="error-box">{saveError}</div>}
          <div className={s.actions}>
            <button className="btn primary" onClick={save} disabled={saving || !dirty}>
              {saving && <Loader size={16} label="Salvando" />} Salvar agente
            </button>
            <button className="btn ghost" disabled={saving || !dirty} onClick={() => { setForm(agent); setSaveError(""); }}>Descartar alterações</button>
          </div>
        </div>
      )}

      <div className={s.foot}>
        <button className={`btn small ${open ? "ghost" : ""}`} onClick={onToggle} aria-expanded={open}>
          {open ? "Fechar edição" : noPrompt ? "Editar modelo" : "Editar modelo e prompt"}
        </button>
        <Link href={`/usage?agent=${agent.id}`}>Custos e uso deste agente →</Link>
      </div>
    </article>
  );
}
