import { readFileSync } from 'node:fs';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = new URL('../../contract/', import.meta.url);
const openapi = JSON.parse(readFileSync(new URL('go.json', root), 'utf8'));
const table = JSON.parse(readFileSync(new URL('methods.json', root), 'utf8'));
/** The 1.1 proposals (docs/GO-CHANGES.md), laid over 1.0 additively. Replaced by the official go.json when it is published. */
const extensions = JSON.parse(readFileSync(new URL('extensions-1.1.json', root), 'utf8')) as { contract: string; schemas: Record<string, unknown>; methods: MethodInfo[] };
export const CONTRACT_EXTENSIONS_VERSION: string = extensions.contract;

/**
 * Null and missing mean the same thing in this contract, so a field that "may be empty" is written
 * in go.json as anyOf [X, null]. Turn those back into X and drop nulls before checking: it gives
 * error messages that name the field instead of listing both branches.
 */
function simplify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(simplify);
  if (node === null || typeof node !== 'object') return node;
  const obj = node as Record<string, unknown>;
  const any = obj.anyOf;
  if (Array.isArray(any) && any.length === 2) {
    const nonNull = any.filter((b) => !(b && typeof b === 'object' && (b as { type?: unknown }).type === 'null'));
    if (nonNull.length === 1) {
      const { anyOf: _drop, ...rest } = obj;
      return simplify({ ...(nonNull[0] as object), ...rest });
    }
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, simplify(v)]));
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Lays an extension over a schema and only ever widens it: a new property is added, an enum gains values, a oneOf gains
 * branches, nested objects are merged the same way. What the base already says (types, limits, formats, `required`)
 * stays as it is, so every frame that was valid under the base is still valid, and nothing becomes required.
 */
export function mergeAdditive(base: unknown, patch: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(patch)) return [...base, ...patch.filter((p) => !base.some((b) => same(b, p)))];
  if (!isObject(base) || !isObject(patch)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'required') continue; // never tighten
    if (!(key in base)) out[key] = value;
    else if (key === 'enum' || key === 'oneOf' || key === 'anyOf' || isObject(base[key])) out[key] = mergeAdditive(base[key], value);
  }
  return out;
}

const schemas = mergeAdditive(simplify(openapi.components.schemas), extensions.schemas) as Record<string, unknown>;

const ajv = new Ajv2020({ strict: false, allErrors: false, discriminator: true });
addFormats.default(ajv);
ajv.addSchema({ $id: 'go', components: { schemas } });

const uriOk = ajv.compile({ type: 'string', format: 'uri' });
/** True when the text passes the contract's own URL test: the same one every event is checked with. */
export const isContractUri = (value: unknown): value is string => typeof value === 'string' && uriOk(value);

const cache = new Map<string, ValidateFunction>();
export function validator(schemaName: string): ValidateFunction {
  let v = cache.get(schemaName);
  if (!v) {
    const compiled = ajv.getSchema(`go#/components/schemas/${schemaName}`);
    if (!compiled) throw new Error(`no schema ${schemaName} in the contract`);
    cache.set(schemaName, (v = compiled));
  }
  return v;
}

/** Drops `null` object members, recursively: null and missing are the same. */
export function dropNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(dropNulls) as T;
  if (value && typeof value === 'object') {
    // Built with fromEntries so a key named `__proto__` stays an ordinary key of the copy, never its prototype.
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, dropNulls(v)])) as T;
  }
  return value;
}

function describe(errors: NonNullable<ValidateFunction['errors']>): string {
  const e = errors[0]!;
  const path = e.instancePath.split('/').filter(Boolean).join('.');
  let field = path;
  if (e.keyword === 'required') field = [path, (e.params as { missingProperty: string }).missingProperty].filter(Boolean).join('.');
  if (e.keyword === 'additionalProperties') field = [path, (e.params as { additionalProperty: string }).additionalProperty].filter(Boolean).join('.');
  const what = e.keyword === 'required' ? 'is required' : e.message ?? 'is invalid';
  return `${field || 'params'} ${what}`.slice(0, 500);
}

export type Checked<T = Record<string, unknown>> = { ok: true; value: T } | { ok: false; message: string };

/** Checks a value against a named schema of the contract. The value is returned with nulls dropped. */
export function check<T = Record<string, unknown>>(schemaName: string, value: unknown): Checked<T> {
  const v = dropNulls(value);
  const validate = validator(schemaName);
  if (validate(v)) return { ok: true, value: v as T };
  return { ok: false, message: describe(validate.errors!) };
}

export interface MethodInfo {
  name: string;
  direction: 'to_go' | 'to_server';
  params: string;
  result: string | null;
  answer_within_seconds: number | null;
  sends_event: string | null;
  notification?: boolean;
}

export const METHODS: Record<string, MethodInfo> = Object.fromEntries(
  [...(table.methods as MethodInfo[]), ...extensions.methods.filter((m) => !(table.methods as MethodInfo[]).some((t) => t.name === m.name))].map((m) => [m.name, m]),
);

/** `parseParams('post_message', params)`: the params checked against the method's params schema. */
export function parseParams<T = Record<string, unknown>>(method: string, params: unknown): Checked<T> {
  const info = METHODS[method];
  if (!info) return { ok: false, message: `unknown method ${method}` };
  return check<T>(info.params, params);
}
