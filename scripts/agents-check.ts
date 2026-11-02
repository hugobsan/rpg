/**
 * Prompts padrão versionados por hash (src/lib/agents.ts), sem IA, numa tabela agents descartável (schema
 * agents_check no banco local, apagado no fim). Confere: agente novo entra com o padrão e o hash; padrão mudou e o
 * prompt intocado é trocado; prompt editado à mão não é trocado e a API manda o padrão novo; restaurar pela rota troca e
 * grava prompt_base; agente sem prompt_base (anterior a este controle): igual ao padrão = intocado, senão editado.
 * Rodar: npx tsx scripts/agents-check.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Pool } from "pg";
import { NextRequest } from "next/server";
import { DEFAULT_AGENTS, getAgent, insertDefaultAgents, listAgents, promptHash } from "../src/lib/agents";
import { lineDiff } from "../src/lib/lineDiff";
import { PUT } from "../src/app/api/agents/[id]/route";

const url = process.env.DATABASE_URL || "postgres://rpg:rpg@localhost:5433/rpg";
const admin = new Pool({ connectionString: url, max: 1 });
const pool = new Pool({ connectionString: url, max: 2, options: "-c search_path=agents_check" });
const g = global as unknown as { __pgPool?: unknown; __schemaReady?: Promise<boolean> };
g.__pgPool = pool;
g.__schemaReady = Promise.resolve(true);

const def = (id: string) => DEFAULT_AGENTS.find((a) => a.id === id)!;
const row = async (id: string) =>
  (await pool.query<{ system_prompt: string; prompt_base: string | null }>(`SELECT system_prompt, prompt_base FROM agents WHERE id = $1`, [id])).rows[0];

(async () => {
  await admin.query(`DROP SCHEMA IF EXISTS agents_check CASCADE; CREATE SCHEMA agents_check`);
  // a tabela de agentes como o schema.sql a cria (CREATE + ALTERs de agents)
  const sql = fs.readFileSync("src/lib/schema.sql", "utf-8");
  const ddl = [sql.match(/CREATE TABLE IF NOT EXISTS agents \([\s\S]*?\);/)![0], ...sql.match(/^ALTER TABLE agents .*;$/gm)!];
  for (const s of ddl) await pool.query(s);
  try {
    // agente novo: padrão + hash
    await insertDefaultAgents();
    for (const a of DEFAULT_AGENTS) {
      const r = await row(a.id);
      assert.equal(r.system_prompt, a.system_prompt, `${a.id}: inserido com o padrão`);
      assert.equal(r.prompt_base, promptHash(a.system_prompt), `${a.id}: prompt_base = hash do padrão`);
    }
    assert.ok((await listAgents()).every((a) => a.default_prompt === undefined), "nada a oferecer com tudo no padrão");

    // padrão mudou e o prompt está intocado: troca inteiro
    def("npc").system_prompt += "\nLinha nova do padrão.";
    await insertDefaultAgents();
    assert.equal((await row("npc")).system_prompt, def("npc").system_prompt, "npc intocado recebe o padrão novo");
    assert.equal((await row("npc")).prompt_base, promptHash(def("npc").system_prompt));

    // editado à mão (como o PUT da tela: só system_prompt): o padrão muda e o prompt fica
    const mine = def("chronicler").system_prompt + "\nRegra minha.";
    await pool.query(`UPDATE agents SET system_prompt = $1 WHERE id = 'chronicler'`, [mine]);
    await insertDefaultAgents();
    assert.equal((await getAgent("chronicler")).default_prompt, undefined, "editado sem padrão novo: nada a oferecer");
    def("chronicler").system_prompt = "Cronista: padrão novo.\n" + def("chronicler").system_prompt;
    await insertDefaultAgents();
    assert.equal((await row("chronicler")).system_prompt, mine, "editado à mão não é sobrescrito");
    const listed = (await listAgents()).find((a) => a.id === "chronicler")!;
    assert.equal(listed.default_prompt, def("chronicler").system_prompt, "a API manda o padrão novo");
    assert.equal((await getAgent("npc")).default_prompt, undefined);

    // restaurar pela rota: troca e grava prompt_base
    const res = await PUT(new NextRequest("http://x/api/agents/chronicler", { method: "PUT", body: JSON.stringify({ restorePrompt: true }) }), {
      params: Promise.resolve({ id: "chronicler" }),
    });
    const restored = await res.json();
    assert.equal(restored.system_prompt, def("chronicler").system_prompt, "restaurar traz o padrão atual");
    assert.equal(restored.default_prompt, undefined);
    assert.equal((await row("chronicler")).prompt_base, promptHash(def("chronicler").system_prompt), "restaurar grava prompt_base");

    // sem prompt_base: gm igual ao padrão vira intocado; scribe diferente fica editado (NULL) e a tela oferece o padrão
    await pool.query(`UPDATE agents SET prompt_base = NULL WHERE id = 'gm'`);
    const edited = def("scribe").system_prompt + "\nEdição minha.";
    await pool.query(`UPDATE agents SET system_prompt = $1, prompt_base = NULL WHERE id = 'scribe'`, [edited]);
    await insertDefaultAgents();
    assert.deepEqual(await row("gm"), { system_prompt: def("gm").system_prompt, prompt_base: promptHash(def("gm").system_prompt) }, "gm = intocado");
    const s = await row("scribe");
    assert.deepEqual(s, { system_prompt: edited, prompt_base: null }, "scribe editado fica como está, sem prompt_base");
    assert.equal((await getAgent("scribe")).default_prompt, def("scribe").system_prompt, "e a tela oferece o padrão");
    // padrão novo do scribe não o atropela
    def("scribe").system_prompt += "\nMais uma do padrão.";
    await insertDefaultAgents();
    assert.equal((await row("scribe")).system_prompt, s.system_prompt);

    // diferença por linhas
    assert.deepEqual(lineDiff("a\nb\nc", "a\nx\nc\nd"), [[" ", "a"], ["-", "b"], ["+", "x"], [" ", "c"], ["+", "d"]]);
    console.log("agents-check: ok");
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS agents_check CASCADE`);
    await Promise.all([admin.end(), pool.end()]);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
