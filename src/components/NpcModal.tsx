"use client";
import { useEffect, useRef, useState } from "react";
import type { Campaign, Character, Persona, VoiceFx, VoiceProfile } from "@/lib/types";
import { FX_DEFAULT, fxOf, playVoice, stopVoice } from "@/lib/voiceFx";
import SheetView from "./SheetView";
import AbilitiesView from "./AbilitiesView";
import Portrait, { PortraitButton } from "./Portrait";
import Loader from "./ui/Loader";
import { toast } from "./ui/Toast";
import s from "./NpcModal.module.css";

interface ChatMsg {
  role: "player" | "npc";
  content: string;
  refused?: boolean;
}

let loadingKey: string | null = null; // fala (npc + texto) sendo gerada agora
let lineSeq = 0;

/**
 * Toca a fala na voz do NPC (TTS do OpenRouter; o servidor guarda o áudio, repetir não cobra).
 * Velocidade e tom do personagem (persona.voiceFx) são aplicados só aqui, no navegador; o mp3 é o mesmo.
 */
export async function playLine(
  campaignId: string,
  npc: Pick<Character, "id" | "persona">,
  text: string,
  fx: VoiceFx = fxOf(npc.persona)
) {
  const key = `${npc.id}\n${text}`;
  if (loadingKey === key) return; // clique repetido enquanto a mesma fala carrega: ignora
  const me = ++lineSeq;
  loadingKey = key;
  stopVoice();
  try {
    const res = await fetch(`/api/campaigns/${campaignId}/npcs/${npc.id}/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return void toast(d.error || `Erro ${res.status} ao gerar a voz`, { kind: "alerta" });
    if (me !== lineSeq) return; // outra fala foi pedida depois: a mais recente vence
    playVoice(d.url, fx); // já tocando? playVoice para o anterior e recomeça, sem sobrepor
    return d as { voice: string; gender: "male" | "female" | null };
  } finally {
    if (loadingKey === key) loadingKey = null;
  }
}

interface TtsInfo {
  model: string;
  male: string;
  female: string;
  voices: string[] | null; // null = o catálogo não lista: campo livre
}

const Svg = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const SPEAKER = "M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12";
const TABS = [["chat", "Conversa"], ["profile", "Perfil"], ["sheet", "Ficha"], ["voice", "Voz"]] as const;
// segredos ficam de fora: só o Mestre vê
const PROFILE: [keyof Persona, string][] = [
  ["appearance", "Aparência"],
  ["personality", "Personalidade"],
  ["speech", "Jeito de falar"],
  ["quirks", "Manias"],
  ["current", "Situação atual"],
  ["backstory", "Passado"],
  ["goals", "Objetivos"],
  ["relationships", "Relações"],
];

export default function NpcModal({
  campaignId,
  npc,
  campaign,
  profiling = false,
  session,
  onChanged,
  onToggleActive,
  onClose,
  onBackToCampaign,
}: {
  campaignId: string;
  npc: Character;
  campaign: Campaign;
  profiling?: boolean; // o Criador de personagens está montando o perfil agora
  onChanged?: () => void;
  // conversa que começou no chat da campanha (evento npc_talk): abre nela, já com as falas
  session?: { id: string; messages: ChatMsg[] };
  onToggleActive: (npc: Character) => void; // tirar/trazer da cena; quem chama fecha o modal
  // saved: a conversa foi encerrada e registrada (linha no chat da campanha); farewell: a fala de encerramento do NPC
  onClose: (saved: boolean, farewell?: string) => void;
  // "não era uma conversa": a conversa é apagada e quem chama manda a fala como turno da campanha (e fecha o modal)
  onBackToCampaign?: () => void;
}) {
  const [view, setView] = useState<(typeof TABS)[number][0]>("chat");
  const [redoing, setRedoing] = useState(false);
  const [msgs, setMsgs] = useState<ChatMsg[]>(session?.messages ?? []);
  const [sessionId, setSessionId] = useState<string | null>(session?.id ?? null);
  const [calledBy, setCalledBy] = useState(false); // a conversa foi aberta pelo NPC (npc_message)
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [ending, setEnding] = useState(false);
  const [voice, setVoice] = useState<VoiceProfile | null>(npc.voice);
  const [gender, setGender] = useState(npc.persona.gender);
  const [tts, setTts] = useState<TtsInfo | null>(null);
  const [speaking, setSpeaking] = useState<number | null>(null); // índice da fala gerando voz (-1 = prévia)
  const [fx, setFx] = useState<VoiceFx>(() => fxOf(npc.persona));
  const fxRef = useRef(fx); // valor mais recente, para a prévia e para salvar ao soltar o slider
  const fxSaved = useRef(fx); // último salvo: volta para ele se o servidor recusar
  const feedRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (view === "voice" && !tts)
      fetch(`/api/campaigns/${campaignId}/npcs/${npc.id}/speech`).then((r) => r.json()).then(setTts);
  }, [view, tts, campaignId, npc.id]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);

  // o NPC mandou mensagem (npc_message): abre nessa conversa; o servidor marca como lida
  useEffect(() => {
    if (session) return;
    fetch(`/api/campaigns/${campaignId}/npcs/${npc.id}?pending=1`)
      .then((r) => r.json())
      .then((d: { sessionId: string | null; messages: ChatMsg[] }) => {
        if (!d.sessionId) return;
        setSessionId(d.sessionId);
        setCalledBy(true);
        setMsgs(d.messages.map((m) => ({ role: m.role, content: m.content })));
      })
      .catch(() => {});
  }, [campaignId, npc.id, session]);

  // Esc fecha (encerrando a conversa, como o clique fora)
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && endChat();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const speak = async (text: string, idx: number) => {
    setSpeaking(idx);
    await saving.current; // a prévia logo após trocar a voz espera o save
    const d = await playLine(campaignId, npc, text, fxRef.current);
    if (d?.gender && gender === undefined) setGender(d.gender); // o Jev decidiu o sexo agora
    setSpeaking(null);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setInput("");
    setMsgs((m) => [...m, { role: "player", content: text }]);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/npcs/${npc.id}/talk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, sessionId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "erro");
      setSessionId(data.sessionId);
      setMsgs((m) => [...m, { role: "npc", content: data.reply, refused: data.refused }]);
    } catch (e) {
      setMsgs((m) => [
        ...m,
        { role: "npc", content: `(erro: ${e instanceof Error ? e.message : e})`, refused: true },
      ]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const endChat = async () => {
    if (ending) return;
    let saved = false;
    let farewell: string | undefined;
    if (sessionId && msgs.length >= 2) {
      setEnding(true);
      // session: a conversa nasceu de uma ação no chat da campanha, e o NPC fecha com uma fala lá
      const res = await fetch(`/api/campaigns/${campaignId}/npcs/${npc.id}/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, fromCampaign: !!session }),
      }).catch(() => null);
      saved = !!res?.ok;
      if (saved) farewell = (await res!.json().catch(() => ({}))).farewell;
    }
    stopVoice();
    onClose(saved, farewell);
  };

  const backToCampaign = async () => {
    if (ending || !sessionId) return;
    setEnding(true);
    const ok = await fetch(`/api/campaigns/${campaignId}/npcs/${npc.id}/end`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, discard: true }),
    }).then((r) => r.ok, () => false);
    if (!ok) {
      setEnding(false);
      toast("Tente de novo.", { kind: "alerta", title: "Não deu para desfazer a conversa" });
      return;
    }
    stopVoice();
    onBackToCampaign?.();
  };

  // otimista: a tela já mudou; se o PUT falhar, `undo` desfaz e sai o aviso
  const saveNpc = (body: object, undo: () => void, ok?: () => void) =>
    (saving.current = fetch(`/api/campaigns/${campaignId}/npcs/${npc.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .catch(() => null)
      .then((res) => {
        if (res?.ok) return ok?.();
        undo();
        toast("A alteração voltou ao que era.", { kind: "alerta", title: `Não deu para salvar ${npc.name}` });
      }));
  // voz vazia = padrão pelo sexo
  const saveVoice = (v: string) => {
    const prev = voice;
    const next = v && tts ? { model: tts.model, voice: v } : null;
    setVoice(next);
    saveNpc({ voice: next }, () => setVoice(prev));
  };
  const saveGender = (g: string) => {
    const prev = gender;
    const next = g === "male" || g === "female" ? g : null;
    setGender(next);
    saveNpc({ gender: next }, () => setGender(prev));
  };
  const changeFx = (patch: Partial<VoiceFx>) => setFx((fxRef.current = { ...fxRef.current, ...patch }));
  const saveFx = () => {
    const sent = fxRef.current;
    saveNpc(
      { voiceFx: sent },
      () => fxRef.current === sent && setFx((fxRef.current = fxSaved.current)), // só se não mexeram de novo
      () => { fxSaved.current = sent; }
    );
  };
  const resetFx = (k: keyof VoiceFx) => {
    changeFx({ [k]: FX_DEFAULT[k] });
    saveFx();
  };
  const chosen = tts && voice?.model === tts.model ? voice.voice : "";
  const defaultVoice = tts ? (gender === "female" ? tts.female : tts.male) : "";

  const redoProfile = async () => {
    setRedoing(true);
    const res = await fetch(`/api/campaigns/${campaignId}/npcs/${npc.id}/profile`, { method: "POST" }).catch(() => null);
    setRedoing(false);
    if (!res?.ok) return void toast("Não deu para pedir agora. Tente de novo.", { kind: "alerta" });
    toast(`O Criador de personagens está refazendo o perfil de ${npc.name}.`);
    onChanged?.();
  };
  const p = npc.persona;
  const facts = PROFILE.filter(([k]) => p[k]);

  // otimista: o modal fecha e a lista muda na hora (GameClient); o PUT vai depois
  const toggleActive = () => {
    stopVoice();
    onToggleActive(npc);
  };

  return (
    <div className="modal-backdrop" onClick={endChat}>
      <div className={`modal ${s.modal}`} role="dialog" aria-modal="true" aria-label={`Conversa com ${npc.name}`} onClick={(e) => e.stopPropagation()}>
        <div className={s.head}>
          <Portrait char={npc} size={72} />
          <div className={s.who}>
            <h3 className={s.name}>{npc.name}</h3>
            <div className={s.status}>
              <span className={`${s.dot}${npc.active ? ` ${s.on}` : ""}`} aria-hidden="true" />
              {npc.active ? "em cena" : "fora de cena"}
              {npc.canon && <> · cânone</>}
            </div>
            <div className={s.portraitAction}><PortraitButton char={npc} onChange={onChanged} /></div>
          </div>
          <button className={s.icon} onClick={toggleActive} data-tip={npc.active ? "Tirar de cena" : "Trazer para a cena"} data-tip-pos="below"
            aria-label={npc.active ? `Tirar ${npc.name} de cena` : `Trazer ${npc.name} para a cena`}>
            <Svg d={npc.active ? "M14 4h5v16h-5M10 8l-4 4 4 4M6 12h9" : "M14 4h5v16h-5M9 8l4 4-4 4M13 12H4"} />
          </button>
          <button className={s.icon} onClick={endChat} disabled={ending} aria-label="Fechar">
            {ending ? <Loader size={18} label="Salvando a conversa" /> : <Svg d="M6 6l12 12M18 6 6 18" />}
          </button>
        </div>

        <div className={s.tabs} role="tablist">
          {TABS.map(([v, label]) => (
            <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)}>{label}</button>
          ))}
        </div>

        <div className={s.body} ref={view === "chat" ? feedRef : undefined}>
          {view === "chat" && (
            <div className={s.feed} aria-live="polite">
              {calledBy && (
                <div className={s.called}>
                  <Svg d="M4 6h16v12H4zM4 7l8 6 8-6" />
                  <span><b>{npc.name}</b> procurou você em particular. O Mestre não narra esta conversa; o que for importante entra na história quando você encerrar.</span>
                </div>
              )}
              {session && (
                <div className={s.called}>
                  <Svg d="M4 5h16v11H10l-5 4v-4H4z" />
                  <span>Você falou com <b>{npc.name}</b>: a conversa segue aqui, fora da narração do Mestre. Ao encerrar, o que ela mudou (itens, missões) é registrado e o Mestre retoma a cena de onde ela parou.</span>
                </div>
              )}
              {/* só antes de seguir a conversa: depois dela, voltar apagaria falas que o jogador quis */}
              {session && onBackToCampaign && msgs.length <= 2 && (
                <button className={`btn ghost small ${s.back}`} disabled={busy || ending} onClick={backToCampaign}>
                  Não era uma conversa? Continuar no chat da campanha
                </button>
              )}
              {msgs.length === 0 && (
                <p className={s.intro}>
                  <b>Conversa particular com {npc.name}</b>
                  Fora da narração do Mestre. Dependendo da cena, o personagem pode recusar parar para conversar.
                  Ao encerrar, o que ela mudou (itens, missões, fatos importantes) é registrado, e {npc.name} lembra de tudo.
                </p>
              )}
              {msgs.map((m, i) => (
                <div key={i} className={`${s.line} ${s[m.role]}${m.refused ? ` ${s.refused}` : ""}`}>
                  <div className={s.bubble}>{m.content}</div>
                  {m.role === "npc" && !m.refused && (
                    <button className={`${s.speak}${speaking === i ? ` ${s.busy}` : ""}`} data-tip="Ouvir a fala" aria-label={`Ouvir ${npc.name}`}
                      disabled={speaking !== null} onClick={() => speak(m.content, i)}>
                      {speaking === i ? <Loader size={16} label="Gerando a voz" /> : <Svg d={SPEAKER} size={15} />}
                    </button>
                  )}
                </div>
              ))}
              {busy && (
                <div className={`${s.line} ${s.npc}`}>
                  <div className={`${s.bubble} ${s.typing}`} role="status" aria-label={`${npc.name} está respondendo`}>
                    <i /><i /><i />
                  </div>
                </div>
              )}
            </div>
          )}
          {view === "profile" && (
            <div className={s.profile}>
              {profiling && (
                <div className={s.working}>
                  <Loader size={18} label="Montando o perfil" />
                  <span>O Criador de personagens está montando o perfil de <b>{npc.name}</b>. A ficha e o retrato chegam sozinhos.</span>
                </div>
              )}
              {(p.role || p.age) && <p className={s.tagline}>{[p.role, p.age].filter(Boolean).join(" · ")}</p>}
              {facts.length > 0 ? (
                <dl className={s.facts}>
                  {facts.map(([k, label]) => (
                    <div key={k}>
                      <dt>{label}</dt>
                      <dd>{String(p[k])}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                !profiling && <p className={s.intro}><b>Sem perfil ainda</b>Peça ao Criador de personagens para montar um a partir do que já aconteceu na história.</p>
              )}
              <div className={s.redo}>
                <button className="btn small" onClick={redoProfile} disabled={profiling || redoing}>
                  {redoing ? <Loader size={16} label="Pedindo" /> : <Svg d="M20 11a8 8 0 0 0-14.3-4.9M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9M20 20v-4h-4" size={15} />} Refazer perfil
                </button>
                <span>Reescreve o perfil e completa a ficha, mantendo nome, sexo e o que já aconteceu na história.</span>
              </div>
            </div>
          )}
          {view === "sheet" && (
            <>
              <SheetView char={npc} campaign={campaign} />
              {npc.sheet.abilities.length > 0 && <AbilitiesView char={npc} ruleset={campaign.ruleset} />}
            </>
          )}
          {view === "voice" && (
            <div className={s.voice}>
              <label className="field">
                <span>Sexo (define a voz padrão)</span>
                <select value={gender ?? ""} onChange={(e) => saveGender(e.target.value)}>
                  <option value="">
                    não definido {gender === undefined ? "(o Jev decide na 1ª fala)" : "(usa a voz masculina padrão)"}
                  </option>
                  <option value="male">masculino</option>
                  <option value="female">feminino</option>
                </select>
              </label>
              {!tts ? (
                <Loader size={22} label="Carregando as vozes" showLabel />
              ) : (
                <label className="field">
                  <span>Voz ({tts.model}, escolhido no agente Voz)</span>
                  {tts.voices ? (
                    <select value={chosen} onChange={(e) => saveVoice(e.target.value)}>
                      <option value="">padrão pelo sexo ({defaultVoice || "sem voz padrão"})</option>
                      {tts.voices.map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  ) : (
                    <input type="text" defaultValue={chosen} placeholder={`padrão pelo sexo (${defaultVoice || "sem voz padrão"})`}
                      onBlur={(e) => saveVoice(e.target.value.trim())} />
                  )}
                </label>
              )}
              <FxSlider label="Velocidade (mantém o tom)" min={0.5} max={2} step={0.05} value={fx.rate}
                show={(v) => `${String(+v.toFixed(2)).replace(".", ",")}x`}
                onChange={(rate) => changeFx({ rate })} onCommit={saveFx} onReset={() => resetFx("rate")} />
              <FxSlider label="Tom (mantém a velocidade)" min={-12} max={12} step={1} value={fx.pitch}
                show={(v) => `${v > 0 ? "+" : ""}${v} st`}
                onChange={(pitch) => changeFx({ pitch })} onCommit={saveFx} onReset={() => resetFx("pitch")} />
              <p>Só muda como o áudio toca aqui no navegador; nada vai para a API de voz. Tom muito alto ou baixo pode soar artificial.</p>
              <button className="btn small" style={{ alignSelf: "flex-start" }} disabled={speaking !== null}
                onClick={() => speak(`Olá. Eu sou ${npc.name}.`, -1)}>
                {speaking === -1 ? <Loader size={16} label="Gerando a voz" /> : <Svg d={SPEAKER} size={15} />} Ouvir prévia
              </button>
            </div>
          )}
        </div>

        {view === "chat" && (
          <>
            <div className={s.composer}>
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                placeholder={`Falar com ${npc.name}...`}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                disabled={busy}
              />
              <button className={`btn primary ${s.send}`} onClick={send} disabled={busy || !input.trim()} aria-label="Enviar">
                <Svg d="M5 12h13M13 6l6 6-6 6" />
              </button>
            </div>
            <div className={s.foot}>
              <span className={s.hint}>Enter envia · Shift+Enter quebra a linha</span>
              <button className="btn ghost small" onClick={endChat} disabled={ending}>
                {ending ? "Salvando..." : "Encerrar conversa"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function FxSlider({ label, min, max, step, value, show, onChange, onCommit, onReset }: {
  label: string; min: number; max: number; step: number; value: number;
  show: (v: number) => string;
  onChange: (v: number) => void; onCommit: () => void; onReset: () => void;
}) {
  return (
    <label className="field">
      <span>{label}: <b className={s.val}>{show(value)}</b></span>
      <div className={s.slider}>
        <input type="range" min={min} max={max} step={step} value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          onPointerUp={onCommit} onKeyUp={onCommit} />
        <button type="button" className="btn ghost small" data-tip="Voltar ao padrão" data-tip-align="end" aria-label="Voltar ao padrão" onClick={onReset}>
          <Svg d="M4 12a8 8 0 1 0 3-6.3M4 4v4h4" size={15} />
        </button>
      </div>
    </label>
  );
}
