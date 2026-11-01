"use client";
import { memo, useEffect, useState, type CSSProperties } from "react";
import type { Character, Scene } from "@/lib/types";
import type { FeedItem } from "./useTurn";
import { playLine } from "../NpcModal";
import { initials, portraitUrl } from "../Portrait";
import Loader from "../ui/Loader";
import Icon from "./Icon";
import { CONTINUE_INPUT } from "@/lib/continueScene";
import { chipIcon, chipText, draftSafe, excerpt, md, narrationBlocks, PHASES, speakerColor, type Phase } from "./feedModel";
import s from "./Feed.module.css";

/** Quem pode aparecer nas falas: NPCs por nome (minúsculo) e o nome do jogador. */
export interface Cast {
  npcs: Map<string, Character>;
  player?: string;
  campaignId: string;
  onNpc: (npc: Character) => void;
}

const signed = (n: number) => (n > 0 ? `+${n}` : `−${-n}`);

function SpeakButton({ cast, npc, line }: { cast: Cast; npc: Character; line: string }) {
  const [loading, setLoading] = useState(false);
  return (
    <button className={s.speak} title="Ouvir a fala" aria-label={`Ouvir ${npc.name}`} disabled={loading}
      onClick={() => {
        setLoading(true);
        playLine(cast.campaignId, npc, line).finally(() => setLoading(false));
      }}>
      {loading ? <Loader size={14} label="Gerando a voz" /> : <Icon name="speaker" size={15} />}
    </button>
  );
}

/** Fala de personagem: monograma, nome na cor de quem fala e o botão de ouvir. */
function Say({ name, line, cast, cursor }: { name: string; line: string; cast: Cast; cursor?: boolean }) {
  const npc = cast.npcs.get(name.toLowerCase());
  const you = !npc && cast.player?.toLowerCase() === name.toLowerCase();
  const style = { "--who": you ? "var(--text-dim)" : speakerColor(name) } as CSSProperties;
  return (
    <div className={`${s.say} ${you ? s.you : ""}`} style={style}>
      {npc ? (
        <button className={s.mono} onClick={() => cast.onNpc(npc)} aria-label={`Abrir ${npc.name}`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- retrato pixel art pequeno */}
          {portraitUrl(npc) ? <img src={portraitUrl(npc)!} alt="" decoding="async" /> : initials(name)}
        </button>
      ) : (
        <span className={s.mono} aria-hidden="true">{initials(name)}</span>
      )}
      <div className={s.sayBody}>
        <div className={s.who}>
          {npc ? <button className={s.whoName} onClick={() => cast.onNpc(npc)}>{name}</button> : <span className={s.whoName}>{name}</span>}
          {npc && <SpeakButton cast={cast} npc={npc} line={line} />}
        </div>
        <p className={s.line}>
          <span dangerouslySetInnerHTML={{ __html: md(line) }} />
          {cursor && <span className={s.cursor} aria-hidden="true" />}
        </p>
      </div>
    </div>
  );
}

function Narration({ text, cast, cursor }: { text: string; cast: Cast; cursor?: boolean }) {
  const blocks = narrationBlocks(text);
  return blocks.map((b, i) => {
    const end = cursor && i === blocks.length - 1;
    const caret = end ? <span className={s.cursor} aria-hidden="true" /> : null;
    if (b.kind === "say") return <Say key={i} name={b.name} line={b.line} cast={cast} cursor={end} />;
    if (b.kind === "list")
      return (
        <ul key={i} className={s.list}>
          {b.items.map((it, j) => (
            <li key={j}><span dangerouslySetInnerHTML={{ __html: md(it) }} />{j === b.items.length - 1 && caret}</li>
          ))}
        </ul>
      );
    return <p key={i}><span dangerouslySetInnerHTML={{ __html: md(b.text) }} />{caret}</p>;
  });
}

// texto do último rascunho: a narração final que o substitui não repete a animação de entrada
let lastDraft = "";

/**
 * Narração chegando em streaming, com cursor. Fica fora do feed memoizado (muda a cada pedaço).
 * ghost: rascunho descartado (o Mestre parou para usar ferramenta), esmaecido até o novo texto chegar.
 */
