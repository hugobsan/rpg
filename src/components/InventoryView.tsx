"use client";
import { useEffect, useRef, useState } from "react";
import type { Character } from "@/lib/types";
import { toast } from "./ui/Toast";
import SearchBox, { fold } from "./ui/SearchBox";
import type { OnFix } from "./SheetView";
import s from "./SidePanels.module.css";

const BagIcon = ({ size = 18 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 7V6a4 4 0 0 1 8 0v1" /><path d="M5 7h14l-1 13H6L5 7Z" /><path d="M9 11h6" />
  </svg>
);

/** Aba Inventário: itens do personagem do jogador, com a opção de largar e a de corrigir à mão (onFix). */
export default function InventoryView({
  char,
  campaignId,
  disabled,
  onChange,
  onUse,
  onFix,
}: {
  char: Character;
  campaignId: string;
  disabled?: boolean; // durante o turno do Mestre a ficha pode estar mudando
  onChange: () => void;
  onUse?: (name: string) => void; // põe o item no campo da ação
  onFix?: OnFix; // correção do registro: tira, põe e muda a quantidade sem virar acontecimento da história
}) {
  const [fixing, setFixing] = useState(false);
  const [adding, setAdding] = useState({ name: "", qty: "1" });
  const fixQty = (name: string, qty: number) => onFix?.({ fix: "item", name, qty });
  const fixToggle = onFix && (
    <button className="btn ghost small" disabled={disabled && !fixing} aria-pressed={fixing} onClick={() => setFixing((f) => !f)}>
      {fixing ? "Pronto" : "Corrigir"}
    </button>
  );
  const addForm = fixing && (
    <form className={s.row} onSubmit={async (e) => {
      e.preventDefault();
      if (adding.name.trim() && (await fixQty(adding.name.trim(), Math.max(1, Math.floor(Number(adding.qty)) || 1)))) setAdding({ name: "", qty: "1" });
    }}>
      <input type="text" className={s.grow} aria-label="Item a adicionar" placeholder="Item que faltou" value={adding.name}
        onChange={(e) => setAdding((a) => ({ ...a, name: e.target.value }))} />
      <input type="number" min={1} aria-label="Quantidade" style={{ width: 68 }} value={adding.qty}
        onChange={(e) => setAdding((a) => ({ ...a, qty: e.target.value }))} />
      <button className="btn small" disabled={disabled || !adding.name.trim()}>Adicionar</button>
    </form>
  );
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
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

  const qf = fold(query.trim());
  const shown = items.filter((i) => !qf || fold(`${i.name} ${i.description ?? ""}`).includes(qf));

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
      <div className={s.wrap}>
        <div className={s.empty}>
          <BagIcon size={26} />
          <b>{char.name} não carrega nada</b>
          Itens ganhos, comprados ou encontrados na história aparecem aqui.
          {!fixing && fixToggle}
        </div>
        {addForm}
      </div>
    );
  return (
    <div className={s.wrap}>
      <div className={s.head}>
        <h4>Carregando</h4>
        <span className={s.count}>{items.reduce((n, i) => n + i.qty, 0)} no total</span>
        {fixToggle}
      </div>
      {fixing && <p className={s.sub}>Corrija o que ficou errado no registro: o item não é largado na história, e o Mestre fica sabendo no próximo turno.</p>}
      {addForm}
      {items.length > 1 && <SearchBox value={query} onChange={setQuery} label="Buscar no inventário" placeholder="Buscar item por nome ou descrição" />}
      {error && <div className="error-box">{error}</div>}
      {!shown.length && <p className="muted">Nada com essa busca.</p>}
      {shown.map((i, n) => (
        <div key={i.name} className={s.card} style={{ animationDelay: `${Math.min(n, 8) * 25}ms` }}>
          <div className={s.row}>
            <span className={s.icon}><BagIcon /></span>
            <div className={s.grow}>
              <div className={s.title}>{i.name}</div>
              {i.description && <div className={s.sub}>{i.description}</div>}
            </div>
            {i.qty > 1 && <span className={s.chip}>×{i.qty}</span>}
            {fixing && <>
              <button className="btn ghost small" disabled={disabled} onClick={() => fixQty(i.name, -1)} aria-label={`Tirar 1 ${i.name}`}>−</button>
              <button className="btn ghost small" disabled={disabled} onClick={() => fixQty(i.name, 1)} aria-label={`Pôr mais 1 ${i.name}`}>+</button>
              {i.qty > 1 && <button className="btn ghost small" disabled={disabled} onClick={() => fixQty(i.name, -i.qty)}>Tirar todos</button>}
            </>}
            {!fixing && confirming !== i.name && <>
              {onUse && (
                <button className="btn ghost small" onClick={() => onUse(i.name)} data-tip="Escrever no campo da ação" data-tip-align="end">Usar</button>
              )}
              <button className="btn ghost small" disabled={disabled} onClick={() => setConfirming(i.name)}>
                Largar
              </button>
            </>}
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
