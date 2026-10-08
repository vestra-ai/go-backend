// Writes the Postman collection and its two environments from the route metadata every section under src/api/v1 declares
// and from the journeys in scripts/postman-journeys.ts. Postman is generated, never hand-edited, so the collection,
// API.md's index and the code cannot drift:
//   docs/go-server.postman_collection.json          one folder per contract section (in its order) with an example body and
//                                                   example answers per request, plus "Run in order": the scripted journeys
//   docs/go-server.postman_environment.json         the local dev stack (pnpm dev:stack)
//   docs/go-server.railway.postman_environment.json the deployed server (tokens from pnpm supabase:token)
// It writes files only: nothing is pushed to Postman's cloud.
//   pnpm postman:build
import { writeFileSync } from 'node:fs';
import { sections, SECTIONS, type RouteMeta } from '../src/api/v1/index.js';
import { journeys, type Step } from './postman-journeys.js';

const OUT = (name: string) => new URL(`../docs/${name}`, import.meta.url);
const RAILWAY_BASE = 'https://server-production-2202go.up.railway.app/app/v1';

const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized',
  403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 413: 'Payload Too Large', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

// ---- the reference folders: one request per route

/** The environment variable a `:param` resolves to: by its name, else by the resource it hangs off (`decisions/:id` → decisionId). */
const BY_NAME: Record<string, string> = { trip: 'tripId', booking_id: 'bookingId', decision_id: 'decisionId', message_id: 'messageId', card_id: 'cardId', expense_id: 'expenseId', settlement_id: 'settlementId', line_id: 'lineId', document_id: 'documentId', code: 'inviteCode', device_id: 'deviceId', fact_id: 'factId' };
const BY_PARENT: Record<string, string> = { decisions: 'decisionId', messages: 'messageId', expenses: 'expenseId', settlements: 'settlementId', bookings: 'bookingId', record: 'lineId', cards: 'cardId', invites: 'inviteCode', devices: 'deviceId', facts: 'factId', trips: 'tripId' };
const variableFor = (segment: string, previous: string | undefined): string => BY_NAME[segment.slice(1)] ?? (previous ? BY_PARENT[previous] : undefined) ?? segment.slice(1).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** `/app/v1/trips/:trip/messages/:id` → `{{baseUrl}}/trips/{{tripId}}/messages/{{messageId}}` ({{baseUrl}} already ends in /app/v1). */
function urlOf(route: RouteMeta) {
  const segments = route.path.replace(/^\/app\/v1/, '').split('/').filter(Boolean);
  const path = segments.map((s, i) => (s.startsWith(':') ? `{{${variableFor(s, segments[i - 1])}}}` : s));
  const query = Object.entries(route.example?.query ?? {}).map(([key, value]) => ({ key, value: value === 't_goa' ? '{{tripId}}' : value })); // the example trip is the run's trip
  const raw = `{{baseUrl}}/${path.join('/')}${query.length ? `?${query.map((q) => `${q.key}=${q.value}`).join('&')}` : ''}`;
  return { raw, host: ['{{baseUrl}}'], path, ...(query.length ? { query } : {}) };
}

const isWrite = (method: string) => method !== 'GET';
const JSON_HEADER = { key: 'Content-Type', value: 'application/json' };
const IDEMPOTENCY = { key: 'Idempotency-Key', value: '{{$guid}}', description: 'One key per press (§1.4); send the same one when you retry: the first answer is replayed.' };

