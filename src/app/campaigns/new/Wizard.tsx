"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Ability, Ruleset } from "@/lib/types";
import { abilityCost, startingKit } from "@/lib/ruleset";
import { DEFAULT_THEME, THEMES, inferTheme, type ThemeKey } from "@/lib/theme";
import Loader from "@/components/ui/Loader";
import { toast } from "@/components/ui/Toast";
import CampaignCard, { STYLE_LABEL } from "@/app/(home)/CampaignCard";
import AdventureChat from "./AdventureChat";
import s from "./new.module.css";

type Preset = "naruto" | "default" | "import" | "ai";
type Style = "open" | "hybrid" | "guided";
const STEPS = ["Mundo", "Visual", "Estilo", "Personagem", "Extras", "Revisão"] as const;

const STYLES: [Style, string, string, string, number][] = [
  ["open", "Aberta", "Você descreve tudo o que faz. O Mestre nunca sugere opções: liberdade total.", "Quem gosta de improvisar e conhece o cenário.", 0],
  ["hybrid", "Híbrida", "Nas cenas normais o Mestre sugere opções, e você também pode escrever o que quiser. Diálogos são sempre livres.", "A maioria das campanhas.", 2],
  ["guided", "Guiada", "O Mestre dá opções concretas e você escolhe entre elas; a história fica mais controlada e verossímil. Só os diálogos são livres.", "Começar num cenário que você ainda não conhece.", 3],
];

const facts = (r: Ruleset) => [
  `${r.attributes.length} atributos`,
  r.resources.map((x) => x.label).join(", "),
  ...(r.canonBased ? ["segue o cânone"] : []),
];
const baseAttrs = (r: Ruleset) => Object.fromEntries(r.attributes.map((x) => [x.key, x.default]));

