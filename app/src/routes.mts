import {
  ESTADOS_HABILITADOS, HttpError, ahoraIsoZ, clientePorSlug, db, esFechaIso, getEstudioId, hoy, hoyIso, isoDate,
  logActividad, pyStr, q, sumarMeses, fechaValida,
} from "./core.mts"
import { rutasSuperadmin } from "./superadmin.mts"
import { buscarEnConstancia, buscarEnPadron, certPem, constanciaCompleta, cuitContador, keyPem, serviciosCacheados } from "./arca.mts"
import { pdfConstancia } from "./constancia-pdf.mts"
import {
  facturacionDisponible, feComprobanteAdmin, feEmitirAdmin, feEstado, feGuardarConfig, fePortalComprobante, fePortalEmitir,
  fePortalEstado, fePortalReceptor, feReceptorAdmin, feReintentar, feBorrar,
} from "./facturacion-electronica.mts"
import { cifrarClave, exigirSesionPortal, firmarTokenPortal } from "./secretos.mts"
import { TAREAS, despacharSincronizacion, finPeriodoProximaRecategorizacion } from "./sincronizacion.mts"
import { getStore } from "@netlify/blobs"
import { randomUUID } from "node:crypto"
import {
  aNumero, fechaExcelIso, leerExcel, parseArNumber, parseNumPuntos, pdfTablas, pdfTexto,
  totalesComprobantesPorMes,
} from "./parsers.mts"

type Ctx = { req: Request; p: Record<string, string>; query: URLSearchParams }
type Handler = (c: Ctx) => Promise<unknown>

// ── Helpers de request ───────────────────────────────────────────────────────

async function body(req: Request): Promise<Record<string, any>> {
  let b: unknown
  try {
    b = await req.json()
  } catch {
    throw new HttpError(422, "Body JSON inválido")
  }
  if (b === null || typeof b !== "object" || Array.isArray(b)) throw new HttpError(422, "Body JSON inválido")
  return b as Record<string, any>
}

async function formulario(req: Request): Promise<FormData> {
  try {
    return await req.formData()
  } catch {
    throw new HttpError(422, "Se esperaba multipart/form-data")
  }
}

const esArchivo = (v: unknown): v is File =>
  typeof v === "object" && v !== null && typeof (v as File).arrayBuffer === "function"

async function archivo(req: Request, campo = "file"): Promise<File> {
  const f = (await formulario(req)).get(campo)
  if (!esArchivo(f)) throw new HttpError(422, `Falta el archivo '${campo}'`)
  return f
}

const bytes = async (f: File) => new Uint8Array(await f.arrayBuffer())

function entero(v: string, nombre: string): number {
  if (!/^-?\d+$/.test(v)) throw new HttpError(422, `${nombre} debe ser un entero`)
  return parseInt(v, 10)
}

const sinNulos = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined))

const elegir = (data: Record<string, any>, campos: string[]) =>
  Object.fromEntries(Object.entries(data).filter(([k]) => campos.includes(k)))

// data.get(k, default) de Python: el default solo aplica si la clave no vino.
const get = (data: Record<string, any>, k: string, def: unknown = null) => (k in data ? data[k] : def)

const soloDigitos = (s: unknown) => String(s ?? "").replace(/\D/g, "")

const CATS = "ABCDEFGHIJK"
const esCat = (s: string) => s.length === 1 && CATS.includes(s)

// Componente ART Río Negro por categoría (vigente desde 01/02/2026)
const ART_RIO_NEGRO: Record<string, number> = {
  A: 17773.24, B: 26330.15, C: 35038.48,
  D: 52992.43, E: 70657.51, F: 88097.78,
  G: 105032.36, H: 170242.95, I: 197256.01,
  J: 231453.81, K: 261120.28,
}

const pesos = (n: number) => "$" + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".")

// Componente de ART Río Negro de la categoría según la tabla de Configuración (componentes
// provinciales vigentes); si no está cargada, el valor fijo de febrero de 2026.
async function artPorMes(categoria: unknown): Promise<number> {
  const cat = String(categoria ?? "").toUpperCase()
  try {
    const filas = await q(db().from("componentes_provinciales").select("monto,tipo")
      .in("provincia", ["Rio Negro", "Río Negro"]).eq("categoria", cat).lte("vigente_desde", hoyIso())
      .order("vigente_desde", { ascending: false }).limit(3))
    const fila = (filas ?? []).find((f: any) => f.tipo === "servicios" || f.tipo === "unico") ?? filas?.[0]
    if (fila && Number(fila.monto) > 0) return Number(fila.monto)
  } catch {
    // Sin tabla: valor fijo.
  }
  return ART_RIO_NEGRO[cat] ?? 0
}

// ART Río Negro (monotributo unificado) no figura en la CCMA de ARCA: se estima como el componente
// provincial de la categoría por cada mes cuya cuota de ARCA está vencida e impaga.
function componenteArtEstimado(cliente: any, historial: any[], porMes: number): number {
  const rioNegro = /r[ií]o negro/i.test(cliente.provincia || "Rio Negro")
  const unificado = !cliente.iibb_modalidad || cliente.iibb_modalidad === "monotributo_unificado"
  if (!rioNegro || !unificado) return 0
  const t = hoy()
  const desde = t.y * 12 + (t.m - 1) - 11
  return historial.filter((h) =>
    h.fuente === "arca" && h.estado === "vencida" && h["año"] * 12 + (h.mes - 1) >= desde).length * porMes
}

// Con la cuenta corriente de ART leída por el robot la deuda es la real; si no, la estimación.
async function deudaArtDe(cliente: any, historial: any[]) {
  if (cliente.art_actualizada_at) {
    return { monto: Number(cliente.art_deuda_monto) || 0, real: true, actualizada_at: cliente.art_actualizada_at, por_mes: 0 }
  }
  const porMes = await artPorMes(cliente.categoria)
  return { monto: componenteArtEstimado(cliente, historial, porMes), real: false, actualizada_at: null, por_mes: porMes }
}

// UPDATE y, si no tocó filas, INSERT (nunca upsert con on_conflict en estas tablas).
async function actualizarOInsertar(
  tabla: string, valores: Record<string, unknown>, filtro: Record<string, unknown>,
) {
  let upd = db().from(tabla).update(valores)
  for (const [k, v] of Object.entries(filtro)) upd = upd.eq(k, v as any)
  const filas = await q(upd.select())
  if (!filas?.length) await q(db().from(tabla).insert({ ...filtro, ...valores }))
}

// Con clave fiscal cargada, cuotas y deuda vienen de ARCA y no se marcan a mano.
async function tieneClaveFiscal(clienteId: string) {
  return !!(await q(db().from("credenciales_arca").select("cliente_id").eq("cliente_id", clienteId).maybeSingle()))
}
const SINCRONIZADO = "Este cliente se sincroniza con ARCA: las cuotas se actualizan solas"

// ── Salud ────────────────────────────────────────────────────────────────────

const salud: Handler = async () => {
  const cert = certPem()
  return {
    status: "ok", version: "2.0.0-netlify",
    cert_ok: !!cert, key_ok: !!keyPem(),
    cert_lines: cert ? cert.split("\n").length : 0,
    openssl_ok: true,
    supabase_ok: !!(Netlify.env.get("SUPABASE_URL") && Netlify.env.get("SUPABASE_KEY")),
    cuit_contador: cuitContador(),
    servicios_cacheados: serviciosCacheados(),
    node: process.version,
    runtime: process.env.AWS_EXECUTION_ENV ?? null,
  }
}

// ── Estudios ─────────────────────────────────────────────────────────────────

const estudiosMe: Handler = async ({ req }) => {
  const estudioId = await getEstudioId(req)
  const data = await q(db().from("estudios").select("*").eq("id", estudioId).single())
  return data ?? {}
}

const COLOR_POR_DEFECTO = "#2BAF82"
const esColor = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)

const actualizarEstudio: Handler = async ({ req }) => {
  const estudioId = await getEstudioId(req)
  const update = elegir(await body(req), ["nombre", "onboarding_completo", "facturacion_electronica_habilitada", "color_primario"])
  if ("color_primario" in update) {
    if (update.color_primario === null || update.color_primario === "") update.color_primario = COLOR_POR_DEFECTO
    if (!esColor(update.color_primario)) throw new HttpError(422, "El color tiene que ser un código como #2BAF82")
    update.color_primario = update.color_primario.toUpperCase()
  }
  if ("nombre" in update) {
    update.nombre = String(update.nombre ?? "").trim().slice(0, 80)
    if (!update.nombre) throw new HttpError(422, "El nombre del estudio no puede quedar vacío")
    await actualizarOInsertar("configuracion", { valor: update.nombre }, { clave: "nombre_estudio", estudio_id: estudioId })
  }
  if (!Object.keys(update).length) throw new HttpError(400, "Sin campos válidos")
  await q(db().from("estudios").update(update).eq("id", estudioId))
  return { ok: true }
}

// Logo del estudio (marca blanca): bucket público logos-estudios/{estudio}/logo-<fecha>.<ext>.
const BUCKET_LOGOS = "logos-estudios"
const TIPOS_LOGO: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }

async function borrarLogos(estudioId: string, salvo?: string) {
  const storage = db().storage.from(BUCKET_LOGOS)
  const { data } = await storage.list(estudioId, { limit: 100 })
  const viejos = (data ?? []).map((f) => `${estudioId}/${f.name}`).filter((r) => r !== salvo)
  if (viejos.length) await storage.remove(viejos)
}

const subirLogo: Handler = async ({ req }) => {
  const estudioId = await getEstudioId(req)
  const adjunto = await archivo(req)
  const porExtension: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }
  const tipo = TIPOS_LOGO[adjunto.type] ? adjunto.type : porExtension[adjunto.name.split(".").pop()?.toLowerCase() ?? ""] ?? ""
  if (!TIPOS_LOGO[tipo]) throw new HttpError(415, "El logo tiene que ser PNG, JPG o WEBP")
  if (adjunto.size > 1024 * 1024) throw new HttpError(413, "El logo supera 1 MB")
  const ruta = `${estudioId}/logo-${Date.now()}.${TIPOS_LOGO[tipo]}`
  const storage = db().storage.from(BUCKET_LOGOS)
  const { error } = await storage.upload(ruta, await bytes(adjunto), { contentType: tipo })
  if (error) throw new HttpError(500, `No se pudo subir el logo: ${error.message}`)
  const url = storage.getPublicUrl(ruta).data.publicUrl
  await q(db().from("estudios").update({ logo_url: url }).eq("id", estudioId))
  await borrarLogos(estudioId, ruta).catch(() => {})
  return { ok: true, logo_url: url }
}

const quitarLogo: Handler = async ({ req }) => {
  const estudioId = await getEstudioId(req)
  await q(db().from("estudios").update({ logo_url: null }).eq("id", estudioId))
  await borrarLogos(estudioId).catch(() => {})
  return { ok: true }
}

// Marca del estudio para pantallas sin sesión (login del portal con ?e=<estudio>): solo datos públicos.
const marcaDe = (e: any) => ({
  estudio_id: e.id, nombre: e.nombre ?? "", logo_url: e.logo_url ?? null,
  color_primario: esColor(e.color_primario) ? e.color_primario : COLOR_POR_DEFECTO,
})