/** The summary plus the §1 conventions that apply to this route. */
function describe(route: RouteMeta): string {
  const rules: string[] = [];
  if (route.auth === 'none') rules.push('**Public** (§1.2): no sign-in needed.');
  else rules.push('**Sign-in** (§1.2): `Authorization: Bearer <Supabase access token>` ({{token}}); 401 `unauthorized` means refresh the session once, then sign in again.');
  if (route.path.includes('/trips/:trip')) rules.push('**Membership** (§1.2, rev 3): only for someone in the trip now; a non-member and a trip that does not exist both answer 403 `forbidden`.');
  if (isWrite(route.method)) rules.push('**Once** (§1.4): send `Idempotency-Key` (one per press, kept 24 h); a repeat replays the first answer, the same key with a different body is 422 `idempotency_key_reused`.');
  if (isWrite(route.method) && route.example?.body !== undefined) rules.push('**Strict body** (§1.5): an unknown field or a value of the wrong type is 422 `invalid` with `field` set.');
  if (JSON.stringify(route.example ?? {}).includes('_minor')) rules.push('**Money** (§1.3): whole paise, `*_minor` plus `currency`; never a float.');
  if (route.method === 'GET' && route.path.includes('/trips/:trip')) rules.push('**Consistency** (§1.6): `seq` is the trip change number the answer matches; `Cache-Control: private, no-store`.');
  rules.push('**Errors** (§1.5): `{ "error": { "code", "message", "field", "retry_after_seconds", "request_id" } }`, `X-Request-Id` on every answer.');
  return `${route.summary}\n\n${rules.map((r) => `- ${r}`).join('\n')}`;
}

function responseOf(route: RouteMeta, r: NonNullable<NonNullable<RouteMeta['example']>['responses']>[number], request: object) {
  return {
    name: r.name,
    originalRequest: request,
    status: STATUS_TEXT[r.status] ?? String(r.status),
    code: r.status,
    _postman_previewlanguage: 'json',
    header: r.body === undefined ? [] : [JSON_HEADER],
    cookie: [],
    body: r.body === undefined ? '' : JSON.stringify(r.body, null, 2),
  };
}

function requestOf(route: RouteMeta) {
  const write = isWrite(route.method);
  // A POST/PUT/PATCH with nothing to say still sends `{}` (bodies are strict, and an explicit empty object is the clearest example).
  const body = route.example?.body ?? (write && route.method !== 'DELETE' ? {} : undefined);
  const request = {
    method: route.method,
    header: [...(body !== undefined ? [JSON_HEADER] : []), ...(write ? [IDEMPOTENCY] : [])],
    ...(route.auth === 'none' ? { auth: { type: 'noauth' } } : {}),
    url: urlOf(route),
    ...(body !== undefined ? { body: { mode: 'raw', raw: JSON.stringify(body, null, 2), options: { raw: { language: 'json' } } } } : {}),
    description: describe(route),
  };
  return { name: route.title, request, response: (route.example?.responses ?? []).map((r) => responseOf(route, r, request)) };
}

const LIVE_FOLDER_NOTE = [
  'The live connection is a WebSocket, which Postman\'s runner cannot drive: this folder has the ticket request only. To watch the room from a terminal:',
  '',
  '```',
  'TICKET=$(curl -s -X POST "$BASE/live/ticket" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d \'{"device_id":"laptop"}\' | jq -r .ticket)',
  'npx wscat -c "ws://localhost:8080/app/v1/live?ticket=$TICKET"     # wss:// against Railway',
  '> {"type":"subscribe","trips":[{"trip_id":"t_…","since_seq":0}]}',
  '```',
  '',
  'The server says `hello` first, replays the messages changed after `since_seq` (up to 200, else `resync`), then sends `message`, `card`, `typing`, `trip_changed { seq, kinds }`, `home_changed` and `ping` (answer `pong`). A bad or used ticket closes the socket with 4401. The ticket is single-use and lives 30 seconds, so mint it right before connecting.',
].join('\n');

function referenceFolders() {
  const order = Object.values(SECTIONS) as string[];
  const folders = new Map<string, ReturnType<typeof requestOf>[]>();
  for (const section of sections) {
    for (const route of section.routes) {
      if (route.dev) continue; // local only (AUTH_MODE=dev): documented in the README, not here
      if (route.path === '/app/v1/live' && route.method === 'GET') continue; // the WebSocket itself: described on the folder
      if (!folders.has(route.section)) folders.set(route.section, []);
      folders.get(route.section)!.push(requestOf(route));
    }
  }
  return [...folders]
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([name, item]) => ({ name, ...(name === SECTIONS.live ? { description: LIVE_FOLDER_NOTE } : {}), item }));
}

// ---- the journeys: one scripted request per step

