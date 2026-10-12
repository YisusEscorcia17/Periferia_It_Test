import { join } from "node:path"
import ExcelJS from "exceljs"
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib"
import { z } from "zod"
import { ETIQUETAS_TRIBUTARIAS_AMBIGUAS, TEXTOS, cargarConfigPortal, type ConfigPortal } from "../config.js"
import { BaseTool, casoSchema, type ToolContext } from "../core/BaseTool.js"
import { PathResolver } from "../core/PathResolver.js"

// Contrato del mapeo (PRD 6.2): cada campo queda en exactamente uno de los tres grupos.
export interface Mapeo {
  pais: string
  llenos: Array<{ etiqueta: string; valor: unknown; fuente: string }>
  faltantes: Array<{ etiqueta: string }>
  requiere_confirmacion: Array<{ etiqueta: string; valor?: unknown; fuente?: string; nota: string }>
}

const MapeoSchema = z.object({
  llenos: z.array(z.object({ etiqueta: z.string(), valor: z.unknown(), fuente: z.string() })),
  faltantes: z.array(z.object({ etiqueta: z.string() })),
  requiere_confirmacion: z.array(z.object({ etiqueta: z.string(), valor: z.unknown().optional(), fuente: z.string().optional(), nota: z.string() })),
})

const SchemaCaso = z.object({ caso: casoSchema })
const SchemaMapear = z.object({
  caso: casoSchema,
  campos: z.array(z.object({ etiqueta: z.string() })).optional().describe("Campos a mapear; si falta se usa la plantilla del caso"),
})
const SchemaGenerar = z.object({
  caso: casoSchema,
  formato: z.string().optional().describe("Formato solicitado; si falta se usa el de la solicitud"),
  mapeo: MapeoSchema.optional().describe("Resultado de proveedor_mapear_campos; si falta se calcula"),
})
const SchemaEnvio = z.object({
  caso: casoSchema,
  confirmado: z.boolean().optional().describe("Debe ser true solo tras confirmación explícita del usuario"),
})

const leerRuta = (obj: Record<string, unknown>, ruta: string): unknown =>
  ruta.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), obj)

const dirCaso = (ctx: ToolContext, config: ConfigPortal, caso: string) => new PathResolver(join(ctx.directory, config.rutas.casos)).caso(caso)

const leerSolicitud = (ctx: ToolContext, dir: string) => JSON.parse(ctx.fs.leer(join(dir, "solicitud.json")))

// HU-1: la plantilla puede ser de campos (pdf/portal) o de celdas (xlsx); ambas traen `etiqueta`.
function leerPlantilla(ctx: ToolContext, dir: string): Array<{ etiqueta: string }> {
  for (const nombre of ["plantilla-campos.json", "plantilla-celdas.json"]) {
    const ruta = join(dir, nombre)
    if (ctx.fs.existe(ruta)) return JSON.parse(ctx.fs.leer(ruta))
  }
  throw new Error("plantilla no encontrada: se esperaba plantilla-campos.json o plantilla-celdas.json")
}

// Clasifica cada campo contra glosario + maestro (RN1, HU-1 y HU-2).
export function mapearCampos(ctx: ToolContext, config: ConfigPortal, caso: string, campos?: Array<{ etiqueta: string }>): Mapeo {
  const dir = dirCaso(ctx, config, caso)
  const { pais } = leerSolicitud(ctx, dir)
  const lista = campos ?? leerPlantilla(ctx, dir)
  const glosario: Record<string, string> = JSON.parse(ctx.fs.leer(join(ctx.directory, config.rutas.glosario)))
  const maestro: Record<string, unknown> = JSON.parse(ctx.fs.leer(join(ctx.directory, config.rutas.repositorio, "maestro.json")))

  const mapeo: Mapeo = { pais, llenos: [], faltantes: [], requiere_confirmacion: [] }
  for (const { etiqueta } of lista) {
    const clave = glosario[etiqueta]
    const valor = clave ? leerRuta(maestro, clave) : undefined
    if (!clave || valor === undefined) {
      mapeo.faltantes.push({ etiqueta })
    } else if (clave === "nit" && pais !== "CO") {
      mapeo.requiere_confirmacion.push({ etiqueta, valor, fuente: clave, nota: TEXTOS.identificadorExtranjero })
    } else if (clave === "nit" && (ETIQUETAS_TRIBUTARIAS_AMBIGUAS as readonly string[]).includes(etiqueta)) {
      mapeo.requiere_confirmacion.push({ etiqueta, valor, fuente: clave, nota: TEXTOS.ambigua })
    } else {
      mapeo.llenos.push({ etiqueta, valor, fuente: clave })
    }
  }
  return mapeo
}

