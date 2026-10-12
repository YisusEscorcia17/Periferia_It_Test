import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { Adaptador, RespuestaLLM } from "../src/llm/adapter.js"
import type { Herramientas } from "../src/tools/registry.js"

export function guionAdaptador(pasos: Array<RespuestaLLM | Error | ((n: number) => RespuestaLLM)>): Adaptador & { llamadas: number } {
  const a = {
    llamadas: 0,
    nombre: "mock",
    modelo: "mock-1",
    async enviar() {
      const paso = pasos[Math.min(a.llamadas, pasos.length - 1)]
      a.llamadas++
      if (paso instanceof Error) throw paso
      return typeof paso === "function" ? paso(a.llamadas) : paso
    },
  }
  return a
}

export function herramientasFalsas(): Herramientas {
  return {
    proveedor_simular_envio: {
      description: "simula el envío (requiere confirmación)",
      args: { caso: z.string().describe("caso"), confirmado: z.boolean().optional() },
      async execute({ caso, confirmado }: { caso: string; confirmado?: boolean }, ctx: { directory: string }) {
        if (confirmado !== true) return JSON.stringify({ ok: false, error: "requiere confirmación explícita" })
        const dir = join(ctx.directory, caso)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "ENVIO-SIMULADO.md"), "# Envío simulado\n")
        return JSON.stringify({ ok: true, data: { ruta: dir } })
      },
    },
    proveedor_generar_formulario: {
      description: "genera el formulario del caso (falso)",
      args: { caso: z.string().describe("caso") },
      async execute({ caso }: { caso: string }, ctx: { directory: string }) {
        const dir = join(ctx.directory, caso)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "formulario.xlsx"), "xlsx falso")
        return JSON.stringify({ ok: true, data: { ruta: `out/${caso}/formulario.xlsx`, formato: "xlsx" } })
      },
    },
    proveedor_leer_solicitud: {
      description: "lee solicitud",
      args: { caso: z.string().describe("caso") },
      async execute() {
        return JSON.stringify({ ok: true, data: { pais: "Panamá", cliente: "Logística Istmo" } })
      },
    },
  }
}
