"use client";
import { useImperativeHandle, useRef, useState, type Ref } from "react";
import Icon from "./Icon";
import Loader from "../ui/Loader";
import s from "./Composer.module.css";

export interface ComposerHandle {
  /** Põe o texto no campo (substitui) e foca no fim, para o jogador ajustar antes de enviar. */
  fill: (text: string) => void;
  /** Técnica ou item da ficha: com o campo vazio começa a frase; senão acrescenta ao que já está escrito. */
  use: (name: string) => void;
}

/**
 * Campo da ação: cresce com o texto, Enter envia, Shift+Enter quebra linha, Esc solta o foco
 * (aí as teclas 1 a 9 escolhem uma opção). O texto vive aqui: digitar não re-renderiza a tela.
 * Ações rápidas pede ao servidor opções para o momento da cena (aparecem no lugar das do Mestre).
 */
export default function Composer({ ref, onSend, busy, placeholder, onSuggest, suggesting, onOoc }: {
  ref?: Ref<ComposerHandle>;
  onSend: (text: string) => boolean;
  busy: boolean;
  placeholder: string;
  onSuggest: () => void;
  suggesting: boolean;
  onOoc: () => void;
}) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);

  const focusEnd = () =>
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  useImperativeHandle(ref, () => ({
    fill: (t) => { setText(t); focusEnd(); },
    use: (name) => { setText((t) => (t.trim() ? `${t.trimEnd()} usando ${name} ` : `Uso ${name} `)); focusEnd(); },
  }), []);

  const send = () => {
    if (onSend(text)) setText("");
  };

  return (
    <div className={s.composer}>
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
            } else if (e.key === "Escape") e.currentTarget.blur();
          }}
        />
        <div className={s.bar}>
          <button className={s.tool} onClick={onSuggest} disabled={busy || suggesting} aria-label="Ações rápidas"
            data-tip="Sugere ações para este momento da cena">
            {suggesting ? <Loader size={16} label="Pensando em ações" /> : <Icon name="bolt" size={16} />}<span>Ações rápidas</span>
          </button>
          <button className={`${s.tool} ${s.ooc}`} onClick={onOoc} aria-label="Fora do jogo" title="Converse com o Mestre como jogador: nada disso entra na história">
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
