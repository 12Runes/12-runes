import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Minería del log de eventos (`events`, guardado como JSON por partida) para sacar
// estadísticas por carta dentro de un matchup: cuántas veces se jugó, win rate cuando se
// jugó vs. cuando no, y el mismo desglose separado por on the play / on the draw.
//
// Basado en lo que realmente emite TCG Arena por WebRTC (ver Riftbound Tracker/README.md):
// los robos y la mano inicial no llevan identidad de carta (barajado determinista en cada
// cliente), pero cada vez que una carta se JUEGA sí viaja completa. Por eso "más importante
// para el matchup" aquí se mide sobre cartas jugadas, no sobre la mano inicial.

const CARD_PLAY_TEXTS = new Set([
  "play.logs.player.cardMove.play.from.hand",
  "play.logs.player.cardMove.play.from.deck",
]);

interface HistoryEvent {
  eventType?: string;
  text?: string | null;
  playerId?: string | null;
  params?: { card?: { cardId?: string; cardName?: string; cardType?: string; cardImage?: string } } | null;
}

// Las Runes se juegan prácticamente en automático cada turno (son el recurso, no una
// decisión de juego), así que no aportan nada útil a "qué carta rinde mejor" y se piden
// fuera de la tabla de rendimiento.
const EXCLUDED_CARD_TYPES = new Set(["Runes"]);

export interface MatchForCardStats {
  id: string;
  result: string;
  onThePlay: boolean | null;
  localPlayerId: string | null;
  events: string;
}

// --- "Perspectiva": minar los datos del rival exactamente igual que los propios -----------
//
// Cada partida ya guarda TODO por duplicado — mazo, id de jugador y eventos de ambos lados —
// porque el log de WebRTC no distingue "mío"/"del rival" más que por la dirección del mensaje.
// Hasta ahora solo se explotaba el lado local. `toPerspective` reconstruye un registro
// equivalente desde el lado del rival: mismo log de eventos (ya trae los cardId completos de
// las dos manos), pero con `localPlayerId` puesto al id del rival (para que la minería de
// cartas filtre SUS jugadas) y el resultado invertido (si yo gané, él perdió). Así cada
// partida grabada aporta dos puntos de datos — el mío y el suyo — en vez de solo uno, sin
// tener que capturar ni guardar nada más por parte del rival.
export type Perspective = "local" | "opponent";

export function invertResult(result: string): string {
  if (result === "WIN") return "LOSS";
  if (result === "LOSS") return "WIN";
  return "UNKNOWN";
}

export interface BattlefieldEntry {
  cardId: string | null;
  cardName: string | null;
  cardImage: string | null;
}

// Los campos marcados opcionales son los "caros" de traer de la base de datos (sobre todo
// `events`, el log completo de la partida — potencialmente la columna más pesada de la tabla).
// No todos los endpoints que pasan por `toPerspective` los necesitan (ver los distintos SELECT_*
// en index.ts): quedan opcionales aquí para que cada uno pida a Prisma solo lo que de verdad va a
// usar, y `toPerspective` los rellena con un valor neutro si no vinieron en el select.
export interface RawMatchForPerspective {
  id: string;
  result: string;
  onThePlay: boolean | null;
  localPlayerId?: string | null;
  opponentPlayerId?: string | null;
  events?: string;
  localDeck?: string | null;
  opponentDeck?: string | null;
  localBattlefields?: string | null;
  opponentBattlefields?: string | null;
  localLegendName: string | null;
  opponentLegendName: string | null;
  startedAt: Date;
}

