import express from "express"
import { existsSync } from "node:fs"
import { appendFile, mkdir, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { ejecutarTurno } from "./ciclo.js"
import { ConfirmStore } from "./confirm-store.js"
import type { Adaptador, Mensaje } from "./llm/adapter.js"
import type { Herramientas } from "./tools/registry.js"

export interface OpcionesApp {
  adapter: Adaptador
  tools: Herramientas
  maxIter?: number
  tokensSesion?: number
  tokensGlobales?: number
  outDir: string
  casosDir: string
  webDir?: string
  sistema?: string
}

interface Sesion {
  mensajes: Mensaje[]
  turno: number
  tokens: number
}

// Nombre canónico del PRD para la herramienta de envío (ver tools/proveedor.ts).
export const NOMBRE_ENVIO = "proveedor_simular_envio"
const CASO = /^[a-z0-9][a-z0-9-]{0,63}$/
const Body = z.object({
  sessionId: z.string().regex(/^[\w-]{1,64}$/),
  message: z.string().max(4000).optional(),
  confirmed: z.boolean().optional(),
  actionId: z.string().max(100).optional(),
})

export function crearApp(op: OpcionesApp) {
  const app = express()
  const store = new ConfirmStore()
  const sesiones = new Map<string, Sesion>()
  const outDir = resolve(op.outDir)
  // Tope global: protege la clave cuando el enlace es público y cualquiera abre sesiones nuevas.
  let tokensGlobales = 0
  // Herramienta real de envío; solo se invoca tras confirmación humana (Aceptar).
  const real = op.tools[NOMBRE_ENVIO]

  const log = async (evento: Record<string, unknown>) => {
    await mkdir(outDir, { recursive: true })
    await appendFile(join(outDir, "log.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), ...evento })}\n`)
  }

  const casoValido = async (caso: string) => {
    if (!CASO.test(caso)) return false
    try {
      return (await stat(join(op.casosDir, caso))).isDirectory()
    } catch {
      return false
    }
  }

  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src 'self'")
    res.setHeader("X-Content-Type-Options", "nosniff")
    next()
  })
  app.use(express.json({ limit: "32kb" }))
  if (op.webDir) app.use(express.static(op.webDir))

  const salud = (_req: express.Request, res: express.Response) =>
    res.json({ ok: true, provider: op.adapter.nombre, model: op.adapter.modelo })
  app.get("/health", salud)
  app.get("/api/health", salud)

  app.get("/api/sessions/:id", (req, res) => {
    const s = sesiones.get(req.params.id)
    if (!s) return res.status(404).json({ error: "sesión no encontrada" })
    res.json({ messages: s.mensajes.filter((m) => m.role === "user" || (m.role === "assistant" && !("toolCalls" in m))) })
  })

  // Archivos que se pueden descargar (lista blanca). Nunca se sirve nada fuera de out/<caso>/.
  const DESCARGABLES = ["formulario.xlsx", "formulario.pdf", "valores-portal.md", "ENVIO-SIMULADO.md"]
  const DESCARGABLES_PAQUETE = ["formulario.xlsx", "formulario.pdf", "valores-portal.md", "checklist.md", "borrador-correo.md"]

  const enviarArchivo = (res: express.Response, ruta: string, nombre: string) => {
    if (!existsSync(ruta)) return res.status(404).json({ error: "archivo no encontrado" })
    res.download(ruta, nombre)
  }

  app.get("/api/archivos/:caso/:nombre", (req, res) => {
    if (!CASO.test(req.params.caso) || !DESCARGABLES.includes(req.params.nombre)) return res.status(404).json({ error: "archivo no disponible" })
    enviarArchivo(res, join(outDir, req.params.caso, req.params.nombre), req.params.nombre)
  })

  app.get("/api/archivos/:caso/paquete/:nombre", (req, res) => {
    if (!CASO.test(req.params.caso) || !DESCARGABLES_PAQUETE.includes(req.params.nombre)) return res.status(404).json({ error: "archivo no disponible" })
    enviarArchivo(res, join(outDir, req.params.caso, "paquete", req.params.nombre), req.params.nombre)
  })

  // Enlaces de descarga de los archivos que existen para el caso del turno.
  const descargasDelCaso = (caso: string) => {
    const enRaiz = DESCARGABLES.filter((n) => existsSync(join(outDir, caso, n))).map((nombre) => ({ nombre, url: `/api/archivos/${caso}/${nombre}` }))
    const enPaquete = DESCARGABLES_PAQUETE.filter((n) => existsSync(join(outDir, caso, "paquete", n))).map((nombre) => ({ nombre: `paquete/${nombre}`, url: `/api/archivos/${caso}/paquete/${nombre}` }))
    return [...enRaiz, ...enPaquete]
  }

  app.post("/api/chat", async (req, res) => {
    const parsed = Body.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: "solicitud inválida" })
    const { sessionId, message, confirmed, actionId } = parsed.data
    let s = sesiones.get(sessionId)
    if (!s) sesiones.set(sessionId, (s = { mensajes: [], turno: 0, tokens: 0 }))
    s.turno++
    const turno = s.turno

    if (confirmed !== undefined || actionId) {
      if (confirmed === false) {
        await log({ evento: "cancelacion", sessionId, actionId })
        s.mensajes.push({ role: "assistant", content: "Envío cancelado. No se creó ningún archivo." })
        return res.json({ reply: "Envío cancelado. No se creó ningún archivo.", toolCalls: [], needsConfirmation: false })
      }
      const accion = confirmed && actionId ? store.consumir(sessionId, actionId, turno) : null
      if (!accion) {
        await log({ evento: "confirmacion_rechazada", sessionId })
        return res.json({ reply: "Requiere confirmación explícita vigente; no se creó ningún archivo.", toolCalls: [], needsConfirmation: false })
      }
      const caso = String(accion.caso)
      if (!real) return res.json({ reply: "Herramienta de envío no disponible; no se creó ningún archivo.", toolCalls: [], needsConfirmation: false })
      // Única vía de confirmación: la analista pulsó Aceptar con un actionId vigente.
      const envio = JSON.parse(await real.execute({ caso, confirmado: true }, { directory: outDir, sessionId }))
      if (!envio.ok) {
        await log({ evento: "envio_fallido", sessionId, caso, error: envio.error })
        return res.json({ reply: `No se pudo crear el envío: ${envio.error}`, toolCalls: [], needsConfirmation: false })
      }
      await log({ evento: "envio_simulado", sessionId, caso })
      const reply = `Envío simulado creado para ${caso}.`
      s.mensajes.push({ role: "assistant", content: reply })
      return res.json({ reply, toolCalls: [], needsConfirmation: false })
    }

    if (!message) return res.status(400).json({ error: "mensaje requerido" })
    const tope = op.tokensSesion ?? 50000
    if (s.tokens >= tope) {
      await log({ evento: "limite_tokens", sessionId, usados: s.tokens, tope })
      const reply = `Límite de tokens de la sesión alcanzado (${s.tokens} de ${tope}). Inicia una sesión nueva para continuar.`
      return res.json({ reply, toolCalls: [], needsConfirmation: false })
    }
    const topeGlobal = op.tokensGlobales ?? Infinity
    if (tokensGlobales >= topeGlobal) {
      await log({ evento: "limite_tokens_global", sessionId, usados: tokensGlobales, tope: topeGlobal })
      return res.json({ reply: `Límite global de tokens alcanzado (${tokensGlobales} de ${topeGlobal}). El servicio está en pausa hasta que se renueve el presupuesto.`, toolCalls: [], needsConfirmation: false })
    }
    s.mensajes.push({ role: "user", content: message })

    let solicitado: string | null = null
    // Al modelo solo se le expone `caso`: no puede pasar `confirmado` (CA3).
    const tools: Herramientas = {
      ...op.tools,
      [NOMBRE_ENVIO]: {
        description: "Solicita el envío del paquete al portal. Requiere confirmación humana posterior; el agente nunca confirma.",
        args: { caso: z.string().describe("identificador del caso") },
        async execute({ caso }: { caso: string }) {
          if (!(await casoValido(caso))) return JSON.stringify({ ok: false, error: "caso inexistente o inválido" })
          solicitado = caso
          return JSON.stringify({ ok: true, data: { caso, pendiente: "confirmación" } })
        },
      },
    }

    try {
      const r = await ejecutarTurno(
        { adapter: op.adapter, tools, maxIter: op.maxIter ?? 25, ctx: { directory: outDir, sessionId }, sistema: op.sistema },
        s.mensajes,
      )
      s.tokens += r.tokens.entrada + r.tokens.salida
      tokensGlobales += r.tokens.entrada + r.tokens.salida
      if (r.errorLlm) await log({ evento: "error_llm", sessionId, ...r.errorLlm })
      for (const t of r.toolCalls) await log({ evento: "tool_call", sessionId, name: t.name, args: t.args, ok: t.ok })
      let reply = r.reply
      let needsConfirmation = false
      let id: string | undefined
      if (solicitado) {
        id = store.emitir(sessionId, { caso: solicitado }, turno)
        needsConfirmation = true
        reply += `\n¿Confirmas el envío del caso ${solicitado}?`
      }
      // La sesión conserva las llamadas y resultados del turno para que el modelo pueda citarlos después.
      s.mensajes = [...r.mensajes, { role: "assistant", content: reply }]
      // Descargas del caso de la última herramienta de caso ejecutada en este turno.
      const casoDelTurno = [...r.toolCalls].reverse().map((t) => t.args.caso).find((c): c is string => typeof c === "string" && CASO.test(c))
      const descargas = casoDelTurno ? descargasDelCaso(casoDelTurno) : []
      res.json({ reply, toolCalls: r.toolCalls, needsConfirmation, tokensSesion: s.tokens, descargas, ...(id ? { actionId: id, caso: solicitado } : {}) })
    } catch (e) {
      await log({ evento: "error", sessionId, error: e instanceof Error ? e.message : "desconocido" })
      res.json({ reply: "Ocurrió un error interno; puedes seguir escribiendo.", toolCalls: [], needsConfirmation: false })
    }
  })

  return app
}
