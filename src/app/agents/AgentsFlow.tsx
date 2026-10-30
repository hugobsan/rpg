"use client";
import "@xyflow/react/dist/style.css";
import { useCallback, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";

// Mesma paleta de globals.css (hex porque as setas SVG e o minimapa não leem var()).
const COLOR = {
  player: "#9a95a8",
  code: "#6b6880",
  gm: "#d4a24e",
  npc: "#a78bfa",
  chron: "#fbbf24",
  writer: "#3fb8af",
  img: "#66bb6a",
  jev: "#60a5fa",
  db: "#4de08a",
  infra: "#9a95a8",
} as const;
type Who = keyof typeof COLOR;

const KIND_LABEL: Record<Who, string> = {
  player: "Jogador",
  code: "Código (sem IA)",
  gm: "Mestre",
  npc: "NPC",
  chron: "Cronista",
  writer: "Roteirista",
  img: "Ilustrador",
  jev: "Jev",
  db: "Banco de dados",
  infra: "Infraestrutura",
};

interface Tip {
  oque: string;
  quando?: string;
  freq?: string;
  custo?: string;
  fallback?: string;
}
interface FlowData extends Record<string, unknown> {
  who: Who;
  title: string;
  sub: string;
  tip: Tip;
}
type FlowNode = Node<FlowData, "flow">;
type LaneNode = Node<{ label: string }, "lane">;

const TIP_LABELS: [keyof Tip, string][] = [
  ["oque", "O que faz"],
  ["quando", "Quando é chamado"],
  ["freq", "Frequência"],
  ["custo", "Custo"],
  ["fallback", "Se falhar"],
];

// ---------- nós ----------
// Colunas: passo de 215px. Lanes: 3 (sob demanda, turno, NPC), de cima para baixo.
const X = [20, 290, 560, 830, 1100, 1370];

const n = (id: string, x: number, y: number, who: Who, title: string, sub: string, tip: Tip): FlowNode => ({
  id,
  type: "flow",
  position: { x, y },
  // tamanho fixo: o minimapa só desenha nós com width/height explícitos
  width: 165,
  height: 96,
  data: { who, title, sub, tip },
});

const lane = (id: string, y: number, h: number, w: number, label: string): LaneNode => ({
  id,
  type: "lane",
  position: { x: 0, y },
  data: { label },
  style: { width: w, height: h, pointerEvents: "none" },
  selectable: false,
  draggable: false,
  focusable: false,
  zIndex: -1,
});

const NODES: (FlowNode | LaneNode)[] = [
  lane("L3", -310, 270, 760, "3. Sob demanda: Roteirista e Ilustrador"),
  lane("L1", 0, 335, 1570, "1. Turno do jogador"),
  lane("L2", 370, 290, 1570, "2. Conversa particular com um NPC"),

  // --- sob demanda ---
  n("s_btn1", X[0], -250, "player", "Criar ou replanejar campanha", "gera o roteiro", {
    oque: "O roteiro é gerado ao criar a campanha (se a opção estiver marcada) ou quando você pede para replanejar.",
  }),
  n("s_writer", X[1], -250, "writer", "Roteirista", "premissa, arcos, ganchos", {
    oque: "Planeja a campanha: premissa, de 4 a 8 arcos, eventos canônicos e ganchos ligados ao passado do personagem, em JSON. Se o cenário é baseado em obra, ancora os arcos na linha do tempo canônica, com busca web.",
    quando: "Ao criar a campanha (se marcado) e ao pedir replanejamento.",
    freq: "Raro: 1 chamada por geração.",
    custo: "Médio e pontual: saída de até 4 mil tokens, mais a busca web.",
    fallback: "Sem JSON válido, nada é salvo e a tela mostra erro (502); o roteiro anterior continua.",
  }),
  n("s_script", X[2], -250, "code", "Roteiro da campanha", "campaigns.script", {
    oque: "Fica salvo na campanha. O arco ativo entra no contexto do Mestre a cada turno; o Mestre consulta (get_script) e atualiza (update_script) o roteiro por ferramenta.",
  }),
  n("s_btn2", X[0], -130, "player", "Botão “Ver ambiente”", "na tela da campanha", {
    oque: "A imagem só é gerada quando o jogador clica.",
  }),
  n("s_img", X[1], -130, "img", "Ilustrador", "imagem do ambiente", {
    oque: "Gera uma imagem a partir do local, do modo da cena e das duas últimas narrações do Mestre. Não passa pelo Mestre e não entra no contexto de nenhum agente.",
    quando: "Só quando o jogador clica em “Ver ambiente”.",
    freq: "Sob demanda.",
    custo: "Cobrado por imagem gerada: bem mais que uma chamada de texto curta. A entrada é pequena.",
    fallback: "Se o modelo não devolver imagem, a tela mostra o erro e nada é salvo.",
  }),
  n("s_out", X[2], -130, "code", "Imagem salva na cena", "scene_images", {
    oque: "A imagem fica guardada no Postgres, ligada à cena, e a última aparece na ficha da tela da campanha.",
  }),

  // --- turno ---
  n("t_player", X[0], 60, "player", "Ação do jogador", "texto ou opção clicada", {
    oque: "O jogador digita uma ação ou clica numa opção. A mensagem é salva no histórico da cena antes de qualquer IA rodar.",
    quando: "A cada turno.",
  }),
  n("t_mem", X[1], 60, "code", "Memórias candidatas", "6 parecidas + 8 importantes", {
    oque: "Sem IA: busca no Postgres as 6 memórias mais parecidas com a ação (vetorial no pgvector, ou por texto se não houver embeddings) e junta as 8 de maior importância e mais recentes, sem repetir. Também lê o histórico recente (janela de ≈9 mil tokens).",
    quando: "Logo depois que a ação é salva.",
    custo: "Um embedding da ação (barato) e consultas SQL.",
  }),
  n("t_jev", X[2], 60, "jev", "Jev: decide o turno", "modelo, web e memórias", {
    oque: "Uma única chamada devolve probabilidades, não texto: (1) turno complexo? Escolhe entre o modelo do Mestre e o caro de turnos complexos (se configurado). (2) Precisa de busca web (:online)? Só quando o turno depende de um fato do cânone que não está no contexto. (3) Cada memória candidata é relevante? As de importância 5 entram sem perguntar. Os limiares ficam em src/lib/decisions.ts.",
    quando: "No início de cada turno, depois das candidatas. Se não houver nada a perguntar (sem modelo caro, sem web, sem memórias), nem é chamado.",
    freq: "No máximo 1 request por turno.",
    custo: "Mínimo: cerca de US$ 0,00005 e ≈0,4 s por chamada; saída só em probabilidades.",
    fallback: "Timeout de 7 s. Qualquer falha: modelo padrão do Mestre, web conforme a configuração dele e todas as memórias entram.",
  }),
  n("t_ctx", X[3], 60, "code", "Montagem do contexto", "ficha, cena, NPCs, roteiro", {
    oque: "Sem IA: monta o prompt do Mestre com regras, estilo da campanha, mecânica, cena atual (com o resumo compactado), ficha do jogador, NPCs ativos, só as memórias aprovadas pelo Jev e o arco ativo do roteiro. Soma o histórico recente.",
    quando: "Antes de cada turno do Mestre.",
  }),
  n("t_gm", X[4], 60, "gm", "Mestre", "narra e arbitra", {
    oque: "Narra o mundo, arbitra as regras e altera o jogo por ferramentas. Usa o modelo escolhido pelo Jev, mantido em todas as rodadas do turno.",
    quando: "Em cada turno do jogador, em loop com as ferramentas.",
    freq: "1 a 9 chamadas por turno (normalmente 2 a 4). Termina quando responde só com texto.",
    custo: "O mais caro: cada rodada reenvia prompt, ficha, memórias, histórico (até ≈9 mil tokens) e as definições das ferramentas. A busca web (:online) vale só na 1ª rodada e é cobrada por busca.",
  }),
  n("t_tools", X[5], 60, "code", "Ferramentas", "dados, ficha, cena, memórias", {
    oque: "Executadas pelo código a pedido do Mestre: rolar dados, mudar recursos, atributos, habilidades, itens e XP, criar NPC, trocar a cena, gravar e buscar memórias, consultar livros e roteiro. As escritas vão direto ao Postgres.",
    quando: "Sempre que o Mestre pedir, em qualquer rodada.",
    custo: "Sem IA: só SQL (e embeddings ao gravar ou buscar memórias).",
  }),
  n("t_fx", X[4], 230, "code", "Efeitos persistidos", "narração e opções salvas", {
    oque: "Fichas, cena, NPCs, memórias e roteiro já foram gravados pelas ferramentas durante o loop. No fim, a narração e o bloco de opções são salvos e enviados ao jogador.",
    quando: "Quando o Mestre responde só com texto (ou estoura as rodadas).",
  }),
  n("t_chron", X[3], 230, "chron", "Cronista: compacta", "só se estourar o limite", {
    oque: "Resume as mensagens antigas ainda não compactadas (todas menos as 12 mais recentes) num resumo acumulado na cena, marca-as como compactadas e extrai memórias estruturadas: evento, NPC, descoberta, marco, relação.",
    quando: "Depois da narração, se as mensagens não compactadas passam de ≈11 mil tokens.",
    freq: "De vez em quando (estimativa: 1 a cada 10 a 15 turnos). Também roda 1 vez por conversa com NPC.",
    custo: "Baixo: modelo barato, mas lê de uma vez todo o trecho antigo (≈11 mil tokens de entrada).",
  }),
  n("t_imp", X[2], 230, "jev", "Jev: nota de importância", "1 a 5, em lote", {
    oque: "Dá a nota de 1 a 5 de todas as memórias extraídas numa única chamada. Nota 5 entra sempre no contexto; as demais disputam as vagas por importância.",
    quando: "Logo depois que o Cronista extrai memórias (compactação ou fim de conversa com NPC).",
    freq: "1 request por lote de memórias.",
    custo: "Mínimo: cerca de US$ 0,00005 e ≈0,4 s por chamada; saída só em probabilidades.",
    fallback: "Se falhar, vale a nota que o Cronista escreveu.",
  }),
  n("pg", X[5], 230, "db", "Postgres + pgvector", "memórias, fichas, mensagens", {
    oque: "Guarda tudo: campanhas, cenas, fichas, mensagens, memórias (com embeddings para busca por similaridade), roteiro, conversas de NPC, imagens e o log de cada chamada de IA (tokens, custo, duração).",
    custo: "Local (Docker). Nenhuma chamada paga; só os embeddings das memórias passam pelo OpenRouter.",
  }),
  n("or", X[5], -250, "infra", "OpenRouter", "toda IA passa por aqui", {
    oque: "Todas as chamadas de IA (Jev, Mestre, NPC, Cronista, Roteirista e Ilustrador) saem por este gateway e viram uma linha no histórico do agente: tokens, duração, custo, request e resposta. O Jev usa a Decisions API (probabilidades); os demais, chat completions.",
    custo: "Você paga o preço do modelo escolhido em cada agente, direto ao OpenRouter.",
  }),

  // --- NPC ---
  n("n_player", X[0], 430, "player", "Jogador fala com o NPC", "conversa particular", {
    oque: "Conversa fora da narração do Mestre. O histórico fica guardado por sessão de conversa.",
    quando: "A cada mensagem do jogador ao NPC.",
  }),
  n("n_jev", X[1], 430, "jev", "Jev: o NPC topa?", "só no início da conversa", {
    oque: "Decide se o NPC toparia conversar agora, olhando persona, objetivos, relação com o jogador, cena e se o NPC está presente.",
    quando: "Antes da 1ª chamada do NPC da sessão (histórico vazio). Uma troca recusada não é gravada: se o jogador insistir, a checagem roda de novo. No meio de uma conversa aceita não há checagem: o NPC pode cortar sozinho, em personagem.",
    freq: "1 request no início de cada conversa.",
    custo: "Mínimo: cerca de US$ 0,00005 e ≈0,4 s por chamada; saída só em probabilidades.",
    fallback: "Se falhar, o NPC conversa normalmente.",
  }),
  n("n_npc", X[2], 430, "npc", "NPC responde", "persona + memórias da relação", {
    oque: "Interpreta o NPC em primeira pessoa com persona, ficha, cena atual, as 8 memórias mais ligadas ao NPC e as últimas 30 mensagens da conversa. A troca é gravada.",
    quando: "A cada mensagem do jogador, depois do aval do Jev.",
    freq: "1 chamada por mensagem.",
    custo: "Baixo: contexto pequeno e resposta curta (máx. 700 tokens).",
  }),
  n("n_no", X[2], 560, "npc", "NPC recusa em personagem", "troca não gravada", {
    oque: "É a mesma chamada do NPC, com uma instrução extra no prompt: recusar em personagem, numa fala curta. Substitui o antigo prefixo [RECUSA]. A tela recebe refused=true e a troca não é gravada.",
    quando: "Quando o Jev diz que o NPC não toparia conversar agora.",
    custo: "O mesmo de uma resposta normal do NPC.",
  }),
  n("n_end", X[3], 430, "player", "Encerrar a conversa", "botão de encerrar", {
    oque: "Ao encerrar, a conversa vira memória da campanha: o Mestre passa a saber o essencial, e o NPC continua lembrando de tudo.",
  }),
  n("n_chron", X[4], 430, "chron", "Cronista: extrai memórias", "1 vez por conversa", {
    oque: "Lê a conversa inteira e guarda só o que o Mestre precisa saber (revelações, acordos, mudanças de relação) como memórias de tipo npc ou relationship. Só roda se houve ao menos uma troca.",
    quando: "Ao encerrar a conversa com o NPC.",
    freq: "1 chamada por conversa.",
    custo: "Baixo: modelo barato; a entrada é a conversa toda.",
  }),
  n("n_imp", X[5], 430, "jev", "Jev: nota de importância", "1 a 5, em lote", {
    oque: "Dá a nota de 1 a 5 das memórias extraídas da conversa, numa única chamada.",
    quando: "Logo depois que o Cronista extrai as memórias.",
    freq: "1 request por conversa.",
    custo: "Mínimo: cerca de US$ 0,00005 e ≈0,4 s por chamada; saída só em probabilidades.",
    fallback: "Se falhar, vale a nota que o Cronista escreveu.",
  }),
];

// ---------- setas ----------
const colorOf = (id: string) => {
  const nd = NODES.find((x) => x.id === id) as FlowNode | undefined;
  return nd ? COLOR[nd.data.who] : COLOR.code;
};

function e(
  s: string,
  sh: string,
  t: string,
  th: string,
  label?: string,
  opts: { both?: boolean; dashed?: boolean } = {}
): Edge {
  const color = colorOf(s);
  return {
    id: `${s}-${t}`,
    source: s,
    sourceHandle: sh,
    target: t,
    targetHandle: th,
    type: "smoothstep",
    label,
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 18, height: 18 },
    markerStart: opts.both ? { type: MarkerType.ArrowClosed, color, width: 18, height: 18 } : undefined,
    style: { stroke: color, strokeWidth: 1.6, strokeDasharray: opts.dashed ? "5 4" : undefined },
    labelStyle: { fill: "var(--text)", fontSize: 11 },
    labelBgStyle: { fill: "var(--bg-panel)", stroke: "var(--border)" },
    labelBgPadding: [6, 3],
    labelBgBorderRadius: 6,
  };
}

