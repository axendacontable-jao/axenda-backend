import os, re, datetime, base64, uuid, random, subprocess, tempfile
from pathlib import Path
from dotenv import load_dotenv
from lxml import etree
from fastapi import FastAPI, HTTPException, UploadFile
import pandas as pd
import io
from fastapi.middleware.cors import CORSMiddleware
from supabase import create_client
import requests
import urllib3
from requests.adapters import HTTPAdapter
from urllib3.util.ssl_ import create_urllib3_context

class LegacySSLAdapter(HTTPAdapter):
    def init_poolmanager(self, *args, **kwargs):
        ctx = create_urllib3_context()
        ctx.set_ciphers("DEFAULT:@SECLEVEL=1")
        ctx.options |= 0x4  # OP_LEGACY_SERVER_CONNECT
        kwargs["ssl_context"] = ctx
        return super().init_poolmanager(*args, **kwargs)

def requests_legacy():
    s = requests.Session()
    s.mount("https://", LegacySSLAdapter())
    return s

load_dotenv()

app = FastAPI(title="Axenda Contable API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
db = create_client(SUPABASE_URL, SUPABASE_KEY)

CUIT_CONTADOR = os.getenv("CUIT_CONTADOR", "20395847946")

def setup_cert_files():
    cert_content = os.getenv("CERT_CONTENT", "")
    key_content  = os.getenv("KEY_CONTENT", "")
    if cert_content:
        cert_content = cert_content.replace("\\n", "\n")
        with open("axenda-contable.crt", "w") as f:
            f.write(cert_content)
        os.environ["CERT_PATH"] = "axenda-contable.crt"
    if key_content:
        key_content = key_content.replace("\\n", "\n")
        with open("axenda_privada.key", "w") as f:
            f.write(key_content)
        os.environ["KEY_PATH"] = "axenda_privada.key"

setup_cert_files()

CERT_PATH = os.getenv("CERT_PATH", "axenda-contable.crt")
KEY_PATH  = os.getenv("KEY_PATH",  "axenda_privada.key")

# Cache separado por servicio
_token_cache = {}

WSAA_URL_PROD = "https://wsaa.afip.gov.ar/ws/services/LoginCms"

def crear_tra(servicio: str) -> str:
    ahora = datetime.datetime.now(datetime.timezone.utc)
    desde = (ahora - datetime.timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    hasta = (ahora + datetime.timedelta(hours=12)).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    unique_id = str(random.randint(1, 2147483647))
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>{unique_id}</uniqueId>
    <generationTime>{desde}</generationTime>
    <expirationTime>{hasta}</expirationTime>
  </header>
  <service>{servicio}</service>
</loginTicketRequest>"""

def firmar_tra(tra: str) -> str:
    with tempfile.NamedTemporaryFile(suffix=".xml", delete=False, mode="w") as f:
        f.write(tra)
        tra_path = f.name
    out_path = tra_path + ".cms"
    try:
        result = subprocess.run([
            "openssl", "smime", "-sign",
            "-in", tra_path, "-signer", CERT_PATH, "-inkey", KEY_PATH,
            "-outform", "DER", "-nodetach", "-out", out_path
        ], capture_output=True, timeout=15)
        if result.returncode != 0:
            raise Exception(f"openssl error: {result.stderr.decode()}")
        with open(out_path, "rb") as f:
            return base64.b64encode(f.read()).decode("utf-8")
    finally:
        os.unlink(tra_path)
        if os.path.exists(out_path):
            os.unlink(out_path)

def obtener_token(servicio: str, cuit_rep: str = None) -> dict:
    global _token_cache
    ahora = datetime.datetime.now(datetime.timezone.utc)
    cache_key = f"{servicio}:{cuit_rep}" if cuit_rep else servicio
    cached = _token_cache.get(cache_key)
    if cached and cached["expira"] and ahora < cached["expira"]:
        return cached
    tra = crear_tra(servicio)
    cms = firmar_tra(tra)
    soap_body = f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Header/>
  <soapenv:Body>
    <wsaa:loginCms>
      <wsaa:in0>{cms}</wsaa:in0>
    </wsaa:loginCms>
  </soapenv:Body>
</soapenv:Envelope>"""
    r = requests_legacy().post(WSAA_URL_PROD, data=soap_body.encode("utf-8"),
                      headers={"Content-Type": "text/xml; charset=UTF-8", "SOAPAction": ""}, timeout=30)
    if r.status_code != 200:
        raise Exception(f"WSAA error {r.status_code}: {r.text[:500]}")
    root = etree.fromstring(r.content)
    resultado = root.find(".//{http://wsaa.view.sua.dvadac.desein.afip.gov}loginCmsReturn")
    if resultado is None:
        raise Exception(f"WSAA sin loginCmsReturn: {r.text[:500]}")
    ticket = etree.fromstring(resultado.text.encode("utf-8"))
    token = ticket.find(".//token").text
    sign  = ticket.find(".//sign").text
    expira = datetime.datetime.fromisoformat(ticket.find(".//expirationTime").text)
    _token_cache[cache_key] = {"token": token, "sign": sign, "expira": expira}
    return _token_cache[cache_key]

def buscar_en_constancia(cuit: str) -> dict:
    """Busca en Padron A5 / constancia inscripcion. Devuelve nombre, apellido y categoria."""
    auth = obtener_token("ws_sr_constancia_inscripcion")
    soap_body = f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:con="http://a5.soap.ws.server.puc.sr/">
  <soapenv:Header/>
  <soapenv:Body>
    <con:getPersona>
      <token>{auth['token']}</token>
      <sign>{auth['sign']}</sign>
      <cuitRepresentada>{CUIT_CONTADOR}</cuitRepresentada>
      <idPersona>{cuit}</idPersona>
    </con:getPersona>
  </soapenv:Body>
</soapenv:Envelope>"""
    r = requests_legacy().post(
        "https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5",
        data=soap_body.encode("utf-8"),
        headers={"Content-Type": "text/xml; charset=UTF-8", "SOAPAction": ""},
        timeout=30
    )
    root = etree.fromstring(r.content)
    def get(tag):
        el = root.find(f".//{tag}")
        return el.text if el is not None else ""
    nombre   = get("nombre")
    apellido = get("apellido") or get("razonSocial")
    estado   = get("estadoClave")
    # Categoria: busqueda flexible
    categoria = ""
    for el in root.iter():
        if "categoria" in el.tag.lower() and el.text:
            categoria = el.text.strip().split()[0].upper()
            if categoria.match if hasattr(categoria, 'match') else re.match(r'^[A-K]$', categoria):
                break
    if not nombre and not apellido:
        raise Exception("CUIT no encontrado en constancia")
    return {"cuit": cuit, "nombre": nombre, "apellido": apellido,
            "categoria": categoria, "estado": estado, "fuente": "constancia"}

def buscar_en_padron(cuit: str) -> dict:
    """Fallback: busca en Padron A13. Solo devuelve nombre y apellido."""
    auth = obtener_token("ws_sr_padron_a13")
    soap_body = f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:a13="http://a13.soap.ws.server.puc.sr/">
  <soapenv:Header/>
  <soapenv:Body>
    <a13:getPersona>
      <token>{auth['token']}</token>
      <sign>{auth['sign']}</sign>
      <cuitRepresentada>{CUIT_CONTADOR}</cuitRepresentada>
      <idPersona>{cuit}</idPersona>
    </a13:getPersona>
  </soapenv:Body>
</soapenv:Envelope>"""
    r = requests_legacy().post(
        "https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA13",
        data=soap_body.encode("utf-8"),
        headers={"Content-Type": "text/xml; charset=UTF-8", "SOAPAction": ""},
        timeout=30
    )
    root = etree.fromstring(r.content)
    def get(tag):
        el = root.find(f".//{tag}")
        return el.text if el is not None else ""
    nombre   = get("nombre")
    apellido = get("apellido") or get("razonSocial")
    if not nombre and not apellido:
        raise Exception("CUIT no encontrado en padron A13")
    return {"cuit": cuit, "nombre": nombre, "apellido": apellido,
            "categoria": "", "estado": get("estadoClave"), "fuente": "padron"}

@app.get("/")
async def health():
    cert_ok = Path(CERT_PATH).exists()
    key_ok  = Path(KEY_PATH).exists()
    cert_lines = 0
    if cert_ok:
        with open(CERT_PATH) as f:
            cert_lines = len(f.readlines())
    openssl_ok = subprocess.run(["openssl", "version"], capture_output=True).returncode == 0
    return {
        "status": "ok", "version": "1.4.0",
        "cert_ok": cert_ok, "key_ok": key_ok,
        "cert_lines": cert_lines, "openssl_ok": openssl_ok,
        "cuit_contador": CUIT_CONTADOR,
        "servicios_cacheados": list(_token_cache.keys()),
    }

@app.get("/padron/{cuit}")
async def consultar_padron(cuit: str):
    cuit_limpio = re.sub(r'\D', '', cuit)
    if len(cuit_limpio) != 11:
        raise HTTPException(400, "CUIT invalido: debe tener 11 digitos")
    # 1) Intentar constancia (trae nombre, apellido y categoria)
    try:
        return buscar_en_constancia(cuit_limpio)
    except Exception as e1:
        pass
    # 2) Fallback: padron A13 (solo nombre y apellido)
    try:
        return buscar_en_padron(cuit_limpio)
    except Exception as e2:
        raise HTTPException(404, f"CUIT no encontrado: {str(e2)}")

@app.get("/clientes")
async def listar_clientes():
    result = db.from_("clientes").select("*").order("apellido").execute()
    return result.data

@app.post("/clientes")
async def crear_cliente(data: dict):
    cuit = re.sub(r'\D', '', data.get("cuit", ""))
    apellido_slug = re.sub(r'[^a-z0-9]', '', data.get("apellido", "").lower().replace(" ", "-"))
    slug = f"{apellido_slug}-{cuit}"
    cliente = {
        "slug": slug, "nombre": data.get("nombre"), "apellido": data.get("apellido"),
        "cuit": cuit, "whatsapp": data.get("whatsapp", ""), "email": data.get("email", ""),
        "categoria": (data.get("categoria") or "").upper() or None,
        "cuota": data.get("cuota") or None, "activo": True,
    }
    try:
        result = db.from_("clientes").insert(cliente).execute()
    except Exception as e:
        raise HTTPException(500, f"Error al guardar cliente: {str(e)}")
    cliente_id = result.data[0]["id"] if result.data else None
    log_actividad(cliente_id, f"Alta de cliente — {data.get('nombre','')} {data.get('apellido','')}")
    return {"ok": True, "slug": slug, "data": result.data}

@app.patch("/clientes/{slug}/toggle")
async def toggle_activo(slug: str):
    try:
        cliente = db.from_("clientes").select("activo").eq("slug", slug).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    if not cliente.data:
        raise HTTPException(404, "Cliente no encontrado")
    nuevo = not cliente.data["activo"]
    db.from_("clientes").update({"activo": nuevo}).eq("slug", slug).execute()
    return {"ok": True, "activo": nuevo}

def log_actividad(cliente_id, mensaje: str):
    try:
        db.from_("alertas").insert({
            "cliente_id": cliente_id, "tipo": "actividad",
            "mensaje": mensaje, "leida": True,
        }).execute()
    except Exception:
        pass

@app.patch("/clientes/{slug}/estado-pago")
async def actualizar_estado_pago(slug: str, data: dict):
    nuevo = data.get("estado_pago")
    if nuevo not in ("al_dia", "debe", "vencida"):
        raise HTTPException(400, "Estado inválido: debe ser al_dia, debe o vencida")
    try:
        res = db.from_("clientes").select("id,nombre,apellido").eq("slug", slug).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    if not res.data:
        raise HTTPException(404, "Cliente no encontrado")
    db.from_("clientes").update({"estado_pago": nuevo}).eq("slug", slug).execute()
    if nuevo == "al_dia":
        nombre = f"{res.data.get('nombre','')} {res.data.get('apellido','')}".strip()
        log_actividad(res.data["id"], f"Cuota marcada al día — {nombre}")
    return {"ok": True, "estado_pago": nuevo}

@app.get("/clientes/{slug}/historial-cuotas")
async def get_historial_cuotas(slug: str, meses: int = 6):
    try:
        cl = db.from_("clientes").select("id").eq("slug", slug).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    cliente_id = cl.data["id"]
    hoy = datetime.date.today()
    meses_lista = []
    for i in range(meses):
        m = hoy.month - i
        y = hoy.year
        while m <= 0:
            m += 12
            y -= 1
        meses_lista.append((y, m))
    try:
        res = db.from_("historial_cuotas").select("*").eq("cliente_id", cliente_id).execute()
        existentes = {(r["año"], r["mes"]): r for r in (res.data or [])}
    except Exception:
        existentes = {}
    resultado = []
    for (y, m) in meses_lista:
        if (y, m) in existentes:
            resultado.append(existentes[(y, m)])
        else:
            resultado.append({"cliente_id": cliente_id, "año": y, "mes": m, "pagado": False, "fecha_pago": None, "id": None})
    return {"ok": True, "historial": resultado}


@app.patch("/clientes/{slug}/historial-cuotas/{año}/{mes}")
async def toggle_historial_cuota(slug: str, año: int, mes: int, data: dict):
    try:
        cl = db.from_("clientes").select("id").eq("slug", slug).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    cliente_id = cl.data["id"]
    pagado = data.get("pagado", True)
    upsert_data = {
        "cliente_id": cliente_id,
        "año": año,
        "mes": mes,
        "pagado": pagado,
        "fecha_pago": datetime.datetime.utcnow().isoformat() + "Z" if pagado else None,
    }
    try:
        db.from_("historial_cuotas").upsert(upsert_data, on_conflict="cliente_id,año,mes").execute()
    except Exception as e:
        raise HTTPException(500, str(e))
    return {"ok": True, "pagado": pagado}


@app.get("/facturacion/{slug}")
async def obtener_facturacion(slug: str):
    try:
        cliente = db.from_("clientes").select("id").eq("slug", slug).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    if not cliente.data:
        raise HTTPException(404, "Cliente no encontrado")
    result = db.from_("facturacion").select("*").eq("cliente_id", cliente.data["id"]).order("anio").order("mes").execute()
    return result.data

@app.post("/facturacion/{slug}")
async def cargar_facturacion(slug: str, data: dict):
    try:
        cliente = db.from_("clientes").select("id").eq("slug", slug).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    if not cliente.data:
        raise HTTPException(404, "Cliente no encontrado")
    registro = {
        "cliente_id": cliente.data["id"], "anio": data["anio"],
        "mes": data["mes"], "monto": data["monto"], "fuente": "manual",
    }
    result = db.from_("facturacion").upsert(registro, on_conflict="cliente_id,anio,mes").execute()
    return {"ok": True, "data": result.data}

@app.get("/portal/{slug}")
async def datos_portal(slug: str):
    cliente_res = db.from_("clientes").select("*").eq("slug", slug).execute()
    if not cliente_res.data:
        raise HTTPException(404, "Cliente no encontrado")
    cliente = cliente_res.data[0]
    tope_res = db.from_("topes_categoria").select("*").eq("categoria", cliente.get("categoria", "")).execute()
    tope = tope_res.data[0]["tope_anual"] if tope_res.data else 0
    fac_res = db.from_("facturacion").select("*").eq("cliente_id", cliente["id"]).order("anio").order("mes").execute()
    planes_res = db.from_("planes_pago").select("*").eq("cliente_id", cliente["id"]).eq("estado", "activo").execute()
    docs_res = db.from_("documentos").select("*").eq("cliente_id", cliente["id"]).order("created_at", desc=True).execute()
    alertas_res = db.from_("alertas").select("*").eq("cliente_id", cliente["id"]).eq("leida", False).execute()
    try:
        nov_res = db.from_("novedades").select("*").eq("activa", True).order("created_at", desc=True).execute()
        novedades = [n for n in (nov_res.data or [])
                     if n.get("para_todos") or str(n.get("cliente_id")) == str(cliente["id"])]
    except Exception:
        novedades = []
    try:
        cfg_res = db.from_("configuracion").select("clave,valor").in_("clave", ["whatsapp"]).execute()
        cfg = {r["clave"]: r["valor"] for r in (cfg_res.data or [])}
    except Exception:
        cfg = {}
    facturacion = fac_res.data or []
    montos = [f["monto"] for f in facturacion if f["monto"] > 0]
    total_fac = sum(montos)
    meses_cargados = len(montos) or 1
    pct = min(total_fac / tope, 1.05) if tope > 0 else 0
    return {
        "cliente": cliente, "tope": tope, "facturacion": facturacion,
        "total_fac": total_fac, "promedio": total_fac / meses_cargados,
        "pct": pct, "planes": planes_res.data or [],
        "documentos": docs_res.data or [], "alertas": alertas_res.data or [],
        "novedades": novedades, "whatsapp": cfg.get("whatsapp"),
    }


@app.post("/portal/login")
async def portal_login(data: dict):
    cuit = re.sub(r'\D', '', data.get("cuit", ""))
    password = data.get("password", "")
    if not cuit or not password:
        return {"ok": False, "error": "CUIT y contraseña requeridos"}
    try:
        res = db.from_("clientes").select("id,slug,nombre,apellido,activo,portal_password,cuit").eq("cuit", cuit).single().execute()
    except Exception:
        return {"ok": False, "error": "Credenciales incorrectas"}
    if not res.data:
        return {"ok": False, "error": "Credenciales incorrectas"}
    cliente = res.data
    pwd_guardado = cliente.get("portal_password") or cuit
    if password != pwd_guardado:
        return {"ok": False, "error": "Credenciales incorrectas"}
    return {
        "ok": True,
        "slug": cliente["slug"],
        "nombre": cliente.get("nombre", ""),
        "apellido": cliente.get("apellido", ""),
        "activo": cliente.get("activo", True),
    }


@app.patch("/portal/cambiar-password")
async def portal_cambiar_password(data: dict):
    cuit = re.sub(r'\D', '', data.get("cuit", ""))
    pwd_actual = data.get("password_actual", "")
    pwd_nueva = data.get("password_nueva", "")
    if not cuit or not pwd_actual or not pwd_nueva:
        return {"ok": False, "error": "Datos incompletos"}
    try:
        res = db.from_("clientes").select("id,portal_password,cuit").eq("cuit", cuit).single().execute()
    except Exception:
        return {"ok": False, "error": "Credenciales incorrectas"}
    if not res.data:
        return {"ok": False, "error": "Credenciales incorrectas"}
    cliente = res.data
    pwd_guardado = cliente.get("portal_password") or cuit
    if pwd_actual != pwd_guardado:
        return {"ok": False, "error": "Contraseña actual incorrecta"}
    db.from_("clientes").update({"portal_password": pwd_nueva}).eq("id", cliente["id"]).execute()
    return {"ok": True}


@app.post("/importar-comprobantes/{slug}")
async def importar_comprobantes(slug: str, file: UploadFile):
    # Leer cliente
    try:
        cliente = db.from_("clientes").select("id").eq("slug", slug).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    if not cliente.data:
        raise HTTPException(404, "Cliente no encontrado")
    cliente_id = cliente.data["id"]
    # Leer Excel
    contenido = await file.read()
    df = pd.read_excel(io.BytesIO(contenido), header=1)
    df = df[df["Fecha"].notna()].copy()
    df["Fecha"] = pd.to_datetime(df["Fecha"], dayfirst=True, errors="coerce")
    df = df[df["Fecha"].notna()]
    df["Imp. Total"] = pd.to_numeric(df["Imp. Total"], errors="coerce").fillna(0)
    if "Tipo" in df.columns:
        es_nc = df["Tipo"].astype(str).str.contains("Nota de Cr", case=False, na=False)
        df.loc[es_nc, "Imp. Total"] = -df.loc[es_nc, "Imp. Total"]
    df["mes"] = df["Fecha"].dt.month
    df["anio"] = df["Fecha"].dt.year
    # Sumar por mes
    totales = df.groupby(["anio", "mes"])["Imp. Total"].sum().reset_index()
    # Upsert en Supabase
    registros = []
    for _, row in totales.iterrows():
        registros.append({
            "cliente_id": cliente_id,
            "anio": int(row["anio"]),
            "mes": int(row["mes"]),
            "monto": float(row["Imp. Total"]),
            "fuente": "arca_excel"
        })
    for r in registros:
        db.from_("facturacion").upsert(r, on_conflict="cliente_id,anio,mes").execute()
    if registros:
        log_actividad(cliente_id, f"Importación ARCA — {slug} — {len(registros)} meses")
    return {"ok": True, "meses_importados": len(registros), "detalle": registros}

# ─── Planes de pago ──────────────────────────────────────────────────────────

@app.get("/planes")
async def listar_todos_planes():
    result = db.from_("planes_pago").select("*").eq("estado", "activo").order("proximo_venc").execute()
    return result.data or []

@app.get("/planes/{slug}")
async def planes_cliente(slug: str):
    try:
        cliente = db.from_("clientes").select("id").eq("slug", slug).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    if not cliente.data:
        raise HTTPException(404, "Cliente no encontrado")
    result = db.from_("planes_pago").select("*").eq("cliente_id", cliente.data["id"]).order("created_at", desc=True).execute()
    return result.data or []

@app.post("/planes/parsear-pdf")
async def parsear_pdf_plan(file: UploadFile):
    """Parsea PDF de Mis Facilidades ARCA y devuelve datos estructurados del plan."""
    try:
        import pdfplumber
    except ImportError:
        raise HTTPException(500, "pdfplumber no instalado")
    contenido = await file.read()
    with pdfplumber.open(io.BytesIO(contenido)) as pdf:
        texto = "\n".join(page.extract_text() or "" for page in pdf.pages)

    result: dict = {"organismo": "ARCA"}

    # Número de plan — tolerante a encoding (ú puede extraerse como char de reemplazo)
    m = re.search(r"N.{0,4}mero\s+de\s+Plan[:\s]+([A-Z0-9\-]+)", texto, re.IGNORECASE)
    if m:
        result["numero_plan"] = m.group(1).strip()

    # Fecha de consolidación
    m = re.search(r"[Ff]h?\.?\s*de\s+Consolidaci.{0,4}n[:\s]+(\d{2}/\d{2}/\d{4})", texto)
    if m:
        result["fecha_consolidacion"] = m.group(1).strip()

    hoy = datetime.date.today()

    # ── Formato "Mis Facilidades" — filas numeradas con doble vencimiento ──
    # 1er vencimiento: "N  capital  interesF  -  total  dd/mm/yyyy"
    primeros = []
    for match in re.finditer(
        r"^(\d{1,3})\s+([\d.,]+)\s+([\d.,]+)\s+[-–]\s+([\d.,]+)\s+(\d{2}/\d{2}/\d{4})",
        texto, re.MULTILINE
    ):
        try:
            num = int(match.group(1))
            total = parse_ar_number(match.group(4))
            d, mo, y = match.group(5).split("/")
            fecha = datetime.date(int(y), int(mo), int(d))
            primeros.append({"num": num, "total": total, "fecha": fecha})
        except Exception:
            pass

    # 2do vencimiento: "interesF  interesR  total  dd/mm/yyyy" (sin número al inicio)
    segundos = []
    for match in re.finditer(
        r"^([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+(\d{2}/\d{2}/\d{4})",
        texto, re.MULTILINE
    ):
        try:
            total = parse_ar_number(match.group(3))
            d, mo, y = match.group(4).split("/")
            fecha = datetime.date(int(y), int(mo), int(d))
            segundos.append({"total": total, "fecha": fecha})
        except Exception:
            pass

    if primeros:
        result["total_cuotas"] = max(r["num"] for r in primeros)
        # Cuotas con 1er vencimiento ya pasado → estimadas como pagas
        result["cuotas_pagas"] = sum(1 for r in primeros if r["fecha"] < hoy)
        # Próximo vencimiento: el más cercano entre 1eros y 2dos futuros
        all_upcoming = [(r["fecha"], r["total"]) for r in primeros if r["fecha"] >= hoy]
        all_upcoming += [(r["fecha"], r["total"]) for r in segundos if r["fecha"] >= hoy]
        all_upcoming.sort(key=lambda x: x[0])
        if all_upcoming:
            result["proximo_venc"] = all_upcoming[0][0].strftime("%d/%m/%Y")
        # Montos fijos del plan (iguales para todas las cuotas)
        result["monto_primer_venc"] = primeros[0]["total"]
        if segundos:
            result["monto_segundo_venc"] = segundos[0]["total"]
    else:
        # ── Formato alternativo: con "Cuota Cancelada" / "Cuota a Vencer" ──
        cuotas_canceladas = len(re.findall(r"Cuota\s+Cancelada", texto, re.IGNORECASE))
        result["cuotas_pagas"] = cuotas_canceladas
        total_cuotas = len(re.findall(r"Cuota\s+(?:Cancelada|a\s+Vencer)", texto, re.IGNORECASE))
        if total_cuotas > 0:
            result["total_cuotas"] = total_cuotas
        vencimientos = []
        for m in re.finditer(r"(\d{2}/\d{2}/\d{4})\s+([\d.,]+)\s+([\d.,]+)\s+Cuota a Vencer", texto, re.IGNORECASE):
            try:
                d, mo, y = m.group(1).split("/")
                fecha = datetime.date(int(y), int(mo), int(d))
                monto = parse_ar_number(m.group(3))
                if fecha >= hoy:
                    vencimientos.append((fecha, monto))
            except Exception:
                pass
        vencimientos.sort(key=lambda x: x[0])
        if vencimientos:
            result["proximo_venc"] = vencimientos[0][0].strftime("%d/%m/%Y")
            result["monto_primer_venc"] = vencimientos[0][1]
            if len(vencimientos) > 1:
                result["monto_segundo_venc"] = vencimientos[1][1]

    return {"ok": True, **result}

@app.post("/planes/{slug}")
async def crear_plan(slug: str, data: dict):
    try:
        cliente = db.from_("clientes").select("id").eq("slug", slug).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    if not cliente.data:
        raise HTTPException(404, "Cliente no encontrado")
    total = data.get("total_cuotas")
    pagas = data.get("cuotas_pagas", 0)
    impagas = (int(total) - int(pagas)) if total is not None else data.get("cuotas_impagas")
    plan = {
        "cliente_id": cliente.data["id"],
        "numero_plan":        data.get("numero_plan"),
        "organismo":          data.get("organismo", "ARCA"),
        "fecha_consolidacion": data.get("fecha_consolidacion") or None,
        "total_cuotas":       total,
        "cuotas_pagas":       pagas,
        "cuotas_impagas":     impagas,
        "monto_primer_venc":  data.get("monto_primer_venc"),
        "monto_segundo_venc": data.get("monto_segundo_venc"),
        "proximo_venc":       data.get("proximo_venc") or None,
        "url_pdf":            data.get("url_pdf"),
        "estado":             "activo",
    }
    plan = {k: v for k, v in plan.items() if v is not None}
    try:
        result = db.from_("planes_pago").insert(plan).execute()
    except Exception as e:
        raise HTTPException(500, f"Error al guardar plan: {str(e)}")
    return {"ok": True, "data": result.data}

@app.patch("/planes/{plan_id}/pagar")
async def marcar_cuota_pagada(plan_id: str):
    try:
        res = db.from_("planes_pago").select("*").eq("id", plan_id).single().execute()
    except Exception:
        raise HTTPException(404, "Plan no encontrado")
    if not res.data:
        raise HTTPException(404, "Plan no encontrado")
    p = res.data
    nuevas_pagas = (p.get("cuotas_pagas") or 0) + 1
    total        = p.get("total_cuotas") or 0
    impagas      = max(0, (p.get("cuotas_impagas") or 0) - 1)
    nuevo_estado = "cancelado" if total > 0 and nuevas_pagas >= total else "activo"
    update_data = {"cuotas_pagas": nuevas_pagas, "cuotas_impagas": impagas, "estado": nuevo_estado}
    nuevo_venc = None
    if p.get("proximo_venc") and nuevo_estado == "activo":
        try:
            fecha = datetime.date.fromisoformat(p["proximo_venc"])
            mes_sig = fecha.month % 12 + 1
            año_sig = fecha.year + (1 if fecha.month == 12 else 0)
            import calendar
            dia = min(fecha.day, calendar.monthrange(año_sig, mes_sig)[1])
            nuevo_venc = datetime.date(año_sig, mes_sig, dia).isoformat()
            update_data["proximo_venc"] = nuevo_venc
        except Exception:
            pass
    db.from_("planes_pago").update(update_data).eq("id", plan_id).execute()
    return {"ok": True, "cuotas_pagas": nuevas_pagas, "estado": nuevo_estado, "proximo_venc": nuevo_venc}

@app.patch("/planes/{plan_id}/estado")
async def cambiar_estado_plan(plan_id: str, data: dict):
    estado = data.get("estado")
    if estado not in ("activo", "cancelado", "caido", "inactivo"):
        raise HTTPException(400, "Estado inválido")
    try:
        db.from_("planes_pago").update({"estado": estado}).eq("id", plan_id).execute()
    except Exception as e:
        raise HTTPException(500, f"Error al actualizar estado: {str(e)}")
    return {"ok": True, "estado": estado}

@app.delete("/planes/{plan_id}")
async def eliminar_plan(plan_id: str):
    db.from_("planes_pago").update({"estado": "inactivo"}).eq("id", plan_id).execute()
    return {"ok": True}

# ─── Cuotas individuales de plan ──────────────────────────────────────────────

@app.get("/planes/{plan_id}/cuotas")
async def get_cuotas_plan(plan_id: str):
    try:
        res = db.from_("planes_pago_cuotas").select("*").eq("plan_id", plan_id).order("numero_cuota").execute()
    except Exception as e:
        raise HTTPException(500, str(e))
    return {"ok": True, "cuotas": res.data or []}


@app.post("/planes/{plan_id}/cuotas/inicializar")
async def inicializar_cuotas(plan_id: str):
    import calendar as cal_mod
    try:
        res = db.from_("planes_pago").select("*").eq("id", plan_id).single().execute()
    except Exception:
        raise HTTPException(404, "Plan no encontrado")
    p = res.data
    total = p.get("total_cuotas") or 0
    if total <= 0:
        raise HTTPException(400, "El plan no tiene total_cuotas definido")
    pagas = p.get("cuotas_pagas") or 0
    monto_1 = p.get("monto_primer_venc")
    monto_2 = p.get("monto_segundo_venc")
    fecha_base = None
    raw = p.get("proximo_venc")
    if raw:
        try:
            fecha_base = datetime.date.fromisoformat(raw)
        except Exception:
            pass
    if not fecha_base:
        fecha_base = datetime.date.today().replace(day=16)

    def add_months(d, n):
        month = d.month - 1 + n
        year = d.year + month // 12
        month = month % 12 + 1
        day = min(d.day, cal_mod.monthrange(year, month)[1])
        return datetime.date(year, month, day)

    cuotas = []
    for i in range(1, total + 1):
        offset = i - (pagas + 1)
        fecha_venc = add_months(fecha_base, offset)
        cuotas.append({
            "plan_id": plan_id,
            "numero_cuota": i,
            "monto_primer_venc": monto_1,
            "monto_segundo_venc": monto_2,
            "fecha_venc": fecha_venc.isoformat(),
            "pagado_primer_venc": False,
            "pagado_segundo_venc": False,
            "fecha_pago": None,
        })
    try:
        db.from_("planes_pago_cuotas").delete().eq("plan_id", plan_id).execute()
        db.from_("planes_pago_cuotas").insert(cuotas).execute()
        db.from_("planes_pago").update({"cuotas_pagas": 0}).eq("id", plan_id).execute()
    except Exception as e:
        raise HTTPException(500, f"Error al inicializar cuotas: {str(e)}")
    return {"ok": True, "cuotas": cuotas}


@app.patch("/planes/{plan_id}/cuotas/{numero_cuota}/pagar")
async def pagar_cuota_individual(plan_id: str, numero_cuota: int, data: dict):
    vencimiento = data.get("vencimiento", "1ro")
    if vencimiento not in ("1ro", "2do"):
        raise HTTPException(400, "vencimiento debe ser '1ro' o '2do'")
    update = {}
    if vencimiento == "1ro":
        update["pagado_primer_venc"] = True
        update["pagado_segundo_venc"] = False
    else:
        update["pagado_segundo_venc"] = True
    update["fecha_pago"] = datetime.datetime.utcnow().isoformat() + "Z"
    try:
        db.from_("planes_pago_cuotas").update(update).eq("plan_id", plan_id).eq("numero_cuota", numero_cuota).execute()
    except Exception as e:
        raise HTTPException(500, str(e))
    try:
        all_c = db.from_("planes_pago_cuotas").select("*").eq("plan_id", plan_id).order("numero_cuota").execute()
        cuotas = all_c.data or []
    except Exception:
        cuotas = []
    pagas = sum(1 for c in cuotas if c.get("pagado_primer_venc") or c.get("pagado_segundo_venc"))
    total = len(cuotas)
    nuevo_estado = "cancelado" if total > 0 and pagas >= total else "activo"
    proximo_venc = next(
        (c["fecha_venc"] for c in cuotas
         if not (c.get("pagado_primer_venc") or c.get("pagado_segundo_venc")) and c.get("fecha_venc")),
        None
    )
    plan_update = {"cuotas_pagas": pagas, "estado": nuevo_estado}
    if proximo_venc:
        plan_update["proximo_venc"] = proximo_venc
    try:
        db.from_("planes_pago").update(plan_update).eq("id", plan_id).execute()
    except Exception:
        pass
    return {"ok": True, "cuotas_pagas": pagas, "proximo_venc": proximo_venc, "estado": nuevo_estado}

# ─── Topes ───────────────────────────────────────────────────────────────────

def parse_ar_number(s):
    """Parse Argentine number format: 7.400.000 or 7.400.000,50"""
    if s is None:
        return None
    s = str(s).strip().replace("$", "").replace(" ", "").replace("\xa0", "")
    if not s or s in ("-", "—", ""):
        return None
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    else:
        s = s.replace(".", "")
    try:
        return float(s)
    except Exception:
        return None

@app.patch("/topes/{categoria}")
async def actualizar_tope(categoria: str, data: dict):
    campos = {"tope_anual", "cuota_servicios", "cuota_bienes", "vigente_desde"}
    update = {k: v for k, v in data.items() if k in campos}
    if not update:
        raise HTTPException(400, "Sin campos válidos")
    db.from_("topes_categoria").update(update).eq("categoria", categoria.upper()).execute()
    return {"ok": True}

@app.post("/topes/importar")
async def importar_topes(file: UploadFile):
    nombre = (file.filename or "").lower()
    contenido = await file.read()
    resultados = []
    CATS = set("ABCDEFGHIJK")

    if nombre.endswith(".pdf"):
        try:
            import pdfplumber
        except ImportError:
            raise HTTPException(500, "pdfplumber no instalado")
        with pdfplumber.open(io.BytesIO(contenido)) as pdf:
            for page in pdf.pages:
                for table in (page.extract_tables() or []):
                    if not table or len(table) < 2:
                        continue
                    col_cat = col_tope = col_serv = col_bienes = None
                    header_idx = None
                    for i, row in enumerate(table):
                        if not row:
                            continue
                        row_l = [str(c or "").lower() for c in row]
                        if any("categor" in c for c in row_l):
                            header_idx = i
                            for j, h in enumerate(row_l):
                                if "categor" in h:
                                    col_cat = j
                                elif "ingreso" in h:
                                    col_tope = j
                                elif "locacion" in h or "servicio" in h:
                                    col_serv = j
                                elif "mueble" in h or "bienes" in h:
                                    col_bienes = j
                            break
                    if header_idx is None or col_cat is None:
                        continue
                    for row in table[header_idx + 1:]:
                        if not row or len(row) <= col_cat:
                            continue
                        cat = str(row[col_cat] or "").strip().upper().split("\n")[0].strip()
                        if len(cat) != 1 or cat not in CATS:
                            continue
                        def get_cell(col):
                            return str(row[col]) if col is not None and len(row) > col else None
                        resultados.append({
                            "categoria": cat,
                            "tope_anual": parse_ar_number(get_cell(col_tope)),
                            "cuota_servicios": parse_ar_number(get_cell(col_serv)),
                            "cuota_bienes": parse_ar_number(get_cell(col_bienes)),
                        })

    elif nombre.endswith((".xlsx", ".xls")):
        df = pd.read_excel(io.BytesIO(contenido))
        df.columns = [str(c).strip() for c in df.columns]
        col_cat = col_tope = col_serv = col_bienes = None
        for col in df.columns:
            cl = col.lower()
            if "categor" in cl:   col_cat = col
            elif "ingreso" in cl: col_tope = col
            elif "locacion" in cl or "servicio" in cl: col_serv = col
            elif "mueble" in cl or "bienes" in cl:     col_bienes = col
        if col_cat is None:
            for col in df.columns:
                vals = df[col].astype(str).str.strip().str.upper()
                if sum(v in CATS and len(v) == 1 for v in vals) >= 5:
                    col_cat = col
                    break
            if col_cat:
                num_cols = [c for c in df.columns if c != col_cat and pd.to_numeric(df[c], errors="coerce").notna().sum() >= 5]
                if len(num_cols) >= 1: col_tope = num_cols[0]
                if len(num_cols) >= 2: col_serv  = num_cols[1]
                if len(num_cols) >= 3: col_bienes = num_cols[2]
        if col_cat is None:
            raise HTTPException(400, "No se encontró columna de categorías A-K en el Excel")
        for _, row in df.iterrows():
            cat = str(row[col_cat]).strip().upper()
            if len(cat) != 1 or cat not in CATS:
                continue
            def get_num(col):
                if col is None: return None
                v = pd.to_numeric(row.get(col), errors="coerce")
                return float(v) if not pd.isna(v) else None
            resultados.append({
                "categoria": cat,
                "tope_anual": get_num(col_tope),
                "cuota_servicios": get_num(col_serv),
                "cuota_bienes": get_num(col_bienes),
            })
    else:
        raise HTTPException(400, "Formato no soportado. Subí un PDF o Excel (.xlsx)")

    if not resultados:
        raise HTTPException(400, "No se encontraron categorías A-K en el archivo")

    seen: dict = {}
    for r in resultados:
        if r["categoria"] not in seen:
            seen[r["categoria"]] = r

    actualizados = 0
    for cat, r in seen.items():
        update = {k: r[k] for k in ("tope_anual", "cuota_servicios", "cuota_bienes") if r[k] is not None}
        if update:
            db.from_("topes_categoria").update(update).eq("categoria", cat).execute()
            actualizados += 1

    return {"ok": True, "actualizados": actualizados, "categorias": list(seen.keys()), "detalle": list(seen.values())}

# ─── Configuración ───────────────────────────────────────────────────────────

@app.get("/configuracion")
async def obtener_configuracion():
    result = db.from_("configuracion").select("clave,valor").execute()
    return {r["clave"]: r["valor"] for r in (result.data or [])}

@app.post("/configuracion")
async def guardar_configuracion(data: dict):
    for clave, valor in data.items():
        db.from_("configuracion").upsert(
            {"clave": clave, "valor": str(valor) if valor is not None else ""},
            on_conflict="clave"
        ).execute()
    return {"ok": True}

# ─── Alertas ─────────────────────────────────────────────────────────────────

@app.get("/alertas/{slug}")
async def alertas_cliente(slug: str):
    try:
        cliente = db.from_("clientes").select("id").eq("slug", slug).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    if not cliente.data:
        raise HTTPException(404, "Cliente no encontrado")
    result = db.from_("alertas").select("*").eq("cliente_id", cliente.data["id"]).order("created_at", desc=True).execute()
    return result.data or []

@app.post("/alertas/{slug}")
async def crear_alerta(slug: str, data: dict):
    try:
        cliente = db.from_("clientes").select("id").eq("slug", slug).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    if not cliente.data:
        raise HTTPException(404, "Cliente no encontrado")
    alerta = {
        "cliente_id": cliente.data["id"],
        "tipo":    data.get("tipo", "manual"),
        "mensaje": data.get("mensaje", ""),
        "leida":   False,
    }
    try:
        result = db.from_("alertas").insert(alerta).execute()
    except Exception as e:
        raise HTTPException(500, f"Error al crear alerta: {str(e)}")
    return {"ok": True, "data": result.data}

@app.delete("/alertas/{alerta_id}")
async def eliminar_alerta(alerta_id: str):
    db.from_("alertas").delete().eq("id", alerta_id).execute()
    return {"ok": True}

# ─── Documentos ──────────────────────────────────────────────────────────────

@app.post("/documentos/{slug}")
async def crear_documento(slug: str, data: dict):
    try:
        cliente = db.from_("clientes").select("id").eq("slug", slug).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    if not cliente.data:
        raise HTTPException(404, "Cliente no encontrado")
    doc = {
        "cliente_id": cliente.data["id"],
        "nombre":  data.get("nombre"),
        "tipo":    data.get("tipo"),
        "fecha":   data.get("fecha"),
        "url":     data.get("url"),
    }
    try:
        result = db.from_("documentos").insert({k: v for k, v in doc.items() if v is not None}).execute()
    except Exception as e:
        raise HTTPException(500, f"Error al guardar documento: {str(e)}")
    return {"ok": True, "data": result.data}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8080)))



































