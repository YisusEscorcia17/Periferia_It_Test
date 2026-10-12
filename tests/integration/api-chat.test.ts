import { mkdtemp } from "node:fs/promises"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import request from "supertest"
import { describe, expect, it } from "vitest"
import { crearApp } from "../../src/server.js"
import type { Mensaje } from "../../src/llm/adapter.js"
import { guionAdaptador, herramientasFalsas } from "../helpers.js"

const casosDir = join(__dirname, "../../fixtures/reto-01/casos")
const llamar = (name: string, caso: string) => ({ toolCalls: [{ id: "c1", name, args: { caso } }] })

async function nueva(pasos: Parameters<typeof guionAdaptador>[0], opciones: { tokensSesion?: number; tokensGlobales?: number } = {}) {
  const outDir = await mkdtemp(join(tmpdir(), "reto01-"))
  return { outDir, app: crearApp({ adapter: guionAdaptador(pasos), tools: herramientasFalsas(), outDir, casosDir, ...opciones }) }
}

describe("API", () => {
  it("GET /health y /api/health sin clave", async () => {
    const { app } = await nueva([{ text: "x" }])
    for (const p of ["/health", "/api/health"]) {
      const r = await request(app).get(p)
      expect(r.body).toEqual({ ok: true, provider: "mock", model: "mock-1" })
    }
  })

  it("POST /api/chat responde reply, toolCalls y needsConfirmation", async () => {
    const { app } = await nueva([llamar("proveedor_leer_solicitud", "pa-logistica-istmo"), { text: "Listo" }])
    const r = await request(app).post("/api/chat").send({ sessionId: "s1", message: "hola" })
    expect(r.status).toBe(200)
    expect(r.body.reply).toBe("Listo")
    expect(r.body.toolCalls).toHaveLength(1)
    expect(r.body.needsConfirmation).toBe(false)
  })

  it("caso inexistente no mata la sesión", async () => {
    const { app } = await nueva([llamar("proveedor_simular_envio", "../../etc"), { text: "No existe" }, { text: "sigo aquí" }])
    const r1 = await request(app).post("/api/chat").send({ sessionId: "s1", message: "envía" })
    expect(r1.body.needsConfirmation).toBe(false)
    expect(r1.body.toolCalls[0].ok).toBe(false)
    const r2 = await request(app).post("/api/chat").send({ sessionId: "s1", message: "hola" })
    expect(r2.body.reply).toBe("sigo aquí")
  })

  it("el modelo no puede confirmar por sí mismo: confirmado:true del modelo sigue pendiente", async () => {
    const { app, outDir } = await nueva([
      { toolCalls: [{ id: "c1", name: "proveedor_simular_envio", args: { caso: "pa-logistica-istmo", confirmado: true } }] },
      { text: "Preparado" },
    ])
    const r = await request(app).post("/api/chat").send({ sessionId: "s1", message: "envía" })
    expect(r.body.needsConfirmation).toBe(true)
    const { existsSync } = await import("node:fs")
    expect(existsSync(join(outDir, "pa-logistica-istmo", "ENVIO-SIMULADO.md"))).toBe(false)
  })

  it("envío exige actionId vigente: aceptar crea, reusar no", async () => {
    const { app, outDir } = await nueva([llamar("proveedor_simular_envio", "pa-logistica-istmo"), { text: "Preparado" }])
    const r1 = await request(app).post("/api/chat").send({ sessionId: "s1", message: "envía" })
    expect(r1.body.needsConfirmation).toBe(true)
    const ok = await request(app).post("/api/chat").send({ sessionId: "s1", confirmed: true, actionId: r1.body.actionId })
    expect(ok.body.reply).toMatch(/creado/)
    const { existsSync } = await import("node:fs")
    expect(existsSync(join(outDir, "pa-logistica-istmo", "ENVIO-SIMULADO.md"))).toBe(true)
    const otra = await request(app).post("/api/chat").send({ sessionId: "s1", confirmed: true, actionId: r1.body.actionId })
    expect(otra.body.reply).toMatch(/confirmación explícita/)
  })

  it("tope de tokens por sesión: al superarlo no llama al modelo y lo explica", async () => {
    const { app } = await nueva([{ text: "uno", usage: { entrada: 80, salida: 40 } }, { text: "dos" }], { tokensSesion: 100 })
    const r1 = await request(app).post("/api/chat").send({ sessionId: "tk", message: "hola" })
    expect(r1.body.reply).toBe("uno")
    const r2 = await request(app).post("/api/chat").send({ sessionId: "tk", message: "otra" })
    expect(r2.body.reply).toMatch(/límite de tokens/i)
    expect(r2.body.reply).not.toBe("dos")
  })

  it("un error del proveedor queda en log.jsonl con su causa, sin clave", async () => {
    const { app, outDir } = await nueva([new Error("LLM HTTP 429")])
    const r = await request(app).post("/api/chat").send({ sessionId: "e1", message: "hola" })
    expect(r.body.reply).toMatch(/429/)
    const { readFileSync } = await import("node:fs")
    const log = readFileSync(join(outDir, "log.jsonl"), "utf8")
    expect(log).toMatch(/"evento":"error_llm"/)
    expect(log).toMatch(/"status":429/)
  })

  it("la respuesta informa los tokens acumulados de la sesión (para medir costo)", async () => {
    const { app } = await nueva([{ text: "uno", usage: { entrada: 80, salida: 40 } }, { text: "dos", usage: { entrada: 10, salida: 5 } }])
    await request(app).post("/api/chat").send({ sessionId: "tc", message: "a" })
    const r = await request(app).post("/api/chat").send({ sessionId: "tc", message: "b" })
    expect(r.body.tokensSesion).toBe(135)
  })
})

