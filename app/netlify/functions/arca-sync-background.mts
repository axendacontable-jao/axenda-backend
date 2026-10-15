import type { Config } from "@netlify/functions"
import { pedidoFacturaValido, pedidoValido, procesarFactura, sincronizarCliente } from "../../src/sincronizacion.mts"

// Corre el robot de ARCA para un cliente: la sincronización (cron mensual o botón del admin) o una
// factura pedida desde el portal o el admin.
// El sufijo "-background" del archivo es necesario además de config.background: la CLI con la que
// se hacen los deploys de prueba no reconoce la opción y ejecutaba el robot en forma sincrónica.
export default async (req: Request) => {
  const pedido = await req.json().catch(() => null)
  if (pedidoFacturaValido(pedido)) {
    try {
      await procesarFactura(pedido.facturaId)
    } catch (e: any) {
      console.error(`[arca-sync] factura ${pedido.facturaId}: ${String(e?.message ?? e).split("\n")[0]}`)
    }
    return
  }
  if (!pedidoValido(pedido)) {
    console.warn("[arca-sync] pedido sin firma válida, ignorado")
    return
  }
  // Escalonado para no entrar a ARCA con todos los clientes a la vez (el límite es 15 min).
  const demora = Math.min(Math.max(Number(pedido.demoraMs) || 0, 0), 12 * 60_000)
  if (demora) await new Promise((r) => setTimeout(r, demora))
  try {
    await sincronizarCliente(pedido.clienteId, pedido.anio, pedido.mes, pedido.tipos)
  } catch (e: any) {
    console.error(`[arca-sync] cliente ${pedido.clienteId}: ${String(e?.message ?? e).split("\n")[0]}`)
  }
}

export const config: Config = { background: true, path: "/jobs/arca-sync" }
