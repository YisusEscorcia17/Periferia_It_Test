import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { IFileSystem, ToolContext } from "../../src/core/BaseTool.js"
import { FsNode } from "../../src/core/FileSystem.js"
import { cargarConfigPortal } from "../../src/config.js"
import { SimularEnvio } from "../../src/tools/proveedor.js"

const raiz = fileURLToPath(new URL("../../", import.meta.url))
const cfg = cargarConfigPortal()
const reloj = { hoy: () => "2026-09-03" }
const envioRuta = join(raiz, cfg.rutas.out, "pa-logistica-istmo", "ENVIO-SIMULADO.md")
// El log de observabilidad se escribe en toda ejecución; no cuenta como artefacto de negocio.
const sinLog = (escritos: Record<string, string>) => Object.keys(escritos).filter((r) => !r.endsWith("log.jsonl"))

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

async function simular(args: { caso: string; confirmado?: boolean }) {
  const fs = fsGrabador()
  const ctx: ToolContext = { directory: raiz, fs, clock: reloj }
  const salida = JSON.parse(await new SimularEnvio().execute(args, ctx))
  return { salida, escritos: fs.escritos }
}

describe("SimularEnvio", () => {
  it("sin confirmado devuelve error y no crea archivo", async () => {
    const { salida, escritos } = await simular({ caso: "pa-logistica-istmo" })
    expect(salida.ok).toBe(false)
    expect(salida.error).toMatch(/requiere confirmación explícita/)
    expect(sinLog(escritos)).toHaveLength(0)
  })

  it("confirmado=false también devuelve error y no crea archivo", async () => {
    const { salida, escritos } = await simular({ caso: "pa-logistica-istmo", confirmado: false })
    expect(salida.ok).toBe(false)
    expect(sinLog(escritos)).toHaveLength(0)
  })

  it("con confirmado=true crea ENVIO-SIMULADO.md", async () => {
    const { salida, escritos } = await simular({ caso: "pa-logistica-istmo", confirmado: true })
    expect(salida.ok).toBe(true)
    expect(sinLog(escritos)).toEqual([envioRuta])
  })
})
