import type pg from 'pg';

export interface SeedPerson { id: string; name: string; role?: 'organizer' | 'member'; upi?: string; paused?: boolean; budget?: [number, number] }

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
  let n = 0;
  for (const p of people) {
    await pool.query('insert into people (person_id, name, upi_id, phone, email) values ($1, $2, $3, $4, $5) on conflict do nothing', [
      p.id, p.name, p.upi ?? null, `+91${p.id}`, `${p.id}@mail.test`,
    ]);
    await pool.query(
      `insert into trip_people (trip_id, person_id, role, joined_at, go_paused, budget_min_minor, budget_max_minor)
       values ($1, $2, $3, now() + make_interval(secs => $4), $5, $6, $7)`,
      [tripId, p.id, p.role ?? 'member', n++, p.paused ?? false, p.budget?.[0] ?? null, p.budget?.[1] ?? null],
    );
  }
}
