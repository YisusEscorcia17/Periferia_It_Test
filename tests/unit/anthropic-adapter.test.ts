import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { crearAnthropic } from "../../src/llm/anthropic.js"
import type { Mensaje } from "../../src/llm/adapter.js"

// Servidor local que imita POST /v1/messages y guarda cada petición recibida.
type Recibida = { headers: Record<string, unknown>; body: Record<string, unknown> }
let servidor: Server | undefined
afterEach(() => new Promise<void>((r) => (servidor ? servidor.close(() => r()) : r())))

async function mock(respuesta: unknown, status = 200) {
  const recibidas: Recibida[] = []
  servidor = createServer((req, res) => {
    let cuerpo = ""
    req.on("data", (c) => (cuerpo += c))
    req.on("end", () => {
      recibidas.push({ headers: req.headers, body: JSON.parse(cuerpo) })
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(respuesta))
    })
  })
  await new Promise<void>((r) => servidor!.listen(0, "127.0.0.1", () => r()))
  const base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`
  return { recibidas, base }
}

const tools = [{ name: "proveedor_leer_solicitud", description: "lee", parameters: { type: "object", properties: { caso: { type: "string" } } } }]

describe("adaptador Anthropic", () => {
  it("envía x-api-key, anthropic-version, system de nivel superior y max_tokens", async () => {
    const { recibidas, base } = await mock({ content: [{ type: "text", text: "ok" }] })
    const a = crearAnthropic({ apiKey: "sk-ant-test", model: "claude-haiku-5-5", timeoutMs: 5000, baseUrl: base })
    await a.enviar([{ role: "user", content: "hola" }], tools, "sé breve")
    const r = recibidas[0]
    expect(r.headers["x-api-key"]).toBe("sk-ant-test")
    expect(r.headers["anthropic-version"]).toBe("2023-06-01")
    expect(r.body.model).toBe("claude-haiku-5-5")
    expect(r.body.system).toBe("sé breve")
    expect(r.body.max_tokens).toBeGreaterThan(0)
    expect(r.body.messages).toEqual([{ role: "user", content: "hola" }])
  })

  it("traduce las herramientas a {name, description, input_schema}", async () => {
    const { recibidas, base } = await mock({ content: [{ type: "text", text: "ok" }] })
    const a = crearAnthropic({ apiKey: "k", model: "m", timeoutMs: 5000, baseUrl: base })
    await a.enviar([{ role: "user", content: "x" }], tools)
    expect(recibidas[0].body.tools).toEqual([
      { name: "proveedor_leer_solicitud", description: "lee", input_schema: tools[0].parameters },
    ])
  })

  it("convierte toolCalls del asistente en bloques tool_use y agrupa los resultados en un solo mensaje user", async () => {
    const { recibidas, base } = await mock({ content: [{ type: "text", text: "listo" }] })
    const a = crearAnthropic({ apiKey: "k", model: "m", timeoutMs: 5000, baseUrl: base })
    const historial: Mensaje[] = [
      { role: "user", content: "procesa" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "proveedor_leer_solicitud", args: { caso: "pa" } }, { id: "t2", name: "proveedor_mapear_campos", args: { caso: "pa" } }] },
      { role: "tool", toolCallId: "t1", name: "proveedor_leer_solicitud", content: "{\"ok\":true}" },
      { role: "tool", toolCallId: "t2", name: "proveedor_mapear_campos", content: "{\"ok\":false}" },
    ]
    await a.enviar(historial, tools)
    const msgs = recibidas[0].body.messages as unknown[]
    expect(msgs[1]).toEqual({
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "proveedor_leer_solicitud", input: { caso: "pa" } },
        { type: "tool_use", id: "t2", name: "proveedor_mapear_campos", input: { caso: "pa" } },
      ],
    })
    expect(msgs[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "{\"ok\":true}" },
        { type: "tool_result", tool_use_id: "t2", content: "{\"ok\":false}" },
      ],
    })
    expect(msgs).toHaveLength(3)
  })

  it("respuesta con texto y tool_use se devuelve como RespuestaLLM", async () => {
    const { base } = await mock({
      content: [
        { type: "text", text: "Voy a leerla." },
        { type: "tool_use", id: "tu_1", name: "proveedor_leer_solicitud", input: { caso: "pa-logistica-istmo" } },
      ],
    })
    const a = crearAnthropic({ apiKey: "k", model: "m", timeoutMs: 5000, baseUrl: base })
    const r = await a.enviar([{ role: "user", content: "x" }], tools)
    expect(r.text).toBe("Voy a leerla.")
    expect(r.toolCalls).toEqual([{ id: "tu_1", name: "proveedor_leer_solicitud", args: { caso: "pa-logistica-istmo" } }])
  })

  it("respuesta sin herramientas no trae toolCalls", async () => {
    const { base } = await mock({ content: [{ type: "text", text: "Hecho." }] })
    const a = crearAnthropic({ apiKey: "k", model: "m", timeoutMs: 5000, baseUrl: base })
    const r = await a.enviar([{ role: "user", content: "x" }], [])
    expect(r.text).toBe("Hecho.")
    expect(r.toolCalls).toBeUndefined()
  })

  it("error HTTP lanza excepción con el código (el ciclo la captura)", async () => {
    const { base } = await mock({ error: { type: "rate_limit_error" } }, 429)
    const a = crearAnthropic({ apiKey: "k", model: "m", timeoutMs: 5000, baseUrl: base })
    await expect(a.enviar([{ role: "user", content: "x" }], [])).rejects.toThrow(/429/)
  })
})
