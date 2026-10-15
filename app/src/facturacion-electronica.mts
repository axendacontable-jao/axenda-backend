import { ESTADOS_HABILITADOS, HttpError, clientePorSlug, db, getEstudioId, hoyArgentina, isoDate, q } from "./core.mts"
import { constanciaCompleta } from "./arca.mts"
import { exigirSesionPortal } from "./secretos.mts"
import { despacharFactura, nombreFactura } from "./sincronizacion.mts"

// Facturas C que emite el robot en "Comprobantes en línea" con la clave fiscal del cliente.
// El pedido se guarda en comprobantes_emitidos (estado "pendiente") y lo procesa la función de fondo.

type Ctx = { req: Request; p: Record<string, string>; query: URLSearchParams }

const FACTURA_C = 11
const CONDICIONES_IVA: Record<number, string> = {
  5: "Consumidor Final", 1: "IVA Responsable Inscripto", 6: "Responsable Monotributo", 4: "IVA Sujeto Exento",
  15: "IVA No Alcanzado", 13: "Monotributista Social",
}
const TIPOS_DOC: Record<number, string> = { 99: "Consumidor Final", 80: "CUIT", 96: "DNI" }
const CONCEPTOS: Record<number, string> = { 2: "Servicios", 1: "Productos" }
const COLS_CLIENTE = "id,cuit,nombre,apellido,estudio_id,tipo_actividad,fe_habilitada,fe_punto_venta"
const MAX_POR_DIA_CLIENTE = 20
const EN_CURSO = ["pendiente", "procesando", "confirmando"]

const esIso = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
const hoyAr = () => { const t = hoyArgentina(); return isoDate(t.y, t.m, t.d) }
const finDeMes = (iso: string) => {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), 0))
  return d.toISOString().slice(0, 10)
}

async function cuerpo(req: Request): Promise<Record<string, any>> {
  try {
    const d = await req.json()
    if (d && typeof d === "object") return d
  } catch {
    // cae abajo
  }
  throw new HttpError(400, "Pedido inválido")
}

async function tieneClave(clienteId: string) {
  return !!(await q(db().from("credenciales_arca").select("cliente_id").eq("cliente_id", clienteId).maybeSingle()))
}
async function estudioHabilitado(estudioId: string) {
  const e = await q(db().from("estudios").select("facturacion_electronica_habilitada,estado").eq("id", estudioId).maybeSingle()).catch(() => null)
  return !!e?.facturacion_electronica_habilitada && ESTADOS_HABILITADOS.includes(e.estado)
}

// Disponible si el estudio la activó, el cliente está habilitado y tiene la clave fiscal cargada.
export async function facturacionDisponible(cliente: any) {
  return !!cliente.fe_habilitada && (await estudioHabilitado(cliente.estudio_id)) && (await tieneClave(cliente.id))
}

const resumen = (c: any) => ({
  id: c.id, estado: c.estado, paso: c.paso ?? null, nombre: c.estado === "emitida" ? nombreFactura(c.punto_venta, c.numero) : "Factura C",
  fecha: c.fecha, importe: Number(c.importe), receptor: c.receptor_nombre, descripcion: c.items?.[0]?.descripcion ?? "",
  cae: c.cae, cae_vto: c.cae_vto, url_pdf: c.url_pdf, emitido_por: c.emitido_por, error: c.error, creado: c.created_at,
})

async function comprobantesDe(clienteId: string, limite: number) {
  return ((await q(db().from("comprobantes_emitidos").select("*").eq("cliente_id", clienteId)
    .order("created_at", { ascending: false }).limit(limite))) ?? []).map(resumen)
}

const opciones = (cliente: any) => ({
  condiciones_iva: CONDICIONES_IVA, tipos_doc: TIPOS_DOC, conceptos: CONCEPTOS,
  concepto_sugerido: /bien|venta|comercio|producto/i.test(cliente.tipo_actividad ?? "") ? 1 : 2,
})

type Pedido = {
  concepto: number; docTipo: number; docNro: number; condicionIva: number; receptorNombre: string
  descripcion: string; importe: number; fecha: string; servDesde: string | null; servHasta: string | null; vtoPago: string | null
  clave: string | null
}

