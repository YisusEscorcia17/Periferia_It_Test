import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { cargarConfigPortal } from "../../src/config.js"
import { correrCaso, type PasoDemo } from "../../demo.js"

const raiz = fileURLToPath(new URL("../../", import.meta.url))
// Carpeta de salida aislada (no toca out/ de la demo).
const outRel = "out-test/demo-pa"
const cfg = cargarConfigPortal({ PROVEEDOR_RUTA_OUT: outRel })
const salida = join(raiz, outRel, "pa-logistica-istmo")

describe("demo e2e caso pa-logistica-istmo", () => {
  let pasos: PasoDemo[] = []
  beforeAll(async () => {
    pasos = await correrCaso("pa-logistica-istmo", cfg, raiz)
  })

  afterAll(() => {
    rmSync(join(raiz, outRel), { recursive: true, force: true })
  })

  it("todas las herramientas terminan ok", () => {
    expect(pasos.map((p) => [p.herramienta, p.ok])).toEqual([
      ["proveedor_leer_solicitud", true],
      ["proveedor_mapear_campos", true],
      ["proveedor_generar_formulario", true],
      ["proveedor_armar_paquete", true],
    ])
  })

  it("crea valores-portal.md, paquete/ y log.jsonl", () => {
    expect(existsSync(join(salida, "valores-portal.md"))).toBe(true)
    expect(existsSync(join(salida, "paquete"))).toBe(true)
    expect(existsSync(join(salida, "log.jsonl"))).toBe(true)
  })

  it("el RUC aparece en confirmación", () => {
    const valores = readFileSync(join(salida, "valores-portal.md"), "utf8")
    const filaRuc = valores.split("\n").find((l) => l.startsWith("| RUC |"))!
    expect(filaRuc).toMatch(/requiere confirmación/)
  })

  it("checklist de 2/2 soportes presentes y listo para firma", () => {
    const checklist = readFileSync(join(salida, "paquete", "checklist.md"), "utf8")
    expect(checklist.match(/\[x\]/g)).toHaveLength(2)
    expect(checklist).toMatch(/Listo para firma: sí/)
  })

  it("el borrador no contiene datos de cuenta", () => {
    const borrador = readFileSync(join(salida, "paquete", "borrador-correo.md"), "utf8")
    expect(borrador).not.toMatch(/03100012345/)
    expect(borrador).not.toMatch(/COLOCOBM/)
  })

  it("no se crea ENVIO-SIMULADO.md sin confirmación", () => {
    expect(existsSync(join(salida, "ENVIO-SIMULADO.md"))).toBe(false)
  })
})
