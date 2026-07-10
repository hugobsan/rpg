import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { getCampaign } from "@/lib/engine";

export const dynamic = "force-dynamic";

/** GET ?what=ruleset|full → exporta JSON (mecânica ou campanha inteira). */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const what = req.nextUrl.searchParams.get("what") || "ruleset";
  const campaign = await getCampaign(id);
  if (what === "ruleset") {
    return new NextResponse(JSON.stringify(campaign.ruleset, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="ruleset-${campaign.name.replace(/\W+/g, "-")}.json"`,
      },
    });
  }
  const [characters, scenes, messages, memories] = await Promise.all([
    q(`SELECT kind, name, active, canon, sheet, persona, voice FROM characters WHERE campaign_id = $1`, [id]),
    q(`SELECT seq, mode, title, location, summary FROM scenes WHERE campaign_id = $1 ORDER BY seq`, [id]),
    q(`SELECT role, speaker, content, meta, created_at::text FROM messages WHERE campaign_id = $1 ORDER BY id`, [id]),
    q(`SELECT kind, subject, content, importance, created_at::text FROM memories WHERE campaign_id = $1 ORDER BY id`, [id]),
  ]);
  const dump = {
    exportedAt: new Date().toISOString(),
    campaign: { name: campaign.name, style: campaign.style, ruleset: campaign.ruleset, script: campaign.script },
    characters,
    scenes,
    messages,
    memories,
  };
  return new NextResponse(JSON.stringify(dump, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="campanha-${campaign.name.replace(/\W+/g, "-")}.json"`,
    },
  });
}
