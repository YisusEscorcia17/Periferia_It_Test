import { z } from "zod"
import { FORMATOS_NOMBRE, PAISES_NOMBRE } from "./config.js"
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

// CA2: identificadores (6 dígitos o más, correos, URLs) que la respuesta afirma deben haber salido de una herramienta.
const PATRONES_IDENTIFICADORES = [/\b\d{6,}\b/g, /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, /https?:\/\/[^\s)]+/g]

// Valores destacados: negrita, comillas latinas o inglesas.
const PATRON_DESTACADO = /\*\*([^*]+)\*\*|«([^»]+)»|"([^"]+)"/g

// Secuencias con mayúscula inicial: posibles nombres propios (p. ej. "Carlos Restrepo Vélez").
const PATRON_NOMBRE = /\b[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ.&-]*(?:\s+(?:(?:de|del|la|las|los|y|e)(?![A-Za-zÁÉÍÓÚÑáéíóúñ0-9])|[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ.&-]*))+/g

// Palabras del proceso y de la interfaz que no son valores (encabezados, etiquetas, nombres de caso).
const PALABRAS_DEL_PROCESO = [
  "estado", "resultado", "resumen", "faltantes", "faltante", "llenos", "lleno", "requiere", "confirmación", "confirmar", "confirme",
  "formulario", "formularios", "paquete", "checklist", "borrador", "correo", "soportes", "soporte", "archivos", "listos", "descargar",
  "firma", "listo", "envío", "envíes", "enviar", "simulado", "pendiente", "revisar", "campos", "campo", "portal", "valores", "excel", "pdf",
  "caso", "cliente", "país", "formato", "nota", "sugerencia", "ninguno", "sí", "colombia", "ecuador", "panamá", "perú", "honduras",
  "cámara", "comercio", "rut", "certificación", "bancaria", "estados", "financieros", "parafiscales", "iso", "tributario", "identificador",
  "extranjero", "anterior", "siguiente", "procesé", "generé", "preparé", "revisa", "nit", "ruc", "rtn", "dv", "cuenta", "banco", "swift",
  "claude", "haiku", "proveedor", "registro", "solicitud", "herramienta", "herramientas", "llamada", "llamadas", "turno",
  "está", "están", "estoy", "estar", "es", "son", "fue", "ser", "hay", "tiene", "tienen", "todavía", "aún", "qué", "cuál", "cuáles", "quién",
  "cómo", "tu", "tus", "mi", "mis", "puede", "pueden", "debe", "deben", "hacer", "quedó", "quedaron", "quedan", "falta", "faltan", "sigue",
  "siguen", "presente", "presentes", "ausente", "ausentes", "vencido", "vencidos", "vigente", "vigentes", "enviar", "pregunta", "dato", "datos",
  "revisa", "confirma", "prepara", "preparé", "procesa", "procesé", "genera", "generé", "arma", "armé", "entrega", "entregué", "descarga",
  "tiene", "listo", "lista", "listos", "sin", "más", "menos", "solo", "sólo", "también", "ahora", "después", "antes", "todo", "todos",
]
const CONECTORES = new Set(["de", "del", "la", "las", "los", "y", "e", "el", "un", "una", "es", "en", "con", "por", "para", "al", "a", "o", "se", "que", "lo", "su", "no", "ya"])

const normalizarPalabra = (p: string) =>
  p
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/^[.,;:()]+|[.,;:()]+$/g, "")

// Todas las palabras que aparecen en las salidas de herramientas de la sesión.
function palabrasDeFuentes(fuentes: string[]): Set<string> {
  return new Set(fuentes.flatMap((f) => f.split(/[^\p{L}\p{N}.&-]+/u).map(normalizarPalabra).filter(Boolean)))
}

// Candidatos a valor (destacados o nombres propios) cuyo texto no aparece en las salidas de herramientas.
function nombresNoVerificados(reply: string, fuentes: string[]): string[] {
  const conocidas = palabrasDeFuentes(fuentes)
  for (const p of PALABRAS_DEL_PROCESO) conocidas.add(normalizarPalabra(p))
  const candidatos = [
    ...[...reply.matchAll(PATRON_DESTACADO)].map((m) => (m[1] ?? m[2] ?? m[3]).trim()),
    ...[...reply.matchAll(PATRON_NOMBRE)].map((m) => m[0].trim()),
  ]
  return [...new Set(candidatos)].filter((c) =>
    c
      .split(/\s+/)
      .map(normalizarPalabra)
      .filter((p) => p && !CONECTORES.has(p))
      .some((p) => !conocidas.has(p)),
  )
}

function verificarValores(reply: string, fuentes: string[]): string {
  const identificadores = PATRONES_IDENTIFICADORES.flatMap((patron) => reply.match(patron) ?? [])
    .map((v) => v.replace(/[.,;:]+$/, ""))
    .filter((v) => !fuentes.some((f) => f.includes(v)))
  const noVerificados = [...new Set([...identificadores, ...nombresNoVerificados(reply, fuentes)])]
  if (!noVerificados.length) return reply
  return `${reply}\n⚠ Valores no verificados por herramientas: ${noVerificados.join(", ")}`
}

// HU-1: si el turno leyó la solicitud, la primera línea de la respuesta dice caso, cliente, país y formato.
// El modelo lo dice casi siempre; cuando no lo hace, el servidor antepone la línea con los datos de la herramienta.
function encabezar(reply: string, toolCalls: RegistroToolCall[], mensajes: Mensaje[]): string {
  const lectura = toolCalls.find((t) => t.name === "proveedor_leer_solicitud" && t.ok)
  if (!lectura) return reply
  const salida = [...mensajes].reverse().find((m) => m.role === "tool" && m.name === "proveedor_leer_solicitud")
  if (!salida || salida.role !== "tool") return reply
  const { cliente, pais, formato } = JSON.parse(salida.content).data
  if (!cliente || !pais || !formato) return reply
  const nombrePais = PAISES_NOMBRE[pais] ?? pais
  const nombreFormato = FORMATOS_NOMBRE[formato] ?? formato
  const primera = reply.split("\n")[0]
  if ([cliente, nombrePais, nombreFormato].every((t) => primera.includes(t))) return reply
  return `Caso ${String(lectura.args.caso)} · ${cliente} · ${nombrePais} · formato ${nombreFormato}\n${reply}`
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
      return { reply: verificarValores(encabezar(reply, toolCalls, mensajes), fuentes), toolCalls, faltantes, tokens, mensajes }
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
