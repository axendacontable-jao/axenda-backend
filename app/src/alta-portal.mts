import { ESTADOS_HABILITADOS, HttpError, ahoraIsoZ, db, hoyIso, logActividad, q } from "./core.mts"
import { buscarEnPadron, constanciaCompleta } from "./arca.mts"
import { cifrarClave, exigirSesionPortal, firmarTokenPortal, hashPassword, huellaIp } from "./secretos.mts"
import { TAREAS, despacharSincronizacion, finPeriodoProximaRecategorizacion } from "./sincronizacion.mts"

// Inscripción pública desde el portal: un contribuyente nuevo se registra solo, carga su clave fiscal
// y queda como cliente del estudio en modo "solo lectura" (el robot solo consulta ARCA con esa clave;
// no emite facturas). El estudio la habilita en Configuración (estudios.alta_portal_habilitada).
// Todo pasa por acá con service role: el navegador nunca toca tablas.

type Ctx = { req: Request; p: Record<string, string>; query: URLSearchParams }

const soloDigitos = (s: unknown) => String(s ?? "").replace(/\D/g, "")
const sinAcentos = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "")

async function cuerpo(req: Request): Promise<Record<string, any>> {
  try {
    const d = await req.json()
    if (d && typeof d === "object" && !Array.isArray(d)) return d
  } catch {
    // cae abajo
  }
  throw new HttpError(400, "Pedido inválido")
}

// ── Validaciones ─────────────────────────────────────────────────────────────

// Dígito verificador del CUIT (módulo 11). Un resto de 10 nunca es válido: ARCA cambia el prefijo.
export function cuitValido(cuit: string): boolean {
  if (!/^(20|23|24|25|26|27|30|33|34)\d{9}$/.test(cuit)) return false
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const resto = 11 - (pesos.reduce((s, p, i) => s + p * Number(cuit[i]), 0) % 11)
  const dv = resto === 11 ? 0 : resto
  return dv !== 10 && dv === Number(cuit[10])
}

// Celular argentino como lo guarda el panel (código de área + número, 10 dígitos, sin 54/9/0).
export function celularArgentino(texto: unknown): string | null {
  let n = soloDigitos(texto)
  if (n.startsWith("54")) n = n.slice(2)
  if (n.startsWith("9") && n.length === 11) n = n.slice(1)
  if (n.startsWith("0")) n = n.slice(1)
  return /^[1-9]\d{9}$/.test(n) ? n : null
}

const PROVINCIAS: [RegExp, string][] = [
  [/RIO NEGRO/, "Rio Negro"], [/NEUQUEN/, "Neuquen"], [/CIUDAD AUTONOMA|CAPITAL FEDERAL|C\.?A\.?B\.?A/, "CABA"],
  [/BUENOS AIRES/, "Buenos Aires"], [/CATAMARCA/, "Catamarca"], [/CHACO/, "Chaco"], [/CHUBUT/, "Chubut"],
  [/CORDOBA/, "Cordoba"], [/CORRIENTES/, "Corrientes"], [/ENTRE RIOS/, "Entre Rios"], [/FORMOSA/, "Formosa"],
  [/JUJUY/, "Jujuy"], [/LA PAMPA/, "La Pampa"], [/LA RIOJA/, "La Rioja"], [/MENDOZA/, "Mendoza"], [/MISIONES/, "Misiones"],
  [/SALTA/, "Salta"], [/SAN JUAN/, "San Juan"], [/SAN LUIS/, "San Luis"], [/SANTA CRUZ/, "Santa Cruz"],
  [/SANTIAGO DEL ESTERO/, "Santiago del Estero"], [/SANTA FE/, "Santa Fe"], [/TIERRA DEL FUEGO/, "Tierra del Fuego"],
  [/TUCUMAN/, "Tucuman"],
]

// La provincia del domicilio fiscal ("Calle 123, Localidad, RIO NEGRO, CP 8400"): se busca de atrás para adelante.
export function provinciaDe(domicilio: string): string | null {
  const partes = sinAcentos(domicilio).toUpperCase().split(",").map((s) => s.trim()).reverse()
  for (const parte of partes) {
    const hallada = PROVINCIAS.find(([re]) => re.test(parte))
    if (hallada) return hallada[1]
  }
  return null
}

// ── Límites anti-abuso (tabla portal_intentos, guarda una huella de la IP, nunca la IP) ──