describe("memoria de sesión", () => {
  it("el siguiente turno recibe las llamadas y resultados de herramientas del turno anterior", async () => {
    const capturas: Mensaje[][] = []
    let llamadas = 0
    const adapter = {
      nombre: "mock",
      modelo: "mock-1",
      async enviar(mensajes: Mensaje[]) {
        capturas.push([...mensajes])
        llamadas++
        return llamadas === 1
          ? { toolCalls: [{ id: "c1", name: "proveedor_leer_solicitud", args: { caso: "pa-logistica-istmo" } }] }
          : { text: "ok" }
      },
    }
    const outDir = await mkdtemp(join(tmpdir(), "reto01-mem-"))
    const app = crearApp({ adapter, tools: herramientasFalsas(), outDir, casosDir })
    await request(app).post("/api/chat").send({ sessionId: "mem", message: "procesa" })
    await request(app).post("/api/chat").send({ sessionId: "mem", message: "¿qué leíste?" })
    expect(capturas[2].some((m) => m.role === "tool" && m.name === "proveedor_leer_solicitud")).toBe(true)
  })
})

describe("tope global de tokens (enlace público)", () => {
  it("el consumo de todas las sesiones suma: una sesión nueva tampoco puede gastar más allá del tope", async () => {
    const { app } = await nueva([{ text: "uno", usage: { entrada: 80, salida: 40 } }, { text: "dos" }], { tokensGlobales: 100 })
    const r1 = await request(app).post("/api/chat").send({ sessionId: "g1", message: "hola" })
    expect(r1.body.reply).toBe("uno")
    const r2 = await request(app).post("/api/chat").send({ sessionId: "nueva-sesion", message: "otra" })
    expect(r2.body.reply).toMatch(/límite global de tokens/i)
  })
})

describe("descarga de archivos generados (PRD 9.3: probar desde un link)", () => {
  it("descarga formulario.xlsx del caso cuando existe", async () => {
    const { app, outDir } = await nueva([{ text: "x" }])
    mkdirSync(join(outDir, "pa-logistica-istmo"), { recursive: true })
    writeFileSync(join(outDir, "pa-logistica-istmo", "formulario.xlsx"), "contenido")
    const r = await request(app).get("/api/archivos/pa-logistica-istmo/formulario.xlsx")
    expect(r.status).toBe(200)
    expect(r.headers["content-disposition"]).toMatch(/attachment.*formulario\.xlsx/)
  })

  it("descarga los archivos del paquete con la ruta paquete/<archivo>", async () => {
    const { app, outDir } = await nueva([{ text: "x" }])
    mkdirSync(join(outDir, "pa-logistica-istmo", "paquete"), { recursive: true })
    writeFileSync(join(outDir, "pa-logistica-istmo", "paquete", "checklist.md"), "# c")
    const r = await request(app).get("/api/archivos/pa-logistica-istmo/paquete/checklist.md")
    expect(r.status).toBe(200)
  })

  it("rechaza archivos fuera de la lista blanca y rutas con traversal", async () => {
    const { app, outDir } = await nueva([{ text: "x" }])
    mkdirSync(join(outDir, "pa-logistica-istmo"), { recursive: true })
    writeFileSync(join(outDir, "pa-logistica-istmo", "config.json"), "{}")
    expect((await request(app).get("/api/archivos/pa-logistica-istmo/config.json")).status).toBe(404)
    expect((await request(app).get("/api/archivos/..%2F..%2Fetc/formulario.xlsx")).status).toBe(404)
    expect((await request(app).get("/api/archivos/pa-logistica-istmo/formulario.pdf")).status).toBe(404)
  })

  it("el chat devuelve descargas cuando el turno generó un formulario", async () => {
    const { app } = await nueva([
      { toolCalls: [{ id: "g1", name: "proveedor_generar_formulario", args: { caso: "co-industrias-delta" } }] },
      { text: "Listo" },
    ])
    const r = await request(app).post("/api/chat").send({ sessionId: "dl", message: "genera" })
    expect(r.body.descargas).toEqual([{ nombre: "formulario.xlsx", url: "/api/archivos/co-industrias-delta/formulario.xlsx" }])
  })
})
