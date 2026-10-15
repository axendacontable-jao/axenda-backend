import { randomUUID } from "node:crypto"
import { HttpError, clientePorSlug, db, getEstudioId, hoyArgentina, isoDate, logActividad, q } from "./core.mts"
import { constanciaCompleta } from "./arca.mts"
import { exigirSesionPortal } from "./secretos.mts"
import { type DatosFactura, type ItemFactura, nombreComprobante, numeroComprobante, pdfFactura } from "./factura-pdf.mts"
import {
  CONCEPTOS, CONDICIONES_IVA, ErrorFactura, FACTURA_C, NOTA_CREDITO_C, TIPOS_DOC, puntosDeVenta, solicitarCae, ultimoAutorizado,
} from "./wsfe.mts"

type Ctx = { req: Request; p: Record<string, string>; query: URLSearchParams }

const BUCKET_DOCS = "documentos-axenda"
const CONDICIONES_VENTA = ["Contado", "Transferencia", "Tarjeta de débito", "Tarjeta de crédito", "Cuenta corriente", "Otra"]
const COLS_CLIENTE = "id,cuit,nombre,apellido,estudio_id,fe_habilitada,fe_punto_venta,fe_domicilio,fe_ingresos_brutos,fe_inicio_actividades"
const MAX_POR_DIA_CLIENTE = 20

const redondear = (n: number) => Math.round(n * 100) / 100
const esIso = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
const diasEntre = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)
const hoyAr = () => { const t = hoyArgentina(); return isoDate(t.y, t.m, t.d) }

async function cuerpo(req: Request): Promise<Record<string, any>> {
  try {
    const d = await req.json()
    if (d && typeof d === "object") return d
  } catch {
    // cae abajo
  }
  throw new HttpError(400, "Pedido inválido")
}

// Configuración de facturación del cliente: lista para emitir si está habilitado y tiene punto de
// venta, domicilio comercial y fecha de inicio de actividades (datos obligatorios del comprobante).
const configDe = (c: any) => ({
  habilitada: !!c.fe_habilitada, punto_venta: c.fe_punto_venta ?? null, domicilio: c.fe_domicilio ?? "",
  ingresos_brutos: c.fe_ingresos_brutos ?? "", inicio_actividades: c.fe_inicio_actividades ?? null,
  lista: !!(c.fe_habilitada && c.fe_punto_venta && c.fe_domicilio && c.fe_inicio_actividades),
})

async function estudioHabilitado(estudioId: string) {
  const e = await q(db().from("estudios").select("facturacion_electronica_habilitada").eq("id", estudioId).maybeSingle()).catch(() => null)
  return !!e?.facturacion_electronica_habilitada
}

export async function facturacionDisponible(cliente: any) {
  return configDe(cliente).lista && (await estudioHabilitado(cliente.estudio_id))
}

const resumen = (c: any) => ({
  id: c.id, tipo: c.tipo, nombre: `${nombreComprobante(c.tipo)} ${numeroComprobante(c.punto_venta, c.numero)}`,
  fecha: c.fecha, importe: Number(c.importe), receptor: c.receptor_nombre, cae: c.cae, cae_vto: c.cae_vto,
  url_pdf: c.url_pdf, emitido_por: c.emitido_por, anulado: !!c.anulado_por, asociado_id: c.asociado_id,
})

async function comprobantesDe(clienteId: string, limite: number) {
  return ((await q(db().from("comprobantes_emitidos").select("*").eq("cliente_id", clienteId)
    .order("created_at", { ascending: false }).limit(limite))) ?? []).map(resumen)
}

type Solicitud = {
  concepto: number; docTipo: number; docNro: number; condicionIva: number; receptorNombre: string; receptorDomicilio: string
  condicionVenta: string; items: ItemFactura[]; importe: number; fecha: string
  servDesde: string | null; servHasta: string | null; vtoPago: string | null; clave: string | null
}