function parseBattlefields(raw: string | null): BattlefieldEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Superconjunto de los campos que piden computeCardStats/computeCardGrades/computeDeckGroups —
// una vez normalizada a "perspectiva", cada una de esas funciones consume esto sin saber (ni
// necesitar saber) si el dato vino de mi lado o del rival.
export interface PerspectiveMatch {
  id: string;
  result: string;
  onThePlay: boolean | null;
  localPlayerId: string | null;
  events: string;
  localDeck: string | null;
  battlefields: BattlefieldEntry[];
  startedAt: Date;
  legendName: string | null;
  opponentLegendName: string | null;
  // De qué lado de la partida viene este punto de datos: "local" es el lado del contributor
  // filtrado (el que de verdad jugó esa Legend), "opponent" es el rival al que se enfrentó. Sirve
  // para poder distinguir, en listados como /stats/legends, cuántas partidas de una Legend
  // fueron jugadas por ti frente a cuántas solo la enfrentaste jugando otra cosa.
  side: Perspective;
}

export function toPerspective(m: RawMatchForPerspective, side: Perspective): PerspectiveMatch {
  if (side === "local") {
    return {
      id: m.id,
      result: m.result,
      onThePlay: m.onThePlay,
      localPlayerId: m.localPlayerId ?? null,
      events: m.events ?? "",
      localDeck: m.localDeck ?? null,
      battlefields: parseBattlefields(m.localBattlefields ?? null),
      startedAt: m.startedAt,
      legendName: m.localLegendName,
      opponentLegendName: m.opponentLegendName,
      side,
    };
  }
  return {
    // Sufijo para no colisionar con el id real: si alguna vez local y rival llevan la misma
    // Legend (mirror match), las dos perspectivas deben contar como dos partidas distintas.
    id: `${m.id}:opp`,
    result: invertResult(m.result),
    onThePlay: m.onThePlay == null ? null : !m.onThePlay,
    localPlayerId: m.opponentPlayerId ?? null,
    events: m.events ?? "",
    localDeck: m.opponentDeck ?? null,
    battlefields: parseBattlefields(m.opponentBattlefields ?? null),
    startedAt: m.startedAt,
    legendName: m.opponentLegendName,
    opponentLegendName: m.localLegendName,
    side,
  };
}

// Las dos perspectivas de cada partida, sin filtrar por Legend — para /stats/legends y
// /stats/matchups, que agregan "todo lo que se ha visto", sea mío o del rival.
export function bothPerspectives(matches: RawMatchForPerspective[]): PerspectiveMatch[] {
  const out: PerspectiveMatch[] = [];
  for (const m of matches) {
    out.push(toPerspective(m, "local"));
    out.push(toPerspective(m, "opponent"));
  }
  return out;
}

// Solo la(s) perspectiva(s) en las que esa Legend concreta fue la jugada (normalmente una; las
// dos si la partida fue Legend X contra sí misma).
export function perspectivesForLegend(matches: RawMatchForPerspective[], legend: string): PerspectiveMatch[] {
  const out: PerspectiveMatch[] = [];
  for (const m of matches) {
    if (m.localLegendName === legend) out.push(toPerspective(m, "local"));
    if (m.opponentLegendName === legend) out.push(toPerspective(m, "opponent"));
  }
  return out;
}

function winLoss(wins: number, losses: number) {
  return wins + losses > 0 ? wins / (wins + losses) : null;
}

function splitBucket() {
  return { games: new Set<string>(), wins: 0, losses: 0 };
}

function recordResult(bucket: { wins: number; losses: number }, result: string) {
  if (result === "WIN") bucket.wins++;
  else if (result === "LOSS") bucket.losses++;
}

