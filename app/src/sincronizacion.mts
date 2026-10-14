import type { Browser } from "playwright-core"
import { getStore } from "@netlify/blobs"
import { db, diasEnMes, hoy, logActividad, q } from "./core.mts"
import { descifrarClave, firmarTrabajo, trabajoValido } from "./secretos.mts"
import { totalesComprobantesPorMes } from "./parsers.mts"
import {
  FalloArca, abrirMisComprobantes, abrirNavegador, bajarComprobantes, capturarEstado, elegirContribuyente,
  ingresar, type EstadoSync, type TipoComprobantes,
} from "./robot.mts"

export const TIPOS: TipoComprobantes[] = ["emitidos", "recibidos"]
const TABLA: Record<TipoComprobantes, "facturacion" | "gastos"> = { emitidos: "facturacion", recibidos: "gastos" }
const REINTENTOS = 3

export function mesAnterior() {
  const t = hoy()
  return t.m === 1 ? { anio: t.y - 1, mes: 12 } : { anio: t.y, mes: t.m - 1 }
}

const contenidoTrabajo = (clienteId: string, anio: number, mes: number, tipos: TipoComprobantes[]) =>
  `${clienteId}:${anio}:${mes}:${tipos.join(",")}`

export async function despacharSincronizacion(
  base: string, clienteId: string, anio: number, mes: number, tipos = TIPOS, demoraMs = 0,
) {
  const res = await fetch(`${base}/jobs/arca-sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clienteId, anio, mes, tipos, demoraMs, firma: firmarTrabajo(contenidoTrabajo(clienteId, anio, mes, tipos)) }),
  })
  if (res.status !== 202 && !res.ok) throw new Error(`No se pudo iniciar la sincronización (${res.status})`)
}

export const pedidoValido = (p: any) =>
  p && typeof p.clienteId === "string" && Number.isInteger(p.anio) && Number.isInteger(p.mes) &&
  Array.isArray(p.tipos) && p.tipos.every((t: string) => TIPOS.includes(t as TipoComprobantes)) &&
  trabajoValido(contenidoTrabajo(p.clienteId, p.anio, p.mes, p.tipos), p.firma)

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms))
const pad = (n: number) => String(n).padStart(2, "0")
const pesos = (n: number) => "$" + Math.round(n).toLocaleString("es-AR")

function aFallo(e: any): FalloArca {
  if (e instanceof FalloArca) return e
  const msg = String(e?.message ?? e)
  const red = e?.name === "TimeoutError" || /net::|ECONN|ETIMEDOUT|ENOTFOUND|socket hang up|Timeout/i.test(msg)
  return new FalloArca(red ? "arca_caido" : "error", msg.split("\n")[0].slice(0, 300))
}

export async function sincronizarComprobantes(clienteId: string, anio: number, mes: number, tipos: TipoComprobantes[]) {
  const d = db()
  const cliente = await q(d.from("clientes").select("id,cuit,slug,estudio_id,nombre,apellido").eq("id", clienteId).single())
  const cred = await q(d.from("credenciales_arca").select("clave_cifrada").eq("cliente_id", clienteId).maybeSingle())
  if (!cred) return
  const clave = descifrarClave(cred.clave_cifrada, clienteId)
  // Ningún mensaje que se guarde o se loguee puede contener la clave.
  const limpiar = (s: string) => (clave ? s.split(clave).join("***") : s)

  const registrar = (tipo: TipoComprobantes, estado: EstadoSync, detalle: string) =>
    q(d.from("sincronizaciones_arca").insert({
      cliente_id: clienteId, estudio_id: cliente.estudio_id, tipo, anio, mes, estado, detalle: limpiar(detalle),
    }))

  const desde = `01/${pad(mes)}/${anio}`
  const hasta = `${diasEnMes(anio, mes)}/${pad(mes)}/${anio}`
  const pendientes = new Set(tipos)

  for (let intento = 1; intento <= REINTENTOS && pendientes.size; intento++) {
    let browser: Browser | null = null
    try {
      browser = await abrirNavegador()
      const page = await browser.newPage({ acceptDownloads: true })
      await ingresar(page, cliente.cuit, clave)
      const mc = await abrirMisComprobantes(page)
      await elegirContribuyente(mc, cliente.cuit)
      for (const tipo of [...pendientes]) {
        const excel = await bajarComprobantes(mc, tipo, desde, hasta)
        const totales = excel ? totalesComprobantesPorMes(excel) : []
        const etiqueta = tipo === "emitidos" ? "Facturación" : "Gastos"
        const otros = totales.filter((t) => t.anio !== anio || t.mes !== mes)
        if (otros.length) {
          throw new FalloArca("error", `El Excel de ${etiqueta.toLowerCase()} trajo otros meses (${otros.map((t) => `${t.mes}/${t.anio}`).join(", ")}); no se guardó nada`)
        }
        const monto = totales.reduce((a, t) => a + t.monto, 0)
        const existente = await q(
          d.from(TABLA[tipo]).select("monto").eq("cliente_id", clienteId).eq("anio", anio).eq("mes", mes).maybeSingle(),
        )
        if (!totales.length && Number(existente?.monto) > 0) {
          await registrar(tipo, "ok", `${etiqueta} ${pad(mes)}/${anio}: ARCA no muestra comprobantes; se mantiene lo cargado (${pesos(Number(existente.monto))})`)
          pendientes.delete(tipo)
          continue
        }
        await q(d.from(TABLA[tipo]).upsert(
          { cliente_id: clienteId, estudio_id: cliente.estudio_id, anio, mes, monto, fuente: "arca_robot" },
          { onConflict: "cliente_id,anio,mes" },
        ))
        await registrar(tipo, "ok", `${etiqueta} ${pad(mes)}/${anio}: ${pesos(monto)}`)
        await logActividad(clienteId, `${etiqueta} ${pad(mes)}/${anio} traída de ARCA — ${pesos(monto)}`, cliente.estudio_id)
        pendientes.delete(tipo)
      }
    } catch (e) {
      const fallo = aFallo(e)
      const estadoPagina = await capturarEstado(browser)
      const reintentable = fallo.estado === "arca_caido" && intento < REINTENTOS
      if (!reintentable) {
        const detalle = [fallo.message, estadoPagina && `en ${estadoPagina.url}`, estadoPagina?.texto && `pantalla: ${estadoPagina.texto}`]
          .filter(Boolean).join(" — ")
        for (const tipo of pendientes) await registrar(tipo, fallo.estado, detalle)
        if (estadoPagina?.captura) {
          await getStore("arca-capturas").set(clienteId, estadoPagina.captura).catch(() => {})
        }
        await q(d.from("alertas").insert({
          cliente_id: clienteId, estudio_id: cliente.estudio_id, tipo: "arca", icono: "🏛️", leida: false,
          titulo: `ARCA: no se pudieron traer los comprobantes de ${pad(mes)}/${anio}`,
          descripcion: limpiar(fallo.message),
        })).catch((e) => console.error(`[arca-sync] no se pudo crear la alerta: ${e?.message ?? e}`))
        break
      }
      await esperar(intento * 20_000)
    } finally {
      await browser?.close().catch(() => {})
    }
  }
}
