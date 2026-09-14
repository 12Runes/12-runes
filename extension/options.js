const input = document.getElementById("backendUrl");
const status = document.getElementById("status");

chrome.storage.local.get({ backendUrl: "https://one2-runes.onrender.com" }, ({ backendUrl }) => {
  input.value = backendUrl;
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ backendUrl: input.value.trim() || "https://one2-runes.onrender.com" });
  status.textContent = "Guardado";
  setTimeout(() => (status.textContent = ""), 1500);
});
