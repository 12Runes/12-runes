// ISOLATED world, con acceso al DOM de la página. Muestra el aviso antes de la partida y el
// formulario de guardado al terminar, en un panel aislado (Shadow DOM) para no chocar con los
// estilos de TCG Arena. Solo reacciona a mensajes del service worker; no lee nada del juego.
(() => {
  let host = null;
  let root = null;

  // Estado de lo que hay que enseñar ahora mismo. currentGameNumber !=null mientras se está
  // grabando (indicador persistente); pendingGames son partidas anteriores de la misma serie
  // (Bo3) ya terminadas a la espera de que confirmes el resultado, sin dejar de grabar la
  // siguiente mientras tanto.
  let currentGameNumber = null;
  let pendingGames = []; // { pendingId, finishedGameNumber, guessedResult, summary }

  function ensureHost() {
    if (host) return;
    host = document.createElement("div");
    host.style.all = "initial";
    host.style.position = "fixed";
    host.style.top = "16px";
    host.style.right = "16px";
    host.style.zIndex = "2147483647";
    document.documentElement.appendChild(host);

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      .panel { font-family: system-ui, sans-serif; background:#111827; color:#f9fafb; border-radius:10px; padding:14px 16px; width:300px; max-height:calc(100vh - 32px); overflow-y:auto; box-sizing:border-box; box-shadow:0 8px 24px rgba(0,0,0,.35); display:flex; flex-direction:column; gap:10px; }
      .title { font-weight:600; font-size:13px; display:flex; align-items:center; gap:6px; }
      .dot { width:8px;height:8px;border-radius:50%; background:#22c55e; flex-shrink:0; }
      .text { font-size:12px; color:#d1d5db; line-height:1.4; }
      .row { display:flex; gap:8px; }
      button { flex:1; font-size:12px; padding:6px 8px; border-radius:6px; border:none; cursor:pointer; font-weight:600; }
      .primary { background:#22c55e; color:#052e16; }
      .secondary { background:#374151; color:#f9fafb; }
      .result-row { display:flex; gap:6px; }
      .result-btn { color:#fff; }
      .result-btn.win { background:#16a34a; }
      .result-btn.loss { background:#dc2626; }
      .result-btn.discard { background:#4b5563; }
      .result-btn:hover { filter:brightness(1.15); }
      .badge { display:flex; align-items:center; gap:6px; font-size:12px; font-weight:600; }
      .pending-card { border:1px solid #374151; border-radius:8px; padding:8px; display:flex; flex-direction:column; gap:6px; }
      .divider { border:none; border-top:1px solid #374151; margin:0; }
    `;
    shadow.appendChild(style);
    root = document.createElement("div");
    shadow.appendChild(root);
  }

  function clearPanel() {
    if (!host) return;
    host.remove();
    host = null;
    root = null;
  }

  function send(msg) {
    chrome.runtime.sendMessage(msg).catch(() => {});
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function summaryLines(summary) {
    const opponent = escapeHtml(summary?.opponentPseudo ?? "el rival");
    const lines = [`Contra ${opponent}`];
    if (summary?.turnCount) lines.push(`${summary.turnCount} turnos`);
    if (summary?.localLegend) lines.push(`Tu Legend: ${escapeHtml(summary.localLegend)}`);
    if (summary?.opponentLegend) lines.push(`Legend rival: ${escapeHtml(summary.opponentLegend)}`);
    return lines.join(" · ");
  }

  function showConsent() {
    ensureHost();
    root.innerHTML = `
      <div class="panel">
        <div class="title">🎴 12 Runes</div>
        <div class="text">¿Grabar esta partida y subirla a tus estadísticas al terminar?</div>
        <div class="row">
          <button class="primary" id="rbt-yes">Grabar</button>
          <button class="secondary" id="rbt-no">No, gracias</button>
        </div>
      </div>`;
    root.querySelector("#rbt-yes").addEventListener("click", () => {
      send({ type: "consent-response", answer: "yes" });
    });
    root.querySelector("#rbt-no").addEventListener("click", () => {
      send({ type: "consent-response", answer: "no" });
      clearPanel();
    });
  }

  // Repinta el panel combinando, si los hay: la(s) confirmación(es) pendiente(s) de partidas
  // anteriores de la serie y el indicador de que ya se está grabando la partida actual.
  function renderLive() {
    if (pendingGames.length === 0 && currentGameNumber == null) {
      clearPanel();
      return;
    }
    ensureHost();

    // Antes esto era un <select> + botón "Confirmar": en partidas reales, dentro de la página
    // de TCG Arena, el desplegable nativo dejaba de abrirse de forma intermitente (el juego
    // parece interceptar el pointerdown/click en algún punto de la captura del documento antes
    // de que llegue al <select>) y el resultado se quedaba en lo que tuviera seleccionado por
    // defecto. Los botones normales (Grabar/Confirmar/Descartar) nunca han fallado así, así que
    // el resultado se elige ahora con tres botones directos, sin picker nativo de por medio.
    //
    // Solo Gané/Perdí suben algo a la base de datos. "Descartar partida" (antes "No sé", que sí
    // subía con resultado UNKNOWN) no sube nada — si no estás seguro de que la partida cuenta
    // como dato real, la opción es descartarla, no adivinar el resultado.
    const pendingHtml = pendingGames
      .map(
        (p) => `
        <div class="pending-card" data-pending-id="${p.pendingId}">
          <div class="text"><strong>Game ${p.finishedGameNumber} terminado.</strong><br>${summaryLines(p.summary)}</div>
          <div class="result-row">
            <button class="result-btn win" data-result="WIN">Gané</button>
            <button class="result-btn loss" data-result="LOSS">Perdí</button>
            <button class="result-btn discard rbt-discard-pending">Descartar partida</button>
          </div>
        </div>`
      )
      .join("");

    const recordingHtml =
      currentGameNumber != null
        ? `<div class="badge"><span class="dot"></span> Grabando Game ${currentGameNumber}…</div>`
        : "";

    root.innerHTML = `
      <div class="panel">
        ${pendingHtml}
        ${pendingHtml && recordingHtml ? '<hr class="divider" />' : ""}
        ${recordingHtml}
      </div>`;

    root.querySelectorAll(".pending-card .result-btn[data-result]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const card = btn.closest(".pending-card");
        const pendingId = card.dataset.pendingId;
        const result = btn.dataset.result;
        send({ type: "confirm-series-game", pendingId, result });
        pendingGames = pendingGames.filter((p) => p.pendingId !== pendingId);
        renderLive();
      });
    });
    root.querySelectorAll(".rbt-discard-pending").forEach((btn) => {
      btn.addEventListener("click", () => {
        const card = btn.closest(".pending-card");
        const pendingId = card.dataset.pendingId;
        send({ type: "discard-match", pendingId });
        pendingGames = pendingGames.filter((p) => p.pendingId !== pendingId);
        renderLive();
      });
    });
  }

  // Al cerrarse la conexión (fin de la serie), el service worker manda de golpe TODAS las
  // partidas de la serie que sigan sin confirmar (incluida la que acaba de terminar): se
  // tratan igual que cualquier otro pendiente, una tarjeta por partida, nada se sube hasta que
  // el usuario elige un resultado para cada una.
  function showSeriesEnded(msg) {
    pendingGames = msg.pendingGames;
    currentGameNumber = null;
    renderLive();
  }

  function showSeriesGameFinished(msg) {
    pendingGames.push({
      pendingId: msg.pendingId,
      finishedGameNumber: msg.finishedGameNumber,
      guessedResult: msg.guessedResult,
      summary: msg.summary,
    });
    currentGameNumber = msg.newGameNumber;
    renderLive();
  }

  function showToast(text) {
    ensureHost();
    root.innerHTML = `<div class="panel"><div class="text">${text}</div></div>`;
    setTimeout(() => {
      if (pendingGames.length > 0 || currentGameNumber != null) renderLive();
      else clearPanel();
    }, 4000);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg?.type) return;
    if (msg.type === "show-consent-prompt") showConsent();
    else if (msg.type === "show-recording-indicator") {
      currentGameNumber = msg.gameNumber ?? 1;
      renderLive();
    } else if (msg.type === "series-game-finished") showSeriesGameFinished(msg);
    else if (msg.type === "series-ended") showSeriesEnded(msg);
    else if (msg.type === "series-game-saved") {
      showToast(msg.uploaded ? "✅ Partida guardada y subida." : `⚠️ Guardada localmente, no se pudo subir (${escapeHtml(msg.error ?? "")}).`);
    } else if (msg.type === "series-game-discarded") {
      // Ya se ha quitado del panel de forma inmediata al pulsar "Descartar"; nada más que hacer.
    } else if (msg.type === "hide-overlay") {
      currentGameNumber = null;
      pendingGames = [];
      clearPanel();
    }
  });
})();
