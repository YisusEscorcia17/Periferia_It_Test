import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { cargarConfigPortal } from "../../src/config.js"
import { correrCaso, type PasoDemo } from "../../demo.js"

const raiz = fileURLToPath(new URL("../../", import.meta.url))
const outRel = "out-test/demo-pdf"
const cfg = cargarConfigPortal({ PROVEEDOR_RUTA_OUT: outRel })
const caso = "ec-corp-andina"
const salida = join(raiz, outRel, caso)

describe("demo e2e caso pdf (HU-3 P1, HU-4)", () => {
  let pasos: PasoDemo[] = []
  beforeAll(async () => {
    pasos = await correrCaso(caso, cfg, raiz)
  })
  afterAll(() => rmSync(join(raiz, outRel), { recursive: true, force: true }))

  it("todas las herramientas terminan ok", () => {
    expect(pasos.every((p) => p.ok)).toBe(true)
  })

  it("crea formulario.pdf válido", () => {
    expect(readFileSync(join(salida, "formulario.pdf")).subarray(0, 4).toString()).toBe("%PDF")
  })

  it("el paquete incluye el formulario pdf", () => {
    expect(existsSync(join(salida, "paquete", "formulario.pdf"))).toBe(true)
  })

  it("log.jsonl registra la generación del formulario", () => {
    const lineas = readFileSync(join(salida, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(lineas).toContainEqual(expect.objectContaining({ herramienta: "proveedor_generar_formulario", ok: true }))
  })
})
