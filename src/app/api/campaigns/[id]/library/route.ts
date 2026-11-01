import { NextRequest, NextResponse } from "next/server";
import { getCampaign } from "@/lib/engine";
import { generateLibrary, listLibrary } from "@/lib/library";

export const dynamic = "force-dynamic";

/** GET → biblioteca do mundo da campanha (sem as excluídas): { ability: [...], item: [...] }. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const campaign = await getCampaign((await params).id);
  const [ability, item] = await Promise.all([listLibrary(campaign, "ability", { limit: 2000 }), listLibrary(campaign, "item", { limit: 2000 })]);
  return NextResponse.json({ ability, item });
}

/** POST { kind, count, focus, canon } → o Criador de habilidades/itens gera em segundo plano (tarefa 'library'). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { kind?: string; count?: number; focus?: string; canon?: boolean };
  try {
    const campaign = await getCampaign(id);
    const job = await generateLibrary(
      campaign,
      body.kind === "item" ? "item" : "ability",
      Number(body.count) || 10,
      String(body.focus || ""),
      typeof body.canon === "boolean" ? body.canon : campaign.ruleset.canonBased
    );
    return NextResponse.json(job);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