export function computeCardStats(matches: MatchForCardStats[]) {
  const totalGames = matches.length;
  const overall = { wins: 0, losses: 0 };
  const onPlay = splitBucket();
  const onDraw = splitBucket();

  const cards = new Map<
    string,
    {
      cardId: string;
      cardName: string | null;
      cardType: string | null;
      cardImage: string | null;
      matchesPlayedIn: Set<string>;
      totalTimesPlayed: number;
      played: { wins: number; losses: number };
      onPlay: ReturnType<typeof splitBucket>;
      onDraw: ReturnType<typeof splitBucket>;
    }
  >();

  for (const m of matches) {
    recordResult(overall, m.result);
    if (m.onThePlay === true) {
      onPlay.games.add(m.id);
      recordResult(onPlay, m.result);
    } else if (m.onThePlay === false) {
      onDraw.games.add(m.id);
      recordResult(onDraw, m.result);
    }

    let events: HistoryEvent[];
    try {
      events = JSON.parse(m.events);
    } catch {
      continue;
    }
    if (!Array.isArray(events)) continue;

    const playedInThisMatch = new Set<string>();
    for (const e of events) {
      if (e.eventType !== "history" || !e.text || !CARD_PLAY_TEXTS.has(e.text)) continue;
      if (!m.localPlayerId || e.playerId !== m.localPlayerId) continue;
      const card = e.params?.card;
      if (!card?.cardId) continue;
      if (card.cardType && EXCLUDED_CARD_TYPES.has(card.cardType)) continue;

      if (!cards.has(card.cardId)) {
        cards.set(card.cardId, {
          cardId: card.cardId,
          cardName: card.cardName ?? null,
          cardType: card.cardType ?? null,
          cardImage: card.cardImage ?? null,
          matchesPlayedIn: new Set(),
          totalTimesPlayed: 0,
          played: { wins: 0, losses: 0 },
          onPlay: splitBucket(),
          onDraw: splitBucket(),
        });
      }
      const agg = cards.get(card.cardId)!;
      // Partidas grabadas antes de que empezáramos a guardar la imagen tienen estos campos a
      // null; si esta carta ya se vio en una de esas, no dejamos que ese null se quede fijo
      // para siempre — en cuanto aparece un evento con datos completos, los adoptamos.
      if (card.cardName && !agg.cardName) agg.cardName = card.cardName;
      if (card.cardType && !agg.cardType) agg.cardType = card.cardType;
      if (card.cardImage && !agg.cardImage) agg.cardImage = card.cardImage;
      agg.totalTimesPlayed++;
      playedInThisMatch.add(card.cardId);
    }

    for (const cardId of playedInThisMatch) {
      const agg = cards.get(cardId)!;
      agg.matchesPlayedIn.add(m.id);
      recordResult(agg.played, m.result);
      if (m.onThePlay === true) {
        agg.onPlay.games.add(m.id);
        recordResult(agg.onPlay, m.result);
      } else if (m.onThePlay === false) {
        agg.onDraw.games.add(m.id);
        recordResult(agg.onDraw, m.result);
      }
    }
  }

  const cardRows = Array.from(cards.values())
    .map((c) => {
      const gamesPlayed = c.matchesPlayedIn.size;
      const winsWhenNotPlayed = overall.wins - c.played.wins;
      const lossesWhenNotPlayed = overall.losses - c.played.losses;
      const winRateWhenPlayed = winLoss(c.played.wins, c.played.losses);
      const winRateWhenNotPlayed = winLoss(winsWhenNotPlayed, lossesWhenNotPlayed);
      return {
        cardId: c.cardId,
        cardName: c.cardName,
        cardType: c.cardType,
        cardImage: c.cardImage,
        gamesPlayed,
        totalTimesPlayed: c.totalTimesPlayed,
        gamesNotPlayed: totalGames - gamesPlayed,
        winRateWhenPlayed,
        winRateWhenNotPlayed,
        delta: winRateWhenPlayed != null && winRateWhenNotPlayed != null ? winRateWhenPlayed - winRateWhenNotPlayed : null,
        onPlay: { games: c.onPlay.games.size, winRate: winLoss(c.onPlay.wins, c.onPlay.losses) },
        onDraw: { games: c.onDraw.games.size, winRate: winLoss(c.onDraw.wins, c.onDraw.losses) },
      };
    })
    .sort((a, b) => b.gamesPlayed - a.gamesPlayed);

  return {
    matchup: {
      games: totalGames,
      wins: overall.wins,
      losses: overall.losses,
      winRate: winLoss(overall.wins, overall.losses),
      onPlay: { games: onPlay.games.size, winRate: winLoss(onPlay.wins, onPlay.losses) },
      onDraw: { games: onDraw.games.size, winRate: winLoss(onDraw.wins, onDraw.losses) },
    },
    cards: cardRows,
  };
}

