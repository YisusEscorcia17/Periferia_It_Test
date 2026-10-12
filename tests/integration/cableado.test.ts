import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { cargarConfigPortal } from "../../src/config.js"
import { crearHerramientas } from "../../src/tools/index.js"

const raiz = fileURLToPath(new URL("../../", import.meta.url))
const outRel = "out-test/cableado"
const cfg = cargarConfigPortal({ PROVEEDOR_RUTA_OUT: outRel })
const ctx = { directory: raiz, sessionId: "s1" }

describe("cableado de herramientas reales en el chat", () => {
  afterAll(() => rmSync(join(raiz, outRel), { recursive: true, force: true }))

  it("expone las 5 herramientas proveedor_* con su nombre del PRD", () => {
    const nombres = Object.keys(crearHerramientas(raiz, cfg)).sort()
    expect(nombres).toEqual([
      "proveedor_armar_paquete",
      "proveedor_generar_formulario",
      "proveedor_leer_solicitud",
      "proveedor_mapear_campos",
      "proveedor_simular_envio",
    ])
  })

  it("proveedor_simular_envio sin confirmado devuelve error y no crea archivo", async () => {
    const h = crearHerramientas(raiz, cfg)
    const salida = JSON.parse(await h.proveedor_simular_envio.execute({ caso: "pa-logistica-istmo" }, ctx))
    expect(salida.ok).toBe(false)
    expect(existsSync(join(raiz, outRel, "pa-logistica-istmo", "ENVIO-SIMULADO.md"))).toBe(false)
  })

  it("con confirmado=true crea ENVIO-SIMULADO.md en la salida configurada", async () => {
    const h = crearHerramientas(raiz, cfg)
    const salida = JSON.parse(await h.proveedor_simular_envio.execute({ caso: "pa-logistica-istmo", confirmado: true }, ctx))
    expect(salida.ok).toBe(true)
    expect(readFileSync(join(raiz, outRel, "pa-logistica-istmo", "ENVIO-SIMULADO.md"), "utf8")).toMatch(/Envío simulado/)
  })
})
