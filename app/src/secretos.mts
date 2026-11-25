import crypto from "node:crypto"
import { SignJWT, jwtVerify } from "jose"
import { HttpError, env } from "./core.mts"

// Una sola variable maestra (APP_SECRET); cada uso deriva su propia llave con HKDF.
function llave(uso: string): Buffer {
  const maestra = env("APP_SECRET")
  if (maestra.length < 32) throw new HttpError(500, "Falta configurar APP_SECRET en Netlify")
  return Buffer.from(crypto.hkdfSync("sha256", maestra, "axenda-contable", uso, 32))
}

// ── Clave fiscal: AES-256-GCM, ligada al cliente (AAD) ───────────────────────

export function cifrarClave(clave: string, clienteId: string): string {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv("aes-256-gcm", llave("clave-fiscal"), iv)
  c.setAAD(Buffer.from(clienteId))
  const datos = Buffer.concat([c.update(clave, "utf8"), c.final()])
  return ["v1", iv, c.getAuthTag(), datos].map((p) => (typeof p === "string" ? p : p.toString("base64"))).join(".")
}

export function descifrarClave(cifrada: string, clienteId: string): string {
  const [version, iv, tag, datos] = cifrada.split(".")
  if (version !== "v1" || !iv || !tag || !datos) throw new Error("Formato de clave cifrada desconocido")
  const d = crypto.createDecipheriv("aes-256-gcm", llave("clave-fiscal"), Buffer.from(iv, "base64"))
  d.setAAD(Buffer.from(clienteId))
  d.setAuthTag(Buffer.from(tag, "base64"))
  return Buffer.concat([d.update(Buffer.from(datos, "base64")), d.final()]).toString("utf8")
}

// ── Sesión del portal de clientes ────────────────────────────────────────────

export const firmarTokenPortal = (slug: string, clienteId: string) =>
  new SignJWT({ cid: clienteId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(slug)
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(llave("portal"))

export async function exigirSesionPortal(req: Request, slug: string) {
  const auth = req.headers.get("authorization") ?? ""
  if (!auth.startsWith("Bearer ")) throw new HttpError(401, "Iniciá sesión en el portal")
  try {
    const { payload } = await jwtVerify(auth.slice(7), llave("portal"), { algorithms: ["HS256"] })
    if (payload.sub !== slug) throw new Error("token de otro cliente")
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw new HttpError(401, "Sesión vencida: volvé a ingresar")
  }
}

// ── Contraseñas del portal (clientes que se inscriben solos) ─────────────────
// scrypt con sal aleatoria: "scrypt$N$r$p$sal$hash" (base64). Las contraseñas que cargó el estudio
// antes siguen en clientes.portal_password; las nuevas solo se guardan con hash en portal_accesos.

const SCRYPT = { N: 16384, r: 8, p: 1, largo: 32 }

export function hashPassword(password: string): string {
  const sal = crypto.randomBytes(16)
  const h = crypto.scryptSync(password, sal, SCRYPT.largo, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, sal.toString("base64"), h.toString("base64")].join("$")
}

export function verificarPassword(password: string, guardado: string): boolean {
  const [alg, n, r, p, sal, hash] = String(guardado ?? "").split("$")
  if (alg !== "scrypt" || !sal || !hash) return false
  const esperado = Buffer.from(hash, "base64")
  const h = crypto.scryptSync(password, Buffer.from(sal, "base64"), esperado.length, { N: Number(n), r: Number(r), p: Number(p) })
  return h.length === esperado.length && crypto.timingSafeEqual(h, esperado)
}

// Huella de la IP para los límites del alta pública (no se guarda la IP).
export function huellaIp(req: Request): string {
  const ip = req.headers.get("x-nf-client-connection-ip")
    ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "desconocida"
  return crypto.createHmac("sha256", llave("ip")).update(ip).digest("hex").slice(0, 32)
}

// ── Trabajos internos (cron → robot) ─────────────────────────────────────────

export const firmarTrabajo = (contenido: string) =>
  crypto.createHmac("sha256", llave("trabajos")).update(contenido).digest("hex")

export function trabajoValido(contenido: string, firma: unknown): boolean {
  if (typeof firma !== "string" || !/^[0-9a-f]{64}$/.test(firma)) return false
  return crypto.timingSafeEqual(Buffer.from(firmarTrabajo(contenido), "hex"), Buffer.from(firma, "hex"))
}