// CUIT (o DNI, o consumidor final), descripción, fecha y monto. Para servicios, el período facturado
// es el mes de la fecha y el pago vence ese mismo día.
export function leerPedido(d: Record<string, any>): Pedido {
  const concepto = Number(d.concepto ?? 2)
  if (!CONCEPTOS[concepto]) throw new HttpError(400, "Elegí si facturás servicios o productos")
  const docTipo = Number(d.doc_tipo ?? 99)
  if (!TIPOS_DOC[docTipo]) throw new HttpError(400, "Tipo de documento del receptor inválido")
  const docNro = docTipo === 99 ? 0 : Number(String(d.doc_nro ?? "").replace(/\D/g, ""))
  if (docTipo === 80 && String(docNro).length !== 11) throw new HttpError(400, "El CUIT del receptor tiene que tener 11 dígitos")
  if (docTipo === 96 && (docNro < 1_000_000 || docNro > 99_999_999)) throw new HttpError(400, "DNI del receptor inválido")
  const condicionIva = Number(d.condicion_iva ?? 5)
  if (!CONDICIONES_IVA[condicionIva]) throw new HttpError(400, "Condición frente al IVA del receptor inválida")
  if (docTipo === 99 && condicionIva !== 5) throw new HttpError(400, "Sin documento, el receptor solo puede ser Consumidor Final")
  const receptorNombre = String(d.receptor_nombre ?? "").trim().slice(0, 120) || (docTipo === 99 ? "Consumidor Final" : "")
  if (!receptorNombre) throw new HttpError(400, "Buscá el CUIT en ARCA o escribí el nombre del receptor")
  const descripcion = String(d.descripcion ?? "").trim().replace(/\s+/g, " ").slice(0, 200)
  if (descripcion.length < 3) throw new HttpError(400, "Escribí una descripción")
  const importe = Math.round(Number(d.importe) * 100) / 100
  if (!(importe > 0 && importe <= 10_000_000_000)) throw new HttpError(400, "Monto inválido")
  const hoy = hoyAr()
  const fecha = esIso(d.fecha) ? d.fecha : hoy
  const margen = concepto === 1 ? 5 : 10
  if (Math.abs((Date.parse(fecha) - Date.parse(hoy)) / 86_400_000) > margen) {
    throw new HttpError(400, `La fecha puede estar hasta ${margen} días antes o después de hoy`)
  }
  const servDesde = concepto === 1 ? null : `${fecha.slice(0, 8)}01`
  const clave = typeof d.clave_idempotencia === "string" && /^[\w-]{8,64}$/.test(d.clave_idempotencia) ? d.clave_idempotencia : null
  return {
    concepto, docTipo, docNro, condicionIva, receptorNombre, descripcion, importe, fecha,
    servDesde, servHasta: concepto === 1 ? null : finDeMes(fecha), vtoPago: concepto === 1 ? null : fecha, clave,
  }
}

async function crearPedido(req: Request, cliente: any, emitidoPor: "cliente" | "contador") {
  const p = leerPedido(await cuerpo(req))
  if (p.clave) {
    const previo = await q(db().from("comprobantes_emitidos").select("*").eq("clave_idempotencia", p.clave).maybeSingle())
    if (previo) {
      if (previo.cliente_id !== cliente.id) throw new HttpError(409, "Pedido duplicado")
      return { ok: true, comprobante: resumen(previo) }
    }
  }
  // Una por vez: el robot no puede emitir dos facturas del mismo cliente al mismo tiempo.
  const enCurso = await q(db().from("comprobantes_emitidos").select("id").eq("cliente_id", cliente.id).in("estado", EN_CURSO).limit(1))
  if (enCurso?.length) throw new HttpError(409, "Ya hay una factura generándose para este cliente: esperá a que termine")
  const fila = await q(db().from("comprobantes_emitidos").insert({
    cliente_id: cliente.id, estudio_id: cliente.estudio_id, tipo: FACTURA_C, fecha: p.fecha, concepto: p.concepto,
    doc_tipo: p.docTipo, doc_nro: p.docNro, receptor_nombre: p.receptorNombre, receptor_condicion_iva: p.condicionIva,
    condicion_venta: "Contado", items: [{ descripcion: p.descripcion, cantidad: 1, precio: p.importe }], importe: p.importe,
    fch_serv_desde: p.servDesde, fch_serv_hasta: p.servHasta, fch_vto_pago: p.vtoPago, emitido_por: emitidoPor,
    clave_idempotencia: p.clave, estado: "pendiente",
  }).select().single())
  try {
    await despacharFactura(new URL(req.url).origin, fila.id)
  } catch (e: any) {
    await q(db().from("comprobantes_emitidos").update({ estado: "error", error: "No se pudo iniciar el robot" }).eq("id", fila.id)).catch(() => {})
    throw new HttpError(503, `No se pudo iniciar el robot: ${e?.message ?? e}`)
  }
  return { ok: true, comprobante: resumen(fila) }
}

