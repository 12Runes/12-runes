// Test automático del service worker (background.js), usando node:test — sin dependencias
// nuevas. Mockea chrome.storage.session/local, chrome.tabs.sendMessage/onRemoved,
// chrome.runtime.onMessage y fetch, y reimporta background.js con un query string distinto en
// cada test para que cada uno arranque con módulo fresco (tabQueues/chunkBuffers vacíos, y su
// propio listener registrado contra su propio mock).
//
// Cubre las cinco cosas que más veces se rompieron en producción durante el desarrollo de esta
// extensión: duplicados por pulsar "Play" varias veces, partidas falsas por poca actividad,
// que "Descartar partida" de verdad no suba nada, la red de seguridad manual de "La partida ya
// ha terminado", y que solo Gané/Perdí disparen una subida.
//
// Ejecutar con: node --test extension/background.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

let importSeq = 0;

function makeChromeMock() {
  const sessionStore = new Map();
  const localStore = new Map();
  const sentMessages = []; // { tabId, msg }
  let onMessageListener = null;
  let onRemovedListener = null;

  const chrome = {
    storage: {
      session: {
        async get(defaults) {
          const key = Object.keys(defaults)[0];
          return { [key]: sessionStore.has(key) ? sessionStore.get(key) : defaults[key] };
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v);
        },
        async remove(key) {
          sessionStore.delete(key);
        },
      },
      local: {
        async get(defaults) {
          const out = {};
          for (const k of Object.keys(defaults)) out[k] = localStore.has(k) ? localStore.get(k) : defaults[k];
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) localStore.set(k, v);
        },
      },
    },
    tabs: {
      sendMessage(tabId, msg) {
        sentMessages.push({ tabId, msg });
        return Promise.resolve();
      },
      onRemoved: {
        addListener(fn) {
          onRemovedListener = fn;
        },
      },
    },
    runtime: {
      onMessage: {
        addListener(fn) {
          onMessageListener = fn;
        },
      },
    },
  };

  return {
    chrome,
    sentMessages,
    lastMessageOfType(type) {
      return [...sentMessages].reverse().find((m) => m.msg.type === type)?.msg ?? null;
    },
    messagesOfType(type) {
      return sentMessages.filter((m) => m.msg.type === type).map((m) => m.msg);
    },
    dispatch(msg, tabId) {
      onMessageListener(msg, { tab: { id: tabId } });
    },
    removeTab(tabId) {
      return onRemovedListener?.(tabId);
    },
  };
}

// background.js hace async work sin que su propio listener de chrome.runtime.onMessage lo
// espere (no puede — la API real tampoco lo permite para listeners no-Promise); un tick de
// setTimeout basta para que runExclusive() haya encadenado y resuelto antes de comprobar nada.
function wait(ms = 10) {
  return new Promise((r) => setTimeout(r, ms));
}

async function loadBackground(chrome, fetchImpl) {
  globalThis.chrome = chrome;
  globalThis.fetch = fetchImpl;
  importSeq++;
  await import(`./background.js?t=${importSeq}`);
}

function turnEnvelope(currentPlayer, turnCount) {
  return { type: "GAME_DATA", payload: { currentPlayer, turnCount } };
}

function restartEnvelope() {
  return { type: "GAME_DATA", payload: { gameOptions: { isRestart: true } } };
}

async function captureTurn(mock, tabId, currentPlayer, turnCount) {
  mock.dispatch(
    { type: "capture", entry: { type: "datachannel-message", payload: { direction: "incoming", data: { kind: "string", value: turnEnvelope(currentPlayer, turnCount) } } } },
    tabId,
  );
  await wait();
}

async function captureRestart(mock, tabId) {
  mock.dispatch(
    { type: "capture", entry: { type: "datachannel-message", payload: { direction: "incoming", data: { kind: "string", value: restartEnvelope() } } } },
    tabId,
  );
  await wait();
}

