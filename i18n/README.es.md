<div align="center">

<h1>open-browser-use</h1>

<p><b>Deja que los agentes controlen el navegador que ya usas.</b></p>

<img src="../open-browser-use-readme-preview-wide.png" alt="open-browser-use — agent browser tool, agentic RL ready" width="820">

<sub><a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <b>Español</b></sub>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
  <img alt="Status: public preview" src="https://img.shields.io/badge/status-public%20preview-orange?style=flat-square">
  <img alt="Platforms: macOS and Linux" src="https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux-lightgrey?style=flat-square">
  <br>
  <img alt="Built with Rust" src="https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white">
  <img alt="Built with TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Model Context Protocol" src="https://img.shields.io/badge/MCP-server-7C3AED?style=flat-square">
</p>

</div>

---

Tu agente de programación puede razonar, planificar y escribir código. Pero en cuanto una tarea vive detrás de un inicio de sesión, dentro de un panel sin API, o en un formulario web de varios pasos lleno de clics, choca contra un muro: cerebro de sobra, pero ninguna mano sobre el navegador. **open-browser-use le da esas manos** — manejando *tu* navegador real, en el que ya tienes la sesión iniciada, completamente en tu propia máquina.

## Tu agente tiene cerebro, pero no manos

Nos encanta decirle a los agentes que «simplemente se encarguen de ello». El problema es que buena parte de *ello* vive en una pestaña del navegador:

- «Descarga todas las facturas de mi correo de este trimestre y súmalas.»
- «Vuelve a pedir mi compra habitual en la tienda en la que ya tengo la sesión iniciada.»
- «Extrae las cifras de este panel — no tiene botón de exportar.»
- «Rellena esta solicitud con los datos de aquel PDF.»

Ninguna de estas tareas es difícil de *pensar*. Son difíciles porque el agente no puede *tocar* la página. open-browser-use cierra esa brecha, y trata de hacerlo de la manera amable:

- **Tu navegador real, tus sesiones.** Maneja el Chrome que ya usas, con tus inicios de sesión y tus cookies — no un navegador robot recién abierto y sin sesión. Así puede hacer tus recados *de verdad*.
- **Local y privado.** Todo se ejecuta en tu máquina. Sin nube, sin cuenta, nada llama a casa.
- **Funciona con los agentes que ya tienes.** Codex, Claude Code, Cursor, Gemini CLI, VS Code y más — a través del Model Context Protocol (MCP).
- **Código abierto**, con licencia MIT.

## Instalación (vista previa actual)

open-browser-use es una **vista previa pública para macOS / Linux** — la ficha de la Chrome Web Store aún no está activa, así que la extensión se distribuye a través de GitHub Releases. Solo configuras una cosa a mano: la extensión del navegador. Tu agente de IA instala y conecta todo lo demás.

