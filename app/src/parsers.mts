import * as XLSX from "xlsx"
import { getDocumentProxy } from "unpdf"
import { fechaValida, isoDate } from "./core.mts"

// ── Números ──────────────────────────────────────────────────────────────────

// Formato argentino: 7.400.000 o 7.400.000,50
export function parseArNumber(s: unknown): number | null {
  if (s === null || s === undefined) return null
  let t = String(s).trim().replace(/\$/g, "").replace(/ /g, "").replace(/ /g, "")
  if (!t || t === "-" || t === "—") return null
  t = t.includes(",") ? t.replace(/\./g, "").replace(/,/g, ".") : t.replace(/\./g, "")
  const n = Number(t)
  return t !== "" && Number.isFinite(n) ? n : null
}

// Monto en formato argentino (16.670,54) o inglés (16,670.54), como el que muestra la CCMA:
// el separador seguido de exactamente 2 dígitos al final es el decimal; el otro, de miles.
export function parseMonto(s: string): number | null {
  const t = s.replace(/[^\d.,-]/g, "")
  if (!/\d/.test(t)) return null
  const ultimo = Math.max(t.lastIndexOf(","), t.lastIndexOf("."))
  const n = ultimo >= 0 && t.length - ultimo - 1 === 2
    ? Number(`${t.slice(0, ultimo).replace(/[.,]/g, "")}.${t.slice(ultimo + 1)}`)
    : Number(t.replace(/[.,]/g, ""))
  return Number.isFinite(n) ? n : null
}

export function parseNumPuntos(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const t = String(v).replace(/\./g, "").replace(/,/g, ".").trim()
  const n = Number(t)
  return t !== "" && Number.isFinite(n) ? n : null
}

// pd.to_numeric(..., errors="coerce"): número o null
export function aNumero(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v === "boolean") return v ? 1 : 0
  if (typeof v !== "string") return null
  const t = v.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

// ── Excel ────────────────────────────────────────────────────────────────────

export type Tabla = { columnas: string[]; filas: Record<string, unknown>[] }

// Equivalente a pd.read_excel(..., header=filaEncabezado) sobre la primera hoja.
export function leerExcel(buf: Uint8Array, filaEncabezado = 0): Tabla {
  const wb = XLSX.read(buf, { type: "array" })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const matriz = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, raw: true, blankrows: false })
  const enc = (matriz[filaEncabezado] ?? []) as unknown[]
  const columnas = enc.map((c, j) => (c === null || c === undefined || c === "" ? `Unnamed: ${j}` : String(c).trim()))
  const filas = matriz.slice(filaEncabezado + 1).map((fila) => {
    const obj: Record<string, unknown> = {}
    columnas.forEach((col, j) => {
      obj[col] = (fila as unknown[])[j] ?? null
    })
    return obj
  })
  return { columnas, filas }
}

export function fechaExcel(v: unknown, diaPrimero = true): { y: number; m: number; d: number } | null {
  if (v === null || v === undefined || v === "") return null
  if (typeof v === "number") {
    const p = XLSX.SSF.parse_date_code(v)
    return p && fechaValida(p.y, p.m, p.d) ? { y: p.y, m: p.m, d: p.d } : null
  }
  const s = String(v).trim()
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]]
    return fechaValida(y, mo, d) ? { y, m: mo, d } : null
  }
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/)
  if (m) {
    let y = +m[3]
    if (y < 100) y += y < 69 ? 2000 : 1900
    const [a, b] = [+m[1], +m[2]]
    const [d, mo] = diaPrimero ? [a, b] : [b, a]
    if (fechaValida(y, mo, d)) return { y, m: mo, d }
    if (fechaValida(y, d, mo)) return { y, m: d, d: mo }
  }
  return null
}

export function fechaExcelIso(v: unknown): string | null {
  const f = fechaExcel(v, false)
  return f ? isoDate(f.y, f.m, f.d) : null
}

const buscarColumna = (columnas: string[], nombre: string) =>
  columnas.find((c) => c === nombre) ?? columnas.find((c) => c.trim().toLowerCase() === nombre.toLowerCase())

// Fila del encabezado: la que tiene "Fecha" e "Imp. Total" (en la descarga manual es la 2ª).
function filaEncabezadoComprobantes(buf: Uint8Array): number {
  const wb = XLSX.read(buf, { type: "array", sheetRows: 10 })
  const matriz = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null })
  const i = matriz.findIndex((fila) => {
    const celdas = (fila as unknown[]).map((c) => String(c ?? "").trim().toLowerCase())
    return celdas.includes("fecha") && celdas.includes("imp. total")
  })
  return i >= 0 ? i : 1
}

