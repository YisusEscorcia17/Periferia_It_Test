import { basename, join, relative, sep } from "node:path"
import ExcelJS from "exceljs"
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib"
import { z } from "zod"
import { ETIQUETAS_TRIBUTARIAS_AMBIGUAS, MAPA_TRIBUTARIO, TEXTOS, cargarConfigPortal, type ConfigPortal } from "../config.js"
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

// Umbrales de confianza del mapeo (HU-2): >= 0.8 se llena; entre 0.5 y 0.8 se pide confirmación; menos de 0.5 es faltante.
const CONFIANZA_AUTOMATICA = 0.8
const CONFIANZA_MINIMA = 0.5
const STOPWORDS = new Set(["de", "del", "la", "el", "o", "y", "en", "a", "para", "los", "las"])

const leerRuta = (obj: Record<string, unknown>, ruta: string): unknown =>
  ruta.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), obj)

const dirCaso = (ctx: ToolContext, config: ConfigPortal, caso: string) => new PathResolver(join(ctx.directory, config.rutas.casos)).caso(caso)

// Lee un JSON del caso o del repositorio. Si está corrupto, el error nombra el archivo y no muestra la traza del parser.
function leerJson(ctx: ToolContext, ruta: string): ReturnType<typeof JSON.parse> {
  let texto: string
  try {
    texto = ctx.fs.leer(ruta)
  } catch {
    throw new Error(`archivo no se puede leer: ${basename(ruta)}`)
  }
  try {
    return JSON.parse(texto)
  } catch {
    throw new Error(`archivo corrupto: ${basename(ruta)} no se puede leer (JSON inválido)`)
  }
}

const leerSolicitud = (ctx: ToolContext, dir: string) => leerJson(ctx, join(dir, "solicitud.json"))

// HU-1: la plantilla puede ser de campos (pdf/portal) o de celdas (xlsx); ambas traen `etiqueta`.
function leerPlantilla(ctx: ToolContext, dir: string): Array<{ etiqueta: string }> {
  for (const nombre of ["plantilla-campos.json", "plantilla-celdas.json"]) {
    const ruta = join(dir, nombre)
    if (ctx.fs.existe(ruta)) return leerJson(ctx, ruta)
  }
  throw new Error("plantilla no encontrada: se esperaba plantilla-campos.json o plantilla-celdas.json")
}

// Palabras normalizadas de un texto: sin acentos, minúsculas y sin conectores.
const palabras = (texto: string): Set<string> =>
  new Set(
    texto
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((p) => p && !STOPWORDS.has(p)),
  )

// Similitud de Jaccard entre dos etiquetas: 1 si son la misma frase normalizada.
function similitud(a: string, b: string): number {
  const A = palabras(a)
  const B = palabras(b)
  const comunes = [...A].filter((p) => B.has(p)).length
  const total = new Set([...A, ...B]).size
  return total ? comunes / total : 0
}

// HU-2: busca la clave del maestro para una etiqueta y su confianza, con el sinónimo que la originó.
function resolverClave(etiqueta: string, glosario: Record<string, string>): { clave: string; confianza: number; sinonimo: string } | undefined {
  if (glosario[etiqueta]) return { clave: glosario[etiqueta], confianza: 1, sinonimo: etiqueta }
  let mejor: { clave: string; confianza: number; sinonimo: string } | undefined
  for (const [sinonimo, clave] of Object.entries(glosario)) {
    const confianza = similitud(etiqueta, sinonimo)
    if (!mejor || confianza > mejor.confianza) mejor = { clave, confianza, sinonimo }
  }
  return mejor && mejor.confianza >= CONFIANZA_MINIMA ? mejor : undefined
}

// RN1 / HU-1: identificador tributario equivalente en el país del cliente (NIT, RUC o RTN).
const equivalenteTributario = (pais: string): string => MAPA_TRIBUTARIO[pais] ?? "identificador tributario"

