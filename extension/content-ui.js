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

  // El indicador de grabación se minimiza solo a un "piloto" (punto arrastrable) en cuanto
  // empieza a grabar, porque el panel completo tapa UI propia de TCG Arena. Si hay alguna
  // partida pendiente de Gané/Perdí/Descartar, el panel se fuerza a expandido igualmente (eso
  // sí necesita tu atención); `minimized` solo decide qué pasa cuando no hay nada pendiente.
  let minimized = false;
  let dragStart = null; // { x, y, left, top }
  let dragMoved = false;

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
      .badge-row { display:flex; align-items:center; justify-content:space-between; gap:6px; }
      .minimize-btn { flex:0 0 auto; width:22px; padding:0; font-size:14px; line-height:1; background:#374151; color:#f9fafb; }
      .pilot { width:26px; height:26px; border-radius:50%; background:#111827; border:2px solid #22c55e; box-shadow:0 4px 12px rgba(0,0,0,.4); display:flex; align-items:center; justify-content:center; cursor:grab; user-select:none; }
      .pilot:active { cursor:grabbing; }
      .pilot .pilot-dot { width:10px; height:10px; border-radius:50%; background:#22c55e; }
    `;
    shadow.appendChild(style);
    root = document.createElement("div");
    shadow.appendChild(root);
  }

  function clearPanel() {
    minimized = false;
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

  // Arrastrar el piloto: se mueve con left/top absolutos (abandonando el anclaje inicial por
  // top/right) para poder llevarlo a cualquier esquina. Un click simple (sin mover el ratón más
  // de unos pocos px) no cuenta como arrastre y reabre el panel completo en `stopDrag`.
  function startDrag(e) {
    e.preventDefault();
    e.stopPropagation();
    dragMoved = false;
    const rect = host.getBoundingClientRect();
    dragStart = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
    document.addEventListener("mousemove", onDrag, true);
    document.addEventListener("mouseup", stopDrag, true);
  }

  function onDrag(e) {
    if (!dragStart) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    if (!dragMoved && Math.hypot(dx, dy) < 4) return;
    dragMoved = true;
    e.preventDefault();
    e.stopPropagation();
    const rect = host.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);
    host.style.left = `${Math.min(Math.max(0, dragStart.left + dx), maxLeft)}px`;
    host.style.top = `${Math.min(Math.max(0, dragStart.top + dy), maxTop)}px`;
    host.style.right = "auto";
  }

  function stopDrag(e) {
    document.removeEventListener("mousemove", onDrag, true);
    document.removeEventListener("mouseup", stopDrag, true);
    const wasClick = !dragMoved;
    dragStart = null;
    dragMoved = false;
    if (wasClick) {
      minimized = false;
      renderLive();
    }
  }

  // Si el piloto se arrastró cerca de un borde, al desplegar el panel completo (300px de ancho)
  // este podría salirse de la pantalla; lo recolocamos dentro del viewport sin tocar la posición
  // si nunca se arrastró (sigue anclado por top/right, que ya siempre cabe).
  function clampHostToViewport() {
    if (!host || host.style.left === "") return;
    const rect = host.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);
    host.style.left = `${Math.min(parseFloat(host.style.left) || 0, maxLeft)}px`;
    host.style.top = `${Math.min(parseFloat(host.style.top) || 0, maxTop)}px`;
  }

  function showConsent() {
    ensureHost();
    minimized = false;
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

    // Con una partida pendiente de confirmar, el panel se fuerza a expandido aunque `minimized`
    // siga a true: eso sí necesita que hagas click en Gané/Perdí/Descartar, no puede quedarse
    // escondido en el piloto.
    if (minimized && pendingGames.length === 0 && currentGameNumber != null) {
      root.innerHTML = `<div class="pilot" id="rbt-pilot" title="Grabando · arrastra para moverlo o haz clic para abrir"><span class="pilot-dot"></span></div>`;
      root.querySelector("#rbt-pilot").addEventListener("mousedown", startDrag);
      clampHostToViewport();
      return;
    }

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

    // El botón de abajo es la red de seguridad si, tras un "Timeout" de TCG Arena, la conexión
    // se queda colgada sin que llegue ningún aviso automático (ver `connectionstatechange` en
    // main-world-hook.js — cubre lo detectable a nivel de protocolo, pero por si acaso): permite
    // forzar el aviso de Gané/Perdí/Descartar a mano en vez de quedarse grabando para siempre.
    // El botón de minimizar solo se pinta si de verdad puede minimizar algo: con una partida
    // pendiente delante, el panel se queda expandido pase lo que pase (ver arriba), así que
    // ofrecer un botón que no hace nada solo confundiría.
    const recordingHtml =
      currentGameNumber != null
        ? `<div class="badge-row">
             <div class="badge"><span class="dot"></span> Grabando Game ${currentGameNumber}…</div>
             ${pendingGames.length === 0 ? '<button class="minimize-btn" id="rbt-minimize" title="Minimizar">–</button>' : ""}
           </div>
           <button class="secondary" id="rbt-force-finalize">La partida ya ha terminado</button>`
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
    const forceBtn = root.querySelector("#rbt-force-finalize");
    if (forceBtn) forceBtn.addEventListener("click", () => send({ type: "force-finalize" }));
    const minimizeBtn = root.querySelector("#rbt-minimize");
    if (minimizeBtn) {
      minimizeBtn.addEventListener("click", () => {
        minimized = true;
        renderLive();
      });
    }
    clampHostToViewport();
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
      minimized = true;
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
