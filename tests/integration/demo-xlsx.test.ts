import ExcelJS from "exceljs"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { cargarConfigPortal } from "../../src/config.js"
import { correrCaso, type PasoDemo } from "../../demo.js"

const raiz = fileURLToPath(new URL("../../", import.meta.url))
const outRel = "out-test/demo-xlsx"
const cfg = cargarConfigPortal({ PROVEEDOR_RUTA_OUT: outRel })
const caso = "co-industrias-delta"
const salida = join(raiz, outRel, caso)

describe("demo e2e caso xlsx (HU-3 P0, HU-4)", () => {
  let pasos: PasoDemo[] = []
  beforeAll(async () => {
    pasos = await correrCaso(caso, cfg, raiz)
  })
  afterAll(() => rmSync(join(raiz, outRel), { recursive: true, force: true }))

  it("todas las herramientas terminan ok", () => {
    expect(pasos.every((p) => p.ok)).toBe(true)
  })

  it("crea formulario.xlsx y al releerlo el NIT está en la celda de la plantilla", async () => {
    const ruta = join(salida, "formulario.xlsx")
    expect(existsSync(ruta)).toBe(true)
    const libro = new ExcelJS.Workbook()
    await libro.xlsx.readFile(ruta)
    const plantilla: Array<{ hoja: string; celda_etiqueta: string; etiqueta: string; celda_valor: string }> = JSON.parse(
      readFileSync(join(raiz, cfg.rutas.casos, caso, "plantilla-celdas.json"), "utf8"),
    )
    const nit = plantilla.find((f) => f.etiqueta === "NIT")!
    expect(libro.getWorksheet(nit.hoja)!.getCell(nit.celda_valor).value).toBe("900123456")
  })

  it("el paquete incluye el formulario", () => {
    expect(existsSync(join(salida, "paquete", "formulario.xlsx"))).toBe(true)
  })

  it("log.jsonl registra la generación del formulario", () => {
    const lineas = readFileSync(join(salida, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(lineas).toContainEqual(expect.objectContaining({ herramienta: "proveedor_generar_formulario", ok: true }))
  })
})
