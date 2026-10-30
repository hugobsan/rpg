"use client";
import { useImperativeHandle, useRef, useState, type Ref } from "react";
import type { Ability, Item } from "@/lib/types";
import Icon from "./Icon";
import Loader from "../ui/Loader";
import s from "./Composer.module.css";

export interface ComposerHandle {
  /** Põe o texto no campo (substitui) e foca no fim, para o jogador ajustar antes de enviar. */
  fill: (text: string) => void;
}

/**
 * Campo da ação: cresce com o texto, Enter envia, Shift+Enter quebra linha, Esc solta o foco
 * (aí as teclas 1 a 9 escolhem uma opção). O texto vive aqui: digitar não re-renderiza a tela.
 */
export default function Composer({ ref, onSend, busy, placeholder, abilities, items, abilitiesLabel, onOoc }: {
  ref?: Ref<ComposerHandle>;
  onSend: (text: string) => boolean;
  busy: boolean;
  placeholder: string;
  abilities: Ability[];
  items: Item[];
  abilitiesLabel: string;
  onOoc: () => void;
}) {
  const [text, setText] = useState("");
  const [tray, setTray] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  const focusEnd = () =>
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  useImperativeHandle(ref, () => ({ fill: (t) => { setText(t); focusEnd(); } }), []);

  const send = () => {
    if (onSend(text)) {
      setText("");
      setTray(false);
    }
  };
  // ação rápida: com o campo vazio começa a frase; senão acrescenta ao que já está escrito
  const use = (name: string) => {
    setText((t) => (t.trim() ? `${t.trimEnd()} usando ${name} ` : `Uso ${name} `));
    setTray(false);
    focusEnd();
  };
  const quick = abilities.length + items.length > 0;

  return (
    <div className={s.composer}>
      {tray && (
        <div className={s.tray} role="dialog" aria-label="Ações rápidas" onKeyDown={(e) => e.key === "Escape" && setTray(false)}>
          {abilities.length > 0 && (
            <div className={s.row}>
              <span className={s.rowLabel}>{abilitiesLabel}</span>
              <div className={s.chips}>
                {abilities.map((a) => (
                  <button key={a.name} className={s.chip} onClick={() => use(a.name)} title={a.effect || a.description || a.name}>
                    {a.name}
                    {a.cost?.amount ? <span className={s.cost}>{a.cost.amount} {a.cost.resource}</span> : null}
                  </button>
                ))}
              </div>
            </div>
          )}
          {items.length > 0 && (
            <div className={s.row}>
              <span className={s.rowLabel}>Itens</span>
              <div className={s.chips}>
                {items.map((i) => (
                  <button key={i.name} className={s.chip} onClick={() => use(i.name)} title={i.description || i.name}>
                    {i.name}{i.qty > 1 && <span className={s.cost}>×{i.qty}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      <div className={s.box}>
        <textarea
          ref={area}
          className={s.input}
          value={text}
          rows={1}
          placeholder={placeholder}
          aria-label="Sua ação"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            } else if (e.key === "Escape") {
              if (tray) setTray(false);
              else e.currentTarget.blur();
            }
          }}
        />
        <div className={s.bar}>
          {quick && (
            <button className={`${s.tool} ${tray ? s.on : ""}`} onClick={() => setTray((v) => !v)} aria-expanded={tray}
              title={`Usar ${abilitiesLabel.toLowerCase()} ou itens da ficha`}>
              <Icon name="bolt" size={16} /><span>Ações rápidas</span>
            </button>
          )}
          <button className={`${s.tool} ${s.ooc}`} onClick={onOoc} title="Converse com o Mestre como jogador: nada disso entra na história">
            <Icon name="chat" size={16} /><span>Fora do jogo</span>
          </button>
          <span className={s.hint}>Enter envia · Shift+Enter quebra a linha</span>
          <button className={`btn primary ${s.send}`} onClick={send} disabled={busy || !text.trim()} aria-label="Enviar ação">
            {busy ? <Loader size={16} label="O Mestre está respondendo" /> : <Icon name="send" size={18} />}
          </button>
        </div>
      </div>
    </div>
  );
}
