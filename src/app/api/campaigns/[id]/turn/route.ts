import { NextRequest } from "next/server";
import { runTurn } from "@/lib/engine";
import { restoreSnapshot } from "@/lib/turnSnapshot";
import { TurnEvent } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Turno em andamento por campanha. { stop } aborta o da vez; um turno novo espera o anterior acabar (inclusive a volta
// à foto de um turno parado), então parar e logo gerar de novo nunca deixa dois turnos gravando.
// ponytail: em memória, vale para um processo só (next dev/start); com vários, precisaria de um lock no banco
const turns = new Map<string, { stop: AbortController; done: Promise<void> }>();

/**
 * POST { input } | { regenerate, feedback? } | { regenerate, input } (editar a última ação) → SSE de eventos do turno
 * (status, tools, dados, narração, opções).
 * POST { stop } → para o Mestre enquanto a narração não foi salva: o turno volta à foto, a ação do jogador fica (dá para
 * gerar novamente ou editar) e o SSE do turno termina sem narração. Depois da narração não faz nada (o pós-narração segue).
 * Responde quando o turno acabou. Fechar a aba não para: o turno termina e fica salvo, como antes.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { input, regenerate, feedback, stop } = (await req.json()) as {
    input?: string;
    regenerate?: boolean; // gerar de novo a resposta do último turno (com input: trocando a ação)
    feedback?: string;
    stop?: boolean;
  };
  if (stop) {
    const t = turns.get(id);
    t?.stop.abort();
    await t?.done;
    return Response.json({ ok: true });
  }

  const prev = turns.get(id)?.done;
  const turn = { stop: new AbortController(), done: Promise.resolve() };
  turns.set(id, turn);
  const { signal } = turn.stop;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let narrated = false; // a narração já foi salva: parar não desfaz mais nada
      const emit = (e: TurnEvent) => {
        if (e.type === "narration") narrated = true;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          /* cliente desconectou */
        }
      };
      turn.done = (async () => {
        try {
          await prev;
          if (regenerate) {
            // volta ao estado antes do último turno e roda a mesma ação de novo
            // (com input: a ação editada pelo jogador, que entra no lugar da antiga)
            const lastInput = await restoreSnapshot(id);
            const edited = String(input || "").trim();
            if (edited) await runTurn(id, edited, emit, undefined, signal);
            else await runTurn(id, lastInput, emit, { feedback: String(feedback || "").slice(0, 1000) }, signal);
          } else {
            await runTurn(id, String(input || "").trim() || "(o jogador hesita)", emit, undefined, signal);
          }
        } catch (e) {
          // parado: o runTurn só lança signal.reason depois da foto deste turno e da ação salvas
          if (e === signal.reason && !narrated) await restoreSnapshot(id, true).catch((err) => emit({ type: "error", message: String(err) }));
          else emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
          emit({ type: "done" });
        } finally {
          if (turns.get(id) === turn) turns.delete(id);
          try {
            controller.close();
          } catch {
            /* já fechado */
          }
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
