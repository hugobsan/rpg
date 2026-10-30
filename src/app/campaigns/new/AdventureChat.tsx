"use client";
import { useEffect, useRef, useState } from "react";
import type { Ruleset } from "@/lib/types";
import { normalizeRuleset } from "@/lib/ruleset";
import { draftProgress, FINISH_TEXT, OPENING, type Draft, type DraftMessage } from "@/lib/adventure";
import Skeleton from "@/components/ui/Skeleton";
import s from "./AdventureChat.module.css";

interface Current { id: string; messages: DraftMessage[]; draft: Draft; done: boolean }
interface Saved { id: string; name: string | null; first: string | null; done: boolean; count: number; updated_at: string }

const fresh = (): Current => ({ id: "", messages: [OPENING], draft: {}, done: false });
// **negrito** que escapar do modelo vira destaque, sem HTML cru
const rich = (t: string) => t.split(/\*\*(.+?)\*\*/g).map((p, i) => (i % 2 ? <strong key={i}>{p}</strong> : p));

const Svg = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

/** Entrevista com o Criador de aventuras: o jogador conversa, o agente monta o ruleset por trás. */
export default function AdventureChat({ onUse }: { onUse: (rs: Ruleset) => void }) {
  const [saved, setSaved] = useState<Saved[] | null>(null);
  const [cur, setCur] = useState<Current | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [secs, setSecs] = useState(0);
  const [error, setError] = useState("");
  const [showProg, setShowProg] = useState(false);
  const [confirmDel, setConfirmDel] = useState("");
  const feed = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  // rascunhos para retomar; sem nenhum, a conversa já começa
  useEffect(() => {
    fetch("/api/adventures")
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => [])
      .then((list: Saved[]) => {
        setSaved(list);
        if (!list.length) setCur(fresh());
      });
  }, []);
  useEffect(() => {
    feed.current?.scrollTo({ top: feed.current.scrollHeight, behavior: "smooth" });
  }, [cur?.messages.length, busy]);
  useEffect(() => {
    if (!busy) return;
    setSecs(0);
    const t = setInterval(() => setSecs((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const open = async (id: string) => {
    setError("");
    const d = await fetch(`/api/adventures?id=${id}`).then((r) => r.json()).catch(() => ({ error: "Sem conexão" }));
    if (d.error) setError(d.error);
    else setCur(d);
  };
  const remove = async (id: string) => {
    setSaved((l) => (l || []).filter((x) => x.id !== id));
    await fetch(`/api/adventures?id=${id}`, { method: "DELETE" });
  };

  const send = async (raw: string) => {
    const text = raw.trim();
    if (!text || busy || !cur) return;
    const before = cur;
    setBusy(true);
    setError("");
    setInput("");
    setCur({ ...cur, messages: [...cur.messages, { role: "user", content: text }] });
    try {
      const res = await fetch("/api/adventures", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cur.id || undefined, text }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `Erro ${res.status}`);
      setCur(d);
    } catch (e) {
      // nada se perde: a mensagem volta para o campo
      setCur(before);
      setInput(text);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      requestAnimationFrame(() => area.current?.focus());
    }
  };

  const download = () => {
    if (!cur) return;
    const rs = normalizeRuleset(cur.draft);
    const url = URL.createObjectURL(new Blob([JSON.stringify(rs, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${rs.name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "aventura"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!cur) {
    if (!saved) return <div className={s.drafts} aria-busy="true"><Skeleton h={60} className="block" /><Skeleton h={60} className="block" /></div>;
    return (
      <div className={s.drafts}>
        <div className={s.draftsHead}>
          <p className="muted">Você tem aventuras começadas. Continue de onde parou ou comece outra.</p>
          <button type="button" className="btn primary small" onClick={() => setCur(fresh())}>Começar outra</button>
        </div>
        {error && <div className="error-box">{error}</div>}
        {saved.map((d) => (
          <div key={d.id} className={s.draft}>
            <div className={s.draftInfo}>
              <div className={s.draftName}>{d.name || d.first || "Sem nome ainda"}</div>
              <div className={s.draftMeta}>
                {d.done ? "pronta" : "em andamento"} · {Math.floor(d.count / 2)} {d.count < 4 ? "resposta" : "respostas"} · {new Date(d.updated_at).toLocaleDateString("pt-BR")}
              </div>
            </div>
            <button type="button" className="btn small" onClick={() => open(d.id)}>Continuar</button>
            {confirmDel === d.id
              ? <button type="button" className="btn danger small" onClick={() => remove(d.id)}>Apagar mesmo</button>
              : <button type="button" className="btn ghost small" onClick={() => setConfirmDel(d.id)} aria-label={`Apagar ${d.name || "rascunho"}`}>Apagar</button>}
          </div>
        ))}
      </div>
    );
  }

  const prog = draftProgress(cur.draft);
  const set = prog.filter((p) => p.value).length;
  const last = cur.messages[cur.messages.length - 1];
  return (
    <section className={s.wrap} aria-label="Criador de aventuras">
      <aside className={`${s.side} ${showProg ? s.open : ""}`} aria-label="O que já está definido">
        <h4 className={s.sideHead}>O que já está definido <span className={s.count}>{set} de {prog.length}</span></h4>
        <button type="button" className={s.toggle} aria-expanded={showProg} onClick={() => setShowProg(!showProg)}>
          <span>O que já está definido <span className={s.count}>{set} de {prog.length}</span></span>
        </button>
        <div className={s.bar} aria-hidden="true"><span style={{ transform: `scaleX(${set / prog.length})` }} /></div>
        <ul className={s.items}>
          {prog.map((p) => (
            <li key={p.label} className={`${s.item} ${p.value ? s.set : ""}`}>
              <span className={s.itemLabel}>{p.label}</span>
              {p.value ? <span key={p.value} className={s.itemValue}>{p.value}</span> : <span className={s.todo}>a definir</span>}
            </li>
          ))}
        </ul>
      </aside>

      <div className={s.chat}>
        <div className={s.feed} ref={feed} aria-live="polite">
          {cur.messages.map((m, i) => (
            <div key={i} className={`${s.msg} ${m.role === "user" ? s.user : s.bot}`}>
              <span className={s.who}>{m.role === "user" ? "Você" : "Criador de aventuras"}</span>
              <div className={s.text}>{rich(m.content)}</div>
              {m === last && !busy && !cur.done && !!m.choices?.length && (
                <div className={s.choices}>
                  {m.choices.map((c) => <button key={c} type="button" className={s.choice} onClick={() => send(c)}>{c}</button>)}
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div className={`${s.msg} ${s.bot}`} role="status" aria-label="O criador está pensando">
              <span className={s.who}>Criador de aventuras</span>
              <div className={`${s.text} ${s.typing}`}><i /><i /><i /></div>
              <span className={s.wait}>
                Pensando · {secs} s{secs >= 15 ? ". O modelo grátis raciocina antes de responder; pode levar até 2 minutos." : ""}
              </span>
            </div>
          )}
        </div>

        {cur.done && !busy && (
          <div className={s.ready}>
            <p><b>Aventura pronta.</b> Baixe o arquivo para guardar ou compartilhar, ou comece a campanha com ela.</p>
            <button type="button" className="btn small" onClick={download}>Baixar JSON</button>
            <button type="button" className="btn primary small" onClick={() => onUse(normalizeRuleset(cur.draft))}>Iniciar campanha com esta aventura</button>
          </div>
        )}
        {error && <div className={`error-box ${s.error}`}>{error}</div>}

        <div className={s.composer}>
          <label htmlFor="adventure-input" className="sr-only">Sua resposta</label>
          <textarea
            id="adventure-input"
            ref={area}
            rows={1}
            value={input}
            placeholder={cur.done ? "Quer mudar algo? É só dizer." : "Responda do seu jeito..."}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            disabled={busy}
          />
          {!cur.done && cur.messages.length >= 5 && (
            <button type="button" className={`btn ghost small ${s.finish}`} disabled={busy} onClick={() => send(FINISH_TEXT)}>Finalizar agora</button>
          )}
          <button type="button" className={`btn primary ${s.send}`} onClick={() => send(input)} disabled={busy || !input.trim()} aria-label="Enviar">
            <Svg d="M5 12h13M13 6l6 6-6 6" />
          </button>
        </div>
      </div>
    </section>
  );
}
