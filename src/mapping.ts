/**
 * Tuya DP -> energy_readings column mapping. EDIT THIS FILE for other meters.
 * Mapeo de los DP de Tuya a las columnas de energy_readings. EDITA AQUÍ.
 *
 * Values below are confirmed on an ATORCH GR2PWS with GET /debug. Tuya's
 * specification gives decimals: spec_scale 2 means scale 0.01.
 * Valores confirmados con GET /debug en un ATORCH GR2PWS.
 *
 * - codes: candidate DP codes; the first one present in the status is used.
 *   Códigos candidatos; se usa el primero que aparezca.
 * - scale: multiplier applied to the raw value (x10 => 0.1, mA => 0.001).
 *   Multiplicador sobre el valor crudo.
 * - transform: optional, replaces scale for values that are not a plain number
 *   (e.g. a base64 DP such as phase_a that packs several magnitudes).
 *   Opcional, para DP codificados (por ejemplo phase_a en base64).
 *
 * GR2PWS notes / notas:
 * - power_factor, frequency_hz: this meter does not publish them (null).
 *   The dashboard computes the power factor as W / (V x A).
 * - energy_kwh: intentionally unmapped. The only candidate, add_ele
 *   ("added electricity"), stayed at 0 during a 1.8 kW / ~1 kWh load, so it is
 *   not a cumulative counter. Mapping it would make the views report ~0 kWh.
 *   Unmapped, the views estimate energy from power_w; add_ele is still kept in
 *   the raw column. If your meter has a real cumulative counter, map it here.
 *   Sin asignar a propósito: add_ele siguió en 0 con 1,8 kW de carga.
 */
export interface NumericField {
  codes: string[];
  scale?: number;
  transform?: (value: unknown) => number | null;
}

type NumericColumn =
  | "power_w"
  | "voltage_v"
  | "current_a"
  | "power_factor"
  | "frequency_hz"
  | "energy_kwh";

export const DP_MAPPING: Record<NumericColumn, NumericField> = {
  power_w: { codes: ["cur_power"], scale: 0.01 },
  voltage_v: { codes: ["cur_voltage"], scale: 0.01 },
  current_a: { codes: ["cur_current"], scale: 0.001 },
  power_factor: { codes: [] },
  frequency_hz: { codes: [] },
  energy_kwh: { codes: [] },
};

/** Códigos candidatos del relé (booleano). */
export const RELAY_CODES = ["switch_1"];

export interface TuyaStatusItem {
  code: string;
  value: unknown;
}

export interface MappedReading {
  power_w: number | null;
  voltage_v: number | null;
  current_a: number | null;
  power_factor: number | null;
  frequency_hz: number | null;
  energy_kwh: number | null;
  relay_on: boolean | null;
}

function findValue(status: TuyaStatusItem[], codes: string[]): unknown {
  for (const code of codes) {
    const item = status.find((s) => s.code === code);
    if (item) return item.value;
  }
  return undefined;
}

function mapNumeric(status: TuyaStatusItem[], field: NumericField): number | null {
  const value = findValue(status, field.codes);
  if (value === undefined || value === null) return null;
  if (field.transform) return field.transform(value);
  if (typeof value !== "number" && typeof value !== "string") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (value === "" || !Number.isFinite(n)) return null;
  // Evita ruido de coma flotante como 229.70000000000002.
  return Number((n * (field.scale ?? 1)).toFixed(6));
}

export function mapStatus(status: TuyaStatusItem[]): MappedReading {
  const relay = findValue(status, RELAY_CODES);
  return {
    power_w: mapNumeric(status, DP_MAPPING.power_w),
    voltage_v: mapNumeric(status, DP_MAPPING.voltage_v),
    current_a: mapNumeric(status, DP_MAPPING.current_a),
    power_factor: mapNumeric(status, DP_MAPPING.power_factor),
    frequency_hz: mapNumeric(status, DP_MAPPING.frequency_hz),
    energy_kwh: mapNumeric(status, DP_MAPPING.energy_kwh),
    relay_on: typeof relay === "boolean" ? relay : null,
  };
}
