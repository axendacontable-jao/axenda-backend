import { HttpError, db, esFechaIso, exigirSuperadmin, hoyArgentina, isoDate, q } from "./core.mts"

// Superadmin: ve y administra todos los estudios. Nunca usa getEstudioId ni el RLS del estudio:
// todas las consultas van con la service role del backend, después de exigirSuperadmin.

type Ctx = { req: Request; p: Record<string, string>; query: URLSearchParams }
type Handler = (c: Ctx) => Promise<unknown>

const ESTADOS = ["activa", "suspendida", "trial"]
// La cuota mensual de cada estudio vence el día 10 del mes.
export const DIA_VENCIMIENTO_CUOTA = 10
const BUCKET_DOCS = "documentos-axenda"
const BUCKET_LOGOS = "logos-estudios"

async function datos(req: Request): Promise<Record<string, any>> {
  let b: unknown
  try {
    b = await req.json()
  } catch {
    throw new HttpError(422, "Body JSON inválido")
  }
  if (b === null || typeof b !== "object" || Array.isArray(b)) throw new HttpError(422, "Body JSON inválido")
  return b as Record<string, any>
}

const esUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

function idValido(id: string) {
  if (!esUuid(id)) throw new HttpError(404, "No encontrado")
  return id
}

// pendiente → vencida cuando pasó el día de vencimiento del mes de la cuota.
export function estadoCuota(c: { estado: string; anio: number; mes: number }, hoy: string): string {
  if (c.estado === "paga") return "paga"
  return hoy > isoDate(c.anio, c.mes, DIA_VENCIMIENTO_CUOTA) ? "vencida" : "pendiente"
}

const hoyAr = () => {
  const t = hoyArgentina()
  return { ...t, iso: isoDate(t.y, t.m, t.d) }
}

// Fecha de pago (YYYY-MM-DD) → mediodía en Argentina, para que no cambie de día por el huso.
const fechaPagoIso = (fecha: string) => `${fecha}T12:00:00-03:00`

// Email y último ingreso de cada usuario (auth.users, con la API admin de Supabase).
async function usuariosPorId(): Promise<Map<string, { email: string; ultimo: string | null }>> {
  const m = new Map<string, { email: string; ultimo: string | null }>()
  try {
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await db().auth.admin.listUsers({ page, perPage: 1000 })
      if (error) throw error
      for (const u of data.users) m.set(u.id, { email: u.email ?? "", ultimo: u.last_sign_in_at ?? null })
      if (data.users.length < 1000) break
    }
  } catch (e: any) {
    console.log(`[superadmin] no se pudo leer auth.users: ${e?.message ?? e}`)
  }
  return m
}

async function superadminIds(): Promise<Set<string>> {
  return new Set(((await q(db().from("superadmins").select("user_id"))) ?? []).map((s: any) => s.user_id))
}

const masReciente = (...fechas: (string | null | undefined)[]) =>
  fechas.filter((f): f is string => !!f && !Number.isNaN(Date.parse(f)))
    .sort((a, b) => Date.parse(a) - Date.parse(b)).pop() ?? null

function filaEstudio(e: any, usuarios: Map<string, any>, admins: Set<string>, clientes: any[], cuotas: any[], hoy: string) {
  const u = usuarios.get(e.owner_id)
  const propios = clientes.filter((c) => c.estudio_id === e.id)
  const suyas = cuotas.filter((c) => c.estudio_id === e.id)
  const vencidas = suyas.filter((c) => estadoCuota(c, hoy) === "vencida")
  return {
    id: e.id, nombre: e.nombre, email: u?.email ?? "", plan: e.plan, estado: e.estado,
    cuota_mensual: e.cuota_mensual === null ? null : Number(e.cuota_mensual),
    created_at: e.created_at, ultimo_acceso: masReciente(e.ultimo_acceso_at, u?.ultimo),
    clientes: propios.length, clientes_activos: propios.filter((c) => c.activo).length,
    moroso: vencidas.length > 0, deuda: vencidas.reduce((s, c) => s + Number(c.monto || 0), 0),
    logo_url: e.logo_url, color_primario: e.color_primario, onboarding_completo: e.onboarding_completo,
    es_superadmin: admins.has(e.owner_id),
  }
}

const superMe: Handler = async ({ req }) => {
  const u = await exigirSuperadmin(req)
  return { ok: true, email: u.email }
}