const EDGES: Edge[] = [
  // turno
  e("t_player", "sr", "t_mem", "tl"),
  e("t_mem", "sr", "t_jev", "tl", "candidatas"),
  e("t_jev", "sr", "t_ctx", "tl", "aprovadas"),
  e("t_ctx", "sr", "t_gm", "tl"),
  e("t_gm", "sr", "t_tools", "tl", "ferramentas ⇄", { both: true }),
  e("t_gm", "sb", "t_fx", "tt", "só texto"),
  e("t_fx", "sl", "t_chron", "tr", "estourou o limite"),
  e("t_chron", "sl", "t_imp", "tr", "memórias"),
  e("t_imp", "sb", "pg", "tb", "grava memórias"),
  e("t_tools", "sb", "pg", "tt", "grava ficha, cena, memórias"),
  e("t_fx", "sr", "pg", "tl", "grava narração"),
  e("t_gm", "st", "or", "tb", "toda IA", { dashed: true }),
  // NPC
  e("n_player", "sr", "n_jev", "tl"),
  e("n_jev", "sr", "n_npc", "tl", "topa"),
  e("n_jev", "sb", "n_no", "tl", "não topa"),
  e("n_npc", "sr", "n_end", "tl", "até encerrar"),
  e("n_end", "sr", "n_chron", "tl"),
  e("n_chron", "sr", "n_imp", "tl", "memórias"),
  e("n_imp", "st", "pg", "tb", "grava memórias"),
  // sob demanda
  e("s_btn1", "sr", "s_writer", "tl"),
  e("s_writer", "sr", "s_script", "tl", "JSON"),
  e("s_script", "sr", "t_ctx", "tt", "arco ativo em todo turno"),
  e("s_btn2", "sr", "s_img", "tl"),
  e("s_img", "sr", "s_out", "tl", "imagem"),
];