// --- Agrupación por lista exacta (misma Legend, mazos de 40 distintos) --------------------

interface DeckCardEntry {
  id: string;
  count: number;
  name?: string | null;
  type?: string | null;
  cost?: number | null;
  image?: string | null;
}

interface DeckSummary {
  legendId?: string | null;
  legendName?: string | null;
  legendImage?: string | null;
  championId?: string | null;
  championName?: string | null;
  championImage?: string | null;
  battlefields?: DeckCardEntry[];
  runes?: DeckCardEntry[];
  spells?: DeckCardEntry[];
  units?: DeckCardEntry[];
  sideboard?: DeckCardEntry[];
}

const DECK_LIST_CATEGORIES = ["battlefields", "runes", "spells", "units", "sideboard"] as const;

// Huella estable de una lista concreta: mismo Chosen Champion + mismas cartas (id + copias)
// en cada categoría, sin depender del orden. Dos partidas con la misma Legend pero distinto
// Champion o distintas 40 cartas caen en huellas distintas.
export function computeDeckSignature(deck: DeckSummary | null | undefined): string | null {
  if (!deck) return null;
  const parts: string[] = [];
  if (deck.championId) parts.push(`champion:${deck.championId}`);
  for (const cat of DECK_LIST_CATEGORIES) {
    for (const c of deck[cat] ?? []) parts.push(`${cat}:${c.id}:${c.count}`);
  }
  if (parts.length === 0) return null;
  parts.sort();
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}

// Huella de la partida REAL, para detectar que dos jugadores han grabado la misma partida
// cada uno por su lado (cada uno ve el log completo de los dos, así que la segunda subida no
// aporta nada nuevo — ver README). No podemos usar `seriesId`/`startedAt`: los genera cada
// instalación de la extensión por su cuenta (crypto.randomUUID()/Date.now() locales), así que
// no coinciden entre los dos jugadores de una misma partida. En cambio el CONTENIDO de
// `events` viene del propio motor de TCG Arena (id/playerId/timestamp de cada jugada, turno a
// turno) y por tanto es idéntico para los dos lados de una misma partida real — el único campo
// que difiere es `ts`, un `Date.now()` local de cuando cada cliente procesó el mensaje, que por
// eso se excluye aquí.
export function computeMatchFingerprint(events: unknown): string | null {
  if (!Array.isArray(events) || events.length === 0) return null;

  const canonical = events
    .map((e: any) => {
      if (!e || typeof e !== "object") return null;
      if (e.eventType === "history") {
        return {
          t: "history",
          id: e.id ?? null,
          playerId: e.playerId ?? null,
          type: e.type ?? null,
          timestamp: e.timestamp ?? null,
          cardId: e.params?.card?.cardId ?? e.params?.card?.id ?? null,
        };
      }
      if (e.eventType === "turn") {
        return { t: "turn", currentPlayer: e.currentPlayer ?? null, turnCount: e.turnCount ?? null };
      }
      if (e.eventType === "end-turn") {
        const { ts, eventType, ...info } = e;
        return { t: "end-turn", info };
      }
      return null;
    })
    .filter((e) => e !== null);

  if (canonical.length === 0) return null;

  // Orden estable independiente de en qué momento procesó cada cliente cada mensaje.
  canonical.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export interface MatchForDeckStats {
  id: string;
  result: string;
  startedAt: Date;
  localDeck: string | null;
}

export function computeDeckGroups(matches: MatchForDeckStats[]) {
  const groups = new Map<
    string,
    { signature: string; games: number; wins: number; losses: number; deck: DeckSummary; lastPlayedAt: Date }
  >();

  for (const m of matches) {
    if (!m.localDeck) continue;
    let deck: DeckSummary;
    try {
      deck = JSON.parse(m.localDeck);
    } catch {
      continue;
    }
    const signature = computeDeckSignature(deck);
    if (!signature) continue;

    if (!groups.has(signature)) groups.set(signature, { signature, games: 0, wins: 0, losses: 0, deck, lastPlayedAt: m.startedAt });
    const g = groups.get(signature)!;
    g.games++;
    if (m.result === "WIN") g.wins++;
    else if (m.result === "LOSS") g.losses++;
    // Se muestra la lista de la partida más reciente con esta huella (por si el arte de
    // alguna carta cambia de URL entre parches, se queda con la versión más fresca).
    if (m.startedAt > g.lastPlayedAt) {
      g.lastPlayedAt = m.startedAt;
      g.deck = deck;
    }
  }

  return Array.from(groups.values())
    .map((g) => ({
      signature: g.signature,
      games: g.games,
      wins: g.wins,
      losses: g.losses,
      winRate: winLoss(g.wins, g.losses),
      championName: g.deck.championName ?? null,
      championImage: g.deck.championImage ?? null,
      lastPlayedAt: g.lastPlayedAt,
      deck: g.deck,
    }))
    .sort((a, b) => b.games - a.games);
}

// --- Agrupación de listas "parecidas" en un mismo arquetipo -------------------------------
//
// Con el tiempo, una misma Legend acumula muchísimas huellas distintas (computeDeckSignature
// cambia con solo tocar una carta), y el desplegable de "Lista" acabaría teniendo una entrada
// por cada micro-ajuste. Para evitarlo, las listas con el mismo Chosen Champion cuya distancia
// (cartas que cambian, contando copias) es pequeña se agrupan en un mismo "arquetipo": el
// desplegable principal muestra arquetipos, y cada uno conserva sus listas exactas (variantes)
// para quien quiera ver el desglose build a build.

function deckMultiset(deck: DeckSummary): Map<string, number> {
  const m = new Map<string, number>();
  for (const cat of DECK_LIST_CATEGORIES) {
    for (const c of deck[cat] ?? []) m.set(`${cat}:${c.id}`, (m.get(`${cat}:${c.id}`) ?? 0) + c.count);
  }
  return m;
}

// Suma de diferencias de copias carta a carta entre dos mazos (0 = listas idénticas).
function deckDistance(a: Map<string, number>, b: Map<string, number>): number {
  let diff = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) diff += Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0));
  return diff;
}

