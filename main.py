import os
import re
import json
import datetime
from pathlib import Path
from dotenv import load_dotenv

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from supabase import create_client
import requests
from zeep import Client as ZeepClient
from zeep.transports import Transport
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend
from cryptography import x509

load_dotenv()

app = FastAPI(title="Axenda Contable API")

# CORS — permite que el portal y la webapp accedan al backend
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

# Certificado ARCA
CERT_PATH = os.getenv("CERT_PATH")
KEY_PATH  = os.getenv("KEY_PATH")
CUIT_CONTADOR = os.getenv("CUIT_CONTADOR")

MESES = ["","Enero","Febrero","Marzo","Abril","Mayo","Junio",
         "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"]

# ══════════════════════════════════════════════════
# PADRÓN PÚBLICO (sin certificado)
# ══════════════════════════════════════════════════

@app.get("/padron/{cuit}")
async def consultar_padron(cuit: str):
    """Consulta el padrón público de ARCA por CUIT"""
    cuit_limpio = re.sub(r'\D', '', cuit)
    if len(cuit_limpio) != 11:
        raise HTTPException(400, "CUIT inválido")
    
    try:
        url = f"https://soa.afip.gob.ar/sr-padron/v2/persona/{cuit_limpio}"
        headers = {"Accept": "application/json"}
        r = requests.get(url, headers=headers, timeout=10)
        
        if r.status_code == 404:
            raise HTTPException(404, "CUIT no encontrado en ARCA")
        
        data = r.json().get("data", {})
        return {
            "cuit":     cuit_limpio,
            "nombre":   data.get("nombre", ""),
            "apellido": data.get("apellido", data.get("razonSocial", "")),
            "estado":   data.get("estadoClave", ""),
            "tipo":     data.get("tipoClave", ""),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Error consultando ARCA: {str(e)}")


# ══════════════════════════════════════════════════
# CLIENTES
# ══════════════════════════════════════════════════

@app.get("/clientes")
async def listar_clientes():
    """Lista todos los clientes con su facturación"""
    result = db.from_("clientes").select("*").order("apellido").execute()
    return result.data

@app.post("/clientes")
async def crear_cliente(data: dict):
    """Crea un cliente nuevo"""
    cuit = re.sub(r'\D', '', data.get("cuit", ""))
    apellido = data.get("apellido", "").lower()
    apellido = re.sub(r'[^a-z0-9]', '', apellido.replace(" ", "-"))
    slug = f"{apellido}-{cuit}"
    
    cliente = {
        "slug":       slug,
        "nombre":     data.get("nombre"),
        "apellido":   data.get("apellido"),
        "cuit":       cuit,
        "whatsapp":   data.get("whatsapp", ""),
        "email":      data.get("email", ""),
        "categoria":  data.get("categoria", "").upper() or None,
        "cuota":      data.get("cuota") or None,
        "activo":     True,
    }
    
    result = db.from_("clientes").insert(cliente).execute()
    return {"ok": True, "slug": slug, "data": result.data}

@app.patch("/clientes/{slug}/toggle")
async def toggle_activo(slug: str):
    """Activa o desactiva un cliente"""
    cliente = db.from_("clientes").select("activo").eq("slug", slug).single().execute()
    nuevo_estado = not cliente.data["activo"]
    db.from_("clientes").update({"activo": nuevo_estado}).eq("slug", slug).execute()
    return {"ok": True, "activo": nuevo_estado}


# ══════════════════════════════════════════════════
# FACTURACIÓN
# ══════════════════════════════════════════════════

@app.get("/facturacion/{slug}")
async def obtener_facturacion(slug: str):
    """Obtiene la facturación de un cliente"""
    cliente = db.from_("clientes").select("id").eq("slug", slug).single().execute()
    if not cliente.data:
        raise HTTPException(404, "Cliente no encontrado")
    
    result = db.from_("facturacion")\
        .select("*")\
        .eq("cliente_id", cliente.data["id"])\
        .order("anio").order("mes")\
        .execute()
    return result.data

@app.post("/facturacion/{slug}")
async def cargar_facturacion(slug: str, data: dict):
    """Carga un mes de facturación manual"""
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
    
    result = db.from_("facturacion").upsert(
        registro,
        on_conflict="cliente_id,anio,mes"
    ).execute()
    return {"ok": True, "data": result.data}


# ══════════════════════════════════════════════════
# PORTAL — datos completos de un cliente
# ══════════════════════════════════════════════════

@app.get("/portal/{slug}")
async def datos_portal(slug: str):
    """Endpoint principal del portal del cliente"""
    # Cliente
    cliente_res = db.from_("clientes").select("*").eq("slug", slug).eq("activo", True).execute()
    if not cliente_res.data:
        raise HTTPException(404, "Cliente no encontrado o inactivo")
    cliente = cliente_res.data[0]
    
    # Tope de categoría
    tope_res = db.from_("topes_categoria").select("*").eq("categoria", cliente.get("categoria", "")).execute()
    tope = tope_res.data[0]["tope_anual"] if tope_res.data else 0
    
    # Facturación
    fac_res = db.from_("facturacion")\
        .select("*")\
        .eq("cliente_id", cliente["id"])\
        .order("anio").order("mes")\
        .execute()
    facturacion = fac_res.data or []
    
    # Planes de pago
    planes_res = db.from_("planes_pago")\
        .select("*")\
        .eq("cliente_id", cliente["id"])\
        .eq("estado", "activo")\
        .execute()
    
    # Documentos
    docs_res = db.from_("documentos")\
        .select("*")\
        .eq("cliente_id", cliente["id"])\
        .order("created_at", desc=True)\
        .execute()
    
    # Alertas manuales
    alertas_res = db.from_("alertas")\
        .select("*")\
        .eq("cliente_id", cliente["id"])\
        .eq("leida", False)\
        .order("created_at", desc=True)\
        .execute()
    
    # Cálculos
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


# ══════════════════════════════════════════════════
# SYNC CON ARCA (requiere certificado)
# ══════════════════════════════════════════════════

@app.post("/sync/{slug}")
async def sync_cliente_arca(slug: str):
    """
    Sincroniza los datos de un cliente desde ARCA.
    Requiere que el cliente haya delegado los servicios.
    """
    cliente_res = db.from_("clientes").select("*").eq("slug", slug).single().execute()
    if not cliente_res.data:
        raise HTTPException(404, "Cliente no encontrado")
    
    cliente = cliente_res.data
    cuit = cliente["cuit"]
    
    resultados = {"cuit": cuit, "sincronizado": []}
    
    # 1. Categoría y cuota desde Monotributo (cuando esté disponible)
    # TODO: implementar con ws_sr_padron_a13 cuando tengamos token ARCA
    
    # 2. Facturación del mes actual desde comprobantes
    # TODO: implementar con wsfe cuando tengamos token ARCA
    
    return {
        "ok": True,
        "mensaje": "Sync con ARCA pendiente — certificado registrado, implementación en progreso",
        "resultados": resultados
    }


@app.get("/")
async def health():
    return {
        "status": "ok",
        "servicio": "Axenda Contable API",
        "version": "1.0.0",
        "cert_ok": Path(CERT_PATH).exists() if CERT_PATH else False,
        "key_ok":  Path(KEY_PATH).exists() if KEY_PATH else False,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
