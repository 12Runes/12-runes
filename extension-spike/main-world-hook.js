// Se ejecuta en el MAIN world de la pestaña (mismo contexto que el bundle de TCG Arena).
// Objetivo único: observar los RTCDataChannel que la app crea para sincronizar la partida
// P2P (vía PeerJS) y reenviar cada mensaje a bridge.js mediante postMessage.
// No modifica ni bloquea ningún mensaje: solo escucha.
(() => {
  if (window.__riftboundHookInstalled) return;
  window.__riftboundHookInstalled = true;

  const SOURCE = "riftbound-tracker-spike";

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
    if (typeof data === "string") {
      try {
        return { kind: "json", value: JSON.parse(data) };
      } catch {
        return { kind: "string", value: data };
      }
    }
    if (data instanceof ArrayBuffer) {
      return { kind: "arraybuffer", byteLength: data.byteLength, base64: arrayBufferToBase64(data) };
    }
    if (ArrayBuffer.isView(data)) {
      return { kind: "typedarray", byteLength: data.byteLength, base64: arrayBufferToBase64(data.buffer) };
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return { kind: "blob", size: data.size, mimeType: data.type };
    }
    return { kind: "unknown", value: String(data) };
  }

  function safeJSON(obj) {
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch {
      return null;
    }
  }

  function instrumentChannel(channel, origin) {
    if (channel.__riftboundInstrumented) return;
    channel.__riftboundInstrumented = true;

    channel.addEventListener("message", (evt) => {
      post("datachannel-message", {
        direction: "incoming",
        origin,
        label: channel.label,
        data: describeData(evt.data),
      });
    });

    channel.addEventListener("open", () => post("datachannel-open", { origin, label: channel.label }));
    channel.addEventListener("close", () => post("datachannel-close", { origin, label: channel.label }));

    const originalSend = channel.send.bind(channel);
    channel.send = (data) => {
      post("datachannel-message", {
        direction: "outgoing",
        origin,
        label: channel.label,
        data: describeData(data),
      });
      return originalSend(data);
    };
  }

  const OriginalRTCPeerConnection = window.RTCPeerConnection;
  if (!OriginalRTCPeerConnection) {
    post("hook-error", { reason: "RTCPeerConnection no disponible en window" });
    return;
  }

  function PatchedRTCPeerConnection(...args) {
    const pc = new OriginalRTCPeerConnection(...args);
    post("peerconnection-created", { config: safeJSON(args[0] ?? null) });

    const originalCreateDataChannel = pc.createDataChannel.bind(pc);
    pc.createDataChannel = (label, opts) => {
      const channel = originalCreateDataChannel(label, opts);
      instrumentChannel(channel, "local");
      return channel;
    };

    pc.addEventListener("datachannel", (evt) => {
      instrumentChannel(evt.channel, "remote");
    });

    return pc;
  }
  PatchedRTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
  Object.setPrototypeOf(PatchedRTCPeerConnection, OriginalRTCPeerConnection);
  window.RTCPeerConnection = PatchedRTCPeerConnection;

  post("hook-installed", {});
})();
