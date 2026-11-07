"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DiceResult, TurnEvent } from "@/lib/types";
import type { CampaignView, ChatLine } from "@/lib/campaignView";
import { diceText } from "../DiceRoller";

/**
 * Estado da tela de jogo e o turno do Mestre (SSE de POST /api/campaigns/[id]/turn).
 *
 *   const t = useTurn(campaignId, { initial, onEvent });
 *
 * Campanha
 *   state          CampaignView | null (null até carregar; com `initial`, já vem pronta do servidor)
 *   setState(fn)   ajuste local sem ir ao servidor (imagem nova na ficha, imagem tirada da ficha...)
 *   reload()       relê GET /api/campaigns/[id] (depois de mexer em ficha, livros, NPC...)
 *   error/setError erro do carregamento ou do turno ("" = nenhum)
 *
 * Chat
 *   feed           mensagens salvas (key "m<id>") + eventos ao vivo do turno (key "k<n>"):
 *                  player | gm | chip (ferramenta; name = nome dela) | dice (dice = DiceResult;
 *                  outcome ok/fail quando há CD). name e dice só nos eventos ao vivo, não nas salvas
 *   draft          narração chegando em streaming ("" = nenhuma). Vem de narration_delta; o narration
 *                  final entra no feed e zera o rascunho.
 *                  Renderize o rascunho num componente à parte e os itens do feed com React.memo:
 *                  cada pedaço do streaming re-renderiza quem usa o hook.
 *   choices        rótulos das opções do último turno (send(rótulo, false, índice) manda a opção tipada)
 *   busy, status   turno em andamento e o texto da fase, vindo do servidor: "Lendo a cena...",
 *                  "O Mestre está pensando...", "Consultando memórias e livros...", "Escrevendo..."
 *   send(text, noTalk?, optionIndex?) envia a ação (optionIndex: a opção N das choices, resolvida sem o
 *                  Intérprete); devolve false se não enviou (ocupado ou texto vazio)
 *   regenerate(fb) "gerar novamente" a última resposta (fb = motivo, pode ser "")
 *   edit(text)     troca a última ação do jogador por text e gera a resposta de novo
 *   canStop, stop() parar o Mestre: só enquanto a narração não chegou (depois dela o turno já está salvo e o
 *                  pós-narração segue). O servidor desfaz o turno e mantém a ação do jogador: o chat fica nela, com
 *                  gerar novamente e editar; um envio novo logo depois entra no lugar dela (vira edit)
 *
 * Dados 3D: com a animação ligada (Configurações), a partir de um evento "dice" todo o resto do
 * turno (inclusive o streaming) fica retido até o jogador rolar, um botão por rolagem, em fila.
 *   pendingDice    rolagem esperando o botão "Rolar dados" (null = nenhuma)
 *   rolling        rolagem em animação: renderize <DiceRoller result={rolling} onDone={releaseDice} />
 *   roll()         começa a animação da rolagem pendente
 *   releaseDice()  fim da animação: mostra o dado e libera os eventos até a próxima rolagem
 *
 * Mensagens anteriores (cursor por id): ponha `feedRef` no elemento que rola e chame loadOlder()
 * no onScroll perto do topo. O hook rola até o fim em mensagem nova, segura a posição ao
 * prepender as anteriores e acompanha o rascunho só se o jogador já está lá embaixo.
 *   feedRef, hasMore, loadingOlder, loadOlder()
 *
 * onEvent(ev): cada evento do turno no momento em que ele acontece na tela. Os de conteúdo
 * (tool, dice, narration, narration_delta, choices, time e qualquer tipo novo,
 * como npc_message) chegam depois de liberados pela rolagem; status, scene, state, error e done
 * chegam na hora. Serve para a tela reagir (toast, som) sem mexer no hook.
 *
 * Efeitos aplicados (chips com `scribe`): undo(item) desfaz no servidor e marca o chip (e os do mesmo registro)
 * como desfeito; devolve o erro ("" = ok). Só os do último turno: as etiquetas da última narração salva também voltam
 * do servidor ao carregar a página.
 *
 * ooc: a ação era pergunta ou reclamação sobre o registro e foi respondida na conversa fora do jogo (gm_notes),
 * sem turno. O hook tira a ação do chat e devolve as opções de antes; a tela abre a conversa no onEvent.
 * npc_talk: idem, a ação era fala só com um NPC em cena e virou a 1ª mensagem da conversa particular com ele (a tela abre
 * o modal). talked(nome, fala): a linha discreta da conversa encerrada (mensagem 'talk', um chip no feed) e, se a conversa
 * nasceu na campanha, a fala de encerramento do NPC logo depois.
 */