// Clasifica cada campo contra glosario + maestro (RN1, HU-1 y HU-2). Nunca inventa valores.
export function mapearCampos(ctx: ToolContext, config: ConfigPortal, caso: string, campos?: Array<{ etiqueta: string }>): Mapeo {
  const dir = dirCaso(ctx, config, caso)
  const { pais } = leerSolicitud(ctx, dir)
  const lista = campos ?? leerPlantilla(ctx, dir)
  const glosario: Record<string, string> = leerJson(ctx, join(ctx.directory, config.rutas.glosario))
  const maestro: Record<string, unknown> = leerJson(ctx, join(ctx.directory, config.rutas.repositorio, "maestro.json"))

  const mapeo: Mapeo = { pais, llenos: [], faltantes: [], requiere_confirmacion: [] }
  for (const { etiqueta } of lista) {
    const resuelta = resolverClave(etiqueta, glosario)
    const valor = resuelta ? leerRuta(maestro, resuelta.clave) : undefined
    if (!resuelta || valor === undefined) {
      mapeo.faltantes.push({ etiqueta })
    } else if (resuelta.confianza < CONFIANZA_AUTOMATICA) {
      const porcentaje = Math.round(resuelta.confianza * 100)
      mapeo.requiere_confirmacion.push({ etiqueta, valor, fuente: resuelta.clave, nota: `sugerencia de ${porcentaje}% de confianza (${resuelta.sinonimo}): confirme que corresponde` })
    } else if (resuelta.clave === "nit" && pais !== "CO") {
      mapeo.requiere_confirmacion.push({ etiqueta, valor, fuente: resuelta.clave, nota: `${TEXTOS.identificadorExtranjero}: equivalente en ${pais} es ${equivalenteTributario(pais)}` })
    } else if (resuelta.clave === "nit" && (ETIQUETAS_TRIBUTARIAS_AMBIGUAS as readonly string[]).includes(etiqueta)) {
      mapeo.requiere_confirmacion.push({ etiqueta, valor, fuente: resuelta.clave, nota: `${TEXTOS.ambigua}: equivalente en ${pais} es ${equivalenteTributario(pais)}` })
    } else {
      mapeo.llenos.push({ etiqueta, valor, fuente: resuelta.clave })
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
    const soportes = leerJson(ctx, join(dir, "soportes-exigidos.json"))
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
  const celdas: Array<{ hoja: string; celda_etiqueta: string; etiqueta: string; celda_valor: string }> = leerJson(ctx, join(dir, "plantilla-celdas.json"))
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
  return { ruta: relativa(ctx, ruta), formato: "xlsx" }
}

// Rutas de salida relativas al proyecto: nunca la ruta absoluta de la máquina o del servidor.
const relativa = (ctx: ToolContext, ruta: string) => relative(ctx.directory, ruta).split(sep).join("/")

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

// Bloques de texto del formulario PDF, en el orden de la plantilla. Faltantes sin valor se marcan "(pendiente)".
function bloquesDelFormulario(campos: Array<{ etiqueta: string }>, mapeo: Omit<Mapeo, "pais">, cliente: string) {
  const porEtiqueta = new Map<string, { valor?: unknown; nota?: string }>()
  for (const c of [...mapeo.llenos, ...mapeo.requiere_confirmacion]) porEtiqueta.set(c.etiqueta, { valor: c.valor, nota: "nota" in c ? c.nota : undefined })
  const bloques: Array<{ texto: string; negrita: boolean }> = [{ texto: `Formulario de registro de proveedor — ${cliente}`, negrita: true }, { texto: "", negrita: false }]
  for (const { etiqueta } of campos) {
    const item = porEtiqueta.get(etiqueta)
    bloques.push({ texto: etiqueta, negrita: true })
    bloques.push({ texto: item?.valor === undefined ? "(pendiente)" : textoDeValor(item.valor), negrita: false })
    if (item?.nota) bloques.push({ texto: `Nota: ${item.nota}`, negrita: false })
    bloques.push({ texto: "", negrita: false })
  }
  return bloques
}

// HU-3 P1: formulario PDF con etiqueta y valor en el orden de plantilla-campos.json. Fechas fijas: salida determinista.
async function generarPdf(ctx: ToolContext, config: ConfigPortal, caso: string, dir: string, mapeo: Omit<Mapeo, "pais">, cliente: string) {
  const campos: Array<{ etiqueta: string }> = leerJson(ctx, join(dir, "plantilla-campos.json"))
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

  let pagina = doc.addPage([ANCHO, ALTO])
  let y = ALTO - MARGEN
  for (const bloque of bloquesDelFormulario(campos, mapeo, cliente)) {
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
  return { ruta: relativa(ctx, ruta), formato: "pdf" }
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
      return { formato_no_soporte: true, formato, aviso: `formato no soportado: «${formato}». Formatos disponibles: Excel (xlsx), PDF y valores para el portal.` }
    }
    // PRD HU-3 P2: el portal no se automatiza; se responde con ese aviso y se entregan los valores copiables.
    return this.generarValoresPortal(ctx, args, solicitud.cliente)
  }

  private generarValoresPortal(ctx: ToolContext, args: z.infer<typeof SchemaGenerar>, cliente: string) {
    const mapeo = args.mapeo ?? mapearCampos(ctx, this.config, args.caso)
    const filas = [
      ...mapeo.llenos.map((c) => `| ${c.etiqueta} | ${c.valor} | ${c.fuente} |`),
      ...mapeo.requiere_confirmacion.map((c) => `| ${c.etiqueta} | ${c.valor ?? "—"} | requiere confirmación: ${c.nota}${c.fuente ? ` (${c.fuente})` : ""} |`),
      ...mapeo.faltantes.map((c) => `| ${c.etiqueta} | — | faltante |`),
    ]
    const contenido = [`# Valores portal — ${cliente}`, "", "| campo | valor | fuente/estado |", "|---|---|---|", ...filas, ""].join("\n")
    const ruta = join(ctx.directory, this.config.rutas.out, args.caso, "valores-portal.md")
    ctx.fs.escribir(ruta, contenido)
    return {
      ruta: relativa(ctx, ruta),
      formato: "portal",
      aviso: "formato no soportado: el portal web no se automatiza. Use los valores de valores-portal.md para copiarlos en el portal.",
    }
  }
}

type EstadoSoporte = "presente" | "ausente" | "vencido"
type Soporte = { tipo: string; archivo: string; vigencia_hasta: string | null }

// RN3: un soporte ausente o vencido bloquea; el resto no. Devuelve el estado de cada soporte exigido.
function estadoDeSoportes(exigidos: string[], indice: Soporte[], hoy: string) {
  return exigidos.map((tipo) => {
    const soporte = indice.find((s) => s.tipo === tipo)
    let estado: EstadoSoporte = "ausente"
    if (soporte) estado = soporte.vigencia_hasta && soporte.vigencia_hasta < hoy ? "vencido" : "presente"
    return { tipo, estado, soporte }
  })
}

// Checklist y borrador del paquete. El borrador nunca incluye datos bancarios (RN2).
function escribirChecklist(ctx: ToolContext, paqueteDir: string, checklist: Array<{ tipo: string; estado: EstadoSoporte }>, campos: { llenos: number; requiere_confirmacion: number; faltantes: string[] }, listo: boolean) {
  const lineasSoportes = checklist.map((c) => `- [${c.estado === "presente" ? "x" : " "}] ${c.tipo}: ${c.estado}`)
  const lineasCampos = [`- Llenos: ${campos.llenos}`, `- Requieren confirmación: ${campos.requiere_confirmacion}`, `- Faltantes: ${campos.faltantes.length}`, ...campos.faltantes.map((e) => `  - ${e}`)]
  ctx.fs.escribir(
    join(paqueteDir, "checklist.md"),
    ["# Checklist de soportes", "", ...lineasSoportes, "", "# Campos", "", ...lineasCampos, "", `Listo para firma: ${listo ? "sí" : "no"}`, ""].join("\n"),
  )
}

function escribirBorrador(ctx: ToolContext, paqueteDir: string, cliente: string, adjuntos: string[]) {
  ctx.fs.escribir(
    join(paqueteDir, "borrador-correo.md"),
    [`Asunto: Alta de proveedor — ${cliente}`, "", `Estimado equipo de ${cliente}:`, "", "Adjuntamos el formulario de alta y los soportes solicitados.", "", "Adjuntos:", ...adjuntos, "", "Quedamos atentos.", ""].join("\n"),
  )
}

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
    const soportesDir = join(ctx.directory, this.config.rutas.repositorio, "soportes")
    const indice: Soporte[] = leerJson(ctx, join(soportesDir, "index.json"))
    const checklist = estadoDeSoportes(leerJson(ctx, join(dir, "soportes-exigidos.json")), indice, ctx.clock.hoy())
    const listo = checklist.every((c) => c.estado === "presente")
    const salidaDir = join(ctx.directory, this.config.rutas.out, args.caso)
    const paqueteDir = join(salidaDir, "paquete")

    // HU-4: se copian los soportes que existen en el repositorio (también los vencidos) y el formulario generado.
    const copias = checklist.flatMap((c) => (c.soporte ? [c.soporte.archivo] : [])).filter((archivo) => ctx.fs.existe(join(soportesDir, archivo)))
    for (const archivo of copias) ctx.fs.copiar(join(soportesDir, archivo), join(paqueteDir, archivo))
    for (const formulario of ["valores-portal.md", "formulario.xlsx", "formulario.pdf"]) {
      const origen = join(salidaDir, formulario)
      if (ctx.fs.existe(origen)) ctx.fs.copiar(origen, join(paqueteDir, formulario))
    }

    const mapeo = mapearCampos(ctx, this.config, args.caso)
    const campos = { llenos: mapeo.llenos.length, requiere_confirmacion: mapeo.requiere_confirmacion.length, faltantes: mapeo.faltantes.map((f) => f.etiqueta) }
    escribirChecklist(ctx, paqueteDir, checklist, campos, listo)
    escribirBorrador(ctx, paqueteDir, solicitud.cliente, checklist.filter((c) => c.estado === "presente").map((c) => `- ${c.soporte!.archivo}`))

    return { ruta: relativa(ctx, paqueteDir), listo_para_firma: listo, checklist: checklist.map(({ tipo, estado }) => ({ tipo, estado })), campos }
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
    return { ruta: relativa(ctx, ruta) }
  }
}
