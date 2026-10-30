"use client";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import Icon, { type IconName } from "./Icon";
import s from "./SidePanel.module.css";

export interface PanelTab<K extends string = string> {
  key: K;
  label: string;
  icon: IconName;
  badge?: number; // não lidas
  mobile?: boolean; // atalho direto na barra do celular
  end?: boolean; // vai para o pé do trilho (configurações da mesa)
}

const SIDE_KEY = "chronicle.sideWidth";
const SIDE_DEFAULT = 360;
const RAIL = 68;
// entre 280px e o que deixa pelo menos 420px para o chat (máx. 760px)
const clampSide = (w: number) =>
  Math.round(Math.min(Math.max(w, 280), Math.min(760, (typeof window !== "undefined" ? window.innerWidth : 1400) - 420 - RAIL)));

function Badge({ n }: { n?: number }) {
  return n ? <span className={s.badge} aria-label={`${n} não lida${n > 1 ? "s" : ""}`}>{n > 9 ? "9+" : n}</span> : null;
}

/**
 * Lateral do jogo. Desktop: painel redimensionável + trilho de ícones na borda (clicar na aba aberta
 * recolhe o painel). Celular (< 900 px): barra de ações fixa embaixo e as mesmas abas numa folha que sobe.
 */
export default function SidePanel<K extends string>({ tabs, active, onSelect, collapsed, onCollapse, mobile, drawer, onDrawer, children }: {
  tabs: PanelTab<K>[];
  active: K;
  onSelect: (k: K) => void;
  collapsed: boolean;
  onCollapse: (v: boolean) => void;
  mobile: boolean;
  drawer: boolean;
  onDrawer: (v: boolean) => void;
  children: ReactNode;
}) {
  const [w, setW] = useState(SIDE_DEFAULT);
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(SIDE_KEY));
      if (saved) setW(clampSide(saved));
    } catch {}
  }, []);
  const save = (v: number) => {
    try { localStorage.setItem(SIDE_KEY, String(v)); } catch {}
  };
  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let cur = w;
    const move = (ev: PointerEvent) => setW((cur = clampSide(window.innerWidth - RAIL - ev.clientX)));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      save(cur);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  // Esc fecha a folha do celular
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector("[aria-modal='true']") && onDrawer(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer, onDrawer]);

  // a aba escolhida fica à vista na fileira de abas da folha
  const sheetTabs = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (drawer) sheetTabs.current?.querySelector("[aria-selected='true']")?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [drawer, active]);

  const current = tabs.find((t) => t.key === active) ?? tabs[0];
  const tabButton = (t: PanelTab<K>, cls: string, onClick: () => void) => (
    <button key={t.key} role="tab" aria-selected={t.key === active} className={cls} onClick={onClick}
      title={t.label} aria-label={t.badge ? `${t.label}, ${t.badge} não lidas` : t.label}>
      <span className={s.icon}><Icon name={t.icon} size={20} /><Badge n={t.badge} /></span>
      <span className={s.label}>{t.label}</span>
    </button>
  );

  if (mobile) {
    const quick = tabs.filter((t) => t.mobile);
    const others = tabs.filter((t) => !t.mobile).reduce((n, t) => n + (t.badge ?? 0), 0);
    return (
      <>
        <nav className={s.mbar} aria-label="Painéis do jogo">
          {quick.map((t) => tabButton(t, `${s.mtab} ${drawer && t.key === active ? s.on : ""}`, () => { onSelect(t.key); onDrawer(true); }))}
          <button className={`${s.mtab} ${drawer && !current.mobile ? s.on : ""}`} onClick={() => onDrawer(true)} aria-label="Mais painéis">
            <span className={s.icon}><Icon name="more" size={20} /><Badge n={others} /></span>
            <span className={s.label}>Mais</span>
          </button>
        </nav>
        {drawer && <div className="scrim" onClick={() => onDrawer(false)} />}
        <aside className={`drawer bottom game-side ${s.sheet} ${drawer ? "open" : ""}`} inert={!drawer} aria-label={current.label}>
          <div className={s.grip} aria-hidden="true" />
          <div className={s.sheetHead}>
            <div className={s.sheetTabs} role="tablist" ref={sheetTabs}>
              {tabs.map((t) => tabButton(t, s.stab, () => onSelect(t.key)))}
            </div>
            <button className={s.close} onClick={() => onDrawer(false)} aria-label="Fechar painel"><Icon name="close" size={18} /></button>
          </div>
          <div className={`side-body ${s.body}`}>{children}</div>
        </aside>
      </>
    );
  }

  return (
    <aside className={`game-side ${s.side}`} aria-label="Painéis do jogo">
      {!collapsed && (
        <section className={s.panel} style={{ "--side-w": `${w}px` } as CSSProperties} aria-label={current.label}>
          <div className={`side-resizer ${s.resizer}`} onPointerDown={startResize}
            onDoubleClick={() => { setW(SIDE_DEFAULT); save(SIDE_DEFAULT); }}
            title="Arraste para ajustar a largura · duplo clique volta ao padrão" />
          <header className={s.head}>
            <h2 className={s.title}>{current.label}</h2>
            <button className={s.close} onClick={() => onCollapse(true)} aria-label="Recolher painel" title="Recolher painel">
              <Icon name="chevron" size={18} />
            </button>
          </header>
          <div className={`side-body ${s.body}`}>{children}</div>
        </section>
      )}
      <nav className={s.rail} role="tablist" aria-orientation="vertical" aria-label="Abas">
        {tabs.map((t) =>
          tabButton(t, `${s.rtab} ${t.end ? s.end : ""} ${!collapsed && t.key === active ? s.on : ""}`, () => {
            if (t.key === active && !collapsed) onCollapse(true);
            else {
              onSelect(t.key);
              onCollapse(false);
            }
          })
        )}
      </nav>
    </aside>
  );
}