// ---------- componentes dos nós ----------
const hidden: CSSProperties = { opacity: 0, pointerEvents: "none" };
const SIDES: [string, Position][] = [
  ["t", Position.Top],
  ["b", Position.Bottom],
  ["l", Position.Left],
  ["r", Position.Right],
];

function FlowNodeView({ data }: NodeProps<FlowNode>) {
  const c = COLOR[data.who];
  const infra = data.who === "db" || data.who === "infra";
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        background: "var(--bg-panel)",
        border: `1px ${infra ? "dashed" : "solid"} ${infra ? c : "var(--border)"}`,
        borderLeft: `4px solid ${c}`,
        borderRadius: 10,
        padding: "8px 10px",
        cursor: "help",
      }}
    >
      {SIDES.map(([k, pos]) => (
        <span key={k}>
          <Handle id={`s${k}`} type="source" position={pos} style={hidden} />
          <Handle id={`t${k}`} type="target" position={pos} style={hidden} />
        </span>
      ))}
      <div style={{ fontSize: 10.5, color: c, textTransform: "uppercase", letterSpacing: 0.4 }}>
        {KIND_LABEL[data.who]}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", margin: "1px 0 2px" }}>{data.title}</div>
      <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.3 }}>{data.sub}</div>
    </div>
  );
}

