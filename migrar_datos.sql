-- ═══════════════════════════════════════════════════════════════════
-- AXENDA CONTABLE — Paso 2: Migrar datos existentes al estudio
--
-- Prerequisito: haber corrido crear_tablas.sql Y haberte registrado
-- en el admin (https://axendacontable-jao.github.io/axenda-backend/)
-- y confirmado el email. El trigger habrá creado tu fila en estudios.
--
-- Qué hace: asigna todos los clientes, planes, facturas, etc. que
-- todavía no tienen estudio_id al único estudio que existe en la tabla.
-- ═══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  eid UUID;
BEGIN
  SELECT id INTO eid FROM estudios LIMIT 1;

  IF eid IS NULL THEN
    RAISE EXCEPTION
      'No se encontró ningún estudio. '
      'Registrate en el admin y confirmá tu email antes de correr este script.';
  END IF;

  UPDATE clientes      SET estudio_id = eid WHERE estudio_id IS NULL;
  UPDATE planes_pago   SET estudio_id = eid WHERE estudio_id IS NULL;
  UPDATE deuda_manual  SET estudio_id = eid WHERE estudio_id IS NULL;
  UPDATE alertas       SET estudio_id = eid WHERE estudio_id IS NULL;
  UPDATE facturacion   SET estudio_id = eid WHERE estudio_id IS NULL;
  UPDATE documentos    SET estudio_id = eid WHERE estudio_id IS NULL;
  UPDATE configuracion SET estudio_id = eid WHERE estudio_id IS NULL;

  RAISE NOTICE 'Migración completada. Estudio: %', eid;
END $$;

-- Verificación: estas consultas deben devolver 0
-- SELECT COUNT(*) FROM clientes      WHERE estudio_id IS NULL;
-- SELECT COUNT(*) FROM planes_pago   WHERE estudio_id IS NULL;
-- SELECT COUNT(*) FROM facturacion   WHERE estudio_id IS NULL;