export default function Wizard({ presets }: { presets: Record<"naruto" | "default", Ruleset> }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [busyMsg, setBusyMsg] = useState("");
  const [error, setError] = useState("");

  // mundo e mecânica
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<Preset>("naruto");
  const [imported, setImported] = useState<Ruleset | null>(null);
  const [importError, setImportError] = useState("");
  const [startingPoint, setStartingPoint] = useState("");
  const ruleset = preset === "import" ? imported : preset === "ai" ? null : presets[preset];

  // visual (null = o tema sugerido pelo cenário) e estilo
  const [theme, setTheme] = useState<ThemeKey | null>(null);
  const suggested = inferTheme(ruleset) ?? DEFAULT_THEME;
  const shownTheme = theme ?? suggested;
  const [style, setStyle] = useState<Style>("hybrid");

  // personagem
  const [charName, setCharName] = useState("");
  const [attrs, setAttrs] = useState<Record<string, number>>(() => baseAttrs(presets.naruto));
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [appearance, setAppearance] = useState("");
  const [personality, setPersonality] = useState("");
  const [backstory, setBackstory] = useState("");
  const [goals, setGoals] = useState("");
  const [extraAbilities, setExtraAbilities] = useState<Ability[]>([]);
  const blankAbility = (): Ability => ({ name: "", type: "", description: "", effect: "", damage: "", requirements: "" });
  const [draft, setDraft] = useState<Ability>(blankAbility());
  const [draftCost, setDraftCost] = useState(""); // vazio = padrão do rank

  // extras
  const [initialNpcs, setInitialNpcs] = useState("");
  const [genScript, setGenScript] = useState(true);
  const [bookFile, setBookFile] = useState<File | null>(null);

  // trocar de mecânica zera os atributos e campos extras da ficha
  const resetSheet = (rs: Ruleset | null) => {
    if (rs) setAttrs(baseAttrs(rs));
    setExtra({});
  };
  const pickPreset = (p: Preset) => {
    setPreset(p);
    resetSheet(p === "import" ? imported : p === "ai" ? null : presets[p]);
  };
  // arquivo importado ou aventura criada com IA: o mesmo caminho
  const applyRuleset = (rs: Ruleset) => {
    setImported(rs);
    setPreset("import");
    resetSheet(rs);
    setImportError("");
    if (rs.startingPoint && !startingPoint.trim()) setStartingPoint(rs.startingPoint);
  };
  const importRuleset = (f: File) => {
    f.text().then((t) => {
      try {
        const rs = JSON.parse(t) as Ruleset;
        if (!rs.attributes?.length) throw new Error("sem attributes");
        applyRuleset(rs);
      } catch {
        setImportError("JSON de mecânica inválido: precisa ter ao menos a lista de atributos (veja o naruto-ruleset.json).");
      }
    });
  };

  const pointsUsed = ruleset
    ? ruleset.attributes.reduce((sum, a) => sum + Math.max(0, (attrs[a.key] ?? a.default) - a.default), 0)
    : 0;
  const pointsLeft = (ruleset?.creationPoints ?? 0) - pointsUsed;
  // 1ª frase das notas de rolagem (ex: "Testes: 1d20 + (atributo x 2)..."), mostrada no balão dos atributos
  const testRule = ruleset?.diceNotes?.split(/\.\s/)[0] || "";
  const kit = ruleset ? startingKit(ruleset, ruleset.ranks[0]?.key) : [];
  const abLabel = ruleset?.abilitiesLabel || "Habilidades";
  const typeLabel = (k: string) => ruleset?.abilityTypes.find((t) => t.key === k)?.label || k;
  const costText = (a: Ability) => {
    const c = ruleset && abilityCost(ruleset, a);
    return !c ? "" : c.amount ? `${c.amount} ${ruleset!.resources.find((r) => r.key === c.resource)?.label || c.resource}` : "sem custo";
  };
  const abTitle = (a: Ability) =>
    [a.description, a.effect && `Efeito: ${a.effect}`, a.damage && `Dano: ${a.damage}`, a.requirements && `Requisitos: ${a.requirements}`].filter(Boolean).join("\n\n");
  const setAttr = (a: Ruleset["attributes"][number], v: number) => {
    // na criação, não desce abaixo da base nem gasta além dos pontos livres
    const cur = attrs[a.key] ?? a.default;
    const max = Math.min(a.max, cur + Math.max(pointsLeft, 0));
    setAttrs({ ...attrs, [a.key]: Math.min(Math.max(v, a.default), max) });
  };
  const addExtra = () => {
    if (!ruleset || !draft.name.trim()) return;
    const type = draft.type || ruleset.abilityTypes[0]?.key || "geral";
    const resource = ruleset.abilityCosts?.resource || ruleset.resources[0].key;
    const a: Ability = { ...draft, name: draft.name.trim(), type };
    if (draftCost.trim() !== "" && !Number.isNaN(Number(draftCost))) a.cost = { resource, amount: Number(draftCost) };
    for (const k of ["rank", "description", "effect", "damage", "requirements"] as const) if (!a[k]?.trim()) delete a[k];
    setExtraAbilities([...extraAbilities.filter((x) => x.name.toLowerCase() !== a.name.toLowerCase()), a]);
    setDraft(blankAbility());
    setDraftCost("");
  };

  const create = async () => {
    if (!ruleset) return;
    setBusy(true);
    setError("");
    try {
      setBusyMsg(genScript ? "Criando a campanha e gerando o roteiro. O Roteirista consulta o cânone; pode levar um minuto." : "Criando a campanha");
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          style,
          ruleset,
          theme: theme ?? undefined,
          startingPoint,
          initialNpcs,
          generateScript: genScript,
          character: { name: charName, attributes: attrs, extra, appearance, personality, backstory, goals, abilities: extraAbilities },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro ao criar campanha");
      if (data.scriptError) toast(`Campanha criada, mas o roteiro falhou: ${data.scriptError}. Dá para gerar de novo na aba Roteiro.`, { kind: "alerta" });
      if (bookFile) {
        setBusyMsg("Indexando o livro no banco vetorial (páginas e trechos)");
        const fd = new FormData();
        fd.append("file", bookFile);
        fd.append("title", bookFile.name.replace(/\.\w+$/, ""));
        const up = await fetch(`/api/campaigns/${data.id}/books`, { method: "POST", body: fd });
        if (!up.ok) {
          const e = await up.json().catch(() => ({}));
          toast(`O livro não foi indexado: ${e.error || up.status}. Tente de novo na aba Livros.`, { kind: "alerta", title: "Campanha criada" });
        }
      }
      router.push(`/campaign/${data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const valid = [!!name.trim() && !!ruleset, true, true, !!charName.trim() && pointsLeft >= 0, true, true];
  const reachable = (i: number) => valid.slice(0, i).every(Boolean);
  const go = (i: number) => {
    setStep(i);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const last = STEPS.length - 1;

  return (
    <main className={`container ${s.wrap}`}>
      <h1>Nova campanha</h1>
      <p className={`muted ${s.lede}`}>Seis passos curtos. Só o nome da campanha e o do personagem são obrigatórios; o resto tem padrão.</p>

      <ol className={s.steps} aria-label="Passos">
        {STEPS.map((label, i) => (
          <li key={label}>
            <button type="button" disabled={busy || i === step || !reachable(i)} onClick={() => go(i)}
              className={`${s.stepBtn} ${i === step ? s.current : i < step ? s.done : ""}`} aria-current={i === step ? "step" : undefined}>
              <span><span className={s.stepNum}>{i + 1}</span><span className={s.stepLabel}>{label}</span></span>
            </button>
          </li>
        ))}
      </ol>

      <div key={step} className={s.panel}>
        {step === 0 && (
          <>
            <h2>Mundo e mecânica</h2>
            <p className="muted">O cenário define atributos, barras, tipos de habilidade e ranks. O tema visual vem dele, e você pode trocar no próximo passo.</p>
            <label className="field" style={{ marginTop: 16 }}>
              <span>Nome da campanha</span>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: A Sombra da Folha" autoFocus />
            </label>
            <div className={s.options} role="radiogroup" aria-label="Mecânica e cenário">
              {(["naruto", "default"] as const).map((p) => (
                <button key={p} type="button" role="radio" aria-checked={preset === p} className={s.option} onClick={() => pickPreset(p)}>
                  <span className={s.optTitle}>{presets[p].name}</span>
                  <span className={s.optText}>{presets[p].description}</span>
                  <span className={s.optFacts}>{facts(presets[p]).map((f) => <span key={f} className="pill">{f}</span>)}</span>
                </button>
              ))}
              <button type="button" role="radio" aria-checked={preset === "import"} className={s.option} onClick={() => pickPreset("import")}>
                <span className={s.optTitle}>{imported?.name || "Importar mecânica"}</span>
                <span className={s.optText}>
                  {imported?.description || "Star Wars, D&D, cyberpunk, terror: copie o naruto-ruleset.json da raiz do projeto, ajuste e importe aqui."}
                </span>
                {imported && <span className={s.optFacts}>{facts(imported).map((f) => <span key={f} className="pill">{f}</span>)}</span>}
              </button>
              <button type="button" role="radio" aria-checked={preset === "ai"} className={s.option} onClick={() => pickPreset("ai")}>
                <span className={s.optTitle}>Criar com IA</span>
                <span className={s.optText}>
                  Harry Potter, piratas, faroeste: conte o que quer jogar e a IA monta as regras com você numa conversa. No fim, baixe o JSON ou comece a campanha com ele.
                </span>
              </button>
            </div>
            {preset === "ai" && (
              <AdventureChat onUse={(rs) => {
                applyRuleset(rs);
                if (!name.trim()) setName(rs.name);
                toast(`${rs.name} pronta para a campanha.`, { kind: "sucesso" });
                go(1);
              }} />
            )}
            {preset === "import" && (
              <>
                <label className={s.drop}>
                  <input type="file" accept=".json,application/json" onChange={(e) => e.target.files?.[0] && importRuleset(e.target.files[0])} />
                  <span>Arquivo JSON no mesmo formato do naruto-ruleset.json</span>
                </label>
                {importError && <div className="error-box">{importError}</div>}
              </>
            )}
            <label className="field" style={{ marginTop: 16 }}>
              <span>Ponto de partida na história {ruleset?.canonBased ? "(onde na linha do tempo da obra?)" : "(situação inicial)"}</span>
              <textarea value={startingPoint} onChange={(e) => setStartingPoint(e.target.value)}
                placeholder={ruleset?.canonBased ? "Ex: véspera do Exame Chunin, alguns meses depois da formação dos times Genin" : "Ex: uma vila costeira ameaçada por desaparecimentos"} />
            </label>
          </>
        )}

        {step === 1 && (
          <>
            <h2>Tema visual</h2>
            <p className="muted">
              Cores, fontes e textura da mesa durante o jogo. O sugerido vem do cenário ({ruleset?.name}); dá para trocar depois, dentro da campanha.
            </p>
            <div className={s.options} role="radiogroup" aria-label="Tema visual">
              {THEMES.map((t) => (
                <button key={t.key} type="button" role="radio" aria-checked={shownTheme === t.key} data-theme={t.key}
                  className={`${s.option} ${s.theme}`} onClick={() => setTheme(t.key)}>
                  <span className={s.glyph} aria-hidden="true" />
                  <span className={s.optTitle}>{t.label}</span>
                  {t.key === suggested && <span className={`pill ${s.tag}`}>Sugerido para o cenário</span>}
                  <span className={s.optText}>{t.description}</span>
                  <p className={s.sample}>A porta range. <strong>A guardiã</strong> ergue os olhos do livro e espera.</p>
                  <span className={s.swatchRow} aria-hidden="true">
                    {["exploration", "dialogue", "battle", "training", "downtime"].map((m) => (
                      <span key={m} className={s.dot} style={{ color: `var(--mode-${m})` }} />
                    ))}
                    <span className={s.fakeBtn}>Agir</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h2>Estilo de condução</h2>
            <p className="muted">Quanto o Mestre conduz. Afeta as opções que aparecem no fim de cada narração.</p>
            <div className={s.options} role="radiogroup" aria-label="Estilo de condução">
              {STYLES.map(([k, title, desc, goodFor, choices]) => (
                <button key={k} type="button" role="radio" aria-checked={style === k} className={s.option} onClick={() => setStyle(k)}>
                  <span className={s.optTitle}>{title}</span>
                  {k === "hybrid" && <span className={`pill ${s.tag}`}>Recomendado</span>}
                  <span className={s.optText}>{desc}</span>
                  <span className={s.optText}><b style={{ color: "var(--text)" }}>Bom para:</b> {goodFor}</span>
                  <span className={s.mock} aria-hidden="true">
                    {Array.from({ length: choices }, (_, i) => <span key={i} className={s.mockChoice} style={{ width: `${88 - i * 14}%` }} />)}
                    {k !== "guided" && <span className={s.mockInput} />}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {step === 3 && ruleset && (
          <>
            <h2>Seu personagem</h2>
            <label className="field" style={{ marginTop: 16 }}>
              <span>Nome</span>
              <input type="text" value={charName} onChange={(e) => setCharName(e.target.value)} autoFocus />
            </label>

            <div className={s.section}>
              <h3>Atributos</h3>
              <p className="muted">Comece da base do cenário e distribua os pontos livres. Passe o mouse (ou toque no i) para ver para que cada um serve.</p>
              <div className={s.pool}>
                <span className={`${s.poolNum} ${pointsLeft < 0 ? s.poolOver : ""}`}>{pointsLeft}</span>
                <span className="muted">de {ruleset.creationPoints} pontos livres</span>
                {ruleset.creationPoints <= 24 && (
                  <span className={s.pips} aria-hidden="true">
                    {Array.from({ length: ruleset.creationPoints }, (_, i) => <span key={i} className={`${s.pip} ${i < pointsLeft ? s.pipOn : ""}`} />)}
                  </span>
                )}
                <button type="button" className="btn ghost small" disabled={pointsUsed === 0} onClick={() => setAttrs(baseAttrs(ruleset))}>Redistribuir</button>
              </div>
              <div className={s.attrs}>
                {ruleset.attributes.map((a) => {
                  const cur = attrs[a.key] ?? a.default;
                  const max = Math.min(a.max, cur + Math.max(pointsLeft, 0));
                  const tip = [a.description, testRule, `Base ${a.default} · máximo ${a.max}`].filter(Boolean).join("\n\n");
                  return (
                    <div key={a.key} className={s.attr}>
                      <div className={s.attrHead}>
                        <span>{a.label}</span>
                        <button type="button" className={s.info} aria-label={`Sobre ${a.label}`} aria-describedby={`tip-${a.key}`}>i</button>
                      </div>
                      <div className={s.tip} id={`tip-${a.key}`} role="tooltip">{tip}</div>
                      <div className={s.attrRow}>
                        <button type="button" className={`btn ghost small ${s.step}`} aria-label={`Diminuir ${a.label}`} disabled={cur <= a.default} onClick={() => setAttr(a, cur - 1)}>−</button>
                        <span className={`${s.attrVal} ${cur > a.default ? s.attrUp : ""}`} aria-live="polite">{cur}</span>
                        <button type="button" className={`btn small ${s.step}`} aria-label={`Aumentar ${a.label}`} disabled={cur >= max} onClick={() => setAttr(a, cur + 1)}>+</button>
                      </div>
                      <div className={s.meter} aria-hidden="true">
                        <span className={s.meterVal} style={{ transform: `scaleX(${cur / a.max})` }} />
                        <span className={s.meterBase} style={{ transform: `scaleX(${a.default / a.max})` }} />
                      </div>
                      <div className={s.attrBase}>base {a.default}{cur > a.default ? ` · +${cur - a.default}` : ""}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {ruleset.extraFields.length > 0 && (
              <div className={s.section}>
                <h3>Origem</h3>
                <div className={s.extraGrid} style={{ marginTop: 12 }}>
                  {ruleset.extraFields.map((f) => (
                    <label className="field" key={f.key}>
                      <span>{f.label}</span>
                      <input type="text" value={extra[f.key] || ""} placeholder={f.description} onChange={(e) => setExtra({ ...extra, [f.key]: e.target.value })} />
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className={s.section}>
              <h3>{abLabel}</h3>
              <p className="muted">
                {kit.length
                  ? `Todo ${ruleset.ranks[0]?.label || "personagem"} já sabe estes (passe o mouse para ver o que fazem). Durante o jogo, o Mestre registra o que você usar ou aprender.`
                  : "Durante o jogo, o Mestre registra o que você usar ou aprender."}
              </p>
              <div className={s.kit}>
                {kit.map((a) => (
                  <div key={a.name} className={s.ability} style={{ cursor: "help" }} title={abTitle(a)}>
                    <div>
                      <div className={s.abName}>{a.name} {a.rank && <span className="pill">{a.rank}</span>} {costText(a) && <span className="pill">{costText(a)}</span>}</div>
                      <div className={s.abSub}>{typeLabel(a.type)}</div>
                    </div>
                  </div>
                ))}
                {extraAbilities.map((a) => (
                  <div key={a.name} className={`${s.ability} ${s.extra}`} title={abTitle(a)}>
                    <div>
                      <div className={s.abName}>
                        {a.name} {a.rank && <span className="pill">{a.rank}</span>} {costText(a) && <span className="pill">{costText(a)}</span>}
                        {a.damage && <span className="pill">{a.damage}</span>} <span className="pill on">extra</span>
                      </div>
                      <div className={s.abSub}>{typeLabel(a.type)}</div>
                    </div>
                    <button type="button" className="btn ghost small" aria-label={`Remover ${a.name}`} onClick={() => setExtraAbilities(extraAbilities.filter((x) => x !== a))}>✕</button>
                  </div>
                ))}
              </div>
              <details className={s.addBox}>
                <summary>Adicionar {abLabel.toLowerCase()} extra (combine com a sua história: clã, especialidade...)</summary>
                <div className={s.formGrid}>
                  <label className="field"><span>Nome</span>
                    <input type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  </label>
                  <label className="field"><span>Tipo</span>
                    <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
                      {ruleset.abilityTypes.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                    </select>
                  </label>
                  <label className="field"><span>Rank</span>
                    <select value={draft.rank || ""} onChange={(e) => setDraft({ ...draft, rank: e.target.value })}>
                      <option value="">Sem rank</option>
                      {ruleset.abilityRanks.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span>Custo ({ruleset.resources.find((r) => r.key === (ruleset.abilityCosts?.resource || ruleset.resources[0].key))?.label})</span>
                    <input type="number" min={0} value={draftCost}
                      placeholder={draft.rank && ruleset.abilityCosts?.byRank[draft.rank] !== undefined ? `${ruleset.abilityCosts.byRank[draft.rank]} (rank)` : ""}
                      onChange={(e) => setDraftCost(e.target.value)} />
                  </label>
                </div>
                <label className="field"><span>Efeito (o que faz em jogo)</span>
                  <input type="text" value={draft.effect || ""} onChange={(e) => setDraft({ ...draft, effect: e.target.value })} />
                </label>
                <div className={s.formGrid2}>
                  <label className="field"><span>Dano (ex: 2d6)</span>
                    <input type="text" value={draft.damage || ""} onChange={(e) => setDraft({ ...draft, damage: e.target.value })} />
                  </label>
                  <label className="field"><span>Requisitos (selos, elemento, linhagem)</span>
                    <input type="text" value={draft.requirements || ""} onChange={(e) => setDraft({ ...draft, requirements: e.target.value })} />
                  </label>
                </div>
                <label className="field"><span>Descrição</span>
                  <textarea value={draft.description || ""} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                </label>
                <button type="button" className="btn small" disabled={!draft.name.trim()} onClick={addExtra}>Adicionar</button>
              </details>
            </div>

            <div className={s.section}>
              <h3>Quem é você</h3>
              <p className="muted">Tudo opcional. O Mestre e o Roteirista usam o passado e os objetivos para criar ganchos.</p>
              <div className={s.personaGrid}>
                <label className="field"><span>Aparência</span><textarea value={appearance} onChange={(e) => setAppearance(e.target.value)} /></label>
                <label className="field"><span>Personalidade</span><textarea value={personality} onChange={(e) => setPersonality(e.target.value)} /></label>
                <label className="field"><span>Passado</span><textarea value={backstory} onChange={(e) => setBackstory(e.target.value)} /></label>
                <label className="field"><span>Objetivos</span><textarea value={goals} onChange={(e) => setGoals(e.target.value)} /></label>
              </div>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <h2>Referências e roteiro</h2>
            <p className="muted">Opcional. Material de consulta para o Mestre, o roteiro interno e quem já está na sua vida.</p>
            <label className="field" style={{ marginTop: 16 }}>
              <span>Livro ou material de referência (PDF, TXT ou MD)</span>
              <span className={s.drop}>
                <input type="file" accept=".pdf,.txt,.md" onChange={(e) => setBookFile(e.target.files?.[0] || null)} />
              </span>
            </label>
            <p className="muted" style={{ marginTop: -8 }}>Vira páginas e trechos com busca vetorial; o Mestre consulta e lê as páginas quando precisa.</p>
            <label className={s.toggle}>
              <input type="checkbox" checked={genScript} onChange={(e) => setGenScript(e.target.checked)} />
              <span>
                <b>Gerar o roteiro interno da campanha</b>
                O Roteirista planeja arcos, eventos canônicos e ganchos. Recomendado para cenários com cânone. É uma chamada de IA (centavos) e pode levar até um minuto.
              </span>
            </label>
            <label className="field">
              <span>NPCs iniciais (texto livre; o Mestre os cria na primeira cena)</span>
              <textarea value={initialNpcs} onChange={(e) => setInitialNpcs(e.target.value)} placeholder="Ex: meu mentor, um veterano rabugento; dois colegas de equipe..." />
            </label>
          </>
        )}

        {step === 5 && ruleset && (
          <>
            <h2>Revisão</h2>
            <p className="muted">Confira antes de abrir a mesa. Tudo aqui ainda dá para ajustar voltando ao passo.</p>
            <div className={s.review} style={{ marginTop: 20 }}>
              <div>
                <div className={`overline ${s.previewLabel}`}>Assim ela aparece na sua lista</div>
                <CampaignCard href={null} c={{
                  id: "preview", name: name.trim(), style, ruleset_name: ruleset.name, theme: shownTheme,
                  mode: "exploration", location: startingPoint.trim().slice(0, 120) || null, clock: null,
                  character_name: charName.trim() || null, message_count: 0, last_played: "", image_id: null, created_at: "", updated_at: "",
                }} />
              </div>
              <dl className={s.summary}>
                {([
                  ["Campanha", name.trim(), 0],
                  ["Cenário", ruleset.name, 0],
                  ["Tema", THEMES.find((t) => t.key === shownTheme)?.label, 1],
                  ["Estilo", STYLE_LABEL[style], 2],
                  ["Personagem", charName.trim(), 3],
                  ["Atributos", ruleset.attributes.map((a) => `${a.label} ${attrs[a.key] ?? a.default}`).join(" · "), 3],
                  [abLabel, `${kit.length} do kit inicial${extraAbilities.length ? ` + ${extraAbilities.length} extra` : ""}`, 3],
                  ["Livro", bookFile?.name || "nenhum", 4],
                  ["Roteiro", genScript ? "gerar ao criar (chamada de IA)" : "não gerar agora", 4],
                ] as const).map(([k, v, to]) => (
                  <div key={k} className={s.sumRow}>
                    <dt>{k}</dt>
                    <dd>{v}{k === "Atributos" && pointsLeft > 0 && <span className={s.warnText}> ({pointsLeft} {pointsLeft === 1 ? "ponto livre sobrando" : "pontos livres sobrando"})</span>}</dd>
                    <button type="button" className={s.edit} disabled={busy} onClick={() => go(to)}>Editar</button>
                  </div>
                ))}
              </dl>
            </div>
          </>
        )}
      </div>

      {error && <div className="error-box">{error}</div>}
      {busy && <div className={s.busy}><Loader size={28} label={busyMsg} showLabel /></div>}

      <div className={s.nav}>
        <button type="button" className="btn ghost" disabled={step === 0 || busy} onClick={() => go(step - 1)}>Voltar</button>
        {step < last ? (
          <button type="button" className="btn primary" disabled={!valid[step]} onClick={() => go(step + 1)}>
            Continuar <span aria-hidden="true">→</span>
          </button>
        ) : (
          <button type="button" className="btn primary" disabled={busy || !valid.every(Boolean)} onClick={create}>
            {busy ? <Loader size={16} label="Criando" /> : null} Criar campanha
          </button>
        )}
      </div>
    </main>
  );
}
