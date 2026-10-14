import type { Browser } from "playwright-core"
import { getStore } from "@netlify/blobs"
import { db, diasEnMes, hoyArgentina, logActividad, q } from "./core.mts"
import { descifrarClave, firmarTrabajo, trabajoValido } from "./secretos.mts"
import { totalesComprobantesPorMes } from "./parsers.mts"
import {
  FalloArca, abrirMisComprobantes, abrirNavegador, bajarComprobantes, capturarEstado, elegirContribuyente,
  ingresar, type EstadoSync, type TipoComprobantes,
} from "./robot.mts"

export const TIPOS: TipoComprobantes[] = ["emitidos", "recibidos"]
const TABLA: Record<TipoComprobantes, "facturacion" | "gastos"> = { emitidos: "facturacion", recibidos: "gastos" }
const REINTENTOS = 3

// Último mes del período que evalúa la próxima recategorización. Ventanas: 20/01–05/02 (evalúa
// enero a diciembre del año anterior) y 20/07–05/08 (julio del año anterior a junio).
// De febrero a julio se apunta a la de agosto; de agosto a enero, a la de febrero.
export function finPeriodoProximaRecategorizacion() {
  const { y, m } = hoyArgentina()
  if (m >= 2 && m <= 7) return { anio: y, mes: 6 }
  if (m >= 8) return { anio: y, mes: 12 }
  return { anio: y - 1, mes: 12 }
}

const ms = (a: number, m: number, d: number) => Date.UTC(a, m - 1, d)
const ddmmaaaa = (a: number, m: number, d: number) => `${pad(d)}/${pad(m)}/${a}`

// 12 meses que terminan en (anio, mes), hasta hoy si el período no terminó. ARCA admite consultas de
// hasta 365 días: si el período completo se pasa (año bisiesto), se consulta en dos tramos.
export function periodoRecategorizacion(anio: number, mes: number) {
  const indice = anio * 12 + (mes - 1) - 11
  const inicio = { anio: Math.floor(indice / 12), mes: (indice % 12) + 1 }
  const t = hoyArgentina()
  const finPeriodo = ms(anio, mes, diasEnMes(anio, mes))
  const fin = finPeriodo < ms(t.y, t.m, t.d) ? { a: anio, m: mes, d: diasEnMes(anio, mes) } : { a: t.y, m: t.m, d: t.d }

  const dias = (ms(fin.a, fin.m, fin.d) - ms(inicio.anio, inicio.mes, 1)) / 86_400_000 + 1
  const tramos: { desde: string; hasta: string }[] = []
  if (dias <= 365) {
    tramos.push({ desde: ddmmaaaa(inicio.anio, inicio.mes, 1), hasta: ddmmaaaa(fin.a, fin.m, fin.d) })
  } else {
    const corte = indice + 6
    const medio = { anio: Math.floor(corte / 12), mes: (corte % 12) + 1 }
    const previo = corte - 1
    const finPrimero = { anio: Math.floor(previo / 12), mes: (previo % 12) + 1 }
    tramos.push({
      desde: ddmmaaaa(inicio.anio, inicio.mes, 1),
      hasta: ddmmaaaa(finPrimero.anio, finPrimero.mes, diasEnMes(finPrimero.anio, finPrimero.mes)),
    })
    tramos.push({ desde: ddmmaaaa(medio.anio, medio.mes, 1), hasta: ddmmaaaa(fin.a, fin.m, fin.d) })
  }
  return { inicio, tramos, texto: `${pad(inicio.mes)}/${inicio.anio} a ${pad(mes)}/${anio}` }
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

  const periodo = periodoRecategorizacion(anio, mes)
  const clave12 = (a: number, m: number) => a * 12 + m
  const enPeriodo = (a: number, m: number) =>
    clave12(a, m) >= clave12(periodo.inicio.anio, periodo.inicio.mes) && clave12(a, m) <= clave12(anio, mes)
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
        const totales: { anio: number; mes: number; monto: number }[] = []
        for (const tramo of periodo.tramos) {
          const excel = await bajarComprobantes(mc, tipo, tramo.desde, tramo.hasta)
          if (excel) totales.push(...totalesComprobantesPorMes(excel))
        }
        const etiqueta = tipo === "emitidos" ? "Facturación" : "Gastos"
        const fuera = totales.filter((t) => !enPeriodo(t.anio, t.mes))
        if (fuera.length) {
          throw new FalloArca("error", `El Excel de ${etiqueta.toLowerCase()} trajo meses fuera de ${periodo.texto} (${fuera.map((t) => `${t.mes}/${t.anio}`).join(", ")}); no se guardó nada`)
        }
        // Igual que la importación manual: solo se escriben los meses que tienen comprobantes.
        if (totales.length) {
          await q(d.from(TABLA[tipo]).upsert(
            totales.map((t) => ({
              cliente_id: clienteId, estudio_id: cliente.estudio_id, anio: t.anio, mes: t.mes, monto: t.monto, fuente: "arca_robot",
            })),
            { onConflict: "cliente_id,anio,mes" },
          ))
        }
        const total = totales.reduce((a, t) => a + t.monto, 0)
        const resumen = totales.length
          ? `${totales.length} meses con comprobantes, total ${pesos(total)}`
          : "ARCA no muestra comprobantes en el período"
        await registrar(tipo, "ok", `${etiqueta} ${periodo.texto}: ${resumen}`)
        await logActividad(clienteId, `${etiqueta} ${periodo.texto} traída de ARCA — ${resumen}`, cliente.estudio_id)
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
          titulo: `ARCA: no se pudieron traer los comprobantes de ${periodo.texto}`,
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
