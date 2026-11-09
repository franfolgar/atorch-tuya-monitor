/// <reference types="node" />
import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { buildDpTable, collectReading, shouldRun, type Env } from "../src/index";
import { mapStatus } from "../src/mapping";
import { canonicalPath, signRequest } from "../src/tuya";

// Respuesta real del GR2PWS.
const STATUS = [
  { code: "switch_1", value: true },
  { code: "countdown_1", value: 0 },
  { code: "add_ele", value: 0 },
  { code: "cur_current", value: 742 },
  { code: "cur_power", value: 2770 },
  { code: "cur_voltage", value: 23851 },
];

function makeKv(initial?: unknown) {
  const store = new Map<string, string>();
  if (initial) store.set("tuya_token", JSON.stringify(initial));
  const put = vi.fn(async (key: string, value: string) => void store.set(key, value));
  return {
    put,
    get: vi.fn(async (key: string) => {
      const v = store.get(key);
      return v ? JSON.parse(v) : null;
    }),
  };
}

const PASSWORD = "clave-de-prueba-larga";

function makeEnv(kv = makeKv()): Env {
  return {
    TUYA_BASE_URL: "https://openapi.tuyaeu.com",
    TUYA_CLIENT_ID: "client",
    TUYA_CLIENT_SECRET: "secret",
    TUYA_DEVICE_ID: "device1",
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_KEY: "eyJservice",
    DASHBOARD_PASSWORD: PASSWORD,
    LOG_ERRORS_TO_DB: "true",
    TOKEN_CACHE: kv as unknown as KVNamespace,
  };
}

const tuyaOk = (result: unknown) => Response.json({ success: true, result });
const tuyaFail = (code: number, msg: string) => Response.json({ success: false, code, msg });
const VALID_TOKEN = { access_token: "cached", expires_at: Date.now() + 3_600_000 };

let fetchMock: ReturnType<typeof vi.fn>;
const calledUrls = () => fetchMock.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("firma de Tuya", () => {
  const base = { clientId: "cid", secret: "sec", method: "GET", t: "1700000000000", nonce: "abc" };

  it("coincide con un cálculo independiente en la petición de token", async () => {
    const emptyHash = createHash("sha256").update("").digest("hex");
    const expected = createHmac("sha256", "sec")
      .update(`cid1700000000000abcGET\n${emptyHash}\n\n/v1.0/token?grant_type=1`)
      .digest("hex")
      .toUpperCase();
    expect(await signRequest({ ...base, path: "/v1.0/token?grant_type=1" })).toBe(expected);
  });

  it("incluye el access_token, el hash del body y la query ordenada", async () => {
    const bodyHash = createHash("sha256").update('{"a":1}').digest("hex");
    const expected = createHmac("sha256", "sec")
      .update(`cidTOK1700000000000abcPOST\n${bodyHash}\n\n/p?a=1&b=2`)
      .digest("hex")
      .toUpperCase();
    const sign = await signRequest({
      ...base,
      method: "POST",
      accessToken: "TOK",
      path: "/p?b=2&a=1",
      body: '{"a":1}',
    });
    expect(sign).toBe(expected);
  });

  it("ordena la query", () => {
    expect(canonicalPath("/x?z=1&a=2")).toBe("/x?a=2&z=1");
    expect(canonicalPath("/x")).toBe("/x");
  });
});

describe("mapeo", () => {
  it("aplica las escalas y deja a null lo que no está", () => {
    expect(mapStatus(STATUS)).toEqual({
      power_w: 27.7,
      voltage_v: 238.51,
      current_a: 0.742,
      power_factor: null,
      frequency_hz: null,
      energy_kwh: null,
      relay_on: true,
    });
  });

  it("no convierte en 0 los valores no numéricos", () => {
    const m = mapStatus([
      { code: "cur_power", value: "" },
      { code: "cur_voltage", value: "abc" },
      { code: "cur_current", value: null },
    ]);
    expect([m.power_w, m.voltage_v, m.current_a]).toEqual([null, null, null]);
  });
});

describe("intervalo", () => {
  const minute = (n: number) => n * 60_000;
  it("lee solo en los minutos que tocan", () => {
    expect(shouldRun(minute(10), "2")).toBe(true);
    expect(shouldRun(minute(11), "2")).toBe(false);
    expect(shouldRun(minute(11), "5")).toBe(false);
    expect(shouldRun(minute(15), "5")).toBe(true);
  });
  it("con un valor no válido lee cada minuto", () => {
    expect(shouldRun(minute(11), undefined)).toBe(true);
    expect(shouldRun(minute(11), "0")).toBe(true);
    expect(shouldRun(minute(11), "abc")).toBe(true);
  });
});

