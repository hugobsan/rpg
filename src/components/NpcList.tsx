"use client";
import { useState } from "react";
import type { Character, InboxItem } from "@/lib/types";
import { toast } from "./ui/Toast";
import Portrait from "./Portrait";
import s from "./NpcList.module.css";

export { initials } from "./Portrait";

/** Retrato do NPC (ou o monograma, sem retrato) na moldura do tema; com `unread`, o número de mensagens não lidas. */
export function NpcAvatar({ npc, unread, size }: { npc: Parameters<typeof Portrait>[0]["char"]; unread?: number; size?: number }) {
  return (
    <Portrait char={npc} size={size}>
      {!!unread && <span className={s.badge}>{unread}</span>}
    </Portrait>
  );
}

/** "agora", "há 5 min", "há 2 h", "ontem"... (hora real, não do jogo). */
export function ago(at: string): string {
  const t = Date.parse(at.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  if (!Number.isFinite(t)) return "";
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  if (min < 24 * 60) return `há ${Math.round(min / 60)} h`;
  return min < 48 * 60 ? "ontem" : new Date(t).toLocaleDateString("pt-BR");
}

const Exit = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 4h5v16h-5" /><path d="M10 8l-4 4 4 4M6 12h9" />
  </svg>
);
const Enter = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 4h5v16h-5" /><path d="M9 8l4 4-4 4M13 12H4" />
  </svg>
);

/**
 * Aba NPCs. Com `campaignId` + `onChange`, cada linha ganha o tirar/trazer para a cena e aparece o "esvaziar cena".
 * `inbox` (state.inbox) mostra as mensagens particulares não lidas; clicar abre o NPC já na conversa dele.
 */
export default function NpcList({
  npcs,
  onOpen,
  campaignId,
  inbox = [],
  onChange,
}: {
  npcs: Character[];
  onOpen: (c: Character) => void;
  campaignId?: string;
  inbox?: InboxItem[];
  onChange?: () => void; // depois de tirar/trazer NPC: a tela recarrega o estado
}) {
  const [busy, setBusy] = useState<string[]>([]);
  const [clearing, setClearing] = useState(false);
  const active = npcs.filter((n) => n.active);
  const inactive = npcs.filter((n) => !n.active);
  const unread = (n: Character) => inbox.find((m) => m.npcId === n.id);
  const canEdit = !!campaignId && !!onChange;

  const setActive = async (list: Character[], on: boolean) => {
    setBusy((b) => [...b, ...list.map((n) => n.id)]);
    try {
      const res = await Promise.all(
        list.map((n) =>
          fetch(`/api/campaigns/${campaignId}/npcs/${n.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ active: on }),
          })
        )
      );
      if (res.some((r) => !r.ok)) toast("Não deu para mudar quem está em cena.", { kind: "alerta" });
      else if (list.length > 1) toast(`${list.length} NPCs saíram de cena.`);
      else toast(on ? `${list[0].name} entrou na cena.` : `${list[0].name} saiu de cena.`);
      onChange?.();
    } finally {
      setBusy((b) => b.filter((id) => !list.some((n) => n.id === id)));
      setClearing(false);
    }
  };

  const row = (n: Character, i: number) => {
    const m = unread(n);
    return (
      <div key={n.id} className={`${s.row}${n.active ? "" : ` ${s.off}`}${m ? ` ${s.unread}` : ""}`}
        style={{ animationDelay: `${Math.min(i, 10) * 25}ms` }}>
        <button type="button" className={s.open} onClick={() => onOpen(n)}
          aria-label={`${n.name}${m ? `, ${m.unread} mensagem${m.unread > 1 ? "s" : ""} não lida${m.unread > 1 ? "s" : ""}` : ""}`}>
          <NpcAvatar npc={n} unread={m?.unread} />
          <span className={s.info}>
            <span className={s.nm}>{n.name}{n.canon && <span className={s.canon}>cânone</span>}</span>
            {m ? (
              <span className={s.preview}>&ldquo;{m.preview}&rdquo;</span>
            ) : (
              <span className={s.sub}>{n.persona.personality || n.persona.appearance || "sem descrição ainda"}</span>
            )}
          </span>
        </button>
        {canEdit && (
          <button type="button" className={s.quick} disabled={busy.includes(n.id)}
            title={n.active ? "Tirar de cena" : "Trazer para a cena"} aria-label={n.active ? `Tirar ${n.name} de cena` : `Trazer ${n.name} para a cena`}
            onClick={() => setActive([n], !n.active)}>
            {n.active ? <Exit /> : <Enter />}
          </button>
        )}
      </div>
    );
  };

  const messages = inbox.map((m) => ({ m, n: npcs.find((n) => n.id === m.npcId) })).filter((x) => x.n);

  if (!npcs.length)
    return (
      <div className={s.wrap}>
        <p className={s.none}>
          Ninguém registrado ainda. Os personagens que você conhecer na história aparecem aqui, e dá para conversar com cada um em particular.
        </p>
      </div>
    );

  return (
    <div className={s.wrap}>
      {messages.length > 0 && (
        <section className={s.inbox} aria-label="Mensagens particulares">
          <div className={s.head}><h4>Mensagens <span className="num">{messages.length}</span></h4></div>
          {messages.map(({ m, n }) => (
            <button key={m.sessionId} type="button" className={s.msg} onClick={() => onOpen(n!)}>
              <NpcAvatar npc={n!} unread={m.unread} />
              <span className={s.msgBody}>
                <span className={s.msgTop}><b>{n!.name}</b><span>{ago(m.at)}</span></span>
                <span className={s.msgText}>{m.preview}</span>
                <span className={s.reply}>Abrir conversa</span>
              </span>
            </button>
          ))}
        </section>
      )}

      <div className={s.head}>
        <h4><span className={s.live} aria-hidden="true" /> Em cena <span className="num">{active.length}</span></h4>
        {canEdit && active.length > 1 && !clearing && (
          <button className="btn ghost small" onClick={() => setClearing(true)}>Esvaziar cena</button>
        )}
      </div>
      {clearing && (
        <div className={s.confirm}>
          <span>Tirar os {active.length} de cena? O Mestre passa a considerar que não estão por perto.</span>
          <button className="btn small" onClick={() => setActive(active, false)}>Tirar todos</button>
          <button className="btn ghost small" onClick={() => setClearing(false)}>Cancelar</button>
        </div>
      )}
      {active.length ? active.map(row) : <p className={s.none}>Ninguém por perto.</p>}

      {inactive.length > 0 && (
        <>
          <div className={s.head}><h4>Fora de cena <span className="num">{inactive.length}</span></h4></div>
          {inactive.map(row)}
        </>
      )}
    </div>
  );
}
