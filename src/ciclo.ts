import { z } from "zod"
import type { Adaptador, DefinicionTool, LlamadaTool, Mensaje } from "./llm/adapter.js"
import type { ContextoHerramienta, Herramientas } from "./tools/registry.js"

export interface RegistroToolCall {
  name: string
  args: Record<string, unknown>
  ok: boolean
  resumen: string
}

// Causa de un fallo del proveedor LLM, sin datos sensibles.
export type ErrorLlm = { tipo: "timeout" } | { tipo: "http"; status: number } | { tipo: "desconocido" }

export interface ResultadoTurno {
  reply: string
  toolCalls: RegistroToolCall[]
  faltantes: string[]
  tokens: { entrada: number; salida: number }
  errorLlm?: ErrorLlm
  // Historial completo con las llamadas y resultados de herramientas del turno (sin la respuesta final).
  mensajes: Mensaje[]
}

export interface OpcionesCiclo {
  adapter: Adaptador
  tools: Herramientas
  maxIter: number
  ctx: ContextoHerramienta
  sistema?: string
}

const resumir = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s)

export function definirTools(tools: Herramientas): DefinicionTool[] {
  return Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
    parameters: z.toJSONSchema(z.object(t.args)) as Record<string, unknown>,
  }))
}

export function clasificarErrorLlm(e: unknown): ErrorLlm {
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return { tipo: "timeout" }
  const status = e instanceof Error ? /LLM HTTP (\d{3})/.exec(e.message)?.[1] : undefined
  if (status) return { tipo: "http", status: Number(status) }
  return { tipo: "desconocido" }
}

// Mensaje claro para el analista, sin traza ni clave.
export function mensajeErrorLlm(err: ErrorLlm): string {
  if (err.tipo === "timeout") return "El modelo tardó demasiado en responder (timeout). Intenta de nuevo."
  if (err.tipo === "http") {
    const { status } = err
    if (status === 429) return "El proveedor de IA rechazó la solicitud por cuota o créditos agotados (429). Revisa la cuenta del proveedor."
    if (status === 401 || status === 403) return `El proveedor de IA rechazó la clave (${status}). Revisa ANTHROPIC_API_KEY en .env.`
    if (status >= 500) return `El proveedor de IA tuvo un error interno (${status}). Intenta de nuevo en unos minutos.`
    return `El proveedor de IA rechazó la solicitud (${status}).`
  }
  return "No pude consultar al modelo en este momento. Intenta de nuevo."
}

// Salidas de herramientas exitosas de toda la sesión: son la única fuente válida de valores (CA2).
const fuentesDe = (historial: Mensaje[]): string[] =>
  historial.flatMap((m) => {
    if (m.role !== "tool") return []
    try {
      return JSON.parse(m.content).ok !== false ? [m.content] : []
    } catch {
      return []
    }
  })

// CA2: los identificadores de la respuesta (6 dígitos o más, correos y URLs) deben haber salido de una herramienta.
const PATRONES_IDENTIFICADORES = [/\b\d{6,}\b/g, /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, /https?:\/\/[^\s)]+/g]

function verificarValores(reply: string, fuentes: string[]): string {
  const encontrados = PATRONES_IDENTIFICADORES.flatMap((patron) => reply.match(patron) ?? []).map((v) => v.replace(/[.,;:]+$/, ""))
  const noVerificados = [...new Set(encontrados.filter((v) => !fuentes.some((f) => f.includes(v))))]
  if (!noVerificados.length) return reply
  return `${reply}\n⚠ Valores no verificados por herramientas: ${noVerificados.join(", ")}`
}

export async function ejecutarTurno(op: OpcionesCiclo, historial: Mensaje[]): Promise<ResultadoTurno> {
  const mensajes = [...historial]
  const toolCalls: RegistroToolCall[] = []
  const fuentes = fuentesDe(historial)
  const defs = definirTools(op.tools)
  const tokens = { entrada: 0, salida: 0 }

  for (let i = 0; i < op.maxIter; i++) {
    let resp
    try {
      resp = await op.adapter.enviar(mensajes, defs, op.sistema)
    } catch (e) {
      const errorLlm = clasificarErrorLlm(e)
      return { reply: mensajeErrorLlm(errorLlm), toolCalls, faltantes: [], tokens, errorLlm, mensajes }
    }
    if (resp.usage) {
      tokens.entrada += resp.usage.entrada
      tokens.salida += resp.usage.salida
    }

    if (!resp.toolCalls?.length) {
      const faltantes: string[] = []
      for (const v of resp.valores ?? []) {
        if (!fuentes.some((f) => f.includes(v.valor))) faltantes.push(v.campo)
      }
      let reply = resp.text ?? ""
      if (faltantes.length) reply += `${reply ? "\n" : ""}Faltantes (sin fuente en herramientas): ${faltantes.join(", ")}`
      return { reply: verificarValores(reply, fuentes), toolCalls, faltantes, tokens, mensajes }
    }

    mensajes.push({ role: "assistant", content: resp.text ?? "", toolCalls: resp.toolCalls })
    for (const c of resp.toolCalls) {
      const { salida, ok } = await ejecutarLlamada(c, op)
      if (ok) fuentes.push(salida)
      toolCalls.push({ name: c.name, args: c.args, ok, resumen: resumir(salida) })
      mensajes.push({ role: "tool", toolCallId: c.id, name: c.name, content: salida })
    }
  }

  const parciales = toolCalls.filter((t) => t.ok).map((t) => `- ${t.name}: ${t.resumen}`)
  const reply = `Llegué al tope de ${op.maxIter} iteraciones. Resultados parciales:\n${parciales.join("\n")}\nFaltan datos por completar; indícame cómo continuar.`
  return { reply, toolCalls, faltantes: [], tokens, mensajes }
}

async function ejecutarLlamada(c: LlamadaTool, op: OpcionesCiclo): Promise<{ salida: string; ok: boolean }> {
  const tool = op.tools[c.name]
  if (!tool) return { salida: JSON.stringify({ ok: false, error: `herramienta desconocida: ${c.name}` }), ok: false }
  const parsed = z.object(tool.args).safeParse(c.args)
  if (!parsed.success) return { salida: JSON.stringify({ ok: false, error: `argumentos inválidos: ${parsed.error.message}` }), ok: false }
  try {
    const salida = await tool.execute(parsed.data, op.ctx)
    let ok = true
    try {
      ok = JSON.parse(salida).ok !== false
    } catch {}
    return { salida, ok }
  } catch (e) {
    return { salida: JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "error de herramienta" }), ok: false }
  }
}
