import { fileURLToPath } from "url";
import path from "path";
import { readFileSync, readdirSync } from "fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import staticPlugin from "@fastify/static";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaLibSQL } from "@prisma/adapter-libsql";
import { createClient } from "@libsql/client";
import {
  computeCardStats,
  computeDeckClusters,
  clusterMemberSignatures,
  computeDeckSignature,
  computeCardGrades,
  computeMatchFingerprint,
  bothPerspectives,
  perspectivesForLegend,
  computeMatchupMatrix,
  SET_NAMES,
} from "./stats.js";

// Mismo orden cronológico que `SET_CHRONO_ORDER` en extension/parser.js — se usa para listar
// las seasons de más reciente a más antigua.
const SET_CHRONO_ORDER = ["OGN", "OGS", "SFD", "UNL", "VEN"];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// TURSO_DATABASE_URL/TURSO_AUTH_TOKEN apuntan a la base de producción (ver README); en local,
// sin esas variables, cae en prisma/dev.db. Se resuelve como ruta absoluta (no relativa al cwd
// del proceso) porque @libsql/client, a diferencia del motor nativo de Prisma, no la interpreta
// relativa a schema.prisma.
const localDbUrl = "file:" + fileURLToPath(new URL("../prisma/dev.db", import.meta.url));
const libsqlClient = createClient({
  url: process.env.TURSO_DATABASE_URL ?? localDbUrl,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const prisma = new PrismaClient({ adapter: new PrismaLibSQL(libsqlClient) });

// `prisma migrate deploy` no entiende URLs `libsql://` en esta versión de Prisma (necesitaría
// prisma.config.ts + adapters en migrate, no solo en el cliente). En vez de aplicar cada
// migración a mano contra Turso, el propio servidor las aplica al arrancar, con el mismo
// libsqlClient que ya usa para todo lo demás — así un `git push` basta para que producción
// tenga el esquema al día, sin tocar credenciales de Turso fuera de esta app. Tolera "ya
// existe" porque esta base puede traer migraciones aplicadas a mano en el pasado (antes de que
// existiera este runner) sin el historial de qué se aplicó.
async function runPendingMigrations() {
  const migrationsDir = fileURLToPath(new URL("../prisma/migrations", import.meta.url));
  const folders = readdirSync(migrationsDir)
    .filter((f) => f !== "migration_lock.toml")
    .sort();
  for (const folder of folders) {
    const sql = readFileSync(path.join(migrationsDir, folder, "migration.sql"), "utf8");
    try {
      await libsqlClient.executeMultiple(sql);
      console.log(`[migrate] applied ${folder}`);
    } catch (err: any) {
      if (/already exists|duplicate column/i.test(String(err?.message ?? err))) continue;
      throw err;
    }
  }
}
await runPendingMigrations();

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(staticPlugin, { root: path.join(__dirname, "..", "..", "web") });

const VALID_RESULTS = new Set(["WIN", "LOSS", "UNKNOWN"]);

// Filtro opcional por instalación: con `contributor` presente, todas las stats se limitan a
// esa persona ("mis partidas"); sin él, se agregan las de todo el backend ("comunidad"). El
// pseudo del rival nunca sale de aquí en ninguno de los dos casos: ningún endpoint de stats
// selecciona `opponentPseudo`/`localPseudo`, solo Legend/carta/mazo (ver README, "Privacidad").
function contributorWhere(query: { contributor?: string }) {
  return query.contributor ? { contributorId: query.contributor } : {};
}

// Columnas necesarias para reconstruir las dos perspectivas de una partida (ver
// `toPerspective` en stats.ts): con esto de sobra, cada endpoint de stats puede minar tanto mi
// lado como el del rival sin una segunda consulta.
const PERSPECTIVE_SELECT = {
  id: true,
  result: true,
  onThePlay: true,
  localPlayerId: true,
  opponentPlayerId: true,
  events: true,
  localDeck: true,
  opponentDeck: true,
  localBattlefields: true,
  opponentBattlefields: true,
  localLegendName: true,
  opponentLegendName: true,
  startedAt: true,
} as const;

app.post("/matches", async (request, reply) => {
  const body = request.body as any;

  if (!body || typeof body !== "object") return reply.code(400).send({ error: "invalid body" });
  if (!body.startedAt) return reply.code(400).send({ error: "startedAt is required" });
  const result = VALID_RESULTS.has(body.result) ? body.result : "UNKNOWN";

  // Si el rival ya grabó esta misma partida por su lado, su subida ya trae el log completo de
  // los dos jugadores (ver README, "cada partida cuenta el doble") — la nuestra no aportaría
  // nada nuevo y solo duplicaría cada estadística. `matchFingerprint` es la misma huella para
  // ambos lados (viene del propio log del motor del juego, no de nada que genere cada
  // instalación por su cuenta), así que la restricción @unique del esquema es la que de verdad
  // evita la carrera si las dos subidas llegan a la vez; aquí solo detectamos el caso limpio.
  const matchFingerprint = computeMatchFingerprint(body.events);

  const data = {
    gameName: body.gameName ?? "Riftbound",
    contributorId: typeof body.contributorId === "string" ? body.contributorId : null,
    seriesId: typeof body.seriesId === "string" ? body.seriesId : null,
    gameNumber: typeof body.gameNumber === "number" ? body.gameNumber : null,
    startedAt: new Date(body.startedAt),
    endedAt: body.endedAt ? new Date(body.endedAt) : null,
    result,
    turnCount: body.turnCount ?? null,
    onThePlay: typeof body.onThePlay === "boolean" ? body.onThePlay : null,
    localPlayerId: body.localPlayerId ?? null,
    localPseudo: body.localPseudo ?? null,
    opponentPlayerId: body.opponentPlayerId ?? null,
    opponentPseudo: body.opponentPseudo ?? null,
    localLegendId: body.localDeck?.legendId ?? null,
    localLegendName: body.localDeck?.legendName ?? null,
    opponentLegendId: body.opponentDeck?.legendId ?? null,
    opponentLegendName: body.opponentDeck?.legendName ?? null,
    season: typeof body.season === "string" ? body.season : null,
    localDeck: body.localDeck ? JSON.stringify(body.localDeck) : null,
    opponentDeck: body.opponentDeck ? JSON.stringify(body.opponentDeck) : null,
    localBattlefields: Array.isArray(body.localBattlefields) && body.localBattlefields.length > 0 ? JSON.stringify(body.localBattlefields) : null,
    opponentBattlefields: Array.isArray(body.opponentBattlefields) && body.opponentBattlefields.length > 0 ? JSON.stringify(body.opponentBattlefields) : null,
    events: JSON.stringify(body.events ?? []),
    matchFingerprint,
  };

  try {
    const match = await prisma.match.create({ data });
    return reply.code(201).send({ id: match.id });
  } catch (err) {
    // El motor nativo de Prisma envuelve esto en un `PrismaClientKnownRequestError` con
    // code "P2002" de forma consistente, pero contra Turso (protocolo remoto, no el sqlite3
    // local) el driver adapter deja pasar el error crudo del motor ("SQLITE_CONSTRAINT: ...
    // UNIQUE constraint failed: Match.matchFingerprint") sin traducirlo — comprobado en vivo.
    // Por eso se detecta por texto en vez de por tipo/código, cubriendo las dos formas.
    const isFingerprintConflict =
      matchFingerprint &&
      ((err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") ||
        /matchfingerprint/i.test(String((err as any)?.message ?? err)));
    if (isFingerprintConflict) {
      const existing = await prisma.match.findUnique({ where: { matchFingerprint } });
      return reply.code(200).send({ id: existing?.id ?? null, duplicate: true });
    }
    throw err;
  }
});

app.get("/matches", async (request, reply) => {
  const query = request.query as { limit?: string; contributor?: string };
  // El log de partidas es siempre personal: nunca se sirve sin acotar a un contributorId,
  // para no exponer el pseudo de nadie (tuyo o del rival) a quien no sea tú.
  if (!query.contributor) return reply.code(400).send({ error: "contributor query param is required" });

  const limit = Math.min(Number(query.limit) || 50, 200);
  return prisma.match.findMany({
    where: { contributorId: query.contributor },
    orderBy: { startedAt: "desc" },
    take: limit,
    select: {
      id: true,
      startedAt: true,
      result: true,
      turnCount: true,
      onThePlay: true,
      localPseudo: true,
      opponentPseudo: true,
      localLegendName: true,
      opponentLegendName: true,
      seriesId: true,
      gameNumber: true,
    },
  });
});

app.get("/stats/legends", async (request) => {
  const query = request.query as { contributor?: string };
  const matches = await prisma.match.findMany({
    where: { OR: [{ localLegendName: { not: null } }, { opponentLegendName: { not: null } }], ...contributorWhere(query) },
    select: PERSPECTIVE_SELECT,
  });
  // Cada partida aporta dos puntos de datos: el mío (tal cual) y el del rival (mismo log de
  // eventos, resultado invertido) — ver `toPerspective` en stats.ts.
  const perspectives = bothPerspectives(matches).filter((p) => p.legendName != null);

  type LegendAgg = {
    legendName: string;
    games: number;
    wins: number;
    losses: number;
    unknown: number;
    onPlay: { games: number; wins: number; losses: number };
    onDraw: { games: number; wins: number; losses: number };
  };
  const byLegend = new Map<string, LegendAgg>();
  for (const p of perspectives) {
    const name = p.legendName as string;
    if (!byLegend.has(name))
      byLegend.set(name, {
        legendName: name,
        games: 0,
        wins: 0,
        losses: 0,
        unknown: 0,
        onPlay: { games: 0, wins: 0, losses: 0 },
        onDraw: { games: 0, wins: 0, losses: 0 },
      });
    const entry = byLegend.get(name)!;
    entry.games += 1;
    if (p.result === "WIN") entry.wins += 1;
    else if (p.result === "LOSS") entry.losses += 1;
    else entry.unknown += 1;

    const bucket = p.onThePlay === true ? entry.onPlay : p.onThePlay === false ? entry.onDraw : null;
    if (bucket) {
      bucket.games += 1;
      if (p.result === "WIN") bucket.wins += 1;
      else if (p.result === "LOSS") bucket.losses += 1;
    }
  }

  const winRate = (wins: number, losses: number) => (wins + losses > 0 ? wins / (wins + losses) : null);

  return Array.from(byLegend.values())
    .map((e) => ({
      ...e,
      winRate: winRate(e.wins, e.losses),
      onPlay: { ...e.onPlay, winRate: winRate(e.onPlay.wins, e.onPlay.losses) },
      onDraw: { ...e.onDraw, winRate: winRate(e.onDraw.wins, e.onDraw.losses) },
    }))
    .sort((a, b) => b.games - a.games);
});

app.get("/stats/cards", async (request, reply) => {
  const query = request.query as { legend?: string; opponent?: string; deck?: string; contributor?: string };
  if (!query.legend) return reply.code(400).send({ error: "legend query param is required" });

  // Trae las partidas donde esa Legend estuvo en cualquiera de los dos lados: local (la jugué
  // yo) u oponente (la jugó el rival) — `perspectivesForLegend` decide cuál de las dos (o las
  // dos, si fue mirror match) corresponde a cada partida.
  const matches = await prisma.match.findMany({
    where: { OR: [{ localLegendName: query.legend }, { opponentLegendName: query.legend }], ...contributorWhere(query) },
    select: PERSPECTIVE_SELECT,
  });

  let perspectives = perspectivesForLegend(matches, query.legend);
  if (query.opponent) perspectives = perspectives.filter((p) => p.opponentLegendName === query.opponent);

  if (query.deck) {
    // El arquetipo (cluster) se calcula sobre TODAS las perspectivas de la Legend, sin filtrar
    // por rival, para que la huella elegida en el desplegable de "Lista" resuelva siempre al
    // mismo conjunto de variantes independientemente del matchup que se esté mirando.
    const memberSignatures = clusterMemberSignatures(perspectivesForLegend(matches, query.legend), query.deck);
    perspectives = perspectives.filter((p) => {
      if (!p.localDeck) return false;
      let deck;
      try {
        deck = JSON.parse(p.localDeck);
      } catch {
        return false;
      }
      const sig = computeDeckSignature(deck);
      return sig != null && memberSignatures.has(sig);
    });
  }

  return computeCardStats(perspectives);
});

app.get("/stats/decks", async (request, reply) => {
  const query = request.query as { legend?: string; contributor?: string };
  if (!query.legend) return reply.code(400).send({ error: "legend query param is required" });

  const matches = await prisma.match.findMany({
    where: { OR: [{ localLegendName: query.legend }, { opponentLegendName: query.legend }], ...contributorWhere(query) },
    select: PERSPECTIVE_SELECT,
  });

  return computeDeckClusters(perspectivesForLegend(matches, query.legend));
});

app.get("/stats/matchups", async (request) => {
  const query = request.query as { contributor?: string };
  const matches = await prisma.match.findMany({
    where: { localLegendName: { not: null }, opponentLegendName: { not: null }, ...contributorWhere(query) },
    select: PERSPECTIVE_SELECT,
  });
  const perspectives = bothPerspectives(matches).filter((p) => p.legendName != null && p.opponentLegendName != null);

  const byMatchup = new Map<
    string,
    { localLegend: string; opponentLegend: string; games: number; wins: number; losses: number; unknown: number }
  >();
  for (const p of perspectives) {
    const key = `${p.legendName}__${p.opponentLegendName}`;
    if (!byMatchup.has(key))
      byMatchup.set(key, {
        localLegend: p.legendName as string,
        opponentLegend: p.opponentLegendName as string,
        games: 0,
        wins: 0,
        losses: 0,
        unknown: 0,
      });
    const entry = byMatchup.get(key)!;
    entry.games += 1;
    if (p.result === "WIN") entry.wins += 1;
    else if (p.result === "LOSS") entry.losses += 1;
    else entry.unknown += 1;
  }

  return Array.from(byMatchup.values())
    .map((e) => ({ ...e, winRate: e.wins + e.losses > 0 ? e.wins / (e.wins + e.losses) : null }))
    .sort((a, b) => b.games - a.games);
});

app.get("/stats/card-grades", async (request) => {
  const query = request.query as { legend?: string; contributor?: string };
  const matches = await prisma.match.findMany({
    where: {
      ...(query.legend ? { OR: [{ localLegendName: query.legend }, { opponentLegendName: query.legend }] } : {}),
      ...contributorWhere(query),
    },
    select: PERSPECTIVE_SELECT,
  });

  const perspectives = query.legend ? perspectivesForLegend(matches, query.legend) : bothPerspectives(matches);
  return computeCardGrades(perspectives);
});

// Seasons con al menos una partida grabada (filtrado por contributor si aplica), de más
// reciente a más antigua. Puramente derivado de lo que ya hay en la base de datos: en cuanto
// se juega y sube la primera partida de una season nueva, aparece aquí sola.
app.get("/stats/seasons", async (request) => {
  const query = request.query as { contributor?: string };
  const rows = await prisma.match.findMany({
    where: { season: { not: null }, ...contributorWhere(query) },
    select: { season: true },
    distinct: ["season"],
  });

  const codes = rows.map((r) => r.season as string);
  codes.sort((a, b) => {
    const ra = SET_CHRONO_ORDER.indexOf(a);
    const rb = SET_CHRONO_ORDER.indexOf(b);
    if (ra === -1 && rb === -1) return a.localeCompare(b);
    if (ra === -1) return 1;
    if (rb === -1) return -1;
    return rb - ra;
  });

  return codes.map((code) => ({ code, name: SET_NAMES[code] ?? code }));
});

app.get("/stats/matchup-matrix", async (request, reply) => {
  const query = request.query as { season?: string; contributor?: string; deck?: string; onThePlay?: string };
  if (!query.season) return reply.code(400).send({ error: "season query param is required" });

  const matches = await prisma.match.findMany({
    where: {
      season: query.season,
      localLegendName: { not: null },
      opponentLegendName: { not: null },
      ...contributorWhere(query),
    },
    select: PERSPECTIVE_SELECT,
  });

  let perspectives = bothPerspectives(matches).filter((p) => p.legendName != null && p.opponentLegendName != null);
  // Cada perspectiva ya trae su propio onThePlay invertido cuando corresponde (ver
  // toPerspective en stats.ts), así que filtrar aquí es correcto para las dos: "On the play"
  // enseña la matriz solo con las partidas donde la Legend de la FILA empezó la partida.
  if (query.onThePlay === "play") perspectives = perspectives.filter((p) => p.onThePlay === true);
  else if (query.onThePlay === "draw") perspectives = perspectives.filter((p) => p.onThePlay === false);
  if (query.deck) {
    perspectives = perspectives.filter((p) => {
      if (!p.localDeck) return false;
      let deck;
      try {
        deck = JSON.parse(p.localDeck);
      } catch {
        return false;
      }
      return computeDeckSignature(deck) === query.deck;
    });
  }

  return computeMatchupMatrix(perspectives);
});

const port = Number(process.env.PORT) || 4000;
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
