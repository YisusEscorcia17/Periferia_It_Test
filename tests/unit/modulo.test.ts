import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as moduloTools from "../../modulo/tools/proveedor.js"
import * as appTools from "../../src/tools/proveedor.js"

const leer = (ruta: string) => readFileSync(new URL(ruta, import.meta.url), "utf8")
const cuerpo = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n/, "")
const frontmatter = (md: string) => /^---\n([\s\S]*?)\n---\n/.exec(md)?.[1] ?? ""

describe("bonus modulo/ (PRD 9.4)", () => {
  it("las herramientas del módulo son exactamente las de la aplicación (sin copias)", () => {
    expect(moduloTools.LeerSolicitud).toBe(appTools.LeerSolicitud)
    expect(moduloTools.MapearCampos).toBe(appTools.MapearCampos)
    expect(moduloTools.GenerarPortal).toBe(appTools.GenerarPortal)
    expect(moduloTools.ArmarPaquete).toBe(appTools.ArmarPaquete)
    expect(moduloTools.SimularEnvio).toBe(appTools.SimularEnvio)
  })

  it("agent.md: frontmatter con permisos denegados y, como cuerpo, el mismo system prompt de la app", () => {
    const md = leer("../../modulo/agent.md")
    const fm = frontmatter(md)
    expect(fm).toMatch(/^description: .+/m)
    expect(fm).toMatch(/^mode: primary$/m)
    expect(fm).toMatch(/edit: deny/)
    expect(fm).toMatch(/bash: deny/)
    expect(cuerpo(md)).toBe(leer("../../agent/prompt.md"))
  })

  it("SKILL.md: frontmatter con name y description y, como cuerpo, el mismo conocimiento de la app", () => {
    const md = leer("../../modulo/skill/registro-proveedor/SKILL.md")
    const fm = frontmatter(md)
    expect(fm).toMatch(/^name: registro-proveedor$/m)
    expect(fm).toMatch(/^description: .+/m)
    expect(cuerpo(md)).toBe(leer("../../src/knowledge/registro-proveedor.md"))
  })
})
