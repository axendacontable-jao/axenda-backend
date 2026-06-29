-- ═══════════════════════════════════════════════════════════════════
-- AXENDA CONTABLE — Migración multi-tenant
-- Ejecutar en Supabase → SQL Editor (de arriba hacia abajo, una sola vez)
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

-- Cada usuario solo ve y edita su propio estudio
CREATE POLICY "estudio_owner" ON estudios
  FOR ALL USING (owner_id = auth.uid());

-- ────────────────────────────────────────────────────────────────────
-- 2. Agregar estudio_id a todas las tablas de negocio
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE clientes      ADD COLUMN IF NOT EXISTS estudio_id UUID REFERENCES estudios(id) ON DELETE CASCADE;
ALTER TABLE planes_pago   ADD COLUMN IF NOT EXISTS estudio_id UUID REFERENCES estudios(id) ON DELETE CASCADE;
ALTER TABLE deuda_manual  ADD COLUMN IF NOT EXISTS estudio_id UUID REFERENCES estudios(id) ON DELETE CASCADE;
ALTER TABLE alertas       ADD COLUMN IF NOT EXISTS estudio_id UUID REFERENCES estudios(id) ON DELETE CASCADE;
ALTER TABLE facturacion   ADD COLUMN IF NOT EXISTS estudio_id UUID REFERENCES estudios(id) ON DELETE CASCADE;
ALTER TABLE documentos    ADD COLUMN IF NOT EXISTS estudio_id UUID REFERENCES estudios(id) ON DELETE CASCADE;
ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS estudio_id UUID REFERENCES estudios(id) ON DELETE CASCADE;

-- ────────────────────────────────────────────────────────────────────
-- 3. Trigger: crear estudio automáticamente al confirmar email
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
-- 4. Helper function: devuelve el estudio_id del usuario actual
--    (usado por las políticas RLS)
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mi_estudio_id()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id FROM estudios
  WHERE owner_id = auth.uid() AND estado = 'activa'
  LIMIT 1;
$$;

-- ────────────────────────────────────────────────────────────────────
-- 5. RLS en cada tabla de negocio
--    Doble condición: estudio correcto AND estado activa
-- ────────────────────────────────────────────────────────────────────

-- clientes
ALTER TABLE clientes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "clientes_estudio" ON clientes;
CREATE POLICY "clientes_estudio" ON clientes
  FOR ALL USING (estudio_id = mi_estudio_id());

-- facturacion (accedida directo desde el browser con la anon key)
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

-- planes_pago
ALTER TABLE planes_pago ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "planes_estudio" ON planes_pago;
CREATE POLICY "planes_estudio" ON planes_pago
  FOR ALL USING (estudio_id = mi_estudio_id());

-- planes_pago_cuotas: derivada del plan, acceso a través de plan_id
ALTER TABLE planes_pago_cuotas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cuotas_plan_estudio" ON planes_pago_cuotas;
CREATE POLICY "cuotas_plan_estudio" ON planes_pago_cuotas
  FOR ALL USING (
    plan_id IN (SELECT id FROM planes_pago WHERE estudio_id = mi_estudio_id())
  );

-- historial_cuotas
ALTER TABLE historial_cuotas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "historial_estudio" ON historial_cuotas;
CREATE POLICY "historial_estudio" ON historial_cuotas
  FOR ALL USING (
    cliente_id IN (SELECT id FROM clientes WHERE estudio_id = mi_estudio_id())
  );

-- deuda_manual
ALTER TABLE deuda_manual ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "deuda_manual_estudio" ON deuda_manual;
CREATE POLICY "deuda_manual_estudio" ON deuda_manual
  FOR ALL USING (estudio_id = mi_estudio_id());

-- alertas
ALTER TABLE alertas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "alertas_estudio" ON alertas;
CREATE POLICY "alertas_estudio" ON alertas
  FOR ALL USING (estudio_id = mi_estudio_id());

-- documentos
ALTER TABLE documentos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "documentos_estudio" ON documentos;
CREATE POLICY "documentos_estudio" ON documentos
  FOR ALL USING (estudio_id = mi_estudio_id());

-- configuracion
ALTER TABLE configuracion ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "config_estudio" ON configuracion;
CREATE POLICY "config_estudio" ON configuracion
  FOR ALL USING (estudio_id = mi_estudio_id() OR estudio_id IS NULL);

-- ────────────────────────────────────────────────────────────────────
-- 6. MIGRACIÓN DE DATOS EXISTENTES
--
--    Prerequisito: registrarte y confirmar tu email en el admin.
--    El trigger handle_new_user() ya habrá creado tu fila en estudios.
--    Este bloque la detecta automáticamente.
-- ────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  eid UUID;
BEGIN
  SELECT id INTO eid FROM estudios LIMIT 1;

  IF eid IS NULL THEN
    RAISE EXCEPTION 'No se encontró ningún estudio. Registrate en el admin y confirmá tu email antes de ejecutar esta sección.';
  END IF;

  UPDATE clientes      SET estudio_id = eid WHERE estudio_id IS NULL;
  UPDATE planes_pago   SET estudio_id = eid WHERE estudio_id IS NULL;
  UPDATE deuda_manual  SET estudio_id = eid WHERE estudio_id IS NULL;
  UPDATE alertas       SET estudio_id = eid WHERE estudio_id IS NULL;
  UPDATE facturacion   SET estudio_id = eid WHERE estudio_id IS NULL;
  UPDATE documentos    SET estudio_id = eid WHERE estudio_id IS NULL;
  UPDATE configuracion SET estudio_id = eid WHERE estudio_id IS NULL;

  RAISE NOTICE 'Migración completada para estudio %', eid;
END $$;

-- ────────────────────────────────────────────────────────────────────
-- 7. Verificación: corré esto para confirmar que el aislamiento funciona
-- ────────────────────────────────────────────────────────────────────
-- SELECT COUNT(*) FROM clientes WHERE estudio_id IS NULL;  -- debe ser 0
-- SELECT * FROM estudios;  -- debe tener tu fila
