"use client";
import { useEffect, useRef, useState } from "react";
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
  const [error, setError] = useState("");
  // otimista: o que foi largado sai da lista na hora; o servidor confirma depois (ele grava a memória, demora)
  const [dropped, setDropped] = useState<Record<string, number>>({});
  const flying = useRef(new Map<string, number>()); // pedidos ainda sem resposta, por item
  // a ficha nova (relida) já vem sem o item: só fica descontado o que ainda não teve resposta
  useEffect(() => {
    setDropped((d) => Object.fromEntries(Object.entries(d).filter(([k]) => flying.current.get(k))));
  }, [char.sheet.inventory]);
  const items = char.sheet.inventory
    .map((i) => ({ ...i, qty: i.qty - (dropped[i.name] ?? 0) }))
    .filter((i) => i.qty > 0);

  const drop = async (name: string, qty: number) => {
    const add = (n: number) => setDropped((d) => ({ ...d, [name]: Math.max(0, (d[name] ?? 0) + n) }));
    const fly = (n: number) => flying.current.set(name, (flying.current.get(name) ?? 0) + n);
    setError("");
    setConfirming(null);
    add(qty);
    fly(1);
    const res = await fetch(`/api/campaigns/${campaignId}/inventory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, qty }),
    }).catch(() => null);
    fly(-1);
    if (!res?.ok) {
      add(-qty);
      const msg = (await res?.json().catch(() => ({})))?.error || "Falha ao largar o item.";
      setError(msg);
      toast(msg, { kind: "alerta", title: `${name} continua com você` });
      return;
    }
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
              <button className="btn ghost small" disabled={disabled} onClick={() => setConfirming(i.name)}>
                Largar
              </button>
            )}
          </div>
          {confirming === i.name && (
            <div className={s.actions}>
              <span className={s.sub}>Largar {i.name}? O Mestre fica sabendo que ficou no local atual.</span>
              <button className="btn small" onClick={() => drop(i.name, 1)}>
                {i.qty > 1 ? "Largar 1" : "Largar"}
              </button>
              {i.qty > 1 && (
                <button className="btn small" onClick={() => drop(i.name, i.qty)}>
                  Largar todos ({i.qty})
                </button>
              )}
              <button className="btn ghost small" onClick={() => setConfirming(null)}>Cancelar</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
