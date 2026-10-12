// Pruebas de aceptación por historia de usuario (PRD sección 5). Un bloque por criterio.
import { readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import type { IFileSystem, ToolContext } from "../src/core/BaseTool.js"
import { cargarConfigPortal } from "../src/config.js"
import { FsNode } from "../src/core/FileSystem.js"
import { ArmarPaquete, GenerarPortal, LeerSolicitud, MapearCampos, SimularEnvio } from "../src/tools/proveedor.js"

const raiz = fileURLToPath(new URL("../", import.meta.url))
const outRel = "out-test/historias"
const cfg = cargarConfigPortal({ PROVEEDOR_RUTA_OUT: outRel })
const ctx: ToolContext = { directory: raiz, fs: new FsNode(), clock: { hoy: () => "2026-09-03" } }
const casos = readdirSync(join(raiz, cfg.rutas.casos))

afterAll(() => rmSync(join(raiz, "out-test"), { recursive: true, force: true }))

// Sistema de archivos real con lecturas sobreescritas por ruta (para plantillas a medida).
function fsCon(sobre: Record<string, string>): IFileSystem {
  const real = new FsNode()
  return {
    leer: (r) => (r in sobre ? sobre[r] : real.leer(r)),
    existe: (r) => r in sobre || real.existe(r),
    escribir: (r, c) => real.escribir(r, c),
    escribirBinario: (r, d) => real.escribirBinario(r, d),
    copiar: (o, d) => real.copiar(o, d),
    listar: (r) => real.listar(r),
    borrar: (r) => real.borrar(r),
  }
}
const ctxCon = (sobre: Record<string, string>): ToolContext => ({ ...ctx, fs: fsCon(sobre) })
const dirCaso = (caso: string) => join(raiz, cfg.rutas.casos, caso)
const ruta = (caso: string, archivo: string) => join(dirCaso(caso), archivo)
const tienePlantillaCampos = (caso: string) => readdirSync(dirCaso(caso)).includes("plantilla-campos.json")

describe("HU-1 · Leer la solicitud", () => {
  it.each(casos)("criterio 1 (%s): devuelve campos, país, formato y soportes exigidos", async (caso) => {
    const r = JSON.parse(await new LeerSolicitud(cfg).execute({ caso }, ctx))
    expect(r.ok).toBe(true)
    expect(r.data.pais).toMatch(/^(CO|EC|PE|PA|HN)$/)
    expect(["xlsx", "pdf", "portal"]).toContain(r.data.formato)
    expect(r.data.campos.length).toBeGreaterThan(0)
    expect(Array.isArray(r.data.soportes)).toBe(true)
  })

  it.each([
    ["CO", "NIT"],
    ["EC", "RUC"],
    ["PE", "RUC"],
    ["PA", "RUC"],
    ["HN", "RTN"],
  ])("criterio 2 (país %s): una etiqueta ambigua se marca requiere_confirmacion y propone el equivalente %s", async (pais, equivalente) => {
    const solicitud = JSON.stringify({ id: "x", pais, cliente: "Cliente de prueba", formato: "portal" })
    const plantilla = JSON.stringify([{ etiqueta: "Identificación tributaria", obligatorio: true }])
    const sobre = { [ruta("pa-logistica-istmo", "solicitud.json")]: solicitud, [ruta("pa-logistica-istmo", "plantilla-campos.json")]: plantilla }
    const d = JSON.parse(await new MapearCampos(cfg).execute({ caso: "pa-logistica-istmo" }, ctxCon(sobre))).data
    expect(d.llenos).toEqual([])
    expect(d.requiere_confirmacion).toHaveLength(1)
    expect(d.requiere_confirmacion[0].nota).toContain(equivalente)
  })
})

describe("HU-2 · Mapear campos al maestro", () => {
  it.each(casos)("criterio 1 (%s): cada campo queda en lleno, faltante o requiere_confirmacion", async (caso) => {
    const plantilla = JSON.parse(readFileSync(ruta(caso, tienePlantillaCampos(caso) ? "plantilla-campos.json" : "plantilla-celdas.json"), "utf8"))
    const d = JSON.parse(await new MapearCampos(cfg).execute({ caso }, ctx)).data
    expect(d.llenos.length + d.faltantes.length + d.requiere_confirmacion.length).toBe(plantilla.length)
  })

  it("criterio 2: un campo sin fuente es faltante y nunca tiene valor", async () => {
    const sobre = { [ruta("pa-logistica-istmo", "plantilla-campos.json")]: JSON.stringify([{ etiqueta: "Campo inexistente XYZ", obligatorio: true }]) }
    const d = JSON.parse(await new MapearCampos(cfg).execute({ caso: "pa-logistica-istmo" }, ctxCon(sobre))).data
    expect(d.faltantes).toEqual([{ etiqueta: "Campo inexistente XYZ" }])
    expect(d.llenos).toEqual([])
  })

  it("criterio 3: los sinónimos del glosario se resuelven automáticamente", async () => {
    const sobre = { [ruta("pa-logistica-istmo", "plantilla-campos.json")]: JSON.stringify([{ etiqueta: "Nombre o razón social del proveedor", obligatorio: true }]) }
    const d = JSON.parse(await new MapearCampos(cfg).execute({ caso: "pa-logistica-istmo" }, ctxCon(sobre))).data
    expect(d.llenos).toEqual([expect.objectContaining({ fuente: "razon_social" })])
  })
})

describe("HU-3 · Generar el formulario en el formato pedido", () => {
  it("P0 Excel: se produce formulario.xlsx (el contenido celda por celda está en generar-xlsx.test.ts)", async () => {
    const r = JSON.parse(await new GenerarPortal(cfg).execute({ caso: "co-industrias-delta" }, ctx))
    expect(r.data.formato).toBe("xlsx")
    expect(r.data.ruta).toMatch(/formulario\.xlsx$/)
  })

  it("P1 PDF: se produce formulario.pdf a partir de plantilla-campos.json", async () => {
    const r = JSON.parse(await new GenerarPortal(cfg).execute({ caso: "ec-corp-andina" }, ctx))
    expect(r.data.formato).toBe("pdf")
    expect(r.data.ruta).toMatch(/formulario\.pdf$/)
  })

  it("P2 Portal: responde 'formato no soportado' y produce valores-portal.md", async () => {
    const r = JSON.parse(await new GenerarPortal(cfg).execute({ caso: "pa-logistica-istmo" }, ctx))
    expect(r.data.aviso).toMatch(/formato no soportado/i)
    expect(r.data.ruta).toMatch(/valores-portal\.md$/)
  })

  it("un formato que no existe responde 'formato no soportado' con mensaje claro", async () => {
    const sobre = { [ruta("pa-logistica-istmo", "solicitud.json")]: JSON.stringify({ id: "x", pais: "PA", cliente: "C", formato: "docx" }) }
    const r = JSON.parse(await new GenerarPortal(cfg).execute({ caso: "pa-logistica-istmo" }, ctxCon(sobre)))
    expect(r.data.formato_no_soporte).toBe(true)
    expect(r.data.aviso).toMatch(/formato no soportado/i)
  })
})

describe("HU-4 · Armar el paquete para firma", () => {
  it("criterio 1: paquete/ con formulario, soportes que existen, checklist.md y borrador-correo.md", async () => {
    await new GenerarPortal(cfg).execute({ caso: "co-industrias-delta" }, ctx)
    await new ArmarPaquete(cfg).execute({ caso: "co-industrias-delta" }, ctx)
    const archivos = readdirSync(join(raiz, outRel, "co-industrias-delta", "paquete"))
    expect(archivos).toContain("formulario.xlsx")
    expect(archivos).toContain("checklist.md")
    expect(archivos).toContain("borrador-correo.md")
    expect(archivos).toContain("rut-2026.txt")
  })

  it("criterio 2: un soporte vencido se marca vencido y bloquea listo_para_firma", async () => {
    const indice = JSON.stringify([
      { tipo: "camara_comercio", archivo: "camara-comercio-2026-08.txt", vigencia_hasta: "2026-08-01", pais_emisor: "CO" },
      { tipo: "rut", archivo: "rut-2026.txt", vigencia_hasta: null, pais_emisor: "CO" },
    ])
    const sobre = { [join(raiz, cfg.rutas.repositorio, "soportes", "index.json")]: indice }
    const r = JSON.parse(await new ArmarPaquete(cfg).execute({ caso: "pa-logistica-istmo" }, ctxCon(sobre))).data
    expect(r.checklist).toContainEqual({ tipo: "camara_comercio", estado: "vencido" })
    expect(r.listo_para_firma).toBe(false)
  })

  it("criterio 3: el envío solo escribe ENVIO-SIMULADO.md con confirmación explícita", async () => {
    const sin = JSON.parse(await new SimularEnvio(cfg).execute({ caso: "pa-logistica-istmo" }, ctx))
    expect(sin.ok).toBe(false)
    expect(sin.error).toMatch(/requiere confirmación explícita/)
    const con = JSON.parse(await new SimularEnvio(cfg).execute({ caso: "pa-logistica-istmo", confirmado: true }, ctx))
    expect(con.data.ruta).toMatch(/ENVIO-SIMULADO\.md$/)
  })
})

describe("HU-5 · Manejo de errores", () => {
  it("plantilla corrupta: mensaje claro que nombra el archivo, sin traza", async () => {
    const sobre = { [ruta("pa-logistica-istmo", "plantilla-campos.json")]: "[{ roto" }
    const r = JSON.parse(await new LeerSolicitud(cfg).execute({ caso: "pa-logistica-istmo" }, ctxCon(sobre)))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/plantilla-campos\.json/)
    expect(r.error).not.toMatch(/Expected|Unexpected|position/)
  })

  it("caso inexistente: mensaje claro, sin traza", async () => {
    const r = JSON.parse(await new LeerSolicitud(cfg).execute({ caso: "no-existe" }, ctx))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/caso no encontrado: no-existe/)
  })

  it("ninguna herramienta lanza excepciones hacia el agente: devuelve {ok,error}", async () => {
    const r = JSON.parse(await new MapearCampos(cfg).execute({ caso: "pa-logistica-istmo" }, ctxCon({ [join(raiz, cfg.rutas.glosario)]: "{" })))
    expect(r).toMatchObject({ ok: false })
    expect(typeof r.error).toBe("string")
  })
})
