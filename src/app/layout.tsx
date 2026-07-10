import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Chronicle RPG",
  description: "RPG de mesa por IA com múltiplos agentes e memória persistente",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <nav className="topnav">
          <Link href="/" className="brand">⚔ Chronicle</Link>
          <Link href="/" className="nav">Campanhas</Link>
          <Link href="/agents" className="nav">Agentes</Link>
          <Link href="/settings" className="nav">Configurações</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
