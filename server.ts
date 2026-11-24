import "dotenv/config";
import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { CASTING_ONLY_PREVIEW_MODE } from "./src/lib/castingConfig";
import {
  computeApplicationMergePatch,
  findMatchingApplicationInDb,
  normalizeGoogleFormsRows,
} from "./src/lib/castingCsvNormalizer";
import type { CastingApplication } from "./src/types";

const CASTING_PHOTOS_DIR = path.resolve(process.cwd(), "storage", "casting-photos");
const CASTING_PHOTOS_INDEX = path.resolve(CASTING_PHOTOS_DIR, "index.json");
const MAX_SINGLE_PHOTO_BYTES = 2.5 * 1024 * 1024;
const ALLOWED_PHOTO_FILENAME_RE = /^[a-f0-9-]{36}-(cara|cuerpo)\.(webp|jpg|png)$/i;

interface StoredCastingPhotoEntry {
  id: string;
  correo: string;
  instagram: string;
  whatsapp: string;
  nombre: string;
  apellidos: string;
  fotoCaraUrl: string;
  fotoCuerpoUrl: string;
  createdAt: string;
}

let photoIndexQueue: Promise<unknown> = Promise.resolve();

function withPhotoIndexLock<T>(task: () => Promise<T>): Promise<T> {
  const next = photoIndexQueue.then(task, task);
  photoIndexQueue = next.catch(() => {});
  return next;
}

function ensureCastingPhotosDir(): void {
  fs.mkdirSync(CASTING_PHOTOS_DIR, { recursive: true });
}

function readPhotoIndex(): StoredCastingPhotoEntry[] {
  ensureCastingPhotosDir();
  if (!fs.existsSync(CASTING_PHOTOS_INDEX)) return [];
  try {
    const raw = fs.readFileSync(CASTING_PHOTOS_INDEX, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePhotoIndex(entries: StoredCastingPhotoEntry[]): void {
  ensureCastingPhotosDir();
  const tmpPath = path.resolve(CASTING_PHOTOS_DIR, `index.${crypto.randomUUID()}.tmp`);
  if (!tmpPath.startsWith(CASTING_PHOTOS_DIR + path.sep)) {
    throw new Error("Invalid index path");
  }
  fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), "utf-8");
  fs.renameSync(tmpPath, CASTING_PHOTOS_INDEX);
}

function parseValidatedImageDataUrl(raw: unknown): {
  buffer: Buffer;
  ext: "webp" | "jpg" | "png";
  mime: string;
} | null {
  if (typeof raw !== "string") return null;
  const match = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(raw.trim());
  if (!match) return null;

  const declared = match[1].toLowerCase();
  const b64 = match[2].replace(/\s+/g, "");
  const buffer = Buffer.from(b64, "base64");

  if (buffer.length < 32 || buffer.length > MAX_SINGLE_PHOTO_BYTES) {
    return null;
  }

  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng =
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47;
  const isWebp =
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP";

  if ((declared === "jpeg" || declared === "jpg") && isJpeg) {
    return { buffer, ext: "jpg", mime: "image/jpeg" };
  }
  if (declared === "png" && isPng) {
    return { buffer, ext: "png", mime: "image/png" };
  }
  if (declared === "webp" && isWebp) {
    return { buffer, ext: "webp", mime: "image/webp" };
  }
  return null;
}

function resolveConfinedPhotoPath(filename: string): string | null {
  if (!ALLOWED_PHOTO_FILENAME_RE.test(filename)) return null;
  const resolved = path.resolve(CASTING_PHOTOS_DIR, filename);
  if (!resolved.startsWith(CASTING_PHOTOS_DIR + path.sep)) return null;
  return resolved;
}

async function verifySupabaseAdminRequest(req: express.Request): Promise<{ id: string; email?: string } | null> {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token || token.length > 4096) return null;

  const supabaseUrl = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const supabaseAnonKey = (process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "").trim();
  if (!supabaseUrl || !supabaseAnonKey) {
    return null;
  }

  try {
    const authRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!authRes.ok) return null;
    const user = (await authRes.json()) as { id?: string; email?: string };
    if (!user?.id) return null;
    return { id: user.id, email: user.email };
  } catch {
    return null;
  }
}

