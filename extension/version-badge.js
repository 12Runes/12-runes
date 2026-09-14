// Deja la versión instalada como atributo en <html>, para que el dashboard pueda comparar
// contra la última disponible y avisar de que hay actualización (ver web/index.html,
// checkExtensionVersion). El contenido de la página nunca puede leer nada del propio
// service worker, así que este es el único hueco disponible: un content script (mundo
// aislado, pero el DOM sí lo comparten) escribiendo un valor que el JS de la página sí lee.
document.documentElement.setAttribute("data-rbt-extension-version", chrome.runtime.getManifest().version);
