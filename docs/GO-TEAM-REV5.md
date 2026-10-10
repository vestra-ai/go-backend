# For Go's team: rev 5, richer choices in the chat

**From:** the Server team. **Date:** 11 Oct 2026. **Please reply by:** the reply table at the end.

The App team wants the room to feel like a shop window: photo-led cards for places and stays, up to 10 choices with
"see more", votes right on the card, a live view of Go working, and the vault inside the app.

This page lists what each item needs **from Go**, and what the Server already does or will do. Names are proposals:
tell us if you'd rather call them something else and we'll follow.

Shapes are added on top of contract 1.1 (`packages/contract`). Please add them to your contract files too, so both sides
check the same thing.

---

## R1. Multiple photos on stays and on the trip's place

**Already in contract 1.1, no new shape.** Up to 12 `photos: [{ url, label? }]` each on `Place` (the destination),
`Option` (stay and place options) and `DecisionOption`.

**Ask:** send them every time:
- 6–12 photos for each stay option (rooms, pool, outside, bathroom, with labels);
- 6–12 for the destination in `update_trip.destination.photos`.

`image_url` / `photo_url` stay as the cover. On 10 Oct, production Go sent `photos` on only 6 frames out of about
10,000.

**Server:** stores and passes everything through already. The trip home, home card and vote options show them.

## R2. Place suggestions as their own cards (Goa, Manali, Ladakh)

