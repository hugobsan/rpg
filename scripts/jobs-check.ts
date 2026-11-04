/**
 * Verificação das tarefas em segundo plano (lib/jobs.ts): fim, erro, progresso e duplicata.
 * Campanha temporária, sem IA. Rodar: npx tsx scripts/jobs-check.ts
 */
import assert from "node:assert/strict";
import { pool, q } from "../src/lib/db";
import { listJobs, startJob } from "../src/lib/jobs";

const tick = () => new Promise((r) => setTimeout(r, 150));

async function main() {
  const [c] = await q<{ id: string }>(`INSERT INTO campaigns (name, ruleset) VALUES ('[teste-jobs]', '{}') RETURNING id`);
  const id = c.id;
  try {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = await startJob(id, "library", "ability:fogo", "Lote A", async (progress) => {
      await progress(1, 3);
      await gate;
    });
    assert.equal(a.started, true);
    const dup = await startJob(id, "library", "ability:fogo", "Lote A de novo", async () => {});
    assert.deepEqual(dup, { id: a.id, started: false }, "mesma tarefa rodando não começa outra");
    await tick();
    let jobs = await listJobs(id);
    assert.equal(jobs.find((j) => j.id === a.id)?.status, "running");
    assert.deepEqual(jobs.find((j) => j.id === a.id)?.progress, { done: 1, total: 3 });

    const b = await startJob(id, "portrait", null, "Retrato", async () => {
      throw new Error("modelo fora");
    });
    release();
    await tick();
    jobs = await listJobs(id);
    assert.equal(jobs.find((j) => j.id === a.id)?.status, "done");
    const jb = jobs.find((j) => j.id === b.id);
    assert.equal(jb?.status, "error");
    assert.equal(jb?.error, "modelo fora");

    // rodando sem sinal há mais de 15 min = o servidor reiniciou no meio: vira erro (e some em 2 min)
    await q(`INSERT INTO jobs (campaign_id, kind, label, updated_at) VALUES ($1, 'library', 'Velha', now() - interval '20 minutes')`, [id]);
    const old = (await listJobs(id)).find((j) => j.label === "Velha");
    assert.equal(old?.status, "error");
    const again = await startJob(id, "library", "ability:fogo", "Lote A outra vez", async () => {});
    assert.equal(again.started, true, "terminada não bloqueia uma nova");
    console.log("jobs-check: ok");
  } finally {
    await q(`DELETE FROM campaigns WHERE id = $1`, [id]);
    await pool().end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
