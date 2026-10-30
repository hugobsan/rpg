import Link from "next/link";
import { THEMES } from "@/lib/theme";
import { listCampaigns } from "./campaignList";
import CampaignCard from "./CampaignCard";
import DeleteCampaign from "./DeleteCampaign";
import s from "./home.module.css";

// lê o banco a cada visita: a lista já vem no HTML, sem "carregando"
export const dynamic = "force-dynamic";

export default async function Home() {
  const rows = await listCampaigns();
  return (
    <main className="container">
      <header className={s.head}>
        <div>
          <h1>Suas campanhas</h1>
          <p className="muted">Retome de onde parou ou abra uma mesa nova.</p>
        </div>
        {rows.length > 0 && <Link href="/campaigns/new" className="btn primary">Nova campanha</Link>}
      </header>

      {rows.length === 0 ? (
        <section className={s.empty}>
          <div className={s.seal} aria-hidden="true" />
          <h2>A mesa está pronta</h2>
          <p>
            Escolha um cenário, monte seu personagem e o Mestre abre a primeira cena. O preset de Naruto já vem
            pronto; qualquer outro mundo entra por um JSON de mecânica.
          </p>
          <Link href="/campaigns/new" className="btn primary">Criar a primeira campanha</Link>
          <div className={s.swatches} aria-label="Temas visuais disponíveis">
            {THEMES.map((t) => <span key={t.key} className={s.swatch} data-theme={t.key}>{t.label}</span>)}
          </div>
        </section>
      ) : (
        <div className={s.grid}>
          {rows.map((c, i) => (
            <CampaignCard key={c.id} c={c} featured={i === 0} actions={<DeleteCampaign id={c.id} name={c.name} />} />
          ))}
        </div>
      )}
    </main>
  );
}
