import https from "node:https"
import crypto from "node:crypto"
import forge from "node-forge"
import { getStore } from "@netlify/blobs"
import { env } from "./core.mts"

const WSAA_URL = "https://wsaa.afip.gov.ar/ws/services/LoginCms"
const A5_URL = "https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5"
const A13_URL = "https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA13"

export const cuitContador = () => env("CUIT_CONTADOR", "20395847946")

function normalizarPem(raw: string, etiqueta: string): string {
  const s = raw.replace(/\\n/g, "\n").trim()
  if (!s || s.includes("-----BEGIN")) return s
  const cuerpo = s.replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") ?? ""
  return `-----BEGIN ${etiqueta}-----\n${cuerpo}\n-----END ${etiqueta}-----`
}

export const certPem = () => normalizarPem(env("CERT_CONTENT"), "CERTIFICATE")
export const keyPem = () => normalizarPem(env("KEY_CONTENT"), "PRIVATE KEY")

// AFIP todavía negocia cifrados viejos: equivalente a SECLEVEL=1 + OP_LEGACY_SERVER_CONNECT.
const legacyAgent = new https.Agent({
  ciphers: "DEFAULT:@SECLEVEL=1",
  secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
})

function postSoap(url: string, body: string, timeoutMs = 30000): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "POST",
        agent: legacyAgent,
        timeout: timeoutMs,
        headers: {
          "Content-Type": "text/xml; charset=UTF-8",
          SOAPAction: "",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }))
      },
    )
    req.on("timeout", () => req.destroy(new Error("timeout")))
    req.on("error", reject)
    req.end(body)
  })
}

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")

function tagText(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([^<]*)</(?:[\\w.-]+:)?${tag}>`))
  return m ? unescapeXml(m[1]) : null
}

function crearTra(servicio: string): string {
  const ahora = Date.now()
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "+00:00"
  const uniqueId = Math.floor(Math.random() * 2147483647) + 1
  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${uniqueId}</uniqueId>
    <generationTime>${fmt(ahora - 10 * 60_000)}</generationTime>
    <expirationTime>${fmt(ahora + 12 * 3_600_000)}</expirationTime>
  </header>
  <service>${servicio}</service>
</loginTicketRequest>`
}

function firmarTra(tra: string): string {
  const cert = forge.pki.certificateFromPem(certPem())
  const key = forge.pki.privateKeyFromPem(keyPem())
  const p7 = forge.pkcs7.createSignedData()
  p7.content = forge.util.createBuffer(tra, "utf8")
  p7.addCertificate(cert)
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() as any },
    ],
  })
  p7.sign()
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes())
}

type Ticket = { token: string; sign: string; expira: string }

// WSAA rechaza pedir un ticket nuevo mientras el anterior sigue vigente, y las funciones
// arrancan en frío seguido: el ticket se guarda también en Netlify Blobs.
const memoria = new Map<string, Ticket>()
export const serviciosCacheados = () => [...memoria.keys()]

const vigente = (t: Ticket | null | undefined): t is Ticket => !!t && new Date(t.expira).getTime() > Date.now()

async function obtenerToken(servicio: string): Promise<Ticket> {
  const enMemoria = memoria.get(servicio)
  if (vigente(enMemoria)) return enMemoria

  let store: ReturnType<typeof getStore> | null = null
  try {
    store = getStore("arca-tickets")
    const guardado = (await store.get(servicio, { type: "json" })) as Ticket | null
    if (vigente(guardado)) {
      memoria.set(servicio, guardado)
      return guardado
    }
  } catch {
    store = null
  }

  const cms = firmarTra(crearTra(servicio))
  const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Header/>
  <soapenv:Body>
    <wsaa:loginCms>
      <wsaa:in0>${cms}</wsaa:in0>
    </wsaa:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`
  const r = await postSoap(WSAA_URL, soap)
  if (r.status !== 200) throw new Error(`WSAA error ${r.status}: ${r.text.slice(0, 500)}`)
  const ret = r.text.match(/<(?:[\w.-]+:)?loginCmsReturn[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?loginCmsReturn>/)
  if (!ret) throw new Error(`WSAA sin loginCmsReturn: ${r.text.slice(0, 500)}`)
  const ticketXml = unescapeXml(ret[1])
  const token = tagText(ticketXml, "token")
  const sign = tagText(ticketXml, "sign")
  const expira = tagText(ticketXml, "expirationTime")
  if (!token || !sign || !expira) throw new Error("WSAA devolvió un ticket incompleto")
  const ticket = { token, sign, expira }
  memoria.set(servicio, ticket)
  if (store) await store.setJSON(servicio, ticket).catch(() => {})
  return ticket
}

function soapPersona(ns: string, prefijo: string, auth: Ticket, cuit: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:${prefijo}="${ns}">
  <soapenv:Header/>
  <soapenv:Body>
    <${prefijo}:getPersona>
      <token>${auth.token}</token>
      <sign>${auth.sign}</sign>
      <cuitRepresentada>${cuitContador()}</cuitRepresentada>
      <idPersona>${cuit}</idPersona>
    </${prefijo}:getPersona>
  </soapenv:Body>
</soapenv:Envelope>`
}

export async function buscarEnConstancia(cuit: string) {
  const auth = await obtenerToken("ws_sr_constancia_inscripcion")
  const r = await postSoap(A5_URL, soapPersona("http://a5.soap.ws.server.puc.sr/", "con", auth, cuit))
  const xml = r.text
  const nombre = tagText(xml, "nombre") ?? ""
  const apellido = tagText(xml, "apellido") || tagText(xml, "razonSocial") || ""
  const estado = tagText(xml, "estadoClave") ?? ""
  let categoria = ""
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?([\w.-]*)(?:\s[^>]*)?>([^<]+)</g)) {
    if (!m[1].toLowerCase().includes("categoria")) continue
    const texto = unescapeXml(m[2]).trim()
    if (!texto) continue
    categoria = texto.split(/\s+/)[0].toUpperCase()
    if (/^[A-K]$/.test(categoria)) break
  }
  if (!nombre && !apellido) throw new Error("CUIT no encontrado en constancia")
  return { cuit, nombre, apellido, categoria, estado, fuente: "constancia" }
}

export async function buscarEnPadron(cuit: string) {
  const auth = await obtenerToken("ws_sr_padron_a13")
  const r = await postSoap(A13_URL, soapPersona("http://a13.soap.ws.server.puc.sr/", "a13", auth, cuit))
  const xml = r.text
  const nombre = tagText(xml, "nombre") ?? ""
  const apellido = tagText(xml, "apellido") || tagText(xml, "razonSocial") || ""
  if (!nombre && !apellido) throw new Error("CUIT no encontrado en padron A13")
  return { cuit, nombre, apellido, categoria: "", estado: tagText(xml, "estadoClave") ?? "", fuente: "padron" }
}
