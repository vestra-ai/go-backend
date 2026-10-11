# App changes since the contract you have (rev 4, 10 Oct 2026, 15:40 IST)

**For:** the App team. **Date:** 11 Oct 2026.

**Compared with:** the `CONTRACT-APP.md` we shared on 10 Oct (commit `da88ee9`). The current file is in the repo at
`docs/CONTRACT-APP.md`, and the § numbers below point into it. Appendix C now lists **71 routes**; one is new.

Everything below is live on production (`https://server-production-2202go.up.railway.app`) except these, which come
with our next deploy today:
- 403 before a bad **query string** (A4; the 403 before a bad body is already live);
- "only Go cards with a button are items" (B1);
- the itinerary field path, the vault-limit counting and the account-delete line rewrite (C).

There are three parts:
- **A. Must handle:** things that can break the app or show wrong data if the code doesn't change.
- **B. New things to build:** new fields, routes and flows.
- **C. Good to know:** no code change needed, but they change what you'll see.

---

## A. Must handle

1. **`Me` sends empty fields as `null`, not missing (§2).**
   - `photo_url`, `from_city` and `upi_id_masked` are always present: a string, or `null`.
   - **Do:** type them `string | null` and treat `null` as "not set".
   - Every other answer still leaves empty fields out.
2. **Invite links are `/invite/<code>` (§4.4).**
   - `invite_url` is now `https://go-frontend-three.vercel.app/invite/<code>`, the web app's own invite page. The old
     form was `…/j/<code>`.
   - **Do:** the `/invite/[code]` page reads the code and calls `GET /invites/:code`, then `POST /invites/:code/accept`.
     Links shared before this change still read `/j/<code>`: if you want them to keep working, add a `/j/[code]`
     redirect to `/invite/[code]`.
3. **`home_changed` now fires much more often (§3.1).** It still fires when a trip is created, joined or left. Now
   also when:
   - a trip is reset or renamed (title, destination, dates, status);
   - a vote opens, I vote, or it closes or is cancelled;
   - a mandate is set for me or answered;
   - a Go card naming me is posted or replaced;
   - a record line names me;
   - any money change happens in my trips.

   **Do:** re-read `GET /home` on it, with a short debounce (about 300 ms), because several can arrive together.
   Still re-read home when the app comes back to the foreground.
4. **A non-member gets `403` before any validation (§1.2).** A stranger sending a bad query (`?limit=abc`) or a bad
   body to any `/trips/:trip/…` route gets `403 forbidden`, not `422`. **Do:** don't rely on a 422 to tell a member
   apart; 403 means "not in this trip".
5. **"Former member" (§4.6).** A message whose author left the trip or deleted their account has
   `author: { kind: "person", person_id, former: true }`. Reactions by such a person carry `former: true` too. They are
   not in `TripView.people`.
   - **Do:** draw "Former member" with a neutral avatar when `former` is true, and also whenever a `person_id` isn't
     in `people`, so it never crashes on lookup.
   - `chat.last_message.author` can carry `former` too.
6. **Messages only some people can see (§1.7, §4.6).** A message of Go's may carry `visible_to_person_ids`. You only
   receive it when you're in the list. Everyone else never sees it anywhere.
   - **Do:** show "Only you can see this" (or "Only you and Rahul").
   - **Do:** expect **gaps in `seq`**: a hidden message still takes a change number. A gap is harmless; don't treat
     it as data missing forever (the existing re-read rule is enough).
7. **A `card` frame is now followed by a `message` frame (§3.1).** When Go replaces a card, you get the `card` frame,
   then the whole message at its new `updated_seq`. **Do:** upsert by `message_id`; the second one simply wins.