const superResumen: Handler = async ({ req }) => {
  await exigirSuperadmin(req)
  const d = db()
  const [estudios, clientes, cuotas, usuarios, admins] = await Promise.all([
    q(d.from("estudios").select("*").order("created_at", { ascending: false })),
    q(d.from("clientes").select("estudio_id,activo")),
    q(d.from("cuotas_estudios").select("estudio_id,anio,mes,monto,estado,fecha_pago")),
    usuariosPorId(),
    superadminIds(),
  ])
  const t = hoyAr()
  const lista = (estudios ?? []).map((e: any) => filaEstudio(e, usuarios, admins, clientes ?? [], cuotas ?? [], t.iso))
  const mesActual = `${t.y}-${String(t.m).padStart(2, "0")}`
  // Ingresos del mes: lo cobrado este mes (por fecha de pago, en hora argentina).
  const cobradas = (cuotas ?? []).filter((c: any) =>
    c.estado === "paga" && c.fecha_pago && new Date(Date.parse(c.fecha_pago) - 3 * 3_600_000).toISOString().slice(0, 7) === mesActual)
  const delMes = (cuotas ?? []).filter((c: any) => c.anio === t.y && c.mes === t.m)
  return {
    hoy: t.iso,
    totales: {
      activos: lista.filter((e) => e.estado === "activa").length,
      suspendidos: lista.filter((e) => e.estado === "suspendida").length,
      trial: lista.filter((e) => e.estado === "trial").length,
      total: lista.length,
      ingresos_mes: cobradas.reduce((s: number, c: any) => s + Number(c.monto || 0), 0),
      cuotas_mes: delMes.length,
      cuotas_mes_pagas: delMes.filter((c: any) => c.estado === "paga").length,
      esperado_mes: delMes.reduce((s: number, c: any) => s + Number(c.monto || 0), 0),
      nuevos_mes: lista.filter((e) => String(e.created_at ?? "").slice(0, 7) === mesActual).length,
      morosos: lista.filter((e) => e.moroso).length,
    },
    estudios: lista,
  }
}

async function estudioPorId(id: string) {
  const e = await q(db().from("estudios").select("*").eq("id", idValido(id)).maybeSingle())
  if (!e) throw new HttpError(404, "Estudio no encontrado")
  return e
}

const superEstudio: Handler = async ({ req, p }) => {
  await exigirSuperadmin(req)
  const d = db()
  const e = await estudioPorId(p.id)
  const [clientes, creds, cuotas, cfg, usuarios, admins] = await Promise.all([
    q(d.from("clientes").select("estudio_id,activo").eq("estudio_id", e.id)),
    q(d.from("credenciales_arca").select("cliente_id").eq("estudio_id", e.id)),
    q(d.from("cuotas_estudios").select("*").eq("estudio_id", e.id).order("anio", { ascending: false }).order("mes", { ascending: false })),
    q(d.from("configuracion").select("clave,valor").eq("estudio_id", e.id)
      .in("clave", ["whatsapp_estudio", "email_estudio", "provincia_principal"])),
    usuariosPorId(),
    superadminIds(),
  ])
  const hoy = hoyAr().iso
  const contacto = Object.fromEntries((cfg ?? []).map((r: any) => [r.clave, r.valor]))
  return {
    estudio: {
      ...filaEstudio(e, usuarios, admins, clientes ?? [], cuotas ?? [], hoy),
      whatsapp: contacto.whatsapp_estudio ?? null, email_contacto: contacto.email_estudio ?? null,
      provincia: contacto.provincia_principal ?? null,
      facturacion_electronica_habilitada: !!e.facturacion_electronica_habilitada,
      clientes_con_clave: (creds ?? []).length,
    },
    cuotas: (cuotas ?? []).map((c: any) => ({ ...c, monto: Number(c.monto), estado: estadoCuota(c, hoy) })),
  }
}

