#!/usr/bin/env python3
"""Toma screenshots reales del admin de Axenda para el brochure PDF."""

from playwright.sync_api import sync_playwright
from pathlib import Path

HTML_FILE = Path("C:/Users/julia/OneDrive/Desktop/axenda-admin (3).html")
OUT_DIR   = Path("C:/Users/julia/axenda-backend/screenshots_promo")
OUT_DIR.mkdir(exist_ok=True)

def nav_wait(page, txt, ms=2500):
    page.locator(".nav-btn").filter(has_text=txt).click()
    page.wait_for_timeout(ms)

def shot(page, name, clip=None):
    path = str(OUT_DIR / f"{name}.png")
    page.screenshot(path=path, clip=clip, full_page=False)
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
            page.wait_for_selector("table, .dashboard-card, .client-row",
                                   timeout=14000)
        except Exception:
            pass
        page.wait_for_timeout(2500)

        # 1 dashboard
        nav_wait(page, "Dashboard", 2000)
        shot(page, "01_dashboard")

        # 2 clientes
        nav_wait(page, "Clientes", 2000)
        shot(page, "02_clientes")

        # 3 detalle cliente
        try:
            page.locator("button").filter(has_text="Ver detalle").first.click()
            page.wait_for_timeout(2500)
            shot(page, "03_detalle")
        except Exception as e:
            print(f"  [WARN] {e}")

        # 4 cuotas
        nav_wait(page, "Cuotas", 2500)
        shot(page, "04_cuotas")

        # 5 planes
        nav_wait(page, "Planes", 2500)
        shot(page, "05_planes")

        browser.close()

    print("Done:", OUT_DIR)
    for f in sorted(OUT_DIR.iterdir()):
        print(f"  {f.name} ({f.stat().st_size//1024} KB)")

if __name__ == "__main__":
    main()
