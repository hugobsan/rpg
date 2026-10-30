import { q } from "./db";
import type { Job } from "./types";

// sem sinal de vida por mais que isso = o processo caiu no meio (reinício do servidor): conta como erro
const STALE = "15 minutes";

/**
 * Roda `fn` em segundo plano, sem segurar o turno nem a resposta HTTP, e registra em `jobs`
 * para a tela de jogo acompanhar (indicador no cabeçalho + aviso ao terminar).
 * Com `target`, uma tarefa igual (mesmo kind + target) já rodando não começa de novo: devolve a dela.
 * `progress(done, total)` atualiza a barra e serve de sinal de vida em tarefas longas.
 * ponytail: roda no próprio processo do Next; fila de verdade (worker) se um dia for multi-instância.
 */
export async function startJob(
  campaignId: string,
  kind: string,
  target: string | null,
  label: string,
  fn: (progress: (done: number, total: number) => Promise<void>) => Promise<void>
): Promise<{ id: number; started: boolean }> {
  if (target) {
    const [dup] = await q<{ id: string }>(
      `SELECT id FROM jobs WHERE campaign_id = $1 AND kind = $2 AND target = $3 AND status = 'running'
         AND updated_at > now() - interval '${STALE}' ORDER BY id DESC LIMIT 1`,
      [campaignId, kind, target]
    );
    if (dup) return { id: Number(dup.id), started: false };
  }
  const [row] = await q<{ id: string }>(
    `INSERT INTO jobs (campaign_id, kind, target, label) VALUES ($1,$2,$3,$4) RETURNING id`,
    [campaignId, kind, target, label]
  );
  const id = Number(row.id);
  const progress = async (done: number, total: number) => {
    await q(`UPDATE jobs SET progress = $2, updated_at = now() WHERE id = $1`, [id, JSON.stringify({ done, total })]);
  };
  void fn(progress)
    .then(
      () => q(`UPDATE jobs SET status = 'done', updated_at = now() WHERE id = $1`, [id]),
      (e) => {
        console.error(`[job ${kind}#${id}]`, e);
        return q(`UPDATE jobs SET status = 'error', error = $2, updated_at = now() WHERE id = $1`, [
          id,
          (e instanceof Error ? e.message : String(e)).slice(0, 500),
        ]);
      }
    )
    .catch(() => {}); // banco fora: a tarefa fica "running" e vira erro pelo STALE
  return { id, started: true };
}

/** Tarefas rodando + as que terminaram nos últimos 2 minutos (a tela avisa o fim). */
export async function listJobs(campaignId: string): Promise<Job[]> {
  await q(
    `UPDATE jobs SET status = 'error', error = 'Interrompida (o servidor reiniciou no meio)', updated_at = now()
      WHERE campaign_id = $1 AND status = 'running' AND updated_at < now() - interval '${STALE}'`,
    [campaignId]
  );
  const rows = await q<Job & { id: string }>(
    `SELECT id, kind, target, label, status, progress, error FROM jobs
      WHERE campaign_id = $1 AND (status = 'running' OR updated_at > now() - interval '2 minutes')
      ORDER BY id DESC LIMIT 20`,
    [campaignId]
  );
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}
