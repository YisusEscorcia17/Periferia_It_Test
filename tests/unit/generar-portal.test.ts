import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { IFileSystem, ToolContext } from "../../src/core/BaseTool.js"
import { FsNode } from "../../src/core/FileSystem.js"
import { cargarConfigPortal } from "../../src/config.js"
import { GenerarPortal } from "../../src/tools/proveedor.js"

const raiz = fileURLToPath(new URL("../../", import.meta.url))
const cfg = cargarConfigPortal()
const reloj = { hoy: () => "2026-09-03" }
const salidaDir = join(raiz, cfg.rutas.out, "pa-logistica-istmo")
// El log de observabilidad se escribe en toda ejecución; no cuenta como artefacto de negocio.
const sinLog = (escritos: Record<string, string>) => Object.keys(escritos).filter((r) => !r.endsWith("log.jsonl"))

// Registra cada escritura para verificar qué archivos se crean.
function fsGrabador(): IFileSystem & { escritos: Record<string, string> } {
  const real = new FsNode()
  const escritos: Record<string, string> = {}
  return {
    escritos,
    leer: (ruta) => real.leer(ruta),
    existe: (ruta) => real.existe(ruta),
    escribir: (ruta, contenido) => {
      escritos[ruta] = contenido
    },
    escribirBinario: () => {}, copiar: () => {},
    listar: () => [],
    borrar: () => {},
  }
}

async function generar(args: { caso: string; formato?: string }) {
  const fs = fsGrabador()
  const ctx: ToolContext = { directory: raiz, fs, clock: reloj }
  const salida = JSON.parse(await new GenerarPortal().execute(args, ctx))
  return { salida, escritos: fs.escritos }
}

describe("GenerarPortal", () => {
  it("crea valores-portal.md con tabla de 9 filas campo/valor/fuente", async () => {
    const { salida, escritos } = await generar({ caso: "pa-logistica-istmo", formato: "portal" })
    expect(salida.ok).toBe(true)
    const ruta = join(salidaDir, "valores-portal.md")
    expect(sinLog(escritos)).toEqual([ruta])
    const filasDatos = escritos[ruta].split("\n").filter((l) => l.startsWith("|")).slice(2)
    expect(filasDatos).toHaveLength(9)
  })

  it("no genera xlsx ni pdf", async () => {
    const { escritos } = await generar({ caso: "pa-logistica-istmo", formato: "portal" })
    for (const ruta of sinLog(escritos)) {
      expect(ruta).not.toMatch(/\.(xlsx|pdf)$/)
    }
  })

  it("responde formato_no_soporte para formatos sin rama (docx) y no escribe nada", async () => {
    for (const formato of ["docx"]) {
      const { salida, escritos } = await generar({ caso: "pa-logistica-istmo", formato })
      expect(salida.data.formato_no_soporte).toBe(true)
      expect(sinLog(escritos)).toHaveLength(0)
    }
  })
})

describe("GenerarPortal con mapeo explícito (PRD 6.2: {caso, mapeo})", () => {
  it("usa el mapeo recibido en lugar de recalcularlo", async () => {
    const mapeo = {
      pais: "PA",
      llenos: [{ etiqueta: "Dirección", valor: "Calle X", fuente: "direccion" }],
      faltantes: [{ etiqueta: "Banco" }],
      requiere_confirmacion: [],
    }
    const { salida, escritos } = await generar({ caso: "pa-logistica-istmo", mapeo } as { caso: string; formato?: string })
    expect(salida.ok).toBe(true)
    const md = escritos[join(salidaDir, "valores-portal.md")]
    expect(md).toMatch(/\| Dirección \| Calle X \| direccion \|/)
    expect(md).toMatch(/\| Banco \| — \| faltante \|/)
    expect(md.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| campo")).length).toBe(2)
  })
})
