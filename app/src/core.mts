import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose"

export class HttpError extends Error {
  status: number
  constructor(status: number, detail: string) {
    super(detail)
    this.status = status
  }
}

export const env = (key: string, fallback = ""): string => Netlify.env.get(key) ?? fallback

let client: SupabaseClient | null = null

export function db(): SupabaseClient {
  if (!client) {
    const url = env("SUPABASE_URL")
    const key = env("SUPABASE_KEY")
    if (!url || !key) {
      throw new HttpError(500, "Faltan SUPABASE_URL o SUPABASE_KEY en las variables de entorno de Netlify")
    }
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  }
  return client
}

// supabase-js returns API errors instead of throwing (supabase-py throws); surface them as 500s.
export async function q<T = any>(builder: PromiseLike<{ data: T; error: any }>): Promise<T> {
  const { data, error } = await builder
  if (error) throw new HttpError(500, error.message ?? String(error))
  return data
}

export async function clientePorSlug(slug: string, estudioId: string, cols = "id"): Promise<any> {
  const { data, error } = await db()
    .from("clientes").select(cols).eq("slug", slug).eq("estudio_id", estudioId).single()
  if (error || !data) throw new HttpError(404, "Cliente no encontrado")
  return data
}

export async function logActividad(clienteId: unknown, mensaje: string, estudioId?: string | null) {
  try {
    const row: Record<string, unknown> = { cliente_id: clienteId, tipo: "actividad", titulo: mensaje, leida: true }
    if (estudioId) row.estudio_id = estudioId
    await db().from("alertas").insert(row)
  } catch {
    // best effort, igual que en la versión Python
  }
}

// ── Fechas (UTC, igual que el servidor anterior) ─────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0")
export const isoDate = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`
export const diasEnMes = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()
export const fechaValida = (y: number, m: number, d: number) =>
  y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= diasEnMes(y, m)

export function hoy() {
  const n = new Date()
  return { y: n.getUTCFullYear(), m: n.getUTCMonth() + 1, d: n.getUTCDate() }
}
// Fecha en Argentina (UTC-3, sin horario de verano): la que usa ARCA en sus formularios.
export function hoyArgentina() {
  const n = new Date(Date.now() - 3 * 3_600_000)
  return { y: n.getUTCFullYear(), m: n.getUTCMonth() + 1, d: n.getUTCDate() }
}

export const hoyIso = () => {
  const t = hoy()
  return isoDate(t.y, t.m, t.d)
}
export const ahoraIsoZ = () => new Date().toISOString()

export function sumarMeses(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number)
  const idx = m - 1 + n
  const year = y + Math.floor(idx / 12)
  const month = ((idx % 12) + 12) % 12 + 1
  return isoDate(year, month, Math.min(d, diasEnMes(year, month)))
}

export const esFechaIso = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && fechaValida(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10))

// Python's str(): configuration values were stored with these spellings.
export function pyStr(v: unknown): string {
  if (v === true) return "True"
  if (v === false) return "False"
  if (typeof v === "string") return v
  if (typeof v === "number") return String(v)
  return JSON.stringify(v)
}

// ── Auth (JWT de Supabase) ───────────────────────────────────────────────────

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null

// Usuario (sub del JWT de Supabase) que hace el pedido.
export async function usuarioDe(req: Request): Promise<{ id: string; email: string }> {
  const auth = req.headers.get("authorization") ?? ""
  if (!auth.startsWith("Bearer ")) throw new HttpError(401, "Autenticación requerida")
  const token = auth.slice(7)
  let payload: JWTPayload
  try {
    const { alg } = decodeProtectedHeader(token)
    if (alg === "HS256") {
      const secret = new TextEncoder().encode(env("SUPABASE_JWT_SECRET"))
      ;({ payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] }))
    } else {
      jwks ??= createRemoteJWKSet(new URL(`${env("SUPABASE_URL")}/auth/v1/.well-known/jwks.json`))
      ;({ payload } = await jwtVerify(token, jwks))
    }
  } catch (e: any) {
    throw new HttpError(401, `Token inválido: ${e?.message ?? e}`)
  }
  if (!payload.sub) throw new HttpError(401, "Token sin subject")
  return { id: payload.sub, email: String(payload.email ?? "") }
}

// Estados con los que el estudio puede usar la app (suspendida queda bloqueada).
export const ESTADOS_HABILITADOS = ["activa", "trial"]

export async function getEstudioId(req: Request): Promise<string> {
  const { id: userId } = await usuarioDe(req)
  const rows = await q(db().from("estudios").select("id,estado,ultimo_acceso_at").eq("owner_id", userId).limit(1))
  if (!rows?.length) {
    const ins = await q(
      db().from("estudios").insert({ owner_id: userId, nombre: "Mi Estudio", estado: "activa" }).select(),
    )
    if (!ins?.length) throw new HttpError(403, "No se pudo inicializar el estudio")
    return ins[0].id
  }
  if (!ESTADOS_HABILITADOS.includes(rows[0].estado)) throw new HttpError(403, `Estudio ${rows[0].estado}`)
  // Último acceso para el superadmin (como mucho una escritura cada 10 minutos).
  const ultimo = Date.parse(rows[0].ultimo_acceso_at ?? "")
  if (!(Date.now() - ultimo < 10 * 60_000)) {
    await db().from("estudios").update({ ultimo_acceso_at: ahoraIsoZ() }).eq("id", rows[0].id)
  }
  return rows[0].id
}

// Pantalla de superadmin: el usuario tiene que estar en la tabla superadmins. No usa el estudio.
export async function exigirSuperadmin(req: Request): Promise<{ id: string; email: string }> {
  const usuario = await usuarioDe(req)
  const fila = await q(db().from("superadmins").select("user_id").eq("user_id", usuario.id).maybeSingle())
  if (!fila) throw new HttpError(403, "No tenés acceso al superadmin")
  return usuario
}
