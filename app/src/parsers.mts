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

const columnaQueCoincide = (columnas: string[], re: RegExp) => columnas.find((c) => re.test(c.trim()))

export type Comprobante = { fecha: string; tipo: string; numero: string; contraparte: string; total: number }

// Los n comprobantes más recientes del Excel de "Mis Comprobantes" (emitidos o recibidos).
export function ultimosComprobantes(buf: Uint8Array, n = 3): Comprobante[] {
  const { columnas, filas } = leerExcel(buf, filaEncabezadoComprobantes(buf))
  const colFecha = buscarColumna(columnas, "Fecha")
  const colTotal = buscarColumna(columnas, "Imp. Total")
  if (!colFecha || !colTotal) return []
  const colTipo = buscarColumna(columnas, "Tipo")
  const colPv = columnaQueCoincide(columnas, /^punto de venta$/i)
  const colNro = columnaQueCoincide(columnas, /^n[uú]mero( desde)?$/i)
  const colContra = columnaQueCoincide(columnas, /^denominaci[oó]n (receptor|emisor)$/i)
  const lista: Comprobante[] = []
  for (const fila of filas) {
    const f = fechaExcel(fila[colFecha])
    if (!f) continue
    const pv = colPv ? String(fila[colPv] ?? "").padStart(5, "0") : ""
    const nro = colNro ? String(fila[colNro] ?? "").padStart(8, "0") : ""
    lista.push({
      fecha: isoDate(f.y, f.m, f.d),
      tipo: colTipo ? String(fila[colTipo] ?? "").trim() : "",
      numero: pv && nro ? `${pv}-${nro}` : nro || pv,
      contraparte: colContra ? String(fila[colContra] ?? "").trim() : "",
      total: Math.round((aNumero(fila[colTotal]) ?? 0) * 100) / 100,
    })
  }
  return lista.sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : b.numero.localeCompare(a.numero))).slice(0, n)
}

// ── CCMA: saldo por período ──────────────────────────────────────────────────

const PERIODO = [
  { re: /^(0?[1-9]|1[0-2])\s*[/-]\s*(20\d{2})$/, a: 2, m: 1 },
  { re: /^(20\d{2})\s*[/-]\s*(0?[1-9]|1[0-2])$/, a: 1, m: 2 },
  { re: /^(20\d{2})(0[1-9]|1[0-2])$/, a: 1, m: 2 },
]

function leerPeriodo(celda: string): { anio: number; mes: number } | null {
  const t = celda.trim()
  for (const p of PERIODO) {
    const m = t.match(p.re)
    if (m) return { anio: Number(m[p.a]), mes: Number(m[p.m]) }
  }
  return null
}

// Busca en las tablas de la pantalla una con columna de período y suma el saldo de cada uno
// (puede haber varias filas por período: impositivo, previsional, obra social).
// Devuelve null si ninguna tabla tiene períodos.
export function saldosPorPeriodo(tablas: string[][][]): Map<string, number> | null {
  for (const tabla of tablas) {
    const iEnc = tabla.findIndex((fila) => fila.some((c) => /per[ií]odo/i.test(c)))
    const enc = iEnc >= 0 ? tabla[iEnc].map((c) => c.toLowerCase()) : []
    const colPer = enc.findIndex((c) => /per[ií]odo/.test(c))
    const colMonto = [/saldo/, /deuda/, /total/, /importe/, /debe/]
      .map((re) => enc.findIndex((c) => re.test(c)))
      .find((j) => j >= 0) ?? -1

    const saldos = new Map<string, number>()
    for (const fila of tabla.slice(iEnc + 1)) {
      const per = colPer >= 0 && fila[colPer] ? leerPeriodo(fila[colPer]) : fila.map(leerPeriodo).find(Boolean) ?? null
      if (!per) continue
      const celdaMonto = colMonto >= 0
        ? fila[colMonto]
        : [...fila].reverse().find((c) => /\d/.test(c) && !leerPeriodo(c))
      const monto = celdaMonto ? parseMonto(celdaMonto) : null
      if (monto === null) continue
      const k = `${per.anio}-${per.mes}`
      saldos.set(k, Math.round(((saldos.get(k) ?? 0) + monto) * 100) / 100)
    }
    if (saldos.size) return saldos
  }
  return null
}

