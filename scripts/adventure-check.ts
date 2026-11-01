/**
 * Criador de aventuras sem IA: parse da resposta do agente, merge do rascunho, validação final
 * (o Naruto passa; rascunho quebrado não) e a rota (ler, listar, apagar; erros antes de chamar a IA).
 * Linhas temporárias apagadas no fim. Rodar: npx tsx scripts/adventure-check.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { NextRequest } from "next/server";
import { pool, q } from "../src/lib/db";
import { draftIssues, draftProgress, mergeDraft, parseReply, type Draft } from "../src/lib/adventure";
import { blankSheet, normalizeRuleset, startingKit } from "../src/lib/ruleset";
import { DELETE, GET, POST } from "../src/app/api/adventures/route";
import type { Ability } from "../src/lib/types";

const naruto = JSON.parse(fs.readFileSync("naruto-ruleset.json", "utf-8")) as Draft;
const req = (url: string, body?: unknown) =>
  new NextRequest(`http://x/api/adventures${url}`, body ? { method: "POST", body: JSON.stringify(body) } : undefined);

async function main() {
  // ---------- parse ----------
  let r = parseReply('Fechado: Hogwarts, 1991.\n\nQual casa?\n\n```json\n{"patch": {"name": "Hogwarts"}, "choices": ["Grifinória", " ", 3], "done": false}\n```');
  assert.equal(r.message, "Fechado: Hogwarts, 1991.\n\nQual casa?");
  assert.deepEqual(r.patch, { name: "Hogwarts" });
  assert.deepEqual(r.choices, ["Grifinória"], "só textos não vazios");
  assert.equal(r.done, false);
  r = parseReply('Pronto!\n```json\n{"patch": {"canonBased": true,}, "done": true}\n```');
  assert.deepEqual([r.patch, r.done, r.message], [{ canonBased: true }, true, "Pronto!"], "vírgula sobrando é tolerada");
  r = parseReply('Ok.\n```json\n{"patch": {"loreNotes": "linha 1\nlinha 2"}, "done": false}\n```');
  assert.deepEqual(r.patch, { loreNotes: "linha 1 linha 2" }, "quebra de linha crua dentro de texto");
  r = parseReply('Pronta.\n```json\n{"patch": {"startingAbilities": {"a": [{"name": "Lumos"}]}}}, "choices": ["Começar"], "done": true}\n```');
  assert.deepEqual([r.patch, r.choices, r.done], [{ startingAbilities: { a: [{ name: "Lumos" }] } }, ["Começar"], true], "chave fechando a mais");
  r = parseReply('Texto.\n{"patch": {"theme": "arcano"}, "choices": [], "done": false}');
  assert.deepEqual([r.message, r.patch], ["Texto.", { theme: "arcano" }], "sem cerca: objeto solto no fim");
  r = parseReply('<think>hmm</think>Oi.\n```json\n{"patch": {"name": "x"\n```');
  assert.deepEqual([r.message, r.patch, r.done, r.broken], ["Oi.", {}, false, true], "bloco ilegível: o texto sobrevive, sem JSON e sem raciocínio");
  r = parseReply('Veja:\n```json\n{"exemplo": 1}\n```\nE aí?\n```json\n{"patch": {}, "done": false}\n```');
  assert.match(r.message, /exemplo[\s\S]*E aí\?/, "só o bloco de estado sai do texto");
  assert.deepEqual([parseReply("Só texto.").patch, parseReply("Só texto.").broken], [{}, false]);
  assert.equal(parseReply('ok {"patch": {"name": 1}, "choices": "x"}').choices.length, 0);

  // ---------- merge ----------
  const base: Draft = { name: "A", attributes: [{ key: "for", label: "Força", min: 1, max: 10, default: 3 }] };
  const merged = mergeDraft(base, { attributes: [], description: "d", hack: 1, name: null } as unknown as Draft);
  assert.deepEqual(merged, { attributes: [], description: "d" }, "campo inteiro trocado, null apaga, desconhecido ignorado");
  assert.equal(base.name, "A", "não muta o rascunho");
  assert.equal(base.attributes!.length, 1);

  // ---------- validação ----------
  assert.deepEqual(draftIssues(naruto), [], "o exemplo de referência fecha");
  const empty = draftIssues({});
  for (const k of ["name", "loreNotes", "theme", "attributes", "resources", "abilityTypes", "abilityRanks", "ranks", "powerLevels", "creationPoints", "extraFields", "abilityCosts", "diceNotes"])
    assert.ok(empty.some((i) => i.startsWith(k)), `rascunho vazio cobra ${k}`);
  const broken: Draft = {
    ...naruto,
    theme: "rosa",
    attributes: [...naruto.attributes!, { key: "Magia", label: "Magia", min: 1, max: 10, default: 12 }],
    resources: [{ key: "hp", label: "Vida", defaultMax: 0, color: "red" }],
    ranks: [{ key: "a", label: "A", xpRequired: 10 }, { key: "a", label: "B", xpRequired: 5 }],
    abilityTypes: [...naruto.abilityTypes!, { key: "pocoes", label: "Poções" }],
    // cost não existe mais (vem do rank): o rascunho que ainda o traz é cobrado
    startingAbilities: { genin: [{ name: "Raio", type: "voo", rank: "Z", costFree: "sim", cost: { resource: "mana", amount: 2 } } as unknown as Ability] },
  };
  const issues = draftIssues(broken).join("\n");
  for (const re of [/theme/, /key inválida "Magia"/, /Magia.*min <= default/s, /hp: defaultMax/, /hp: color/, /ranks: key repetida/,
    /ranks: xpRequired/, /abilityCosts: \{resource/, /tipo "pocoes" sem atributo/, /falta o kit do primeiro cargo "a"/,
    /"genin" não é key de ranks/, /type "voo"/, /rank "Z"/, /genin\.Raio: costFree é true ou false/, /genin\.Raio: sem cost/])
    assert.match(issues, re);

  // o que passa na validação vira campanha: ficha e kit inicial
  const rs = normalizeRuleset(naruto);
  assert.equal(Object.keys(blankSheet(rs).attributes).length, 8);
  assert.equal(startingKit(rs, rs.ranks[0].key).length, 6);

  // ---------- progresso ----------
  assert.ok(draftProgress({}).every((p) => p.value === null));
  const prog = Object.fromEntries(draftProgress({ ...naruto, startingPoint: "Véspera do Exame Chunin" }).map((p) => [p.label, p.value]));
  assert.equal(prog["Aventura"], "Mundo Shinobi (Naruto), segue a obra");
  assert.match(prog["Jutsus"]!, /Ninjutsu.*níveis D < C < B < A < S/);
  assert.equal(prog["Custo"], "Chakra por nível: D 3, C 6, B 12, A 20, S 35");
  assert.equal(prog["Kit inicial"], "10 habilidades");
  assert.equal(prog["Tema visual"], "Shinobi");
  assert.equal(prog["Ponto de partida"], "Véspera do Exame Chunin");

  // ---------- rota (sem IA) ----------
  const [row] = await q<{ id: string }>(
    `INSERT INTO adventure_drafts (messages, draft) VALUES ($1, $2) RETURNING id`,
    [JSON.stringify([{ role: "assistant", content: "Oi" }, { role: "user", content: "Harry Potter" }]), JSON.stringify({ name: "Teste do check" })]
  );
  try {
    const one = await (await GET(req(`?id=${row.id}`))).json();
    assert.equal(one.draft.name, "Teste do check");
    assert.equal(one.messages.length, 2);
    const list = (await (await GET(req(""))).json()) as { id: string; name: string; first: string; count: number }[];
    const mine = list.find((x) => x.id === row.id);
    assert.deepEqual([mine?.name, mine?.first, mine?.count], ["Teste do check", "Harry Potter", 2]);
    assert.equal((await GET(req("?id=nao-e-uuid"))).status, 404);
    assert.equal((await POST(req("", { id: row.id, text: "  " }))).status, 400, "texto vazio nem chama a IA");
    assert.equal((await POST(req("", { id: "00000000-0000-0000-0000-000000000000", text: "oi" }))).status, 404);
    await DELETE(req(`?id=${row.id}`));
    assert.equal((await q(`SELECT 1 FROM adventure_drafts WHERE id = $1`, [row.id])).length, 0);
  } finally {
    await q(`DELETE FROM adventure_drafts WHERE id = $1`, [row.id]);
  }
  console.log("adventure-check: ok");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool().end());
