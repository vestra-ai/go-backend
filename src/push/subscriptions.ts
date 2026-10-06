import type pg from 'pg';
import { notFound } from '../domain/errors.js';

/** Registers a browser's push address for the person. An address that already exists moves to this person. */
export async function saveSubscription(pool: pg.Pool, personId: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<void> {
  const { rowCount } = await pool.query(
    `insert into push_subscriptions (endpoint, person_id, p256dh, auth)
     select $1, $2, $3, $4 where exists (select 1 from people where person_id = $2)
     on conflict (endpoint) do update set person_id = excluded.person_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    [sub.endpoint, personId, sub.keys.p256dh, sub.keys.auth],
  );
  if (!rowCount) throw notFound(`person ${personId} does not exist`);
}

/** Removes the caller's own subscription for this address; another person's is untouched. Safe to repeat. */
export async function removeSubscription(pool: pg.Pool, personId: string, endpoint: string): Promise<void> {
  await pool.query('delete from push_subscriptions where endpoint = $1 and person_id = $2', [endpoint, personId]);
}
