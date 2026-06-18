-- ============================================================
-- Migración: tabla configuracion
-- Ejecutar en: Supabase > SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS configuracion (
    id         UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
    clave      TEXT    UNIQUE NOT NULL,
    valor      TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE configuracion ENABLE ROW LEVEL SECURITY;

CREATE POLICY lectura_configuracion ON configuracion
    FOR SELECT USING (true);

CREATE POLICY escritura_configuracion ON configuracion
    FOR ALL USING (true);
