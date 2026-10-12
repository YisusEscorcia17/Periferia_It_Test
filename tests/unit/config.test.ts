import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CLAVES_PORTAL, MAPA_TRIBUTARIO, TEXTOS, cargarConfigPortal } from "../../src/config.js"

const envExample = readFileSync(new URL("../../.env.example", import.meta.url), "utf8")
const clavesDocumentadas = new Set(
  envExample
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("=")[0]),
)

describe("cargarConfigPortal", () => {
  it("falla si .env.example no documenta una clave que la config lee", () => {
    const faltantes = CLAVES_PORTAL.filter((k) => !clavesDocumentadas.has(k))
    expect(faltantes).toEqual([])
  })

  it("aplica valores por defecto con entorno vacío", () => {
    const cfg = cargarConfigPortal({})
    expect(cfg.rutas.casos).toBe("fixtures/reto-01/casos")
    expect(cfg.rutas.repositorio).toBe("fixtures/reto-01/repositorio")
    expect(cfg.rutas.out).toBe("out")
    expect(cfg.topes.tokensSesion).toBeGreaterThan(0)
    expect(cfg.fechaReferencia).toBe("2026-09-03")
  })

  it("lee topes y rutas del entorno", () => {
    const cfg = cargarConfigPortal({ TOKENS_SESION: "1234", PROVEEDOR_RUTA_OUT: "salida" })
    expect(cfg.topes.tokensSesion).toBe(1234)
    expect(cfg.rutas.out).toBe("salida")
  })

  it("ignora topes no numéricos o no positivos y usa el defecto", () => {
    const cfg = cargarConfigPortal({ TOKENS_SESION: "-5" })
    expect(cfg.topes.tokensSesion).toBe(50000)
  })

  it("mapa tributario resuelve RN1 para los 5 países", () => {
    expect(MAPA_TRIBUTARIO).toEqual({ CO: "NIT", EC: "RUC", PE: "RUC", PA: "RUC", HN: "RTN" })
  })

  it("expone textos de la UI del caso no vacíos", () => {
    for (const valor of Object.values(TEXTOS)) {
      expect(valor.length).toBeGreaterThan(0)
    }
  })
})

describe("presupuesto del enlace público (crédito de 5 USD)", () => {
  it("el tope global por defecto cuesta como máximo 4 USD (de 5 USD de crédito) a la tarifa de salida, 0.50 USD por millón", () => {
    const cfg = cargarConfigPortal({})
    const costoMaximoUsd = (cfg.topes.tokensGlobales * 0.5) / 1_000_000
    expect(costoMaximoUsd).toBeLessThanOrEqual(4)
  })
})
