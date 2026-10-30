import Skeleton from "@/components/ui/Skeleton";
import s from "./home.module.css";

// esqueleto da lista de campanhas enquanto o servidor lê o banco (navegação vinda de outra tela)
export default function Loading() {
  return (
    <main className="container" aria-busy="true">
      <header className={s.head}>
        <div style={{ width: "min(320px, 70%)" }}>
          <Skeleton h={36} w="80%" />
          <Skeleton lines={1} />
        </div>
      </header>
      <div className={s.grid}>
        {[0, 1, 2].map((i) => (
          <div key={i} className={`card ${i === 0 ? s.featured : ""}`} style={{ minHeight: i === 0 ? 300 : 236 }}>
            <Skeleton w={140} h={12} />
            <Skeleton w="55%" h={30} style={{ margin: "16px 0 10px" }} />
            <Skeleton w="35%" h={12} />
            <Skeleton w="70%" h={14} style={{ marginTop: 24 }} />
          </div>
        ))}
      </div>
    </main>
  );
}
