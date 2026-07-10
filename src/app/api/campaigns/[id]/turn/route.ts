import { NextRequest } from "next/server";
import { runTurn } from "@/lib/engine";
import { TurnEvent } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** POST { input } → SSE de eventos do turno (status, tools, dados, narração, opções). */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { input } = (await req.json()) as { input: string };
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
        await runTurn(id, String(input || "").trim() || "(o jogador hesita)", emit);
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
