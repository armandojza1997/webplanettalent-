import { createClient } from '@supabase/supabase-js';

const viteEnv = (import.meta as any).env || {};
const supabaseUrl = (viteEnv.VITE_SUPABASE_URL || '').trim();
const supabaseAnonKey = (viteEnv.VITE_SUPABASE_ANON_KEY || '').trim();

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

const REFRESH_COOLDOWN_DEFAULT_MS = 60_000;
let refreshCooldownUntil = 0;
let inFlightRefresh: { key: string; promise: Promise<Response> } | null = null;

function makeSyntheticRetryableResponse(message: string): Response {
  return new Response(
    JSON.stringify({
      error: 'temporarily_unavailable',
      message,
    }),
    {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

const rateLimitSafeFetch: typeof fetch = async (input, init) => {
  const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const isRefreshTokenCall =
    urlStr.includes('/auth/v1/token') && urlStr.includes('grant_type=refresh_token');

  if (!isRefreshTokenCall) {
    return fetch(input, init);
  }

  const now = Date.now();
  if (now < refreshCooldownUntil) {
    return makeSyntheticRetryableResponse('Auth refresh cooldown active after rate limit');
  }

  const bodyKey = typeof init?.body === 'string' ? init.body : '';
  const dedupeKey = `${urlStr}|${bodyKey}`;

  if (inFlightRefresh && inFlightRefresh.key === dedupeKey) {
    const sharedRes = await inFlightRefresh.promise;
    return sharedRes.clone();
  }

  const fetchPromise = (async () => {
    const response = await fetch(input, init);
    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retrySeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      const cooldownMs =
        Number.isFinite(retrySeconds) && retrySeconds > 0
          ? Math.min(Math.max(retrySeconds * 1000, 15_000), 300_000)
          : REFRESH_COOLDOWN_DEFAULT_MS;
      refreshCooldownUntil = Date.now() + cooldownMs;
      // Return 503 so @supabase/auth-js treats 429 as AuthRetryableFetchError
      // instead of clearing the user's local session and emitting SIGNED_OUT.
      return makeSyntheticRetryableResponse('Rate limit 429 converted to retryable pause');
    }
    return response;
  })();

  inFlightRefresh = { key: dedupeKey, promise: fetchPromise };
  try {
    const result = await fetchPromise;
    return result.clone();
  } finally {
    if (inFlightRefresh?.promise === fetchPromise) {
      inFlightRefresh = null;
    }
  }
};

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder-anon-key',
  {
    global: {
      fetch: rateLimitSafeFetch,
    },
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  }
);

type SessionResult = Awaited<ReturnType<typeof supabase.auth.getSession>>;
const SESSION_CACHE_TTL_MS = 4_000;
let cachedSessionResult: { data: SessionResult; fetchedAt: number } | null = null;
let inFlightSessionPromise: Promise<SessionResult> | null = null;

export const clearSessionCache = () => {
  cachedSessionResult = null;
};

export const getSessionSingleFlight = async (forceRefresh = false): Promise<SessionResult> => {
  if (
    !forceRefresh &&
    cachedSessionResult &&
    Date.now() - cachedSessionResult.fetchedAt < SESSION_CACHE_TTL_MS
  ) {
    return cachedSessionResult.data;
  }

  if (inFlightSessionPromise) {
    return inFlightSessionPromise;
  }

  const pending = supabase.auth
    .getSession()
    .then((res) => {
      cachedSessionResult = { data: res, fetchedAt: Date.now() };
      return res;
    })
    .finally(() => {
      if (inFlightSessionPromise === pending) {
        inFlightSessionPromise = null;
      }
    });

  inFlightSessionPromise = pending;
  return pending;
};

// Caché global en memoria
let memoryModelsCache: any[] | null = null;
let memoryBookingsCache: any[] | null = null;

/**
 * Helper to run queries with an automatic exponential retry policy for maximum robustness on transient connection drops or cold starts.
 */
const runWithRetry = async (
  queryFn: () => PromiseLike<{ data: any[] | null; error: any }>,
  retries = 3,
  delay = 1200
): Promise<{ data: any[] | null; error: any }> => {
  try {
    const res = await queryFn();
    if (res.error && retries > 0) {
      console.warn(`Error de base de datos transitorio: "${res.error.message}". Reintentando en ${delay}ms... (${retries} intentos restantes)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return runWithRetry(queryFn, retries - 1, delay * 1.5);
    }
    return res;
  } catch (err: any) {
    if (retries > 0) {
      console.warn(`Excepción de conexión con la BD: "${err?.message || err}". Reintentando en ${delay}ms... (${retries} intentos restantes)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return runWithRetry(queryFn, retries - 1, delay * 1.5);
    }
    throw err;
  }
};

export const normalizeModel = (raw: any): any => {
  if (!raw) return raw;
  const isFeatured = raw.destacada === true || 
    (typeof raw.instagram === 'string' && (raw.instagram.split('|')[5] === 'featured' || raw.instagram.includes('|featured')));
  return {
    ...raw,
    destacada: isFeatured
  };
};

export const normalizeModelsList = (list: any[] | null | undefined): any[] => {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeModel);
};

/**
 * Obtiene las modelos usando la estrategia Stale-While-Revalidate (SWR).
 * Si hay datos en caché, los devuelve inmediatamente (0ms) y ejecuta
 * una consulta en segundo plano para actualizar la caché.
 */
export const getCachedModels = async (
  onUpdate?: (data: any[]) => void,
  forceRefresh: boolean = false
): Promise<any[]> => {
  // 1. Comprobar memoria primero
  if (!forceRefresh && memoryModelsCache && memoryModelsCache.length > 0) {
    if (onUpdate) {
      revalidateModels(onUpdate);
    }
    return normalizeModelsList(memoryModelsCache);
  }

  // 2. Comprobar sessionStorage
  if (!forceRefresh) {
    try {
      const cached = sessionStorage.getItem('pt_models_cache');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.length > 0) {
          memoryModelsCache = normalizeModelsList(parsed);
          if (onUpdate) {
            revalidateModels(onUpdate);
          }
          return memoryModelsCache;
        }
      }
    } catch (e) {
      console.warn("Error leyendo modelos de sessionStorage:", e);
    }
  }

  // 3. Consulta directa a Supabase (si no hay caché o se fuerza recarga) con reintentos automáticos
  const { data, error } = await runWithRetry(() => 
    supabase.from('models').select('*').order('nombre')
  );
  if (error) throw error;

  const normalized = normalizeModelsList(data);
  if (normalized) {
    memoryModelsCache = normalized;
    try {
      sessionStorage.setItem('pt_models_cache', JSON.stringify(normalized));
    } catch (e) {
      console.warn("Error guardando modelos en sessionStorage:", e);
    }
  }
  return normalized || [];
};

