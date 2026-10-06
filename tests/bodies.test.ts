import { expect, it } from 'vitest';
import { CLEARABLE, PASSTHROUGH, bodies } from '../src/api/bodies.js';

/** The routes with a body definition. Each block that adds a definition adds its name here. */
const EXPECTED = ['openVote', 'addBooking', 'updateBooking', 'cancelVote', 'patchMe', 'patchTripMe', 'putBudget', 'patchTrip', 'nudge'];
const ALLOWED_KEYWORDS = ['type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum', 'format', 'pattern', 'description'];

it('every body definition is strict: typed, closed objects, null only where clearable, bounded strings and arrays', () => {
  expect(Object.keys(bodies).sort()).toEqual([...EXPECTED].sort()); // so the walk cannot pass on an empty module
  const problems: string[] = [];
  const walk = (name: string, node: any, path: string) => {
    const where = `${name}${path ? `.${path}` : ''}`;
    if (PASSTHROUGH.includes(where)) return; // checked against the contract's own definitions in the domain code
    const types: string[] = ([] as string[]).concat(node.type ?? []);
    if (types.length === 0) problems.push(`${where}: no type (an untyped node accepts anything)`);
    for (const key of Object.keys(node)) if (!ALLOWED_KEYWORDS.includes(key)) problems.push(`${where}: keyword ${key} is not one the walk understands`);
    if (Array.isArray(node.enum) && node.enum.includes(null)) problems.push(`${where}: enum allows null`);
    if (types.includes('null') && !CLEARABLE.includes(where)) problems.push(`${where}: null allowed but not in CLEARABLE`);
    if (types.includes('object')) {
      if (node.additionalProperties !== false) problems.push(`${where}: object does not set additionalProperties: false`);
      for (const [key, child] of Object.entries<any>(node.properties ?? {})) walk(name, child, path ? `${path}.${key}` : key);
    }
    if (types.includes('string') && node.maxLength === undefined && !node.enum && !node.format) problems.push(`${where}: string has no maxLength, enum or format`);
    if (types.includes('array')) {
      if (node.maxItems === undefined) problems.push(`${where}: array has no maxItems`);
      if (node.items) walk(name, node.items, `${path}[]`);
      else problems.push(`${where}: array does not say what its items are`);
    }
  };
  for (const [name, schema] of Object.entries(bodies)) {
    expect((schema as any).type).toBe('object');
    walk(name, schema, '');
  }
  expect(problems).toEqual([]);
  expect(PASSTHROUGH).toEqual(['patchTrip.itinerary[]']); // the exemptions are pinned here: a new one needs a reviewed change to this test
});