const marcaEstudio: Handler = async ({ p }) => {
  if (!/^[0-9a-f-]{36}$/i.test(p.id)) throw new HttpError(404, "Estudio no encontrado")
  const e = await q(db().from("estudios").select("id,nombre,logo_url,color_primario").eq("id", p.id).maybeSingle())
  if (!e) throw new HttpError(404, "Estudio no encontrado")
  // El WhatsApp del estudio, para "¿Olvidaste tu contraseña?" antes de iniciar sesión.
  const wa = await q(db().from("configuracion").select("valor").eq("estudio_id", e.id).eq("clave", "whatsapp_estudio").maybeSingle()).catch(() => null)
  return { ...marcaDe(e), whatsapp: wa?.valor || null }
}

const completarOnboarding: Handler = async ({ req }) => {
  const estudioId = await getEstudioId(req)
  const data = await body(req)
  try {
    const nombre = get(data, "nombre", "Mi Estudio")
    const configs: Record<string, unknown> = { nombre_estudio: nombre }
    if (data.provincia_principal) configs.provincia_principal = data.provincia_principal
    if (data.whatsapp) configs.whatsapp_estudio = data.whatsapp
    if (data.email_contacto) configs.email_estudio = data.email_contacto
    for (const [clave, valor] of Object.entries(configs)) {
      try {
        await actualizarOInsertar("configuracion", { valor }, { clave, estudio_id: estudioId })
      } catch (e: any) {
        console.log(`[onboarding] cfg ${clave} error: ${e?.message ?? e}`)
      }
    }
    try {
      const marca = esColor(data.color_primario) ? { color_primario: data.color_primario.toUpperCase() } : {}
      await q(db().from("estudios").update({ nombre, onboarding_completo: true, ...marca }).eq("id", estudioId))
    } catch {
      await q(db().from("estudios").update({ nombre }).eq("id", estudioId))
    }
    return { ok: true }
  } catch (e: any) {
    console.log(`[onboarding] error inesperado: ${e?.message ?? e}`)
    return { ok: false, error: String(e?.message ?? e) }
  }
}

const migrarDatos: Handler = async ({ req }) => {
  const estudioId = await getEstudioId(req)
  const tablas = ["clientes", "planes_pago", "deuda_manual", "alertas", "facturacion", "documentos", "configuracion"]
  const totales: Record<string, unknown> = {}
  for (const tabla of tablas) {
    try {
      const filas = await q(db().from(tabla).update({ estudio_id: estudioId }).is("estudio_id", null).select("id"))
      totales[tabla] = (filas ?? []).length
    } catch (e: any) {
      totales[tabla] = `error: ${e?.message ?? e}`
    }
  }
  return { ok: true, migrados: totales }
}

// ── Componentes provinciales ─────────────────────────────────────────────────

const componentesResumen: Handler = async ({ req }) => {
  await getEstudioId(req)
  const filas = await q(
    db().from("componentes_provinciales").select("*").lte("vigente_desde", hoyIso()).order("vigente_desde", { ascending: false }),
  )
  const vistos = new Map<string, any>()
  for (const r of filas ?? []) {
    const k = `${r.provincia}|${r.categoria}|${r.tipo}`
    if (!vistos.has(k)) vistos.set(k, r)
  }
  return { ok: true, componentes: [...vistos.values()] }
}

const componenteProvincial: Handler = async ({ p, query }) => {
  const tipo = query.get("tipo") ?? "servicios"
  const buscar = (t: string) =>
    q(
      db().from("componentes_provinciales").select("*")
        .eq("provincia", p.provincia).eq("categoria", p.categoria.toUpperCase()).eq("tipo", t)
        .lte("vigente_desde", hoyIso()).order("vigente_desde", { ascending: false }).limit(1),
    )
  let filas = await buscar(tipo)
  if (!filas?.length && tipo !== "unico") filas = await buscar("unico")
  return { ok: true, componente: filas?.length ? filas[0] : null }
}

// ── ARCA ─────────────────────────────────────────────────────────────────────

const constancia: Handler = async ({ req, p }) => {
  await getEstudioId(req)
  const cuit = soloDigitos(p.cuit)
  if (cuit.length !== 11) throw new HttpError(400, "CUIT inválido")
  try {
    const datos = await buscarEnConstancia(cuit)
    return {
      ok: true,
      cuit,
      cuit_fmt: `${cuit.slice(0, 2)}-${cuit.slice(2, -1)}-${cuit.slice(-1)}`,
      nombre: datos.nombre ?? "",
      apellido: datos.apellido ?? "",
      categoria: datos.categoria ?? "",
      estado: datos.estado ?? "ACTIVO",
      fecha_consulta: hoyIso(),
    }
  } catch (e: any) {
    throw new HttpError(503, `ARCA no responde: ${e?.message ?? e}`)
  }
}

const padron: Handler = async ({ req, p }) => {
  await getEstudioId(req)
  const cuit = soloDigitos(p.cuit)
  if (cuit.length !== 11) throw new HttpError(400, "CUIT invalido: debe tener 11 digitos")
  try {
    return await buscarEnConstancia(cuit)
  } catch {
    // sigue con el padrón A13
  }
  try {
    return await buscarEnPadron(cuit)
  } catch (e: any) {
    throw new HttpError(404, `CUIT no encontrado: ${e?.message ?? e}`)
  }
}

// ── Clientes ─────────────────────────────────────────────────────────────────

const listarClientes: Handler = async ({ req }) => {
  const estudioId = await getEstudioId(req)
  const [clientes, creds] = await Promise.all([
    q(db().from("clientes").select("*").eq("estudio_id", estudioId).order("apellido")),
    q(db().from("credenciales_arca").select("cliente_id").eq("estudio_id", estudioId)),
  ])
  const conClave = new Set((creds ?? []).map((c: any) => c.cliente_id))
  return (clientes ?? []).map((c: any) => ({ ...c, arca_auto: conClave.has(c.id) }))
}

const crearCliente: Handler = async ({ req }) => {
  const estudioId = await getEstudioId(req)
  const data = await body(req)
  const cuit = soloDigitos(get(data, "cuit", ""))
  const apellidoSlug = String(get(data, "apellido", "") ?? "").toLowerCase().replace(/ /g, "-").replace(/[^a-z0-9]/g, "")
  const slug = `${apellidoSlug}-${cuit}`
  const cliente = {
    slug, nombre: data.nombre ?? null, apellido: data.apellido ?? null,
    cuit, whatsapp: get(data, "whatsapp", ""), email: get(data, "email", ""),
    categoria: String(data.categoria || "").toUpperCase() || null,
    cuota: data.cuota || null, activo: true,
    provincia: get(data, "provincia", "Rio Negro"),
    iibb_modalidad: get(data, "iibb_modalidad", "monotributo_unificado"),
    tipo_actividad: get(data, "tipo_actividad", "servicios"),
    en_relacion_dependencia: !!get(data, "en_relacion_dependencia", false),
    estudio_id: estudioId,
  }
  const { data: filas, error } = await db().from("clientes").insert(cliente).select()
  if (error) throw new HttpError(500, `Error al guardar cliente: ${error.message}`)
  const clienteId = filas?.length ? filas[0].id : null
  await logActividad(clienteId, `Alta de cliente — ${data.nombre ?? ""} ${data.apellido ?? ""}`, estudioId)
  return { ok: true, slug, data: filas }
}

const toggleActivo: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const cliente = await clientePorSlug(p.slug, estudioId, "activo")
  const nuevo = !cliente.activo
  await q(db().from("clientes").update({ activo: nuevo }).eq("slug", p.slug).eq("estudio_id", estudioId))
  return { ok: true, activo: nuevo }
}

const actualizarEstadoPago: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const nuevo = (await body(req)).estado_pago
  if (!["al_dia", "debe", "vencida"].includes(nuevo)) {
    throw new HttpError(400, "Estado inválido: debe ser al_dia, debe o vencida")
  }
  const cliente = await clientePorSlug(p.slug, estudioId, "id,nombre,apellido")
  if (await tieneClaveFiscal(cliente.id)) throw new HttpError(409, SINCRONIZADO)
  await q(db().from("clientes").update({ estado_pago: nuevo }).eq("slug", p.slug).eq("estudio_id", estudioId))
  if (nuevo === "al_dia") {
    const nombre = `${cliente.nombre ?? ""} ${cliente.apellido ?? ""}`.trim()
    await logActividad(cliente.id, `Cuota marcada al día — ${nombre}`, estudioId)
  }
  return { ok: true, estado_pago: nuevo }
}

const actualizarCuota: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const cuota = (await body(req)).cuota
  if (typeof cuota !== "number" || !Number.isFinite(cuota) || cuota < 0) throw new HttpError(400, "Cuota inválida")
  await clientePorSlug(p.slug, estudioId)
  await q(db().from("clientes").update({ cuota }).eq("slug", p.slug).eq("estudio_id", estudioId))
  return { ok: true, cuota }
}

const actualizarDatosCliente: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const update = elegir(await body(req), ["provincia", "iibb_modalidad", "en_relacion_dependencia", "tipo_actividad", "cuota"])
  if (!Object.keys(update).length) throw new HttpError(400, "Sin campos válidos")
  await clientePorSlug(p.slug, estudioId)
  await q(db().from("clientes").update(update).eq("slug", p.slug).eq("estudio_id", estudioId))
  return { ok: true }
}

function ultimosMeses(n: number) {
  const t = hoy()
  const meses: [number, number][] = []
  for (let i = 0; i < n; i++) {
    let m = t.m - i
    let y = t.y
    while (m <= 0) {
      m += 12
      y -= 1
    }
    meses.push([y, m])
  }
  return meses
}

const historialCuotas: Handler = async ({ req, p, query }) => {
  const estudioId = await getEstudioId(req)
  const meses = entero(query.get("meses") ?? "6", "meses")
  const cliente = await clientePorSlug(
    p.slug, estudioId,
    "id,categoria,provincia,iibb_modalidad,deuda_monto,deuda_descripcion,deuda_actualizada_at,deuda_detalle,art_deuda_monto,art_deuda_detalle,art_actualizada_at,art_regimen",
  )
  let filas: any[] = []
  try {
    filas = (await q(db().from("historial_cuotas").select("*").eq("cliente_id", cliente.id))) ?? []
  } catch {
    filas = []
  }
  const existentes = new Map(filas.map((r: any) => [`${r["año"]}-${r.mes}`, r]))
  const historial = ultimosMeses(meses).map(([y, m]) =>
    existentes.get(`${y}-${m}`) ?? { cliente_id: cliente.id, año: y, mes: m, pagado: false, fecha_pago: null, id: null },
  )
  const automatico = await tieneClaveFiscal(cliente.id)
  const art = automatico ? await deudaArtDe(cliente, filas) : null
  return {
    ok: true, historial, automatico,
    // Con clave fiscal: deuda real de ARCA (todos los períodos) y de ART Río Negro (real o estimada).
    deuda_arca: automatico && cliente.deuda_actualizada_at ? Number(cliente.deuda_monto) || 0 : null,
    deuda_actualizada_at: automatico ? cliente.deuda_actualizada_at : null,
    art_monto: art?.monto ?? null, art_real: art?.real ?? false, art_actualizada_at: art?.actualizada_at ?? null,
    art_detalle: art?.real ? cliente.art_deuda_detalle ?? [] : null, art_regimen: art?.real ? cliente.art_regimen : null,
    art_estimado: art && !art.real ? art.monto : null, art_por_mes: art && !art.real ? art.por_mes : null,
    deuda_detalle: automatico ? cliente.deuda_detalle ?? null : null,
    deuda_descripcion: automatico ? cliente.deuda_descripcion ?? null : null,
  }
}

