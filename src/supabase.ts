export interface SupabaseEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
}

function authHeaders(env: SupabaseEnv): Record<string, string> {
  const headers: Record<string, string> = { apikey: env.SUPABASE_SERVICE_KEY };
  // Las claves service_role antiguas son JWT; las nuevas sb_secret_ solo van en apikey.
  if (env.SUPABASE_SERVICE_KEY.startsWith("eyJ")) {
    headers.Authorization = `Bearer ${env.SUPABASE_SERVICE_KEY}`;
  }
  return headers;
}

function restUrl(env: SupabaseEnv, table: string): string {
  return `${env.SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/${table}`;
}

/** Inserta una fila por PostgREST. Lanza un error si la respuesta no es correcta. */
export async function insertRow(
  env: SupabaseEnv,
  table: string,
  row: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(restUrl(env, table), {
    method: "POST",
    headers: {
      ...authHeaders(env),
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    throw new Error(`Supabase ${table}: HTTP ${res.status}: ${await res.text()}`);
  }
}

/** Lee filas por PostgREST y devuelve el JSON como texto, sin parsearlo. */
export async function selectRows(
  env: SupabaseEnv,
  table: string,
  params: URLSearchParams,
): Promise<string> {
  const res = await fetch(`${restUrl(env, table)}?${params}`, { headers: authHeaders(env) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${table}: HTTP ${res.status}: ${text}`);
  return text;
}
