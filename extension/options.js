const input = document.getElementById("backendUrl");
const status = document.getElementById("status");

chrome.storage.local.get({ backendUrl: "http://localhost:4000" }, ({ backendUrl }) => {
  input.value = backendUrl;
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ backendUrl: input.value.trim() || "http://localhost:4000" });
  status.textContent = "Guardado";
  setTimeout(() => (status.textContent = ""), 1500);
});