const toggleHistorialCuota: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const anio = entero(p.anio, "anio")
  const mes = entero(p.mes, "mes")
  const data = await body(req)
  const filas = await q(db().from("clientes").select("id").eq("slug", p.slug).eq("estudio_id", estudioId).limit(1))
  if (!filas?.length) throw new HttpError(404, "Cliente no encontrado")
  if (await tieneClaveFiscal(filas[0].id)) throw new HttpError(409, SINCRONIZADO)
  const pagado = get(data, "pagado", true)
  const fechaPago = pagado ? ahoraIsoZ() : null
  try {
    await actualizarOInsertar("historial_cuotas", { pagado, fecha_pago: fechaPago }, { cliente_id: filas[0].id, año: anio, mes })
  } catch (e: any) {
    throw new HttpError(500, e?.message ?? String(e))
  }
  return { ok: true, pagado }
}

// ── Deuda manual ─────────────────────────────────────────────────────────────

const getDeudaManual: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const cliente = await clientePorSlug(p.slug, estudioId)
  const deudas = await q(
    db().from("deuda_manual").select("*").eq("cliente_id", cliente.id).eq("estudio_id", estudioId)
      .eq("pagado", false).order("created_at"),
  )
  return { ok: true, deudas: deudas ?? [] }
}

const agregarDeudaManual: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const data = await body(req)
  const organismo = data.organismo
  if (!["ARCA", "ART"].includes(organismo)) throw new HttpError(400, "Organismo inválido: debe ser ARCA o ART")
  const monto = Number(data.monto)
  if (!data.monto || !(monto > 0)) throw new HttpError(400, "Monto inválido")
  const cliente = await clientePorSlug(p.slug, estudioId)
  const filas = await q(
    db().from("deuda_manual").insert({
      cliente_id: cliente.id, organismo, monto, descripcion: get(data, "descripcion", ""),
      pagado: false, estudio_id: estudioId,
    }).select(),
  )
  return { ok: true, deuda: filas?.length ? filas[0] : null }
}

const pagarDeudaManual: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  await q(db().from("deuda_manual").update({ pagado: true, fecha_pago: ahoraIsoZ() }).eq("id", p.id).eq("estudio_id", estudioId))
  return { ok: true }
}

const eliminarDeudaManual: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  await q(db().from("deuda_manual").delete().eq("id", p.id).eq("estudio_id", estudioId))
  return { ok: true }
}

// ── Facturación y gastos ─────────────────────────────────────────────────────

const obtenerFacturacion: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const cliente = await clientePorSlug(p.slug, estudioId)
  return q(db().from("facturacion").select("*").eq("cliente_id", cliente.id).order("anio").order("mes"))
}

const cargarFacturacion: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const data = await body(req)
  const cliente = await clientePorSlug(p.slug, estudioId)
  for (const k of ["anio", "mes", "monto"]) if (!(k in data)) throw new HttpError(500, `Falta '${k}'`)
  const registro = {
    cliente_id: cliente.id, anio: data.anio, mes: data.mes, monto: data.monto,
    fuente: "manual", estudio_id: estudioId,
  }
  const filas = await q(db().from("facturacion").upsert(registro, { onConflict: "cliente_id,anio,mes" }).select())
  return { ok: true, data: filas }
}

async function importarExcelMensual(req: Request, slug: string, tabla: "facturacion" | "gastos", etiqueta: string) {
  const estudioId = await getEstudioId(req)
  const file = await archivo(req)
  const cliente = await clientePorSlug(slug, estudioId)
  let totales
  try {
    totales = totalesComprobantesPorMes(await bytes(file))
  } catch (e: any) {
    throw new HttpError(500, e?.message ?? String(e))
  }
  const registros = totales.map((t) => ({
    cliente_id: cliente.id, anio: t.anio, mes: t.mes, monto: t.monto,
    fuente: "arca_excel", estudio_id: estudioId,
  }))
  for (const r of registros) {
    await q(db().from(tabla).upsert(r, { onConflict: "cliente_id,anio,mes" }))
  }
  if (registros.length) await logActividad(cliente.id, `${etiqueta} — ${slug} — ${registros.length} meses`, estudioId)
  return { ok: true, meses_importados: registros.length, detalle: registros }
}

const importarComprobantes: Handler = ({ req, p }) =>
  importarExcelMensual(req, p.slug, "facturacion", "Importación ARCA")

const importarGastos: Handler = ({ req, p }) =>
  importarExcelMensual(req, p.slug, "gastos", "Importación gastos ARCA")

const gastosCliente: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const cliente = await clientePorSlug(p.slug, estudioId)
  return (await q(db().from("gastos").select("*").eq("cliente_id", cliente.id).order("anio").order("mes"))) ?? []
}

// ── Portal del cliente (sin login de admin) ──────────────────────────────────

const portalMarcarPago: Handler = async ({ req, p }) => {
  await exigirSesionPortal(req, p.slug)
  const filas = await q(db().from("clientes").select("id,nombre,apellido,estudio_id").eq("slug", p.slug))
  if (!filas?.length) throw new HttpError(404, "Cliente no encontrado")
  const cliente = filas[0]
  if (await tieneClaveFiscal(cliente.id)) throw new HttpError(409, SINCRONIZADO)
  const t = hoy()
  try {
    await actualizarOInsertar(
      "historial_cuotas", { pagado: true, fecha_pago: ahoraIsoZ() }, { cliente_id: cliente.id, año: t.y, mes: t.m },
    )
  } catch (e: any) {
    throw new HttpError(500, e?.message ?? String(e))
  }
  const nombre = `${cliente.nombre ?? ""} ${cliente.apellido ?? ""}`.trim()
  await logActividad(cliente.id, `Cuota ${t.m}/${t.y} marcada al día desde el portal — ${nombre}`, cliente.estudio_id)
  return { ok: true, estado_cuota: "al_dia" }
}

// Períodos vencidos con saldo de un detalle de deuda (CCMA o ART), como "09/2026".
function periodosVencidos(detalle: unknown, hoyStr: string): string[] {
  if (!Array.isArray(detalle)) return []
  return detalle
    .filter((p: any) => p?.periodo && (p.a_vencer === undefined ? !(p.vencimiento && p.vencimiento >= hoyStr) : !p.a_vencer))
    .map((p: any) => `${String(p.periodo).slice(5, 7)}/${String(p.periodo).slice(0, 4)}`)
}

const listaCorta = (xs: string[]) => (xs.length <= 4 ? xs.join(", ") : `${xs.slice(0, 3).join(", ")} y ${xs.length - 3} más`)

type DeudaPortal = { organismo: string; monto: number; descripcion: string; fecha: string | null; fuente: string; estimado?: boolean }

async function deudasPortal(cliente: any, arcaAuto: boolean, historial: any[], manuales: any[], hoyStr: string): Promise<DeudaPortal[]> {
  const deudas: DeudaPortal[] = []
  let arcaLeida = false
  let artReal = false
  if (arcaAuto && cliente.deuda_actualizada_at) {
    arcaLeida = true
    const ps = periodosVencidos(cliente.deuda_detalle, hoyStr)
    deudas.push({
      organismo: "ARCA", monto: Number(cliente.deuda_monto) || 0, fecha: cliente.deuda_actualizada_at, fuente: "arca",
      descripcion: ps.length ? `Monotributo: ${ps.length} ${ps.length === 1 ? "período" : "períodos"} con deuda (${listaCorta(ps)}), con intereses` : "Monotributo al día",
    })
    const art = await deudaArtDe(cliente, historial)
    artReal = art.real
    if (art.real) {
      const pa = periodosVencidos(cliente.art_deuda_detalle, hoyStr)
      deudas.push({
        organismo: "ART", monto: art.monto, fecha: art.actualizada_at, fuente: "art",
        descripcion: pa.length ? `Ingresos Brutos Río Negro: ${pa.length} ${pa.length === 1 ? "anticipo" : "anticipos"} con deuda (${listaCorta(pa)}), con intereses` : "Ingresos Brutos Río Negro al día",
      })
    } else if (art.monto > 0) {
      deudas.push({
        organismo: "ART", monto: art.monto, fecha: cliente.deuda_actualizada_at, fuente: "art", estimado: true,
        descripcion: "Ingresos Brutos Río Negro (estimado: no figura en ARCA)",
      })
    }
  }
  // La deuda manual de ARCA o ART no se suma cuando ese organismo ya viene leído de forma automática.
  for (const x of manuales) {
    if ((x.organismo === "ARCA" && arcaLeida) || (x.organismo === "ART" && artReal)) continue
    deudas.push({
      organismo: x.organismo || "Otro", monto: Number(x.monto) || 0, fecha: x.created_at ?? null, fuente: "manual",
      descripcion: x.descripcion || "Deuda registrada por tu contador",
    })
  }
  return deudas
}

const situacionDe = (c: any) => ({
  categoria_arca: c.categoria_arca ?? null, estado_arca: c.estado_arca ?? null,
  ultima_verificacion_arca: c.ultima_verificacion_arca ?? null,
  difiere: !!c.categoria_arca && !!c.categoria && String(c.categoria_arca).toUpperCase() !== String(c.categoria).toUpperCase(),
})

// Categoría y estado según ARCA (constancia A5; si no responde, el estado del padrón A13). La categoría
// de ARCA se guarda aparte de la del sistema: si no coinciden, queda una alerta para el contador.
async function verificarSituacionArca(cliente: any) {
  let categoria: string | null = null
  let estado: string | null = null
  try {
    const datos = await buscarEnConstancia(cliente.cuit)
    categoria = /^[A-K]$/.test(datos.categoria) ? datos.categoria : null
    estado = datos.estado || null
  } catch {
    estado = (await buscarEnPadron(cliente.cuit)).estado || null
  }
  const cambios: Record<string, unknown> = { estado_arca: estado, ultima_verificacion_arca: ahoraIsoZ() }
  if (categoria) cambios.categoria_arca = categoria
  await q(db().from("clientes").update(cambios).eq("id", cliente.id))
  const actual = { ...cliente, ...cambios }
  const situacion = situacionDe(actual)
  if (situacion.difiere) {
    const titulo = `Categoría en ARCA: ${actual.categoria_arca} (en el sistema: ${String(cliente.categoria).toUpperCase()})`
    const ya = await q(db().from("alertas").select("id").eq("cliente_id", cliente.id).eq("titulo", titulo).eq("leida", false))
    if (!ya?.length) {
      await q(db().from("alertas").insert({
        cliente_id: cliente.id, estudio_id: cliente.estudio_id, tipo: "arca", icono: "⚠️", leida: false, titulo,
        descripcion: "La categoría que informa ARCA no coincide con la cargada en el sistema. Revisá si hubo una recategorización.",
      })).catch(() => {})
    }
  }
  return situacion
}

