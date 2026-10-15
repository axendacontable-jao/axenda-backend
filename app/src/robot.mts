import type { Browser, Frame, Locator, Page } from "playwright-core"
import {
  type AnticipoArt, type MesCcma, type PlanArca, leerCuentaCorrienteArt, leerPlanesFacilidades, movimientosCcma, parseMonto,
  saldosPorPeriodo,
} from "./parsers.mts"

// Debe coincidir con la versión de @sparticuz/chromium-min del package.json.
const CHROMIUM_PACK = "https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar"
const LOGIN_URL = "https://auth.afip.gob.ar/contribuyente_/login.xhtml"
const PORTAL_URL = "https://portalcf.cloud.afip.gob.ar/portal/app/"
const PORTAL = /portalcf\.cloud\.afip\.gob\.ar/
const MCMP = /fes\.afip\.gob\.ar\/mcmp/
const T = 30_000

export type EstadoSync = "ok" | "clave_incorrecta" | "requiere_2fa" | "captcha" | "arca_caido" | "error"
export type TipoComprobantes = "emitidos" | "recibidos"

export class FalloArca extends Error {
  estado: EstadoSync
  constructor(estado: EstadoSync, mensaje: string) {
    super(mensaje)
    this.estado = estado
  }
}

export async function abrirNavegador(): Promise<Browser> {
  // chromium-min 131 elige las librerías por la versión de Node de Lambda: con 18.x usa las de
  // Amazon Linux 2 y solo reconoce "20.x" para las de AL2023. Node 22+ también corre sobre AL2023,
  // así que se lo presenta como 20.x (si no, Chromium no arranca). Debe hacerse antes del import.
  const runtime = process.env.AWS_EXECUTION_ENV ?? ""
  const version = Number(runtime.match(/nodejs(\d+)/)?.[1] ?? 0)
  if (version >= 22) process.env.AWS_EXECUTION_ENV = "AWS_Lambda_nodejs20.x"
  const { default: chromium } = await import("@sparticuz/chromium-min")
  const { chromium: pw } = await import("playwright-core")
  const executablePath = await chromium.executablePath(CHROMIUM_PACK)
  // chromium-min fija LD_LIBRARY_PATH al cargarse; según cómo se empaquetó la función eso puede
  // pasar antes del ajuste de arriba y apuntar a /tmp/al2/lib. Se fuerza la carpeta que corresponde.
  if (version) {
    const libs = version >= 20 ? "/tmp/al2023/lib" : "/tmp/al2/lib"
    const otras = (process.env.LD_LIBRARY_PATH ?? "").split(":").filter((p) => p && !/^\/tmp\/al2(023)?\/lib$/.test(p))
    process.env.LD_LIBRARY_PATH = [libs, ...otras].join(":")
  }
  return pw.launch({ executablePath, args: chromium.args, headless: true })
}

// Una pestaña o un marco (ART abre sus pantallas viejas dentro de marcos).
type Lugar = Page | Frame

const textoVisible = (page: Lugar) => page.locator("body").innerText({ timeout: 5000 }).catch(() => "")
const resumen = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 300)

