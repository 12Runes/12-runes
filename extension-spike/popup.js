function refreshCount() {
  chrome.storage.local.get({ log: [] }, ({ log }) => {
    document.getElementById("count").textContent = `${log.length} mensajes capturados`;
  });
}

document.getElementById("download").addEventListener("click", () => {
  chrome.storage.local.get({ log: [] }, ({ log }) => {
    const blob = new Blob([JSON.stringify(log, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download(
      { url, filename: `riftbound-spike-${Date.now()}.json`, saveAs: true },
      () => URL.revokeObjectURL(url)
    );
  });
});

document.getElementById("clear").addEventListener("click", () => {
  chrome.storage.local.set({ log: [] }, refreshCount);
});

refreshCount();