async function openChannel(mock, tabId) {
  mock.dispatch({ type: "capture", entry: { type: "datachannel-open" } }, tabId);
  await wait();
}

async function closeChannel(mock, tabId) {
  mock.dispatch({ type: "capture", entry: { type: "datachannel-close" } }, tabId);
  await wait();
}

async function consent(mock, tabId, answer) {
  mock.dispatch({ type: "consent-response", answer }, tabId);
  await wait();
}

// Abre canal, acepta grabar, y juega N turnos alternos (1..N) — con N >= 4 supera
// MIN_TOTAL_TURNS (2 turnos por jugador) y cuenta como partida real.
async function playToTurn(mock, tabId, turnCount) {
  await openChannel(mock, tabId);
  await consent(mock, tabId, "yes");
  for (let t = 1; t <= turnCount; t++) {
    await captureTurn(mock, tabId, t % 2 === 0 ? "p2" : "p1", t);
  }
}

function fakeFetch(calls, { ok = true } = {}) {
  return async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok, status: ok ? 201 : 500 };
  };
}

test("partida con actividad real: al cerrar canal queda pendiente, y confirmar Gané sube exactamente una vez", async () => {
  const mock = makeChromeMock();
  const fetchCalls = [];
  await loadBackground(mock.chrome, fakeFetch(fetchCalls));

  await playToTurn(mock, 1, 4);
  await closeChannel(mock, 1);

  const ended = mock.lastMessageOfType("series-ended");
  assert.ok(ended, "debe pedir confirmación (series-ended) tras cerrar con actividad real");
  assert.equal(ended.pendingGames.length, 1);

  const pendingId = ended.pendingGames[0].pendingId;
  mock.dispatch({ type: "confirm-series-game", pendingId, result: "WIN" }, 1);
  await wait();

  assert.equal(fetchCalls.length, 1, "debe subir exactamente una vez");
  assert.equal(fetchCalls[0].body.result, "WIN");
  assert.equal(mock.lastMessageOfType("series-game-saved")?.uploaded, true);
});

test("mínimo de actividad: cerrar canal con menos de 4 turnos no genera pendiente ni sube nada", async () => {
  const mock = makeChromeMock();
  const fetchCalls = [];
  await loadBackground(mock.chrome, fakeFetch(fetchCalls));

  await playToTurn(mock, 2, 2); // solo 2 turnos, por debajo de MIN_TOTAL_TURNS
  await closeChannel(mock, 2);

  assert.equal(mock.lastMessageOfType("series-ended"), null, "no debe pedir confirmación de nada");
  assert.equal(mock.lastMessageOfType("hide-overlay")?.type, "hide-overlay");
  assert.equal(fetchCalls.length, 0, "no debe subir nada");
});

test('"Descartar partida" nunca sube nada, aunque la partida tuviera actividad real', async () => {
  const mock = makeChromeMock();
  const fetchCalls = [];
  await loadBackground(mock.chrome, fakeFetch(fetchCalls));

  await playToTurn(mock, 3, 4);
  await closeChannel(mock, 3);

  const pendingId = mock.lastMessageOfType("series-ended").pendingGames[0].pendingId;
  mock.dispatch({ type: "discard-match", pendingId }, 3);
  await wait();

  assert.equal(fetchCalls.length, 0, "descartar no debe llamar nunca a fetch");
  assert.equal(mock.lastMessageOfType("series-game-discarded")?.pendingId, pendingId);
});