async function primeroVisible(candidatos: Locator[], timeout = T): Promise<Locator | null> {
  const limite = Date.now() + timeout
  while (Date.now() < limite) {
    for (const c of candidatos) if (await c.first().isVisible().catch(() => false)) return c.first()
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

async function detectarBloqueos(page: Page) {
  if (page.url().startsWith("chrome-error")) {
    throw new FalloArca("arca_caido", "La página de ARCA no cargó (problema de red o ARCA caído)")
  }
  if (await page.locator("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], [id*='captcha' i], [class*='captcha' i]").count()) {
    throw new FalloArca("captcha", "ARCA pidió un captcha: hay que cargar los comprobantes a mano este mes")
  }
  const t = (await textoVisible(page)).toLowerCase()
  if (/dos pasos|doble factor|segundo factor|c[oó]digo de verificaci[oó]n|token de seguridad/.test(t)) {
    throw new FalloArca("requiere_2fa", "La cuenta tiene verificación en dos pasos: el robot no puede ingresar")
  }
  if (/(cambiar|modificar) (su|tu|la) clave|clave (fiscal )?(ha )?vencid/.test(t)) {
    throw new FalloArca("clave_incorrecta", "ARCA pide cambiar la clave fiscal")
  }
  if (/servicio no (est[aá] )?disponible|en mantenimiento|intente (nuevamente )?m[aá]s tarde/.test(t)) {
    throw new FalloArca("arca_caido", "ARCA informa que el servicio no está disponible")
  }
}

export async function ingresar(page: Page, cuit: string, clave: string) {
  try {
    await page.goto(LOGIN_URL, { timeout: T, waitUntil: "domcontentloaded" })
  } catch (e: any) {
    throw new FalloArca("arca_caido", `No abre el login de ARCA: ${e?.message ?? e}`)
  }
  await detectarBloqueos(page)
  await page.locator("#F1\\:username").fill(cuit, { timeout: T })
  await page.locator("#F1\\:btnSiguiente").click({ timeout: T })

  const pwd = page.locator("#F1\\:password")
  if (!(await primeroVisible([pwd], T))) {
    await detectarBloqueos(page)
    throw new FalloArca("clave_incorrecta", `ARCA no aceptó el CUIT: ${resumen(await textoVisible(page))}`)
  }
  await pwd.fill(clave)
  await page.locator("#F1\\:btnIngresar").click({ timeout: T })
  await page.waitForURL((u) => !u.href.includes("/contribuyente_/login"), { timeout: T }).catch(() => {})
  await detectarBloqueos(page)
  if (page.url().includes("/contribuyente_/login")) {
    throw new FalloArca("clave_incorrecta", `ARCA rechazó el ingreso: ${resumen(await textoVisible(page))}`)
  }
}

// Busca un servicio en el portal "Mi ARCA": primero en la portada ("Más utilizados"), después con el
// buscador "¿Qué necesitás? | Buscá trámites y servicios" (hay que tipearlo: la lista de resultados
// aparece con el teclado) y por último en "Mis servicios".
async function buscarServicio(page: Page, nombre: RegExp, busqueda: string): Promise<Locator> {
  if (!PORTAL.test(page.url())) await page.goto(PORTAL_URL, { timeout: T }).catch(() => {})
  await page.waitForLoadState("networkidle", { timeout: T }).catch(() => {})
  const servicio = () => page.getByText(nombre)

  let enlace = await primeroVisible([servicio()], 10_000)
  let buscadorVisto = "sin buscador"
  if (!enlace) {
    const buscador = await primeroVisible([
      page.getByRole("searchbox"), page.getByPlaceholder(/busc|necesit/i), page.getByRole("combobox"),
      page.locator("input[type='search'], input[type='text']"),
    ], 8000)
    if (buscador) {
      buscadorVisto = `buscador ${await buscador.evaluate((e) => `${e.tagName.toLowerCase()} "${(e as HTMLInputElement).placeholder ?? ""}"`).catch(() => "")}`
      await buscador.click().catch(() => {})
      await buscador.fill("").catch(() => {})
      await buscador.pressSequentially(busqueda, { delay: 80 })
      enlace = await primeroVisible([servicio()], 12_000)
      if (!enlace) {
        await buscador.press("Enter").catch(() => {})
        enlace = await primeroVisible([servicio()], 12_000)
      }
      if (!enlace) buscadorVisto += `, resultados: ${resumen(await textoVisible(page)).slice(0, 200)}`
    }
  }
  if (!enlace) {
    await page.goto(`${PORTAL_URL}mis-servicios`, { timeout: T }).catch(() => {})
    await page.waitForLoadState("networkidle", { timeout: T }).catch(() => {})
    enlace = await primeroVisible([servicio()], 15_000)
  }
  if (!enlace) {
    throw new FalloArca("error", `No aparece '${busqueda}' en el portal de ARCA (¿está habilitado el servicio para este CUIT?) [${buscadorVisto}]`)
  }
  return enlace
}

// Abre un servicio del portal "Mi ARCA" (suelen abrirse en otra pestaña).
async function abrirServicio(page: Page, nombre: RegExp, busqueda: string): Promise<Page> {
  const enlace = await buscarServicio(page, nombre, busqueda)
  const [nueva] = await Promise.all([
    page.context().waitForEvent("page", { timeout: T }).catch(() => null),
    enlace.click(),
  ])
  const abierta = nueva ?? page
  await abierta.waitForLoadState("domcontentloaded", { timeout: T }).catch(() => {})
  await abierta.waitForLoadState("networkidle", { timeout: T }).catch(() => {})
  await detectarBloqueos(abierta)
  return abierta
}

export async function abrirMisComprobantes(page: Page): Promise<Page> {
  const mc = await abrirServicio(page, /^\s*Mis Comprobantes\s*$/i, "Mis Comprobantes")
  await mc.waitForURL(MCMP, { timeout: T }).catch(() => {})
  if (!MCMP.test(mc.url())) throw new FalloArca("error", `No se abrió Mis Comprobantes (quedó en ${mc.url()})`)
  return mc
}

const CLICKEABLES = "a, button, [onclick], [role='button'], input[type='submit'], input[type='button']"

// Lista corta de lo que se puede tocar en pantalla, para diagnosticar cuando no aparece un botón.
export async function describirClickeables(page: Lugar): Promise<string> {
  const items = await page.locator(CLICKEABLES).evaluateAll((els) =>
    els
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .slice(0, 25)
      .map((el) => {
        const e = el as HTMLElement
        const texto = ((e.innerText || (e as HTMLInputElement).value || "") as string).replace(/\s+/g, " ").trim().slice(0, 40)
        return `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : ""} "${texto}"`
      }),
  ).catch(() => [] as string[])
  return items.join(" | ")
}

// "Elegí una persona", "Selecciona la CUIT a representar" (CCMA), "Seleccione una de las Cuits asociadas" (Mis Facilidades).
const PIDE_PERSONA = /eleg[ií] una persona|a qui[eé]n (quer[eé]s )?represent|seleccion\w*\s+(el |la |un |una de las |una )?(contribuyente|persona|cuit)/i

// "Elegí una persona para ingresar": aparece cuando el CUIT puede representar a otros.
// El CUIT también figura en el encabezado, así que se busca un elemento clickeable fuera de él.
export async function elegirContribuyente(mc: Page, cuit: string) {
  await mc.waitForLoadState("networkidle", { timeout: T }).catch(() => {})
  if (!PIDE_PERSONA.test(await textoVisible(mc))) return

  const continuar = async () => {
    const seguir = await primeroVisible([mc.getByRole("button", { name: /continuar|aceptar|ingresar|seleccionar|elegir/i })], 5000)
    if (seguir) await seguir.click()
    await mc.waitForLoadState("networkidle", { timeout: T }).catch(() => {})
  }

  // Variante con lista desplegable (CCMA: "Selecciona la CUIT a representar" + "Elegir CUIT").
  const selects = mc.locator("select")
  for (let i = 0, n = await selects.count(); i < n; i++) {
    const s = selects.nth(i)
    const valor = await s.evaluate((el, c) =>
      [...(el as HTMLSelectElement).options].find((o) => (o.text + o.value).replace(/\D/g, "").includes(c))?.value ?? null, cuit)
    if (valor === null) continue
    await s.selectOption(valor)
    return continuar()
  }

  // Variante con botones de opción: el CUIT tiene que estar en su valor, su etiqueta o en un
  // contenedor propio (no en uno compartido con los otros CUIT).
  const radios = mc.locator("input[type='radio']")
  for (let i = 0, n = await radios.count(); i < n; i++) {
    const r = radios.nth(i)
    const esEste = await r.evaluate((el, c) => {
      const inp = el as HTMLInputElement
      const digitos = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "")
      if (digitos(inp.value).includes(c) || [...(inp.labels ?? [])].some((l) => digitos(l.innerText).includes(c))) return true
      const cuits = (inp.parentElement?.innerText ?? "").match(/\d{2}-?\d{8}-?\d/g) ?? []
      return cuits.length === 1 && digitos(cuits[0]) === c
    }, cuit)
    if (!esEste) continue
    await r.check()
    return continuar()
  }

  const candidatos = mc.locator(CLICKEABLES)
  let elegido: Locator | null = null
  for (let i = 0, n = await candidatos.count(); i < n && !elegido; i++) {
    const c = candidatos.nth(i)
    if (!(await c.isVisible().catch(() => false))) continue
    const info = await c.evaluate((el) => ({
      digitos: ((el as HTMLElement).innerText + " " + ((el as HTMLInputElement).value ?? "")).replace(/\D/g, ""),
      enEncabezado: !!el.closest("nav, header, .navbar"),
    }))
    if (!info.enEncabezado && info.digitos.includes(cuit)) elegido = c
  }
  if (!elegido) {
    // Tarjeta que contiene el CUIT (la más interna, que es la última en orden de documento).
    const fmt = `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}`
    const tarjetas = mc.locator("li, tr, form, .card, .panel, div").filter({ hasText: new RegExp(`${fmt}|${cuit}`) })
    const n = await tarjetas.count()
    if (n) {
      const tarjeta = tarjetas.nth(n - 1)
      const boton = tarjeta.locator(CLICKEABLES).first()
      elegido = (await boton.count()) ? boton : tarjeta
    }
  }
  if (!elegido) {
    throw new FalloArca("error", `No pude elegir a ${cuit} en "Elegí una persona". Botones: ${await describirClickeables(mc)}`)
  }
  await elegido.click()
  await mc.waitForLoadState("domcontentloaded", { timeout: T }).catch(() => {})
  await mc.waitForLoadState("networkidle", { timeout: T }).catch(() => {})
}

// Devuelve el Excel exportado por Mis Comprobantes, o null si no hubo comprobantes en el período.
// El selector de fechas arranca en un solo día y el formulario solo toma el período cuando se
// "aplica" (escribir en el campo no alcanza). Se usa su API y, si no, "Rango Personalizado".
async function ponerPeriodo(mc: Page, desde: string, hasta: string) {
  const fecha = mc.locator("#fechaEmision")
  await fecha.waitFor({ timeout: T })
  const rango = `${desde} - ${hasta}`
  const quedo = async () => (await fecha.inputValue()).replace(/\s/g, "") === rango.replace(/\s/g, "")
  const selector = ".daterangepicker:visible"
  const aplicar = async () => {
    const boton = mc.locator(`${selector} .applyBtn`)
    if (await boton.isVisible().catch(() => false)) await boton.click()
  }

  const conApi = await mc.evaluate(([d, h]) => {
    const $ = (window as any).jQuery
    const input = document.querySelector("#fechaEmision")
    const picker = $ && input && $(input).data("daterangepicker")
    if (!picker) return false
    picker.setStartDate(d)
    picker.setEndDate(h)
    if (picker.clickApply) picker.clickApply()
    else $(input).trigger("apply.daterangepicker", picker)
    return true
  }, [desde, hasta])
  if (conApi && (await quedo())) return

  await fecha.click()
  await mc.locator(`${selector} .ranges li`, { hasText: /personalizado/i }).first().click({ timeout: 3000 }).catch(() => {})
  for (const [nombre, valor] of [["daterangepicker_start", desde], ["daterangepicker_end", hasta]]) {
    const campo = mc.locator(`${selector} input[name='${nombre}']`)
    if (await campo.isVisible().catch(() => false)) {
      await campo.fill(valor)
      await campo.press("Tab").catch(() => {})
    }
  }
  await aplicar()
  if (await quedo()) return
  throw new FalloArca("error", `No se pudo poner el período ${rango} (quedó "${await fecha.inputValue()}"; selector ${conApi ? "con" : "sin"} API)`)
}

export async function bajarComprobantes(
  mc: Page, tipo: TipoComprobantes, desde: string, hasta: string,
): Promise<Uint8Array | null> {
  const nombre = tipo === "emitidos" ? /emitidos/i : /recibidos/i
  const opciones = () => [
    mc.locator(tipo === "emitidos" ? "#btnEmitidos" : "#btnRecibidos"),
    mc.getByRole("link", { name: nombre }),
    mc.getByRole("button", { name: nombre }),
  ]
  let boton = await primeroVisible(opciones(), 5000)
  if (!boton) {
    // Después de una consulta queda en la pantalla de resultados: volver al menú.
    const menu = await primeroVisible([mc.getByRole("link", { name: /men[uú] principal/i })], 5000)
    if (menu) {
      await menu.click()
      await mc.waitForLoadState("networkidle", { timeout: T }).catch(() => {})
      boton = await primeroVisible(opciones())
    }
  }
  if (!boton) {
    throw new FalloArca("error", `No encontré el botón "${tipo}" en Mis Comprobantes. Botones: ${await describirClickeables(mc)}`)
  }
  await boton.click()

  const rango = `${desde} - ${hasta}`
  await ponerPeriodo(mc, desde, hasta)

  const buscar = await primeroVisible([mc.locator("#buscarComprobantes"), mc.getByRole("button", { name: /^\s*buscar\s*$/i })])
  if (!buscar) throw new FalloArca("error", `No encontré el botón Buscar en Mis Comprobantes. Botones: ${await describirClickeables(mc)}`)
  await buscar.click()
  await mc.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {})

  const excel = mc.locator(".buttons-excel, button:has-text('Excel'), a:has-text('Excel')")
  const vacio = mc.getByText(/no se encontraron|ning[uú]n dato disponible|no hay (datos|comprobantes|registros)/i)
  const listo = await primeroVisible([excel, vacio], 60_000)
  if (!listo) throw new FalloArca("arca_caido", "Mis Comprobantes no devolvió resultados a tiempo")
  const pantalla = (await textoVisible(mc)).replace(/\s+/g, " ")
  if (!pantalla.includes(desde) || !pantalla.includes(hasta)) {
    const filtro = pantalla.match(/Filtro Aplicado.{0,120}/)?.[0] ?? "sin filtro visible"
    throw new FalloArca("error", `ARCA no aplicó el período ${rango}: ${filtro}`)
  }
  if (!(await excel.first().isVisible().catch(() => false))) return null

  const [descarga] = await Promise.all([mc.waitForEvent("download", { timeout: 60_000 }), excel.first().click()])
  const partes: Buffer[] = []
  for await (const parte of await descarga.createReadStream()) partes.push(parte as Buffer)
  return new Uint8Array(Buffer.concat(partes))
}

