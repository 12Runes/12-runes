const input = document.getElementById("backendUrl");
const status = document.getElementById("status");
const contributorIdInput = document.getElementById("contributorId");

chrome.storage.local.get({ backendUrl: "https://one2-runes.onrender.com" }, ({ backendUrl }) => {
  input.value = backendUrl;
});

// Igual que getContributorId() en background.js/popup.js: se lee de storage.sync (sobrevive a
// reinstalar la extensión con la sesión de Chrome iniciada), con migración de una sola vez desde
// un id viejo en storage.local si lo hubiera, o se genera uno nuevo la primera vez que se abre
// esta página — así siempre hay algo que mostrar, coincidiendo con lo que promete la política de
// privacidad ("lo encuentras en la página de opciones").
async function loadContributorId() {
  const { contributorId } = await chrome.storage.sync.get({ contributorId: null });
  if (contributorId) return contributorId;
  const { contributorId: legacyLocalId } = await chrome.storage.local.get({ contributorId: null });
  const id = legacyLocalId || crypto.randomUUID();
  await chrome.storage.sync.set({ contributorId: id });
  return id;
}
loadContributorId().then((id) => (contributorIdInput.value = id));

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ backendUrl: input.value.trim() || "https://one2-runes.onrender.com" });
  status.textContent = "Guardado";
  setTimeout(() => (status.textContent = ""), 1500);
});

const copyBtn = document.getElementById("copy-id");
copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(contributorIdInput.value);
    const original = copyBtn.textContent;
    copyBtn.textContent = "¡Copiado!";
    setTimeout(() => (copyBtn.textContent = original), 1500);
  } catch {
    // Sin permiso de portapapeles (poco habitual en una página de opciones): seleccionamos el
    // texto para que al menos se pueda copiar a mano con Cmd/Ctrl+C.
    contributorIdInput.select();
  }
});

// Restaurar a mano un id guardado de antes — la única garantía 100% fiable de recuperar tu
// historial si alguna vez reinstalas la extensión sin tener sesión de Chrome con sync activado
// (storage.sync ya ayuda solo, pero esto no depende de nada de Chrome).
const restoreInput = document.getElementById("restore-id-input");
const restoreStatus = document.getElementById("restore-status");
document.getElementById("restore-id").addEventListener("click", async () => {
  const id = restoreInput.value.trim();
  if (!id) return;
  await chrome.storage.sync.set({ contributorId: id });
  contributorIdInput.value = id;
  restoreInput.value = "";
  restoreStatus.textContent = "Restaurado";
  setTimeout(() => (restoreStatus.textContent = ""), 1500);
});
