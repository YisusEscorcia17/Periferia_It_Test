import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { BaseTool, casoSchema, type ToolContext } from "../../src/core/BaseTool.js"
import { PathResolver } from "../../src/core/PathResolver.js"

const ctx: ToolContext = {
  directory: "/raiz",
  fs: {
    leer: () => "",
    existe: () => false,
    escribir: () => {},
    escribirBinario: () => {}, copiar: () => {},
    listar: () => [],
    borrar: () => {},
  },
  clock: { hoy: () => "2026-09-03" },
}

class Eco extends BaseTool<z.ZodObject<{ caso: typeof casoSchema }>> {
  readonly nombre = "eco"
  readonly schema = z.object({ caso: casoSchema })
  protected ejecutar(args: { caso: string }) {
    return { caso: args.caso }
  }
}

class Explota extends BaseTool<z.ZodObject<{ caso: typeof casoSchema }>> {
  readonly nombre = "explota"
  readonly schema = z.object({ caso: casoSchema })
  protected ejecutar(): unknown {
    throw new Error("fallo interno")
  }
}

describe("contrato de herramientas", () => {
  it("devuelve string JSON {ok:true,data} con args válidos", async () => {
    const salida = await new Eco().execute({ caso: "pa-logistica-istmo" }, ctx)
    expect(typeof salida).toBe("string")
    expect(JSON.parse(salida)).toEqual({ ok: true, data: { caso: "pa-logistica-istmo" } })
  })

  it("devuelve {ok:false,error} con args inválidos sin lanzar", async () => {
    const salida = JSON.parse(await new Eco().execute({ caso: "" }, ctx))
    expect(salida.ok).toBe(false)
    expect(typeof salida.error).toBe("string")
  })

  it("convierte una excepción interna en {ok:false,error} sin lanzar", async () => {
    const salida = JSON.parse(await new Explota().execute({ caso: "pa-logistica-istmo" }, ctx))
    expect(salida).toEqual({ ok: false, error: "fallo interno" })
  })

  it("rechaza path traversal en caso", async () => {
    const salida = JSON.parse(await new Eco().execute({ caso: "../../etc" }, ctx))
    expect(salida.ok).toBe(false)
  })

  it("casoSchema acepta slugs y rechaza vacío, rutas y separadores", async () => {
    expect(casoSchema.safeParse("pa-logistica-istmo").success).toBe(true)
    expect(casoSchema.safeParse("").success).toBe(false)
    expect(casoSchema.safeParse("../../etc").success).toBe(false)
    expect(casoSchema.safeParse("a/b").success).toBe(false)
  })
})

describe("PathResolver", () => {
  it("resuelve un caso dentro de la raíz de casos", async () => {
    const resolver = new PathResolver("/raiz/fixtures")
    expect(resolver.caso("pa-logistica-istmo")).toBe(resolve("/raiz/fixtures", "pa-logistica-istmo"))
  })

  it("lanza si el resultado sale de la raíz", async () => {
    const resolver = new PathResolver("/raiz/fixtures")
    expect(() => resolver.caso("../../etc")).toThrow()
  })
})
