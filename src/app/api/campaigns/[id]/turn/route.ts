import { NextRequest } from "next/server";
import { runTurn } from "@/lib/engine";
import { restoreSnapshot } from "@/lib/turnSnapshot";
import { TurnEvent } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** POST { input } | { regenerate, feedback? } | { regenerate, input } (editar a última ação) → SSE de eventos do turno (status, tools, dados, narração, opções). */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { input, regenerate, feedback } = (await req.json()) as {
    input?: string;
    regenerate?: boolean; // gerar de novo a resposta do último turno (com input: trocando a ação)
    feedback?: string;
  };
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: TurnEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          /* cliente desconectou */
        }
      };
      try {
        if (regenerate) {
          // volta ao estado antes do último turno e roda a mesma ação de novo
          // (com input: a ação editada pelo jogador, que entra no lugar da antiga)
          const lastInput = await restoreSnapshot(id);
          const edited = String(input || "").trim();
          if (edited) await runTurn(id, edited, emit);
          else await runTurn(id, lastInput, emit, { feedback: String(feedback || "").slice(0, 1000) });
        } else {
          await runTurn(id, String(input || "").trim() || "(o jogador hesita)", emit);
        }
      } catch (e) {
        emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
        emit({ type: "done" });
      } finally {
        try {
          controller.close();
        } catch {
          /* já fechado */
        }
      }
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
