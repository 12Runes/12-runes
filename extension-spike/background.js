const MAX_LOG_ENTRIES = 5000;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "capture") return;

  chrome.storage.local.get({ log: [] }, ({ log }) => {
    log.push(msg.entry);
    if (log.length > MAX_LOG_ENTRIES) {
      log.splice(0, log.length - MAX_LOG_ENTRIES);
    }
    chrome.storage.local.set({ log });
  });
});