async function respuestaConstancia(cuit: string) {
  let datos
  try {
    datos = await constanciaCompleta(cuit)
  } catch (e: any) {
    throw new HttpError(503, `ARCA no devolvió la constancia en este momento: ${e?.message ?? e}`)
  }
  const pdf = await pdfConstancia(datos, new Date())
  return new Response(pdf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="constancia-inscripcion-${cuit}.pdf"`,
      "Cache-Control": "no-store",
    },
  })
}

const desdeHace12 = (anio: number, mes: number, ref: { y: number; m: number }) =>
  anio > ref.y - 1 || (anio === ref.y - 1 && mes >= ref.m)

const datosPortal: Handler = async ({ req, p }) => {
  await exigirSesionPortal(req, p.slug)
  const d = db()
  const clientes = await q(d.from("clientes").select("*").eq("slug", p.slug))
  if (!clientes?.length) throw new HttpError(404, "Cliente no encontrado")
  const { portal_password: _, ...cliente } = clientes[0]
  const topes = await q(d.from("topes_categoria").select("*").eq("categoria", cliente.categoria ?? ""))
  const tope = topes?.length ? topes[0].tope_anual : 0
  const [fac, planes, docs, gastosTodos, alertas] = await Promise.all([
    q(d.from("facturacion").select("*").eq("cliente_id", cliente.id).order("anio").order("mes")),
    q(d.from("planes_pago").select("*").eq("cliente_id", cliente.id).eq("estado", "activo")),
    q(d.from("documentos").select("*").eq("cliente_id", cliente.id).order("created_at", { ascending: false })),
    q(d.from("gastos").select("*").eq("cliente_id", cliente.id).order("anio").order("mes")),
    q(d.from("alertas").select("*").eq("cliente_id", cliente.id).eq("leida", false)),
  ])

  let novedades: any[] = []
  try {
    const nov = await q(
      d.from("novedades").select("*").eq("activa", true).eq("estudio_id", cliente.estudio_id)
        .order("created_at", { ascending: false }),
    )
    novedades = (nov ?? []).filter((n: any) => n.para_todos || String(n.cliente_id) === String(cliente.id))
  } catch {
    novedades = []
  }

  const estudio = cliente.estudio_id
    ? await q(d.from("estudios").select("id,nombre,logo_url,color_primario,estado").eq("id", cliente.estudio_id).maybeSingle()).catch(() => null)
    : null

  let cfg: Record<string, string> = {}
  try {
    const filas = await q(
      d.from("configuracion").select("clave,valor").in("clave", ["whatsapp_estudio", "cm05_vencimiento"]).eq("estudio_id", cliente.estudio_id ?? ""),
    )
    cfg = Object.fromEntries((filas ?? []).map((r: any) => [r.clave, r.valor]))
  } catch {
    cfg = {}
  }

  const t = hoy()
  let pagadosDb: Set<string> | null = null
  let historialFilas: any[] = []
  try {
    historialFilas = (await q(d.from("historial_cuotas").select("*").eq("cliente_id", cliente.id))) ?? []
    pagadosDb = new Set(historialFilas.filter((h: any) => h.pagado).map((h: any) => `${h["año"]}-${h.mes}`))
  } catch {
    historialFilas = []
  }

  // Deuda por organismo: ARCA (CCMA) y ART Río Negro salen solas cuando hay clave fiscal; a eso se
  // suma la que carga el contador. Sin clave fiscal solo se muestra la manual.
  const arcaAuto = await tieneClaveFiscal(cliente.id)
  const deudasMan: any[] = (await q(d.from("deuda_manual").select("*").eq("cliente_id", cliente.id).neq("pagado", true)).catch(() => [])) ?? []
  const deudas = await deudasPortal(cliente, arcaAuto, historialFilas, deudasMan, isoDate(t.y, t.m, t.d))
  const deudaTotal = Math.round(deudas.reduce((s, x) => s + x.monto, 0) * 100) / 100
  const deudaDesc = deudas.filter((x) => x.monto > 0).map((x) => `${x.organismo}: ${pesos(x.monto)}`).join(" · ") || null
  const deudaDe = (org: string) => deudas.filter((x) => x.organismo === org).reduce((s, x) => s + x.monto, 0)

  // "Emitir factura" en el portal: estudio habilitado y cliente con la facturación configurada.
  const facturacionElectronica = await facturacionDisponible(cliente).catch(() => false)

  const jurisdicciones = cliente.iibb_modalidad === "convenio_multilateral"
    ? (await q(d.from("cliente_jurisdicciones").select("jurisdiccion,nro_inscripcion,alicuota,coeficiente,es_sede")
      .eq("cliente_id", cliente.id).eq("activo", true).order("es_sede", { ascending: false }).order("jurisdiccion"))) ?? []
    : []

  // Estado de la cuota del mes según historial_cuotas (no el campo manual)
  let estadoCuota = "pendiente"
  if (pagadosDb) {
    if (pagadosDb.has(`${t.y}-${t.m}`)) estadoCuota = "al_dia"
    else if (t.d > 20) estadoCuota = "vencida"
  }

  const facturacion = fac ?? []
  const montos12 = facturacion
    .filter((f: any) => (f.monto ?? 0) > 0 && desdeHace12(f.anio, f.mes, t))
    .map((f: any) => f.monto)
  const totalFac = montos12.reduce((a: number, b: number) => a + b, 0)
  const mesesCargados = montos12.length || 1
  const pct = tope > 0 ? Math.min(totalFac / tope, 1.05) : 0
  const gastos12 = (gastosTodos ?? []).filter((g: any) => desdeHace12(g.anio, g.mes, t))
  const totalGastos = gastos12.reduce((a: number, g: any) => a + (g.monto || 0), 0)

  let ultimaRecat: any = null
  try {
    const r = await q(d.from("recategorizaciones").select("*").eq("cliente_id", cliente.id).order("fecha", { ascending: false }).limit(1))
    ultimaRecat = r?.length ? r[0] : null
  } catch {
    ultimaRecat = null
  }
  const hoyStr = isoDate(t.y, t.m, t.d)
  const ventanas: [string, string][] = [
    [isoDate(t.y, 1, 20), isoDate(t.y, 2, 5)],
    [isoDate(t.y, 7, 20), isoDate(t.y, 8, 5)],
  ]
  const ventana = ventanas.find(([a, b]) => a <= hoyStr && hoyStr <= b)
  let recatPendiente = false
  if (ventana) recatPendiente = ultimaRecat ? String(ultimaRecat.fecha).slice(0, 10) < ventana[0] : true

  return {
    cliente, tope, facturacion,
    total_fac: totalFac, promedio: totalFac / mesesCargados,
    pct, planes: planes ?? [],
    documentos: docs ?? [], alertas: alertas ?? [],
    novedades, whatsapp: cfg.whatsapp_estudio ?? null,
    deudas, deuda_total: deudaTotal, deuda_desc: deudaDesc, deuda_automatica: arcaAuto,
    deuda_art: deudaDe("ART"), deuda_arca: deudaDe("ARCA"),
    situacion_arca: situacionDe(cliente),
    facturacion_electronica: facturacionElectronica,
    estado_cuota: estadoCuota,
    ultima_recat: ultimaRecat, recat_pendiente: recatPendiente,
    gastos: gastos12, total_gastos: totalGastos,
    arca_auto: arcaAuto, jurisdicciones, cm05_vencimiento: cfg.cm05_vencimiento ?? null,
    // Marca blanca: logo, nombre y color del estudio.
    estudio_id: cliente.estudio_id ?? null, estudio: estudio ? marcaDe(estudio) : null,
    logo_url: estudio?.logo_url ?? null, color_primario: estudio ? marcaDe(estudio).color_primario : COLOR_POR_DEFECTO,
    estudio_suspendido: !!estudio && !ESTADOS_HABILITADOS.includes(estudio.estado),
  }
}

// Botón "Actualizar desde ARCA" de la tarjeta de situación fiscal del portal.
const portalVerificarArca: Handler = async ({ req, p }) => {
  await exigirSesionPortal(req, p.slug)
  const cliente = await q(db().from("clientes")
    .select("id,cuit,categoria,estudio_id,categoria_arca,estado_arca,ultima_verificacion_arca").eq("slug", p.slug).single())
  // Una consulta por minuto alcanza: evita repetir el pedido a ARCA con cada clic.
  const ultima = cliente.ultima_verificacion_arca ? Date.parse(cliente.ultima_verificacion_arca) : 0
  if (Date.now() - ultima < 60_000) return { ok: true, ...situacionDe(cliente) }
  try {
    return { ok: true, ...(await verificarSituacionArca(cliente)) }
  } catch {
    throw new HttpError(503, "ARCA no responde en este momento. Probá de nuevo en unos minutos.")
  }
}

const portalConstancia: Handler = async ({ req, p }) => {
  await exigirSesionPortal(req, p.slug)
  const cliente = await q(db().from("clientes").select("cuit").eq("slug", p.slug).single())
  return respuestaConstancia(cliente.cuit)
}

const constanciaPdf: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const cliente = await clientePorSlug(p.slug, estudioId, "id,cuit")
  return respuestaConstancia(cliente.cuit)
}

// El cliente sube un comprobante a su bóveda (por ejemplo, la factura que emitió en ARCA).
// Las funciones de Netlify aceptan pedidos de hasta 6 MB: se limita a 4 MB por archivo.
const TIPOS_SUBIDA: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }

const portalSubirDocumento: Handler = async ({ req, p }) => {
  await exigirSesionPortal(req, p.slug)
  const cliente = await q(db().from("clientes").select("id,estudio_id").eq("slug", p.slug).single())
  const form = await formulario(req)
  const adjunto = form.get("archivo")
  if (!esArchivo(adjunto) || !adjunto.name) throw new HttpError(422, "Elegí un archivo")
  // Algunos navegadores no informan el tipo: se deduce de la extensión.
  const porExtension: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }
  const tipo = TIPOS_SUBIDA[adjunto.type] ? adjunto.type : porExtension[adjunto.name.split(".").pop()?.toLowerCase() ?? ""] ?? ""
  const ext = TIPOS_SUBIDA[tipo]
  if (!ext) throw new HttpError(415, "Solo se aceptan PDF o imágenes (JPG o PNG)")
  if (adjunto.size > 4 * 1024 * 1024) throw new HttpError(413, "El archivo supera los 4 MB")
  const nombreForm = form.get("nombre")
  const nombre = (typeof nombreForm === "string" && nombreForm.trim() ? nombreForm.trim() : adjunto.name).slice(0, 120)
  const ruta = `${cliente.id}/${randomUUID()}.${ext}`
  const storage = db().storage.from(BUCKET_DOCS)
  const { error } = await storage.upload(ruta, await bytes(adjunto), { contentType: tipo })
  if (error) throw new HttpError(500, `No se pudo subir el archivo: ${error.message}`)
  const doc = {
    cliente_id: cliente.id, estudio_id: cliente.estudio_id, tipo: "comprobante", nombre, fecha: hoyIso(),
    url: storage.getPublicUrl(ruta).data.publicUrl, subido_por_cliente: true,
  }
  const filas = await q(db().from("documentos").insert(doc).select())
  await logActividad(cliente.id, `El cliente subió "${nombre}" a su bóveda`, cliente.estudio_id)
  return { ok: true, documento: filas?.[0] ?? doc }
}

async function clientePorCuit(cuit: string, cols: string) {
  const { data, error } = await db().from("clientes").select(cols).eq("cuit", cuit).single()
  return error || !data ? null : (data as any)
}

const portalLogin: Handler = async ({ req }) => {
  const data = await body(req)
  const cuit = soloDigitos(get(data, "cuit", ""))
  const password = get(data, "password", "")
  if (!cuit || !password) return { ok: false, error: "CUIT y contraseña requeridos" }
  const cliente = await clientePorCuit(cuit, "id,slug,nombre,apellido,activo,portal_password,cuit,estudio_id")
  if (!cliente) return { ok: false, error: "Credenciales incorrectas" }
  if (password !== (cliente.portal_password || cuit)) return { ok: false, error: "Credenciales incorrectas" }
  const estudio = cliente.estudio_id
    ? await q(db().from("estudios").select("id,nombre,logo_url,color_primario,estado").eq("id", cliente.estudio_id).maybeSingle()).catch(() => null)
    : null
  // Con el estudio suspendido el portal de sus clientes queda en pausa.
  const suspendido = !!estudio && !ESTADOS_HABILITADOS.includes(estudio.estado)
  return {
    ok: true, slug: cliente.slug, nombre: cliente.nombre ?? "", apellido: cliente.apellido ?? "",
    activo: (cliente.activo ?? true) && !suspendido, token: await firmarTokenPortal(cliente.slug, cliente.id),
    marca: estudio ? marcaDe(estudio) : null,
  }
}

const portalCambiarPassword: Handler = async ({ req }) => {
  const data = await body(req)
  const cuit = soloDigitos(get(data, "cuit", ""))
  const actual = get(data, "password_actual", "")
  const nueva = get(data, "password_nueva", "")
  if (!cuit || !actual || !nueva) return { ok: false, error: "Datos incompletos" }
  const cliente = await clientePorCuit(cuit, "id,portal_password,cuit")
  if (!cliente) return { ok: false, error: "Credenciales incorrectas" }
  if (actual !== (cliente.portal_password || cuit)) return { ok: false, error: "Contraseña actual incorrecta" }
  await q(db().from("clientes").update({ portal_password: nueva }).eq("id", cliente.id))
  return { ok: true }
}

// ── Planes de pago ───────────────────────────────────────────────────────────

const listarTodosPlanes: Handler = async ({ req }) => {
  const estudioId = await getEstudioId(req)
  return (await q(db().from("planes_pago").select("*").eq("estudio_id", estudioId).eq("estado", "activo").order("proximo_venc"))) ?? []
}

const planesCliente: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const cliente = await clientePorSlug(p.slug, estudioId)
  return (await q(
    db().from("planes_pago").select("*").eq("cliente_id", cliente.id).eq("estudio_id", estudioId)
      .order("created_at", { ascending: false }),
  )) ?? []
}

const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`

function fechaDdmm(s: string): string | null {
  const [d, m, y] = s.split("/").map(Number)
  return fechaValida(y, m, d) ? isoDate(y, m, d) : null
}

// PDF de "Mis Facilidades" de ARCA → datos del plan
const parsearPdfPlan: Handler = async ({ req }) => {
  const file = await archivo(req)
  const texto = await pdfTexto(await bytes(file))
  const result: Record<string, unknown> = { organismo: "ARCA" }

  let m = texto.match(/N.{0,4}mero\s+de\s+Plan[:\s]+([A-Z0-9-]+)/i)
  if (m) result.numero_plan = m[1].trim()
  m = texto.match(/[Ff]h?\.?\s*de\s+Consolidaci.{0,4}n[:\s]+(\d{2}\/\d{2}\/\d{4})/)
  if (m) result.fecha_consolidacion = m[1].trim()

  const hoyStr = hoyIso()
  type Venc = { num?: number; total: number | null; fecha: string }

  // 1er vencimiento: "N  capital  interesF  -  total  dd/mm/yyyy"
  const primeros: Venc[] = []
  for (const x of texto.matchAll(/^(\d{1,3})\s+([\d.,]+)\s+([\d.,]+)\s+[-–]\s+([\d.,]+)\s+(\d{2}\/\d{2}\/\d{4})/gm)) {
    const fecha = fechaDdmm(x[5])
    if (fecha) primeros.push({ num: parseInt(x[1], 10), total: parseArNumber(x[4]), fecha })
  }
  // 2do vencimiento: "interesF  interesR  total  dd/mm/yyyy"
  const segundos: Venc[] = []
  for (const x of texto.matchAll(/^([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+(\d{2}\/\d{2}\/\d{4})/gm)) {
    const fecha = fechaDdmm(x[4])
    if (fecha) segundos.push({ total: parseArNumber(x[3]), fecha })
  }

  if (primeros.length) {
    result.total_cuotas = Math.max(...primeros.map((r) => r.num!))
    result.cuotas_pagas = primeros.filter((r) => r.fecha < hoyStr).length
    const proximos = [...primeros, ...segundos].filter((r) => r.fecha >= hoyStr).sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0))
    if (proximos.length) result.proximo_venc = ddmmyyyy(proximos[0].fecha)
    result.monto_primer_venc = primeros[0].total
    if (segundos.length) result.monto_segundo_venc = segundos[0].total
  } else {
    result.cuotas_pagas = (texto.match(/Cuota\s+Cancelada/gi) ?? []).length
    const totalCuotas = (texto.match(/Cuota\s+(?:Cancelada|a\s+Vencer)/gi) ?? []).length
    if (totalCuotas > 0) result.total_cuotas = totalCuotas
    const vencimientos: { fecha: string; monto: number | null }[] = []
    for (const x of texto.matchAll(/(\d{2}\/\d{2}\/\d{4})\s+([\d.,]+)\s+([\d.,]+)\s+Cuota a Vencer/gi)) {
      const fecha = fechaDdmm(x[1])
      if (fecha && fecha >= hoyStr) vencimientos.push({ fecha, monto: parseArNumber(x[3]) })
    }
    vencimientos.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0))
    if (vencimientos.length) {
      result.proximo_venc = ddmmyyyy(vencimientos[0].fecha)
      result.monto_primer_venc = vencimientos[0].monto
      if (vencimientos.length > 1) result.monto_segundo_venc = vencimientos[1].monto
    }
  }
  return { ok: true, ...result }
}