export interface FeedItem {
  key: string;
  kind: "player" | "gm" | "chip" | "dice";
  content: string;
  outcome?: "ok" | "fail"; // rolagem com CD: passou ou não
  // só nos eventos ao vivo (mensagens salvas não têm): a rolagem inteira e o nome da ferramenta
  dice?: DiceResult;
  name?: string;
  scribe?: { messageId: number; index: number; undone?: boolean }; // efeito aplicado que dá para desfazer
}

// eventos que nunca ficam retidos pela rolagem
const IMMEDIATE = new Set(["status", "scene", "state", "error", "done"]);

// scribe: as etiquetas dos efeitos da última narração (só elas se desfazem) vêm junto
const toFeed = (messages: ChatLine[], scribe = false): FeedItem[] => {
  const last = scribe ? messages.findLast((m) => m.role === "gm") : undefined;
  return messages.flatMap((m): FeedItem[] => [
    ...(m.role === "talk" // conversa particular encerrada: o chip e a fala de encerramento do NPC
      ? talkItems(`m${m.id}`, m.content, m.speaker, m.meta.farewell)
      : [{ key: `m${m.id}`, kind: m.role === "player" ? "player" : "gm", content: m.content } as FeedItem]),
    ...(m === last ? m.meta.scribe ?? [] : [])
      .map((e, index) => ({ e, index }))
      .filter(({ e }) => e.undo || e.summary !== e.tool)
      .map(({ e, index }): FeedItem => ({
        key: `m${m.id}s${index}`, kind: "chip", content: e.summary, name: e.tool,
        scribe: e.undo ? { messageId: Number(m.id), index, undone: e.undone } : undefined,
      })),
  ]);
};

// fala de encerramento: linha do Mestre com name (não conta como narração para o desfazer) e chave sem "m" (não é mensagem salva)
const talkItems = (key: string, content: string, npc?: string | null, farewell?: string): FeedItem[] => [
  { key, kind: "chip", name: "npc_talk", content },
  ...(farewell && npc ? [{ key: `f${key}`, kind: "gm" as const, name: "npc_talk", content: `**${npc}:** ${farewell}` }] : []),
];

// o feed guarda mensagens salvas com chave "m<id>"; os eventos ao vivo do turno usam "k<n>"
const savedId = (i: FeedItem) => (i.key[0] === "m" && i.kind !== "chip" ? Number(i.key.slice(1)) : null);

const lastChoices = (messages: ChatLine[]) => messages[messages.length - 1]?.meta?.choices ?? [];