export type MesCcma = {
  obligacion: number; pagos: number; intereses: number; saldo: number
  vencimiento: string | null; impuestos: Record<string, number>
}

const redondear = (n: number) => Math.round(n * 100) / 100

function fechaDdmmIso(s: string): string | null {
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  return m && fechaValida(+m[3], +m[2], +m[1]) ? isoDate(+m[3], +m[2], +m[1]) : null
}

// Detalle de la CCMA (Período | Impuesto | Concepto | Subcpto | Descripción | Fecha | Debe | Haber | Saldo):
// por período, obligación del mes, pagos, intereses pendientes y saldo por impuesto (020 impositivo,
// 021 jubilación, 024 obra social). Un saldo entre paréntesis es deuda.
export function movimientosCcma(tablas: string[][][]): Map<string, MesCcma> | null {
  for (const tabla of tablas) {
    const iEnc = tabla.findIndex((f) =>
      f.some((c) => /per[ií]odo/i.test(c)) && f.some((c) => /^debe$/i.test(c.trim())) && f.some((c) => /^saldo$/i.test(c.trim())))
    if (iEnc < 0) continue
    const enc = tabla[iEnc].map((c) => c.trim().toLowerCase())
    const col = (re: RegExp) => enc.findIndex((c) => re.test(c))
    const cPer = col(/per[ií]odo/), cImp = col(/impuesto/), cDesc = col(/descripci/), cFecha = col(/fecha/)
    const cDebe = col(/^debe$/), cHaber = col(/^haber$/), cSaldo = col(/^saldo$/)

    const meses = new Map<string, MesCcma>()
    let impuesto = "?"
    for (const fila of tabla.slice(iEnc + 1)) {
      const per = leerPeriodo(fila[cPer] ?? "")
      if (!per) continue
      const k = `${per.anio}-${per.mes}`
      const m = meses.get(k) ?? { obligacion: 0, pagos: 0, intereses: 0, saldo: 0, vencimiento: null, impuestos: {} }
      const celda = (j: number) => (j >= 0 ? fila[j] ?? "" : "")

      if (fila.some((c) => /^saldo$/i.test(c.trim()))) {
        // Fila de cierre del período para el último impuesto listado.
        const texto = celda(cSaldo) || fila.filter((c) => /\d/.test(c)).at(-1) || ""
        const valor = parseMonto(texto) ?? 0
        const debe = texto.includes("(") ? valor : -valor
        m.saldo += debe
        m.impuestos[impuesto] = redondear((m.impuestos[impuesto] ?? 0) + debe)
      } else {
        if (/^\d{3}$/.test(celda(cImp).trim())) impuesto = celda(cImp).trim()
        const desc = celda(cDesc) || fila.join(" ")
        const debe = parseMonto(celda(cDebe)) ?? 0
        const haber = parseMonto(celda(cHaber)) ?? 0
        if (/^pago/i.test(desc.trim())) {
          if (/inter/i.test(desc)) m.intereses -= haber
          else m.pagos += haber
        } else if (/inter/i.test(desc)) {
          m.intereses += debe - haber
        } else if (/obligaci/i.test(desc)) {
          m.obligacion += debe
          const venc = fechaDdmmIso(celda(cFecha))
          if (venc && (!m.vencimiento || venc < m.vencimiento)) m.vencimiento = venc
        }
      }
      meses.set(k, m)
    }
    if (meses.size) {
      for (const m of meses.values()) {
        m.obligacion = redondear(m.obligacion)
        m.pagos = redondear(m.pagos)
        m.intereses = redondear(Math.max(m.intereses, 0))
        m.saldo = redondear(m.saldo)
      }
      return meses
    }
  }
  return null
}

// ── Mis Facilidades: lista de planes ─────────────────────────────────────────

export type PlanArca = {
  numero: string; tipo: string | null; estado: string | null; situacion: string | null
  consolidacion: string | null; cuotas: number | null; cuotasPagas: number | null
  monto: number | null; proximoVenc: string | null
}

