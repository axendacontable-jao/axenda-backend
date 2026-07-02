#!/usr/bin/env python3
"""Axenda Contable — Brochure promocional con screenshots reales del sistema."""

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas as pdf_canvas
from reportlab.lib.colors import HexColor, white
import os

W, H = A4
SHOTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'screenshots_promo')

NAVY  = HexColor('#1B2D4F')
NAVY2 = HexColor('#0D1926')
SLATE = HexColor('#1E293B')
DARK  = HexColor('#0F172A')
MID   = HexColor('#334155')
BLUE  = HexColor('#2563EB')
BL    = HexColor('#DBEAFE')
BM    = HexColor('#93C5FD')
GRN   = HexColor('#2BAF82')
GL    = HexColor('#D1FAE5')
RED   = HexColor('#E04545')
RL    = HexColor('#FEE2E2')
AMB   = HexColor('#F59E0B')
AL    = HexColor('#FEF3C7')
GRAY  = HexColor('#F8FAFC')
BRD   = HexColor('#E2E8F0')
MUT   = HexColor('#64748B')
LIGHT = HexColor('#F1F5F9')
PURP  = HexColor('#7C3AED')
PL    = HexColor('#EDE9FE')
TEAL  = HexColor('#06B6D4')
TL    = HexColor('#CFFAFE')
PINK  = HexColor('#EC4899')
PKL   = HexColor('#FCE7F3')

TC1 = HexColor('#1E40AF')
TC2 = HexColor('#065F46')
TC3 = HexColor('#5B21B6')


# ── helpers ──────────────────────────────────────────────────────────────────

def rr(c, x, y, w, h, r=3, fc=None, sc=None, sw=0.5):
    if fc: c.setFillColor(fc)
    if sc: c.setStrokeColor(sc); c.setLineWidth(sw)
    c.roundRect(x, y, w, h, r,
                fill=1 if fc else 0,
                stroke=1 if sc else 0)

def txt(c, x, y, s, bold=False, sz=10, col=None, a='left'):
    if col: c.setFillColor(col)
    c.setFont('Helvetica-Bold' if bold else 'Helvetica', sz)
    if a == 'c': c.drawCentredString(x, y, s)
    elif a == 'r': c.drawRightString(x, y, s)
    else: c.drawString(x, y, s)

def hl(c, x, y, w, col=HexColor('#E2E8F0'), lw=0.5):
    c.setStrokeColor(col); c.setLineWidth(lw); c.line(x, y, x+w, y)

def dot(c, x, y, r=2, col=GRN):
    c.setFillColor(col); c.circle(x, y, r, fill=1, stroke=0)

def chk(c, x, y, col=GRN, sz=2.5):
    c.setStrokeColor(col); c.setLineWidth(1.3)
    c.line(x, y, x+sz*0.45, y-sz*0.5)
    c.line(x+sz*0.45, y-sz*0.5, x+sz*1.1, y+sz*0.6)

def cross(c, x, y, col=RED, sz=2):
    c.setStrokeColor(col); c.setLineWidth(1.3)
    c.line(x, y, x+sz*1.1, y+sz*1.1)
    c.line(x+sz*1.1, y, x, y+sz*1.1)

def status_badge(c, x, y, label, fc, tc, sz=7.5, h_pad=5, v_pad=3):
    c.setFont('Helvetica-Bold', sz)
    tw = c.stringWidth(label, 'Helvetica-Bold', sz)
    bw = tw + h_pad*2; bh = sz + v_pad*2
    rr(c, x, y-v_pad, bw, bh, r=bh/2, fc=fc)
    c.setFillColor(tc); c.drawString(x + h_pad, y, label)
    return bw + 3

def cat_badge(c, x, y, cat):
    cat_map = {
        'A': (BLUE, BL), 'B': (PURP, PL), 'C': (GRN, GL),
        'D': (AMB, AL),  'E': (PINK, PKL), 'F': (TEAL, TL),
    }
    fc, bc = cat_map.get(cat, (BLUE, BL))
    label = f'Cat. {cat}'
    c.setFont('Helvetica-Bold', 7.5)
    tw = c.stringWidth(label, 'Helvetica-Bold', 7.5)
    bw = tw + 10
    rr(c, x, y-3, bw, 12, r=6, fc=bc)
    c.setFillColor(fc); c.drawString(x + 5, y, label)
    return bw + 3