// Lee solicitud, plantilla (campos o celdas) y soportes exigidos de un caso.
export class LeerSolicitud extends BaseTool<typeof SchemaCaso> {
  readonly nombre = "proveedor_leer_solicitud"
  readonly schema = SchemaCaso

  constructor(config: ConfigPortal = cargarConfigPortal()) {
    super(config)
  }

  protected ejecutar(args: z.infer<typeof SchemaCaso>, ctx: ToolContext) {
    const dir = dirCaso(ctx, this.config, args.caso)
    if (!ctx.fs.existe(join(dir, "solicitud.json"))) {
      throw new Error(`caso no encontrado: ${args.caso}`)
    }
    const solicitud = leerSolicitud(ctx, dir)
    const campos = leerPlantilla(ctx, dir)
    const soportes = JSON.parse(ctx.fs.leer(join(dir, "soportes-exigidos.json")))
    return { pais: solicitud.pais, cliente: solicitud.cliente, formato: solicitud.formato, campos, soportes }
  }
}

export class MapearCampos extends BaseTool<typeof SchemaMapear> {
  readonly nombre = "proveedor_mapear_campos"
  readonly schema = SchemaMapear

  constructor(config: ConfigPortal = cargarConfigPortal()) {
    super(config)
  }

  protected ejecutar(args: z.infer<typeof SchemaMapear>, ctx: ToolContext) {
    return mapearCampos(ctx, this.config, args.caso, args.campos)
  }
}

// Valor de celda: los objetos (p.ej. un rango de ingresos) se escriben como texto JSON.
const normalizarValor = (v: unknown): ExcelJS.CellValue => (typeof v === "object" && v !== null ? JSON.stringify(v) : (v as ExcelJS.CellValue))

// HU-3 P0: escribe cada etiqueta y su valor en la hoja y celda que indica plantilla-celdas.json. Sin fechas internas: salida determinista.
async function generarXlsx(ctx: ToolContext, config: ConfigPortal, caso: string, dir: string, mapeo: Omit<Mapeo, "pais">) {
  const celdas: Array<{ hoja: string; celda_etiqueta: string; etiqueta: string; celda_valor: string }> = JSON.parse(ctx.fs.leer(join(dir, "plantilla-celdas.json")))
  const valores = new Map<string, unknown>([...mapeo.llenos, ...mapeo.requiere_confirmacion].map((c) => [c.etiqueta, c.valor]))
  const libro = new ExcelJS.Workbook()
  libro.created = libro.modified = new Date(`${ctx.clock.hoy()}T00:00:00Z`)
  for (const celda of celdas) {
    const hoja = libro.getWorksheet(celda.hoja) ?? libro.addWorksheet(celda.hoja)
    hoja.getCell(celda.celda_etiqueta).value = celda.etiqueta
    if (valores.has(celda.etiqueta)) hoja.getCell(celda.celda_valor).value = normalizarValor(valores.get(celda.etiqueta))
  }
  const ruta = join(ctx.directory, config.rutas.out, caso, "formulario.xlsx")
  ctx.fs.escribirBinario(ruta, new Uint8Array(await libro.xlsx.writeBuffer()))
  return { ruta, formato: "xlsx" }
}

const textoDeValor = (v: unknown): string => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v))

// Parte un texto en líneas que caben en el ancho dado (corte por palabras).
function ajustarALinea(texto: string, fuente: PDFFont, tamano: number, ancho: number): string[] {
  const lineas: string[] = []
  let actual = ""
  for (const palabra of texto.split(" ")) {
    const candidata = actual ? `${actual} ${palabra}` : palabra
    if (fuente.widthOfTextAtSize(candidata, tamano) <= ancho || !actual) {
      actual = candidata
    } else {
      lineas.push(actual)
      actual = palabra
    }
  }
  lineas.push(actual)
  return lineas
}