// Hasta 6 copias de diferencia (de 40 cartas) se considera la misma build en evolución, no un
// mazo nuevo — cubre tecnológicas puntuales, sideboard cambiado entre rondas, etc.
const CLUSTER_DISTANCE_THRESHOLD = 6;

type DeckGroupRow = ReturnType<typeof computeDeckGroups>[number];

export interface DeckCluster {
  clusterId: string;
  games: number;
  wins: number;
  losses: number;
  winRate: number | null;
  championName: string | null;
  championImage: string | null;
  lastPlayedAt: Date;
  variantCount: number;
  variants: DeckGroupRow[];
}

export function computeDeckClusters(matches: MatchForDeckStats[], threshold = CLUSTER_DISTANCE_THRESHOLD): DeckCluster[] {
  const groups = computeDeckGroups(matches);

  const parent = groups.map((_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  const multisets = groups.map((g) => deckMultiset(g.deck));
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      // Cambiar de Chosen Champion es un mazo distinto aunque el resto de cartas se parezca.
      if ((groups[i].championName ?? null) !== (groups[j].championName ?? null)) continue;
      if (deckDistance(multisets[i], multisets[j]) <= threshold) union(i, j);
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < groups.length; i++) {
    const root = find(i);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root)!.push(i);
  }

  return Array.from(byRoot.values())
    .map((idxs): DeckCluster => {
      const variants = idxs.map((i) => groups[i]).sort((a, b) => b.games - a.games);
      const rep = variants[0];
      const games = variants.reduce((s, v) => s + v.games, 0);
      const wins = variants.reduce((s, v) => s + v.wins, 0);
      const losses = variants.reduce((s, v) => s + v.losses, 0);
      const lastPlayedAt = variants.reduce((max, v) => (v.lastPlayedAt > max ? v.lastPlayedAt : max), variants[0].lastPlayedAt);
      return {
        clusterId: rep.signature,
        games,
        wins,
        losses,
        winRate: winLoss(wins, losses),
        championName: rep.championName,
        championImage: rep.championImage,
        lastPlayedAt,
        variantCount: variants.length,
        variants,
      };
    })
    .sort((a, b) => b.games - a.games);
}

