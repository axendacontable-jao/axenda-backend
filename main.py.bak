import os
import re
import json
import datetime
import base64
from pathlib import Path
from dotenv import load_dotenv
from lxml import etree
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from supabase import create_client
import requests
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.serialization import pkcs7
from cryptography import x509
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.asymmetric import padding

load_dotenv()

app = FastAPI(title="Axenda Contable API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Supabase
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
db = create_client(SUPABASE_URL, SUPABASE_KEY)

CUIT_CONTADOR = os.getenv("CUIT_CONTADOR", "20395844794")

# ── Setup certificado desde variables de entorno ──
def setup_cert_files():
    cert_content = os.getenv("CERT_CONTENT")
    key_content  = os.getenv("KEY_CONTENT")
    if cert_content:
        with open("axenda-contable.crt", "w") as f:
            f.write(cert_content)
        os.environ["CERT_PATH"] = "axenda-contable.crt"
    if key_content:
        with open("axenda_privada.key", "w") as f:
            f.write(key_content)
        os.environ["KEY_PATH"] = "axenda_privada.key"

setup_cert_files()

CERT_PATH = os.getenv("CERT_PATH", "axenda-contable.crt")
KEY_PATH  = os.getenv("KEY_PATH",  "axenda_privada.key")

# ── Cache del token ARCA ──
_token_cache = {"token": None, "sign": None, "expira": None}

WSAA_URL_HOMO = "https://wsaahomo.afip.gov.ar/ws/services/LoginCms"
WSAA_URL_PROD = "https://wsaa.afip.gov.ar/ws/services/LoginCms"
PADRON_URL    = "https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA13"

def crear_tra(servicio: str) -> str:
    """Crea el Ticket de Requerimiento de Acceso"""
    ahora = datetime.datetime.now(datetime.timezone.utc)
    desde = (ahora - datetime.timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    hasta = (ahora + datetime.timedelta(hours=12)).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    unique_id = str(uuid.uuid4().int)[:10]
    
    tra = f"""<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>{unique_id}</uniqueId>
    <generationTime>{desde}</generationTime>
    <expirationTime>{hasta}</expirationTime>
  </header>
  <service>{servicio}</service>
</loginTicketRequest>"""
    return tra

def firmar_tra(tra: str) -> str:
    """Firma el TRA con el certificado y clave privada"""
    # Leer certificado y clave
    with open(CERT_PATH, "rb") as f:
        cert = x509.load_pem_x509_certificate(f.read(), default_backend())
    with open(KEY_PATH, "rb") as f:
        key = serialization.load_pem_private_key(f.read(), password=None, backend=default_backend())
    
    tra_bytes = tra.encode("utf-8")
    
    # Firmar con PKCS7
    signed = (
        pkcs7.PKCS7SignatureBuilder()
        .set_data(tra_bytes)
        .add_signer(cert, key, hashes.SHA256())
        .sign(serialization.Encoding.DER, [pkcs7.PKCS7Options.DetachedSignature])
    )
    
    return base64.b64encode(signed).decode("utf-8")

def obtener_token(servicio: str = "ws_sr_padron_a13") -> dict:
    """Obtiene o renueva el token de ARCA"""
    global _token_cache
    
    ahora = datetime.datetime.now(datetime.timezone.utc)
    if (_token_cache["token"] and _token_cache["expira"] and 
        ahora < _token_cache["expira"]):
        return _token_cache
    
    tra = crear_tra(servicio)
    cms = firmar_tra(tra)
    
    # Llamar al WSAA
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
    
    headers = {
        "Content-Type": "text/xml; charset=UTF-8",
        "SOAPAction": ""
    }
    
    r = requests.post(WSAA_URL_PROD, data=soap_body.encode("utf-8"), 
                      headers=headers, timeout=30)
    
    if r.status_code != 200:
        raise Exception(f"WSAA error {r.status_code}: {r.text[:200]}")
    
    # Parsear respuesta
    root = etree.fromstring(r.content)
    ns = {"soap": "http://schemas.xmlsoap.org/soap/envelope/"}
    
    # Extraer el loginTicketResponse
    resultado = root.find(".//{http://wsaa.view.sua.dvadac.desein.afip.gov}loginCmsReturn")
    if resultado is None:
        raise Exception("No se encontró loginCmsReturn en la respuesta")
    
    ticket = etree.fromstring(resultado.text)
    token = ticket.find(".//token").text
    sign  = ticket.find(".//sign").text
    expira_str = ticket.find(".//expirationTime").text
    
    expira = datetime.datetime.fromisoformat(expira_str.replace("+00:00", "+00:00"))
    
    _token_cache = {"token": token, "sign": sign, "expira": expira}
    return _token_cache


def consultar_padron_a13(cuit: str) -> dict:
    """Consulta el Padrón A13 de ARCA con certificado"""
    auth = obtener_token("ws_sr_padron_a13")
    
    soap_body = f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:a13="http://a13.soap.wsServicioConsultaPersona.afip.gov.ar/">
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

    headers = {
        "Content-Type": "text/xml; charset=UTF-8",
        "SOAPAction": ""
    }
    
    r = requests.post(PADRON_URL, data=soap_body.encode("utf-8"),
                      headers=headers, timeout=30)
    
    if r.status_code != 200:
        raise Exception(f"Padrón A13 error {r.status_code}: {r.text[:300]}")
    
    root = etree.fromstring(r.content)
    
    # Extraer datos
    persona = root.find(".//{http://a13.soap.wsServicioConsultaPersona.afip.gov.ar/}persona")
    if persona is None:
        raise Exception("CUIT no encontrado en padrón A13")
    
    def get(tag):
        el = persona.find(f".//{tag}")
        return el.text if el is not None else ""
    
    return {
        "cuit":     cuit,
        "nombre":   get("nombre"),
        "apellido": get("apellido") or get("razonSocial"),
        "estado":   get("estadoClave"),
        "tipo":     get("tipoClave"),
    }


# ══════════════════════════════════════════════════
# ENDPOINTS
# ══════════════════════════════════════════════════

@app.get("/padron/{cuit}")
async def consultar_padron(cuit: str):
    cuit_limpio = re.sub(r'\D', '', cuit)
    if len(cuit_limpio) != 11:
        raise HTTPException(400, "CUIT inválido — debe tener 11 dígitos")
    try:
        return consultar_padron_a13(cuit_limpio)
    except Exception as e:
        raise HTTPException(404, f"No encontrado: {str(e)}")


@app.get("/clientes")
async def listar_clientes():
    result = db.from_("clientes").select("*").order("apellido").execute()
    return result.data

@app.post("/clientes")
async def crear_cliente(data: dict):
    cuit = re.sub(r'\D', '', data.get("cuit", ""))
    apellido = data.get("apellido", "").lower()
    apellido_slug = re.sub(r'[^a-z0-9]', '', apellido.replace(" ", "-"))
    slug = f"{apellido_slug}-{cuit}"
    
    cliente = {
        "slug":      slug,
        "nombre":    data.get("nombre"),
        "apellido":  data.get("apellido"),
        "cuit":      cuit,
        "whatsapp":  data.get("whatsapp", ""),
        "email":     data.get("email", ""),
        "categoria": (data.get("categoria") or "").upper() or None,
        "cuota":     data.get("cuota") or None,
        "activo":    True,
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
        "cliente_id": cliente.data["id"],
        "anio":       data["anio"],
        "mes":        data["mes"],
        "monto":      data["monto"],
        "fuente":     "manual",
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
    promedio = total_fac / meses_cargados
    pct = min(total_fac / tope, 1.05) if tope > 0 else 0
    
    return {
        "cliente":     cliente,
        "tope":        tope,
        "facturacion": facturacion,
        "total_fac":   total_fac,
        "promedio":    promedio,
        "pct":         pct,
        "planes":      planes_res.data or [],
        "documentos":  docs_res.data or [],
        "alertas":     alertas_res.data or [],
    }

@app.get("/")
async def health():
    cert_ok = Path(CERT_PATH).exists() if CERT_PATH else False
    key_ok  = Path(KEY_PATH).exists()  if KEY_PATH  else False
    return {
        "status":   "ok",
        "servicio": "Axenda Contable API",
        "version":  "1.1.0",
        "cert_ok":  cert_ok,
        "key_ok":   key_ok,
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