1. **[Descarga la extensión](https://github.com/open-browser-use/open-browser-use/releases/latest/download/open-browser-use-extension.zip)** de la última versión y luego descomprímela.
2. **Cárgala en tu navegador:** abre `chrome://extensions` (Chrome u otro navegador Chromium), activa el **Modo de desarrollador**, haz clic en **Cargar descomprimida** y selecciona la carpeta descomprimida. Ánclala — su ventana emergente es por donde conectarás tu agente a continuación.

> [!NOTE]
> Una vez que la ficha de la Chrome Web Store esté activa, añadirás la extensión directamente desde la Store — sin descargas ni descompresión. Para notas específicas de cada plataforma y solución de problemas, consulta [docs/install.md](../docs/install.md) y [docs/troubleshooting.md](../docs/troubleshooting.md).

## Inicio rápido

Con la extensión cargada, conectarla a tu agente de programación lleva alrededor de un minuto — sin archivos de configuración que editar a mano:

1. **Abre la ventana emergente de la extensión** y haz clic en **Copy for agent**.
2. **Pégalo en tu agente de programación** (Codex, Claude Code, Cursor, Gemini CLI, …).
3. El agente **configura el servidor MCP de open-browser-use y se conecta a tu navegador.** Eso es todo.

> [!TIP]
> Luego simplemente pídelo, en lenguaje natural:
> *«Abre mis notificaciones de GitHub y resume lo que realmente necesita mi atención.»*

## Capacidades

Tu agente maneja el navegador a través de una única herramienta `js`. El JavaScript que escribe se ejecuta en un runtime de Node persistente donde un SDK con forma de Playwright está vinculado al global `agent`, de modo que un turno completo de trabajo en el navegador se mantiene pequeño y legible:

```js
const browser = await agent.browsers.get("chrome");
const tab = await browser.tabs.current();
await tab.attach();                                   // toma el control de la pestaña
await tab.goto("https://news.ycombinator.com");
await tab.getByRole("link", { name: "new" }).click();
display(await tab.locator("h1").innerText());         // muestra un resultado
await browser.turnEnded();                            // devuelve el control, conserva la sesión
```

El SDK cubre toda la gama de interacciones que exige una tarea real:

| Capacidad | Qué proporciona |
| --- | --- |
| **Actuar sobre elementos** | Hacer clic, rellenar, escribir, pulsar teclas, seleccionar y pasar el cursor — direccionados por rol ARIA, texto visible o selector CSS: los locators resilientes, al estilo de Playwright, que sobreviven a los cambios del marcado. |
| **Clic por vista o nodo del DOM** | Interacción por visión/coordenada y direccionada por el DOM para páginas sin un selector limpio, incluidos los objetivos dentro de iframes de origen cruzado. |
| **Leer y extraer** | Texto de la página y de elementos, tablas, atributos y capturas de pantalla. |
| **Archivos y diálogos** | Subidas y descargas de archivos, además del manejo nativo de `alert`, `confirm` y `prompt`. |
| **Pestañas, sesiones y reanudación** | Manejar varias pestañas y sesiones en paralelo, y reanudar tareas de larga duración a lo largo de los turnos sin perder el hilo. |

Para flujos de trabajo de más alto nivel, el SDK añade helpers ergonómicos (`tab.act.*`, `tab.flows`, `tab.read`) sobre estas mismas primitivas.

## Arquitectura

Para tu agente, open-browser-use es un servidor MCP. El agente escribe JavaScript a través de la única herramienta `js`; ese código se ejecuta en un runtime de Node de larga vida donde el SDK está vinculado a `agent`. Las llamadas del SDK se enmarcan como JSON-RPC y viajan a través de un Unix socket, restringido por capacidades y exclusivo del propietario, hasta **`obu-host`** — un daemon broker por sesión que maneja tu navegador mediante uno de dos backends:

```
your agent
   │  MCP over stdio              (la herramienta `js`; tú escribes JS, el SDK es `agent`)
   ▼
obu-node-repl                     (servidor MCP + el runtime de Node que lanza)
   │  JSON-RPC over an owner-only Unix socket   (restringido por capacidades)
   ▼
obu-host                          (daemon broker por sesión)
   ├─▶ WebExtension backend ─▶ your everyday Chrome        (MV3 + native messaging, sin puerto de depuración)
   └─▶ CDP backend          ─▶ Chrome with remote debugging   (OBU_CDP_URL)
```

Ambos backends hablan el mismo protocolo y presentan el mismo SDK; solo difieren en cómo alcanzan el navegador:

| Backend | Cómo alcanza el navegador | Ideal para |
| --- | --- | --- |
| **WebExtension** *(predeterminado)* | Un Chrome instalado de forma normal a través de la extensión de open-browser-use (MV3 + native messaging) — sin `--remote-debugging-port`, con tu perfil real y tus inicios de sesión intactos. | El uso diario contra el navegador en el que ya inicias sesión. |
| **CDP** | Cualquier Chrome iniciado con depuración remota, direccionado mediante `OBU_CDP_URL`. | Ejecuciones headless, en contenedores y con scripts. |

<details>
<summary><b>Estructura del repositorio</b> — dónde vive cada pieza</summary>

| Ruta | Qué es |
| --- | --- |
| `crates/obu-wire` | Framing, sobres (envelopes) y códigos de error de JSON-RPC compartidos. |
| `crates/obu-node-repl` | El servidor MCP: lanza el runtime de Node (donde se ejecuta el SDK) y hace de broker de su socket, restringido por capacidades, hacia `obu-host`. |
| `crates/obu-host` | El daemon broker por sesión y los backends de CDP / WebExtension. |
| `packages/sdk` | El SDK de TypeScript con forma de Playwright, orientado al agente (`@open-browser-use/sdk`). |
| `packages/browser-control-core` | Tipos de protocolo puros, planificadores y fixtures compartidos por el SDK y la extensión. |
| `packages/cli` | La línea de comandos `obu` — `setup`, `verify`, `doctor` y el cableado MCP del agente. |
| `packages/extension` | La extensión Chromium MV3 y su puente con el native-host. |

</details>

## Seguridad y privacidad

open-browser-use es local-first por diseño: nunca llama a una URL remota ni a un servicio de políticas de producto, y nada sobre tu navegación sale de tu máquina. Los guards del SDK y la política del host se ejecutan localmente y son permisivos por defecto — solo los endureces cuando lo necesitas. Tres capas te dan el control, desde el límite del proceso hacia afuera.

**Límite del proceso.** `obu-host` escucha en un Unix socket que es exclusivo del propietario y se autentica por el usuario del sistema operativo, y solo el código del SDK de confianza posee el token de capacidad necesario para alcanzarlo. open-browser-use nunca abre una conexión hacia un servicio remoto.

**Política del host.** Restringe lo que el navegador puede hacer con variables de entorno:

| Variable | Efecto |
| --- | --- |
| `OBU_HOST_POLICY_DENY_ORIGINS` | Bloquea la navegación y los comandos sobre el origen actual para los orígenes indicados. |
| `OBU_HOST_POLICY_DENY_CDP_METHODS` | Bloquea métodos CDP en bruto específicos (`*` los bloquea todos). |
| `OBU_HOST_POLICY_BLOCK_HISTORY` / `_BLOCK_DOWNLOADS` / `_BLOCK_UPLOADS` | Bloquea las lecturas del historial, las descargas o las subidas. |
| `OBU_GUARD_MODE=disabled` | Bypass local/de pruebas para todas las comprobaciones de guards y políticas. |

**Guards del SDK.** Para un control programático por navegador, instala hooks `Guards` para navegación, descargas, subidas, historial y CDP en bruto. Se ejecutan dentro de tu proceso de agente local y no hacen ninguna petición de red:

```ts
import { Guards } from "@open-browser-use/sdk";

const browser = await agent.browsers.get("chrome", {
  guards: new Guards({
    checkNavigation(url) {
      if (url.startsWith("https://admin.example/")) throw new Error("navigation blocked");
    },
  }),
});
```

## Entorno de RL agéntico

open-browser-use está construido para servir también como un **entorno para entrenar y evaluar agentes de navegador**, no solo para ejecutarlos. El núcleo de aprendizaje por refuerzo ya existe; lo que falta es el andamiaje a su alrededor.

**Ya disponible**

- **Un bucle de acción/observación con forma de entorno.** `tab.observe()` devuelve un `TabObservation` tipado; `tab.step(action)` recibe un `EnvAction` tipado y devuelve un `ActionResult`. `EnvAction` abarca **13 tipos de acción** repartidos en tres modos de direccionamiento — `locator.*`, `dom_cua.*` y `coordinate.*` — cada uno con una `policy` de capacidad opcional.
- **Resultados de paso ricos y estructurados.** `ActionResult` informa de un `ActionEffect` (`navigation`, `dom_changed`, `download_started`, `no_visible_change`, …), `invalidatedObservations`, handles, avisos y un `error` estructurado — señal suficiente para guiar a un aprendiz o a un verificador.
- **Episodios duraderos con recuperación.** Las sesiones llevan arbitraje de propiedad, diagnósticos de handles obsoletos, pruebas del turno del propietario y `resume`, de modo que los episodios largos sobreviven a caídas y reconexiones. Las tareas se exportan a `EpisodeExport { task_id, turns, events }`.

**Aún no disponible** — no hay una única fachada `Environment` que exponga un `reset/step/observe/close` formal y muestreable; `browser.reset()` solo restablece el viewport (el backend se conecta a un navegador en lugar de lanzar uno desechable); y no hay un sustrato de verificador integrado, un esquema de trayectorias con recompensa, una flota de rollouts en paralelo, ni un cliente de Python / de red (HTTP/gRPC) — hoy la superficie es MCP-stdio más el broker de tubería nativa.

### Hoja de ruta hacia un entorno entrenable

Ordenada según la ruta crítica hacia *«¿se puede entrenar de verdad contra él?»*:

- [ ] **Fachada de entorno + protocolo neutral respecto al lenguaje + cliente de Python** *(pieza clave)* — converger `reset/step/observe/close` detrás de una superficie HTTP/gRPC (o adaptadores para los frameworks de RL más comunes) para que un entrenador externo pueda impulsar rollouts a gran escala.
- [ ] **`reset()` limpio y con semilla** — permitir que el backend lance un navegador desechable con un perfil nuevo y una URL de inicio fija, desmontado al final del episodio. Esta única capacidad desbloquea tanto el reset *como* el paralelismo.
- [ ] **Sustrato de verificador (RLVR)** — una biblioteca de aserciones determinista (`url_contains`, `text_visible`, `dom_query`, `download_produced`, predicado JS) más `episode.evaluate({ assertions })`.
- [ ] **Esquema de trayectorias listo para entrenamiento** — tipar `EpisodeExport.turns` en registros `(obs, action, effect, reward, done)` con exportación estándar a JSONL / dataset de Hugging Face.
- [ ] **Flota de rollouts en paralelo** — un pool de N navegadores aislados con stepping asíncrono (se apoya en el reset limpio).
- [ ] **Determinismo y reproducibilidad** — semillas, grabación/reproducción de red opcional e instancias de tarea fijas con hash de contenido para detectar la deriva de la web en vivo.

## Compilar desde el código fuente

Compila y prueba todo el workspace:

```bash
cargo test --workspace
pnpm install --frozen-lockfile
pnpm -r build && pnpm -r test
```

Los nombres de los métodos del wire, las clases de guards del SDK, las clases de política del host y los estados de soporte de cada backend se generan todos a partir de `wire/methods.json`. Después de cambiar un método del wire, regenera las tablas de TypeScript/Rust y ejecuta la comprobación de vigencia:

```bash
pnpm generate:wire-methods
pnpm check:wire-methods
```

El empaquetado, la cobertura y los gates end-to-end de CDP / WebExtension (marcados como ignorados) tienen sus propios scripts y configuración; consulta [docs/install.md](../docs/install.md), [docs/troubleshooting.md](../docs/troubleshooting.md) y [docs/release-checklist.md](../docs/release-checklist.md).

## Licencia

open-browser-use tiene licencia MIT — consulta [LICENSE](../LICENSE). Los paquetes de las versiones también incluyen componentes de terceros bajo sus licencias originales; los detalles están en [LICENSE-THIRD-PARTY.md](../LICENSE-THIRD-PARTY.md).

---

<div align="center">
<sub>Construido con Rust + TypeScript · manejado a través del Model Context Protocol · vista previa pública para macOS / Linux</sub>
</div>
