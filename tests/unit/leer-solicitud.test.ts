import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { IFileSystem, ToolContext } from "../../src/core/BaseTool.js"
import { FsNode } from "../../src/core/FileSystem.js"
import { cargarConfigPortal } from "../../src/config.js"
import { LeerSolicitud } from "../../src/tools/proveedor.js"

const raiz = fileURLToPath(new URL("../../", import.meta.url))
const reloj = { hoy: () => "2026-09-03" }
// Lectura real del disco; las escrituras (p.ej. log.jsonl) se descartan para no ensuciar out/.
const realFs = new FsNode()
const ctxReal: ToolContext = {
  directory: raiz,
  fs: { ...realFs, leer: (r) => realFs.leer(r), existe: (r) => realFs.existe(r), escribir: () => {}, escribirBinario: () => {}, copiar: () => {}, listar: () => [], borrar: () => {} },
  clock: reloj,
}

function fsFalso(archivos: Record<string, string>): IFileSystem {
  return {
    leer: (ruta) => {
      if (!(ruta in archivos)) throw new Error(`no existe: ${ruta}`)
      return archivos[ruta]
    },
    existe: (ruta) => ruta in archivos,
    escribir: () => {},
    escribirBinario: () => {}, copiar: () => {},
    listar: () => [],
    borrar: () => {},
  }
}

const dirCaso = (caso: string) => join(raiz, cargarConfigPortal().rutas.casos, caso)

describe("LeerSolicitud", () => {
  it("caso feliz pa-logistica-istmo: país, cliente, formato, 9 campos y 2 soportes", async () => {
    const salida = JSON.parse(await new LeerSolicitud().execute({ caso: "pa-logistica-istmo" }, ctxReal))
    expect(salida.ok).toBe(true)
    expect(salida.data.pais).toBe("PA")
    expect(salida.data.cliente).toBe("Logística del Istmo S.A.")
    expect(salida.data.formato).toBe("portal")
    expect(salida.data.campos).toHaveLength(9)
    expect(salida.data.soportes).toEqual(["camara_comercio", "rut"])
  })

  it("caso inexistente devuelve {ok:false,error} legible sin lanzar", async () => {
    const salida = JSON.parse(await new LeerSolicitud().execute({ caso: "no-existe" }, ctxReal))
    expect(salida.ok).toBe(false)
    expect(salida.error).toMatch(/no-existe/)
  })

  it("plantilla corrupta devuelve {ok:false,error} sin lanzar", async () => {
    const ctx: ToolContext = {
      directory: raiz,
      clock: reloj,
      fs: fsFalso({
        [join(dirCaso("caso-x"), "solicitud.json")]: JSON.stringify({ pais: "PA", cliente: "X", formato: "portal" }),
        [join(dirCaso("caso-x"), "plantilla-campos.json")]: "[{ corrupto",
        [join(dirCaso("caso-x"), "soportes-exigidos.json")]: "[]",
      }),
    }
    const salida = JSON.parse(await new LeerSolicitud().execute({ caso: "caso-x" }, ctx))
    expect(salida.ok).toBe(false)
    expect(typeof salida.error).toBe("string")
  })
})
