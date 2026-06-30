-- ═══════════════════════════════════════════════════════════════════
-- AXENDA CONTABLE — Paso 1: Estructura multi-tenant
-- Correr en Supabase → SQL Editor UNA SOLA VEZ, antes de registrarte.
-- No toca datos existentes.
-- ═══════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────
-- 1. TABLA estudios
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS estudios (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id            UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  nombre              TEXT NOT NULL DEFAULT 'Mi Estudio',
  estado              TEXT NOT NULL DEFAULT 'activa'
                        CHECK (estado IN ('activa','suspendida','cancelada')),
  onboarding_completo BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE estudios ENABLE ROW LEVEL SECURITY;

CREATE POLICY "estudio_owner" ON estudios
  FOR ALL USING (owner_id = auth.uid());

-- ────────────────────────────────────────────────────────────────────
-- 2. Columna estudio_id en todas las tablas de negocio
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE clientes      ADD COLUMN IF NOT EXISTS estudio_id UUID REFERENCES estudios(id) ON DELETE CASCADE;
ALTER TABLE planes_pago   ADD COLUMN IF NOT EXISTS estudio_id UUID REFERENCES estudios(id) ON DELETE CASCADE;
ALTER TABLE deuda_manual  ADD COLUMN IF NOT EXISTS estudio_id UUID REFERENCES estudios(id) ON DELETE CASCADE;
ALTER TABLE alertas       ADD COLUMN IF NOT EXISTS estudio_id UUID REFERENCES estudios(id) ON DELETE CASCADE;
ALTER TABLE facturacion   ADD COLUMN IF NOT EXISTS estudio_id UUID REFERENCES estudios(id) ON DELETE CASCADE;
ALTER TABLE documentos    ADD COLUMN IF NOT EXISTS estudio_id UUID REFERENCES estudios(id) ON DELETE CASCADE;
ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS estudio_id UUID REFERENCES estudios(id) ON DELETE CASCADE;

-- ────────────────────────────────────────────────────────────────────
-- 3. Trigger: crea fila en estudios al registrar un usuario nuevo
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.estudios (owner_id, nombre)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'nombre_estudio', 'Mi Estudio')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ────────────────────────────────────────────────────────────────────
-- 4. Helper RLS: devuelve el estudio_id del usuario autenticado
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mi_estudio_id()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id FROM estudios
  WHERE owner_id = auth.uid() AND estado = 'activa'
  LIMIT 1;
$$;

-- ────────────────────────────────────────────────────────────────────
-- 5. RLS en cada tabla de negocio
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE clientes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "clientes_estudio" ON clientes;
CREATE POLICY "clientes_estudio" ON clientes
  FOR ALL USING (estudio_id = mi_estudio_id());

ALTER TABLE facturacion ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "facturacion_estudio" ON facturacion;
CREATE POLICY "facturacion_estudio" ON facturacion
  FOR ALL USING (
    estudio_id = mi_estudio_id()
    OR cliente_id IN (SELECT id FROM clientes WHERE estudio_id = mi_estudio_id())
  );

-- topes_categoria: datos globales ARCA, lectura pública
ALTER TABLE topes_categoria ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "topes_leer" ON topes_categoria;
CREATE POLICY "topes_leer" ON topes_categoria FOR SELECT USING (true);
DROP POLICY IF EXISTS "topes_escribir" ON topes_categoria;
CREATE POLICY "topes_escribir" ON topes_categoria
  FOR ALL USING (auth.role() = 'authenticated');

ALTER TABLE planes_pago ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "planes_estudio" ON planes_pago;
CREATE POLICY "planes_estudio" ON planes_pago
  FOR ALL USING (estudio_id = mi_estudio_id());

ALTER TABLE planes_pago_cuotas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cuotas_plan_estudio" ON planes_pago_cuotas;
CREATE POLICY "cuotas_plan_estudio" ON planes_pago_cuotas
  FOR ALL USING (
    plan_id IN (SELECT id FROM planes_pago WHERE estudio_id = mi_estudio_id())
  );

ALTER TABLE historial_cuotas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "historial_estudio" ON historial_cuotas;
CREATE POLICY "historial_estudio" ON historial_cuotas
  FOR ALL USING (
    cliente_id IN (SELECT id FROM clientes WHERE estudio_id = mi_estudio_id())
  );

ALTER TABLE deuda_manual ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "deuda_manual_estudio" ON deuda_manual;
CREATE POLICY "deuda_manual_estudio" ON deuda_manual
  FOR ALL USING (estudio_id = mi_estudio_id());

ALTER TABLE alertas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "alertas_estudio" ON alertas;
CREATE POLICY "alertas_estudio" ON alertas
  FOR ALL USING (estudio_id = mi_estudio_id());

ALTER TABLE documentos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "documentos_estudio" ON documentos;
CREATE POLICY "documentos_estudio" ON documentos
  FOR ALL USING (estudio_id = mi_estudio_id());

ALTER TABLE configuracion ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "config_estudio" ON configuracion;
CREATE POLICY "config_estudio" ON configuracion
  FOR ALL USING (estudio_id = mi_estudio_id() OR estudio_id IS NULL);

-- ────────────────────────────────────────────────────────────────────
-- Verificación rápida (opcional, podés correr esto al final)
-- ────────────────────────────────────────────────────────────────────
-- SELECT table_name, column_name FROM information_schema.columns
--   WHERE column_name = 'estudio_id' ORDER BY table_name;
