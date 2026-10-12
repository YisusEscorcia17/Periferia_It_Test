import type { Adaptador, DefinicionTool, LlamadaTool, Mensaje, RespuestaLLM } from "./adapter.js"

// Bloque de contenido que devuelve la API (texto o llamada a herramienta).
interface BloqueRespuesta {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

// Mensajes de la API de Anthropic: los resultados de herramientas van agrupados en un único turno `user`.
type MensajeApi = { role: "user" | "assistant"; content: string | Array<Record<string, unknown>> }

function aMensajesApi(mensajes: Mensaje[]): MensajeApi[] {
  const salida: MensajeApi[] = []
  for (const m of mensajes) {
    if (m.role === "tool") {
      const bloque = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content }
      const ultimo = salida.at(-1)
      if (ultimo && ultimo.role === "user" && Array.isArray(ultimo.content)) ultimo.content.push(bloque)
      else salida.push({ role: "user", content: [bloque] })
    } else if ("toolCalls" in m) {
      const bloques: Array<Record<string, unknown>> = []
      if (m.content) bloques.push({ type: "text", text: m.content })
      for (const c of m.toolCalls) bloques.push({ type: "tool_use", id: c.id, name: c.name, input: c.args })
      salida.push({ role: "assistant", content: bloques })
    } else if (m.content) {
      salida.push({ role: m.role, content: m.content })
    }
  }
  return salida
}

export function crearAnthropic(opts: { apiKey: string; model: string; timeoutMs: number; baseUrl?: string }): Adaptador {
  return {
    nombre: "anthropic",
    modelo: opts.model,
    async enviar(mensajes: Mensaje[], tools: DefinicionTool[], sistema?: string): Promise<RespuestaLLM> {
      const res = await fetch(`${opts.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: 2048,
          ...(sistema ? { system: sistema } : {}),
          messages: aMensajesApi(mensajes),
          ...(tools.length
            ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) }
            : {}),
        }),
        signal: AbortSignal.timeout(opts.timeoutMs),
      })
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}`)
      const body = (await res.json()) as { content?: BloqueRespuesta[]; usage?: { input_tokens?: number; output_tokens?: number } }
      const bloques = body.content ?? []
      const text = bloques
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")
      const toolCalls: LlamadaTool[] = bloques
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id ?? "", name: b.name ?? "", args: b.input ?? {} }))
      const usage = { entrada: body.usage?.input_tokens ?? 0, salida: body.usage?.output_tokens ?? 0 }
      return { text: text || undefined, toolCalls: toolCalls.length ? toolCalls : undefined, usage }
    },
  }
}
