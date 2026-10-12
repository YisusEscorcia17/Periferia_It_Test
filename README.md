# Reto 01 — Agente de registro como proveedor

Agente conversacional que procesa solicitudes de registro de proveedor: lee la solicitud, mapea los campos al maestro, genera el formulario, arma el paquete para firma y prepara el envío **solo con confirmación humana**. Diseño completo en [SOLUCION.md](SOLUCION.md); requisitos en [PRD.md](PRD.md).

## Requisitos

- Node.js 20 o superior (probado con Node 24.21).
- Una clave de Anthropic (`ANTHROPIC_API_KEY`).

## Puesta en marcha (local)

```bash
npm install
cp .env.example .env        # en Windows: copy .env.example .env
# edita .env: ANTHROPIC_API_KEY=... y LLM_MODEL=claude-haiku-5-5
npm run dev                 # front + backend en http://localhost:3000
```

## Variables de entorno

Todas están documentadas en `.env.example`. La clave **solo** se lee del entorno del backend; nunca aparece en el front, en el repositorio, en los logs ni en las respuestas de la API.

| Variable | Por defecto | Uso |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Clave del proveedor de modelo. |
| `LLM_MODEL` | `claude-haiku-5-5` | Modelo de Claude. |
| `LLM_DISABLED` | `false` | `true` ejecuta en modo demo sin modelo. |
| `PORT` | `3000` | Puerto del servidor. |
| `MAX_ITER` | `25` | Tope de iteraciones herramienta → modelo por turno (CA1). |
| `LLM_TIMEOUT_MS` | `30000` | Timeout de cada llamada al modelo. |
| `TOKENS_SESION` | `50000` | Tope de tokens por sesión (costo). |
| `FECHA_REFERENCIA` | `2026-09-03` | Fecha para evaluar vigencia de soportes. |
| `PROVEEDOR_RUTA_*` | rutas de `fixtures/` y `out/` | Rutas de casos, repositorio, salida y glosario. |

## Formatos de salida

| Formato del caso | Salida en `out/<caso>/` |
|---|---|
| `portal` | `valores-portal.md` (valores listos para copiar) |
| `xlsx` | `formulario.xlsx` (cada valor en la hoja y celda de `plantilla-celdas.json`) |
| `pdf` | `formulario.pdf` (etiqueta y valor en el orden de `plantilla-campos.json`) |

Los campos faltantes nunca se inventan: quedan vacíos en xlsx y marcados `(pendiente)` en pdf.

## Demo sin modelo

Ejecuta las herramientas directamente sobre todos los casos de `fixtures/reto-01/casos/`, sin clave de ningún proveedor:

```bash
npm run demo                          # todos los casos
npx tsx demo.ts --caso=pa-logistica-istmo   # un caso
```

La salida queda en `out/<caso>/`. Cada ejecución limpia `out/` primero.

## Pruebas

```bash
npm test                 # suite completa (Vitest)
npm run test:coverage    # cobertura
npm run typecheck        # tsc --noEmit
```

## Uso del chat

1. Abre http://localhost:3000.
2. Escribe, por ejemplo: `Procesa el caso "pa-logistica-istmo". Dime qué campos quedaron llenos, cuáles faltan y si el paquete está listo para firma. No envíes nada todavía.`
3. Las llamadas a herramientas aparecen en el chat. Cuando el agente propone el envío, aparece un diálogo con **Aceptar** / **Cancelar** (Esc cancela). Solo Aceptar crea `out/<caso>/ENVIO-SIMULADO.md`.

## Estructura

```
agent/prompt.md                  comportamiento del agente (system prompt)
src/knowledge/registro-proveedor.md   conocimiento del proceso
src/tools/proveedor.ts           herramientas proveedor_* (zod + contrato {ok,data}|{ok,error})
src/tools/index.ts               adaptador BaseTool → herramienta del chat
src/llm/anthropic.ts             adaptador del proveedor de modelo
src/ciclo.ts                     ciclo del agente (tope, confirmación, verificación de valores)
src/server.ts                    API HTTP, sesiones, confirmación con actionId
web/                             front de chat
fixtures/                        casos y repositorio (solo lectura)
demo.ts                          herramientas sin modelo
```

## Docker

```bash
docker compose up --build    # lee .env; la clave no entra en la imagen (ver .dockerignore)
```

La imagen se construyó sin probar en esta máquina porque el daemon de Docker no estaba activo. La instalación de producción (`npm ci --omit=dev`) sí se probó en una copia limpia.

## Módulo reutilizable (`modulo/`)

Agente empaquetado para otras plataformas de agentes, sin depender del servidor:

- `modulo/agent.md`: system prompt con frontmatter (`mode: primary`, edición y shell denegados).
- `modulo/tools/proveedor.ts`: las mismas herramientas de la aplicación (reexport).
- `modulo/skill/registro-proveedor/SKILL.md`: conocimiento del proceso.

Los dos `.md` se generan desde `agent/prompt.md` y `src/knowledge/`. Tras cambiar esas fuentes, ejecuta `npm run modulo`; la prueba `tests/unit/modulo.test.ts` falla si el módulo se desvía.

## Despliegue en Render

El archivo `render.yaml` describe el servicio (build, arranque, health check en `/api/health` y variables).

1. En Render: **New → Blueprint** y elige el repositorio `YisusEscorcia17/Periferia_It_Test`.
2. Render pedirá el valor de **ANTHROPIC_API_KEY**: pégalo ahí. No se guarda en el repositorio.
3. Espera el build (`npm ci --omit=dev`) y abre la URL del servicio. `/api/health` debe responder `{"ok":true,"provider":"anthropic",...}`.

Notas:
- El plan `free` se duerme tras un rato sin tráfico; la primera petición tarda más. Para la defensa, abre el enlace unos minutos antes o usa un plan que no se duerma.
- `out/` se borra al redesplegar (el disco es efímero). Las sesiones viven en memoria.
- Como el enlace es público, `TOKENS_GLOBALES` (2 000 000 por defecto) corta el gasto total de la clave cuando se agota el presupuesto.

## Enlace de prueba

Pendiente de despliegue. Mientras tanto, el agente corre en local con `npm run dev` o `docker compose up`.
