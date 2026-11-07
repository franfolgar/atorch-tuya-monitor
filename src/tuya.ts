import type { TuyaStatusItem } from "./mapping";

export interface TuyaEnv {
  TUYA_BASE_URL: string;
  TUYA_CLIENT_ID: string;
  TUYA_CLIENT_SECRET: string;
  TUYA_DEVICE_ID: string;
  TOKEN_CACHE: KVNamespace;
}

const TOKEN_KV_KEY = "tuya_token";
/** Margen antes de caducar a partir del cual se pide otro token. */
const TOKEN_MARGIN_MS = 5 * 60 * 1000;
/** Códigos de Tuya para token caducado o no válido. */
const TOKEN_ERROR_CODES = new Set([1010, 1011, 1012]);

export class TuyaError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "TuyaError";
  }

  get isTokenError(): boolean {
    return this.code !== undefined && TOKEN_ERROR_CODES.has(this.code);
  }
}

interface CachedToken {
  access_token: string;
  expires_at: number;
}

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

export async function hmacSha256HexUpper(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(text))).toUpperCase();
}

/** Devuelve la ruta con los parámetros de la query ordenados por nombre. */
export function canonicalPath(path: string): string {
  const [base, query] = path.split("?", 2);
  if (!query) return base ?? path;
  return `${base}?${query.split("&").sort().join("&")}`;
}

export interface SignInput {
  clientId: string;
  secret: string;
  method: string;
  path: string;
  t: string;
  nonce: string;
  accessToken?: string;
  body?: string;
  /** Cabeceras firmadas ya formateadas; vacío si no se firma ninguna. */
  signedHeaders?: string;
}

/**
 * Firma de Tuya OpenAPI:
 *   stringToSign = método \n SHA256(body) \n cabeceras \n url con query ordenada
 *   sign = HMAC-SHA256(client_id + access_token + t + nonce + stringToSign, secret)
 * En la petición de token, access_token va vacío.
 */
export async function signRequest(input: SignInput): Promise<string> {
  const stringToSign = [
    input.method.toUpperCase(),
    await sha256Hex(input.body ?? ""),
    input.signedHeaders ?? "",
    canonicalPath(input.path),
  ].join("\n");
  const payload = `${input.clientId}${input.accessToken ?? ""}${input.t}${input.nonce}${stringToSign}`;
  return hmacSha256HexUpper(input.secret, payload);
}

async function tuyaGet<T>(env: TuyaEnv, path: string, accessToken?: string): Promise<T> {
  const t = Date.now().toString();
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const sign = await signRequest({
    clientId: env.TUYA_CLIENT_ID,
    secret: env.TUYA_CLIENT_SECRET,
    method: "GET",
    path,
    t,
    nonce,
    accessToken,
  });

  const headers: Record<string, string> = {
    client_id: env.TUYA_CLIENT_ID,
    sign,
    sign_method: "HMAC-SHA256",
    t,
    nonce,
  };
  if (accessToken) headers.access_token = accessToken;

  const baseUrl = env.TUYA_BASE_URL.replace(/\/+$/, "");
  const res = await fetch(`${baseUrl}${canonicalPath(path)}`, { headers });
  const text = await res.text();

  let json: { success?: boolean; code?: number; msg?: string; result?: T };
  try {
    json = JSON.parse(text);
  } catch {
    throw new TuyaError(`GET ${path}: HTTP ${res.status}, respuesta no JSON`);
  }
  if (!res.ok || !json.success) {
    throw new TuyaError(
      `GET ${path}: HTTP ${res.status}, código ${json.code ?? "?"}: ${json.msg ?? "sin mensaje"}`,
      json.code,
    );
  }
  return json.result as T;
}

async function getToken(env: TuyaEnv, forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    const cached = await env.TOKEN_CACHE.get<CachedToken>(TOKEN_KV_KEY, "json");
    if (cached && cached.expires_at - Date.now() > TOKEN_MARGIN_MS) return cached.access_token;
  }

  const result = await tuyaGet<{ access_token: string; expire_time: number }>(
    env,
    "/v1.0/token?grant_type=1",
  );
  const value: CachedToken = {
    access_token: result.access_token,
    expires_at: Date.now() + result.expire_time * 1000,
  };
  // 60 s es el TTL mínimo que admite KV.
  await env.TOKEN_CACHE.put(TOKEN_KV_KEY, JSON.stringify(value), {
    expirationTtl: Math.max(60, result.expire_time),
  });
  return value.access_token;
}

/** GET autenticado; si el token no vale, lo renueva y reintenta una sola vez. */
async function authedGet<T>(env: TuyaEnv, path: string): Promise<T> {
  const token = await getToken(env);
  try {
    return await tuyaGet<T>(env, path, token);
  } catch (err) {
    if (!(err instanceof TuyaError) || !err.isTokenError) throw err;
    console.log(`Token de Tuya rechazado (código ${err.code}); se renueva y se reintenta`);
    return tuyaGet<T>(env, path, await getToken(env, true));
  }
}

export async function getDeviceStatus(env: TuyaEnv): Promise<TuyaStatusItem[]> {
  const id = encodeURIComponent(env.TUYA_DEVICE_ID);
  try {
    return await authedGet<TuyaStatusItem[]>(env, `/v1.0/iot-03/devices/${id}/status`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`Fallo en iot-03/status, se prueba /v1.0/devices: ${message}`);
    return authedGet<TuyaStatusItem[]>(env, `/v1.0/devices/${id}/status`);
  }
}

export interface SpecStatusItem {
  code: string;
  type?: string;
  /** Tuya lo devuelve como texto JSON: {"unit":"V","min":0,"max":5000,"scale":1,"step":1} */
  values?: string;
}

export interface DeviceSpecification {
  category?: string;
  functions?: SpecStatusItem[];
  status?: SpecStatusItem[];
}

export function getDeviceSpecification(env: TuyaEnv): Promise<DeviceSpecification> {
  const id = encodeURIComponent(env.TUYA_DEVICE_ID);
  return authedGet<DeviceSpecification>(env, `/v1.0/iot-03/devices/${id}/specification`);
}