export function Draft({ text, cast, ghost }: { text: string; cast: Cast; ghost?: boolean }) {
  if (!ghost) lastDraft = text;
  return (
    <div className={`msg-gm ${s.narr} ${ghost ? s.ghost : ""}`} aria-busy="true">
      <Narration text={draftSafe(text)} cast={cast} cursor={!ghost} />
    </div>
  );
}

function GmLine({ item, cast }: { item: FeedItem; cast: Cast }) {
  const [still] = useState(() => !!lastDraft && item.content.startsWith(lastDraft.slice(0, 60)));
  return (
    <div className={`msg-gm ${s.narr}${still ? ` ${s.still}` : ""}`}>
      <Narration text={item.content} cast={cast} />
    </div>
  );
}

function DiceLine({ item }: { item: FeedItem }) {
  const d = item.dice;
  if (!d) return <div className={`${s.chip} ${s.solo} ${item.outcome ? s[item.outcome] : ""}`}><Icon name="d20" size={14} />{chipText(item.content)}</div>;
  const outcome = d.dc === undefined ? null : d.success ? "ok" : "fail";
  const d20 = /^1?d20\b/i.test(d.notation);
  const verdict = d.crit === "success" ? "Sucesso crítico" : d.crit === "failure" ? "Falha crítica" : outcome === "ok" ? "Passou" : "Falhou";
  return (
    <div className={`${s.dice} ${outcome ? s[outcome] : ""} ${d.crit ? s.crit : ""}`}>
      <Icon name="d20" size={24} className={s.diceIcon} />
      <div className={s.diceMain}>
        <span className={s.diceReason}>{d.reason || "Rolagem"}</span>
        <span className={s.diceMath}>
          <span className={s.faint}>{d.notation}</span>
          <span className={s.rolls}>
            {d.rolls.map((r, i) => (
              <span key={i} className={`${s.die} ${d20 && r === 20 ? s.nat20 : d20 && r === 1 ? s.nat1 : ""}`}>{r}</span>
            ))}
          </span>
          {d.modifier ? <span>{signed(d.modifier)}</span> : null}
          <span className={s.faint}>=</span>
          <b className={s.total}>{d.total}</b>
        </span>
      </div>
      {d.dc !== undefined && (
        <div className={s.dc} title={d.dcAdjust?.length ? "CD do Mestre ajustada pelas regras da mesa" : "Dificuldade do teste"}>
          <span className={s.dcLabel}>CD</span>
          {d.baseDc !== undefined && d.dcAdjust?.length ? (
            <span className={s.dcMath}>
              {d.baseDc}
              {d.dcAdjust.map((a) => <span key={a.label} className={s.adj}>{signed(a.value)} {a.label}</span>)}
              <span className={s.faint}>=</span>
            </span>
          ) : null}
          <b className={s.dcValue}>{d.dc}</b>
        </div>
      )}
      {outcome && <span className={s.verdict}>{verdict}</span>}
    </div>
  );
}

const CHIP_LIMIT = 4;

/** Ações do Mestre seguidas, compactas; muitas de uma vez dobram num "+N". */
function ChipGroup({ items }: { items: FeedItem[] }) {
  const [open, setOpen] = useState(false);
  const shown = open || items.length <= CHIP_LIMIT ? items : items.slice(0, CHIP_LIMIT - 1);
  return (
    <div className={s.chips}>
      {shown.map((c) => (
        <span key={c.key} className={s.chip}><Icon name={chipIcon(c)} size={13} />{chipText(c.content)}</span>
      ))}
      {shown.length < items.length && (
        <button className={`${s.chip} ${s.more}`} onClick={() => setOpen(true)}>+{items.length - shown.length} ações do Mestre</button>
      )}
    </div>
  );
}

/** Item do feed; memo: o streaming re-renderiza a tela a cada pedaço e os itens antigos não mudam. */
export const FeedLine = memo(function FeedLine({ item, chips, cast }: { item?: FeedItem; chips?: FeedItem[]; cast: Cast }) {
  if (chips) return <ChipGroup items={chips} />;
  if (!item) return null;
  // o "Continuar" é ação interna: fica no feed (o gerar novamente corta a partir dela), mas não aparece
  if (item.kind === "player") return item.content === CONTINUE_INPUT ? null : <div className="msg-player">{item.content}</div>;
  if (item.kind === "dice") return <DiceLine item={item} />;
  if (item.kind === "chip") return <ChipGroup items={[item]} />;
  return <GmLine item={item} cast={cast} />;
});

