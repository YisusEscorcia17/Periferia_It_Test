import ExcelJS from "exceljs"
import { readFileSync, rmSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { JSDOM } from "jsdom"
import { extractText, getDocumentProxy } from "unpdf"
import { afterAll, describe, expect, it } from "vitest"
import { cargarConfigPortal } from "../../src/config.js"
import { crearApp } from "../../src/server.js"
import { crearHerramientas } from "../../src/tools/index.js"
import { guionAdaptador } from "../helpers.js"

// Prueba de extremo a extremo desde el front: tarjeta del caso → chat con herramientas reales → enlace → archivo descargado.
const raiz = fileURLToPath(new URL("../../", import.meta.url))
// Superficie de la ventana de jsdom que la prueba necesita parchear.
interface VentanaJsdom {
  HTMLDialogElement: { prototype: { showModal: (this: HTMLElement) => void; close: (this: HTMLElement) => void } }
  fetch: (u: string, o?: RequestInit) => Promise<Response>
}

const outRel = "out-test/front"
const cfg = cargarConfigPortal({ PROVEEDOR_RUTA_OUT: outRel })
const webDir = join(raiz, "web")
const casosDir = join(raiz, cfg.rutas.casos)

afterAll(() => rmSync(join(raiz, outRel), { recursive: true, force: true }))

const esperarHasta = async (cond: () => boolean, ms = 15000) => {
  const limite = Date.now() + ms
  while (!cond() && Date.now() < limite) await new Promise((r) => setTimeout(r, 50))
  return cond()
}

// Abre el front real, pulsa la tarjeta del caso y devuelve el documento y la URL base.
async function usarFrontCon(pasos: Parameters<typeof guionAdaptador>[0], caso: string) {
  const app = crearApp({ adapter: guionAdaptador(pasos), tools: crearHerramientas(raiz, cfg), outDir: join(raiz, outRel), casosDir, webDir })
  const server = app.listen(0)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const dom = await JSDOM.fromURL(`${base}/`, {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse(w) {
      // jsdom no implementa showModal/close ni fetch relativo: se parchea la ventana con su forma real.
      const ventana = w as unknown as VentanaJsdom
      const proto = ventana.HTMLDialogElement.prototype
      proto.showModal = function (this: HTMLElement) { this.setAttribute("open", "") }
      proto.close = function (this: HTMLElement) { this.removeAttribute("open") }
      ventana.fetch = (u: string, o?: RequestInit) => fetch(new URL(u, base), o)
    },
  })
  await new Promise((r) => dom.window.addEventListener("load", r))
  const doc = dom.window.document
  const tarjeta = [...doc.querySelectorAll("button.caso")].find((b) => b.textContent?.includes(caso)) as HTMLButtonElement
  expect(tarjeta, `tarjeta del caso ${caso}`).toBeTruthy()
  tarjeta.click()
  const llego = await esperarHasta(() => doc.querySelector("#historial .descargas a") !== null)
  return { server, base, doc, llego }
}

const descargar = async (base: string, href: string) => {
  const r = await fetch(new URL(href, base))
  return { status: r.status, tipo: r.headers.get("content-type") ?? "", bytes: Buffer.from(await r.arrayBuffer()) }
}

const herramienta = (name: string, args: Record<string, unknown>, id: string) => ({ toolCalls: [{ id, name, args }] })

describe("front: generación real de cada formato y descarga desde el chat (PRD HU-3, HU-4)", () => {
  it("co-industrias-delta: el front genera formulario.xlsx y el archivo abre con el NIT en su celda", async () => {
    const caso = "co-industrias-delta"
    const { server, base, doc, llego } = await usarFrontCon([herramienta("proveedor_generar_formulario", { caso }, "g1"), { text: "Listo." }], caso)
    try {
      expect(llego).toBe(true)
      const enlace = doc.querySelector("#historial .descargas a[href$='formulario.xlsx']") as HTMLAnchorElement
      expect(enlace, "enlace al Excel en el chat").toBeTruthy()
      const r = await descargar(base, enlace.getAttribute("href")!)
      expect(r.status).toBe(200)
      const libro = new ExcelJS.Workbook()
      await libro.xlsx.load(r.bytes as unknown as Parameters<typeof libro.xlsx.load>[0])
      const plantilla: Array<{ hoja: string; celda_etiqueta: string; etiqueta: string; celda_valor: string }> = JSON.parse(readFileSync(join(raiz, cfg.rutas.casos, caso, "plantilla-celdas.json"), "utf8"))
      const nit = plantilla.find((f) => f.etiqueta === "NIT")!
      expect(libro.getWorksheet(nit.hoja)!.getCell(nit.celda_valor).value).toBe("900123456")
    } finally {
      server.close()
    }
  })

  it("hn-agroexport-sula: el front genera el Excel del caso Honduras", async () => {
    const caso = "hn-agroexport-sula"
    const { server, base, doc, llego } = await usarFrontCon([herramienta("proveedor_generar_formulario", { caso }, "g1"), { text: "Listo." }], caso)
    try {
      expect(llego).toBe(true)
      const enlace = doc.querySelector("#historial .descargas a[href$='formulario.xlsx']") as HTMLAnchorElement
      const r = await descargar(base, enlace.getAttribute("href")!)
      expect(r.status).toBe(200)
      const libro = new ExcelJS.Workbook()
      await libro.xlsx.load(r.bytes as unknown as Parameters<typeof libro.xlsx.load>[0])
      expect(libro.worksheets.length).toBeGreaterThan(0)
    } finally {
      server.close()
    }
  })

  it("ec-corp-andina: el front genera formulario.pdf y el archivo es un PDF con los campos en orden", async () => {
    const caso = "ec-corp-andina"
    const { server, base, doc, llego } = await usarFrontCon([herramienta("proveedor_generar_formulario", { caso }, "g1"), { text: "Listo." }], caso)
    try {
      expect(llego).toBe(true)
      const enlace = doc.querySelector("#historial .descargas a[href$='formulario.pdf']") as HTMLAnchorElement
      const r = await descargar(base, enlace.getAttribute("href")!)
      expect(r.status).toBe(200)
      expect(r.bytes.subarray(0, 4).toString()).toBe("%PDF")
      const pdf = await getDocumentProxy(new Uint8Array(r.bytes))
      const { text } = await extractText(pdf, { mergePages: true })
      const etiquetas: string[] = JSON.parse(readFileSync(join(raiz, cfg.rutas.casos, caso, "plantilla-campos.json"), "utf8")).map((c: { etiqueta: string }) => c.etiqueta)
      let previa = -1
      for (const e of etiquetas) {
        const pos = text.indexOf(e, previa + 1)
        expect(pos, `etiqueta ${e} en orden`).toBeGreaterThan(previa)
        previa = pos
      }
    } finally {
      server.close()
    }
  })

  it("pa-logistica-istmo: el front responde 'formato no soportado' y entrega valores-portal.md para copiar", async () => {
    const caso = "pa-logistica-istmo"
    const { server, base, doc, llego } = await usarFrontCon([herramienta("proveedor_generar_formulario", { caso }, "g1"), { text: "Listo." }], caso)
    try {
      expect(llego).toBe(true)
      const resumen = doc.querySelector("#historial details.tool pre")?.textContent ?? ""
      expect(resumen).toMatch(/formato no soportado/)
      const enlace = doc.querySelector("#historial .descargas a[href$='valores-portal.md']") as HTMLAnchorElement
      const r = await descargar(base, enlace.getAttribute("href")!)
      expect(r.status).toBe(200)
      expect(r.bytes.toString()).toMatch(/\| RUC \|/)
    } finally {
      server.close()
    }
  })

  it("el paquete del caso se descarga desde el chat con su checklist", async () => {
    const caso = "co-industrias-delta"
    const { server, base, doc, llego } = await usarFrontCon(
      [herramienta("proveedor_generar_formulario", { caso }, "g1"), herramienta("proveedor_armar_paquete", { caso }, "a1"), { text: "Listo." }],
      caso,
    )
    try {
      expect(llego).toBe(true)
      const enlace = doc.querySelector("#historial .descargas a[href$='checklist.md']") as HTMLAnchorElement
      expect(enlace, "enlace al checklist").toBeTruthy()
      const r = await descargar(base, enlace.getAttribute("href")!)
      expect(r.status).toBe(200)
      expect(r.bytes.toString()).toMatch(/Checklist de soportes/)
    } finally {
      server.close()
    }
  })
})

describe("descargas agrupadas y sin duplicados (usuario final)", () => {
  it("el front separa 'Formulario' y 'Paquete para firma', con etiquetas claras y sin repetir el formulario", async () => {
    const caso = "co-industrias-delta"
    const { server, doc, llego } = await usarFrontCon(
      [herramienta("proveedor_generar_formulario", { caso }, "g1"), herramienta("proveedor_armar_paquete", { caso }, "a1"), { text: "Listo." }],
      caso,
    )
    try {
      expect(llego).toBe(true)
      const titulos = [...doc.querySelectorAll("#historial .descargas h4")].map((h) => h.textContent)
      expect(titulos).toEqual(["Formulario", "Paquete para firma"])
      const etiquetas = [...doc.querySelectorAll("#historial .descargas a")].map((a) => a.textContent)
      expect(etiquetas).toContain("Formulario Excel")
      expect(etiquetas).toContain("Checklist de soportes")
      expect(etiquetas).toContain("Borrador de correo")
      const hrefs = [...doc.querySelectorAll("#historial .descargas a")].map((a) => a.getAttribute("href"))
      expect(hrefs.filter((h) => h?.endsWith("/paquete/formulario.xlsx"))).toHaveLength(0)
      expect(new Set(hrefs).size).toBe(hrefs.length)
    } finally {
      server.close()
    }
  })

  it("el caso PDF muestra 'Formulario PDF' y no ofrece Excel", async () => {
    const caso = "ec-corp-andina"
    const { server, doc, llego } = await usarFrontCon([herramienta("proveedor_generar_formulario", { caso }, "g1"), { text: "Listo." }], caso)
    try {
      expect(llego).toBe(true)
      const etiquetas = [...doc.querySelectorAll("#historial .descargas a")].map((a) => a.textContent)
      expect(etiquetas).toEqual(["Formulario PDF"])
    } finally {
      server.close()
    }
  })
})
