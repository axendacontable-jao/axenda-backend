-- Inscripción de contribuyentes nuevos desde el portal (2026-11-25).
-- Un contribuyente se registra solo, carga su clave fiscal y queda como cliente del estudio en
-- "solo lectura": el robot usa la clave únicamente para consultar ARCA (nunca emite facturas).
-- Todo lo usa el backend con service role: las tablas nuevas tienen RLS sin políticas.

-- El estudio decide si recibe inscripciones (Configuración → Datos del estudio).
alter table public.estudios add column if not exists alta_portal_habilitada boolean not null default false;

-- Clientes: restricción de solo lectura y marca de "se inscribió solo".
alter table public.clientes add column if not exists solo_lectura boolean not null default false;
alter table public.clientes add column if not exists autoregistro_at timestamptz;

-- Contraseña del portal con hash (scrypt) para las cuentas creadas por inscripción. Va en una tabla
-- aparte porque "clientes" todavía se puede leer con la clave publicable (ver cerrar_acceso_directo_rls.sql).
create table if not exists public.portal_accesos (
  cliente_id uuid primary key references public.clientes(id) on delete cascade,
  password_hash text not null,
  actualizada_at timestamptz not null default now()
);
alter table public.portal_accesos enable row level security;

-- Constancia del consentimiento para guardar y usar la clave fiscal (texto aceptado, versión y fecha).
create table if not exists public.altas_portal (
  cliente_id uuid primary key references public.clientes(id) on delete cascade,
  estudio_id uuid not null references public.estudios(id) on delete cascade,
  created_at timestamptz not null default now(),
  consentimiento jsonb not null,
  ip_hash text
);
alter table public.altas_portal enable row level security;

-- Límites anti-abuso del alta pública (huella HMAC de la IP, nunca la IP). Se purgan a los 30 días.
create table if not exists public.portal_intentos (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  tipo text not null check (tipo in ('verificar', 'alta', 'clave')),
  ip_hash text not null,
  cuit text,
  estudio_id uuid references public.estudios(id) on delete cascade,
  ok boolean not null default false
);
create index if not exists portal_intentos_ip on public.portal_intentos (tipo, ip_hash, created_at);
create index if not exists portal_intentos_cuit on public.portal_intentos (tipo, cuit, created_at);
create index if not exists portal_intentos_estudio on public.portal_intentos (tipo, estudio_id, created_at);
alter table public.portal_intentos enable row level security;

revoke all on public.portal_accesos, public.altas_portal, public.portal_intentos from anon, authenticated;
