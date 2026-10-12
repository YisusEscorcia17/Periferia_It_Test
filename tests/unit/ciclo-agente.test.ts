import { describe, expect, it } from "vitest"
import type { Mensaje } from "../../src/llm/adapter.js"
import { ejecutarTurno } from "../../src/ciclo.js"
import { guionAdaptador, herramientasFalsas } from "../helpers.js"

const ctx = { directory: ".", sessionId: "s1" }
const llamar = { toolCalls: [{ id: "c1", name: "proveedor_leer_solicitud", args: { caso: "pa-logistica-istmo" } }] }

describe("ciclo del agente", () => {
  it("corta en el tope con resultados parciales y no lanza", async () => {
    const adapter = guionAdaptador([llamar])
    const r = await ejecutarTurno({ adapter, tools: herramientasFalsas(), maxIter: 25, ctx }, [{ role: "user", content: "procesa" }])
    expect(adapter.llamadas).toBe(25)
    expect(r.toolCalls).toHaveLength(25)
    expect(r.reply).toMatch(/tope/i)
    expect(r.reply).toMatch(/Panamá/)
  })

  it("CA2: ignora valores sin fuente en herramientas y los marca faltantes", async () => {
    const adapter = guionAdaptador([
      llamar,
      { text: "Listo", valores: [{ campo: "nit", valor: "999-INVENTADO" }, { campo: "pais", valor: "Panamá" }] },
    ])
    const r = await ejecutarTurno({ adapter, tools: herramientasFalsas(), maxIter: 25, ctx }, [{ role: "user", content: "x" }])
    expect(r.faltantes).toEqual(["nit"])
    expect(r.reply).toMatch(/nit/)
    expect(r.reply).not.toMatch(/999-INVENTADO/)
  })

  it("un error del LLM no mata la sesión", async () => {
    const mensajes = [{ role: "user" as const, content: "hola" }]
    const roto = guionAdaptador([new Error("boom sk-secreto")])
    const r1 = await ejecutarTurno({ adapter: roto, tools: herramientasFalsas(), maxIter: 25, ctx }, mensajes)
    expect(r1.reply).toMatch(/no pude/i)
    expect(r1.reply).not.toMatch(/sk-secreto/)
    const ok = guionAdaptador([{ text: "ya estoy" }])
    const r2 = await ejecutarTurno({ adapter: ok, tools: herramientasFalsas(), maxIter: 25, ctx }, mensajes)
    expect(r2.reply).toBe("ya estoy")
  })

  it("herramienta desconocida o args inválidos se devuelven al modelo como error", async () => {
    const adapter = guionAdaptador([
      { toolCalls: [{ id: "c1", name: "proveedor_leer_solicitud", args: {} }] },
      { text: "fin" },
    ])
    const r = await ejecutarTurno({ adapter, tools: herramientasFalsas(), maxIter: 25, ctx }, [{ role: "user", content: "x" }])
    expect(r.toolCalls[0].ok).toBe(false)
    expect(r.reply).toBe("fin")
  })
})

