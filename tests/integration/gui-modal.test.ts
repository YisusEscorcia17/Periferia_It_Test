import { mkdtemp } from "node:fs/promises"
import { existsSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JSDOM } from "jsdom"
import request from "supertest"
import { afterEach, describe, expect, it } from "vitest"
import { crearApp } from "../../src/server.js"
import { guionAdaptador, herramientasFalsas } from "../helpers.js"

// Superficie de la ventana de jsdom que el test necesita parchear.
interface VentanaJsdom {
  HTMLDialogElement: { prototype: { showModal: (this: HTMLElement) => void; close: (this: HTMLElement) => void } }
  fetch: (u: string, o?: RequestInit) => Promise<Response>
}

const casosDir = join(__dirname, "../../fixtures/reto-01/casos")
const webDir = join(__dirname, "../../web")
const cierres: Array<() => void> = []
afterEach(() => cierres.splice(0).forEach((c) => c()))

const esperar = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(cond()).toBe(true)
}

async function abrir(pasos: Parameters<typeof guionAdaptador>[0]) {
  const outDir = await mkdtemp(join(tmpdir(), "reto01-gui-"))
  const app = crearApp({ adapter: guionAdaptador(pasos), tools: herramientasFalsas(), outDir, casosDir, webDir })
  const server = app.listen(0)
  cierres.push(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const dom = await JSDOM.fromURL(`${base}/`, {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse(w) {
      // jsdom no implementa showModal/close
      const ventana = w as unknown as VentanaJsdom
      const proto = ventana.HTMLDialogElement.prototype
      proto.showModal = function (this: HTMLElement) { this.setAttribute("open", "") }
      proto.close = function (this: HTMLElement) { this.removeAttribute("open") }
      ventana.fetch = (u: string, o?: RequestInit) => fetch(new URL(u, base), o)
    },
  })
  await new Promise((r) => dom.window.addEventListener("load", r))
  const doc = dom.window.document
  const enviar = (texto: string) => {
    ;(doc.querySelector("#mensaje") as HTMLInputElement).value = texto
    ;(doc.querySelector("#form") as HTMLFormElement).dispatchEvent(new dom.window.Event("submit", { cancelable: true }))
  }
  return { dom, doc, outDir, enviar, app }
}

const pedirEnvio = (caso: string) => [
  { toolCalls: [{ id: "c1", name: "proveedor_simular_envio", args: { caso } }] },
  { text: "Paquete listo" },
]

describe("GUI modal", () => {
  it("sirve CSP default-src 'self'", async () => {
    const { app } = await abrir([{ text: "x" }])
    const r = await request(app).get("/")
    expect(r.headers["content-security-policy"]).toBe("default-src 'self'")
  })

  it("Aceptar crea el archivo", async () => {
    const { doc, outDir, enviar } = await abrir(pedirEnvio("pa-logistica-istmo"))
    enviar("envía")
    await esperar(() => (doc.querySelector("#confirmacion") as HTMLDialogElement).open)
    expect(doc.querySelector("#confirmacion")!.textContent).toMatch(/pa-logistica-istmo/)
    ;(doc.querySelector("#aceptar") as HTMLButtonElement).click()
    await esperar(() => existsSync(join(outDir, "pa-logistica-istmo", "ENVIO-SIMULADO.md")))
  })

  it("Cancelar y Esc NO crean nada", async () => {
    for (const via of ["cancelar", "esc"]) {
      const { dom, doc, outDir, enviar } = await abrir(pedirEnvio("pa-logistica-istmo"))
      enviar("envía")
      const dlg = doc.querySelector("#confirmacion") as HTMLDialogElement
      await esperar(() => dlg.open)
      if (via === "cancelar") (doc.querySelector("#cancelar") as HTMLButtonElement).click()
      else dlg.dispatchEvent(new dom.window.Event("cancel", { cancelable: true }))
      await esperar(() => /cancelad/i.test(doc.querySelector("#historial")!.textContent ?? ""))
      expect(dlg.open).toBe(false)
      expect(existsSync(join(outDir, "pa-logistica-istmo"))).toBe(false)
    }
  })

  it("XSS se muestra como texto y no ejecuta", async () => {
    const xss = '<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>'
    const { dom, doc, enviar } = await abrir([{ text: xss }])
    enviar("hola")
    await esperar(() => (doc.querySelector("#historial")!.textContent ?? "").includes("<script>"))
    expect(doc.querySelector("#historial script, #historial img")).toBeNull()
    expect((dom.window as unknown as { pwned?: unknown }).pwned).toBeUndefined()
  })

  it("caso con path traversal es rechazado y no abre modal", async () => {
    const { doc, outDir, enviar } = await abrir(pedirEnvio("../../etc"))
    enviar("envía")
    await esperar(() => (doc.querySelector("#historial")!.textContent ?? "").includes("Paquete listo"))
    expect((doc.querySelector("#confirmacion") as HTMLDialogElement).open).toBe(false)
    expect(existsSync(join(outDir, "ENVIO-SIMULADO.md"))).toBe(false)
  })
})
