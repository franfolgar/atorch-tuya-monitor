import dashboardHtml from "./dashboard.html";
import loginHtml from "./login.html";
import { selectRows, type SupabaseEnv } from "./supabase";
import { hmacSha256HexUpper, sha256Hex } from "./tuya";

/** Subconjunto del binding Rate Limiting de Cloudflare que usamos. */
export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface DashboardEnv extends SupabaseEnv {
  /** Contraseña del dashboard y de /debug. Mínimo MIN_PASSWORD_LENGTH caracteres. */
  DASHBOARD_PASSWORD?: string;
  READ_INTERVAL_MINUTES?: string;
  /** Zona horaria IANA para agrupar días y mostrar horas. Por defecto Europe/Madrid. */
  TIMEZONE?: string;
  /** Intentos de login por IP (wrangler.toml, [[ratelimits]]). */
  LOGIN_LIMITER_IP?: Limiter;
  /** Intentos de login de todo el mundo juntos, contra ataques desde muchas IPs. */
  LOGIN_LIMITER_GLOBAL?: Limiter;
}

export const MIN_PASSWORD_LENGTH = 12;
const DEFAULT_TIMEZONE = "Europe/Madrid";
const TIMEZONE_RE = /^(?:[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){0,2}|UTC)$/;

/** Zona horaria validada: solo letras, números y / _ + -, así que es segura en HTML, JS y SQL. */
export function timezoneOf(env: DashboardEnv): string {
  const tz = env.TIMEZONE?.trim();
  return tz && TIMEZONE_RE.test(tz) ? tz : DEFAULT_TIMEZONE;
}

/** La contraseña configurada, o null si falta o es demasiado corta. */
export function configuredPassword(env: DashboardEnv): string | null {
  const password = env.DASHBOARD_PASSWORD;
  return password && password.length >= MIN_PASSWORD_LENGTH ? password : null;
}

const COOKIE_NAME = "atm_session";
const SESSION_DAYS = 30;
const DAY_MS = 86_400_000;
const NO_STORE = { "Cache-Control": "no-store" };

