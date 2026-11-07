/**
 * Roteirista sem IA (rede falsa) numa campanha temporária; agentes, configurações e api_logs reais não são lidos nem
 * mexidos. Confere: com a campanha em andamento, lê a história (cenas, NPCs, diretrizes) e replaneja do ponto atual,
 * mantendo os arcos concluídos e as notas; sem narração, roteiro do zero.
 * Rodar: npx tsx scripts/world-check.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Pool } from "pg";
import { DEFAULT_AGENTS } from "../src/lib/agents";
import { generateScript, getCampaign } from "../src/lib/engine";
import { blankSheet, normalizeRuleset } from "../src/lib/ruleset";

const real = new Pool({ connectionString: process.env.DATABASE_URL || "postgres://rpg:rpg@localhost:5433/rpg", max: 4 });
const row = (id: string) => ({ ...DEFAULT_AGENTS.find((a) => a.id === id)!, source: "openrouter" });
const g = global as unknown as { __pgPool?: unknown; __schemaReady?: Promise<boolean> };
g.__schemaReady = Promise.resolve(true);
g.__pgPool = {
  query(text: string, params: unknown[] = []) {
    if (/FROM settings WHERE key/.test(text) && params[0] === "openrouter") return { rows: [{ value: { apiKey: "k-teste" } }] };
    if (/FROM settings WHERE key/.test(text) && ["sources", "embeddings", "advanced"].includes(params[0] as string)) return { rows: [] };
    if (/SELECT source(, params)? FROM agents/.test(text)) return { rows: [{ source: "openrouter", params: {} }] };
    if (/INSERT INTO api_logs/.test(text)) return { rows: [] };
    if (/^\s*(INSERT INTO|UPDATE|DELETE FROM) agents/.test(text)) return { rows: [] };
    if (/SELECT \* FROM agents WHERE id/.test(text) && ["decider", "scriptwriter"].includes(params[0] as string)) return { rows: [row(params[0] as string)] };
    return real.query(text, params);
  },
  connect: () => real.connect(),
  end: () => real.end(),
};

let request = "";
let reply: object = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (!url.endsWith("/chat/completions")) return new Response("fora do roteiro", { status: 500 });
  const body = JSON.parse(String(init?.body || "{}"));
  request = String(body.messages[1].content);
  return Response.json({ choices: [{ message: { content: JSON.stringify(reply) } }] });
}) as typeof fetch;

const rs = normalizeRuleset(JSON.parse(fs.readFileSync("naruto-ruleset.json", "utf-8")));
const script = {
  premise: "p",
  arcs: [
    { title: "Raízes", status: "done", summary: "Hugo na vila.", hooks: [], notes: ["O time passou."], canonEvents: ["Time 7 aprovado no teste dos guizos (já aconteceu).", "Primeiras missões rank D."] },
    { title: "Exame Chunin", status: "active", summary: "Exames.", hooks: [], notes: [], canonEvents: [] },
  ],
};

async function main() {
  const { rows: [c] } = await real.query(
    `INSERT INTO campaigns (name, style, ruleset, state, script) VALUES ('[teste-mundo]', 'open', $1, '{"clock":{"minutes":8440}}', $2) RETURNING id`,
    [JSON.stringify(rs), JSON.stringify(script)]
  );
  const id: string = c.id;
  const say = (n: number) =>
    real.query(
      `INSERT INTO messages (campaign_id, scene_id, role, content) SELECT $1, id, r, t FROM scenes, unnest($2::text[], $3::text[]) AS x(r, t) WHERE campaign_id = $1`,
      [id, Array.from({ length: n }, (_, i) => (i % 2 ? "gm" : "player")), Array.from({ length: n }, (_, i) => `Naruto comemora a aprovação no teste dos guizos (${i}). Kakashi sorri.`)]
    );
  try {
    await real.query(`INSERT INTO scenes (campaign_id, seq, mode, location, is_current) VALUES ($1, 1, 'downtime', 'Ichiraku', true)`, [id]);
    const npc = async (name: string, rank: string) =>
      (await real.query(
        `INSERT INTO characters (campaign_id, kind, name, sheet, persona, canon) VALUES ($1, 'npc', $2, $3, $4, true) RETURNING id`,
        [id, name, JSON.stringify({ ...blankSheet(rs), rank }), JSON.stringify({ backstory: "Está no último ano da Academia.", current: "Genin do Time 7, em missões rank D." })]
      )).rows[0].id as string;
    await npc("Naruto Uzumaki", "genin");
    await real.query(
      `INSERT INTO memories (campaign_id, kind, subject, content, importance) VALUES ($1, 'directive', 'permanente', 'A história se passa ANTES do teste dos guizos.', 5) RETURNING id`,
      [id]
    );
    await say(6);

    // Roteirista com a campanha em andamento: lê a história e replaneja do ponto atual; concluído fica, notas ficam
    await real.query(`UPDATE scenes SET summary = 'Hugo assistiu ao teste dos guizos.' WHERE campaign_id = $1`, [id]);
    reply = {
      premise: "nova",
      arcs: [
        { title: "Raízes", status: "done", summary: "repetido", canonEvents: [], hooks: [] },
        { title: "Exame Chunin", status: "active", summary: "Do ponto atual aos exames.", canonEvents: ["Exames"], hooks: [] },
        { title: "Invasão", status: "done", summary: "Ainda não aconteceu.", canonEvents: [], hooks: [] },
      ],
    };
    await real.query(`UPDATE campaigns SET script = jsonb_set(script, '{arcs,1,notes}', '["nota do Mestre"]') WHERE id = $1`, [id]);
    const re = await generateScript(await getCampaign(id));
    assert.ok(request.includes("HISTÓRIA ATÉ AGORA") && request.includes("REPLANEJE") && request.includes("Hugo assistiu ao teste dos guizos."), "lê a história");
    assert.ok(request.includes("Os arcos concluídos (Raízes)") && request.includes("Naruto Uzumaki | cargo: genin | agora: Genin do Time 7"), "concluídos e NPCs no pedido");
    assert.ok(request.includes("A história se passa ANTES"), "diretrizes no pedido");
    assert.deepEqual(re?.arcs.map((a) => [a.title, a.status]), [["Raízes", "done"], ["Exame Chunin", "active"], ["Invasão", "pending"]], "concluído fica, repetido sai, só o que já estava fica concluído");
    assert.deepEqual(re?.arcs[0].canonEvents, ["Time 7 aprovado no teste dos guizos (já aconteceu).", "Primeiras missões rank D."], "arco concluído intacto");
    assert.deepEqual(re?.arcs[1].notes, ["nota do Mestre"], "notas do arco que continua ficam");

    // campanha sem narração: roteiro do zero, como antes
    await real.query(`DELETE FROM messages WHERE campaign_id = $1`, [id]);
    await generateScript(await getCampaign(id));
    assert.ok(request.includes("Monte o roteiro") && !request.includes("HISTÓRIA ATÉ AGORA"), "sem história: do zero");

    console.log("world-check: ok (o Roteirista replaneja do ponto atual da história, mantendo concluídos e notas, e começa do zero sem narração)");
  } finally {
    await real.query(`DELETE FROM campaigns WHERE id = $1`, [id]);
    await real.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
