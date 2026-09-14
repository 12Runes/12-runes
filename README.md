# 12 Runes

Plugin de navegador para trackear partidas de Riftbound jugadas en [tcg-arena.fr](https://tcg-arena.fr),
con subida a un servidor propio que expone estadísticas avanzadas: win rate por Legend, on the play vs.
on the draw, y qué cartas rinden mejor (y cuáles son más importantes) en cada matchup.

## Cómo funciona

TCG Arena es un simulador genérico de TCGs (Riftbound es solo uno de los "mods" que carga) y sincroniza las
partidas **peer-to-peer vía WebRTC (PeerJS)** entre los navegadores de los dos jugadores — no hay servidor
central de partidas. `extension/` intercepta (sin modificar ni bloquear) los mensajes del canal de datos
WebRTC, los decodifica (son `binarypack`, ver `extension/vendor/`) y los traduce a un log de partida
normalizado. Descubierto y validado con `extension-spike/` a partir de partidas reales capturadas.

## Estructura

- `extension-spike/` — extensión de solo-investigación usada para descubrir el formato de los mensajes.
  Ya cumplió su función; se conserva como referencia.
- `extension/` — la extensión real (icono propio en `extension/icons/`, mismo diseño que el logo de la
  web, para distinguirla a simple vista en `chrome://extensions`):
  - Al detectar que se abre el canal de datos `game` (empieza una partida), muestra un aviso en la propia
    pestaña preguntando si quieres grabarla.
  - Si aceptas, decodifica en vivo el tráfico WebRTC y construye el registro de la partida: mazos de ambos
    jugadores (Legend, Chosen Champion, Battlefields, Runes, Spells, Units), quién empezó (on the play/on
    the draw), turnos y el log de acciones (robos, jugadas de cartas con su carta completa, mulligan,
    contador de energía/vida, etc.).
  - Al cerrarse el canal (partida terminada), pregunta el resultado (con una sugerencia automática a partir
    de si algún jugador quedó "eliminado", a confirmar a mano — ver "Limitaciones") y, al pulsar Guardar,
    sube la partida al backend. Si el backend no responde, queda guardada localmente para reintentar desde
    el icono de la extensión.
  - **Bo3 dentro de la misma conexión**: TCG Arena no cierra el canal WebRTC entre partidas de una misma
    sala — al pulsar "Start new game"/"Restart with the same decks" llega un mensaje con
    `gameOptions.isRestart: true`. Al detectarlo, la extensión da por terminada la partida en curso (te
    pregunta el resultado en un aviso compacto) y **arranca a grabar la siguiente al instante**, sin esperar
    tu respuesta — el aviso de "Grabando Game 2…" aparece de inmediato y puedes confirmar el resultado del
    Game 1 con calma mientras tanto. Cada partida de la serie se guarda como un registro independiente con
    el mismo `seriesId` y su `gameNumber` (1, 2, 3...). Al cerrarse la conexión (fin de la serie), la
    **última partida se trata exactamente igual que las anteriores**: se añade a la misma lista de
    pendientes por confirmar (con su propio selector Gané/Perdí/No estoy seguro y botón Confirmar/Descartar)
    en vez de usar un formulario aparte — así nunca desaparece la posibilidad de confirmar un Game anterior
    mientras se resuelve el último (ver "[Corregido]" más abajo). Funciona igual tanto si la partida sale de
    matchmaking como si os conectáis directamente por la pestaña de amigos: la extensión no distingue cómo
    se estableció la conexión, solo observa el canal de datos WebRTC llamado `"game"` que usa Riftbound para
    sincronizar la partida en cualquiera de los dos casos.
  - **Arquetipos**: con el tiempo, una misma Legend acumula muchas listas casi idénticas (cambiar una sola
    carta ya genera una huella distinta). El backend agrupa automáticamente las listas del mismo Chosen
    Champion que difieren en hasta 6 cartas (de 40) en un mismo "arquetipo" para el desplegable — si se han
    jugado varias variantes de una build, la vista de decklist deja elegir cuál ver sin perder el desglose
    conjunto de win rate.
- `server/` — API Fastify + Prisma (SQLite en dev):
  - **Cada partida cuenta el doble: se mina también el lado del rival.** El log de eventos ya traía completa
    la identidad de las cartas jugadas por los dos jugadores (nunca hizo falta que el rival tuviera la
    extensión instalada), pero hasta ahora todas las estadísticas filtraban solo `localPlayerId`. Con
    `toPerspective`/`bothPerspectives`/`perspectivesForLegend` (`stats.ts`) cada partida se puede reconstruir
    también "desde el otro lado": mismo log de eventos, pero con el resultado invertido (si gané yo, perdió
    el rival) y el mazo/id de jugador del rival en el rol de "local". Todos los endpoints de stats
    (`legends`, `matchups`, `cards`, `decks`, `card-grades`) agregan ambas perspectivas de cada partida sin
    ninguna consulta ni dato adicional — el efecto práctico es que Legends que nunca has jugado tú pero sí
    has enfrentado aparecen igualmente en "Tu Legend" con su propio win rate, cartas, arquetipos y nota de
    17lands, y el simulador de mulligans puede generarles una mano igual que a las tuyas. Ver la limitación
    de "mano inicial" más abajo: esto no incluye la mano/mulligan real de nadie (ni la tuya ni la del rival)
    porque esa identidad nunca viaja por el protocolo — lo que se dobla es todo lo que sí viaja completo:
    cartas jugadas, resultado, on the play/draw y decklist.
  - `POST /matches` — ingesta. Incluye el `contributorId` anónimo de quien graba (ver "Repositorio común").
  - `GET /matches?contributor=<id>` — partidas recientes de esa instalación (obligatorio: nunca se sirve
    sin acotar, para no exponer pseudos de nadie).
  - `GET /stats/legends`, `/stats/matchups`, `/stats/cards`, `/stats/decks` — todas aceptan `?contributor=<id>`
    opcional: con él, solo esa instalación; sin él, agregado de todo el backend ("Comunidad"). Ninguna de
    estas devuelve pseudos, solo Legend/carta/mazo.
  - `GET /stats/cards?legend=X&opponent=Y&deck=Z` (`opponent`, `deck` y `contributor` opcionales) — por cada
    carta jugada en ese filtro (Runes excluidas: se juegan en automático, no aportan señal): veces jugada,
    win rate cuando se jugó vs. cuando no (y la diferencia, Δ), y el mismo split on-the-play/draw. Esto es
    lo que HSReplay.net llama "Win Rate When Played" y 17Lands "GIH Win Rate/IWD", adaptado a un juego con
    mazo preconstruido en vez de draft.
  - `GET /stats/decks?legend=X` — agrupa las partidas de una Legend por **arquetipo**: listas del mismo
    Chosen Champion que difieren en hasta 6 cartas de 40 se tratan como la misma build en evolución, para
    que el desplegable no crezca sin límite con cada ajuste puntual. Cada arquetipo lleva su propio desglose
    de partidas/win rate agregado y la lista de variantes exactas que lo componen (con su propia decklist
    completa e imagen). `GET /stats/cards?...&deck=<huella>` acepta la huella de cualquier variante y filtra
    por todo su arquetipo, no solo por esa lista exacta.
  - `GET /stats/card-grades?legend=X&contributor=Y` (`legend` opcional: sin él, agrega todas las Legends) —
    cada carta jugada con su set (`OGN`/`OGS`/`SFD`/`UNL`/`VEN`, derivado directamente del propio `cardId`,
    p. ej. `"OGN-166"`), su dominio de runa (Fury/Calm/Mind/Body/Chaos/Order/Multi/Colorless) y una nota
    (A+ a F) según el win rate cuando se juega — pensado para alimentar la tabla de "Valoración de cartas"
    al estilo 17lands.com. El dominio no viaja por el protocolo de TCG Arena, así que se resuelve contra un
    catálogo estático (`server/src/data/cardDomains.json`, ~1200 cartas) descargado una vez de la web
    oficial de Riftbound (`riftbound.leagueoflegends.com/en-us/card-gallery/`) — si una carta de un set
    futuro no está todavía en ese catálogo, se omite del grid en vez de inventar un dominio.
  - **Season**: cada partida guarda el código de set/expansión activo cuando se jugó (p. ej. `"VEN"` =
    Vendetta), derivado en `extension/parser.js` a partir de las banderas `_legal` que trae cada carta del
    mazo — la misma bandera que usa el propio deckbuilder de TCG Arena para el desplegable "Choose Format"
    ("Standard (Vendetta)", "Legacy (Unleashed)"...). La season se toma como el set más reciente marcado
    legal en cualquier carta del mazo (Legend, Chosen Champion, Battlefields, Runes, Spells, Units). Es una
    propiedad de la sala (la misma para los dos lados), así que si el mazo local no la trae se cae al del
    rival. Null en partidas grabadas antes de esta función, o si ninguno de los dos mazos traía la bandera.
  - `GET /stats/seasons?contributor=Y` — seasons con alguna partida grabada, de más reciente a más antigua
    (`{code, name}`, p. ej. `{code:"VEN", name:"Vendetta"}`). Puramente derivado de lo que ya hay en la base
    de datos: en cuanto se sube la primera partida de una season nueva, aparece aquí sola.
  - `GET /stats/matchup-matrix?season=X&contributor=Y&deck=Z` (`season` obligatorio) — matriz Legend contra
    Legend al estilo de las tablas de counters de blitz.gg/u.gg: mismo pool de Legends en filas y columnas,
    cada celda con partidas/win rate/intervalo de confianza (Wilson 95%) de la fila contra la columna. Con
    las dos perspectivas de cada partida ya combinadas (ver arriba), cada partida aporta un punto de datos a
    la celda (A, B) y otro a la (B, A) — no hace falta lógica extra para "la vista desde el otro lado", ya
    llega así.
  - Sirve además `web/` como estáticos, así que abrir `http://localhost:4000` ya enseña el panel.
- `web/` — panel de estadísticas (HTML+JS sin build step, tema oscuro con detalles en degradado). Es una
  sola página con **cuatro herramientas** navegables por menú (sin build step ni framework de rutas: solo
  `location.hash` — `#tracker`, `#mulligan`, `#cards`, `#matrix` — mostrando/ocultando cada bloque; sin
  hash, la página de inicio):
  - **Inicio**: tarjetas grandes a cada herramienta.
  - **Rendimiento y win rate** (`#tracker`, la vista original): selector de Legend → Lista (opcional, todas
    las builds distintas jugadas con esa Legend) → Rival, tarjetas de resumen, vista de la decklist
    completa con imágenes cuando se elige una lista concreta, tabla de rendimiento por carta (ordenable,
    con imagen al pasar el ratón), tabla de matchups y partidas recientes.
  - **Simulador de mulligans** (`#mulligan`).
  - **Valoración de cartas** (`#cards`, estilo 17lands).
  - **Matriz de matchups** (`#matrix`, estilo blitz.gg/u.gg): botones para elegir la season (uno por cada
    season con partidas grabadas — aparece uno nuevo solo con jugar y grabar la primera partida de esa
    season, sin tocar código) y la cuadrícula Legend contra Legend, coloreada de rojo a verde según win
    rate, con el intervalo de confianza encima del porcentaje.

  El toggle Mis partidas/Comunidad es global (afecta a las cuatro herramientas, arriba del menú). El ancho de
  `main` es fluido (`min(1440px, 94vw)`, antes fijo a 1080px) para aprovechar pantallas anchas/apaisadas sin
  dejar márgenes laterales enormes, y sigue siendo responsive: por debajo de ~760px los controles se apilan
  en una columna y el menú de navegación pasa a envolver en varias filas; todas las tablas van además dentro
  de un contenedor con scroll horizontal propio, para no romper el layout de la página en móvil.
  - El simulador de mulligans roba 4 cartas al azar (solo de Spells+Units, que es lo único que se roba —
    Battlefields se elige al construir el mazo y las Runes son un recurso aparte) de la lista elegida, y
    sugiere hasta 2 para cambiar (el máximo real del juego) según: su win rate jugada on the play/on the
    draw en ese matchup, si su coste la deja varios turnos sin poder jugarse frente a las runas que tendrás
    en tu primer turno (2 on the play, 3 on the draw), y si ya hay otra copia en la mano. Es una heurística
    sobre agregados de partidas jugadas, **no datos reales de manos iniciales** — eso no se puede capturar
    (ver limitación de abajo) — así que puede acertar menos con poca muestra; el motivo aparece al pasar el
    ratón por cualquier carta de la mano generada, tanto las que se cambiarían como las que no.
  - La valoración de cartas agrupa cada carta jugada en una cuadrícula: filas = nota (A+ a F, por umbrales
    absolutos de win rate, no percentiles — con el volumen de partidas de una sola persona un percentil es
    ruidoso), columnas = dominio de runa. Pestañas para ver un set concreto (Origins, Origins: Proving
    Grounds, Spiritforged, Unleashed, Vendetta) o todos a la vez, y un selector de Legend opcional (por
    defecto agrega todas). El motivo (partidas jugadas) aparece al pasar el ratón, igual que en el resto
    del panel.

## Cómo probarlo

1. **Backend**: en `server/`, `cp .env.example .env`, `npm install`, `npm run prisma:migrate`, `npm run dev`
   (queda escuchando en `:4000`).
2. **Extensión**: `chrome://extensions` (o equivalente en Opera/Edge) → Modo desarrollador → Cargar
   descomprimida → carpeta `extension/`. Por defecto apunta a `http://localhost:4000`; cámbialo desde el
   icono de la extensión → "Configurar servidor" si tu backend está en otro sitio.
3. Juega una partida de Riftbound en tcg-arena.fr. Acepta el aviso de grabación al empezar y confirma el
   resultado al terminar.
4. Abre `http://localhost:4000` para ver el panel, o el icono de la extensión (lista las partidas locales y
   permite reintentar la subida si falló).

> Nota: el hook usa `"world": "MAIN"` en el `manifest.json`, soportado en Chrome/Chromium (Chrome, Opera,
> Edge) desde la v111. El soporte para Firefox necesita una variante distinta de inyección — pendiente.

## Limitaciones conocidas / próximos pasos

- **Mano inicial y mulligan por carta concreta: no implementado, y no es un simple TODO.** Investigado a
  fondo: los robos (`play.logs.player.draw`) solo llevan un contador, nunca la identidad de la carta, ni
  siquiera para el propio jugador. Verificado conectando dos pestañas directamente entre sí (sin
  dependencia de otra persona) que cada cliente calcula su propia mano **en local**, a partir de la
  decklist ya compartida y un barajado determinista — por diseño, nunca viaja por la red. Tampoco está en
  el DOM (el tablero se renderiza con `<img>` normales, pero el nombre de la carta forma parte de la imagen
  descargada del CDN de Riot, no hay texto ni alt). Camino identificado para una futura iteración: cruzar
  el `src` de los `<img>` de la zona de mano contra el mapa imagen→carta que ya se construye a partir de la
  `decklist` (esa sí viaja completa). Requiere localizar de forma fiable qué región del DOM es "mi mano" y
  observarla con un `MutationObserver`; no abordado todavía.
- **Lo que sí funciona ya, verificado con datos reales**: win rate de cada carta cuando se juega (identidad
  completa disponible en los eventos `cardMove.play.*`), cartas más importantes por matchup (Δ entre win
  rate jugada/no jugada) y el split on the play/on the draw, tanto a nivel de Legend como por carta.
- **Detección de season: confirmado que la bandera `_legal` existe en el protocolo, pero no todavía en un
  mensaje de `decklist` real.** Se vio `_legal: {"VEN": true, "UNL": true}` en la `cardData` de una carta
  capturada en vivo (mensaje `playerData.visibleCards`), y el propio deckbuilder de TCG Arena confirma el
  concepto de "season" con esos mismos códigos ("Choose Format" → "Standard (Vendetta)" / "Legacy
  (Unleashed)"). Los mazos que llegan por `decklist` reutilizan el mismo objeto de carta del catálogo (ya se
  lee `face.front.image`/`name`/`cost` de ahí), así que `_legal` debería estar igual de disponible — pero no
  se ha podido confirmar con una partida real todavía. Si al jugar la season sale siempre `null`, es la
  primera pista a revisar en `extension/parser.js` (`deriveSeason`).
- **Solo 1v1**: el parser asume dos jugadores (identifica "local" vs. "rival" por la dirección del mensaje:
  saliente/entrante). Partidas de 3-4 jugadores no están soportadas.
- **Detección de fin de partida sin verificar del todo**: el resultado se pide siempre confirmado a mano
  (por diseño) y en las partidas de prueba jugadas hasta el final coincidió con la victoria real. El
  detector automático (basado en el campo `isEliminated` de `playerData`) aún no se ha visto disparar de
  forma fiable por sí solo — sigue pidiéndose confirmación manual por precaución.
- **[Corregido] El propio mazo y las propias acciones no se capturaban**: `background.js` hacía
  `getState → mutar → setState` sobre `chrome.storage.session` sin esperar al mensaje anterior; en ráfagas
  (los fragmentos del `decklist`, o varias acciones seguidas) las escrituras concurrentes se pisaban entre
  sí. Verificado con un test aislado (solo 1 de 30 escrituras concurrentes sobrevivía sin el fix, 30 de 30
  con él) y corregido serializando por pestaña (`runExclusive`).
- **[Corregido] Los ids de jugador no coincidían entre mensajes**: `playerData` identifica a cada jugador
  con un id de conexión (prefijo `TCGA-`), pero `newToHistory`/`currentPlayer` usan un id de partida
  distinto — con el primero, la minería de cartas y el "on the play" nunca encontraban coincidencias.
  Corregido resolviendo el id de partida real cruzando por pseudónimo contra el propio log de eventos.
- **[Corregido] En un Bo3, la confirmación de partidas anteriores podía perderse sin avisar**: al cerrarse
  la conexión, `background.js` subía de inmediato como "UNKNOWN" cualquier Game de la serie que siguiera
  sin confirmar, en el mismo instante en que le pedía al jugador el resultado del último Game — el panel de
  confirmación de los anteriores nunca llegaba a mostrarse con tiempo real para contestar (se sustituía por
  el formulario del último Game antes de poder pulsar nada). Corregido unificando ambos flujos: ahora la
  última partida se añade a la misma lista de pendientes en vez de subirse aparte, y nada se sube hasta que
  el usuario confirma cada una a mano; solo se sube como "UNKNOWN" si la pestaña se cierra del todo sin
  contestar (último recurso, no el camino normal).
- **Sin panel de "mejores manos iniciales"** — bloqueado por el punto de la mano inicial de arriba.
- **Las imágenes de carta solo aparecen en partidas grabadas desde ahora.** Hasta esta versión, tanto el
  decklist como el log de eventos guardaban las cartas sin su URL de imagen (para ahorrar espacio). Las
  partidas ya guardadas antes de este cambio seguirán mostrando un placeholder ("?") en vez de la carta real
  en la vista de decklist y en el hover de la tabla de rendimiento — no hay forma de recuperar esa imagen a
  posteriori porque nunca se guardó. Las partidas nuevas sí la tendrán.
- **Repositorio común entre instalaciones — base técnica lista, hosting pendiente.** Cada instalación de la
  extensión genera un `contributorId` anónimo (UUID, `chrome.storage.local`, no identifica a la persona) y
  lo manda con cada partida. El botón "Ver panel de estadísticas" del popup abre la web con
  `?me=<contributorId>`, que lo guarda en `localStorage` y activa el toggle "Mis partidas" (filtra por tu
  id) vs. "Comunidad" (agrega todo el backend). El pseudo del rival nunca sale en las estadísticas
  agregadas — ni en modo "mis partidas" ni en "comunidad" — solo en `GET /matches`, que siempre exige un
  `contributor` y por tanto solo enseña tu propio historial, nunca el de otra instalación. Propuesta de
  despliegue gratuito sin dominio ni tarjeta: **Render** (web service gratis, sirve `server/` tal cual, sin
  Dockerfile) + **Turso** (SQLite/libSQL alojado, gratis, sin caducar) en vez del SQLite en disco actual —
  ver conversación para el detalle y los pasos de migración (cambiar el datasource de Prisma a libSQL).
  Nota: el free tier de Render "duerme" tras ~15 min sin tráfico y tarda unos 30-50s en despertar en la
  primera petición del día — aceptable para un grupo de amigos, no para un servicio con SLA. Tampoco hay
  autenticación ni límite de peticiones — para un grupo de amigos con la URL no es grave, pero antes de
  anunciarlo más ampliamente conviene añadir algo de rate-limiting.
test