// Valida el formulario de emisión (ARCA vuelve a validar todo; esto da mensajes claros antes).
export function leerSolicitud(d: Record<string, any>): Solicitud {
  const concepto = Number(d.concepto)
  if (!CONCEPTOS[concepto]) throw new HttpError(400, "Elegí si facturás productos, servicios o ambos")
  const docTipo = Number(d.doc_tipo ?? 99)
  if (!TIPOS_DOC[docTipo]) throw new HttpError(400, "Tipo de documento del receptor inválido")
  const docNro = docTipo === 99 ? 0 : Number(String(d.doc_nro ?? "").replace(/\D/g, ""))
  if (docTipo === 80 || docTipo === 86) {
    if (String(docNro).length !== 11) throw new HttpError(400, "El CUIT/CUIL del receptor tiene que tener 11 dígitos")
  } else if (docTipo === 96 && (docNro < 1_000_000 || docNro > 99_999_999)) {
    throw new HttpError(400, "DNI del receptor inválido")
  }
  const condicionIva = Number(d.condicion_iva ?? 5)
  if (!CONDICIONES_IVA[condicionIva]) throw new HttpError(400, "Condición frente al IVA del receptor inválida")
  if (docTipo === 99 && condicionIva !== 5) throw new HttpError(400, "Sin documento, el receptor solo puede ser Consumidor Final")
  const receptorNombre = String(d.receptor_nombre ?? "").trim().slice(0, 120)
  if (docTipo !== 99 && !receptorNombre) throw new HttpError(400, "Completá el nombre o razón social del receptor")
  const condicionVenta = CONDICIONES_VENTA.includes(d.condicion_venta) ? d.condicion_venta : "Contado"

  if (!Array.isArray(d.items) || !d.items.length || d.items.length > 12) throw new HttpError(400, "Cargá entre 1 y 12 renglones")
  const items: ItemFactura[] = d.items.map((it: any) => {
    const descripcion = String(it?.descripcion ?? "").trim().slice(0, 200)
    const cantidad = Number(it?.cantidad)
    const precio = Number(it?.precio)
    if (!descripcion) throw new HttpError(400, "Cada renglón necesita una descripción")
    if (!(cantidad > 0 && cantidad <= 1_000_000)) throw new HttpError(400, `Cantidad inválida en "${descripcion}"`)
    if (!(precio > 0 && precio <= 10_000_000_000)) throw new HttpError(400, `Precio inválido en "${descripcion}"`)
    return { descripcion, cantidad, precio: redondear(precio) }
  })
  const importe = redondear(items.reduce((s, it) => s + it.cantidad * it.precio, 0))
  if (!(importe > 0)) throw new HttpError(400, "El importe tiene que ser mayor a cero")

  const hoy = hoyAr()
  const fecha = esIso(d.fecha) ? d.fecha : hoy
  const margen = concepto === 1 ? 5 : 10
  if (Math.abs(diasEntre(hoy, fecha)) > margen) {
    throw new HttpError(400, `La fecha de emisión puede estar hasta ${margen} días antes o después de hoy`)
  }
  let servDesde: string | null = null, servHasta: string | null = null, vtoPago: string | null = null
  if (concepto !== 1) {
    if (!esIso(d.serv_desde) || !esIso(d.serv_hasta)) throw new HttpError(400, "Completá el período facturado (desde y hasta)")
    if (d.serv_desde > d.serv_hasta) throw new HttpError(400, "El período facturado empieza después de terminar")
    servDesde = d.serv_desde
    servHasta = d.serv_hasta
    vtoPago = esIso(d.vto_pago) ? d.vto_pago : fecha
    if (vtoPago < fecha) throw new HttpError(400, "El vencimiento del pago no puede ser anterior a la fecha de emisión")
  }
  const clave = typeof d.clave_idempotencia === "string" && /^[\w-]{8,64}$/.test(d.clave_idempotencia) ? d.clave_idempotencia : null
  return {
    concepto, docTipo, docNro, condicionIva, receptorNombre: docTipo === 99 && !receptorNombre ? "Consumidor Final" : receptorNombre,
    receptorDomicilio: String(d.receptor_domicilio ?? "").trim().slice(0, 160), condicionVenta, items, importe, fecha,
    servDesde, servHasta, vtoPago, clave,
  }
}