**No new shape.** An `options` card with `option_kind: "place"`. Each `Option` has:
- `title`: the place name;
- `place`: a `Place` with `photos`, `lat`, `lng`;
- `photos`: 6–12 images;
- `price_min_minor` / `price_max_minor`: rough per-person cost for the trip;
- `details`: `why` (up to 5 reasons), `activities`, `facts` (best months, travel time from each person's `from_city`).

**Ask:** use this for every "where should we go" answer, instead of text or a list.

When a place wins its vote, call `update_trip { destination, title }` with the winning `place` (title included, so the
trip isn't still called "Manali trip").

## R3. Up to 10 options on a card

**Contract change:** `OptionsCard.options` `maxItems` goes from 5 to **10**. (`open_vote` already allows 10.) The app
shows the first few and a "show more" control.

**Ask:**
- send 10 good options for stays and places when you have them;
- raise the limit in your contract (the Server's overlay can only add, so we follow your file).

## R4. "See more options" gives a new message with new cards

**Contract:** a standard action on `options` cards:

```json
{ "action_id": "more_options", "label": "See more", "style": "secondary" }
```

A tap reaches Go as the usual `card_tap { action_id: "more_options" }`. Go answers `done` at once, then posts a **new
message** with a new options card. It holds up to 10 options **not shown before** for the same search, and it is linked
to the same vote (R5). Go repeats this until it has nothing new; then it answers the tap with a toast.

## R5. Vote right on the card: no "Put it to a vote", "I'll take this" or "See on ixigo"

Today Go posts an options card, then a "Put it to a vote" button, then the Server's vote card. The app wants **Vote**
buttons on the options card itself, from the start.

**Contract:**
1. `OptionsCard` gains an optional `decision_id`.
2. When Go posts stay or place options for the group, it first calls `open_vote` with one `DecisionOption` per card
   option. Each `DecisionOption` carries:
   - `option_ref`: the card's `option_id`;
   - `photos`, `details` and prices: copied from the card option.
3. Go then posts the options card with that `decision_id`. The app draws a Vote button on each option. Votes go
   through the Server (`decision.voted` events as today), and the tally shows on the card.
4. **"See more" adds to the same vote.** New method `add_vote_options` (Go to Server, 2 s):

   ```json
   { "request_id": "r_77", "trip_id": "t_goa", "decision_id": "d_12", "options": [ { "label": "Casa Azul", "option_ref": "opt_14", "photos": [ … ] } ] }
   ```

   - Only for an open vote, and at most 20 options in total.
   - Votes already cast stay.
   - The answer is `{ seq }`.
   - The Server sends a new event, `decision.options_added { decision_id, options, by: go }`. Its option indexes
     continue from the last one.
   - The new message's card carries the same `decision_id`, so both messages show vote buttons for one vote.
5. **Drop** the follow-up CTA messages and buttons: "Put it to a vote", "I'll take this", "See on ixigo".
   - For the ixigo page, send `Option.url` (new, optional, https). The app shows it as a small "View on ixigo" link
     inside the option's details, not as a button.
6. **Travel options (flight, train, bus) stay personal (B7): no vote.** They use `visible_to_person_ids` for the
   traveller.

When the vote closes, everything continues as today:
- the Server posts "Casa Azul won · 3 votes";
- Go hears `decision.closed`;
- the mandate and payment follow.

## R6. "Ideas for you" with place photos

The ideas carousel on the home screen is the Server's (curated, per starting city). Today each idea has one
`image_url`, and we have no good photo source.

**Ask:** a new method, `place_info` (Server to Go, 3 s):

```json
{ "name": "Ladakh", "from_city": "Delhi" }
→ { "place": { "name": "Ladakh", "place_id": "…", "photos": [ … 6–12 … ], "lat": …, "lng": … }, "tag": "High-altitude road trip", "travel": { "mode": "flight", "duration_minutes": 85 }, "best_months": [6,7,8,9] }
```

The Server calls it at most once a day per idea, keeps the answer, and never calls it while a person waits.

## R7. Live view of Go using the computer

**Today:** your `working` card's `steps` arrive. `screenshot_url` and `page_url` exist in the contract, but production Go
never sent them (0 of about 10,000 frames on 10 Oct). **Nothing is streamed today.**

**Contract:** `WorkingCard` gains `live_url`, a Go-hosted, view-only, short-lived (≤ 15 min), signed https page that
shows the browser Go is driving. The app opens it in an in-app panel while `state` is `running` or `needs_you`.

**Ask:**
- Host the stream yourselves (WebRTC, HLS or MJPEG, your choice). The video never passes through the Server.
- Allow your page in frames from the app's origins: `https://go-frontend-three.vercel.app`, `http://localhost:3000`,
  `http://localhost:3002`.
- Send `live_url` when the task starts. Then `replace_card` only at step changes, **not** for every frame or screenshot:
  each `replace_card` is a change in the trip.
- When the screen shows a person's own account (an ixigo login, their bookings), post the card with
  `visible_to_person_ids: [that person]`.
- Keep `screenshot_url` for the last frame once the task ends.

## R8. The vault inside the app, and "Save card"

**Today:**
- the contract says to open the vault link "in the system browser sheet, never a WebView";
- the App team reports the **Save card button does nothing**.

**Ask:**
1. **Save card:** please reproduce and fix it. Open `vault_link { start: "add_card" }`, enter a test card, press Save.
   If it depends on a popup, a 3-D Secure redirect or third-party cookies, tell us, because the app's sheet may block
   them.
2. **In the app:** `CreateLink` gains `display: "sheet" | "embedded"` (default `sheet`). For `embedded`, Go returns a
   link whose page:
   - allows framing only by the app origins above (`Content-Security-Policy: frame-ancestors …`);
   - tells the app when it's finished, with `window.parent.postMessage({ type: "go-vault", status: "saved" | "cancelled" | "failed" }, origin)`.
3. **Is embedding the card form acceptable** for your payment provider (PCI and clickjacking)? If not, we keep the sheet
   and only need the Save fix.

## R9. Much more on a stay's "Details"

Today `OptionDetails` has: gallery, caption, why, costs, total, amenities, activities, facts, cancellation, rating, review
count and Go's note. Putting more inline would make a 10-option card heavy.

**Contract:** a new method, `get_option_details` (Server to Go, 3 s), asked only when a person opens Details:

```json
{ "trip_id": "t_goa", "card_id": "c_opts_3", "option_id": "opt_2", "person_id": "p_priya" }
→ OptionDetails + {
  "address": "…", "map": { "lat": …, "lng": … },
  "check_in": "14:00", "check_out": "11:00",
  "property_type": "villa", "stars": 4,
  "rooms": RoomType[],                          // as in 1.1, with photos
  "policies": ["No pets", "Quiet hours 22:00–07:00"],
  "reviews": [ { "rating": 4.5, "text": "…", "date": "2026-09-12", "source": "ixigo" } ],   // up to 10
  "nearby": [ { "name": "Anjuna beach", "distance_m": 600 } ],
  "url": "https://www.ixigo.com/…"
}
```

The Server caches the answer per option for an hour.

---

## Reply table

| # | Item | Go builds | Already live (where, since when)? | Date, or a counter-proposal |
|---|---|---|---|---|
| R1 | Send `photos` on stays and the destination | behaviour | | |
| R2 | Place options with photos; `update_trip` with title when a place wins | behaviour | | |
| R3 | `OptionsCard.options` up to 10 | contract + behaviour | | |
| R4 | `more_options` action, new message with new options | behaviour | | |
| R5 | `OptionsCard.decision_id`, `add_vote_options`, `decision.options_added`, `Option.url`; drop the CTA messages | contract + behaviour | | |
| R6 | `place_info` method | new method | | |
| R7 | `WorkingCard.live_url`, frameable, per-person when private | contract + hosting | | |
| R8 | Fix Save card; `CreateLink.display: "embedded"` + postMessage (or say no) | fix + contract | | |
| R9 | `get_option_details` method | new method | | |

**Questions:**
1. R5: one vote across "see more" messages (our proposal), or a separate vote per message?
2. R7: which stream technology, and how long does a `live_url` stay valid?
3. R8: is an embedded card form allowed by your payment provider?
4. Anything here you'd rather shape differently? We'll follow your names.
