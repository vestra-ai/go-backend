// A checker built from Go's official contract/go.json ONLY: none of the Server's overlay (contract/extensions-1.1.json,
// the web check-in additions) is known to it. go.json writes "may be empty" as anyOf [X, null] and the Server leaves empty
// members out, so those are read as X, as the Server's own check does (src/contract/validate.ts).
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export const simplifyNullable = (node: any): any => {
  if (Array.isArray(node)) return node.map(simplifyNullable);
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node.anyOf) && node.anyOf.length === 2) {
    const nonNull = node.anyOf.filter((b: any) => b?.type !== 'null');
    if (nonNull.length === 1) {
      const { anyOf: _drop, ...rest } = node;
      return simplifyNullable({ ...nonNull[0], ...rest });
    }
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, simplifyNullable(v)]));
};

export const officialGoJson = JSON.parse(readFileSync(new URL('../../contract/go.json', import.meta.url), 'utf8'));
export const officialMethods = JSON.parse(readFileSync(new URL('../../contract/methods.json', import.meta.url), 'utf8'));

const ajv = new Ajv2020({ strict: false, allErrors: false, discriminator: true });
addFormats.default(ajv);
ajv.addSchema({ $id: 'official', components: { schemas: simplifyNullable(officialGoJson.components.schemas) } });

/** True when the official schema exists and the value passes it. */
export const hasOfficial = (schema: string): boolean => schema in officialGoJson.components.schemas;
export const validOfficial = (schema: string, value: unknown): boolean => {
  const v = ajv.getSchema(`official#/components/schemas/${schema}`);
  if (!v) throw new Error(`no schema ${schema} in the official go.json`);
  return v(value) as boolean;
};
