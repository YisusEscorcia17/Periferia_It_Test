import type { z } from "zod"

export interface ContextoHerramienta {
  directory: string
  sessionId: string
}

export interface Herramienta {
  description: string
  args: Record<string, z.ZodType>
  execute(args: unknown, ctx: ContextoHerramienta): Promise<string>
}

export type Herramientas = Record<string, Herramienta>
