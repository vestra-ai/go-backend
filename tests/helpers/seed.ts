import { createHash } from 'node:crypto';
import type pg from 'pg';

export interface SeedPerson { id: string; name: string; role?: 'organizer' | 'member'; upi?: string; paused?: boolean; budget?: [number, number] }

/**
 * The Supabase user id a seeded (or any named) person signs in as: fixed by the person id, so the fake Supabase Auth
 * can mint a token for `p_rahul` and the server finds the same row (people.auth_user_id).
 */
export function uuidFor(personId: string): string {
  const hex = createHash('sha256').update(`go-test-user:${personId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A trip with its people, the way the app's "create trip" and "join" routes leave it (without their events). */
export async function seedTrip(
  pool: pg.Pool,
  tripId = 't_goa',
  people: SeedPerson[] = [
    { id: 'p_rahul', name: 'Rahul', role: 'organizer', upi: 'rahul@upi' },
    { id: 'p_priya', name: 'Priya' },
    { id: 'p_arjun', name: 'Arjun' },
    { id: 'p_meher', name: 'Meher' },
    { id: 'p_kabir', name: 'Kabir' },
  ],
): Promise<void> {
  await pool.query(
    `insert into trips (trip_id, title, organizer_person_id, invite_code, currency, dates_start, dates_end, plan_minor, seq)
     values ($1, 'Goa 🌴', $2, $3, 'INR', '2026-11-06', '2026-11-09', 7500000, 1)  -- trip.created took change 1`,
    [tripId, people[0]!.id, `inv_${tripId}`],
  );
  await pool.query('insert into invites (code, trip_id, created_by) values ($1, $2, $3)', [`inv_${tripId}`, tripId, people[0]!.id]); // the trip's working link (005)
  let n = 0;
  for (const p of people) {
    await pool.query(
      `insert into people (person_id, name, upi_id, phone, email, auth_user_id, auth_provider) values ($1, $2, $3, $4, $5, $6, 'google') on conflict do nothing`,
      [p.id, p.name, p.upi ?? null, `+91${p.id}`, `${p.id}@mail.test`, uuidFor(p.id)],
    );
    await pool.query(
      `insert into trip_people (trip_id, person_id, role, joined_at, go_paused, budget_min_minor, budget_max_minor)
       values ($1, $2, $3, now() + make_interval(secs => $4), $5, $6, $7)`,
      [tripId, p.id, p.role ?? 'member', n++, p.paused ?? false, p.budget?.[0] ?? null, p.budget?.[1] ?? null],
    );
  }
}
