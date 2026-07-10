"use client";
import { useEffect, useRef, useState } from "react";
import type { Campaign, Character, VoiceProfile } from "@/lib/types";
import { SheetView } from "./GameClient";

interface ChatMsg {
  role: "player" | "npc";
  content: string;
  refused?: boolean;
}

const DEFAULT_VOICE: VoiceProfile = { pitch: 1, rate: 1, lang: "pt-BR" };

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
  const [voice, setVoice] = useState<VoiceProfile>(npc.voice || DEFAULT_VOICE);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => setVoices(window.speechSynthesis?.getVoices() || []);
    load();
    window.speechSynthesis?.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis?.removeEventListener("voiceschanged", load);
  }, []);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [msgs]);

  const speak = (text: string) => {
    const synth = window.speechSynthesis;
    if (!synth) return alert("Seu navegador não suporta síntese de voz.");
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.pitch = voice.pitch;
    u.rate = voice.rate;
    u.lang = voice.lang;
    const v = voices.find((x) => x.name === voice.voiceName);
    if (v) u.voice = v;
    synth.speak(u);
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
    window.speechSynthesis?.cancel();
    onClose();
  };

  const saveVoice = async (v: VoiceProfile) => {
    setVoice(v);
    await fetch(`/api/campaigns/${campaignId}/npcs/${npc.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice: v }),
    });
  };

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
                    <button className="speak" title="Ouvir" onClick={() => speak(m.content)}>🔊</button>
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
                <span>Voz do navegador</span>
                <select
                  value={voice.voiceName || ""}
                  onChange={(e) => saveVoice({ ...voice, voiceName: e.target.value || undefined })}
                >
                  <option value="">(padrão do sistema)</option>
                  {voices.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.name} ({v.lang})
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Tom (pitch): {voice.pitch.toFixed(2)}</span>
                <input
                  type="range" min={0.5} max={2} step={0.05}
                  value={voice.pitch}
                  onChange={(e) => saveVoice({ ...voice, pitch: Number(e.target.value) })}
                  style={{ width: "100%" }}
                />
              </label>
              <label className="field">
                <span>Velocidade: {voice.rate.toFixed(2)}</span>
                <input
                  type="range" min={0.5} max={2} step={0.05}
                  value={voice.rate}
                  onChange={(e) => saveVoice({ ...voice, rate: Number(e.target.value) })}
                  style={{ width: "100%" }}
                />
              </label>
              <button className="btn small" onClick={() => speak(`Olá. Eu sou ${npc.name}.`)}>
                ▶ Testar voz
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