async function buscarReceptor(cuitTexto: string) {
  const cuit = String(cuitTexto ?? "").replace(/\D/g, "")
  if (cuit.length !== 11) throw new HttpError(400, "CUIT inválido")
  try {
    const c = await constanciaCompleta(cuit)
    const impuestos = c.impuestos.map((i) => i.toUpperCase())
    // Monotributista si ARCA informa categoría; Responsable Inscripto si tiene IVA; si no, a elegir.
    const condicion = c.categoria ? 6
      : impuestos.some((i) => /IVA EXENTO/.test(i)) ? 4
      : impuestos.some((i) => /^IVA\b/.test(i)) ? 1 : null
    return { ok: true, nombre: c.razonSocial || [c.apellido, c.nombre].filter(Boolean).join(" "), condicion_iva: condicion, estado: c.estado }
  } catch (e: any) {
    throw new HttpError(404, `ARCA no encontró ese CUIT (${String(e?.message ?? e).slice(0, 120)})`)
  }
}

async function unComprobante(clienteId: string, id: string) {
  const c = await q(db().from("comprobantes_emitidos").select("*").eq("id", id).eq("cliente_id", clienteId).maybeSingle())
  if (!c) throw new HttpError(404, "Comprobante no encontrado")
  return resumen(c)
}

// A quién le factura seguido el cliente y con qué descripciones, para sugerirlo en el formulario.
async function sugerencias(clienteId: string) {
  const filas = (await q(db().from("comprobantes_emitidos")
    .select("doc_tipo,doc_nro,receptor_nombre,receptor_condicion_iva,items,importe")
    .eq("cliente_id", clienteId).eq("estado", "emitida").order("created_at", { ascending: false }).limit(200))) ?? []
  const receptores = new Map<string, any>()
  const descripciones = new Map<string, { texto: string; veces: number }>()
  for (const f of filas) {
    const descripcion = String(f.items?.[0]?.descripcion ?? "").trim()
    if (f.doc_tipo !== 99 && f.doc_nro) {
      const k = `${f.doc_tipo}-${f.doc_nro}`
      // La primera vez que aparece es la factura más reciente a ese receptor.
      const r = receptores.get(k) ?? {
        doc_tipo: f.doc_tipo, doc_nro: String(f.doc_nro), nombre: f.receptor_nombre, condicion_iva: f.receptor_condicion_iva,
        ultima_descripcion: descripcion, ultimo_importe: Number(f.importe), veces: 0,
      }
      r.veces++
      receptores.set(k, r)
    }
    if (descripcion) {
      const k = descripcion.toLowerCase()
      const d = descripciones.get(k) ?? { texto: descripcion, veces: 0 }
      d.veces++
      descripciones.set(k, d)
    }
  }
  // Las más usadas primero; entre iguales, la más reciente (sort estable).
  const top = <T extends { veces: number }>(m: Map<string, T>) => [...m.values()].sort((a, b) => b.veces - a.veces).slice(0, 6)
  return { receptores: top(receptores), descripciones: top(descripciones).map((d) => d.texto) }
}

// ── Admin ────────────────────────────────────────────────────────────────────

