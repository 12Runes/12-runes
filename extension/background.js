import { unpack } from "./vendor/binarypack.mjs";
import { classifyEnvelope, summarizeDeck, summarizeHistoryEntry } from "./parser.js";

// Buffers de reensamblado de chunks WebRTC (>16KB se fragmentan). Solo en memoria: viven
// unos milisegundos mientras llegan los trozos, así que perderlos si el service worker se
// suspende a mitad de un mensaje grande es un riesgo aceptable para esta primera versión.
const chunkBuffers = new Map();

// chrome.runtime.onMessage dispara un handler async por cada mensaje sin esperar al
// anterior: durante una ráfaga (varias acciones seguidas, o los chunks de un decklist)
// varios handlers hacían getState -> mutar -> setState en paralelo y se pisaban las
// escrituras entre sí (el último en escribir ganaba y el resto se perdía en silencio).
// Serializamos aquí todo lo que toca el estado de una pestaña para que cada mensaje se
// procese de principio a fin antes de empezar el siguiente.
const tabQueues = new Map();
function runExclusive(tabId, fn) {
  const prev = tabQueues.get(tabId) ?? Promise.resolve();
  const next = prev.then(fn, fn).catch((err) => console.error("[riftbound-tracker]", err));
  tabQueues.set(tabId, next);
  return next;
}

function freshState() {
  return {
    channelState: "idle", // idle | awaiting-consent | recording | ended-awaiting-save | declined
    seriesId: null, // agrupa las partidas de un mismo Bo3 (misma conexión WebRTC)
    gameNumber: 1, // Game 1, 2, 3... dentro de la serie
    localPlayerId: null,
    opponentPlayerId: null,
    localPseudo: null,
    opponentPseudo: null,
    localEliminated: null,
    opponentEliminated: null,
    guessedResult: null,
    match: null, // { startedAt, turnCount, firstTurnPlayerId, localDeck, opponentDeck, events: [] }
    pendingBuffer: [],
    pendingSaves: [], // partidas anteriores de la serie ya terminadas, a la espera de que confirmes el resultado
  };
}

async function getState(tabId) {
  const key = `match:${tabId}`;
  const stored = await chrome.storage.session.get({ [key]: null });
  return stored[key] ?? freshState();
}

async function setState(tabId, state) {
  await chrome.storage.session.set({ [`match:${tabId}`]: state });
}