def page_top(c, subtitle, n, total=6):
    rr(c, 0, H-10*mm, W, 10*mm, r=0, fc=NAVY)
    txt(c, 15*mm, H-6.5*mm, 'AXENDA CONTABLE', bold=True, sz=8, col=white)
    txt(c, W-15*mm, H-6.5*mm, subtitle, sz=7, col=HexColor('#94A3B8'), a='r')
    rr(c, 0, 0, W, 8*mm, r=0, fc=GRAY)
    hl(c, 0, 8*mm, W, BRD)
    txt(c, 15*mm, 3*mm,
        'contacto@axendacontable.com.ar  |  www.axendacontable.com.ar',
        sz=7, col=MUT)
    txt(c, W-15*mm, 3*mm, f'{n} / {total}', sz=7, col=MUT, a='r')

def wordwrap(c, text, max_w, font='Helvetica', sz=8):
    words, lines, line = text.split(), [], ''
    for w in words:
        test = (line + ' ' + w).strip()
        if c.stringWidth(test, font, sz) > max_w:
            if line: lines.append(line)
            line = w
        else:
            line = test
    if line: lines.append(line)
    return lines


# ── PAGE 1: COVER ─────────────────────────────────────────────────────────────

def page_cover(c):
    rr(c, 0, 0, W, H, r=0, fc=NAVY2)
    rr(c, 0, H*0.38, W, H*0.62, r=0, fc=NAVY)

    c.setFillColor(HexColor('#1E3A5F'))
    c.circle(W-38*mm, H-52*mm, 72*mm, fill=1, stroke=0)
    c.setFillColor(HexColor('#162D4A'))
    c.circle(-18*mm, 82*mm, 62*mm, fill=1, stroke=0)
    c.setFillColor(HexColor('#0F1E35'))
    c.circle(W-22*mm, 42*mm, 48*mm, fill=1, stroke=0)

    rr(c, 15*mm, H-46*mm, 10*mm, 2*mm, r=1, fc=BLUE)
    rr(c, 15*mm, H-50*mm, 5*mm, 2*mm, r=1, fc=BM)

    txt(c, 15*mm, H-70*mm, 'AXENDA', bold=True, sz=52, col=white)
    txt(c, 15*mm, H-85*mm, 'CONTABLE', bold=True, sz=52, col=BLUE)
    txt(c, 15*mm, H-100*mm,
        u'Gestión integral de monotributistas',
        sz=16, col=HexColor('#94A3B8'))
    txt(c, 15*mm, H-109*mm,
        u'para estudios contables modernos',
        sz=16, col=HexColor('#94A3B8'))

    features = [
        'Panel de clientes', 'Cuotas mensuales',
        'Planes ARCA', 'Portal del cliente', 'Alertas'
    ]
    fx, fy = 15*mm, H-128*mm
    for f in features:
        c.setFont('Helvetica', 8)
        fw = c.stringWidth(f, 'Helvetica', 8) + 16
        rr(c, fx, fy-3*mm, fw, 7.5*mm, r=3.5*mm,
           fc=HexColor('#2563EB20'))
        c.setFillColor(BM)
        c.drawString(fx+8, fy+0.5*mm, f)
        fx += fw + 5
        if fx > W-55*mm:
            fx = 15*mm; fy -= 10*mm

    mx=22*mm; my=32*mm; mw=W-44*mm; mh=78*mm
    c.setFillColor(HexColor('#00000045'))
    c.roundRect(mx+1.5*mm, my-1.5*mm, mw, mh, 3.5*mm, fill=1, stroke=0)
    rr(c, mx, my, mw, mh, r=3.5*mm, fc=SLATE)
    rr(c, mx, my+mh-8*mm, mw, 8*mm, r=3.5*mm, fc=DARK)
    for i, dc in enumerate([HexColor('#EF4444'),
                             HexColor('#F59E0B'),
                             HexColor('#22C55E')]):
        c.setFillColor(dc)
        c.circle(mx+6.5*mm+i*5*mm, my+mh-4*mm, 1.5*mm, fill=1, stroke=0)
    rr(c, mx+22*mm, my+mh-6.5*mm, mw-44*mm, 5*mm, r=2*mm, fc=SLATE)
    txt(c, mx+mw/2, my+mh-5.2*mm,
        'admin.axendacontable.com.ar', sz=6.5, col=MUT, a='c')

    ty = my+mh-10*mm
    cx_cols = [mx+3*mm, mx+44*mm, mx+80*mm, mx+108*mm, mx+133*mm]
    rr(c, mx, ty-5.5*mm, mw, 5.5*mm, r=0, fc=DARK)
    for i, h in enumerate(['Cliente', u'Categoría', 'Cuota',
                            'Estado', 'Deuda']):
        txt(c, cx_cols[i], ty-3.8*mm, h, bold=True, sz=6.5,
            col=HexColor('#94A3B8'))
    ty -= 5.5*mm

    rows = [
        (u'María González',   'C', '$38.500', 'Al dia',  '-',        GRN),
        (u'Carlos Fernández', 'B', '$25.000', 'Debe',    '$75.000',  RED),
        (u'Laura Martínez',   'D', '$52.000', 'Al dia',  '-',        GRN),
        (u'Roberto Sánchez',  'A', '$18.000', 'Vencida', '$54.000',
         HexColor('#DC2626')),
        (u'Ana López',        'C', '$38.500', 'Al dia',  '-',        GRN),
        (u'Diego Torres',     'B', '$25.000', 'Al dia',  '-',        GRN),
        (u'Valeria Ruiz',     'E', '$70.000', 'Debe',    '$140.000', RED),
    ]
    for i, (name, cat, cuota, estado, deuda, sc) in enumerate(rows):
        if ty < my+1*mm: break
        bg = SLATE if i % 2 == 0 else HexColor('#1A2640')
        rr(c, mx, ty-5*mm, mw, 5*mm, r=0, fc=bg)
        txt(c, cx_cols[0], ty-3.5*mm, name, sz=6.5, col=white)
        txt(c, cx_cols[1], ty-3.5*mm, f'Cat. {cat}', sz=6.5,
            col=HexColor('#94A3B8'))
        txt(c, cx_cols[2], ty-3.5*mm, cuota, bold=True, sz=6.5, col=white)
        rr(c, cx_cols[3], ty-4.5*mm, 19*mm, 4*mm, r=2*mm, fc=sc)
        txt(c, cx_cols[3]+2*mm, ty-3.2*mm, estado, bold=True, sz=6,
            col=white)
        dc = RED if deuda != '-' else MUT
        txt(c, cx_cols[4], ty-3.5*mm, deuda, bold=True, sz=6.5, col=dc)
        ty -= 5*mm

    txt(c, W/2, 19*mm,
        u'Tu estudio, potenciado con tecnología',
        sz=12, col=HexColor('#94A3B8'), a='c')
    txt(c, W/2, 12*mm,
        u'Software como Servicio  ·  '
        u'Implementación inmediata  ·  Soporte incluido',
        sz=8, col=HexColor('#475569'), a='c')
    hl(c, 15*mm, 16*mm, W-30*mm, HexColor('#334155'))