export async function feEstado({ req, p }: Ctx) {
  const estudioId = await getEstudioId(req)
  const cliente = await clientePorSlug(p.slug, estudioId, COLS_CLIENTE)
  return {
    estudio_habilitado: await estudioHabilitado(estudioId), clave_fiscal: await tieneClave(cliente.id),
    config: { habilitada: !!cliente.fe_habilitada, punto_venta: cliente.fe_punto_venta ?? null },
    comprobantes: await comprobantesDe(cliente.id, 50), sugerencias: await sugerencias(cliente.id), ...opciones(cliente),
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
  if (!Object.keys(cambios).length) throw new HttpError(400, "Sin cambios")
  await q(db().from("clientes").update(cambios).eq("id", cliente.id))
  return { ok: true }
}

export async function feEmitirAdmin({ req, p }: Ctx) {
  const estudioId = await getEstudioId(req)
  const cliente = await clientePorSlug(p.slug, estudioId, COLS_CLIENTE)
  if (!(await estudioHabilitado(estudioId))) throw new HttpError(409, "Activá la facturación en Configuración → Estudio")
  if (!(await tieneClave(cliente.id))) throw new HttpError(409, "Cargá la clave fiscal del cliente en la pestaña ARCA")
  return crearPedido(req, cliente, "contador")
}

export async function feComprobanteAdmin({ req, p }: Ctx) {
  const estudioId = await getEstudioId(req)
  const cliente = await clientePorSlug(p.slug, estudioId)
  return unComprobante(cliente.id, p.id)
}

// Vuelve a intentar un pedido que falló antes de confirmar en ARCA (nunca uno "a revisar").
export async function feReintentar({ req, p }: Ctx) {
  const estudioId = await getEstudioId(req)
  const cliente = await clientePorSlug(p.slug, estudioId)
  const filas = await q(db().from("comprobantes_emitidos").update({ estado: "pendiente", paso: null, error: null, actualizado_at: new Date().toISOString() })
    .eq("id", p.id).eq("cliente_id", cliente.id).eq("estado", "error").select())
  if (!filas?.length) throw new HttpError(409, "Solo se pueden reintentar las facturas con error")
  await despacharFactura(new URL(req.url).origin, p.id)
  return { ok: true, comprobante: resumen(filas[0]) }
}

// Borra un pedido que falló antes de confirmar en ARCA (en ARCA no se generó nada).
export async function feBorrar({ req, p }: Ctx) {
  const estudioId = await getEstudioId(req)
  const cliente = await clientePorSlug(p.slug, estudioId)
  const filas = await q(db().from("comprobantes_emitidos").delete()
    .eq("id", p.id).eq("cliente_id", cliente.id).eq("estado", "error").is("cae", null).select("id"))
  if (!filas?.length) throw new HttpError(409, "Solo se pueden borrar las facturas que no se emitieron")
  return { ok: true }
}

export async function feReceptorAdmin({ req, p }: Ctx) {
  await getEstudioId(req)
  return buscarReceptor(p.cuit)
}

// ── Portal ───────────────────────────────────────────────────────────────────

async function clienteDelPortal(req: Request, slug: string) {
  await exigirSesionPortal(req, slug)
  return q(db().from("clientes").select(COLS_CLIENTE).eq("slug", slug).single())
}

export async function fePortalEstado({ req, p }: Ctx) {
  const cliente = await clienteDelPortal(req, p.slug)
  return {
    disponible: await facturacionDisponible(cliente), comprobantes: await comprobantesDe(cliente.id, 20),
    sugerencias: await sugerencias(cliente.id), ...opciones(cliente),
  }
}

export async function fePortalEmitir({ req, p }: Ctx) {
  const cliente = await clienteDelPortal(req, p.slug)
  if (!(await facturacionDisponible(cliente))) throw new HttpError(409, "La facturación desde el portal no está habilitada. Consultá a tu contadora.")
  const desde = new Date(Date.now() - 86_400_000).toISOString()
  const { count } = await db().from("comprobantes_emitidos").select("id", { count: "exact", head: true })
    .eq("cliente_id", cliente.id).eq("emitido_por", "cliente").gte("created_at", desde)
  if ((count ?? 0) >= MAX_POR_DIA_CLIENTE) throw new HttpError(429, "Llegaste al máximo de facturas por día desde el portal. Consultá a tu contadora.")
  return crearPedido(req, cliente, "cliente")
}

export async function fePortalComprobante({ req, p }: Ctx) {
  const cliente = await clienteDelPortal(req, p.slug)
  return unComprobante(cliente.id, p.id)
}

export async function fePortalReceptor({ req, p }: Ctx) {
  await exigirSesionPortal(req, p.slug)
  return buscarReceptor(p.cuit)
}
