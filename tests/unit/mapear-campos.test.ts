import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { IFileSystem, ToolContext } from "../../src/core/BaseTool.js"
import { FsNode } from "../../src/core/FileSystem.js"
import { cargarConfigPortal } from "../../src/config.js"
import { MapearCampos } from "../../src/tools/proveedor.js"

const raiz = fileURLToPath(new URL("../../", import.meta.url))
const cfg = cargarConfigPortal()
const reloj = { hoy: () => "2026-09-03" }
const dirCaso = (caso: string) => join(raiz, cfg.rutas.casos, caso)
const rutaMaestro = join(raiz, cfg.rutas.repositorio, "maestro.json")
const rutaGlosario = join(raiz, cfg.rutas.glosario)

// Sistema real con sobreescrituras puntuales por ruta.
function fsCon(overrides: Record<string, string>): IFileSystem {
  const real = new FsNode()
  return {
    leer: (ruta) => (ruta in overrides ? overrides[ruta] : real.leer(ruta)),
    existe: (ruta) => ruta in overrides || real.existe(ruta),
    escribir: () => {},
    escribirBinario: () => {}, copiar: () => {},
    listar: () => [],
    borrar: () => {},
  }
}

const ctxCon = (overrides: Record<string, string> = {}): ToolContext => ({ directory: raiz, fs: fsCon(overrides), clock: reloj })

type Mapeo = {
  pais: string
  llenos: Array<{ etiqueta: string; valor: unknown; fuente: string }>
  faltantes: Array<{ etiqueta: string }>
  requiere_confirmacion: Array<{ etiqueta: string; valor?: unknown; fuente?: string; nota: string }>
}

async function mapear(args: { caso: string; campos?: Array<{ etiqueta: string }> }, overrides: Record<string, string> = {}) {
  return JSON.parse(await new MapearCampos().execute(args, ctxCon(overrides))) as { ok: boolean; data: Mapeo; error?: string }
}

const plantillaCon = (etiquetas: string[]) => JSON.stringify(etiquetas.map((etiqueta) => ({ etiqueta, obligatorio: true })))
const plantillaPa = join(dirCaso("pa-logistica-istmo"), "plantilla-campos.json")

describe("MapearCampos (contrato PRD 6.2)", () => {
  it("PA: 8 llenos con fuente y el RUC en requiere_confirmacion con nota de identificador extranjero", async () => {
    const { ok, data } = await mapear({ caso: "pa-logistica-istmo" })
    expect(ok).toBe(true)
    expect(data.llenos).toHaveLength(8)
    expect(data.faltantes).toEqual([])
    expect(data.requiere_confirmacion).toEqual([
      expect.objectContaining({ etiqueta: "RUC", valor: "900123456", fuente: "nit", nota: expect.stringMatching(/identificador extranjero/) }),
    ])
    expect(data.llenos.find((c) => c.etiqueta === "Número de cuenta")).toMatchObject({ valor: "03100012345", fuente: "banco.numero_cuenta" })
  })

  it("HU-1: una etiqueta tributaria ambigua en Colombia se marca requiere_confirmacion aunque el país sea CO", async () => {
    const { data } = await mapear({ caso: "pa-logistica-istmo" }, { [plantillaPa]: plantillaCon(["Identificación tributaria"]), [join(dirCaso("pa-logistica-istmo"), "solicitud.json")]: JSON.stringify({ pais: "CO", cliente: "X", formato: "portal" }) })
    expect(data.llenos).toEqual([])
    expect(data.requiere_confirmacion).toEqual([expect.objectContaining({ etiqueta: "Identificación tributaria", valor: "900123456", nota: expect.stringMatching(/ambigua/) })])
  })

  it("un campo sin equivalencia va a faltantes y nunca se inventa valor", async () => {
    const { data } = await mapear({ caso: "pa-logistica-istmo" }, { [plantillaPa]: plantillaCon(["Campo inexistente XYZ"]) })
    expect(data.faltantes).toEqual([{ etiqueta: "Campo inexistente XYZ" }])
    expect(data.llenos).toEqual([])
  })

  it("equivalencia en glosario sin dato en maestro va a faltantes", async () => {
    const maestro = JSON.parse(new FsNode().leer(rutaMaestro))
    delete maestro.banco
    const { data } = await mapear({ caso: "pa-logistica-istmo" }, { [rutaMaestro]: JSON.stringify(maestro), [plantillaPa]: plantillaCon(["SWIFT"]) })
    expect(data.faltantes).toEqual([{ etiqueta: "SWIFT" }])
  })

  it("el glosario resuelve sinónimos al campo del maestro", async () => {
    const { data } = await mapear({ caso: "pa-logistica-istmo" }, { [plantillaPa]: plantillaCon(["Nombre o razón social del proveedor"]) })
    expect(data.llenos).toEqual([expect.objectContaining({ fuente: "razon_social" })])
  })

  it("acepta una lista de campos explícita (campos[]) en lugar de la plantilla", async () => {
    const { data } = await mapear({ caso: "pa-logistica-istmo", campos: [{ etiqueta: "RUC" }] })
    expect(data.requiere_confirmacion).toHaveLength(1)
    expect(data.llenos).toEqual([])
  })

  it("lee la plantilla de celdas (xlsx) igual que la de campos", async () => {
    const { ok, data } = await mapear({ caso: "co-industrias-delta" })
    expect(ok).toBe(true)
    expect(data.llenos.length + data.faltantes.length + data.requiere_confirmacion.length).toBeGreaterThan(0)
  })

  it("glosario corrupto no lanza: devuelve {ok:false}", async () => {
    const { ok } = await mapear({ caso: "pa-logistica-istmo" }, { [rutaGlosario]: "{roto" })
    expect(ok).toBe(false)
  })
})