const crearPlan: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const data = await body(req)
  const cliente = await clientePorSlug(p.slug, estudioId)
  const total = data.total_cuotas ?? null
  const pagas = get(data, "cuotas_pagas", 0)
  const impagas = total !== null ? parseInt(String(total), 10) - parseInt(String(pagas), 10) : (data.cuotas_impagas ?? null)
  const plan = sinNulos({
    cliente_id: cliente.id,
    estudio_id: estudioId,
    numero_plan: data.numero_plan,
    organismo: get(data, "organismo", "ARCA"),
    fecha_consolidacion: data.fecha_consolidacion || null,
    total_cuotas: total,
    cuotas_pagas: pagas,
    cuotas_impagas: impagas,
    monto_primer_venc: data.monto_primer_venc,
    monto_segundo_venc: data.monto_segundo_venc,
    proximo_venc: data.proximo_venc || null,
    url_pdf: data.url_pdf,
    estado: "activo",
  })
  const { data: filas, error } = await db().from("planes_pago").insert(plan).select()
  if (error) throw new HttpError(500, `Error al guardar plan: ${error.message}`)
  return { ok: true, data: filas }
}

async function planDelEstudio(planId: string, estudioId: string) {
  const { data, error } = await db().from("planes_pago").select("*").eq("id", planId).eq("estudio_id", estudioId).single()
  if (error || !data) throw new HttpError(404, "Plan no encontrado")
  return data as any
}

const marcarCuotaPagada: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const plan = await planDelEstudio(p.id, estudioId)
  const nuevasPagas = (plan.cuotas_pagas || 0) + 1
  const total = plan.total_cuotas || 0
  const impagas = Math.max(0, (plan.cuotas_impagas || 0) - 1)
  const nuevoEstado = total > 0 && nuevasPagas >= total ? "cancelado" : "activo"
  const update: Record<string, unknown> = { cuotas_pagas: nuevasPagas, cuotas_impagas: impagas, estado: nuevoEstado }
  let nuevoVenc: string | null = null
  if (plan.proximo_venc && nuevoEstado === "activo" && esFechaIso(plan.proximo_venc)) {
    nuevoVenc = sumarMeses(plan.proximo_venc, 1)
    update.proximo_venc = nuevoVenc
  }
  await q(db().from("planes_pago").update(update).eq("id", p.id))
  return { ok: true, cuotas_pagas: nuevasPagas, estado: nuevoEstado, proximo_venc: nuevoVenc }
}

const cambiarEstadoPlan: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const estado = (await body(req)).estado
  if (!["activo", "cancelado", "caido", "inactivo"].includes(estado)) throw new HttpError(400, "Estado inválido")
  const { error } = await db().from("planes_pago").update({ estado }).eq("id", p.id).eq("estudio_id", estudioId)
  if (error) throw new HttpError(500, `Error al actualizar estado: ${error.message}`)
  return { ok: true, estado }
}

const eliminarPlan: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  await q(db().from("planes_pago").update({ estado: "inactivo" }).eq("id", p.id).eq("estudio_id", estudioId))
  return { ok: true }
}

const cuotasPlan: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const plan = await q(db().from("planes_pago").select("id").eq("id", p.id).eq("estudio_id", estudioId))
  if (!plan?.length) throw new HttpError(404, "Plan no encontrado")
  const cuotas = await q(db().from("planes_pago_cuotas").select("*").eq("plan_id", p.id).order("numero_cuota"))
  return { ok: true, cuotas: cuotas ?? [] }
}

const inicializarCuotas: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const plan = await planDelEstudio(p.id, estudioId)
  const total = plan.total_cuotas || 0
  if (total <= 0) throw new HttpError(400, "El plan no tiene total_cuotas definido")
  const pagas = plan.cuotas_pagas || 0
  const t = hoy()
  const base = esFechaIso(plan.proximo_venc) ? plan.proximo_venc : isoDate(t.y, t.m, 16)
  const cuotas = []
  for (let i = 1; i <= total; i++) {
    cuotas.push({
      plan_id: p.id,
      numero_cuota: i,
      monto_primer_venc: plan.monto_primer_venc ?? null,
      monto_segundo_venc: plan.monto_segundo_venc ?? null,
      fecha_venc: sumarMeses(base, i - (pagas + 1)),
      pagado_primer_venc: false,
      pagado_segundo_venc: false,
      fecha_pago: null,
    })
  }
  try {
    await q(db().from("planes_pago_cuotas").delete().eq("plan_id", p.id))
    await q(db().from("planes_pago_cuotas").insert(cuotas))
    await q(db().from("planes_pago").update({ cuotas_pagas: 0 }).eq("id", p.id))
  } catch (e: any) {
    throw new HttpError(500, `Error al inicializar cuotas: ${e?.message ?? e}`)
  }
  return { ok: true, cuotas }
}

