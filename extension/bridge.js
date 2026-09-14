// ISOLATED world: único con acceso a chrome.runtime. Reenvía al service worker lo que
// main-world-hook.js publica via postMessage.
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.source !== "riftbound-tracker") return;

  chrome.runtime.sendMessage({ type: "capture", entry: msg }).catch(() => {});
});