# ── PAGES 2-5: SCREENSHOT PAGES ───────────────────────────────────────────────

def page_screenshot(c, img_file, page_num, nav_label, title, subtitle,
                    row1, row2, tip_title, tip_body):
    """
    Content page built around a real screenshot.
    row1, row2: list of (title, description) tuples (3 items each)
    """
    page_top(c, nav_label, page_num)

    # ── Title area ──
    y = H - 20*mm
    txt(c, 15*mm, y, title, bold=True, sz=20, col=NAVY)
    txt(c, 15*mm, y-7*mm, subtitle, sz=9.5, col=MUT)
    hl(c, 15*mm, y-11*mm, W-30*mm, BRD)
    y -= 16*mm  # y is now the TOP of the screenshot area

    # ── Screenshot ──
    sc_w = W - 30*mm
    sc_h = sc_w / (1440 / 860)   # ~107 mm at A4 width
    sc_x = 15*mm
    sc_bot = y - sc_h

    # shadow
    c.setFillColor(HexColor('#00000022'))
    c.roundRect(sc_x + 2.5, sc_bot - 3, sc_w, sc_h, 4, fill=1, stroke=0)

    # image
    c.drawImage(os.path.join(SHOTS, img_file),
                sc_x, sc_bot, width=sc_w, height=sc_h, mask='auto')

    # border
    c.setStrokeColor(BRD); c.setLineWidth(0.7)
    c.roundRect(sc_x, sc_bot, sc_w, sc_h, 4, fill=0, stroke=1)

    y = sc_bot - 9*mm  # top of feature area

    # ── Feature rows (3 + 3) ──
    fw = (W - 30*mm - 2*4*mm) / 3   # width of each feature card
    fh = 28*mm

    styles = [
        (BLUE, BL, TC1),
        (GRN,  GL, TC2),
        (PURP, PL, TC3),
    ]

    for row_idx, row in enumerate([row1, row2]):
        fy = y - fh
        for col_idx, (ft, fd) in enumerate(row[:3]):
            fc, bc, tc = styles[col_idx]
            fx = 15*mm + col_idx*(fw + 4*mm)

            rr(c, fx, fy, fw, fh, r=4, fc=bc, sc=fc, sw=0.7)
            # top accent
            rr(c, fx, fy+fh-1.5*mm, fw, 1.5*mm, r=0, fc=fc)

            txt(c, fx+5*mm, fy+fh-8*mm, ft, bold=True, sz=9, col=tc)

            lines = wordwrap(c, fd, fw-10*mm)
            for j, ln in enumerate(lines[:3]):
                txt(c, fx+5*mm, fy+fh-15*mm-j*5.5*mm, ln, sz=8, col=DARK)

        y = fy - 5*mm  # gap between rows

    # ── Tip callout ──
    bar_h = 19*mm
    bar_y = y - bar_h - 4*mm
    rr(c, 15*mm, bar_y, W-30*mm, bar_h, r=4, fc=NAVY)
    txt(c, 22*mm, bar_y+bar_h-7*mm, tip_title, bold=True, sz=10, col=white)
    txt(c, 22*mm, bar_y+bar_h-13*mm, tip_body, sz=8.5, col=HexColor('#94A3B8'))