let cachedSupabaseAdmin: { key: string; client: SupabaseClient } | null = null;

function getSupabaseAdminClient(): SupabaseClient | null {
  const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!supabaseUrl || !serviceRoleKey) return null;

  const cacheKey = `${supabaseUrl}|${serviceRoleKey.slice(0, 12)}`;
  if (cachedSupabaseAdmin && cachedSupabaseAdmin.key === cacheKey) {
    return cachedSupabaseAdmin.client;
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  cachedSupabaseAdmin = { key: cacheKey, client };
  return client;
}

function timingSafeSecretEquals(provided: string, expected: string): boolean {
  const digestA = crypto.createHash("sha256").update(provided, "utf8").digest();
  const digestB = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

function extractWebhookSecretFromRequest(req: express.Request): string {
  const headerSecret = req.headers["x-webhook-secret"];
  if (typeof headerSecret === "string" && headerSecret.trim()) {
    return headerSecret.trim();
  }
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }
  return "";
}

function getRequestOrigin(req: express.Request): string {
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "";
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
  return host ? `${proto}://${host}` : "";
}

function applySeoMeta(html: string, origin: string, isCastingPage: boolean): string {
  if (!isCastingPage) {
    if (!origin) return html;
    return html
      .replace(/content="\/og-preview\.jpg"/g, `content="${origin}/og-preview.jpg"`)
      .replace(/href="\/og-preview\.jpg"/g, `href="${origin}/og-preview.jpg"`);
  }

  const castingTitle = "Casting Planet Talent | Convocatoria para Modelos";
  const castingDesc =
    "Convocatoria presencial de casting para modelos · 28 y 29 de noviembre en Estudio 50 (Calle Lugareño esq. Almendares, Vedado, Plaza de la Revolución), La Habana.";
  const castingImg = origin
    ? `${origin}/assets/aistudio/casting_flyer_top.jpg`
    : "/assets/aistudio/casting_flyer_top.jpg";

  return html
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${castingTitle}</title>`)
    .replace(
      /<meta\s+name="description"\s+content="[^"]*"\s*\/>/i,
      `<meta name="description" content="${castingDesc}" />`
    )
    .replace(
      /<meta\s+name="keywords"\s+content="[^"]*"\s*\/>/i,
      `<meta name="keywords" content="casting, modelos, planet talent, planet records, convocatoria, la habana" />`
    )
    .replace(
      /<meta\s+property="og:title"\s+content="[^"]*"\s*\/>/i,
      `<meta property="og:title" content="${castingTitle}" />`
    )
    .replace(
      /<meta\s+property="og:description"\s+content="[^"]*"\s*\/>/i,
      `<meta property="og:description" content="${castingDesc}" />`
    )
    .replace(
      /<meta\s+property="og:image"\s+content="[^"]*"\s*\/>/i,
      `<meta property="og:image" content="${castingImg}" />`
    )
    .replace(
      /<meta\s+property="og:image:secure_url"\s+content="[^"]*"\s*\/>/i,
      `<meta property="og:image:secure_url" content="${castingImg}" />`
    )
    .replace(
      /<meta\s+property="og:image:width"\s+content="[^"]*"\s*\/>/i,
      `<meta property="og:image:width" content="870" />`
    )
    .replace(
      /<meta\s+property="og:image:height"\s+content="[^"]*"\s*\/>/i,
      `<meta property="og:image:height" content="628" />`
    )
    .replace(
      /<meta\s+property="og:image:alt"\s+content="[^"]*"\s*\/>/i,
      `<meta property="og:image:alt" content="${castingTitle}" />`
    )
    .replace(
      /<link\s+rel="image_src"\s+href="[^"]*"\s*\/>/i,
      `<link rel="image_src" href="${castingImg}" />`
    )
    .replace(
      /<meta\s+name="twitter:title"\s+content="[^"]*"\s*\/>/i,
      `<meta name="twitter:title" content="${castingTitle}" />`
    )
    .replace(
      /<meta\s+name="twitter:description"\s+content="[^"]*"\s*\/>/i,
      `<meta name="twitter:description" content="${castingDesc}" />`
    )
    .replace(
      /<meta\s+name="twitter:image"\s+content="[^"]*"\s*\/>/i,
      `<meta name="twitter:image" content="${castingImg}" />`
    )
    .replace(
      /<meta\s+name="twitter:image:alt"\s+content="[^"]*"\s*\/>/i,
      `<meta name="twitter:image:alt" content="${castingTitle}" />`
    )
    .replace(
      /<meta\s+name="apple-mobile-web-app-title"\s+content="[^"]*"\s*\/>/i,
      `<meta name="apple-mobile-web-app-title" content="Casting PT" />`
    )
    .replace(
      /<link\s+rel="manifest"\s+href="[^"]*"\s*\/>/i,
      `<link rel="manifest" href="/manifest-casting.json" />`
    );
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middleware de tamaño alto exclusivo para carga de las 2 fotos locales de casting
  app.post("/api/casting-photos", express.json({ limit: "8mb" }), async (req, res) => {
    const {
      fotoCara,
      fotoCuerpo,
      correo,
      instagram,
      whatsapp,
      nombre,
      apellidos,
      website,
    } = req.body || {};

    // Honeypot silencioso
    if (typeof website === "string" && website.trim().length > 0) {
      return res.status(200).json({ ok: true, fotoCaraUrl: "", fotoCuerpoUrl: "" });
    }

    const clientIp =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";
    const now = Date.now();
    const recentUploads = (castingPhotoRateMap.get(clientIp) || []).filter(
      (ts) => now - ts < 15 * 60 * 1000
    );
    if (recentUploads.length >= 12) {
      return res.status(429).json({ error: "Demasiadas cargas de fotos recientes desde este dispositivo." });
    }
    recentUploads.push(now);
    castingPhotoRateMap.set(clientIp, recentUploads);

    const parsedCara = parseValidatedImageDataUrl(fotoCara);
    const parsedCuerpo = parseValidatedImageDataUrl(fotoCuerpo);
    if (!parsedCara || !parsedCuerpo) {
      return res.status(400).json({
        error: "Formato o tamaño de fotografía inválido. Usa imágenes JPG, PNG o WebP (máx. 2.5 MB cada una).",
      });
    }

    try {
      const recordId = crypto.randomUUID();
      const caraFilename = `${recordId}-cara.${parsedCara.ext}`;
      const cuerpoFilename = `${recordId}-cuerpo.${parsedCuerpo.ext}`;

      const caraPath = resolveConfinedPhotoPath(caraFilename);
      const cuerpoPath = resolveConfinedPhotoPath(cuerpoFilename);
      if (!caraPath || !cuerpoPath) {
        return res.status(400).json({ error: "Nombre de archivo inválido." });
      }

      ensureCastingPhotosDir();
      fs.writeFileSync(caraPath, parsedCara.buffer);
      fs.writeFileSync(cuerpoPath, parsedCuerpo.buffer);

      const entry: StoredCastingPhotoEntry = {
        id: recordId,
        correo: String(correo || "").trim().toLowerCase().slice(0, 180),
        instagram: String(instagram || "").trim().slice(0, 120),
        whatsapp: String(whatsapp || "").trim().slice(0, 60),
        nombre: String(nombre || "").trim().slice(0, 120),
        apellidos: String(apellidos || "").trim().slice(0, 140),
        fotoCaraUrl: `/api/casting-photos/${caraFilename}`,
        fotoCuerpoUrl: `/api/casting-photos/${cuerpoFilename}`,
        createdAt: new Date().toISOString(),
      };

      await withPhotoIndexLock(async () => {
        const current = readPhotoIndex();
        current.unshift(entry);
        writePhotoIndex(current);
      });

      return res.status(200).json({
        ok: true,
        id: recordId,
        fotoCaraUrl: entry.fotoCaraUrl,
        fotoCuerpoUrl: entry.fotoCuerpoUrl,
      });
    } catch (err) {
      console.error("Error saving casting photos locally:", err);
      return res.status(500).json({ error: "No se pudieron guardar las fotografías localmente." });
    }
  });

  // Endpoints protegidos de lectura y limpieza para el panel de administración (Supabase Auth Bearer)
  app.get("/api/casting-photos/index", async (req, res) => {
    const admin = await verifySupabaseAdminRequest(req);
    if (!admin) {
      return res.status(401).json({ error: "Sesión de administrador requerida." });
    }
    try {
      const records = await withPhotoIndexLock(async () => readPhotoIndex());
      return res.status(200).json({ ok: true, localStorageAvailable: true, records });
    } catch (err) {
      console.error("Error reading casting photo index:", err);
      return res.status(500).json({ error: "Error leyendo índice de fotos locales." });
    }
  });

  app.get("/api/casting-photos/:filename", async (req, res) => {
    const admin = await verifySupabaseAdminRequest(req);
    if (!admin) {
      return res.status(401).json({ error: "Sesión de administrador requerida." });
    }
    const filename = String(req.params.filename || "");
    const resolvedPath = resolveConfinedPhotoPath(filename);
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: "Fotografía no encontrada." });
    }
    const ext = path.extname(filename).toLowerCase();
    const contentType =
      ext === ".webp" ? "image/webp" : ext === ".png" ? "image/png" : "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=3600");
    return res.sendFile(resolvedPath);
  });

  app.delete("/api/casting-photos", express.json({ limit: "64kb" }), async (req, res) => {
    const admin = await verifySupabaseAdminRequest(req);
    if (!admin) {
      return res.status(401).json({ error: "Sesión de administrador requerida." });
    }
    const { correo, instagram, fotoCaraUrl, fotoCuerpoUrl } = req.body || {};
    const targetEmail = String(correo || "").trim().toLowerCase();
    const targetIg = String(instagram || "").trim().replace(/^@+/, "").toLowerCase();
    const targetCara = String(fotoCaraUrl || "").trim();
    const targetCuerpo = String(fotoCuerpoUrl || "").trim();

    try {
      await withPhotoIndexLock(async () => {
        const current = readPhotoIndex();
        const toDelete: StoredCastingPhotoEntry[] = [];
        const remaining = current.filter((item) => {
          const matches =
            (targetCara && item.fotoCaraUrl === targetCara) ||
            (targetCuerpo && item.fotoCuerpoUrl === targetCuerpo) ||
            (targetEmail && item.correo === targetEmail) ||
            (targetIg && item.instagram.replace(/^@+/, "").toLowerCase() === targetIg);
          if (matches) {
            toDelete.push(item);
            return false;
          }
          return true;
        });

        for (const item of toDelete) {
          for (const url of [item.fotoCaraUrl, item.fotoCuerpoUrl]) {
            const fname = path.basename(url || "");
            const confined = resolveConfinedPhotoPath(fname);
            if (confined && fs.existsSync(confined)) {
              fs.unlinkSync(confined);
            }
          }
        }
        writePhotoIndex(remaining);
      });
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("Error deleting local casting photos:", err);
      return res.status(500).json({ error: "No se pudieron eliminar las fotos locales." });
    }
  });

  // Middleware for JSON body parsing on remaining routes
  app.use(express.json({ limit: "2mb" }));

  // Estado del webhook de Google Form (solo Admin autenticado, sin exponer secretos)
  app.get("/api/webhooks/google-form/status", async (req, res) => {
    const admin = await verifySupabaseAdminRequest(req);
    if (!admin) {
      return res.status(401).json({ error: "Sesión de administrador requerida." });
    }
    const supabaseUrlConfigured = Boolean(
      (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").trim()
    );
    const serviceRoleConfigured = Boolean((process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim());
    const webhookSecretConfigured = Boolean((process.env.GOOGLE_FORM_WEBHOOK_SECRET || "").trim());

    return res.status(200).json({
      ok: true,
      supabaseUrlConfigured,
      serviceRoleConfigured,
      webhookSecretConfigured,
      ready: supabaseUrlConfigured && serviceRoleConfigured && webhookSecretConfigured,
    });
  });

  // Webhook para recibir filas desde Google Forms / Google Sheets vía Apps Script
  app.post("/api/webhooks/google-form", async (req, res) => {
    const expectedSecret = (process.env.GOOGLE_FORM_WEBHOOK_SECRET || "").trim();
    if (!expectedSecret) {
      return res.status(503).json({
        error: "Falta configurar GOOGLE_FORM_WEBHOOK_SECRET en Secrets del servidor.",
      });
    }

    const providedSecret = extractWebhookSecretFromRequest(req);
    if (!providedSecret || !timingSafeSecretEquals(providedSecret, expectedSecret)) {
      return res.status(401).json({ error: "No autorizado: secreto de webhook inválido." });
    }

    const supabaseAdmin = getSupabaseAdminClient();
    if (!supabaseAdmin) {
      return res.status(503).json({
        error: "Falta configurar SUPABASE_SERVICE_ROLE_KEY o VITE_SUPABASE_URL en Secrets del servidor.",
      });
    }

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
      return res.status(400).json({ error: "Máximo 250 filas por solicitud." });
    }

    const sanitizedRows: string[][] = rawRowsInput.map((r: unknown) =>
      Array.isArray(r) ? r.slice(0, 40).map((cell) => String(cell ?? "").slice(0, 2000)) : []
    );

    const normalized = normalizeGoogleFormsRows(sanitizedRows);

    try {
      const existingApps: CastingApplication[] = [];
      const pageSize = 1000;
      let offset = 0;

      while (true) {
        const { data: pageData, error: fetchError } = await supabaseAdmin
          .from("casting_applications")
          .select(
            "id, nombre, apellidos, fecha_nacimiento, edad, ciudad, whatsapp, correo, instagram, estatura, busto, cintura, caderas, talla_superior, talla_inferior, calzado, color_cabello, largo_cabello, color_ojos, tono_piel, tiene_piercings, tiene_tatuajes, detalle_piercings_tatuajes, origen, talento, genero, formacion_artistica, nivel_ensenanza, nombre_artistico, estado_cabello, tiktok, notas_importacion, datos_incompletos, campos_faltantes, estado"
          )
          .order("id", { ascending: true })
          .range(offset, offset + pageSize - 1);

        if (fetchError) {
          console.error("Webhook Supabase read error:", fetchError);
          return res.status(502).json({ error: "No se pudo consultar casting_applications en Supabase." });
        }

        const rowsPage = (pageData || []) as CastingApplication[];
        existingApps.push(...rowsPage);
        if (rowsPage.length < pageSize) break;
        offset += pageSize;
      }

      let inserted = 0;
      let mergedUpdated = 0;
      let skippedDuplicates = 0;
      const insertedProfiles: {
        nombre: string;
        apellidos: string;
        edad: number;
        whatsapp: string;
        instagram: string;
        estatura: number | null;
        talento: "modelo" | "bailarin";
        genero: string | null;
        formacion_artistica: string | null;
      }[] = [];

      for (const candidate of normalized.validRecords) {
        const match = findMatchingApplicationInDb(candidate, existingApps);
        if (!match) {
          const { data: insertedRow, error: insertError } = await supabaseAdmin
            .from("casting_applications")
            .insert(candidate)
            .select(
              "id, nombre, apellidos, fecha_nacimiento, edad, ciudad, whatsapp, correo, instagram, estatura, busto, cintura, caderas, talla_superior, talla_inferior, calzado, color_cabello, largo_cabello, color_ojos, tono_piel, tiene_piercings, tiene_tatuajes, detalle_piercings_tatuajes, origen, talento, genero, formacion_artistica, nivel_ensenanza, nombre_artistico, estado_cabello, tiktok, notas_importacion, datos_incompletos, campos_faltantes, estado"
            )
            .single();

          if (insertError) {
            console.error("Webhook Supabase insert error:", insertError);
            return res.status(502).json({
              error: `Error insertando registro en Supabase: ${insertError.message}`,
            });
          }

          if (insertedRow) {
            existingApps.push(insertedRow as CastingApplication);
          }
          inserted++;
          insertedProfiles.push({
            nombre: candidate.nombre,
            apellidos: candidate.apellidos,
            edad: candidate.edad,
            whatsapp: candidate.whatsapp,
            instagram: candidate.instagram,
            estatura: candidate.estatura,
            talento: candidate.talento,
            genero: candidate.genero,
            formacion_artistica: candidate.formacion_artistica,
          });
        } else {
          const patch = computeApplicationMergePatch(match, candidate);
          if (patch) {
            const { error: updateError } = await supabaseAdmin
              .from("casting_applications")
              .update(patch)
              .eq("id", match.id);

            if (updateError) {
              console.error("Webhook Supabase merge update error:", updateError);
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

      const shouldNotifyTelegram =
        body.notifyTelegram === true || (sanitizedRows.length === 1 && body.notifyTelegram !== false);

      if (shouldNotifyTelegram && insertedProfiles.length > 0 && insertedProfiles.length <= 3) {
        const escapeHTML = (str: unknown) =>
          String(str ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
        const telegramBotToken = "8875004415:AAED6CX7msEFkNuqBn9Xagv4jq7KHT4WQbw";
        const telegramChatId = "-1004303735696";

        for (const p of insertedProfiles) {
          const tutorLine = p.edad === 17 ? `\n⚠️ <b>Nota:</b> Tiene 17 años (asiste con tutor)` : "";
          const isDancer = p.talento === "bailarin";
          const headerTitle = isDancer
            ? "💃 Nuevo/a Bailarín/a — Google Form (Casting)"
            : "📝 Nueva Modelo — Google Form (Casting)";
          const dancerExtra = isDancer
            ? `\n🎭 <b>Talento:</b> Bailarín/a${p.genero ? ` (${escapeHTML(p.genero)})` : ""}${
                p.formacion_artistica ? ` · ${escapeHTML(p.formacion_artistica)}` : ""
              }`
            : "";
          const msg = `<b>${headerTitle}</b>

👤 <b>Nombre:</b> ${escapeHTML(`${p.nombre} ${p.apellidos}`.trim())}${dancerExtra}
🎂 <b>Edad:</b> ${escapeHTML(p.edad)} años
📏 <b>Estatura:</b> ${escapeHTML(p.estatura ? `${p.estatura} cm` : "Pendiente")}
📱 <b>WhatsApp:</b> ${escapeHTML(p.whatsapp)}
📸 <b>Instagram:</b> ${escapeHTML(p.instagram || "No especificado")}${tutorLine}
⚠️ <b>Estado:</b> Pendiente de fotos`;

          fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: telegramChatId,
              text: msg,
              parse_mode: "HTML",
            }),
          }).catch((e) => console.error("Webhook Telegram notification error:", e));
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
    } catch (err: any) {
      console.error("Google Form webhook unexpected error:", err);
      return res.status(500).json({ error: "Error interno procesando el webhook de Google Form." });
    }
  });

  // Health check endpoint
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", castingPhotoStorage: "local" });
  });

  // API Route to send Telegram notification for new bookings
  app.post("/api/notify-booking", async (req, res) => {
    const { nombre, modelos, fecha } = req.body;

    const escapeHTML = (str: string) => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const telegramMessage = `<b>🔔 Nueva solicitud de booking</b>

👤 <b>Cliente:</b> ${escapeHTML(nombre)}
📱 <b>Modelos:</b> ${escapeHTML(modelos)}
📅 <b>Fecha del evento:</b> ${escapeHTML(fecha)}

Revisa el panel de administración para más detalles`;
    const telegramBotToken = '8875004415:AAED6CX7msEFkNuqBn9Xagv4jq7KHT4WQbw';
    const telegramChatId = '-1004303735696';

    try {
      const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          chat_id: telegramChatId,
          text: telegramMessage,
          parse_mode: 'HTML'
        })
      });

      if (!response.ok) {
        console.error('Telegram API error:', await response.text());
        return res.status(502).json({ error: "Failed to send Telegram notification" });
      }

      console.log('Telegram notification sent');
      return res.status(200).json({ success: true });
    } catch (err: any) {
      console.error("Error sending Telegram notification:", err);
      return res.status(500).json({ error: "Failed to send notification" });
    }
  });

  // Rate limit sencillo en memoria por IP para el formulario de Casting (máx. 5 envíos cada 15 min)
  const castingRateMap = new Map<string, number[]>();
  const castingPhotoRateMap = new Map<string, number[]>();

  // API Route to send Telegram-only notification for new Casting applications
  app.post("/api/notify-casting", async (req, res) => {
    const {
      nombre,
      apellidos,
      edad,
      estatura,
      whatsapp,
      instagram,
      talento,
      genero,
      formacionArtistica,
      nivelEnsenanza,
      website,
    } = req.body || {};

    // Campo trampa honeypot: si viene relleno, responder ok silenciosamente sin notificar
    if (typeof website === 'string' && website.trim().length > 0) {
      return res.status(200).json({ success: true });
    }

    const clientIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      'unknown';
    const now = Date.now();
    const recentHits = (castingRateMap.get(clientIp) || []).filter(
      (ts) => now - ts < 15 * 60 * 1000
    );
    if (recentHits.length >= 5) {
      return res.status(429).json({ error: 'Demasiados envíos recientes desde este dispositivo.' });
    }
    recentHits.push(now);
    castingRateMap.set(clientIp, recentHits);

    if (!nombre || !whatsapp) {
      return res.status(400).json({ error: 'Faltan campos requeridos de la postulación.' });
    }

    const numericAge = Number(edad);
    if (!Number.isNaN(numericAge) && numericAge > 0 && numericAge < 17) {
      return res.status(400).json({ error: 'La edad mínima para postularse es de 17 años.' });
    }

    const escapeHTML = (str: unknown) =>
      String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    const fullName = `${nombre}${apellidos ? ` ${apellidos}` : ''}`;
    const tutorLine =
      numericAge === 17
        ? `\n⚠️ <b>Nota:</b> Tiene 17 años (debe asistir con tutor)`
        : '';
    const isDancer = talento === 'bailarin';
    const headerLabel = isDancer
      ? '💃 Nuevo/a Bailarín/a — Casting Planet Talent'
      : '🎬 Nueva postulante — Casting Planet Talent';
    const dancerExtraLines = isDancer
      ? `\n🎭 <b>Talento:</b> Bailarín/a${genero ? ` (${escapeHTML(genero)})` : ''}${
          formacionArtistica ? `\n🎓 <b>Formación:</b> ${escapeHTML(formacionArtistica)}` : ''
        }${nivelEnsenanza ? `\n📚 <b>Nivel:</b> ${escapeHTML(nivelEnsenanza)}` : ''}`
      : '';
    const telegramMessage = `<b>${headerLabel}</b>

👤 <b>Nombre:</b> ${escapeHTML(fullName)}${dancerExtraLines}
🎂 <b>Edad:</b> ${escapeHTML(edad)} años
📏 <b>Estatura:</b> ${escapeHTML(estatura)} cm
📱 <b>WhatsApp:</b> ${escapeHTML(whatsapp)}
📸 <b>Instagram:</b> ${escapeHTML(instagram || 'No especificado')}${tutorLine}`;

    const telegramBotToken = '8875004415:AAED6CX7msEFkNuqBn9Xagv4jq7KHT4WQbw';
    const telegramChatId = '-1004303735696';

    try {
      const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: telegramChatId,
          text: telegramMessage,
          parse_mode: 'HTML',
        }),
      });

      if (!response.ok) {
        console.error('Telegram casting API error:', await response.text());
        return res.status(502).json({ error: 'Failed to send Telegram casting notification' });
      }

      return res.status(200).json({ success: true });
    } catch (err: any) {
      console.error('Error sending Telegram casting notification:', err);
      return res.status(500).json({ error: 'Failed to send casting notification' });
    }
  });

  // Vite integration
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });

    app.get(["/", "/casting", "/admin"], async (req, res, next) => {
      try {
        const rawHtml = fs.readFileSync(path.join(process.cwd(), "index.html"), "utf-8");
        const isCastingPage =
          CASTING_ONLY_PREVIEW_MODE || req.path.replace(/\/+$/, "") === "/casting";
        const origin = getRequestOrigin(req);
        const transformed = await vite.transformIndexHtml(req.originalUrl, rawHtml);
        const html = applySeoMeta(transformed, origin, isCastingPage);
        res.status(200).set({ "Content-Type": "text/html; charset=utf-8" }).end(html);
      } catch (e) {
        next(e);
      }
    });

    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath, { index: false }));
    app.get("*", (req, res) => {
      try {
        const indexPath = path.join(distPath, "index.html");
        const rawHtml = fs.readFileSync(indexPath, "utf-8");
        const origin = getRequestOrigin(req);
        const isCastingPage =
          CASTING_ONLY_PREVIEW_MODE || req.path.replace(/\/+$/, "") === "/casting";
        const html = applySeoMeta(rawHtml, origin, isCastingPage);
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(html);
      } catch {
        res.sendFile(path.join(distPath, "index.html"));
      }
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
