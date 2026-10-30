import { createHash } from "node:crypto";
import { q } from "./db";
import { getAgent } from "./agents";
import { getOpenRouterKey, listModels, logApiCall } from "./openrouter";
import { decideGender } from "./decisions";
import type { Campaign, Character } from "./types";

/**
 * Voz dos NPCs via TTS do OpenRouter (/audio/speech, compatível com a OpenAI).
 * O áudio gerado fica em tts_cache (chave = modelo + voz + texto): repetir a fala não cobra de novo.
 */

const SPEECH_URL = "https://openrouter.ai/api/v1/audio/speech";

/** Só a fala: os trechos entre aspas, se houver; senão o texto sem as ações *entre asteriscos*. Sem markdown. */
export function speechText(raw: string): string {
  const plain = raw.replace(/\*\*/g, ""); // negrito fica (só tira a marcação)
  const quoted = plain.match(/["“][^"”]+["”]/g);
  const text = quoted ? quoted.map((s) => s.slice(1, -1)).join(" ") : plain.replace(/\*[^*]+\*/g, " ");
  return text.replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim();
}

/** Modelo e vozes padrão do agente Voz. */
export async function voiceSettings() {
  const agent = await getAgent("voice");
  const p = agent.params as { maleVoice?: string; femaleVoice?: string };
  return { model: agent.model, male: p.maleVoice || "", female: p.femaleVoice || "" };
}

/** Vozes que o modelo aceita, pelo catálogo (null = o catálogo não lista; aí a voz é texto livre). */
export async function modelVoices(model: string): Promise<string[] | null> {
  return (await listModels()).find((m) => m.id === model || m.slug === model)?.voices ?? null;
}

/**
 * Voz do NPC: a escolhida à mão (se for do modelo atual) ou a padrão do sexo.
 * Sexo nunca decidido (undefined): pergunta ao Jev e grava; desconhecido usa a voz masculina.
 */
export async function npcVoice(npc: Character, campaign: Campaign) {
  const s = await voiceSettings();
  if (npc.voice?.model === s.model) return { model: s.model, voice: npc.voice.voice, gender: npc.persona.gender ?? null };
  let gender = npc.persona.gender;
  if (gender === undefined) {
    gender = await decideGender(
      { name: npc.name, canon: npc.canon, setting: campaign.ruleset.name, persona: npc.persona },
      campaign.id
    );
    if (gender !== undefined) // Jev falhou: não grava, tenta de novo na próxima fala
      await q(
        `UPDATE characters SET persona = persona || jsonb_build_object('gender', $1::text), updated_at = now() WHERE id = $2`,
        [gender, npc.id]
      );
  }
  return { model: s.model, voice: gender === "female" ? s.female : s.male, gender: gender ?? null };
}

/** PCM 16 bits cru → WAV (o navegador não toca PCM sem cabeçalho). Taxa e canais vêm do Content-Type. */
function pcmToWav(pcm: Buffer, type: string): Buffer {
  const rate = Number(/rate=(\d+)/.exec(type)?.[1] || 24000);
  const ch = Number(/channels=(\d+)/.exec(type)?.[1] || 1);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(ch, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * ch * 2, 28);
  h.writeUInt16LE(ch * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Gera o áudio da fala (ou acha no cache). Devolve a chave do cache, servida em /api/tts/[key]. */
export async function synthesize(
  text: string,
  model: string,
  voice: string,
  meta: { campaignId?: string | null; purpose: string }
): Promise<string> {
  const key = createHash("sha256").update(`${model}\n${voice}\n${text}`).digest("hex");
  if ((await q(`SELECT 1 FROM tts_cache WHERE key = $1`, [key])).length) return key;

  const apiKey = await getOpenRouterKey();
  if (!apiKey) throw new Error("Chave do OpenRouter não configurada. Vá em Configurações e informe sua API key.");
  const request = { model, voice: voice || undefined, input: text };
  const call = (response_format: string) =>
    fetch(SPEECH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "Chronicle RPG" },
      body: JSON.stringify({ ...request, response_format }),
    });
  const started = Date.now();
  let genId: string | null = null;
  let error: string | null = null;
  let saved: { mime: string; bytes: number } | null = null;
  try {
    let res = await call("pcm"); // pcm é o formato que todos dão, menos o MiniMax (só mp3)
    if (res.status === 400) res = await call("mp3");
    genId = res.headers.get("x-generation-id");
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const type = res.headers.get("content-type") || "audio/mpeg";
    const raw = Buffer.from(await res.arrayBuffer());
    // ponytail: PCM vira WAV sem compressão (~90 KB/s a 44,1 kHz); converter para mp3 pediria uma dependência
    const [mime, data] = type.startsWith("audio/pcm") ? ["audio/wav", pcmToWav(raw, type)] : [type.split(";")[0], raw];
    await q(`INSERT INTO tts_cache (key, mime, data) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING`, [key, mime, data]);
    saved = { mime, bytes: data.length };
    return key;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    const durationMs = Date.now() - started;
    // a resposta é só áudio: custo e tokens vêm de /generation, buscado depois sem segurar a fala
    void (async () => {
      let gen: { total_cost?: number; tokens_prompt?: number } | null = null;
      // a geração demora alguns segundos para aparecer (404 até lá)
      for (const wait of genId ? [2000, 4000, 8000] : []) {
        await new Promise((r) => setTimeout(r, wait));
        gen = await fetch(`https://openrouter.ai/api/v1/generation?id=${genId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => j?.data ?? null)
          .catch(() => null);
        if (gen) break;
      }
      await logApiCall({
        agentId: "voice",
        campaignId: meta.campaignId,
        model,
        purpose: meta.purpose,
        request,
        response: { generation_id: genId, ...saved, total_cost: gen?.total_cost ?? null },
        promptTokens: gen?.tokens_prompt ?? null,
        durationMs,
        error,
        cost: typeof gen?.total_cost === "number" ? gen.total_cost : null,
      });
    })();
  }
}
