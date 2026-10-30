"use client";
import { useEffect, useRef, useState } from "react";
import type { Campaign, Character, VoiceProfile } from "@/lib/types";
import { SheetView } from "./GameClient";

interface ChatMsg {
  role: "player" | "npc";
  content: string;
  refused?: boolean;
}

let current: HTMLAudioElement | null = null;

/** Toca a fala na voz do NPC (TTS do OpenRouter; o servidor guarda o áudio, repetir não cobra). */
export async function playLine(campaignId: string, npcId: string, text: string) {
  current?.pause();
  const res = await fetch(`/api/campaigns/${campaignId}/npcs/${npcId}/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return alert(d.error || `Erro ${res.status} ao gerar a voz`);
  current = new Audio(d.url);
  current.play().catch(() => {});
  return d as { voice: string; gender: "male" | "female" | null };
}

interface TtsInfo {
  model: string;
  male: string;
  female: string;
  voices: string[] | null; // null = o catálogo não lista: campo livre
}

export default function NpcModal({
  campaignId,
  npc,
  campaign,
  onClose,
}: {
  campaignId: string;
  npc: Character;
  campaign: Campaign;
  onClose: () => void;
}) {
  const [view, setView] = useState<"chat" | "sheet" | "voice">("chat");
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [ending, setEnding] = useState(false);
  const [voice, setVoice] = useState<VoiceProfile | null>(npc.voice);
  const [gender, setGender] = useState(npc.persona.gender);
  const [tts, setTts] = useState<TtsInfo | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (view === "voice" && !tts)
      fetch(`/api/campaigns/${campaignId}/npcs/${npc.id}/speech`).then((r) => r.json()).then(setTts);
  }, [view, tts, campaignId, npc.id]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [msgs]);

  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const speak = async (text: string) => {
    setSpeaking(true);
    await saving.current; // a prévia logo após trocar a voz espera o save
    const d = await playLine(campaignId, npc.id, text);
    if (d?.gender && gender === undefined) setGender(d.gender); // o Jev decidiu o sexo agora
    setSpeaking(false);
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
    }
  };

  const endChat = async () => {
    if (sessionId && msgs.length >= 2) {
      setEnding(true);
      await fetch(`/api/campaigns/${campaignId}/npcs/${npc.id}/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      }).catch(() => {});
    }
    current?.pause();
    onClose();
  };

  const saveNpc = (body: object) =>
    (saving.current = fetch(`/api/campaigns/${campaignId}/npcs/${npc.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {}));
  // voz vazia = padrão pelo sexo
  const saveVoice = (v: string) => {
    const next = v && tts ? { model: tts.model, voice: v } : null;
    setVoice(next);
    saveNpc({ voice: next });
  };
  const saveGender = (g: string) => {
    const next = g === "male" || g === "female" ? g : null;
    setGender(next);
    saveNpc({ gender: next });
  };
  const chosen = tts && voice?.model === tts.model ? voice.voice : "";
  const defaultVoice = tts ? (gender === "female" ? tts.female : tts.male) : "";

  const toggleActive = async () => {
    await fetch(`/api/campaigns/${campaignId}/npcs/${npc.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !npc.active }),
    });
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={endChat}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 style={{ margin: 0, flex: 1 }}>
            {npc.name}{" "}
            {npc.canon && <span className="pill">cânone</span>}
            <span className={`pill ${npc.active ? "on" : ""}`}>{npc.active ? "em cena" : "fora de cena"}</span>
          </h3>
          {(["chat", "sheet", "voice"] as const).map((v) => (
            <button
              key={v}
              className={`btn small ${view === v ? "" : "ghost"}`}
              onClick={() => setView(v)}
            >
              {v === "chat" ? "💬" : v === "sheet" ? "📋" : "🔊"}
            </button>
          ))}
          <button className="btn ghost small" onClick={endChat}>✕</button>
        </div>

        <div className="modal-body">
          {view === "chat" && (
            <div className="npc-chat-feed" ref={feedRef} style={{ maxHeight: "50vh", overflowY: "auto" }}>
              {msgs.length === 0 && (
                <p className="muted">
                  Conversa particular com {npc.name}, fora da narração do Mestre. Dependendo da cena,
                  o personagem pode recusar parar para conversar. Ao fechar, o Cronista salva só os
                  pontos importantes para o Mestre — o NPC lembra de tudo.
                </p>
              )}
              {msgs.map((m, i) => (
                <div key={i} className={`npc-bubble ${m.role}`}>
                  {m.content}
                  {m.role === "npc" && !m.refused && (
                    <button className="speak" title="Ouvir" disabled={speaking} onClick={() => speak(m.content)}>🔊</button>
                  )}
                </div>
              ))}
              {busy && (
                <div className="thinking">
                  <span className="dot" /><span className="dot" /><span className="dot" />
                  {npc.name} está respondendo...
                </div>
              )}
            </div>
          )}
          {view === "sheet" && <SheetView char={npc} campaign={campaign} />}
          {view === "voice" && (
            <div>
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
              {!tts && <p className="muted">Carregando vozes...</p>}
              {tts && (
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
              <button className="btn small" disabled={speaking} onClick={() => speak(`Olá. Eu sou ${npc.name}.`)}>
                {speaking ? "gerando..." : "▶ Ouvir prévia"}
              </button>
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn ghost small" onClick={toggleActive}>
            {npc.active ? "Tirar de cena" : "Trazer para a cena"}
          </button>
          <span style={{ flex: 1 }} />
          {view === "chat" && (
            <>
              <input
                type="text"
                value={input}
                placeholder={`Falar com ${npc.name}...`}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
                disabled={busy}
                style={{ flex: 3 }}
              />
              <button className="btn primary small" onClick={send} disabled={busy || !input.trim()}>➤</button>
              <button className="btn ghost small" onClick={endChat} disabled={ending}>
                {ending ? "salvando..." : "Encerrar conversa"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