/** `{{baseUrl}}/trips/{{tripId}}/messages?limit=50` → Postman's URL object (the first segment is the variable that holds the host). */
function journeyUrl(url: string) {
  const [address, search] = url.split('?') as [string, string | undefined];
  const [host, ...path] = address.split('/').filter(Boolean) as [string, ...string[]];
  const query = (search ?? '').split('&').filter(Boolean).map((pair) => {
    const [key, ...rest] = pair.split('=');
    return { key: key!, value: rest.join('=') };
  });
  return { raw: url, host: [host], path, ...(query.length ? { query } : {}) };
}

const authOf = (as: Step['as']) => {
  if (as === 'none') return { auth: { type: 'noauth' } };
  if (as === 'bad') return { auth: { type: 'bearer', bearer: [{ key: 'token', value: 'not-a-token', type: 'string' }] } };
  if (as === 'token2' || as === 'token3') return { auth: { type: 'bearer', bearer: [{ key: 'token', value: `{{${as}}}`, type: 'string' }] } };
  return {}; // Aarav: the collection's own bearer {{token}}
};

const FEATURE_VAR: Record<NonNullable<Step['feature']>, string> = { checkin: 'featureCheckin', visa: 'featureVisa', calls: 'featureCalls' };

/** `{{uploadUrl}}`: a whole address held in one variable. Postman's URL object would add a slash to it, so the script sets it as a string. */
const wholeVariable = (url: string): string | null => /^\{\{(\w+)\}\}$/.exec(url)?.[1] ?? null;

function preRequest(step: Step): string[] {
  const lines: string[] = [];
  const variable = wholeVariable(step.url);
  if (variable) lines.push(`pm.request.url = pm.environment.get('${variable}'); // the whole address, as the server gave it`);
  if (step.local || step.go) lines.push("if (pm.environment.get('local') !== 'true') { console.log('skipped (local dev stack only): ' + pm.info.requestName); pm.execution.skipRequest(); }");
  if (step.feature) lines.push(`if (pm.environment.get('${FEATURE_VAR[step.feature]}') !== 'true') { console.log('skipped: features.${step.feature} is off on this server (locally: pnpm dev:stack --features ${step.feature}): ' + pm.info.requestName); pm.execution.skipRequest(); }`);
  lines.push(...(step.pre ?? []));
  return lines;
}

function tests(step: Step): string[] {
  const statuses = Array.isArray(step.status) ? step.status : [step.status];
  const lines = [
    "const env = (k) => pm.environment.get(k);",
    statuses.length === 1
      ? `pm.test('status is ${statuses[0]}', () => pm.response.to.have.status(${statuses[0]}));`
      : `pm.test('status is ${statuses.join(' or ')}', () => pm.expect(${JSON.stringify(statuses)}, 'got ' + pm.response.code).to.include(pm.response.code));`,
    'let j = {}; try { j = pm.response.json(); } catch (e) {}',
  ];
  for (const [name, expression] of step.checks ?? []) {
    lines.push(`pm.test(${JSON.stringify(name)}, () => pm.expect(${expression}, JSON.stringify(j).slice(0, 400)).to.be.ok);`);
  }
  for (const [key, expression] of Object.entries(step.save ?? {})) lines.push(`if (pm.response.code < 300) pm.environment.set('${key}', ${expression});`);
  lines.push(...(step.test ?? []));
  return lines;
}

function journeyItem(step: Step) {
  const write = isWrite(step.method);
  const headers: Array<{ key: string; value: string }> = [];
  const custom = step.headers ?? {};
  if (step.body !== undefined && !('Content-Type' in custom)) headers.push(JSON_HEADER);
  if (write && !step.noIdempotency && !('Idempotency-Key' in custom)) headers.push(IDEMPOTENCY);
  headers.push(...Object.entries(custom).map(([key, value]) => ({ key, value })));
  const raw = typeof step.body === 'string' ? step.body : step.body === undefined ? undefined : JSON.stringify(step.body, null, 2);
  const notes = [
    step.description,
    step.go ? 'Acts as Go through the dev stack\'s control port (`POST {{goUrl}}/sim/<method>`, params as JSON). Local only: skipped unless the environment has `local = true`.' : step.local ? 'Local dev stack only: skipped unless the environment has `local = true`.' : undefined,
    step.feature ? `Runs only when \`GET /config\` said \`features.${step.feature}\` is on.` : undefined,
  ].filter(Boolean);
  return {
    name: step.name,
    event: [
      ...(preRequest(step).length ? [{ listen: 'prerequest', script: { type: 'text/javascript', exec: preRequest(step) } }] : []),
      { listen: 'test', script: { type: 'text/javascript', exec: tests(step) } },
    ],
    request: {
      method: step.method,
      header: headers,
      ...authOf(step.go ? 'none' : step.as),
      url: journeyUrl(step.url),
      ...(raw !== undefined ? { body: { mode: 'raw', raw, options: { raw: { language: typeof step.body === 'string' && !raw.trim().startsWith('{') ? 'text' : 'json' } } } } : {}),
      ...(notes.length ? { description: notes.join('\n\n') } : {}),
    },
    response: [],
  };
}

