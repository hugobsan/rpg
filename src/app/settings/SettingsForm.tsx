"use client";
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Loader from "@/components/ui/Loader";
import { toast } from "@/components/ui/Toast";
import type { DiceResult } from "@/lib/types";
import s from "./settings.module.css";

// só baixa a caixa 3D quando o jogador pede o teste
const DiceRoller = dynamic(() => import("@/components/DiceRoller"), { ssr: false });

/** Rolagem de mentira para testar a animação (1d20+3 contra CD 15, com crítico no 20/1). */
function testRoll(): DiceResult {
  const d = 1 + Math.floor(Math.random() * 20);
  const total = d + 3;
  const crit = d === 20 ? "success" : d === 1 ? "failure" : undefined;
  return { notation: "1d20+3", rolls: [d], modifier: 3, total, reason: "Teste da animação", dc: 15, success: crit ? crit === "success" : total >= 15, crit };
}

export interface SettingsShape {
  openrouter: { configured: boolean; apiKeyMasked: string };
  embeddings: { enabled: boolean; model: string };
  ui: { diceAnimation: boolean; imageGeneration: boolean; autoMaps: boolean };
}
type Result = { ok: boolean; text: string } | null;

function ResultText({ r }: { r: Result }) {
  if (!r) return null;
  return <span className={`${s.result} ${r.ok ? s.ok : s.err}`} role="status">{r.ok ? "✓" : "✕"} {r.text}</span>;
}

