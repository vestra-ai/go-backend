// A message only some people can see (our 1.1 overlay: post_message `visible_to_person_ids`, migration 013), and "Former
// member" on messages and reactions by people no longer in the trip. Go reads every message; every app read leaves out
// a message whose list does not name the reader, as if it did not exist: the room in both modes, single-message answers,
// live frames and the replay, cards, needs-you, the trip's chat preview and unread count, catch-up, home, taps, reactions,
// replies, "Ask Go about this", edits, deletes and "read up to".
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, v1, type Harness } from './helpers/harness.js';
import { LiveClient, settle } from './helpers/live-client.js';
import { fakeCard, fakeChecklist } from './helpers/mock-go.js';
import { seedTrip } from './helpers/seed.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
const open: LiveClient[] = [];
beforeAll(async () => {
  h = await startHarness({ features: { calls: true, visa: true } }); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
});
afterAll(async () => {
  for (const c of open) c.close();
  await h.stop();
});

let n = 0;
/** Go posts; answers the result, or throws with Go's error. */
const goPost = async (trip: string, params: Record<string, unknown>) => {
  const r = await h.go.call('post_message', { request_id: `rq_vis_${++n}`, trip_id: trip, ...params });
  if (r.error) throw Object.assign(new Error(JSON.stringify(r.error)), { error: r.error });
  return r.result as { message_id: string; seq: number };
};
const goPostError = async (trip: string, params: Record<string, unknown>) => (await h.go.call('post_message', { request_id: `rq_vis_${++n}`, trip_id: trip, ...params })).error;
const say = (who: string, trip: string, text: string, extra: Record<string, unknown> = {}) =>
  t.api(t.as(who), 'POST', v1(`/trips/${trip}/messages`), { client_message_id: `cm-vis-${++n}`, text, ...extra });
const page = async (who: string, trip: string, query = '') => (await t.api(t.as(who), 'GET', v1(`/trips/${trip}/messages${query}`))).body;
const ids = (p: { messages: Array<{ message_id: string }> }) => p.messages.map((m) => m.message_id);
const tripSeq = async (trip: string) => (await rows(h.pool, 'select seq from trips where trip_id = $1', [trip]))[0].seq as number;
const connect = async (who: string) => {
  const c = await LiveClient.open(h, who);
  open.push(c);
  await c.until((f) => f.type === 'hello');
  return c;
};

describe('post_message with visible_to_person_ids (Go)', () => {
  it('takes 1 to 30 unique ids of people in the trip now; anything else is 422 and nothing is stored', async () => {
    const before = await tripSeq('t_goa');
    expect(await goPostError('t_goa', { text: 'x', visible_to_person_ids: [] })).toMatchObject({ code: 422 });
    expect(await goPostError('t_goa', { text: 'x', visible_to_person_ids: ['p_priya', 'p_priya'] })).toMatchObject({ code: 422 });
    expect(await goPostError('t_goa', { text: 'x', visible_to_person_ids: Array.from({ length: 31 }, (_, i) => `p_${i}`) })).toMatchObject({ code: 422 });
    const stranger = await goPostError('t_goa', { text: 'x', visible_to_person_ids: ['p_priya', 'p_nobody'] });
    expect([stranger?.code, stranger?.message]).toEqual([422, expect.stringContaining('visible_to_person_ids: p_nobody')]);
    expect(await tripSeq('t_goa')).toBe(before);
  });

  it('stores the list; read_messages returns every message to Go, with the list; null is everyone', async () => {
    const after = await tripSeq('t_goa');
    const hidden = await goPost('t_goa', { text: 'Your ixigo money applies here', visible_to_person_ids: ['p_priya'] });
    const open_ = await goPost('t_goa', { text: 'For everyone', visible_to_person_ids: null });
    expect((await rows(h.pool, 'select visible_to_person_ids from messages where message_id = $1', [hidden.message_id]))[0].visible_to_person_ids).toEqual(['p_priya']);
    const read = (await h.go.call('read_messages', { trip_id: 't_goa', after_seq: after })).result;
    expect(read.messages.map((m: any) => [m.message_id, m.visible_to_person_ids])).toEqual([[hidden.message_id, ['p_priya']], [open_.message_id, undefined]]);
    await h.flush();
    expect(h.go.events.find((e) => e.type === 'message.created' && e.data.message.message_id === hidden.message_id)?.data.message.visible_to_person_ids).toEqual(['p_priya']);
  });
});

