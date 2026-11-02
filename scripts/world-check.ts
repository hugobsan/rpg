/**
 * Estado do mundo na compactação, sem IA: o Cronista (rede falsa) recebe os NPCs citados no trecho, o arco ativo e as
 * diretrizes, e o que ele devolve é aplicado numa campanha temporária. Agentes, configurações e api_logs reais não são
 * lidos nem mexidos.
 * Confere: o pedido traz ESTADO DO MUNDO só com o NPC citado; situação atual e cargo do NPC gravados (cargo fora da
 * lista ignorado, NPC fora do trecho ignorado); eventos e nota do arco, arco concluído abre o seguinte; diretriz
 * desatualizada vira um aviso na conversa fora do jogo, uma vez só. Roteirista: sem narração, roteiro do zero; com
 * a campanha em andamento, lê a história e replaneja do ponto atual, mantendo os arcos concluídos e as notas.
 * Rodar: npx tsx scripts/world-check.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Pool } from "pg";
import { DEFAULT_AGENTS } from "../src/lib/agents";
import { generateScript, getCampaign, getCurrentScene, maybeCompact } from "../src/lib/engine";
import { sceneNpcMemories } from "../src/lib/retrieval";
import { blankSheet, normalizeRuleset } from "../src/lib/ruleset";
import type { TurnEvent } from "../src/lib/types";

const real = new Pool({ connectionString: process.env.DATABASE_URL || "postgres://rpg:rpg@localhost:5433/rpg", max: 4 });
const row = (id: string) => ({ ...DEFAULT_AGENTS.find((a) => a.id === id)!, source: "openrouter", params: { compactThresholdTokens: 10, keepRecentMessages: 1 } });
const g = global as unknown as { __pgPool?: unknown; __schemaReady?: Promise<boolean> };
g.__schemaReady = Promise.resolve(true);
g.__pgPool = {
  query(text: string, params: unknown[] = []) {
    if (/FROM settings WHERE key/.test(text) && params[0] === "openrouter") return { rows: [{ value: { apiKey: "k-teste" } }] };
    if (/FROM settings WHERE key/.test(text) && ["sources", "embeddings", "advanced"].includes(params[0] as string)) return { rows: [] };
    if (/SELECT source(, params)? FROM agents/.test(text)) return { rows: [{ source: "openrouter", params: {} }] };
    if (/INSERT INTO api_logs/.test(text)) return { rows: [] };
    if (/^\s*(INSERT INTO|UPDATE|DELETE FROM) agents/.test(text)) return { rows: [] };
    if (/SELECT \* FROM agents WHERE id/.test(text) && ["chronicler", "decider", "scriptwriter"].includes(params[0] as string)) return { rows: [row(params[0] as string)] };
    return real.query(text, params);
  },
  connect: () => real.connect(),
  end: () => real.end(),
};

let request = "";
let reply: object = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (!url.endsWith("/chat/completions")) return new Response("fora do roteiro", { status: 500 }); // Jev da importância: fica a do Cronista
  const body = JSON.parse(String(init?.body || "{}"));
  request = String(body.messages[1].content);
  return Response.json({ choices: [{ message: { content: JSON.stringify(reply) } }] });
}) as typeof fetch;

const rs = normalizeRuleset(JSON.parse(fs.readFileSync("naruto-ruleset.json", "utf-8")));
const script = {
  premise: "p",
  arcs: [
    { title: "Raízes", status: "active", summary: "Hugo na vila.", hooks: [], notes: [], canonEvents: ["A turma de Naruto está no último ano da Academia."] },
    { title: "Exame Chunin", status: "pending", summary: "Exames.", hooks: [], notes: [], canonEvents: [] },
  ],
};

async function main() {
  const { rows: [c] } = await real.query(
    `INSERT INTO campaigns (name, style, ruleset, state, script) VALUES ('[teste-mundo]', 'open', $1, '{"clock":{"minutes":8440}}', $2) RETURNING id`,
    [JSON.stringify(rs), JSON.stringify(script)]
  );
  const id: string = c.id;
  const events: TurnEvent[] = [];
  const emit = (e: TurnEvent) => events.push(e);
  const one = async <T>(sql: string, p: unknown[] = [id]) => (await real.query(sql, p)).rows[0] as T;
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
        [id, name, JSON.stringify({ ...blankSheet(rs), rank }), JSON.stringify({ backstory: "Está no último ano da Academia." })]
      )).rows[0].id as string;
    const naruto = await npc("Naruto Uzumaki", "estudante");
    await npc("Gaara", "genin"); // fora do trecho
    const { rows: [dir] } = await real.query(
      `INSERT INTO memories (campaign_id, kind, subject, content, importance) VALUES ($1, 'directive', 'permanente', 'A história se passa ANTES do teste dos guizos.', 5) RETURNING id`,
      [id]
    );
    await say(6);

    reply = {
      summary: "O Time 7 passou no teste dos guizos.",
      memories: [],
      npcs: [
        { name: "Naruto Uzumaki", rank: "genin", current: "Genin do Time 7, aprovado no teste dos guizos no Dia 4." },
        { name: "Gaara", current: "Não deveria mudar." },
      ],
      arc: { canonEvents: ["Time 7 aprovado no teste dos guizos (já aconteceu).", "Primeiras missões rank D."], note: "O time passou.", done: true },
      directives: [{ id: Number(dir.id), why: "O teste já aconteceu no Dia 4." }],
    };
    await maybeCompact(id, await getCurrentScene(id), emit);

    // o pedido: o NPC citado no trecho, o arco, as diretrizes e os cargos; Gaara não foi citado
    assert.ok(request.includes("ESTADO DO MUNDO") && request.includes("- Naruto Uzumaki | cargo: estudante"), "NPC citado no pedido");
    assert.ok(!request.includes("Gaara"), "NPC fora do trecho não vai");
    assert.ok(request.includes("ARCO ATIVO: Raízes") && request.includes(`id ${dir.id}: A história se passa ANTES`), "arco e diretriz no pedido");

    const n = await one<{ rank: string; current: string; backstory: string }>(
      `SELECT sheet->>'rank' AS rank, persona->>'current' AS current, persona->>'backstory' AS backstory FROM characters WHERE id = $1`,
      [naruto]
    );
    assert.deepEqual(n, { rank: "genin", current: "Genin do Time 7, aprovado no teste dos guizos no Dia 4.", backstory: "Está no último ano da Academia." }, "situação e cargo; o passado fica");
    assert.equal((await one<{ c: string | null }>(`SELECT persona->>'current' AS c FROM characters WHERE campaign_id = $1 AND name = 'Gaara'`)).c, null, "Gaara intocado");

    const s = (await one<{ script: typeof script }>(`SELECT script FROM campaigns WHERE id = $1`)).script;
    assert.deepEqual(s.arcs[0].canonEvents, ["Time 7 aprovado no teste dos guizos (já aconteceu).", "Primeiras missões rank D."]);
    assert.deepEqual([s.arcs[0].notes, s.arcs[0].status, s.arcs[1].status], [["O time passou."], "done", "active"], "arco concluído abre o seguinte");

    const notes = async () => (await real.query(`SELECT content FROM gm_notes WHERE campaign_id = $1`, [id])).rows.map((r) => r.content as string);
    assert.equal((await notes()).length, 1);
    assert.ok((await notes())[0].includes("A história se passa ANTES") && (await notes())[0].includes("Dia 4"), "aviso com a diretriz e o motivo");
    assert.ok(events.some((e) => e.type === "tool" && e.summary.includes("Naruto Uzumaki → genin")), "etiqueta do NPC no chat");

    // 2ª compactação: cargo fora da lista é ignorado, a mesma diretriz não é avisada de novo
    reply = { summary: "Mais um dia.", memories: [], npcs: [{ name: "naruto uzumaki", rank: "hokage_supremo", current: "Genin do Time 7, em missões rank D." }], directives: [{ id: Number(dir.id), why: "de novo" }] };
    await say(6);
    await maybeCompact(id, await getCurrentScene(id), emit);
    const n2 = await one<{ rank: string; current: string }>(`SELECT sheet->>'rank' AS rank, persona->>'current' AS current FROM characters WHERE id = $1`, [naruto]);
    assert.deepEqual(n2, { rank: "genin", current: "Genin do Time 7, em missões rank D." }, "cargo inválido ignorado, situação reescrita");
    assert.equal((await notes()).length, 1, "aviso uma vez só");

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

    // memórias dos NPCs em cena: as marcadas com o nome primeiro, depois as que o citam; NPC fora de cena não traz nada
    await real.query(`UPDATE characters SET active = (name = 'Naruto Uzumaki') WHERE campaign_id = $1`, [id]);
    const { rows: mems } = await real.query(
      `INSERT INTO memories (campaign_id, kind, subject, content, importance) VALUES
         ($1, 'event', 'Naruto Uzumaki', 'Naruto treinou com Hugo no Dia 3.', 2),
         ($1, 'event', 'Time 7', 'Kakashi aprovou Naruto e o time.', 5),
         ($1, 'event', 'Gaara', 'Gaara chegou à vila.', 5),
         ($1, 'event', 'Hugo', 'Narutomaki no ramen.', 5)
       RETURNING id`,
      [id]
    );
    assert.deepEqual((await sceneNpcMemories(id)).map((m) => Number(m.id)).sort(), [Number(mems[0].id), Number(mems[1].id)].sort(), "do NPC em cena, pelo nome inteiro");

    // campanha sem narração: roteiro do zero, como antes
    await real.query(`DELETE FROM messages WHERE campaign_id = $1`, [id]);
    await generateScript(await getCampaign(id));
    assert.ok(request.includes("Monte o roteiro") && !request.includes("HISTÓRIA ATÉ AGORA"), "sem história: do zero");

    console.log("world-check: ok (o Cronista recebe NPCs citados, arco e diretrizes; situação atual e cargo gravados, arco concluído abre o seguinte, diretriz desatualizada avisada uma vez; o Roteirista replaneja do ponto atual da história, mantendo concluídos e notas, e começa do zero sem narração; memórias dos NPCs em cena)");
  } finally {
    await real.query(`DELETE FROM campaigns WHERE id = $1`, [id]);
    await real.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
