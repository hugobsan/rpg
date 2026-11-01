import type { ReactNode } from "react";

// Ícones de linha da tela de jogo (traço 1.7, cor do texto). Sem emoji na UI nova (DESIGN.md).
const PATHS = {
  sheet: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c1.2-3.6 4-5.5 7-5.5s5.8 1.9 7 5.5" /></>,
  spark: <><path d="M12 3c.6 3.2 2.2 4.9 5 6-2.8 1.1-4.4 2.8-5 6-.6-3.2-2.2-4.9-5-6 2.8-1.1 4.4-2.8 5-6z" /><path d="M18.5 15.5c.2 1.2.8 1.8 2 2-1.2.2-1.8.8-2 2-.2-1.2-.8-1.8-2-2 1.2-.2 1.8-.8 2-2z" /></>,
  bag: <><path d="M6 8h12l-1 12H7L6 8z" /><path d="M9 8V6.5a3 3 0 0 1 6 0V8" /></>,
  flag: <><path d="M5 21V4" /><path d="M5 4h12l-2.5 4L17 12H5" /></>,
  people: <><circle cx="9" cy="8" r="3" /><path d="M3.5 19c.9-3 3-4.5 5.5-4.5s4.6 1.5 5.5 4.5" /><path d="M15.5 5.2a3 3 0 0 1 0 5.6" /><path d="M17 14.6c1.8.5 3 1.9 3.6 4.4" /></>,
  map: <><path d="M3 6.5l6-2.5 6 2.5 6-2.5v13.5l-6 2.5-6-2.5-6 2.5z" /><path d="M9 4v13.5M15 6.5V20" /></>,
  bookmark: <path d="M7 3.5h10v17l-5-4-5 4z" />,
  book: <><path d="M12 6.5c-2-1.5-5-2-8-1.5v13.5c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V5c-3-.5-6 0-8 1.5z" /><path d="M12 6.5V20" /></>,
  library: <><path d="M4 4.5h3.5v15H4zM9.5 4.5H13v15H9.5z" /><path d="M14.8 6l3.3-.9 3.4 13.5-3.3.9z" /><path d="M4 8h3.5M9.5 16H13" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
  scroll: <><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v4h4" /><path d="M10 12h5M10 16h5" /></>,
  image: <><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M21 16l-5-5-8 8" /></>,
  landscape: <><path d="M3 19l6-8 4 5 3-3 5 6z" /><circle cx="16.5" cy="7.5" r="2" /></>,
  sliders: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
  chat: <path d="M4 5h16v11H10l-5 4v-4H4z" />,
  send: <path d="M12 19V5M6 11l6-6 6 6" />,
  speaker: <><path d="M4 9.5v5h3.5l5 4v-13l-5 4z" /><path d="M16 9a4.5 4.5 0 0 1 0 6" /><path d="M18.5 6.5a8 8 0 0 1 0 11" /></>,
  regen: <><path d="M4 4.5v5h5" /><path d="M5.6 14.5a7 7 0 1 0 1.7-7.3L4 9.5" /></>,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  pin: <><path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z" /><circle cx="12" cy="10" r="2.2" /></>,
  d20: <><path d="M12 2.5l8.5 5v9L12 21.5l-8.5-5v-9z" /><path d="M12 2.5L7 12h10zM7 12l5 9.5 5-9.5M3.5 7.5L7 12l-3.5 4.5M20.5 7.5L17 12l3.5 4.5" /></>,
  bolt: <path d="M13 3L5 13.5h6L10 21l8-10.5h-6z" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  folder: <><path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2h8A1.5 1.5 0 0 1 20.5 9v9a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z" /><path d="M3.5 10.5h17" /></>,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3.2" />,
  edit: <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>,
  heart: <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />,
  star: <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  mail: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3.5 7.5l8.5 6 8.5-6" /></>,
  dot: <circle cx="12" cy="12" r="2.5" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export default function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className} style={{ flexShrink: 0 }}>
      {PATHS[name]}
    </svg>
  );
}
