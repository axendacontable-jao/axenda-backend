-- ═══════════════════════════════════════════════════════════════════
-- AXENDA CONTABLE — Fix aislamiento multi-tenant: tabla novedades
-- Correr en Supabase → SQL Editor UNA SOLA VEZ.
-- La tabla debe estar vacía antes de correr esto (o ya tiene estudio_id).
-- ═══════════════════════════════════════════════════════════════════

-- 1. Agregar columna estudio_id
ALTER TABLE novedades
  ADD COLUMN IF NOT EXISTS estudio_id UUID REFERENCES estudios(id) ON DELETE CASCADE;

-- 2. Habilitar RLS y crear policy
ALTER TABLE novedades ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "novedades_estudio" ON novedades;
CREATE POLICY "novedades_estudio" ON novedades
  FOR ALL USING (estudio_id = mi_estudio_id());

-- 3. Verificación
-- SELECT COUNT(*) FROM novedades WHERE estudio_id IS NULL;  -- debe dar 0
