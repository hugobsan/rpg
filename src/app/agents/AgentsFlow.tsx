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
  char: "#fb7185",
  abil: "#ec5a55",
  items: "#f59e6b",
  pixel: "#a3e635",
  carto: "#38bdf8",
  adv: "#e879f9",
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
  char: "Criador de personagens",
  abil: "Criador de habilidades",
  items: "Criador de itens",
  pixel: "Pixel artista",
  carto: "Cartógrafo",
  adv: "Criador de aventuras",
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
// Colunas: passo de 270px. Lanes: sob demanda, turno, NPC e criação em segundo plano, de cima para baixo.
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
  lane("L3", -310, 270, 1300, "3. Sob demanda: Roteirista, Ilustrador e Criador de aventuras"),
  lane("L1", 0, 335, 1570, "1. Turno do jogador"),
  lane("L2", 370, 290, 1570, "2. Conversa particular com um NPC"),
  lane("L4", 700, 440, 1570, "4. Criação em segundo plano: personagens, retratos, biblioteca e mapas"),

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

  n("a_btn", X[3], -250, "player", "Criar com IA", "nova campanha, passo Mundo", {
    oque: "No assistente de campanha nova, o jogador escolhe criar a aventura (a mecânica do RPG) conversando, em vez de usar um preset ou importar um JSON.",
  }),
  n("a_adv", X[4], -250, "adv", "Criador de aventuras", "entrevista em linguagem natural", {
    oque: "Faz 1 ou 2 perguntas por vez sobre o universo, o tom e como o poder funciona, deduz pela obra o óbvio e vai preenchendo o JSON da mecânica (atributos, barras, tipos e níveis de habilidade, cargos, progressão, tema visual) com o Naruto como exemplo. O jogador nunca vê o JSON.",
    quando: "A cada resposta do jogador na entrevista.",
    freq: "De 3 a 10 chamadas por aventura.",
    custo: "Grátis com o modelo padrão (o mesmo do Mestre), mas lento: 1 a 2 min por resposta.",
    fallback: "O rascunho fica salvo e pode ser retomado. Se o modelo diz que acabou com pendências, ou o JSON vem ilegível, o servidor pede um conserto uma vez sem envolver o jogador.",
  }),
  n("a_out", X[3], -130, "code", "Mecânica validada", "baixar JSON ou iniciar", {
    oque: "O rascunho passa pela validação (keys, faixas, custos, kit, tema) e pela normalização da mecânica. O jogador baixa o JSON ou inicia a campanha com ele, como no Importar mecânica.",
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
  n("t_tools", X[5], 60, "code", "Ferramentas", "dados, ficha, cena, delegações", {
    oque: "Executadas pelo código a pedido do Mestre: rolar dados, mudar recursos, atributos, habilidades, itens e XP, criar NPC, trocar a cena, gravar e buscar memórias, consultar livros, roteiro e biblioteca, pedir mapas 3D. As escritas vão direto ao Postgres; criar NPC, técnica nova e mapa são delegados aos criadores (lane 4).",
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
    oque: "Todas as chamadas de IA (Jev, Mestre, NPC, Cronista, Roteirista, Ilustrador e os criadores) saem por este gateway e viram uma linha no histórico do agente: tokens, duração, custo, request e resposta. O Jev usa a Decisions API (probabilidades); os demais, chat completions.",
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

  // --- criação em segundo plano ---
  n("c_gm", X[0], 760, "gm", "Mestre: create_npc", "nome, sexo, canon e brief", {
    oque: "O Mestre só registra quem entrou na história: nome, sexo, se é do cânone e um brief (quem é, papel, o que já foi narrado). Não escreve a ficha.",
    quando: "Antes de narrar, quando um personagem com nome aparece pela primeira vez.",
  }),
  n("c_reg", X[1], 760, "code", "NPC registrado na hora", "ativo na cena, o turno segue", {
    oque: "Sem IA: grava o NPC ativo na cena (o brief vira o passado provisório) e responde ao Mestre na hora, para a checagem de quem fala passar. Abre uma tarefa em segundo plano, que aparece no cabeçalho do jogo e avisa quando termina.",
    custo: "Só SQL (≈5 ms).",
  }),
  n("c_char", X[2], 760, "char", "Criador de personagens", "perfil rico e ficha", {
    oque: "Lê a mecânica, o mundo (premissa, arco, cena, NPCs) e os nomes da biblioteca e devolve aparência, idade, papel, personalidade, jeito de falar, passado, objetivos, segredos, relações e manias, mais atributos, recursos, cargo, técnicas e itens coerentes com o poder. Personagem do cânone: fiel à obra no ponto da história.",
    quando: "Em segundo plano, depois de cada create_npc de NPC novo e no botão Refazer perfil do modal do NPC.",
    freq: "1 chamada por NPC novo.",
    custo: "Grátis com o modelo padrão (o mesmo do Mestre); leva de 1,5 a 4 min.",
    fallback: "O NPC fica com o brief do Mestre e a tela avisa; o botão Refazer perfil tenta de novo.",
  }),
  n("c_merge", X[3], 760, "code", "Ficha gravada com merge", "preserva o que o Mestre mudou", {
    oque: "Sem IA: grava o perfil e a ficha com a linha travada. O que o Mestre mudou nesse meio tempo (dano, gasto, cargo, sexo) fica como ele deixou; técnicas e itens se somam por nome.",
  }),
  n("c_pix", X[4], 760, "pixel", "Pixel artista", "retrato em pixel art", {
    oque: "Desenha o retrato de busto como uma grade de pixels com paleta (não SVG livre); o código valida e converte em SVG nítido. Com a geração de imagens ligada nas Configurações, quem pinta o retrato é o Ilustrador, em estilo pixel art.",
    quando: "Depois do perfil de cada NPC novo, ao criar a campanha (protagonista) e nos botões Gerar e Regerar retrato.",
    freq: "1 chamada por personagem (regerar faz outra).",
    custo: "Opus 5.5 com raciocínio baixo: ≈700 tokens de saída, ≈10 s, cerca de US$ 0,02 por retrato. Pelo Ilustrador, cerca de US$ 0,03.",
    fallback: "A tarefa vira erro com aviso; o personagem mostra as iniciais e o botão Regerar.",
  }),
  n("c_out", X[5], 760, "code", "Retrato salvo", "NPCs, modal, ficha e falas", {
    oque: "O retrato fica no Postgres com versão (cache longo no navegador) e aparece nos cartões de NPC, no modal, na ficha do jogador e ao lado das falas no chat.",
  }),

  n("b_gm", X[0], 880, "gm", "Mestre: add_ability", "nome e brief da técnica", {
    oque: "Quando o personagem aprende ou usa uma técnica que ainda não está na ficha, o Mestre só diz o nome e um brief. Antes de inventar, pode consultar a biblioteca (search_library). add_item completa a descrição pela biblioteca.",
  }),
  n("b_lib", X[1], 880, "db", "Biblioteca", "técnicas e itens do mundo", {
    oque: "Técnicas (com tipo, rank, custo, efeito, dano, requisitos, marcos e quem usa) e itens da campanha, do cânone ou criados no jogo. Fonte do add_ability, do add_item e do Criador de personagens, para ninguém adivinhar na hora o que existe. Aba Biblioteca na tela de jogo.",
    custo: "Local (Postgres).",
  }),
  n("b_abil", X[2], 880, "abil", "Criador de habilidades", "técnica nova, validada", {
    oque: "Cria a técnica seguindo a mecânica da campanha (tipos, ranks, recursos, custos por rank, faixas de domínio) e o cânone; o código valida tipo, rank, custo, dano e marcos e guarda na biblioteca.",
    quando: "Na hora, quando o add_ability ou o Criador de personagens pede uma técnica que não existe; em lotes, quando o jogador pede.",
    freq: "1 chamada por técnica nova; lotes de 6 até chegar ao total pedido.",
    custo: "Grátis com o modelo padrão; 70 a 120 s por chamada.",
    fallback: "Prazo de 90 s no turno: estourou, a técnica entra com o que o Mestre deu e o Criador termina em segundo plano para a próxima vez.",
  }),
  n("b_player", X[3], 880, "player", "Gerar biblioteca", "aba Biblioteca ou Fora do jogo", {
    oque: "O jogador pede N técnicas ou itens com um foco (ex.: jutsus canônicos de Konoha até o Exame Chūnin), pela aba Biblioteca ou pedindo ao Mestre fora do jogo.",
  }),
  n("b_items", X[4], 880, "items", "Criador de itens", "ferramentas, armas, consumíveis", {
    oque: "Cria itens e equipamentos do mundo em lotes, recebendo os nomes que já existem para não repetir. O código valida e descarta repetidos.",
    quando: "Em lotes, quando o jogador pede.",
    freq: "Lotes de 6 até o total; para depois de 2 lotes sem nada novo.",
    custo: "Grátis com o modelo padrão.",
  }),
  n("b_jobs", X[5], 880, "code", "Tarefas em segundo plano", "indicador no cabeçalho", {
    oque: "Perfis, retratos, lotes da biblioteca e mapas rodam fora do turno. O cabeçalho do jogo mostra o que está rodando (com progresso) e, quando termina, a tela recarrega e avisa. Duas tarefas iguais não rodam juntas.",
    fallback: "Se o servidor reinicia no meio, a tarefa vira erro depois de 15 min sem sinal.",
  }),

  n("m_gm", X[0], 1000, "gm", "Mestre: local_map", "gerar, editar, remover", {
    oque: "Uma ferramenta com três ações. O Mestre pede o mapa quando o jogador chega a um lugar relevante sem mapa ou a cena pede, e edita quando a história muda o lugar (ex.: a ponte foi destruída). Não regera um mapa que já existe. Os pontos de interesse do mapa viram as zonas do palco da cena. A iniciativa do Mestre pode ser desligada nas Configurações; os botões continuam."
  }),
  n("m_btn", X[1], 1000, "player", "Botões da aba Mapa", "gerar, regerar, editar, remover", {
    oque: "O jogador pode pedir o mapa de qualquer lugar por onde passou, regerar, editar com uma instrução ou remover.",
  }),
  n("m_carto", X[2], 1000, "carto", "Cartógrafo", "mapa 3D de um lugar", {
    oque: "Compõe a maquete 3D de um lugar a partir da obra, da narração e da cena: relevo, contornos extrudados, caminhos e rios, espalhamento de árvores e casas, materiais, luz do horário e pontos de interesse. Devolve uma descrição declarativa, nunca código.",
    quando: "Quando o Mestre ou o jogador pede gerar ou editar o mapa de um lugar.",
    freq: "1 chamada por geração ou edição; um mapa desenhado por vez.",
    custo: "Opus 5.5 com raciocínio médio: o mais caro dos criadores. Cerca de US$ 0,14 e 1 min por mapa novo; US$ 0,18 por edição (recebe o mapa atual compacto).",
    fallback: "A tarefa vira erro com aviso; o mapa anterior (se houver) continua.",
  }),
  n("m_spec", X[3], 1000, "code", "Mapa validado", "limites, cores, contagens", {
    oque: "Sem IA: o código valida e limita o que o Cartógrafo devolveu (quantidades, faixas, cores) e guarda o mapa ligado ao lugar do mapa do mundo.",
  }),
  n("m_view", X[4], 1000, "code", "Aba Mapa", "o da cena em destaque", {
    oque: "Mostra em destaque o mapa 3D do lugar da cena atual (girar, zoom, pontos clicáveis) e a galeria dos mapas dos outros lugares por onde o jogador passou. O diorama do mundo continua na visão Mundo.",
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
  e("s_script", "sr", "t_ctx", "tl", "arco ativo"),
  e("s_btn2", "sr", "s_img", "tl"),
  e("s_img", "sr", "s_out", "tl", "imagem"),
  // aventura
  e("a_btn", "sr", "a_adv", "tl", "conversa ⇄", { both: true }),
  e("a_adv", "sb", "a_out", "tr", "JSON"),
  // criação em segundo plano
  e("c_gm", "sr", "c_reg", "tl"),
  e("c_reg", "sr", "c_char", "tl", "tarefa"),
  e("c_char", "sr", "c_merge", "tl", "JSON"),
  e("c_merge", "sr", "c_pix", "tl", "retrato"),
  e("c_pix", "sr", "c_out", "tl", "SVG"),
  e("c_char", "sb", "b_lib", "tt", "técnicas e itens"),
  e("b_gm", "sr", "b_lib", "tl", "consulta"),
  e("b_lib", "sr", "b_abil", "tl", "não existe"),
  e("b_abil", "sb", "b_lib", "tb", "guarda"),
  e("b_player", "sl", "b_abil", "tr", "N com foco"),
  e("b_player", "sr", "b_items", "tl", "N com foco"),
  e("b_items", "sb", "b_lib", "tb"),
  e("m_gm", "sb", "m_carto", "tb", "tools"),
  e("m_btn", "sr", "m_carto", "tl", "botões"),
  e("m_carto", "sr", "m_spec", "tl", "JSON"),
  e("m_spec", "sr", "m_view", "tl"),
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
