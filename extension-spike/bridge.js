// Content script en el ISOLATED world: es el único con acceso a chrome.runtime.
// Recibe los mensajes que main-world-hook.js publica via postMessage y los reenvía
// al service worker para que los guarde en chrome.storage.local.
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.source !== "riftbound-tracker-spike") return;

  chrome.runtime.sendMessage({ type: "capture", entry: msg }).catch(() => {
    // El popup puede no estar abierto / el runtime puede no estar listo; no es un error real.
  });
});
