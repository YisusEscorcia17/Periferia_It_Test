import { readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { cargarConfigPortal } from "../../src/config.js"
import { correrCaso } from "../../demo.js"

const raiz = fileURLToPath(new URL("../../", import.meta.url))
const outRel = "out-test/seguridad"
const cfg = cargarConfigPortal({ PROVEEDOR_RUTA_OUT: outRel })
const CLAVE = "sk-test-CLAVE-SECRETA-123456"

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const ruta = join(dir, e)
    return statSync(ruta).isDirectory() ? archivos(ruta) : [ruta]
  })
}

describe("seguridad", () => {
  // Clave presente en entorno: la demo no debe volcarla en ningún artefacto.
  process.env.ANTHROPIC_API_KEY = CLAVE
  const salida = join(raiz, outRel)
  beforeAll(async () => {
    await correrCaso("pa-logistica-istmo", cfg, raiz)
  })

  afterAll(() => {
    delete process.env.ANTHROPIC_API_KEY
    rmSync(join(raiz, outRel), { recursive: true, force: true })
  })

  it("la clave no aparece en ningún archivo de out/", () => {
    for (const f of archivos(salida)) {
      expect(readFileSync(f, "utf8"), f).not.toContain(CLAVE)
    }
  })

  it("los artefactos no contienen rutas absolutas de la máquina", () => {
    for (const f of archivos(salida)) {
      const contenido = readFileSync(f, "utf8")
      expect(contenido, f).not.toContain(raiz)
      expect(contenido, f).not.toMatch(/[A-Za-z]:\|\/Users\//)
    }
  })

  it("el código de herramientas no usa shell ni procesos hijos", () => {
    for (const f of archivos(join(raiz, "src", "core")).concat(archivos(join(raiz, "src", "tools")))) {
      const codigo = readFileSync(f, "utf8")
      expect(codigo, f).not.toMatch(/child_process|execSync|spawn\(|\bexec\(/)
    }
  })

  it("un caso con path traversal no toca el filesystem", async () => {
    const pasos = await correrCaso("../../etc", cfg, raiz)
    expect(pasos.every((p) => p.ok === false)).toBe(true)
  })
})