// HU-3 P1: formulario PDF con etiqueta y valor en el orden de plantilla-campos.json. Fechas fijas: salida determinista.
async function generarPdf(ctx: ToolContext, config: ConfigPortal, caso: string, dir: string, mapeo: Omit<Mapeo, "pais">, cliente: string) {
  const campos: Array<{ etiqueta: string }> = JSON.parse(ctx.fs.leer(join(dir, "plantilla-campos.json")))
  const porEtiqueta = new Map<string, { valor?: unknown; nota?: string }>()
  for (const c of [...mapeo.llenos, ...mapeo.requiere_confirmacion]) porEtiqueta.set(c.etiqueta, { valor: c.valor, nota: "nota" in c ? c.nota : undefined })

  const doc = await PDFDocument.create()
  const fecha = new Date(`${ctx.clock.hoy()}T00:00:00Z`)
  doc.setTitle(`Formulario de registro — ${cliente}`)
  doc.setCreationDate(fecha)
  doc.setModificationDate(fecha)
  const fuente = await doc.embedFont(StandardFonts.Helvetica)
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold)

  const TAMANO = 11
  const ANCHO = 595
  const ALTO = 842
  const MARGEN = 50
  const INTERLINEADO = 16
  const ANCHO_UTIL = ANCHO - 2 * MARGEN

  const bloques: Array<{ texto: string; negrita: boolean }> = [{ texto: `Formulario de registro de proveedor — ${cliente}`, negrita: true }, { texto: "", negrita: false }]
  for (const { etiqueta } of campos) {
    const item = porEtiqueta.get(etiqueta)
    bloques.push({ texto: etiqueta, negrita: true })
    bloques.push({ texto: item?.valor === undefined ? "(pendiente)" : textoDeValor(item.valor), negrita: false })
    if (item?.nota) bloques.push({ texto: `Nota: ${item.nota}`, negrita: false })
    bloques.push({ texto: "", negrita: false })
  }

  let pagina = doc.addPage([ANCHO, ALTO])
  let y = ALTO - MARGEN
  for (const bloque of bloques) {
    const font = bloque.negrita ? negrita : fuente
    for (const linea of ajustarALinea(bloque.texto, font, TAMANO, ANCHO_UTIL)) {
      if (y < MARGEN) {
        pagina = doc.addPage([ANCHO, ALTO])
        y = ALTO - MARGEN
      }
      if (linea) pagina.drawText(linea, { x: MARGEN, y, size: TAMANO, font })
      y -= INTERLINEADO
    }
  }

  const ruta = join(ctx.directory, config.rutas.out, caso, "formulario.pdf")
  ctx.fs.escribirBinario(ruta, await doc.save())
  return { ruta, formato: "pdf" }
}

// Genera valores-portal.md (tabla campo/valor/fuente), formulario.xlsx o formulario.pdf según el formato del caso.
export class GenerarPortal extends BaseTool<typeof SchemaGenerar> {
  readonly nombre = "proveedor_generar_formulario"
  readonly schema = SchemaGenerar

  constructor(config: ConfigPortal = cargarConfigPortal()) {
    super(config)
  }

  protected async ejecutar(args: z.infer<typeof SchemaGenerar>, ctx: ToolContext) {
    const dir = dirCaso(ctx, this.config, args.caso)
    const solicitud = leerSolicitud(ctx, dir)
    const formato = args.formato ?? solicitud.formato
    if (formato === "xlsx") {
      return generarXlsx(ctx, this.config, args.caso, dir, args.mapeo ?? mapearCampos(ctx, this.config, args.caso))
    }
    if (formato === "pdf") {
      return generarPdf(ctx, this.config, args.caso, dir, args.mapeo ?? mapearCampos(ctx, this.config, args.caso), solicitud.cliente)
    }
    if (formato !== "portal") {
      return { formato_no_soporte: true, formato }
    }
    const mapeo = args.mapeo ?? mapearCampos(ctx, this.config, args.caso)

    const filas = [
      ...mapeo.llenos.map((c) => `| ${c.etiqueta} | ${c.valor} | ${c.fuente} |`),
      ...mapeo.requiere_confirmacion.map((c) => `| ${c.etiqueta} | ${c.valor ?? "—"} | requiere confirmación: ${c.nota}${c.fuente ? ` (${c.fuente})` : ""} |`),
      ...mapeo.faltantes.map((c) => `| ${c.etiqueta} | — | faltante |`),
    ]
    const contenido = [`# Valores portal — ${solicitud.cliente}`, "", "| campo | valor | fuente/estado |", "|---|---|---|", ...filas, ""].join("\n")

    const ruta = join(ctx.directory, this.config.rutas.out, args.caso, "valores-portal.md")
    ctx.fs.escribir(ruta, contenido)
    return { ruta, formato }
  }
}

type EstadoSoporte = "presente" | "ausente" | "vencido"
type Soporte = { tipo: string; archivo: string; vigencia_hasta: string | null }

// Arma paquete/: checklist de soportes y campos, copias de los soportes que existen, borrador sin banco.
export class ArmarPaquete extends BaseTool<typeof SchemaCaso> {
  readonly nombre = "proveedor_armar_paquete"
  readonly schema = SchemaCaso

  constructor(config: ConfigPortal = cargarConfigPortal()) {
    super(config)
  }

