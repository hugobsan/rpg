import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { blankSheet, normalizeRuleset, startingKit } from "@/lib/ruleset";
import { generateScript, getCampaign } from "@/lib/engine";
import { EXTRA_MASTERY } from "@/lib/progression";
import { dehydrateSheet, ensureLibraryAbility } from "@/lib/library";
import { slugKey } from "@/lib/table";
import { Ability, Campaign, Persona, StoredAbility, StoredSheet } from "@/lib/types";
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
  ruleset.world ||= slugKey(ruleset.name); // escopo da biblioteca (igual ao worldOf), fixo desde a criação

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
  // kit do rank inicial + extras da tela entram na biblioteca do mundo (a existente pelo nome, se já há) e a ficha
  // guarda { ref, progress }; extra que cai na mesma entrada do kit substitui o domínio
  const abilities = new Map<number, StoredAbility>();
  for (const a of startingKit(ruleset, sheet.rank)) {
    const e = await ensureLibraryAbility(campaign, a, "gm", !!ruleset.canonBased);
    if (e) abilities.set(e.id, { ref: e.id, progress: a.progress });
  }
  for (const a of body.character.abilities || []) {
    if (!a?.name?.trim() || !a.type) continue;
    const e = await ensureLibraryAbility(campaign, { ...a, name: a.name.trim() }, "gm", false);
    const progress = typeof a.progress === "number" && Number.isFinite(a.progress) ? Math.max(0, Math.min(100, a.progress)) : EXTRA_MASTERY;
    if (e) abilities.set(e.id, { ref: e.id, progress });
  }
  const stored: StoredSheet = { ...sheet, abilities: [...abilities.values()] };
  const persona: Persona = {
    appearance: body.character.appearance,
    personality: body.character.personality,
    backstory: body.character.backstory,
    goals: body.character.goals,
  };
  const [player] = await q<{ id: string }>(
    `INSERT INTO characters (campaign_id, kind, name, sheet, persona)
     VALUES ($1, 'player', $2, $3, $4) RETURNING id`,
    [campaign.id, body.character.name.trim(), JSON.stringify(dehydrateSheet(stored)), JSON.stringify(persona)]
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