describe("lectura", () => {
  it("reutiliza el token de KV e inserta la fila con raw", async () => {
    const kv = makeKv(VALID_TOKEN);
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("tuyaeu") ? tuyaOk(STATUS) : new Response(null, { status: 201 }),
    );
    await collectReading(makeEnv(kv));

    expect(calledUrls()).toEqual([
      "https://openapi.tuyaeu.com/v1.0/iot-03/devices/device1/status",
      "https://x.supabase.co/rest/v1/energy_readings",
    ]);
    expect(kv.put).not.toHaveBeenCalled();
    const body = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(body.power_w).toBe(27.7);
    expect(body.raw).toEqual(STATUS);
  });

  it("renueva el token cuando falta poco para caducar", async () => {
    const kv = makeKv({ access_token: "old", expires_at: Date.now() + 60_000 });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/token")) return tuyaOk({ access_token: "new", expire_time: 7200 });
      if (url.includes("tuyaeu")) return tuyaOk(STATUS);
      return new Response(null, { status: 201 });
    });
    await collectReading(makeEnv(kv));
    expect(kv.put).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[1]![1].headers.access_token).toBe("new");
  });

  it("con error de token renueva y reintenta una vez", async () => {
    const kv = makeKv(VALID_TOKEN);
    let statusCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/token")) return tuyaOk({ access_token: "new", expire_time: 7200 });
      if (url.includes("tuyaeu")) {
        return ++statusCalls === 1 ? tuyaFail(1010, "token invalid") : tuyaOk(STATUS);
      }
      return new Response(null, { status: 201 });
    });
    await collectReading(makeEnv(kv));
    expect(statusCalls).toBe(2);
    expect(calledUrls().at(-1)).toContain("energy_readings");
  });

  it("usa /v1.0/devices si iot-03 falla", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("iot-03")) return tuyaFail(1106, "permission deny");
      if (url.includes("tuyaeu")) return tuyaOk(STATUS);
      return new Response(null, { status: 201 });
    });
    await collectReading(makeEnv(makeKv(VALID_TOKEN)));
    expect(calledUrls()).toContain("https://openapi.tuyaeu.com/v1.0/devices/device1/status");
    expect(calledUrls().at(-1)).toContain("energy_readings");
  });

  it("si Tuya falla no lanza y guarda el error", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("tuyaeu") ? tuyaFail(28841004, "quota") : new Response(null, { status: 201 }),
    );
    await expect(collectReading(makeEnv(makeKv(VALID_TOKEN)))).resolves.toBeUndefined();
    expect(calledUrls().at(-1)).toContain("energy_errors");
    expect(calledUrls().join()).not.toContain("energy_readings");
  });

  it("no lanza aunque también falle Supabase", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("tuyaeu") ? tuyaOk(STATUS) : new Response("boom", { status: 500 }),
    );
    await expect(collectReading(makeEnv(makeKv(VALID_TOKEN)))).resolves.toBeUndefined();
  });
});

