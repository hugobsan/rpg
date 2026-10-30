import type { Metadata } from "next";
import Link from "next/link";
import { Chakra_Petch, Cinzel, Cormorant_Garamond, Geist, IM_Fell_English, Literata, Michroma, Shippori_Mincho_B1 } from "next/font/google";
import "./globals.css";

// fontes self-hosted no build; cada uma vira uma variável CSS (--ff-*) usada pelos temas em globals.css.
// As de display dos temas não são pré-carregadas: o navegador só baixa a do tema em uso.
const geist = Geist({ subsets: ["latin"], variable: "--ff-geist", display: "swap" });
const literata = Literata({ subsets: ["latin"], style: ["normal", "italic"], variable: "--ff-literata", display: "swap" });
const cormorant = Cormorant_Garamond({ subsets: ["latin"], weight: ["600", "700"], variable: "--ff-cormorant", display: "swap" });
const cinzel = Cinzel({ subsets: ["latin"], weight: ["600"], variable: "--ff-cinzel", display: "swap", preload: false });
const shippori = Shippori_Mincho_B1({ subsets: ["latin"], weight: ["800"], variable: "--ff-shippori", display: "swap", preload: false });
const chakra = Chakra_Petch({ subsets: ["latin"], weight: ["600"], variable: "--ff-chakra", display: "swap", preload: false });
const michroma = Michroma({ subsets: ["latin"], weight: ["400"], variable: "--ff-michroma", display: "swap", preload: false });
const fell = IM_Fell_English({ subsets: ["latin"], weight: ["400"], variable: "--ff-fell", display: "swap", preload: false });
const fontVars = [geist, literata, cormorant, cinzel, shippori, chakra, michroma, fell].map((f) => f.variable).join(" ");

export const metadata: Metadata = {
  title: "Chronicle RPG",
  description: "RPG de mesa por IA com múltiplos agentes e memória persistente",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={fontVars}>
      <body>
        <nav className="topnav">
          <Link href="/" className="brand">⚔ Chronicle</Link>
          <Link href="/" className="nav">Campanhas</Link>
          <Link href="/agents" className="nav">Agentes</Link>
          <Link href="/usage" className="nav">Custos e uso</Link>
          <Link href="/settings" className="nav">Configurações</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