// "Presentaciones Enviadas" (Presentación | Número | Cuotas | Tipo | Consolidado($) | Estado | Situación).
// El Estado es el de la presentación ("Aceptada"); la Situación es la del plan ("Plan Caduco").
// Devuelve [] si está el encabezado pero no hay planes, y null si no encontró la tabla.
export function leerPlanesFacilidades(tablas: string[][][]): PlanArca[] | null {
  let hayEncabezado = false
  for (const tabla of tablas) {
    const esEncabezado = (c: string, re: RegExp) => c.trim().length < 40 && re.test(c)
    const iEnc = tabla.findIndex((f) =>
      f.some((c) => esEncabezado(c, /n[uú]mero|nro|plan/i)) && f.some((c) => esEncabezado(c, /estado|situaci[oó]n/i)))
    if (iEnc < 0) continue
    hayEncabezado = true
    const enc = tabla[iEnc].map((c) => c.trim().toLowerCase())
    const col = (...res: RegExp[]) => {
      for (const re of res) {
        const j = enc.findIndex((c) => re.test(c))
        if (j >= 0) return j
      }
      return -1
    }
    const cNum = col(/n[uú]mero|^nro/, /^plan$/, /plan/)
    const cTipo = col(/tipo|r[eé]gimen|descripci/)
    const cEstado = col(/estado/, /situaci/)
    const cSituacion = enc.findIndex((c, j) => j !== cEstado && /situaci/.test(c))
    const cCons = col(/consolidaci/, /presentaci/, /fecha/)
    const cCuotas = col(/cuotas/)
    const cMonto = col(/deuda|monto|total|importe|consolidado/)
    const cVenc = col(/pr[oó]x.*venc|vencimiento/)
    const celda = (fila: string[], j: number) => (j >= 0 ? (fila[j] ?? "").trim() : "")

    const planes: PlanArca[] = []
    for (const fila of tabla.slice(iEnc + 1)) {
      const numero = celda(fila, cNum)
      if (!/[A-Z0-9]{4,}/i.test(numero)) continue
      const cuotasTxt = celda(fila, cCuotas)
      const pagasDeTotal = cuotasTxt.match(/(\d+)\s*\/\s*(\d+)/)
      planes.push({
        numero,
        tipo: celda(fila, cTipo) || null,
        estado: celda(fila, cEstado) || null,
        situacion: celda(fila, cSituacion) || null,
        consolidacion: fechaDdmmIso(celda(fila, cCons)),
        cuotas: pagasDeTotal ? Number(pagasDeTotal[2]) : /^\d+$/.test(cuotasTxt) ? Number(cuotasTxt) : null,
        cuotasPagas: pagasDeTotal ? Number(pagasDeTotal[1]) : null,
        monto: celda(fila, cMonto) ? parseMonto(celda(fila, cMonto)) : null,
        proximoVenc: fechaDdmmIso(celda(fila, cVenc)),
      })
    }
    if (planes.length) return planes
  }
  return hayEncabezado ? [] : null
}

// ── ART Río Negro: cuenta corriente de Ingresos Brutos ───────────────────────

export type AnticipoArt = {
  periodo: string; concepto: string; vencimiento: string | null; plan: string | null
  impuesto: number; deducciones: number; pagado: number; intereses: number; saldo: number
}

