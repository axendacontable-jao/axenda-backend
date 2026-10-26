// node --test test/*.test.mts (desde app/)
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { compararConTopes, firmaPrevia, leerMontosArca, montoArca } from "../src/montos-arca.mts"

// Recorte de la página de ARCA con los valores desde el 1/08/2026.
const HTML = readFileSync(new URL("./fixtures/arca-categorias-2026-08.html", import.meta.url), "utf8")

// Componente de Río Negro desde el 1/08/2026.
const RIO_NEGRO: Record<string, number> = {
  A: 20759.14, B: 30753.61, C: 40924.95, D: 61895.16, E: 82527.97, F: 102898.2,
  G: 122677.8, H: 198843.76, I: 230395.02, J: 270338.05, K: 304988.49,
}

test("lee la fecha de aplicación y las 11 categorías sin errores", () => {
  const r = leerMontosArca(HTML)
  assert.deepEqual(r.errores, [])
  assert.equal(r.vigente_desde, "2026-08-01")
  assert.deepEqual(r.filas.map((f) => f.categoria), "ABCDEFGHIJK".split(""))
})

test("categoría A de agosto 2026", () => {
  const a = leerMontosArca(HTML).filas[0]
  assert.deepEqual(a, {
    categoria: "A", tope_anual: 12009410.45, imp_integrado_servicios: 5585.77, imp_integrado_bienes: 5585.77,
    aportes_sipa: 18246.86, obra_social: 25694.55, total_servicios: 49527.18, total_bienes: 49527.18,
  })
})

test("categoría K de agosto 2026", () => {
  const k = leerMontosArca(HTML).filas[10]
  assert.deepEqual(k, {
    categoria: "K", tope_anual: 126610838.75, imp_integrado_servicios: 1368514.2, imp_integrado_bienes: 456171.4,
    aportes_sipa: 158049.02, obra_social: 87882.82, total_servicios: 1614446.04, total_bienes: 702103.24,
  })
})

test("si un total no cierra con impuesto + SIPA + obra social, lo informa", () => {
  const r = leerMontosArca(HTML.replace("$66.020,12", "$66.020,13"))
  assert.equal(r.errores.length, 1)
  assert.match(r.errores[0], /Categoría C \(servicios\).*\$66\.020,12.*\$66\.020,13/)
})

test("si falta una categoría, lo informa", () => {
  const sinK = HTML.replace(/<tr>\s*<th id="th_K_t15"[\s\S]*?<\/tr>/, "")
  const r = leerMontosArca(sinK)
  assert.equal(r.filas.length, 10)
  assert.deepEqual(r.errores, ["Faltan categorías: K"])
})

test("si una categoría viene repetida, lo informa", () => {
  const filaA = /<tr>\s*<th id="th_A_t15"[\s\S]*?<\/tr>/.exec(HTML)![0]
  const r = leerMontosArca(HTML.replace(filaA, filaA + filaA))
  assert.deepEqual(r.errores, ["La categoría A aparece más de una vez"])
})

test("si un monto no se puede leer, lo informa", () => {
  const r = leerMontosArca(HTML.replace("$18.246,86 </td>", "a confirmar</td>"))
  assert.equal(r.errores.length, 1)
  assert.match(r.errores[0], /Categoría A: no se pudo leer aportes SIPA/)
})

test("sin la fecha de aplicación no hay vigencia y queda el error", () => {
  const r = leerMontosArca(HTML.replace("Valores de aplicación desde el 1/08/2026", "Valores vigentes"))
  assert.equal(r.vigente_desde, null)
  assert.match(r.errores[0], /Valores de aplicación desde el/)
  assert.equal(r.filas.length, 11)
})

test("sin la tabla, error claro", () => {
  const r = leerMontosArca(HTML.replace(/<table[\s\S]*<\/table>/, ""))
  assert.equal(r.filas.length, 0)
  assert.match(r.errores.join(), /Categorías y valores del monotributo/)
})

