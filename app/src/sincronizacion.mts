import type { Browser, Page } from "playwright-core"
import { getStore } from "@netlify/blobs"
import { db, diasEnMes, hoyArgentina, isoDate, logActividad, q } from "./core.mts"
import { descifrarClave, firmarTrabajo, trabajoValido } from "./secretos.mts"
import { type Comprobante, type MesCcma, type PlanArca, totalesComprobantesPorMes, ultimosComprobantes } from "./parsers.mts"
import {
  FalloArca, abrirMisComprobantes, abrirNavegador, bajarComprobantes, capturarEstado, consultarCuentaArt, consultarDeudaCcma,
  consultarFacilidades, consultarPlanesArt, elegirContribuyente, ingresar, ingresarArt, type DeudaCcma, type EstadoSync,
  type TipoComprobantes,
} from "./robot.mts"

export type Tarea = TipoComprobantes | "ccma" | "facilidades" | "art" | "art_planes"
export const TAREAS: Tarea[] = ["emitidos", "recibidos", "ccma", "facilidades", "art", "art_planes"]
const TABLA: Record<TipoComprobantes, "facturacion" | "gastos"> = { emitidos: "facturacion", recibidos: "gastos" }
const NOMBRE: Record<Tarea, string> = {
  emitidos: "facturación", recibidos: "gastos", ccma: "deuda CCMA", facilidades: "planes de Mis Facilidades",
  art: "deuda de ART Río Negro", art_planes: "planes de ART Río Negro",
}

// Estado de un plan de Mis Facilidades → estados de planes_pago (null: no se sabe, no se cambia).
function estadoPlan(texto: string | null): string | null {
  if (!texto) return null
  if (/caduc/i.test(texto)) return "caido"
  if (/cancel|finaliz|pagad|cumplid/i.test(texto)) return "cancelado"
  if (/anulad|rechaz|baja|desist/i.test(texto)) return "inactivo"
  if (/vigente|activ|presentad|aceptad/i.test(texto)) return "activo"
  return null
}
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

const pad = (n: number) => String(n).padStart(2, "0")
const ms = (a: number, m: number, d: number) => Date.UTC(a, m - 1, d)
const ddmmaaaa = (a: number, m: number, d: number) => `${pad(d)}/${pad(m)}/${a}`
const pesos = (n: number) => "$" + Math.round(n).toLocaleString("es-AR")
const esperar = (milis: number) => new Promise((r) => setTimeout(r, milis))
const redondear = (n: number) => Math.round(n * 100) / 100

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

const contenidoTrabajo = (clienteId: string, anio: number, mes: number, tareas: Tarea[]) =>
  `${clienteId}:${anio}:${mes}:${tareas.join(",")}`

