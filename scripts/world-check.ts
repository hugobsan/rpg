/**
 * Roteirista sem IA (rede falsa) numa campanha temporária; agentes, configurações e api_logs reais não são lidos nem
 * mexidos. Confere: a 1ª resposta com beat que exige ato do jogador volta com o erro (nova tentativa); a 2ª, válida,
 * vira arco ativo com beats, relógio e gancho; o pedido leva o cânone e o que já aconteceu; modelo marcado fraco não é
 * chamado (fallback do cânone); Refazer arco troca o ativo e mantém os concluídos.
 * Rodar: npx tsx scripts/world-check.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Pool } from "pg";
import { DEFAULT_AGENTS } from "../src/lib/agents";
import { loadStory, writeArc } from "../src/lib/story";
import { normalizeRuleset } from "../src/lib/ruleset";

const real = new Pool({ connectionString: process.env.DATABASE_URL || "postgres://rpg:rpg@localhost:5433/rpg", max: 4 });
let writerModel = "deepseek/deepseek-v4-pro";
const row = (id: string) => ({ ...DEFAULT_AGENTS.find((a) => a.id === id)!, source: "openrouter", ...(id === "scriptwriter" && { model: writerModel }) });
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

const requests: string[] = [];
let replies: object[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (!url.endsWith("/chat/completions")) return new Response("fora do roteiro", { status: 500 }); // Jev falha = nenhum beat sinalizado
  const body = JSON.parse(String(init?.body || "{}"));
  requests.push(body.messages.map((m: { content: string }) => m.content).join("\n---\n"));
  return Response.json({ choices: [{ message: { content: JSON.stringify(replies.shift() ?? {}) } }] });
}) as typeof fetch;

const rs = normalizeRuleset(JSON.parse(fs.readFileSync("naruto-ruleset.json", "utf-8")));
const beat = (title: string, situation: string, o: object = {}) => ({ title, situation, dueDay: 3, ...o });
const arc = (title: string, extra: object[] = []) => ({
  arc: { title, premise: "Gatō quer a ponte parada.", stakes: "O País das Ondas continua refém." },
  beats: [
    beat("O pedido", "Tazuna pede escolta e esconde que é caçado.", { required: true, fallback: "Outra equipe parte.", reward: { pay: 30000, xp: "media" } }),
    beat("Emboscada", "Os Irmãos Demônio atacam na estrada.", { required: true, fallback: "Kakashi vence sem você." }),
    beat("Zabuza", "Zabuza surge na névoa.", { trigger: { clock: { name: "Gatō aperta", gte: 2 } } }),
    beat("A ponte", "Zabuza e Haku atacam na ponte.", { dueDay: 6 }),
    ...extra,
  ],
  clocks: [{ name: "Gatō aperta", segments: 4, tick: ["day"], onFullBeat: 3 }],
  hooks: [{ text: "O homem pálido do sonho", beat: 1 }],
  npcs: [{ name: "Naruto", agenda: "Treina escondido à noite.", wants: "Ser reconhecido" }],
});

async function main() {
  const {
    rows: [c],
  } = await real.query(`INSERT INTO campaigns (name, ruleset, state) VALUES ('[teste-mundo]', $1, $2) RETURNING id`, [
    JSON.stringify(rs),
    JSON.stringify({ clock: { minutes: 1440 + 600 }, startingPoint: "Konoha" }),
  ]);
  const id: string = c.id;
  try {
    await real.query(`INSERT INTO scenes (campaign_id, seq, mode, location, is_current) VALUES ($1, 1, 'downtime', 'Ichiraku', true)`, [id]);
    await real.query(`INSERT INTO characters (campaign_id, kind, name, persona) VALUES ($1, 'player', 'Hugo', '{}'), ($1, 'npc', 'Naruto Uzumaki', '{}')`, [id]);
    await real.query(`INSERT INTO messages (campaign_id, role, content) VALUES ($1, 'gm', 'Naruto comemora a aprovação no teste dos guizos.')`, [id]);

    // 1ª resposta: beat que exige ato do jogador → nova tentativa com o erro; 2ª válida → arco ativo
    replies = [arc("Ruim", [beat("Errado", "Hugo é forçado a usar um poder desconhecido.")]), arc("A ponte de Tazuna")];
    const w = await writeArc(id, "new");
    assert.deepEqual([w.source, w.title, requests.length], ["llm", "A ponte de Tazuna", 2]);
    assert.ok(requests[0].includes("Ep 1: Enter: Naruto Uzumaki!") && requests[0].includes("HOJE: Dia 2"), "cânone e dia no pedido");
    assert.ok(requests[0].includes("Naruto comemora a aprovação"), "onde a história parou");
    assert.ok(requests[1].includes("exige ato de Hugo"), "o erro volta na nova tentativa");
    let s = await loadStory(id);
    assert.deepEqual([s.arcs.length, s.arcs[0].status, s.arcs[0].canon_ref, s.beats.length, s.clocks[0].on_full_beat, s.hooks[0].beat_id], [
      1, "active", "01-pais-das-ondas.md", 4, s.beats[3].id, s.beats[1].id,
    ]);
    assert.deepEqual([s.beats[0].reward, s.beats[1].trigger.after_beat, s.beats[2].trigger.clock?.id], [{ pay: 30000, xp: "media" }, s.beats[0].id, s.clocks[0].id]);
    const [naruto] = (await real.query(`SELECT persona FROM characters WHERE campaign_id = $1 AND name = 'Naruto Uzumaki'`, [id])).rows;
    assert.equal(naruto.persona.agenda, "Treina escondido à noite.", "agenda do NPC no cartão dele");

    // extensão: próximo arco pendente; o pedido lista o que ainda está na agenda e o próximo cânone
    replies = [arc("Exame")];
    await writeArc(id, "extend");
    s = await loadStory(id);
    assert.deepEqual(s.arcs.map((a) => [a.title, a.status, a.canon_ref]), [["A ponte de Tazuna", "active", "01-pais-das-ondas.md"], ["Exame", "pending", "02-exame-chunin.md"]]);
    assert.ok(requests.at(-1)!.includes("Ainda na agenda") && requests.at(-1)!.includes("PRÓXIMO arco"));

    // modelo fraco: nem chama; Refazer arco troca ativo e pendente pelo fallback do cânone e mantém o concluído
    await real.query(`UPDATE arcs SET status = 'done' WHERE campaign_id = $1 AND title = 'A ponte de Tazuna'`, [id]);
    await real.query(`UPDATE arcs SET status = 'active' WHERE campaign_id = $1 AND title = 'Exame'`, [id]);
    writerModel = "google/gemini-3.5-flash";
    const before = requests.length;
    const redo = await writeArc(id, "redo");
    s = await loadStory(id);
    assert.equal(requests.length, before, "modelo fraco não é chamado");
    assert.equal(redo.source, "canon");
    assert.deepEqual(s.arcs.map((a) => [a.status, a.canon_ref]), [["done", "01-pais-das-ondas.md"], ["active", "02-exame-chunin.md#ep"]]);

    console.log("world-check: ok (nova tentativa com o erro, arco salvo como estado, extensão, modelo fraco cai no cânone, Refazer arco)");
  } finally {
    await real.query(`DELETE FROM campaigns WHERE id = $1`, [id]);
    await real.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
