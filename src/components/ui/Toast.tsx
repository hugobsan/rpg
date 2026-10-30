"use client";
import { useEffect, useState } from "react";

/**
 * Avisos passageiros. Chame toast() de qualquer componente cliente; o <Toaster/> já está no layout.
 * toast("Kakashi saiu da cena") · toast("-8 Saúde", { kind: "dano" }) · toast("+40 XP", { kind: "xp", title: "Treino" })
 * Com ação (fecha ao clicar): toast("Kakashi quer falar com você", { action: { label: "Abrir", onClick: abrir } })
 */
export type ToastKind = "info" | "sucesso" | "dano" | "cura" | "xp" | "alerta";
export interface ToastAction { label: string; onClick: () => void }
interface Item { id: number; text: string; title?: string; kind: ToastKind; duration: number; action?: ToastAction; leaving?: boolean }

const MAX = 4; // visíveis ao mesmo tempo; o mais antigo sai
const ICON: Record<ToastKind, string> = { info: "i", sucesso: "✓", dano: "▼", cura: "▲", xp: "✦", alerta: "!" };

let items: Item[] = [];
let seq = 0;
const subs = new Set<(list: Item[]) => void>();
const emit = () => subs.forEach((fn) => fn(items));

export function toast(text: string, opts: { kind?: ToastKind; title?: string; duration?: number; action?: ToastAction } = {}): number {
  const kind = opts.kind ?? "info";
  // aviso com ação ou alerta fica mais tempo na tela
  const duration = opts.duration ?? (opts.action || kind === "alerta" ? 8000 : 4500);
  const item: Item = { id: ++seq, text, kind, title: opts.title, duration, action: opts.action };
  items = [...items, item].slice(-MAX);
  emit();
  return item.id;
}

export function dismissToast(id: number) {
  items = items.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  emit();
  setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, 180); // tempo da animação de saída
}

function ToastItem({ t }: { t: Item }) {
  const [paused, setPaused] = useState(false); // mouse em cima segura o aviso
  useEffect(() => {
    if (paused || t.leaving) return;
    const h = setTimeout(() => dismissToast(t.id), t.duration);
    return () => clearTimeout(h);
  }, [paused, t.id, t.duration, t.leaving]);
  return (
    <div className={`toast ${t.kind}${t.leaving ? " leaving" : ""}`} role="status"
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <span className="toast-icon" aria-hidden="true">{ICON[t.kind]}</span>
      <div className="toast-body">
        {t.title && <div className="toast-title">{t.title}</div>}
        <div>{t.text}</div>
        {t.action && (
          <button className="btn small toast-action" onClick={() => { t.action!.onClick(); dismissToast(t.id); }}>
            {t.action.label}
          </button>
        )}
      </div>
      <button className="toast-close" aria-label="Fechar aviso" onClick={() => dismissToast(t.id)}>✕</button>
    </div>
  );
}

export function Toaster() {
  const [list, setList] = useState(items);
  useEffect(() => {
    subs.add(setList);
    setList(items);
    return () => void subs.delete(setList);
  }, []);
  return (
    <div className="toaster" role="region" aria-label="Avisos" aria-live="polite">
      {list.map((t) => <ToastItem key={t.id} t={t} />)}
    </div>
  );
}
