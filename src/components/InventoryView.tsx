"use client";
import { useState } from "react";
import type { Character } from "@/lib/types";
import { toast } from "./ui/Toast";
import s from "./SidePanels.module.css";

const BagIcon = ({ size = 18 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 7V6a4 4 0 0 1 8 0v1" /><path d="M5 7h14l-1 13H6L5 7Z" /><path d="M9 11h6" />
  </svg>
);

/** Aba Inventário: itens do personagem do jogador, com a opção de largar. */
export default function InventoryView({
  char,
  campaignId,
  disabled,
  onChange,
}: {
  char: Character;
  campaignId: string;
  disabled?: boolean; // durante o turno do Mestre a ficha pode estar mudando
  onChange: () => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const items = char.sheet.inventory;

  const drop = async (name: string, qty: number) => {
    setBusy(true);
    setError("");
    const res = await fetch(`/api/campaigns/${campaignId}/inventory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, qty }),
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error || "Falha ao largar o item.");
      return;
    }
    setConfirming(null);
    toast(`${qty > 1 ? `${qty}x ` : ""}${name} ficou no local atual.`, { title: "Item largado" });
    onChange();
  };

  if (!items.length)
    return (
      <div className={s.empty}>
        <BagIcon size={26} />
        <b>{char.name} não carrega nada</b>
        Itens ganhos, comprados ou encontrados na história aparecem aqui.
      </div>
    );
  return (
    <div className={s.wrap}>
      <div className={s.head}>
        <h4>Carregando</h4>
        <span className={s.count}>{items.reduce((n, i) => n + i.qty, 0)} no total</span>
      </div>
      {error && <div className="error-box">{error}</div>}
      {items.map((i, n) => (
        <div key={i.name} className={s.card} style={{ animationDelay: `${Math.min(n, 8) * 25}ms` }}>
          <div className={s.row}>
            <span className={s.icon}><BagIcon /></span>
            <div className={s.grow}>
              <div className={s.title}>{i.name}</div>
              {i.description && <div className={s.sub}>{i.description}</div>}
            </div>
            {i.qty > 1 && <span className={s.chip}>×{i.qty}</span>}
            {confirming !== i.name && (
              <button className="btn ghost small" disabled={disabled || busy} onClick={() => setConfirming(i.name)}>
                Largar
              </button>
            )}
          </div>
          {confirming === i.name && (
            <div className={s.actions}>
              <span className={s.sub}>Largar {i.name}? O Mestre fica sabendo que ficou no local atual.</span>
              <button className="btn small" disabled={busy} onClick={() => drop(i.name, 1)}>
                {i.qty > 1 ? "Largar 1" : "Largar"}
              </button>
              {i.qty > 1 && (
                <button className="btn small" disabled={busy} onClick={() => drop(i.name, i.qty)}>
                  Largar todos ({i.qty})
                </button>
              )}
              <button className="btn ghost small" disabled={busy} onClick={() => setConfirming(null)}>Cancelar</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
