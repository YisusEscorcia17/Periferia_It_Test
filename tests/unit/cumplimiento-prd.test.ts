import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import type { ToolContext } from "../../src/core/BaseTool.js"
import { cargarConfigPortal } from "../../src/config.js"
import { FsNode } from "../../src/core/FileSystem.js"
import { GenerarPortal, LeerSolicitud, MapearCampos } from "../../src/tools/proveedor.js"

const raiz = fileURLToPath(new URL("../../", import.meta.url))
const outRel = "out-test/cumplimiento"
const cfg = cargarConfigPortal({ PROVEEDOR_RUTA_OUT: outRel })
const ctx: ToolContext = { directory: raiz, fs: new FsNode(), clock: { hoy: () => "2026-09-03" } }
const dirCaso = (caso: string) => join(raiz, cfg.rutas.casos, caso)

afterAll(() => rmSync(join(raiz, outRel), { recursive: true, force: true }))

// Sobreescribe un archivo del caso con un contenido dado, dejando el resto como está.
function ctxCon(sobreescribir: Record<string, string>): ToolContext {
  const real = new FsNode()
  return {
    ...ctx,
    fs: {
      leer: (r) => (r in sobreescribir ? sobreescribir[r] : real.leer(r)),
      existe: (r) => r in sobreescribir || real.existe(r),
      escribir: (r, c) => real.escribir(r, c),
      escribirBinario: (r, d) => real.escribirBinario(r, d),
      copiar: (o, d) => real.copiar(o, d),
      listar: (r) => real.listar(r),
      borrar: (r) => real.borrar(r),
    },
  }
}

describe("HU-3 P2: portal responde 'formato no soportado' y entrega valores-portal.md", () => {
  it("el resultado del portal incluye el aviso exigido y el archivo", async () => {
    const salida = JSON.parse(await new GenerarPortal(cfg).execute({ caso: "pa-logistica-istmo" }, ctx))
    expect(salida.ok).toBe(true)
    expect(salida.data.aviso).toMatch(/formato no soportado/i)
    expect(salida.data.ruta).toMatch(/valores-portal\.md$/)
  })

  it("el prompt del agente instruye decir 'formato no soportado' para el portal", () => {
    const prompt = readFileSync(join(raiz, "agent/prompt.md"), "utf8")
    expect(prompt).toMatch(/formato no soportado/i)
  })
})

describe("HU-5: plantilla corrupta con mensaje claro, sin traza del parser", () => {
  it("una plantilla JSON inválida devuelve un error en español que nombra el archivo", async () => {
    const ruta = join(dirCaso("pa-logistica-istmo"), "plantilla-campos.json")
    const salida = JSON.parse(await new LeerSolicitud(cfg).execute({ caso: "pa-logistica-istmo" }, ctxCon({ [ruta]: "[{ corrupto" })))
    expect(salida.ok).toBe(false)
    expect(salida.error).toMatch(/plantilla-campos\.json/)
    expect(salida.error).toMatch(/corrupt|no se puede leer|inválido/i)
    expect(salida.error).not.toMatch(/Expected|Unexpected|position|line \d/)
  })

  it("un glosario corrupto se explica como glosario corrupto", async () => {
    const ruta = join(raiz, cfg.rutas.glosario)
    const salida = JSON.parse(await new MapearCampos(cfg).execute({ caso: "pa-logistica-istmo" }, ctxCon({ [ruta]: "{roto" })))
    expect(salida.ok).toBe(false)
    expect(salida.error).toMatch(/glosario-campos\.json/)
    expect(salida.error).not.toMatch(/Expected|Unexpected|position/)
  })
})

describe("HU-2: confianza menor que 0.8 pasa a requiere_confirmacion; nunca se inventa", () => {
  const mapear = async (etiqueta: string) =>
    JSON.parse(await new MapearCampos(cfg).execute({ caso: "pa-logistica-istmo", campos: [{ etiqueta }] }, ctx)).data

  it("una variante sin acentos ni mayúsculas (confianza 1) se llena con su fuente", async () => {
    const d = await mapear("nombre o razon social del proveedor")
    expect(d.llenos).toEqual([expect.objectContaining({ fuente: "razon_social" })])
  })

  it("una etiqueta parecida (confianza entre 0.5 y 0.8) va a requiere_confirmacion con sugerencia", async () => {
    const d = await mapear("Nombre del proveedor")
    expect(d.llenos).toEqual([])
    expect(d.requiere_confirmacion).toEqual([
      expect.objectContaining({ etiqueta: "Nombre del proveedor", fuente: "razon_social", nota: expect.stringMatching(/confianza|sugerencia/i) }),
    ])
  })

  it("una etiqueta sin parecido suficiente sigue siendo faltante", async () => {
    const d = await mapear("Campo inexistente XYZ")
    expect(d.faltantes).toEqual([{ etiqueta: "Campo inexistente XYZ" }])
  })
})

