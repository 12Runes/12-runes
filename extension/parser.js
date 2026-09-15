// Clasifica un envelope ya decodificado (objeto JS, salida de binarypack unpack()) del
// protocolo interno de TCG Arena para el canal "game". Basado en observación real de una
// partida de Riftbound capturada con extension-spike/ (ver ../README.md).
//
// Formas de payload de GAME_DATA vistas: decklist, playerData, newToHistory,
// currentPlayer+turnCount, endTurnInfo, revealed, hostCardZonesOrder, cardsLinks,
// stackCardAccept, isTyping, ping. De ahí, relevantes para reconstruir una partida: las cinco
// primeras (`playerData` incluye además `visibleCards`, de donde sale qué battlefield está en
// juego — ver `extractBattlefields`); el resto es estado de tablero/UI que no necesitamos.
export function classifyEnvelope(value, direction) {
  if (!value || typeof value !== "object" || value.type !== "GAME_DATA") return { kind: "ignore" };

  const payload = value.payload;
  if (!payload || typeof payload !== "object") return { kind: "ignore" };

  if ("decklist" in payload) {
    return { kind: "decklist", direction, decklist: payload.decklist };
  }
  if ("playerData" in payload) {
    const pd = payload.playerData ?? {};
    const profile = pd.profileData ?? {};
    return {
      kind: "player-data",
      direction,
      pseudo: profile.pseudo ?? null,
      playerId: profile.playerId ?? null,
      isEliminated: pd.isEliminated ?? null,
      battlefields: extractBattlefields(pd.visibleCards),
    };
  }
  if ("newToHistory" in payload) {
    return { kind: "history", direction, entry: payload.newToHistory };
  }
  if ("currentPlayer" in payload && "turnCount" in payload) {
    return { kind: "turn", currentPlayer: payload.currentPlayer, turnCount: payload.turnCount };
  }
  if ("endTurnInfo" in payload) {
    return { kind: "end-turn", info: payload.endTurnInfo };
  }
  if ("gameOptions" in payload) {
    // Se emite una vez por cada "Start the game": al empezar la conexión Y cada vez que el
    // host pulsa "Start new game"/"Restart with the same decks" dentro de la MISMA conexión
    // (un Bo3 no cierra el canal WebRTC entre partidas). isRestart distingue la primera
    // partida (false/ausente) de las siguientes de la misma serie (true).
    return { kind: "game-options", isRestart: payload.gameOptions?.isRestart === true };
  }
  return { kind: "ignore" };
}

// `playerData.visibleCards` trae, entre todas las cartas visibles de la partida (mano, mazo,
// zonas...), la carta que está actualmente en la zona "Battlefields" — con `owner` (el id de
// partida del jugador, el mismo que usa `newToHistory.playerId`/`.player`, así que se cruza con
// `resolveGamePlayerIds` en background.js) y los datos de la carta en sí. Puede haber más de
// un battlefield en juego a la vez o cambiar a lo largo de la partida (p. ej. si se revela uno
// nuevo), así que se devuelven todos los que aparezcan en este mensaje, no solo el primero.
function extractBattlefields(visibleCards) {
  if (!Array.isArray(visibleCards)) return [];
  const out = [];
  for (const c of visibleCards) {
    if (c?.position?.section !== "Battlefields") continue;
    const cardData = c.cardData ?? {};
    out.push({
      id: c.id ?? null,
      owner: c.owner ?? null,
      cardId: cardData.id ?? null,
      cardName: cardData.name?.en ?? cardData.face?.front?.name?.en ?? null,
      cardImage: cardData.face?.front?.image?.en ?? null,
    });
  }
  return out;
}

// Orden cronológico de sets/expansiones (el último es el más reciente). Cada carta del
// catálogo trae `_legal: { OGN: true, ... }` marcando en qué formatos es legal ahora mismo —
// es la misma bandera que TCG Arena usa para el desplegable "Choose Format" del deckbuilder
// ("Standard (Vendetta)", "Legacy (Unleashed)"...). La "season" activa de una partida se toma
// como el set más reciente marcado legal en cualquier carta del mazo.
const SET_CHRONO_ORDER = ["OGN", "OGS", "SFD", "UNL", "VEN"];

