"use client";
import { useEffect, useRef, useState } from "react";
import type { Job } from "@/lib/types";

/**
 * Tarefas em segundo plano da campanha (retratos, biblioteca, perfis de NPC).
 * Parte de `fromState` (o GET da campanha, relido depois de cada turno ou ação) e, enquanto
 * alguma roda, consulta /jobs a cada 3 s. Quando uma termina, chama onFinish (a tela recarrega e avisa).
 */
export function useJobs(campaignId: string, fromState: Job[] | undefined, onFinish: (ended: Job[]) => void): Job[] {
  const [jobs, setJobs] = useState<Job[]>(fromState ?? []);
  const last = useRef(jobs);
  const finish = useRef(onFinish);
  finish.current = onFinish;

  const apply = (next: Job[]) => {
    const ended = next.filter((j) => j.status !== "running" && last.current.some((p) => p.id === j.id && p.status === "running"));
    last.current = next;
    setJobs(next);
    if (ended.length) finish.current(ended);
  };

  useEffect(() => {
    if (fromState) apply(fromState);
  }, [fromState]); // eslint-disable-line react-hooks/exhaustive-deps

  const running = jobs.some((j) => j.status === "running");
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const t = setInterval(async () => {
      const next = await fetch(`/api/campaigns/${campaignId}/jobs`)
        .then((r) => (r.ok ? (r.json() as Promise<Job[]>) : null))
        .catch(() => null);
      if (alive && next) apply(next);
    }, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [running, campaignId]); // eslint-disable-line react-hooks/exhaustive-deps

  return jobs;
}