const revalidateModels = async (onUpdate: (data: any[]) => void) => {
  try {
    const { data, error } = await runWithRetry(() => 
      supabase.from('models').select('*').order('nombre')
    );
    if (!error && data) {
      const normalized = normalizeModelsList(data);
      const oldStr = JSON.stringify(memoryModelsCache || []);
      const newStr = JSON.stringify(normalized);
      if (oldStr !== newStr) {
        memoryModelsCache = normalized;
        try {
          sessionStorage.setItem('pt_models_cache', newStr);
        } catch (e) {}
        onUpdate(normalized);
      }
    }
  } catch (err) {
    console.warn("Error de revalidación de modelos en segundo plano:", err);
  }
};

/**
 * Obtiene las reservas usando la estrategia Stale-While-Revalidate (SWR).
 */
export const getCachedBookings = async (
  onUpdate?: (data: any[]) => void,
  forceRefresh: boolean = false
): Promise<any[]> => {
  if (!forceRefresh && memoryBookingsCache && memoryBookingsCache.length > 0) {
    if (onUpdate) {
      revalidateBookings(onUpdate);
    }
    return memoryBookingsCache;
  }

  if (!forceRefresh) {
    try {
      const cached = sessionStorage.getItem('pt_bookings_cache');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.length > 0) {
          memoryBookingsCache = parsed;
          if (onUpdate) {
            revalidateBookings(onUpdate);
          }
          return parsed;
        }
      }
    } catch (e) {
      console.warn("Error leyendo reservas de sessionStorage:", e);
    }
  }

  const { data, error } = await runWithRetry(() =>
    supabase
      .from('bookings')
      .select('*')
      .order('created_at', { ascending: false })
  );
  if (error) throw error;

  if (data) {
    memoryBookingsCache = data;
    try {
      sessionStorage.setItem('pt_bookings_cache', JSON.stringify(data));
    } catch (e) {
      console.warn("Error guardando reservas en sessionStorage:", e);
    }
  }
  return data || [];
};

const revalidateBookings = async (onUpdate: (data: any[]) => void) => {
  try {
    const { data, error } = await runWithRetry(() =>
      supabase
        .from('bookings')
        .select('*')
        .order('created_at', { ascending: false })
    );
    if (!error && data) {
      const oldStr = JSON.stringify(memoryBookingsCache || []);
      const newStr = JSON.stringify(data);
      if (oldStr !== newStr) {
        memoryBookingsCache = data;
        try {
          sessionStorage.setItem('pt_bookings_cache', newStr);
        } catch (e) {}
        onUpdate(data);
      }
    }
  } catch (err) {
    console.warn("Error de revalidación de reservas en segundo plano:", err);
  }
};

/**
 * Invalida la caché de modelos para forzar una consulta fresca en la próxima llamada.
 */
export const invalidateModelsCache = () => {
  memoryModelsCache = null;
  try {
    sessionStorage.removeItem('pt_models_cache');
  } catch (e) {}
};

/**
 * Invalida la caché de reservas.
 */
export const invalidateBookingsCache = () => {
  memoryBookingsCache = null;
  try {
    sessionStorage.removeItem('pt_bookings_cache');
  } catch (e) {}
};