// Suma (o resta, si es nota de crédito) el comprobante en la facturación del mes. La próxima
// importación o sincronización con ARCA reemplaza el total del mes con el dato oficial.
async function sumarEnFacturacion(cliente: any, fecha: string, importe: number) {
  const anio = Number(fecha.slice(0, 4))
  const mes = Number(fecha.slice(5, 7))
  const actual = await q(db().from("facturacion").select("monto").eq("cliente_id", cliente.id).eq("anio", anio).eq("mes", mes).maybeSingle())
  const monto = redondear(Math.max((Number(actual?.monto) || 0) + importe, 0))
  await q(db().from("facturacion").upsert(
    { cliente_id: cliente.id, estudio_id: cliente.estudio_id, anio, mes, monto },
    { onConflict: "cliente_id,anio,mes" },
  ))
}

type Asociado = { id: string; puntoVenta: number; numero: number; fecha: string }

async function emitir(cliente: any, s: Solicitud, tipo: number, emitidoPor: "cliente" | "contador", asociado: Asociado | null = null) {
  const config = configDe(cliente)
  if (!config.lista) throw new HttpError(409, "La facturación electrónica no está configurada para este cliente")
  if (s.clave) {
    const previo = await q(db().from("comprobantes_emitidos").select("*").eq("clave_idempotencia", s.clave).maybeSingle())
    if (previo) {
      if (previo.cliente_id !== cliente.id) throw new HttpError(409, "Pedido duplicado")
      return { ok: true, comprobante: resumen(previo), repetido: true }
    }
  }

  let autorizado
  try {
    autorizado = await solicitarCae(cliente.cuit, {
      ptoVta: config.punto_venta, tipo, concepto: s.concepto, docTipo: s.docTipo, docNro: s.docNro, condicionIva: s.condicionIva,
      fecha: s.fecha, importe: s.importe, servDesde: s.servDesde, servHasta: s.servHasta, vtoPago: s.vtoPago,
      asociado: asociado ? { tipo: FACTURA_C, ptoVta: asociado.puntoVenta, numero: asociado.numero, fecha: asociado.fecha } : null,
    })
  } catch (e: any) {
    if (e instanceof ErrorFactura) throw new HttpError(422, e.message)
    throw new HttpError(503, `No se pudo comunicar con ARCA: ${String(e?.message ?? e).slice(0, 200)}`)
  }

  const nombre = `${nombreComprobante(tipo)} ${numeroComprobante(config.punto_venta, autorizado.numero)}`
  const fila: Record<string, unknown> = {
    cliente_id: cliente.id, estudio_id: cliente.estudio_id, tipo, punto_venta: config.punto_venta, numero: autorizado.numero,
    fecha: s.fecha, concepto: s.concepto, doc_tipo: s.docTipo, doc_nro: s.docNro, receptor_nombre: s.receptorNombre,
    receptor_condicion_iva: s.condicionIva, receptor_domicilio: s.receptorDomicilio || null, condicion_venta: s.condicionVenta,
    items: s.items, importe: s.importe, fch_serv_desde: s.servDesde, fch_serv_hasta: s.servHasta, fch_vto_pago: s.vtoPago,
    cae: autorizado.cae, cae_vto: autorizado.caeVto, asociado_id: asociado?.id ?? null, emitido_por: emitidoPor,
    clave_idempotencia: s.clave, observaciones: autorizado.observaciones.join(" / ") || null,
  }
  // El CAE ya es válido ante ARCA: aunque falle algo de acá en adelante, queda registrado.
  await logActividad(cliente.id, `${nombre} autorizada por ARCA (CAE ${autorizado.cae}) por $${s.importe.toLocaleString("es-AR")} · emitida por ${emitidoPor === "cliente" ? "el cliente" : "el contador"}`, cliente.estudio_id)

  const datos: DatosFactura = {
    tipo, puntoVenta: config.punto_venta, numero: autorizado.numero, fecha: s.fecha, concepto: s.concepto,
    emisor: {
      nombre: [cliente.apellido, cliente.nombre].filter(Boolean).join(" "), cuit: cliente.cuit, domicilio: config.domicilio,
      ingresosBrutos: config.ingresos_brutos, inicioActividades: config.inicio_actividades,
    },
    receptor: { docTipo: s.docTipo, docNro: s.docNro, nombre: s.receptorNombre, condicionIva: s.condicionIva, domicilio: s.receptorDomicilio },
    condicionVenta: s.condicionVenta, items: s.items, importe: s.importe, servDesde: s.servDesde, servHasta: s.servHasta,
    vtoPago: s.vtoPago, cae: autorizado.cae, caeVto: autorizado.caeVto,
    asociado: asociado ? { puntoVenta: asociado.puntoVenta, numero: asociado.numero, fecha: asociado.fecha } : null,
  }
  const avisos: string[] = []
  try {
    const pdf = await pdfFactura(datos)
    const ruta = `${cliente.id}/comprobantes/${config.punto_venta}-${tipo}-${autorizado.numero}-${randomUUID().slice(0, 8)}.pdf`
    const storage = db().storage.from(BUCKET_DOCS)
    const { error } = await storage.upload(ruta, pdf, { contentType: "application/pdf" })
    if (error) throw error
    fila.url_pdf = storage.getPublicUrl(ruta).data.publicUrl
    await q(db().from("documentos").insert({
      cliente_id: cliente.id, estudio_id: cliente.estudio_id, tipo: "comprobante", nombre, fecha: s.fecha,
      url: fila.url_pdf, generado_auto: true,
    }))
  } catch (e: any) {
    avisos.push(`No se pudo guardar el PDF (${String(e?.message ?? e).slice(0, 120)}); el comprobante es válido igual.`)
  }

  const guardado = await q(db().from("comprobantes_emitidos").insert(fila).select().single()).catch((e: any) => {
    avisos.push(`No se pudo registrar en la base (${String(e?.message ?? e).slice(0, 120)}). CAE ${autorizado.cae}.`)
    return { ...fila, id: null, created_at: new Date().toISOString() }
  })
  if (asociado && guardado.id) await q(db().from("comprobantes_emitidos").update({ anulado_por: guardado.id }).eq("id", asociado.id)).catch(() => {})
  await sumarEnFacturacion(cliente, s.fecha, tipo === NOTA_CREDITO_C ? -s.importe : s.importe).catch(() => {
    avisos.push("No se pudo sumar en la facturación del mes.")
  })
  if (emitidoPor === "cliente") {
    await q(db().from("alertas").insert({
      cliente_id: cliente.id, estudio_id: cliente.estudio_id, tipo: "factura", icono: "🧾", leida: false,
      titulo: `${[cliente.apellido, cliente.nombre].filter(Boolean).join(" ")} emitió la ${nombre}`,
      descripcion: `Por $${s.importe.toLocaleString("es-AR", { minimumFractionDigits: 2 })} a ${s.receptorNombre}. CAE ${autorizado.cae}.`,
    })).catch(() => {})
  }
  return { ok: true, comprobante: resumen(guardado), avisos }
}

