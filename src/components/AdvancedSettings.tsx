"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import Loader from "./ui/Loader";
import type { Advanced, AdvancedSpec } from "@/lib/advanced";
import s from "./AdvancedSettings.module.css";

type Field = { label: string; help: string; def: number; min: number; max: number; step: number; reprocess?: boolean };
type Groups = Record<string, { title: string; note: string; fields: Record<string, Field> }>;
type Values = Record<string, Record<string, number>>;

const fmt = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 4 });
const clamp = (v: number, f: Field) => {
  const c = Math.min(f.max, Math.max(f.min, v));
  return f.step >= 1 ? Math.round(c) : c;
};

/** Algum campo "exige reprocessar" mudou entre b (salvo) e a (na tela)? */
export function reprocessPending(spec: AdvancedSpec, a: Advanced, b: Advanced): boolean {
  const [va, vb] = [a, b] as unknown as Values[];
  return Object.entries(spec as unknown as Groups).some(([g, grp]) =>
    Object.entries(grp.fields).some(([k, f]) => f.reprocess && va[g][k] !== vb[g][k])
  );
}

/**
 * Modal dos parâmetros de recuperação vetorial, indexação e do Jev (lib/advanced.ts), aberto pela Memória semântica.
 * O estado e o salvar ficam com a tela de Configurações (mesma barra de alterações e Ctrl+S); aqui só se edita.
 */
export default function AdvancedSettings({ spec, value, onChange, onClose, onSave, dirty, saving }: {
  spec: AdvancedSpec;
  value: Advanced;
  onChange: (v: Advanced) => void;
  onClose: () => void;
  onSave: () => void;
  dirty: boolean; // há alterações não salvas na tela (aqui ou fora do modal)
  saving: boolean;
}) {
  const groups = spec as unknown as Groups;
  const vals = value as unknown as Values;
  const [draft, setDraft] = useState<Record<string, string>>({}); // texto em edição ("" ou "0.") até sair do campo
  const set = (g: string, patch: Record<string, number>) => onChange({ ...vals, [g]: { ...vals[g], ...patch } } as unknown as Advanced);
  const off = Object.entries(groups).flatMap(([g, grp]) => Object.entries(grp.fields).filter(([k, f]) => vals[g][k] !== f.def)).length;
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal ${s.modal}`} role="dialog" aria-modal="true" aria-labelledby="adv-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 id="adv-title" className={s.title}>
            Configurações avançadas
            {off > 0 && <span className={s.count}>{off} fora do padrão</span>}
          </h3>
          <button className={s.close} onClick={onClose} aria-label="Fechar">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <p className={s.intro}>
            Top-k, limiares de distância de cosseno, chunking, dimensões dos embeddings e limiares do Jev, por cenário. A janela
            do histórico e as rodadas de ferramentas do Mestre e a compactação do Cronista ficam em <Link href="/agents">Agentes</Link>.
          </p>

      <div className={s.danger} role="note">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M8 1.8 14.6 13.5H1.4L8 1.8Z" strokeLinejoin="round" /><path d="M8 6.2v3.4M8 11.6v.1" strokeLinecap="round" /></svg>
        <div>
          <p>
            <b>Parâmetros de recuperação vetorial e indexação.</b> Valores errados degradam a memória do Mestre em silêncio:
            ele esquece o que aconteceu, recebe contexto irrelevante, gasta mais tokens ou passa a decidir errado, e nenhum
            erro aparece na tela. Os padrões foram medidos nos modelos atuais. Se kNN, distância de cosseno e chunk overlap
            não querem dizer nada para você, feche esta janela.
          </p>
          <p>
            Os campos marcados com &quot;exige reprocessar&quot; só valem para o que já está indexado depois de salvar e clicar
            em Reprocessar embeddings, na Memória semântica. O resto vale a partir do próximo turno.
          </p>
        </div>
      </div>

      {Object.entries(groups).map(([g, grp]) => {
        const isDefault = Object.entries(grp.fields).every(([k, f]) => vals[g][k] === f.def);
        return (
          <section key={g} className={s.group} aria-labelledby={`adv-${g}`}>
            <div className={s.groupHead}>
              <h3 id={`adv-${g}`}>{grp.title}</h3>
              <button type="button" className="btn ghost small" disabled={isDefault}
                onClick={() => {
                  set(g, Object.fromEntries(Object.entries(grp.fields).map(([k, f]) => [k, f.def])));
                  setDraft({});
                }}>
                Restaurar padrões
              </button>
            </div>
            <p className={s.note}>{grp.note}</p>
            {Object.entries(grp.fields).map(([k, f]) => {
              const id = `adv-${g}-${k}`;
              const v = vals[g][k];
              return (
                <div key={k} className={`${s.field} ${v !== f.def ? s.changed : ""}`}>
                  <label htmlFor={id} className={s.label}>{f.label}</label>
                  <input id={id} type="number" inputMode="decimal" min={f.min} max={f.max} step={f.step} aria-describedby={`${id}-help`}
                    value={draft[id] ?? String(v)}
                    onChange={(e) => {
                      setDraft({ ...draft, [id]: e.target.value });
                      if (e.target.value !== "" && Number.isFinite(e.target.valueAsNumber)) set(g, { [k]: e.target.valueAsNumber });
                    }}
                    onBlur={() => {
                      const c = clamp(v, f); // fora da faixa volta para a borda (o servidor também prende)
                      if (c !== v) set(g, { [k]: c });
                      setDraft(({ [id]: _, ...rest }) => rest);
                    }} />
                  <p id={`${id}-help`} className={s.help}>
                    {f.help} <span className={s.meta}>Padrão {fmt(f.def)} · faixa {fmt(f.min)} a {fmt(f.max)}.</span>
                    {f.reprocess && <span className={`pill ${s.re}`}>exige reprocessar</span>}
                  </p>
                </div>
              );
            })}
          </section>
        );
      })}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Fechar</button>
          <button className="btn primary" onClick={onSave} disabled={saving || !dirty}>
            {saving && <Loader size={16} label="Salvando" />} Salvar configurações
          </button>
        </div>
      </div>
    </div>
  );
}
