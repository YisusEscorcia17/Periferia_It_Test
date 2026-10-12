import { join } from "node:path"
import { z } from "zod"
import { cargarConfigPortal, type ConfigPortal } from "../config.js"

export interface IFileSystem {
  leer(ruta: string): string
  existe(ruta: string): boolean
  escribir(ruta: string, contenido: string): void
  escribirBinario(ruta: string, datos: Uint8Array): void
  copiar(origen: string, destino: string): void
  listar(ruta: string): string[]
  borrar(ruta: string): void
}

export interface IClock {
  hoy(): string
}

export interface ToolContext {
  directory: string
  fs: IFileSystem
  clock: IClock
}

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string }

// Slug del caso: sin separadores ni puntos, así no hay path traversal.
export const casoSchema = z
  .string()
  .min(1, "caso vacío")
  .regex(/^[a-z0-9-]+$/, "caso inválido: solo minúsculas, dígitos y guiones")
  .describe("Identificador del caso, p.ej. pa-logistica-istmo")

export abstract class BaseTool<S extends z.ZodType> {
  abstract readonly nombre: string
  abstract readonly schema: S

  constructor(protected readonly config: ConfigPortal = cargarConfigPortal()) {}

  protected abstract ejecutar(args: z.infer<S>, ctx: ToolContext): unknown | Promise<unknown>

  // Nunca lanza: cualquier fallo se serializa como {ok:false,error}. Asíncrono porque algunas salidas (xlsx) son asíncronas.
  async execute(args: unknown, ctx: ToolContext): Promise<string> {
    let resultado: ToolResult
    try {
      const parseado = this.schema.safeParse(args)
      resultado = parseado.success
        ? { ok: true, data: await this.ejecutar(parseado.data, ctx) }
        : { ok: false, error: parseado.error.issues.map((i) => i.message).join("; ") }
    } catch (e) {
      resultado = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    this.registrar(args, ctx, resultado)
    return JSON.stringify(resultado)
  }

  // Observabilidad (RN5): una línea JSON por ejecución en out/<caso>/log.jsonl. Nunca lanza.
  private registrar(args: unknown, ctx: ToolContext, resultado: ToolResult): void {
    const caso = (args as { caso?: unknown } | null)?.caso
    if (typeof caso !== "string" || !casoSchema.safeParse(caso).success) return
    try {
      const logRuta = join(ctx.directory, this.config.rutas.out, caso, "log.jsonl")
      const previo = ctx.fs.existe(logRuta) ? ctx.fs.leer(logRuta) : ""
      const linea = { ts: ctx.clock.hoy(), herramienta: this.nombre, ok: resultado.ok, resumen: resultado.ok ? "ok" : resultado.error }
      ctx.fs.escribir(logRuta, previo + JSON.stringify(linea) + "\n")
    } catch {
      // El log no debe romper la herramienta.
    }
  }
}