describe('the room for a person inside and a person outside the list', () => {
  let hidden: { message_id: string; seq: number };
  let visible: { message_id: string; seq: number };
  let start: number;
  beforeAll(async () => {
    start = await tripSeq('t_goa');
    visible = await goPost('t_goa', { text: 'Flights for everyone soon' });
    hidden = await goPost('t_goa', { text: 'Your flight options, Priya', card: fakeCard('options', 'c_vis_fl', 'p_priya'), visible_to_person_ids: ['p_priya', 'p_rahul'] });
  });

  it('GET messages, history mode: Priya sees it with the list; Arjun never does, and his page and has_more count only what he may see', async () => {
    const priya = await page('p_priya', 't_goa');
    expect(priya.messages.find((m: any) => m.message_id === hidden.message_id)).toMatchObject({ visible_to_person_ids: ['p_priya', 'p_rahul'], text: 'Your flight options, Priya' });
    expect(priya.messages.find((m: any) => m.message_id === visible.message_id).visible_to_person_ids).toBeUndefined();
    const arjun = await page('p_arjun', 't_goa');
    expect(ids(arjun)).toContain(visible.message_id);
    expect(ids(arjun)).not.toContain(hidden.message_id);
    // limit=1: Arjun's newest is the visible message, not the hidden one after it; Priya's is the hidden one.
    expect(ids(await page('p_arjun', 't_goa', '?limit=1'))).toEqual([visible.message_id]);
    expect(ids(await page('p_priya', 't_goa', '?limit=1'))).toEqual([hidden.message_id]);
    // Paging back past it with before_seq skips it the same way.
    expect(ids(await page('p_arjun', 't_goa', `?before_seq=${hidden.seq + 1}&limit=1`))).toEqual([visible.message_id]);
  });

  it('GET messages, changes mode: only Priya gets it; for Arjun nothing more after the visible one (a gap in seq), has_more false', async () => {
    expect(ids(await page('p_priya', 't_goa', `?after_seq=${start}`))).toEqual([visible.message_id, hidden.message_id]);
    const arjun = await page('p_arjun', 't_goa', `?after_seq=${start}`);
    expect([ids(arjun), arjun.has_more]).toEqual([[visible.message_id], false]);
    const one = await page('p_arjun', 't_goa', `?after_seq=${start}&limit=1`);
    expect([ids(one), one.has_more]).toEqual([[visible.message_id], false]);
    expect((await page('p_priya', 't_goa', `?after_seq=${start}&limit=1`)).has_more).toBe(true);
  });

  it('reacting: 404 for Arjun, as for an unknown message; Priya reacts and gets the Message back', async () => {
    const out = await t.api(t.as('p_arjun'), 'PUT', v1(`/trips/t_goa/messages/${hidden.message_id}/reaction`), { emoji: '👍' });
    const unknown = await t.api(t.as('p_arjun'), 'PUT', v1('/trips/t_goa/messages/m_nope/reaction'), { emoji: '👍' });
    expect([out.status, out.body.error.code]).toEqual([unknown.status, unknown.body.error.code]);
    expect(out.status).toBe(404);
    const inside = await t.api(t.as('p_priya'), 'PUT', v1(`/trips/t_goa/messages/${hidden.message_id}/reaction`), { emoji: '👍' });
    expect([inside.status, inside.body.reactions, inside.body.visible_to_person_ids]).toEqual([200, [{ emoji: '👍', person_id: 'p_priya' }], ['p_priya', 'p_rahul']]);
  });

  it('replying to it and "Ask Go about this": 422 for Arjun, as for an unknown message; fine for Priya', async () => {
    for (const field of ['reply_to', 'about_message_id']) {
      const out = await say('p_arjun', 't_goa', 'what is this?', { [field]: hidden.message_id });
      expect([out.status, out.body.error.field, out.body.error.message]).toEqual([422, field, `${field}: message ${hidden.message_id} is not in this trip`]);
      expect((await say('p_priya', 't_goa', 'tell me more', { [field]: hidden.message_id })).status).toBe(201);
    }
  });

  it('editing and deleting it: 404 for Arjun (a visible message of Go\'s is 403, not his); 403 for Priya, who may see it but did not write it', async () => {
    for (const [method, body] of [['PATCH', { text: 'mine now' }], ['DELETE', undefined]] as const) {
      expect((await t.api(t.as('p_arjun'), method, v1(`/trips/t_goa/messages/${hidden.message_id}`), body)).status).toBe(404);
      expect((await t.api(t.as('p_arjun'), method, v1(`/trips/t_goa/messages/${visible.message_id}`), body)).status).toBe(403);
      expect((await t.api(t.as('p_priya'), method, v1(`/trips/t_goa/messages/${hidden.message_id}`), body)).status).toBe(403);
    }
  });

  it('"read up to" by message_id: 422 for Arjun, as for an unknown message; 204 for Priya', async () => {
    const out = await t.api(t.as('p_arjun'), 'POST', v1('/trips/t_goa/read'), { message_id: hidden.message_id });
    expect([out.status, out.body.error.field]).toEqual([422, 'message_id']);
    expect((await t.api(t.as('p_priya'), 'POST', v1('/trips/t_goa/read'), { message_id: hidden.message_id })).status).toBe(204);
  });

  it('GET cards: the card is there for Priya and not for Arjun', async () => {
    const cardIds = async (who: string) => (await t.api(t.as(who), 'GET', v1('/trips/t_goa/cards?kind=options'))).body.items.map((i: any) => i.card.card_id);
    expect(await cardIds('p_priya')).toContain('c_vis_fl');
    expect(await cardIds('p_arjun')).not.toContain('c_vis_fl');
  });

  it('a tap on the card: Arjun gets the same 404 as an unknown card and Go is not asked; Priya\'s tap reaches Go', async () => {
    const before = h.go.requests.length;
    const out = await t.api(t.as('p_arjun'), 'POST', v1('/trips/t_goa/cards/c_vis_fl/actions'), { action_id: 'pick', option_id: 'opt_fl_1', press_id: 'vis-press-a' });
    const unknown = await t.api(t.as('p_arjun'), 'POST', v1('/trips/t_goa/cards/c_nope/actions'), { action_id: 'pick', press_id: 'vis-press-b' });
    expect([out.status, out.body.error.code]).toEqual([404, unknown.body.error.code]);
    expect(h.go.requests.slice(before).filter((r) => r.method === 'card_tap')).toEqual([]);
    const inside = await t.api(t.as('p_priya'), 'POST', v1('/trips/t_goa/cards/c_vis_fl/actions'), { action_id: 'pick', option_id: 'opt_fl_1', press_id: 'vis-press-c' });
    expect([inside.status, h.go.requests.at(-1)?.method, h.go.requests.at(-1)?.params.person_id]).toEqual([200, 'card_tap', 'p_priya']);
  });

  it('"Share in group chat" on a call card: 404 for Arjun, as for an unknown card; Priya gets the usual 409 (no recording yet)', async () => {
    await goPost('t_goa', { text: 'Calling', card: fakeCard('call', 'c_vis_call', 'p_priya'), visible_to_person_ids: ['p_priya'] });
    expect((await t.api(t.as('p_arjun'), 'POST', v1('/trips/t_goa/cards/c_vis_call/share'), {})).status).toBe(404);
    expect((await t.api(t.as('p_priya'), 'POST', v1('/trips/t_goa/cards/c_vis_call/share'), {})).status).toBe(409);
  });

  it('needs-you: a card naming both in for_person_ids is an item for Priya only, when only Priya may see it', async () => {
    await goPost('t_goa', { text: 'Approve', card: { ...fakeCard('pay', 'c_vis_pay', 'p_priya'), for_person_ids: ['p_priya', 'p_arjun'] }, visible_to_person_ids: ['p_priya'] });
    const items = async (who: string) => (await t.api(t.as(who), 'GET', v1('/trips/t_goa/needs-you'))).body.items.map((i: any) => i.item_id);
    expect(await items('p_priya')).toContain('card:c_vis_pay');
    expect(await items('p_arjun')).not.toContain('card:c_vis_pay');
  });

  it('home: a checklist row still to do is "<title> needed" only on a card the person may see', async () => {
    await goPost('t_goa', { text: 'Visa', card: fakeChecklist('c_vis_visa', [{ person_id: 'p_priya', status: 'todo', label: 'Not yet' }, { person_id: 'p_arjun', status: 'todo', label: 'Not yet' }]), visible_to_person_ids: ['p_priya'] });
    const attention = async (who: string) => (await t.api(t.as(who), 'GET', v1('/home'))).body.trips.find((x: any) => x.trip_id === 't_goa').attention;
    expect(await attention('p_priya')).toEqual({ kind: 'task', label: 'Indonesia e-VOA needed' });
    expect(await attention('p_arjun')).not.toEqual({ kind: 'task', label: 'Indonesia e-VOA needed' });
  });
});