const RUN_IN_ORDER = [
  'The whole app API end to end, with a check on every answer and the ids saved to the environment as it goes. Run it top to bottom (Collection Runner, or `pnpm postman`).',
  '',
  '**Locally:** `pnpm dev:stack --features checkin` (a temporary Postgres, a fake Go, the real server on :8080, a fake Supabase Auth on :54331 and the act-as-Go port on :8090), then run this folder with the *Go Server (local dev stack)* environment. Every run signs in new people (Aarav, Priya, and Kabir who never joins) and makes a new trip, so it can run again and again.',
  '',
  '**Against Railway:** use the *Go Server (Railway)* environment and put three test-user tokens from `pnpm supabase:token` in `token`, `token2`, `token3`. The sign-in steps, folder 7 (acting as Go) and anything that depends on them skip themselves there; the check-in folder runs only when the server\'s `GET /config` says `features.checkin` is on.',
  '',
  'Requests marked **[Go]** are Go\'s side of the contract (open a vote, set a mandate, ask for a spend approval, post or replace a card), sent through the dev stack\'s control port: the stack forwards them over the real signed socket and answers with the Server\'s answer.',
].join('\n');

// ---- the environments

/** Every variable the journeys write, so an imported environment shows them (the values come from the run). */
const SAVED_IDS = ['personId', 'personId2', 'personId3', 'runId', 'tripId', 'tripSeq', 'inviteCode', 'oldInviteCode', 'messageId', 'messageId2', 'messageId3', 'voteMessageId', 'idemMessageId', 'uploadId', 'uploadUrl', 'decisionId', 'goDecisionId', 'cancelDecisionId', 'lineId', 'approvalId', 'cardId', 'payCardMessageId', 'pressId', 'expenseId', 'expenseId2', 'settlementId', 'bookingId', 'documentId', 'deviceId', 'featureCheckin', 'featureVisa', 'featureCalls'];

function environment(name: string, description: string, values: Record<string, { value: string; secret?: boolean }>) {
  return {
    name,
    description,
    values: [
      ...Object.entries(values).map(([key, v]) => ({ key, value: v.value, type: v.secret ? 'secret' : 'default', enabled: true })),
      ...SAVED_IDS.map((key) => ({ key, value: '', type: 'default', enabled: true })),
      { key: 'factId', value: 'f_demo', type: 'default', enabled: true }, // DELETE /me/go/facts/:fact_id: the fake Go accepts any id
    ],
    _postman_variable_scope: 'environment',
  };
}

export const localEnvironment = () => environment(
  'Go Server (local dev stack)',
  'For `pnpm dev:stack`: the server on :8080, the fake Supabase Auth on :54331 (tokens come from its /mint route, no Google needed) and the act-as-Go port on :8090. `local = true` lets the sign-in and [Go] steps of "Run in order" run; the tokens and ids are filled by the run.',
  {
    baseUrl: { value: 'http://localhost:8080/app/v1' },
    authUrl: { value: 'http://localhost:54331' },
    goUrl: { value: 'http://localhost:8090' },
    local: { value: 'true' },
    token: { value: '', secret: true },
    token2: { value: '', secret: true },
    token3: { value: '', secret: true },
  },
);

