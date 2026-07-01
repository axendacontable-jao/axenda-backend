import os, re, datetime, base64, uuid, random, subprocess, tempfile
from pathlib import Path
from dotenv import load_dotenv
from lxml import etree
from fastapi import FastAPI, HTTPException, UploadFile, Depends, Request
import pandas as pd
import io
from fastapi.middleware.cors import CORSMiddleware
from supabase import create_client
from jose import jwt, JWTError, jwk as jose_jwk
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
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type", "Accept", "X-Requested-With"],
)

SUPABASE_URL        = os.getenv("SUPABASE_URL")
SUPABASE_KEY        = os.getenv("SUPABASE_KEY")
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")
db = create_client(SUPABASE_URL, SUPABASE_KEY)

CUIT_CONTADOR = os.getenv("CUIT_CONTADOR", "20395847946")

# ── Auth ─────────────────────────────────────────────────────────────────────
# Supabase usa JWT con firma asimétrica ES256 (ECC P-256).
# Cacheamos las claves públicas del endpoint JWKS en memoria.

_jwks_cache: list = []

def _get_jwks() -> list:
    global _jwks_cache
    if not _jwks_cache:
        url = f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json"
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        _jwks_cache = resp.json().get("keys", [])
    return _jwks_cache

def _verify_supabase_token(token: str) -> dict:
    header = jwt.get_unverified_header(token)
    alg = header.get("alg", "ES256")

    if alg == "HS256":
        # Fallback legacy: secret compartido
        return jwt.decode(token, SUPABASE_JWT_SECRET, algorithms=["HS256"],
                          options={"verify_aud": False})

    # ES256 u otro algoritmo asimétrico: verificar con clave pública JWKS
    kid = header.get("kid")
    keys = _get_jwks()
    key_data = next((k for k in keys if k.get("kid") == kid), None) if kid else None
    if key_data is None:
        key_data = keys[0] if keys else None
    if key_data is None:
        raise JWTError("No se encontró clave pública en JWKS")
    public_key = jose_jwk.construct(key_data)
    return jwt.decode(token, public_key, algorithms=[alg],
                      options={"verify_aud": False})

