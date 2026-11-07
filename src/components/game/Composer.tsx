"use client";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import Icon from "./Icon";
import Loader from "../ui/Loader";
import s from "./Composer.module.css";

export interface ComposerHandle {
  /** Põe o texto no campo (substitui) e foca no fim, para o jogador ajustar antes de enviar. */
  fill: (text: string) => void;
  /** Técnica ou item da ficha: põe só o nome no campo (no fim do que já está escrito). */
  use: (name: string) => void;
}

/** Missão em curso: o campo de texto some e fica a faixa (principal ou secundária) com quem dá para chamar à conversa. */
export interface ComposerMission {
  title: string;
  scope: "main" | "side";
  talk: { name: string; onTalk: () => void }[]; // NPCs em cena: a conversa particular é livre em qualquer modo
}

/**
 * Campo da ação: cresce com o texto, Enter envia, Shift+Enter quebra linha, Esc solta o foco
 * (aí as teclas 1 a 9 escolhem uma opção). O texto vive aqui: digitar não re-renderiza a tela.
 * Com onStop (o Mestre está gerando a narração), o botão de enviar vira o de parar; Esc também para.
 * Com mission, só as opções acima valem (a API recusa texto livre em missão).
 */
export default function Composer({ ref, onSend, busy, placeholder, onOoc, onStop, mission }: {
  ref?: Ref<ComposerHandle>;
  onSend: (text: string) => boolean;
  busy: boolean;
  placeholder: string;
  onOoc: () => void;
  onStop?: () => void;
  mission?: ComposerMission;
}) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const stopRef = useRef(onStop);
  stopRef.current = onStop;
  const canStop = !!onStop;

  // Esc para o Mestre, menos com modal ou diálogo aberto (lá o Esc fecha o modal, inclusive o da rolagem)
  useEffect(() => {
    if (!canStop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.repeat || document.querySelector("[aria-modal='true'], .modal-backdrop, [role='dialog']")) return;
      stopRef.current?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canStop]);

  const focusEnd = () =>
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  useImperativeHandle(ref, () => ({
    fill: (t) => { setText(t); focusEnd(); },
    use: (name) => { setText((t) => (t.trim() ? `${t.trimEnd()} ${name} ` : `${name} `)); focusEnd(); },
  }), []);

  const send = () => {
    if (onSend(text)) setText("");
  };

  const stopButton = onStop && (
    <button className={`btn primary ${s.send}`} onClick={onStop} aria-label="Parar o Mestre"
      data-tip="Parar o Mestre" data-tip-align="end" aria-keyshortcuts="Escape">
      <Icon name="stop" size={16} />
    </button>
  );
  const oocButton = (
    <button className={`${s.tool} ${s.ooc}`} onClick={onOoc} aria-label="Fora do jogo" title="Converse com o Mestre como jogador: nada disso entra na história">
      <Icon name="chat" size={16} /><span>Fora do jogo</span>
    </button>
  );

  if (mission)
    return (
      <div className={s.composer}>
        <div className={`${s.box} ${s.mission}`} data-scope={mission.scope}>
          <div className={s.band} role="status">
            <Icon name="flag" size={16} />
            <span className={s.bandText}>
              <b>{mission.scope === "main" ? "Missão principal" : "Missão"}: {mission.title}</b>
              <span className={s.bandHint}>Escolha uma das opções acima</span>
            </span>
          </div>
          <div className={s.bar}>
            {oocButton}
            {mission.talk.slice(0, 3).map((n) => (
              <button key={n.name} className={s.tool} onClick={n.onTalk} title={`Conversa particular com ${n.name}: livre também em missão`}>
                <Icon name="people" size={16} /><span>Falar com {n.name.split(" ")[0]}</span>
              </button>
            ))}
            {stopButton ?? <span className={s.hint}>Teclas 1 a 4 escolhem</span>}
          </div>
        </div>
      </div>
    );

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
          {oocButton}
          <span className={s.hint}>Enter envia · Shift+Enter quebra a linha</span>
          {stopButton ?? (
            <button className={`btn primary ${s.send}`} onClick={send} disabled={busy || !text.trim()} aria-label="Enviar ação">
              {busy ? <Loader size={16} label="O Mestre está respondendo" /> : <Icon name="send" size={18} />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
