import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib"
// Solo el generador de la matriz del QR (sin los renderizadores de PNG ni de terminal).
import QRCode from "qrcode/lib/core/qrcode.js"
import { CONDICIONES_IVA, NOTA_CREDITO_C, TIPOS_DOC } from "./wsfe.mts"

export type ItemFactura = { descripcion: string; cantidad: number; precio: number }

export type DatosFactura = {
  tipo: number; puntoVenta: number; numero: number; fecha: string; concepto: number
  emisor: { nombre: string; cuit: string; domicilio: string; ingresosBrutos: string; inicioActividades: string }
  receptor: { docTipo: number; docNro: number; nombre: string; condicionIva: number; domicilio: string }
  condicionVenta: string; items: ItemFactura[]; importe: number
  servDesde?: string | null; servHasta?: string | null; vtoPago?: string | null
  cae: string; caeVto: string
  asociado?: { puntoVenta: number; numero: number; fecha: string } | null
}

const NEGRO = rgb(0.1, 0.1, 0.12)
const GRIS = rgb(0.4, 0.43, 0.48)
const LINEA = rgb(0.75, 0.77, 0.8)

const legible = (s: string) => s.replace(/[^\x20-\x7E -ÿ–—‘’“”•€]/g, "?")
const fecha = (iso?: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "")
const pesos = (n: number) => n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const cuitFmt = (c: string) => (c.length === 11 ? `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}` : c)
const pad = (n: number, largo: number) => String(n).padStart(largo, "0")

export const numeroComprobante = (puntoVenta: number, numero: number) => `${pad(puntoVenta, 5)}-${pad(numero, 8)}`
export const nombreComprobante = (tipo: number) => (tipo === NOTA_CREDITO_C ? "Nota de Crédito C" : "Factura C")

// Código QR de ARCA (RG 4892): URL con los datos del comprobante en JSON y base64.
export function urlQr(d: DatosFactura) {
  const datos = {
    ver: 1, fecha: d.fecha, cuit: Number(d.emisor.cuit), ptoVta: d.puntoVenta, tipoCmp: d.tipo, nroCmp: d.numero,
    importe: Number(d.importe.toFixed(2)), moneda: "PES", ctz: 1, tipoDocRec: d.receptor.docTipo, nroDocRec: d.receptor.docNro,
    tipoCodAut: "E", codAut: Number(d.cae),
  }
  return `https://www.afip.gob.ar/fe/qr/?p=${Buffer.from(JSON.stringify(datos)).toString("base64")}`
}

function partir(texto: string, fuente: PDFFont, tam: number, ancho: number): string[] {
  const lineas: string[] = []
  let linea = ""
  for (const palabra of legible(texto).split(/\s+/)) {
    const prueba = linea ? `${linea} ${palabra}` : palabra
    if (fuente.widthOfTextAtSize(prueba, tam) > ancho && linea) {
      lineas.push(linea)
      linea = palabra
    } else {
      linea = prueba
    }
  }
  if (linea) lineas.push(linea)
  return lineas.length ? lineas : [""]
}

