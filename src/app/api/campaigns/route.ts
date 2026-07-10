import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { blankSheet, normalizeRuleset } from "@/lib/ruleset";
import { generateScript, getCampaign } from "@/lib/engine";
import { Campaign, Persona } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await q(
    `SELECT c.id, c.name, c.style, c.created_at::text, c.updated_at::text,
            c.ruleset->>'name' AS ruleset_name,
            (SELECT count(*) FROM messages m WHERE m.campaign_id = c.id) AS message_count
     FROM campaigns c ORDER BY c.updated_at DESC`
  );
  return NextResponse.json(rows);
}

interface CreateBody {
  name: string;
  style: "open" | "hybrid" | "guided";
  ruleset: unknown;
  character: {
    name: string;
    attributes?: Record<string, number>;
    extra?: Record<string, string>;
    abilities?: { name: string; type: string; rank?: string; description?: string }[];
    appearance?: string;
    personality?: string;
    backstory?: string;
    goals?: string;
  };
  startingPoint?: string; // onde na história/linha do tempo a campanha começa
  initialNpcs?: string; // texto livre: NPCs que o mestre deve inicializar
  generateScript?: boolean;
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as CreateBody;
  if (!body.name?.trim() || !body.character?.name?.trim())
    return NextResponse.json(
      { error: "Nome da campanha e do personagem são obrigatórios" },
      { status: 400 }
    );
  const ruleset = normalizeRuleset(body.ruleset);

  const rows = await q<Campaign>(
    `INSERT INTO campaigns (name, style, ruleset, state) VALUES ($1,$2,$3,$4) RETURNING *`,
    [
      body.name.trim(),
      body.style || "hybrid",
      JSON.stringify(ruleset),
      JSON.stringify({
        startingPoint: body.startingPoint || "",
        initialNpcs: body.initialNpcs || "",
      }),
    ]
  );
  const campaign = rows[0];

  const sheet = blankSheet(ruleset);
  if (body.character.attributes) Object.assign(sheet.attributes, body.character.attributes);
  if (body.character.extra) Object.assign(sheet.extra, body.character.extra);
  if (body.character.abilities?.length) sheet.abilities = body.character.abilities;
  const persona: Persona = {
    appearance: body.character.appearance,
    personality: body.character.personality,
    backstory: body.character.backstory,
    goals: body.character.goals,
  };
  await q(
    `INSERT INTO characters (campaign_id, kind, name, sheet, persona)
     VALUES ($1, 'player', $2, $3, $4)`,
    [campaign.id, body.character.name.trim(), JSON.stringify(sheet), JSON.stringify(persona)]
  );
  await q(
    `INSERT INTO scenes (campaign_id, seq, mode, title, location)
     VALUES ($1, 1, 'exploration', 'Prólogo', $2)`,
    [campaign.id, body.startingPoint?.slice(0, 120) || ""]
  );

  let script = null;
  let scriptError: string | null = null;
  if (body.generateScript !== false) {
    try {
      script = await generateScript(await getCampaign(campaign.id));
    } catch (e) {
      scriptError = e instanceof Error ? e.message : String(e);
    }
  }
  return NextResponse.json({ id: campaign.id, script: !!script, scriptError });
}