const pagarCuotaIndividual: Handler = async ({ req, p }) => {
  await getEstudioId(req)
  const numero = entero(p.numero, "numero_cuota")
  const vencimiento = get(await body(req), "vencimiento", "1ro")
  if (!["1ro", "2do"].includes(vencimiento)) throw new HttpError(400, "vencimiento debe ser '1ro' o '2do'")
  const update: Record<string, unknown> =
    vencimiento === "1ro" ? { pagado_primer_venc: true, pagado_segundo_venc: false } : { pagado_segundo_venc: true }
  update.fecha_pago = ahoraIsoZ()
  await q(db().from("planes_pago_cuotas").update(update).eq("plan_id", p.id).eq("numero_cuota", numero))
  let cuotas: any[] = []
  try {
    cuotas = (await q(db().from("planes_pago_cuotas").select("*").eq("plan_id", p.id).order("numero_cuota"))) ?? []
  } catch {
    cuotas = []
  }
  const pagada = (c: any) => c.pagado_primer_venc || c.pagado_segundo_venc
  const pagas = cuotas.filter(pagada).length
  const total = cuotas.length
  const nuevoEstado = total > 0 && pagas >= total ? "cancelado" : "activo"
  const proximoVenc = cuotas.find((c) => !pagada(c) && c.fecha_venc)?.fecha_venc ?? null
  const planUpdate: Record<string, unknown> = { cuotas_pagas: pagas, estado: nuevoEstado }
  if (proximoVenc) planUpdate.proximo_venc = proximoVenc
  await db().from("planes_pago").update(planUpdate).eq("id", p.id)
  return { ok: true, cuotas_pagas: pagas, proximo_venc: proximoVenc, estado: nuevoEstado }
}

// ── Topes y tablas de configuración ──────────────────────────────────────────

const actualizarTope: Handler = async ({ req, p }) => {
  await getEstudioId(req)
  const update = elegir(await body(req), ["tope_anual", "cuota_servicios", "cuota_bienes", "vigente_desde"])
  if (!Object.keys(update).length) throw new HttpError(400, "Sin campos válidos")
  await q(db().from("topes_categoria").update(update).eq("categoria", p.categoria.toUpperCase()))
  return { ok: true }
}

const primeraLinea = (v: unknown) => String(v ?? "").trim().toUpperCase().split("\n")[0].trim()
const textoCelda = (v: unknown) => (v === null || v === undefined ? "NAN" : String(v).trim().toUpperCase())
const detectar = (encabezados: string[], ...claves: string[]) => {
  for (const k of claves) {
    const j = encabezados.findIndex((h) => h.toLowerCase().includes(k))
    if (j >= 0) return j
  }
  return null
}
const columnaQue = (columnas: string[], ...claves: string[]) =>
  columnas.find((c) => claves.some((k) => c.toLowerCase().includes(k))) ?? null

type Tope = { categoria: string; [k: string]: number | string | null }

function primeraPorCategoria<T extends { categoria: string }>(filas: T[]) {
  const vistos = new Map<string, T>()
  for (const r of filas) if (!vistos.has(r.categoria)) vistos.set(r.categoria, r)
  return vistos
}

const importarTopes: Handler = async ({ req }) => {
  await getEstudioId(req)
  const file = await archivo(req)
  const nombre = (file.name || "").toLowerCase()
  const buf = await bytes(file)
  const resultados: Tope[] = []

  if (nombre.endsWith(".pdf")) {
    for (const tabla of await pdfTablas(buf)) {
      if (tabla.length < 2) continue
      let colCat: number | null = null, colTope: number | null = null, colServ: number | null = null, colBienes: number | null = null
      let headerIdx: number | null = null
      for (let i = 0; i < tabla.length; i++) {
        const rowL = tabla[i].map((c) => String(c ?? "").toLowerCase())
        if (rowL.some((c) => c.includes("categor"))) {
          headerIdx = i
          rowL.forEach((h, j) => {
            if (h.includes("categor")) colCat = j
            else if (h.includes("ingreso")) colTope = j
            else if (h.includes("locacion") || h.includes("servicio")) colServ = j
            else if (h.includes("mueble") || h.includes("bienes")) colBienes = j
          })
          break
        }
      }
      if (headerIdx === null || colCat === null) continue
      for (const row of tabla.slice(headerIdx + 1)) {
        if (row.length <= colCat) continue
        const cat = primeraLinea(row[colCat])
        if (!esCat(cat)) continue
        const celda = (c: number | null) => (c !== null && row.length > c ? row[c] : null)
        resultados.push({
          categoria: cat,
          tope_anual: parseArNumber(celda(colTope)),
          cuota_servicios: parseArNumber(celda(colServ)),
          cuota_bienes: parseArNumber(celda(colBienes)),
        })
      }
    }
  } else if (nombre.endsWith(".xlsx") || nombre.endsWith(".xls")) {
    const { columnas, filas } = leerExcel(buf)
    let colCat: string | null = null, colTope: string | null = null, colServ: string | null = null, colBienes: string | null = null
    for (const col of columnas) {
      const cl = col.toLowerCase()
      if (cl.includes("categor")) colCat = col
      else if (cl.includes("ingreso")) colTope = col
      else if (cl.includes("locacion") || cl.includes("servicio")) colServ = col
      else if (cl.includes("mueble") || cl.includes("bienes")) colBienes = col
    }
    if (colCat === null) {
      colCat = columnas.find((col) => filas.filter((f) => esCat(textoCelda(f[col]))).length >= 5) ?? null
      if (colCat) {
        const numericas = columnas.filter((c) => c !== colCat && filas.filter((f) => aNumero(f[c]) !== null).length >= 5)
        if (numericas.length >= 1) colTope = numericas[0]
        if (numericas.length >= 2) colServ = numericas[1]
        if (numericas.length >= 3) colBienes = numericas[2]
      }
    }
    if (colCat === null) throw new HttpError(400, "No se encontró columna de categorías A-K en el Excel")
    for (const fila of filas) {
      const cat = textoCelda(fila[colCat])
      if (!esCat(cat)) continue
      const num = (col: string | null) => (col === null ? null : aNumero(fila[col]))
      resultados.push({ categoria: cat, tope_anual: num(colTope), cuota_servicios: num(colServ), cuota_bienes: num(colBienes) })
    }
  } else {
    throw new HttpError(400, "Formato no soportado. Subí un PDF o Excel (.xlsx)")
  }

  if (!resultados.length) throw new HttpError(400, "No se encontraron categorías A-K en el archivo")
  const vistos = primeraPorCategoria(resultados)
  let actualizados = 0
  for (const [cat, r] of vistos) {
    const update = sinNulos({ tope_anual: r.tope_anual, cuota_servicios: r.cuota_servicios, cuota_bienes: r.cuota_bienes })
    if (Object.keys(update).length) {
      await q(db().from("topes_categoria").update(update).eq("categoria", cat))
      actualizados += 1
    }
  }
  return { ok: true, actualizados, categorias: [...vistos.keys()], detalle: [...vistos.values()] }
}

const PROVINCIAS: Record<string, string> = {
  componente_rio_negro: "Rio Negro",
  componente_neuquen: "Neuquen",
  componente_buenos_aires: "Buenos Aires",
}

function tipoActividad(v: string) {
  const t = v.toLowerCase()
  if (t.includes("bien") || t.includes("mueble")) return "bienes"
  if (t.includes("unico") || t.includes("único")) return "unico"
  return "servicios"
}

const importarTabla: Handler = async ({ req, p }) => {
  await getEstudioId(req)
  const tipo = p.tipo
  if (tipo !== "topes_nacionales" && !(tipo in PROVINCIAS)) throw new HttpError(400, `Tipo inválido: ${tipo}`)
  const file = await archivo(req)
  const nombre = (file.name || "").toLowerCase()
  const buf = await bytes(file)
  const esPdf = nombre.endsWith(".pdf")
  const esExcel = nombre.endsWith(".xlsx") || nombre.endsWith(".xls")

  if (tipo === "topes_nacionales") {
    const resultados: Tope[] = []
    if (esPdf) {
      for (const tabla of await pdfTablas(buf)) {
        if (tabla.length < 2) continue
        for (let i = 0; i < tabla.length; i++) {
          const hdr = tabla[i].map((c) => String(c ?? "").toLowerCase())
          if (!hdr.some((c) => c.includes("categor"))) continue
          const colCat = detectar(hdr, "categor")
          const colTope = detectar(hdr, "ingreso", "tope")
          const colIs = detectar(hdr, "locacion", "servicio")
          const colIb = detectar(hdr, "mueble", "bien")
          const colSipa = detectar(hdr, "sipa", "previsional", "jubil")
          const colOs = detectar(hdr, "obra social", "salud", "os")
          for (const row of tabla.slice(i + 1)) {
            if (row.length <= (colCat ?? 0)) continue
            const cat = primeraLinea(row[colCat!])
            if (!esCat(cat)) continue
            const g = (c: number | null) => (c !== null && row.length > c ? parseNumPuntos(row[c]) : null)
            resultados.push({
              categoria: cat, tope_anual: g(colTope), imp_integrado_servicios: g(colIs), imp_integrado_bienes: g(colIb),
              aportes_sipa: g(colSipa), obra_social: g(colOs),
            })
          }
          break
        }
      }
    } else if (esExcel) {
      const { columnas, filas } = leerExcel(buf)
      const colCat = columnaQue(columnas, "categor")
      const colTope = columnaQue(columnas, "ingreso", "tope")
      const colIs = columnaQue(columnas, "locacion", "servicio")
      const colIb = columnaQue(columnas, "mueble", "bien")
      const colSipa = columnaQue(columnas, "sipa", "previsional", "jubil")
      const colOs = columnaQue(columnas, "obra", "salud")
      if (colCat === null) throw new HttpError(400, "No se encontró columna de categorías A-K")
      for (const fila of filas) {
        const cat = textoCelda(fila[colCat])
        if (!esCat(cat)) continue
        const g = (c: string | null) => (c ? aNumero(fila[c]) : null)
        resultados.push({
          categoria: cat, tope_anual: g(colTope), imp_integrado_servicios: g(colIs), imp_integrado_bienes: g(colIb),
          aportes_sipa: g(colSipa), obra_social: g(colOs),
        })
      }
    } else {
      throw new HttpError(400, "Formato no soportado. Subí PDF o Excel (.xlsx)")
    }
    if (!resultados.length) throw new HttpError(400, "No se encontraron categorías A-K en el archivo")
    const vistos = primeraPorCategoria(resultados)
    let actualizados = 0
    for (const [cat, r] of vistos) {
      const update = sinNulos({
        tope_anual: r.tope_anual, imp_integrado_servicios: r.imp_integrado_servicios,
        imp_integrado_bienes: r.imp_integrado_bienes, aportes_sipa: r.aportes_sipa, obra_social: r.obra_social,
      })
      if (Object.keys(update).length) {
        await q(db().from("topes_categoria").update(update).eq("categoria", cat))
        actualizados += 1
      }
    }
    return { ok: true, tipo, actualizados, categorias: [...vistos.keys()] }
  }

  const provincia = PROVINCIAS[tipo]
  const resultados: { categoria: string; tipo: string; monto: number; vigente_desde: string }[] = []
  if (esPdf) {
    for (const tabla of await pdfTablas(buf)) {
      if (tabla.length < 2) continue
      for (let i = 0; i < tabla.length; i++) {
        const hdr = tabla[i].map((c) => String(c ?? "").toLowerCase())
        if (!hdr.some((c) => c.includes("categor"))) continue
        const colCat = detectar(hdr, "categor")
        const colTipo = detectar(hdr, "tipo", "actividad")
        const colMonto = detectar(hdr, "monto", "cuota", "import")
        const colDesde = detectar(hdr, "desde", "vigente", "fecha")
        for (const row of tabla.slice(i + 1)) {
          if (row.length <= (colCat ?? 0)) continue
          const cat = primeraLinea(row[colCat!])
          if (!esCat(cat)) continue
          const g = (c: number | null) => (c !== null && row.length > c ? String(row[c]).trim() : null)
          const monto = parseNumPuntos(g(colMonto))
          const desde = g(colDesde) || hoyIso()
          if (monto) resultados.push({ categoria: cat, tipo: tipoActividad(g(colTipo) || "servicios"), monto, vigente_desde: desde.slice(0, 10) })
        }
        break
      }
    }
  } else if (esExcel) {
    const { columnas, filas } = leerExcel(buf)
    const colCat = columnaQue(columnas, "categor")
    const colTipo = columnaQue(columnas, "tipo", "actividad")
    const colMonto = columnaQue(columnas, "monto", "cuota", "import")
    const colDesde = columnaQue(columnas, "desde", "vigente", "fecha")
    if (colCat === null) throw new HttpError(400, "No se encontró columna de categorías A-K")
    for (const fila of filas) {
      const cat = textoCelda(fila[colCat])
      if (!esCat(cat)) continue
      const tipoVal = tipoActividad(String((colTipo ? fila[colTipo] : null) || "servicios"))
      const monto = colMonto ? aNumero(fila[colMonto]) : null
      const desde = (colDesde ? fechaExcelIso(fila[colDesde]) : null) ?? hoyIso()
      if (monto) resultados.push({ categoria: cat, tipo: tipoVal, monto, vigente_desde: desde })
    }
  } else {
    throw new HttpError(400, "Formato no soportado. Subí PDF o Excel (.xlsx)")
  }
  if (!resultados.length) throw new HttpError(400, "No se encontraron datos de componentes en el archivo")
  for (const r of resultados) {
    await actualizarOInsertar(
      "componentes_provinciales",
      { monto: r.monto, vigente_desde: r.vigente_desde },
      { provincia, categoria: r.categoria, tipo: r.tipo },
    )
  }
  return { ok: true, tipo, provincia, importados: resultados.length, detalle: resultados }
}

