import { handleDashboard, isAuthenticated, type DashboardEnv } from "./dashboard";
import { DP_MAPPING, RELAY_CODES, mapStatus, type TuyaStatusItem } from "./mapping";
import { insertRow } from "./supabase";
import {
  getDeviceSpecification,
  getDeviceStatus,
  type DeviceSpecification,
  type TuyaEnv,
} from "./tuya";

export interface Env extends TuyaEnv, DashboardEnv {
  LOG_ERRORS_TO_DB?: string;
}

/** Decide si toca leer en este minuto, alineado con el reloj. */
export function shouldRun(scheduledTime: number, intervalSetting: string | undefined): boolean {
  const parsed = Number(intervalSetting);
  const interval = Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
  return Math.floor(scheduledTime / 60_000) % interval === 0;
}

async function logFailure(env: Env, stage: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  console.log(`[atorch-monitor] Error en ${stage}: ${message}`);
  if (env.LOG_ERRORS_TO_DB !== "true") return;
  try {
    await insertRow(env, "energy_errors", { stage, message });
  } catch (dbErr) {
    console.log(`[atorch-monitor] No se pudo guardar el error: ${String(dbErr)}`);
  }
}

/** Una lectura completa. Nunca lanza errores, para no romper el cron. */
export async function collectReading(env: Env): Promise<void> {
  let status: TuyaStatusItem[];
  try {
    status = await getDeviceStatus(env);
  } catch (err) {
    await logFailure(env, "tuya", err);
    return;
  }

  try {
    await insertRow(env, "energy_readings", { ...mapStatus(status), raw: status });
  } catch (err) {
    await logFailure(env, "supabase", err);
  }
}

function mappedFieldFor(code: string): string | null {
  for (const [field, config] of Object.entries(DP_MAPPING)) {
    if (config.codes.includes(code)) return field;
  }
  return RELAY_CODES.includes(code) ? "relay_on" : null;
}

function parseSpecValues(values: string | undefined): { unit?: string; scale?: number } {
  try {
    return values ? JSON.parse(values) : {};
  } catch {
    return {};
  }
}

/** Una fila por DP: valor crudo, escala declarada por Tuya y columna a la que va. */
export function buildDpTable(status: TuyaStatusItem[], spec: DeviceSpecification | null) {
  return status.map(({ code, value }) => {
    const specItem = spec?.status?.find((s) => s.code === code);
    const { unit, scale } = parseSpecValues(specItem?.values);
    return {
      code,
      raw_value: value,
      type: specItem?.type ?? null,
      unit: unit ?? null,
      spec_scale: scale ?? null,
      value_with_spec_scale:
        typeof value === "number" && typeof scale === "number" ? value / 10 ** scale : null,
      mapped_to: mappedFieldFor(code),
    };
  });
}

async function handleDebug(env: Env): Promise<Response> {
  const [statusResult, specResult] = await Promise.allSettled([
    getDeviceStatus(env),
    getDeviceSpecification(env),
  ]);
  const status = statusResult.status === "fulfilled" ? statusResult.value : null;
  const specification = specResult.status === "fulfilled" ? specResult.value : null;

  return Response.json(
    {
      dp_table: status ? buildDpTable(status, specification) : null,
      mapped_preview: status ? mapStatus(status) : null,
      status,
      specification,
      errors: {
        status: statusResult.status === "rejected" ? String(statusResult.reason) : null,
        specification: specResult.status === "rejected" ? String(specResult.reason) : null,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Cabeceras de seguridad comunes a todas las respuestas. */
export function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Strict-Transport-Security", "max-age=31536000");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/debug") return handleDashboard(request, url, env);
  // /debug gasta llamadas de Tuya y enseña datos del dispositivo: solo con sesión iniciada.
  if (request.method !== "GET") return new Response("Not found", { status: 404 });
  if (!(await isAuthenticated(request, env))) {
    return new Response("Inicia sesión en el dashboard y vuelve a abrir /debug", { status: 401 });
  }
  return handleDebug(env);
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (!shouldRun(controller.scheduledTime, env.READ_INTERVAL_MINUTES)) return;
    await collectReading(env);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    return withSecurityHeaders(await route(request, env));
  },
} satisfies ExportedHandler<Env>;
