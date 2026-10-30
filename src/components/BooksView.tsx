"use client";
import { useState } from "react";

export default function BooksView({
  campaignId,
  books,
  onChange,
}: {
  campaignId: string;
  books: { id: string; title: string; pages: number }[];
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const upload = async (f: File) => {
    setBusy(true);
    setMsg("Indexando (páginas + chunks + embeddings)...");
    const fd = new FormData();
    fd.append("file", f);
    fd.append("title", f.name.replace(/\.\w+$/, ""));
    const res = await fetch(`/api/campaigns/${campaignId}/books`, { method: "POST", body: fd });
    const data = await res.json();
    setBusy(false);
    setMsg(res.ok ? `✓ ${data.pages} páginas, ${data.chunks} chunks indexados.` : `Erro: ${data.error}`);
    onChange();
  };
  return (
    <div>
      {books.map((b) => (
        <div key={b.id} className="ability-item">
          <div className="name">📖 {b.title}</div>
          <div className="sub">{b.pages} páginas indexadas</div>
        </div>
      ))}
      {books.length === 0 && <p className="muted">Nenhum material indexado. O Mestre consulta livros via busca semântica e leitura de páginas.</p>}
      <input
        type="file"
        accept=".pdf,.txt,.md"
        disabled={busy}
        onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
        style={{ marginTop: 8 }}
      />
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}