// Dada la huella de una lista exacta, todas las huellas de su mismo arquetipo (para poder
// filtrar /stats/cards por "esta build y sus variantes menores", no solo la huella exacta).
export function clusterMemberSignatures(matches: MatchForDeckStats[], signature: string): Set<string> {
  const clusters = computeDeckClusters(matches);
  const cluster = clusters.find((c) => c.variants.some((v) => v.signature === signature));
  return cluster ? new Set(cluster.variants.map((v) => v.signature)) : new Set([signature]);
}

// --- Valoración de cartas al estilo 17lands ------------------------------------------------
//
// `cardId` ya es el código público de la carta tal cual lo usa el juego (p. ej. "OGN-166"):
// el código de set es el prefijo antes del guion, así que se deriva sin datos extra. El
// dominio (Fury/Calm/Mind/Body/Chaos/Order/Colorless, o "Multi" con dos) no viaja por el
// protocolo, así que se resuelve contra un catálogo estático descargado una vez de la web
// oficial de Riftbound (riftbound.leagueoflegends.com/en-us/card-gallery/) — ver
// `data/cardDomains.json`. Si una carta nueva de un set futuro no está todavía en ese
// catálogo, se omite del grid en vez de mostrar un dominio inventado.

export const SET_NAMES: Record<string, string> = {
  OGN: "Origins",
  OGS: "Origins: Proving Grounds",
  SFD: "Spiritforged",
  UNL: "Unleashed",
  VEN: "Vendetta",
};

let cardDomainsCache: Record<string, string> | null = null;
function loadCardDomains(): Record<string, string> {
  if (!cardDomainsCache) {
    const path = fileURLToPath(new URL("./data/cardDomains.json", import.meta.url));
    cardDomainsCache = JSON.parse(readFileSync(path, "utf8"));
  }
  return cardDomainsCache!;
}

// Bandas de win rate -> nota, al estilo 17lands pero con umbrales absolutos (no percentiles):
// con el volumen de partidas de una sola persona, un percentil relativo a "todas las cartas
// vistas" es ruidoso: mover el listón según win rate real es más legible y estable.
const GRADE_BANDS: { min: number; grade: string }[] = [
  { min: 0.65, grade: "A+" },
  { min: 0.62, grade: "A" },
  { min: 0.59, grade: "A-" },
  { min: 0.56, grade: "B+" },
  { min: 0.53, grade: "B" },
  { min: 0.5, grade: "B-" },
  { min: 0.47, grade: "C+" },
  { min: 0.44, grade: "C" },
  { min: 0.41, grade: "C-" },
  { min: 0.38, grade: "D+" },
  { min: 0.35, grade: "D" },
  { min: -Infinity, grade: "F" },
];
function gradeForWinRate(winRate: number): string {
  return GRADE_BANDS.find((b) => winRate >= b.min)!.grade;
}

export interface MatchForCardGrades {
  id: string;
  result: string;
  localPlayerId: string | null;
  events: string;
}