/** Formulário com os dados já vindos do servidor (sem tela de carregando). */
export default function SettingsForm({ initial }: { initial: SettingsShape }) {
  const [data, setData] = useState(initial);
  const [orKey, setOrKey] = useState("");
  const [emb, setEmb] = useState(initial.embeddings);
  const [diceAnimation, setDiceAnimation] = useState(initial.ui.diceAnimation);
  const [imageGeneration, setImageGeneration] = useState(initial.ui.imageGeneration);
  const [autoMaps, setAutoMaps] = useState(initial.ui.autoMaps);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<Result>(null);
  const [reRunning, setReRunning] = useState(false);
  const [re, setRe] = useState<Result>(null);

  const embDirty = emb.enabled !== data.embeddings.enabled || emb.model !== data.embeddings.model;
  const dirty = !!orKey.trim() || embDirty || diceAnimation !== data.ui.diceAnimation || imageGeneration !== data.ui.imageGeneration || autoMaps !== data.ui.autoMaps;

  const save = async () => {
    setSaving(true);
    const body: Record<string, unknown> = { embeddings: emb, ui: { diceAnimation, imageGeneration, autoMaps } };
    if (orKey.trim()) body.openrouterApiKey = orKey.trim();
    const res = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    if (res?.ok) {
      toast("Configurações salvas.", { kind: "sucesso" });
      setOrKey("");
      const fresh = await fetch("/api/settings").then((r) => r.json() as Promise<SettingsShape>).catch(() => null);
      if (fresh) {
        setData(fresh);
        setEmb(fresh.embeddings); // o servidor apara o nome do modelo
      }
    } else {
      toast("Não foi possível salvar as configurações. Tente de novo.", { kind: "alerta" });
    }
    setSaving(false);
  };

  // Ctrl+S / Cmd+S salva (e nunca abre o "salvar página" do navegador)
  const saveRef = useRef<() => void>(() => {});
  saveRef.current = () => { if (dirty && !saving) save(); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [diceTest, setDiceTest] = useState<DiceResult | null>(null);

  const testOpenRouter = async () => {
    setTesting(true);
    setTest(null);
    const res = await fetch("/api/models?fresh=1").catch(() => null);
    const d = res && (await res.json().catch(() => ({})));
    setTest(res?.ok ? { ok: true, text: `Conexão OK, ${d.length} modelos disponíveis` } : { ok: false, text: `Falhou: ${d?.error || res?.status || "sem resposta"}` });
    setTesting(false);
  };

  const reprocess = async () => {
    // reprocessa com o modelo salvo no banco, não com o que está na tela
    if (embDirty) return setRe({ ok: false, text: "Salve as configurações antes de reprocessar" });
    setReRunning(true);
    setRe(null);
    try {
      const res = await fetch("/api/embeddings/reprocess", { method: "POST" });
      const d = await res.json();
      const n = `${d.memories ?? 0} memórias e ${d.book_chunks ?? 0} trechos`;
      setRe(res.ok
        ? { ok: true, text: `${n} reprocessados` }
        : { ok: false, text: `${d.error || res.status}${d.memories !== undefined ? ` (${n} reprocessados; o restante ficou sem embedding)` : ""}` });
    } catch {
      setRe({ ok: false, text: "Falha na requisição" });
    }
    setReRunning(false);
  };

  return (
    <>
      <section className={s.section} aria-labelledby="sec-or">
        <div className={s.aside}>
          <h2 id="sec-or">OpenRouter</h2>
          <p>Todos os agentes chamam a IA pelo OpenRouter. A chave fica só no seu banco local.</p>
          <span className={`pill ${data.openrouter.configured ? "on" : "err"} ${s.status}`}>
            {data.openrouter.configured ? `Chave ${data.openrouter.apiKeyMasked}` : "Sem chave"}
          </span>
        </div>
        <div>
          <label className="field">
            <span>API key (sk-or-...)</span>
            <input type="password" value={orKey} onChange={(e) => setOrKey(e.target.value)} autoComplete="off"
              placeholder={data.openrouter.configured ? "Preencha só para substituir a atual" : "sk-or-v1-..."} />
          </label>
          <div className={s.row}>
            <button className="btn small" onClick={testOpenRouter} disabled={testing}>
              {testing && <Loader size={14} label="Testando" />} Testar conexão
            </button>
            <ResultText r={test} />
          </div>
        </div>
      </section>

      <section className={s.section} aria-labelledby="sec-emb">
        <div className={s.aside}>
          <h2 id="sec-emb">Memória semântica</h2>
          <p>Embeddings deixam a busca de memórias e livros por significado (pgvector). Desligados, a busca usa texto do Postgres e o jogo segue funcionando.</p>
        </div>
        <div>
          <label className={s.switch}>
            <b>Usar embeddings</b>
            <span>Gera um vetor por memória e por trecho de livro, pelo OpenRouter (custo baixo).</span>
            <input type="checkbox" role="switch" checked={emb.enabled} onChange={(e) => setEmb({ ...emb, enabled: e.target.checked })} />
          </label>
          <label className="field" style={{ marginTop: 16 }}>
            <span>Modelo de embeddings</span>
            <input type="text" value={emb.model} onChange={(e) => setEmb({ ...emb, model: e.target.value })} spellCheck={false} />
          </label>
          <div className={s.warn}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M8 1.8 14.6 13.5H1.4L8 1.8Z" strokeLinejoin="round" /><path d="M8 6.2v3.4M8 11.6v.1" strokeLinecap="round" /></svg>
            <span>Trocar o modelo exige reprocessar os embeddings já gerados (memórias e livros): vetores de modelos diferentes não se comparam. Salve antes de reprocessar.</span>
          </div>
          <div className={s.row}>
            <button className="btn small" onClick={reprocess} disabled={reRunning}>
              {reRunning && <Loader size={14} label="Reprocessando" />} Reprocessar embeddings
            </button>
            {reRunning ? <span className={s.result}>Pode demorar alguns minutos</span> : <ResultText r={re} />}
          </div>
        </div>
      </section>

      <section className={s.section} aria-labelledby="sec-ui">
        <div className={s.aside}>
          <h2 id="sec-ui">Mesa de jogo</h2>
          <p>Como a tela da campanha se comporta. Vale para todas as campanhas.</p>
        </div>
        <div>
          <label className={s.switch}>
            <b>Animação 3D dos dados</b>
            <span>Quando o Mestre rola, o chat mostra o botão &quot;Rolar dados&quot; e você arremessa os dados numa caixa 3D. O valor é sorteado no servidor; a animação só o mostra. Desligada, o resultado aparece direto no chat.</span>
            <input type="checkbox" role="switch" checked={diceAnimation} onChange={(e) => setDiceAnimation(e.target.checked)} />
            {/* preventDefault: o clique no botão não liga/desliga o interruptor do label */}
            <button type="button" className={`btn small ${s.switchAction}`}
              onClick={(e) => { e.preventDefault(); setDiceTest(testRoll()); }}>
              Ver animação
            </button>
          </label>
          <label className={s.switch}>
            <b>Imagens do ambiente</b>
            <span>O botão &quot;Ver ambiente&quot; gera uma imagem da cena com o Ilustrador; costuma ser a chamada mais cara do jogo. Desligada, o botão some. As imagens que já existem continuam na ficha e na galeria.</span>
            <input type="checkbox" role="switch" checked={imageGeneration} onChange={(e) => setImageGeneration(e.target.checked)} />
          </label>
          <label className={s.switch}>
            <b>O Mestre gera mapas 3D sozinho</b>
            <span>Quando você chega a um lugar importante, o Mestre pede ao Cartógrafo o mapa 3D dele, e o edita quando a história muda o lugar. Usa um modelo caro (Claude Opus). Desligado, só os botões da aba Mapa geram e editam.</span>
            <input type="checkbox" role="switch" checked={autoMaps} onChange={(e) => setAutoMaps(e.target.checked)} />
          </label>
        </div>
      </section>

      <div className={`${s.saveBar} ${dirty ? s.dirty : ""}`}>
        <span className={s.saveMsg} aria-live="polite">{dirty ? "Há alterações não salvas · Ctrl+S salva" : "Tudo salvo"}</span>
        <button className="btn primary" onClick={save} disabled={saving || !dirty}>
          {saving && <Loader size={16} label="Salvando" />} Salvar configurações
        </button>
      </div>

      {diceTest && <DiceRoller result={diceTest} onDone={() => setDiceTest(null)} />}
    </>
  );
}
