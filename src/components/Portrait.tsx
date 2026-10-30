"use client";
import { useState, type CSSProperties, type ReactNode } from "react";
import type { Character } from "@/lib/types";
import Icon from "./game/Icon";
import { toast } from "./ui/Toast";
import s from "./Portrait.module.css";

type Who = Pick<Character, "id" | "campaign_id" | "name"> & Partial<Pick<Character, "active" | "portrait">>;

export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

/** URL do retrato com a versão (cache longo); null = ainda sem retrato. */
export const portraitUrl = (c: Who) =>
  c.portrait?.v ? `/api/campaigns/${c.campaign_id}/portraits/${c.id}?v=${c.portrait.v}` : null;

/** Retrato na moldura do tema; sem retrato, as iniciais. Enquanto a tarefa roda (portrait.busy), a grade de pixels acende. */
export default function Portrait({ char, size = 38, children }: { char: Who; size?: number; children?: ReactNode }) {
  const url = portraitUrl(char);
  const cls = [s.frame, size >= 56 && s.lg, char.active === false && s.off, char.portrait?.busy && s.busy].filter(Boolean).join(" ");
  return (
    <span className={cls} style={{ "--size": `${size}px` } as CSSProperties} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element -- SVG/pixel art pequena, sem otimização do Next */}
      {url ? <img key={url} className={s.img} src={url} alt="" decoding="async" /> : <span className={s.mono}>{initials(char.name)}</span>}
      {children}
    </span>
  );
}

/** Gera ou regera o retrato em segundo plano; onChange relê a campanha para a tela acompanhar a tarefa. */
export function PortraitButton({ char, onChange }: { char: Who; onChange?: () => unknown }) {
  const [sending, setSending] = useState(false);
  const busy = sending || !!char.portrait?.busy;
  const go = async () => {
    setSending(true);
    try {
      const res = await fetch(`/api/campaigns/${char.campaign_id}/portraits/${char.id}`, { method: "POST" });
      if (!res.ok) toast((await res.json().catch(() => ({}))).error || "Não deu para pedir o retrato agora.", { kind: "alerta" });
      await onChange?.();
    } finally {
      setSending(false);
    }
  };
  return (
    <button type="button" className="btn ghost small" disabled={busy} onClick={go}>
      <Icon name="regen" size={13} />
      {busy ? "Desenhando o retrato" : char.portrait?.v ? "Regerar retrato" : "Gerar retrato"}
    </button>
  );
}
