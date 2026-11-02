/**
 * Cena que acompanha a história, sem IA: roda o runTurn de ponta a ponta numa campanha temporária, com a rede falsa
 * (o Jev responde só a pergunta de lugar e modo, o Cronista dá o nome, o Mestre narra por roteiro; o resto falha e cai
 * no padrão). Os agentes e as configurações reais não são lidos nem mexidos: fonte, chave, api_logs e a semeadura de
 * agentes são interceptados.
 * Confere: mudou de lugar = cena nova com o local e o modo novos (a anterior fica com o resumo); o "gerar novamente"
 * volta a cena; o contexto da cena nova mostra o fim do resumo anterior até ela ter o seu; ficou no lugar = só o modo
 * muda, acima do limiar e se o Mestre não trocou; Jev falhando = nada muda.
 * Rodar: npx tsx scripts/scene-check.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Pool } from "pg";
import { DEFAULT_AGENTS } from "../src/lib/agents";
import { runTurn } from "../src/lib/engine";
import { loadMap } from "../src/lib/map";
import { blankSheet, normalizeRuleset } from "../src/lib/ruleset";
import { restoreSnapshot } from "../src/lib/turnSnapshot";
import type { TurnEvent } from "../src/lib/types";

// ---------- banco: o real, menos agentes, configurações de IA e api_logs ----------
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
    if (/SELECT \* FROM agents WHERE id/.test(text) && ["gm", "scribe", "decider", "chronicler"].includes(params[0] as string))
      return { rows: [row(params[0] as string)] };
    return real.query(text, params);
  },
  connect: () => real.connect(),
  end: () => real.end(),
};

// ---------- rede: Jev (lugar e modo), Cronista (nome do lugar), Mestre (streaming) e Escrivão ----------
type Call = { name: string; args: Record<string, unknown> };
let place: { moved: number; mode: string; p: number } | "falha" = "falha";
let placeName = "?";
const gmScript: { text: string; calls: Call[] }[] = [];
const gmCtx: string[] = []; // contexto do turno de cada chamada do Mestre
let events: TurnEvent[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const body = JSON.parse(String(init?.body || "{}"));
  if (url.endsWith("/decisions")) {
    if (place === "falha" || !body.questions?.moved) return new Response("fora do roteiro", { status: 500 });
    return Response.json({
      answers: { moved: { type: "noul", noul: place.moved }, mode: { type: "choice", choice: place.mode, probabilities: { [place.mode]: place.p } } },
    });
  }
  if (!url.endsWith("/chat/completions")) return new Response("fora do roteiro", { status: 500 });
  const tools: string[] = (body.tools || []).map((t: { function: { name: string } }) => t.function.name);
  if (tools.includes("note_objective")) {
    const r = gmScript.shift();
    assert.ok(r, "Mestre chamado além do roteiro");
    gmCtx.push(body.messages.map((m: { content: unknown }) => String(m.content ?? "")).find((c: string) => c.startsWith("(Contexto do turno")) ?? "");
    const calls = r.calls.map((c, index) => ({ index, id: `c${index}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }));
    const chunks = [
      { choices: [{ delta: { content: r.text } }] },
      ...(calls.length ? [{ choices: [{ delta: { tool_calls: calls } }] }] : []),
      { choices: [{ delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];
    return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n");
  }
  if (tools.includes("update_resource")) return Response.json({ choices: [{ message: { content: "" } }] }); // Escrivão: nada
  const isPlace = String(body.messages?.[0]?.content || "").startsWith("Você dá nome ao lugar");
  return Response.json({ choices: [{ message: { content: isPlace ? placeName : "?" } }] });
}) as typeof fetch;

const rs = normalizeRuleset(JSON.parse(fs.readFileSync("naruto-ruleset.json", "utf-8")));
const OLD_SUMMARY = `${"Conferência longa na Academia. ".repeat(60)}Hugo permanece no gabinete.`;

async function main() {
  const { rows: [c] } = await real.query(`INSERT INTO campaigns (name, style, ruleset) VALUES ('[teste-cena]', 'open', $1) RETURNING id`, [JSON.stringify(rs)]);
  const id: string = c.id;
  const scenes = async () =>
    (await real.query(`SELECT seq, mode, title, location, summary, is_current FROM scenes WHERE campaign_id = $1 ORDER BY seq`, [id])).rows as {
      seq: number; mode: string; title: string; location: string; summary: string; is_current: boolean;
    }[];
  const turn = async (input: string, text: string, calls: Call[] = []) => {
    gmScript.push({ text, calls });
    events = [];
    await runTurn(id, input, (e) => events.push(e));
  };
  try {
    await real.query(
      `INSERT INTO scenes (campaign_id, seq, mode, title, location, summary) VALUES ($1, 18, 'dialogue', 'Conferência concluída na Academia', 'Gabinete, Academia Ninja', $2)`,
      [id, OLD_SUMMARY]
    );
    await real.query(`INSERT INTO characters (campaign_id, kind, name, sheet) VALUES ($1, 'player', 'Hugo', $2), ($1, 'npc', 'Iruka', $2)`, [id, JSON.stringify(blankSheet(rs))]);

    // 1. mudou de lugar: cena nova com o local e o modo da narração; a anterior fica com o resumo
    place = { moved: 0.95, mode: "downtime", p: 0.8 };
    placeName = "Casa do Hugo, Konoha";
    await turn("Vou para casa.", "Você atravessa a vila e chega em casa.");
    let s = await scenes();
    assert.equal(s.length, 2, "cena nova");
    assert.deepEqual({ ...s[0], summary: s[0].summary === OLD_SUMMARY }, { seq: 18, mode: "dialogue", title: "Conferência concluída na Academia", location: "Gabinete, Academia Ninja", summary: true, is_current: false });
    assert.deepEqual(s[1], { seq: 19, mode: "downtime", title: "", location: "Casa do Hugo, Konoha", summary: "", is_current: true });
    assert.ok(events.some((e) => e.type === "scene"), "chip e cabeçalho da cena");
    const [camp] = (await real.query(`SELECT state FROM campaigns WHERE id = $1`, [id])).rows;
    assert.ok((await loadMap(id, camp.state)).places.some((p) => p.name === "Casa do Hugo"), "o mapa registra o lugar novo");

    // gerar novamente: volta à cena anterior; refeito, abre de novo
    await restoreSnapshot(id);
    assert.deepEqual((await scenes()).map((x) => [x.seq, x.is_current]), [[18, true]]);
    await turn("Vou para casa.", "Você atravessa a vila e chega em casa.");
    assert.equal((await scenes()).length, 2);

    // 2. ficou e o modo é o mesmo: nada muda; o contexto da cena nova mostra o fim do resumo anterior
    place = { moved: 0.02, mode: "downtime", p: 0.9 };
    await turn("Deito na cama.", "Você se joga na cama.");
    const ctx = gmCtx[gmCtx.length - 1];
    assert.match(ctx, /Modo: downtime \| Local: Casa do Hugo, Konoha \| Título: -/);
    assert.match(ctx, /Antes desta cena \(fim do resumo da anterior\): .*Hugo permanece no gabinete\./);
    assert.ok(!ctx.includes(OLD_SUMMARY.slice(0, 1300)), "só o fim do resumo anterior");
    assert.ok(!ctx.includes("Resumo do que já aconteceu nesta cena"));
    assert.equal((await scenes()).length, 2);

    // 3. ficou e a narração mostra outro modo: troca na cena atual
    place = { moved: 0.1, mode: "training", p: 0.7 };
    await turn("Treino selos de mão no quintal.", "Você repete os selos até as mãos doerem.");
    s = await scenes();
    assert.deepEqual([s.length, s[1].mode, s[1].location], [2, "training", "Casa do Hugo, Konoha"]);

    // 4. abaixo do limiar (0,6): fica
    place = { moved: 0.1, mode: "battle", p: 0.55 };
    await turn("Chuto o boneco.", "O boneco balança.");
    assert.equal((await scenes())[1].mode, "training");

    // 5. o Mestre trocou o modo no turno: o Jev não mexe
    place = { moved: 0.1, mode: "battle", p: 0.95 };
    await turn("Chamo o Iruka para conversar.", "Iruka senta no degrau.", [{ name: "set_scene", args: { mode: "dialogue" } }]);
    assert.equal((await scenes())[1].mode, "dialogue");

    // 6. com resumo próprio, o da anterior sai do contexto; Jev falhando, nada muda
    await real.query(`UPDATE scenes SET summary = 'Hugo chegou em casa e treinou.' WHERE campaign_id = $1 AND is_current`, [id]);
    place = "falha";
    await turn("Pergunto do exame.", "Iruka sorri.");
    assert.match(gmCtx[gmCtx.length - 1], /Resumo do que já aconteceu nesta cena \(compactado\): Hugo chegou em casa e treinou\./);
    assert.ok(!gmCtx[gmCtx.length - 1].includes("Antes desta cena"));
    s = await scenes();
    assert.deepEqual([s.length, s[1].mode], [2, "dialogue"]);
    assert.equal(gmScript.length, 0);

    console.log("scene-check: ok (mudou de lugar abre cena nova com local e modo, gerar novamente volta a cena, fim do resumo anterior até a cena ter o seu, modo pela narração só acima do limiar e se o Mestre não trocou, Jev falhando não mexe)");
  } finally {
    await new Promise((r) => setTimeout(r, 300)); // o índice do histórico roda depois do done
    await real.query(`DELETE FROM campaigns WHERE id = $1`, [id]);
    await real.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
