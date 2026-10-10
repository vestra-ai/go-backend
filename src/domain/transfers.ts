// §4.9 the `settle_up` card's Pay by UPI button: a `upi://pay` link to the payee, built here because the UPI id is
// kept on the server (it hides nothing: the link carries the id; it is a convenience). It works from the trip's net transfers (the fewest payments that square everyone up), never a share
// of one expense. Go hears nothing of it: the contract has no event for it.
import type { Ctx } from '../context.js';
import type { PayLinkBody } from '../api/bodies.js';
import { requireMember } from './actions.js';
import { conflict, invalid } from './errors.js';
import { readOnly, tripMoney } from './money-view.js';

export const PAY_LINK_MINUTES = 10;

/** How many digits of the minor unit make one unit of the currency (two for rupees, none for yen, three for dinars). */
const fractionDigits = (currency: string) => new Intl.NumberFormat('en-IN', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;

/** `upi://pay?pa=<id>&pn=<name>&am=<units.fraction>&cu=<currency>&tn=<note>`, every value percent-encoded; the note is cut to the 50 characters UPI allows. */
export function upiPayUri(p: { pa: string; pn: string; amount_minor: number; currency: string; tn: string }): string {
  const digits = fractionDigits(p.currency);
  const am = (p.amount_minor / 10 ** digits).toFixed(digits);
  const q = Object.entries({ pa: p.pa, pn: p.pn, am, cu: p.currency, tn: Array.from(p.tn).slice(0, 50).join('') }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return `upi://pay?${q.join('&')}`;
}

/**
 * A pay link to someone the caller owes right now (422 otherwise). 409 when the payee is not in the trip or has no UPI id
 * saved (the app then offers Record a payment instead). The link is good for ten minutes as far as the app is concerned;
 * the server keeps nothing.
 */
export async function payLinkFor(ctx: Ctx, tripId: string, callerId: string, input: PayLinkBody): Promise<{ upi_uri: string; expires_at: string }> {
  return readOnly(ctx, async (db) => {
    await requireMember(db, tripId, callerId);
    const m = await tripMoney(db, tripId);
    const payee = m.people.find((p) => p.person_id === input.to_person_id);
    if (!payee) throw conflict(`${input.to_person_id} is not in this trip`);
    if (!payee.upi_id) throw conflict(`${payee.name} has no UPI id saved: record the payment instead`);
    if (!m.money.transfers.some((t) => t.from_person_id === callerId && t.to_person_id === input.to_person_id)) throw invalid(`to_person_id: you do not owe ${payee.name} anything right now`, 'to_person_id');
    return {
      upi_uri: upiPayUri({ pa: payee.upi_id, pn: payee.name, amount_minor: input.amount_minor, currency: m.trip.currency, tn: `${m.trip.title} · settle up` }),
      expires_at: new Date(Date.now() + PAY_LINK_MINUTES * 60_000).toISOString(),
    };
  });
}