// Nunca se toca nada que pague, genere obligaciones o cambie datos en ARCA.
const PROHIBIDO = /vep|pagar|pago|generar|presentar|confirmar|eliminar|baja|adherir|plan de|volante/i

// Cuenta Corriente de Monotributistas y Autónomos: saldo de deuda a la fecha.
const tablasDe = (p: Lugar) =>
  p.evaluate(() =>
    [...document.querySelectorAll("table")].map((t) =>
      [...(t as HTMLTableElement).rows].map((r) => [...r.cells].map((c) => (c as HTMLElement).innerText.replace(/\s+/g, " ").trim()))),
  ).catch(() => [] as string[][][])

export type DeudaCcma = {
  monto: number; detalle: string; pantalla: string
  saldos: Map<string, number> | null; meses: Map<string, MesCcma> | null
  // Resumen del encabezado: cuotas (obligación mensual) e intereses (accesorios) adeudados, y saldo a favor.
  cuotas: number | null; intereses: number | null; aFavor: number | null
}

// La CCMA lista de a 12 períodos ("Mostrar 12 24 36 48 períodos"); con menos no se ve toda la deuda.
async function mostrarTodosLosPeriodos(ccma: Page): Promise<string> {
  const contar = async () => movimientosCcma(await tablasDe(ccma))?.size ?? 0
  const antes = await contar()
  if (!/mostrar[\s\d]*\b48\b/i.test((await textoVisible(ccma)).replace(/\s+/g, " "))) return ""
  const conLista = ccma.locator("select").filter({ has: ccma.locator("option", { hasText: /^\s*48\s*$/ }) })
  const el = (await conLista.count()) ? null : await primeroVisible([
    ccma.getByRole("button", { name: /^\s*48\s*$/ }),
    ccma.getByRole("link", { name: /^\s*48\s*$/ }),
    ccma.getByRole("radio", { name: /^\s*48\s*$/ }),
    ccma.getByText("48", { exact: true }),
  ], 5000)
  if (await conLista.count()) await conLista.first().selectOption({ label: "48" })
  else if (el) await el.click()
  else return `[no encontré el "48" de "Mostrar períodos": ${await describirClickeables(ccma)}]`
  await ccma.waitForLoadState("networkidle", { timeout: T }).catch(() => {})
  let despues = await contar()
  for (let i = 0; i < 4 && despues <= antes; i++) {
    await ccma.waitForTimeout(1500)
    despues = await contar()
  }
  if (despues <= antes) {
    // Algunas vistas recién toman la cantidad al volver a consultar.
    const buscar = await primeroVisible([ccma.getByRole("button", { name: /^\s*(buscar|filtrar|consultar|aplicar)\s*$/i })], 3000)
    if (buscar) {
      await buscar.click()
      await ccma.waitForLoadState("networkidle", { timeout: T }).catch(() => {})
      despues = await contar()
    }
  }
  return `[períodos: ${antes} → ${despues}] `
}

