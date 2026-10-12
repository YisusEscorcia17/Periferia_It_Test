import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { IFileSystem, ToolContext } from "../../src/core/BaseTool.js"
import { FsNode } from "../../src/core/FileSystem.js"
import { cargarConfigPortal } from "../../src/config.js"
import { ArmarPaquete } from "../../src/tools/proveedor.js"

const raiz = fileURLToPath(new URL("../../", import.meta.url))
const cfg = cargarConfigPortal()
const reloj = { hoy: () => "2026-09-03" }
const salidaDir = join(raiz, cfg.rutas.out, "pa-logistica-istmo")
const paqueteDir = join(salidaDir, "paquete")
const rutaIndex = join(raiz, cfg.rutas.repositorio, "soportes", "index.json")

// Registra escrituras y copias; permite sobreescribir lecturas (p.ej. el índice de soportes).
function fsGrabador(overrides: Record<string, string> = {}) {
  const real = new FsNode()
  const escritos: Record<string, string> = {}
  const copias: Array<[string, string]> = []
  const fs: IFileSystem & { escritos: typeof escritos; copias: typeof copias } = {
    escritos,
    copias,
    leer: (ruta) => (ruta in overrides ? overrides[ruta] : real.leer(ruta)),
    existe: (ruta) => ruta in overrides || real.existe(ruta),
    escribir: (ruta, contenido) => {
      escritos[ruta] = contenido
    },
    escribirBinario: () => {}, copiar: (origen, destino) => {
      copias.push([origen, destino])
    },
    listar: () => [],
    borrar: () => {},
  }
  return fs
}

async function armar(overrides: Record<string, string> = {}) {
  const fs = fsGrabador(overrides)
  const ctx: ToolContext = { directory: raiz, fs, clock: reloj }
  const salida = JSON.parse(await new ArmarPaquete().execute({ caso: "pa-logistica-istmo" }, ctx))
  return { salida, fs }
}

type Item = { tipo: string; estado: string }

describe("ArmarPaquete", () => {
  it("con soportes presentes y vigentes: checklist 2/2 y listo_para_firma true", async () => {
    const { salida } = await armar()
    expect(salida.ok).toBe(true)
    expect(salida.data.listo_para_firma).toBe(true)
    expect(salida.data.checklist).toEqual([
      { tipo: "camara_comercio", estado: "presente" },
      { tipo: "rut", estado: "presente" },
    ] satisfies Item[])
  })

  it("checklist distingue presente, ausente y vencido; vencido bloquea la firma", async () => {
    const indexVencido = JSON.stringify([
      { tipo: "camara_comercio", archivo: "camara-comercio-2026-08.txt", vigencia_hasta: "2026-08-01", pais_emisor: "CO" },
      { tipo: "rut", archivo: "rut-2026.txt", vigencia_hasta: null, pais_emisor: "CO" },
    ])
    const vencido = (await armar({ [rutaIndex]: indexVencido })).salida
    expect(vencido.data.listo_para_firma).toBe(false)
    expect(vencido.data.checklist).toContainEqual({ tipo: "camara_comercio", estado: "vencido" })

    const sinRut = JSON.stringify([
      { tipo: "camara_comercio", archivo: "camara-comercio-2026-08.txt", vigencia_hasta: "2026-09-30", pais_emisor: "CO" },
    ])
    const ausente = (await armar({ [rutaIndex]: sinRut })).salida
    expect(ausente.data.listo_para_firma).toBe(false)
    expect(ausente.data.checklist).toContainEqual({ tipo: "rut", estado: "ausente" })
  })

  it("copia los soportes presentes al paquete y escribe checklist.md", async () => {
    const { fs } = await armar()
    const destinos = fs.copias.map(([, destino]) => destino)
    expect(destinos).toContain(join(paqueteDir, "camara-comercio-2026-08.txt"))
    expect(destinos).toContain(join(paqueteDir, "rut-2026.txt"))
    expect(fs.escritos[join(paqueteDir, "checklist.md")]).toMatch(/camara_comercio/)
  })

  it("borrador-correo.md no contiene datos bancarios", async () => {
    const { fs } = await armar()
    const borrador = fs.escritos[join(paqueteDir, "borrador-correo.md")]
    expect(borrador).toBeTruthy()
    expect(borrador).not.toMatch(/03100012345/)
    expect(borrador).not.toMatch(/COLOCOBM/)
    expect(borrador).not.toMatch(/Bancolombia/)
  })

  it("registra una línea JSON válida en log.jsonl", async () => {
    const { fs } = await armar()
    const log = fs.escritos[join(salidaDir, "log.jsonl")]
    expect(log).toBeTruthy()
    const linea = JSON.parse(log.trim().split("\n").at(-1)!)
    expect(linea).toMatchObject({ herramienta: "proveedor_armar_paquete", ok: true })
    expect(linea).toHaveProperty("ts")
    expect(linea).toHaveProperty("resumen")
  })
})

describe("ArmarPaquete (RN3, HU-4)", () => {
  it("el checklist lista los campos faltantes sin bloquear listo_para_firma", async () => {
    const plantillaConFaltante = JSON.stringify([{ etiqueta: "Campo inexistente XYZ", obligatorio: true }])
    const plantilla = join(raiz, cfg.rutas.casos, "pa-logistica-istmo", "plantilla-campos.json")
    const { salida, fs } = await armar({ [plantilla]: plantillaConFaltante })
    expect(salida.data.listo_para_firma).toBe(true)
    expect(salida.data.campos.faltantes).toEqual(["Campo inexistente XYZ"])
    expect(fs.escritos[join(paqueteDir, "checklist.md")]).toMatch(/Campo inexistente XYZ/)
  })

  it("un soporte vencido que existe en el repositorio se copia al paquete y bloquea la firma", async () => {
    const indexVencido = JSON.stringify([
      { tipo: "camara_comercio", archivo: "camara-comercio-2026-08.txt", vigencia_hasta: "2026-08-01", pais_emisor: "CO" },
      { tipo: "rut", archivo: "rut-2026.txt", vigencia_hasta: null, pais_emisor: "CO" },
    ])
    const { salida, fs } = await armar({ [rutaIndex]: indexVencido })
    expect(salida.data.listo_para_firma).toBe(false)
    expect(fs.copias.map(([, d]) => d)).toContain(join(paqueteDir, "camara-comercio-2026-08.txt"))
  })
})