// Excel de "Mis Comprobantes" de ARCA: suma "Imp. Total" por mes (notas de crédito restan).
export function totalesComprobantesPorMes(buf: Uint8Array) {
  const { columnas, filas } = leerExcel(buf, filaEncabezadoComprobantes(buf))
  const colFecha = buscarColumna(columnas, "Fecha")
  const colTotal = buscarColumna(columnas, "Imp. Total")
  const colTipo = buscarColumna(columnas, "Tipo")
  if (!colFecha) throw new Error("El Excel no tiene la columna 'Fecha'")
  if (!colTotal) throw new Error("El Excel no tiene la columna 'Imp. Total'")
  const totales = new Map<string, { anio: number; mes: number; monto: number }>()
  for (const fila of filas) {
    const f = fechaExcel(fila[colFecha])
    if (!f) continue
    let monto = aNumero(fila[colTotal]) ?? 0
    if (colTipo && /nota de cr/i.test(String(fila[colTipo] ?? ""))) monto = -monto
    const k = `${f.y}-${f.m}`
    const t = totales.get(k) ?? { anio: f.y, mes: f.m, monto: 0 }
    t.monto += monto
    totales.set(k, t)
  }
  return [...totales.values()]
    .map((t) => ({ ...t, monto: Math.round(t.monto * 100) / 100 }))
    .sort((a, b) => a.anio - b.anio || a.mes - b.mes)
}

// ── PDF ──────────────────────────────────────────────────────────────────────

type Pieza = { str: string; x: number; y: number; w: number; h: number }
type Celda = { x0: number; x1: number; texto: string }

async function piezasPorPagina(buf: Uint8Array): Promise<Pieza[][]> {
  // pdf.js transfiere (y deja inutilizable) el buffer que recibe.
  const pdf = await getDocumentProxy(buf.slice())
  const paginas: Pieza[][] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const contenido = await page.getTextContent()
    paginas.push(
      (contenido.items as any[])
        .filter((it) => typeof it.str === "string" && it.str.trim() !== "")
        .map((it) => ({
          str: it.str,
          x: it.transform[4],
          y: it.transform[5],
          w: it.width,
          h: Math.abs(it.transform[3]) || it.height || 10,
        })),
    )
  }
  return paginas
}

function agruparLineas(piezas: Pieza[]): Pieza[][] {
  const ordenadas = [...piezas].sort((a, b) => b.y - a.y || a.x - b.x)
  const lineas: { y: number; piezas: Pieza[] }[] = []
  for (const p of ordenadas) {
    const ultima = lineas[lineas.length - 1]
    if (ultima && Math.abs(ultima.y - p.y) <= Math.max(2, p.h * 0.5)) ultima.piezas.push(p)
    else lineas.push({ y: p.y, piezas: [p] })
  }
  return lineas.map((l) => l.piezas.sort((a, b) => a.x - b.x))
}

// Une piezas cercanas; un hueco mayor a `corte` puntos abre una celda nueva.
function celdas(linea: Pieza[], corte: number): Celda[] {
  const out: Celda[] = []
  for (const p of linea) {
    const prev = out[out.length - 1]
    if (prev && p.x - prev.x1 < corte) {
      prev.texto += p.x - prev.x1 > 2.5 ? " " + p.str : p.str
      prev.x1 = Math.max(prev.x1, p.x + p.w)
    } else {
      out.push({ x0: p.x, x1: p.x + p.w, texto: p.str })
    }
  }
  return out.map((c) => ({ ...c, texto: c.texto.replace(/\s+/g, " ").trim() }))
}

// Equivalente aproximado a pdfplumber extract_text(): una línea de texto por renglón.
export async function pdfTexto(buf: Uint8Array): Promise<string> {
  const paginas = await piezasPorPagina(buf)
  return paginas
    .map((piezas) => agruparLineas(piezas).map((l) => celdas(l, Infinity)[0]?.texto ?? "").join("\n"))
    .join("\n")
}

const esCategoria = (s: string) => /^[A-K]$/.test(s.trim().toUpperCase().split("\n")[0].trim())

// Aproximación a pdfplumber extract_tables() para tablas de categorías A-K:
// las columnas se toman de la primera fila de datos y el encabezado se arma con
// el texto ubicado sobre cada columna.
export async function pdfTablas(buf: Uint8Array): Promise<string[][][]> {
  const paginas = await piezasPorPagina(buf)
  const tablas: string[][][] = []
  for (const piezas of paginas) {
    const lineas = agruparLineas(piezas).map((l) => celdas(l, 8))
    const h = lineas.findIndex((l) => l.some((c) => c.texto.toLowerCase().includes("categor")))
    if (h < 0) continue
    const d = lineas.findIndex((l, i) => i > h && l.length > 0 && esCategoria(l[0].texto))
    if (d < 0) {
      tablas.push([lineas[h].map((c) => c.texto)])
      continue
    }
    const anclas = lineas[d].map((c) => (c.x0 + c.x1) / 2)
    const columna = (c: Celda) => {
      const centro = (c.x0 + c.x1) / 2
      let mejor = 0
      anclas.forEach((a, j) => {
        if (Math.abs(a - centro) < Math.abs(anclas[mejor] - centro)) mejor = j
      })
      return mejor
    }
    const aFila = (linea: Celda[]) => {
      const fila = anclas.map(() => "")
      for (const c of linea) {
        const j = columna(c)
        fila[j] = fila[j] ? `${fila[j]} ${c.texto}` : c.texto
      }
      return fila
    }
    const encabezado = anclas.map(() => "")
    for (const linea of lineas.slice(h, d)) {
      aFila(linea).forEach((t, j) => {
        if (t) encabezado[j] = encabezado[j] ? `${encabezado[j]} ${t}` : t
      })
    }
    tablas.push([encabezado, ...lineas.slice(d).map(aFila)])
  }
  return tablas
}