type Tipo = "verificar" | "alta" | "clave"
const HORA = 3_600_000
const DIA = 24 * HORA

async function contar(tipo: Tipo, campo: "ip_hash" | "cuit" | "estudio_id", valor: string, desdeMs: number, soloOk = false) {
  let consulta = db().from("portal_intentos").select("id", { count: "exact", head: true })
    .eq("tipo", tipo).eq(campo, valor).gte("created_at", new Date(Date.now() - desdeMs).toISOString())
  if (soloOk) consulta = consulta.eq("ok", true)
  const { count, error } = await consulta
  if (error) throw new HttpError(500, error.message)
  return count ?? 0
}

const DEMASIADOS = "Hiciste demasiados intentos. Probá de nuevo más tarde o escribile a tu contador."

async function registrarIntento(tipo: Tipo, ip: string, cuit: string | null, estudioId: string | null): Promise<number | null> {
  // De vez en cuando se borran los intentos de hace más de 30 días.
  if (Math.random() < 0.05) {
    await db().from("portal_intentos").delete().lt("created_at", new Date(Date.now() - 30 * DIA).toISOString())
  }
  const fila = await q(db().from("portal_intentos").insert({ tipo, ip_hash: ip, cuit, estudio_id: estudioId }).select("id").single())
  return fila?.id ?? null
}

const marcarIntentoOk = (id: number | null) =>
  id === null ? Promise.resolve() : db().from("portal_intentos").update({ ok: true }).eq("id", id).then(() => {})

// ── Estudio y consentimiento ─────────────────────────────────────────────────

export const VERSION_CONSENTIMIENTO = "2026-11-25"

export const textoConsentimiento = (estudio: string) =>
  `Autorizo a ${estudio} a guardar mi clave fiscal de ARCA cifrada y a usarla solo para consultar mi información ` +
  `(comprobantes emitidos y recibidos, deuda, constancia de inscripción, planes de pago e Ingresos Brutos). ` +
  `No se va a usar para emitir facturas ni para hacer trámites a mi nombre. Puedo quitarla desde el portal ` +
  `o cambiarla en ARCA cuando quiera, y en ese momento deja de funcionar.`

async function estudioConAlta(id: unknown) {
  const estudioId = String(id ?? "")
  const cerrado = new HttpError(403, "La inscripción desde el portal no está habilitada. Consultá a tu contador.")
  if (!/^[0-9a-f-]{36}$/i.test(estudioId)) throw cerrado
  const e = await q(db().from("estudios").select("id,nombre,estado,alta_portal_habilitada").eq("id", estudioId).maybeSingle())
  if (!e || !e.alta_portal_habilitada || !ESTADOS_HABILITADOS.includes(e.estado)) throw cerrado
  return e as { id: string; nombre: string }
}

// Datos para el formulario: si el estudio recibe inscripciones y el texto que se acepta (también lo
// usa el portal cuando un cliente inscripto vuelve a cargar su clave).
export async function infoAltaPortal({ p }: Ctx) {
  if (!/^[0-9a-f-]{36}$/i.test(p.estudio)) return { habilitada: false }
  const e = await q(db().from("estudios").select("nombre,estado,alta_portal_habilitada").eq("id", p.estudio).maybeSingle())
  if (!e) return { habilitada: false }
  return {
    habilitada: !!e.alta_portal_habilitada && ESTADOS_HABILITADOS.includes(e.estado), estudio: e.nombre,
    consentimiento: { version: VERSION_CONSENTIMIENTO, texto: textoConsentimiento(e.nombre) },
  }
}

// ── Padrón de ARCA ───────────────────────────────────────────────────────────

type Padron = {
  nombre: string; apellido: string; categoria: string; categoriaDescripcion: string; actividad: string
  localidad: string; provinciaArca: string; estado: string; provincia: string | null; bienes: boolean; monotributo: boolean
}