export const railwayEnvironment = () => environment(
  'Go Server (Railway)',
  `The deployed server (${RAILWAY_BASE}). It issues no tokens: \`token\` (and \`token2\`, \`token3\` for the two-person steps) are Supabase access tokens of the project's test users, from \`pnpm supabase:token\` (about an hour each). The fake Supabase Auth and the act-as-Go port exist only in the local stack, so "Run in order"'s sign-in steps and its folder 7 ([Go]) skip themselves here (\`local = false\`); the check-in folder runs only when GET /config says features.checkin is on.`,
  {
    baseUrl: { value: RAILWAY_BASE },
    authUrl: { value: '' },
    goUrl: { value: '' },
    local: { value: 'false' },
    token: { value: '', secret: true },
    token2: { value: '', secret: true },
    token3: { value: '', secret: true },
  },
);

// ---- the collection

export function buildCollection() {
  const reference = referenceFolders();
  const runInOrder = { name: 'Run in order', description: RUN_IN_ORDER, item: journeys.map((f) => ({ name: f.name, ...(f.description ? { description: f.description } : {}), item: f.steps.map(journeyItem) })) };
  return {
    info: {
      name: 'Go Server: App API (v1)',
      description: [
        'Everything the app calls on the Go Server, under `/app/v1`, in the app contract\'s section order (rev 2 + the Server\'s rev 3 changes). Generated by `pnpm postman:build` from the routes\' own metadata (src/api/v1) and scripts/postman-journeys.ts: do not edit by hand.',
        '',
        '**Run in order** is one scripted end-to-end run (sign in → trip and invite → the room → an upload → a vote → acting as Go → money → bookings → web check-in → the You screen → the errors → leaving) with a check on every answer; see its description for the local stack and for Railway. The **§ folders** hold one request per route with an example body and the example answers; they use `{{token}}` and the ids the run saved (`{{tripId}}`, `{{messageId}}`, …).',
        '',
        'Sign in with a Supabase access token: `Authorization: Bearer {{token}}` (the collection\'s auth; §1.2, rev 3). Locally `pnpm dev:stack` runs a fake Supabase Auth: `GET {{authUrl}}/mint?name=Priya&email=priya@gmail.com` answers one; against Railway use `pnpm supabase:token`.',
        '',
        'Every write carries an `Idempotency-Key` (one per press; the same one on a retry replays the first answer). Errors always look like `{"error": {"code", "message", "field", "retry_after_seconds", "request_id"}}`. Money is whole paise. Full reference: docs/API.md.',
      ].join('\n'),
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
    variable: [
      { key: 'baseUrl', value: 'http://localhost:8080/app/v1', description: 'The server\'s /app/v1 base (the environment overrides it)' },
      { key: 'authUrl', value: 'http://localhost:54331', description: 'The fake Supabase Auth of the local stack' },
      { key: 'goUrl', value: 'http://localhost:8090', description: 'The act-as-Go port of the local stack' },
      { key: 'token', value: '' },
      ...['tripId', 'bookingId', 'decisionId', 'messageId', 'cardId', 'expenseId', 'settlementId', 'lineId', 'documentId', 'inviteCode', 'deviceId', 'factId'].map((key) => ({ key, value: '' })),
    ],
    item: [runInOrder, ...reference],
  };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const collection = buildCollection();
  const count = (items: Array<{ item?: unknown[] }>): number => items.reduce((n, f) => n + (Array.isArray(f.item) ? count(f.item as Array<{ item?: unknown[] }>) : 1), 0);
  writeFileSync(OUT('go-server.postman_collection.json'), `${JSON.stringify(collection, null, 2)}\n`);
  writeFileSync(OUT('go-server.postman_environment.json'), `${JSON.stringify(localEnvironment(), null, 2)}\n`);
  writeFileSync(OUT('go-server.railway.postman_environment.json'), `${JSON.stringify(railwayEnvironment(), null, 2)}\n`);
  const [run, ...reference] = collection.item as Array<{ name: string; item: unknown[] }>;
  console.log(`wrote docs/go-server.postman_collection.json: ${reference.length} reference folders with ${count(reference as never)} requests; "Run in order": ${run!.item.length} folders, ${count(run!.item as never)} requests`);
  console.log('wrote docs/go-server.postman_environment.json and docs/go-server.railway.postman_environment.json');
}