describe('counts and previews', () => {
  beforeAll(async () => {
    await seedTrip(h.pool, 't_vis_count'); // the same five people, an empty room
  });

  it('the trip\'s chat: unread_count, last_message and participants_preview leave out what the person may not see', async () => {
    for (const who of ['p_priya', 'p_arjun']) await t.api(t.as(who), 'POST', v1('/trips/t_vis_count/read'), { up_to_seq: await tripSeq('t_vis_count') });
    const said = await say('p_kabir', 't_vis_count', 'anyone up for dinner?');
    const hidden = await goPost('t_vis_count', { text: 'Only for Priya', visible_to_person_ids: ['p_priya'] });
    const chat = async (who: string) => (await t.api(t.as(who), 'GET', v1('/trips/t_vis_count'))).body.chat;
    const priya = await chat('p_priya');
    const arjun = await chat('p_arjun');
    expect([priya.unread_count, priya.last_message.message_id, priya.participants_preview]).toEqual([2, hidden.message_id, [{ kind: 'go' }, { kind: 'person', person_id: 'p_kabir' }]]);
    expect([arjun.unread_count, arjun.last_message.message_id, arjun.participants_preview]).toEqual([1, said.body.message_id, [{ kind: 'person', person_id: 'p_kabir' }]]);
    expect((await t.api(t.as('p_arjun'), 'GET', v1('/trips/t_vis_count'))).body.me.unread_count).toBe(1);
  });

  it('catch-up counts only what the person may see: 15 messages for Priya alone ask Go for her, and not for Arjun', async () => {
    for (const who of ['p_priya', 'p_arjun']) await t.api(t.as(who), 'POST', v1('/trips/t_vis_count/read'), { up_to_seq: await tripSeq('t_vis_count') });
    await new Promise((r) => setTimeout(r, 20)); // sent_at after last_seen_at
    for (let i = 0; i < 15; i++) await goPost('t_vis_count', { text: `Priya's option ${i}`, visible_to_person_ids: ['p_priya'] });
    expect((await t.api(t.as('p_arjun'), 'GET', v1('/trips/t_vis_count/catch-up'))).status).toBe(204);
    const priya = await t.api(t.as('p_priya'), 'GET', v1('/trips/t_vis_count/catch-up'));
    expect([priya.status, h.go.requests.at(-1)?.method, h.go.requests.at(-1)?.params.person_id]).toEqual([200, 'catch_up', 'p_priya']);
  });
});