const sessionCookie = async (env: Env) => {
  const res = await worker.fetch(
    new Request("https://w.dev/login", {
      method: "POST",
      body: new URLSearchParams({ password: PASSWORD }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }),
    env,
  );
  return res.headers.get("Set-Cookie")!.split(";")[0]!;
};

describe("/debug", () => {
  const call = (path: string, env: Env, cookie?: string) =>
    worker.fetch(new Request(`https://w.dev${path}`, { headers: cookie ? { Cookie: cookie } : {} }), env);

  it("sin sesión no llama a Tuya, aunque se pase una clave en la URL", async () => {
    expect((await call(`/debug?key=${PASSWORD}`, makeEnv())).status).toBe(401);
    expect((await call("/debug", makeEnv())).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("da 503 sin contraseña configurada y 404 en otras rutas", async () => {
    expect((await call("/", { ...makeEnv(), DASHBOARD_PASSWORD: undefined })).status).toBe(503);
    expect((await call("/debug", { ...makeEnv(), DASHBOARD_PASSWORD: undefined })).status).toBe(401);
    expect((await call("/otra", makeEnv())).status).toBe(404);
  });

  it("con sesión devuelve el estado crudo y la especificación", async () => {
    const spec = {
      category: "zndb",
      status: [{ code: "cur_voltage", type: "Integer", values: '{"unit":"V","scale":1}' }],
    };
    const env = makeEnv(makeKv(VALID_TOKEN));
    const cookie = await sessionCookie(env);
    fetchMock.mockImplementation(async (url: string) =>
      tuyaOk(url.endsWith("/specification") ? spec : STATUS),
    );
    const res = await call("/debug", env, cookie);
    const json = (await res.json()) as { status: unknown; specification: unknown };
    expect(res.status).toBe(200);
    expect(json.status).toEqual(STATUS);
    expect(json.specification).toEqual(spec);
  });

  it("calcula el valor con la escala de la especificación", () => {
    const [row] = buildDpTable([{ code: "cur_voltage", value: 2297 }], {
      status: [{ code: "cur_voltage", type: "Integer", values: '{"unit":"V","scale":1}' }],
    });
    expect(row).toMatchObject({ unit: "V", value_with_spec_scale: 229.7, mapped_to: "voltage_v" });
  });
});

describe("dashboard", () => {
  const login = (password: string, env: Env, extra: Record<string, string> = {}) =>
    worker.fetch(
      new Request("https://w.dev/login", {
        method: "POST",
        body: new URLSearchParams({ password }),
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...extra },
      }),
      env,
    );
  const get = (path: string, env: Env, cookie?: string) =>
    worker.fetch(
      new Request(`https://w.dev${path}`, { headers: cookie ? { Cookie: cookie } : {} }),
      env,
    );
  const session = sessionCookie;
  const querystring = () => new URL(calledUrls()[0]!).searchParams;

  it("sin sesión muestra el login y no da datos", async () => {
    const env = makeEnv();
    const page = await get("/", env);
    expect(await page.text()).toContain('name="password"');
    expect((await get("/api/summary", env)).status).toBe(401);
    expect((await get("/api/export?dataset=readings&from=2026-11-01&to=2026-11-02", env)).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rechaza una contraseña incorrecta", async () => {
    const res = await login("mala", makeEnv());
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("con la contraseña crea una sesión protegida y muestra la página", async () => {
    const env = makeEnv();
    const res = await login(PASSWORD, env);
    expect(res.status).toBe(303);
    expect(res.headers.get("Set-Cookie")).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    const page = await get("/", env, res.headers.get("Set-Cookie")!.split(";")[0]);
    const nonce = page.headers.get("Content-Security-Policy")!.match(/nonce-([0-9a-f]+)/)![1];
    const html = await page.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).not.toContain("__NONCE__");
  });

  it("rechaza sesiones manipuladas, caducadas o firmadas con otra contraseña", async () => {
    const env = makeEnv();
    const cookie = await session(env);
    const signature = cookie.split(".")[1]!;
    const future = Date.now() + 1e12;
    expect((await get("/api/summary", env, `atm_session=${future}.${signature}`)).status).toBe(401);
    expect((await get("/api/summary", env, "atm_session=1.ABC")).status).toBe(401);
    expect((await get("/api/summary", { ...env, DASHBOARD_PASSWORD: "otra-clave-larga-distinta" }, cookie)).status).toBe(401);
  });

  it("une los datos del resumen en un JSON válido", async () => {
    const env = { ...makeEnv(), READ_INTERVAL_MINUTES: "2" };
    const cookie = await session(env);
    fetchMock.mockImplementation(async (url: string) =>
      new Response(url.includes("energy_errors") ? '[{"stage":"tuya"}]' : "[]"),
    );
    const json = (await (await get("/api/summary", env, cookie)).json()) as Record<string, unknown>;
    expect(json).toEqual({
      intervalMinutes: 2,
      latest: [],
      readingPages: [[], []],
      hourly: [],
      daily: [],
      errors: [{ stage: "tuya" }],
    });
  });

  it("si Supabase falla responde 502 sin filtrar el detalle", async () => {
    const env = makeEnv();
    const cookie = await session(env);
    fetchMock.mockImplementation(async () => new Response("detalle interno", { status: 500 }));
    const res = await get("/api/summary", env, cookie);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("detalle interno");
  });

  it("exporta por días completos en la zona horaria, con cursor", async () => {
    const env = makeEnv();
    const cookie = await session(env);
    fetchMock.mockImplementation(async () => new Response("[]"));
    const after = "2026-11-05T10:00:00.123456+00:00";
    const res = await get(
      `/api/export?dataset=readings&from=2026-11-01&to=2026-11-30&after=${encodeURIComponent(after)}`,
      env,
      cookie,
    );
    expect(res.status).toBe(200);
    expect(calledUrls()[0]).toContain("/rest/v1/energy_readings?");
    expect(querystring().getAll("ts")).toEqual([
      "gte.2026-11-01 00:00:00 Europe/Madrid",
      "lt.2026-12-01 00:00:00 Europe/Madrid",
      `gt.${after}`,
    ]);
  });

  it("no acepta parámetros de exportación no válidos", async () => {
    const env = makeEnv();
    const cookie = await session(env);
    const bad = [
      "dataset=energy_errors&from=2026-11-01&to=2026-11-02",
      "dataset=constructor&from=2026-11-01&to=2026-11-02",
      "dataset=readings&from=2026-11-05&to=2026-11-02",
      "dataset=readings&from=ayer&to=2026-11-02",
      "dataset=readings&from=2026-11-01&to=2026-11-02&after=1;drop",
      "dataset=daily&from=2026-11-01&to=2026-11-02&after=2026-11-01T00:00:00Z",
    ];
    for (const q of bad) expect((await get(`/api/export?${q}`, env, cookie)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("seguridad del acceso", () => {
  const login = (env: Env, headers: Record<string, string> = {}, password = PASSWORD) =>
    worker.fetch(
      new Request("https://w.dev/login", {
        method: "POST",
        body: new URLSearchParams({ password }),
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      }),
      env,
    );
  const limiter = (allowed: number) => {
    let calls = 0;
    return { limit: vi.fn(async () => ({ success: ++calls <= allowed })) };
  };

  it("bloquea con 429 cuando se superan los intentos, incluso con la contraseña buena", async () => {
    const env = { ...makeEnv(), LOGIN_LIMITER_IP: limiter(2) };
    expect((await login(env, {}, "mala")).status).toBe(401);
    expect((await login(env, {}, "mala")).status).toBe(401);
    const blocked = await login(env);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expect(blocked.headers.get("Set-Cookie")).toBeNull();
  });

  it("cuenta los intentos por IP y también en global", async () => {
    const perIp = limiter(10);
    const global = limiter(0);
    const env = { ...makeEnv(), LOGIN_LIMITER_IP: perIp, LOGIN_LIMITER_GLOBAL: global };
    expect((await login(env, { "CF-Connecting-IP": "203.0.113.7" })).status).toBe(429);
    expect(perIp.limit).toHaveBeenCalledWith({ key: "login:203.0.113.7" });
    expect(global.limit).toHaveBeenCalledWith({ key: "login:all" });
  });

  it("rechaza el login enviado desde otra web", async () => {
    const res = await login(makeEnv(), { Origin: "https://malicioso.example" });
    expect(res.status).toBe(403);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect((await login(makeEnv(), { Origin: "https://w.dev" })).status).toBe(303);
  });

  it("no arranca el dashboard con una contraseña corta", async () => {
    const env = { ...makeEnv(), DASHBOARD_PASSWORD: "once-carac1" };
    expect((await login(env, {}, "once-carac1")).status).toBe(503);
    const ok = { ...makeEnv(), DASHBOARD_PASSWORD: "doce-carac12" };
    expect((await login(ok, {}, "doce-carac12")).status).toBe(303);
  });

  it("añade cabeceras de seguridad y no muestra la contraseña en ninguna respuesta", async () => {
    const res = await worker.fetch(new Request("https://w.dev/"), makeEnv());
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(await res.text()).not.toContain(PASSWORD);
  });

  it("usa la zona horaria configurada y descarta valores peligrosos", async () => {
    const env = { ...makeEnv(), TIMEZONE: "America/Mexico_City" };
    const cookie = await sessionCookie(env);
    fetchMock.mockImplementation(async () => new Response("[]"));
    await worker.fetch(
      new Request("https://w.dev/api/export?dataset=readings&from=2026-11-01&to=2026-11-01", {
        headers: { Cookie: cookie },
      }),
      env,
    );
    expect(new URL(calledUrls()[0]!).searchParams.getAll("ts")[0]).toBe(
      "gte.2026-11-01 00:00:00 America/Mexico_City",
    );
    const page = await worker.fetch(new Request("https://w.dev/", { headers: { Cookie: cookie } }), {
      ...env,
      TIMEZONE: '"</script><script>alert(1)//',
    });
    const html = await page.text();
    expect(html).toContain('const TZ = "Europe/Madrid";');
    expect(html).not.toContain("alert(1)");
  });
});
