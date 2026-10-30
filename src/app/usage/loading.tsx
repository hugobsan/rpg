import Skeleton from "@/components/ui/Skeleton";
import s from "./usage.module.css";

export default function Loading() {
  return (
    <main className="container" aria-busy="true">
      <h1>Custos e uso</h1>
      <Skeleton w="45%" h={14} style={{ marginBottom: 24 }} />
      <div className={`card ${s.filters}`}><Skeleton h={26} w="70%" /><Skeleton h={40} /></div>
      <div className={s.kpis}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className={`card ${s.tile} ${i === 0 ? s.hero : ""}`}>
            <Skeleton w="50%" h={12} />
            <Skeleton w="70%" h={i === 0 ? 48 : 24} style={{ marginTop: 6 }} />
          </div>
        ))}
      </div>
      <div className={`card ${s.panel}`}><Skeleton w={160} h={20} /><Skeleton h={220} style={{ marginTop: 12 }} /></div>
      <div className={`card ${s.panel}`}><Skeleton w={120} h={20} /><Skeleton lines={5} /></div>
    </main>
  );
}