describe("errores del proveedor, tokens y verificación de valores (PRD HU-5, RNF costo, CA2)", () => {
  const herramientaConValor = {
    proveedor_mapear_campos: {
      description: "mapea",
      args: {},
      async execute() {
        return JSON.stringify({ ok: true, data: { llenos: [{ etiqueta: "NIT", valor: "900123456" }] } })
      },
    },
  }
  const pedirMapeo = { toolCalls: [{ id: "c1", name: "proveedor_mapear_campos", args: {} }] }

  it("un 429 del proveedor se explica con su causa, sin traza ni clave", async () => {
    const adapter = guionAdaptador([new Error("LLM HTTP 429")])
    const r = await ejecutarTurno({ adapter, tools: {}, maxIter: 5, ctx }, [{ role: "user", content: "hola" }])
    expect(r.reply).toMatch(/429/)
    expect(r.reply).toMatch(/cuota|créditos|cuenta/i)
    expect(r.errorLlm).toEqual({ tipo: "http", status: 429 })
  })

  it("un timeout del proveedor se informa como timeout", async () => {
    const timeout = new Error("The operation was aborted due to timeout")
    timeout.name = "TimeoutError"
    const adapter = guionAdaptador([timeout])
    const r = await ejecutarTurno({ adapter, tools: {}, maxIter: 5, ctx }, [{ role: "user", content: "hola" }])
    expect(r.reply).toMatch(/tardó|tiempo/i)
    expect(r.errorLlm).toEqual({ tipo: "timeout" })
  })

  it("acumula los tokens reportados por el adaptador en el turno", async () => {
    const adapter = guionAdaptador([
      { ...pedirMapeo, usage: { entrada: 100, salida: 20 } },
      { text: "Listo", usage: { entrada: 150, salida: 30 } },
    ])
    const r = await ejecutarTurno({ adapter, tools: herramientaConValor, maxIter: 5, ctx }, [{ role: "user", content: "x" }])
    expect(r.tokens).toEqual({ entrada: 250, salida: 50 })
  })

  it("CA2: un número de identificación que no salió de ninguna herramienta se marca como no verificado", async () => {
    const adapter = guionAdaptador([pedirMapeo, { text: "El NIT es 999888777." }])
    const r = await ejecutarTurno({ adapter, tools: herramientaConValor, maxIter: 5, ctx }, [{ role: "user", content: "x" }])
    expect(r.reply).toMatch(/no verificados.*999888777/)
  })

  it("CA2: un número que sí salió de una herramienta no se marca", async () => {
    const adapter = guionAdaptador([pedirMapeo, { text: "El NIT es 900123456." }])
    const r = await ejecutarTurno({ adapter, tools: herramientaConValor, maxIter: 5, ctx }, [{ role: "user", content: "x" }])
    expect(r.reply).not.toMatch(/no verificados/)
  })
})

describe("memoria del turno: fuentes de turnos anteriores (CA2 a nivel sesión)", () => {
  it("un valor que salió de una herramienta en un turno anterior no se marca como no verificado", async () => {
    const historial: Mensaje[] = [
      { role: "user", content: "procesa" },
      { role: "assistant", content: "", toolCalls: [{ id: "h1", name: "proveedor_mapear_campos", args: {} }] },
      { role: "tool", toolCallId: "h1", name: "proveedor_mapear_campos", content: JSON.stringify({ ok: true, data: { llenos: [{ valor: "900123456" }] } }) },
      { role: "assistant", content: "Listo" },
      { role: "user", content: "¿cuál es el NIT?" },
    ]
    const adapter = guionAdaptador([{ text: "El NIT es 900123456." }])
    const r = await ejecutarTurno({ adapter, tools: {}, maxIter: 5, ctx }, historial)
    expect(r.reply).not.toMatch(/no verificados/)
  })

  it("el resultado devuelve el historial completo con las llamadas y resultados del turno", async () => {
    const adapter = guionAdaptador([llamar, { text: "Hecho" }])
    const r = await ejecutarTurno({ adapter, tools: herramientasFalsas(), maxIter: 5, ctx }, [{ role: "user", content: "x" }])
    expect(r.mensajes.map((m) => m.role)).toEqual(["user", "assistant", "tool"])
  })
})

describe("CA2 reforzado: correos y URLs también deben salir de herramientas", () => {
  const conCorreo = { proveedor_mapear_campos: { description: "mapea", args: {}, async execute() { return JSON.stringify({ ok: true, data: { llenos: [{ valor: "lgomez@periferia-ficticia.com" }, { valor: "https://www.periferia-ficticia.com" }] } }) } } }
  const pedir = { toolCalls: [{ id: "c1", name: "proveedor_mapear_campos", args: {} }] }

  it("un correo inventado se marca como no verificado", async () => {
    const adapter = guionAdaptador([pedir, { text: "Escribe a otro@ejemplo.com." }])
    const r = await ejecutarTurno({ adapter, tools: conCorreo, maxIter: 5, ctx }, [{ role: "user", content: "x" }])
    expect(r.reply).toMatch(/no verificados.*otro@ejemplo\.com/)
  })

  it("un correo y una URL que sí salieron de herramientas no se marcan", async () => {
    const adapter = guionAdaptador([pedir, { text: "Correo lgomez@periferia-ficticia.com y web https://www.periferia-ficticia.com." }])
    const r = await ejecutarTurno({ adapter, tools: conCorreo, maxIter: 5, ctx }, [{ role: "user", content: "x" }])
    expect(r.reply).not.toMatch(/no verificados/)
  })
})
