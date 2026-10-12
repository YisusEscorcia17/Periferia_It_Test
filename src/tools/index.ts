import type { z } from "zod"
import { cargarConfigPortal, type ConfigPortal } from "../config.js"
import type { BaseTool } from "../core/BaseTool.js"
import { FsNode } from "../core/FileSystem.js"
import { ArmarPaquete, GenerarPortal, LeerSolicitud, MapearCampos, SimularEnvio } from "./proveedor.js"
import type { Herramienta, Herramientas } from "./registry.js"

const DESCRIPCIONES: Record<string, string> = {
  proveedor_leer_solicitud: "Lee la solicitud del caso: país, cliente, formato, campos y soportes exigidos.",
  proveedor_mapear_campos: "Clasifica cada campo como lleno (con fuente), faltante o requiere_confirmacion.",
  proveedor_generar_formulario: "Genera valores-portal.md con los valores copiables (solo formato portal).",
  proveedor_armar_paquete: "Arma paquete/ con checklist de soportes, copias y borrador sin datos bancarios.",
  proveedor_simular_envio: "Simula el envío del paquete. Exige confirmación explícita.",
}

// Adapta una BaseTool (contrato {ok,data}|{ok,error}) a la interfaz Herramienta del chat.
export function desdeBaseTool(tool: BaseTool<z.ZodObject<z.ZodRawShape>>, raiz: string, cfg: ConfigPortal): Herramienta {
  const clock = { hoy: () => cfg.fechaReferencia }
  return {
    description: DESCRIPCIONES[tool.nombre] ?? tool.nombre,
    // Frontera de tipos: zod v4 expone el shape como $ZodType; el chat usa la interfaz ZodType.
    args: { ...tool.schema.shape } as Record<string, z.ZodType>,
    async execute(args) {
      return tool.execute(args, { directory: raiz, fs: new FsNode(), clock })
    },
  }
}

// Todas las herramientas del caso PA, ancladas a la raíz del proyecto (donde están fixtures/ y out/).
export function crearHerramientas(raiz: string, cfg: ConfigPortal = cargarConfigPortal()): Herramientas {
  const lista = [new LeerSolicitud(cfg), new MapearCampos(cfg), new GenerarPortal(cfg), new ArmarPaquete(cfg), new SimularEnvio(cfg)]
  return Object.fromEntries(lista.map((t) => [t.nombre, desdeBaseTool(t, raiz, cfg)]))
}