export function computeCardGrades(matches: MatchForCardGrades[]) {
  const domains = loadCardDomains();
  const cards = new Map<
    string,
    {
      cardId: string;
      cardName: string | null;
      cardType: string | null;
      cardImage: string | null;
      totalTimesPlayed: number;
      wins: number;
      losses: number;
      matchesPlayedIn: Set<string>;
    }
  >();

  for (const m of matches) {
    let events: HistoryEvent[];
    try {
      events = JSON.parse(m.events);
    } catch {
      continue;
    }
    if (!Array.isArray(events)) continue;

    const playedInThisMatch = new Set<string>();
    for (const e of events) {
      if (e.eventType !== "history" || !e.text || !CARD_PLAY_TEXTS.has(e.text)) continue;
      if (!m.localPlayerId || e.playerId !== m.localPlayerId) continue;
      const card = e.params?.card;
      if (!card?.cardId) continue;
      if (card.cardType && EXCLUDED_CARD_TYPES.has(card.cardType)) continue;

      if (!cards.has(card.cardId)) {
        cards.set(card.cardId, {
          cardId: card.cardId,
          cardName: card.cardName ?? null,
          cardType: card.cardType ?? null,
          cardImage: card.cardImage ?? null,
          totalTimesPlayed: 0,
          wins: 0,
          losses: 0,
          matchesPlayedIn: new Set(),
        });
      }
      const agg = cards.get(card.cardId)!;
      if (card.cardName && !agg.cardName) agg.cardName = card.cardName;
      if (card.cardType && !agg.cardType) agg.cardType = card.cardType;
      if (card.cardImage && !agg.cardImage) agg.cardImage = card.cardImage;
      agg.totalTimesPlayed++;
      playedInThisMatch.add(card.cardId);
    }

    for (const cardId of playedInThisMatch) {
      const agg = cards.get(cardId)!;
      agg.matchesPlayedIn.add(m.id);
      if (m.result === "WIN") agg.wins++;
      else if (m.result === "LOSS") agg.losses++;
    }
  }

  const rows = Array.from(cards.values())
    .map((c) => {
      const gamesPlayed = c.matchesPlayedIn.size;
      const winRateWhenPlayed = winLoss(c.wins, c.losses);
      const set = c.cardId.split("-")[0] ?? null;
      return {
        cardId: c.cardId,
        cardName: c.cardName,
        cardType: c.cardType,
        cardImage: c.cardImage,
        set,
        domain: domains[c.cardId] ?? null,
        gamesPlayed,
        totalTimesPlayed: c.totalTimesPlayed,
        winRateWhenPlayed,
        grade: winRateWhenPlayed != null ? gradeForWinRate(winRateWhenPlayed) : null,
      };
    })
    .filter((c) => c.winRateWhenPlayed != null && c.domain != null && c.set != null)
    .sort((a, b) => b.winRateWhenPlayed! - a.winRateWhenPlayed!);

  const sets = Array.from(new Set(rows.map((r) => r.set as string)))
    .sort()
    .map((code) => ({ code, name: SET_NAMES[code] ?? code }));

  return { cards: rows, sets };
}

// --- Matriz de matchups (estilo "counter matrix" de blitz.gg/u.gg) ------------------------
//
// Mismo pool de Legends en filas y columnas: la celda (fila=A, columna=B) es el win rate de A
// contra B. Con las dos perspectivas ya combinadas (ver `bothPerspectives` más arriba), cada
// partida aporta un punto de datos a la celda (A,B) y otro a la (B,A) — no hace falta lógica
// extra aquí, ya llega así en la lista de perspectivas.

