const resultLabel = { WIN: "Victoria", LOSS: "Derrota", UNKNOWN: "Resultado desconocido" };

function fmtDate(ts) {
  return new Date(ts).toLocaleString();
}

async function render() {
  const { matches } = await chrome.storage.local.get({ matches: [] });
  const list = document.getElementById("list");
  const empty = document.getElementById("empty");

  if (matches.length === 0) {
    list.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  list.innerHTML = matches
    .map(
      (m, i) => `
      <div class="match">
        <div class="top">
          <span class="result-${m.result}">${resultLabel[m.result] ?? m.result}</span>
          <span>${fmtDate(m.savedAt)}</span>
        </div>
        <div class="meta">vs ${m.opponentPseudo ?? "?"}${m.localDeck?.legendName ? ` · ${m.localDeck.legendName}` : ""}</div>
        <div class="status ${m.uploaded ? "uploaded" : "pending"}">${m.uploaded ? "Subida al servidor" : `Pendiente de subir${m.error ? ` (${m.error})` : ""}`}</div>
        ${!m.uploaded ? `<button class="link" data-retry="${i}">Reintentar subida</button>` : ""}
      </div>`
    )
    .join("");

  list.querySelectorAll("[data-retry]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.dataset.retry);
      await retryUpload(idx);
      render();
    });
  });
}

async function retryUpload(idx) {
  const { matches, backendUrl } = await chrome.storage.local.get({ matches: [], backendUrl: "https://one2-runes.onrender.com" });
  const m = matches[idx];
  if (!m) return;
  try {
    const res = await fetch(`${backendUrl}/matches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(m),
    });
    m.uploaded = res.ok;
    m.error = res.ok ? null : `HTTP ${res.status}`;
  } catch (err) {
    m.uploaded = false;
    m.error = String(err);
  }
  await chrome.storage.local.set({ matches });
}

async function getContributorId() {
  const { contributorId } = await chrome.storage.local.get({ contributorId: null });
  if (contributorId) return contributorId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ contributorId: id });
  return id;
}

document.getElementById("open-dashboard").addEventListener("click", async () => {
  const { backendUrl } = await chrome.storage.local.get({ backendUrl: "https://one2-runes.onrender.com" });
  const contributorId = await getContributorId();
  chrome.tabs.create({ url: `${backendUrl}/?me=${encodeURIComponent(contributorId)}` });
});

document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

document.getElementById("export").addEventListener("click", async () => {
  const { matches } = await chrome.storage.local.get({ matches: [] });
  const blob = new Blob([JSON.stringify(matches, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: `riftbound-matches-${Date.now()}.json`, saveAs: true }, () => URL.revokeObjectURL(url));
});

// Modo diagnóstico temporal (ver background.js, maybeDebugCapture): al activarlo se vacía el
// log anterior, para que cada captura corresponda a una sola partida de prueba y no se mezcle
// con capturas viejas.
const debugToggle = document.getElementById("debug-toggle");
chrome.storage.local.get({ debugCapture: false }, ({ debugCapture }) => (debugToggle.checked = debugCapture));
debugToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ debugCapture: debugToggle.checked });
  if (debugToggle.checked) await chrome.storage.local.set({ debugLog: [] });
});

document.getElementById("debug-export").addEventListener("click", async () => {
  const { debugLog } = await chrome.storage.local.get({ debugLog: [] });
  const blob = new Blob([JSON.stringify(debugLog, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: `riftbound-debug-${Date.now()}.json`, saveAs: true }, () => URL.revokeObjectURL(url));
});

render();