export function useTurn(
  campaignId: string,
  opts: { initial?: CampaignView | null; onEvent?: (ev: TurnEvent) => void } = {}
) {
  const { initial } = opts;
  const [state, setState] = useState<CampaignView | null>(initial ?? null);
  const [feed, setFeed] = useState<FeedItem[]>(() => (initial ? toFeed(initial.messages, true) : []));
  const [draft, setDraft] = useState("");
  const [choices, setChoices] = useState<string[]>(() => (initial ? lastChoices(initial.messages) : []));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const busyRef = useRef(false); // dois cliques seguidos não mandam dois turnos
  const [canStop, setCanStop] = useState(false);
  const stopping = useRef(false); // o jogador pediu para parar este turno
  const stopped = useRef(false); // o último turno foi parado: a ação dele ficou salva sem resposta
  const onEvent = useRef(opts.onEvent);
  onEvent.current = opts.onEvent;

  const feedRef = useRef<HTMLDivElement>(null);
  const [hasMore, setHasMore] = useState(initial?.hasMore ?? false); // há mensagens anteriores ainda não carregadas
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false); // evita pedido duplicado enquanto um lote carrega
  const anchor = useRef<{ h: number; top: number } | null>(null); // posição do scroll antes de prepender
  const firstScroll = useRef(true);
  const keyCounter = useRef(0);
  const nextKey = () => `k${++keyCounter.current}`;

  const diceAnim = useRef(initial?.ui.diceAnimation ?? true);
  const held = useRef<TurnEvent[]>([]);
  const reloadAfterHeld = useRef(false);
  const [pendingDice, setPendingDice] = useState<DiceResult | null>(null);
  const [rolling, setRolling] = useState<DiceResult | null>(null);

  const reload = useCallback(async () => {
    const res = await fetch(`/api/campaigns/${campaignId}`);
    if (!res.ok) {
      setError("Campanha não encontrada.");
      return;
    }
    const data = (await res.json()) as CampaignView;
    diceAnim.current = data.ui.diceAnimation;
    setState(data);
    return data;
  }, [campaignId]);

  useEffect(() => {
    if (initial) return; // já veio no HTML
    reload().then((data) => {
      if (!data) return;
      setFeed(toFeed(data.messages, true));
      setHasMore(data.hasMore);
      setChoices(lastChoices(data.messages));
    });
  }, [reload]);

  // Segue o fim só enquanto o jogador está lá: subir (roda, toque, teclado, barra) para de seguir e
  // voltar perto do fim retoma. Scroll do código só desce, então não conta como "subiu"; conteúdo que
  // encolhe sobe o scrollTop, mas termina colado no fim (gap ~0) e também não conta.
  const stick = useRef(true);
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    let last = el.scrollTop;
    let touchY = 0;
    const up = () => (stick.current = false);
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (el.scrollTop < last && gap > 2) up();
      else if (gap < 80) stick.current = true;
      last = el.scrollTop;
    };
    // roda/toque/teclado chegam antes do scroll: param de seguir já, sem disputar com o streaming
    const onWheel = (e: WheelEvent) => e.deltaY < 0 && up();
    const onTouchStart = (e: TouchEvent) => (touchY = e.touches[0].clientY);
    const onTouchMove = (e: TouchEvent) => e.touches[0].clientY > touchY && up();
    const onKey = (e: KeyboardEvent) => ["ArrowUp", "PageUp", "Home"].includes(e.key) && up();
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("keydown", onKey);
    };
  }, []);

  // Conteúdo novo (mensagem, narração em streaming, opções, fase): rola ao fim só se o jogador seguia;
  // ao prepender anteriores, só compensa a altura acrescentada. Sempre instantâneo (o .feed tem
  // scroll-behavior: smooth, e a animação perderia a corrida com o texto crescendo).
  useLayoutEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    if (anchor.current) {
      el.scrollTo({ top: anchor.current.top + el.scrollHeight - anchor.current.h, behavior: "instant" });
      anchor.current = null;
      return;
    }
    if (firstScroll.current || stick.current) el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
    if (feed.length) firstScroll.current = false;
  }, [feed, status, draft, choices]);

  const loadOlder = async () => {
    const el = feedRef.current;
    const oldest = feed.map(savedId).find((id) => id !== null);
    if (loadingOlderRef.current || !hasMore || !el || !oldest) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/messages?before=${oldest}`);
      if (!res.ok) throw new Error(`Erro ${res.status}`);
      const page = (await res.json()) as { messages: ChatLine[]; hasMore: boolean };
      anchor.current = { h: el.scrollHeight, top: el.scrollTop };
      setFeed((f) => [...toFeed(page.messages), ...f]);
      setHasMore(page.hasMore);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };

  const showEvent = (ev: TurnEvent) => {
    if (ev.type === "tool") setFeed((f) => [...f, { key: nextKey(), kind: "chip", content: ev.summary, name: ev.name, scribe: ev.scribe }]);
    else if (ev.type === "dice")
      setFeed((f) => [
        ...f,
        {
          key: nextKey(),
          kind: "dice",
          content: diceText(ev.result),
          dice: ev.result,
          outcome: ev.result.dc === undefined ? undefined : ev.result.success ? "ok" : "fail",
        },
      ]);
    else if (ev.type === "narration_delta") setDraft((d) => d + ev.text);
    else if (ev.type === "narration") {
      setDraft("");
      setFeed((f) => [...f, { key: nextKey(), kind: "gm", content: ev.content }]);
    } else if (ev.type === "choices") setChoices(ev.choices);
    else if (ev.type === "time")
      setState((s) => s && { ...s, campaign: { ...s.campaign, state: { ...s.campaign.state, clock: { minutes: ev.minutes } } } });
    onEvent.current?.(ev);
  };

  // libera os eventos retidos até a próxima rolagem (all: libera tudo, sem animar)
  const drainHeld = (all = false) => {
    while (held.current.length) {
      const ev = held.current[0];
      if (ev.type === "dice" && !ev.result.sure && !all) return setPendingDice(ev.result);
      held.current.shift();
      showEvent(ev);
    }
    setPendingDice(null);
    if (reloadAfterHeld.current) {
      reloadAfterHeld.current = false;
      reload();
    }
  };

  const roll = () => setRolling(pendingDice);

  const releaseDice = () => {
    const ev = held.current.shift();
    if (ev) showEvent(ev);
    setRolling(null);
    drainHeld();
  };

  // regen: gera de novo a resposta do último turno (o servidor volta o estado de antes dele);
  // com edit, a ação do jogador também é trocada por text
  const run = async (text: string, regen?: { feedback: string; edit?: boolean }, noTalk?: boolean, optionIndex?: number) => {
    const before = choices; // a ação pode virar fala fora do jogo: aí as opções de antes voltam
    stick.current = true; // o jogador agiu: volta a seguir o fim
    busyRef.current = true;
    setBusy(true);
    setCanStop(true);
    stopping.current = false;
    stopped.current = false;
    setError("");
    setChoices([]);
    setRolling(null);
    drainHeld(true);
    setDraft("");
    if (regen) {
      // tira do chat o que veio depois da última ação do jogador
      setFeed((f) => {
        const lastPlayer = f.map((i) => i.kind).lastIndexOf("player");
        if (regen.edit) return [...(lastPlayer >= 0 ? f.slice(0, lastPlayer) : f), { key: nextKey(), kind: "player", content: text }];
        return lastPlayer >= 0 ? f.slice(0, lastPlayer + 1) : f;
      });
    } else setFeed((f) => [...f, { key: nextKey(), kind: "player", content: text }]);
    setStatus("Lendo a cena..."); // o servidor manda as fases seguintes
    let failed = false;
    let narrated = false;
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(regen ? { regenerate: true, feedback: regen.feedback, input: regen.edit ? text : undefined } : { input: text, noTalk, optionIndex }),
      });
      // recusado antes do turno (400: texto livre em missão): a ação sai do chat, as opções voltam e a mensagem aparece
      if (res.status === 400 && !regen) {
        setFeed((f) => {
          const i = f.map((x) => x.kind).lastIndexOf("player");
          return i >= 0 ? f.slice(0, i) : f;
        });
        setChoices(before);
      }
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error || `Erro ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6)) as TurnEvent;
          if (ev.type === "narration" || ev.type === "ooc" || ev.type === "npc_talk") {
            narrated = true; // salva no servidor (mesmo se ainda retida pela rolagem): não dá mais para parar
            setCanStop(false);
          }
          if (ev.type === "ooc" || ev.type === "npc_talk") {
            // não houve turno: a ação sai do chat (ficou na conversa fora do jogo ou na particular com o NPC, com a resposta)
            setFeed((f) => {
              const i = f.map((x) => x.kind).lastIndexOf("player");
              return i >= 0 ? f.slice(0, i) : f;
            });
            setChoices(before);
          }
          if (IMMEDIATE.has(ev.type)) {
            if (ev.type === "status") setStatus(ev.text);
            else if (ev.type === "error") {
              failed = true;
              setError(ev.message);
            }
            onEvent.current?.(ev);
          } else if (diceAnim.current && ((ev.type === "dice" && !ev.result.sure) || held.current.length)) {
            // resultado garantido não abre a rolagem: entra direto no chat
            held.current.push(ev);
            if (ev.type === "dice" && held.current.length === 1) setPendingDice(ev.result);
          } else showEvent(ev);
        }
      }
    } catch (e) {
      failed = true;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
      setCanStop(false);
      setStatus("");
      if (stopping.current && !narrated && !failed) {
        // parado: o servidor já voltou o estado; some o que veio depois da ação (chips, dados, rascunho)
        stopped.current = true;
        held.current = [];
        setPendingDice(null);
        setRolling(null);
        setDraft("");
        setFeed((f) => f.slice(0, f.map((i) => i.kind).lastIndexOf("player") + 1));
        void reload();
        return;
      }
      // ficha/cena só atualizam depois da rolagem, para não adiantar o resultado
      if (held.current.length && !failed) {
        reloadAfterHeld.current = true;
        return;
      }
      drainHeld(true);
      if (failed) setDraft(""); // narração interrompida não foi salva
      const data = await reload();
      // se o "gerar novamente" falhou, o chat volta a refletir o que está salvo
      // (mantém as anteriores já carregadas, antes da janela recente)
      if (regen && failed && data) {
        const first = data.messages[0]?.id ?? 0;
        setFeed((f) => [...f.filter((i) => (savedId(i) ?? Infinity) < first), ...toFeed(data.messages, true)]);
      }
    }
  };

  // noTalk: a fala voltou do chat do NPC ("não era uma conversa"), o servidor não pergunta de novo se é conversa
  // optionIndex: a opção N das choices (o servidor resolve os passos tipados dela, sem o Intérprete)
  const send = (text: string, noTalk?: boolean, optionIndex?: number) => {
    if (busyRef.current || !text.trim()) return false;
    // depois de parar, a ação parada (salva sem resposta) dá lugar à nova
    void (stopped.current ? run(text.trim(), { feedback: "", edit: true }) : run(text, undefined, noTalk, optionIndex));
    return true;
  };

  const stop = () => {
    if (!busyRef.current || stopping.current || !canStop) return;
    stopping.current = true;
    setCanStop(false);
    setStatus("Parando o Mestre...");
    // o SSE do turno termina depois que o servidor desfaz o turno; é por ele que o run acaba
    fetch(`/api/campaigns/${campaignId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stop: true }),
    }).catch(() => {});
  };

  const regenerate = (feedback: string) => {
    if (busyRef.current) return false;
    void run("", { feedback });
    return true;
  };

  const undo = async (item: FeedItem): Promise<string> => {
    const sc = item.scribe;
    if (busyRef.current || !sc || sc.undone) return "";
    const res = await fetch(`/api/campaigns/${campaignId}/corrections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ undo: { messageId: sc.messageId, index: sc.index } }),
    }).catch(() => null);
    const data = await res?.json().catch(() => null);
    if (!res?.ok) return data?.error || "Não deu para desfazer.";
    const same = (i: FeedItem) => i.scribe?.messageId === sc.messageId && i.scribe.index === sc.index;
    setFeed((f) => f.map((i) => (same(i) ? { ...i, scribe: { ...i.scribe!, undone: true } } : i)));
    void reload();
    return "";
  };

  const edit = (text: string) => {
    if (busyRef.current || !text.trim()) return false;
    void run(text.trim(), { feedback: "", edit: true });
    return true;
  };

  const talked = (name: string, farewell?: string) =>
    setFeed((f) => [...f, ...talkItems(nextKey(), `Conversa particular com ${name}`, name, farewell)]);

  return {
    state, setState, reload, error, setError, talked,
    feed, draft, choices, setChoices, busy, status, send, regenerate, edit, canStop, stop, undo,
    pendingDice, rolling, roll, releaseDice,
    feedRef, hasMore, loadingOlder, loadOlder,
  };
}
