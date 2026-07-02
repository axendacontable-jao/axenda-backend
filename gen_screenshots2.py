#!/usr/bin/env python3
"""Captura screenshots adicionales del admin: detalle cliente + historial cuotas."""

from playwright.sync_api import sync_playwright
from pathlib import Path

HTML_FILE = Path("C:/Users/julia/OneDrive/Desktop/axenda-admin (3).html")
OUT_DIR   = Path("C:/Users/julia/axenda-backend/screenshots_promo")
OUT_DIR.mkdir(exist_ok=True)

def nav_wait(page, txt, ms=2500):
    page.locator(".nav-btn").filter(has_text=txt).click()
    page.wait_for_timeout(ms)

def shot(page, name):
    path = str(OUT_DIR / f"{name}.png")
    page.screenshot(path=path, full_page=False)
    print(f"  [OK] {name}.png")

def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        ctx = browser.new_context(
            viewport={"width": 1440, "height": 860},
            device_scale_factor=1.5,
        )
        page = ctx.new_page()
        page.goto(HTML_FILE.as_uri(), wait_until="domcontentloaded")
        try:
            page.wait_for_selector("table, .dashboard-card, .cliente-card", timeout=14000)
        except Exception:
            pass
        page.wait_for_timeout(2500)

        # Ir a clientes y abrir el primero
        nav_wait(page, "Clientes", 2000)
        try:
            page.locator(".cliente-card").first.click()
            page.wait_for_timeout(3000)
            shot(page, "03_detalle_facturacion")

            # Historial cuotas: buscar el panel expandible
            # Buscar boton o div que diga Historial
            hist = page.locator("text=Historial de cuotas").first
            if hist.is_visible():
                hist.click()
                page.wait_for_timeout(2500)
                shot(page, "03b_historial_cuotas")

            # Tab de Planes en el detalle
            planes_tab = page.locator("button").filter(has_text="Planes").first
            if planes_tab.is_visible():
                planes_tab.click()
                page.wait_for_timeout(2000)
                shot(page, "03c_planes_cliente")

        except Exception as e:
            print(f"  [WARN] {e}")

        # Cuotas expandido
        nav_wait(page, "Cuotas", 2000)
        try:
            # click primera fila de la tabla para expandir historial
            page.locator("tbody tr").first.click()
            page.wait_for_timeout(2500)
            shot(page, "04b_cuotas_historial")
        except Exception as e:
            print(f"  [WARN] expand cuotas: {e}")

        browser.close()

    print("Done:", OUT_DIR)
    for f in sorted(OUT_DIR.iterdir()):
        print(f"  {f.name} ({f.stat().st_size//1024} KB)")

if __name__ == "__main__":
    main()
