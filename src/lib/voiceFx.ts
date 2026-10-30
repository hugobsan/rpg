import type { Persona, VoiceFx } from "./types";

export const FX_DEFAULT: VoiceFx = { rate: 1, pitch: 0 };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Ajuste salvo no personagem (persona.voiceFx), sempre dentro dos limites. */
export function fxOf(persona?: Persona | null): VoiceFx {
  const f = persona?.voiceFx;
  return {
    rate: clamp(Number(f?.rate) || 1, 0.5, 2),
    pitch: clamp(Math.round(Number(f?.pitch) || 0), -12, 12),
  };
}

let audio: HTMLAudioElement | null = null;
let teardown: (() => void) | null = null;
let gen = 0; // cada play/stop invalida os anteriores que ainda esperam a biblioteca carregar

export function stopVoice() {
  gen++;
  audio?.pause();
  teardown?.();
  audio = teardown = null;
}

// ponytail: um AudioContext só, para sempre; nós descartados a cada fala. Sem limpeza se o app não tocar mais.
let pitchLib: Promise<{ ctx: AudioContext; SoundTouchNode: typeof import("@soundtouchjs/audio-worklet").SoundTouchNode }> | null = null;
function loadPitchLib() {
  if (!pitchLib) {
    const ctx = new AudioContext(); // criado já no clique, antes do import, por causa da política de autoplay
    pitchLib = import("@soundtouchjs/audio-worklet")
      .then(async ({ SoundTouchNode }) => {
        await SoundTouchNode.register(ctx, new URL("@soundtouchjs/audio-worklet/processor", import.meta.url).href);
        return { ctx, SoundTouchNode };
      })
      .catch((e) => {
        pitchLib = null;
        throw e;
      });
  }
  return pitchLib;
}

/**
 * Toca o mp3 com os efeitos do personagem, parando a fala anterior.
 * Tom 0: só o <audio> nativo (playbackRate + preservesPitch), a biblioteca nem é baixada.
 * Tom != 0: o <audio> alimenta um SoundTouch (AudioWorklet, carregado no 1º uso) que muda só o tom.
 */
export async function playVoice(url: string, fx: VoiceFx) {
  stopVoice();
  const me = gen;
  const plain = () => {
    const a = new Audio(url);
    a.preservesPitch = true;
    a.playbackRate = fx.rate;
    audio = a;
    return a.play().catch(() => {});
  };
  if (fx.pitch === 0) return plain();

  const a = new Audio(url);
  a.preservesPitch = false; // o SoundTouch cuida do tom; a velocidade vem do playbackRate do <audio>
  a.playbackRate = fx.rate;
  try {
    const { ctx, SoundTouchNode } = await loadPitchLib();
    if (me !== gen) return;
    await ctx.resume();
    const src = ctx.createMediaElementSource(a);
    const st = new SoundTouchNode({ context: ctx });
    st.playbackRate.value = fx.rate; // o processador desconta o tom que o playbackRate do <audio> arrasta
    st.pitchSemitones.value = fx.pitch;
    src.connect(st);
    st.connect(ctx.destination);
    audio = a;
    teardown = () => {
      src.disconnect();
      st.disconnect();
    };
    a.addEventListener("ended", () => audio === a && stopVoice());
    await a.play();
  } catch (e) {
    console.warn("pitch indisponível, tocando sem mudar o tom", e);
    if (me === gen) return plain();
  }
}
