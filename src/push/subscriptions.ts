import type pg from 'pg';
import { notFound } from '../domain/errors.js';

/** A person keeps this many subscriptions (a phone, a tablet, a few browsers); a newer one replaces the oldest (build-direction ruling). */
export const MAX_SUBSCRIPTIONS_PER_PERSON = 10;

/**
 * Registers a browser's push address for the person. An address that already exists moves to this person and counts as the newest.
 * Beyond the limit the oldest are removed (in the same transaction), so a new device is never refused and dead entries heal themselves.
 */
export async function saveSubscription(pool: pg.Pool, personId: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query('begin');
    await db.query('select pg_advisory_xact_lock(hashtext($1))', [`push_subscriptions:${personId}`]); // one save per person at a time, so the trim sees every other save
    const { rowCount } = await db.query(
      `insert into push_subscriptions (endpoint, person_id, p256dh, auth)
       select $1, $2, $3, $4 where exists (select 1 from people where person_id = $2)
       on conflict (endpoint) do update set person_id = excluded.person_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = now()`,
      [sub.endpoint, personId, sub.keys.p256dh, sub.keys.auth],
    );
    if (!rowCount) throw notFound(`person ${personId} does not exist`);
    await db.query(
      `delete from push_subscriptions where person_id = $1 and endpoint not in
         (select endpoint from push_subscriptions where person_id = $1 order by created_at desc, endpoint limit $2)`,
      [personId, MAX_SUBSCRIPTIONS_PER_PERSON],
    );
    await db.query('commit');
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

/** Removes the caller's own subscription for this address; another person's is untouched. Safe to repeat. */
export async function removeSubscription(pool: pg.Pool, personId: string, endpoint: string): Promise<void> {
  await pool.query('delete from push_subscriptions where endpoint = $1 and person_id = $2', [endpoint, personId]);
}
