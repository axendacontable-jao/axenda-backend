import { obtenerToken, postSoap, tagText, unescapeXml } from "./arca.mts"

// Factura electrónica de ARCA (WSFEv1). Se usa el certificado del estudio; cada cliente le delega el
// servicio "Facturación Electrónica" y tiene un punto de venta "Web Services".
const WSFE_URL = "https://servicios1.afip.gov.ar/wsfev1/service.asmx"
const NS = "http://ar.gov.afip.dif.FEV1/"

export const FACTURA_C = 11
export const NOTA_CREDITO_C = 13

export const CONDICIONES_IVA: Record<number, string> = {
  5: "Consumidor Final", 1: "IVA Responsable Inscripto", 6: "Responsable Monotributo", 4: "IVA Sujeto Exento",
  15: "IVA No Alcanzado", 13: "Monotributista Social", 16: "Monotributo Trabajador Independiente Promovido", 7: "Sujeto No Categorizado",
}
export const TIPOS_DOC: Record<number, string> = { 80: "CUIT", 86: "CUIL", 96: "DNI", 99: "Consumidor Final" }
export const CONCEPTOS: Record<number, string> = { 1: "Productos", 2: "Servicios", 3: "Productos y servicios" }

export class ErrorFactura extends Error {}

const etiquetas = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<(?:[\\w.-]+:)?${tag}>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`, "g"))].map((m) => m[1])
const mensajes = (xml: string, tag: "Err" | "Obs") =>
  etiquetas(xml, tag).map((b) => `${tagText(b, "Code") ?? "?"}: ${unescapeXml(tagText(b, "Msg") ?? "")}`)

async function llamar(metodo: string, cuerpo: string, cuit: string, timeoutMs = 45_000): Promise<string> {
  let ticket
  try {
    ticket = await obtenerToken("wsfe")
  } catch (e: any) {
    throw new ErrorFactura(`El certificado del estudio no está autorizado para Facturación Electrónica en ARCA (${String(e?.message ?? e).slice(0, 200)})`)
  }
  const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NS}">
  <soap:Body>
    <ar:${metodo}>
      <ar:Auth><ar:Token>${ticket.token}</ar:Token><ar:Sign>${ticket.sign}</ar:Sign><ar:Cuit>${cuit}</ar:Cuit></ar:Auth>
      ${cuerpo}
    </ar:${metodo}>
  </soap:Body>
</soap:Envelope>`
  const r = await postSoap(WSFE_URL, soap, timeoutMs, `${NS}${metodo}`)
  const fault = tagText(r.text, "faultstring")
  if (fault) throw new ErrorFactura(`ARCA: ${fault}`)
  if (r.status !== 200) throw new ErrorFactura(`ARCA respondió ${r.status}`)
  return r.text
}

export async function ultimoAutorizado(cuit: string, ptoVta: number, tipo: number): Promise<number> {
  const xml = await llamar("FECompUltimoAutorizado", `<ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${tipo}</ar:CbteTipo>`, cuit)
  const errores = mensajes(xml, "Err")
  if (errores.length) throw new ErrorFactura(errores.join(" / "))
  return Number(tagText(xml, "CbteNro") ?? 0)
}

export type PuntoVenta = { numero: number; tipo: string; bloqueado: boolean; baja: string | null }

export async function puntosDeVenta(cuit: string): Promise<PuntoVenta[]> {
  const xml = await llamar("FEParamGetPtosVenta", "", cuit)
  const errores = mensajes(xml, "Err")
  // 602: sin resultados (no tiene puntos de venta de web services).
  if (errores.length && !errores.every((e) => e.startsWith("602"))) throw new ErrorFactura(errores.join(" / "))
  return etiquetas(xml, "PtoVenta").map((b) => ({
    numero: Number(tagText(b, "Nro")), tipo: tagText(b, "EmisionTipo") ?? "",
    bloqueado: tagText(b, "Bloqueado") === "S", baja: (tagText(b, "FchBaja") ?? "").replace(/^NULL$/i, "") || null,
  }))
}

const aArca = (iso: string) => iso.replace(/-/g, "")
const deArca = (f: string | null) => (f && /^\d{8}$/.test(f) ? `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}` : null)

export type SolicitudCae = {
  ptoVta: number; tipo: number; concepto: number; docTipo: number; docNro: number; condicionIva: number
  fecha: string; importe: number; servDesde?: string | null; servHasta?: string | null; vtoPago?: string | null
  asociado?: { tipo: number; ptoVta: number; numero: number; fecha: string } | null
}
export type Autorizado = { numero: number; cae: string; caeVto: string; observaciones: string[] }

