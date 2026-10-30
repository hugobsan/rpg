import Skeleton from "@/components/ui/Skeleton";
import s from "./settings.module.css";

export default function Loading() {
  return (
    <main className={`container ${s.wrap}`} aria-busy="true">
      <h1>Configurações</h1>
      <Skeleton w="55%" h={14} style={{ marginBottom: 32 }} />
      {[0, 1, 2].map((i) => (
        <div key={i} className={s.section}>
          <div><Skeleton w="50%" h={22} /><Skeleton lines={2} /></div>
          <div><Skeleton h={14} w={120} /><Skeleton h={40} style={{ marginTop: 8 }} /><Skeleton h={30} w={140} style={{ marginTop: 14 }} /></div>
        </div>
      ))}
    </main>
  );
}