describe("respuesta al usuario final (PRD 6.1: el chat muestra el resultado)", () => {
  it("el prompt pide indicar el formato del formulario y remitir a los enlaces, sin rutas del servidor", () => {
    const prompt = readFileSync(join(raiz, "agent/prompt.md"), "utf8")
    expect(prompt).toMatch(/Archivos listos para descargar/)
    expect(prompt).toMatch(/no escribas rutas/i)
  })
})

describe("HU-5: plantilla ausente con mensaje claro y sin rutas absolutas (xlsx y pdf)", () => {
  // Simula que el archivo no existe: existe() es false y leer() falla como lo haría el sistema de archivos.
  const sinArchivo = (ruta: string): ToolContext => {
    const real = new FsNode()
    return {
      ...ctx,
      fs: {
        leer: (r) => {
          if (r === ruta) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${r}'`), { code: "ENOENT" })
          return real.leer(r)
        },
        existe: (r) => (r === ruta ? false : real.existe(r)),
        escribir: (r, c) => real.escribir(r, c),
        escribirBinario: (r, d) => real.escribirBinario(r, d),
        copiar: (o, d) => real.copiar(o, d),
        listar: (r) => real.listar(r),
        borrar: (r) => real.borrar(r),
      },
    }
  }
  const sinTraza = (texto: string) => {
    expect(texto).not.toMatch(/ENOENT|no such file|open '/)
    expect(texto).not.toMatch(/[A-Za-z]:\|\/Users\//)
  }

  it("xlsx sin plantilla-celdas.json: mensaje claro que nombra el archivo", async () => {
    const ruta = join(dirCaso("co-industrias-delta"), "plantilla-celdas.json")
    const salida = JSON.parse(await new GenerarPortal(cfg).execute({ caso: "co-industrias-delta" }, sinArchivo(ruta)))
    expect(salida.ok).toBe(false)
    expect(salida.error).toMatch(/plantilla-celdas\.json/)
    sinTraza(salida.error)
  })

  it("pdf sin plantilla-campos.json: mensaje claro que nombra el archivo", async () => {
    const ruta = join(dirCaso("ec-corp-andina"), "plantilla-campos.json")
    const salida = JSON.parse(await new GenerarPortal(cfg).execute({ caso: "ec-corp-andina" }, sinArchivo(ruta)))
    expect(salida.ok).toBe(false)
    expect(salida.error).toMatch(/plantilla-campos\.json/)
    sinTraza(salida.error)
  })
})

describe("HU-5: archivo que existe pero no se puede leer (p. ej. permisos) sin traza ni rutas", () => {
  it("el error nombra el archivo y no muestra la causa técnica del sistema", async () => {
    const ruta = join(dirCaso("co-industrias-delta"), "plantilla-celdas.json")
    const real = new FsNode()
    const ctxIlegible: ToolContext = {
      ...ctx,
      fs: {
        leer: (r) => {
          if (r === ruta) throw Object.assign(new Error(`EACCES: permission denied, open '${r}'`), { code: "EACCES" })
          return real.leer(r)
        },
        existe: () => true,
        escribir: (r, c) => real.escribir(r, c),
        escribirBinario: (r, d) => real.escribirBinario(r, d),
        copiar: (o, d) => real.copiar(o, d),
        listar: (r) => real.listar(r),
        borrar: (r) => real.borrar(r),
      },
    }
    const salida = JSON.parse(await new GenerarPortal(cfg).execute({ caso: "co-industrias-delta", mapeo: { llenos: [], faltantes: [], requiere_confirmacion: [] } }, ctxIlegible))
    expect(salida.ok).toBe(false)
    expect(salida.error).toMatch(/plantilla-celdas\.json/)
    expect(salida.error).not.toMatch(/EACCES|permission denied|open '|[A-Za-z]:\|\/Users\//)
  })
})

describe("HU-1: al elegir la solicitud el agente devuelve país, cliente y formato de salida", () => {
  it("el prompt exige decir país, cliente y formato en la primera línea tras leer la solicitud", () => {
    const prompt = readFileSync(join(raiz, "agent/prompt.md"), "utf8")
    expect(prompt).toMatch(/primera línea[\s\S]*país[\s\S]*cliente[\s\S]*formato de salida/i)
  })
})