export async function despacharSincronizacion(
  base: string, clienteId: string, anio: number, mes: number, tareas = TAREAS, demoraMs = 0,
) {
  const res = await fetch(`${base}/jobs/arca-sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clienteId, anio, mes, tipos: tareas, demoraMs, firma: firmarTrabajo(contenidoTrabajo(clienteId, anio, mes, tareas)),
    }),
  })
  if (res.status !== 202 && !res.ok) throw new Error(`No se pudo iniciar la sincronización (${res.status})`)
}

export const pedidoValido = (p: any) =>
  p && typeof p.clienteId === "string" && Number.isInteger(p.anio) && Number.isInteger(p.mes) &&
  Array.isArray(p.tipos) && p.tipos.every((t: string) => TAREAS.includes(t as Tarea)) &&
  trabajoValido(contenidoTrabajo(p.clienteId, p.anio, p.mes, p.tipos), p.firma)

function aFallo(e: any): FalloArca {
  if (e instanceof FalloArca) return e
  const msg = String(e?.message ?? e)
  const red = e?.name === "TimeoutError" || /net::|ECONN|ETIMEDOUT|ENOTFOUND|socket hang up|Timeout/i.test(msg)
  // Si Chromium no arranca, la causa está en su salida de error ("[pid=..][err] ...").
  const errChromium = msg.split("\n").find((l) => l.includes("[err]"))?.trim()
  const resumen = [msg.split("\n")[0], errChromium].filter(Boolean).join(" — ")
  return new FalloArca(red ? "arca_caido" : "error", resumen.slice(0, 500))
}

type Fallo = { fallo: FalloArca; pantalla: Awaited<ReturnType<typeof capturarEstado>> }

export async function sincronizarCliente(clienteId: string, anio: number, mes: number, tareas: Tarea[]) {
  const d = db()
  const cliente = await q(d.from("clientes").select("id,cuit,slug,estudio_id,nombre,apellido,provincia").eq("id", clienteId).single())
  const cred = await q(d.from("credenciales_arca").select("clave_cifrada").eq("cliente_id", clienteId).maybeSingle())
  if (!cred) return
  const clave = descifrarClave(cred.clave_cifrada, clienteId)
  // Ningún mensaje que se guarde o se loguee puede contener la clave.
  const limpiar = (s: string) => (clave ? s.split(clave).join("***") : s)

  const registrar = (tarea: Tarea | "cuotas", estado: EstadoSync, detalle: string, pantalla?: string) =>
    q(d.from("sincronizaciones_arca").insert({
      cliente_id: clienteId, estudio_id: cliente.estudio_id, tipo: tarea, anio, mes, estado, detalle: limpiar(detalle),
      pantalla: pantalla ? limpiar(pantalla).slice(0, 6000) : null,
    }))

  const periodo = periodoRecategorizacion(anio, mes)
  const clave12 = (a: number, m: number) => a * 12 + m
  const enPeriodo = (a: number, m: number) =>
    clave12(a, m) >= clave12(periodo.inicio.anio, periodo.inicio.mes) && clave12(a, m) <= clave12(anio, mes)

  async function traerComprobantes(mc: Page, tipo: TipoComprobantes) {
    const totales: { anio: number; mes: number; monto: number }[] = []
    const recientes: Comprobante[] = []
    for (const tramo of periodo.tramos) {
      const excel = await bajarComprobantes(mc, tipo, tramo.desde, tramo.hasta)
      if (!excel) continue
      totales.push(...totalesComprobantesPorMes(excel))
      if (tipo === "emitidos") recientes.push(...ultimosComprobantes(excel, 3))
    }
    if (tipo === "emitidos") {
      const ultimos = recientes.sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0)).slice(0, 3)
      await q(d.from("clientes").update({ ultimos_comprobantes: ultimos }).eq("id", clienteId))
    }
    const etiqueta = tipo === "emitidos" ? "Facturación" : "Gastos"
    const fuera = totales.filter((t) => !enPeriodo(t.anio, t.mes))
    if (fuera.length) {
      throw new FalloArca("error", `El Excel de ${NOMBRE[tipo]} trajo meses fuera de ${periodo.texto} (${fuera.map((t) => `${t.mes}/${t.anio}`).join(", ")}); no se guardó nada`)
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
  }

  async function traerDeuda(page: Page) {
    const deuda = await consultarDeudaCcma(page, cliente.cuit)
    const t = hoyArgentina()
    const descripcion = `CCMA al ${ddmmaaaa(t.y, t.m, t.d)} — ${deuda.detalle}`

    // A qué corresponde la deuda: cada período con saldo, por impuesto e intereses. El saldo deudor
    // de la CCMA no incluye las cuotas que todavía no vencieron: se marcan aparte.
    const hoyStr = isoDate(t.y, t.m, t.d)
    const detalle = deuda.meses
      ? [...deuda.meses]
        .filter(([, m]) => m.saldo > 1)
        .map(([k, m]) => {
          const [a, mes] = k.split("-").map(Number)
          return { periodo: `${a}-${pad(mes)}`, ...m, a_vencer: !!m.vencimiento && m.vencimiento >= hoyStr }
        })
        .sort((x, y) => (x.periodo < y.periodo ? 1 : -1))
      : null
    const vencido = detalle?.filter((p) => !p.a_vencer).reduce((s, p) => s + p.saldo, 0) ?? 0
    const aVencer = detalle?.filter((p) => p.a_vencer) ?? []
    const cuadra = !detalle || Math.abs(vencido - deuda.monto) <= 1

    await q(d.from("clientes").update({
      deuda_monto: deuda.monto, deuda_descripcion: descripcion, deuda_actualizada_at: new Date().toISOString(),
      deuda_detalle: detalle,
    }).eq("id", clienteId))
    const resumen = detalle
      ? ` (${detalle.length - aVencer.length} períodos vencidos${aVencer.length
        ? `; a vencer ${aVencer.map((p) => `${p.periodo.slice(5)}/${p.periodo.slice(0, 4)} ${pesos(p.saldo)}`).join(", ")}` : ""})`
      : ""
    await registrar("ccma", "ok", cuadra
      ? `${descripcion}${resumen}`
      : `${descripcion}${resumen} — ojo: los períodos vencidos suman ${pesos(vencido)}`, deuda.pantalla)
    await logActividad(clienteId, `Deuda traída de ARCA — ${descripcion}`, cliente.estudio_id)
    await actualizarHistorialCuotas(deuda).catch((e) =>
      registrar("cuotas", "error", `No se pudo actualizar el historial de cuotas: ${e?.message ?? e}`))
  }

  // Planes de Mis Facilidades → planes_pago (se emparejan por número; nunca se borra nada).
  async function traerFacilidades(page: Page) {
    const { planes, pantalla } = await consultarFacilidades(page, cliente.cuit)
    const nuevos = await guardarPlanes(planes, "ARCA", "arca")
    await registrar("facilidades", "ok", planes.length
      ? `${planes.length} planes en Mis Facilidades (${nuevos} nuevos): ${planes.map(describirPlan).join(" · ")}`
      : "Sin planes en Mis Facilidades", pantalla)
  }

  const describirPlan = (p: PlanArca) =>
    `${p.numero}${p.situacion ? ` ${p.situacion}` : p.estado ? ` ${p.estado}` : ""}${p.monto ? ` (${pesos(p.monto)})` : ""}`

  // Si hay varias filas con el mismo número se actualiza la más reciente; los planes que se
  // eliminaron a mano (estado "inactivo") no se vuelven a crear. Devuelve cuántos planes son nuevos.
  async function guardarPlanes(planes: PlanArca[], organismo: string, fuente: string) {
    const existentes = (await q(d.from("planes_pago").select("id,numero_plan,estado")
      .eq("cliente_id", clienteId).order("created_at", { ascending: true }))) ?? []
    const numeroPlan = (n: unknown) => String(n ?? "").replace(/\W/g, "").toUpperCase()
    const vigentes = new Map(existentes.filter((p: any) => p.estado !== "inactivo").map((p: any) => [numeroPlan(p.numero_plan), p]))
    const eliminados = new Set(existentes.filter((p: any) => p.estado === "inactivo").map((p: any) => numeroPlan(p.numero_plan)))
    const ahora = new Date().toISOString()
    let nuevos = 0
    for (const plan of planes) {
      const estado = estadoPlan(plan.situacion) ?? estadoPlan(plan.estado)
      const datos: Record<string, unknown> = Object.fromEntries(Object.entries({
        estado_arca: [plan.estado, plan.situacion].filter(Boolean).join(" · ") || null, estado,
        nombre_plan: plan.tipo, fecha_consolidacion: plan.consolidacion, monto_consolidado: plan.monto,
        total_cuotas: plan.cuotas, cuotas_pagas: plan.cuotasPagas, proximo_venc: plan.proximoVenc,
        arca_actualizado_at: ahora,
      }).filter(([, v]) => v !== null && v !== undefined))
      const actual = vigentes.get(numeroPlan(plan.numero))
      if (actual) {
        await q(d.from("planes_pago").update(datos).eq("id", actual.id))
      } else if (!eliminados.has(numeroPlan(plan.numero))) {
        await q(d.from("planes_pago").insert({
          ...datos, cliente_id: clienteId, estudio_id: cliente.estudio_id, numero_plan: plan.numero,
          organismo, fuente, estado: estado ?? "activo",
        }))
        nuevos++
      }
    }
    return nuevos
  }

  // ART Río Negro: anticipos de Ingresos Brutos (deuda real, ya no estimada) y su estado en el historial.
  async function traerCuentaArt(art: Page) {
    const t = hoyArgentina()
    const hoyStr = isoDate(t.y, t.m, t.d)
    const { anticipos, regimen, inscripcion, pantalla } = await consultarCuentaArt(art, t.y - 3)
    // "intereses": el anticipo se pagó fuera de término y quedó un resto (ART imputa primero los intereses).
    const conEstado = anticipos.map((p) => {
      const aVencer = !!p.vencimiento && p.vencimiento >= hoyStr
      const estado = p.saldo <= 1 ? "pagada"
        : p.impuesto > 0 && p.pagado >= p.impuesto - p.deducciones - 1 ? "intereses"
        : aVencer ? "a_vencer" : "vencida"
      return { ...p, a_vencer: aVencer, estado }
    })
    const detalle = conEstado.filter((p) => p.saldo > 1)
    const impagos = detalle.filter((p) => !p.a_vencer)
    const deuda = redondear(impagos.reduce((s, p) => s + p.saldo, 0))
    await q(d.from("clientes").update({
      art_deuda_monto: deuda, art_deuda_detalle: detalle, art_actualizada_at: new Date().toISOString(), art_regimen: regimen,
    }).eq("id", clienteId))

    // Estado del anticipo de ART de cada mes (últimos 12), junto al de la cuota de ARCA.
    const existentes = new Map<string, any>(
      ((await q(d.from("historial_cuotas").select("id,año,mes").eq("cliente_id", clienteId))) ?? [])
        .map((h: any) => [`${h["año"]}-${h.mes}`, h]),
    )
    for (let i = 0; i < 12; i++) {
      const idx = t.y * 12 + (t.m - 1) - i
      const anio = Math.floor(idx / 12)
      const mes = (idx % 12) + 1
      const p = conEstado.find((x) => x.periodo === `${anio}-${pad(mes)}`)
      if (!p) continue
      const fila = {
        art_estado: p.estado, art_impuesto: p.impuesto, art_pagado: p.pagado, art_saldo: p.saldo, art_vencimiento: p.vencimiento,
      }
      const actual = existentes.get(`${anio}-${mes}`)
      if (actual) await q(d.from("historial_cuotas").update(fila).eq("id", actual.id))
      else await q(d.from("historial_cuotas").insert({ cliente_id: clienteId, año: anio, mes, ...fila }))
    }

    const periodo = (k: string) => `${k.slice(5)}/${k.slice(0, 4)}`
    const resumen = impagos.length
      ? `deuda ${pesos(deuda)} (${impagos.length} períodos con deuda: ${impagos.map((p) => periodo(p.periodo)).join(", ")})`
      : "sin deuda"
    const descripcion = `ART Río Negro al ${ddmmaaaa(t.y, t.m, t.d)} — ${inscripcion ?? "Ingresos Brutos"}: ${resumen}`
    await registrar("art", "ok", `${descripcion}${regimen ? ` · ${regimen}` : ""} · ${anticipos.length} períodos leídos`, pantalla)
    await logActividad(clienteId, descripcion, cliente.estudio_id)
  }

  async function traerPlanesArt(art: Page, panel: string) {
    const { planes, pantalla } = await consultarPlanesArt(art, panel)
    if (!planes) {
      await registrar("art_planes", "error", `No encontré la lista de planes de pago de ART: ${pantalla.slice(0, 300)}`, pantalla)
      return
    }
    const nuevos = await guardarPlanes(planes, "ART", "art")
    await registrar("art_planes", "ok", planes.length
      ? `${planes.length} planes en ART (${nuevos} nuevos): ${planes.map(describirPlan).join(" · ")}`
      : "Sin planes de pago en ART", pantalla)
  }

  // Con la clave fiscal cargada, ARCA dice qué meses se deben: el historial deja de ser manual.
  async function actualizarHistorialCuotas(deuda: DeudaCcma) {
    if (deuda.meses) return historialDesdeMovimientos(deuda.meses)
    let adeudados: Set<string>
    if (deuda.saldos) {
      adeudados = new Set([...deuda.saldos].filter(([, saldo]) => saldo > 1).map(([k]) => k))
    } else if (deuda.monto <= 0) {
      adeudados = new Set()
    } else {
      await registrar("cuotas", "error", "La CCMA informa deuda pero no muestra el detalle por período: el historial de cuotas no se actualizó", deuda.pantalla)
      return
    }
    if (deuda.monto > 1 && adeudados.size === 0) {
      await registrar("cuotas", "error", "La CCMA informa deuda pero ningún período con saldo: el historial de cuotas no se actualizó", deuda.pantalla)
      return
    }

    // Si la CCMA lista todos los períodos (incluidos los saldados en $0), los meses anteriores al
    // primero que muestra no se conocen: no se tocan. Si lista solo los adeudados, los que no
    // aparecen están pagos.
    const indiceDe = (k: string) => { const [a, m] = k.split("-").map(Number); return a * 12 + (m - 1) }
    const listadoCompleto = !!deuda.saldos && [...deuda.saldos.values()].some((s) => Math.abs(s) <= 1)
    const desdeIndice = listadoCompleto ? Math.min(...[...deuda.saldos!.keys()].map(indiceDe)) : -Infinity

    const t = hoyArgentina()
    const existentes = new Map<string, any>(
      ((await q(d.from("historial_cuotas").select("*").eq("cliente_id", clienteId))) ?? [])
        .map((h: any) => [`${h["año"]}-${h.mes}`, h]),
    )
    const ahora = new Date().toISOString()
    let cambios = 0
    // Últimos 6 meses: lo que muestran el admin y el portal.
    for (let i = 0; i < 6; i++) {
      const idx = t.y * 12 + (t.m - 1) - i
      if (idx < desdeIndice) continue
      const anioMes = { anio: Math.floor(idx / 12), mes: (idx % 12) + 1 }
      const k = `${anioMes.anio}-${anioMes.mes}`
      const debe = adeudados.has(k)
      // Mes en curso sin deuda antes del vencimiento (día 20): todavía no se sabe si lo va a pagar.
      if (i === 0 && !debe && t.d <= 20) continue
      const pagado = !debe
      const actual = existentes.get(k)
      if (actual && !!actual.pagado === pagado) continue
      if (actual) {
        await q(d.from("historial_cuotas").update({ pagado, fecha_pago: pagado ? ahora : null }).eq("id", actual.id))
      } else {
        await q(d.from("historial_cuotas").insert({ cliente_id: clienteId, año: anioMes.anio, mes: anioMes.mes, pagado, fecha_pago: pagado ? ahora : null }))
      }
      cambios++
    }

    const actualDebe = adeudados.has(`${t.y}-${t.m}`)
    if (actualDebe || t.d > 20) {
      await q(d.from("clientes").update({ estado_pago: actualDebe ? "debe" : "al_dia" }).eq("id", clienteId))
    }
    const meses = [...adeudados].map((k) => { const [a, m] = k.split("-"); return `${pad(Number(m))}/${a}` }).sort()
    await registrar("cuotas", "ok", meses.length
      ? `Según ARCA se deben ${meses.length} períodos: ${meses.join(", ")} (${cambios} meses actualizados)`
      : `Según ARCA no hay cuotas adeudadas (${cambios} meses actualizados)`)
  }

  // Detalle real de cada mes (últimos 12) a partir de los movimientos de la CCMA.
  async function historialDesdeMovimientos(meses: Map<string, MesCcma>) {
    const t = hoyArgentina()
    const hoyStr = isoDate(t.y, t.m, t.d)
    const existentes = new Map<string, any>(
      ((await q(d.from("historial_cuotas").select("*").eq("cliente_id", clienteId))) ?? [])
        .map((h: any) => [`${h["año"]}-${h.mes}`, h]),
    )
    const ahora = new Date().toISOString()
    const ETIQUETA: Record<string, string> = { intereses: "intereses", vencida: "vencida", a_vencer: "a vencer" }
    const pendientes: string[] = []

    for (let i = 0; i < 12; i++) {
      const idx = t.y * 12 + (t.m - 1) - i
      const anio = Math.floor(idx / 12)
      const mes = (idx % 12) + 1
      const m = meses.get(`${anio}-${mes}`)
      if (!m) continue // ARCA no tiene obligación ese mes
      const saldada = m.saldo <= 1
      const cuotaPaga = m.obligacion > 0 ? m.pagos >= m.obligacion - 1 : saldada
      const estado = saldada ? "pagada"
        : cuotaPaga ? "intereses"
        : m.vencimiento && m.vencimiento < hoyStr ? "vencida" : "a_vencer"
      const actual = existentes.get(`${anio}-${mes}`)
      const fila = {
        pagado: cuotaPaga, estado, obligacion: m.obligacion, pagos: m.pagos, intereses: m.intereses,
        saldo: Math.max(m.saldo, 0), vencimiento: m.vencimiento, impuestos: m.impuestos, fuente: "arca",
        fecha_pago: cuotaPaga ? (actual?.pagado && actual.fecha_pago ? actual.fecha_pago : ahora) : null,
      }
      if (actual) await q(d.from("historial_cuotas").update(fila).eq("id", actual.id))
      else await q(d.from("historial_cuotas").insert({ cliente_id: clienteId, año: anio, mes, ...fila }))
      if (estado !== "pagada") pendientes.push(`${pad(mes)}/${anio} ${ETIQUETA[estado]} ${pesos(m.saldo)}`)
    }

    // Estado de la cuota del mes en curso (si ARCA ya generó la obligación).
    const delMes = meses.get(`${t.y}-${t.m}`)
    if (delMes && delMes.obligacion > 0) {
      const paga = delMes.pagos >= delMes.obligacion - 1
      const vencida = !!delMes.vencimiento && delMes.vencimiento < hoyStr
      await q(d.from("clientes").update({ estado_pago: paga ? "al_dia" : vencida ? "vencida" : "debe" }).eq("id", clienteId))
    }
    await registrar("cuotas", "ok", pendientes.length
      ? `Según ARCA: ${pendientes.join(" · ")}`
      : "Según ARCA no hay cuotas adeudadas en los últimos 12 meses")
  }

  const pendientes = new Set(tareas)
  // ART solo para clientes de Río Negro (sin provincia cargada se asume Río Negro, como en el resto de la app).
  if (!/r[ií]o negro/i.test(cliente.provincia || "Rio Negro")) {
    pendientes.delete("art")
    pendientes.delete("art_planes")
  }
  const definitivos = new Map<Tarea, Fallo>()

  for (let intento = 1; intento <= REINTENTOS && pendientes.size; intento++) {
    let browser: Browser | null = null
    const fallos = new Map<Tarea, Fallo>()
    const fallar = async (afectadas: Tarea[], e: unknown) => {
      const f = { fallo: aFallo(e), pantalla: await capturarEstado(browser) }
      for (const t of afectadas) fallos.set(t, f)
    }
    try {
      browser = await abrirNavegador()
      const page = await browser.newPage({ acceptDownloads: true })
      await ingresar(page, cliente.cuit, clave)

      // Comprobantes, deuda y planes fallan por separado: si una parte falla, las otras se guardan igual.
      const comprobantes = [...pendientes].filter((t): t is TipoComprobantes => t === "emitidos" || t === "recibidos")
      if (comprobantes.length) {
        try {
          const mc = await abrirMisComprobantes(page)
          await elegirContribuyente(mc, cliente.cuit)
          for (const tipo of comprobantes) {
            await traerComprobantes(mc, tipo)
            pendientes.delete(tipo)
          }
          if (mc !== page) await mc.close().catch(() => {})
        } catch (e) {
          await fallar([...pendientes].filter((t) => t === "emitidos" || t === "recibidos"), e)
        }
      }
      if (pendientes.has("ccma")) {
        try {
          await traerDeuda(page)
          pendientes.delete("ccma")
        } catch (e) {
          await fallar(["ccma"], e)
        }
      }
      if (pendientes.has("facilidades")) {
        try {
          await traerFacilidades(page)
          pendientes.delete("facilidades")
        } catch (e) {
          await fallar(["facilidades"], e)
        }
      }
      const deArt = [...pendientes].filter((t) => t === "art" || t === "art_planes")
      if (deArt.length) {
        try {
          const art = await ingresarArt(page, cliente.cuit)
          const panel = art.url()
          if (pendientes.has("art")) {
            try {
              await traerCuentaArt(art)
              pendientes.delete("art")
            } catch (e) {
              await fallar(["art"], e)
            }
          }
          if (pendientes.has("art_planes")) {
            try {
              await traerPlanesArt(art, panel)
              pendientes.delete("art_planes")
            } catch (e) {
              await fallar(["art_planes"], e)
            }
          }
        } catch (e) {
          await fallar(deArt.filter((t) => pendientes.has(t)), e)
        }
      }
    } catch (e) {
      // Falló antes de llegar a las tareas (navegador o login): afecta a todas.
      await fallar([...pendientes], e)
    } finally {
      await browser?.close().catch(() => {})
    }

    const hayCaidos = [...fallos.values()].some((f) => f.fallo.estado === "arca_caido")
    for (const [tarea, f] of fallos) {
      if (f.fallo.estado === "arca_caido" && intento < REINTENTOS) continue
      definitivos.set(tarea, f)
      pendientes.delete(tarea)
    }
    if (hayCaidos && pendientes.size) await esperar(intento * 20_000)
  }

  if (!definitivos.size) return
  for (const [tarea, { fallo, pantalla }] of definitivos) {
    const detalle = [fallo.message, pantalla && `en ${pantalla.url}`, pantalla?.texto && `pantalla: ${pantalla.texto}`]
      .filter(Boolean).join(" — ")
    await registrar(tarea, fallo.estado, detalle)
  }
  const captura = [...definitivos.values()].find((f) => f.pantalla?.captura)?.pantalla?.captura
  if (captura) await getStore("arca-capturas").set(clienteId, captura).catch(() => {})
  const que = [...definitivos.keys()].map((t) => NOMBRE[t]).join(", ")
  await q(d.from("alertas").insert({
    cliente_id: clienteId, estudio_id: cliente.estudio_id, tipo: "arca", icono: "🏛️", leida: false,
    titulo: `ARCA: no se pudo traer ${que}`,
    descripcion: limpiar([...new Set([...definitivos.values()].map((f) => f.fallo.message))].join(" / ")),
  })).catch((e) => console.error(`[arca-sync] no se pudo crear la alerta: ${e?.message ?? e}`))
}
