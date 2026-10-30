"use client";
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import AdvancedSettings, { reprocessPending } from "@/components/AdvancedSettings";
import Loader from "@/components/ui/Loader";
import { toast } from "@/components/ui/Toast";
import type { ChatgptStatus, DiceResult, SourceView } from "@/lib/types";
import type { Advanced, AdvancedSpec } from "@/lib/advanced";
import SourcesPanel from "./SourcesPanel";
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
  embeddings: { enabled: boolean; model: string; source: string };
  sources: SourceView[]; // fontes cadastradas (chave mascarada)
  chatgpt: ChatgptStatus; // Login com ChatGPT (sem token)
  ui: { diceAnimation: boolean; imageGeneration: boolean; autoMaps: boolean; diceForce: number };
}
type Result = { ok: boolean; text: string } | null;

function ResultText({ r }: { r: Result }) {
  if (!r) return null;
  return <span className={`${s.result} ${r.ok ? s.ok : s.err}`} role="status">{r.ok ? "✓" : "✕"} {r.text}</span>;
}

/** Formulário com os dados já vindos do servidor (sem tela de carregando). */
export default function SettingsForm({ initial, advanced, usedBy, notice }: {
  initial: SettingsShape;
  advanced: { spec: AdvancedSpec; values: Advanced }; // Configurações avançadas (rota própria)
  usedBy: Record<string, string[]>; // agentes por fonte
  notice: { ok: boolean; text: string } | null; // retorno do Login com ChatGPT
}) {
  const [data, setData] = useState(initial);
  const [sources, setSources] = useState(initial.sources);
  const [emb, setEmb] = useState(initial.embeddings);
  const [diceAnimation, setDiceAnimation] = useState(initial.ui.diceAnimation);
  const [diceForce, setDiceForce] = useState(initial.ui.diceForce);
  const [imageGeneration, setImageGeneration] = useState(initial.ui.imageGeneration);
  const [autoMaps, setAutoMaps] = useState(initial.ui.autoMaps);
  const [advSaved, setAdvSaved] = useState(advanced.values);
  const [adv, setAdv] = useState(advanced.values);
  const [saving, setSaving] = useState(false);
  const [reRunning, setReRunning] = useState(false);
  const [re, setRe] = useState<Result>(null);

  const embDirty = emb.enabled !== data.embeddings.enabled || emb.model !== data.embeddings.model || emb.source !== data.embeddings.source;
  const advDirty = JSON.stringify(adv) !== JSON.stringify(advSaved);
  const dirty = embDirty || advDirty || diceAnimation !== data.ui.diceAnimation || diceForce !== data.ui.diceForce || imageGeneration !== data.ui.imageGeneration || autoMaps !== data.ui.autoMaps;

  const save = async () => {
    setSaving(true);
    const body = { embeddings: emb, ui: { diceAnimation, diceForce, imageGeneration, autoMaps } };
    const put = (url: string, b: unknown) =>
      fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).catch(() => null);
    // as avançadas vão na rota própria, só quando mudaram; ela devolve o normalizado (faixas presas)
    const [res, advRes] = await Promise.all([put("/api/settings", body), advDirty ? put("/api/settings/advanced", adv) : null]);
    if (advRes?.ok) {
      const fresh = (await advRes.json()) as Advanced;
      setAdv(fresh);
      setAdvSaved(fresh);
    }
    if (res?.ok && (!advDirty || advRes?.ok)) {
      toast(advDirty && reprocessPending(advanced.spec, adv, advSaved)
        ? "Configurações salvas. Reprocesse os embeddings para os novos parâmetros valerem no que já está indexado."
        : "Configurações salvas.", { kind: "sucesso" });
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

  // a chave do OpenRouter salva na hora (no painel de fontes): relê só a versão mascarada
  const reloadOpenrouter = async () => {
    const fresh = await fetch("/api/settings").then((r) => r.json() as Promise<SettingsShape>).catch(() => null);
    if (fresh) setData((d) => ({ ...d, openrouter: fresh.openrouter }));
  };

  const reprocess = async () => {
    // reprocessa com o modelo salvo no banco, não com o que está na tela
    if (embDirty || advDirty) return setRe({ ok: false, text: "Salve as configurações antes de reprocessar" });
    setReRunning(true);
    setRe(null);
    try {
      const res = await fetch("/api/embeddings/reprocess", { method: "POST" });
      const d = await res.json();
      const n = `${d.memories ?? 0} memórias, ${d.book_chunks ?? 0} trechos de livros e ${d.history_chunks ?? 0} do histórico`;
      setRe(res.ok
        ? { ok: !d.warning, text: `${n} reprocessados${d.dims ? `, vetores de ${d.dims} dimensões` : ""}${d.warning ? `. ${d.warning}` : ""}` }
        : { ok: false, text: `${d.error || res.status}${d.memories !== undefined ? ` (${n} reprocessados; o restante ficou sem embedding)` : ""}` });
    } catch {
      setRe({ ok: false, text: "Falha na requisição" });
    }
    setReRunning(false);
  };

  return (
    <>
      <section className={s.section} aria-labelledby="sec-src" id="fontes">
        <div className={s.aside}>
          <h2 id="sec-src">Fontes de modelos</h2>
          <p>
            Onde os agentes chamam a IA: o OpenRouter (embutido) ou qualquer API compatível com a da OpenAI. As chaves ficam só
            no seu banco local; cada agente escolhe a fonte em <Link href="/agents">Agentes</Link>. Só o OpenRouter informa o custo:
            das outras fontes, Custos e uso mostra os tokens.
          </p>
          <p className={s.note}>Cada fonte salva na hora, pelos próprios botões (fora do Salvar configurações).</p>
        </div>
        <SourcesPanel sources={sources} setSources={setSources} openrouter={data.openrouter} onOpenrouterKey={reloadOpenrouter}
          usedBy={usedBy} initialChatgpt={initial.chatgpt} notice={notice} />
      </section>

      <section className={s.section} aria-labelledby="sec-emb">
        <div className={s.aside}>
          <h2 id="sec-emb">Memória semântica</h2>
          <p>Embeddings deixam a busca de memórias e livros por significado (pgvector). Desligados, a busca usa texto do Postgres e o jogo segue funcionando.</p>
        </div>
        <div>
          <label className={s.switch}>
            <b>Usar embeddings</b>
            <span>Gera um vetor por memória e por trecho de livro, na fonte escolhida abaixo (POST /embeddings; custo baixo).</span>
            <input type="checkbox" role="switch" checked={emb.enabled} onChange={(e) => setEmb({ ...emb, enabled: e.target.checked })} />
          </label>
          <label className="field" style={{ marginTop: 16 }}>
            <span>Fonte (as de Fontes de modelos, acima)</span>
            <select value={emb.source} onChange={(e) => setEmb({ ...emb, source: e.target.value })}>
              <option value="openrouter">OpenRouter</option>
              {sources.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          {sources.find((x) => x.id === emb.source)?.auth === "chatgpt" && (
            <div className={s.warn}>
              <span>Esta fonte está no Login com ChatGPT, que só faz texto pela Responses API: embeddings não funcionam nela. Escolha outra fonte.</span>
            </div>
          )}
          <label className="field">
            <span>Modelo de embeddings</span>
            <input type="text" value={emb.model} onChange={(e) => setEmb({ ...emb, model: e.target.value })} spellCheck={false} />
          </label>
          <div className={s.warn}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M8 1.8 14.6 13.5H1.4L8 1.8Z" strokeLinejoin="round" /><path d="M8 6.2v3.4M8 11.6v.1" strokeLinecap="round" /></svg>
            <span>Trocar o modelo ou a fonte exige reprocessar os embeddings já gerados (memórias, livros e histórico): vetores de modelos diferentes não se comparam. Salve antes de reprocessar.</span>
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
            {/* preventDefault: clicar no slider, no botão ou no texto deles não liga/desliga o interruptor do label */}
            <span className={s.force} onClick={(e) => e.preventDefault()}>
              Força do arremesso
              <input type="range" min={0.5} max={3} step={0.25} value={diceForce} aria-label="Força do arremesso"
                onChange={(e) => setDiceForce(Number(e.target.value))} />
              <output>{diceForce.toLocaleString("pt-BR")}×</output>
            </span>
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

      <section className={s.section} aria-labelledby="sec-adv">
        <div className={s.aside}>
          <h2 id="sec-adv">Configurações avançadas</h2>
          <p>
            Top-k, limiares de distância de cosseno, chunking, dimensões dos embeddings e limiares do Jev, por cenário. A janela
            do histórico e as rodadas de ferramentas do Mestre e a compactação do Cronista ficam em <Link href="/agents">Agentes</Link>.
          </p>
        </div>
        <AdvancedSettings spec={advanced.spec} value={adv} onChange={setAdv} />
      </section>

      <div className={`${s.saveBar} ${dirty ? s.dirty : ""}`}>
        <span className={s.saveMsg} aria-live="polite">{dirty ? "Há alterações não salvas · Ctrl+S salva" : "Tudo salvo"}</span>
        <button className="btn primary" onClick={save} disabled={saving || !dirty}>
          {saving && <Loader size={16} label="Salvando" />} Salvar configurações
        </button>
      </div>

      {/* usa a força da tela, mesmo sem salvar, para testar antes */}
      {diceTest && <DiceRoller result={diceTest} force={diceForce} onDone={() => setDiceTest(null)} />}
    </>
  );
}
