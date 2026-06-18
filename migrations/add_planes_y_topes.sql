-- ============================================================
-- Migración: columnas nuevas para planes_pago y topes_categoria
-- Ejecutar en: Supabase > SQL Editor
-- ============================================================

-- planes_pago: columnas nuevas
ALTER TABLE planes_pago ADD COLUMN IF NOT EXISTS numero_plan       TEXT;
ALTER TABLE planes_pago ADD COLUMN IF NOT EXISTS organismo         TEXT DEFAULT 'ARCA';
ALTER TABLE planes_pago ADD COLUMN IF NOT EXISTS fecha_consolidacion DATE;
ALTER TABLE planes_pago ADD COLUMN IF NOT EXISTS total_cuotas      INTEGER;
ALTER TABLE planes_pago ADD COLUMN IF NOT EXISTS cuotas_pagas      INTEGER DEFAULT 0;
ALTER TABLE planes_pago ADD COLUMN IF NOT EXISTS cuotas_impagas    INTEGER;
ALTER TABLE planes_pago ADD COLUMN IF NOT EXISTS monto_primer_venc NUMERIC;
ALTER TABLE planes_pago ADD COLUMN IF NOT EXISTS monto_segundo_venc NUMERIC;
ALTER TABLE planes_pago ADD COLUMN IF NOT EXISTS url_pdf           TEXT;
ALTER TABLE planes_pago ADD COLUMN IF NOT EXISTS proximo_venc      DATE;

-- topes_categoria: columnas nuevas
ALTER TABLE topes_categoria ADD COLUMN IF NOT EXISTS cuota_servicios NUMERIC;
ALTER TABLE topes_categoria ADD COLUMN IF NOT EXISTS cuota_bienes    NUMERIC;
ALTER TABLE topes_categoria ADD COLUMN IF NOT EXISTS vigente_desde   DATE;
