import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { extractText, getDocumentProxy } from "unpdf"
import { afterAll, describe, expect, it } from "vitest"
import type { ToolContext } from "../../src/core/BaseTool.js"
import { cargarConfigPortal } from "../../src/config.js"
import { FsNode } from "../../src/core/FileSystem.js"
import { GenerarPortal, MapearCampos } from "../../src/tools/proveedor.js"

const raiz = fileURLToPath(new URL("../../", import.meta.url))
const outRel = "out-test/pdf"
const cfg = cargarConfigPortal({ PROVEEDOR_RUTA_OUT: outRel })
const ctx: ToolContext = { directory: raiz, fs: new FsNode(), clock: { hoy: () => "2026-09-03" } }
const caso = "ec-corp-andina"
const rutaPdf = join(raiz, outRel, caso, "formulario.pdf")

interface Etiqueta {
  etiqueta: string
}
const plantilla = (): Etiqueta[] => JSON.parse(readFileSync(join(raiz, cfg.rutas.casos, caso, "plantilla-campos.json"), "utf8"))

async function textoDelPdf(ruta: string): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(readFileSync(ruta)))
  const { text } = await extractText(doc, { mergePages: true })
  return text
}

afterAll(() => rmSync(join(raiz, outRel), { recursive: true, force: true }))

describe("GenerarPortal rama pdf (HU-3 P1)", () => {
  it("genera formulario.pdf real, no vacío", async () => {
    const salida = JSON.parse(await new GenerarPortal(cfg).execute({ caso }, ctx))
    expect(salida.ok).toBe(true)
    expect(salida.data.formato).toBe("pdf")
    expect(existsSync(rutaPdf)).toBe(true)
    expect(readFileSync(rutaPdf).subarray(0, 4).toString()).toBe("%PDF")
    expect(readFileSync(rutaPdf).length).toBeGreaterThan(1000)
  })

  it("contiene cada etiqueta de la plantilla en el orden dado", async () => {
    await new GenerarPortal(cfg).execute({ caso }, ctx)
    const texto = await textoDelPdf(rutaPdf)
    let anterior = -1
    for (const { etiqueta } of plantilla()) {
      const pos = texto.indexOf(etiqueta, anterior + 1)
      expect(pos, `etiqueta "${etiqueta}" en orden`).toBeGreaterThan(anterior)
      anterior = pos
    }
  })

  it("los campos llenos muestran su valor y los faltantes se marcan como pendientes", async () => {
    const mapeo = JSON.parse(await new MapearCampos(cfg).execute({ caso }, ctx)).data
    await new GenerarPortal(cfg).execute({ caso }, ctx)
    const texto = await textoDelPdf(rutaPdf)
    expect(mapeo.faltantes.length).toBeGreaterThan(0)
    expect(texto).toContain("(pendiente)")
    expect(texto).toContain("Medellín")
  })

  it("dos ejecuciones producen el mismo texto (determinista)", async () => {
    await new GenerarPortal(cfg).execute({ caso }, ctx)
    const primero = await textoDelPdf(rutaPdf)
    await new GenerarPortal(cfg).execute({ caso }, ctx)
    expect(await textoDelPdf(rutaPdf)).toBe(primero)
  })
})