async function datosPadron(cuit: string): Promise<Padron> {
  try {
    const c = await constanciaCompleta(cuit)
    const apellido = c.apellido || c.razonSocial
    if (c.nombre || apellido) {
      return {
        nombre: c.nombre, apellido, categoria: c.categoria, categoriaDescripcion: c.categoriaDescripcion, actividad: c.actividad,
        localidad: c.localidad, provinciaArca: c.provincia, estado: c.estado, provincia: provinciaDe(c.provincia || c.domicilio),
        bienes: /VENTA|COSAS MUEBLES/i.test(`${c.categoriaDescripcion} ${c.actividad}`),
        monotributo: !!c.categoria || c.impuestos.some((i) => /MONOTRIBUTO/i.test(i)),
      }
    }
  } catch {
    // sigue con el padrón A13
  }
  try {
    const a = await buscarEnPadron(cuit)
    return {
      nombre: a.nombre, apellido: a.apellido, categoria: "", categoriaDescripcion: "", actividad: "", localidad: "", provinciaArca: "",
      estado: a.estado, provincia: null, bienes: false, monotributo: false,
    }
  } catch {
    throw new HttpError(404, "ARCA no encontró ese CUIT (o no responde en este momento). Revisalo y probá de nuevo.")
  }
}

// Paso 1 del formulario: el contribuyente escribe su CUIT y confirma en un cartel que es él (nombre,
// categoría, actividad y localidad según ARCA: lo mismo que muestra la constancia pública, sin la calle).
export async function verificarAltaPortal({ req }: Ctx) {
  const ip = huellaIp(req)
  const d = await cuerpo(req)
  const estudio = await estudioConAlta(d.estudio_id)
  const cuit = soloDigitos(d.cuit)
  if (await contar("verificar", "ip_hash", ip, HORA) >= 20 || await contar("verificar", "ip_hash", ip, DIA) >= 60) {
    throw new HttpError(429, DEMASIADOS)
  }
  await registrarIntento("verificar", ip, cuit || null, estudio.id)
  if (!cuitValido(cuit)) throw new HttpError(400, "El CUIT no es válido: revisá los números.")
  const existe = await q(db().from("clientes").select("id").eq("cuit", cuit).maybeSingle())
  if (existe) throw new HttpError(409, "Ese CUIT ya tiene una cuenta en el portal. Ingresá con tu contraseña o consultá a tu contador.")
  const padron = await datosPadron(cuit)
  return {
    ok: true, cuit, nombre: padron.nombre, apellido: padron.apellido,
    categoria: /^[A-K]$/.test(padron.categoria) ? padron.categoria : null,
    categoria_descripcion: padron.categoriaDescripcion || null, actividad: padron.actividad || null,
    localidad: padron.localidad || null, provincia: padron.provinciaArca || null,
    estado: padron.estado || null, monotributo: padron.monotributo,
  }
}

// Cuota del monotributo como la sugiere el panel al dar de alta: nacional (impuesto + SIPA + obra
// social, que no pagan quienes están en relación de dependencia) más el componente provincial vigente.
// Si falta algún dato, queda vacía para el contador.
async function cuotaSugerida(categoria: string, provincia: string, bienes: boolean, relDep: boolean): Promise<number | null> {
  try {
    const topes = await q(db().from("topes_categoria").select("*").eq("categoria", categoria)
      .order("vigente_desde", { ascending: false }).limit(1))
    const tope = topes?.[0]
    if (!tope) return null
    const imp = bienes ? (tope.imp_integrado_bienes || tope.cuota_bienes) : (tope.imp_integrado_servicios || tope.cuota_servicios)
    const nacional = Number(imp || 0) + (relDep ? 0 : Number(tope.aportes_sipa || 0) + Number(tope.obra_social || 0))
    if (!nacional) return null
    const buscar = (tipo: string) => q(db().from("componentes_provinciales").select("monto")
      .eq("provincia", provincia).eq("categoria", categoria).eq("tipo", tipo).lte("vigente_desde", hoyIso())
      .order("vigente_desde", { ascending: false }).limit(1))
    let comp = await buscar(bienes ? "bienes" : "servicios")
    if (!comp?.length) comp = await buscar("unico")
    return Math.round(nacional + Number(comp?.[0]?.monto || 0))
  } catch {
    return null
  }
}

// ── Alta ─────────────────────────────────────────────────────────────────────