async function datosReceptor(cuit: string) {
  const c = await constanciaCompleta(cuit)
  return {
    nombre: c.razonSocial || [c.apellido, c.nombre].filter(Boolean).join(" "),
    domicilio: c.domicilio,
    // Monotributista si ARCA informa categoría; si no, se elige a mano.
    condicion_iva: c.categoria ? 6 : null,
    estado: c.estado,
  }
}

const opciones = () => ({
  condiciones_iva: CONDICIONES_IVA, tipos_doc: TIPOS_DOC, conceptos: CONCEPTOS, condiciones_venta: CONDICIONES_VENTA,
})

// ── Admin ────────────────────────────────────────────────────────────────────

export async function feEstado({ req, p }: Ctx) {
  const estudioId = await getEstudioId(req)
  const cliente = await clientePorSlug(p.slug, estudioId, COLS_CLIENTE)
  return {
    estudio_habilitado: await estudioHabilitado(estudioId), config: configDe(cliente),
    comprobantes: await comprobantesDe(cliente.id, 50), ...opciones(),
  }
}

export async function feGuardarConfig({ req, p }: Ctx) {
  const estudioId = await getEstudioId(req)
  const cliente = await clientePorSlug(p.slug, estudioId)
  const d = await cuerpo(req)
  const cambios: Record<string, unknown> = {}
  if ("habilitada" in d) cambios.fe_habilitada = !!d.habilitada
  if ("punto_venta" in d) {
    const pv = d.punto_venta === null || d.punto_venta === "" ? null : Number(d.punto_venta)
    if (pv !== null && !(Number.isInteger(pv) && pv >= 1 && pv <= 99998)) throw new HttpError(400, "Punto de venta inválido")
    cambios.fe_punto_venta = pv
  }
  if ("domicilio" in d) cambios.fe_domicilio = String(d.domicilio ?? "").trim().slice(0, 160) || null
  if ("ingresos_brutos" in d) cambios.fe_ingresos_brutos = String(d.ingresos_brutos ?? "").trim().slice(0, 40) || null
  if ("inicio_actividades" in d) {
    if (d.inicio_actividades && !esIso(d.inicio_actividades)) throw new HttpError(400, "Fecha de inicio de actividades inválida")
    cambios.fe_inicio_actividades = d.inicio_actividades || null
  }
  if (!Object.keys(cambios).length) throw new HttpError(400, "Sin cambios")
  await q(db().from("clientes").update(cambios).eq("id", cliente.id))
  return { ok: true }
}

