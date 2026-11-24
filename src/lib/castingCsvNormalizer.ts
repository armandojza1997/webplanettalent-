import { CastingApplication } from '../types';

export interface NormalizedCastingInsert {
  nombre: string;
  apellidos: string;
  fecha_nacimiento: string | null;
  edad: number;
  ciudad: string;
  whatsapp: string;
  correo: string;
  instagram: string;
  estatura: number | null;
  busto: number | null;
  cintura: number | null;
  caderas: number | null;
  talla_superior: string | null;
  talla_inferior: string | null;
  calzado: string | null;
  color_cabello: string | null;
  largo_cabello: string | null;
  color_ojos: string | null;
  tono_piel: string | null;
  tiene_piercings: boolean;
  tiene_tatuajes: boolean;
  detalle_piercings_tatuajes: string | null;
  foto_cara: null;
  foto_cuerpo: null;
  origen: 'google_form';
  talento: 'modelo' | 'bailarin';
  genero: string | null;
  formacion_artistica: string | null;
  nivel_ensenanza: string | null;
  nombre_artistico: string | null;
  estado_cabello: string | null;
  tiktok: string | null;
  notas_importacion: string | null;
  datos_incompletos: boolean;
  campos_faltantes: string[];
  estado: 'pendiente';
  created_at: string;
}

export interface DiscardedCsvRecord {
  filaOriginal: string;
  marcaTemporal: string;
  talento: string;
  nombreCompleto: string;
  fechaNacimientoRaw: string;
  edadRaw: string;
  whatsappRaw: string;
  correoRaw: string;
  instagramRaw: string;
  estaturaRaw: string;
  motivo: string;
}

export interface NormalizationSummary {
  totalRows: number;
  excludedDancers: number;
  includedModels: number;
  includedDancers: number;
  emptyOrJunkRows: number;
  internalDuplicatesMerged: number;
  discardedUnder17OrConflict: number;
  readyToImport: number;
  withExtraMissingFields: number;
  repairedBirthYears: number;
}

export interface NormalizationResult {
  validRecords: NormalizedCastingInsert[];
  discardedRecords: DiscardedCsvRecord[];
  summary: NormalizationSummary;
}

const COMPOUND_FIRST_NAMES = new Set([
  'ana',
  'maria',
  'maría',
  'jose',
  'josé',
  'laura',
  'carla',
  'karla',
  'paula',
  'daniela',
  'rosa',
  'claudia',
  'elena',
  'clara',
  'sofia',
  'sofía',
  'lucia',
  'lucía',
  'isabel',
  'carmen',
  'luisa',
  'victoria',
  'karen',
  'liz',
  'liset',
  'andrea',
]);

const NAME_PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'san', 'santa']);

export function parseCsvMatrix(rawText: string): string[][] {
  const clean = rawText.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const next = clean[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(current);
        current = '';
      } else if (ch === '\r' && next === '\n') {
        row.push(current);
        rows.push(row);
        row = [];
        current = '';
        i++;
      } else if (ch === '\n' || ch === '\r') {
        row.push(current);
        rows.push(row);
        row = [];
        current = '';
      } else {
        current += ch;
      }
    }
  }
  if (current.length > 0 || row.length > 0) {
    row.push(current);
    rows.push(row);
  }
  return rows;
}