/** Comparación en tiempo constante: compara los hashes, no el texto. */
export async function keysMatch(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Hex(given), sha256Hex(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// La sesión va firmada con la contraseña: al cambiarla se cierran todas las sesiones.
function signSession(expiry: string, key: string): Promise<string> {
  return hmacSha256HexUpper(key, `session:${expiry}`);
}

async function createSessionCookie(key: string): Promise<string> {
  const expiry = String(Date.now() + SESSION_DAYS * DAY_MS);
  const value = `${expiry}.${await signSession(expiry, key)}`;
  const maxAge = SESSION_DAYS * 86_400;
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

async function hasValidSession(request: Request, key: string): Promise<boolean> {
  const cookies = request.headers.get("Cookie") ?? "";
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match?.[1]) return false;
  const [expiry, signature] = match[1].split(".");
  if (!expiry || !signature || !(Number(expiry) > Date.now())) return false;
  return keysMatch(signature, await signSession(expiry, key));
}

const LOGIN_MESSAGES = {
  none: { status: 200, text: "" },
  wrong: { status: 401, text: "Contraseña incorrecta." },
  limited: { status: 429, text: "Demasiados intentos. Espera un minuto y vuelve a probar." },
  origin: { status: 403, text: "Petición no válida. Recarga la página." },
} as const;

function loginPage(kind: keyof typeof LOGIN_MESSAGES): Response {
  const { status, text } = LOGIN_MESSAGES[kind];
  return new Response(loginHtml.replace("__ERROR__", text), {
    status,
    headers: {
      ...NO_STORE,
      ...(kind === "limited" ? { "Retry-After": "60" } : {}),
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

function dashboardPage(env: DashboardEnv): Response {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const html = dashboardHtml.replaceAll("__NONCE__", nonce).replaceAll("__TIMEZONE__", timezoneOf(env));
  return new Response(html, {
    headers: {
      ...NO_STORE,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; ` +
        "connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}

function query(params: Record<string, string>): URLSearchParams {
  return new URLSearchParams(params);
}

/**
 * Datos de la página. Une las respuestas de Supabase como texto, sin parsearlas,
 * para no gastar la CPU limitada del plan gratuito. Supabase devuelve como mucho
 * 1.000 filas por consulta; dos páginas cubren 24 h incluso leyendo cada minuto.
 */
async function handleSummary(env: DashboardEnv): Promise<Response> {
  const now = Date.now();
  const since24h = new Date(now - DAY_MS).toISOString();
  const since30d = new Date(now - 31 * DAY_MS).toISOString();
  const readingsPage = (offset: string) =>
    selectRows(
      env,
      "energy_readings",
      query({
        select: "ts,power_w",
        ts: `gte.${since24h}`,
        order: "ts.desc",
        limit: "1000",
        offset,
      }),
    );

  const [latest, page1, page2, hourly, daily, errors] = await Promise.all([
    selectRows(
      env,
      "energy_readings",
      query({
        select: "ts,power_w,voltage_v,current_a,relay_on",
        order: "ts.desc",
        limit: "1",
      }),
    ),
    readingsPage("0"),
    readingsPage("1000"),
    selectRows(
      env,
      "energy_hourly",
      query({
        select: "hour_start,kwh,kwh_counter,avg_power_w,max_power_w,samples",
        hour_start: `gte.${since30d}`,
        order: "hour_start.asc",
        limit: "1000",
      }),
    ),
    selectRows(
      env,
      "energy_daily",
      query({
        select: "day,kwh,kwh_counter,avg_power_w,max_power_w,samples",
        order: "day.desc",
        limit: "40",
      }),
    ),
    selectRows(
      env,
      "energy_errors",
      query({
        select: "ts,stage,message",
        ts: `gte.${since24h}`,
        order: "ts.desc",
        limit: "20",
      }),
    ),
  ]);

  const interval = Number(env.READ_INTERVAL_MINUTES);
  const intervalMinutes = Number.isInteger(interval) && interval >= 1 ? interval : 1;
  const body =
    `{"intervalMinutes":${intervalMinutes},"latest":${latest},"readingPages":[${page1},${page2}],` +
    `"hourly":${hourly},"daily":${daily},"errors":${errors}}`;
  return new Response(body, {
    headers: { ...NO_STORE, "Content-Type": "application/json; charset=utf-8" },
  });
}

const DATASETS = {
  readings: {
    table: "energy_readings",
    column: "ts",
    select: "ts,power_w,voltage_v,current_a,relay_on,raw",
    byDay: false,
  },
  hourly: {
    table: "energy_hourly",
    column: "hour_start",
    select: "hour_start,kwh,kwh_counter,kwh_estimated,samples,avg_power_w,max_power_w",
    byDay: false,
  },
  daily: {
    table: "energy_daily",
    column: "day",
    select: "day,kwh,kwh_counter,kwh_estimated,samples,avg_power_w,max_power_w,archived",
    byDay: true,
  },
} as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:\d{2})?)$/;

function isRealDate(value: string): boolean {
  return DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/**
 * Una página de la exportación. El navegador pide páginas hasta tenerlo todo,
 * así que el tamaño no choca con los límites por petición del Worker.
 * Las fechas `from` y `to` son días completos en la zona horaria configurada.
 */
async function handleExport(url: URL, env: DashboardEnv): Promise<Response> {
  const name = url.searchParams.get("dataset") ?? "";
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const after = url.searchParams.get("after");

  if (!Object.hasOwn(DATASETS, name)) return jsonError(400, "Conjunto de datos no válido");
  const dataset = DATASETS[name as keyof typeof DATASETS];
  if (!isRealDate(from) || !isRealDate(to) || from > to) {
    return jsonError(400, "Fechas no válidas");
  }
  if (after && !(dataset.byDay ? isRealDate(after) : INSTANT_RE.test(after))) {
    return jsonError(400, "Cursor no válido");
  }

  const tz = timezoneOf(env);
  const params = query({
    select: dataset.select,
    order: `${dataset.column}.asc`,
    limit: "1000",
  });
  if (dataset.byDay) {
    params.append(dataset.column, `gte.${from}`);
    params.append(dataset.column, `lte.${to}`);
  } else {
    params.append(dataset.column, `gte.${from} 00:00:00 ${tz}`);
    params.append(dataset.column, `lt.${nextDay(to)} 00:00:00 ${tz}`);
  }
  if (after) params.append(dataset.column, `gt.${after}`);

  return new Response(await selectRows(env, dataset.table, params), {
    headers: { ...NO_STORE, "Content-Type": "application/json; charset=utf-8" },
  });
}

/** true si la petición lleva una sesión válida. */
export async function isAuthenticated(request: Request, env: DashboardEnv): Promise<boolean> {
  const key = configuredPassword(env);
  return key !== null && hasValidSession(request, key);
}

/** Rechaza formularios enviados desde otra web (CSRF en login y logout). */
function isSameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  return origin === null || origin === url.origin;
}

/**
 * Límite de intentos de login: uno por IP y otro global. Si el binding no está
 * configurado se deja pasar, pero la contraseña larga obligatoria sigue protegiendo.
 */
async function loginAllowed(request: Request, env: DashboardEnv): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const [perIp, global] = await Promise.all([
    env.LOGIN_LIMITER_IP?.limit({ key: `login:${ip}` }),
    env.LOGIN_LIMITER_GLOBAL?.limit({ key: "login:all" }),
  ]);
  return perIp?.success !== false && global?.success !== false;
}

const NOT_CONFIGURED =
  `Falta configurar DASHBOARD_PASSWORD (mínimo ${MIN_PASSWORD_LENGTH} caracteres). ` +
  "Las lecturas se siguen guardando.";

/** Atiende la web: inicio de sesión, página y datos. */
export async function handleDashboard(request: Request, url: URL, env: DashboardEnv): Promise<Response> {
  const key = configuredPassword(env);
  if (!key) {
    return new Response(NOT_CONFIGURED, {
      status: 503,
      headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const { pathname } = url;

  if (request.method === "POST" && pathname === "/login") {
    if (!isSameOrigin(request, url)) return loginPage("origin");
    if (!(await loginAllowed(request, env))) return loginPage("limited");
    const form = await request.formData().catch(() => null);
    const password = form?.get("password");
    if (typeof password !== "string" || !(await keysMatch(password, key))) return loginPage("wrong");
    return new Response(null, {
      status: 303,
      headers: { ...NO_STORE, Location: "/", "Set-Cookie": await createSessionCookie(key) },
    });
  }

  if (request.method === "POST" && pathname === "/logout") {
    if (!isSameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
    return new Response(null, {
      status: 303,
      headers: {
        ...NO_STORE,
        Location: "/",
        "Set-Cookie": `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
      },
    });
  }

  if (request.method !== "GET") return new Response("Not found", { status: 404 });
  const authed = await hasValidSession(request, key);

  if (pathname === "/") return authed ? dashboardPage(env) : loginPage("none");

  if (pathname === "/api/summary" || pathname === "/api/export") {
    if (!authed) return jsonError(401, "Sesión caducada");
    try {
      return pathname === "/api/summary" ? await handleSummary(env) : await handleExport(url, env);
    } catch (err) {
      console.log(`[atorch-monitor] Error en ${pathname}: ${String(err)}`);
      return jsonError(502, "No se pudieron leer los datos de Supabase");
    }
  }

  return new Response("Not found", { status: 404 });
}