// Grilla "Consulta de Cuenta Corriente de IIBB": Concepto | Posic. Fiscal (2026/9) | Vencimiento |
// Nro. Plan Pago | Impuesto | Deducciones(1) | Impuesto Pagado | … La grilla tiene scroll, así que el
// encabezado puede venir en una tabla aparte: se alinea por la columna de posición fiscal.
// Agrupa por período ("YYYY-MM"), del más reciente al más viejo. null si no está la grilla.
export function leerCuentaCorrienteArt(tablas: string[][][]): AnticipoArt[] | null {
  const esPosicion = (c: string) => /^\d{4}\s*\/\s*\d{1,2}$/.test(c.trim())
  const esFecha = (c: string) => /^\d{2}\/\d{2}\/\d{4}$/.test(c.trim())
  const corto = (c: string) => c.trim().length < 30
  const esEncabezado = (f: string[]) => f.some((c) => corto(c) && /posic/i.test(c)) && f.some((c) => corto(c) && /vencim/i.test(c))

  // La tabla con más filas de datos es la grilla (evita contar dos veces copias del encabezado fijo).
  let filas: string[][] = []
  let enc: string[] | null = null
  for (const t of tablas) {
    const datos = t.filter((f) => f.some(esPosicion) && f.some(esFecha))
    if (datos.length > filas.length) {
      filas = datos
      enc = t.find(esEncabezado) ?? null
    }
  }
  enc ??= tablas.flatMap((t) => t.filter(esEncabezado))[0] ?? null
  if (!filas.length) return enc ? [] : null

  const h = (enc ?? []).map((c) => c.trim().toLowerCase())
  const col = (re: RegExp, excluir?: RegExp) => h.findIndex((c) => re.test(c) && !(excluir && excluir.test(c)))
  const hPos = col(/posic/)
  const cols = {
    concepto: col(/concepto/), venc: col(/vencim/), plan: col(/plan/), impuesto: col(/impuesto/, /pagad/),
    deducciones: col(/deducc/), pagado: col(/pagad/), intereses: col(/inter[eé]s|recargo/), saldo: col(/saldo/),
  }

  const meses = new Map<string, AnticipoArt>()
  for (const fila of filas) {
    const iPos = fila.findIndex(esPosicion)
    const [a, m] = fila[iPos].split("/").map((x) => Number(x.trim()))
    if (!fechaValida(a, m, 1)) continue
    // Con encabezado se alinea por la posición fiscal; sin él, el orden de la grilla.
    const iVenc = fila.findIndex((c, j) => j > iPos && esFecha(c))
    const desplazo = hPos >= 0 ? iPos - hPos : 0
    const en = (j: number, sinEnc: number) => {
      const i = hPos >= 0 ? (j >= 0 ? j + desplazo : -1) : sinEnc
      return i >= 0 ? (fila[i] ?? "").trim() : ""
    }
    const monto = (j: number, sinEnc: number) => parseMonto(en(j, sinEnc)) ?? 0
    const impuesto = monto(cols.impuesto, iVenc + 2)
    const deducciones = monto(cols.deducciones, iVenc + 3)
    const pagado = monto(cols.pagado, iVenc + 4)
    const intereses = monto(cols.intereses, -1)
    const saldoTxt = en(cols.saldo, -1)
    const saldo = saldoTxt ? (parseMonto(saldoTxt) ?? 0) : Math.max(impuesto - deducciones - pagado, 0) + intereses
    const plan = en(cols.plan, iVenc + 1)
    const vencimiento = fechaDdmmIso(en(cols.venc, iVenc))

    const k = `${a}-${String(m).padStart(2, "0")}`
    const p = meses.get(k) ?? { periodo: k, concepto: "", vencimiento: null, plan: null, impuesto: 0, deducciones: 0, pagado: 0, intereses: 0, saldo: 0 }
    const concepto = en(cols.concepto, iPos - 1)
    if (concepto && !p.concepto.includes(concepto)) p.concepto = p.concepto ? `${p.concepto} · ${concepto}` : concepto
    if (vencimiento && (!p.vencimiento || vencimiento < p.vencimiento)) p.vencimiento = vencimiento
    if (plan && !/^0*$/.test(plan)) p.plan ??= plan
    p.impuesto = redondear(p.impuesto + impuesto)
    p.deducciones = redondear(p.deducciones + deducciones)
    p.pagado = redondear(p.pagado + pagado)
    p.intereses = redondear(p.intereses + intereses)
    p.saldo = redondear(p.saldo + saldo)
    meses.set(k, p)
  }
  return [...meses.values()].sort((x, y) => (x.periodo < y.periodo ? 1 : -1))
}

// ── PDF ──────────────────────────────────────────────────────────────────────

type Pieza ={ str: string; x: number; y: number; w: number; h: number }
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
