import { createHash } from "node:crypto"

// Montos del monotributo publicados por ARCA en su página pública de categorías (tabla "Categorías y
// valores del monotributo" + "Valores de aplicación desde el dd/mm/aaaa"). Funciones puras: el superadmin
// las usa para la vista previa y la confirmación, y los tests las prueban con un HTML guardado.

export const URL_CATEGORIAS_ARCA = "https://www.afip.gob.ar/monotributo/categorias.asp"
export const CATEGORIAS = "ABCDEFGHIJK".split("")

export type FilaArca = {
  categoria: string
  tope_anual: number
  imp_integrado_servicios: number
  imp_integrado_bienes: number
  aportes_sipa: number
  obra_social: number
  total_servicios: number
  total_bienes: number
}
type Campo = Exclude<keyof FilaArca, "categoria">

export type MontosArca = { vigente_desde: string | null; filas: FilaArca[]; errores: string[] }

const ENTIDADES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", aacute: "á", eacute: "é", iacute: "í",
  oacute: "ó", uacute: "ú", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
  ntilde: "ñ", Ntilde: "Ñ", uuml: "ü", ordm: "º", deg: "°",
}

function decodificar(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : m
    }
    return ENTIDADES[e] ?? m
  })
}

const texto = (html: string) => decodificar(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim()
const normalizar = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
const atributo = (attrs: string, nombre: string) =>
  decodificar(attrs.match(new RegExp(`${nombre}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"))?.slice(1).find((v) => v !== undefined) ?? "")

// "$12.009.410,45 " → 12009410.45 (formato argentino; ARCA a veces deja espacios o &nbsp;).
export function montoArca(s: string): number | null {
  const t = s.replace(/[$\s]/g, "")
  if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+(,\d{1,2})?$/.test(t)) return null
  return Number(t.replace(/\./g, "").replace(",", "."))
}

// Columna de la tabla según el data-title de la celda (ARCA lo pone en cada <td> para la vista móvil).
function campoPorTitulo(titulo: string): Campo | null {
  const t = normalizar(titulo)
  const bienes = /venta|mueble|bien/.test(t)
  const servicios = /locaci|servicio/.test(t)
  if (/^\s*total/.test(t)) return bienes ? "total_bienes" : servicios ? "total_servicios" : null
  if (/impuesto integrado|imp\.? integrado/.test(t)) return bienes ? "imp_integrado_bienes" : servicios ? "imp_integrado_servicios" : null
  if (/sipa|previsional|jubilac/.test(t)) return "aportes_sipa"
  if (/obra social/.test(t)) return "obra_social"
  if (/ingresos brutos/.test(t)) return "tope_anual"
  return null
}

// Si faltan títulos, por posición: [ingresos, superficie, energía, alquileres, precio unitario,
// imp. servicios, imp. bienes, SIPA, obra social, total servicios, total bienes].
const POR_POSICION_DESDE_EL_FINAL: Campo[] = [
  "imp_integrado_servicios", "imp_integrado_bienes", "aportes_sipa", "obra_social", "total_servicios", "total_bienes",
]

function filasDeTabla(tabla: string): { categoria: string; valores: Partial<Record<Campo, number | null>> }[] {
  const filas = []
  for (const [tr] of tabla.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
    const celdas = [...tr.matchAll(/<(t[hd])\b([^>]*)>([\s\S]*?)<\/\1>/gi)].map((m) => ({ attrs: m[2], txt: texto(m[3]) }))
    const iCat = celdas.findIndex((c) => /^[A-K]$/.test(c.txt))
    if (iCat < 0) continue
    const datos = celdas.slice(iCat + 1)
    const valores: Partial<Record<Campo, number | null>> = {}
    for (const c of datos) {
      const campo = campoPorTitulo(atributo(c.attrs, "data-title"))
      if (campo && !(campo in valores)) valores[campo] = montoArca(c.txt)
    }
    if (Object.keys(valores).length < 7 && datos.length >= 7) {
      if (!("tope_anual" in valores)) valores.tope_anual = montoArca(datos[0].txt)
      const ultimas = datos.slice(-POR_POSICION_DESDE_EL_FINAL.length)
      POR_POSICION_DESDE_EL_FINAL.forEach((campo, i) => {
        if (!(campo in valores)) valores[campo] = montoArca(ultimas[i]?.txt ?? "")
      })
    }
    filas.push({ categoria: celdas[iCat].txt, valores })
  }
  return filas
}

const NOMBRES: Record<Campo, string> = {
  tope_anual: "ingresos brutos", imp_integrado_servicios: "impuesto integrado servicios",
  imp_integrado_bienes: "impuesto integrado bienes", aportes_sipa: "aportes SIPA", obra_social: "obra social",
  total_servicios: "total servicios", total_bienes: "total bienes",
}
const CAMPOS = Object.keys(NOMBRES) as Campo[]
const centavos = (n: number) => Math.round(n * 100)
export const redondear = (n: number) => centavos(n) / 100
const pesos = (n: number) => "$" + n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Valida que estén las 11 categorías una sola vez, con todos los montos, y que cada total sea
// impuesto + SIPA + obra social al centavo. Si algo no cierra, la tabla no se guarda.
export function validarMontos(filas: { categoria: string; valores: Partial<Record<Campo, number | null>> }[]) {
  const errores: string[] = []
  const buenas: FilaArca[] = []
  const vistas = new Set<string>()
  for (const { categoria, valores } of filas) {
    if (vistas.has(categoria)) {
      errores.push(`La categoría ${categoria} aparece más de una vez`)
      continue
    }
    vistas.add(categoria)
    const faltan = CAMPOS.filter((c) => !(typeof valores[c] === "number" && valores[c]! > 0))
    if (faltan.length) {
      errores.push(`Categoría ${categoria}: no se pudo leer ${faltan.map((c) => NOMBRES[c]).join(", ")}`)
      continue
    }
    const f = { categoria, ...valores } as FilaArca
    for (const [tipo, imp, total] of [
      ["servicios", f.imp_integrado_servicios, f.total_servicios],
      ["bienes", f.imp_integrado_bienes, f.total_bienes],
    ] as const) {
      const suma = centavos(imp) + centavos(f.aportes_sipa) + centavos(f.obra_social)
      if (suma !== centavos(total)) {
        errores.push(`Categoría ${categoria} (${tipo}): impuesto + SIPA + obra social = ${pesos(suma / 100)}, pero el total publicado es ${pesos(total)}`)
      }
    }
    buenas.push(f)
  }
  const faltantes = CATEGORIAS.filter((c) => !vistas.has(c))
  if (faltantes.length) errores.push(`Faltan categorías: ${faltantes.join(", ")}`)
  const orden = buenas.sort((a, b) => a.categoria.localeCompare(b.categoria))
  for (let i = 1; i < orden.length; i++) {
    if (orden[i].tope_anual <= orden[i - 1].tope_anual) {
      errores.push(`El tope de la categoría ${orden[i].categoria} no es mayor que el de la ${orden[i - 1].categoria}: revisá la tabla de ARCA`)
    }
  }
  return { filas: orden, errores }
}

// Fecha de "Valores de aplicación desde el 1/08/2026" → "2026-08-01".
function fechaVigencia(html: string): { iso: string; fin: number } | null {
  const m = /Valores\s+de\s+aplicaci\S{1,8}n\s+desde\s+el\s+(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/i.exec(html)
  if (!m) return null
  const [d, mes, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const fecha = new Date(Date.UTC(y, mes - 1, d))
  if (fecha.getUTCMonth() !== mes - 1 || fecha.getUTCDate() !== d) return null
  return { iso: fecha.toISOString().slice(0, 10), fin: m.index + m[0].length }
}

export function leerMontosArca(html: string): MontosArca {
  const limpio = html.replace(/<!--[\s\S]*?-->/g, "")
  const fecha = fechaVigencia(limpio)
  const errores: string[] = []
  if (!fecha) errores.push('No se encontró la fecha "Valores de aplicación desde el dd/mm/aaaa" en la página de ARCA')
  // La tabla de valores: la primera con filas de categorías después de la fecha (o en toda la página).
  const tablas = [...limpio.matchAll(/<table\b[\s\S]*?<\/table>/gi)]
  const candidatas = fecha ? tablas.filter((t) => t.index! >= fecha.fin).concat(tablas.filter((t) => t.index! < fecha.fin)) : tablas
  const tabla = candidatas.map((t) => filasDeTabla(t[0])).find((f) => f.length > 0)
  if (!tabla) {
    errores.push('No se encontró la tabla "Categorías y valores del monotributo" en la página de ARCA')
    return { vigente_desde: fecha?.iso ?? null, filas: [], errores }
  }
  const v = validarMontos(tabla)
  return { vigente_desde: fecha?.iso ?? null, filas: v.filas, errores: [...errores, ...v.errores] }
}

// ── Comparación con lo que hay en topes_categoria ────────────────────────────

export const CAMPOS_TOPES = [
  "tope_anual", "imp_integrado_servicios", "imp_integrado_bienes", "aportes_sipa", "obra_social",
  "cuota_servicios", "cuota_bienes", "vigente_desde",
] as const
type CampoTope = (typeof CAMPOS_TOPES)[number]
export type ValoresTope = Record<CampoTope, number | string | null>

export type FilaPrevia = {
  categoria: string
  actual: ValoresTope | null
  nuevo: ValoresTope & { total_servicios: number; total_bienes: number; componente_rio_negro: number | null }
  cambios: CampoTope[]
}

const igual = (a: unknown, b: unknown) =>
  typeof b === "number" ? a !== null && a !== undefined && a !== "" && centavos(Number(a)) === centavos(b) : String(a ?? "") === String(b ?? "")

// cuota_servicios / cuota_bienes guardan la cuota unificada con Río Negro: total nacional + componente
// provincial de Río Negro de la categoría.
export function compararConTopes(
  montos: { vigente_desde: string; filas: FilaArca[] },
  actuales: Record<string, any>[],
  rioNegro: Record<string, number>,
): { filas: FilaPrevia[]; errores: string[] } {
  const errores: string[] = []
  const porCat = new Map(actuales.map((t) => [String(t.categoria).toUpperCase(), t]))
  const filas = montos.filas.map((f) => {
    const comp = rioNegro[f.categoria] ?? null
    if (!comp) errores.push(`Falta el componente de Río Negro de la categoría ${f.categoria}: cargalo en la grilla de Río Negro antes de confirmar`)
    const nuevo = {
      tope_anual: f.tope_anual,
      imp_integrado_servicios: f.imp_integrado_servicios,
      imp_integrado_bienes: f.imp_integrado_bienes,
      aportes_sipa: f.aportes_sipa,
      obra_social: f.obra_social,
      cuota_servicios: comp ? redondear(f.total_servicios + comp) : null,
      cuota_bienes: comp ? redondear(f.total_bienes + comp) : null,
      vigente_desde: montos.vigente_desde,
      total_servicios: f.total_servicios,
      total_bienes: f.total_bienes,
      componente_rio_negro: comp,
    }
    const t = porCat.get(f.categoria)
    const actual = t ? (Object.fromEntries(CAMPOS_TOPES.map((c) => [c, t[c] === null || t[c] === undefined ? null
      : c === "vigente_desde" ? String(t[c]).slice(0, 10) : Number(t[c])])) as ValoresTope) : null
    const cambios = CAMPOS_TOPES.filter((c) => !actual || !igual(actual[c], nuevo[c]))
    return { categoria: f.categoria, actual, nuevo, cambios }
  })
  return { filas, errores }
}

// Huella de lo que se mostró en la vista previa: "Confirmar" solo guarda si ARCA (y el componente)
// siguen dando exactamente lo mismo.
export function firmaPrevia(vigenteDesde: string | null, filas: FilaPrevia[]): string {
  const datos = filas.map((f) => [f.categoria, ...CAMPOS_TOPES.map((c) => f.nuevo[c])])
  return createHash("sha256").update(JSON.stringify([vigenteDesde, datos])).digest("hex").slice(0, 32)
}
