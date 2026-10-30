"use client";
import { useState } from "react";
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
 * Parâmetros de recuperação vetorial, indexação e do Jev (lib/advanced.ts), recolhidos. O estado e o salvar
 * ficam com a tela de Configurações (barra de alterações e Ctrl+S); aqui só se edita.
 */
export default function AdvancedSettings({ spec, value, onChange }: {
  spec: AdvancedSpec;
  value: Advanced;
  onChange: (v: Advanced) => void;
}) {
  const groups = spec as unknown as Groups;
  const vals = value as unknown as Values;
  const [draft, setDraft] = useState<Record<string, string>>({}); // texto em edição ("" ou "0.") até sair do campo
  const set = (g: string, patch: Record<string, number>) => onChange({ ...vals, [g]: { ...vals[g], ...patch } } as unknown as Advanced);
  const off = Object.entries(groups).flatMap(([g, grp]) => Object.entries(grp.fields).filter(([k, f]) => vals[g][k] !== f.def)).length;

  return (
    <details className={s.wrap}>
      <summary>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        Parâmetros de recuperação e indexação
        {off > 0 && <span className={s.count}>{off} fora do padrão</span>}
      </summary>

      <div className={s.danger} role="note">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M8 1.8 14.6 13.5H1.4L8 1.8Z" strokeLinejoin="round" /><path d="M8 6.2v3.4M8 11.6v.1" strokeLinecap="round" /></svg>
        <div>
          <p>
            <b>Parâmetros de recuperação vetorial e indexação.</b> Valores errados degradam a memória do Mestre em silêncio:
            ele esquece o que aconteceu, recebe contexto irrelevante, gasta mais tokens ou passa a decidir errado, e nenhum
            erro aparece na tela. Os padrões foram medidos nos modelos atuais. Se kNN, distância de cosseno e chunk overlap
            não querem dizer nada para você, feche esta seção.
          </p>
          <p>
            Os campos marcados com &quot;exige reprocessar&quot; só valem para o que já está indexado depois de salvar e clicar
            em <a href="#sec-emb">Reprocessar embeddings</a>. O resto vale a partir do próximo turno.
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
    </details>
  );
}
