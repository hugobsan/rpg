"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS: [href: string, label: string][] = [
  ["/", "Campanhas"],
  ["/agents", "Agentes"],
  ["/usage", "Custos e uso"],
  ["/settings", "Configurações"],
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
      {LINKS.map(([href, label]) => (
        <Link key={href} href={href} className="nav" aria-current={isActive(path, href) ? "page" : undefined}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
