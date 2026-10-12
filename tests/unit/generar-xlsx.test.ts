import ExcelJS from "exceljs"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import type { ToolContext } from "../../src/core/BaseTool.js"
import { cargarConfigPortal } from "../../src/config.js"
import { FsNode } from "../../src/core/FileSystem.js"
import { GenerarPortal, MapearCampos } from "../../src/tools/proveedor.js"

const raiz = fileURLToPath(new URL("../../", import.meta.url))
const outRel = "out-test/xlsx"
const cfg = cargarConfigPortal({ PROVEEDOR_RUTA_OUT: outRel })
const ctx: ToolContext = { directory: raiz, fs: new FsNode(), clock: { hoy: () => "2026-09-03" } }

interface Celda {
  hoja: string
  celda_etiqueta: string
  etiqueta: string
  celda_valor: string
}
const plantillaDe = (caso: string): Celda[] => JSON.parse(readFileSync(join(raiz, cfg.rutas.casos, caso, "plantilla-celdas.json"), "utf8"))

async function generar(caso: string) {
  const salida = JSON.parse(await new GenerarPortal(cfg).execute({ caso }, ctx))
  const mapeo = JSON.parse(await new MapearCampos(cfg).execute({ caso }, ctx)).data
  const wb = new ExcelJS.Workbook()
  const ruta = join(raiz, outRel, caso, "formulario.xlsx")
  expect(existsSync(ruta), "debe existir formulario.xlsx").toBe(true)
  await wb.xlsx.readFile(ruta)
  return { salida, mapeo, wb }
}

// Todo el texto de todas las celdas del libro, para buscar datos.
function textoDelLibro(wb: ExcelJS.Workbook): string {
  const partes: string[] = []
  wb.eachSheet((ws) => ws.eachRow((fila) => fila.eachCell((c) => partes.push(String(c.value)))))
  return partes.join("\n")
}

afterAll(() => rmSync(join(raiz, outRel), { recursive: true, force: true }))

describe("GenerarPortal rama xlsx (HU-3 P0)", () => {
  it("escribe cada etiqueta y su valor en la hoja y celda que indica la plantilla", async () => {
    const caso = "co-industrias-delta"
    const { salida, mapeo, wb } = await generar(caso)
    expect(salida.ok).toBe(true)
    expect(salida.data.formato).toBe("xlsx")
    expect(salida.data.ruta).toMatch(/formulario\.xlsx$/)
    const conValor = new Map<string, unknown>([...mapeo.llenos, ...mapeo.requiere_confirmacion].map((c: { etiqueta: string; valor: unknown }) => [c.etiqueta, c.valor]))
    for (const f of plantillaDe(caso)) {
      const ws = wb.getWorksheet(f.hoja)!
      expect(ws.getCell(f.celda_etiqueta).value).toBe(f.etiqueta)
      if (conValor.has(f.etiqueta)) expect(String(ws.getCell(f.celda_valor).value)).toBe(String(conValor.get(f.etiqueta)))
    }
  })

  it("un campo faltante deja su celda de valor vacía; nunca se inventa", async () => {
    const caso = "co-industrias-delta"
    const mapeo = { llenos: [], faltantes: [{ etiqueta: "Razón social" }], requiere_confirmacion: [] }
    const salida = JSON.parse(await new GenerarPortal(cfg).execute({ caso, mapeo }, ctx))
    expect(salida.ok).toBe(true)
    const libro = new ExcelJS.Workbook()
    await libro.xlsx.readFile(join(raiz, outRel, caso, "formulario.xlsx"))
    const f = plantillaDe(caso).find((x) => x.etiqueta === "Razón social")!
    const ws = libro.getWorksheet(f.hoja)!
    expect(ws.getCell(f.celda_etiqueta).value).toBe("Razón social")
    expect(ws.getCell(f.celda_valor).value).toBeNull()
  })

  it("sin campos bancarios en la plantilla (HN) el xlsx no contiene datos bancarios", async () => {
    const { wb } = await generar("hn-agroexport-sula")
    const texto = textoDelLibro(wb)
    expect(texto).not.toMatch(/03100012345/)
    expect(texto).not.toMatch(/COLOCOBM/)
  })

  it("con campos bancarios pedidos (CO) los incluye", async () => {
    const { mapeo, wb } = await generar("co-industrias-delta")
    const bancarios = mapeo.llenos.filter((c: { fuente: string }) => c.fuente.startsWith("banco."))
    expect(bancarios.length).toBeGreaterThan(0)
    expect(textoDelLibro(wb)).toContain(String(bancarios[0].valor))
  })

  it("el portal no cambia: genera valores-portal.md y no un xlsx", async () => {
    const salida = JSON.parse(await new GenerarPortal(cfg).execute({ caso: "pa-logistica-istmo" }, ctx))
    expect(salida.data.ruta).toMatch(/valores-portal\.md$/)
    expect(existsSync(join(raiz, outRel, "pa-logistica-istmo", "formulario.xlsx"))).toBe(false)
  })
})
