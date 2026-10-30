/**
 * Verificação do Criador de personagens sem IA: leitura e limpeza do JSON dele, merge que não atropela
 * o que o Mestre mudou enquanto o job rodava, gravação com a linha travada e o create_npc de NPC que já existe.
 * Campanha temporária. Rodar: npx tsx scripts/characters-check.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { pool, q } from "../src/lib/db";
import { applyProfile, mergeProfile, normalizeDraft, parseCreatorJson, Snapshot } from "../src/lib/characters";
import { executeGmTool, ToolContext } from "../src/lib/tools";
import { blankSheet, normalizeRuleset } from "../src/lib/ruleset";
import type { Campaign, Scene, Sheet, TurnEvent } from "../src/lib/types";

const r = normalizeRuleset(JSON.parse(fs.readFileSync("naruto-ruleset.json", "utf-8")));

async function main() {
  // JSON do modelo: raciocínio antes, cerca e vírgula sobrando
  assert.deepEqual(parseCreatorJson('<think>{"x":1}</think>\nAqui:\n```json\n{"profile": {"age": "30",},}\n```'), { profile: { age: "30" } });
  assert.throws(() => parseCreatorJson("sem json"), /JSON legível/);

  const d = normalizeDraft(
    {
      profile: { appearance: "  Alto, cabelo prateado.  ", role: "Jounin de Konoha", speech: "", gender: "female", bogus: "x" },
      sheet: {
        rank: "jounin",
        powerLevel: "jounin",
        attributes: { taijutsu: 12, ninjutsu: "8", genjutsu: 0, inexistente: 5 },
        resources: { hp: 120, chakra: "200", mana: 50, stamina: 0 },
        extra: { vila: "Konoha", cla: "", nada: "x" },
        abilities: [
          { name: "Chidori", progress: 140 },
          { name: "chidori", progress: 10 },
          { name: "Raikiri", type: "ninjutsu", rank: "A", cost: { resource: "chakra", amount: 20 }, damage: "4d6", milestones: [{ threshold: 50, description: "corta raio" }, { threshold: 0, description: "base" }] },
          { name: "Golpe Estranho", type: "inventado", rank: "Z", cost: { resource: "mana", amount: 3 } },
          { type: "ninjutsu" },
        ],
        inventory: [{ name: "Kunai", qty: 0 }, { name: "kunai" }, { name: "Icha Icha", qty: "2", description: "livro" }],
      },
    },
    r
  );
  assert.deepEqual(d.persona, { appearance: "Alto, cabelo prateado.", role: "Jounin de Konoha", gender: "female" }, "só campos do perfil, aparados");
  assert.equal(d.sheet.rank, "jounin");
  assert.equal(d.sheet.xp, 3000, "xp do nível de poder");
  // teto do Jounin é 9; mínimo 1; key desconhecida some
  assert.deepEqual(d.sheet.attributes, { taijutsu: 9, ninjutsu: 8, genjutsu: 1 });
  assert.deepEqual(d.sheet.resources, { hp: { current: 120, max: 120 }, chakra: { current: 200, max: 200 } });
  assert.deepEqual(d.sheet.extra, { vila: "Konoha" });
  assert.deepEqual(d.abilities.map((a) => [a.name, a.type, a.rank, a.progress]), [
    ["Chidori", "", undefined, 100],
    ["Raikiri", "ninjutsu", "A", 50],
    ["Golpe Estranho", "", undefined, 50],
  ]);
  assert.deepEqual(d.abilities[1].cost, { resource: "chakra", amount: 20 });
  assert.deepEqual(d.abilities[1].milestones?.map((m) => m.threshold), [0, 50], "marcos em ordem");
  assert.equal(d.abilities[2].cost, undefined, "recurso inexistente");
  assert.deepEqual(d.sheet.inventory, [
    { name: "Kunai", qty: 1, description: undefined },
    { name: "Icha Icha", qty: 2, description: "livro" },
  ]);
  const vazio = normalizeDraft({ sheet: { rank: "hokage", powerLevel: "x" } }, r);
  assert.equal(vazio.sheet.rank, undefined);
  assert.equal(vazio.sheet.xp, undefined);
  assert.equal(normalizeDraft(null, r).abilities.length, 0, "lixo não quebra");

  // ---------- merge ----------
  const base: Snapshot = {
    sheet: blankSheet(r),
    persona: { personality: "Calmo", backstory: "brief do Mestre", gender: "male", appearance: undefined },
  };
  const draft = normalizeDraft(
    {
      profile: { personality: "Calmo e preguiçoso", backstory: "Passado rico", appearance: "Máscara", goals: "Proteger o time", gender: "female" },
      sheet: {
        rank: "jounin",
        powerLevel: "jounin",
        attributes: { taijutsu: 8, ninjutsu: 9 },
        resources: { hp: 120, chakra: 200 },
        extra: { vila: "Konoha", cla: "Hatake" },
        abilities: [{ name: "Chidori", type: "ninjutsu", rank: "A", progress: 80, effect: "estocada de raio" }, { name: "Kawarimi", type: "ninjutsu", progress: 100 }],
        inventory: [{ name: "Kunai", qty: 5 }],
      },
    },
    r
  );
  // no meio tempo o Mestre: dano, chidori com add_ability, cargo, sexo pelo modal, voz, mudou o passado
  const cur: Snapshot = JSON.parse(JSON.stringify(base));
  cur.sheet.resources.hp.current = 30;
  cur.sheet.abilities.push({ name: "chidori", type: "ninjutsu", progress: 15 });
  cur.sheet.rank = "chunin";
  cur.sheet.inventory.push({ name: "Pergaminho", qty: 1 });
  cur.persona.backstory = "O Mestre reescreveu";
  cur.persona.voiceFx = { rate: 1.2, pitch: 0 };
  const m = mergeProfile(base, cur, draft);
  assert.deepEqual(m.sheet.resources.hp, { current: 30, max: 40 }, "dano do Mestre fica");
  assert.deepEqual(m.sheet.resources.chakra, { current: 200, max: 200 }, "o resto vem do Criador");
  assert.equal(m.sheet.rank, "chunin", "set_rank do Mestre fica");
  assert.equal(m.sheet.xp, 3000);
  assert.equal(m.sheet.attributes.taijutsu, 8);
  assert.equal(m.sheet.attributes.genjutsu, base.sheet.attributes.genjutsu, "o que o Criador não deu continua");
  assert.deepEqual(m.sheet.extra, { vila: "Konoha", cla: "Hatake" });
  assert.deepEqual(m.sheet.abilities, [
    { name: "chidori", type: "ninjutsu", progress: 15, rank: "A", effect: "estocada de raio" },
    { name: "Kawarimi", type: "ninjutsu", progress: 100 },
  ].map((a) => ({ ...draft.abilities.find((x) => x.name.toLowerCase() === a.name.toLowerCase()), ...a })), "a do Mestre vence campo a campo, o Criador completa e soma");
  assert.deepEqual(m.sheet.inventory.map((i) => `${i.qty}x ${i.name}`), ["1x Pergaminho", "5x Kunai"]);
  assert.equal(m.persona.backstory, "O Mestre reescreveu", "persona mexida no meio tempo fica");
  assert.equal(m.persona.personality, "Calmo e preguiçoso", "o que o Mestre deu no registro o Criador expande");
  assert.equal(m.persona.appearance, "Máscara");
  assert.equal(m.persona.goals, "Proteger o time");
  assert.equal(m.persona.gender, "male", "sexo nunca vem do Criador");
  assert.deepEqual(m.persona.voiceFx, { rate: 1.2, pitch: 0 });
  assert.equal(mergeProfile(base, { ...cur, persona: { ...cur.persona, gender: undefined } }, draft).persona.gender, "female", "sexo ainda não decidido: o Criador preenche");

  // ---------- gravação no banco (JSONB reordena chaves: não pode contar como mudança) ----------
  const [c] = await q<{ id: string }>(`INSERT INTO campaigns (name, ruleset) VALUES ('[teste-personagens] check', $1) RETURNING id`, [JSON.stringify(r)]);
  const id = c.id;
  try {
    const [npc] = await q<{ id: string }>(
      `INSERT INTO characters (campaign_id, kind, name, sheet, persona) VALUES ($1,'npc','Kakashi',$2,$3) RETURNING id`,
      [id, JSON.stringify(base.sheet), JSON.stringify(base.persona)]
    );
    // update_resource no meio tempo, do jeito que as tools gravam
    await q(`UPDATE characters SET sheet = jsonb_set(sheet, '{resources,hp,current}', '25') WHERE id = $1`, [npc.id]);
    assert.equal(await applyProfile(npc.id, base, draft), true);
    const [row] = await q<{ sheet: Sheet; persona: Snapshot["persona"] }>(`SELECT sheet, persona FROM characters WHERE id = $1`, [npc.id]);
    assert.deepEqual(row.sheet.resources.hp, { current: 25, max: 40 });
    assert.deepEqual(row.sheet.resources.chakra, { current: 200, max: 200 });
    assert.equal(row.sheet.rank, "jounin");
    assert.equal(row.sheet.attributes.ninjutsu, 9);
    assert.equal(row.persona.backstory, "Passado rico", "base com chave undefined não conta como mudança");
    assert.equal(row.persona.gender, "male");
    assert.equal(await applyProfile("00000000-0000-0000-0000-000000000000", base, draft), false, "personagem sumiu: nada a fazer");

    // create_npc de quem já existe só traz de volta (sem Criador)
    await q(`UPDATE characters SET active = FALSE WHERE id = $1`, [npc.id]);
    const events: TurnEvent[] = [];
    const ctx: ToolContext = { campaign: { id, state: {}, ruleset: r } as unknown as Campaign, scene: {} as Scene, emit: (e) => events.push(e) };
    const out = await executeGmTool("create_npc", { name: "Kakashi", gender: "male", brief: "jounin" }, ctx);
    assert.match(out, /já estava registrado/);
    const [after] = await q<{ active: boolean; n: string }>(
      `SELECT active, (SELECT count(*) FROM jobs WHERE campaign_id = $1)::text AS n FROM characters WHERE id = $2`,
      [id, npc.id]
    );
    assert.deepEqual(after, { active: true, n: "0" });
  } finally {
    await q(`DELETE FROM campaigns WHERE id = $1`, [id]);
  }
  console.log("characters-check: ok");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool().end());
