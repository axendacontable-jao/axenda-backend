import type { Config, Context } from "@netlify/functions"
import { db, q } from "../../src/core.mts"
import { despacharSincronizacion, finPeriodoProximaRecategorizacion } from "../../src/sincronizacion.mts"

// Día 22 de cada mes (la cuota vence el 20): solo CCMA, para saber qué clientes pagaron la cuota
// del mes y actualizar deuda, historial de cuotas y estado de pago.
export default async (_req: Request, context: Context) => {
  const { anio, mes } = finPeriodoProximaRecategorizacion()
  const filas = (await q(
    db().from("credenciales_arca").select("cliente_id, clientes!inner(activo)").eq("clientes.activo", true),
  )) ?? []
  const base = context.site.url ?? Netlify.env.get("URL")
  const resultados = await Promise.allSettled(
    filas.map((f: any, i: number) => despacharSincronizacion(base!, f.cliente_id, anio, mes, ["ccma"], (i * 15_000) % (12 * 60_000))),
  )
  const fallidos = resultados.filter((r) => r.status === "rejected").length
  console.log(`[arca-cuotas-post-vencimiento] ${filas.length} clientes, ${fallidos} sin despachar`)
}

// Día 22 a las 12:00 UTC = 09:00 en Argentina.
export const config: Config = { schedule: "0 12 22 * *" }
