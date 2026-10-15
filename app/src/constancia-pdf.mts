import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib"
import type { ConstanciaArca } from "./arca.mts"

const AZUL = rgb(0.106, 0.176, 0.31)
const GRIS = rgb(0.42, 0.47, 0.55)

// Las fuentes estándar solo tienen el juego WinAnsi (alcanza para el castellano): lo demás se reemplaza.
const legible = (s: string) => s.replace(/[^\x20-\x7E -ÿ–—‘’“”•€]/g, "?")

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
  return lineas
}

// PDF con los datos de la constancia de inscripción que devuelve ARCA (padrón A5), consultados con
// el certificado del estudio. No reemplaza a la constancia oficial: lo dice el pie del documento.
export async function pdfConstancia(datos: ConstanciaArca, consultadaEl: Date): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const normal = await doc.embedFont(StandardFonts.Helvetica)
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold)
  let pagina: PDFPage = doc.addPage([595.28, 841.89])
  const margen = 56
  const ancho = 595.28 - margen * 2
  let y = 841.89 - margen

  const escribir = (texto: string, { fuente = normal, tam = 10.5, color = rgb(0.1, 0.12, 0.16), sangria = 0, despues = 4 } = {}) => {
    for (const linea of partir(texto, fuente, tam, ancho - sangria)) {
      if (y < margen + 40) {
        pagina = doc.addPage([595.28, 841.89])
        y = 841.89 - margen
      }
      pagina.drawText(linea, { x: margen + sangria, y, size: tam, font: fuente, color })
      y -= tam + 4
    }
    y -= despues
  }
  const campo = (etiqueta: string, valor: string) => {
    if (!valor) return
    escribir(etiqueta.toUpperCase(), { fuente: negrita, tam: 8.5, color: GRIS, despues: 0 })
    escribir(valor, { despues: 8 })
  }

  const cuitFmt = `${datos.cuit.slice(0, 2)}-${datos.cuit.slice(2, 10)}-${datos.cuit.slice(10)}`
  const titular = datos.razonSocial || [datos.apellido, datos.nombre].filter(Boolean).join(", ")
  const fecha = consultadaEl.toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  })

  escribir("Detalle de inscripción", { fuente: negrita, tam: 20, color: AZUL, despues: 2 })
  escribir(`Datos registrados en ARCA · consultados el ${fecha}`, { tam: 9.5, color: GRIS, despues: 14 })
  pagina.drawLine({ start: { x: margen, y: y + 6 }, end: { x: margen + ancho, y: y + 6 }, thickness: 0.8, color: rgb(0.85, 0.88, 0.92) })
  y -= 8

  campo("CUIT", cuitFmt)
  campo("Apellido y nombre / Razón social", titular)
  campo("Estado de la clave", datos.estado)
  campo("Categoría de monotributo", datos.categoriaDescripcion || datos.categoria)
  campo("Actividad", datos.actividad)
  campo("Domicilio fiscal", datos.domicilio)
  if (datos.impuestos.length) campo("Impuestos", datos.impuestos.join(" · "))
  if (datos.actividades.length) campo("Actividades (régimen general)", datos.actividades.join(" · "))
  if (datos.errores.length) {
    escribir("OBSERVACIONES DE ARCA", { fuente: negrita, tam: 8.5, color: rgb(0.75, 0.2, 0.2), despues: 0 })
    for (const e of datos.errores) escribir(`• ${e}`, { sangria: 6, despues: 2 })
    y -= 6
  }

  y = Math.max(y, margen + 60)
  escribir("Este documento resume los datos de inscripción que informa ARCA (servicio de padrón A5), consultados por " +
    "tu estudio contable con su certificado digital. No reemplaza a la constancia oficial, que se obtiene en arca.gob.ar " +
    "(Constancia de inscripción) ingresando el CUIT.", { tam: 8.5, color: GRIS })

  doc.setTitle(`Detalle de inscripción ${cuitFmt}`)
  doc.setProducer("Axenda Contable")
  return doc.save()
}
