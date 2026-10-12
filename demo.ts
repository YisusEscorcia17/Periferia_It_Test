import { readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { cargarConfigPortal, type ConfigPortal } from "./src/config.js"
import { FsNode } from "./src/core/FileSystem.js"
import type { ToolContext } from "./src/core/BaseTool.js"
import { ArmarPaquete, GenerarPortal, LeerSolicitud, MapearCampos } from "./src/tools/proveedor.js"

const RAIZ = fileURLToPath(new URL(".", import.meta.url))

export interface PasoDemo {
  herramienta: string
  ok: boolean
  data?: unknown
  error?: string
}

// Ejecuta el flujo de un caso (sin clave LLM). Con `limpiar`, borra antes la carpeta de salida (determinismo).
export async function correrCaso(caso: string, cfg: ConfigPortal = cargarConfigPortal(), raiz = RAIZ, limpiar = true): Promise<PasoDemo[]> {
  if (limpiar) rmSync(join(raiz, cfg.rutas.out), { recursive: true, force: true })
  const ctx: ToolContext = { directory: raiz, fs: new FsNode(), clock: { hoy: () => cfg.fechaReferencia } }
  const herramientas = [new LeerSolicitud(cfg), new MapearCampos(cfg), new GenerarPortal(cfg), new ArmarPaquete(cfg)]
  const pasos: PasoDemo[] = []
  for (const t of herramientas) pasos.push({ herramienta: t.nombre, ...JSON.parse(await t.execute({ caso }, ctx)) })
  return pasos
}

// PRD 6.6: ejecuta todos los casos de fixtures; un caso malo no impide el siguiente.
export async function correrTodosLosCasos(cfg: ConfigPortal = cargarConfigPortal(), raiz = RAIZ): Promise<Record<string, PasoDemo[]>> {
  rmSync(join(raiz, cfg.rutas.out), { recursive: true, force: true })
  const casos = readdirSync(join(raiz, cfg.rutas.casos), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
  const resumen: Record<string, PasoDemo[]> = {}
  for (const caso of casos) resumen[caso] = await correrCaso(caso, cfg, raiz, false)
  return resumen
}

// Entrada de línea de comandos: npx tsx demo.ts [--caso=<slug>]  (sin --caso ejecuta todos)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const caso = process.argv.find((a) => a.startsWith("--caso="))?.slice("--caso=".length)
  const resumen = caso ? { [caso]: await correrCaso(caso) } : await correrTodosLosCasos()
  let todoOk = true
  for (const [nombre, pasos] of Object.entries(resumen)) {
    console.log(`\n## ${nombre}`)
    for (const p of pasos) {
      console.log(`${p.ok ? "✓" : "✗"} ${p.herramienta}${p.ok ? "" : `: ${p.error}`}`)
      todoOk &&= p.ok
    }
  }
  process.exitCode = todoOk ? 0 : 1
}
