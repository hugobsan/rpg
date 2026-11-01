"use client";
import { useEffect, useRef, useState } from "react";
import Skeleton from "./ui/Skeleton";
import s from "./OocModal.module.css";

interface Note { id: number; role: "player" | "gm"; content: string }
interface Directive { id: number; subject: string; content: string }

const IDEAS = [
  "Quero menos combate e mais investigação.",
  "Deixe os testes mais difíceis.",
  "Na próxima cena quero treinar.",
  "O que meu personagem já sabe sobre isso?",
];

const Svg = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

/** Conversa fora do jogo com o Mestre: o jogador fala como ele mesmo; nada disso entra na história. */
export default function OocModal({
  campaignId,
  onClose,
  onChanged,
}: {
  campaignId: string;
  onClose: () => void;
  onChanged?: () => void; // o Mestre mudou o jogo (ficha, missões, regras da mesa...): a tela recarrega o estado
}) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [directives, setDirectives] = useState<Directive[] | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [clearing, setClearing] = useState(false); // confirmação inline do "Limpar conversa"
  const feedRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const load = async () => {
    const d = await fetch(`/api/campaigns/${campaignId}/ooc`).then((r) => r.json()).catch(() => ({}));
    setNotes(d.notes || []);
    setDirectives(d.directives || []);
  };
  useEffect(() => {
    load();
  }, [campaignId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [notes, busy]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    setInput("");
    setNotes((n) => [...n, { id: -Date.now(), role: "player", content: text }]);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/ooc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) setError(d.error || `Erro ${res.status}`);
      if (d.changed) onChanged?.();
      await load();
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const clear = async () => {
    setClearing(false);
    const res = await fetch(`/api/campaigns/${campaignId}/ooc?notes=all`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) return setError("Não deu para limpar a conversa. Tente de novo.");
    setNotes([]);
    setError("");
    inputRef.current?.focus();
  };

  // otimista: sai na hora; se o DELETE falhar, volta para o mesmo lugar com o erro
  const removeDirective = async (id: number) => {
    const at = directives?.findIndex((d) => d.id === id) ?? -1;
    const gone = at >= 0 ? directives![at] : null;
    setDirectives((ds) => (ds || []).filter((d) => d.id !== id));
    const res = await fetch(`/api/campaigns/${campaignId}/ooc?directive=${id}`, { method: "DELETE" }).catch(() => null);
    if (res?.ok || !gone) return;
    setDirectives((ds) => {
      const next = [...(ds || [])];
      next.splice(Math.min(at, next.length), 0, gone);
      return next;
    });
    setError("Não deu para remover a diretriz. Tente de novo.");
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal ${s.modal}`} role="dialog" aria-modal="true" aria-label="Falar com o Mestre fora do jogo"
        onClick={(e) => e.stopPropagation()}>
        <div className={s.head}>
          <span className={s.badge}><Svg d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0" /></span>
          <div className={s.title}>
            <h3>Falar com o Mestre <span className={s.tag}>fora do jogo</span></h3>
            <p>Você fala como jogador, não como personagem. Nada disso aparece na história.</p>
          </div>
          {notes.length > 0 && !busy && (clearing ? (
            <span className={s.clearAsk} role="group" aria-label="Confirmar limpeza da conversa">
              <span>Apagar a conversa? As diretrizes continuam.</span>
              <button className="btn danger small" onClick={clear}>Limpar</button>
              <button className="btn ghost small" onClick={() => setClearing(false)} autoFocus>Cancelar</button>
            </span>
          ) : (
            <button className={`btn ghost small ${s.clear}`} onClick={() => setClearing(true)}>Limpar conversa</button>
          ))}
          <button className={s.close} onClick={onClose} aria-label="Fechar"><Svg d="M6 6l12 12M18 6 6 18" /></button>
        </div>

        <div className={s.grid}>
          <section className={s.rules} aria-label="Diretrizes ativas">
            <h4>Diretrizes ativas <span>{directives?.length ?? ""}</span></h4>
            {!directives && <div aria-busy="true"><Skeleton h={52} className="block" /><Skeleton h={52} className="block" style={{ marginTop: 6 }} /></div>}
            {directives && !directives.length && (
              <p className={s.none}>Nenhuma por enquanto. Pedidos como &quot;menos combate&quot; viram diretrizes que o Mestre segue a partir do próximo turno.</p>
            )}
            {!!directives?.length && (
              <ol>
                {directives.map((d) => (
                  <li key={d.id} className={s.rule}>
                    <span>
                      {d.content}
                      {d.subject === "proxima_cena" && <span className={s.scope}>vale nesta cena e na próxima</span>}
                    </span>
                    <button className={s.remove} data-tip="Desativar esta diretriz" data-tip-align="end" aria-label={`Desativar: ${d.content}`}
                      onClick={() => removeDirective(d.id)}>
                      <Svg d="M6 6l12 12M18 6 6 18" size={14} />
                    </button>
                  </li>
                ))}
              </ol>
            )}
            <p className={s.tip}>Perguntas são respondidas sem spoilers. O Mestre também ajusta a dificuldade dos testes e corrige a ficha se você pedir.</p>
          </section>

          <section className={s.chat}>
            <div className={s.feed} ref={feedRef} aria-live="polite">
              {!notes.length && !busy && (
                <div className={s.start}>
                  <p>Peça um ajuste, tire uma dúvida sobre as regras ou combine o que quer ver na história.</p>
                  <div className={s.ideas}>
                    {IDEAS.map((t) => (
                      <button key={t} className={s.idea} onClick={() => { setInput(t); inputRef.current?.focus(); }}>{t}</button>
                    ))}
                  </div>
                </div>
              )}
              {notes.map((n) => (
                <div key={n.id} className={`${s.msg} ${n.role === "player" ? s.player : s.gm}`}>
                  <span className={s.who}>{n.role === "player" ? "Você" : "Mestre"}</span>
                  <div className={s.text}>{n.content}</div>
                </div>
              ))}
              {busy && (
                <div className={`${s.msg} ${s.gm}`}>
                  <span className={s.who}>Mestre</span>
                  <div className={`${s.text} ${s.typing}`} role="status" aria-label="O Mestre está respondendo"><i /><i /><i /></div>
                </div>
              )}
            </div>
            {error && <div className={`error-box ${s.error}`}>{error}</div>}
            <div className={s.composer}>
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                placeholder="Fale com o Mestre como jogador..."
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                disabled={busy}
              />
              <button className={`btn ${s.send}`} onClick={send} disabled={busy || !input.trim()} aria-label="Enviar">
                <Svg d="M5 12h13M13 6l6 6-6 6" />
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
