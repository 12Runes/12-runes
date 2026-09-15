const input = document.getElementById("backendUrl");
const status = document.getElementById("status");
const contributorIdInput = document.getElementById("contributorId");

chrome.storage.local.get({ backendUrl: "https://one2-runes.onrender.com" }, ({ backendUrl }) => {
  input.value = backendUrl;
});

// Igual que getContributorId() en popup.js: se lee si ya existe, o se genera y guarda la
// primera vez que se abre esta página — así siempre hay algo que mostrar, coincidiendo con lo
// que promete la política de privacidad ("lo encuentras en la página de opciones").
chrome.storage.local.get({ contributorId: null }, async ({ contributorId }) => {
  if (!contributorId) {
    contributorId = crypto.randomUUID();
    await chrome.storage.local.set({ contributorId });
  }
  contributorIdInput.value = contributorId;
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ backendUrl: input.value.trim() || "https://one2-runes.onrender.com" });
  status.textContent = "Guardado";
  setTimeout(() => (status.textContent = ""), 1500);
});
