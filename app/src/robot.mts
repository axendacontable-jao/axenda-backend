import type { Browser, Locator, Page } from "playwright-core"

// Debe coincidir con la versión de @sparticuz/chromium-min del package.json.
const CHROMIUM_PACK = "https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar"
const LOGIN_URL = "https://auth.afip.gob.ar/contribuyente_/login.xhtml"
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
  // Netlify corre Node 24 sobre Amazon Linux 2023, pero chromium-min 131 solo descomprime
  // las librerías de AL2023 si ve "20.x" (con 24.x usa las de AL2 y Chromium no arranca).
  process.env.AWS_EXECUTION_ENV = "AWS_Lambda_nodejs20.x"
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

export async function abrirMisComprobantes(page: Page): Promise<Page> {
  await page.waitForLoadState("networkidle", { timeout: T }).catch(() => {})
  const servicio = () => page.getByText(/^\s*Mis Comprobantes\s*$/i)

  let enlace = await primeroVisible([servicio()], 10_000)
  if (!enlace) {
    const buscador = page.locator("input[type='search'], input[placeholder*='uscar' i]")
    if (await buscador.first().isVisible().catch(() => false)) {
      await buscador.first().fill("Mis Comprobantes")
      enlace = await primeroVisible([servicio()], 10_000)
    }
  }
  if (!enlace) {
    await page.goto("https://portalcf.cloud.afip.gob.ar/portal/app/mis-servicios", { timeout: T }).catch(() => {})
    await page.waitForLoadState("networkidle", { timeout: T }).catch(() => {})
    enlace = await primeroVisible([servicio()], 15_000)
  }
  if (!enlace) {
    throw new FalloArca("error", "No aparece 'Mis Comprobantes' en el portal de ARCA (¿está habilitado el servicio para este CUIT?)")
  }

  const [nueva] = await Promise.all([
    page.context().waitForEvent("page", { timeout: T }).catch(() => null),
    enlace.click(),
  ])
  const mc = nueva ?? page
  await mc.waitForURL(MCMP, { timeout: T }).catch(() => {})
  await mc.waitForLoadState("domcontentloaded", { timeout: T }).catch(() => {})
  if (!MCMP.test(mc.url())) throw new FalloArca("error", `No se abrió Mis Comprobantes (quedó en ${mc.url()})`)
  await detectarBloqueos(mc)
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

// "Elegí una persona para ingresar": aparece cuando el CUIT puede representar a otros.
// El CUIT también figura en el encabezado, así que se busca un elemento clickeable fuera de él.
export async function elegirContribuyente(mc: Page, cuit: string) {
  if (await primeroVisible([mc.locator("#btnEmitidos"), mc.getByText(/emitidos/i)], 5000)) return

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
    const tarjetas = mc.locator("li, tr, form, .card, .panel, div").filter({ hasText: fmt })
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
  const fecha = mc.locator("#fechaEmision")
  await fecha.waitFor({ timeout: T })
  // El daterangepicker ignora el texto tipeado: se usa su API (si no está, se escribe el valor).
  await mc.evaluate(([d, h]) => {
    const input = document.querySelector("#fechaEmision") as HTMLInputElement
    const $ = (window as any).jQuery
    const picker = $ && $(input).data("daterangepicker")
    if (picker) {
      picker.setStartDate(d)
      picker.setEndDate(h)
      picker.updateElement?.()
    } else {
      input.value = `${d} - ${h}`
    }
    input.dispatchEvent(new Event("change", { bubbles: true }))
  }, [desde, hasta])
  const cargado = await fecha.inputValue()
  if (cargado.replace(/\s/g, "") !== rango.replace(/\s/g, "")) {
    throw new FalloArca("error", `No se pudo poner el período ${rango} en el filtro (quedó "${cargado}")`)
  }

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