  protected ejecutar(args: z.infer<typeof SchemaCaso>, ctx: ToolContext) {
    const dir = dirCaso(ctx, this.config, args.caso)
    const solicitud = leerSolicitud(ctx, dir)
    const exigidos: string[] = JSON.parse(ctx.fs.leer(join(dir, "soportes-exigidos.json")))
    const soportesDir = join(ctx.directory, this.config.rutas.repositorio, "soportes")
    const indice: Soporte[] = JSON.parse(ctx.fs.leer(join(soportesDir, "index.json")))
    const hoy = ctx.clock.hoy()
    const salidaDir = join(ctx.directory, this.config.rutas.out, args.caso)
    const paqueteDir = join(salidaDir, "paquete")

    const checklist = exigidos.map((tipo) => {
      const soporte = indice.find((s) => s.tipo === tipo)
      let estado: EstadoSoporte = "ausente"
      if (soporte) estado = soporte.vigencia_hasta && soporte.vigencia_hasta < hoy ? "vencido" : "presente"
      return { tipo, estado, soporte }
    })
    // RN3: solo soportes ausentes o vencidos bloquean; los campos faltantes solo aparecen en el checklist.
    const listo = checklist.every((c) => c.estado === "presente")

    // HU-4: se copian los soportes que existen en el repositorio, también los vencidos.
    for (const { soporte } of checklist) {
      if (soporte && ctx.fs.existe(join(soportesDir, soporte.archivo))) {
        ctx.fs.copiar(join(soportesDir, soporte.archivo), join(paqueteDir, soporte.archivo))
      }
    }
    // El formulario generado (portal o xlsx) viaja en el paquete (HU-4).
    for (const formulario of ["valores-portal.md", "formulario.xlsx", "formulario.pdf"]) {
      const origen = join(salidaDir, formulario)
      if (ctx.fs.existe(origen)) ctx.fs.copiar(origen, join(paqueteDir, formulario))
    }

    const mapeo = mapearCampos(ctx, this.config, args.caso)
    const campos = {
      llenos: mapeo.llenos.length,
      requiere_confirmacion: mapeo.requiere_confirmacion.length,
      faltantes: mapeo.faltantes.map((f) => f.etiqueta),
    }

    const lineasSoportes = checklist.map((c) => `- [${c.estado === "presente" ? "x" : " "}] ${c.tipo}: ${c.estado}`)
    const lineasCampos = [
      `- Llenos: ${campos.llenos}`,
      `- Requieren confirmación: ${campos.requiere_confirmacion}`,
      `- Faltantes: ${campos.faltantes.length}`,
      ...campos.faltantes.map((e) => `  - ${e}`),
    ]
    ctx.fs.escribir(
      join(paqueteDir, "checklist.md"),
      ["# Checklist de soportes", "", ...lineasSoportes, "", "# Campos", "", ...lineasCampos, "", `Listo para firma: ${listo ? "sí" : "no"}`, ""].join("\n"),
    )

    // RN2: el borrador no incluye el bloque bancario del maestro.
    const adjuntos = checklist.filter((c) => c.estado === "presente").map((c) => `- ${c.soporte!.archivo}`)
    ctx.fs.escribir(
      join(paqueteDir, "borrador-correo.md"),
      [
        `Asunto: Alta de proveedor — ${solicitud.cliente}`,
        "",
        `Estimado equipo de ${solicitud.cliente}:`,
        "",
        "Adjuntamos el formulario de alta y los soportes solicitados.",
        "",
        "Adjuntos:",
        ...adjuntos,
        "",
        "Quedamos atentos.",
        "",
      ].join("\n"),
    )

    return { ruta: paqueteDir, listo_para_firma: listo, checklist: checklist.map(({ tipo, estado }) => ({ tipo, estado })), campos }
  }
}

// Simula el envío del paquete. Exige confirmación explícita (RN4) antes de tocar el filesystem.
export class SimularEnvio extends BaseTool<typeof SchemaEnvio> {
  readonly nombre = "proveedor_simular_envio"
  readonly schema = SchemaEnvio

  constructor(config: ConfigPortal = cargarConfigPortal()) {
    super(config)
  }

  protected ejecutar(args: z.infer<typeof SchemaEnvio>, ctx: ToolContext) {
    if (args.confirmado !== true) {
      throw new Error(TEXTOS.envioRequiereConfirmacion)
    }
    const ruta = join(ctx.directory, this.config.rutas.out, args.caso, "ENVIO-SIMULADO.md")
    ctx.fs.escribir(ruta, ["# Envío simulado", "", `Caso: ${args.caso}`, `Fecha: ${ctx.clock.hoy()}`, "", "Simulación local: no se envió ningún correo.", ""].join("\n"))
    return { ruta }
  }
}