export async function consultarDeudaCcma(page: Page, cuit: string): Promise<DeudaCcma> {
  const resultado = await leerDeudaCcma(page, cuit)
  if (resultado.monto <= 0 || resultado.saldos) return resultado
  // Hay deuda pero esta pantalla no muestra el detalle por período: probar "Detalle" (solo consulta).
  const ccma = resultado.pagina
  const detalle = await primeroVisible([
    ccma.getByRole("link", { name: /detalle|deuda por per[ií]odo|ver deuda/i }),
    ccma.getByRole("button", { name: /detalle|deuda por per[ií]odo|ver deuda/i }),
  ], 6000)
  if (detalle && !PROHIBIDO.test((await detalle.innerText().catch(() => "")) || "")) {
    await detalle.click()
    await ccma.waitForLoadState("networkidle", { timeout: T }).catch(() => {})
    const tablas = await tablasDe(ccma)
    const pantalla = (await textoVisible(ccma)).replace(/\s+/g, " ")
    return {
      ...resultado, saldos: saldosPorPeriodo(tablas), meses: movimientosCcma(tablas),
      pantalla: `${resultado.pantalla} || DETALLE: ${pantalla}`,
    }
  }
  return resultado
}

async function leerDeudaCcma(page: Page, cuit: string): Promise<DeudaCcma & { pagina: Page }> {
  const ccma = await abrirServicio(page, /^\s*(CCMA|Cuenta Corriente de (Contribuyentes )?Monotributistas y Aut[oó]nomos)/i, "CCMA")
  await elegirContribuyente(ccma, cuit)

  for (const paso of [/estado de cuenta/i, /c[aá]lculo de deuda|consult(a|ar) (de )?deuda/i, /^\s*(calcular|consultar)\s*$/i]) {
    const el = await primeroVisible([ccma.getByRole("link", { name: paso }), ccma.getByRole("button", { name: paso })], 6000)
    if (!el) continue
    const texto = (await el.innerText().catch(() => "")) || (await el.getAttribute("value").catch(() => "")) || ""
    if (PROHIBIDO.test(texto)) continue
    await el.click()
    await ccma.waitForLoadState("networkidle", { timeout: T }).catch(() => {})
  }

  const periodos = await mostrarTodosLosPeriodos(ccma)
  const pantalla = periodos + (await textoVisible(ccma)).replace(/\s+/g, " ")
  const tablas = await tablasDe(ccma)
  const saldos = saldosPorPeriodo(tablas)
  const meses = movimientosCcma(tablas)
  // "Total Saldo Deudor: X Total Saldo Acreedor: Y Obligación Mensual: (deudor) Obligación Mensual: (acreedor)
  // Accesorios: (deudor) Accesorios: (acreedor)": la primera aparición de cada rubro es la del deudor.
  const rubro = (re: RegExp) => { const r = pantalla.match(re); return r ? parseMonto(r[1]) : null }
  const resumen = {
    cuotas: rubro(/obligaci[oó]n mensual:?\s*\$?\s*(-?\d[\d.,]*\d)/i),
    intereses: rubro(/accesorios:?\s*\$?\s*(-?\d[\d.,]*\d)/i),
    aFavor: rubro(/saldo acreedor:?\s*\$?\s*(-?\d[\d.,]*\d)/i),
  }
  if (/no (registra|posee|tiene|existe[n]?) deudas?|sin deuda|no se registran (deudas|saldos)/i.test(pantalla)) {
    return { monto: 0, detalle: "sin deuda", pantalla, saldos, meses, ...resumen, pagina: ccma }
  }
  const m = pantalla.match(/(saldo deudor|total (de )?(la )?deuda|deuda total|total adeudado|saldo total)[^0-9$-]{0,40}\$?\s*(-?\d[\d.,]*\d)/i)
  const monto = m ? parseMonto(m[4]) : null
  if (!m || monto === null) {
    throw new FalloArca("error", `No encontré el total de deuda en la CCMA (${ccma.url()}). Pantalla: ${pantalla.slice(0, 400)} — Botones: ${await describirClickeables(ccma)}`)
  }
  const pesosAr = (n: number) => n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const partes = resumen.cuotas !== null && resumen.intereses !== null && monto > 0
    ? ` (cuotas $${pesosAr(resumen.cuotas)} + intereses $${pesosAr(resumen.intereses)})` : ""
  const aFavor = resumen.aFavor ? ` · saldo a favor $${pesosAr(resumen.aFavor)}` : ""
  return { monto, detalle: `${m[1]}: $${pesosAr(monto)}${partes}${aFavor}`, pantalla, saldos, meses, ...resumen, pagina: ccma }
}