test('pulsar "Play" dos veces seguidas (nuevo canal mientras el anterior grababa) finaliza el anterior en vez de perderlo o duplicarlo', async () => {
  const mock = makeChromeMock();
  const fetchCalls = [];
  await loadBackground(mock.chrome, fakeFetch(fetchCalls));

  // Primer "Play": empieza a grabar y juega una partida real.
  await openChannel(mock, 4);
  await consent(mock, 4, "yes");
  for (let t = 1; t <= 4; t++) await captureTurn(mock, 4, t % 2 === 0 ? "p2" : "p1", t);

  // Segundo "Play" antes de cerrar el canal anterior: onChannelOpen debe finalizar la partida en
  // curso (con actividad real, así que genera un pendiente) y luego pedir consentimiento de nuevo
  // para la conexión nueva — sin duplicar ni perder la anterior.
  await openChannel(mock, 4);

  const prompts = mock.messagesOfType("show-consent-prompt");
  assert.equal(prompts.length, 2, "cada 'Play' pide su propio consentimiento (uno por el primer canal, otro por el segundo)");

  // Acepta la segunda conexión y ciérrala sin jugar nada (0 turnos): el pendiente de la PRIMERA
  // partida debe seguir vivo y llegar en el series-ended de este cierre.
  await consent(mock, 4, "yes");
  await closeChannel(mock, 4);

  const ended = mock.lastMessageOfType("series-ended");
  assert.ok(ended, "el pendiente de la primera partida no debe perderse");
  assert.equal(ended.pendingGames.length, 1, "no debe haber duplicados: solo la partida real cuenta");

  mock.dispatch({ type: "confirm-series-game", pendingId: ended.pendingGames[0].pendingId, result: "LOSS" }, 4);
  await wait();
  assert.equal(fetchCalls.length, 1, "solo debe subirse una vez, no una por cada 'Play'");
});

test('botón manual "La partida ya ha terminado" (force-finalize) finaliza igual que un cierre de canal', async () => {
  const mock = makeChromeMock();
  const fetchCalls = [];
  await loadBackground(mock.chrome, fakeFetch(fetchCalls));

  await playToTurn(mock, 5, 4);
  mock.dispatch({ type: "force-finalize" }, 5);
  await wait();

  const ended = mock.lastMessageOfType("series-ended");
  assert.ok(ended, "force-finalize debe comportarse como un cierre de canal normal");
  assert.equal(ended.pendingGames.length, 1);
});

test("un Bo3 real: restart entre partidas encadena Game 1 y Game 2 sin perder ninguna, y cada una sube su propio resultado", async () => {
  const mock = makeChromeMock();
  const fetchCalls = [];
  await loadBackground(mock.chrome, fakeFetch(fetchCalls));

  await openChannel(mock, 6);
  await consent(mock, 6, "yes");
  for (let t = 1; t <= 4; t++) await captureTurn(mock, 6, t % 2 === 0 ? "p2" : "p1", t);

  await captureRestart(mock, 6); // fin de Game 1, empieza Game 2 en el mismo canal
  const finished = mock.lastMessageOfType("series-game-finished");
  assert.ok(finished, "el restart debe avisar de que Game 1 terminó");
  assert.equal(finished.finishedGameNumber, 1);
  assert.equal(finished.newGameNumber, 2);

  // Como en el uso real: confirmamos Game 1 en cuanto aparece su tarjeta, sin esperar a que
  // termine también Game 2 — así el series-ended final solo debe traer la partida que de verdad
  // sigue sin confirmar (Game 2), no las dos.
  mock.dispatch({ type: "confirm-series-game", pendingId: finished.pendingId, result: "WIN" }, 6);
  await wait();

  for (let t = 1; t <= 4; t++) await captureTurn(mock, 6, t % 2 === 0 ? "p2" : "p1", t);
  await closeChannel(mock, 6);

  const ended = mock.lastMessageOfType("series-ended");
  assert.equal(ended.pendingGames.length, 1, "Game 1 ya quedó confirmada antes; aquí solo debe llegar Game 2");

  mock.dispatch({ type: "confirm-series-game", pendingId: ended.pendingGames[0].pendingId, result: "LOSS" }, 6);
  await wait();

  assert.equal(fetchCalls.length, 2, "las dos partidas del Bo3 deben subir, cada una una sola vez");
  const results = fetchCalls.map((c) => c.body.result).sort();
  assert.deepEqual(results, ["LOSS", "WIN"]);
});