function LaneView({ data }: NodeProps<LaneNode>) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        border: "1px dashed var(--border)",
        borderRadius: 14,
        background: "color-mix(in srgb, var(--text) 2%, transparent)",
        padding: "8px 14px",
        fontFamily: "var(--serif)",
        fontSize: 15,
        color: "var(--text-dim)",
      }}
    >
      {data.label}
    </div>
  );
}

const nodeTypes = { flow: FlowNodeView, lane: LaneView };

const THEME_CSS = `
.agents-flow .react-flow {
  --xy-background-color: var(--bg);
  --xy-controls-button-background-color: var(--bg-panel);
  --xy-controls-button-background-color-hover: var(--accent-soft);
  --xy-controls-button-color: var(--text);
  --xy-controls-button-border-color: var(--border);
  --xy-minimap-background-color: var(--bg-panel);
  --xy-minimap-mask-background-color: color-mix(in srgb, var(--bg) 70%, transparent);
  --xy-attribution-background-color: transparent;
  --xy-edge-label-background-color: var(--bg-panel);
  --xy-edge-label-color: var(--text);
}
.agents-flow { height: 680px; }
@media (max-width: 600px) { .agents-flow { height: 520px; } }
.agents-flow .react-flow__attribution a { color: var(--text-dim); }
.agents-flow .react-flow__controls { box-shadow: none; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.agents-flow .react-flow__minimap { border: 1px solid var(--border); border-radius: 8px; }
@media (max-width: 600px) { .agents-flow .react-flow__minimap { display: none; } }
`;

