import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { getCampaign } from "@/lib/engine";
import { hydrateSheets } from "@/lib/library";
import type { StoredSheet } from "@/lib/types";
import { loadStory } from "@/lib/story";

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
  const [characters, scenes, messages, memories, events, story] = await Promise.all([
    // habilidades hidratadas: a exportação sai autocontida (sem depender da biblioteca)
    q<{ sheet: StoredSheet }>(`SELECT kind, name, active, canon, sheet, persona, voice FROM characters WHERE campaign_id = $1`, [id]).then(hydrateSheets),
    q(`SELECT seq, mode, title, location, summary FROM scenes WHERE campaign_id = $1 ORDER BY seq`, [id]),
    q(`SELECT role, speaker, content, meta, created_at::text FROM messages WHERE campaign_id = $1 ORDER BY id`, [id]),
    q(`SELECT kind, subject, content, importance, created_at::text FROM memories WHERE campaign_id = $1 ORDER BY id`, [id]),
    // fatos com quem sabe (nome, como soube)
    q(
      `SELECT e.minute, e.text, e.public, COALESCE(json_agg(json_build_object('name', c.name, 'access', k.access, 'from', k.from_name)) FILTER (WHERE c.id IS NOT NULL), '[]') AS known_by
       FROM events e LEFT JOIN knowledge k ON k.event_id = e.id LEFT JOIN characters c ON c.id = k.character_id
       WHERE e.campaign_id = $1 GROUP BY e.id ORDER BY e.id`,
      [id]
    ),
    loadStory(id),
  ]);
  const dump = {
    exportedAt: new Date().toISOString(),
    campaign: { name: campaign.name, ruleset: campaign.ruleset },
    story,
    characters,
    scenes,
    messages,
    memories,
    events,
  };
  return new NextResponse(JSON.stringify(dump, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="campanha-${campaign.name.replace(/\W+/g, "-")}.json"`,
    },
  });
}