// Prueba de conexión (solo consultas): certificado autorizado, delegación del cliente y punto de venta.
export async function feProbar({ req, p }: Ctx) {
  const estudioId = await getEstudioId(req)
  const cliente = await clientePorSlug(p.slug, estudioId, COLS_CLIENTE)
  let puntos
  try {
    puntos = await puntosDeVenta(cliente.cuit)
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    const sinDelegacion = /relacion|representad|no autorizado|600|ValidacionDeToken/i.test(msg)
    return {
      ok: false, paso: sinDelegacion ? "delegacion" : "certificado",
      mensaje: sinDelegacion
        ? `ARCA no deja facturar por este cliente con el certificado del estudio: falta que el cliente delegue "Facturación Electrónica" (${msg.slice(0, 160)})`
        : msg.slice(0, 300),
    }
  }
  const pv = cliente.fe_punto_venta
  const elegido = puntos.find((x) => x.numero === pv)
  if (!pv) return { ok: false, paso: "punto_venta", mensaje: "Elegí el punto de venta de Web Services", puntos }
  if (!elegido) {
    return { ok: false, paso: "punto_venta", mensaje: `El punto de venta ${pv} no es de Web Services para este CUIT. Puntos habilitados: ${puntos.map((x) => x.numero).join(", ") || "ninguno"}`, puntos }
  }
  if (elegido.bloqueado || elegido.baja) return { ok: false, paso: "punto_venta", mensaje: `El punto de venta ${pv} está bloqueado o dado de baja`, puntos }
  const ultimo = await ultimoAutorizado(cliente.cuit, pv, FACTURA_C).catch(() => null)
  return {
    ok: true, puntos, ultimo_numero: ultimo,
    mensaje: `Todo listo: punto de venta ${pv}, última Factura C N° ${ultimo ?? 0}. La próxima será la ${numeroComprobante(pv, (ultimo ?? 0) + 1)}.`,
  }
}

export async function feEmitirAdmin({ req, p }: Ctx) {
  const estudioId = await getEstudioId(req)
  const cliente = await clientePorSlug(p.slug, estudioId, COLS_CLIENTE)
  if (!(await estudioHabilitado(estudioId))) throw new HttpError(409, "Activá la facturación electrónica en Configuración → Estudio")
  return emitir(cliente, leerSolicitud(await cuerpo(req)), FACTURA_C, "contador")
}