# ── PAGE 6: CTA ───────────────────────────────────────────────────────────────

def page_cta(c):
    rr(c, 0, 0, W, H, r=0, fc=NAVY2)
    rr(c, 0, H-10*mm, W, 10*mm, r=0, fc=NAVY)
    txt(c, 15*mm, H-6.5*mm, 'AXENDA CONTABLE', bold=True, sz=8, col=white)
    txt(c, W-15*mm, H-6.5*mm, '6 / 6', sz=7, col=HexColor('#94A3B8'), a='r')

    txt(c, 15*mm, H-24*mm, u'¿Qué incluye?', bold=True, sz=18, col=white)
    hl(c, 15*mm, H-28*mm, 65*mm, BLUE, 1.5)

    all_f = [
        (u'Gestión de clientes', [
            u'Alta, baja y modificación',
            u'Estados de pago y seguimiento',
            u'Búsqueda, filtros y exportación',
        ]),
        ('Cuotas mensuales', [
            u'Historial 6 meses automático',
            u'Split ART Río Negro / ARCA',
            u'Deuda manual por organismo',
        ]),
        ('Planes de pago ARCA', [
            u'Parseo automático de PDF ARCA',
            u'Control cuota a cuota',
            u'Estados activo / caído / cancelado',
        ]),
        ('Portal del cliente', [
            u'Link único por cliente',
            u'Semáforo de recategorización',
            u'Bóveda de documentos',
        ]),
        ('Alertas y notificaciones', [
            u'Vencimientos y recordatorios',
            u'Recategorización automática',
            u'Alertas personalizadas',
        ]),
        (u'Facturación e ingresos', [
            u'Importación de movimientos',
            u'Evolución mensual y comparativa',
            u'Control de topes anuales',
        ]),
    ]
    fy4 = H-35*mm
    for i5, (sec, items) in enumerate(all_f):
        col5 = i5 % 2; row5 = i5 // 2
        sx5 = 15*mm + col5*85*mm
        sy5 = fy4 - row5*38*mm
        txt(c, sx5, sy5, sec, bold=True, sz=9, col=BM)
        for j5, item in enumerate(items):
            dot(c, sx5+2*mm, sy5-5*mm-j5*6*mm+2*mm, r=1.5, col=BLUE)
            txt(c, sx5+6*mm, sy5-5*mm-j5*6*mm,
                item, sz=8, col=HexColor('#94A3B8'))

    cx3 = W/2+8*mm; cy3 = H-22*mm; cw3 = W/2-23*mm
    rr(c, cx3, cy3-125*mm, cw3, 123*mm, r=4, fc=SLATE, sc=BLUE, sw=1.2)

    txt(c, cx3+cw3/2, cy3-8*mm, 'Plan Estudio',
        bold=True, sz=14, col=white, a='c')
    txt(c, cx3+cw3/2, cy3-17*mm, 'Precio a convenir',
        bold=True, sz=13, col=BM, a='c')
    txt(c, cx3+cw3/2, cy3-23*mm, 'por mes + IVA', sz=9, col=MUT, a='c')
    hl(c, cx3+8*mm, cy3-27*mm, cw3-16*mm, MID)

    includes = [
        u'Clientes ilimitados',
        u'Portales de cliente incluidos',
        u'Actualizaciones automáticas',
        u'Soporte por WhatsApp',
        u'Datos seguros en la nube',
        u'Implementación en 1 día',
        u'Sin contratos de permanencia',
    ]
    iy3 = cy3-35*mm
    for inc in includes:
        chk(c, cx3+10*mm, iy3+1*mm, GRN, sz=3)
        txt(c, cx3+17*mm, iy3, inc, sz=9.5, col=white)
        iy3 -= 8*mm

    rr(c, cx3+6*mm, cy3-117*mm, cw3-12*mm, 12*mm, r=6*mm, fc=BLUE)
    txt(c, cx3+cw3/2, cy3-110.5*mm, 'Solicitar demo gratuita',
        bold=True, sz=10, col=white, a='c')

    txt(c, 15*mm, 40*mm, 'Contacto', bold=True, sz=11, col=BM)
    contacts = ['contacto@axendacontable.com.ar',
                '+54 9 294 XXX XXXX',
                'www.axendacontable.com.ar']
    for i, ct in enumerate(contacts):
        txt(c, 15*mm, (38-i*6.5)*mm, ct, sz=9, col=HexColor('#94A3B8'))

    rr(c, 0, 0, W, 8*mm, r=0, fc=NAVY)
    txt(c, W/2, 3*mm,
        u'Axenda Contable © 2025  —  '
        u'Software de gestión para estudios contables · Argentina',
        sz=7, col=HexColor('#475569'), a='c')


