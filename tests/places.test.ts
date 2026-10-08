// §4.14 Places: the city search over the bundled dataset: prefix match without accents or case, biggest first, one row per
// name and state, the top list, the caching headers, and the per-person limit.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readCitiesFile } from '../src/domain/places.js';
import { appApi } from './helpers/app-api.js';
import { startHarness, v1, type Harness } from './helpers/harness.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness();
  t = appApi(h);
});
afterAll(() => h.stop());

// Five a second per person is the limit, so each test asks as a different seeded person.
const search = (query: string, who: any) => t.api(who, 'GET', v1(`/places/cities${query}`));

describe('GET /places/cities', () => {
  it('matches the start of a name, biggest first, at most 8, with the region as "State, India" and a stable id; cached a day', async () => {
    const rahul = t.as('p_rahul');
    const r = await search('?q=in', rahul);
    expect([r.status, r.headers['cache-control'], r.body.items.map((c: any) => c.name)]).toEqual([200, 'private, max-age=86400', ['Indore', 'Indi', 'Indapur']]);
    expect(r.body.items[0]).toEqual({ id: 'in-indore-mp', name: 'Indore', region: 'Madhya Pradesh, India', lat: 22.7196, lng: 75.8577, population: 1964086 });
    expect((await search('?q=ma', rahul)).body.items).toHaveLength(8);
    expect((await search('?q=ma&limit=3', rahul)).body.items.map((c: any) => c.name)).toEqual(['Madurai', 'Mangaluru', 'Malegaon']);
    expect((await search('?q=zzzz', rahul)).body.items).toEqual([]);
  });

  it('ignores accents and case in what was typed, never in what is shown', async () => {
    const priya = t.as('p_priya');
    expect((await search('?q=b%C3%A9NG', priya)).body.items.map((c: any) => c.name)).toEqual(['Bengaluru']); // "béNG"
    expect((await search('?q=Ko', priya)).body.items.map((c: any) => c.name)).toEqual(['Kolkata', 'Kota', 'Kochi', 'Kolhapur', 'Kozhikode', 'Korba', 'Kollam', 'Kottayam']);
  });

  it('under two characters typed (or nothing) it is the top list; the top route is the same eight, cached a week', async () => {
    const arjun = t.as('p_arjun');
    const top = await search('/top', arjun);
    const short = await search('?q=m', arjun);
    const none = await search('', arjun);
    expect([top.status, top.headers['cache-control'], top.body.items.map((c: any) => c.name)]).toEqual([200, 'private, max-age=604800', ['Mumbai', 'Delhi', 'Bengaluru', 'Hyderabad', 'Ahmedabad', 'Chennai', 'Kolkata', 'Surat']]);
    expect([short.body, none.body]).toEqual([top.body, top.body]);
    expect((await search('/top?limit=2', arjun)).body.items.map((c: any) => c.name)).toEqual(['Mumbai', 'Delhi']);
  });

  it('refuses a limit over 8, a country we have no data for, a query over 80 characters, and no sign-in', async () => {
    const meher = t.as('p_meher');
    expect((await search('?q=ma&limit=9', meher)).status).toBe(422);
    const us = await search('?q=ma&country=US', meher);
    expect([us.status, us.body.error.field]).toEqual([422, 'country']);
    expect((await search(`?q=${'a'.repeat(81)}`, meher)).status).toBe(422);
    expect((await search('?q=ma', null)).status).toBe(401);
    expect((await search('/top', null)).status).toBe(401);
  });

  it('holds the design\'s cities and every row of the bundled file', async () => {
    const { cities } = readCitiesFile();
    const n = (await h.pool.query('select count(*)::int as n from places_cities')).rows[0].n;
    expect(n).toBe(cities.length);
    for (const name of ['Bengaluru', 'Mumbai', 'Delhi', 'Pune', 'Hyderabad', 'Chennai', 'Kolkata', 'Kochi', 'Indore', 'Indapur', 'Indi', 'Imphal', 'Kozhikode', 'Jaipur', 'Udaipur', 'Panaji', 'Gokarna', 'Manali', 'Madikeri']) {
      expect(cities.some((c) => c.name === name), name).toBe(true);
    }
    expect(cities.filter((c) => c.population < 15_000).map((c) => c.name)).toEqual(['Manali']); // the one exception, for the design
  });

  it('allows five searches a second per person, then 429 with a wait; another person is not held back', async () => {
    const answers: number[] = [];
    const kabir = t.as('p_kabir');
    for (let i = 0; i < 7; i++) answers.push((await search('?q=go', kabir)).status);
    expect([answers.filter((s) => s === 200).length <= 5, answers.at(-1)]).toEqual([true, 429]);
    expect((await search('?q=go', t.as('p_priya'))).status).toBe(200);
  });
});
