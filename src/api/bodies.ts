// The body of every route this feature adds, one definition per route (JSON Schema 2020-12). Each route owns
// its definition: limits, formats and enumerations come from the design or the contract (contract/go.json),
// never invented here, and the contract's request schemas are not reused because they are for Go's requests.
// Rules for every definition (tests/bodies.test.ts walks them): each object sets `additionalProperties: false`;
// `null` appears only at the paths named in CLEARABLE; every string has a `maxLength`, an `enum` or a `format`;
// every array has a `maxItems`.
import { bodyChecker } from './input.js';

const id = { type: 'string', minLength: 1, maxLength: 64 } as const;

const openVote = {
  type: 'object',
  additionalProperties: false,
  required: ['client_id', 'question', 'kind', 'anonymous', 'options'],
  properties: {
    client_id: id,
    question: { type: 'string', minLength: 1, maxLength: 200 },
    kind: { type: 'string', enum: ['choice', 'yesno'] },
    anonymous: { type: 'boolean' },
    options: {
      type: 'array',
      minItems: 2,
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label'],
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 120 },
          image_url: { type: 'string', format: 'uri' },
          price_minor: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          note: { type: 'string', maxLength: 120 },
        },
      },
    },
    closes_at: { type: 'string', format: 'date-time' },
  },
} as const;

/** Every route's body definition, by name. */
export const bodies = { openVote } as const;

/** The only places `null` is a valid value ("clear this field"): `<definition>.<dotted path>`. */
export const CLEARABLE: readonly string[] = [];

export interface OpenVoteBody {
  client_id: string;
  question: string;
  kind: 'choice' | 'yesno';
  anonymous: boolean;
  options: Array<{ label: string; image_url?: string; price_minor?: number; note?: string }>;
  closes_at?: string;
}

export const checkOpenVote = bodyChecker<OpenVoteBody>(bodies.openVote);
