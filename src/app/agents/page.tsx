"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { AgentConfig } from "@/lib/types";
import dynamic from "next/dynamic";

// o diagrama (React Flow, pesado) vem em pedaço separado, depois da página; o card vazio guarda o lugar
const AgentsDiagram = dynamic(() => import("./AgentsDiagram"), {
  ssr: false,
  loading: () => <div className="card" style={{ marginBottom: 14, minHeight: 56 }} />,
});

interface Model {
  id: string;
  name: string;
  context: number;
  pricing: { prompt: string; completion: string };
  speech: boolean;
  voices: string[] | null;
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/agents").then((r) => r.json()).then(setAgents);
    fetch("/api/models")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => Array.isArray(d) && setModels(d))
      .catch(() => {});
  }, []);

  return (
    <div className="container">
      <h1>Agentes</h1>
      <p className="muted">
        Cada agente é um conjunto de modelo + system prompt + parâmetros. Edite à vontade — toda
        chamada ao OpenRouter fica registrada (tokens, custo, duração, request e resposta) e aparece
        em <Link href="/usage">Custos e uso</Link>, para você avaliar e trocar modelos/prompts depois.
      </p>
      <AgentsDiagram />
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
  );
}

function AgentCard({
  agent,
  models,
  open,
  onToggle,
  onSaved,
}: {
  agent: AgentConfig;
  models: Model[];
  open: boolean;
  onToggle: () => void;
  onSaved: (a: AgentConfig) => void;
}) {
  const [form, setForm] = useState(agent);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [savedAt, setSavedAt] = useState(0);

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
    });
    if (res.ok) {
      onSaved(await res.json());
      setSavedAt(Date.now());
    } else {
      setSaveError((await res.json().catch(() => null))?.error || `Erro ${res.status} ao salvar`);
    }
    setSaving(false);
  };

  const modelInfo = models.find((m) => m.id === form.model);
  const noPrompt = agent.id === "decider" || agent.id === "voice";

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={onToggle}>
        <h3 style={{ margin: 0, flex: 1 }}>
          {agent.name} <span className="pill">{agent.id}</span>
          {agent.web_search && <span className="pill on">web</span>}
        </h3>
        <span className="muted">
          {agent.model}
          {agent.pricing && (
            <> · ${agent.pricing.input}/M in · ${agent.pricing.output}/M out
              {agent.pricing.cache_read != null && <> · ${agent.pricing.cache_read}/M cache</>}
              {" "}· ctx {Math.round(agent.pricing.context / 1000)}k</>
          )}
        </span>
        <span className="muted">{open ? "▲" : "▼"}</span>
      </div>
      <p className="muted" style={{ margin: "6px 0 0" }}>{agent.description}</p>

      {open && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 10 }}>
            <label className="field">
              <span>Modelo (OpenRouter)</span>
              <input
                type="text" list={`models-${agent.id}`} value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
              />
              <datalist id={`models-${agent.id}`}>
                {/* agente Voz só lista modelos de fala */}
                {models.filter((m) => agent.id !== "voice" || m.speech).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </datalist>
              {modelInfo && (
                <span className="muted">
                  ctx {Math.round(modelInfo.context / 1000)}k · ${Number(modelInfo.pricing.prompt) * 1e6}/M in · ${Number(modelInfo.pricing.completion) * 1e6}/M out
                </span>
              )}
            </label>
            {/* Jev e Voz só usam o modelo: sem temperatura, tokens, web ou prompt */}
            {!noPrompt && <>
            <label className="field">
              <span>Temperatura</span>
              <input type="number" step={0.1} min={0} max={2} value={form.temperature}
                onChange={(e) => setForm({ ...form, temperature: Number(e.target.value) })} />
            </label>
            <label className="field">
              <span>Max tokens</span>
              <input type="number" step={100} value={form.max_tokens}
                onChange={(e) => setForm({ ...form, max_tokens: Number(e.target.value) })} />
            </label>
            <label className="field" style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 18 }}>
              <input type="checkbox" checked={form.web_search} style={{ width: "auto" }}
                onChange={(e) => setForm({ ...form, web_search: e.target.checked })} />
              <span style={{ margin: 0 }}>Busca web (:online)</span>
            </label>
            </>}
          </div>
          {agent.id === "gm" && (
            <label className="field">
              <span>Modelo para turnos complexos (o Jev decide por turno; vazio = sempre o modelo acima)</span>
              <input
                type="text" list={`models-${agent.id}`}
                value={String(form.params.complexModel ?? "")}
                onChange={(e) => setForm({ ...form, params: { ...form.params, complexModel: e.target.value } })}
              />
            </label>
          )}
          {agent.id === "voice" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {([["maleVoice", "Voz masculina padrão"], ["femaleVoice", "Voz feminina padrão"]] as const).map(([k, label]) => (
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
            </div>
          )}
          {!noPrompt && (
            <label className="field">
              <span>System prompt</span>
              <textarea rows={12} value={form.system_prompt}
                onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
                style={{ fontFamily: "var(--mono)", fontSize: 12.5 }} />
            </label>
          )}
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving ? "salvando..." : "Salvar agente"}
          </button>
          {saveError && <div className="error-box" style={{ marginTop: 10 }}>{saveError}</div>}
          {savedAt > 0 && Date.now() - savedAt < 4000 && <span className="pill on" style={{ marginLeft: 10 }}>salvo ✓</span>}

          <div style={{ marginTop: 16 }}>
            <Link href={`/usage?agent=${agent.id}`}>Ver custos e uso deste agente →</Link>
          </div>
        </div>
      )}
    </div>
  );
}