# ── MAIN ──────────────────────────────────────────────────────────────────────

def main():
    base = os.path.join(os.path.expanduser('~'), 'OneDrive', 'Desktop',
                        'Axenda_Contable_Promo.pdf')
    out  = base
    if os.path.exists(out):
        try:
            with open(out, 'ab'):
                pass
        except PermissionError:
            out = base.replace('.pdf', '_v2.pdf')
    cv = pdf_canvas.Canvas(out, pagesize=A4)

    page_cover(cv)
    cv.showPage()

    page_screenshot(
        cv,
        img_file='01_dashboard.png',
        page_num=2,
        nav_label='Dashboard',
        title='Dashboard General',
        subtitle=u'Toda la información del estudio centralizada en un solo lugar, actualizada en tiempo real.',
        row1=[
            ('Vista Ejecutiva',
             u'Estadísticas clave: clientes activos, con deuda, vencidos y facturación del mes.'),
            ('Alertas Automáticas',
             u'Vencimientos próximos, cuotas pendientes y recategorizaciones destacadas al frente.'),
            ('Acceso Rápido',
             u'Navegá al detalle de cualquier cliente desde el panel principal con un click.'),
        ],
        row2=[
            ('Sin Instalación',
             u'Funciona en el navegador, en cualquier dispositivo. Sin configuraciones.'),
            ('Multi-cliente',
             u'Gestioná decenas de monotributistas desde un único panel ordenado.'),
            ('Actualización',
             u'Los datos se sincronizan automáticamente con cada acción del estudio.'),
        ],
        tip_title=u'El punto de partida de tu jornada laboral.',
        tip_body=(u'Entrás, ves quién debe, quién está al día y qué vence esta semana. '
                  u'Todo sin buscar ni calcular.'),
    )
    cv.showPage()

    page_screenshot(
        cv,
        img_file='02_clientes.png',
        page_num=3,
        nav_label=u'Panel de Clientes',
        title=u'Gestión de Clientes',
        subtitle=u'Todos tus clientes activos con estados de pago, categoría, cuota y CUIT en una sola tabla.',
        row1=[
            ('Panel Completo',
             u'Cada cliente muestra su categoría ARCA, cuota mensual, estado y CUIT.'),
            ('Estados Visuales',
             u'Badges de color para identificar al día, debe y vencido de un vistazo.'),
            ('Detalle Completo',
             u'Entrá al perfil completo de cualquier cliente con un click en la tarjeta.'),
        ],
        row2=[
            ('Filtros Avanzados',
             u'Filtrá por nombre, categoría de monotributo o estado de pago.'),
            (u'Categorías ARCA',
             u'Categoría A a K actualizada manualmente cuando el cliente recategoriza.'),
            (u'Gestión Masiva',
             u'Administrá decenas de clientes desde una sola pantalla, sin perderte.'),
        ],
        tip_title=u'La base de todo: tu cartera de monotributistas, ordenada.',
        tip_body=(u'Agregás un cliente, le asignás categoría y cuota, '
                  u'y el sistema empieza a seguirlo automáticamente.'),
    )
    cv.showPage()

    page_screenshot(
        cv,
        img_file='03b_historial_cuotas.png',
        page_num=4,
        nav_label=u'Historial de Cuotas',
        title=u'Historial de Cuotas Mensuales',
        subtitle=u'Los últimos 6 meses por cliente, con deuda separada entre ART Río Negro y ARCA.',
        row1=[
            ('Historial Automático',
             u'Los últimos 6 meses se generan solos, sin ninguna carga manual.'),
            ('Split ART / ARCA',
             u'La deuda se calcula separada entre ART Río Negro provincial y ARCA nacional.'),
            ('Deuda Manual',
             u'Registrá deudas históricas con organismo (ARCA o ART), monto y descripción libre.'),
        ],
        row2=[
            ('Control por Mes',
             u'Marcá cada mes como pagado o pendiente con un click. Reversible.'),
            ('Deuda Estimada',
             u'La deuda total se calcula automáticamente y se muestra por organismo.'),
            (u'Vencimiento Claro',
             u'Se identifica cuándo aplica el componente ART según el día del mes.'),
        ],
        tip_title=u'El cálculo de deuda que te saca trabajo.',
        tip_body=(u'Ingresás los meses pagados y el sistema te calcula cuánto debe '
                  u'por ARCA, cuánto por ART y cuánto en total.'),
    )
    cv.showPage()

    page_screenshot(
        cv,
        img_file='05_planes.png',
        page_num=5,
        nav_label='Planes de Pago ARCA',
        title='Planes de Pago ARCA',
        subtitle=u'Registrá y seguí cada plan de cuotas con ARCA. Control cuota a cuota, primer y segundo vencimiento.',
        row1=[
            ('Registro de Planes',
             u'Cargá planes de cuotas ARCA con expediente, fecha de inicio y cantidad de cuotas.'),
            ('1er y 2do Vencimiento',
             u'Cada cuota tiene su primer y segundo vencimiento. Se controlan por separado.'),
            ('Cuota a Cuota',
             u'Marcá cuotas pagadas individualmente. El sistema actualiza el progreso al instante.'),
        ],
        row2=[
            ('Estado del Plan',
             u'Activo, caído o cancelado. Cambiá el estado con un click cuando sea necesario.'),
            ('Vista Global',
             u'Todos los planes de todos tus clientes visibles desde el panel de planes.'),
            ('Progreso Visual',
             u'Barra de avance que muestra cuántas cuotas van pagas del total del plan.'),
        ],
        tip_title=u'El plan de ARCA de tu cliente, siempre bajo control.',
        tip_body=(u'Sabés cuántas cuotas quedan, cuál es la próxima, '
                  u'si hubo 2do vencimiento y si el plan cayó.'),
    )
    cv.showPage()

    page_cta(cv)
    cv.showPage()

    cv.save()
    print(f'PDF generado: {out}')
    sz = os.path.getsize(out) // 1024
    print(f'Tamanio: {sz} KB')


if __name__ == '__main__':
    main()