async def get_estudio_id(request: Request) -> str:
    """Verifica JWT de Supabase Auth y devuelve el estudio_id del usuario."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "Autenticación requerida")
    token = auth[7:]
    try:
        payload = _verify_supabase_token(token)
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(401, "Token sin subject")
    except JWTError as e:
        raise HTTPException(401, f"Token inválido: {e}")
    res = db.from_("estudios").select("id,estado").eq("owner_id", user_id).limit(1).execute()
    rows = res.data or []
    if not rows:
        # El trigger handle_new_user no creó el estudio — lo inicializamos aquí como fallback
        ins = db.from_("estudios").insert({
            "owner_id": user_id,
            "nombre": "Mi Estudio",
            "estado": "activa",
        }).execute()
        if not ins.data:
            raise HTTPException(403, "No se pudo inicializar el estudio")
        return ins.data[0]["id"]
    estudio = rows[0]
    if estudio["estado"] != "activa":
        raise HTTPException(403, f"Estudio {estudio['estado']}")
    return estudio["id"]

# Componente ART Río Negro por categoría (vigente desde 01/02/2026)
ART_RIO_NEGRO = {
    "A": 17773.24, "B": 26330.15, "C": 35038.48,
    "D": 52992.43, "E": 70657.51, "F": 88097.78,
    "G": 105032.36, "H": 170242.95, "I": 197256.01,
    "J": 231453.81, "K": 261120.28,
}

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
        "status": "ok", "version": "1.5.0",
        "cert_ok": cert_ok, "key_ok": key_ok,
        "cert_lines": cert_lines, "openssl_ok": openssl_ok,
        "cuit_contador": CUIT_CONTADOR,
        "servicios_cacheados": list(_token_cache.keys()),
    }

@app.get("/estudios/me")
async def estudios_me(estudio_id: str = Depends(get_estudio_id)):
    res = db.from_("estudios").select("*").eq("id", estudio_id).single().execute()
    return res.data or {}

@app.patch("/estudios/me")
async def actualizar_estudio(data: dict, estudio_id: str = Depends(get_estudio_id)):
    campos = {"nombre", "onboarding_completo"}
    update = {k: v for k, v in data.items() if k in campos}
    if not update:
        raise HTTPException(400, "Sin campos válidos")
    db.from_("estudios").update(update).eq("id", estudio_id).execute()
    return {"ok": True}

@app.patch("/estudios/onboarding")
async def completar_onboarding(data: dict, estudio_id: str = Depends(get_estudio_id)):
    try:
        nombre = data.get("nombre", "Mi Estudio")
        configs = {"nombre_estudio": nombre}
        if data.get("provincia_principal"):
            configs["provincia_principal"] = data["provincia_principal"]
        if data.get("whatsapp"):
            configs["whatsapp_estudio"] = data["whatsapp"]
        if data.get("email_contacto"):
            configs["email_estudio"] = data["email_contacto"]
        for clave, valor in configs.items():
            try:
                upd = db.from_("configuracion").update({"valor": valor}).eq("clave", clave).eq("estudio_id", estudio_id).execute()
                if not upd.data:
                    db.from_("configuracion").insert({"clave": clave, "valor": valor, "estudio_id": estudio_id}).execute()
            except Exception as e_cfg:
                print(f"[onboarding] cfg {clave} error: {e_cfg}")
        try:
            db.from_("estudios").update({"nombre": nombre, "onboarding_completo": True}).eq("id", estudio_id).execute()
        except Exception:
            db.from_("estudios").update({"nombre": nombre}).eq("id", estudio_id).execute()
        return {"ok": True}
    except Exception as e:
        print(f"[onboarding] error inesperado: {e}")
        return {"ok": False, "error": str(e)}

@app.get("/componentes-provinciales/resumen")
async def get_componentes_resumen(estudio_id: str = Depends(get_estudio_id)):
    res = db.from_("componentes_provinciales").select("*") \
        .lte("vigente_desde", datetime.date.today().isoformat()) \
        .order("vigente_desde", desc=True).execute()
    seen = {}
    for r in (res.data or []):
        key = (r["provincia"], r["categoria"], r["tipo"])
        if key not in seen:
            seen[key] = r
    return {"ok": True, "componentes": list(seen.values())}


@app.get("/componentes-provinciales/{provincia}/{categoria}")
async def get_componente_provincial(provincia: str, categoria: str, tipo: str = "servicios"):
    def _q(t):
        return db.from_("componentes_provinciales").select("*") \
            .eq("provincia", provincia).eq("categoria", categoria.upper()).eq("tipo", t) \
            .lte("vigente_desde", datetime.date.today().isoformat()) \
            .order("vigente_desde", desc=True).limit(1).execute()
    res = _q(tipo)
    if not res.data and tipo != "unico":
        res = _q("unico")
    return {"ok": True, "componente": res.data[0] if res.data else None}

# Migración one-time: asigna todos los registros huérfanos al estudio del usuario
@app.post("/estudios/migrar-datos")
async def migrar_datos(estudio_id: str = Depends(get_estudio_id)):
    tablas = ["clientes", "planes_pago", "deuda_manual", "alertas",
              "facturacion", "documentos", "configuracion"]
    totales = {}
    for tabla in tablas:
        try:
            res = db.from_(tabla).update({"estudio_id": estudio_id}).is_("estudio_id", "null").execute()
            totales[tabla] = len(res.data or [])
        except Exception as e:
            totales[tabla] = f"error: {e}"
    return {"ok": True, "migrados": totales}

@app.get("/constancia/{cuit}")
async def obtener_constancia(cuit: str):
    cuit_limpio = re.sub(r'\D', '', cuit)
    if len(cuit_limpio) != 11:
        raise HTTPException(400, "CUIT inválido")
    try:
        datos = buscar_en_constancia(cuit_limpio)
        cuit_fmt = f"{cuit_limpio[:2]}-{cuit_limpio[2:-1]}-{cuit_limpio[-1]}"
        return {
            "ok": True,
            "cuit": cuit_limpio,
            "cuit_fmt": cuit_fmt,
            "nombre": datos.get("nombre", ""),
            "apellido": datos.get("apellido", ""),
            "categoria": datos.get("categoria", ""),
            "estado": datos.get("estado", "ACTIVO"),
            "fecha_consulta": datetime.date.today().isoformat(),
        }
    except Exception as e:
        raise HTTPException(503, f"ARCA no responde: {str(e)}")

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
async def listar_clientes(estudio_id: str = Depends(get_estudio_id)):
    result = db.from_("clientes").select("*").eq("estudio_id", estudio_id).order("apellido").execute()
    return result.data

@app.post("/clientes")
async def crear_cliente(data: dict, estudio_id: str = Depends(get_estudio_id)):
    cuit = re.sub(r'\D', '', data.get("cuit", ""))
    apellido_slug = re.sub(r'[^a-z0-9]', '', data.get("apellido", "").lower().replace(" ", "-"))
    slug = f"{apellido_slug}-{cuit}"
    cliente = {
        "slug": slug, "nombre": data.get("nombre"), "apellido": data.get("apellido"),
        "cuit": cuit, "whatsapp": data.get("whatsapp", ""), "email": data.get("email", ""),
        "categoria": (data.get("categoria") or "").upper() or None,
        "cuota": data.get("cuota") or None, "activo": True,
        "provincia": data.get("provincia", "Rio Negro"),
        "iibb_modalidad": data.get("iibb_modalidad", "monotributo_unificado"),
        "tipo_actividad": data.get("tipo_actividad", "servicios"),
        "en_relacion_dependencia": bool(data.get("en_relacion_dependencia", False)),
        "estudio_id": estudio_id,
    }
    try:
        result = db.from_("clientes").insert(cliente).execute()
    except Exception as e:
        raise HTTPException(500, f"Error al guardar cliente: {str(e)}")
    cliente_id = result.data[0]["id"] if result.data else None
    log_actividad(cliente_id, f"Alta de cliente — {data.get('nombre','')} {data.get('apellido','')}", estudio_id)
    return {"ok": True, "slug": slug, "data": result.data}

@app.patch("/clientes/{slug}/toggle")
async def toggle_activo(slug: str, estudio_id: str = Depends(get_estudio_id)):
    try:
        cliente = db.from_("clientes").select("activo").eq("slug", slug).eq("estudio_id", estudio_id).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    if not cliente.data:
        raise HTTPException(404, "Cliente no encontrado")
    nuevo = not cliente.data["activo"]
    db.from_("clientes").update({"activo": nuevo}).eq("slug", slug).eq("estudio_id", estudio_id).execute()
    return {"ok": True, "activo": nuevo}

def log_actividad(cliente_id, mensaje: str, estudio_id: str = None):
    try:
        row = {"cliente_id": cliente_id, "tipo": "actividad", "mensaje": mensaje, "leida": True}
        if estudio_id:
            row["estudio_id"] = estudio_id
        db.from_("alertas").insert(row).execute()
    except Exception:
        pass

@app.patch("/clientes/{slug}/estado-pago")
async def actualizar_estado_pago(slug: str, data: dict, estudio_id: str = Depends(get_estudio_id)):
    nuevo = data.get("estado_pago")
    if nuevo not in ("al_dia", "debe", "vencida"):
        raise HTTPException(400, "Estado inválido: debe ser al_dia, debe o vencida")
    try:
        res = db.from_("clientes").select("id,nombre,apellido").eq("slug", slug).eq("estudio_id", estudio_id).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    if not res.data:
        raise HTTPException(404, "Cliente no encontrado")
    db.from_("clientes").update({"estado_pago": nuevo}).eq("slug", slug).eq("estudio_id", estudio_id).execute()
    if nuevo == "al_dia":
        nombre = f"{res.data.get('nombre','')} {res.data.get('apellido','')}".strip()
        log_actividad(res.data["id"], f"Cuota marcada al día — {nombre}", estudio_id)
    return {"ok": True, "estado_pago": nuevo}

@app.patch("/clientes/{slug}/cuota")
async def actualizar_cuota(slug: str, data: dict, estudio_id: str = Depends(get_estudio_id)):
    nueva_cuota = data.get("cuota")
    if nueva_cuota is None or not isinstance(nueva_cuota, (int, float)) or nueva_cuota < 0:
        raise HTTPException(400, "Cuota inválida")
    try:
        res = db.from_("clientes").select("id").eq("slug", slug).eq("estudio_id", estudio_id).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    if not res.data:
        raise HTTPException(404, "Cliente no encontrado")
    db.from_("clientes").update({"cuota": nueva_cuota}).eq("slug", slug).eq("estudio_id", estudio_id).execute()
    return {"ok": True, "cuota": nueva_cuota}

@app.patch("/clientes/{slug}/datos")
async def actualizar_datos_cliente(slug: str, data: dict, estudio_id: str = Depends(get_estudio_id)):
    campos_permitidos = {"provincia", "iibb_modalidad", "en_relacion_dependencia", "tipo_actividad", "cuota"}
    update = {k: v for k, v in data.items() if k in campos_permitidos}
    if not update:
        raise HTTPException(400, "Sin campos válidos")
    try:
        res = db.from_("clientes").select("id").eq("slug", slug).eq("estudio_id", estudio_id).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    if not res.data:
        raise HTTPException(404, "Cliente no encontrado")
    db.from_("clientes").update(update).eq("slug", slug).eq("estudio_id", estudio_id).execute()
    return {"ok": True}


@app.get("/clientes/{slug}/historial-cuotas")
async def get_historial_cuotas(slug: str, meses: int = 6, estudio_id: str = Depends(get_estudio_id)):
    try:
        cl = db.from_("clientes").select("id").eq("slug", slug).eq("estudio_id", estudio_id).single().execute()
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


@app.patch("/clientes/{slug}/historial-cuotas/{anio}/{mes}")
async def toggle_historial_cuota(slug: str, anio: int, mes: int, data: dict, estudio_id: str = Depends(get_estudio_id)):
    cl_res = db.from_("clientes").select("id").eq("slug", slug).eq("estudio_id", estudio_id).limit(1).execute()
    if not cl_res.data:
        raise HTTPException(404, "Cliente no encontrado")
    cliente_id = cl_res.data[0]["id"]
    pagado = data.get("pagado", True)
    fecha_pago = datetime.datetime.utcnow().isoformat() + "Z" if pagado else None
    try:
        upd = db.from_("historial_cuotas").update({
            "pagado": pagado,
            "fecha_pago": fecha_pago,
        }).eq("cliente_id", cliente_id).eq("año", anio).eq("mes", mes).execute()
        if not upd.data:
            db.from_("historial_cuotas").insert({
                "cliente_id": cliente_id,
                "año": anio,
                "mes": mes,
                "pagado": pagado,
                "fecha_pago": fecha_pago,
            }).execute()
    except Exception as e:
        raise HTTPException(500, str(e))
    return {"ok": True, "pagado": pagado}


@app.get("/clientes/{slug}/deuda-manual")
async def get_deuda_manual(slug: str, estudio_id: str = Depends(get_estudio_id)):
    try:
        cl = db.from_("clientes").select("id").eq("slug", slug).eq("estudio_id", estudio_id).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    res = db.from_("deuda_manual").select("*").eq("cliente_id", cl.data["id"]).eq("estudio_id", estudio_id).eq("pagado", False).order("created_at").execute()
    return {"ok": True, "deudas": res.data or []}

@app.post("/clientes/{slug}/deuda-manual")
async def agregar_deuda_manual(slug: str, data: dict, estudio_id: str = Depends(get_estudio_id)):
    organismo = data.get("organismo")
    monto = data.get("monto")
    descripcion = data.get("descripcion", "")
    if organismo not in ("ARCA", "ART"):
        raise HTTPException(400, "Organismo inválido: debe ser ARCA o ART")
    if not monto or float(monto) <= 0:
        raise HTTPException(400, "Monto inválido")
    try:
        cl = db.from_("clientes").select("id").eq("slug", slug).eq("estudio_id", estudio_id).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    res = db.from_("deuda_manual").insert({
        "cliente_id": cl.data["id"],
        "organismo": organismo,
        "monto": float(monto),
        "descripcion": descripcion,
        "pagado": False,
        "estudio_id": estudio_id,
    }).execute()
    return {"ok": True, "deuda": res.data[0] if res.data else None}

@app.patch("/deuda-manual/{deuda_id}/pagar")
async def pagar_deuda_manual(deuda_id: str, estudio_id: str = Depends(get_estudio_id)):
    db.from_("deuda_manual").update({
        "pagado": True,
        "fecha_pago": datetime.datetime.utcnow().isoformat() + "Z",
    }).eq("id", deuda_id).eq("estudio_id", estudio_id).execute()
    return {"ok": True}

@app.delete("/deuda-manual/{deuda_id}")
async def eliminar_deuda_manual(deuda_id: str, estudio_id: str = Depends(get_estudio_id)):
    db.from_("deuda_manual").delete().eq("id", deuda_id).eq("estudio_id", estudio_id).execute()
    return {"ok": True}


@app.get("/facturacion/{slug}")
async def obtener_facturacion(slug: str, estudio_id: str = Depends(get_estudio_id)):
    try:
        cliente = db.from_("clientes").select("id").eq("slug", slug).eq("estudio_id", estudio_id).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    if not cliente.data:
        raise HTTPException(404, "Cliente no encontrado")
    result = db.from_("facturacion").select("*").eq("cliente_id", cliente.data["id"]).order("anio").order("mes").execute()
    return result.data

@app.post("/facturacion/{slug}")
async def cargar_facturacion(slug: str, data: dict, estudio_id: str = Depends(get_estudio_id)):
    try:
        cliente = db.from_("clientes").select("id").eq("slug", slug).eq("estudio_id", estudio_id).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    if not cliente.data:
        raise HTTPException(404, "Cliente no encontrado")
    registro = {
        "cliente_id": cliente.data["id"], "anio": data["anio"],
        "mes": data["mes"], "monto": data["monto"], "fuente": "manual",
        "estudio_id": estudio_id,
    }
    result = db.from_("facturacion").upsert(registro, on_conflict="cliente_id,anio,mes").execute()
    return {"ok": True, "data": result.data}

@app.patch("/portal/{slug}/marcar-pago")
async def portal_marcar_pago(slug: str):
    """Endpoint sin auth de admin para que el cliente marque su cuota como pagada."""
    cliente_res = db.from_("clientes").select("id,nombre,apellido").eq("slug", slug).execute()
    if not cliente_res.data:
        raise HTTPException(404, "Cliente no encontrado")
    cliente = cliente_res.data[0]
    hoy = datetime.date.today()
    fecha_pago = datetime.datetime.utcnow().isoformat() + "Z"
    try:
        upd = db.from_("historial_cuotas").update({
            "pagado": True,
            "fecha_pago": fecha_pago,
        }).eq("cliente_id", cliente["id"]).eq("año", hoy.year).eq("mes", hoy.month).execute()
        if not upd.data:
            db.from_("historial_cuotas").insert({
                "cliente_id": cliente["id"],
                "año": hoy.year,
                "mes": hoy.month,
                "pagado": True,
                "fecha_pago": fecha_pago,
            }).execute()
    except Exception as e:
        raise HTTPException(500, str(e))
    nombre = f"{cliente.get('nombre','')} {cliente.get('apellido','')}".strip()
    log_actividad(cliente["id"], f"Cuota {hoy.month}/{hoy.year} marcada al día desde el portal — {nombre}", cliente.get("estudio_id"))
    return {"ok": True, "estado_cuota": "al_dia"}

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
        estudio_id_portal = cliente.get("estudio_id")
        nov_res = db.from_("novedades").select("*").eq("activa", True).eq("estudio_id", estudio_id_portal).order("created_at", desc=True).execute()
        novedades = [n for n in (nov_res.data or [])
                     if n.get("para_todos") or str(n.get("cliente_id")) == str(cliente["id"])]
    except Exception:
        novedades = []
    try:
        estudio_id_cliente = cliente.get("estudio_id", "")
        cfg_res = db.from_("configuracion").select("clave,valor").in_("clave", ["whatsapp"]).eq("estudio_id", estudio_id_cliente).execute()
        cfg = {r["clave"]: r["valor"] for r in (cfg_res.data or [])}
    except Exception:
        cfg = {}
    try:
        hoy = datetime.date.today()
        cat = (cliente.get("categoria") or "").upper()
        cuota_mensual = cliente.get("cuota") or 0
        art_por_mes = ART_RIO_NEGRO.get(cat, 0)

        # Historial cuotas: últimos 6 meses
        # Los meses SIN registro en historial_cuotas también se consideran no pagados
        # (idéntica lógica al panel de administrador)
        hist_res = db.from_("historial_cuotas").select("*").eq("cliente_id", cliente["id"]).execute()
        historial = hist_res.data or []
        pagados_db = {(h["año"], h["mes"]) for h in historial if h.get("pagado")}
        meses_6 = []
        for i in range(6):
            m = hoy.month - i
            y = hoy.year
            while m <= 0:
                m += 12
                y -= 1
            meses_6.append((y, m))
        vencidos_count = 0
        sin_vencer_count = 0
        for (y, m) in meses_6:
            if (y, m) in pagados_db:
                continue  # mes pagado, no cuenta
            es_mes_actual = (y == hoy.year and m == hoy.month)
            if not es_mes_actual or hoy.day > 20:
                vencidos_count += 1
            else:
                sin_vencer_count += 1
        deuda_art_hist  = vencidos_count * art_por_mes
        deuda_arca_hist = vencidos_count * (cuota_mensual - art_por_mes) + sin_vencer_count * cuota_mensual

        # Deuda manual — neq(True) captura tanto False como NULL
        deuda_res = db.from_("deuda_manual").select("*").eq("cliente_id", cliente["id"]).neq("pagado", True).execute()
        deudas_man = deuda_res.data or []
        deuda_art_man  = sum(d.get("monto", 0) or 0 for d in deudas_man if d.get("organismo") == "ART")
        deuda_arca_man = sum(d.get("monto", 0) or 0 for d in deudas_man if d.get("organismo") == "ARCA")
        deuda_otro_man = sum(d.get("monto", 0) or 0 for d in deudas_man
                             if d.get("organismo") not in ("ART", "ARCA"))

        deuda_art   = deuda_art_hist + deuda_art_man
        deuda_arca  = deuda_arca_hist + deuda_arca_man
        deuda_total = deuda_art + deuda_arca + deuda_otro_man
        partes = []
        if deuda_art > 0:   partes.append(f"ART Río Negro: ${deuda_art:,.0f}".replace(",", "."))
        if deuda_arca > 0:  partes.append(f"ARCA: ${deuda_arca:,.0f}".replace(",", "."))
        if deuda_otro_man > 0: partes.append(f"Otros: ${deuda_otro_man:,.0f}".replace(",", "."))
        deuda_desc = " · ".join(partes) if partes else None
    except Exception:
        deuda_total, deuda_desc, deuda_art, deuda_arca = 0, None, 0, 0

    # Estado de cuota del mes actual basado en historial_cuotas (no en campo manual)
    try:
        mes_actual_pagado = (hoy.year, hoy.month) in pagados_db
        if mes_actual_pagado:
            estado_cuota = "al_dia"
        elif hoy.day > 20:
            estado_cuota = "vencida"
        else:
            estado_cuota = "pendiente"
    except Exception:
        estado_cuota = "pendiente"

    facturacion = fac_res.data or []
    hoy_d = datetime.date.today()
    hace_12m = (hoy_d.year - 1, hoy_d.month)
    montos_12 = [f["monto"] for f in facturacion if f.get("monto", 0) > 0 and (f["anio"], f["mes"]) >= hace_12m]
    total_fac = sum(montos_12)
    meses_cargados = len(montos_12) or 1
    pct = min(total_fac / tope, 1.05) if tope > 0 else 0
    return {
        "cliente": cliente, "tope": tope, "facturacion": facturacion,
        "total_fac": total_fac, "promedio": total_fac / meses_cargados,
        "pct": pct, "planes": planes_res.data or [],
        "documentos": docs_res.data or [], "alertas": alertas_res.data or [],
        "novedades": novedades, "whatsapp": cfg.get("whatsapp"),
        "deuda_total": deuda_total, "deuda_desc": deuda_desc,
        "deuda_art": deuda_art, "deuda_arca": deuda_arca,
        "estado_cuota": estado_cuota,
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
async def importar_comprobantes(slug: str, file: UploadFile, estudio_id: str = Depends(get_estudio_id)):
    try:
        cliente = db.from_("clientes").select("id").eq("slug", slug).eq("estudio_id", estudio_id).single().execute()
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
        r["estudio_id"] = estudio_id
        db.from_("facturacion").upsert(r, on_conflict="cliente_id,anio,mes").execute()
    if registros:
        log_actividad(cliente_id, f"Importación ARCA — {slug} — {len(registros)} meses", estudio_id)
    return {"ok": True, "meses_importados": len(registros), "detalle": registros}

# ─── Planes de pago ──────────────────────────────────────────────────────────

@app.get("/planes")
async def listar_todos_planes(estudio_id: str = Depends(get_estudio_id)):
    result = db.from_("planes_pago").select("*").eq("estudio_id", estudio_id).eq("estado", "activo").order("proximo_venc").execute()
    return result.data or []

@app.get("/planes/{slug}")
async def planes_cliente(slug: str, estudio_id: str = Depends(get_estudio_id)):
    try:
        cliente = db.from_("clientes").select("id").eq("slug", slug).eq("estudio_id", estudio_id).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    if not cliente.data:
        raise HTTPException(404, "Cliente no encontrado")
    result = db.from_("planes_pago").select("*").eq("cliente_id", cliente.data["id"]).eq("estudio_id", estudio_id).order("created_at", desc=True).execute()
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
async def crear_plan(slug: str, data: dict, estudio_id: str = Depends(get_estudio_id)):
    try:
        cliente = db.from_("clientes").select("id").eq("slug", slug).eq("estudio_id", estudio_id).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    if not cliente.data:
        raise HTTPException(404, "Cliente no encontrado")
    total = data.get("total_cuotas")
    pagas = data.get("cuotas_pagas", 0)
    impagas = (int(total) - int(pagas)) if total is not None else data.get("cuotas_impagas")
    plan = {
        "cliente_id": cliente.data["id"],
        "estudio_id": estudio_id,
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
async def marcar_cuota_pagada(plan_id: str, estudio_id: str = Depends(get_estudio_id)):
    try:
        res = db.from_("planes_pago").select("*").eq("id", plan_id).eq("estudio_id", estudio_id).single().execute()
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
async def cambiar_estado_plan(plan_id: str, data: dict, estudio_id: str = Depends(get_estudio_id)):
    estado = data.get("estado")
    if estado not in ("activo", "cancelado", "caido", "inactivo"):
        raise HTTPException(400, "Estado inválido")
    try:
        db.from_("planes_pago").update({"estado": estado}).eq("id", plan_id).eq("estudio_id", estudio_id).execute()
    except Exception as e:
        raise HTTPException(500, f"Error al actualizar estado: {str(e)}")
    return {"ok": True, "estado": estado}

@app.delete("/planes/{plan_id}")
async def eliminar_plan(plan_id: str, estudio_id: str = Depends(get_estudio_id)):
    db.from_("planes_pago").update({"estado": "inactivo"}).eq("id", plan_id).eq("estudio_id", estudio_id).execute()
    return {"ok": True}

# ─── Cuotas individuales de plan ──────────────────────────────────────────────

@app.get("/planes/{plan_id}/cuotas")
async def get_cuotas_plan(plan_id: str, estudio_id: str = Depends(get_estudio_id)):
    # Verifica ownership del plan antes de devolver cuotas
    plan_ok = db.from_("planes_pago").select("id").eq("id", plan_id).eq("estudio_id", estudio_id).execute()
    if not plan_ok.data:
        raise HTTPException(404, "Plan no encontrado")
    try:
        res = db.from_("planes_pago_cuotas").select("*").eq("plan_id", plan_id).order("numero_cuota").execute()
    except Exception as e:
        raise HTTPException(500, str(e))
    return {"ok": True, "cuotas": res.data or []}


@app.post("/planes/{plan_id}/cuotas/inicializar")
async def inicializar_cuotas(plan_id: str, estudio_id: str = Depends(get_estudio_id)):
    import calendar as cal_mod
    try:
        res = db.from_("planes_pago").select("*").eq("id", plan_id).eq("estudio_id", estudio_id).single().execute()
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
async def pagar_cuota_individual(plan_id: str, numero_cuota: int, data: dict, estudio_id: str = Depends(get_estudio_id)):
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
async def actualizar_tope(categoria: str, data: dict, _: str = Depends(get_estudio_id)):
    campos = {"tope_anual", "cuota_servicios", "cuota_bienes", "vigente_desde"}
    update = {k: v for k, v in data.items() if k in campos}
    if not update:
        raise HTTPException(400, "Sin campos válidos")
    db.from_("topes_categoria").update(update).eq("categoria", categoria.upper()).execute()
    return {"ok": True}

@app.post("/topes/importar")
async def importar_topes(file: UploadFile, _: str = Depends(get_estudio_id)):
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

@app.post("/configuracion/importar-tabla/{tipo}")
async def importar_tabla(tipo: str, file: UploadFile, _: str = Depends(get_estudio_id)):
    TIPOS_VALIDOS = {"topes_nacionales", "componente_rio_negro", "componente_neuquen", "componente_buenos_aires"}
    if tipo not in TIPOS_VALIDOS:
        raise HTTPException(400, f"Tipo inválido: {tipo}")
    PROV_MAP = {
        "componente_rio_negro":      "Rio Negro",
        "componente_neuquen":        "Neuquen",
        "componente_buenos_aires":   "Buenos Aires",
    }
    nombre = (file.filename or "").lower()
    contenido = await file.read()
    CATS = set("ABCDEFGHIJK")

    def parse_num(v):
        if v is None: return None
        try:
            return float(str(v).replace(".", "").replace(",", ".").strip())
        except Exception:
            return None

    def detect_col(headers, *keywords):
        for kw in keywords:
            for j, h in enumerate(headers):
                if kw in h.lower():
                    return j
        return None

    if tipo == "topes_nacionales":
        resultados = []
        if nombre.endswith(".pdf"):
            try:
                import pdfplumber
            except ImportError:
                raise HTTPException(500, "pdfplumber no instalado")
            with pdfplumber.open(io.BytesIO(contenido)) as pdf:
                for page in pdf.pages:
                    for table in (page.extract_tables() or []):
                        if not table or len(table) < 2: continue
                        for i, row in enumerate(table):
                            if not row: continue
                            row_l = [str(c or "").lower() for c in row]
                            if any("categor" in c for c in row_l):
                                hdr = row_l
                                col_cat  = detect_col(hdr, "categor")
                                col_tope = detect_col(hdr, "ingreso", "tope")
                                col_is   = detect_col(hdr, "locacion", "servicio")
                                col_ib   = detect_col(hdr, "mueble", "bien")
                                col_sipa = detect_col(hdr, "sipa", "previsional", "jubil")
                                col_os   = detect_col(hdr, "obra social", "salud", "os")
                                for row2 in table[i + 1:]:
                                    if not row2 or len(row2) <= (col_cat or 0): continue
                                    cat = str(row2[col_cat] or "").strip().upper().split("\n")[0].strip()
                                    if len(cat) != 1 or cat not in CATS: continue
                                    g = lambda c: parse_num(row2[c]) if c is not None and len(row2) > c else None
                                    resultados.append({"categoria": cat, "tope_anual": g(col_tope),
                                        "imp_integrado_servicios": g(col_is), "imp_integrado_bienes": g(col_ib),
                                        "aportes_sipa": g(col_sipa), "obra_social": g(col_os)})
                                break
        elif nombre.endswith((".xlsx", ".xls")):
            df = pd.read_excel(io.BytesIO(contenido))
            df.columns = [str(c).strip() for c in df.columns]
            hdr = [c.lower() for c in df.columns]
            col_cat  = next((c for c in df.columns if "categor" in c.lower()), None)
            col_tope = next((c for c in df.columns if any(k in c.lower() for k in ["ingreso","tope"])), None)
            col_is   = next((c for c in df.columns if any(k in c.lower() for k in ["locacion","servicio"])), None)
            col_ib   = next((c for c in df.columns if any(k in c.lower() for k in ["mueble","bien"])), None)
            col_sipa = next((c for c in df.columns if any(k in c.lower() for k in ["sipa","previsional","jubil"])), None)
            col_os   = next((c for c in df.columns if any(k in c.lower() for k in ["obra","salud"])), None)
            if col_cat is None:
                raise HTTPException(400, "No se encontró columna de categorías A-K")
            for _, row in df.iterrows():
                cat = str(row[col_cat]).strip().upper()
                if len(cat) != 1 or cat not in CATS: continue
                g = lambda c: float(pd.to_numeric(row.get(c), errors="coerce")) if c and not pd.isna(pd.to_numeric(row.get(c), errors="coerce")) else None
                resultados.append({"categoria": cat, "tope_anual": g(col_tope),
                    "imp_integrado_servicios": g(col_is), "imp_integrado_bienes": g(col_ib),
                    "aportes_sipa": g(col_sipa), "obra_social": g(col_os)})
        else:
            raise HTTPException(400, "Formato no soportado. Subí PDF o Excel (.xlsx)")

        if not resultados:
            raise HTTPException(400, "No se encontraron categorías A-K en el archivo")
        seen: dict = {}
        for r in resultados:
            if r["categoria"] not in seen: seen[r["categoria"]] = r
        actualizados = 0
        for cat, r in seen.items():
            update = {k: r[k] for k in ("tope_anual","imp_integrado_servicios","imp_integrado_bienes","aportes_sipa","obra_social") if r.get(k) is not None}
            if update:
                db.from_("topes_categoria").update(update).eq("categoria", cat).execute()
                actualizados += 1
        return {"ok": True, "tipo": tipo, "actualizados": actualizados, "categorias": list(seen.keys())}

    else:
        provincia = PROV_MAP[tipo]
        resultados = []
        if nombre.endswith(".pdf"):
            try:
                import pdfplumber
            except ImportError:
                raise HTTPException(500, "pdfplumber no instalado")
            with pdfplumber.open(io.BytesIO(contenido)) as pdf:
                for page in pdf.pages:
                    for table in (page.extract_tables() or []):
                        if not table or len(table) < 2: continue
                        for i, row in enumerate(table):
                            if not row: continue
                            row_l = [str(c or "").lower() for c in row]
                            if any("categor" in c for c in row_l):
                                hdr = row_l
                                col_cat   = detect_col(hdr, "categor")
                                col_tipo  = detect_col(hdr, "tipo", "actividad")
                                col_monto = detect_col(hdr, "monto", "cuota", "import")
                                col_desde = detect_col(hdr, "desde", "vigente", "fecha")
                                for row2 in table[i + 1:]:
                                    if not row2 or len(row2) <= (col_cat or 0): continue
                                    cat = str(row2[col_cat] or "").strip().upper().split("\n")[0].strip()
                                    if len(cat) != 1 or cat not in CATS: continue
                                    g = lambda c: str(row2[c]).strip() if c is not None and len(row2) > c else None
                                    tipo_val = (g(col_tipo) or "servicios").lower()
                                    if "bien" in tipo_val or "mueble" in tipo_val: tipo_val = "bienes"
                                    elif "unico" in tipo_val or "único" in tipo_val: tipo_val = "unico"
                                    else: tipo_val = "servicios"
                                    monto = parse_num(g(col_monto))
                                    desde = g(col_desde) or datetime.date.today().isoformat()
                                    if monto: resultados.append({"categoria": cat, "tipo": tipo_val, "monto": monto, "vigente_desde": desde[:10]})
                                break
        elif nombre.endswith((".xlsx", ".xls")):
            df = pd.read_excel(io.BytesIO(contenido))
            df.columns = [str(c).strip() for c in df.columns]
            col_cat   = next((c for c in df.columns if "categor" in c.lower()), None)
            col_tipo  = next((c for c in df.columns if any(k in c.lower() for k in ["tipo","actividad"])), None)
            col_monto = next((c for c in df.columns if any(k in c.lower() for k in ["monto","cuota","import"])), None)
            col_desde = next((c for c in df.columns if any(k in c.lower() for k in ["desde","vigente","fecha"])), None)
            if col_cat is None:
                raise HTTPException(400, "No se encontró columna de categorías A-K")
            for _, row in df.iterrows():
                cat = str(row[col_cat]).strip().upper()
                if len(cat) != 1 or cat not in CATS: continue
                tipo_val = str(row.get(col_tipo) or "servicios").lower()
                if "bien" in tipo_val or "mueble" in tipo_val: tipo_val = "bienes"
                elif "unico" in tipo_val or "único" in tipo_val: tipo_val = "unico"
                else: tipo_val = "servicios"
                monto = float(pd.to_numeric(row.get(col_monto), errors="coerce")) if col_monto else None
                if pd.isna(monto if monto else float("nan")): monto = None
                desde_raw = row.get(col_desde) if col_desde else None
                if pd.notna(desde_raw if desde_raw is not None else float("nan")):
                    try: desde = str(pd.Timestamp(desde_raw).date())
                    except Exception: desde = datetime.date.today().isoformat()
                else: desde = datetime.date.today().isoformat()
                if monto: resultados.append({"categoria": cat, "tipo": tipo_val, "monto": monto, "vigente_desde": desde})
        else:
            raise HTTPException(400, "Formato no soportado. Subí PDF o Excel (.xlsx)")

        if not resultados:
            raise HTTPException(400, "No se encontraron datos de componentes en el archivo")
        importados = 0
        for r in resultados:
            upd = db.from_("componentes_provinciales").update({"monto": r["monto"], "vigente_desde": r["vigente_desde"]}) \
                .eq("provincia", provincia).eq("categoria", r["categoria"]).eq("tipo", r["tipo"]).execute()
            if not upd.data:
                db.from_("componentes_provinciales").insert({
                    "provincia": provincia, "categoria": r["categoria"],
                    "tipo": r["tipo"], "monto": r["monto"], "vigente_desde": r["vigente_desde"],
                }).execute()
            importados += 1
        return {"ok": True, "tipo": tipo, "provincia": provincia, "importados": importados, "detalle": resultados}

# ─── Configuración ───────────────────────────────────────────────────────────

@app.get("/configuracion")
async def obtener_configuracion(estudio_id: str = Depends(get_estudio_id)):
    result = db.from_("configuracion").select("clave,valor").eq("estudio_id", estudio_id).execute()
    return {r["clave"]: r["valor"] for r in (result.data or [])}

@app.post("/configuracion")
async def guardar_configuracion(data: dict, estudio_id: str = Depends(get_estudio_id)):
    for clave, valor in data.items():
        val = str(valor) if valor is not None else ""
        upd = db.from_("configuracion").update({"valor": val}).eq("clave", clave).eq("estudio_id", estudio_id).execute()
        if not upd.data:
            db.from_("configuracion").insert({"clave": clave, "valor": val, "estudio_id": estudio_id}).execute()
    return {"ok": True}

# ─── Alertas ─────────────────────────────────────────────────────────────────

@app.get("/alertas/{slug}")
async def alertas_cliente(slug: str, estudio_id: str = Depends(get_estudio_id)):
    try:
        cliente = db.from_("clientes").select("id").eq("slug", slug).eq("estudio_id", estudio_id).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    if not cliente.data:
        raise HTTPException(404, "Cliente no encontrado")
    result = db.from_("alertas").select("*").eq("cliente_id", cliente.data["id"]).eq("estudio_id", estudio_id).order("created_at", desc=True).execute()
    return result.data or []

@app.post("/alertas/{slug}")
async def crear_alerta(slug: str, data: dict, estudio_id: str = Depends(get_estudio_id)):
    try:
        cliente = db.from_("clientes").select("id").eq("slug", slug).eq("estudio_id", estudio_id).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    if not cliente.data:
        raise HTTPException(404, "Cliente no encontrado")
    alerta = {
        "cliente_id": cliente.data["id"],
        "tipo":    data.get("tipo", "manual"),
        "mensaje": data.get("mensaje", ""),
        "leida":   False,
        "estudio_id": estudio_id,
    }
    try:
        result = db.from_("alertas").insert(alerta).execute()
    except Exception as e:
        raise HTTPException(500, f"Error al crear alerta: {str(e)}")
    return {"ok": True, "data": result.data}

@app.delete("/alertas/{alerta_id}")
async def eliminar_alerta(alerta_id: str, estudio_id: str = Depends(get_estudio_id)):
    db.from_("alertas").delete().eq("id", alerta_id).eq("estudio_id", estudio_id).execute()
    return {"ok": True}

# ─── Documentos ──────────────────────────────────────────────────────────────

@app.post("/documentos/{slug}")
async def crear_documento(slug: str, data: dict, estudio_id: str = Depends(get_estudio_id)):
    try:
        cliente = db.from_("clientes").select("id").eq("slug", slug).eq("estudio_id", estudio_id).single().execute()
    except Exception:
        raise HTTPException(404, "Cliente no encontrado")
    if not cliente.data:
        raise HTTPException(404, "Cliente no encontrado")
    doc = {
        "cliente_id": cliente.data["id"],
        "nombre":     data.get("nombre"),
        "tipo":       data.get("tipo"),
        "fecha":      data.get("fecha"),
        "url":        data.get("url"),
        "estudio_id": estudio_id,
    }
    try:
        result = db.from_("documentos").insert({k: v for k, v in doc.items() if v is not None}).execute()
    except Exception as e:
        raise HTTPException(500, f"Error al guardar documento: {str(e)}")
    return {"ok": True, "data": result.data}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8080)))



