interface Hover {
  id: string;
  left: number;
  top?: number;
  bottom?: number;
}

/** Canvas do React Flow; carregado só quando o cartão do diagrama abre (next/dynamic em AgentsDiagram). */
export default function AgentsFlow() {
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  const show = useCallback((ev: MouseEvent, node: Node) => {
    if (node.type !== "flow" || !wrap.current) return;
    const box = wrap.current.getBoundingClientRect();
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const tw = Math.min(380, box.width - 16);
    const left = Math.max(8, Math.min(r.left - box.left, box.width - tw - 8));
    const lower = r.top - box.top > box.height / 2;
    // tela estreita: o balão ocupa a largura toda, no lado oposto ao do bloco
    const narrow = box.width < 600;
    setHover({
      id: node.id,
      left,
      ...(narrow
        ? lower ? { top: 8 } : { bottom: 8 }
        : lower ? { bottom: box.bottom - r.top + 8 } : { top: r.bottom - box.top + 8 }),
    });
  }, []);

  const tip = hover ? (NODES.find((x) => x.id === hover.id) as FlowNode) : null;

  return (
    <div
      ref={wrap}
      className="agents-flow"
      style={{
        position: "relative",
        marginTop: 12,
        border: "1px solid var(--border)",
        borderRadius: "var(--r-md)",
        overflow: "hidden",
      }}
    >
      <style>{THEME_CSS}</style>
      <ReactFlow
        nodes={NODES}
        edges={EDGES}
        nodeTypes={nodeTypes}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.06 }}
        minZoom={0.15}
        maxZoom={2.5}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onNodeMouseEnter={show}
        onNodeClick={show}
        onNodeMouseLeave={() => setHover(null)}
        onPaneClick={() => setHover(null)}
        onMoveStart={() => setHover(null)}
      >
        <Background color="var(--border-strong)" gap={22} />
        <Controls showInteractive={false} fitViewOptions={{ padding: 0.06 }} />
        <MiniMap
          pannable
          zoomable
          style={{ width: 150, height: 100 }}
          nodeColor={(nd) => (nd.type === "flow" ? COLOR[(nd.data as FlowData).who] : "transparent")}
        />
      </ReactFlow>
      {tip && hover && (
        <div
          role="tooltip"
          style={{
            position: "absolute",
            left: hover.left,
            top: hover.top,
            bottom: hover.bottom,
            width: Math.min(380, (wrap.current?.clientWidth ?? 400) - 16),
            background: "var(--bg-raise)",
            border: "1px solid var(--border)",
            borderTop: `3px solid ${COLOR[tip.data.who]}`,
            borderRadius: 10,
            padding: "10px 12px",
            boxShadow: "var(--shadow-2)",
            pointerEvents: "none",
            zIndex: 10,
            maxHeight: "calc(100% - 16px)",
            overflow: "hidden",
            fontSize: 12.5,
            lineHeight: 1.45,
            color: "var(--text)",
          }}
        >
          <div style={{ fontFamily: "var(--serif)", fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
            {tip.data.title}
          </div>
          {TIP_LABELS.filter(([k]) => tip.data.tip[k]).map(([k, label]) => (
            <div key={k} style={{ marginBottom: 5 }}>
              <span style={{ color: COLOR[tip.data.who], fontWeight: 600 }}>{label}: </span>
              <span style={{ color: "var(--text-dim)" }}>{tip.data.tip[k]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