function deriveSeason(decklist) {
  let best = null;
  let bestRank = -1;
  for (const cat of ["Legend", "Chosen_Champion", "Battlefields", "Runes", "Spell", "Unit"]) {
    const list = decklist[cat];
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      const legal = c?._legal;
      if (!legal || typeof legal !== "object") continue;
      for (const code of Object.keys(legal)) {
        if (!legal[code]) continue;
        const rank = SET_CHRONO_ORDER.indexOf(code);
        if (rank > bestRank) {
          bestRank = rank;
          best = code;
        }
      }
    }
  }
  return best;
}

// Reduce un decklist completo (con imágenes bilingües por carta) a algo compacto para
// identificar el Legend / Chosen Champion en las estadísticas, conservando el resto de
// categorías como listas de {id, count} para poder cruzar "mejores cartas por matchup" más
// adelante sin guardar el catálogo de cartas entero en cada partida.
export function summarizeDeck(decklist) {
  if (!decklist || typeof decklist !== "object") return null;

  const pickCard = (cat) => {
    const list = decklist[cat];
    return Array.isArray(list) && list[0] ? list[0] : null;
  };

  // Battlefields/Runes/Spell/Unit sí traen la carta completa (nombre, coste, imagen);
  // Sideboard solo trae {id, count}, así que ahí no hay imagen que conservar.
  const toCompactList = (cat) => {
    const list = decklist[cat];
    if (!Array.isArray(list)) return [];
    return list.map((c) => ({
      id: c.id,
      count: c.count ?? 1,
      name: c.name?.en ?? c.face?.front?.name?.en ?? null,
      type: c.type ?? c.face?.front?.type ?? null,
      cost: c.cost ?? c.face?.front?.cost ?? null,
      image: c.face?.front?.image?.en ?? null,
    }));
  };

  const legend = pickCard("Legend");
  const champion = pickCard("Chosen_Champion");

  return {
    legendId: legend?.id ?? null,
    legendName: legend?.name?.en ?? legend?.face?.front?.name?.en ?? null,
    legendImage: legend?.face?.front?.image?.en ?? null,
    championId: champion?.id ?? null,
    championName: champion?.name?.en ?? champion?.face?.front?.name?.en ?? null,
    championImage: champion?.face?.front?.image?.en ?? null,
    season: deriveSeason(decklist),
    battlefields: toCompactList("Battlefields"),
    runes: toCompactList("Runes"),
    spells: toCompactList("Spell"),
    units: toCompactList("Unit"),
    sideboard: toCompactList("Sideboard"),
  };
}

export function summarizeHistoryEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  return {
    id: entry.id ?? null,
    playerId: entry.playerId ?? null,
    player: entry.player ?? null,
    text: entry.text ?? null,
    type: entry.type ?? null,
    timestamp: entry.timestamp ?? null,
    params: summarizeHistoryParams(entry.params),
  };
}

// Los params de un cardMove traen la carta completa (posición, imágenes bilingües...).
// Para el log de eventos solo nos interesa qué carta e id de partida, no el resto del tablero.
function summarizeHistoryParams(params) {
  if (!params || typeof params !== "object") return params ?? null;
  if (params.card && typeof params.card === "object") {
    const card = params.card;
    const cardData = card.cardData ?? {};
    return {
      ...params,
      card: {
        id: card.id,
        owner: card.owner,
        section: card.position?.section ?? null,
        cardId: cardData.id ?? null,
        cardName: cardData.name?.en ?? cardData.face?.front?.name?.en ?? null,
        cardType: cardData.type ?? cardData.face?.front?.type ?? null,
        cardImage: cardData.face?.front?.image?.en ?? null,
      },
    };
  }
  return params;
}