function toTitleCaseSpanish(input: string): string {
  return input
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word, idx) => {
      const lower = word.toLowerCase();
      if (idx > 0 && NAME_PARTICLES.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

function splitFullName(rawName: string): { nombre: string; apellidos: string; missingApellidos: boolean } {
  const cleaned = toTitleCaseSpanish(rawName);
  if (!cleaned) {
    return { nombre: 'Sin nombre', apellidos: 'Por completar', missingApellidos: true };
  }
  const tokens = cleaned.split(' ').filter(Boolean);
  if (tokens.length === 1) {
    return { nombre: tokens[0], apellidos: 'Por completar', missingApellidos: true };
  }
  if (tokens.length === 2) {
    return { nombre: tokens[0], apellidos: tokens[1], missingApellidos: false };
  }
  if (tokens.length === 3) {
    const t0 = tokens[0].toLowerCase();
    const t1 = tokens[1].toLowerCase();
    if (NAME_PARTICLES.has(t1)) {
      return { nombre: tokens[0], apellidos: `${tokens[1]} ${tokens[2]}`, missingApellidos: false };
    }
    if (COMPOUND_FIRST_NAMES.has(t0) && !NAME_PARTICLES.has(tokens[2].toLowerCase())) {
      // Check if second token looks like an obvious compound middle name (e.g. Ana Paula, María José, Laura Sofía)
      if (COMPOUND_FIRST_NAMES.has(t1)) {
        return { nombre: `${tokens[0]} ${tokens[1]}`, apellidos: tokens[2], missingApellidos: false };
      }
    }
    return { nombre: tokens[0], apellidos: `${tokens[1]} ${tokens[2]}`, missingApellidos: false };
  }
  // 4+ tokens: if particle near end (e.g. "María de los Ángeles Pérez") keep apellidos at the end
  return {
    nombre: tokens.slice(0, tokens.length - 2).join(' '),
    apellidos: tokens.slice(tokens.length - 2).join(' '),
    missingApellidos: false,
  };
}

function parseGoogleFormTimestamp(rawTs: string): Date {
  const normalized = (rawTs || '')
    .replace(/[\u202f\u00a0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return new Date();

  // ISO timestamp (e.g. 2026-11-24T12:34:56.000Z)
  if (/^\d{4}-\d{2}-\d{2}T/.test(normalized)) {
    const parsedIso = new Date(normalized);
    if (!Number.isNaN(parsedIso.getTime())) return parsedIso;
  }

  // Format 1: YYYY/MM/DD HH:mm:ss [a. m.|p. m.]
  const ymdMatch = normalized.match(
    /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?)?/i
  );
  if (ymdMatch) {
    const year = Number(ymdMatch[1]);
    const month = Number(ymdMatch[2]) - 1;
    const day = Number(ymdMatch[3]);
    let hour = Number(ymdMatch[4]);
    const minute = Number(ymdMatch[5]);
    const second = Number(ymdMatch[6] || '0');
    const ampm = (ymdMatch[7] || '').toLowerCase();
    if (ampm.startsWith('p') && hour < 12) hour += 12;
    if (ampm.startsWith('a') && hour === 12) hour = 0;
    const utcMs = Date.UTC(year, month, day, hour - 1, minute, second);
    return new Date(utcMs);
  }

  // Format 2: DD/MM/YYYY HH:mm:ss or MM/DD/YYYY HH:mm:ss (Google Sheets display values)
  const dmyMatch = normalized.match(
    /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?)?/i
  );
  if (dmyMatch) {
    const first = Number(dmyMatch[1]);
    const second = Number(dmyMatch[2]);
    const year = Number(dmyMatch[3]);
    let day = first;
    let month = second - 1;
    // If second part > 12, it was MM/DD/YYYY
    if (second > 12 && first <= 12) {
      month = first - 1;
      day = second;
    }
    let hour = Number(dmyMatch[4]);
    const minute = Number(dmyMatch[5]);
    const secondSec = Number(dmyMatch[6] || '0');
    const ampm = (dmyMatch[7] || '').toLowerCase();
    if (ampm.startsWith('p') && hour < 12) hour += 12;
    if (ampm.startsWith('a') && hour === 12) hour = 0;
    const utcMs = Date.UTC(year, month, day, hour, minute, secondSec);
    return new Date(utcMs);
  }

  const fallback = new Date(normalized);
  return Number.isNaN(fallback.getTime()) ? new Date() : fallback;
}

function computeAgeAtReference(year: number, month: number, day: number, refDate: Date): number {
  let age = refDate.getUTCFullYear() - year;
  const mDiff = refDate.getUTCMonth() + 1 - month;
  if (mDiff < 0 || (mDiff === 0 && refDate.getUTCDate() < day)) {
    age--;
  }
  return age;
}

function parseDobComponents(trimmedDob: string): { year: number; month: number; day: number } | null {
  const ymd = trimmedDob.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (ymd) {
    return {
      year: parseInt(ymd[1], 10),
      month: parseInt(ymd[2], 10),
      day: parseInt(ymd[3], 10),
    };
  }
  const dmy = trimmedDob.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (dmy) {
    const first = parseInt(dmy[1], 10);
    const second = parseInt(dmy[2], 10);
    const year = parseInt(dmy[3], 10);
    if (second > 12 && first <= 12) {
      return { year, month: first, day: second };
    }
    return { year, month: second, day: first };
  }
  return null;
}

function parseAndRepairDob(
  rawDob: string,
  rawEdad: string,
  submissionDate: Date,
  castingRefDate: Date
): {
  fechaNacimiento: string | null;
  edad: number | null;
  repaired: boolean;
  conflictReason: string | null;
  repairNote: string | null;
} {
  const edadMatch = (rawEdad || '').match(/\d+/);
  const declaredAge = edadMatch ? parseInt(edadMatch[0], 10) : null;
  const validDeclaredAge =
    declaredAge !== null && declaredAge >= 3 && declaredAge <= 80 ? declaredAge : null;

  const trimmedDob = (rawDob || '').trim();
  const parsedDob = parseDobComponents(trimmedDob);

  if (!parsedDob) {
    return {
      fechaNacimiento: null,
      edad: validDeclaredAge,
      repaired: false,
      conflictReason: null,
      repairNote: null,
    };
  }

  let { year } = parsedDob;
  const { month, day } = parsedDob;
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return {
      fechaNacimiento: null,
      edad: validDeclaredAge,
      repaired: false,
      conflictReason: null,
      repairNote: `Fecha original inválida (${trimmedDob})`,
    };
  }

  let repaired = false;
  let repairNote: string | null = null;

  // 1) Typo "0004" -> "2004", "0005" -> "2005"
  if (year >= 1 && year <= 99) {
    const fixedYear = year <= 25 ? 2000 + year : 1900 + year;
    repairNote = `Año de nacimiento reparado (${String(year).padStart(4, '0')} -> ${fixedYear})`;
    year = fixedYear;
    repaired = true;
  } else if (year >= 2020 && validDeclaredAge !== null && validDeclaredAge >= 12 && validDeclaredAge <= 65) {
    // 2) User typed current year (2026 / 2027) instead of birth year
    const refYear = submissionDate.getUTCFullYear();
    const refMonth = submissionDate.getUTCMonth() + 1;
    const refDay = submissionDate.getUTCDate();
    const birthdayAlreadyPassed = month < refMonth || (month === refMonth && day <= refDay);
    const fixedYear = refYear - validDeclaredAge - (birthdayAlreadyPassed ? 0 : 1);
    repairNote = `Año calculado por edad (${trimmedDob} + ${validDeclaredAge}a -> ${fixedYear})`;
    year = fixedYear;
    repaired = true;
  }

  if (year < 1940 || year > 2026) {
    return {
      fechaNacimiento: null,
      edad: validDeclaredAge,
      repaired: false,
      conflictReason: null,
      repairNote: `Año fuera de rango (${trimmedDob})`,
    };
  }

  const fixedIso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const ageFromDob = computeAgeAtReference(year, month, day, castingRefDate);

  // Detect severe conflict (e.g. DOB says 15 years old but declared age says 17)
  if (
    !repaired &&
    ageFromDob < 17 &&
    validDeclaredAge !== null &&
    validDeclaredAge >= 17 &&
    Math.abs(validDeclaredAge - ageFromDob) >= 2
  ) {
    return {
      fechaNacimiento: fixedIso,
      edad: ageFromDob,
      repaired: false,
      conflictReason: `Conflicto fecha/edad (fecha ${fixedIso} = ${ageFromDob} años vs edad declarada ${validDeclaredAge})`,
      repairNote: null,
    };
  }

  if (ageFromDob < 17) {
    const turns17Soon = ageFromDob === 16 && year === 2009 && month === 12;
    return {
      fechaNacimiento: fixedIso,
      edad: ageFromDob,
      repaired,
      conflictReason: turns17Soon
        ? `Menor durante el casting: cumple 17 el ${fixedIso}`
        : `Menor de 17 años (${ageFromDob} años, nac. ${fixedIso})`,
      repairNote,
    };
  }

  return {
    fechaNacimiento: fixedIso,
    edad: ageFromDob,
    repaired,
    conflictReason: null,
    repairNote,
  };
}

export function normalizePhoneNumber(raw: string): {
  primary: string;
  phoneKey: string;
  extraNotes: string | null;
  missing: boolean;
} {
  const cleanedRaw = (raw || '').trim();
  if (!cleanedRaw || /^(no tengo|ninguno|-|\.)+$/i.test(cleanedRaw)) {
    return { primary: 'No especificado', phoneKey: '', extraNotes: null, missing: true };
  }

  // Extract segments separated by / or multiple numbers
  const candidates = cleanedRaw
    .split(/[/,\n]|(?:\s{2,})|(?:\s+o\s+)/i)
    .map((part) => part.replace(/[^\d+]/g, ''))
    .filter((digits) => digits.replace(/\D/g, '').length >= 7);

  if (candidates.length === 0) {
    const allDigits = cleanedRaw.replace(/\D/g, '');
    if (allDigits.length >= 8) {
      const first8 = allDigits.slice(0, 8);
      const rest = allDigits.length >= 16 ? allDigits.slice(8) : '';
      const formatted = /^[56]\d{7}$/.test(first8) ? `+53 ${first8}` : first8;
      return {
        primary: formatted,
        phoneKey: first8,
        extraNotes: rest ? `Tel. secundario: ${rest}` : null,
        missing: false,
      };
    }
    return { primary: 'No especificado', phoneKey: '', extraNotes: null, missing: true };
  }

  const formatSingle = (num: string): { formatted: string; key: string } => {
    const digitsOnly = num.replace(/\D/g, '');
    if (digitsOnly.length === 8 && /^[56]\d{7}$/.test(digitsOnly)) {
      return { formatted: `+53 ${digitsOnly}`, key: digitsOnly };
    }
    if (digitsOnly.length === 10 && digitsOnly.startsWith('53')) {
      return { formatted: `+53 ${digitsOnly.slice(2)}`, key: digitsOnly.slice(-8) };
    }
    if (digitsOnly.length === 11 && digitsOnly.startsWith('053')) {
      return { formatted: `+53 ${digitsOnly.slice(3)}`, key: digitsOnly.slice(-8) };
    }
    return {
      formatted: num.startsWith('+') ? num : `+${digitsOnly}`,
      key: digitsOnly.slice(-8),
    };
  };

  const first = formatSingle(candidates[0]);
  const extras = candidates
    .slice(1)
    .map((c) => formatSingle(c).formatted)
    .filter((v) => v && v !== first.formatted);

  return {
    primary: first.formatted,
    phoneKey: first.key,
    extraNotes: extras.length > 0 ? `Tel. alternativo: ${extras.join(', ')}` : null,
    missing: false,
  };
}

export function normalizeEmailAddress(raw: string): {
  email: string;
  emailKey: string;
  missing: boolean;
} {
  let s = (raw || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!s || /^(no tengo|ninguno|no|-|\.)+$/i.test(s)) {
    return { email: 'No especificado', emailKey: '', missing: true };
  }
  // Remove leading accidental @ like @usuario@gmail.com
  s = s.replace(/^@+/, '');
  // Common domain typos
  s = s
    .replace(/@gamil\.com$/i, '@gmail.com')
    .replace(/@gamail\.com$/i, '@gmail.com')
    .replace(/@gmai\.com$/i, '@gmail.com')
    .replace(/@gmail\.con$/i, '@gmail.com')
    .replace(/@gmail\.como$/i, '@gmail.com')
    .replace(/@gmail\.vom$/i, '@gmail.com')
    .replace(/@hotmai\.com$/i, '@hotmail.com')
    .replace(/@outlok\.com$/i, '@outlook.com');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
    return { email: 'No especificado', emailKey: '', missing: true };
  }
  return { email: s, emailKey: s, missing: false };
}