// Mis Facilidades: planes de pago del contribuyente (solo consulta).
export async function consultarFacilidades(page: Page, cuit: string): Promise<{ planes: PlanArca[]; pantalla: string }> {
  const mf = await abrirServicio(page, /^\s*Mis Facilidades\s*$/i, "Mis Facilidades")
  await elegirContribuyente(mf, cuit)

  let planes = leerPlanesFacilidades(await tablasDe(mf))
  if (!planes) {
    const paso = /consult(a|ar)?\b.*planes?|planes presentados|mis planes|^\s*planes\s*$/i
    const el = await primeroVisible([
      mf.getByRole("link", { name: paso }), mf.getByRole("button", { name: paso }), mf.getByRole("menuitem", { name: paso }),
    ], 8000)
    if (el && !PROHIBIDO.test((await el.innerText().catch(() => "")) || "")) {
      await el.click()
      await mf.waitForLoadState("networkidle", { timeout: T }).catch(() => {})
      planes = leerPlanesFacilidades(await tablasDe(mf))
    }
  }
  const pantalla = (await textoVisible(mf)).replace(/\s+/g, " ")
  if (!planes) {
    if (/no (posee|tiene|registra|existen?|se encontraron) planes|sin planes/i.test(pantalla)) return { planes: [], pantalla }
    throw new FalloArca("error", `No encontré la lista de planes en Mis Facilidades (${mf.url()}). Pantalla: ${pantalla.slice(0, 400)} — Botones: ${await describirClickeables(mf)}`)
  }
  return { planes, pantalla }
}

// ── ART Río Negro (se entra desde ARCA con la misma clave fiscal) ────────────

// En ART solo se consulta: nunca se toca nada que presente, pague, emita boletas, modifique datos
// o abra notificaciones (leerlas cuenta como notificarse).
const ART_PROHIBIDO = /notificaci|emitir|boleta|generar|presentar|confirmar|eliminar|baja|adherir|solicitar|pagar|volante|ddjj|actualizar|modificar|retenci|percepci/i

async function tocarEnArt(el: Locator, que: string) {
  const texto = ((await el.innerText().catch(() => "")) || (await el.getAttribute("value").catch(() => "")) || "").trim()
  if (ART_PROHIBIDO.test(texto)) throw new FalloArca("error", `Por seguridad no se tocó "${texto}" en ART (${que})`)
  // Los ítems del menú lateral solo se ven al pasar el mouse: si no está a la vista se lo activa directo.
  if (await el.isVisible().catch(() => false)) await el.click({ timeout: T })
  else await el.evaluate((e) => (e as HTMLElement).click())
}