// ── Configuración ────────────────────────────────────────────────────────────

const obtenerConfiguracion: Handler = async ({ req }) => {
  const estudioId = await getEstudioId(req)
  const filas = await q(db().from("configuracion").select("clave,valor").eq("estudio_id", estudioId))
  const cfg: Record<string, unknown> = Object.fromEntries((filas ?? []).map((r: any) => [r.clave, r.valor]))
  if (!("nombre_estudio" in cfg)) {
    const est = await q(db().from("estudios").select("nombre").eq("id", estudioId).limit(1))
    if (est?.length) cfg.nombre_estudio = est[0].nombre
  }
  return cfg
}

const guardarConfiguracion: Handler = async ({ req }) => {
  const estudioId = await getEstudioId(req)
  const errors: string[] = []
  for (const [clave, valor] of Object.entries(await body(req))) {
    const val = valor === null || valor === undefined ? "" : pyStr(valor)
    try {
      await actualizarOInsertar("configuracion", { valor: val }, { clave, estudio_id: estudioId })
    } catch (e: any) {
      errors.push(`${clave}: ${e?.message ?? e}`)
      console.log(`[configuracion] Error guardando ${clave} para estudio ${estudioId}: ${e?.message ?? e}`)
    }
    // El nombre que muestran el admin, el portal y el superadmin es estudios.nombre.
    if (clave === "nombre_estudio" && String(valor ?? "").trim()) {
      await db().from("estudios").update({ nombre: String(valor).trim().slice(0, 80) }).eq("id", estudioId)
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true }
}

// ── Alertas ──────────────────────────────────────────────────────────────────

const alertasCliente: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const cliente = await clientePorSlug(p.slug, estudioId)
  const filas = (await q(
    db().from("alertas").select("*").eq("cliente_id", cliente.id).eq("estudio_id", estudioId)
      .order("created_at", { ascending: false }),
  )) ?? []
  // La tabla guarda titulo/descripcion; el admin muestra "mensaje".
  return filas.map((a: any) => ({ ...a, mensaje: [a.titulo, a.descripcion].filter(Boolean).join(" — ") }))
}

const crearAlerta: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const data = await body(req)
  const cliente = await clientePorSlug(p.slug, estudioId)
  const { data: filas, error } = await db().from("alertas").insert({
    cliente_id: cliente.id, tipo: get(data, "tipo", "manual"), titulo: get(data, "mensaje", "") || "Alerta",
    leida: false, estudio_id: estudioId,
  }).select()
  if (error) throw new HttpError(500, `Error al crear alerta: ${error.message}`)
  return { ok: true, data: filas }
}

const eliminarAlerta: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  await q(db().from("alertas").delete().eq("id", p.id).eq("estudio_id", estudioId))
  return { ok: true }
}

// ── Documentos ───────────────────────────────────────────────────────────────

const BUCKET_DOCS = "documentos-axenda"

const crearDocumento: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const form = await formulario(req)
  const tipo = form.get("tipo")
  if (typeof tipo !== "string") throw new HttpError(422, "Falta el campo 'tipo'")
  const nombre = form.get("nombre")
  const fecha = form.get("fecha")
  const adjunto = form.get("archivo")
  const cliente = await clientePorSlug(p.slug, estudioId)
  let url: string | null = null
  if (esArchivo(adjunto) && adjunto.name) {
    try {
      const ext = adjunto.name.includes(".") ? adjunto.name.split(".").pop()!.toLowerCase() : "pdf"
      const ruta = `${cliente.id}/${randomUUID()}.${ext}`
      const storage = db().storage.from(BUCKET_DOCS)
      const { error } = await storage.upload(ruta, await bytes(adjunto), { contentType: adjunto.type || "application/pdf" })
      if (error) throw error
      url = storage.getPublicUrl(ruta).data.publicUrl
    } catch (e: any) {
      throw new HttpError(500, `Error al subir archivo: ${e?.message ?? e}`)
    }
  }
  const doc = sinNulos({
    cliente_id: cliente.id,
    nombre: typeof nombre === "string" ? nombre : null,
    tipo,
    fecha: typeof fecha === "string" && fecha ? fecha : null,
    url,
    estudio_id: estudioId,
  })
  const { data: filas, error } = await db().from("documentos").insert(doc).select()
  if (error) throw new HttpError(500, `Error al guardar documento: ${error.message}`)
  return { ok: true, data: filas }
}

// ── Recategorizaciones ───────────────────────────────────────────────────────

const listarRecategorizaciones: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const cliente = await clientePorSlug(p.slug, estudioId)
  return (await q(db().from("recategorizaciones").select("*").eq("cliente_id", cliente.id).order("fecha", { ascending: false }))) ?? []
}

const registrarRecategorizacion: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const data = await body(req)
  const cliente = await clientePorSlug(p.slug, estudioId, "id,categoria")
  await q(db().from("recategorizaciones").insert(sinNulos({
    cliente_id: cliente.id,
    estudio_id: estudioId,
    fecha: data.fecha,
    categoria_anterior: data.categoria_anterior,
    categoria_nueva: data.categoria_nueva,
  })))
  if (data.categoria_nueva) {
    await q(db().from("clientes").update({ categoria: data.categoria_nueva }).eq("id", cliente.id))
  }
  return { ok: true }
}

// ── ARCA: clave fiscal y sincronización automática ───────────────────────────

const estadoArca: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const cliente = await clientePorSlug(
    p.slug, estudioId,
    "id,categoria,provincia,iibb_modalidad,estado_arca,categoria_arca,ultima_verificacion_arca,ultimos_comprobantes,deuda_monto,deuda_descripcion,deuda_actualizada_at,art_deuda_monto,art_actualizada_at,art_regimen",
  )
  const [cred, sincronizaciones, historial] = await Promise.all([
    q(db().from("credenciales_arca").select("actualizada_at").eq("cliente_id", cliente.id).maybeSingle()),
    q(db().from("sincronizaciones_arca").select("tipo,anio,mes,estado,detalle,created_at")
      .eq("cliente_id", cliente.id).order("created_at", { ascending: false }).limit(60)),
    q(db().from("historial_cuotas").select("año,mes,estado,fuente").eq("cliente_id", cliente.id)),
  ])
  const art = await deudaArtDe(cliente, historial ?? [])
  return {
    clave_cargada: !!cred, actualizada_at: cred?.actualizada_at ?? null, sincronizaciones: sincronizaciones ?? [],
    deuda: cliente.deuda_actualizada_at
      ? {
        monto: Number(cliente.deuda_monto) || 0, descripcion: cliente.deuda_descripcion,
        actualizada_at: cliente.deuda_actualizada_at, art_estimado: art.real ? 0 : art.monto,
      }
      : null,
    art: art.real ? { monto: art.monto, actualizada_at: art.actualizada_at, regimen: cliente.art_regimen } : null,
    situacion: {
      categoria: cliente.categoria, categoria_arca: cliente.categoria_arca, estado: cliente.estado_arca,
      actualizada_at: cliente.ultima_verificacion_arca, ultimos_comprobantes: cliente.ultimos_comprobantes,
    },
  }
}

const guardarClaveFiscal: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const clave = (await body(req)).clave
  if (typeof clave !== "string" || !clave || clave.length > 64) throw new HttpError(400, "Clave fiscal inválida")
  const cliente = await clientePorSlug(p.slug, estudioId)
  await actualizarOInsertar(
    "credenciales_arca",
    { clave_cifrada: cifrarClave(clave, cliente.id), estudio_id: estudioId, actualizada_at: ahoraIsoZ() },
    { cliente_id: cliente.id },
  )
  await logActividad(cliente.id, "Clave fiscal cargada para la sincronización con ARCA", estudioId)
  return { ok: true }
}

const borrarClaveFiscal: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const cliente = await clientePorSlug(p.slug, estudioId)
  await q(db().from("credenciales_arca").delete().eq("cliente_id", cliente.id).eq("estudio_id", estudioId))
  return { ok: true }
}

