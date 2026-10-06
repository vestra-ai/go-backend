// Strict input for the routes this feature adds. Each route owns its body definition and checks it in the
// handler: no type coercion, no silent stripping, no defaults. Fastify's own body validation is not used for
// these routes, because it coerces types and can strip fields. Every bad input answers 422 `invalid`.
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { invalid } from '../domain/errors.js';

// The same formats package the contract validator uses (src/contract/validate.ts), so "uri" and "date-time"
// mean the same thing here as they do for the events Go receives.
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: false, coerceTypes: false, removeAdditional: false, useDefaults: false });
addFormats.default(ajv);

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** How deep a body may nest. The routes' own shapes are a few levels; only an itinerary's free-form fields can go deeper. */
export const MAX_DEPTH = 32;

/**
 * What the database or the parser cannot take, anywhere in a body, found without recursion (a deep body must not exhaust the
 * stack): a NUL character or an unpaired surrogate in any string or key (Postgres refuses both), a `__proto__` key, or nesting
 * deeper than MAX_DEPTH.
 */
function unacceptable(root: unknown): string | null {
  const unstorable = (text: string) => text.includes('\u0000') || LONE_SURROGATE.test(text);
  const stack: Array<[unknown, number]> = [[root, 1]];
  while (stack.length > 0) {
    const [value, depth] = stack.pop()!;
    if (typeof value === 'string') {
      if (unstorable(value)) return 'body has a character that cannot be stored (a NUL or an unpaired surrogate)';
    } else if (value && typeof value === 'object') {
      if (depth > MAX_DEPTH) return `body is nested more than ${MAX_DEPTH} levels deep`;
      if (Array.isArray(value)) for (const item of value) stack.push([item, depth + 1]);
      else {
        for (const [key, item] of Object.entries(value)) {
          if (unstorable(key)) return 'body has a character that cannot be stored (a NUL or an unpaired surrogate)';
          if (key === '__proto__') return 'body has a key that is not allowed'; // read as an ordinary key by JSON.parse, it would let a value skip the contract check that copies it
          stack.push([item, depth + 1]);
        }
      }
    }
  }
  return null;
}

/** Names the field and the rule, never the value: a UPI id or a budget answer must not travel in an error message. */
function describe(e: ErrorObject): string {
  const path = e.instancePath.split('/').filter(Boolean).join('.');
  let message: string;
  if (e.keyword === 'required') message = `${[path, (e.params as { missingProperty: string }).missingProperty].filter(Boolean).join('.')} is required`;
  else if (e.keyword === 'additionalProperties') message = `${[path, (e.params as { additionalProperty: string }).additionalProperty].filter(Boolean).join('.')} is not a known field`;
  else message = `${path || 'body'} ${e.message ?? 'is invalid'}`;
  return message.slice(0, 300);
}

/**
 * Compiles a body definition (JSON Schema, 2020-12) into a checker that returns the body as it arrived,
 * or throws 422 `invalid`. `null` is accepted only where the definition lists it in a field's `type`.
 */
export function bodyChecker<T>(schema: object): (body: unknown) => T {
  const validate = ajv.compile(schema);
  return (body: unknown): T => {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid('body must be a JSON object');
    const refused = unacceptable(body);
    if (refused) throw invalid(refused);
    if (!validate(body)) throw invalid(describe(validate.errors![0]!));
    return body as T;
  };
}