// Anula una Factura C con una Nota de Crédito C por el total (mismo receptor, concepto y renglones).
export async function feAnular({ req, p }: Ctx) {
  const estudioId = await getEstudioId(req)
  const original = await q(db().from("comprobantes_emitidos").select("*").eq("id", p.id).eq("estudio_id", estudioId).maybeSingle())
  if (!original) throw new HttpError(404, "Comprobante no encontrado")
  if (original.tipo !== FACTURA_C) throw new HttpError(400, "Solo se anulan facturas")
  if (original.anulado_por) throw new HttpError(409, "Esta factura ya tiene una nota de crédito")
  const cliente = await q(db().from("clientes").select(COLS_CLIENTE).eq("id", original.cliente_id).single())
  const hoy = hoyAr()
  const s: Solicitud = {
    concepto: original.concepto, docTipo: original.doc_tipo, docNro: Number(original.doc_nro), condicionIva: original.receptor_condicion_iva,
    receptorNombre: original.receptor_nombre ?? "Consumidor Final", receptorDomicilio: original.receptor_domicilio ?? "",
    condicionVenta: original.condicion_venta ?? "Contado", items: original.items, importe: Number(original.importe), fecha: hoy,
    servDesde: original.fch_serv_desde, servHasta: original.fch_serv_hasta,
    vtoPago: original.concepto !== 1 ? (original.fch_vto_pago && original.fch_vto_pago > hoy ? original.fch_vto_pago : hoy) : null,
    clave: `anula-${original.id}`,
  }
  return emitir(cliente, s, NOTA_CREDITO_C, "contador", {
    id: original.id, puntoVenta: original.punto_venta, numero: Number(original.numero), fecha: original.fecha,
  })
}

export async function feReceptorAdmin({ req, p }: Ctx) {
  await getEstudioId(req)
  return buscarReceptor(p.cuit)
}

async function buscarReceptor(cuitTexto: string) {
  const cuit = String(cuitTexto ?? "").replace(/\D/g, "")
  if (cuit.length !== 11) throw new HttpError(400, "CUIT inválido")
  try {
    return { ok: true, ...(await datosReceptor(cuit)) }
  } catch (e: any) {
    throw new HttpError(404, `ARCA no encontró ese CUIT (${String(e?.message ?? e).slice(0, 120)})`)
  }
}

// ── Portal ───────────────────────────────────────────────────────────────────

async function clienteDelPortal(req: Request, slug: string) {
  await exigirSesionPortal(req, slug)
  return q(db().from("clientes").select(COLS_CLIENTE).eq("slug", slug).single())
}

export async function fePortalEstado({ req, p }: Ctx) {
  const cliente = await clienteDelPortal(req, p.slug)
  return { disponible: await facturacionDisponible(cliente), comprobantes: await comprobantesDe(cliente.id, 20), ...opciones() }
}

export async function fePortalEmitir({ req, p }: Ctx) {
  const cliente = await clienteDelPortal(req, p.slug)
  if (!(await facturacionDisponible(cliente))) throw new HttpError(409, "La facturación desde el portal no está habilitada. Consultá a tu contadora.")
  const desde = new Date(Date.now() - 86_400_000).toISOString()
  const { count } = await db().from("comprobantes_emitidos").select("id", { count: "exact", head: true })
    .eq("cliente_id", cliente.id).eq("emitido_por", "cliente").gte("created_at", desde)
  if ((count ?? 0) >= MAX_POR_DIA_CLIENTE) throw new HttpError(429, "Llegaste al máximo de facturas por día desde el portal. Consultá a tu contadora.")
  return emitir(cliente, leerSolicitud(await cuerpo(req)), FACTURA_C, "cliente")
}

export async function fePortalReceptor({ req, p }: Ctx) {
  await exigirSesionPortal(req, p.slug)
  return buscarReceptor(p.cuit)
}
