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
    result = db.from_("clientes").insert(cliente).execute()
    return {"ok": True, "slug": slug, "data": result.data}

@app.patch("/clientes/{slug}/toggle")
async def toggle_activo(slug: str):
    cliente = db.from_("clientes").select("activo").eq("slug", slug).single().execute()
    nuevo = not cliente.data["activo"]
    db.from_("clientes").update({"activo": nuevo}).eq("slug", slug).execute()
    return {"ok": True, "activo": nuevo}

@app.get("/facturacion/{slug}")
async def obtener_facturacion(slug: str):
    cliente = db.from_("clientes").select("id").eq("slug", slug).single().execute()
    if not cliente.data:
        raise HTTPException(404, "Cliente no encontrado")
    result = db.from_("facturacion").select("*").eq("cliente_id", cliente.data["id"]).order("anio").order("mes").execute()
    return result.data

@app.post("/facturacion/{slug}")
async def cargar_facturacion(slug: str, data: dict):
    cliente = db.from_("clientes").select("id").eq("slug", slug).single().execute()
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
    cliente_res = db.from_("clientes").select("*").eq("slug", slug).eq("activo", True).execute()
    if not cliente_res.data:
        raise HTTPException(404, "Cliente no encontrado o inactivo")
    cliente = cliente_res.data[0]
    tope_res = db.from_("topes_categoria").select("*").eq("categoria", cliente.get("categoria", "")).execute()
    tope = tope_res.data[0]["tope_anual"] if tope_res.data else 0
    fac_res = db.from_("facturacion").select("*").eq("cliente_id", cliente["id"]).order("anio").order("mes").execute()
    planes_res = db.from_("planes_pago").select("*").eq("cliente_id", cliente["id"]).eq("estado", "activo").execute()
    docs_res = db.from_("documentos").select("*").eq("cliente_id", cliente["id"]).order("created_at", desc=True).execute()
    alertas_res = db.from_("alertas").select("*").eq("cliente_id", cliente["id"]).eq("leida", False).execute()
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
    }

@app.get("/wscdc-debug/{cuit}")
async def wscdc_debug(cuit: str):
    cuit_limpio = re.sub(r"\D", "", cuit)
    auth = obtener_token("wscdc")
    soap_body = f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:wsc="http://ar.gov.afip.dif.wscdc/">
  <soapenv:Header/>
  <soapenv:Body>
    <wsc:consultarComprobantes>
      <wsc:authRequest>
        <token>{auth["token"]}</token>
        <sign>{auth["sign"]}</sign>
        <cuitRepresentada>{cuit_limpio}</cuitRepresentada>
      </wsc:authRequest>
      <wsc:consultaRequest>
        <fechaDesde>20250701</fechaDesde>
        <fechaHasta>20260616</fechaHasta>
      </wsc:consultaRequest>
    </wsc:consultarComprobantes>
  </soapenv:Body>
</soapenv:Envelope>"""
    r = requests_legacy().post(
        "https://aws.afip.gov.ar/wscdc/services/WSDCService",
        data=soap_body.encode("utf-8"),
        headers={"Content-Type": "text/xml; charset=UTF-8", "SOAPAction": ""},
        timeout=30
    )
    return {"status": r.status_code, "raw": r.text[:3000]}

@app.get("/wsfe-debug/{cuit}")
async def wsfe_debug(cuit: str):
    cuit_limpio = re.sub(r"\D", "", cuit)
    auth = obtener_token("wsfe", cuit_limpio)
    soap_body = f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:ar="http://ar.gov.afip.dif.FEV1/">
  <soapenv:Header/>
  <soapenv:Body>
    <ar:FECompUltimoAutorizado>
      <ar:Auth>
        <ar:Token>{auth["token"]}</ar:Token>
        <ar:Sign>{auth["sign"]}</ar:Sign>
        <ar:Cuit>{cuit_limpio}</ar:Cuit>
      </ar:Auth>
      <ar:PtoVta>1</ar:PtoVta>
      <ar:CbteTipo>11</ar:CbteTipo>
    </ar:FECompUltimoAutorizado>
  </soapenv:Body>
</soapenv:Envelope>"""
    r = requests_legacy().post(
        "https://servicios1.afip.gov.ar/wsfev1/service.asmx",
        data=soap_body.encode("utf-8"),
        headers={"Content-Type": "text/xml; charset=UTF-8", "SOAPAction": "http://ar.gov.afip.dif.FEV1/FECompUltimoAutorizado"},
        timeout=30
    )
    return {"status": r.status_code, "raw": r.text[:3000]}

@app.post("/importar-comprobantes/{slug}")
async def importar_comprobantes(slug: str, file: bytes = None):

    pass

@app.post("/importar-comprobantes/{slug}")
async def importar_comprobantes(slug: str, file: UploadFile):
    # Leer cliente
    cliente = db.from_("clientes").select("id").eq("slug", slug).single().execute()
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
    return {"ok": True, "meses_importados": len(registros), "detalle": registros}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8080)))



