// Factura C / Nota de Crédito C con los datos que exige ARCA (RG 1415) y el QR (RG 4892).
export async function pdfFactura(d: DatosFactura): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const normal = await doc.embedFont(StandardFonts.Helvetica)
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold)
  const pagina: PDFPage = doc.addPage([595.28, 841.89])
  const M = 36
  const ANCHO = 595.28 - M * 2
  const texto = (t: string, x: number, y: number, { fuente = normal, tam = 9, color = NEGRO } = {}) =>
    pagina.drawText(legible(t), { x, y, size: tam, font: fuente, color })
  const derecha = (t: string, xDer: number, y: number, op: { fuente?: PDFFont; tam?: number } = {}) =>
    texto(t, xDer - (op.fuente ?? normal).widthOfTextAtSize(legible(t), op.tam ?? 9), y, op)
  const caja = (x: number, y: number, w: number, h: number) =>
    pagina.drawRectangle({ x, y, width: w, height: h, borderColor: LINEA, borderWidth: 0.8 })
  const esNota = d.tipo === NOTA_CREDITO_C

  // ── Encabezado: emisor | letra C | comprobante ──
  const altoEnc = 128
  let y = 841.89 - M - altoEnc
  texto("ORIGINAL", M + ANCHO / 2 - negrita.widthOfTextAtSize("ORIGINAL", 9) / 2, 841.89 - M + 6, { fuente: negrita })
  caja(M, y, ANCHO, altoEnc)
  pagina.drawLine({ start: { x: M + ANCHO / 2, y }, end: { x: M + ANCHO / 2, y: y + altoEnc - 44 }, color: LINEA, thickness: 0.8 })
  const cx = M + ANCHO / 2 - 22
  pagina.drawRectangle({ x: cx, y: y + altoEnc - 44, width: 44, height: 44, borderColor: NEGRO, borderWidth: 1, color: rgb(1, 1, 1) })
  texto("C", cx + 22 - negrita.widthOfTextAtSize("C", 26) / 2, y + altoEnc - 30, { fuente: negrita, tam: 26 })
  const codigo = `COD. ${pad(d.tipo, 3)}`
  texto(codigo, cx + 22 - normal.widthOfTextAtSize(codigo, 6.5) / 2, y + altoEnc - 41, { tam: 6.5 })

  let ye = y + altoEnc - 22
  for (const linea of partir(d.emisor.nombre, negrita, 13, ANCHO / 2 - 40).slice(0, 2)) {
    texto(linea, M + 10, ye, { fuente: negrita, tam: 13 })
    ye -= 16
  }
  ye -= 4
  const datoEmisor = (etq: string, val: string) => {
    for (const linea of partir(`${etq}: ${val}`, normal, 8.5, ANCHO / 2 - 30).slice(0, 2)) {
      texto(linea, M + 10, ye, { tam: 8.5 })
      ye -= 11
    }
  }
  datoEmisor("Domicilio comercial", d.emisor.domicilio || "-")
  datoEmisor("Condición frente al IVA", "Responsable Monotributo")

  const xd = M + ANCHO / 2 + 30
  let yd = y + altoEnc - 22
  texto(esNota ? "NOTA DE CRÉDITO" : "FACTURA", xd, yd, { fuente: negrita, tam: 15 })
  yd -= 20
  const datoComp = (etq: string, val: string) => {
    texto(`${etq}:`, xd, yd, { fuente: negrita, tam: 8.5 })
    texto(val, xd + negrita.widthOfTextAtSize(`${etq}: `, 8.5), yd, { tam: 8.5 })
    yd -= 12
  }
  datoComp("Punto de Venta", pad(d.puntoVenta, 5))
  datoComp("Comp. Nro", pad(d.numero, 8))
  datoComp("Fecha de Emisión", fecha(d.fecha))
  datoComp("CUIT", cuitFmt(d.emisor.cuit))
  datoComp("Ingresos Brutos", d.emisor.ingresosBrutos || cuitFmt(d.emisor.cuit))
  datoComp("Fecha de Inicio de Actividades", fecha(d.emisor.inicioActividades) || "-")

  // ── Período facturado (servicios) ──
  y -= 6
  if (d.concepto !== 1) {
    y -= 20
    caja(M, y, ANCHO, 20)
    const per = `Período Facturado Desde: ${fecha(d.servDesde)}    Hasta: ${fecha(d.servHasta)}    Fecha de Vto. para el pago: ${fecha(d.vtoPago)}`
    texto(per, M + 10, y + 7, { tam: 8.5 })
    y -= 6
  }

  // ── Receptor ──
  const altoRec = 52
  y -= altoRec
  caja(M, y, ANCHO, altoRec)
  const docEtq = d.receptor.docTipo === 99 ? "Doc." : TIPOS_DOC[d.receptor.docTipo] ?? "Doc."
  const docVal = d.receptor.docTipo === 99 ? "-" : d.receptor.docTipo === 80 ? cuitFmt(String(d.receptor.docNro)) : String(d.receptor.docNro)
  const fila = (etq: string, val: string, x: number, yy: number, ancho: number) => {
    texto(`${etq}:`, x, yy, { fuente: negrita, tam: 8.5 })
    const x2 = x + negrita.widthOfTextAtSize(`${etq}: `, 8.5)
    texto(partir(val, normal, 8.5, ancho - (x2 - x))[0], x2, yy, { tam: 8.5 })
  }
  fila(docEtq, docVal, M + 10, y + altoRec - 15, ANCHO / 2 - 20)
  fila("Apellido y Nombre / Razón Social", d.receptor.nombre || "Consumidor Final", M + ANCHO / 2 - 40, y + altoRec - 15, ANCHO / 2 + 30)
  fila("Condición frente al IVA", CONDICIONES_IVA[d.receptor.condicionIva] ?? "-", M + 10, y + altoRec - 30, ANCHO / 2 - 20)
  fila("Domicilio", d.receptor.domicilio || "-", M + ANCHO / 2 - 40, y + altoRec - 30, ANCHO / 2 + 30)
  fila("Condición de venta", d.condicionVenta || "Contado", M + 10, y + altoRec - 45, ANCHO / 2 - 20)
  if (d.asociado) {
    fila("Comprobante asociado", `Factura C ${numeroComprobante(d.asociado.puntoVenta, d.asociado.numero)} del ${fecha(d.asociado.fecha)}`,
      M + ANCHO / 2 - 40, y + altoRec - 45, ANCHO / 2 + 30)
  }

  // ── Detalle ──
  y -= 10
  const cols = [M, M + 300, M + 360, M + 450, M + ANCHO]
  const altoCab = 18
  y -= altoCab
  pagina.drawRectangle({ x: M, y, width: ANCHO, height: altoCab, color: rgb(0.92, 0.93, 0.95) })
  texto("Producto / Servicio", cols[0] + 6, y + 6, { fuente: negrita, tam: 8.5 })
  derecha("Cantidad", cols[2] - 6, y + 6, { fuente: negrita, tam: 8.5 })
  derecha("Precio Unit.", cols[3] - 6, y + 6, { fuente: negrita, tam: 8.5 })
  derecha("Subtotal", cols[4] - 6, y + 6, { fuente: negrita, tam: 8.5 })
  for (const item of d.items) {
    const lineas = partir(item.descripcion, normal, 8.5, cols[1] - cols[0] + 40)
    y -= 14
    texto(lineas[0], cols[0] + 6, y, { tam: 8.5 })
    derecha(item.cantidad.toLocaleString("es-AR", { maximumFractionDigits: 2 }), cols[2] - 6, y, { tam: 8.5 })
    derecha(pesos(item.precio), cols[3] - 6, y, { tam: 8.5 })
    derecha(pesos(item.cantidad * item.precio), cols[4] - 6, y, { tam: 8.5 })
    for (const extra of lineas.slice(1, 4)) {
      y -= 11
      texto(extra, cols[0] + 6, y, { tam: 8.5 })
    }
  }

  // ── Totales y autorización (al pie) ──
  const yPie = M + 150
  caja(M, yPie, ANCHO, 56)
  derecha("Subtotal: $", M + ANCHO - 120, yPie + 38, { fuente: negrita, tam: 9 })
  derecha(pesos(d.importe), M + ANCHO - 10, yPie + 38, { tam: 9 })
  derecha("Importe Otros Tributos: $", M + ANCHO - 120, yPie + 24, { fuente: negrita, tam: 9 })
  derecha("0,00", M + ANCHO - 10, yPie + 24, { tam: 9 })
  derecha("Importe Total: $", M + ANCHO - 120, yPie + 8, { fuente: negrita, tam: 10 })
  derecha(pesos(d.importe), M + ANCHO - 10, yPie + 8, { fuente: negrita, tam: 10 })

  const qr = QRCode.create(urlQr(d), { errorCorrectionLevel: "M" })
  const n: number = qr.modules.size
  const lado = 96
  const modulo = lado / n
  const qx = M
  const qy = M + 20
  for (let fila = 0; fila < n; fila++) {
    for (let col = 0; col < n; col++) {
      if (!qr.modules.get(fila, col)) continue
      pagina.drawRectangle({ x: qx + col * modulo, y: qy + lado - (fila + 1) * modulo, width: modulo + 0.05, height: modulo + 0.05, color: NEGRO })
    }
  }
  texto("Comprobante Autorizado", qx + lado + 14, qy + 62, { fuente: negrita, tam: 10 })
  texto("Esta Agencia no se responsabiliza por los datos ingresados en el detalle de la operación", qx + lado + 14, qy + 46, { tam: 7, color: GRIS })
  derecha(`CAE N°: ${d.cae}`, M + ANCHO, qy + 90, { fuente: negrita, tam: 9 })
  derecha(`Fecha de Vto. de CAE: ${fecha(d.caeVto)}`, M + ANCHO, qy + 76, { fuente: negrita, tam: 9 })
  texto("ARCA", qx + lado + 14, qy + 20, { fuente: negrita, tam: 14, color: rgb(0.12, 0.29, 0.53) })

  doc.setTitle(`${nombreComprobante(d.tipo)} ${numeroComprobante(d.puntoVenta, d.numero)}`)
  doc.setProducer("Axenda Contable")
  return doc.save()
}