const superActualizarEstudio: Handler = async ({ req, p }) => {
  const yo = await exigirSuperadmin(req)
  const e = await estudioPorId(p.id)
  const data = await datos(req)
  const update: Record<string, unknown> = {}
  if ("estado" in data) {
    if (!ESTADOS.includes(data.estado)) throw new HttpError(422, "Estado inválido (activa, suspendida o trial)")
    if (data.estado === "suspendida" && (e.owner_id === yo.id || (await superadminIds()).has(e.owner_id))) {
      throw new HttpError(409, "No se puede suspender el estudio de un superadmin")
    }
    update.estado = data.estado
  }
  if ("plan" in data) update.plan = String(data.plan ?? "").trim().slice(0, 40) || null
  if ("cuota_mensual" in data) {
    const monto = data.cuota_mensual === null || data.cuota_mensual === "" ? null : Number(data.cuota_mensual)
    if (monto !== null && !(monto >= 0 && Number.isFinite(monto))) throw new HttpError(422, "Cuota mensual inválida")
    update.cuota_mensual = monto
  }
  if (!Object.keys(update).length) throw new HttpError(400, "Sin campos válidos")
  await q(db().from("estudios").update(update).eq("id", e.id))
  return { ok: true }
}

// Todos los archivos bajo una carpeta del storage (list no es recursivo).
async function archivosEn(bucket: string, carpeta: string, profundidad = 0): Promise<string[]> {
  if (profundidad > 3) return []
  const { data, error } = await db().storage.from(bucket).list(carpeta, { limit: 1000 })
  if (error || !data) return []
  const rutas: string[] = []
  for (const it of data) {
    const ruta = `${carpeta}/${it.name}`
    if (it.id) rutas.push(ruta)
    else rutas.push(...(await archivosEn(bucket, ruta, profundidad + 1)))
  }
  return rutas
}

async function borrarArchivos(bucket: string, carpetas: string[]) {
  let borrados = 0
  for (const carpeta of carpetas) {
    try {
      const rutas = await archivosEn(bucket, carpeta)
      for (let i = 0; i < rutas.length; i += 100) {
        const { error } = await db().storage.from(bucket).remove(rutas.slice(i, i + 100))
        if (!error) borrados += Math.min(100, rutas.length - i)
      }
    } catch (e: any) {
      console.log(`[superadmin] no se pudieron borrar archivos de ${bucket}/${carpeta}: ${e?.message ?? e}`)
    }
  }
  return borrados
}

// Eliminar: el frontend pide dos confirmaciones y la segunda es escribir el nombre del estudio.
// Borra el estudio (en cascada: clientes y todos sus datos), sus archivos y la cuenta del dueño.
const superEliminarEstudio: Handler = async ({ req, p }) => {
  const yo = await exigirSuperadmin(req)
  const e = await estudioPorId(p.id)
  const data = await datos(req)
  if (String(data.confirmacion ?? "").trim() !== String(e.nombre ?? "").trim()) {
    throw new HttpError(422, "El nombre escrito no coincide con el del estudio")
  }
  const admins = await superadminIds()
  if (e.owner_id === yo.id || admins.has(e.owner_id)) throw new HttpError(409, "No se puede eliminar el estudio de un superadmin")
  const d = db()
  const clientes = (await q(d.from("clientes").select("id").eq("estudio_id", e.id))) ?? []
  const archivos = await borrarArchivos(BUCKET_DOCS, clientes.map((c: any) => c.id))
  await borrarArchivos(BUCKET_LOGOS, [e.id])
  await q(d.from("estudios").delete().eq("id", e.id))
  // La cuenta del dueño: si quedara, al volver a entrar se le crearía un estudio vacío.
  let cuentaBorrada = false
  if (e.owner_id) {
    const otros = (await q(d.from("estudios").select("id").eq("owner_id", e.owner_id))) ?? []
    if (!otros.length) {
      const { error } = await d.auth.admin.deleteUser(e.owner_id)
      cuentaBorrada = !error
      if (error) console.log(`[superadmin] no se pudo borrar la cuenta ${e.owner_id}: ${error.message}`)
    }
  }
  console.log(`[superadmin] estudio ${e.id} (${e.nombre}) eliminado: ${clientes.length} clientes, ${archivos} archivos`)
  return { ok: true, clientes: clientes.length, archivos, cuenta_borrada: cuentaBorrada }
}

// ── Cuotas mensuales de los estudios ─────────────────────────────────────────

function periodo(data: Record<string, any>) {
  const anio = Number(data.anio)
  const mes = Number(data.mes)
  if (!Number.isInteger(anio) || anio < 2020 || anio > 2100) throw new HttpError(422, "Año inválido")
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) throw new HttpError(422, "Mes inválido")
  return { anio, mes }
}

