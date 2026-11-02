import { NextRequest, NextResponse } from "next/server";
import { getCampaign } from "@/lib/engine";
import { saveTable } from "@/lib/tools";
import { DIFFICULTIES, getTable, normalizeTable } from "@/lib/table";

export const dynamic = "force-dynamic";

/** GET → { table, difficulties }: regras da mesa atuais (ou o padrão) e os presets para a UI. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const campaign = await getCampaign(id);
    return NextResponse.json({ table: getTable(campaign.state), difficulties: DIFFICULTIES });
  } catch {
    return NextResponse.json({ error: "Campanha não encontrada" }, { status: 404 });
  }
}

/** PUT { difficulty?, dcOffset?, categories?, crits?, notes?, xp?, modes?, rest? } → { table }. Só o que vier muda; categories substitui a lista. */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body))
    return NextResponse.json({ error: "Corpo inválido" }, { status: 400 });
  let campaign;
  try {
    campaign = await getCampaign(id);
  } catch {
    return NextResponse.json({ error: "Campanha não encontrada" }, { status: 404 });
  }
  const table = normalizeTable(body as Record<string, unknown>, getTable(campaign.state), campaign.ruleset.resources.map((r) => r.key));
  if (typeof table === "string") return NextResponse.json({ error: table }, { status: 400 });
  await saveTable(id, table);
  return NextResponse.json({ table });
}