export async function altaPortal({ req }: Ctx) {
  const ip = huellaIp(req)
  const d = await cuerpo(req)
  const estudio = await estudioConAlta(d.estudio_id)
  const cuit = soloDigitos(d.cuit)

  if (await contar("alta", "ip_hash", ip, HORA) >= 5 || await contar("alta", "ip_hash", ip, DIA) >= 10 ||
    (cuit && await contar("alta", "cuit", cuit, DIA) >= 5)) throw new HttpError(429, DEMASIADOS)
  // Freno general: un estudio no recibe más de 20 inscripciones por día.
  if (await contar("alta", "estudio_id", estudio.id, DIA, true) >= 20) {
    throw new HttpError(429, "Hoy no se pueden recibir más inscripciones. Probá mañana o escribile a tu contador.")
  }
  const intento = await registrarIntento("alta", ip, cuit || null, estudio.id)

  // Campo trampa: las personas no lo ven; los robots de spam lo completan.
  if (String(d.web ?? "").trim()) throw new HttpError(400, "No se pudo completar la inscripción.")
  if (!cuitValido(cuit)) throw new HttpError(400, "El CUIT no es válido: revisá los números.")
  const whatsapp = celularArgentino(d.whatsapp)
  if (!whatsapp) throw new HttpError(400, "Escribí tu celular con código de área, sin 0 ni 15 (por ejemplo 2944123456).")
  const email = String(d.email ?? "").trim().toLowerCase()
  if (email && (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new HttpError(400, "El email no es válido.")
  const password = typeof d.password === "string" ? d.password : ""
  if (password.length < 8 || password.length > 72) throw new HttpError(400, "La contraseña del portal tiene que tener entre 8 y 72 caracteres.")
  if (soloDigitos(password) === cuit) throw new HttpError(400, "La contraseña del portal no puede ser tu CUIT.")
  const clave = typeof d.clave_fiscal === "string" ? d.clave_fiscal : ""
  if (!clave || clave.length > 64) throw new HttpError(400, "Escribí tu clave fiscal de ARCA.")
  if (clave === password) throw new HttpError(400, "Usá una contraseña del portal distinta de tu clave fiscal.")
  if (d.acepto !== true) throw new HttpError(400, "Para inscribirte tenés que autorizar el uso de tu clave fiscal.")
  const relDep = d.relacion_dependencia === true
  // Lo que el contribuyente le quiere contar al contador (opcional).
  const comentario = String(d.comentario ?? "").replace(/\s+/g, " ").trim().slice(0, 500)

  const existe = await q(db().from("clientes").select("id").eq("cuit", cuit).maybeSingle())
  if (existe) throw new HttpError(409, "Ese CUIT ya tiene una cuenta en el portal. Ingresá con tu contraseña o consultá a tu contador.")
  const padron = await datosPadron(cuit)
  const categoria = /^[A-K]$/.test(padron.categoria) ? padron.categoria : null
  const provincia = padron.provincia ?? "Rio Negro"
  const ahora = ahoraIsoZ()
  const base = sinAcentos(padron.apellido).toLowerCase().replace(/[^a-z0-9]/g, "") || "cliente"
  const slug = `${base}-${cuit}`

  const { data: creado, error } = await db().from("clientes").insert({
    slug, nombre: padron.nombre || "", apellido: padron.apellido || "", cuit, whatsapp, email,
    categoria, categoria_arca: categoria, estado_arca: padron.estado || null, ultima_verificacion_arca: ahora,
    cuota: categoria ? await cuotaSugerida(categoria, provincia, padron.bienes, relDep) : null,
    activo: true, provincia, iibb_modalidad: "monotributo_unificado", tipo_actividad: padron.bienes ? "bienes" : "servicios",
    en_relacion_dependencia: relDep, estudio_id: estudio.id, solo_lectura: true, autoregistro_at: ahora,
  }).select("id,slug,nombre,apellido").single()
  if (error?.code === "23505") {
    throw new HttpError(409, "Ese CUIT ya tiene una cuenta en el portal. Ingresá con tu contraseña o consultá a tu contador.")
  }
  if (error || !creado) throw new HttpError(500, `No se pudo completar la inscripción: ${error?.message ?? "sin datos"}`)

  // Si algo falla después de crear al cliente, se borra todo (las tablas hijas borran en cascada).
  try {
    await q(db().from("portal_accesos").insert({ cliente_id: creado.id, password_hash: hashPassword(password) }))
    await q(db().from("credenciales_arca").insert({
      cliente_id: creado.id, estudio_id: estudio.id, clave_cifrada: cifrarClave(clave, creado.id), actualizada_at: ahora,
    }))
    await q(db().from("altas_portal").insert({
      cliente_id: creado.id, estudio_id: estudio.id, ip_hash: ip, comentario: comentario || null,
      consentimiento: { version: VERSION_CONSENTIMIENTO, texto: textoConsentimiento(estudio.nombre), aceptado_at: ahora },
    }))
  } catch (e: any) {
    await db().from("clientes").delete().eq("id", creado.id)
    throw new HttpError(500, `No se pudo completar la inscripción: ${e?.message ?? e}`)
  }
  await marcarIntentoOk(intento)

  const nombre = [creado.apellido, creado.nombre].filter(Boolean).join(" ")
  await logActividad(creado.id, `Se inscribió desde el portal y cargó su clave fiscal — ${nombre}`, estudio.id)
  await db().from("alertas").insert({
    cliente_id: creado.id, estudio_id: estudio.id, tipo: "arca", icono: "🆕", leida: false,
    titulo: `Nuevo cliente desde el portal: ${nombre}`,
    descripcion: `Se inscribió solo (CUIT ${cuit}, cel. ${whatsapp}${email ? `, ${email}` : ""}) y cargó su clave fiscal. ` +
      `Queda en solo lectura: el robot trae sus datos de ARCA pero no emite facturas. Revisá provincia, actividad, cuota y honorarios.` +
      (padron.monotributo ? "" : " Ojo: ARCA no lo muestra inscripto en el Monotributo.") +
      (comentario ? ` Te escribió: "${comentario}"` : ""),
  }).then(() => {}, () => {})

  // El robot trae sus datos de ARCA ahora mismo (solo consultas). Si no arranca, lo hace el cron.
  try {
    const { anio, mes } = finPeriodoProximaRecategorizacion()
    await despacharSincronizacion(new URL(req.url).origin, creado.id, anio, mes, TAREAS)
  } catch (e: any) {
    console.error(`[alta-portal] no se pudo iniciar la sincronización de ${creado.id}: ${e?.message ?? e}`)
  }

  return {
    ok: true, slug: creado.slug, nombre: creado.nombre ?? "", apellido: creado.apellido ?? "", activo: true,
    token: await firmarTokenPortal(creado.slug, creado.id),
  }
}

// ── Clave fiscal desde el portal (solo para quienes se inscribieron solos) ───

async function clienteInscripto(req: Request, slug: string) {
  await exigirSesionPortal(req, slug)
  const c = await q(db().from("clientes").select("id,cuit,nombre,apellido,estudio_id,autoregistro_at").eq("slug", slug).single())
  if (!c.autoregistro_at) throw new HttpError(403, "Tu clave fiscal la administra tu contador: escribile si la cambiaste.")
  return c
}

// Estado de la clave para el portal: si el robot ya pudo entrar a ARCA con ella.
export async function estadoClavePortal(clienteId: string) {
  const cred = await q(db().from("credenciales_arca").select("actualizada_at").eq("cliente_id", clienteId).maybeSingle())
  if (!cred) return { estado: "sin_clave", actualizada_at: null, detalle: null }
  const syncs = (await q(db().from("sincronizaciones_arca").select("estado,created_at")
    .eq("cliente_id", clienteId).gte("created_at", cred.actualizada_at).order("created_at", { ascending: false }).limit(20))) ?? []
  const rechazo = syncs.find((s: any) => ["clave_incorrecta", "requiere_2fa", "captcha"].includes(s.estado))
  const base = { actualizada_at: cred.actualizada_at }
  if (syncs.some((s: any) => s.estado === "ok")) return { ...base, estado: "ok", detalle: null }
  if (rechazo?.estado === "clave_incorrecta") {
    return { ...base, estado: "clave_incorrecta", detalle: "ARCA no aceptó tu clave fiscal (o te pide cambiarla). Cargala de nuevo." }
  }
  if (rechazo?.estado === "requiere_2fa") {
    return { ...base, estado: "requiere_2fa", detalle: "Tu cuenta de ARCA pide verificación en dos pasos: el robot no puede entrar. Escribile a tu contador." }
  }
  if (syncs.length) return { ...base, estado: "error", detalle: "Todavía no pudimos traer tus datos de ARCA. Lo vamos a volver a intentar." }
  const reciente = Date.now() - Date.parse(cred.actualizada_at) < 30 * 60_000
  return { ...base, estado: reciente ? "sincronizando" : "pendiente", detalle: null }
}

export async function portalGuardarClave({ req, p }: Ctx) {
  const c = await clienteInscripto(req, p.slug)
  const d = await cuerpo(req)
  const clave = typeof d.clave === "string" ? d.clave : ""
  if (!clave || clave.length > 64) throw new HttpError(400, "Escribí tu clave fiscal de ARCA.")
  if (d.acepto !== true) throw new HttpError(400, "Tenés que autorizar el uso de tu clave fiscal.")
  if (await contar("clave", "cuit", c.cuit, DIA) >= 5) throw new HttpError(429, DEMASIADOS)
  await registrarIntento("clave", huellaIp(req), c.cuit, c.estudio_id)
  const estudio = await q(db().from("estudios").select("nombre").eq("id", c.estudio_id).single())
  const ahora = ahoraIsoZ()
  const valores = { clave_cifrada: cifrarClave(clave, c.id), estudio_id: c.estudio_id, actualizada_at: ahora }
  const upd = await q(db().from("credenciales_arca").update(valores).eq("cliente_id", c.id).select("cliente_id"))
  if (!upd?.length) await q(db().from("credenciales_arca").insert({ cliente_id: c.id, ...valores }))
  await q(db().from("altas_portal").update({
    consentimiento: { version: VERSION_CONSENTIMIENTO, texto: textoConsentimiento(estudio.nombre), aceptado_at: ahora },
  }).eq("cliente_id", c.id))
  const nombre = [c.apellido, c.nombre].filter(Boolean).join(" ")
  await logActividad(c.id, `Cargó una clave fiscal nueva desde el portal — ${nombre}`, c.estudio_id)
  try {
    const { anio, mes } = finPeriodoProximaRecategorizacion()
    await despacharSincronizacion(new URL(req.url).origin, c.id, anio, mes, TAREAS)
  } catch (e: any) {
    console.error(`[alta-portal] no se pudo iniciar la sincronización de ${c.id}: ${e?.message ?? e}`)
  }
  return { ok: true, clave: await estadoClavePortal(c.id) }
}

// Botón "Emitir factura" de una cuenta de solo lectura: el cliente pide contratar la facturación.
// Le llega una alerta al contador (una por día como mucho) con los pasos para activarla.
export async function portalContratarFacturacion({ req, p }: Ctx) {
  await exigirSesionPortal(req, p.slug)
  const c = await q(db().from("clientes").select("id,nombre,apellido,estudio_id,solo_lectura").eq("slug", p.slug).single())
  const nombre = [c.apellido, c.nombre].filter(Boolean).join(" ")
  const titulo = `${nombre} quiere contratar la facturación desde el portal`
  const desde = new Date(Date.now() - DIA).toISOString()
  const ya = await q(db().from("alertas").select("id").eq("cliente_id", c.id).eq("titulo", titulo).gte("created_at", desde).limit(1))
  if (!ya?.length) {
    await q(db().from("alertas").insert({
      cliente_id: c.id, estudio_id: c.estudio_id, tipo: "factura", icono: "🧾", leida: false, titulo,
      descripcion: c.solo_lectura
        ? "Para activarla: en su ficha, ✏ Editar datos → destildá \"Solo lectura\"; después, en la pestaña Facturar, tildá \"El cliente puede emitir facturas desde su portal\"."
        : "Para activarla: en su ficha, pestaña Facturar, tildá \"El cliente puede emitir facturas desde su portal\".",
    }))
    await db().from("altas_portal").update({ facturacion_solicitada_at: ahoraIsoZ() }).eq("cliente_id", c.id).then(() => {}, () => {})
  }
  return { ok: true }
}

export async function portalBorrarClave({ req, p }: Ctx) {
  const c = await clienteInscripto(req, p.slug)
  await q(db().from("credenciales_arca").delete().eq("cliente_id", c.id))
  const nombre = [c.apellido, c.nombre].filter(Boolean).join(" ")
  await db().from("alertas").insert({
    cliente_id: c.id, estudio_id: c.estudio_id, tipo: "arca", icono: "🔑", leida: false,
    titulo: `${nombre} quitó su clave fiscal desde el portal`,
    descripcion: "El robot ya no puede traer sus datos de ARCA hasta que la vuelva a cargar.",
  }).then(() => {}, () => {})
  return { ok: true, clave: await estadoClavePortal(c.id) }
}
