// Rev 5 B: photos for the ideas carousel, from Go (1.3 place_info). A job asks about each idea at most once a day and
// keeps a whole answer; GET /discover/ideas only reads what is kept. A partial answer, a refusal or an answer without
// photos never replaces photos already kept.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SocketTimeoutError } from '../src/go/go-socket.js';
import { refreshIdeas } from '../src/jobs/ideas.js';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, v1, type Harness } from './helpers/harness.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
let asha: any;
/** The job's Go: the harness's socket to the fake Go. `connected: false` stands for the socket being down. */
let go: { request: (m: string, p: object, o?: { timeoutMs?: number }) => Promise<object>; connected?: boolean };
beforeAll(async () => {
  h = await startHarness({ seed: false });
  t = appApi(h);
  asha = await h.signIn('Asha');
  go = { request: (m, p, o) => h.socket.request(m, p, o) };
});
afterAll(() => h.stop());

const photo = (n: number, label?: string) => ({ url: `https://photos.go.example/goa-${n}.jpg`, ...(label ? { label } : {}) });
const GOA = { place: { name: 'Goa', lat: 15.3, lng: 74.1, photos: [photo(1, 'Beach'), { ...photo(2), label: null }] }, tag: 'Sun and sand', travel: { mode: 'drive', duration_minutes: 600 }, best_months: [11, 12, 1, 2] };
const asks = () => h.go.requests.filter((r) => r.method === 'place_info');
const idea = async (id: string) => (await rows(h.pool, 'select tag, travel_mode, duration_minutes, photos, best_months, refreshed_at is not null as refreshed, refresh_tried_at is not null as tried from ideas where idea_id = $1', [id]))[0];
const ideas = async (query = '') => (await t.api(asha, 'GET', v1(`/discover/ideas${query}`))).body.items as any[];
/** Only this idea is due: every other one counts as asked about just now. */
const onlyDue = (id: string) => h.pool.query(`update ideas set refresh_tried_at = case when idea_id = $1 then null else now() end`, [id]);

beforeEach(async () => {
  h.go.requests.length = 0;
  h.go.answers.place_info = () => ({ result: GOA });
  go.connected = undefined;
  await h.pool.query('update ideas set photos = null, best_months = null, refreshed_at = null, refresh_tried_at = null');
});

