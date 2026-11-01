"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { AgentConfig, SourceView } from "@/lib/types";
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
  image: "O Ilustrador pede a imagem pelo chat com modalities, no formato do OpenRouter (imagens em message.images): a fonte precisa responder igual. Na fonte Gemini ele usa POST {URL}/images/generations, com um modelo de imagem do Gemini (ex.: gemini-2.5-flash-image).",
};

// ordem do fluxo (a mesma de Custos e uso) e cor de cada agente, só por tokens do tema
const ORDER = ["gm", "scribe", "npc", "chronicler", "scriptwriter", "decider", "characters", "abilities", "items", "image", "cartographer", "surveyor", "voice", "adventure"];
const TONE: Record<string, string> = {
  gm: "var(--accent)", scribe: "color-mix(in srgb, var(--accent) 45%, var(--ok))", npc: "var(--mode-dialogue)", chronicler: "var(--warn)", scriptwriter: "var(--mode-exploration)",
  decider: "var(--info)", image: "var(--ok)", voice: "var(--mode-training)",
  // criadores em segundo plano: tons derivados dos do jogo
  characters: "color-mix(in srgb, var(--mode-dialogue) 55%, var(--accent))", abilities: "var(--mode-battle)",
  items: "color-mix(in srgb, var(--mode-battle) 50%, var(--warn))",
  cartographer: "var(--mode-downtime)", surveyor: "color-mix(in srgb, var(--mode-downtime) 50%, var(--ok))", adventure: "color-mix(in srgb, var(--mode-exploration) 50%, var(--info))",
};
// Login com ChatGPT (fonte OpenAI): só texto, pela Responses API
const USAGE = "https://chatgpt.com/settings/usage";
const TEXT_ONLY = ["image", "voice", "decider"];
const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : 99);
const usd = (n: number | null | undefined) =>
  n == null ? "?" : n === 0 ? "grátis" : `US$ ${n.toLocaleString("pt-BR", { maximumFractionDigits: 4 })}`;
const ctx = (n: number) => `${Math.round(n / 1000).toLocaleString("pt-BR")} mil`;

export default function AgentsClient({ initialAgents, sources }: { initialAgents: AgentConfig[]; sources: SourceView[] }) {
  const [agents, setAgents] = useState(() => [...initialAgents].sort((a, b) => rank(a.id) - rank(b.id)));
  // modelos por fonte, só para o editor (seletor de modelo e preço ao vivo): ausente = carregando, null = a fonte não listou
  const [models, setModels] = useState<Record<string, Model[] | null>>({});
  const asked = useRef(new Set<string>());
  const [open, setOpen] = useState<string | null>(null);

  const fetchModels = useCallback(async (src: string): Promise<Model[]> => {
    asked.current.add(src);
    const r = await fetch(`/api/models?source=${encodeURIComponent(src)}`).catch(() => null);
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
            onClose={() => setOpen((o) => (o === a.id ? null : o))}
            onReopen={() => setOpen((o) => o ?? a.id)}
            onSaved={(updated) => setAgents((list) => list.map((x) => (x.id === updated.id ? updated : x)))}
          />
        ))}
      </div>
    </>
  );
}

function AgentCard({ agent, sources, models, loadModels, open, onToggle, onClose, onReopen, onSaved }: {
  agent: AgentConfig;
  sources: SourceView[];
  models: Record<string, Model[] | null>;
  loadModels: (src: string) => void;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onReopen: () => void;
  onSaved: (a: AgentConfig) => void;
}) {
  const [form, setForm] = useState(agent);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const or = form.source === "openrouter";
  const viaGpt = sources.find((x) => x.id === form.source)?.auth === "chatgpt";
  // cache de prompt: só modelos da Anthropic (fonte Anthropic ou anthropic/* no OpenRouter)
  const claude = or ? form.model.startsWith("anthropic/") : sources.find((x) => x.id === form.source)?.kind === "anthropic";
  const setParam = (k: string, v: unknown) => setForm({ ...form, params: { ...form.params, [k]: v } });

  // otimista: a lista mostra o agente novo e o card recolhe na hora; o PUT vai depois e, se falhar, desfaz
  const save = async () => {
    const prev = agent;
    const next = { ...form, temperature: Number(form.temperature), max_tokens: Number(form.max_tokens), web_search: or && form.web_search };
    setSaving(true);
    setSaveError("");
    setForm(next);
    onSaved(next);
    onClose();
    const res = await fetch(`/api/agents/${agent.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: next.name,
        source: next.source,
        model: next.model,
        temperature: next.temperature,
        max_tokens: next.max_tokens,
        web_search: next.web_search,
        system_prompt: next.system_prompt,
        params: next.params,
      }),
    }).catch(() => null);
    const same = (f: AgentConfig) => JSON.stringify(f) === JSON.stringify(next); // não atropela edição feita no meio tempo
    if (res?.ok) {
      const updated = await res.json();
      onSaved(updated);
      setForm((f) => (same(f) ? updated : f));
      toast(`${agent.name} salvo${updated.pricing ? " com o preço atual do catálogo" : ""}.`, { kind: "sucesso" });
    } else {
      const error = (await res?.json().catch(() => null))?.error || `Erro ${res?.status ?? "de rede"} ao salvar`;
      onSaved(prev); // o formulário fica com a edição (sujo) para tentar de novo
      setSaveError(error);
      onReopen();
      toast(error, { kind: "alerta", title: `${agent.name} não foi salvo` });
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

  // Ctrl+S / Cmd+S salva o agente aberto (e nunca abre o "salvar página" do navegador)
  const saveRef = useRef<() => void>(() => {});
  saveRef.current = () => { if (dirty && !saving) save(); };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

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
            {!!agent.params.cache && <span className="pill on">cache</span>}
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
            {agent.source !== "openrouter" && " (preço do OpenRouter, para estimar o custo)"}
          </span>
        ) : agent.source !== "openrouter" ? (
          <span className={s.price}>Sem preço: o modelo não está no catálogo do OpenRouter, então o custo não é estimado (em Custos e uso ficam os tokens).</span>
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
                <span className={s.hint}><Link href="/settings#fontes">Gerenciar fontes</Link> (em Configurações)</span>
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
            {viaGpt ? (
              <p className={`${s.warnBox} ${s.full}`} role="note">
                {TEXT_ONLY.includes(agent.id)
                  ? `O Login com ChatGPT só faz texto, pela Responses API: ${agent.name} não funciona nesta fonte. Escolha outra para ele.`
                  : "Usando o plano do ChatGPT: temperatura e máximo de tokens são ignorados nesta fonte. "}
                {!TEXT_ONLY.includes(agent.id) && <a href={USAGE} target="_blank" rel="noreferrer">Gerenciar uso</a>}
              </p>
            ) : !or && SPECIAL[agent.id] && <p className={`${s.warnBox} ${s.full}`} role="note">{SPECIAL[agent.id]}</p>}
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
              {claude && <label className={`${s.check} ${s.full}`}>
                <input type="checkbox" checked={!!form.params.cache} onChange={(e) => setParam("cache", e.target.checked)} />
                Cache de prompt: o começo que se repete (ferramentas, prompt do agente, histórico, rodadas anteriores do turno) sai por 5 a 10% do preço de entrada. Gravar custa mais (2x no que dura 1 hora entre turnos, 1,25x no fim da conversa): compensa em quem chama várias vezes seguidas, como o Mestre
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
