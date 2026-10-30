import Skeleton from "@/components/ui/Skeleton";
import s from "./agents.module.css";

export default function Loading() {
  return (
    <main className="container" aria-busy="true">
      <h1>Agentes</h1>
      <Skeleton lines={2} w="70%" style={{ marginBottom: 24 }} />
      <Skeleton h={76} style={{ marginBottom: 24, borderRadius: "var(--r-lg)" }} />
      <div className={s.grid}>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className={`card ${s.agent}`}>
            <Skeleton w="45%" h={24} />
            <Skeleton lines={2} />
            <Skeleton h={64} />
          </div>
        ))}
      </div>
    </main>
  );
}