describe('live frames and the replay', () => {
  beforeAll(async () => {
    await seedTrip(h.pool, 't_vis_live');
  });

  it('a message frame and a card frame go only to the people in the list; the others still get the room\'s other messages', async () => {
    const priya = await connect('p_priya');
    const arjun = await connect('p_arjun');
    const seq = await tripSeq('t_vis_live');
    priya.subscribe('t_vis_live', seq);
    arjun.subscribe('t_vis_live', seq);
    await settle(200);
    const card = fakeCard('notice', 'c_vis_live', 'p_priya');
    const hidden = await goPost('t_vis_live', { text: 'Only Priya', card, visible_to_person_ids: ['p_priya'] });
    const frame = await priya.until((f) => f.type === 'message' && f.message.message_id === hidden.message_id);
    expect(frame.message).toMatchObject({ text: 'Only Priya', visible_to_person_ids: ['p_priya'] });
    await h.go.call('replace_card', { trip_id: 't_vis_live', card: { ...card, body: 'Changed' } });
    expect((await priya.until((f) => f.type === 'card' && f.message_id === hidden.message_id)).card.body).toBe('Changed');
    const after = await say('p_kabir', 't_vis_live', 'for all');
    await arjun.until((f) => f.type === 'message' && f.message.message_id === after.body.message_id); // frames after it reached him
    await settle(100);
    expect(arjun.frames.filter((f) => f.message_id === hidden.message_id || f.message?.message_id === hidden.message_id)).toEqual([]);
  });

  it('the subscribe replay holds the message for Priya and not for Arjun', async () => {
    const seq = await tripSeq('t_vis_live');
    const hidden = await goPost('t_vis_live', { text: 'Replay for Priya', visible_to_person_ids: ['p_priya'] });
    const shown = await goPost('t_vis_live', { text: 'Replay for all' });
    const priya = await connect('p_priya');
    const arjun = await connect('p_arjun');
    priya.subscribe('t_vis_live', seq);
    arjun.subscribe('t_vis_live', seq);
    await priya.until((f) => f.type === 'trip_changed');
    await arjun.until((f) => f.type === 'trip_changed');
    expect(priya.of('message').map((f) => f.message.message_id)).toEqual([hidden.message_id, shown.message_id]);
    expect(arjun.of('message').map((f) => f.message.message_id)).toEqual([shown.message_id]);
    expect(arjun.of('trip_changed')).toEqual([{ type: 'trip_changed', trip_id: 't_vis_live', seq: shown.seq }]); // the same seq: the gap is harmless
  });

  it('a person in the list who leaves stops seeing the trip, as any leave', async () => {
    const hidden = await goPost('t_vis_live', { text: 'Meher only', visible_to_person_ids: ['p_meher'] });
    expect(ids(await page('p_meher', 't_vis_live'))).toContain(hidden.message_id);
    await t.api(t.as('p_meher'), 'POST', v1('/trips/t_vis_live/leave'), {});
    expect((await t.api(t.as('p_meher'), 'GET', v1('/trips/t_vis_live/messages'))).status).toBe(403);
  });
});