describe('the ideas refresh (place_info)', () => {
  it('asks Go about one idea a round, keeps the whole answer, and the carousel shows the photos with the first as its cover', async () => {
    await onlyDue('idea_any_goa');
    expect((await ideas())[0]).toEqual({ idea_id: 'idea_any_goa', name: 'Goa', tag: 'Beach weekend', travel: { mode: 'flight', duration_minutes: 90 }, destination_hint: 'Goa' });
    expect(await refreshIdeas(h.ctx, go)).toBe(1);
    expect(asks()).toEqual([{ method: 'place_info', params: { name: 'Goa' } }]); // an idea for "anywhere" names no city
    // The way there is from a city, so an idea for anywhere keeps its curated one; the rest is Go's.
    expect((await ideas())[0]).toEqual({ idea_id: 'idea_any_goa', name: 'Goa', tag: 'Sun and sand', travel: { mode: 'flight', duration_minutes: 90 }, image_url: photo(1).url, photos: [photo(1, 'Beach'), photo(2)], best_months: [11, 12, 1, 2], destination_hint: 'Goa' });
    // An idea from a city sends it, and takes Go's way there in the table's own words (drive is car).
    await onlyDue('idea_blr_gokarna');
    await refreshIdeas(h.ctx, go);
    expect(asks().at(-1)!.params).toEqual({ name: 'Gokarna', from_city: 'Bengaluru' });
    expect(await idea('idea_blr_gokarna')).toMatchObject({ travel_mode: 'car', duration_minutes: 600, refreshed: true });
  });

  it('asks about each idea at most once a day, the longest-waiting first, and not at all while the socket to Go is down', async () => {
    const total = (await rows(h.pool, 'select count(*)::int as n from ideas'))[0].n;
    go.connected = false;
    expect(await refreshIdeas(h.ctx, go, 50)).toBe(0);
    expect((await rows(h.pool, 'select count(*)::int as n from ideas where refresh_tried_at is not null'))[0].n).toBe(0); // an outage uses up nobody's try
    go.connected = true;
    expect(await refreshIdeas(h.ctx, go, 500)).toBe(total);
    expect(await refreshIdeas(h.ctx, go, 500)).toBe(0); // all asked about today
    expect(asks()).toHaveLength(total);
    await h.pool.query(`update ideas set refresh_tried_at = now() - interval '25 hours' where idea_id = 'idea_any_manali'`);
    expect(await refreshIdeas(h.ctx, go, 500)).toBe(1);
    expect(asks().at(-1)!.params).toEqual({ name: 'Manali' });
    // One a round means one: with two due, the default round claims and asks about a single idea.
    await h.pool.query(`update ideas set refresh_tried_at = now() - interval '25 hours' where idea_id in ('idea_any_manali', 'idea_any_coorg')`);
    const before = asks().length;
    expect(await refreshIdeas(h.ctx, go)).toBe(1);
    expect(asks()).toHaveLength(before + 1);
    // The socket drops under an ask: Go was never really asked, so the idea is due again at once, not tomorrow.
    let up = true;
    await h.pool.query(`update ideas set refresh_tried_at = null where idea_id = 'idea_any_goa'`);
    await refreshIdeas(h.ctx, { request: async () => { up = false; throw new SocketTimeoutError('place_info timed out'); }, get connected() { return up; } });
    expect((await idea('idea_any_goa')).tried).toBe(false);
  });

  it('an idea Go has not answered about in full is asked about again after an hour, and takes the photos a partial answer brings when it has none', async () => {
    // Go marks a place partial while it lacks only its best months (place-info.ts): the photos are there.
    await onlyDue('idea_any_goa');
    h.go.answers.place_info = () => ({ result: { place: { name: 'Goa', photos: [photo(7)] }, complete: false } });
    expect(await refreshIdeas(h.ctx, go)).toBe(0); // not the idea's answer yet
    expect(await idea('idea_any_goa')).toMatchObject({ photos: [photo(7)], refreshed: false, tried: true });
    expect((await ideas())[0].image_url).toBe(photo(7).url);
    // 59 minutes on it waits; 61 minutes on it is asked about again, and the whole answer is kept.
    const ago = (minutes: number) => h.pool.query(`update ideas set refresh_tried_at = now() - make_interval(mins => $1) where idea_id = 'idea_any_goa'`, [minutes]);
    h.go.answers.place_info = () => ({ result: GOA });
    await ago(59);
    expect(await refreshIdeas(h.ctx, go)).toBe(0);
    await ago(61);
    expect(await refreshIdeas(h.ctx, go)).toBe(1);
    expect(await idea('idea_any_goa')).toMatchObject({ photos: [photo(1, 'Beach'), photo(2)], refreshed: true });
    // Answered in full, it now waits a day: an hour on, nothing is asked.
    await ago(61);
    expect(await refreshIdeas(h.ctx, go)).toBe(0);
    // A partial answer never touches photos an idea already has.
    await ago(25 * 60);
    h.go.answers.place_info = () => ({ result: { place: { name: 'Goa', photos: [photo(8)] }, complete: false } });
    await refreshIdeas(h.ctx, go);
    expect((await idea('idea_any_goa')).photos).toEqual([photo(1, 'Beach'), photo(2)]);
  });

  it('keeps the photos it has when Go has none to give: a partial answer, a refusal, an answer outside the contract or one with no photos leaves them, until tomorrow', async () => {
    await onlyDue('idea_any_goa');
    await refreshIdeas(h.ctx, go);
    const kept = await idea('idea_any_goa');
    const again = () => h.pool.query(`update ideas set refresh_tried_at = now() - interval '25 hours' where idea_id = 'idea_any_goa'`);
    for (const answer of [
      { result: { place: { name: 'Goa' }, complete: false } }, // Go could not settle on the place
      { error: { code: 409, message: 'place_info is not available yet.', data: { code: 'conflict' } } },
      { result: { place: { name: 'Goa', photos: [{ url: 'not a url' }] } } },
    ]) {
      await again();
      h.go.answers.place_info = () => answer;
      expect(await refreshIdeas(h.ctx, go)).toBe(0);
      expect(await idea('idea_any_goa')).toEqual(kept);
      expect(await refreshIdeas(h.ctx, go)).toBe(0); // tried today: not asked again
    }
    expect(asks()).toHaveLength(4);
    // A whole answer with no photos and a new tag: the tag is taken, the photos stay.
    await again();
    h.go.answers.place_info = () => ({ result: { place: { name: 'Goa', photos: [] }, tag: 'Beaches and forts' } });
    expect(await refreshIdeas(h.ctx, go)).toBe(1);
    expect(await idea('idea_any_goa')).toEqual({ ...kept, tag: 'Beaches and forts' });
    // A whole answer with photos is Go's newest word, even with fewer of them; a place known by one picture shows that one.
    await again();
    h.go.answers.place_info = () => ({ result: { place: { name: 'Goa', photo_url: photo(9).url } } });
    await refreshIdeas(h.ctx, go);
    expect((await idea('idea_any_goa')).photos).toEqual([photo(9)]);
  });
});
