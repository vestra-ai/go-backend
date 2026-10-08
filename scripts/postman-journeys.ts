// The "Run in order" folder of the Postman collection: one end-to-end run of the app API against the local dev stack
// (`pnpm dev:stack --features checkin,visa,calls`), with a check on every answer and the ids saved to the environment as it goes.
// scripts/postman-build.ts turns these steps into Postman requests with their pre-request and test scripts. Nothing here
// touches the server: when a step disagrees with the server, it is the step (or the contract) that needs looking at.
//
// Who is who (the seeded names): Aarav Shah is the organizer ({{token}}), Priya joins by the invite link ({{token2}}),
// Kabir signs in but never joins (the outsider, {{token3}}). The trip is Goa 🌴.
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** Whose bearer token the request carries: Aarav's is the collection's default. `bad` sends a made-up token. */
export type As = 'token' | 'token2' | 'token3' | 'none' | 'bad';

export interface Step {
  name: string;
  method: Method;
  /** A full address with Postman variables: `{{baseUrl}}/trips/{{tripId}}`, `{{authUrl}}/mint?…`, `{{goUrl}}/sim/open_vote`, `{{uploadUrl}}`. */
  url: string;
  as?: As;
  /** An object goes as JSON; a string goes as raw text (broken JSON, file bytes). */
  body?: unknown;
  headers?: Record<string, string>;
  /** Local stack only (the fake Supabase Auth, the act-as-Go port, what depends on them): skipped unless the environment says local = true. */
  local?: boolean;
  /** Acts as Go through the dev stack's control port: local only, shown as [Go]. */
  go?: boolean;
  /** Skipped unless GET /config (step 1) said this flag is on. */
  feature?: 'checkin' | 'visa' | 'calls';
  /** Leave the Idempotency-Key header off (the default is a fresh one on every write). */
  noIdempotency?: boolean;
  /** Lines added to the pre-request script. */
  pre?: string[];
  /** The expected status, or any of these. */
  status: number | number[];
  /** Named checks on `j` (the parsed answer); `env('key')` reads the environment. */
  checks?: Array<[name: string, expression: string]>;
  /** Environment keys saved from the answer (expressions on `j`), only when the answer was a success. */
  save?: Record<string, string>;
  /** Extra lines at the end of the test script. */
  test?: string[];
  description?: string;
}

export interface JourneyFolder { name: string; description?: string; steps: Step[] }

const B = '{{baseUrl}}';
const T = `${B}/trips/{{tripId}}`;
const ERR = (code: string): [string, string] => [`error.code is ${code}`, `j.error && j.error.code === '${code}' && typeof j.error.request_id === 'string'`];
const JOURNEY = { mode: 'flight', origin: { name: 'Bengaluru', code: 'BLR' }, destination: { name: 'Mopa', code: 'GOX' }, depart_at: '2026-11-06T19:40:00+05:30', arrive_at: '2026-11-06T21:55:00+05:30', carrier_name: 'IndiGo', carrier_code: '6E', number: '5313' };
const PAY_CARD = (state: 'waiting' | 'paid') => ({
  card_id: 'c_pay_{{runId}}', kind: 'pay', fallback_text: state === 'waiting' ? 'Aarav, approve ₹54,200 for Villa Sol' : 'Paid ₹54,200 for Villa Sol',
  for_person_ids: state === 'waiting' ? ['{{personId}}'] : [], approval_id: '{{approvalId}}', payer_person_id: '{{personId}}',
  amount_minor: 5420000, currency: 'INR', merchant: 'ixigo: Villa Sol', purpose: 'Villa Sol, 3 nights', expires_at: '2099-01-01T00:00:00Z', state,
  actions: state === 'waiting' ? [{ action_id: 'approve', label: 'Approve', style: 'primary', only_for_person_ids: ['{{personId}}'] }, { action_id: 'decline', label: 'Not now', style: 'secondary', only_for_person_ids: ['{{personId}}'] }] : [],
});
const SPEND = { request_id: 'pm-{{runId}}-spend-1', trip_id: '{{tripId}}', decision_id: '{{goDecisionId}}', amount_minor: 5420000, currency: 'INR', merchant: 'ixigo: Villa Sol', purpose: 'Villa Sol, 3 nights', refundable_until: '2099-01-01T00:00:00Z' };

