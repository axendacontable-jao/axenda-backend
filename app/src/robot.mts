import type { Browser, Locator, Page } from "playwright-core"
import { type MesCcma, type PlanArca, leerPlanesFacilidades, movimientosCcma, parseMonto, saldosPorPeriodo } from "./parsers.mts"

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
  return pw.launch({ executablePath, args: chromium.args, headless: true })
}

const textoVisible = (page: Page) => page.locator("body").innerText({ timeout: 5000 }).catch(() => "")
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

// Abre un servicio del portal "Mi ARCA" (suelen abrirse en otra pestaña).
async function abrirServicio(page: Page, nombre: RegExp, busqueda: string): Promise<Page> {
  if (!PORTAL.test(page.url())) await page.goto(PORTAL_URL, { timeout: T }).catch(() => {})
  await page.waitForLoadState("networkidle", { timeout: T }).catch(() => {})
  const servicio = () => page.getByText(nombre)

  let enlace = await primeroVisible([servicio()], 10_000)
  if (!enlace) {
    const buscador = page.locator("input[type='search'], input[placeholder*='uscar' i]")
    if (await buscador.first().isVisible().catch(() => false)) {
      await buscador.first().fill(busqueda)
      enlace = await primeroVisible([servicio()], 10_000)
    }
  }
  if (!enlace) {
    await page.goto(`${PORTAL_URL}mis-servicios`, { timeout: T }).catch(() => {})
    await page.waitForLoadState("networkidle", { timeout: T }).catch(() => {})
    enlace = await primeroVisible([servicio()], 15_000)
  }
  if (!enlace) {
    throw new FalloArca("error", `No aparece '${busqueda}' en el portal de ARCA (¿está habilitado el servicio para este CUIT?)`)
  }

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
export async function describirClickeables(page: Page): Promise<string> {
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

const PIDE_PERSONA = /eleg[ií] una persona|a qui[eé]n (quer[eé]s )?represent|seleccion[aá]?r? (el |la |un |una )?(contribuyente|persona|cuit)/i

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
const tablasDe = (p: Page) =>
  p.evaluate(() =>
    [...document.querySelectorAll("table")].map((t) =>
      [...(t as HTMLTableElement).rows].map((r) => [...r.cells].map((c) => (c as HTMLElement).innerText.replace(/\s+/g, " ").trim()))),
  ).catch(() => [] as string[][][])

export type DeudaCcma = {
  monto: number; detalle: string; pantalla: string
  saldos: Map<string, number> | null; meses: Map<string, MesCcma> | null
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

  const pantalla = (await textoVisible(ccma)).replace(/\s+/g, " ")
  const tablas = await tablasDe(ccma)
  const saldos = saldosPorPeriodo(tablas)
  const meses = movimientosCcma(tablas)
  if (/no (registra|posee|tiene|existe[n]?) deudas?|sin deuda|no se registran (deudas|saldos)/i.test(pantalla)) {
    return { monto: 0, detalle: "sin deuda", pantalla, saldos, meses, pagina: ccma }
  }
  const m = pantalla.match(/(saldo deudor|total (de )?(la )?deuda|deuda total|total adeudado|saldo total)[^0-9$-]{0,40}\$?\s*(-?\d[\d.,]*\d)/i)
  const monto = m ? parseMonto(m[4]) : null
  if (!m || monto === null) {
    throw new FalloArca("error", `No encontré el total de deuda en la CCMA (${ccma.url()}). Pantalla: ${pantalla.slice(0, 400)} — Botones: ${await describirClickeables(ccma)}`)
  }
  const pesosAr = monto.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return { monto, detalle: `${m[1]}: $${pesosAr}`, pantalla, saldos, meses, pagina: ccma }
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