8. **Tapping a button that's no longer on the card gives `422`, `field: "action_id"` (§4.7).** For example, a pay card
   Go already marked paid, expired or declined. The tap never reaches Go. **Do:** show a light toast ("This has
   changed") and re-read the card (`GET /trips/:trip/cards`).
9. **After a leave, the socket stops following that trip (§4.4).** The leaver gets `trip_changed` and the "… left"
   line, then nothing for that trip. Subscribing again answers `error forbidden`. **Do:** on leave, drop the trip from
   the socket's subscriptions and navigate away.
10. **Card states (§4.11):**
    - `pay` is `waiting | paid | declined | expired | failed`; the old doc wrongly said `cancelled`.
    - `working` is `running | needs_you | done | failed`.

    **Do:** handle `declined`, `failed` and `needs_you` in the card renderers.
11. **Catch-up answers `204` when Go has nothing to say (§4.6),** as well as when you weren't away long enough. **Do:**
    a 204 means show nothing.

## B. New things to build

1. **Home: one card per open item, opening a popup (§4.2, §2 `HomeNeedsYouItem`).**
   - `GET /home` gains `"needs_you": { "items": [...], "total": N }`: every open item of mine across my active trips.
     Each is a `NeedsYouItem` plus `trip_id` and `trip_title`. At most 50 are listed; `total` is the real count.
   - Order: votes closing soonest; then mandates for me; then Go's cards for me; then settle-up; then record lines by
     due date; then check-in.
   - **Draw one card per item. A tap opens the same action in a popup.** How each kind loads and acts is in the table
     in §4.2:

     | kind | Load the popup with | Act with |
     |---|---|---|
     | vote | `GET /trips/:trip/decisions/:decision_id` | `PUT …/decisions/:id/vote` |
     | mandate | `GET …/decisions/:decision_id` | `POST …/decisions/:id/mandate/confirm` or `/decline` |
     | card | `GET /trips/:trip/cards`, the item with `target.card_id` | `POST …/cards/:card_id/actions` |
     | settle_up | nothing: `target.transfer` has the payee and amount | `POST …/settlements` or `POST …/transfers/pay-link` |
     | record_line | `GET …/record`, the line with `line_id` | — |
     | checkin | `GET …/bookings/:id/checkin` | the check-in sheets |

   - Only Go cards **with a button** are items. Notices like "Go forgot you in this trip" are information, not
     pending items.
   - The trip home's "Next up" can use the same items from `GET /trips/:trip/needs-you` instead of the fixed list.
2. **The automatic trip name (§4.4).** A trip still called exactly "New trip" that has a destination now reads
   **"Hampi 2026"** (the year of the start date, else this year). It shows on `TripView.title`, the home cards, `owes`,
   `needs_you` and the invite preview. **Do:** nothing beyond showing `title`. It renames itself when the destination
   or dates change (`trip_changed` and `home_changed` arrive). A name a person typed is never changed.
3. **Vote right on Go's options card, plus "See more" (§4.7, rev 5).**
   - When an `options` card has `decision_id`, draw a **Vote** button on each option, with no "Put it to a vote" step.
     - The card option with `option_id` X is the decision option whose `option_ref` is X.
     - Its position in `decision.options` is the `option_index` you send to `PUT /trips/:trip/decisions/:id/vote`.
     - Show the tally from `decision.tally[index]` and the person's choice from `my_vote`.
     - The Vote button is the app's own: it never goes to `…/cards/:card_id/actions`.
   - **"See more"** is the card action `more_options`: send it like any card button. Go posts a **new message** whose
     card carries the **same** `decision_id`, and the vote grows (up to 20 options; votes already cast stay). Both
     messages show Vote buttons for the one vote.
   - Re-read the decision on `trip_changed kinds:["decision"]`. When it closes, draw the result and no Vote buttons.
   - An option may carry `url`: show a small "View on ixigo" link inside its details, not a button.
4. **An option's Details: new route (§4.7).** `GET /trips/:trip/cards/:card_id/options/:option_id/details`, called
   when a person opens Details.
   - It answers everything the card's `details` has, plus `address`, `map {lat,lng}`, `check_in`/`check_out`,
     `property_type`, `stars`, `rooms` (with photos), `policies`, `reviews` (up to 10), `nearby` and `url`. **Every
     field is optional: draw what's there.**
   - `complete: false` means partial (Go is still collecting): show it, and ask again next time Details opens.
   - Errors: `404` when the card or option isn't yours to see; `429` above 10 lookups a minute per person per trip
     (an answer kept for the hour is free).
5. **Go's live view (§4.7).** A `working` card may carry `live_url`. While `state` is `running` or `needs_you`, open it
   in an in-app panel (`<iframe>`).
   - Always use the link on the card as it stands now: Go sends a fresh one at step changes.
   - **Never log it, store it or send it in an error report:** whoever holds the link can watch.
   - When the task ends, `live_url` is gone and `screenshot_url` remains.
   - *Today Go's page still refuses to be framed. We've asked Go to fix it; until then, show the steps and
     `screenshot_url`.*
6. **The vault inside the app (§4.1).** `POST /me/vault-link` takes `"display": "embedded"`, for `start: "home"` only.
   - Open the link in an `<iframe>`. When the person is done, Go's page posts
     `{ type: "go-vault", status: "saved" | "cancelled" | "failed" }` to `window.parent`. **Check `event.origin` is
     the link's origin, then close the frame.**
   - Adding a card or a login stays in the system browser sheet (embedded with another `start` gives `422 display`).
7. **Idea photos (§4.2).** `GET /discover/ideas` items can carry `photos` (up to 12 of `{url, label?}`) and
   `best_months` (1–12). `image_url` becomes the first photo. Go fills them in over time, so **keep the fallback
   illustration** for ideas without photos.
8. **A trip made from an Idea starts with its destination (§4.4).** `POST /trips { destination_hint: "Goa" }` now also
   sets `destination: { name: "Goa" }`, so the trip opens at stage `deciding`, not the empty "where to?" state.

## C. Good to know (no code change)

- **Live frames arrive in order (§3.2).** Per trip, frames come in change-number order. A join, leave, vote close,
  poll, booking or money action sends `trip_changed` (N) before its room line (N+1). The "keep the highest seq" rule is
  safe.
- **Read markers (§4.4):** `POST /trips/:trip/read` never moves past the trip's latest change.
- **Yes/no vote results name the question:** "Scuba on day 2? Yes won · 2 votes", and so does the decided line.
- **Itinerary errors name the exact field:** `itinerary[0].items[0].category`, not only the day.
- **Rate limit change:** the vault-link limit (6 a minute) now counts only calls that reach Go. A 422 or 403 doesn't
  count. Option details has its own limit: 10 a minute per person per trip.
- **Account delete:** the room's lines that named the person ("Priya joined", "Aarav paid Priya ₹5,800") are
  rewritten to "Former member". Each arrives as a normal `message` frame, with no "edited" mark.
- **Revoked or expired invite preview:** it shows only the trip's name and picture, with `people_preview: []`,
  `joined_count: 0` and no dates.
- **System lines (joins, money lines, vote results)** now also reach Go, so Go can see them. Nothing changes for the
  app.
- **CORS:** production allows `https://go-frontend-three.vercel.app`, `http://localhost:3000` and
  `http://localhost:3002`. Add any new web address to the server's `APP_ORIGINS` before using it.

---

**Questions or anything unclear:** reply to the Server team. When this file and `CONTRACT-APP.md` differ,
`CONTRACT-APP.md` is what the Server does.
