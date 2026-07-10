"use client";
import { useEffect, useState } from "react";

interface SettingsShape {
  openrouter: { configured: boolean; apiKeyMasked: string };
  embeddings: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    apiKeyMasked: string;
  };
}

export default function SettingsPage() {
  const [data, setData] = useState<SettingsShape | null>(null);
  const [orKey, setOrKey] = useState("");
  const [emb, setEmb] = useState({ enabled: false, baseUrl: "", model: "", apiKey: "" });
  const [msg, setMsg] = useState("");
  const [testMsg, setTestMsg] = useState("");

  const load = () =>
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d: SettingsShape) => {
        setData(d);
        setEmb({
          enabled: d.embeddings.enabled,
          baseUrl: d.embeddings.baseUrl,
          model: d.embeddings.model,
          apiKey: "",
        });
      });
  useEffect(() => {
    load();
  }, []);

  const save = async () => {
    setMsg("salvando...");
    const body: Record<string, unknown> = { embeddings: { ...emb } };
    if (orKey.trim()) body.openrouterApiKey = orKey.trim();
    if (!emb.apiKey) delete (body.embeddings as Record<string, unknown>).apiKey;
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setMsg(res.ok ? "✓ salvo" : "erro ao salvar");
    setOrKey("");
    load();
  };

  const testOpenRouter = async () => {
    setTestMsg("testando...");
    const res = await fetch("/api/models");
    setTestMsg(res.ok ? `✓ conexão OK (${(await res.json()).length} modelos disponíveis)` : `✗ falhou: ${(await res.json()).error || res.status}`);
  };

  if (!data) return <div className="container"><p className="muted">Carregando...</p></div>;

  return (
    <div className="container" style={{ maxWidth: 680 }}>
      <h1>Configurações</h1>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>OpenRouter (provedor de IA)</h3>
        <p className="muted">
          Todos os agentes usam a API do OpenRouter.{" "}
          {data.openrouter.configured
            ? `Chave configurada: ${data.openrouter.apiKeyMasked}`
            : "Nenhuma chave configurada ainda."}
        </p>
        <label className="field">
          <span>API key (sk-or-...)</span>
          <input type="password" value={orKey} onChange={(e) => setOrKey(e.target.value)}
            placeholder={data.openrouter.configured ? "•••••• (preencha para substituir)" : "sk-or-v1-..."} />
        </label>
        <button className="btn small" onClick={testOpenRouter}>Testar conexão</button>
        {testMsg && <span className="muted" style={{ marginLeft: 10 }}>{testMsg}</span>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Embeddings (busca vetorial no pgvector)</h3>
        <p className="muted">
          O OpenRouter não oferece embeddings, então a busca semântica usa um endpoint
          OpenAI-compatível separado (ex: OpenAI text-embedding-3-small — centavos por livro).
          Sem isso, o sistema continua funcionando com busca full-text do Postgres, só menos
          &quot;esperta&quot; para consultas por significado.
        </p>
        <label className="field" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={emb.enabled} style={{ width: "auto" }}
            onChange={(e) => setEmb({ ...emb, enabled: e.target.checked })} />
          <span style={{ margin: 0 }}>Habilitar embeddings</span>
        </label>
        <label className="field">
          <span>Base URL</span>
          <input type="text" value={emb.baseUrl} onChange={(e) => setEmb({ ...emb, baseUrl: e.target.value })} />
        </label>
        <label className="field">
          <span>Modelo</span>
          <input type="text" value={emb.model} onChange={(e) => setEmb({ ...emb, model: e.target.value })} />
        </label>
        <label className="field">
          <span>API key {data.embeddings.apiKeyMasked ? `(atual: ${data.embeddings.apiKeyMasked})` : ""}</span>
          <input type="password" value={emb.apiKey} onChange={(e) => setEmb({ ...emb, apiKey: e.target.value })} />
        </label>
      </div>

      <button className="btn primary" onClick={save}>Salvar configurações</button>
      {msg && <span className="muted" style={{ marginLeft: 10 }}>{msg}</span>}
    </div>
  );
}