function montoValido(v: unknown) {
  const monto = Number(v)
  if (!(monto >= 0 && Number.isFinite(monto))) throw new HttpError(422, "Monto inválido")
  return monto
}

const superCrearCuota: Handler = async ({ req, p }) => {
  await exigirSuperadmin(req)
  const e = await estudioPorId(p.id)
  const data = await datos(req)
  const { anio, mes } = periodo(data)
  const monto = montoValido(data.monto ?? e.cuota_mensual ?? 0)
  const existe = await q(db().from("cuotas_estudios").select("id").eq("estudio_id", e.id).eq("anio", anio).eq("mes", mes).maybeSingle())
  if (existe) throw new HttpError(409, "Ese mes ya tiene cuota cargada")
  const filas = await q(db().from("cuotas_estudios").insert({ estudio_id: e.id, anio, mes, monto }).select())
  return { ok: true, cuota: filas?.[0] ?? null }
}

const superActualizarCuota: Handler = async ({ req, p }) => {
  await exigirSuperadmin(req)
  const cuota = await q(db().from("cuotas_estudios").select("*").eq("id", idValido(p.id)).maybeSingle())
  if (!cuota) throw new HttpError(404, "Cuota no encontrada")
  const data = await datos(req)
  const update: Record<string, unknown> = {}
  if ("estado" in data) {
    if (data.estado === "paga") {
      const fecha = data.fecha_pago ?? hoyAr().iso
      if (!esFechaIso(fecha)) throw new HttpError(422, "Fecha de pago inválida")
      update.estado = "paga"
      update.fecha_pago = fechaPagoIso(fecha)
    } else if (data.estado === "pendiente") {
      update.estado = "pendiente"
      update.fecha_pago = null
    } else {
      throw new HttpError(422, "Estado inválido (paga o pendiente)")
    }
  }
  if ("monto" in data) update.monto = montoValido(data.monto)
  if (!Object.keys(update).length) throw new HttpError(400, "Sin campos válidos")
  await q(db().from("cuotas_estudios").update(update).eq("id", cuota.id))
  return { ok: true }
}

const superBorrarCuota: Handler = async ({ req, p }) => {
  await exigirSuperadmin(req)
  await q(db().from("cuotas_estudios").delete().eq("id", idValido(p.id)))
  return { ok: true }
}

// Genera la cuota de un mes para todos los estudios activos con cuota mensual definida.
const superGenerarCuotas: Handler = async ({ req }) => {
  await exigirSuperadmin(req)
  const { anio, mes } = periodo(await datos(req))
  const d = db()
  const [estudios, existentes] = await Promise.all([
    q(d.from("estudios").select("id,cuota_mensual,estado").eq("estado", "activa")),
    q(d.from("cuotas_estudios").select("estudio_id").eq("anio", anio).eq("mes", mes)),
  ])
  const ya = new Set((existentes ?? []).map((c: any) => c.estudio_id))
  const conMonto = (estudios ?? []).filter((e: any) => Number(e.cuota_mensual) > 0)
  const nuevas = conMonto.filter((e: any) => !ya.has(e.id))
    .map((e: any) => ({ estudio_id: e.id, anio, mes, monto: Number(e.cuota_mensual) }))
  if (nuevas.length) await q(d.from("cuotas_estudios").insert(nuevas))
  return {
    ok: true, creadas: nuevas.length, ya_estaban: conMonto.length - nuevas.length,
    sin_monto: (estudios ?? []).length - conMonto.length,
  }
}

export const rutasSuperadmin: [string, string, Handler][] = [
  ["GET", "/superadmin/me", superMe],
  ["GET", "/superadmin/resumen", superResumen],
  ["POST", "/superadmin/cuotas/generar", superGenerarCuotas],
  ["PATCH", "/superadmin/cuotas/:id", superActualizarCuota],
  ["DELETE", "/superadmin/cuotas/:id", superBorrarCuota],
  ["GET", "/superadmin/estudios/:id", superEstudio],
  ["PATCH", "/superadmin/estudios/:id", superActualizarEstudio],
  ["DELETE", "/superadmin/estudios/:id", superEliminarEstudio],
  ["POST", "/superadmin/estudios/:id/cuotas", superCrearCuota],
]
