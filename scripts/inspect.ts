// What happened between our server and Go, from the outbox and logs/go-traffic.jsonl.
//   pnpm inspect                 summary: socket state, outbox per trip, errors, latencies
//   pnpm inspect --trip t_xxx    only one trip
//   pnpm inspect --since 10m     only traffic from the last 10 minutes (s, m, h)
import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { loadEnv } from './dev-real.js';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const trip = opt('trip');
const sinceArg = opt('since');
const since = sinceArg ? Date.now() - Number(sinceArg.slice(0, -1)) * { s: 1e3, m: 6e4, h: 36e5 }[sinceArg.slice(-1) as 's' | 'm' | 'h']! : 0;

const env = loadEnv();
const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();

type Entry = Record<string, any>;
const entries: Entry[] = existsSync('logs/go-traffic.jsonl')
  ? readFileSync('logs/go-traffic.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];
const recent = entries.filter((e) => Date.parse(e.at) >= since && (!trip || e.trip_id === trip || e.kind === 'socket'));

console.log('== Socket');
for (const e of recent.filter((x) => x.kind === 'socket').slice(-8)) console.log(`  ${e.at}  ${e.note}`);

console.log('\n== Outbox (events to Go) per trip');
const { rows } = await client.query(
  `select o.trip_id, t.title, count(*) filter (where o.status = 'sent')::int as sent, count(*) filter (where o.status = 'pending')::int as pending,
          count(*) filter (where o.status = 'failed')::int as failed, max(o.seq)::int as last_seq,
          count(*) filter (where o.status = 'pending' and o.created_at < now() - interval '10 seconds')::int as stuck
     from outbox o join trips t using (trip_id) ${trip ? 'where o.trip_id = $1' : ''}
    group by o.trip_id, t.title order by max(o.created_at) desc limit 30`,
  trip ? [trip] : [],
);
for (const r of rows) console.log(`  ${r.trip_id}  ${String(r.title).padEnd(28).slice(0, 28)}  sent ${r.sent}  pending ${r.pending}  stuck ${r.stuck}  failed ${r.failed}  (last seq ${r.last_seq})`);

// Why each failed event failed: its send_event request and Go's answer, matched by frame id.
const failed = await client.query(
  `select event_id, trip_id, seq, body->>'type' as type, attempts from outbox where status = 'failed' ${trip ? 'and trip_id = $1' : ''} order by created_at desc limit 20`,
  trip ? [trip] : [],
);
if (failed.rowCount) {
  console.log('\n== Events Go refused (status failed)');
  for (const f of failed.rows) {
    const sends = entries.filter((e) => e.kind === 'our_request' && e.params?.event_id === f.event_id).map((e) => e.id);
    const answer = entries.filter((e) => e.kind === 'go_answer' && sends.includes(e.id)).at(-1);
    console.log(`  ${f.trip_id} #${f.seq} ${f.type}: ${answer?.error ? `${answer.error.code} ${answer.error.data_code ?? ''} ${answer.error.message ?? ''}` : answer?.note ?? 'no answer logged'}`);
  }
}

const ourErrors = recent.filter((e) => e.kind === 'our_answer' && !e.ok);
console.log(`\n== Go's requests we answered with an error (${ourErrors.length})`);
for (const e of ourErrors.slice(-25)) console.log(`  ${e.at}  ${e.method} ${e.trip_id ?? ''} → ${e.error?.code} ${e.error?.data_code ?? ''} ${e.error?.message ?? ''}`);

const refusedParams = recent.filter((e) => (e.kind === 'go_request' || e.kind === 'go_notify') && e.ok === false);
if (refusedParams.length) {
  console.log(`\n== Go frames whose params failed our contract check (${refusedParams.length})`);
  for (const e of refusedParams.slice(-15)) console.log(`  ${e.at}  ${e.method}: ${e.note}`);
}

const goErrors = recent.filter((e) => e.kind === 'go_answer' && !e.ok);
console.log(`\n== Our requests Go refused or did not answer (${goErrors.length})`);
for (const e of goErrors.slice(-25)) console.log(`  ${e.at}  ${e.method ?? '?'} → ${e.error ? `${e.error.code} ${e.error.data_code ?? ''} ${e.error.message ?? ''}` : e.note}`);

const bad = recent.filter((e) => e.kind === 'bad_frame');
if (bad.length) {
  console.log(`\n== Frames that were not JSON-RPC (${bad.length})`);
  for (const e of bad.slice(-5)) console.log(`  ${e.at}  ${e.note}`);
}

const stats = (kind: string) => {
  const by = new Map<string, number[]>();
  for (const e of recent.filter((x) => x.kind === kind && typeof x.ms === 'number')) {
    const k = e.method ?? '?';
    by.set(k, [...(by.get(k) ?? []), e.ms]);
  }
  for (const [m, ms] of [...by].sort()) {
    const s = [...ms].sort((a, b) => a - b);
    const pct = (p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
    console.log(`  ${m.padEnd(24)} n=${String(s.length).padEnd(4)} p50 ${pct(50)} ms  p95 ${pct(95)} ms  max ${s.at(-1)} ms`);
  }
};
console.log('\n== How fast we answered Go (limit 2000 ms)');
stats('our_answer');
console.log('\n== How fast Go answered us (send_event 2 s, card_tap/catch_up 3 s, others 2 s)');
stats('go_answer');

const methods = new Map<string, number>();
for (const e of recent.filter((x) => x.kind === 'go_request' || x.kind === 'go_notify')) methods.set(e.method, (methods.get(e.method) ?? 0) + 1);
console.log('\n== What Go asked us to do');
console.log(`  ${[...methods].map(([m, n]) => `${m} ×${n}`).join(', ') || '(nothing yet)'}`);
const kinds = new Set(recent.filter((e) => e.method === 'post_message' || e.method === 'replace_card').map((e) => e.params?.card?.kind).filter(Boolean));
console.log(`  card kinds seen: ${[...kinds].join(', ') || '(none yet)'}`);

await client.end();
