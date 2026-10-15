import type { Config } from "@netlify/functions"
import { HttpError } from "../../src/core.mts"
import { rutas } from "../../src/routes.mts"

const json = (data: unknown, status: number) =>
  new Response(JSON.stringify(data === undefined ? null : data), {
    status,
    headers: { "Content-Type": "application/json" },
  })

const compiladas = rutas.map(([metodo, patron, handler]) => {
  const nombres: string[] = []
  const fuente = patron.replace(/:(\w+)/g, (_, n: string) => {
    nombres.push(n)
    return "([^/]+)"
  })
  return { metodo, re: new RegExp(`^${fuente}/?$`), nombres, handler }
})

export default async (req: Request) => {
  const url = new URL(req.url)
  const path = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/"
  let metodoNoPermitido = false
  for (const ruta of compiladas) {
    const m = path.match(ruta.re)
    if (!m) continue
    if (ruta.metodo !== req.method) {
      metodoNoPermitido = true
      continue
    }
    try {
      const p = Object.fromEntries(ruta.nombres.map((n, i) => [n, decodeURIComponent(m[i + 1])]))
      const resultado = await ruta.handler({ req, p, query: url.searchParams })
      // Un handler puede devolver un archivo (por ejemplo, la constancia en PDF).
      return resultado instanceof Response ? resultado : json(resultado, 200)
    } catch (e: any) {
      if (e instanceof HttpError) return json({ detail: e.message }, e.status)
      console.error(`[${req.method} ${url.pathname}]`, e)
      return json({ detail: String(e?.message ?? e) }, 500)
    }
  }
  return metodoNoPermitido ? json({ detail: "Method Not Allowed" }, 405) : json({ detail: "Not Found" }, 404)
}

export const config: Config = {
  path: ["/api", "/api/*"],
}
