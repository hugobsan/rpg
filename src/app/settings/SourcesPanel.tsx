"use client";
import { useEffect, useState } from "react";
import type { ChatgptStatus, SourceView } from "@/lib/types";
import { presetOf, SOURCE_PRESETS } from "@/lib/sourcePresets";
import Loader from "@/components/ui/Loader";
import { toast } from "@/components/ui/Toast";
import s from "./settings.module.css";

const USAGE = "https://chatgpt.com/settings/usage";
const CHATGPT_NOTE =
  "Login com ChatGPT (preview): os agentes de texto usam o limite da sua assinatura ChatGPT, sem API key. Pode ainda não estar liberado para a sua conta. No Plus, o limite de 5 h é dividido com os outros apps que usam o plano. Temperatura e máximo de tokens são ignorados, e só texto funciona: Ilustrador, Voz, Jev e embeddings não.";

type Draft = { id?: string; kind?: string; name: string; url: string; apiKey: string; auth?: "chatgpt" };
type Test = { ok: boolean; text: string } | "testing";
type Balance = { limit: number | null; remaining: number | null; usage: number; reset: string | null; error?: string } | { error: string } | "loading" | null;

const usd = (n: number) => `US$ ${n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const PERIOD: Record<string, string> = { daily: "diário", weekly: "semanal", monthly: "mensal" };

/**
 * Fontes de modelos: o OpenRouter embutido (a chave dele) e as APIs compatíveis com a da OpenAI (adicionar, editar,
 * testar com GET /models e remover se nenhum agente usa), com o Login com ChatGPT na fonte OpenAI.
 * Cada botão salva na hora: nada aqui entra na barra "Há alterações não salvas".
 */
export default function SourcesPanel({ sources, setSources, openrouter, onOpenrouterKey, usedBy, initialChatgpt, notice }: {
  sources: SourceView[];
  setSources: React.Dispatch<React.SetStateAction<SourceView[]>>;
  openrouter: { configured: boolean; apiKeyMasked: string };
  onOpenrouterKey: () => Promise<void>; // relê a chave mascarada depois de salvar
  usedBy: Record<string, string[]>; // nomes dos agentes por fonte
  initialChatgpt: ChatgptStatus;
  notice: { ok: boolean; text: string } | null; // retorno do Login com ChatGPT (/auth/callback)
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(notice && !notice.ok ? notice.text : "");
  const [confirmDel, setConfirmDel] = useState("");
  const [tests, setTests] = useState<Record<string, Test>>({});
  const [orKey, setOrKey] = useState("");
  const [gpt, setGpt] = useState(initialChatgpt);
  const [bal, setBal] = useState<Balance>(null);
  // fontes além do OpenRouter: recolhidas, e abertas viram um carrossel (abre sozinho na volta do Login com ChatGPT)
  const [showAll, setShowAll] = useState(!!notice);
  // carrossel: um cartão por vez, anda só pelos botões (translateX, sem rolagem)
  const [idx, setIdx] = useState(0);
  const last = Math.max(sources.length - 1, 0);
  const cur = Math.min(idx, last);
  const gptTaken = (id?: string) => sources.find((x) => x.auth && x.id !== id);

  // volta do /auth/callback: confirma uma vez e tira o ?chatgpt da URL
  useEffect(() => {
    if (!notice) return;
    if (notice.ok) toast("Os agentes na fonte OpenAI (Login com ChatGPT) usam o seu plano. Uso e limites em chatgpt.com/settings/usage.", { kind: "sucesso", title: "Você está usando seu plano do ChatGPT" });
    history.replaceState(null, "", "/settings#fontes");
  }, [notice]);

  // saldo da chave do OpenRouter (GET /key é grátis): ao abrir e no Atualizar
  const loadBal = async () => {
    setBal("loading");
    const d = await fetch("/api/sources/balance").then((r) => r.json()).catch(() => ({ error: "erro de rede" }));
    setBal(d);
  };
  useEffect(() => {
    if (openrouter.configured) loadBal();
  }, [openrouter.configured]);

  const test = async (id: string) => {
    setTests((t) => ({ ...t, [id]: "testing" }));
    const r = await fetch(`/api/models?source=${encodeURIComponent(id)}&fresh=1`).catch(() => null);
    const d = await r?.json().catch(() => null);
    const res: Test = r?.ok && Array.isArray(d)
      ? { ok: true, text: `Conectou: ${d.length} ${d.length === 1 ? "modelo" : "modelos"} em GET /models.` }
      : { ok: false, text: `Falhou: ${d?.error || `erro ${r?.status ?? "de rede"}`}` };
    setTests((t) => ({ ...t, [id]: res }));
  };

  const saveOrKey = async () => {
    setBusy(true);
    setError("");
    const res = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ openrouterApiKey: orKey.trim() }) }).catch(() => null);
    setBusy(false);
    if (!res?.ok) return setError("Não foi possível salvar a chave do OpenRouter.");
    setOrKey("");
    await onOpenrouterKey();
    toast("Chave do OpenRouter salva.", { kind: "sucesso" });
    test("openrouter");
    loadBal();
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError("");
    const res = await fetch("/api/sources", {
      method: draft.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    }).catch(() => null);
    const d = await res?.json().catch(() => null);
    setBusy(false);
    if (!res?.ok) return setError(d?.error || `Erro ${res?.status ?? "de rede"} ao salvar a fonte`);
    setSources((list) => (draft.id ? list.map((x) => (x.id === d.id ? d : x)) : [...list, d]));
    setDraft(null);
    setShowAll(true);
    if (!draft.id) setIdx(sources.length); // mostra a nova (vai para o fim da lista)
    toast(`Fonte ${d.name} salva.`, { kind: "sucesso" });
    if (!d.auth || gpt.connected) test(d.id); // confere a conexão já com a URL e a chave novas
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError("");
    const res = await fetch(`/api/sources?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    const d = await res?.json().catch(() => null);
    setBusy(false);
    setConfirmDel("");
    if (!res?.ok) return setError(d?.error || `Erro ${res?.status ?? "de rede"} ao remover a fonte`);
    setSources((list) => list.filter((x) => x.id !== id));
    toast("Fonte removida.", { kind: "sucesso" });
  };

  const connect = async () => {
    setBusy(true);
    setError("");
    const d = await fetch("/api/chatgpt", { method: "POST" }).then((r) => r.json()).catch(() => null);
    if (d?.url) return window.location.assign(d.url); // a OpenAI volta em /auth/callback, que traz de volta para cá
    setBusy(false);
    setError("Não foi possível iniciar o Login com ChatGPT.");
  };

  const disconnect = async () => {
    setBusy(true);
    const d = await fetch("/api/chatgpt", { method: "DELETE" }).then((r) => r.json()).catch(() => null);
    setBusy(false);
    if (!d) return setError("Erro de rede ao desconectar do ChatGPT.");
    setGpt(d);
    if (d.revoked) toast("Desconectado do ChatGPT.", { kind: "sucesso" });
    else toast("Desconectado aqui, mas a OpenAI não confirmou o fim da sessão: desconecte o app nas configurações do ChatGPT.", { kind: "alerta" });
  };

  const edit = (x: Draft | null) => {
    setDraft(x);
    setError("");
  };

  const testLine = (id: string) => {
    const t = tests[id];
    return t && t !== "testing" && <p className={`${s.srcTest} ${t.ok ? s.ok : s.err}`} role="status">{t.ok ? "✓" : "✕"} {t.text}</p>;
  };
  const testButton = (id: string) => (
    <button className="btn small" disabled={tests[id] === "testing"} onClick={() => test(id)}>
      {tests[id] === "testing" && <Loader size={14} label="Testando" />} Testar
    </button>
  );
  const usedLine = (id: string) => (
    <span className={s.srcMeta}>{usedBy[id]?.length ? `Usada por: ${usedBy[id].join(", ")}` : "Nenhum agente usa esta fonte."}</span>
  );

  return (
    <div className={s.srcPanel}>
      <div className={s.srcRow}>
        <div className={s.srcInfo}>
          <span><b>OpenRouter</b><span className="pill">embutida</span></span>
          <span className={s.srcMeta}>
            <code>https://openrouter.ai/api/v1</code> · {openrouter.configured ? <>chave <code>{openrouter.apiKeyMasked}</code></> : <b className={s.err}>sem chave</b>}
          </span>
          {usedLine("openrouter")}
          {bal && (
            <span className={s.srcMeta} role="status">
              {bal === "loading" ? "Lendo o saldo…"
                : "error" in bal && bal.error ? <span className={s.err}>Saldo indisponível: {bal.error}</span>
                : "usage" in bal && (bal.remaining != null && bal.limit != null
                  ? <>Limite {bal.reset ? `${PERIOD[bal.reset] ?? bal.reset} ` : ""}da chave: restam <b>{usd(bal.remaining)}</b> de {usd(bal.limit)} · gasto total {usd(bal.usage)}</>
                  : <>Chave sem limite · gasto total {usd(bal.usage)} · saldo da conta em <a href="https://openrouter.ai/settings/credits" target="_blank" rel="noreferrer">openrouter.ai</a></>)}
            </span>
          )}
        </div>
        <div className={s.srcActions}>
          {testButton("openrouter")}
          {openrouter.configured && <button className="btn small ghost" disabled={bal === "loading"} onClick={loadBal}>Atualizar saldo</button>}
        </div>
        <form className={s.srcKey} onSubmit={(e) => { e.preventDefault(); saveOrKey(); }}>
          <input type="password" value={orKey} onChange={(e) => setOrKey(e.target.value)} autoComplete="off" spellCheck={false}
            aria-label="API key do OpenRouter" placeholder={openrouter.configured ? "Nova chave sk-or-... (substitui a atual)" : "sk-or-v1-..."} />
          <button type="submit" className="btn small" disabled={busy || !orKey.trim()}>Salvar chave</button>
        </form>
        {testLine("openrouter")}
      </div>

      {sources.length > 0 && (
        <div className={s.srcMore}>
          <button type="button" className="btn small ghost" aria-expanded={showAll} aria-controls="src-others" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Ocultar outras fontes" : sources.length === 1 ? "Ver outra fonte" : `Ver outras ${sources.length} fontes`}
          </button>
          {showAll && sources.length > 1 && (
            <span className={s.srcNav}>
              <button type="button" className="btn small ghost" aria-label="Fonte anterior" disabled={cur <= 0} onClick={() => setIdx(cur - 1)}>‹</button>
              <span className={s.srcPos} aria-live="polite">{cur + 1} de {sources.length}</span>
              <button type="button" className="btn small ghost" aria-label="Próxima fonte" disabled={cur >= last} onClick={() => setIdx(cur + 1)}>›</button>
            </span>
          )}
        </div>
      )}

      {showAll && (
      <div id="src-others" className={s.carousel} role="region" aria-roledescription="carrossel" aria-label="Outras fontes de modelos">
      <div className={s.track} style={{ transform: `translateX(calc(${-cur} * (100% + var(--s-3))))` }}>
      {sources.map((x, n) => (
        // fora da vista: inert tira os botões do Tab e do leitor de tela
        <div key={x.id} className={s.srcCard} inert={n !== cur} aria-roledescription="slide" aria-label={`${n + 1} de ${sources.length}: ${x.name}`}>
          <div className={s.srcInfo}>
            <span><b>{x.name}</b><span className="pill">{x.id}</span></span>
            <span className={s.srcMeta}>
              <code>{x.url}</code> · {x.auth ? "Login com ChatGPT" : x.apiKeyMasked ? <>chave <code>{x.apiKeyMasked}</code></> : "sem chave"}
            </span>
            {usedLine(x.id)}
            {(x.auth || presetOf(x.kind)) && (
              <details className={s.srcMeta}>
                <summary>Limitações</summary>
                {x.auth ? CHATGPT_NOTE : presetOf(x.kind)!.note}
              </details>
            )}
          </div>
          <div className={s.srcActions}>
            {confirmDel === x.id ? (
              <>
                <span className="muted">Remover {x.name}?</span>
                <button className="btn small danger" disabled={busy} onClick={() => remove(x.id)}>Remover</button>
                <button className="btn small ghost" disabled={busy} onClick={() => setConfirmDel("")}>Cancelar</button>
              </>
            ) : (
              <>
                {testButton(x.id)}
                <button className="btn small ghost" onClick={() => edit({ id: x.id, kind: x.kind, name: x.name, url: x.url, apiKey: "", auth: x.auth })}>Editar</button>
                {/* em uso por agente: troque a fonte deles antes (os embeddings o servidor confere) */}
                {!usedBy[x.id]?.length && <button className="btn small ghost" onClick={() => setConfirmDel(x.id)}>Remover</button>}
              </>
            )}
          </div>
          {x.auth && (
            <div className={s.gptRow}>
              {gpt.connected ? (
                <>
                  <span>
                    Conectado como <b>{gpt.email || "sua conta"}</b>
                    {gpt.sessionUntil && <span className="muted"> · renova sozinho a cada uso (parado, vale até {new Date(gpt.sessionUntil).toLocaleDateString("pt-BR")})</span>}
                  </span>
                  <button className="btn small ghost" disabled={busy} onClick={disconnect}>Desconectar</button>
                  <a href={USAGE} target="_blank" rel="noreferrer">Gerenciar uso</a>
                </>
              ) : (
                // botão no formato das guidelines do Sign in with ChatGPT ("Continue with ChatGPT", preto ou branco)
                <button className={s.gptBtn} data-oai-siwc-button disabled={busy} onClick={connect}>
                  {busy && <Loader size={14} label="Abrindo o ChatGPT" />} Continuar com o ChatGPT
                </button>
              )}
            </div>
          )}
          {testLine(x.id)}
        </div>
      ))}
      </div>
      </div>
      )}

      {draft ? (
        <form className={s.srcAdd} onSubmit={(e) => { e.preventDefault(); save(); }}>
          {/* tipo conhecido: nome e URL já vêm preenchidos, só falta a chave; o tipo não muda depois */}
          {!draft.id && (
            <label className="field">
              <span>Tipo</span>
              <select value={draft.kind ?? ""} onChange={(e) => {
                const p = presetOf(e.target.value);
                setDraft({ ...draft, kind: p?.kind, name: p?.name ?? "", url: p?.url ?? "", auth: undefined });
              }}>
                {SOURCE_PRESETS.map((p) => <option key={p.kind} value={p.kind}>{p.name}</option>)}
                <option value="">Personalizada</option>
              </select>
            </label>
          )}
          {draft.kind === "openai" && (
            <label className="field">
              <span>Autenticação</span>
              <select value={draft.auth ?? ""} onChange={(e) => setDraft({ ...draft, auth: e.target.value ? "chatgpt" : undefined })}>
                <option value="">API key</option>
                <option value="chatgpt" disabled={!!gptTaken(draft.id)}>
                  {gptTaken(draft.id) ? `Login com ChatGPT (já usado na fonte ${gptTaken(draft.id)!.name})` : "Login com ChatGPT"}
                </option>
              </select>
            </label>
          )}
          <div className={s.warn} role="note">
            <span>
              {draft.auth ? CHATGPT_NOTE : presetOf(draft.kind)?.note ?? <>
                A API precisa ser <b>compatível com a da OpenAI</b>: <code>POST {"{URL}"}/chat/completions</code> e, de preferência,{" "}
                <code>GET {"{URL}"}/models</code> para listar os modelos (sem ela, digite o id do modelo). Use a URL base, como{" "}
                <code>http://localhost:11434/v1</code>.
              </>}
            </span>
          </div>
          <label className="field">
            <span>Nome</span>
            <input type="text" value={draft.name} maxLength={60} placeholder="Ollama local"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="field">
            <span>URL base</span>
            {/* tipo conhecido: URL fixa (o servidor também ignora outra) */}
            {presetOf(draft.kind) ? (
              <input type="url" className={s.fixedUrl} value={presetOf(draft.kind)!.url} readOnly title="Fonte de tipo conhecido: a URL é fixa" />
            ) : (
              <input type="url" value={draft.url} spellCheck={false} placeholder="http://localhost:11434/v1"
                onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
            )}
          </label>
          {!draft.auth && (
            <label className="field">
              <span>API key</span>
              <input type="password" value={draft.apiKey} autoComplete="off" spellCheck={false}
                placeholder={draft.id ? "em branco: mantém a atual" : draft.kind ? "cole a chave da sua conta" : "opcional (Ollama local não usa)"}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} />
            </label>
          )}
          <div className={s.row}>
            <button type="submit" className="btn primary small"
              disabled={busy || !draft.name.trim() || !draft.url.trim() || (!draft.id && !!draft.kind && !draft.auth && !draft.apiKey.trim())}>
              {busy && <Loader size={14} label="Salvando" />} {draft.id ? "Salvar fonte" : "Adicionar fonte"}
            </button>
            <button type="button" className="btn small ghost" disabled={busy} onClick={() => edit(null)}>Cancelar</button>
          </div>
        </form>
      ) : (
        <div className={s.srcRow}>
          <button className="btn small" onClick={() => { const p = SOURCE_PRESETS[0]; edit({ kind: p.kind, name: p.name, url: p.url, apiKey: "" }); }}>Adicionar fonte</button>
        </div>
      )}
      {error && <div className="error-box">{error}</div>}
    </div>
  );
}