export const journeys: JourneyFolder[] = [
  {
    name: '1. Config and health',
    description: 'What the app reads before anything else (§4.14), with no sign-in. The feature flags are kept in the environment: the check-in steps run only when `features.checkin` is on.',
    steps: [
      { name: 'Config: contract version and feature flags', method: 'GET', url: `${B}/config`, as: 'none', status: 200,
        checks: [['contract, min_client_version, currency_default, features, vapid_public_key', "typeof j.contract === 'string' && typeof j.min_client_version === 'string' && j.currency_default === 'INR' && j.features && typeof j.features.checkin === 'boolean' && 'vapid_public_key' in j"]],
        test: ["pm.environment.set('runId', Date.now().toString(36)); // new people, ids and keys on every run",
          "for (const f of ['checkin', 'visa', 'calls']) pm.environment.set('feature' + f[0].toUpperCase() + f.slice(1), String(j.features && j.features[f] === true));"] },
      { name: 'Health: up, and whether Go is connected', method: 'GET', url: `${B}/health`, as: 'none', status: 200, checks: [['ok true; go is a boolean', "j.ok === true && typeof j.go === 'boolean'"]],
        description: '`go` is true while the signed socket to Go is open. Against the dev stack it can read false for a second or two every 40 s: the fake Go never pings, so the server\'s idle close (IDLE_CLOSE_SECONDS) drops the socket and the backoff reopens it.' },
    ],
  },
  {
    name: '2. Sign in: Aarav, Priya and an outsider',
    description: 'Locally the dev stack runs a fake Supabase Auth: `GET {{authUrl}}/mint?name=&email=` answers an access token exactly like the real one (§1.2, rev 3: the Server never issues tokens). A new email each run makes new people. Against Railway these three mint steps are skipped: put real test-user tokens from `pnpm supabase:token` in `token`, `token2` and `token3` first. The person is created on the first request with the token.',
    steps: [
      { name: 'Mint a token for Aarav (fake Supabase Auth)', method: 'GET', url: '{{authUrl}}/mint?name=Aarav%20Shah&email=aarav.{{runId}}@gmail.com', as: 'none', local: true, status: 200, checks: [['access_token', "typeof j.access_token === 'string' && j.token_type === 'bearer'"]], save: { token: 'j.access_token' } },
      { name: 'Mint a token for Priya', method: 'GET', url: '{{authUrl}}/mint?name=Priya&email=priya.{{runId}}@gmail.com', as: 'none', local: true, status: 200, save: { token2: 'j.access_token' } },
      { name: 'Mint a token for Kabir (never joins the trip)', method: 'GET', url: '{{authUrl}}/mint?name=Kabir&email=kabir.{{runId}}@gmail.com', as: 'none', local: true, status: 200, save: { token3: 'j.access_token' } },
      { name: 'Me: Aarav, created on first sign-in', method: 'GET', url: `${B}/me`, status: 200,
        checks: [['Me has person_id, name, email, auth_provider, counts', "typeof j.person_id === 'string' && typeof j.name === 'string' && typeof j.email === 'string' && ['google', 'email'].includes(j.auth_provider) && j.counts && typeof j.counts.active_trips === 'number'"], ['no cache (private data)', "/no-store/.test(pm.response.headers.get('Cache-Control') || '')"]],
        save: { personId: 'j.person_id' } },
      { name: 'Me: Priya', method: 'GET', url: `${B}/me`, as: 'token2', status: 200, save: { personId2: 'j.person_id' } },
      { name: 'Me: Kabir', method: 'GET', url: `${B}/me`, as: 'token3', status: 200, save: { personId3: 'j.person_id' } },
      { name: 'Aarav saves his UPI id (for the pay link later)', method: 'PUT', url: `${B}/me/upi`, body: { upi_id: 'aarav@okhdfc' }, status: 200, checks: [['has_upi true, the id only masked', "j.has_upi === true && typeof j.upi_id_masked === 'string' && !JSON.stringify(j).includes('aarav@okhdfc')"]] },
      { name: 'Priya sets her default city', method: 'PATCH', url: `${B}/me`, as: 'token2', body: { from_city: 'Delhi' }, status: 200, checks: [['from_city saved', "j.from_city === 'Delhi'"]] },
    ],
  },
  {
    name: '3. A trip and the invite link',
    description: 'Aarav creates Goa 🌴 (§4.4) and gets the TripView; the invite link (§4.3) previews with no sign-in, Priya keeps it for later (it shows on her home, §4.2), accepts with her join answers and lands on the trip home; Aarav rotates the link and the old code answers revoked. Other members never see each other\'s from_city (§1.7, rev 3).',
    steps: [
      { name: 'Aarav creates the trip', method: 'POST', url: `${B}/trips`, body: { title: 'Goa 🌴', destination_hint: 'Goa', dates: { start: '2026-11-06', end: '2026-11-09' }, from_city: 'Bengaluru' }, status: 201,
        checks: [['TripView: trip_id, invite_url with /j/<code>, me.person.role organizer, stage, can', "typeof j.trip_id === 'string' && /\\/j\\/[A-Za-z0-9_-]+$/.test(j.invite_url) && j.me && j.me.person.role === 'organizer' && typeof j.stage === 'string' && j.can && j.can.invite === true && typeof j.seq === 'number'"]],
        save: { tripId: 'j.trip_id', inviteCode: "j.invite_url.split('/j/')[1]" } },
      { name: 'Invite preview (no sign-in)', method: 'GET', url: `${B}/invites/{{inviteCode}}`, as: 'none', status: 200,
        checks: [['pending, the trip, the inviter, one person in', "j.state === 'pending' && j.trip && j.trip.title === 'Goa 🌴' && j.inviter && j.inviter.person_id === env('personId') && j.joined_count === 1 && Array.isArray(j.people_preview)"]] },
      { name: 'Priya: not now', method: 'POST', url: `${B}/invites/{{inviteCode}}/later`, as: 'token2', status: 204 },
      { name: 'Priya\'s home shows the invite she kept', method: 'GET', url: `${B}/home`, as: 'token2', status: 200,
        checks: [['invites has the code, with inviter and faces; no trips yet', "j.invites.some(i => i.code === env('inviteCode') && i.inviter && i.inviter.person_id === env('personId') && Array.isArray(i.people_preview)) && Array.isArray(j.trips) && typeof j.seq_hint === 'number'"]] },
      { name: 'Priya accepts with her join answers', method: 'POST', url: `${B}/invites/{{inviteCode}}/accept`, as: 'token2', body: { join_answers: { from_city: 'Delhi', earliest_leave: 'Fri after 6 pm', vibe: 'beach', spend_band: '15to25' } }, status: 200,
        checks: [['trip_id, seq, landing trip_home (no messages yet)', "j.trip_id === env('tripId') && typeof j.seq === 'number' && j.landing === 'trip_home'"]] },
      { name: 'Priya accepts again: already a member, the landing only', method: 'POST', url: `${B}/invites/{{inviteCode}}/accept`, as: 'token2', body: {}, status: 200, checks: [['same trip, a landing', "j.trip_id === env('tripId') && ['chat', 'trip_home'].includes(j.landing)"]] },
      { name: 'Priya\'s home now has the trip', method: 'GET', url: `${B}/home`, as: 'token2', status: 200, checks: [['trips has Goa 🌴, invites no longer', "j.trips.some(t => t.trip_id === env('tripId') && t.title === 'Goa 🌴' && t.attention) && !j.invites.some(i => i.code === env('inviteCode'))"]] },
      { name: 'Aarav reads the TripView: two people, Priya\'s city hidden', method: 'GET', url: T, status: 200,
        checks: [['people 2; the other member has no from_city or earliest_leave; mine does', "j.people.length === 2 && j.people.find(p => p.person_id === env('personId2')).from_city === undefined && j.people.find(p => p.person_id === env('personId2')).earliest_leave === undefined && j.me.person.from_city === 'Bengaluru'"], ['ETag is the seq', `pm.response.headers.get('ETag') === '"' + j.seq + '"'`]],
        save: { tripSeq: 'j.seq' } },
      { name: 'Same seq with If-None-Match: 304', method: 'GET', url: T, headers: { 'If-None-Match': '"{{tripSeq}}"' }, status: 304 },
      { name: 'Priya\'s answers in this trip', method: 'GET', url: `${T}/me`, as: 'token2', status: 200, checks: [['from_city, know with the vibe, a budget from the spend band, role member', "j.from_city === 'Delhi' && Array.isArray(j.know) && j.know.some(k => /Vibe/.test(k)) && j.budget && typeof j.budget.min_minor === 'number' && j.role === 'member' && j.go_paused === false"]] },
      { name: 'Aarav sets his budget', method: 'PUT', url: `${T}/me/budget`, body: { min_minor: 1500000, max_minor: 2500000, currency: 'INR' }, status: 200, checks: [['my answer and the group summary', "j.budget.min_minor === 1500000 && j.summary && j.summary.answered >= 1 && j.summary.of === 2 && j.summary.lowest"]] },
      { name: 'The invite link for the Share sheet', method: 'GET', url: `${T}/invite`, status: 200, checks: [['the current code', "j.code === env('inviteCode') && j.invite_url.endsWith(j.code)"]] },
      { name: 'Priya cannot rotate the link: 403', method: 'POST', url: `${T}/invite/rotate`, as: 'token2', body: {}, status: 403, checks: [ERR('forbidden')] },
      { name: 'Aarav rotates the link', method: 'POST', url: `${T}/invite/rotate`, body: {}, status: 200,
        checks: [['a new code', "typeof j.code === 'string' && j.code !== env('inviteCode')"]],
        test: ["if (pm.response.code === 200) { pm.environment.set('oldInviteCode', pm.environment.get('inviteCode')); pm.environment.set('inviteCode', j.code); }"] },
      { name: 'The old link answers revoked', method: 'GET', url: `${B}/invites/{{oldInviteCode}}`, as: 'none', status: 200, checks: [['state revoked', "j.state === 'revoked'"]] },
      { name: 'A made-up link: 404', method: 'GET', url: `${B}/invites/nope-{{runId}}`, as: 'none', status: 404, checks: [ERR('not_found')] },
    ],
  },
  {
    name: '4. The room',
    description: 'Messages (§4.6): client_message_id makes a repeat the same message; the two read modes (history by seq, changes by updated_seq); one reaction per person (a new emoji replaces it, null takes it back); edit and delete your own; mark read (§4.4) and the unread count in the TripView. Messages here never name @Go, so the fake Go stays quiet and the room is predictable.',
    steps: [
      { name: 'A live ticket (§3: the socket is wscat\'s, not Postman\'s)', method: 'POST', url: `${B}/live/ticket`, body: { device_id: 'postman-{{runId}}' }, status: 201, checks: [['ticket and expires_at', "/^tk_/.test(j.ticket) && typeof j.expires_at === 'string'"]] },
      { name: 'Aarav posts a message', method: 'POST', url: `${T}/messages`, body: { client_message_id: 'cm-{{runId}}-1', text: 'in, but only after 6pm fri' }, status: 201,
        checks: [['Message by Aarav, seq, no mention of Go', "/^m_/.test(j.message_id) && j.author.kind === 'person' && j.author.person_id === env('personId') && j.text === 'in, but only after 6pm fri' && typeof j.seq === 'number' && j.mentions_go === false && j.deleted === false"]],
        save: { messageId: 'j.message_id' } },
      { name: 'The same client_message_id again: the same message', method: 'POST', url: `${T}/messages`, body: { client_message_id: 'cm-{{runId}}-1', text: 'in, but only after 6pm fri' }, status: 201, checks: [['same message_id', "j.message_id === env('messageId')"]] },
      { name: 'Priya replies', method: 'POST', url: `${T}/messages`, as: 'token2', body: { client_message_id: 'cm-{{runId}}-2', text: 'same, my Delhi flight lands 9pm', reply_to: '{{messageId}}' }, status: 201, checks: [['reply_to set', "j.reply_to === env('messageId')"]], save: { messageId2: 'j.message_id' } },
      { name: 'History mode: the newest page', method: 'GET', url: `${T}/messages?limit=50`, status: 200,
        checks: [['messages ascending by seq, has_more, seq', "Array.isArray(j.messages) && j.messages.some(m => m.message_id === env('messageId')) && typeof j.has_more === 'boolean' && typeof j.seq === 'number' && j.messages.every((m, i, a) => i === 0 || a[i - 1].seq < m.seq)"]] },
      { name: 'Changes mode: everything since seq 0', method: 'GET', url: `${T}/messages?after_seq=0&limit=200`, status: 200, checks: [['both messages, by updated_seq', "j.messages.some(m => m.message_id === env('messageId')) && j.messages.some(m => m.message_id === env('messageId2')) && j.messages.every(m => typeof m.updated_seq === 'number')"]] },
      { name: 'Both cursors at once: 422', method: 'GET', url: `${T}/messages?before_seq=5&after_seq=1`, status: 422, checks: [['invalid, field after_seq', "j.error.code === 'invalid' && j.error.field === 'after_seq'"]] },
      { name: 'Priya reacts 🔥', method: 'PUT', url: `${T}/messages/{{messageId}}/reaction`, as: 'token2', body: { emoji: '🔥' }, status: 200, checks: [['her reaction on the Message', "j.reactions.some(r => r.emoji === '🔥' && r.person_id === env('personId2'))"]] },
      { name: 'Priya changes it to 👍 (replaces, one per person)', method: 'PUT', url: `${T}/messages/{{messageId}}/reaction`, as: 'token2', body: { emoji: '👍' }, status: 200, checks: [['only 👍', "j.reactions.filter(r => r.person_id === env('personId2')).map(r => r.emoji).join() === '👍'"]] },
      { name: 'Priya takes it back (null)', method: 'PUT', url: `${T}/messages/{{messageId}}/reaction`, as: 'token2', body: { emoji: null }, status: 200, checks: [['no reactions', 'j.reactions.length === 0']] },
      { name: 'Aarav edits his message', method: 'PATCH', url: `${T}/messages/{{messageId}}`, body: { text: 'in, after 7pm fri' }, status: 200, checks: [['new text, edited_at, updated_seq moved', "j.text === 'in, after 7pm fri' && typeof j.edited_at === 'string' && j.updated_seq > j.seq"]] },
      { name: 'Priya cannot edit it: 403', method: 'PATCH', url: `${T}/messages/{{messageId}}`, as: 'token2', body: { text: 'nope' }, status: 403, checks: [ERR('forbidden')] },
      { name: 'Aarav has one unread (Priya\'s)', method: 'GET', url: `${T}?include=people`, status: 200, checks: [['me.unread_count ≥ 1 and chat.unread_count agree', 'j.me.unread_count >= 1 && j.chat.unread_count === j.me.unread_count']] },
      { name: 'Aarav marks the room read up to Priya\'s message', method: 'POST', url: `${T}/read`, body: { message_id: '{{messageId2}}' }, status: 204 },
      { name: 'Now nothing is unread', method: 'GET', url: `${T}?include=people`, status: 200, checks: [['me.unread_count 0, last_read_seq set', 'j.me.unread_count === 0 && j.me.last_read_seq > 0']] },
      { name: 'Aarav deletes his message', method: 'DELETE', url: `${T}/messages/{{messageId}}`, status: 200, checks: [['deleted, no text', "j.deleted === true && j.text === undefined && j.attachments.length === 0"]] },
      { name: 'Catch-up: not away long enough (204), or Go\'s summary', method: 'GET', url: `${T}/catch-up`, status: [200, 204] },
    ],
  },
  {
    name: '5. An upload in a message',
    description: 'Uploads (§4.5): the Server signs a one-off upload link, the app PUTs the bytes straight to storage (the dev stack\'s in-memory storage serves that link itself), then names the upload_id in a message; the attachment comes back with a signed link.',
    steps: [
      { name: 'Sign an upload (a 4-byte "photo")', method: 'POST', url: `${B}/uploads`, body: { purpose: 'chat_attachment', kind: 'photo', mime: 'image/jpeg', name: 'seats.jpg', size_bytes: 4, width: 1280, height: 960 }, status: 201,
        checks: [['upload_id, upload_url, headers, expires_at, max_size_bytes', "/^up_/.test(j.upload_id) && /^https?:\\/\\//.test(j.upload_url) && j.headers && j.headers['content-type'] === 'image/jpeg' && typeof j.expires_at === 'string' && j.max_size_bytes === 26214400"]],
        save: { uploadId: 'j.upload_id', uploadUrl: 'j.upload_url' } },
      { name: 'PUT the bytes to upload_url', method: 'PUT', url: '{{uploadUrl}}', as: 'none', body: 'JPEG', headers: { 'Content-Type': 'image/jpeg', 'x-upsert': 'false' }, noIdempotency: true, status: 200, description: 'The bytes go to storage, not to the API: no bearer token, the Content-Type the sign answer gave. One PUT per link.' },
      { name: 'A message with the attachment', method: 'POST', url: `${T}/messages`, body: { client_message_id: 'cm-{{runId}}-3', text: 'our seats', attachments: [{ upload_id: '{{uploadId}}', caption: 'Seats' }] }, status: 201,
        checks: [['attachment photo with a signed link, size and caption', "j.attachments.length === 1 && j.attachments[0].kind === 'photo' && j.attachments[0].upload_id === env('uploadId') && /^https?:\\/\\//.test(j.attachments[0].url) && j.attachments[0].caption === 'Seats' && j.attachments[0].width === 1280"]],
        save: { messageId3: 'j.message_id' } },
      { name: 'An upload of the wrong type: 422', method: 'POST', url: `${B}/uploads`, body: { purpose: 'chat_attachment', kind: 'photo', mime: 'image/gif', size_bytes: 10 }, status: 422, checks: [['invalid, field mime', "j.error.code === 'invalid' && j.error.field === 'mime'"]] },
      { name: 'Priya signs a profile photo', method: 'POST', url: `${B}/uploads`, as: 'token2', body: { purpose: 'profile_photo', kind: 'photo', mime: 'image/png', size_bytes: 3 }, status: 201, save: { photoUploadId: 'j.upload_id', photoUploadUrl: 'j.upload_url' } },
      { name: 'PUT the photo bytes', method: 'PUT', url: '{{photoUploadUrl}}', as: 'none', body: 'PNG', headers: { 'Content-Type': 'image/png', 'x-upsert': 'false' }, noIdempotency: true, status: 200 },
      { name: 'Priya makes it her profile photo (PATCH /me photo_upload_id)', method: 'PATCH', url: `${B}/me`, as: 'token2', body: { photo_upload_id: '{{photoUploadId}}' }, status: 200,
        checks: [['Me with the stored photo link and seq', "j.person_id === env('personId2') && /^https?:\\/\\//.test(j.photo_url) && typeof j.seq === 'number'"]] },
      { name: 'The same upload again: 422 photo_upload_id (taken once)', method: 'PATCH', url: `${B}/me`, as: 'token2', body: { photo_upload_id: '{{photoUploadId}}' }, status: 422, checks: [['invalid, field photo_upload_id', "j.error.code === 'invalid' && j.error.field === 'photo_upload_id'"]] },
    ],
  },
  {
    name: '6. A vote Aarav opens',
    description: 'A person-opened vote (§4.8, rev 3 §4.6): the Server posts a system message carrying the vote card so the poll shows in the room. Close is for the organizer or the opener; it also closes by itself once everyone has voted. The decided line lands in the trip record; undo and redo.',
    steps: [
      { name: 'Aarav opens "Where do we stay?"', method: 'POST', url: `${T}/decisions`, body: { question: 'Where do we stay?', kind: 'choice', anonymous: false, options: [{ label: 'Villa Sol', price_minor: 5420000 }, { label: 'Casa Azul' }] }, status: 201,
        checks: [['decision open with 2 options and the anchor message with the vote card', "j.decision && j.decision.status === 'open' && j.decision.options.length === 2 && j.decision.opened_by_person_id === env('personId') && j.message && j.message.author.kind === 'system' && j.message.card && j.message.card.kind === 'vote' && j.message.card.decision_id === j.decision.decision_id"]],
        save: { decisionId: 'j.decision.decision_id', voteMessageId: 'j.message.message_id' } },
      { name: 'The poll is in the room', method: 'GET', url: `${T}/messages?limit=50`, status: 200, checks: [['a system message carries the vote card', "j.messages.some(m => m.message_id === env('voteMessageId') && m.card && m.card.decision_id === env('decisionId'))"]] },
      { name: 'Priya reads it: no vote of hers yet', method: 'GET', url: `${T}/decisions/{{decisionId}}`, as: 'token2', status: 200, checks: [['open, my_vote null, voted 0 of 2', "j.status === 'open' && j.my_vote === null && j.voted === 0 && j.of === 2"]] },
      { name: 'The vote is in Priya\'s needs-you strip', method: 'GET', url: `${T}/needs-you`, as: 'token2', status: 200, checks: [['a vote item for it', "j.items.some(i => i.kind === 'vote' && i.target.decision_id === env('decisionId')) && typeof j.seq === 'number'"]] },
      { name: 'Aarav votes Villa Sol', method: 'PUT', url: `${T}/decisions/{{decisionId}}/vote`, body: { option_index: 0 }, status: 200, checks: [['my_vote 0, voted 1, tally [1,0]', 'j.my_vote && j.my_vote.option_index === 0 && j.voted === 1 && j.tally[0] === 1']] },
      { name: 'Priya cannot close it: 403 (not the organizer, did not open it)', method: 'POST', url: `${T}/decisions/{{decisionId}}/close`, as: 'token2', body: {}, status: 403, checks: [ERR('forbidden')] },
      { name: 'Aarav closes it: Villa Sol wins', method: 'POST', url: `${T}/decisions/{{decisionId}}/close`, body: {}, status: 200, checks: [['closed, result_index 0, closed_at', "j.status === 'closed' && j.result_index === 0 && typeof j.closed_at === 'string'"]] },
      { name: 'Voting on a closed vote: 409', method: 'PUT', url: `${T}/decisions/{{decisionId}}/vote`, as: 'token2', body: { option_index: 1 }, status: 409, checks: [ERR('conflict')] },
      { name: 'The trip record has the decided line', method: 'GET', url: `${T}/record`, status: 200,
        checks: [['a decided line for the vote, active', "j.lines.some(l => l.decision_id === env('decisionId') && l.kind === 'decided' && l.status === 'active') && typeof j.seq === 'number'"]],
        save: { lineId: "j.lines.find(l => l.decision_id === env('decisionId')).line_id" } },
      { name: 'Priya undoes the line', method: 'POST', url: `${T}/record/{{lineId}}/undo`, as: 'token2', body: {}, status: 200, checks: [['status undone', "j.status === 'undone'"]] },
      { name: 'Aarav redoes it', method: 'POST', url: `${T}/record/{{lineId}}/redo`, body: {}, status: 200, checks: [['active again', "j.status === 'active'"]] },
      { name: 'Redo on an active line: 409', method: 'POST', url: `${T}/record/{{lineId}}/redo`, body: {}, status: 409, checks: [ERR('conflict')] },
    ],
  },
  {
    name: '7. Acting as Go: a vote, the mandate, the spend check, a pay card',
    description: 'What only Go can do, sent through the dev stack\'s control port (`POST {{goUrl}}/sim/<method>` with the request\'s params as JSON; the stack forwards it over the real signed socket and answers with the Server\'s answer). Local only: against Railway this whole folder is skipped. The flow is the contract\'s: Go opens a vote → everyone votes and it closes → Go sets the mandate → the payer confirms (§4.8) → Go\'s spend check passes and gets a signed approval → Go posts the pay card → the payer taps Approve (one tap for Go however many presses, §4.7) → Go replaces the card as paid → `GET …/cards?kind=pay` (§4.11).',
    steps: [
      { name: '[Go] open_vote: Which dates?', method: 'POST', url: '{{goUrl}}/sim/open_vote', go: true, body: { request_id: 'pm-{{runId}}-open-vote', trip_id: '{{tripId}}', question: 'Which dates?', kind: 'choice', anonymous: false, options: [{ label: 'Fri 6 – Mon 9 Nov' }, { label: 'Fri 13 – Mon 16 Nov' }] }, status: 200, checks: [['decision_id and seq', '/^d_/.test(j.decision_id) && j.seq > 0']], save: { goDecisionId: 'j.decision_id' } },
      { name: 'It is in Aarav\'s needs-you strip', method: 'GET', url: `${T}/needs-you`, local: true, status: 200, checks: [['a vote item', "j.items.some(i => i.kind === 'vote' && i.target.decision_id === env('goDecisionId'))"]] },
      { name: 'Aarav votes', method: 'PUT', url: `${T}/decisions/{{goDecisionId}}/vote`, local: true, body: { option_index: 0 }, status: 200, checks: [['still open: 1 of 2', "j.status === 'open' && j.voted === 1"]] },
      { name: 'Priya votes: everyone voted, it closes by itself', method: 'PUT', url: `${T}/decisions/{{goDecisionId}}/vote`, as: 'token2', local: true, body: { option_index: 0 }, status: 200, checks: [['closed, result_index 0', "j.status === 'closed' && j.result_index === 0"]] },
      { name: '[Go] set_mandate: Aarav pays, up to ₹55,000, refundable only', method: 'POST', url: '{{goUrl}}/sim/set_mandate', go: true, body: { request_id: 'pm-{{runId}}-mandate', trip_id: '{{tripId}}', decision_id: '{{goDecisionId}}', choice_index: 0, cap_minor: 5500000, currency: 'INR', refundable_only: true, payer_person_id: '{{personId}}' }, status: 200, checks: [['seq', 'j.seq > 0']] },
      { name: 'The mandate is in Aarav\'s strip', method: 'GET', url: `${T}/needs-you`, local: true, status: 200, checks: [['a mandate item', "j.items.some(i => i.kind === 'mandate' && i.target.decision_id === env('goDecisionId'))"]] },
      { name: '[Go] request_spend_approval: denied until the payer says yes', method: 'POST', url: '{{goUrl}}/sim/request_spend_approval', go: true, body: SPEND, status: 200, checks: [['denied, payer_has_not_confirmed', "j.status === 'denied' && j.reason === 'payer_has_not_confirmed'"]] },
      { name: 'Priya cannot answer the mandate: 403', method: 'POST', url: `${T}/decisions/{{goDecisionId}}/mandate/confirm`, as: 'token2', local: true, body: {}, status: 403, checks: [ERR('forbidden')] },
      { name: 'Aarav: yes, book it', method: 'POST', url: `${T}/decisions/{{goDecisionId}}/mandate/confirm`, local: true, body: {}, status: 200, checks: [['the Mandate with confirmed_at', "j.payer_person_id === env('personId') && typeof j.confirmed_at === 'string' && j.cap_minor === 5500000"]] },
      { name: '[Go] request_spend_approval: approved and signed', method: 'POST', url: '{{goUrl}}/sim/request_spend_approval', go: true, body: { ...SPEND, request_id: 'pm-{{runId}}-spend-2' }, status: 200,
        checks: [['approved, approval_id, a 3-part JWS', "j.status === 'approved' && /^ap_/.test(j.approval_id) && typeof j.approval === 'string' && j.approval.split('.').length === 3 && typeof j.expires_at === 'string'"]], save: { approvalId: 'j.approval_id' } },
      { name: '[Go] post_message: the pay card for Aarav', method: 'POST', url: '{{goUrl}}/sim/post_message', go: true, body: { request_id: 'pm-{{runId}}-pay-card', trip_id: '{{tripId}}', text: 'Ready to pay for Villa Sol', card: PAY_CARD('waiting') }, status: 200,
        checks: [['message_id and seq', '/^m_/.test(j.message_id) && j.seq > 0']], save: { payCardMessageId: 'j.message_id' },
        test: ["if (pm.response.code === 200) pm.environment.set('cardId', 'c_pay_' + pm.environment.get('runId'));"] },
      { name: 'The pay card is in Aarav\'s strip', method: 'GET', url: `${T}/needs-you`, local: true, status: 200, checks: [['a card item for it', "j.items.some(i => i.kind === 'card' && i.target.card_id === env('cardId') && i.target.message_id === env('payCardMessageId'))"]] },
      { name: 'Aarav taps Approve (press_id)', method: 'POST', url: `${T}/cards/{{cardId}}/actions`, local: true, body: { action_id: 'approve', press_id: '{{pressId}}' }, status: 200,
        pre: ["pm.environment.set('pressId', pm.variables.replaceIn('{{$guid}}')); // one press id, sent twice below"],
        checks: [['CardActionResult done | open | refused', "['done', 'open', 'refused'].includes(j.result)"]] },
      { name: 'The same press again: one tap for Go', method: 'POST', url: `${T}/cards/{{cardId}}/actions`, local: true, body: { action_id: 'approve', press_id: '{{pressId}}' }, status: 200, checks: [['the same kind of answer', "['done', 'open', 'refused'].includes(j.result)"]] },
      { name: 'A tap on a card that is not there: 404', method: 'POST', url: `${T}/cards/c_nope_{{runId}}/actions`, local: true, body: { action_id: 'approve', press_id: 'p-{{runId}}-x' }, status: 404, checks: [ERR('not_found')] },
      { name: 'A tap with an unknown payload field: 422 (strict body)', method: 'POST', url: `${T}/cards/{{cardId}}/actions`, local: true, body: { action_id: 'approve', press_id: 'p-{{runId}}-y', payload: { trip: 'oneway', extra: 1 } }, status: 422, checks: [['invalid, field payload.extra', "j.error.code === 'invalid' && j.error.field === 'payload.extra'"]] },
      { name: '[Go] replace_card: the pay card is paid', method: 'POST', url: '{{goUrl}}/sim/replace_card', go: true, body: { trip_id: '{{tripId}}', card: PAY_CARD('paid') }, status: 200, checks: [['the same message', "j.message_id === env('payCardMessageId')"]] },
      { name: 'Pay cards by state', method: 'GET', url: `${T}/cards?kind=pay&state=paid`, local: true, status: 200, checks: [['the paid card, latest version', "j.items.some(i => i.message_id === env('payCardMessageId') && i.card.card_id === env('cardId') && i.card.state === 'paid') && typeof j.items[0].posted_at === 'string'"]] },
      { name: 'It left Aarav\'s strip', method: 'GET', url: `${T}/needs-you`, local: true, status: 200, checks: [['no card item for it', "!j.items.some(i => i.kind === 'card' && i.target.card_id === env('cardId'))"]] },
      { name: 'The replaced card shows in changes mode', method: 'GET', url: `${T}/messages?after_seq=0&limit=200`, local: true, status: 200, checks: [['the pay message carries state paid', "j.messages.some(m => m.message_id === env('payCardMessageId') && m.card && m.card.state === 'paid')"]] },
    ],
  },
  {
    name: '8. Money',
    description: 'Expenses people add by hand and their approval (§4.9, rev 3): pending until the split agrees, disputed ones leave the transfers until the payer fixes the split; MoneyView and the Transactions page; a UPI pay link; a nudge and its 24-hour limit; a payment recorded outside Go, confirmed by the payee. Money is whole paise (§1.3).',
    steps: [
      { name: 'Aarav adds the airport cab, split with Priya', method: 'POST', url: `${T}/expenses`, body: { amount_minor: 680000, note: 'Airport cab', category: 'getting_around', split_person_ids: ['{{personId}}', '{{personId2}}'] }, status: 201,
        checks: [['pending, one confirmation (Priya), seq', "j.status === 'pending' && j.confirmations.length === 1 && j.confirmations[0].person_id === env('personId2') && j.confirmations[0].state === 'pending' && j.paid_by_person_id === env('personId') && typeof j.seq === 'number'"]], save: { expenseId: 'j.expense_id' } },
      { name: 'It is in Priya\'s strip to approve', method: 'GET', url: `${T}/needs-you`, as: 'token2', status: 200, checks: [['an expense item', "j.items.some(i => i.kind === 'expense' && i.target.expense_id === env('expenseId') && i.cta_label === 'Approve')"]] },
      { name: 'Pending expenses', method: 'GET', url: `${T}/expenses?status=pending`, as: 'token2', status: 200, checks: [['lists it', "j.items.some(e => e.expense_id === env('expenseId')) && typeof j.seq === 'number'"]] },
      { name: 'The payer has nothing to approve: 403', method: 'POST', url: `${T}/expenses/{{expenseId}}/approve`, body: {}, status: 403, checks: [ERR('forbidden')] },
      { name: 'Priya approves', method: 'POST', url: `${T}/expenses/{{expenseId}}/approve`, as: 'token2', body: {}, status: 200, checks: [['approved by everyone', "j.status === 'approved' && j.confirmations[0].state === 'approved'"]] },
      { name: 'Approving twice: 409', method: 'POST', url: `${T}/expenses/{{expenseId}}/approve`, as: 'token2', body: {}, status: 409, checks: [ERR('conflict')] },
      { name: 'Aarav adds a scooter rental, split with Priya', method: 'POST', url: `${T}/expenses`, body: { amount_minor: 240000, note: 'Scooter rental', category: 'getting_around', split_person_ids: ['{{personId}}', '{{personId2}}'] }, status: 201, save: { expenseId2: 'j.expense_id' } },
      { name: 'Priya disputes it', method: 'POST', url: `${T}/expenses/{{expenseId2}}/dispute`, as: 'token2', body: { reason: 'I took the bus' }, status: 200, checks: [['disputed, with the reason', "j.status === 'disputed' && j.confirmations[0].state === 'disputed' && j.confirmations[0].reason === 'I took the bus'"]] },
      { name: 'Money: the disputed one is out of the transfers', method: 'GET', url: `${T}/money`, status: 200,
        checks: [['Priya owes Aarav ₹3,400 (half the cab only)', "j.transfers.some(t => t.from_person_id === env('personId2') && t.to_person_id === env('personId') && t.amount_minor === 340000) && j.currency === 'INR' && j.me && j.me.budget && typeof j.me.spent_minor === 'number' && typeof j.seq === 'number'"]] },
      { name: 'Aarav fixes the split: just him (approved at once)', method: 'PATCH', url: `${T}/expenses/{{expenseId2}}`, body: { split_person_ids: ['{{personId}}'], note: 'Scooter rental (just me)' }, status: 200, checks: [['approved, no confirmations left', "j.status === 'approved' && j.confirmations.length === 0 && j.note === 'Scooter rental (just me)'"]] },
      { name: 'Priya\'s money view: what she owes', method: 'GET', url: `${T}/money`, as: 'token2', status: 200, checks: [['me.i_owe has Aarav ₹3,400', "j.me.i_owe.some(t => t.to_person_id === env('personId') && t.amount_minor === 340000) && j.me.owed_to_me.length === 0"]] },
      { name: 'Transactions, newest first', method: 'GET', url: `${T}/transactions?filter=all&limit=50`, status: 200, checks: [['rows with expense_status, total_count, next_cursor', "j.items.some(r => r.expense_id === env('expenseId') && r.expense_status === 'approved' && r.kind === 'booking') && j.total_count >= 2 && 'next_cursor' in j"]] },
      { name: 'Priya pays Aarav by UPI: the link', method: 'POST', url: `${T}/transfers/pay-link`, as: 'token2', body: { to_person_id: '{{personId}}', amount_minor: 340000 }, status: 200, checks: [['upi://pay link and expiry', "/^upi:\\/\\/pay\\?pa=/.test(j.upi_uri) && /am=3400\\.00/.test(j.upi_uri) && typeof j.expires_at === 'string'"]] },
      { name: 'Aarav nudges Priya: 204', method: 'POST', url: `${T}/transfers/nudge`, body: { from_person_id: '{{personId2}}' }, status: 204, description: 'Accepted, not delivered: the reminder is a push to Priya (type nudge), best-effort.' },
      { name: 'Again within 24 hours: 429 with Retry-After', method: 'POST', url: `${T}/transfers/nudge`, body: { from_person_id: '{{personId2}}' }, status: 429, checks: [['rate_limited with retry_after_seconds and the header', "j.error.code === 'rate_limited' && j.error.retry_after_seconds > 0 && Number(pm.response.headers.get('Retry-After')) > 0"]] },
      { name: 'Priya records the payment', method: 'POST', url: `${T}/settlements`, as: 'token2', body: { to_person_id: '{{personId}}', amount_minor: 340000, currency: 'INR', method: 'upi', note: 'cab share' }, status: 201,
        checks: [['settlement pending_confirmation; transfers already shrink', "j.settlement && j.settlement.status === 'pending_confirmation' && Array.isArray(j.transfers) && !j.transfers.some(t => t.from_person_id === env('personId2')) && typeof j.seq === 'number'"]], save: { settlementId: 'j.settlement.settlement_id' } },
      { name: 'Only the payee can confirm: 403', method: 'POST', url: `${T}/settlements/{{settlementId}}/confirm`, as: 'token2', body: {}, status: 403, checks: [ERR('forbidden')] },
      { name: 'Aarav: got it', method: 'POST', url: `${T}/settlements/{{settlementId}}/confirm`, body: {}, status: 200, checks: [['confirmed', "j.status === 'confirmed' && typeof j.responded_at === 'string'"]] },
      { name: 'Answering again: 409', method: 'POST', url: `${T}/settlements/{{settlementId}}/dispute`, body: {}, status: 409, checks: [ERR('conflict')] },
      { name: 'Money: settled', method: 'GET', url: `${T}/money`, status: 200, checks: [['no transfer from Priya any more', "!j.transfers.some(t => t.from_person_id === env('personId2'))"]] },
      { name: 'Paybacks in the transactions', method: 'GET', url: `${T}/transactions?filter=payback`, status: 200, checks: [['the settlement row', "j.items.some(r => r.settlement_id === env('settlementId') && r.kind === 'payback' && r.settlement_status === 'confirmed')"]] },
      { name: 'Aarav removes the scooter expense', method: 'DELETE', url: `${T}/expenses/{{expenseId2}}`, status: 200, checks: [['seq', "typeof j.seq === 'number'"]] },
      { name: 'Removing it again: 404', method: 'DELETE', url: `${T}/expenses/{{expenseId2}}`, status: 404, checks: [ERR('not_found')] },
    ],
  },
  {
    name: '9. Bookings and the itinerary',
    description: 'A booking a member adds (§4.10) with its passengers; passengers and documents are shown only to the people the booking covers (§1.7, rev 3); the itinerary in its two scopes; a vote to cancel the booking (rev 3 §4.4), called off by its opener so the flight stays for check-in.',
    steps: [
      { name: 'Aarav adds his flight (covers only him)', method: 'POST', url: `${T}/bookings`, body: { kind: 'flight', title: 'BLR → GOX · 6E 5313', vendor: 'ixigo', ref: 'K7QX2M', amount_minor: 1184000, payer_person_id: '{{personId}}', for_person_ids: ['{{personId}}'], starts_at: '2026-11-06T14:10:00Z', ends_at: '2026-11-06T16:25:00Z', journey: JOURNEY, details: [{ label: 'Baggage', value: '15 kg' }], passengers: [{ person_id: '{{personId}}', pnr: 'K7QX2M' }] }, status: 201,
        checks: [['the Booking as Aarav sees it (confirmed, his passenger row, documents []) plus seq', "/^b_/.test(j.booking_id) && j.status === 'confirmed' && j.currency === 'INR' && j.added_by_person_id === env('personId') && j.passengers.length === 1 && Array.isArray(j.documents) && j.seq > 0"]], save: { bookingId: 'j.booking_id' } },
      { name: 'A passenger who is not covered: 422', method: 'POST', url: `${T}/bookings`, body: { kind: 'cab', title: 'Airport cab', vendor: 'Uber', ref: 'U1', amount_minor: 160000, payer_person_id: '{{personId}}', for_person_ids: ['{{personId}}'], passengers: [{ person_id: '{{personId2}}' }] }, status: 422, checks: [['invalid, field passengers[0].person_id', "j.error.code === 'invalid' && j.error.field === 'passengers[0].person_id'"]] },
      { name: 'Bookings as Aarav: passengers and documents shown', method: 'GET', url: `${T}/bookings`, status: 200, checks: [['his booking with passengers[], documents[], details', "j.items.some(b => b.booking_id === env('bookingId') && Array.isArray(b.passengers) && Array.isArray(b.documents) && b.details.length === 1 && b.status === 'confirmed') && typeof j.seq === 'number'"]] },
      { name: 'One booking as Priya: no passengers, no documents (not covered)', method: 'GET', url: `${T}/bookings/{{bookingId}}`, as: 'token2', status: 200, checks: [['the booking without those two keys', "j.booking_id === env('bookingId') && j.passengers === undefined && j.documents === undefined && j.journey && j.journey.number === '5313'"]] },
      { name: 'One booking as Aarav', method: 'GET', url: `${T}/bookings/{{bookingId}}`, status: 200, checks: [['his passenger row', "j.passengers.length === 1 && j.passengers[0].person_id === env('personId') && j.passengers[0].pnr === 'K7QX2M'"]] },
      { name: 'A booking that is not in the trip: 404', method: 'GET', url: `${T}/bookings/b_nope_{{runId}}`, status: 404, checks: [ERR('not_found')] },
      { name: 'Aarav edits the PNR', method: 'PATCH', url: `${T}/bookings/{{bookingId}}`, body: { ref: 'K7QX2N' }, status: 200, checks: [['seq', "typeof j.seq === 'number'"]] },
      { name: 'The same edit again: nothing changed', method: 'PATCH', url: `${T}/bookings/{{bookingId}}`, body: { ref: 'K7QX2N' }, status: 200, checks: [['seq null', 'j.seq === null']] },
      { name: 'Itinerary, just me', method: 'GET', url: `${T}/itinerary?scope=me`, status: 200, checks: [['days[] and seq', "Array.isArray(j.days) && typeof j.seq === 'number'"]] },
      { name: 'Itinerary for everyone', method: 'GET', url: `${T}/itinerary`, as: 'token2', status: 200, checks: [['days[]', 'Array.isArray(j.days)']] },
      { name: 'Priya proposes cancelling the flight', method: 'POST', url: `${T}/bookings/{{bookingId}}/cancel-vote`, as: 'token2', body: {}, status: 201, checks: [['decision_id and seq', '/^d_/.test(j.decision_id) && j.seq > 0']], save: { cancelDecisionId: 'j.decision_id' } },
      { name: 'The vote: yes/no, closes in 24 h, names the booking', method: 'GET', url: `${T}/decisions/{{cancelDecisionId}}`, status: 200, checks: [['yes/no, not anonymous, closes_at set, no result yet, cancels_booking_id', "j.kind === 'yesno' && j.anonymous === false && typeof j.closes_at === 'string' && j.status === 'open' && j.cancels_booking_id === env('bookingId')"]] },
      { name: 'In the TripView it carries cancels_booking_id too', method: 'GET', url: `${T}?include=decisions`, status: 200, checks: [['the decision names the booking', "j.decisions.some(d => d.decision_id === env('cancelDecisionId') && d.cancels_booking_id === env('bookingId'))"]] },
      { name: 'In Aarav\'s strip too', method: 'GET', url: `${T}/needs-you`, status: 200, checks: [['a vote item with target.cancels_booking_id', "j.items.some(i => i.kind === 'vote' && i.target.decision_id === env('cancelDecisionId') && i.target.cancels_booking_id === env('bookingId'))"]] },
      { name: 'Proposing again while it is open: 409', method: 'POST', url: `${T}/bookings/{{bookingId}}/cancel-vote`, body: {}, status: 409, checks: [ERR('conflict')] },
      { name: 'Priya calls the vote off', method: 'POST', url: `${T}/decisions/{{cancelDecisionId}}/cancel`, as: 'token2', body: {}, status: 200, checks: [['cancelled', "j.status === 'cancelled'"]] },
    ],
  },
  {
    name: '10. Web check-in (features.checkin)',
    description: 'Behind `features.checkin` (§4.12): these steps are skipped when `GET /config` said the flag is off. Start the stack with `pnpm dev:stack --features checkin` to run them: the fake Go answers get_checkin with an open seat map (14A free, 12A paid, 14C taken) and submit_checkin with a boarding pass. A paid seat is a payment: the answer says payment_required and the seat is not set.',
    steps: [
      { name: 'Aarav opens the check-in: Go\'s state, kept by the Server', method: 'GET', url: `${T}/bookings/{{bookingId}}/checkin`, feature: 'checkin', status: 200,
        checks: [['open, flight, passenger, seat_map, boarding_pass null', "j.status === 'open' && j.flight && typeof j.flight.number === 'string' && j.passenger && j.seat_map && Array.isArray(j.seat_map.seats) && j.boarding_pass === null && typeof j.closes_at === 'string'"]] },
      { name: 'Priya is not on this flight: 403', method: 'GET', url: `${T}/bookings/{{bookingId}}/checkin`, as: 'token2', feature: 'checkin', status: 403, checks: [ERR('forbidden')] },
      { name: 'Check-in is open: in Aarav\'s strip and on his home card', method: 'GET', url: `${T}/needs-you`, feature: 'checkin', status: 200, checks: [['a checkin item for the booking', "j.items.some(i => i.kind === 'checkin' && i.target.booking_id === env('bookingId') && i.cta_label === 'Check in now')"]] },
      { name: 'Home: attention is the check-in task', method: 'GET', url: `${B}/home`, feature: 'checkin', status: 200, checks: [['attention.kind task "Web check-in is open"', "j.trips.find(t => t.trip_id === env('tripId')).attention.kind === 'task' && /check-in/i.test(j.trips.find(t => t.trip_id === env('tripId')).attention.label)"]] },
      { name: 'A taken seat: 409', method: 'PATCH', url: `${T}/bookings/{{bookingId}}/checkin`, feature: 'checkin', body: { declaration: true, seat: '14C' }, status: 409, checks: [ERR('conflict')] },
      { name: 'A seat that is not on the map: 422', method: 'PATCH', url: `${T}/bookings/{{bookingId}}/checkin`, feature: 'checkin', body: { seat: '99Z' }, status: 422, checks: [['invalid, field seat', "j.error.code === 'invalid' && j.error.field === 'seat'"]] },
      { name: 'Complete before the declaration: 422', method: 'POST', url: `${T}/bookings/{{bookingId}}/checkin/complete`, feature: 'checkin', body: {}, status: 422, checks: [['invalid, field declaration', "j.error.code === 'invalid' && j.error.field === 'declaration'"]] },
      { name: 'Details and seat 14A', method: 'PATCH', url: `${T}/bookings/{{bookingId}}/checkin`, feature: 'checkin', body: { digi_yatra: false, declaration: true, seat: '14A', mobile: '+91 98765 43210' }, status: 200, checks: [['the updated state, mobile masked', "j.seat === '14A' && j.declaration === true && j.digi_yatra === false && j.status === 'open' && j.payment_required === undefined && !JSON.stringify(j).includes('98765 43210')"]] },
      { name: 'A paid seat (12A): payment first, the seat is not set', method: 'PATCH', url: `${T}/bookings/{{bookingId}}/checkin`, feature: 'checkin', body: { seat: '12A' }, status: 200, checks: [['payment_required with the price; seat still 14A', "j.payment_required === true && j.seat_price && j.seat_price.amount_minor > 0 && j.seat_price.currency === 'INR' && j.seat === '14A'"]] },
      { name: 'Complete: Go checks in and answers the boarding pass', method: 'POST', url: `${T}/bookings/{{bookingId}}/checkin/complete`, feature: 'checkin', body: {}, status: [200, 202], checks: [['done with a boarding pass (or 202 working)', "(pm.response.code === 202 && j.status === 'working') || (j.status === 'done' && j.boarding_pass && j.boarding_pass.barcode && typeof j.boarding_pass.barcode.payload === 'string')"]] },
      { name: 'Read it again: done', method: 'GET', url: `${T}/bookings/{{bookingId}}/checkin`, feature: 'checkin', status: 200, checks: [['done or working, never open again', "['done', 'working'].includes(j.status)"]] },
      { name: 'Done: it left the strip', method: 'GET', url: `${T}/needs-you`, feature: 'checkin', status: 200, checks: [['no checkin item', "!j.items.some(i => i.kind === 'checkin' && i.target.booking_id === env('bookingId'))"]] },
    ],
  },
  {
    name: '11. The You screen and Go',
    description: 'What Go knows about you (§4.13), asked of Go for the signed-in person only; carry-over; delete a fact; forget me in this trip (the Server clears your join answers there too); pause Go in a trip; the vault link (§4.7). With the fake Go the answers are canned; with a real Go the fact id must exist.',
    steps: [
      { name: 'What Go knows about Aarav', method: 'GET', url: `${B}/me/go`, status: 200, checks: [['person_id, carry_over, facts[]', "j.person_id === env('personId') && typeof j.carry_over === 'boolean' && Array.isArray(j.facts)"]] },
      { name: 'Carry-over on', method: 'PATCH', url: `${B}/me/go`, body: { carry_over: true }, status: 200 },
      { name: 'Delete one fact (404 with a real Go when it does not exist)', method: 'DELETE', url: `${B}/me/go/facts/{{factId}}`, status: [200, 404] },
      { name: 'Vault link: add a card', method: 'POST', url: `${B}/me/vault-link`, body: { start: 'add_card' }, status: 200, checks: [['an https link with an expiry; never cached', "/^https:\\/\\//.test(j.url) && typeof j.expires_at === 'string'"]] },
      { name: 'Vault link: the visa documents (200 with features.visa, else 422 start)', method: 'POST', url: `${B}/me/vault-link`, body: { start: 'add_documents', context: { trip_id: '{{tripId}}', purpose: 'visa' } }, status: [200, 422],
        checks: [['matches the flag', "env('featureVisa') === 'true' ? (pm.response.code === 200 && /^https:\\/\\//.test(j.url)) : (pm.response.code === 422 && j.error.field === 'start')"]] },
      { name: 'Priya pauses Go', method: 'PATCH', url: `${T}/me`, as: 'token2', body: { go_paused: true }, status: 200, checks: [['her own Person, go_paused true, plus seq', "j.person_id === env('personId2') && j.go_paused === true && j.role === 'member' && typeof j.seq === 'number'"]] },
      { name: 'Her answers say so', method: 'GET', url: `${T}/me`, as: 'token2', status: 200, checks: [['go_paused true', 'j.go_paused === true']] },
      { name: 'Priya unpauses Go', method: 'PATCH', url: `${T}/me`, as: 'token2', body: { go_paused: false }, status: 200 },
      { name: 'Priya: forget me in this trip', method: 'DELETE', url: `${B}/me/go?trip_id={{tripId}}`, as: 'token2', status: 200, checks: [['deleted_facts, remaining_facts 0', "typeof j.deleted_facts === 'number' && j.remaining_facts === 0"]] },
      { name: 'Her join answers are cleared here', method: 'GET', url: `${T}/me`, as: 'token2', status: 200, checks: [['from_city gone', 'j.from_city === null || j.from_city === undefined']] },
    ],
  },
  {
    name: '12. Errors the app must handle',
    description: 'The one error shape (§1.5): `{ error: { code, message, field, retry_after_seconds, request_id } }` with `X-Request-Id` on every answer. 401 for no or a bad token; 403 for someone outside the trip and for a trip that does not exist (rev 3 §1.2: one answer for both); 404 for an unknown route; 422 for an unknown field (strict bodies) and for a reused Idempotency-Key with a different body (§1.4); 400 only for JSON that cannot be read.',
    steps: [
      { name: 'No sign-in: 401', method: 'GET', url: `${B}/me`, as: 'none', status: 401, checks: [ERR('unauthorized'), ['X-Request-Id header', "typeof pm.response.headers.get('X-Request-Id') === 'string'"]] },
      { name: 'A made-up token: 401', method: 'GET', url: `${B}/me`, as: 'bad', status: 401, checks: [ERR('unauthorized')] },
      { name: 'Kabir is not in the trip: 403', method: 'GET', url: T, as: 'token3', status: 403, checks: [ERR('forbidden')] },
      { name: 'A trip that does not exist: 403 too (nothing is revealed)', method: 'GET', url: `${B}/trips/t_nope_{{runId}}`, status: 403, checks: [ERR('forbidden')] },
      { name: 'An unknown route: 404', method: 'GET', url: `${B}/nope`, status: 404, checks: [ERR('not_found')] },
      { name: 'An unknown field: 422 naming it', method: 'POST', url: `${B}/trips`, body: { title: 'Manali', bogus: 1 }, status: 422, checks: [['invalid, field bogus', "j.error.code === 'invalid' && j.error.field === 'bogus'"]] },
      { name: 'A wrong type: 422 naming the field', method: 'PUT', url: `${T}/me/budget`, body: { min_minor: '15000' }, status: 422, checks: [['invalid, field min_minor', "j.error.code === 'invalid' && j.error.field === 'min_minor'"]] },
      { name: 'Pause Go with an unknown field: 422 (strict like every body)', method: 'PATCH', url: `${T}/me`, body: { go_paused: true, bogus: 1 }, status: 422, checks: [['invalid, field bogus', "j.error.code === 'invalid' && j.error.field === 'bogus'"]] },
      { name: 'A vault link with an unknown context field: 422', method: 'POST', url: `${B}/me/vault-link`, body: { start: 'add_documents', context: { trip_id: '{{tripId}}', purpose: 'visa', extra: 1 } }, status: 422, checks: [['invalid, field context.extra', "j.error.code === 'invalid' && j.error.field === 'context.extra'"]] },
      { name: 'Broken JSON: 400', method: 'POST', url: `${B}/trips`, body: '{ "title": ', status: 400, checks: [ERR('bad_request')] },
      { name: 'Neither an option nor flexible: 422', method: 'PUT', url: `${T}/decisions/{{decisionId}}/vote`, body: {}, status: 422, checks: [['invalid', "j.error.code === 'invalid'"]] },
      { name: 'Idempotency-Key: the first write', method: 'POST', url: `${T}/messages`, body: { client_message_id: 'cm-{{runId}}-k1', text: 'once' }, headers: { 'Idempotency-Key': 'journey-{{runId}}' }, status: 201, save: { idemMessageId: 'j.message_id' } },
      { name: 'The same key with a different body: 422 idempotency_key_reused', method: 'POST', url: `${T}/messages`, body: { client_message_id: 'cm-{{runId}}-k2', text: 'twice' }, headers: { 'Idempotency-Key': 'journey-{{runId}}' }, status: 422, checks: [['invalid, field Idempotency-Key, message names idempotency_key_reused', "j.error.code === 'invalid' && j.error.field === 'Idempotency-Key' && /idempotency_key_reused/.test(j.error.message)"]] },
      { name: 'The same key and body: the first answer replayed', method: 'POST', url: `${T}/messages`, body: { client_message_id: 'cm-{{runId}}-k1', text: 'once' }, headers: { 'Idempotency-Key': 'journey-{{runId}}' }, status: 201, checks: [['same message, Idempotent-Replayed: true', "j.message_id === env('idemMessageId') && pm.response.headers.get('Idempotent-Replayed') === 'true'"]] },
      { name: 'A card tap by someone outside the trip: 403', method: 'POST', url: `${T}/cards/c_x/actions`, as: 'token3', body: { action_id: 'approve', press_id: 'p-{{runId}}-z' }, status: 403, checks: [ERR('forbidden')] },
    ],
  },
  {
    name: '13. Leaving',
    description: 'Priya leaves (§4.4); from then on every route of the trip answers 403 for her, and the TripView has one person.',
    steps: [
      { name: 'Priya leaves the trip: 204', method: 'POST', url: `${T}/leave`, as: 'token2', body: {}, status: 204 },
      { name: 'She can no longer read it: 403', method: 'GET', url: T, as: 'token2', status: 403, checks: [ERR('forbidden')] },
      { name: 'Aarav is alone', method: 'GET', url: `${T}?include=people`, status: 200, checks: [['one person', "j.people.length === 1 && j.people[0].person_id === env('personId')"]] },
      { name: 'Her home no longer lists it', method: 'GET', url: `${B}/home`, as: 'token2', status: 200, checks: [['not in trips', "!j.trips.some(t => t.trip_id === env('tripId'))"]] },
    ],
  },
];
