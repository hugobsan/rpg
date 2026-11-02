import { Suspense } from "react";
import { usageLogs, usageSummary } from "./data";
import UsageClient from "./UsageClient";
import s from "./usage.module.css";

export const dynamic = "force-dynamic";

// 1ª carga no servidor (o painel já vem no HTML); trocar filtro ou página busca no cliente
export default async function UsagePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) if (typeof v === "string") sp.set(k, v);
  const [summary, logs] = await Promise.all([usageSummary(sp), usageLogs(sp)]);
  return (
    <main className="container">
      <h1>Custos e uso</h1>
      <p className={`muted ${s.lede}`}>Todas as chamadas de IA, de todas as fontes, somadas no recorte dos filtros. O custo cobrado é o real do OpenRouter e, nas fontes com chave (Anthropic, API key), uma estimativa pelo preço do mesmo modelo no OpenRouter (≈). O Login com ChatGPT gasta a cota da assinatura: o custo dele é só estimado e fica à parte. Cache é a parte dos tokens de entrada lida do cache de prompt.</p>
      {/* useSearchParams pede Suspense no App Router */}
      <Suspense>
        <UsageClient initial={{ qs: sp.toString(), summary, logs }} />
      </Suspense>
    </main>
  );
}
