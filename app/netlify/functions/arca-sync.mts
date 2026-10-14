import type { Config } from "@netlify/functions"
import { pedidoValido, sincronizarComprobantes } from "../../src/sincronizacion.mts"

// Corre el robot de ARCA para un cliente. Lo disparan el cron mensual o el botón del admin.
export default async (req: Request) => {
  const pedido = await req.json().catch(() => null)
  if (!pedidoValido(pedido)) {
    console.warn("[arca-sync] pedido sin firma válida, ignorado")
    return
  }
  // Escalonado para no entrar a ARCA con todos los clientes a la vez (el límite es 15 min).
  const demora = Math.min(Math.max(Number(pedido.demoraMs) || 0, 0), 12 * 60_000)
  if (demora) await new Promise((r) => setTimeout(r, demora))
  try {
    await sincronizarComprobantes(pedido.clienteId, pedido.anio, pedido.mes, pedido.tipos)
  } catch (e: any) {
    console.error(`[arca-sync] cliente ${pedido.clienteId}: ${String(e?.message ?? e).split("\n")[0]}`)
  }
}

export const config: Config = { background: true, path: "/jobs/arca-sync" }
