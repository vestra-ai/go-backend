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
    if (!validate(body)) throw invalid(describe(validate.errors![0]!));
    return body as T;
  };
}
