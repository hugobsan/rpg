"use client";
import { useState } from "react";
import Loader from "./ui/Loader";
import { toast } from "./ui/Toast";
import s from "./SidePanels.module.css";

const BookIcon = ({ size = 18 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z" /><path d="M4 19a2 2 0 0 1 2-2h13" /><path d="M9 7h6" />
  </svg>
);

/** Envio com XHR para mostrar o progresso do upload; a indexação no servidor vem depois, sem progresso. */
function send(url: string, fd: FormData, onProgress: (p: number) => void): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.open("POST", url);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      let data = {};
      try { data = JSON.parse(x.responseText); } catch {}
      resolve({ ok: x.status >= 200 && x.status < 300, data });
    };
    x.onerror = () => resolve({ ok: false, data: { error: "Falha de rede ao enviar o arquivo." } });
    x.send(fd);
  });
}

export default function BooksView({
  campaignId,
  books,
  onChange,
}: {
  campaignId: string;
  books: { id: string; title: string; pages: number }[];
  onChange: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "upload" | "index">("idle");
  const [progress, setProgress] = useState(0);
  const [name, setName] = useState("");
  const [over, setOver] = useState(false);
  const [error, setError] = useState("");
  const busy = phase !== "idle";

  const upload = async (f: File) => {
    if (busy) return;
    if (!/\.(pdf|txt|md)$/i.test(f.name)) return setError("Use um arquivo PDF, TXT ou MD.");
    setError("");
    setName(f.name);
    setProgress(0);
    setPhase("upload");
    const fd = new FormData();
    fd.append("file", f);
    fd.append("title", f.name.replace(/\.\w+$/, ""));
    const { ok, data } = await send(`/api/campaigns/${campaignId}/books`, fd, (p) => {
      setProgress(p);
      if (p >= 1) setPhase("index");
    });
    setPhase("idle");
    if (!ok) return setError(String(data.error || "Não deu para indexar o arquivo."));
    toast(`${data.pages} páginas e ${data.chunks} trechos indexados.`, { kind: "sucesso", title: f.name });
    onChange();
  };

  return (
    <div className={s.wrap}>
      <p className={s.note}>
        Livros e anotações do cenário. O Mestre busca trechos por significado e lê páginas inteiras quando precisa conferir algo.
      </p>
      {books.length > 0 && (
        <div className={s.head}><h4>Na estante</h4><span className={s.count}>{books.length}</span></div>
      )}
      {books.map((b) => (
        <div key={b.id} className={s.card}>
          <div className={s.row}>
            <span className={s.icon}><BookIcon /></span>
            <div className={s.grow}>
              <div className={s.title}>{b.title}</div>
              <div className={s.sub}>{b.pages} páginas indexadas</div>
            </div>
          </div>
        </div>
      ))}
      <label
        className={`${s.drop}${over ? ` ${s.over}` : ""}${busy ? ` ${s.busy}` : ""}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) upload(f);
        }}
        aria-busy={busy}
      >
        <input type="file" accept=".pdf,.txt,.md" disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) upload(f); }} />
        {phase === "idle" ? (
          <>
            <BookIcon size={26} />
            <b>{over ? "Solte para indexar" : "Arraste um livro aqui"}</b>
            <span>ou toque para escolher · PDF, TXT ou MD</span>
          </>
        ) : (
          <>
            <Loader size={30} label={phase === "upload" ? "Enviando" : "Indexando"} />
            <b>{phase === "upload" ? `Enviando ${name}` : `Indexando ${name}`}</b>
            <span>{phase === "upload" ? `${Math.round(progress * 100)}%` : "lendo páginas, separando trechos e gerando a busca. Pode levar alguns minutos."}</span>
            {phase === "upload" && <div className={s.progress}><span style={{ transform: `scaleX(${progress})` }} /></div>}
          </>
        )}
      </label>
      {error && <div className="error-box">{error}</div>}
    </div>
  );
}
