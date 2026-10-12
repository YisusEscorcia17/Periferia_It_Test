import { readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { cargarConfigPortal } from "../../src/config.js"
import { correrTodosLosCasos } from "../../demo.js"

const raiz = fileURLToPath(new URL("../../", import.meta.url))
const outRel = "out-test/demo-todos"
const cfg = cargarConfigPortal({ PROVEEDOR_RUTA_OUT: outRel })

describe("demo sobre todos los casos (PRD 6.6)", () => {
  let resumen: Awaited<ReturnType<typeof correrTodosLosCasos>> = {}
  beforeAll(async () => {
    resumen = await correrTodosLosCasos(cfg, raiz)
  })
  const casosEnFixtures = readdirSync(join(raiz, cfg.rutas.casos))

  afterAll(() => rmSync(join(raiz, outRel), { recursive: true, force: true }))

  it("ejecuta cada caso de fixtures y devuelve un resumen por caso", () => {
    expect(Object.keys(resumen).sort()).toEqual(casosEnFixtures.sort())
  })

  it("xlsx y pdf generan su formulario; la demo sigue con todos los casos", () => {
    const xlsx = resumen["co-industrias-delta"].find((p) => p.herramienta === "proveedor_generar_formulario")!
    expect(xlsx.ok).toBe(true)
    expect((xlsx.data as { formato: string }).formato).toBe("xlsx")
    const pdf = resumen["ec-corp-andina"].find((p) => p.herramienta === "proveedor_generar_formulario")!
    expect(pdf.ok).toBe(true)
    expect((pdf.data as { formato: string }).formato).toBe("pdf")
    expect(resumen["ec-corp-andina"].find((p) => p.herramienta === "proveedor_leer_solicitud")!.ok).toBe(true)
  })

  it("el caso de portal genera el formulario y el paquete", () => {
    const pa = resumen["pa-logistica-istmo"]
    expect(pa.every((p) => p.ok)).toBe(true)
  })
})
