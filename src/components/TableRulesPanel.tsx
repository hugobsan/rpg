"use client";
import { useEffect, useRef, useState } from "react";
import type { Campaign, SceneMode, TableRules } from "@/lib/types";
import { DIFFICULTIES, getTable, MODE_HINTS, MODE_LABELS, modeHint, tableDc, XP_PACES, xpRule } from "@/lib/table";
import { campaignTheme, inferTheme, THEMES } from "@/lib/theme";
import s from "./TableRulesPanel.module.css";

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0");
const IDEAS = ["Combate", "Furtividade", "Social", "Conhecimento", "Atletismo", "Percepção"];
const Svg = ({ d, size = 14 }: { d: string; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

function Stepper({ value, onChange, label, min = -10, max = 10, fmt = signed }: {
  value: number; onChange: (v: number) => void; label: string; min?: number; max?: number; fmt?: (v: number) => string;
}) {
  const tone = fmt === signed ? (value > 0 ? s.up : value < 0 ? s.down : undefined) : undefined;
  return (
    <span className={s.stepper} role="group" aria-label={label}>
      <button type="button" aria-label="Diminuir" disabled={value <= min} onClick={() => onChange(value - 1)}><Svg d="M5 12h14" /></button>
      <output className={tone} aria-live="polite">{fmt(value)}</output>
      <button type="button" aria-label="Aumentar" disabled={value >= max} onClick={() => onChange(value + 1)}><Svg d="M12 5v14M5 12h14" /></button>
    </span>
  );
}

/** Texto de um modo de cena: salva ao sair do campo; "Voltar ao padrão" manda vazio. */
function ModeField({ mode, value, onSave }: { mode: SceneMode; value: string; onSave: (text: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const custom = value !== MODE_HINTS[mode];
  return (
    <div className={s.mode}>
      <div className={s.line}>
        <span><b>{MODE_LABELS[mode]}</b>{custom && " · ajustado"}</span>
        {custom && <button type="button" className={s.reset} onClick={() => onSave("")}>Voltar ao padrão</button>}
      </div>
      <textarea value={text} maxLength={600} rows={2} aria-label={`Modo ${MODE_LABELS[mode]}`}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text.trim() !== value && onSave(text.trim())} />
    </div>
  );
}

/**
 * Painel "Mesa": regras de dificuldade e dados da campanha (state.table) e o tema visual (state.theme).
 * Cada mudança salva na hora; `onChange` recarrega a tela (o tema muda a raiz do jogo).
 */
export default function TableRulesPanel({ campaign, onChange }: { campaign: Campaign; onChange?: () => void }) {
  const [table, setTable] = useState<TableRules>(() => getTable(campaign.state));
  const [notes, setNotes] = useState(table.notes ?? "");
  const [newCat, setNewCat] = useState({ label: "", offset: 2 });
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<string | null>(null); // seção que acabou de salvar
  const [theme, setTheme] = useState(campaignTheme(campaign));
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  // o Mestre pode mudar as regras na conversa fora do jogo: acompanha o estado que chega
  const remote = JSON.stringify(campaign.state.table ?? null);
  useEffect(() => {
    const t = getTable(campaign.state);
    setTable(t);
    setNotes(t.notes ?? "");
  }, [remote]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setTheme(campaignTheme(campaign)), [campaign]);
  useEffect(() => {
    if (!saved) return;
    const h = setTimeout(() => setSaved(null), 1600);
    return () => clearTimeout(h);
  }, [saved]);

  // salva em fila (um PUT por vez) e fica com o que o servidor devolveu
  const save = (patch: Partial<TableRules>, section: string) => {
    setError("");
    setTable((t) => ({ ...t, ...patch })); // otimista
    queue.current = queue.current.then(async () => {
      const res = await fetch(`/api/campaigns/${campaign.id}/table`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => null);
      const d = await res?.json().catch(() => ({}));
      if (!res?.ok) {
        setError(d?.error || "Não deu para salvar as regras da mesa.");
        setTable(getTable(campaign.state));
        return;
      }
      setTable(d.table);
      setSaved(section);
      onChange?.();
    });
  };

  const pickTheme = async (key: string | null) => {
    setError("");
    const before = theme;
    setTheme(key ? (key as typeof theme) : inferTheme(campaign.ruleset) ?? "chronicle");
    const res = await fetch(`/api/campaigns/${campaign.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: key }),
    }).catch(() => null);
    if (!res?.ok) {
      setTheme(before);
      return setError("Não deu para trocar o tema.");
    }
    setSaved("theme");
    onChange?.();
  };

  const preset = DIFFICULTIES.find((d) => d.key === table.difficulty) ?? DIFFICULTIES[2];
  const sample = tableDc(table, 15, undefined).dc ?? 15;
  const cats = table.categories;
  const setCats = (next: TableRules["categories"]) => save({ categories: next }, "cats");
  const addCat = (label = newCat.label) => {
    const l = label.trim();
    if (!l || cats.length >= 12 || cats.some((c) => c.label.toLowerCase() === l.toLowerCase())) return;
    setCats([...cats, { key: "", label: l, offset: newCat.offset }]); // key vazia: o servidor gera do label
    setNewCat({ label: "", offset: newCat.offset });
  };
  const suggested = inferTheme(campaign.ruleset);
  const chosenTheme = typeof campaign.state.theme === "string";
  const xp = xpRule(table);
  const tick = (section: string) => saved === section && <span className={s.saved}>salvo</span>;

  return (
    <div className={s.wrap}>
      <p className={s.intro}>
        Como a mesa joga: o quanto os testes são difíceis, o ritmo de XP, o jeito de cada tipo de cena e o clima visual. Vale a partir da próxima rolagem.
        Também dá para pedir ao Mestre na <b>conversa fora do jogo</b> (ex.: &quot;deixa o combate mais difícil&quot;).
      </p>
      {error && <div className="error-box">{error}</div>}

      <section className={s.section}>
        <h4>Dificuldade {tick("diff")}</h4>
        <div className={s.seg} role="radiogroup" aria-label="Dificuldade">
          {DIFFICULTIES.map((d) => (
            <button key={d.key} type="button" role="radio" aria-checked={table.difficulty === d.key}
              onClick={() => table.difficulty !== d.key && save({ difficulty: d.key, dcOffset: d.dcOffset }, "diff")}>
              {d.label}<small>CD {signed(d.dcOffset)}</small>
            </button>
          ))}
        </div>
        <p className={s.tone}>{preset.tone.charAt(0).toUpperCase() + preset.tone.slice(1)}</p>
        <div className={s.line}>
          <span>Ajuste geral da CD {table.dcOffset !== preset.dcOffset && <>(o preset sugere {signed(preset.dcOffset)})</>}</span>
          <Stepper label="Ajuste geral da CD" value={table.dcOffset} onChange={(v) => save({ dcOffset: v }, "diff")} />
        </div>
        <div className={s.preview}>
          <span className={s.dcs}>
            <b>15</b>
            <Svg d="M5 12h14M13 6l6 6-6 6" />
            <b>{sample}</b>
          </span>
          <span>
            {sample === 15
              ? "Um teste médio fica com a CD que o Mestre escolher, sem ajuste."
              : `Um teste médio, CD 15, fica CD ${sample}${sample > 15 ? ": mais difícil de passar." : ": mais fácil de passar."}`}
          </span>
        </div>
      </section>

      <section className={s.section}>
        <h4>Por tipo de ação {tick("cats")}</h4>
        <p className={s.help}>Somado à CD quando o Mestre marca o teste com esse tipo. Positivo dificulta, negativo facilita.</p>
        {cats.length > 0 && (
          <div className={s.cats}>
            {cats.map((c, i) => (
              <div key={c.key || c.label} className={s.cat}>
                <input type="text" defaultValue={c.label} maxLength={40} aria-label="Nome do tipo de ação"
                  onBlur={(e) => {
                    const l = e.target.value.trim();
                    if (l && l !== c.label) setCats(cats.map((x, j) => (j === i ? { ...x, label: l } : x)));
                    else e.target.value = c.label;
                  }}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
                <span className={s.to}>CD {tableDc(table, 15, c.key).dc}</span>
                <Stepper label={`Ajuste de ${c.label}`} value={c.offset}
                  onChange={(v) => setCats(cats.map((x, j) => (j === i ? { ...x, offset: v } : x)))} />
                <button type="button" className={s.remove} aria-label={`Remover ${c.label}`} title="Remover"
                  onClick={() => setCats(cats.filter((_, j) => j !== i))}>
                  <Svg d="M6 6l12 12M18 6 6 18" />
                </button>
              </div>
            ))}
          </div>
        )}
        {cats.length < 12 ? (
          <>
            <div className={s.add}>
              <input type="text" value={newCat.label} maxLength={40} placeholder="Ex.: Combate"
                aria-label="Novo tipo de ação" onChange={(e) => setNewCat({ ...newCat, label: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && addCat()} />
              <Stepper label="Ajuste do novo tipo" value={newCat.offset} onChange={(v) => setNewCat({ ...newCat, offset: v })} />
              <button type="button" className="btn small" disabled={!newCat.label.trim()} onClick={() => addCat()}>Adicionar</button>
            </div>
            {!cats.length && (
              <div className={s.chips}>
                {IDEAS.map((l) => (
                  <button key={l} type="button" className="pill filter-pill" onClick={() => setNewCat({ ...newCat, label: l })}>{l}</button>
                ))}
              </div>
            )}
          </>
        ) : (
          <p className={s.help}>Limite de 12 tipos de ação.</p>
        )}
      </section>

      <section className={s.section}>
        <label className={s.switch}>
          <input type="checkbox" checked={table.crits} onChange={(e) => save({ crits: e.target.checked }, "crits")} />
          <span className={s.track} aria-hidden="true" />
          <span>
            <b>Críticos {tick("crits")}</b>
            20 natural sempre passa e 1 natural sempre falha, seja qual for a CD.
          </span>
        </label>
      </section>

      <section className={s.section}>
        <h4>Ganho de XP {tick("xp")}</h4>
        <div className={s.seg} role="radiogroup" aria-label="Ritmo de XP">
          {XP_PACES.map((p) => {
            const on = xp.min === p.xp.min && xp.max === p.xp.max && xp.great === p.xp.great;
            return (
              <button key={p.key} type="button" role="radio" aria-checked={on} onClick={() => !on && save({ xp: { ...p.xp } }, "xp")}>
                {p.label}<small>{p.xp.min}–{p.xp.max}% · {p.xp.great}%</small>
              </button>
            );
          })}
        </div>
        <p className={s.tone}>
          O Escrivão dá XP só por feito que a narração mostra concluído (missão, luta vencida, descoberta, avanço de treino),
          em % do que falta para o próximo nível. Conversa, viagem e rotina não dão XP.
        </p>
        {/* cada passo respeita min ≤ max ≤ grande, então nunca manda uma regra inválida */}
        {([
          ["min", "Feito comum, mínimo", 0, xp.max],
          ["max", "Feito comum, máximo", xp.min, xp.great],
          ["great", "Feito grande, até", xp.max, 100],
        ] as const).map(([k, label, lo, hi]) => (
          <div key={k} className={s.line}>
            <span>{label}</span>
            <Stepper label={label} value={xp[k]} min={lo} max={hi} fmt={(v) => `${v}%`} onChange={(v) => save({ xp: { ...xp, [k]: v } }, "xp")} />
          </div>
        ))}
      </section>

      <section className={s.section}>
        <h4>Modos de cena {tick("modes")}</h4>
        <p className={s.tone}>
          Como o Mestre conduz cada tipo de cena: o texto do modo atual vai no contexto de todo turno. Vale só nesta campanha;
          vazio volta ao padrão.
        </p>
        {(Object.keys(MODE_HINTS) as SceneMode[]).map((k) => (
          <ModeField key={k} mode={k} value={modeHint(table, k)}
            onSave={(text) => save({ modes: { ...table.modes, [k]: text } }, "modes")} />
        ))}
      </section>

      <section className={s.section}>
        <h4>Notas para o Mestre {tick("notes")}</h4>
        <textarea value={notes} maxLength={600} rows={3} onChange={(e) => setNotes(e.target.value)}
          placeholder="Ex.: pode ser duro no combate, mas generoso na investigação. Não quero morte de NPC aliado sem aviso."
          onBlur={() => notes.trim() !== (table.notes ?? "") && save({ notes: notes.trim() }, "notes")} />
        <span className={s.count}>{notes.length}/600</span>
      </section>

      <section className={s.section}>
        <h4>Tema da campanha {tick("theme")}</h4>
        <div className={s.themes} role="radiogroup" aria-label="Tema da campanha">
          {THEMES.map((t) => (
            <button key={t.key} type="button" role="radio" aria-checked={theme === t.key} data-theme={t.key}
              className={s.theme} onClick={() => theme !== t.key && pickTheme(t.key)}>
              <span className={s.themeName}>{t.label}</span>
              <span className={s.themeDesc}>{t.description}</span>
              {t.key === suggested && <span className={s.suggested}>sugerido pelo cenário</span>}
              <span className={s.swatches} aria-hidden="true">
                <i style={{ background: "var(--accent)" }} />
                <i style={{ background: "var(--accent-2)" }} />
                <i style={{ background: "var(--mode-battle)" }} />
                <i style={{ background: "var(--mode-exploration)" }} />
              </span>
              {theme === t.key && <span className={s.check} aria-hidden="true"><Svg d="m5 12 4 4 10-10" size={11} /></span>}
            </button>
          ))}
        </div>
        {chosenTheme && (
          <button type="button" className={s.reset} onClick={() => pickTheme(null)}>
            Voltar ao tema do cenário{suggested ? ` (${THEMES.find((t) => t.key === suggested)?.label})` : ""}
          </button>
        )}
      </section>
    </div>
  );
}
