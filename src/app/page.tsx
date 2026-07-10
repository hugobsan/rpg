"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface Row {
  id: string;
  name: string;
  style: string;
  ruleset_name: string;
  message_count: string;
  updated_at: string;
}

const STYLE_LABEL: Record<string, string> = {
  open: "Aberta",
  hybrid: "Híbrida",
  guided: "Guiada",
};

export default function Home() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const router = useRouter();

  const load = () =>
    fetch("/api/campaigns")
      .then((r) => r.json())
      .then(setRows)
      .catch(() => setRows([]));
  useEffect(() => {
    load();
  }, []);

  const del = async (e: React.MouseEvent, id: string, name: string) => {
    e.preventDefault();
    if (!confirm(`Excluir a campanha "${name}"? Todo o histórico será perdido.`)) return;
    await fetch(`/api/campaigns/${id}`, { method: "DELETE" });
    load();
  };

  return (
    <div className="container">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Suas campanhas</h1>
        <button className="btn primary" onClick={() => router.push("/campaigns/new")}>
          + Nova campanha
        </button>
      </div>
      {rows === null && <p className="muted">Carregando...</p>}
      {rows?.length === 0 && (
        <div className="card" style={{ textAlign: "center", padding: 48 }}>
          <h2 style={{ marginTop: 0 }}>Nenhuma campanha ainda</h2>
          <p className="muted">
            Crie sua primeira campanha — o preset de Naruto já vem pronto, ou importe a
            mecânica de qualquer cenário em JSON.
          </p>
          <Link href="/campaigns/new" className="btn primary" style={{ display: "inline-block" }}>
            Começar aventura
          </Link>
        </div>
      )}
      {rows?.map((c) => (
        <Link key={c.id} href={`/campaign/${c.id}`} className="campaign-card">
          <h3>{c.name}</h3>
          <span className="pill">{c.ruleset_name}</span>
          <span className="pill">{STYLE_LABEL[c.style] || c.style}</span>
          <span className="pill">{c.message_count} mensagens</span>
          <button
            className="btn ghost small"
            style={{ float: "right" }}
            onClick={(e) => del(e, c.id, c.name)}
          >
            excluir
          </button>
        </Link>
      ))}
    </div>
  );
}
