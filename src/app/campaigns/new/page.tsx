"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Ruleset } from "@/lib/types";

type Step = 0 | 1 | 2 | 3;

export default function NewCampaign() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(0);
  const [busy, setBusy] = useState(false);
  const [busyMsg, setBusyMsg] = useState("");
  const [error, setError] = useState("");

  // passo 0: básico + mecânica
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<"naruto" | "default" | "import">("naruto");
  const [ruleset, setRuleset] = useState<Ruleset | null>(null);
  const [startingPoint, setStartingPoint] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // passo 1: estilo
  const [style, setStyle] = useState<"open" | "hybrid" | "guided">("hybrid");

  // passo 2: personagem
  const [charName, setCharName] = useState("");
  const [attrs, setAttrs] = useState<Record<string, number>>({});
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [appearance, setAppearance] = useState("");
  const [personality, setPersonality] = useState("");
  const [backstory, setBackstory] = useState("");
  const [goals, setGoals] = useState("");

  // passo 3: extras
  const [initialNpcs, setInitialNpcs] = useState("");
  const [genScript, setGenScript] = useState(true);
  const [bookFile, setBookFile] = useState<File | null>(null);

  useEffect(() => {
    if (preset === "import") return;
    fetch(`/api/rulesets?preset=${preset}`)
      .then((r) => r.json())
      .then((rs: Ruleset) => {
        setRuleset(rs);
        const a: Record<string, number> = {};
        rs.attributes.forEach((x) => (a[x.key] = x.default));
        setAttrs(a);
        setExtra({});
      });
  }, [preset]);

  const importRuleset = (f: File) => {
    f.text().then((t) => {
      try {
        const rs = JSON.parse(t) as Ruleset;
        if (!rs.attributes?.length) throw new Error("sem attributes");
        setRuleset(rs);
        const a: Record<string, number> = {};
        rs.attributes.forEach((x) => (a[x.key] = x.default));
        setAttrs(a);
        setExtra({});
        setError("");
      } catch {
        setError("JSON de mecânica inválido.");
      }
    });
  };

  const pointsUsed = ruleset
    ? ruleset.attributes.reduce((s, a) => s + Math.max(0, (attrs[a.key] ?? a.default) - a.default), 0)
    : 0;
  const pointsLeft = (ruleset?.creationPoints ?? 0) - pointsUsed;
  // 1ª frase das notas de rolagem (ex: "Testes: 1d20 + (atributo x 2)..."), mostrada no hover dos atributos
  const testRule = ruleset?.diceNotes?.split(/\.\s/)[0] || "";

  const create = async () => {
    if (!ruleset) return;
    setBusy(true);
    setError("");
    try {
      setBusyMsg(genScript ? "Criando campanha e gerando roteiro (o Roteirista consulta o cânone — pode levar um minuto)..." : "Criando campanha...");
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          style,
          ruleset,
          startingPoint,
          initialNpcs,
          generateScript: genScript,
          character: {
            name: charName,
            attributes: attrs,
            extra,
            appearance,
            personality,
            backstory,
            goals,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro ao criar campanha");
      if (bookFile) {
        setBusyMsg("Indexando livro no banco vetorial (páginas + chunks)...");
        const fd = new FormData();
        fd.append("file", bookFile);
        fd.append("title", bookFile.name.replace(/\.\w+$/, ""));
        const up = await fetch(`/api/campaigns/${data.id}/books`, { method: "POST", body: fd });
        if (!up.ok) {
          const e = await up.json().catch(() => ({}));
          alert(`Campanha criada, mas o livro falhou ao indexar: ${e.error || up.status}. Você pode tentar de novo na aba Livros.`);
        }
      }
      router.push(`/campaign/${data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const canNext =
    step === 0 ? !!name.trim() && !!ruleset :
    step === 2 ? !!charName.trim() :
    true;

  return (
    <div className="container" style={{ maxWidth: 760 }}>
      <h1>Nova campanha</h1>
      <div className="wizard-steps">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`st ${step >= i ? "done" : ""}`} />
        ))}
      </div>
      {error && <div className="error-box">{error}</div>}

      {step === 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Mundo e mecânica</h2>
          <label className="field">
            <span>Nome da campanha</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: A Sombra da Folha" />
          </label>
          <label className="field">
            <span>Mecânica / cenário</span>
            <select value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)}>
              <option value="naruto">Preset: Mundo Shinobi (Naruto) — segue o cânone</option>
              <option value="default">Padrão agnóstico (qualquer cenário)</option>
              <option value="import">Importar JSON de mecânica...</option>
            </select>
          </label>
          {preset === "import" && (
            <label className="field">
              <span>Arquivo JSON (mesmo formato do naruto-ruleset.json na raiz do projeto)</span>
              <input
                type="file"
                accept=".json"
                ref={fileRef}
                onChange={(e) => e.target.files?.[0] && importRuleset(e.target.files[0])}
              />
            </label>
          )}
          {ruleset && (
            <p className="muted">
              ✓ {ruleset.name} — atributos: {ruleset.attributes.map((a) => a.label).join(", ")} · barras:{" "}
              {ruleset.resources.map((r) => r.label).join(", ")}
              {ruleset.canonBased ? " · baseado em obra (cânone)" : ""}
            </p>
          )}
          <label className="field">
            <span>Ponto de partida na história {ruleset?.canonBased ? "(onde na linha do tempo da obra?)" : "(situação inicial)"}</span>
            <textarea
              value={startingPoint}
              onChange={(e) => setStartingPoint(e.target.value)}
              placeholder={ruleset?.canonBased ? "Ex: véspera do Exame Chunin, alguns meses depois da formação dos times Genin" : "Ex: uma vila costeira ameaçada por desaparecimentos"}
            />
          </label>
        </div>
      )}

      {step === 1 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Estilo de condução</h2>
          {(
            [
              ["open", "Aberta", "Você sempre descreve livremente o que faz. O Mestre nunca sugere opções — máxima liberdade."],
              ["hybrid", "Híbrida (recomendado)", "Em cenas normais o Mestre oferece opções de ação, mas você também pode digitar o que quiser. Diálogos são sempre livres."],
              ["guided", "Guiada", "História controlada e verossímil: o Mestre dá opções concretas e você escolhe entre elas. Só diálogos são livres."],
            ] as const
          ).map(([k, title, desc]) => (
            <div
              key={k}
              className="npc-row"
              style={{ borderColor: style === k ? "var(--accent)" : undefined }}
              onClick={() => setStyle(k)}
            >
              <input type="radio" checked={style === k} readOnly />
              <div className="info">
                <div className="nm">{title}</div>
                <div className="sub" style={{ whiteSpace: "normal" }}>{desc}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {step === 2 && ruleset && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Seu personagem</h2>
          <label className="field">
            <span>Nome</span>
            <input type="text" value={charName} onChange={(e) => setCharName(e.target.value)} />
          </label>
          <div className="muted" style={{ marginBottom: 6 }}>
            Atributos — pontos livres: <b style={{ color: pointsLeft < 0 ? "var(--danger)" : "var(--ok)" }}>{pointsLeft}</b> de {ruleset.creationPoints}
            {" "}· passe o mouse num atributo para ver para que ele serve
          </div>
          <div className="attr-grid">
            {ruleset.attributes.map((a) => {
              const cur = attrs[a.key] ?? a.default;
              // na criação, não desce abaixo da base nem gasta além dos pontos livres
              const max = Math.min(a.max, cur + Math.max(pointsLeft, 0));
              const tip = [
                a.description,
                testRule,
                `Base ${a.default} · máximo ${a.max}`,
              ].filter(Boolean).join("\n\n");
              return (
              <div key={a.key} className="attr-cell" title={tip} style={{ cursor: "help" }}>
                <div className="k">{a.label}</div>
                <input
                  type="number"
                  min={a.default}
                  max={max}
                  value={cur}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isNaN(v))
                      setAttrs({ ...attrs, [a.key]: Math.min(Math.max(v, a.default), max) });
                  }}
                  style={{ textAlign: "center", padding: 4 }}
                />
              </div>
              );
            })}
          </div>
          {ruleset.extraFields.map((f) => (
            <label className="field" key={f.key}>
              <span>{f.label}{f.description ? ` — ${f.description}` : ""}</span>
              <input type="text" value={extra[f.key] || ""} onChange={(e) => setExtra({ ...extra, [f.key]: e.target.value })} />
            </label>
          ))}
          <label className="field"><span>Aparência</span><textarea value={appearance} onChange={(e) => setAppearance(e.target.value)} /></label>
          <label className="field"><span>Personalidade</span><textarea value={personality} onChange={(e) => setPersonality(e.target.value)} /></label>
          <label className="field"><span>Passado (o Mestre e o Roteirista usam isso para criar ganchos)</span><textarea value={backstory} onChange={(e) => setBackstory(e.target.value)} /></label>
          <label className="field"><span>Objetivos</span><textarea value={goals} onChange={(e) => setGoals(e.target.value)} /></label>
        </div>
      )}

      {step === 3 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Referências e roteiro</h2>
          <label className="field">
            <span>Livro/material de referência (PDF, TXT ou MD) — indexado em chunks no pgvector; o Mestre consulta por busca e leitura de páginas</span>
            <input type="file" accept=".pdf,.txt,.md" onChange={(e) => setBookFile(e.target.files?.[0] || null)} />
          </label>
          <label className="field" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={genScript} onChange={(e) => setGenScript(e.target.checked)} style={{ width: "auto" }} />
            <span style={{ margin: 0 }}>Gerar roteiro interno da campanha (arcos, eventos canônicos e ganchos — recomendado para cenários com cânone)</span>
          </label>
          <label className="field">
            <span>NPCs iniciais (opcional — descreva em texto livre; o Mestre os criará na primeira cena)</span>
            <textarea value={initialNpcs} onChange={(e) => setInitialNpcs(e.target.value)} placeholder="Ex: meu sensei Jounin especialista em Genjutsu; dois colegas de time..." />
          </label>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 18 }}>
        <button className="btn ghost" disabled={step === 0 || busy} onClick={() => setStep((step - 1) as Step)}>
          ← Voltar
        </button>
        {step < 3 ? (
          <button className="btn primary" disabled={!canNext} onClick={() => setStep((step + 1) as Step)}>
            Avançar →
          </button>
        ) : (
          <button className="btn primary" disabled={busy} onClick={create}>
            {busy ? busyMsg : "⚔ Criar campanha"}
          </button>
        )}
      </div>
    </div>
  );
}