async function clearState(tabId) {
  await chrome.storage.session.remove(`match:${tabId}`);
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function toU8(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (x && x.buffer instanceof ArrayBuffer) return new Uint8Array(x.buffer, x.byteOffset ?? 0, x.byteLength);
  return new Uint8Array(0);
}

function concatU8(parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function applyClassified(state, c) {
  switch (c.kind) {
    case "decklist": {
      const summary = summarizeDeck(c.decklist);
      if (c.direction === "outgoing") state.match.localDeck = summary;
      else state.match.opponentDeck = summary;
      break;
    }
    case "player-data": {
      const isLocal = c.direction === "outgoing";
      if (isLocal) {
        if (c.playerId) state.localPlayerId = c.playerId;
        if (c.pseudo) state.localPseudo = c.pseudo;
        if (c.isEliminated != null) state.localEliminated = c.isEliminated;
      } else {
        if (c.playerId) state.opponentPlayerId = c.playerId;
        if (c.pseudo) state.opponentPseudo = c.pseudo;
        if (c.isEliminated != null) state.opponentEliminated = c.isEliminated;
      }
      break;
    }
    case "history": {
      state.match.events.push({ eventType: "history", ...summarizeHistoryEntry(c.entry) });
      break;
    }
    case "turn": {
      state.match.turnCount = c.turnCount;
      if (c.turnCount === 1 && !state.match.firstTurnPlayerId) state.match.firstTurnPlayerId = c.currentPlayer;
      state.match.events.push({ eventType: "turn", currentPlayer: c.currentPlayer, turnCount: c.turnCount, ts: Date.now() });
      break;
    }
    case "end-turn": {
      state.match.events.push({ eventType: "end-turn", ...c.info, ts: Date.now() });
      break;
    }
  }
}

function guessResult(state) {
  if (state.opponentEliminated === true && state.localEliminated !== true) return "WIN";
  if (state.localEliminated === true && state.opponentEliminated !== true) return "LOSS";
  return "UNKNOWN";
}

function buildSummary(state) {
  return {
    opponentPseudo: state.opponentPseudo,
    turnCount: state.match?.turnCount ?? null,
    localLegend: state.match?.localDeck?.legendName ?? null,
    opponentLegend: state.match?.opponentDeck?.legendName ?? null,
  };
}

// `state.localPlayerId`/`opponentPlayerId` vienen de los mensajes `playerData` y usan el id
// de conexión (prefijo "TCGA-"). Pero los eventos de `newToHistory` (y por tanto `turnCount`
// / quién empieza) usan un id de partida distinto, sin ese prefijo. Para poder cruzar
// "quién jugó esta carta" o "quién empezó" con "soy yo", resolvemos el id de partida real
// buscando en el propio log de eventos el primer autor cuyo pseudo coincide con el nuestro.
function resolveGamePlayerIds(state) {
  let localId = null;
  let opponentId = null;
  for (const e of state.match.events) {
    if (e.eventType !== "history" || !e.playerId) continue;
    if (!localId && e.player === state.localPseudo) localId = e.playerId;
    if (!opponentId && e.player === state.opponentPseudo) opponentId = e.playerId;
    if (localId && opponentId) break;
  }
  return { localId, opponentId };
}

function computeOnThePlay(state, localGameId, opponentGameId) {
  const firstPlayerId = state.match.firstTurnPlayerId;
  if (!firstPlayerId) return null;
  if (firstPlayerId === localGameId) return true;
  if (firstPlayerId === opponentGameId) return false;
  return null;
}

function buildMatchRecord(state, result) {
  const { localId, opponentId } = resolveGamePlayerIds(state);
  return {
    gameName: "Riftbound",
    seriesId: state.seriesId,
    gameNumber: state.gameNumber,
    startedAt: state.match.startedAt,
    endedAt: Date.now(),
    result,
    turnCount: state.match.turnCount,
    onThePlay: computeOnThePlay(state, localId, opponentId),
    localPlayerId: localId ?? state.localPlayerId,
    localPseudo: state.localPseudo,
    opponentPlayerId: opponentId ?? state.opponentPlayerId,
    opponentPseudo: state.opponentPseudo,
    // Propiedad de la sala, no de cada lado — si por lo que sea no se pudo derivar del propio
    // mazo (p. ej. el decklist del rival llegó incompleto), se cae al del rival.
    season: state.match.localDeck?.season ?? state.match.opponentDeck?.season ?? null,
    localDeck: state.match.localDeck,
    opponentDeck: state.match.opponentDeck,
    events: state.match.events,
  };
}

function freshGame(previousMatch) {
  return {
    startedAt: Date.now(),
    turnCount: null,
    firstTurnPlayerId: null,
    // El mazo no cambia entre partidas de la misma serie salvo que llegue un decklist nuevo
    // (p. ej. si en vez de "Restart with the same decks" se elige otro mazo distinto).
    localDeck: previousMatch?.localDeck ?? null,
    opponentDeck: previousMatch?.opponentDeck ?? null,
    events: [],
  };
}

async function processDecodedValue(tabId, direction, value) {
  const classified = classifyEnvelope(value, direction);
  if (classified.kind === "ignore") return;

  const state = await getState(tabId);
  if (state.channelState === "awaiting-consent") {
    state.pendingBuffer.push(classified);
    if (state.pendingBuffer.length > 500) state.pendingBuffer.shift();
    await setState(tabId, state);
    return;
  }
  if (state.channelState !== "recording") return;

  if (classified.kind === "game-options" && classified.isRestart) {
    await handleGameRestart(tabId, state);
    return;
  }

  applyClassified(state, classified);
  await setState(tabId, state);
}

// TCG Arena no cierra el canal WebRTC entre partidas de un mismo Bo3: al pulsar "Start new
// game"/"Restart with the same decks" dentro de la misma conexión llega un GAME_DATA con
// payload.gameOptions.isRestart = true. En vez de esperar a que cierre el canal para pedir
// el resultado, cerramos la partida actual ya mismo (a la espera de que confirmes el
// resultado) y empezamos a grabar la siguiente sin cortar.
async function handleGameRestart(tabId, state) {
  const finishedGameNumber = state.gameNumber;
  const guessedResult = guessResult(state);
  const record = buildMatchRecord(state, guessedResult);
  const summary = buildSummary(state);

  const pendingId = crypto.randomUUID();
  state.pendingSaves.push({ id: pendingId, record });

  state.gameNumber = finishedGameNumber + 1;
  state.localEliminated = null;
  state.opponentEliminated = null;
  state.match = freshGame(state.match);

  await setState(tabId, state);
  chrome.tabs
    .sendMessage(tabId, {
      type: "series-game-finished",
      pendingId,
      finishedGameNumber,
      guessedResult,
      newGameNumber: state.gameNumber,
      summary,
    })
    .catch(() => {});
}

async function handleChunk(tabId, direction, chunkMsg) {
  const key = `${tabId}:${direction}:${chunkMsg.__peerData}`;
  let group = chunkBuffers.get(key);
  if (!group) {
    group = { total: chunkMsg.total, chunks: new Map() };
    chunkBuffers.set(key, group);
  }
  group.chunks.set(chunkMsg.n, toU8(chunkMsg.data));

  if (group.chunks.size < group.total) return;
  chunkBuffers.delete(key);

  const parts = [];
  for (let i = 0; i < group.total; i++) parts.push(group.chunks.get(i));
  if (parts.some((p) => !p)) return; // hueco real, descartamos el mensaje

  const merged = concatU8(parts);
  let value;
  try {
    value = unpack(merged.buffer);
  } catch {
    return;
  }
  await processDecodedValue(tabId, direction, value);
}

async function onRawMessage(tabId, payload) {
  let value;
  if (payload.data.kind === "arraybuffer") {
    try {
      value = unpack(base64ToArrayBuffer(payload.data.base64));
    } catch {
      return;
    }
  } else if (payload.data.kind === "string") {
    value = payload.data.value;
  } else {
    return;
  }

  if (value && typeof value === "object" && "__peerData" in value) {
    await handleChunk(tabId, payload.direction, value);
    return;
  }
  await processDecodedValue(tabId, payload.direction, value);
}

async function onChannelOpen(tabId) {
  const state = freshState();
  state.channelState = "awaiting-consent";
  state.seriesId = crypto.randomUUID();
  await setState(tabId, state);
  chrome.tabs.sendMessage(tabId, { type: "show-consent-prompt" }).catch(() => {});
}

// Antes, al cerrarse la conexión, se pedía el resultado de la última partida con un panel
// aparte Y, en el mismo instante, se subían ya como "UNKNOWN" las partidas anteriores de la
// serie que seguían sin confirmar — sin darle tiempo real al usuario a contestar (el panel de
// confirmación se sustituía por el de guardado final antes de que pudiera pulsar nada). Ahora
// la última partida se trata exactamente igual que las anteriores: se añade a `pendingSaves` y
// se manda TODA la lista junta en un solo mensaje, así el panel muestra una tarjeta por cada
// partida de la serie sin confirmar (incluida la que acaba de terminar) y nada se sube hasta
// que el usuario elige un resultado para cada una.
async function onChannelClose(tabId) {
  const state = await getState(tabId);
  if (state.channelState === "recording") {
    const guessedResult = guessResult(state);
    const record = buildMatchRecord(state, guessedResult);
    state.pendingSaves.push({ id: crypto.randomUUID(), record });
    state.channelState = "closed";
    state.match = null;
    await setState(tabId, state);
    chrome.tabs
      .sendMessage(tabId, {
        type: "series-ended",
        pendingGames: state.pendingSaves.map((p) => ({
          pendingId: p.id,
          finishedGameNumber: p.record.gameNumber,
          guessedResult: p.record.result,
          summary: {
            opponentPseudo: p.record.opponentPseudo,
            turnCount: p.record.turnCount,
            localLegend: p.record.localDeck?.legendName ?? null,
            opponentLegend: p.record.opponentDeck?.legendName ?? null,
          },
        })),
      })
      .catch(() => {});
    return;
  }

  if (state.channelState === "awaiting-consent") {
    await clearState(tabId);
    chrome.tabs.sendMessage(tabId, { type: "hide-overlay" }).catch(() => {});
    return;
  }

  // Red de seguridad para estados que no deberían darse en el flujo normal (p. ej. la conexión
  // se cierra dos veces, o queda algo huérfano de una versión anterior): no lo perdemos en
  // silencio, se guarda como resultado desconocido en vez de desaparecer.
  if (state.pendingSaves.length > 0) {
    for (const pending of state.pendingSaves) await uploadAndStore(pending.record, "UNKNOWN");
    await clearState(tabId);
  }
}

async function handleConsent(tabId, answer) {
  const state = await getState(tabId);
  if (state.channelState !== "awaiting-consent") return;

  if (answer === "yes") {
    state.channelState = "recording";
    state.match = freshGame(null);
    const pending = state.pendingBuffer;
    state.pendingBuffer = [];
    for (const c of pending) applyClassified(state, c);
    await setState(tabId, state);
    chrome.tabs.sendMessage(tabId, { type: "show-recording-indicator", gameNumber: state.gameNumber }).catch(() => {});
  } else {
    await clearState(tabId);
    chrome.tabs.sendMessage(tabId, { type: "hide-overlay" }).catch(() => {});
  }
}

// Id anónimo por instalación (no identifica a la persona) para poder separar "mis partidas"
// de las de otras instalaciones cuando varias apuntan al mismo backend compartido.
async function getContributorId() {
  const { contributorId } = await chrome.storage.local.get({ contributorId: null });
  if (contributorId) return contributorId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ contributorId: id });
  return id;
}

