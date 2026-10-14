import type { Config, Context } from "@netlify/functions"
import { db, q } from "../../src/core.mts"
import { despacharSincronizacion, mesAnterior } from "../../src/sincronizacion.mts"

// Día 2 de cada mes: trae de ARCA el mes anterior de todos los clientes activos con clave fiscal.
export default async (_req: Request, context: Context) => {
  const { anio, mes } = mesAnterior()
  const filas = (await q(
    db().from("credenciales_arca").select("cliente_id, clientes!inner(activo)").eq("clientes.activo", true),
  )) ?? []
  const base = context.site.url ?? Netlify.env.get("URL")
  const resultados = await Promise.allSettled(
    filas.map((f: any, i: number) => despacharSincronizacion(base!, f.cliente_id, anio, mes, undefined, (i * 20_000) % (12 * 60_000))),
  )
  const fallidos = resultados.filter((r) => r.status === "rejected").length
  console.log(`[arca-sync-mensual] ${mes}/${anio}: ${filas.length} clientes, ${fallidos} sin despachar`)
}

// Día 2 a las 09:00 UTC = 06:00 en Argentina.
export const config: Config = { schedule: "0 9 2 * *" }