// "Actualizar desde ARCA": categoría y estado salen al instante del padrón (web service con el
// certificado del estudio); facturas, gastos, deuda, cuotas y últimos comprobantes los trae el robot.
const actualizarDesdeArca: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const cliente = await clientePorSlug(p.slug, estudioId, "id,cuit,categoria")

  let constancia: Record<string, unknown> | null = null
  let errorConstancia: string | null = null
  try {
    const datos = await buscarEnConstancia(cliente.cuit)
    const update: Record<string, unknown> = { estado_arca: datos.estado || null, ultima_verificacion_arca: ahoraIsoZ() }
    const nueva = /^[A-K]$/.test(datos.categoria) ? datos.categoria : null
    if (nueva) update.categoria_arca = nueva
    if (nueva && nueva !== cliente.categoria) update.categoria = nueva
    await q(db().from("clientes").update(update).eq("id", cliente.id))
    if (update.categoria) {
      await logActividad(cliente.id, `Categoría actualizada desde ARCA: ${cliente.categoria ?? "—"} → ${nueva}`, estudioId)
    }
    constancia = {
      categoria: nueva ?? cliente.categoria, estado: datos.estado || null,
      categoria_cambio: !!update.categoria, categoria_anterior: cliente.categoria ?? null,
    }
  } catch (e: any) {
    errorConstancia = String(e?.message ?? e)
  }

  const robot = await tieneClaveFiscal(cliente.id)
  if (robot) {
    const { anio, mes } = finPeriodoProximaRecategorizacion()
    await despacharSincronizacion(new URL(req.url).origin, cliente.id, anio, mes, TAREAS)
  }
  return { ok: true, constancia, error_constancia: errorConstancia, robot }
}

// ── Convenio Multilateral: jurisdicciones ────────────────────────────────────

// Acepta "3,5", "0,4523" o "0.4523" (la coma manda; si no hay coma, el punto es decimal).
function numeroDecimal(v: unknown): number | null {
  const s = String(v ?? "").trim()
  const t = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s
  const n = Number(t)
  return t !== "" && Number.isFinite(n) ? n : null
}

function datosJurisdiccion(data: Record<string, any>) {
  const out: Record<string, unknown> = {}
  if ("jurisdiccion" in data) {
    const j = String(data.jurisdiccion ?? "").trim()
    if (!j || j.length > 60) throw new HttpError(400, "Jurisdicción inválida")
    out.jurisdiccion = j
  }
  if ("nro_inscripcion" in data) out.nro_inscripcion = String(data.nro_inscripcion ?? "").trim() || null
  for (const campo of ["alicuota", "coeficiente"]) {
    if (!(campo in data)) continue
    const v = data[campo]
    if (v === null || v === "") {
      out[campo] = null
      continue
    }
    const n = typeof v === "number" ? v : numeroDecimal(v)
    if (n === null || n < 0 || (campo === "coeficiente" && n > 1)) throw new HttpError(400, `${campo} inválido`)
    out[campo] = n
  }
  if ("es_sede" in data) out.es_sede = !!data.es_sede
  if ("activo" in data) out.activo = !!data.activo
  return out
}

// Una sola jurisdicción sede por cliente.
async function dejarUnicaSede(clienteId: string, sedeId: string) {
  await q(db().from("cliente_jurisdicciones").update({ es_sede: false }).eq("cliente_id", clienteId).neq("id", sedeId))
}

const listarJurisdicciones: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const cliente = await clientePorSlug(p.slug, estudioId)
  return (await q(db().from("cliente_jurisdicciones").select("*").eq("cliente_id", cliente.id).eq("estudio_id", estudioId)
    .order("es_sede", { ascending: false }).order("jurisdiccion"))) ?? []
}

const crearJurisdiccion: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const datos = datosJurisdiccion(await body(req))
  if (!datos.jurisdiccion) throw new HttpError(400, "Falta la jurisdicción")
  const cliente = await clientePorSlug(p.slug, estudioId)
  const filas = await q(db().from("cliente_jurisdicciones").insert({ ...datos, cliente_id: cliente.id, estudio_id: estudioId }).select())
  const fila = filas?.[0]
  if (fila?.es_sede) await dejarUnicaSede(cliente.id, fila.id)
  return { ok: true, jurisdiccion: fila ?? null }
}

const actualizarJurisdiccion: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const datos = datosJurisdiccion(await body(req))
  if (!Object.keys(datos).length) throw new HttpError(400, "Sin campos válidos")
  const filas = await q(db().from("cliente_jurisdicciones").update(datos).eq("id", p.id).eq("estudio_id", estudioId).select())
  const fila = filas?.[0]
  if (!fila) throw new HttpError(404, "Jurisdicción no encontrada")
  if (fila.es_sede) await dejarUnicaSede(fila.cliente_id, fila.id)
  return { ok: true, jurisdiccion: fila }
}

const eliminarJurisdiccion: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  await q(db().from("cliente_jurisdicciones").delete().eq("id", p.id).eq("estudio_id", estudioId))
  return { ok: true }
}

const capturaArca: Handler = async ({ req, p }) => {
  const estudioId = await getEstudioId(req)
  const cliente = await clientePorSlug(p.slug, estudioId)
  const captura = await getStore("arca-capturas").get(cliente.id).catch(() => null)
  return { captura: captura ? `data:image/jpeg;base64,${captura}` : null }
}

// ── Tabla de rutas (las estáticas antes que las de parámetro) ────────────────

export const rutas: [string, string, Handler][] = [
  ["GET", "/", salud],

  ["GET", "/estudios/me", estudiosMe],
  ["PATCH", "/estudios/me", actualizarEstudio],
  ["POST", "/estudios/me/logo", subirLogo],
  ["DELETE", "/estudios/me/logo", quitarLogo],
  ["GET", "/marca/:id", marcaEstudio],
  ["PATCH", "/estudios/onboarding", completarOnboarding],
  ["POST", "/estudios/migrar-datos", migrarDatos],

  ["GET", "/componentes-provinciales/resumen", componentesResumen],
  ["GET", "/componentes-provinciales/:provincia/:categoria", componenteProvincial],

  ["GET", "/constancia/:cuit", constancia],
  ["GET", "/clientes/:slug/constancia", constanciaPdf],
  ["GET", "/clientes/:slug/facturacion-electronica", feEstado],
  ["PUT", "/clientes/:slug/facturacion-electronica", feGuardarConfig],
  ["POST", "/clientes/:slug/comprobantes", feEmitirAdmin],
  ["GET", "/clientes/:slug/comprobantes/:id", feComprobanteAdmin],
  ["POST", "/clientes/:slug/comprobantes/:id/reintentar", feReintentar],
  ["DELETE", "/clientes/:slug/comprobantes/:id", feBorrar],
  ["GET", "/receptor/:cuit", feReceptorAdmin],
  ["GET", "/padron/:cuit", padron],

  ["GET", "/clientes", listarClientes],
  ["POST", "/clientes", crearCliente],
  ["PATCH", "/clientes/:slug/toggle", toggleActivo],
  ["PATCH", "/clientes/:slug/estado-pago", actualizarEstadoPago],
  ["PATCH", "/clientes/:slug/cuota", actualizarCuota],
  ["PATCH", "/clientes/:slug/datos", actualizarDatosCliente],
  ["GET", "/clientes/:slug/historial-cuotas", historialCuotas],
  ["PATCH", "/clientes/:slug/historial-cuotas/:anio/:mes", toggleHistorialCuota],
  ["GET", "/clientes/:slug/deuda-manual", getDeudaManual],
  ["POST", "/clientes/:slug/deuda-manual", agregarDeudaManual],
  ["GET", "/clientes/:slug/recategorizaciones", listarRecategorizaciones],
  ["POST", "/clientes/:slug/recategorizar", registrarRecategorizacion],
  ["GET", "/clientes/:slug/arca", estadoArca],
  ["PUT", "/clientes/:slug/clave-fiscal", guardarClaveFiscal],
  ["DELETE", "/clientes/:slug/clave-fiscal", borrarClaveFiscal],
  ["POST", "/clientes/:slug/actualizar-arca", actualizarDesdeArca],
  ["GET", "/clientes/:slug/arca-captura", capturaArca],
  ["GET", "/clientes/:slug/jurisdicciones", listarJurisdicciones],
  ["POST", "/clientes/:slug/jurisdicciones", crearJurisdiccion],
  ["PATCH", "/jurisdicciones/:id", actualizarJurisdiccion],
  ["DELETE", "/jurisdicciones/:id", eliminarJurisdiccion],

  ["PATCH", "/deuda-manual/:id/pagar", pagarDeudaManual],
  ["DELETE", "/deuda-manual/:id", eliminarDeudaManual],

  ["GET", "/facturacion/:slug", obtenerFacturacion],
  ["POST", "/facturacion/:slug", cargarFacturacion],
  ["POST", "/importar-comprobantes/:slug", importarComprobantes],
  ["POST", "/importar-gastos/:slug", importarGastos],
  ["GET", "/gastos/:slug", gastosCliente],

  ["POST", "/portal/login", portalLogin],
  ["PATCH", "/portal/cambiar-password", portalCambiarPassword],
  ["PATCH", "/portal/:slug/marcar-pago", portalMarcarPago],
  ["POST", "/portal/:slug/verificar-arca", portalVerificarArca],
  ["GET", "/portal/:slug/constancia", portalConstancia],
  ["POST", "/portal/:slug/documentos", portalSubirDocumento],
  ["GET", "/portal/:slug/facturacion", fePortalEstado],
  ["POST", "/portal/:slug/comprobantes", fePortalEmitir],
  ["GET", "/portal/:slug/comprobantes/:id", fePortalComprobante],
  ["GET", "/portal/:slug/receptor/:cuit", fePortalReceptor],
  ["GET", "/portal/:slug", datosPortal],

  ["GET", "/planes", listarTodosPlanes],
  ["POST", "/planes/parsear-pdf", parsearPdfPlan],
  ["GET", "/planes/:slug", planesCliente],
  ["POST", "/planes/:slug", crearPlan],
  ["PATCH", "/planes/:id/pagar", marcarCuotaPagada],
  ["PATCH", "/planes/:id/estado", cambiarEstadoPlan],
  ["DELETE", "/planes/:id", eliminarPlan],
  ["GET", "/planes/:id/cuotas", cuotasPlan],
  ["POST", "/planes/:id/cuotas/inicializar", inicializarCuotas],
  ["PATCH", "/planes/:id/cuotas/:numero/pagar", pagarCuotaIndividual],

  ["POST", "/topes/importar", importarTopes],
  ["PATCH", "/topes/:categoria", actualizarTope],
  ["POST", "/configuracion/importar-tabla/:tipo", importarTabla],
  ["GET", "/configuracion", obtenerConfiguracion],
  ["POST", "/configuracion", guardarConfiguracion],

  ["GET", "/alertas/:slug", alertasCliente],
  ["POST", "/alertas/:slug", crearAlerta],
  ["DELETE", "/alertas/:id", eliminarAlerta],

  ["POST", "/documentos/:slug", crearDocumento],

  ...rutasSuperadmin,
]
