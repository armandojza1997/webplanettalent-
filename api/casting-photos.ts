async function verifySupabaseAdmin(req: any): Promise<boolean> {
  const authHeader = req?.headers?.authorization;
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token || token.length > 4096) return false;

  const supabaseUrl = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  const supabaseAnonKey = (process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
  if (!supabaseUrl || !supabaseAnonKey) return false;

  try {
    const authRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!authRes.ok) return false;
    const user = (await authRes.json()) as { id?: string };
    return Boolean(user?.id);
  } catch {
    return false;
  }
}

export default async function handler(req: any, res: any) {
  const isAdmin = await verifySupabaseAdmin(req);
  if (!isAdmin) {
    return res.status(401).json({ error: 'Sesión de administrador requerida.' });
  }

  if (req.method === 'DELETE') {
    return res.status(200).json({ ok: true, localStorageAvailable: false });
  }

  return res.status(200).json({
    ok: true,
    localStorageAvailable: false,
    records: [],
  });
}