// Pestaña o marco de ART que cumple la condición (ART abre sus pantallas en otra pestaña o en un marco).
async function lugarDonde(page: Page, condicion: (l: Lugar) => Promise<boolean>, timeout = T): Promise<Lugar | null> {
  const limite = Date.now() + timeout
  while (Date.now() < limite) {
    for (const p of page.context().pages()) {
      if (p.isClosed()) continue
      for (const f of p.frames()) {
        if (!/rionegro\.gov\.ar/i.test(f.url())) continue
        if (await condicion(f).catch(() => false)) return f === p.mainFrame() ? p : f
      }
    }
    await new Promise((r) => setTimeout(r, 700))
  }
  return null
}

// Textos de los enlaces del menú (incluidos los ocultos), para diagnosticar.
const menuDe = (page: Lugar) =>
  page.locator("a").evaluateAll((els) => [...new Set(els.map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter((t) => t && t.length < 60))].slice(0, 80).join(" | ")).catch(() => "")

const urlsAbiertas = (page: Page) => page.context().pages().map((p) => p.url()).join(" | ")

const corta = (u: string) => u.replace(/^https?:\/\//, "").replace(/\?.*$/, "").slice(0, 70)
const esperarMs = (ms: number) => new Promise((r) => setTimeout(r, ms))

// "Ingreso a Extranet": una lista con CUITs (las páginas de paso que se cierran solas no la tienen).
const tieneListaCuit = (p: Page) => p.locator("select option").evaluateAll((os) =>
  os.some((o) => /\d{11}/.test(((o as HTMLOptionElement).text + (o as HTMLOptionElement).value).replace(/\D/g, ""))))

// Aviso "Existen notificaciones electrónicas pendientes": "Aceptar" solo lo cierra (no notifica).
// Se toca únicamente el botón que está dentro de ese aviso, nunca el de otro cartel (por ejemplo,
// uno que constituya el domicilio fiscal electrónico).
const botonAceptar = (l: Page | Locator) =>
  l.getByRole("button", { name: /^\s*aceptar\s*$/i }).or(l.getByRole("link", { name: /^\s*aceptar\s*$/i }))

async function cerrarAvisoNotificaciones(p: Page): Promise<boolean> {
  const avisos = p.locator("div").filter({ hasText: /notificaciones electr[oó]nicas pendientes/i }).filter({ has: botonAceptar(p) })
  for (let i = (await avisos.count()) - 1; i >= 0; i--) {
    const aviso = avisos.nth(i)
    if (!(await aviso.isVisible().catch(() => false))) continue
    if (/constitu|domicilio fiscal|adhe|acept[oa] los t[eé]rminos/i.test(await aviso.innerText().catch(() => ""))) continue
    const boton = botonAceptar(aviso).first()
    if (!(await boton.isVisible().catch(() => false))) continue
    await boton.click({ timeout: 5000 })
    return true
  }
  return false
}

// Entra a ART desde el portal de ARCA. Al entrar, ARCA y ART abren y cierran ventanas (pase de
// sesión), así que en cada vuelta se mira la pestaña de ART más reciente y se hace lo que pide:
// elegir el CUIT e INGRESAR, cerrar el aviso de notificaciones (puede haber más de uno) y, cuando
// aparece el menú, queda en el panel principal. Lo que va pasando queda anotado por si falla.
export async function ingresarArt(page: Page, cuit: string): Promise<Page> {
  const pasos: string[] = []
  const anotar = (s: string) => { if (pasos.at(-1) !== s) pasos.push(s) }
  const servicio = await buscarServicio(page, /^\s*ART Provincia de R[ií]o Negro\s*$/i, "ART Provincia")
  await servicio.click()
  anotar("servicio ART")

  const pestanas = () => page.context().pages().filter((p) => !p.isClosed() && /rionegro\.gov\.ar/i.test(p.url())).reverse()
  let ingresado = false
  let avisos = 0
  const limite = Date.now() + 120_000
  while (Date.now() < limite) {
    let accion = false
    for (const p of pestanas()) {
      try {
        if (avisos < 5 && (await cerrarAvisoNotificaciones(p))) {
          avisos++
          anotar(`aviso de notificaciones cerrado (${corta(p.url())})`)
          accion = true
          break
        }
        if (await p.locator("a").filter({ hasText: /cuenta corriente/i }).count()) {
          anotar(`panel (${corta(p.url())})`)
          await p.waitForLoadState("networkidle", { timeout: T }).catch(() => {})
          // Puede quedar otro aviso encima del menú: se cierra antes de seguir.
          if (await cerrarAvisoNotificaciones(p)) anotar("aviso de notificaciones cerrado")
          await detectarBloqueos(p)
          return p
        }
        if (!ingresado && (await tieneListaCuit(p))) {
          const listas = p.locator("select")
          let elegido = false
          for (let i = 0, n = await listas.count(); i < n && !elegido; i++) {
            const valor = await listas.nth(i).evaluate((el, c) =>
              [...(el as HTMLSelectElement).options].find((o) => (o.text + o.value).replace(/\D/g, "").includes(c))?.value ?? null, cuit)
            if (valor === null) continue
            await listas.nth(i).selectOption(valor)
            elegido = true
          }
          if (!elegido) throw new FalloArca("error", `ART no ofrece el CUIT ${cuit} para ingresar. Pantalla: ${resumen(await textoVisible(p))}`)
          const boton = await primeroVisible([
            p.getByRole("button", { name: /^\s*ingresar\s*$/i }), p.locator("input[value='INGRESAR' i]"), p.getByRole("link", { name: /^\s*ingresar\s*$/i }),
          ], 10_000)
          if (!boton) throw new FalloArca("error", `No encontré INGRESAR en ART. Botones: ${await describirClickeables(p)}`)
          await tocarEnArt(boton, "ingreso")
          ingresado = true
          anotar(`CUIT elegido e INGRESAR (${corta(p.url())})`)
          accion = true
          break
        }
      } catch (e: any) {
        if (e instanceof FalloArca) throw e
        anotar(`${corta(p.url())}: ${String(e?.message ?? e).split("\n")[0].slice(0, 80)}`)
      }
    }
    await esperarMs(accion ? 2000 : 800)
  }

  const ultima = pestanas()[0]
  const pantalla = ultima ? (await textoVisible(ultima)).replace(/\s+/g, " ").slice(0, 900) : ""
  throw new FalloArca("error", `No se pudo llegar al panel de ART. Pasos: ${pasos.join(" → ")}. Pestañas: ${urlsAbiertas(page)}. ` +
    `Pantalla: ${pantalla}${ultima ? ` — Menú: ${await menuDe(ultima)}` : ""}`)
}

export type CuentaArt = { anticipos: AnticipoArt[]; regimen: string | null; inscripcion: string | null; pantalla: string }

const ddmmaaaa = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`

// IIBB → Consultar Cuenta Corriente → Consultar → inscripción de Ingresos Brutos y fechas → Consultar.
export async function consultarCuentaArt(art: Page, desdeAnio: number): Promise<CuentaArt> {
  const menu = art.locator("a").filter({ hasText: /^\s*Consultar Cuenta Corriente\s*$/i })
  if (!(await menu.count())) throw new FalloArca("error", `No encontré "Consultar Cuenta Corriente" en el menú de ART. Menú: ${await menuDe(art)}`)
  await tocarEnArt(menu.first(), "menú IIBB")

  // Primero aparece una pantalla intermedia ("Para efectuar consulta, Pulse: Consultar") con el mismo
  // título que el formulario: el formulario es el que tiene la lista de inscripciones.
  const conInscripciones = (l: Lugar) => l.locator("select option").evaluateAll((os) =>
    os.some((o) => /brutos|sellos/i.test(o.textContent ?? "")))
  const intermedia = (l: Lugar) => textoVisible(l).then((t) => /para efectuar consulta/i.test(t))
  let form = await lugarDonde(art, async (l) => (await conInscripciones(l)) || (await intermedia(l)))
  if (!form) throw new FalloArca("error", `No se abrió la cuenta corriente de ART. Pestañas: ${urlsAbiertas(art)}. Pantalla: ${resumen(await textoVisible(art))}`)
  if (!(await conInscripciones(form).catch(() => false))) {
    const consultar = await primeroVisible([form.getByRole("button", { name: /^\s*consultar\s*$/i }), form.locator("input[value='Consultar' i]")], 10_000)
    if (!consultar) throw new FalloArca("error", `No encontré "Consultar" en ART. Botones: ${await describirClickeables(form)}`)
    await tocarEnArt(consultar, "cuenta corriente")
    const previa = form
    form = await lugarDonde(art, conInscripciones)
    if (!form) throw new FalloArca("error", `No apareció el formulario de cuenta corriente de ART. Pantalla: ${resumen(await textoVisible(previa))}`)
  }

  // Inscripción de Ingresos Brutos (la lista también trae "Sellos y Tasas").
  const listas = form.locator("select")
  let inscripcion: string | null = null
  for (let i = 0, n = await listas.count(); i < n && !inscripcion; i++) {
    const op = await listas.nth(i).evaluate((el) => {
      const o = [...(el as HTMLSelectElement).options].find((x) => /ingr\w*\.?\s*brutos/i.test(x.text))
      return o ? { valor: o.value, texto: o.text.trim() } : null
    })
    if (!op) continue
    await listas.nth(i).selectOption(op.valor)
    inscripcion = op.texto
  }
  if (!inscripcion) throw new FalloArca("error", `ART no muestra una inscripción de Ingresos Brutos. Pantalla: ${resumen(await textoVisible(form))}`)
  await form.waitForLoadState("networkidle", { timeout: T }).catch(() => {})
  await new Promise((r) => setTimeout(r, 1500))

  const valores = () => form.locator("input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value ?? ""))
  const regimen = (await valores()).find((v) => /r[eé]gimen/i.test(v))?.trim() ?? null
  const ponerDesde = async (desde: string) => {
    const i = (await valores()).findIndex((v) => /^\d{2}\/\d{2}\/\d{4}$/.test(v.trim()))
    if (i >= 0) await form.locator("input").nth(i).fill(desde).catch(() => {})
  }
  const consultar = async () => {
    const boton = await primeroVisible([form.getByRole("button", { name: /^\s*consultar\s*$/i }), form.locator("input[value='Consultar' i]")], 10_000)
    if (!boton) throw new FalloArca("error", `No encontré "Consultar" en la cuenta corriente de ART. Botones: ${await describirClickeables(form)}`)
    await tocarEnArt(boton, "cuenta corriente")
    await form.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {})
    for (let i = 0; i < 20; i++) {
      const leidos = leerCuentaCorrienteArt(await tablasDe(form))
      if (leidos?.length) return leidos
      if (/no (se encontraron|existen|hay|registra)|sin movimientos|falla al procesar|error/i.test(await textoVisible(form))) return leidos
      await new Promise((r) => setTimeout(r, 1000))
    }
    return leerCuentaCorrienteArt(await tablasDe(form))
  }

  // Desde varios años atrás para ver toda la deuda; si ART no acepta el rango, el que trae por defecto.
  await ponerDesde(ddmmaaaa(new Date(Date.UTC(desdeAnio, 0, 1))))
  let anticipos = await consultar()
  let pantalla = (await textoVisible(form)).replace(/\s+/g, " ")
  if (!anticipos?.length && /falla|error|inv[aá]lid|rango|mayor|menor/i.test(pantalla)) {
    await ponerDesde(ddmmaaaa(new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1))))
    anticipos = await consultar()
    pantalla = `[rango corto] ${(await textoVisible(form)).replace(/\s+/g, " ")}`
  }
  if (!anticipos) {
    throw new FalloArca("error", `No encontré la grilla de la cuenta corriente de ART. Pantalla: ${pantalla.slice(0, 400)}`)
  }
  return { anticipos, regimen, inscripcion, pantalla }
}

// Planes de pago de ART: menú lateral "Planes de Pago" → "Consulta de Planes de Pago" (solo consulta).
// Devuelve null si no encontró la lista.
export async function consultarPlanesArt(art: Page, panel: string): Promise<{ planes: PlanArca[] | null; pantalla: string }> {
  if (art.url() !== panel) {
    await art.goto(panel, { timeout: T }).catch(() => {})
    await art.waitForLoadState("networkidle", { timeout: T }).catch(() => {})
  }
  const candidatos = art.locator("a").filter({ hasText: /planes?\b/i })
  let elegido: Locator | null = null
  for (let i = 0, n = await candidatos.count(); i < n; i++) {
    const texto = ((await candidatos.nth(i).textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim()
    if (!texto || texto.length > 60 || ART_PROHIBIDO.test(texto) || /adhe|nuevo|reformul|simul/i.test(texto)) continue
    if (/^consulta de planes de pago$/i.test(texto)) { elegido = candidatos.nth(i); break }
    if (!elegido || /consult/i.test(texto)) elegido = candidatos.nth(i)
  }
  if (!elegido) {
    throw new FalloArca("error", `No encontré "Consulta de Planes de Pago" en el menú de ART. Menú: ${await menuDe(art)}`)
  }
  const nombre = ((await elegido.textContent()) ?? "").replace(/\s+/g, " ").trim()
  await tocarEnArt(elegido, "planes de pago")
  await art.waitForLoadState("networkidle", { timeout: T }).catch(() => {})

  // La lista puede quedar en la misma pantalla, en un marco o en otra pestaña de ART. Se descartan las
  // pestañas de ARCA (Mis Facilidades también tiene una tabla de planes) y la cuenta corriente que quedó
  // abierta (su grilla también tiene "Nro. Plan Pago").
  const marcos = async () => {
    const todos = art.context().pages().flatMap((p) => p.frames()).filter((f) => /rionegro\.gov\.ar/i.test(f.url()))
    const utiles: Frame[] = []
    for (const f of todos) if (!/cuenta corriente de iibb/i.test(await textoVisible(f))) utiles.push(f)
    return utiles
  }
  const leer = async () => {
    let mejor: { planes: PlanArca[]; marco: Frame } | null = null
    for (const f of await marcos()) {
      const tablas = (await tablasDe(f)).filter((t) => !t.some((fila) => fila.some((c) => c.length < 30 && /posic/i.test(c))))
      const leidos = leerPlanesFacilidades(tablas)
      if (leidos && (!mejor || leidos.length > mejor.planes.length)) mejor = { planes: leidos, marco: f }
    }
    return mejor
  }
  const esperarLista = async (veces: number) => {
    let r: Awaited<ReturnType<typeof leer>> = null
    for (let i = 0; i < veces && !r?.planes.length; i++) {
      await new Promise((res) => setTimeout(res, 1500))
      r = await leer()
    }
    return r
  }

  let r = await esperarLista(6)
  let paso = ""
  if (!r?.planes.length) {
    // Como la cuenta corriente, puede pedir elegir la inscripción y "Consultar" antes de mostrar la lista.
    for (const f of await marcos()) {
      const boton = f.getByRole("button", { name: /^\s*consultar\s*$/i }).or(f.locator("input[value='Consultar' i]")).first()
      if (!(await boton.isVisible().catch(() => false))) continue
      const listas = f.locator("select")
      for (let i = 0, n = await listas.count(); i < n; i++) {
        const valor = await listas.nth(i).evaluate((el) =>
          [...(el as HTMLSelectElement).options].find((o) => /ingr\w*\.?\s*brutos/i.test(o.text))?.value ?? null).catch(() => null)
        if (valor !== null) await listas.nth(i).selectOption(valor).catch(() => {})
      }
      await tocarEnArt(boton, "planes de pago")
      await f.waitForLoadState("networkidle", { timeout: T }).catch(() => {})
      paso = " [consultar]"
      break
    }
    r = await esperarLista(10)
  }

  let pantalla: string
  let planes: PlanArca[] | null = r?.planes ?? null
  if (r) {
    pantalla = (await textoVisible(r.marco)).replace(/\s+/g, " ")
  } else {
    const textos = await Promise.all((await marcos()).map((f) => textoVisible(f)))
    pantalla = textos.map((t) => t.replace(/\s+/g, " ")).filter(Boolean).join(" || ")
    if (/no (posee|tiene|registra|existen?|se encontraron) planes|sin planes/i.test(pantalla)) planes = []
  }
  return { planes, pantalla: `[menú: ${nombre}${paso}] ${pantalla}` }
}

// Datos para diagnosticar un fallo: URL, texto visible y captura (nunca valores de campos).
export async function capturarEstado(browser: Browser | null) {
  const paginas = browser?.contexts().flatMap((c) => c.pages()) ?? []
  const page = paginas[paginas.length - 1]
  if (!page) return null
  return {
    url: page.url(),
    texto: resumen(await textoVisible(page)),
    captura: await page.screenshot({ type: "jpeg", quality: 50, fullPage: false }).then((b) => b.toString("base64")).catch(() => null),
  }
}
