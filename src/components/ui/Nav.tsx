"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

// rótulo curto: usado abaixo de 520 px para a barra caber no celular
const LINKS: [href: string, label: string, short?: string][] = [
  ["/", "Campanhas"],
  ["/agents", "Agentes"],
  ["/usage", "Custos e uso", "Custos"],
  ["/settings", "Configurações", "Ajustes"],
];

// campanha aberta e criação contam como "Campanhas"
const isActive = (path: string, href: string) =>
  href === "/" ? path === "/" || path.startsWith("/campaign") : path.startsWith(href);

export default function Nav() {
  const path = usePathname() ?? "/";
  return (
    <nav className="topnav" aria-label="Principal">
      <Link href="/" className="brand" aria-label="Chronicle, início">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">Chronicle</span>
      </Link>
      {LINKS.map(([href, label, short]) => (
        <Link key={href} href={href} className="nav" aria-label={short && label} aria-current={isActive(path, href) ? "page" : undefined}>
          {short ? <><span className="nav-full">{label}</span><span className="nav-short">{short}</span></> : label}
        </Link>
      ))}
    </nav>
  );
}