/** Sua última mensagem em edição: Enter salva (desfaz o turno e o Mestre responde ao texto novo), Esc cancela. */
export function EditLine({ text, onSave, onCancel }: { text: string; onSave: (t: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(text);
  const save = () => value.trim() && onSave(value);
  return (
    <div className={s.editLine}>
      <textarea className="msg-player" autoFocus value={value} aria-label="Editar sua última mensagem"
        rows={Math.min(10, value.split("\n").length + 1)}
        onFocus={(e) => e.currentTarget.setSelectionRange(value.length, value.length)}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            save();
          }
        }} />
      <div className={s.editActions}>
        <button className="btn ghost small" onClick={onCancel}>Cancelar</button>
        <button className="btn primary small" disabled={!value.trim()} onClick={save}>Salvar e gerar</button>
      </div>
    </div>
  );
}

/** Opções do turno como cartões; teclas 1 a 9 escolhem (fora de campo de texto e sem modal aberto). */
export function Choices({ choices, onPick, onEdit }: { choices: string[]; onPick: (c: string) => void; onEdit: (c: string) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector("[aria-modal='true'], .modal-backdrop, .viewer")) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= Math.min(9, choices.length)) {
        e.preventDefault();
        onPick(choices[n - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [choices, onPick]);
  return (
    <div className={s.choices} role="group" aria-label="Opções">
      {choices.map((c, i) => (
        <div key={i} className={s.choice} style={{ animationDelay: `${i * 50}ms` }}>
          <button className={s.choiceMain} onClick={() => onPick(c)}>
            {i < 9 && <kbd className={s.key}>{i + 1}</kbd>}
            <span>{c}</span>
          </button>
          <button className={s.choiceEdit} onClick={() => onEdit(c)} title="Editar antes de enviar" aria-label="Editar esta opção antes de enviar">
            <Icon name="edit" size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}

const PHASE_TEXT: Record<Phase, string> = {
  think: "O Mestre está pensando",
  consult: "Consultando memórias e livros",
  dice: "Rolando os dados",
  write: "O Mestre está escrevendo",
};

/** Espera do turno: selo do tema, o status do servidor, as fases já vistas e o tempo correndo. */
export function TurnWait({ status, phases }: { status: string; phases: Phase[] }) {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSec((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const now = phases[phases.length - 1] ?? "think";
  const text = (status || PHASE_TEXT[now]).replace(/\.+$/, "");
  return (
    <div className={s.wait} aria-live="polite">
      <Loader size={34} label={text} />
      <div className={s.waitBody}>
        <div className={s.waitText}>{text}<span className={`num ${s.faint}`}> · {sec} s</span></div>
        <ol className={s.steps} aria-label="Fases do turno">
          {PHASES.map((p) => (
            <li key={p.key} data-state={p.key === now ? "now" : phases.includes(p.key) ? "done" : "todo"}>{p.label}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** "Anteriormente...": retomada ao abrir uma campanha com histórico. Sem IA: resumo da cena + fim da última narração. */
export function Recap({ name, scene, last, onClose }: { name: string; scene: Scene; last?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector("[aria-modal='true']") && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <section className={s.recap} aria-label="Anteriormente">
      <button className={s.recapClose} onClick={onClose} aria-label="Fechar a retomada"><Icon name="close" size={15} /></button>
      <span className="overline">Anteriormente em {name}</span>
      <h2 className={s.recapTitle}>{[scene.title, scene.location].filter(Boolean).join(" · ") || "Cena atual"}</h2>
      {scene.summary && <p className={s.recapSummary}>{excerpt(scene.summary, 420)}</p>}
      {last && <p className={s.recapLast}>{excerpt(last)}</p>}
      <button className="btn primary small" onClick={onClose}>Continuar</button>
    </section>
  );
}
