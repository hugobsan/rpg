"use client";
import { useState } from "react";
import type { Character } from "@/lib/types";

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
    onChange();
  };

  if (!items.length)
    return <p className="muted">{char.name} não carrega nada. Itens ganhos na história aparecem aqui.</p>;
  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>
        Largar um item tira ele da ficha na hora. O Mestre fica sabendo que ele ficou no local atual.
      </p>
      {error && <div className="error-box" style={{ marginBottom: 8 }}>{error}</div>}
      {items.map((i) => (
        <div key={i.name} className="ability-item">
          <div className="name" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flex: 1 }}>
              {i.name} {i.qty > 1 && <span className="pill">{i.qty}x</span>}
            </span>
            {confirming !== i.name && (
              <button className="btn ghost small" disabled={disabled || busy} onClick={() => setConfirming(i.name)}>
                Largar
              </button>
            )}
          </div>
          {i.description && <div className="sub">{i.description}</div>}
          {confirming === i.name && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, alignItems: "center" }}>
              <span className="sub" style={{ flex: "1 1 100%" }}>Largar {i.name}?</span>
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
