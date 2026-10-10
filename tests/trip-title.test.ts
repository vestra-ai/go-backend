// The automatic trip name (rev 5 I): "New trip" with a destination reads "<destination> - <year>" on every app read
// (TripView, the home card, the invite preview), never in what Go reads, and nothing is stored.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tripTitle } from '../src/domain/trip-title.js';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, ...; titled "Goa 🌴", dates in Nov 2026
  t = appApi(h);
});
afterAll(() => h.stop());

const rahul = () => t.as('p_rahul');
const titles = async (tripId: string) => {
  const view = (await t.api(rahul(), 'GET', `/app/v1/trips/${tripId}`)).body;
  const home = (await t.api(rahul(), 'GET', '/app/v1/home')).body.trips.find((x: any) => x.trip_id === tripId);
  const code = (await t.api(rahul(), 'GET', `/app/v1/trips/${tripId}/invite`)).body.code;
  const preview = (await t.api(null, 'GET', `/app/v1/invites/${code}`)).body.trip;
  return [view.title, home.title, preview.title];
};
let n = 0;
const go = async (method: string, params: Record<string, unknown>) => {
  const f = await h.go.call(method, { request_id: `rq_title_${++n}`, ...params });
  if (f.error) throw new Error(`${method}: ${JSON.stringify(f.error)}`);
  return f.result;
};

describe('the automatic trip name', () => {
  let tripId: string;

  it('"New trip" with no destination stays "New trip" everywhere', async () => {
    tripId = (await t.api(rahul(), 'POST', '/app/v1/trips', {})).body.trip_id;
    expect(await titles(tripId)).toEqual(['New trip', 'New trip', 'New trip']);
  });

  it('once Go sets the destination: "Hampi - <this year in India>" on TripView, the home card and the invite preview; Go\'s read_trip and the stored row still say "New trip"', async () => {
    await go('update_trip', { trip_id: tripId, destination: { name: 'Hampi' } });
    const year = Number(new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric' }).format(new Date()));
    expect(await titles(tripId)).toEqual(Array(3).fill(`Hampi - ${year}`));
    expect((await go('read_trip', { trip_id: tripId })).title).toBe('New trip');
    expect((await rows(h.pool, 'select title from trips where trip_id = $1', [tripId]))[0].title).toBe('New trip');
    // No event was sent for the name itself: only the destination's trip.updated.
    await h.flush();
    expect(h.go.events.filter((e) => e.trip_id === tripId && e.type === 'trip.updated').map((e) => e.data.changed)).toEqual([['destination']]);
  });

  it('with dates the year is the start date\'s: 2027', async () => {
    await t.api(rahul(), 'PATCH', `/app/v1/trips/${tripId}`, { dates: { start: '2027-01-10', end: '2027-01-12' } });
    expect(await titles(tripId)).toEqual(Array(3).fill('Hampi - 2027'));
  });

  it('a renamed trip keeps its own name, and so does a trip that never was "New trip"', async () => {
    await t.api(rahul(), 'PATCH', `/app/v1/trips/${tripId}`, { title: 'Hampi boys' });
    expect(await titles(tripId)).toEqual(['Hampi boys', 'Hampi boys', 'Hampi boys']);
    await go('update_trip', { trip_id: 't_goa', destination: { name: 'Goa' } });
    expect(await titles('t_goa')).toEqual(['Goa 🌴', 'Goa 🌴', 'Goa 🌴']);
  });

  it('the rule itself: exact "New trip" only, a named destination only, the year of dates.start, else the year in India', () => {
    const newYearsEveUtc = new Date('2026-12-31T20:00:00Z'); // already 1 Jan 2027 in India
    expect([
      tripTitle({ title: 'New trip', destination: { name: 'Hampi' } }, newYearsEveUtc),
      tripTitle({ title: 'New trip', destination: { name: 'Hampi' }, dates_start: '2028-03-01' }, newYearsEveUtc),
      tripTitle({ title: 'New trip', destination: null }),
      tripTitle({ title: 'New trip', destination: { name: '  ' } }),
      tripTitle({ title: 'new trip', destination: { name: 'Hampi' } }),
    ]).toEqual(['Hampi - 2027', 'Hampi - 2028', 'New trip', 'New trip', 'new trip']);
  });
});
