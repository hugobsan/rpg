"use client";
import { useEffect, useState } from "react";

interface SettingsShape {
  openrouter: { configured: boolean; apiKeyMasked: string };
  embeddings: { enabled: boolean; model: string };
}

export default function SettingsPage() {
  const [data, setData] = useState<SettingsShape | null>(null);
  const [orKey, setOrKey] = useState("");
  const [emb, setEmb] = useState({ enabled: false, model: "" });
  const [msg, setMsg] = useState("");
  const [testMsg, setTestMsg] = useState("");
  const [reMsg, setReMsg] = useState("");
  const [reRunning, setReRunning] = useState(false);

  const load = () =>
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d: SettingsShape) => {
        setData(d);
        setEmb(d.embeddings);
      });
  useEffect(() => {
    load();
  }, []);

  const save = async () => {
    setMsg("salvando...");
    const body: Record<string, unknown> = { embeddings: emb };
    if (orKey.trim()) body.openrouterApiKey = orKey.trim();
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

  const reprocess = async () => {
    // reprocessa com o modelo salvo no banco, não com o que está na tela
    if (emb.enabled !== data?.embeddings.enabled || emb.model !== data?.embeddings.model)
      return setReMsg("✗ salve as configurações antes de reprocessar");
    setReRunning(true);
    setReMsg("reprocessando... (pode demorar)");
    try {
      const res = await fetch("/api/embeddings/reprocess", { method: "POST" });
      const d = await res.json();
      const n = `${d.memories ?? 0} memórias e ${d.book_chunks ?? 0} trechos`;
      setReMsg(res.ok ? `✓ ${n} reprocessados` : `✗ ${d.error || res.status}${d.memories !== undefined ? ` (${n} reprocessados; o restante ficou sem embedding)` : ""}`);
    } catch {
      setReMsg("✗ falha na requisição");
    }
    setReRunning(false);
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
        <label className="field" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={emb.enabled} style={{ width: "auto" }}
            onChange={(e) => setEmb({ ...emb, enabled: e.target.checked })} />
          <span style={{ margin: 0 }}>Habilitar embeddings</span>
        </label>
        <label className="field">
          <span>Modelo</span>
          <input type="text" value={emb.model} onChange={(e) => setEmb({ ...emb, model: e.target.value })} />
        </label>
        <p className="muted" style={{ marginBottom: 0 }}>
          ⚠ Trocar o modelo exige reprocessar os embeddings já gerados (memórias e livros):
          vetores de modelos diferentes não são comparáveis.
        </p>
        <button className="btn small" style={{ marginTop: 10 }} onClick={reprocess} disabled={reRunning}>
          Reprocessar embeddings
        </button>
        {reMsg && <span className="muted" style={{ marginLeft: 10 }}>{reMsg}</span>}
      </div>

      <button className="btn primary" onClick={save}>Salvar configurações</button>
      {msg && <span className="muted" style={{ marginLeft: 10 }}>{msg}</span>}
    </div>
  );
}
