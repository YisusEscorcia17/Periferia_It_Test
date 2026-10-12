// Genera modulo/ desde las fuentes de la app: el cuerpo de agent.md es agent/prompt.md y el de SKILL.md es la knowledge.
// Así el módulo y la aplicación no pueden divergir (PRD 9.4). Ejecutar: npm run modulo
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const raiz = fileURLToPath(new URL("..", import.meta.url))
const leer = (ruta: string) => readFileSync(join(raiz, ruta), "utf8")
const escribir = (ruta: string, contenido: string) => {
  mkdirSync(join(raiz, ruta, ".."), { recursive: true })
  writeFileSync(join(raiz, ruta), contenido)
}

escribir(
  "modulo/agent.md",
  [
    "---",
    "description: Agente de registro de proveedores de Periferia. Procesa solicitudes con herramientas proveedor_* y exige confirmación humana antes de cualquier envío.",
    "mode: primary",
    "permission:",
    "  edit: deny",
    "  bash: deny",
    "---",
    leer("agent/prompt.md"),
  ].join("\n"),
)

escribir(
  "modulo/skill/registro-proveedor/SKILL.md",
  [
    "---",
    "name: registro-proveedor",
    "description: Proceso de registro de proveedor de Periferia: herramientas, reglas RN1 a RN5 y confirmación para envíos.",
    "---",
    leer("src/knowledge/registro-proveedor.md"),
  ].join("\n"),
)

escribir(
  "modulo/tools/proveedor.ts",
  [
    "// Herramientas del agente: las mismas que usa la aplicación (reexport, sin copias).",
    'export * from "../../src/tools/proveedor.js"',
    "",
  ].join("\n"),
)
console.log("modulo/ generado desde las fuentes de la app")
