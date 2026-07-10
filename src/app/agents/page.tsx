"use client";
import { Fragment, useEffect, useState } from "react";
import type { AgentConfig } from "@/lib/types";

interface LogRow {
  id: number;
  campaign_id: string | null;
  model: string;
  purpose: string;
  request: unknown;
  response: unknown;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
}

interface Model {
  id: string;
  name: string;
  context: number;
  pricing: { prompt: string; completion: string };
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
        chamada ao OpenRouter fica registrada no histórico do agente (tokens, duração, request e
        resposta), para você avaliar e trocar modelos/prompts depois.
      </p>
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
  const [logs, setLogs] = useState<LogRow[] | null>(null);
  const [expandedLog, setExpandedLog] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);

  useEffect(() => {
    if (open && logs === null)
      fetch(`/api/agents/${agent.id}/logs`).then((r) => r.json()).then(setLogs);
  }, [open, logs, agent.id]);

  const save = async () => {
    setSaving(true);
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
      }),
    });
    if (res.ok) {
      onSaved(await res.json());
      setSavedAt(Date.now());
    }
    setSaving(false);
  };

  const modelInfo = models.find((m) => m.id === form.model);

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={onToggle}>
        <h3 style={{ margin: 0, flex: 1 }}>
          {agent.name} <span className="pill">{agent.id}</span>
          {agent.web_search && <span className="pill on">web</span>}
        </h3>
        <span className="muted">{agent.model}</span>
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
                {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </datalist>
              {modelInfo && (
                <span className="muted">
                  ctx {Math.round(modelInfo.context / 1000)}k · ${Number(modelInfo.pricing.prompt) * 1e6}/M in · ${Number(modelInfo.pricing.completion) * 1e6}/M out
                </span>
              )}
            </label>
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
          </div>
          <label className="field">
            <span>System prompt</span>
            <textarea rows={12} value={form.system_prompt}
              onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
              style={{ fontFamily: "var(--mono)", fontSize: 12.5 }} />
          </label>
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving ? "salvando..." : "Salvar agente"}
          </button>
          {savedAt > 0 && Date.now() - savedAt < 4000 && <span className="pill on" style={{ marginLeft: 10 }}>salvo ✓</span>}

          <h4 style={{ margin: "20px 0 8px" }}>Histórico de chamadas (OpenRouter)</h4>
          {logs === null && <p className="muted">Carregando...</p>}
          {logs?.length === 0 && <p className="muted">Nenhuma chamada registrada ainda.</p>}
          {logs && logs.length > 0 && (
            <table className="plain">
              <thead>
                <tr><th>Quando</th><th>Propósito</th><th>Modelo</th><th>Tokens (in/out)</th><th>Duração</th><th>Status</th></tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <Fragment key={l.id}>
                    <tr style={{ cursor: "pointer" }}
                        onClick={() => setExpandedLog(expandedLog === l.id ? null : l.id)}>
                      <td>{new Date(l.created_at).toLocaleString("pt-BR")}</td>
                      <td>{l.purpose}</td>
                      <td>{l.model}</td>
                      <td>{l.prompt_tokens ?? "-"} / {l.completion_tokens ?? "-"}</td>
                      <td>{l.duration_ms ? `${(l.duration_ms / 1000).toFixed(1)}s` : "-"}</td>
                      <td>{l.error ? <span className="pill err">erro</span> : <span className="pill on">ok</span>}</td>
                    </tr>
                    {expandedLog === l.id && (
                      <tr>
                        <td colSpan={6}>
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
          )}
        </div>
      )}
    </div>
  );
}