describe('"Former member": messages and reactions by people no longer in the trip', () => {
  beforeAll(async () => {
    await seedTrip(h.pool, 't_former');
    await seedTrip(h.pool, 't_former_del', [{ id: 'p_rahul', name: 'Rahul', role: 'organizer' }, { id: 'p_zoe', name: 'Zoe' }]);
  });

  it('after a leave: the author says former: true in the room, on a live frame and in the replay, and so does the reaction; Go\'s reads are unchanged', async () => {
    const start = await tripSeq('t_former');
    const kabirs = await say('p_kabir', 't_former', 'see you all');
    const priyas = await say('p_priya', 't_former', 'bye Kabir');
    await t.api(t.as('p_kabir'), 'PUT', v1(`/trips/t_former/messages/${priyas.body.message_id}/reaction`), { emoji: '👋' });
    expect(kabirs.body.author).toEqual({ kind: 'person', person_id: 'p_kabir' }); // still in the trip: no mark
    await t.api(t.as('p_kabir'), 'POST', v1('/trips/t_former/leave'), {});

    const room = await page('p_rahul', 't_former');
    const of = (id: string) => room.messages.find((m: any) => m.message_id === id);
    expect(of(kabirs.body.message_id).author).toEqual({ kind: 'person', person_id: 'p_kabir', former: true });
    expect(of(priyas.body.message_id).author).toEqual({ kind: 'person', person_id: 'p_priya' });
    expect(of(priyas.body.message_id).reactions).toEqual([{ emoji: '👋', person_id: 'p_kabir', former: true }]);

    // Live: Rahul reacts to Kabir's message; the frame carries the mark too.
    const rahul = await connect('p_rahul');
    rahul.subscribe('t_former', await tripSeq('t_former'));
    await settle(200);
    await t.api(t.as('p_rahul'), 'PUT', v1(`/trips/t_former/messages/${kabirs.body.message_id}/reaction`), { emoji: '❤️' });
    const live = await rahul.until((f) => f.type === 'message' && f.message.message_id === kabirs.body.message_id);
    expect([live.message.author, live.message.reactions]).toEqual([{ kind: 'person', person_id: 'p_kabir', former: true }, [{ emoji: '❤️', person_id: 'p_rahul' }]]);

    // The replay.
    const meher = await connect('p_meher');
    meher.subscribe('t_former', start);
    await meher.until((f) => f.type === 'trip_changed');
    const replayed = meher.of('message').find((f) => f.message.message_id === priyas.body.message_id)!;
    expect(replayed.message.reactions).toEqual([{ emoji: '👋', person_id: 'p_kabir', former: true }]);
    expect(meher.of('message').find((f) => f.message.message_id === kabirs.body.message_id)!.message.author.former).toBe(true);

    // Go: no `former` anywhere.
    const read = (await h.go.call('read_messages', { trip_id: 't_former', after_seq: start })).result;
    const goKabir = read.messages.find((m: any) => m.message_id === kabirs.body.message_id);
    expect(goKabir.author).toEqual({ kind: 'person', person_id: 'p_kabir' });
    expect(read.messages.find((m: any) => m.message_id === priyas.body.message_id).reactions).toEqual([{ emoji: '👋', person_id: 'p_kabir' }]);
  });

  it('back in the trip: the mark is gone', async () => {
    await t.api(t.as('p_kabir'), 'POST', v1('/invites/inv_t_former/accept'), {});
    const room = await page('p_rahul', 't_former');
    expect(room.messages.filter((m: any) => m.author.person_id === 'p_kabir').map((m: any) => m.author.former)).toEqual([undefined]);
  });

  it('after an account delete: the author says former: true, and the chat preview\'s author too', async () => {
    const zoes = await say('p_zoe', 't_former_del', 'last words');
    const r = await t.api(t.as('p_zoe'), 'DELETE', v1('/me'), { confirm: true });
    expect(r.status).toBe(202);
    const room = await page('p_rahul', 't_former_del');
    expect(room.messages.find((m: any) => m.message_id === zoes.body.message_id).author).toEqual({ kind: 'person', person_id: 'p_zoe', former: true });
    await t.api(t.as('p_rahul'), 'POST', v1('/trips/t_former_del/messages'), { client_message_id: 'x', text: 'rest well' });
    await h.pool.query(`update messages set deleted = true where trip_id = 't_former_del' and author_person_id = 'p_rahul'`); // so Zoe's is the last message again
    expect((await t.api(t.as('p_rahul'), 'GET', v1('/trips/t_former_del'))).body.chat.last_message.author).toEqual({ kind: 'person', person_id: 'p_zoe', former: true });
  });
});
