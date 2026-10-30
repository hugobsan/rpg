import Link from "next/link";
import type { ReactNode } from "react";
import { formatClock, period } from "@/lib/clock";
import type { CampaignRow } from "./campaignList";
import s from "./home.module.css";

export const STYLE_LABEL: Record<string, string> = { open: "Aberta", hybrid: "Híbrida", guided: "Guiada" };
const MODE_LABEL: Record<string, string> = {
  exploration: "Exploração",
  dialogue: "Diálogo",
  battle: "Batalha",
  training: "Treinamento",
  downtime: "Descanso",
};

const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
/** "há 5 minutos", "ontem", "12 de out." */
function ago(iso: string): string {
  const min = (Date.now() - Date.parse(iso)) / 60000;
  if (min < 1) return "agora há pouco";
  if (min < 60) return rtf.format(-Math.round(min), "minute");
  if (min < 60 * 24) return rtf.format(-Math.round(min / 60), "hour");
  if (min < 60 * 24 * 7) return rtf.format(-Math.round(min / 1440), "day");
  return new Date(iso).toLocaleDateString("pt-BR", { day: "numeric", month: "short", timeZone: "America/Sao_Paulo" });
}

export const Icon = {
  pin: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M8 14.5s4.5-4.2 4.5-8a4.5 4.5 0 0 0-9 0c0 3.8 4.5 8 4.5 8Z" /><circle cx="8" cy="6.5" r="1.6" /></svg>,
  clock: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="8" cy="8" r="6.2" /><path d="M8 4.6V8l2.4 1.5" strokeLinecap="round" /></svg>,
  arrow: <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M3 8h9.5M8.5 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" /></svg>,
};

/**
 * Cartão da campanha pintado no tema dela (data-theme, sem .theme-root: só o cartão muda).
 * Sem href vira prévia (criação de campanha). `actions` fica acima do link esticado.
 */
export default function CampaignCard({ c, featured, actions, href = `/campaign/${c.id}` }: {
  c: CampaignRow;
  featured?: boolean;
  actions?: ReactNode;
  href?: string | null;
}) {
  const msgs = c.message_count;
  return (
    <article className={`${s.card}${featured ? ` ${s.featured}` : ""}`} data-theme={c.theme} data-mode={c.mode ?? undefined}>
      {c.image_id && (
        // eslint-disable-next-line @next/next/no-img-element -- imagem da rota da campanha, cache imutável
        <img className={s.cover} src={`/api/campaigns/${c.id}/images/${c.image_id}`} alt="" loading={featured ? "eager" : "lazy"} decoding="async" />
      )}
      <div className={s.body}>
        <div className={`overline ${s.top}`}>{c.ruleset_name}</div>
        <h2 className={s.name}>
          {href ? <Link href={href} className={s.link}>{c.name}</Link> : c.name || "Sua campanha"}
        </h2>
        {c.character_name && <p className={s.char}>com <b>{c.character_name}</b></p>}
        {(c.mode || c.location || c.clock != null) && (
          <div className={s.where}>
            {c.mode && <span className="mode-badge" style={{ color: "var(--mode)" }}>{MODE_LABEL[c.mode] || c.mode}</span>}
            {c.location && <span className={s.meta}>{Icon.pin}<span className={s.loc} title={c.location}>{c.location}</span></span>}
            {c.clock != null && <span className={`${s.meta} num`}>{Icon.clock}{formatClock(c.clock)} · {period(c.clock)}</span>}
          </div>
        )}
        <div className={s.foot}>
          <span className={s.stats}>
            {STYLE_LABEL[c.style] || c.style}
            {href && ` · ${msgs} ${msgs === 1 ? "mensagem" : "mensagens"} · ${ago(c.last_played)}`}
          </span>
          {href && <span className={s.cta}>{msgs ? "Continuar" : "Começar"}{Icon.arrow}</span>}
        </div>
      </div>
      {actions}
    </article>
  );
}