// Intervalo de confianza de Wilson (95%) para el win rate: con las muestras pequeñas de un
// tracker personal, "56%" solo no dice si son 5 partidas o 500 — el rango sí. Mismo estilo que
// las tablas de counters de blitz.gg/u.gg.
function wilsonInterval(wins: number, losses: number, z = 1.96): { low: number; high: number } | null {
  const n = wins + losses;
  if (n === 0) return null;
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

export interface MatchupMatrixLegend {
  name: string;
  image: string | null;
  games: number;
  wins: number;
  losses: number;
  winRate: number | null;
  ciLow: number | null;
  ciHigh: number | null;
}

export interface MatchupMatrixCellBattlefield {
  cardName: string;
  cardImage: string | null;
  games: number;
  wins: number;
  losses: number;
  winRate: number | null;
}

export interface MatchupMatrixCell {
  row: string;
  col: string;
  games: number;
  wins: number;
  losses: number;
  winRate: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  // El battlefield que llevaba la Legend de la fila en cada una de esas partidas (el propio,
  // no el del rival — para responder "con qué battlefield me ha ido bien/mal este matchup").
  // Una partida con más de un battlefield en juego cuenta en cada uno. Solo tiene sentido
  // filtrado por on the play/on the draw (ver README del hover en la web); en la vista Global
  // se calcula igual pero mezclaría partidas muy distintas entre sí.
  battlefields: MatchupMatrixCellBattlefield[];
}

export function computeMatchupMatrix(perspectives: PerspectiveMatch[]): { legends: MatchupMatrixLegend[]; cells: MatchupMatrixCell[] } {
  const legendTotals = new Map<string, { wins: number; losses: number; image: string | null }>();
  type CellTotal = { wins: number; losses: number; battlefields: Map<string, { cardImage: string | null; wins: number; losses: number }> };
  const cellTotals = new Map<string, CellTotal>();

  for (const p of perspectives) {
    if (!p.legendName || !p.opponentLegendName) continue;

    if (!legendTotals.has(p.legendName)) legendTotals.set(p.legendName, { wins: 0, losses: 0, image: null });
    const lt = legendTotals.get(p.legendName)!;
    if (p.result === "WIN") lt.wins++;
    else if (p.result === "LOSS") lt.losses++;
    if (!lt.image && p.localDeck) {
      try {
        const deck = JSON.parse(p.localDeck);
        if (deck?.legendImage) lt.image = deck.legendImage;
      } catch {
        // sin imagen para esta perspectiva, se intenta con la siguiente partida
      }
    }

    const key = `${p.legendName}__${p.opponentLegendName}`;
    if (!cellTotals.has(key)) cellTotals.set(key, { wins: 0, losses: 0, battlefields: new Map() });
    const ct = cellTotals.get(key)!;
    if (p.result === "WIN") ct.wins++;
    else if (p.result === "LOSS") ct.losses++;

    for (const bf of p.battlefields) {
      if (!bf.cardName) continue;
      if (!ct.battlefields.has(bf.cardName)) ct.battlefields.set(bf.cardName, { cardImage: bf.cardImage, wins: 0, losses: 0 });
      const bfTotal = ct.battlefields.get(bf.cardName)!;
      if (p.result === "WIN") bfTotal.wins++;
      else if (p.result === "LOSS") bfTotal.losses++;
    }
  }

  const legends = Array.from(legendTotals.entries())
    .map(([name, t]): MatchupMatrixLegend => {
      const ci = wilsonInterval(t.wins, t.losses);
      return {
        name,
        image: t.image,
        games: t.wins + t.losses,
        wins: t.wins,
        losses: t.losses,
        winRate: winLoss(t.wins, t.losses),
        ciLow: ci?.low ?? null,
        ciHigh: ci?.high ?? null,
      };
    })
    .sort((a, b) => b.games - a.games);

  const cells = Array.from(cellTotals.entries()).map(([key, t]): MatchupMatrixCell => {
    const sep = key.indexOf("__");
    const row = key.slice(0, sep);
    const col = key.slice(sep + 2);
    const ci = wilsonInterval(t.wins, t.losses);
    const battlefields = Array.from(t.battlefields.entries())
      .map(([cardName, b]): MatchupMatrixCellBattlefield => ({
        cardName,
        cardImage: b.cardImage,
        games: b.wins + b.losses,
        wins: b.wins,
        losses: b.losses,
        winRate: winLoss(b.wins, b.losses),
      }))
      .sort((a, b) => b.games - a.games);
    return {
      row,
      col,
      games: t.wins + t.losses,
      wins: t.wins,
      losses: t.losses,
      winRate: winLoss(t.wins, t.losses),
      ciLow: ci?.low ?? null,
      ciHigh: ci?.high ?? null,
      battlefields,
    };
  });

  return { legends, cells };
}
