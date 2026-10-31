import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { blankSheet, normalizeRuleset, startingKit } from "@/lib/ruleset";
import { generateScript, getCampaign } from "@/lib/engine";
import { EXTRA_MASTERY } from "@/lib/progression";
import { Ability, Campaign, Persona } from "@/lib/types";
import { THEMES } from "@/lib/theme";
import { listCampaigns } from "@/app/(home)/campaignList";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await listCampaigns());
}

interface CreateBody {
  name: string;
  style: "open" | "hybrid" | "guided";
  ruleset: unknown;
  character: {
    name: string;
    attributes?: Record<string, number>;
    extra?: Record<string, string>;
    abilities?: Ability[]; // extras além do kit do rank inicial
    appearance?: string;
    personality?: string;
    backstory?: string;
    goals?: string;
  };
  startingPoint?: string; // onde na história/linha do tempo a campanha começa
  initialNpcs?: string; // texto livre: NPCs que o mestre deve inicializar
  generateScript?: boolean;
  theme?: string; // tema visual escolhido; sem ele vale o do ruleset
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
        ...(THEMES.some((t) => t.key === body.theme) ? { theme: body.theme } : {}),
      }),
    ]
  );
  const campaign = rows[0];

  const sheet = blankSheet(ruleset);
  if (body.character.attributes) Object.assign(sheet.attributes, body.character.attributes);
  if (body.character.extra) Object.assign(sheet.extra, body.character.extra);
  // kit do rank inicial + extras da tela (extra com mesmo nome substitui o do kit)
  const abilities = new Map(startingKit(ruleset, sheet.rank).map((a) => [a.name.toLowerCase(), a]));
  for (const a of body.character.abilities || [])
    if (a?.name?.trim() && a.type) abilities.set(a.name.trim().toLowerCase(), {
        ...a,
        name: a.name.trim(),
        progress: typeof a.progress === "number" && Number.isFinite(a.progress) ? Math.max(0, Math.min(100, a.progress)) : EXTRA_MASTERY,
      });
  sheet.abilities = [...abilities.values()];
  const persona: Persona = {
    appearance: body.character.appearance,
    personality: body.character.personality,
    backstory: body.character.backstory,
    goals: body.character.goals,
  };
  const [player] = await q<{ id: string }>(
    `INSERT INTO characters (campaign_id, kind, name, sheet, persona)
     VALUES ($1, 'player', $2, $3, $4) RETURNING id`,
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
