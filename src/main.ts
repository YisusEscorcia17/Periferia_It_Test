import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { cargarConfig, cargarConfigPortal } from "./config.js"
import { crearApp } from "./server.js"
import type { Adaptador } from "./llm/adapter.js"
import { crearAnthropic } from "./llm/anthropic.js"
import { crearHerramientas } from "./tools/index.js"
import type { Herramientas } from "./tools/registry.js"

const raiz = join(import.meta.dirname, "..")
const cfg = cargarConfig()

const adapter: Adaptador =
  cfg.llmDisabled || !cfg.apiKey
    ? {
        nombre: "disabled",
        modelo: "none",
        async enviar() {
          return { text: "Modo demo sin modelo (LLM_DISABLED o sin ANTHROPIC_API_KEY)." }
        },
      }
    : crearAnthropic({ apiKey: cfg.apiKey, model: cfg.model, timeoutMs: cfg.llmTimeoutMs })

const tools: Herramientas = crearHerramientas(raiz)
const sistema = await readFile(join(raiz, "agent/prompt.md"), "utf8")

crearApp({
  adapter,
  tools,
  maxIter: cfg.maxIter,
  tokensSesion: cargarConfigPortal().topes.tokensSesion,
  tokensGlobales: cargarConfigPortal().topes.tokensGlobales,
  outDir: join(raiz, "out"),
  casosDir: join(raiz, "fixtures/reto-01/casos"),
  webDir: join(raiz, "web"),
  sistema,
}).listen(cfg.port, () => console.log(JSON.stringify({ evento: "listo", port: cfg.port })))
