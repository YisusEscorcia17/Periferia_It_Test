export interface Config {
  port: number
  maxIter: number
  llmTimeoutMs: number
  llmDisabled: boolean
  provider: string
  model: string
  apiKey: string | undefined
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)

export function cargarConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: num(env.PORT, 3000),
    maxIter: num(env.MAX_ITER, 25),
    llmTimeoutMs: num(env.LLM_TIMEOUT_MS, 30000),
    llmDisabled: env.LLM_DISABLED === "true",
    provider: "anthropic",
    model: env.LLM_MODEL || "claude-haiku-5-5",
    apiKey: env.ANTHROPIC_API_KEY,
  }
}

// Configuración del proveedor (reto01-mvp-portal-pa). Solo lectura de env; las rutas son relativas a ctx.directory.
export const CLAVES_PORTAL = ["PROVEEDOR_RUTA_CASOS", "PROVEEDOR_RUTA_REPOSITORIO", "PROVEEDOR_RUTA_OUT", "PROVEEDOR_RUTA_GLOSARIO", "TOKENS_SESION", "TOKENS_GLOBALES", "FECHA_REFERENCIA"] as const

// RN1: identificador tributario por país.
export const MAPA_TRIBUTARIO: Readonly<Record<string, string>> = { CO: "NIT", EC: "RUC", PE: "RUC", PA: "RUC", HN: "RTN" }

// HU-1: etiquetas tributarias genéricas que no indican el país; siempre requieren confirmación.
export const ETIQUETAS_TRIBUTARIAS_AMBIGUAS = ["Identificación tributaria", "Número de identificación fiscal"] as const

export const TEXTOS = {
  ambigua: "etiqueta ambigua: confirme el identificador tributario del país",
  faltante: "No encontrado en el maestro; complételo manualmente.",
  requiereConfirmacion: "Confirme este valor antes de enviarlo.",
  identificadorExtranjero: "identificador extranjero",
  envioRequiereConfirmacion: "requiere confirmación explícita",
} as const

export interface ConfigPortal {
  rutas: { casos: string; repositorio: string; out: string; glosario: string }
  topes: { tokensSesion: number; tokensGlobales: number }
  fechaReferencia: string
}

export function cargarConfigPortal(env: NodeJS.ProcessEnv = process.env): ConfigPortal {
  return {
    rutas: {
      casos: env.PROVEEDOR_RUTA_CASOS || "fixtures/reto-01/casos",
      repositorio: env.PROVEEDOR_RUTA_REPOSITORIO || "fixtures/reto-01/repositorio",
      out: env.PROVEEDOR_RUTA_OUT || "out",
      glosario: env.PROVEEDOR_RUTA_GLOSARIO || "fixtures/reto-01/glosario-campos.json",
    },
    topes: { tokensSesion: num(env.TOKENS_SESION, 50000), tokensGlobales: num(env.TOKENS_GLOBALES, 2000000) },
    fechaReferencia: env.FECHA_REFERENCIA || "2026-09-03",
  }
}
