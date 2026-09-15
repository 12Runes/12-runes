// MAIN world: mismo contexto JS que el bundle de TCG Arena.
// Observa (sin modificar ni bloquear) los mensajes del RTCDataChannel "game", que es por
// donde la app sincroniza la partida P2P entre los dos jugadores. Reenvía cada mensaje en
// crudo (base64) a bridge.js; la decodificación real (binarypack + reensamblado de chunks)
// ocurre en el service worker, que sí tiene acceso a chrome.runtime.
(() => {
  if (window.__riftboundHookInstalled) return;
  window.__riftboundHookInstalled = true;

  const SOURCE = "riftbound-tracker";

  function post(type, payload) {
    window.postMessage({ source: SOURCE, type, payload, ts: Date.now() }, "*");
  }

  function arrayBufferToBase64(buf) {
    let binary = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function describeData(data) {
    if (data instanceof ArrayBuffer) return { kind: "arraybuffer", base64: arrayBufferToBase64(data) };
    if (ArrayBuffer.isView(data)) return { kind: "arraybuffer", base64: arrayBufferToBase64(data.buffer) };
    if (typeof data === "string") return { kind: "string", value: data };
    return null; // Blob u otros: no esperados en este canal, se ignoran.
  }

  function instrumentChannel(channel, origin) {
    if (channel.label !== "game" || channel.__riftboundInstrumented) return;
    channel.__riftboundInstrumented = true;

    channel.addEventListener("message", (evt) => {
      const data = describeData(evt.data);
      if (data) post("datachannel-message", { direction: "incoming", origin, data });
    });

    const originalSend = channel.send.bind(channel);
    channel.send = (data) => {
      const described = describeData(data);
      if (described) post("datachannel-message", { direction: "outgoing", origin, data: described });
      return originalSend(data);
    };

    channel.addEventListener("open", () => post("datachannel-open", { origin }));
    channel.addEventListener("close", () => post("datachannel-close", { origin }));
  }

  const OriginalRTCPeerConnection = window.RTCPeerConnection;
  if (!OriginalRTCPeerConnection) return;

  function PatchedRTCPeerConnection(...args) {
    const pc = new OriginalRTCPeerConnection(...args);

    const originalCreateDataChannel = pc.createDataChannel.bind(pc);
    pc.createDataChannel = (label, opts) => {
      const channel = originalCreateDataChannel(label, opts);
      instrumentChannel(channel, "local");
      return channel;
    };

    pc.addEventListener("datachannel", (evt) => instrumentChannel(evt.channel, "remote"));

    // Cuando la partida se queda colgada (p. ej. TCG Arena muestra "Timeout") la conexión puede
    // quedar en un estado muerto sin que el propio RTCDataChannel llegue a disparar su evento
    // "close" — el canal en sí puede seguir "abierto" a efectos del navegador aunque ya no vaya
    // a pasar nada más. "failed"/"closed" a nivel de RTCPeerConnection sí son un indicador fiable
    // de que la conexión ha terminado de verdad (a diferencia de "disconnected", que puede
    // recuperarse solo tras un corte breve de red, así que ese no cuenta). Se trata exactamente
    // igual que un cierre normal del canal: mismo mensaje "datachannel-close" que ya se
    // gestionaba, sin necesidad de un camino nuevo en el service worker.
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        post("datachannel-close", { origin: "connection-state", reason: pc.connectionState });
      }
    });

    return pc;
  }
  PatchedRTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
  Object.setPrototypeOf(PatchedRTCPeerConnection, OriginalRTCPeerConnection);
  window.RTCPeerConnection = PatchedRTCPeerConnection;
})();