async function uploadAndStore(recordWithoutResult, result) {
  const record = { ...recordWithoutResult, result, contributorId: await getContributorId() };
  const { backendUrl } = await chrome.storage.local.get({ backendUrl: "http://localhost:4000" });

  let uploaded = false;
  let error = null;
  try {
    const res = await fetch(`${backendUrl}/matches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
    uploaded = res.ok;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = String(err);
  }

  const { matches } = await chrome.storage.local.get({ matches: [] });
  matches.unshift({ ...record, uploaded, error, savedAt: Date.now() });
  await chrome.storage.local.set({ matches: matches.slice(0, 200) });
  return { uploaded, error };
}

// Confirma el resultado de una partida de la serie (incluida la última, ver `onChannelClose`)
// mientras otras siguen pendientes o ya se está grabando la siguiente: no toca `state.match`,
// solo quita ese pendiente concreto y lo sube. Si era el último pendiente y ya no se está
// grabando nada más, limpia el estado de la pestaña entero.
async function handleConfirmSeriesGame(tabId, pendingId, result) {
  const state = await getState(tabId);
  const idx = state.pendingSaves.findIndex((p) => p.id === pendingId);
  if (idx === -1) return;

  const [pending] = state.pendingSaves.splice(idx, 1);
  const wasLastPending = state.pendingSaves.length === 0 && state.channelState !== "recording";
  await setState(tabId, state);

  const { uploaded, error } = await uploadAndStore(pending.record, result);
  chrome.tabs.sendMessage(tabId, { type: "series-game-saved", pendingId, uploaded, error }).catch(() => {});

  if (wasLastPending) await clearState(tabId);
}

// Descarta (no sube) una partida concreta de la serie sin tocar el resto de pendientes ni la
// que se esté grabando ahora mismo.
async function handleDiscard(tabId, pendingId) {
  const state = await getState(tabId);
  const idx = state.pendingSaves.findIndex((p) => p.id === pendingId);
  if (idx === -1) return;

  state.pendingSaves.splice(idx, 1);
  const wasLastPending = state.pendingSaves.length === 0 && state.channelState !== "recording";
  await setState(tabId, state);

  chrome.tabs.sendMessage(tabId, { type: "series-game-discarded", pendingId }).catch(() => {});
  if (wasLastPending) await clearState(tabId);
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;
  if (tabId == null || !msg?.type) return;

  if (msg.type === "capture") {
    const entry = msg.entry;
    if (entry.type === "datachannel-open") runExclusive(tabId, () => onChannelOpen(tabId));
    else if (entry.type === "datachannel-close") runExclusive(tabId, () => onChannelClose(tabId));
    else if (entry.type === "datachannel-message") runExclusive(tabId, () => onRawMessage(tabId, entry.payload));
    return;
  }
  if (msg.type === "consent-response") runExclusive(tabId, () => handleConsent(tabId, msg.answer));
  else if (msg.type === "discard-match") runExclusive(tabId, () => handleDiscard(tabId, msg.pendingId));
  else if (msg.type === "confirm-series-game") runExclusive(tabId, () => handleConfirmSeriesGame(tabId, msg.pendingId, msg.result));
});

// Si la pestaña se cierra con partidas de la serie sin confirmar, ya no hay a quién
// preguntarle: se suben como resultado desconocido en vez de perderse.
chrome.tabs.onRemoved.addListener((tabId) => {
  runExclusive(tabId, async () => {
    const state = await getState(tabId);
    for (const pending of state.pendingSaves) await uploadAndStore(pending.record, "UNKNOWN");
    await clearState(tabId);
    tabQueues.delete(tabId);
  });
});
