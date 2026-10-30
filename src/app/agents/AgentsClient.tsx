"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { AgentConfig } from "@/lib/types";
import Loader from "@/components/ui/Loader";
import { toast } from "@/components/ui/Toast";
import AgentsDiagram from "./AgentsDiagram";
import s from "./agents.module.css";

interface Model {
  id: string;
  name: string;
  context: number;
  pricing: { prompt: string; completion: string };
  speech: boolean;
  voices: string[] | null;
}

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

export default function AgentsClient({ initialAgents }: { initialAgents: AgentConfig[] }) {
  const [agents, setAgents] = useState(() => [...initialAgents].sort((a, b) => rank(a.id) - rank(b.id)));
  const [models, setModels] = useState<Model[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  // catálogo do OpenRouter só para o editor (seletor de modelo e preço ao vivo)
  useEffect(() => {
    fetch("/api/models")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => Array.isArray(d) && setModels(d))
      .catch(() => {});
  }, []);

  return (
    <>
      <AgentsDiagram />
      <div className={s.grid}>
        {agents.map((a) => (
          <AgentCard
            key={a.id}
            agent={a}
            models={models}
            open={open === a.id}
            onToggle={() => setOpen(open === a.id ? null : a.id)}
            onSaved={(updated) => setAgents((list) => list.map((x) => (x.id === updated.id ? updated : x)))}
          />
        ))}
      </div>
    </>
  );
}

function AgentCard({ agent, models, open, onToggle, onSaved }: {
  agent: AgentConfig;
  models: Model[];
  open: boolean;
  onToggle: () => void;
  onSaved: (a: AgentConfig) => void;
}) {
  const [form, setForm] = useState(agent);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const save = async () => {
    setSaving(true);
    setSaveError("");
    const res = await fetch(`/api/agents/${agent.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name,
        model: form.model,
        temperature: Number(form.temperature),
        max_tokens: Number(form.max_tokens),
        web_search: form.web_search,
        system_prompt: form.system_prompt,
        params: form.params,
      }),
    }).catch(() => null);
    if (res?.ok) {
      const updated = await res.json();
      onSaved(updated);
      setForm(updated);
      toast(`${agent.name} salvo com o preço atual do catálogo.`, { kind: "sucesso" });
    } else {
      setSaveError((await res?.json().catch(() => null))?.error || `Erro ${res?.status ?? "de rede"} ao salvar`);
    }
    setSaving(false);
  };

  const modelInfo = models.find((m) => m.id === form.model);
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
            <label className="field">
              <span>Modelo (OpenRouter)</span>
              <input type="text" list={`models-${agent.id}`} value={form.model} spellCheck={false}
                onChange={(e) => setForm({ ...form, model: e.target.value })} />
              <datalist id={`models-${agent.id}`}>
                {/* agente Voz só lista modelos de fala */}
                {models.filter((m) => agent.id !== "voice" || m.speech).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </datalist>
              <span className={s.hint}>
                {modelInfo
                  ? `contexto ${ctx(modelInfo.context)} · ${usd(Number(modelInfo.pricing.prompt) * 1e6)} entrada · ${usd(Number(modelInfo.pricing.completion) * 1e6)} saída por milhão`
                  : models.length ? "Modelo fora do catálogo: escolha um id da lista." : "Carregando o catálogo de modelos"}
              </span>
            </label>
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
              <label className={`${s.check} ${s.full}`}>
                <input type="checkbox" checked={form.web_search} onChange={(e) => setForm({ ...form, web_search: e.target.checked })} />
                Busca web (:online): o modelo pode consultar a internet, cobrada por busca
              </label>
            </>}
            {agent.id === "gm" && (
              <label className={`field ${s.full}`}>
                <span>Modelo para turnos complexos (o Jev decide por turno; vazio = sempre o modelo acima)</span>
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
