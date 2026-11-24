import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import {
  computeApplicationMergePatch,
  findMatchingApplicationInDb,
  normalizeGoogleFormsRows,
} from '../../src/lib/castingCsvNormalizer';
import type { CastingApplication } from '../../src/types';

function timingSafeSecretEquals(provided: string, expected: string): boolean {
  const digestA = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const digestB = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

function extractWebhookSecretFromRequest(req: any): string {
  const headerSecret = req?.headers?.['x-webhook-secret'];
  if (typeof headerSecret === 'string' && headerSecret.trim()) {
    return headerSecret.trim();
  }
  const authHeader = req?.headers?.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }
  return '';
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expectedSecret = (process.env.GOOGLE_FORM_WEBHOOK_SECRET || '').trim();
  if (!expectedSecret) {
    return res.status(503).json({
      error: 'Falta configurar GOOGLE_FORM_WEBHOOK_SECRET en Variables de Entorno del servidor.',
    });
  }

  const providedSecret = extractWebhookSecretFromRequest(req);
  if (!providedSecret || !timingSafeSecretEquals(providedSecret, expectedSecret)) {
    return res.status(401).json({ error: 'No autorizado: secreto de webhook inválido.' });
  }

  const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(503).json({
      error: 'Falta configurar SUPABASE_SERVICE_ROLE_KEY o VITE_SUPABASE_URL en el servidor.',
    });
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const body = req.body || {};
  const rawRowsInput = Array.isArray(body.rows)
    ? body.rows
    : Array.isArray(body.row)
    ? [body.row]
    : null;

  if (!rawRowsInput || rawRowsInput.length === 0) {
    return res.status(400).json({ error: "Debes enviar 'rows' (arreglo de filas) o 'row'." });
  }
  if (rawRowsInput.length > 250) {
    return res.status(400).json({ error: 'Máximo 250 filas por solicitud.' });
  }

  const sanitizedRows: string[][] = rawRowsInput.map((r: unknown) =>
    Array.isArray(r) ? r.slice(0, 40).map((cell) => String(cell ?? '').slice(0, 2000)) : []
  );

  const normalized = normalizeGoogleFormsRows(sanitizedRows);

  try {
    const existingApps: CastingApplication[] = [];
    const pageSize = 1000;
    let offset = 0;

    while (true) {
      const { data: pageData, error: fetchError } = await supabaseAdmin
        .from('casting_applications')
        .select(
          'id, nombre, apellidos, fecha_nacimiento, edad, ciudad, whatsapp, correo, instagram, estatura, busto, cintura, caderas, talla_superior, talla_inferior, calzado, color_cabello, largo_cabello, color_ojos, tono_piel, tiene_piercings, tiene_tatuajes, detalle_piercings_tatuajes, foto_cara, foto_cuerpo, origen, talento, genero, formacion_artistica, nivel_ensenanza, nombre_artistico, estado_cabello, tiktok, notas_importacion, datos_incompletos, campos_faltantes, estado'
        )
        .order('id', { ascending: true })
        .range(offset, offset + pageSize - 1);

      if (fetchError) {
        return res.status(502).json({ error: 'No se pudo consultar casting_applications en Supabase.' });
      }

      const rowsPage = (pageData || []) as CastingApplication[];
      existingApps.push(...rowsPage);
      if (rowsPage.length < pageSize) break;
      offset += pageSize;
    }

    let inserted = 0;
    let mergedUpdated = 0;
    let skippedDuplicates = 0;

    for (const candidate of normalized.validRecords) {
      const match = findMatchingApplicationInDb(candidate, existingApps);
      if (!match) {
        const { data: insertedRow, error: insertError } = await supabaseAdmin
          .from('casting_applications')
          .insert(candidate)
          .select('*')
          .single();

        if (insertError) {
          return res.status(502).json({
            error: `Error insertando registro en Supabase: ${insertError.message}`,
          });
        }
        if (insertedRow) {
          existingApps.push(insertedRow as CastingApplication);
        }
        inserted++;
      } else {
        const patch = computeApplicationMergePatch(match, candidate);
        if (patch) {
          const { error: updateError } = await supabaseAdmin
            .from('casting_applications')
            .update(patch)
            .eq('id', match.id);

          if (updateError) {
            return res.status(502).json({
              error: `Error actualizando duplicado en Supabase: ${updateError.message}`,
            });
          }
          Object.assign(match, patch);
          mergedUpdated++;
        } else {
          skippedDuplicates++;
        }
      }
    }

    return res.status(200).json({
      ok: true,
      receivedRows: sanitizedRows.length,
      inserted,
      mergedUpdated,
      skippedDuplicates,
      includedModels: normalized.summary.includedModels,
      includedDancers: normalized.summary.includedDancers,
      excludedDancers: normalized.summary.excludedDancers,
      emptyOrJunkRows: normalized.summary.emptyOrJunkRows,
      discardedUnder17OrConflict: normalized.summary.discardedUnder17OrConflict,
      repairedBirthYears: normalized.summary.repairedBirthYears,
      discardedDetails: normalized.discardedRecords.slice(0, 20).map((d) => ({
        filaOriginal: d.filaOriginal,
        motivo: d.motivo,
      })),
    });
  } catch {
    return res.status(500).json({ error: 'Error interno procesando el webhook de Google Form.' });
  }
}
