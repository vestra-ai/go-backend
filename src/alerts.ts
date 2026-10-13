// Alerts to the team's Slack channel, through an incoming webhook (SLACK_WEBHOOK_URL): a person signing up for the first
// time, and a trip that keeps Go busy (every TRIP_ALERT_GO_MESSAGES of Go's messages in one trip). Go's replies cost model
// tokens, and this is a free project: the channel is how the team sees a trip burning them. An alert never blocks or
// fails the work it reports on: it is sent in the background, and a Slack outage is one log line.
import type pg from 'pg';

export interface Alerts {
  send(text: string): void;
}

/** No webhook set (local runs, tests): alerts go nowhere. */
export const noAlerts: Alerts = { send() {} };

export class SlackAlerts implements Alerts {
  constructor(private readonly webhookUrl: string, private readonly log: (m: string) => void = (m) => console.error(`[alerts] ${m}`)) {}

  send(text: string): void {
    fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000),
    }).then(
      (r) => { if (!r.ok) this.log(`slack answered ${r.status}`); },
      (err) => this.log(`slack unreachable: ${(err as Error).message}`),
    );
  }
}

/** Text a person typed (a name, a trip title), safe inside a Slack message: `&`, `<` and `>` are Slack's control characters. */
export const slackSafe = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Every this many of Go's messages in one trip, an alert (TRIP_ALERT_GO_MESSAGES, default 50; 0 turns it off). */
export function tripAlertEveryOf(env: NodeJS.ProcessEnv = process.env): number {
  const v = (env.TRIP_ALERT_GO_MESSAGES ?? '').trim();
  if (!v) return 50;
  if (!/^\d{1,6}$/.test(v)) throw new Error(`TRIP_ALERT_GO_MESSAGES must be a whole number (0 turns the alert off), not ${v}`);
  return Number(v);
}

export async function alertSignup(alerts: Alerts, pool: pg.Pool, person: { person_id: string; name: string; email: string | null; provider: string }): Promise<void> {
  const total = (await pool.query<{ n: string }>('select count(*) as n from people where deleted_at is null')).rows[0]!.n;
  alerts.send(`:wave: New sign-up: *${slackSafe(person.name)}*${person.email ? ` (${slackSafe(person.email)})` : ''} via ${slackSafe(person.provider)} · \`${person.person_id}\` · ${total} people in all`);
}

/** The trip's numbers when it reaches another step of Go's messages: who it is, and whether Go is busy right now. */
export async function alertTripUsage(alerts: Alerts, pool: pg.Pool, tripId: string, goMessages: number): Promise<void> {
  const { rows } = await pool.query(
    `select t.title, t.destination->>'name' as destination, t.created_at, o.name as organizer, o.email as organizer_email,
            (select count(*) from trip_people x where x.trip_id = t.trip_id and x.left_at is null) as members,
            (select count(*) from messages m where m.trip_id = t.trip_id and m.author_kind = 'person') as person_messages,
            (select count(*) from messages m where m.trip_id = t.trip_id and m.author_kind = 'go' and m.sent_at > now() - interval '1 hour') as go_last_hour
       from trips t left join people o on o.person_id = t.organizer_person_id
      where t.trip_id = $1`,
    [tripId],
  );
  const t = rows[0];
  if (!t) return;
  const days = Math.floor((Date.now() - new Date(t.created_at).getTime()) / 86_400_000);
  alerts.send([
    `:rotating_light: Trip *${slackSafe(t.title)}* has reached *${goMessages}* messages from Go`,
    `\`${tripId}\`${t.destination ? ` · ${slackSafe(t.destination)}` : ''} · organizer ${slackSafe(t.organizer ?? 'unknown')}${t.organizer_email ? ` (${slackSafe(t.organizer_email)})` : ''} · ${t.members} members`,
    `${t.go_last_hour} from Go in the last hour · ${t.person_messages} messages from people · trip started ${days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`}`,
  ].join('\n'));
}