export function normalizeSocialHandles(raw: string): {
  instagram: string;
  tiktok: string | null;
  missingIg: boolean;
} {
  const s = (raw || '').trim();
  if (!s || /^(instagram|tik\s*tok|no tengo|ninguno|no|-|\.)+$/i.test(s)) {
    return { instagram: 'No especificado', tiktok: null, missingIg: true };
  }

  let igHandle = '';
  let tkHandle: string | null = null;

  // Split multi-part entries
  const parts = s.split(/[\s,;|\n]+/).filter(Boolean);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (/tiktok\.com/i.test(part)) {
      const m = part.match(/tiktok\.com\/@?([^/?#\s]+)/i);
      if (m && m[1] && !/^(t|r|video)$/i.test(m[1])) {
        tkHandle = `@${m[1].replace(/^@+/, '')}`;
      } else {
        tkHandle = part.split('?')[0];
      }
      continue;
    }
    if (/instagram\.com/i.test(part)) {
      const m = part.match(/instagram\.com\/([^/?#\s]+)/i);
      if (m && m[1] && !/^(p|reel|stories|explore)$/i.test(m[1])) {
        igHandle = `@${m[1].replace(/^@+/, '')}`;
      }
      continue;
    }
    if (/^(tiktok|tk):?$/i.test(part) && parts[i + 1]) {
      const next = parts[i + 1].replace(/^@+/, '').split(/[/?#]/)[0];
      if (next && !/^(no|tengo)$/i.test(next)) tkHandle = `@${next}`;
      i++;
      continue;
    }
    if (/^(ig|instagram):?$/i.test(part)) continue;
  }

  // Fallback if no URL was matched but user wrote plain @handle or username
  if (!igHandle) {
    const firstValidToken = parts.find((p) => {
      const cleaned = p.replace(/^@+/, '').toLowerCase();
      return (
        cleaned.length >= 2 &&
        !/^https?:\/\//i.test(p) &&
        !/^(instagram|ig|tiktok|tk|y|o|no|tengo|en|como|soy|-)$/i.test(cleaned)
      );
    });
    if (firstValidToken && (!tkHandle || `@${firstValidToken.replace(/^@+/, '')}` !== tkHandle)) {
      igHandle = `@${firstValidToken.replace(/^@+/, '').replace(/[,;]+$/, '')}`;
    }
  }

  if (!igHandle || igHandle === '@') {
    return { instagram: 'No especificado', tiktok: tkHandle, missingIg: true };
  }

  return { instagram: igHandle, tiktok: tkHandle, missingIg: false };
}

function parseHeightCm(raw: string): { cm: number | null; note: string | null } {
  const s = (raw || '').trim();
  if (!s || /^(no s[eé]|alta|baja|ni idea|ni c|-|\.)/i.test(s) && !/\d{2}/.test(s)) {
    return { cm: null, note: s && !/^(-|\.)$/i.test(s) ? `Estatura texto: "${s}"` : null };
  }
  if (/https?:\/\//i.test(s)) {
    return { cm: null, note: null };
  }

  const normalized = s
    .replace(/[\u2018\u2019'`´]/g, '.')
    .replace(/[,:;/\-]/g, '.')
    .replace(/\s*\.\s*/g, '.')
    .replace(/(\d)[oO]/g, '$10');

  const m = normalized.match(/\b([12]\.\d{1,2}|\d{3})\b/);
  if (!m) {
    return { cm: null, note: `Estatura texto: "${s}"` };
  }

  const num = parseFloat(m[1]);
  if (num >= 1.2 && num <= 2.3) {
    return { cm: Math.round(num * 100), note: null };
  }
  if (num >= 120 && num <= 230) {
    return { cm: Math.round(num), note: null };
  }
  return { cm: null, note: `Estatura fuera de rango: "${s}"` };
}

function parseMeasurementCm(raw: string, label: string): { value: number | null; note: string | null } {
  const s = (raw || '').trim();
  if (!s || /^(no s[eé]|ni idea|-|\.|x)$/i.test(s)) {
    return { value: null, note: null };
  }
  // Pure cm like "86", "86cm", "90 cm"
  const m = s.match(/^(\d{2,3})(?:\.\d+)?\s*(?:cm)?$/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 45 && n <= 165) {
      return { value: n, note: null };
    }
  }
  // E.g. "0.80cm" -> 80 cm
  const mDec = s.match(/^0\.(\d{2})\s*(?:cm|m)?$/i);
  if (mDec) {
    return { value: parseInt(mDec[1], 10), note: null };
  }
  // Keep original value like "34B", "XS", "32 pulgadas" in notes without guessing wrong cm
  return { value: null, note: `${label} orig.: ${s}` };
}

function cleanHairCondition(raw: string): string | null {
  const s = (raw || '').trim();
  if (!s) return null;
  return s
    .replace(/\s*\(Marque solo si está de acuerdo\)/gi, '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' · ');
}

function normalizeTextChoice(raw: string): string | null {
  const s = (raw || '').trim().replace(/\s+/g, ' ');
  if (!s || /^(no tengo|-|\.)$/i.test(s)) return null;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function cleanShoeSize(raw: string): string | null {
  const s = (raw || '').trim();
  if (!s || /^(-|\.)$/i.test(s)) return null;
  const numMatch = s.match(/\b(3[4-9]|4[0-6](?:\.5)?(?:\s*[-/]\s*(?:3[4-9]|4[0-6]))?)\b/);
  if (numMatch) return numMatch[1].replace(/\s+/g, '');
  return s;
}

function parseBoolYesNo(raw: string, detailText: string, keywordRegex: RegExp): boolean {
  const s = (raw || '').toLowerCase();
  if (s.includes('sí') || s.includes('si')) return true;
  if (!s && detailText && keywordRegex.test(detailText)) return true;
  return false;
}

export function normalizeGoogleFormsCastingCsv(
  rawCsv: string,
  castingRefDate: Date = new Date('2026-11-28T12:00:00-05:00')
): NormalizationResult {
  const matrix = parseCsvMatrix(rawCsv);
  if (matrix.length <= 1) {
    return {
      validRecords: [],
      discardedRecords: [],
      summary: {
        totalRows: 0,
        excludedDancers: 0,
        includedModels: 0,
        includedDancers: 0,
        emptyOrJunkRows: 0,
        internalDuplicatesMerged: 0,
        discardedUnder17OrConflict: 0,
        readyToImport: 0,
        withExtraMissingFields: 0,
        repairedBirthYears: 0,
      },
    };
  }
  return normalizeGoogleFormsRows(matrix.slice(1), castingRefDate);
}

export function normalizeGoogleFormsRows(
  dataRows: string[][],
  castingRefDate: Date = new Date('2026-11-28T12:00:00-05:00')
): NormalizationResult {
  if (!Array.isArray(dataRows) || dataRows.length === 0) {
    return {
      validRecords: [],
      discardedRecords: [],
      summary: {
        totalRows: 0,
        excludedDancers: 0,
        includedModels: 0,
        includedDancers: 0,
        emptyOrJunkRows: 0,
        internalDuplicatesMerged: 0,
        discardedUnder17OrConflict: 0,
        readyToImport: 0,
        withExtraMissingFields: 0,
        repairedBirthYears: 0,
      },
    };
  }

  const excludedDancers = 0;
  let emptyOrJunkRows = 0;

  interface CandidateRow {
    rowNum: number;
    cols: string[];
    talentoType: 'modelo' | 'bailarin';
    tsDate: Date;
    phoneKey: string;
    emailKey: string;
    nameKey: string;
  }

  const preCandidates: CandidateRow[] = [];
  const discardedRecords: DiscardedCsvRecord[] = [];

  dataRows.forEach((rawCols, idx) => {
    const rowNum = idx + 2;
    const cols = Array.from({ length: 33 }, (_, i) => (rawCols[i] || '').trim());
    const talentoRaw = cols[1];
    const isDancer = /bailar/i.test(talentoRaw);
    const talentoType: 'modelo' | 'bailarin' = isDancer ? 'bailarin' : 'modelo';

    const restEmpty = cols.slice(2).every((c) => !c);
    if (restEmpty) {
      emptyOrJunkRows++;
      discardedRecords.push({
        filaOriginal: String(rowNum),
        marcaTemporal: cols[0],
        talento: talentoRaw,
        nombreCompleto: '',
        fechaNacimientoRaw: '',
        edadRaw: '',
        whatsappRaw: '',
        correoRaw: '',
        instagramRaw: '',
        estaturaRaw: '',
        motivo: 'Fila vacía',
      });
      return;
    }

    const nombreRaw = isDancer ? cols[2] || cols[10] : cols[10] || cols[2];
    if (/gennaro\s+esposito|test\s+prueba/i.test(nombreRaw)) {
      emptyOrJunkRows++;
      discardedRecords.push({
        filaOriginal: String(rowNum),
        marcaTemporal: cols[0],
        talento: talentoRaw,
        nombreCompleto: nombreRaw,
        fechaNacimientoRaw: cols[12],
        edadRaw: cols[13] || cols[3],
        whatsappRaw: cols[15] || cols[8],
        correoRaw: cols[16],
        instagramRaw: cols[17] || cols[9],
        estaturaRaw: cols[18] || cols[5],
        motivo: 'Registro de broma o prueba',
      });
      return;
    }

    const phoneParsed = normalizePhoneNumber(cols[15] || cols[8]);
    const emailParsed = normalizeEmailAddress(cols[16]);
    const nameKey = nombreRaw
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!nameKey && phoneParsed.missing && emailParsed.missing) {
      emptyOrJunkRows++;
      discardedRecords.push({
        filaOriginal: String(rowNum),
        marcaTemporal: cols[0],
        talento: talentoRaw,
        nombreCompleto: nombreRaw,
        fechaNacimientoRaw: cols[12],
        edadRaw: cols[13] || cols[3],
        whatsappRaw: cols[15] || cols[8],
        correoRaw: cols[16],
        instagramRaw: cols[17] || cols[9],
        estaturaRaw: cols[18] || cols[5],
        motivo: 'Sin nombre ni medio de contacto',
      });
      return;
    }

    preCandidates.push({
      rowNum,
      cols,
      talentoType,
      tsDate: parseGoogleFormTimestamp(cols[0]),
      phoneKey: phoneParsed.phoneKey,
      emailKey: emailParsed.emailKey,
      nameKey,
    });
  });

  // Deduplicate internal submissions (merge oldest -> newest so latest wins while keeping prior valid fields)
  const groups: CandidateRow[][] = [];
  const keyToGroup = new Map<string, number>();

  for (const item of preCandidates) {
    let gIdx: number | undefined;
    if (item.phoneKey && keyToGroup.has(`P:${item.phoneKey}`)) {
      gIdx = keyToGroup.get(`P:${item.phoneKey}`);
    } else if (item.emailKey && keyToGroup.has(`E:${item.emailKey}`)) {
      gIdx = keyToGroup.get(`E:${item.emailKey}`);
    } else if (item.nameKey && keyToGroup.has(`N:${item.nameKey}`)) {
      // Only group by exact name if phones don't clash
      const candidateGroupIdx = keyToGroup.get(`N:${item.nameKey}`)!;
      const existingPhone = groups[candidateGroupIdx].find((g) => g.phoneKey)?.phoneKey;
      if (!existingPhone || !item.phoneKey || existingPhone === item.phoneKey) {
        gIdx = candidateGroupIdx;
      }
    }

    if (gIdx === undefined) {
      gIdx = groups.length;
      groups.push([]);
    }
    groups[gIdx].push(item);
    if (item.phoneKey) keyToGroup.set(`P:${item.phoneKey}`, gIdx);
    if (item.emailKey) keyToGroup.set(`E:${item.emailKey}`, gIdx);
    if (item.nameKey) keyToGroup.set(`N:${item.nameKey}`, gIdx);
  }

  const internalDuplicatesMerged = preCandidates.length - groups.length;

  const validRecords: NormalizedCastingInsert[] = [];
  let discardedUnder17OrConflict = 0;
  let repairedBirthYears = 0;
  let withExtraMissingFields = 0;
  let includedModels = 0;
  let includedDancers = 0;

  for (const group of groups) {
    const sorted = [...group].sort((a, b) => a.tsDate.getTime() - b.tsDate.getTime());
    const newest = sorted[sorted.length - 1];
    const merged = [...newest.cols];

    for (let i = sorted.length - 2; i >= 0; i--) {
      for (let c = 0; c < 33; c++) {
        if (!merged[c] && sorted[i].cols[c]) {
          merged[c] = sorted[i].cols[c];
        }
      }
    }

    const isDancer = sorted.some((s) => s.talentoType === 'bailarin') || /bailar/i.test(merged[1]);
    const talentoType: 'modelo' | 'bailarin' = isDancer ? 'bailarin' : 'modelo';
    const nombreRaw = isDancer ? merged[2] || merged[10] : merged[10] || merged[2];
    const dobResult = parseAndRepairDob(
      merged[12],
      merged[13] || merged[3],
      newest.tsDate,
      castingRefDate
    );

    if (dobResult.conflictReason || dobResult.edad === null || dobResult.edad < 17) {
      const reason =
        dobResult.conflictReason ||
        (dobResult.edad !== null && dobResult.edad < 17
          ? `Menor de 17 años (${dobResult.edad} años)`
          : 'Sin fecha de nacimiento ni edad válida');
      discardedUnder17OrConflict++;
      discardedRecords.push({
        filaOriginal: String(newest.rowNum),
        marcaTemporal: merged[0],
        talento: merged[1],
        nombreCompleto: nombreRaw,
        fechaNacimientoRaw: merged[12],
        edadRaw: merged[13] || merged[3],
        whatsappRaw: merged[15] || merged[8],
        correoRaw: merged[16],
        instagramRaw: merged[17] || merged[9],
        estaturaRaw: merged[18] || merged[5],
        motivo: reason,
      });
      continue;
    }

    if (dobResult.repaired) {
      repairedBirthYears++;
    }

    const { nombre, apellidos, missingApellidos } = splitFullName(nombreRaw);
    const phone = normalizePhoneNumber(merged[15] || merged[8]);
    const email = normalizeEmailAddress(merged[16]);
    const social = normalizeSocialHandles(merged[17] || merged[9]);
    const height = parseHeightCm(merged[18] || merged[5]);
    const busto = parseMeasurementCm(merged[19], 'Busto');
    const cintura = parseMeasurementCm(merged[20], 'Cintura');
    const caderas = parseMeasurementCm(merged[21], 'Cadera');
    const tallaSuperior = merged[22] ? merged[22].toUpperCase() : null;
    const tallaInferior = merged[23] ? merged[23].toUpperCase() : null;
    const calzado = cleanShoeSize(merged[24]);
    const colorCabello = normalizeTextChoice(merged[25]);
    const largoCabello = normalizeTextChoice(merged[26]);
    const estadoCabello = cleanHairCondition(merged[27]);
    const colorOjos = normalizeTextChoice(merged[28]);
    const tonoPiel = normalizeTextChoice(merged[29]);
    const detallePyT = merged[32] ? merged[32].trim() : null;
    const tienePiercings = parseBoolYesNo(merged[30], detallePyT || '', /piercing|arete|ombligo|lengua|ceja|nariz/i);
    const tieneTatuajes = parseBoolYesNo(merged[31], detallePyT || '', /tatuaje|tattoo|tatoo/i);
    const ciudad = merged[14] ? toTitleCaseSpanish(merged[14]) : 'No especificada';
    const nombreArtistico = merged[11] && !/^no$/i.test(merged[11].trim()) ? toTitleCaseSpanish(merged[11]) : null;
    const genero = normalizeTextChoice(merged[4]);
    const formacionArtistica = normalizeTextChoice(merged[6]);
    const nivelEnsenanza = normalizeTextChoice(merged[7]);

    const candidateRecord: NormalizedCastingInsert = {
      nombre,
      apellidos,
      fecha_nacimiento: dobResult.fechaNacimiento,
      edad: dobResult.edad,
      ciudad,
      whatsapp: phone.primary,
      correo: email.email,
      instagram: social.instagram,
      estatura: height.cm,
      busto: busto.value,
      cintura: cintura.value,
      caderas: caderas.value,
      talla_superior: tallaSuperior,
      talla_inferior: tallaInferior,
      calzado,
      color_cabello: colorCabello,
      largo_cabello: largoCabello,
      color_ojos: colorOjos,
      tono_piel: tonoPiel,
      tiene_piercings: tienePiercings,
      tiene_tatuajes: tieneTatuajes,
      detalle_piercings_tatuajes: detallePyT || null,
      foto_cara: null,
      foto_cuerpo: null,
      origen: 'google_form',
      talento: talentoType,
      genero,
      formacion_artistica: formacionArtistica,
      nivel_ensenanza: nivelEnsenanza,
      nombre_artistico: nombreArtistico,
      estado_cabello: estadoCabello,
      tiktok: social.tiktok,
      notas_importacion: null,
      datos_incompletos: true,
      campos_faltantes: ['fotos'],
      estado: 'pendiente',
      created_at: newest.tsDate.toISOString(),
    };

    const missingFields = computeMissingCastingFields(candidateRecord);
    if (missingApellidos && !missingFields.includes('nombre_completo')) {
      missingFields.push('nombre_completo');
    }
    candidateRecord.campos_faltantes = missingFields;
    candidateRecord.datos_incompletos = missingFields.length > 0;

    if (missingFields.length > 1) {
      withExtraMissingFields++;
    }

    const notes = [
      dobResult.repairNote,
      phone.extraNotes,
      height.note,
      busto.note,
      cintura.note,
      caderas.note,
      sorted.length > 1 ? `Fusionado de ${sorted.length} envíos repetidos` : null,
    ].filter(Boolean);
    candidateRecord.notas_importacion = notes.length > 0 ? notes.join(' | ') : null;

    if (talentoType === 'bailarin') includedDancers++;
    else includedModels++;

    validRecords.push(candidateRecord);
  }

  return {
    validRecords,
    discardedRecords,
    summary: {
      totalRows: dataRows.length,
      excludedDancers,
      includedModels,
      includedDancers,
      emptyOrJunkRows,
      internalDuplicatesMerged,
      discardedUnder17OrConflict,
      readyToImport: validRecords.length,
      withExtraMissingFields,
      repairedBirthYears,
    },
  };
}

export function findMatchingApplicationInDb(
  candidate: NormalizedCastingInsert,
  existingApps: CastingApplication[]
): CastingApplication | null {
  const candPhone = candidate.whatsapp.replace(/\D/g, '').slice(-8);
  const candEmail =
    candidate.correo && candidate.correo !== 'No especificado' ? candidate.correo.toLowerCase() : '';
  const candName = `${candidate.nombre} ${candidate.apellidos}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  for (const existing of existingApps) {
    const exPhone = (existing.whatsapp || '').replace(/\D/g, '').slice(-8);
    if (candPhone.length >= 8 && exPhone.length >= 8 && candPhone === exPhone) {
      return existing;
    }
    const exEmail = (existing.correo || '').trim().toLowerCase();
    if (candEmail && exEmail && exEmail !== 'no especificado' && candEmail === exEmail) {
      return existing;
    }
    const exName = `${existing.nombre || ''} ${existing.apellidos || ''}`
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (
      candName &&
      exName &&
      candName === exName &&
      candidate.fecha_nacimiento &&
      existing.fecha_nacimiento &&
      candidate.fecha_nacimiento === existing.fecha_nacimiento
    ) {
      return existing;
    }
  }
  return null;
}

export function findExistingDuplicateInDb(
  candidate: NormalizedCastingInsert,
  existingApps: CastingApplication[]
): boolean {
  return findMatchingApplicationInDb(candidate, existingApps) !== null;
}

const isPlaceholderOrEmpty = (val: unknown): boolean => {
  if (val === null || val === undefined) return true;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    return (
      !s ||
      s === 'no especificado' ||
      s === 'no especificada' ||
      s === 'por completar' ||
      s === 'sin nombre'
    );
  }
  return false;
};

export function computeMissingCastingFields(record: Partial<CastingApplication>): string[] {
  const missing: string[] = [];
  const isDancer = record.talento === 'bailarin';
  if (!record.foto_cara || !record.foto_cuerpo) missing.push('fotos');
  if (isPlaceholderOrEmpty(record.nombre) || isPlaceholderOrEmpty(record.apellidos)) {
    missing.push('nombre_completo');
  }
  if (isPlaceholderOrEmpty(record.whatsapp)) missing.push('whatsapp');
  if (isPlaceholderOrEmpty(record.correo)) missing.push('correo');
  if (isPlaceholderOrEmpty(record.instagram)) missing.push('instagram');
  if (!record.estatura) missing.push('estatura');

  if (isDancer) {
    if (isPlaceholderOrEmpty(record.genero)) missing.push('genero');
    if (isPlaceholderOrEmpty(record.formacion_artistica)) missing.push('formacion_artistica');
    if (isPlaceholderOrEmpty(record.nivel_ensenanza)) missing.push('nivel_ensenanza');
    return missing;
  }

  if (!record.fecha_nacimiento) missing.push('fecha_nacimiento');
  if (isPlaceholderOrEmpty(record.ciudad)) missing.push('ciudad');
  if (isPlaceholderOrEmpty(record.talla_superior)) missing.push('talla_superior');
  if (isPlaceholderOrEmpty(record.talla_inferior)) missing.push('talla_inferior');
  if (isPlaceholderOrEmpty(record.calzado)) missing.push('calzado');
  if (isPlaceholderOrEmpty(record.color_cabello)) missing.push('color_cabello');
  if (isPlaceholderOrEmpty(record.largo_cabello)) missing.push('largo_cabello');
  if (isPlaceholderOrEmpty(record.color_ojos)) missing.push('color_ojos');
  if (isPlaceholderOrEmpty(record.tono_piel)) missing.push('tono_piel');
  return missing;
}

export function computeApplicationMergePatch(
  existing: CastingApplication,
  incoming: NormalizedCastingInsert
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};

  const fillIfEmpty = <K extends keyof CastingApplication & keyof NormalizedCastingInsert>(field: K) => {
    const currentVal = existing[field];
    const nextVal = incoming[field];
    if (isPlaceholderOrEmpty(currentVal) && !isPlaceholderOrEmpty(nextVal)) {
      patch[field as string] = nextVal;
    }
  };

  fillIfEmpty('nombre');
  fillIfEmpty('apellidos');
  fillIfEmpty('fecha_nacimiento');
  fillIfEmpty('ciudad');
  fillIfEmpty('whatsapp');
  fillIfEmpty('correo');
  fillIfEmpty('instagram');
  fillIfEmpty('estatura');
  fillIfEmpty('busto');
  fillIfEmpty('cintura');
  fillIfEmpty('caderas');
  fillIfEmpty('talla_superior');
  fillIfEmpty('talla_inferior');
  fillIfEmpty('calzado');
  fillIfEmpty('color_cabello');
  fillIfEmpty('largo_cabello');
  fillIfEmpty('color_ojos');
  fillIfEmpty('tono_piel');
  fillIfEmpty('talento');
  fillIfEmpty('genero');
  fillIfEmpty('formacion_artistica');
  fillIfEmpty('nivel_ensenanza');
  fillIfEmpty('nombre_artistico');
  fillIfEmpty('estado_cabello');
  fillIfEmpty('tiktok');
  fillIfEmpty('detalle_piercings_tatuajes');

  if (!existing.tiene_piercings && incoming.tiene_piercings) {
    patch.tiene_piercings = true;
  }
  if (!existing.tiene_tatuajes && incoming.tiene_tatuajes) {
    patch.tiene_tatuajes = true;
  }

  if (Object.keys(patch).length === 0) {
    return null;
  }

  if (incoming.notas_importacion && !existing.notas_importacion) {
    patch.notas_importacion = incoming.notas_importacion;
  }

  const mergedState: Partial<CastingApplication> = { ...existing, ...patch };
  const recomputedMissing = computeMissingCastingFields(mergedState);
  patch.campos_faltantes = recomputedMissing;
  patch.datos_incompletos = recomputedMissing.length > 0;

  return patch;
}

export function buildDiscardedCsvContent(records: DiscardedCsvRecord[]): string {
  const headers = [
    'Fila Original CSV',
    'Marca Temporal',
    'Talento',
    'Nombre Completo',
    'Fecha Nacimiento (Raw)',
    'Edad (Raw)',
    'WhatsApp (Raw)',
    'Correo (Raw)',
    'Instagram/Redes (Raw)',
    'Estatura (Raw)',
    'Motivo Descarte / Observación',
  ];
  const escapeCell = (val: string) => {
    const s = String(val ?? '');
    if (/[",\n\r]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [
    headers.map(escapeCell).join(','),
    ...records.map((r) =>
      [
        r.filaOriginal,
        r.marcaTemporal,
        r.talento,
        r.nombreCompleto,
        r.fechaNacimientoRaw,
        r.edadRaw,
        r.whatsappRaw,
        r.correoRaw,
        r.instagramRaw,
        r.estaturaRaw,
        r.motivo,
      ]
        .map(escapeCell)
        .join(',')
    ),
  ];
  return '\uFEFF' + lines.join('\r\n');
}