test("sin data-title lee las columnas por posición", () => {
  const r = leerMontosArca(HTML.replace(/ data-title="[^"]*"/g, ""))
  assert.deepEqual(r.errores, [])
  assert.deepEqual(r.filas, leerMontosArca(HTML).filas)
})

test("acepta entidades HTML y acentos codificados", () => {
  const conEntidades = HTML.replace(/\$/g, "&#36;").replace(/ <\/td>/g, "&nbsp;</td>").replace("aplicación", "aplicaci&oacute;n")
  const r = leerMontosArca(conEntidades)
  assert.deepEqual(r.errores, [])
  assert.equal(r.vigente_desde, "2026-08-01")
  assert.deepEqual(r.filas, leerMontosArca(HTML).filas)
})

test("montoArca: formato argentino", () => {
  assert.equal(montoArca("$12.009.410,45 "), 12009410.45)
  assert.equal(montoArca("$716.840,77"), 716840.77)
  assert.equal(montoArca("1500"), 1500)
  assert.equal(montoArca("Hasta 30 m2"), null)
  assert.equal(montoArca("12,009,410.45"), null)
})

test("cuota unificada = total nacional + componente de Río Negro, y sin cambios si ya está cargada", () => {
  const { vigente_desde, filas } = leerMontosArca(HTML)
  const actuales = [{
    categoria: "A", tope_anual: "12009410.45", imp_integrado_servicios: "5585.77", imp_integrado_bienes: "5585.77",
    aportes_sipa: "18246.86", obra_social: "25694.55", cuota_servicios: "70286.32", cuota_bienes: "70286.32", vigente_desde: "2026-08-01",
  }]
  const c = compararConTopes({ vigente_desde: vigente_desde!, filas }, actuales, RIO_NEGRO)
  assert.deepEqual(c.errores, [])
  assert.equal(c.filas[0].nuevo.cuota_servicios, 70286.32)
  assert.deepEqual(c.filas[0].cambios, [])
  // K: 1.614.446,04 + 304.988,49 y 702.103,24 + 304.988,49
  assert.equal(c.filas[10].nuevo.cuota_servicios, 1919434.53)
  assert.equal(c.filas[10].nuevo.cuota_bienes, 1007091.73)
  // Sin fila actual, todo es cambio.
  assert.equal(c.filas[10].actual, null)
  assert.equal(c.filas[10].cambios.length, 8)
})

test("marca solo los campos que cambian", () => {
  const { filas } = leerMontosArca(HTML)
  const actuales = [{
    categoria: "A", tope_anual: 10277988.13, imp_integrado_servicios: 4780.46, imp_integrado_bienes: 4780.46,
    aportes_sipa: 15616.17, obra_social: 25694.55, cuota_servicios: 63848.32, cuota_bienes: 63848.32, vigente_desde: "2026-02-01",
  }]
  const c = compararConTopes({ vigente_desde: "2026-08-01", filas }, actuales, RIO_NEGRO)
  assert.deepEqual(c.filas[0].cambios, [
    "tope_anual", "imp_integrado_servicios", "imp_integrado_bienes", "aportes_sipa", "cuota_servicios", "cuota_bienes", "vigente_desde",
  ])
})

test("sin componente de Río Negro no deja confirmar", () => {
  const { filas } = leerMontosArca(HTML)
  const { B: _, ...sinB } = RIO_NEGRO
  const c = compararConTopes({ vigente_desde: "2026-08-01", filas }, [], sinB)
  assert.equal(c.errores.length, 1)
  assert.match(c.errores[0], /categoría B/)
  assert.equal(c.filas[1].nuevo.cuota_servicios, null)
})

test("la firma de la vista previa cambia si cambia un monto", () => {
  const { filas } = leerMontosArca(HTML)
  const firma = (rn: Record<string, number>) =>
    firmaPrevia("2026-08-01", compararConTopes({ vigente_desde: "2026-08-01", filas }, [], rn).filas)
  assert.equal(firma(RIO_NEGRO), firma({ ...RIO_NEGRO }))
  assert.notEqual(firma(RIO_NEGRO), firma({ ...RIO_NEGRO, A: 20759.15 }))
})