export function cuerpoSolicitud(cuit: string, s: SolicitudCae, numero: number) {
  const importe = s.importe.toFixed(2)
  const servicios = s.concepto !== 1
  return `<ar:FeCAEReq>
  <ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>${s.ptoVta}</ar:PtoVta><ar:CbteTipo>${s.tipo}</ar:CbteTipo></ar:FeCabReq>
  <ar:FeDetReq><ar:FECAEDetRequest>
    <ar:Concepto>${s.concepto}</ar:Concepto>
    <ar:DocTipo>${s.docTipo}</ar:DocTipo>
    <ar:DocNro>${s.docNro}</ar:DocNro>
    <ar:CbteDesde>${numero}</ar:CbteDesde>
    <ar:CbteHasta>${numero}</ar:CbteHasta>
    <ar:CbteFch>${aArca(s.fecha)}</ar:CbteFch>
    <ar:ImpTotal>${importe}</ar:ImpTotal>
    <ar:ImpTotConc>0</ar:ImpTotConc>
    <ar:ImpNeto>${importe}</ar:ImpNeto>
    <ar:ImpOpEx>0</ar:ImpOpEx>
    <ar:ImpTrib>0</ar:ImpTrib>
    <ar:ImpIVA>0</ar:ImpIVA>
    ${servicios ? `<ar:FchServDesde>${aArca(s.servDesde!)}</ar:FchServDesde>
    <ar:FchServHasta>${aArca(s.servHasta!)}</ar:FchServHasta>
    <ar:FchVtoPago>${aArca(s.vtoPago!)}</ar:FchVtoPago>` : ""}
    <ar:MonId>PES</ar:MonId>
    <ar:MonCotiz>1</ar:MonCotiz>
    <ar:CondicionIVAReceptorId>${s.condicionIva}</ar:CondicionIVAReceptorId>
    ${s.asociado ? `<ar:CbtesAsoc><ar:CbteAsoc>
      <ar:Tipo>${s.asociado.tipo}</ar:Tipo><ar:PtoVta>${s.asociado.ptoVta}</ar:PtoVta><ar:Nro>${s.asociado.numero}</ar:Nro>
      <ar:Cuit>${cuit}</ar:Cuit><ar:CbteFch>${aArca(s.asociado.fecha)}</ar:CbteFch>
    </ar:CbteAsoc></ar:CbtesAsoc>` : ""}
  </ar:FECAEDetRequest></ar:FeDetReq>
</ar:FeCAEReq>`
}

// Si la respuesta se perdió (corte de red), ARCA puede haber autorizado igual: se consulta ese número
// y se acepta solo si coincide con lo pedido.
async function recuperar(cuit: string, s: SolicitudCae, numero: number): Promise<Autorizado | null> {
  if ((await ultimoAutorizado(cuit, s.ptoVta, s.tipo)) !== numero) return null
  const xml = await llamar("FECompConsultar",
    `<ar:FeCompConsReq><ar:CbteTipo>${s.tipo}</ar:CbteTipo><ar:CbteNro>${numero}</ar:CbteNro><ar:PtoVta>${s.ptoVta}</ar:PtoVta></ar:FeCompConsReq>`, cuit)
  const cae = tagText(xml, "CodAutorizacion") ?? ""
  const coincide = Math.abs(Number(tagText(xml, "ImpTotal") ?? -1) - s.importe) < 0.01 && Number(tagText(xml, "DocNro") ?? -1) === s.docNro
  if (!/^\d{14}$/.test(cae) || !coincide) return null
  return { numero, cae, caeVto: deArca(tagText(xml, "FchVto")) ?? "", observaciones: ["Recuperado después de un corte de comunicación"] }
}

// CAE (si ARCA lo aprobó), vencimiento, errores y observaciones de la respuesta de FECAESolicitar.
export function interpretarRespuestaCae(xml: string) {
  const detalle = etiquetas(xml, "FECAEDetResponse")[0] ?? ""
  const cae = tagText(detalle, "CAE") ?? ""
  const aprobado = /^\d{14}$/.test(cae) && tagText(detalle, "Resultado") !== "R"
  return {
    cae: aprobado ? cae : null, caeVto: deArca(tagText(detalle, "CAEFchVto")),
    errores: mensajes(xml, "Err"), observaciones: mensajes(detalle, "Obs"),
  }
}

// Pide el CAE con el próximo número del punto de venta. Si otra emisión tomó ese número al mismo
// tiempo (error 10016), se reintenta una vez con el siguiente.
export async function solicitarCae(cuit: string, s: SolicitudCae): Promise<Autorizado> {
  for (let intento = 0; intento < 2; intento++) {
    const numero = (await ultimoAutorizado(cuit, s.ptoVta, s.tipo)) + 1
    let xml: string
    try {
      xml = await llamar("FECAESolicitar", cuerpoSolicitud(cuit, s, numero), cuit, 60_000)
    } catch (e) {
      const recuperado = await recuperar(cuit, s, numero).catch(() => null)
      if (recuperado) return recuperado
      throw e
    }
    const r = interpretarRespuestaCae(xml)
    if (r.cae) return { numero, cae: r.cae, caeVto: r.caeVto ?? "", observaciones: r.observaciones }
    if (intento === 0 && r.errores.some((e) => e.startsWith("10016"))) continue
    throw new ErrorFactura(`ARCA rechazó el comprobante: ${[...r.errores, ...r.observaciones].join(" / ") || "sin detalle"}`)
  }
  throw new ErrorFactura("ARCA no autorizó el comprobante")
}
