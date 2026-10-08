// §4.7 and §4.11: Go's cards. A press on a card button (forwarded to Go as a card_tap, Go's answer handed back), the
// Trip home's query for live cards by kind and state, and "Share in group chat" for an ended call's recording.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { cardTap, TAP_UNANSWERED } from '../../domain/ask-go.js';
import { CARDS_MAX, listCards, shareCallRecording } from '../../domain/cards.js';
import { conflict } from '../../domain/errors.js';
import { RateLimiter } from '../rate-limit.js';
import { checkCardAction } from '../bodies.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { inTrip, type V1Deps } from './shared.js';

/** App contract Appendix A: 10 card taps a minute per person per trip; a repeat of the same press_id is free. */
export const CARD_TAPS_PER_MINUTE = 10;

const CALL = { card_id: 'c_call_1', kind: 'call', fallback_text: 'Go is calling Villa Sol', call_id: 'call_1', business: 'Villa Sol', goal: 'Ask about late check-in', state: 'talking', started_at: '2026-10-08T09:00:00Z', last_line: { who: 'them', text: 'Yes, 11 pm is fine.' }, actions: [{ action_id: 'stop', label: 'Stop', style: 'secondary' }, { action_id: 'listen', label: 'Listen in', style: 'secondary' }] };
const ENDED = { ...CALL, state: 'ended', ended_at: '2026-10-08T09:03:12Z', outcome: 'Late check-in until 11 pm confirmed', recording_url: 'https://brain.go.example/recordings/call_1.m4a?sig=…', duration_s: 192, actions: [] };
const refused = (status: number, code: string, msg: string) => ({ name: code, status, body: { error: { code, message: msg, field: null, retry_after_seconds: null, request_id: 'req_01JA7Q3V8Z' } } });

export const routes: RouteMeta[] = [
  {
    method: 'POST', path: '/app/v1/trips/:trip/cards/:card_id/actions', section: SECTIONS.cards, title: 'Press a card button',
    summary: `{ action_id, option_id?, press_id, payload? }: a tap on a Go card (options, working, call, pay, notice, checklist). press_id becomes Go's tap_id (a double tap is one tap); payload { trip: oneway | round } goes through to Go. Answers Go's CardActionResult: done | open { url, expires_at } | refused { toast }. \`listen\` on a live call card is one of these: Go answers open with its listen-in page. When Go does not answer: 200 refused "Go didn't answer. Try again." Record cards (vote, mandate, expense) are the Server's own: 422. ${CARD_TAPS_PER_MINUTE} taps a minute per person per trip (429); a repeat of the same press_id is not counted.`,
    example: {
      body: { action_id: 'pick', option_id: 'opt_flight_1', press_id: '9a1c3c2e-7b1e-4f0d-9d3c-1a2b3c4d5e6f', payload: { trip: 'round' } },
      responses: [
        { name: 'done', status: 200, body: { result: 'done', toast: 'Noted. Go will reply in the room.' } },
        { name: 'open a page', status: 200, body: { result: 'open', url: 'https://brain.go.example/vault/approve?link=lk_4Rt8Zp2Lq', expires_at: '2026-10-05T09:06:30Z' } },
        { name: 'Go did not answer', status: 200, body: TAP_UNANSWERED },
        { name: 'rate_limited', status: 429, body: { error: { code: 'rate_limited', message: `at most ${CARD_TAPS_PER_MINUTE} card taps a minute: slow down`, field: null, retry_after_seconds: 42, request_id: 'req_01JA7Q3V8Z' } } },
      ],
    },
  },
  {
    method: 'GET', path: '/app/v1/trips/:trip/cards', section: SECTIONS.needsYou, title: "Go's cards by kind and state",
    summary: `The latest version of each card in the room (after replace_card), newest first, at most ${CARDS_MAX}: { items: [{ message_id, card, posted_at }] }. ?kind= any card kind; ?state= a comma list, for kinds that have a state (call: dialing,talking,ended,failed; working: running,done,failed; pay: waiting,paid,cancelled,expired). The Trip home's "Go's calls" reads ?kind=call&state=dialing,talking. Cards are not filtered by for_person_ids here; a card's for_person_ids is returned as stored. An ended call card carries recording_url and duration_s when Go recorded it.`,
    example: { query: { kind: 'call', state: 'dialing,talking' }, responses: [{ name: 'live calls', status: 200, body: { items: [{ message_id: 'm_0190', card: CALL, posted_at: '2026-10-08T09:00:00Z' }] } }, { name: 'ended calls (?kind=call&state=ended)', status: 200, body: { items: [{ message_id: 'm_0190', card: ENDED, posted_at: '2026-10-08T09:00:00Z' }] } }] },
  },
  {
    method: 'POST', path: '/app/v1/trips/:trip/cards/:card_id/share', section: SECTIONS.needsYou, title: 'Share a call recording in the room',
    summary: 'Behind features.calls (409 when off). For an ended call card with a recording: the Server copies the recording into its own storage (audio, at most 25 MB) and posts a message by you, "Call with <business> · <outcome>", with the recording as a file attachment (name, mime, size_bytes, duration_s; a signed link minted on every read). Go hears message.created. One message per card: sharing it again answers that message. 409 when the card is not an ended call with a recording; 503 when the recording could not be fetched.',
    example: {
      responses: [
        { name: 'shared', status: 201, body: { message_id: 'm_0195', seq: 77, updated_seq: 77, author: { kind: 'person', person_id: 'p_rahul' }, text: 'Call with Villa Sol · Late check-in until 11 pm confirmed', attachments: [{ kind: 'file', url: 'https://…/storage/v1/object/sign/go-files/recordings/t_goa/c_call_1.m4a?token=…', name: 'Villa Sol call.m4a', mime: 'audio/mp4', size_bytes: 1532211, duration_s: 192, upload_id: 'up_01JB' }], mentions_go: false, mentions: [], reactions: [], withheld: false, deleted: false, sent_at: '2026-10-08T09:10:00Z' } },
        refused(409, 'conflict', 'card c_call_1 is not an ended call with a recording'),
        refused(409, 'conflict', 'sharing call recordings is not on yet (features.calls)'),
      ],
    },
  },
];

const text = (max: number) => ({ type: 'string', minLength: 1, maxLength: max, pattern: '^[a-z_,]+$' }) as const;

export function register(app: FastifyInstance, ctx: Ctx, deps: V1Deps): void {
  const taps = new RateLimiter(() => ctx.limits?.cardTapsPerMinute ?? CARD_TAPS_PER_MINUTE, 60_000, { what: 'card taps' });
  app.post('/app/v1/trips/:trip/cards/:card_id/actions', inTrip(ctx, (req, trip, me) => {
    const input = checkCardAction(req.body);
    taps.takeOnce(`${me}:${trip}`, input.press_id); // the same press again (a double tap, a retry) is one tap for Go, and free here
    return cardTap(ctx, deps.go, trip, me, { card_id: req.params.card_id!, ...input });
  }));
  app.get('/app/v1/trips/:trip/cards', {
    schema: { querystring: { type: 'object', properties: { kind: text(32), state: text(200) } } },
    ...inTrip(ctx, (req, trip) => listCards(ctx, trip, { kind: req.query.kind, state: req.query.state })),
  });
  app.post('/app/v1/trips/:trip/cards/:card_id/share', inTrip(ctx, (req, trip, me) => {
    if (!deps.features.calls) throw conflict('sharing call recordings is not on yet (features.calls)');
    return shareCallRecording(ctx, trip, me, req.params.card_id!);
  }, 201));
}
