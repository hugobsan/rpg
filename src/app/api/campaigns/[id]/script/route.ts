import { NextRequest, NextResponse } from "next/server";
import { generateScript, getCampaign } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const campaign = await getCampaign(id);
  return NextResponse.json(campaign.script);
}

/** POST → (re)gera o roteiro interno via agente Roteirista. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const script = await generateScript(await getCampaign(id));
    if (!script)
      return NextResponse.json(
        { error: "Roteirista não retornou JSON válido — tente novamente." },
        { status: 502 }
      );
    return NextResponse.json(script);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
