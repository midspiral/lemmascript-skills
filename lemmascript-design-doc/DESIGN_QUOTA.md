# Quota — Design

A slick booking app where **providers** publish a *special page* of a limited number of
**featured slots**, and **anyone — no login — can grab one until they're gone**. The thing
everyone acts on — *"did I actually get it, and is this slot truly not oversold?"* — is
**formally verified** in [LemmaScript](https://github.com/midspiral/LemmaScript).

The name is the domain concept, and a deliberate sibling to **Quorum**: where Quorum is a
count reaching **up to** a threshold (*enough people are free*), Quota is a count held
**under** a limit (*never more bookings than seats*). Same counting math, opposite bound —
and, as it turns out, the opposite concurrency story (§3).

---

## 1. The product

- A signed-in **provider** picks a **username** (their public handle) and creates pages under
  it. Each page is a title and a handful of **featured slots**, each with a **capacity**
  (default **1** — an appointment; a class with N seats is just N sibling slots sharing a
  label). Each page lives at a **vanity URL — `quota.app/username/pagename`** — branded and
  shareable by design (§6).
- **No login for bookers.** Anyone opens the link and **grabs a slot** — and may grab **as
  many different slots as they like** on a page (book a morning *and* an afternoon). They get a
  confirmation with a private **cancellation link**. When a slot is full, it shows as full and
  can't be grabbed — never oversold.
- A **live availability view** shows, per slot, how many seats remain. The provider sees **who
  booked**; the public sees only **counts** (privacy, §6).
- One click **exports** the page's booking log as NDJSON. A query endpoint **replays the same
  verified functions** over the stored log, so the answer it gives is provably the one the
  booker saw.

A featured-slot booking page, but with a verified "never oversold, honestly accepted/rejected"
core and a trustworthy export.

## 2. The promise — what is verified, and why

The thing a booking tool must get right is the **accept/reject decision and the count behind
it**. A booker acts on "you're in"; a provider acts on "this slot is full." So that decision,
the no-overbooking guarantee, and the export's faithfulness are exactly what we verify.
Concretely, Quota's verified core guarantees:

1. **Never oversold (capacity safety).** For every slot, the number of confirmed bookings is
   `≤` its capacity — always, preserved by every transition. This is the load-bearing
   invariant.
2. **Accepted exactly when there's room (honest decision).** A booking attempt is accepted
   **iff** the slot exists and has remaining capacity. A retry of a booking the same booker
   already holds *for that slot* is **idempotent** — it returns the existing booking, never a
   second seat — so a double-click or reconnect can't consume two seats. (A booker may still
   hold *many different* slots; the idempotency is per-(slot, booker).) Reject ⇒ state
   unchanged. No phantom rejections, no silent overbooking.
3. **Conservation.** `remaining(slot) + confirmed(slot) === capacity(slot)`, and `remaining ≥ 0`
   on a well-formed page — seats never vanish or appear.
4. **Cancelling only frees seats (reverse monotonicity).** A cancellation never raises any
   slot's count, so it trivially preserves safety and strictly opens room.
5. **Replay is deterministic.** Folding the append-only booking-op log over the initial page
   reproduces the page exactly — so the export, the audit trail, and the live app provably
   agree (and queries over the export equal queries computed live).

What is **not** verified (the trust boundary, stated honestly): provider authentication
(magic-link), the React UI, the WebSocket/DO/D1/R2 I/O, email/notifications, the wall-clock
*labeling* of slots (each slot's index is abstract; the date/time/timezone shown is shell),
and abuse / rate-limiting / booker-identity spoofing. The core reasons in abstract slot
indices; the index↔label map is shell (its index arithmetic can itself be verified, §6, the
way Quorum verified `grid.ts`).

## 3. The key design insight — Quota is Quorum *inverted*

Quorum's headline was that **availability is partitioned by participant** — nobody edits
anyone else's row — so there are **no conflicts**, which *licensed* a lock-free, optimistic,
login-free design where the Durable Object's total order was **sufficient but not necessary**.

Quota inverts exactly that:

> **Bookings contend for shared, limited inventory.** Two anonymous users racing for the last
> seat is a *genuine conflict* — exactly one must win.

So the architecture flips with it:

- The Durable Object's single-threaded **total order is now *necessary***, not just convenient
  — it's what makes "who got the last seat" well-defined.
- The client must be **pessimistic**: submit the attempt, **await the DO's authoritative
  accept/reject**. It cannot apply optimistically the way Quorum did, because an attempt can be
  *rejected*. (It may show an instant "pending…", but the truth is the server's.)

And the proof pins *exactly where* contention bites — the boundary is itself a theorem:

- **Over-subscribed** (demand > capacity at a slot): the accepted *set* depends on arrival
  order ⇒ you need a serialization point (the DO).
- **Under-subscribed** (every slot's demand ≤ its capacity): *everyone gets in, regardless of
  order* — the system degenerates into Quorum's conflict-free regime, and order stops
  mattering. Provable as a corollary (§7, Family D).

That contrast — *Quorum's proof licensed lock-free optimism; Quota's proof mandates
serialization, and proves precisely when it's needed* — is the spine of the design. Same
counting kernel (`countFree` ↦ `confirmedCount`), opposite bound, opposite concurrency
discipline.

## 4. Influences (prior art in this workspace)

- **`quorum-lemmascript`** — the **inverted sibling** and the structural template. We reuse its
  shape almost verbatim: total recursive counting kernel, abstract slot **indices** (labeling
  is shell), append-only op log + `replay`, "one `domain.ts` runs in browser, DO, and query
  endpoint", the `{getSnapshot, subscribe, dispatch}` store seam, NDJSON export. We invert its
  central claim (partition ⇒ optimistic) into (contention ⇒ pessimistic + necessary
  serialization).
- **`rallly-lemmascript`** — the booking/scheduling domain and the discipline of pinning a
  decision rule exactly (it proved a poll's score formula + tiebreaker injectivity; we pin
  accept-iff-room and capacity safety).
- **`trace-solo-lemmascript`** — the greenfield architecture: Vite + React, **anonymous bookers**
  (localStorage token), local-first, **Cloudflare Worker + D1 + R2**, NDJSON export, and a
  round-trip/replay property as the model for our **export faithfulness**.
- **`collab-todo-lemmascript` / `dafny-replay`** — server-authoritative state with an
  append-only op log, and "one invariant proved once, preserved by every transition, executing
  identically on client and server." We keep the append-log; unlike collab-todo we *do* have
  real conflicts, but they're resolved by the DO's total order, not by rebase.

## 5. Data model

The verified core works in **abstract slot indices** `[0, slots.length)`. Each slot's
date/time/title is shell labeling. Slots are **append-only** (close via capacity, never
delete) so indices are stable — which keeps the op-log honest and avoids reindexing.

```ts
//@ backend dafny

interface Slot {
  label: string      // display only (time/title); OPAQUE to the core
  capacity: number   // >= 0; product default 1. capacity 0 === "closed, no new bookings"
}

type BookingStatus = "confirmed" | "cancelled"

interface Booking {
  id: string         // booking id == the holder's private cancellation token
  slotIdx: number    // which slot, in [0, slots.length)
  key: string        // dedup / idempotency key (anonymous localStorage token)
  status: BookingStatus
  seq: number        // arrival order, assigned by the DO's total order
}

interface Page {
  id: string
  title: string
  slots: Slot[]          // append-only; close by setting capacity to current confirmed count
  bookings: Booking[]    // append-only log; cancellation flips status, never removes
}

export type { Slot, Booking, Page, BookingStatus }
```

**Why an abstract index instead of a slot id string?** Indices are distinct **by
construction**, so the "no two slots collide" obligation — the part Quorum *deferred* (its
A2 id-uniqueness) — never arises. capacity safety becomes a clean per-index count bound. The
index↔(date, time, label) map is pure shell, exactly like Quorum's grid.

**What's deliberately *not* in this model.** There is no `Provider` and no
`username`/`pagename` here. Provider identity, the vanity-URL routing, and the
username/pagename registry are **shell + infra** (§6) — consistent with "auth is trusted." A
`Page` is addressed by an opaque `id`; how a human-readable `username/pagename` resolves to
that `id` (and to a Durable Object) is the unverified shell's job. The verified core never
sees a username.

**Invariant `Inv(p)`** — what a well-formed page satisfies:

- **A1.** Every slot's confirmed bookings are within capacity:
  `forall(j, 0 <= j && j < slots.length ==> confirmedCount(bookings, j) <= slots[j].capacity)`.
- **A2.** Capacities are non-negative: `forall(j, slots[j].capacity >= 0)`.
- **A3.** Every booking targets a real slot: `forall(b, 0 <= b.slotIdx && b.slotIdx < slots.length)`.

A1 is the headline (no overbooking). Following Quorum's `allAvailLen` pattern, `wellFormed`
is built from a **recursive predicate carrying a reflection lemma** that hands a caller the
quantified A1 fact. As in Quorum, the counting kernel is **total** (`confirmedCount` needs no
precondition), so aggregation/queries compose freely; `wellFormed` is the shape the
*mutations* preserve.

> **As implemented:** `wellFormed(p) === withinCapacity(p.slots, p.bookings) && allInRange(p.bookings, p.slots.length)` — i.e. **A1 ∧ A3**. **A2 is a free corollary of A1**: since `confirmedCount ≥ 0` and A1 gives `confirmedCount(bookings, j) ≤ slots[j].capacity`, every capacity is `≥ 0` automatically, so it needn't be a separate conjunct. A3 (no phantom bookings) is *not* deferred — `addSlot` needs it (a freshly appended slot's index must start genuinely empty), so it was folded into `wellFormed` in Stage 1, and `tryBook`/`cancel` are proved to preserve it.

## 6. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  React SPA (UNVERIFIED shell) — two surfaces:                        │
│   • Provider console  (magic-link auth): create page, add/close      │
│     slots, set capacity, see WHO booked                              │
│   • Public booking page (NO login): grab a slot, see counts only     │
│  imports domain.ts directly → renders the SAME verified hasRoom /    │
│  remaining the server enforces → no client/server desync             │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ WebSocket (hibernatable)
                                │ booking is PESSIMISTIC: send attempt,
                                │ await the DO's authoritative accept/reject
┌───────────────────────────────▼──────────────────────────────────────┐
│  Durable Object, one per PAGE (UNVERIFIED shell)                     │
│   • canonical Page + append-only op log in DO storage                │
│   • single-threaded ⇒ a NECESSARY total order over contending books  │
│   • mutates state ONLY via verified tryBook() / cancel() / applyOp() │
│   • broadcasts REDACTED state (counts) to public sockets;            │
│     full bookers to the authenticated provider socket                │
└────────────────────────────────┬─────────────────────────────────────┘
                ┌────────────────┴──────────────────┐
        ┌───────▼────────┐                ┌─────────▼────────┐
        │  D1 (SQLite)   │                │  R2 (objects)    │
        │  append-only   │                │  immutable       │
        │  booking ops;  │                │  NDJSON exports  │
        │  PK(page,seq)  │                │  (the corpus)    │
        └────────────────┘                └──────────────────┘

    ╔═══════════════════════════════════════════════════════════════════╗
    ║  VERIFIED pure core — src/domain.ts (//@ backend dafny)           ║
    ║  confirmedCount, capacityAt, hasRoom, remaining; withinCapacity/  ║
    ║  wellFormed (A1–A3); tryBook (accept-iff-room) + invariant        ║
    ║  preservation; cancel (reverse monotonicity); Op/applyOp/replay   ║
    ║  (deterministic, Inv-preserving); confirmedCount homomorphism +   ║
    ║  under-subscription order theorem; bookersOf / availableSlots /   ║
    ║  soldOut queries; provider mutations (addSlot/closeSlot/setCap).  ║
    ╚═══════════════════════════════════════════════════════════════════╝
```

**Hosting: Cloudflare, one Durable Object per page.** Single-threaded, so it serializes all
booking attempts for a page into a *total order* for free — and here that order is **load-
bearing** (§3): it's what decides who gets the last seat. `D1` holds the append-only op
records (`PRIMARY KEY (page_id, seq)` enforces append-only integrity and gives the corpus its
canonical order); `R2` holds immutable NDJSON exports. Export and query endpoints **replay the
same verified functions server-side**, so their answers provably match the live app.

**Addressing: vanity URLs `username/pagename`.** Unlike Quorum's unlisted random codes, Quota
pages are **branded and meant to be shared** — `quota.app/{username}/{pagename}`. This needs a
small **registry** (the only piece of global, cross-DO state):

- **`username`** is globally unique (a provider's public handle); **`pagename`** is a slug
  unique *within* that provider. A `D1` registry table — `providers(username PK, email)` and
  `pages(username, pagename, page_id, PRIMARY KEY (username, pagename))` — enforces both
  uniquenesses and maps a path to the opaque `page_id`.
- The booking **Durable Object is addressed by `idFromName(page_id)`** (a stable opaque id
  minted at creation), *not* by the path — so renaming a page (or a username) is a registry
  update that never moves the DO or disturbs the op log. Path → `page_id` is one registry
  lookup, then straight to the DO.
- Reserved-word / format validation on usernames and pagenames (and the global username
  allocation) are **trusted shell** — they gate *naming*, never *booking correctness*.

**Provider auth: magic-link email.** Provider enters their email → Worker mails a signed,
expiring link → a session cookie/JWT authorizes the **provider/management routes only** (claim
a username, create/edit pages and slots, see bookers). Booking routes are open. **Auth is a
trust-boundary concern** — it gates *who may create/edit slots and see bookers*, but the
booking core's correctness does not depend on it.

**Privacy.** The public booking page sees **availability (counts) only**; bookers' identities
(`name`/`key`/contact) are visible **only to the authenticated provider**. The DO redacts the
broadcast to public sockets accordingly. A booker's own confirmation/cancellation is keyed by
the private booking `id` (their cancellation token).

**The store seam — adapted for fallible writes.** Quorum's `dispatch(op)` was fire-and-forget
(optimistic). Quota's `dispatch(attempt)` **returns a promise of `{outcome, page}`** — the UI
shows *pending → confirmed / already-yours / full* based on the DO's reply. One interface, two
implementations (local for dev/single-device, remote `RemoteStore` over WebSocket), no UI
rewrite — same discipline as Quorum, with the pessimistic return value as the only shape
change.

**Trust boundary, stated precisely.** Verified: all slot-index math, the count, accept/reject,
capacity safety, conservation, cancellation monotonicity, op-log replay determinism, queries,
and (optionally) the index↔layout map. Trusted: magic-link auth, the React UI,
WebSocket/DO/D1/R2 I/O, email, the `slotIdx ⟷ (date, time, label, timezone)` map, and
abuse/rate-limiting/identity spoofing.

## 7. Properties — the staged catalog

Grouped into families and sequenced into stages. We design the model now so every family is
reachable; we prove them in order. Spec sketches use LemmaScript syntax (`forall(k, P)`,
`\result`, no `\old`; each `//@ ensures` becomes a *separate* `_ensures` lemma, so functions
are **pure recursive** and the kernel is **total**). **Stages 0, 0b, 1, 2, 2b, 3 (Families A, B,
C, G, D, F, E) are implemented and verified** (`src/domain.ts`, 80 Dafny VCs, 0 errors); those specs below are the
real ones. The remaining stages are _planned_ — their sketches are the intended specs, pinned
during implementation.

### Family A — Well-formedness (the no-overbooking invariant)
`Inv(p)` as in §5, via a reflection-carrying recursive predicate:

```ts
// A1 reflection lemma, à la Quorum's allAvailLen: a caller holding withinCapacity
// recovers the quantified per-slot bound.
//@ ensures \result === true ==> forall(j, 0 <= j && j < slots.length ==> confirmedCount(bs, j) <= slots[j].capacity)
function withinCapacity(slots: Slot[], bs: Booking[]): boolean

function wellFormed(p: Page): boolean   // A1 ∧ A2 ∧ A3
```

### Family B — The count & the decision (the core promise)
`confirmedCount` is the spec-level recursive count, built on a **total** `holds` (a booking
counts iff it is `confirmed` and targets the given index), so it needs no precondition — which
is what lets it compose freely (Family D) and keeps these specs clean. This is Quorum's
`countFree`/`freeAt` kernel, re-pointed at bookings.

```ts
// b holds slot idx iff it is a confirmed booking for that index. Total.
function holds(b: Booking, idx: number): boolean

//@ ensures 0 <= \result && \result <= bs.length
function confirmedCount(bs: Booking[], idx: number): number

// capacity of slot idx, or 0 if out of range (total).
//@ ensures \result >= 0
function capacityAt(slots: Slot[], idx: number): number

// room iff in range and under capacity.
//@ ensures \result === (0 <= idx && idx < p.slots.length && confirmedCount(p.bookings, idx) < capacityAt(p.slots, idx))
function hasRoom(p: Page, idx: number): boolean

// Does `key` already hold a confirmed booking for slot idx? Total recursive — the
// per-(slot, booker) idempotency check (NOT a one-per-person rule). Returns false for a
// booker who only holds OTHER slots, so multi-slot booking is unrestricted.
function keyHolds(bs: Booking[], idx: number, key: string): boolean
```

The headline transition. The outcome is a **three-way verdict**, so the shell can tell a happy
retry from a real "sold out":

- **`confirmed`** — a *new* seat was appended (there was room and this booker didn't already
  hold this slot).
- **`duplicate`** — this booker already holds this slot; **idempotent success**, no new seat,
  page unchanged. (A double-click / reconnect lands here, not on `full`.)
- **`full`** — no room (or no such slot); page unchanged.

A booker holding *other* slots never affects any of this — the check is per-(slot, booker), so
multi-slot booking is unrestricted by design.

```ts
type BookOutcome = "confirmed" | "duplicate" | "full"
interface BookResult { outcome: BookOutcome; page: Page }

// Total: append a confirmed booking iff there's room AND `key` doesn't already hold idx;
// a duplicate is idempotent success; anything else is `full`. Only `confirmed` mutates.
// Invariant preservation is the separate lemma below.
//@ ensures \result.page.slots === p.slots
//@ ensures \result.outcome === "duplicate" === keyHolds(p.bookings, idx, key)
//@ ensures \result.outcome === "confirmed" === (!keyHolds(p.bookings, idx, key) && hasRoom(p, idx))
//@ ensures \result.outcome === "confirmed" || \result.page === p   // duplicate/full leave state untouched
function tryBook(p: Page, idx: number, bookingId: string, key: string, seq: number): BookResult

// Capacity safety: a booking attempt never breaks the invariant — for ANY outcome.
//@ requires wellFormed(p)
//@ ensures wellFormed(tryBook(p, idx, bookingId, key, seq).page)
function tryBookPreservesInv(p: Page, idx: number, bookingId: string, key: string, seq: number): boolean { return true }
```

The safety proof rests on the **snoc homomorphism** (appending a booking bumps exactly its own
slot's count by one, leaves all others fixed) — the same algebra as Quorum's `countFreeConcat`:

```ts
//@ ensures confirmedCount(bs.concat([b]), idx) === confirmedCount(bs, idx) + (holds(b, idx) ? 1 : 0)
function confirmedCountSnoc(bs: Booking[], b: Booking, idx: number): boolean { return true }
```

### Family C — Conservation & cancellation monotonicity
```ts
// remaining + confirmed === capacity; remaining >= 0 on a well-formed page (in range).
//@ requires wellFormed(p) && 0 <= idx && idx < p.slots.length
//@ ensures \result + confirmedCount(p.bookings, idx) === capacityAt(p.slots, idx)
//@ ensures \result >= 0
function remaining(p: Page, idx: number): number

// Cancelling never raises any slot's count (so it preserves Inv and strictly frees room).
//@ ensures confirmedCount(cancelById(bs, bookingId), idx) <= confirmedCount(bs, idx)
function cancelMonotone(bs: Booking[], bookingId: string, idx: number): boolean { return true }

//@ requires wellFormed(p)
//@ ensures wellFormed(cancel(p, bookingId))
function cancelPreservesInv(p: Page, bookingId: string): boolean { return true }
```

### Family D — Contention & order (the headline contrast)
The count of a **fixed set** of bookings is order-independent — `confirmedCount` is a
homomorphism from booking-list concatenation to integer addition (Quorum's Family-D core,
re-pointed):

```ts
//@ ensures confirmedCount(xs.concat(ys), idx) === confirmedCount(xs, idx) + confirmedCount(ys, idx)
function confirmedCountConcat(xs: Booking[], ys: Booking[], idx: number): boolean { return true }
```

But — the inversion — the **accepted set** is *not* order-independent under contention; that's
*why* the DO's total order is necessary (§3). The expressible, provable boundary:

```ts
// Replay determinism: folding an op log is a deterministic function (same ops ⇒ same page),
// and preserves the invariant — so every reachable page state is well-formed, the export is
// reproducible, and the DO's serialized decisions are the canonical ones.
//@ requires wellFormed(p) && allOpsOk(ops, p)
//@ ensures wellFormed(replay(p, ops))
function replayPreservesInv(p: Page, ops: Op[]): boolean { return true }
```

**The order boundary — implemented & verified (Stage 2b).** The sharpest expressible form
isn't a "no-contention" carve-out — it's that the count is order-invariant *unconditionally*,
contention included (the loser is simply rejected in either order, so the slot saturates to the
same number):
```ts
// Two booking attempts, applied in EITHER order, leave every slot's confirmed count identical.
//@ ensures confirmedCount(tryBook(tryBook(p, i1,id1,k1,q1).page, i2,id2,k2,q2).page.bookings, s)
//@       === confirmedCount(tryBook(tryBook(p, i2,id2,k2,q2).page, i1,id1,k1,q1).page.bookings, s)
function bookCountOrderInvariant(p: Page, i1,id1,k1,q1, i2,id2,k2,q2, s): boolean { return true }
```
So availability (`hasRoom`/`availableSlots`/`soldOut`, all functions of the count) is
order-free — **no locking is needed for safety**. What *is* order-sensitive is only **which
booker wins** the contended seat — i.e. *fairness* — and that is exactly what the DO's total
order provides. This is the precise, mechanized statement of "Quota is Quorum inverted."

Full element-permutation invariance over an N-attempt batch (vs. the pairwise statement above)
is now **verified**, not just argued: LemmaScript gained a spec-only `perm(a, b)` predicate
(lowering to Dafny's `multiset(a) == multiset(b)`) to close the gap Quorum first noted.
`confirmedCountPerm` (`perm(xs, ys) ==> confirmedCount(xs, idx) === confirmedCount(ys, idx)`)
proves the count depends only on the multiset of the log; `hasRoomPermInvariant` lifts it to
the product-visible observable — two pages with the same slots and a permuted booking log agree
on `hasRoom` at every slot. So "availability is order-free" is mechanized for *any* reordering,
not just the pairwise swap. The proof reuses the concat-homomorphism `confirmedCountConcat` as a
remove-at-index step (the adjacent-swaps argument, now discharged inductively rather than left
in prose). The identity of *which* contender wins remains the order-sensitive part the
serializer pins — that line is unchanged.

### Family E — Export faithfulness & query soundness — **implemented & verified**
The export carries only the **confirmed** bookings (cancelled ones are noise for availability).
The proofs show this is faithful — every slot's count, and hence availability, is identical over
the export and the live page, so "query over the export === the answer the booker saw":

```ts
// E1: dropping cancelled bookings never changes a slot's confirmed count.
//@ ensures confirmedCount(confirmedOnly(bs), idx) === confirmedCount(bs, idx)
function confirmedOnlyPreservesCount(bs: Booking[], idx: number): boolean { return true }

// E2: availableSlots is identical over the export and the live page (query soundness).
//@ ensures forall(j, 0 <= j && j < p.slots.length ==> availableSlots(exportPage(p))[j] === availableSlots(p)[j])
function availableSlotsOverExport(p: Page): boolean { return true }
```
The shipped feature uses the **verified `confirmedOnly`** to build the NDJSON export
(`GET /api/pages/:id/export.ndjson`), and the query endpoint (`GET …/query`) runs the verified
functions over the corpus.
- **E3 (append-only integrity)** — enforced at D1 by `PRIMARY KEY (page_id, seq)`; the corpus
  is immutable and re-export is deterministic (DB-enforced, a trusted mechanism).
- **E4 (canonical encoding)** — `encode` is a function (same page → same bytes), so exports
  are reproducible and diffable.

### Family F — Query algebra (the "see who/what" layer)
```ts
// Who holds a slot — by construction the confirmed-filter of the log; its length provably
// equals the count, so the provider's "3 booked: …" list can never disagree with the number.
//@ ensures \result.length === confirmedCount(p.bookings, idx)
function bookersOf(p: Page, idx: number): Booking[]

// Per-slot availability mask, characterized exactly against the count.
//@ ensures \result.length === p.slots.length
//@ ensures forall(j, 0 <= j && j < p.slots.length ==> \result[j] === hasRoom(p, j))
function availableSlots(p: Page): boolean[]

//@ ensures \result === forall(j, 0 <= j && j < p.slots.length ==> !hasRoom(p, j))
function soldOut(p: Page): boolean
```

### Family G — Provider mutations (management, invariant-preserving)
Slots are append-only; "closing" lowers capacity to the current count (no new bookings) rather
than deleting (which would reindex). The interesting obligation: **you cannot set capacity
below what's already booked.**

```ts
//@ requires numSlots-agnostic ... ensures wellFormed(\result)
function initPage(id: string, title: string, slots: Slot[]): Page   // requires every capacity >= 0

// Append a slot (capacity >= 0). New slot has 0 bookings ⇒ count 0 <= capacity ⇒ Inv holds.
//@ requires wellFormed(p) && newCap >= 0
//@ ensures wellFormed(\result)
function addSlot(p: Page, label: string, newCap: number): Page

// Change capacity of slot idx. Lowering is allowed only down to the current confirmed count.
//@ requires wellFormed(p) && 0 <= idx && idx < p.slots.length
//@ requires newCap >= confirmedCount(p.bookings, idx)
//@ ensures wellFormed(\result)
function setCapacity(p: Page, idx: number, newCap: number): Page

// Closing == setCapacity(p, idx, confirmedCount(p.bookings, idx)) — no new bookings, never oversold.
function closeSlot(p: Page, idx: number): Page
```

## 8. The query layer & export format

- **Export:** one NDJSON line per booking op (`{pageId, seq, kind, slotIdx, bookingId, key,
  status, at}`) plus a page-header line (`{pageId, title, slots:[{label, capacity}]}`).
  Streamed from `GET /api/pages/:id/export.ndjson`. Booker contact (PII) is included only in
  the **provider-authenticated** export; the public export carries counts/availability only.
- **Ad-hoc queries:** raw SQL over the D1 op table for exploration ("fill rate across pages",
  "no-show/cancellation rate", "time-to-sellout").
- **Trustworthy queries:** decision-grade answers (`availableSlots`, `soldOut`, `bookersOf`)
  come from `GET /api/pages/:id/query`, which **runs the verified functions** over the
  replayed corpus — so the answer is provably the one the booker saw (E2). SQL for free-form
  exploration; verified functions for answers people act on.

## 9. Roadmap (staged proofs, designed-for upfront)

| Stage | Lands | Families | Status |
|-------|-------|----------|--------|
| **0 — spine** | Total `holds`/`confirmedCount`/`capacityAt`/`hasRoom`; `withinCapacity`/`wellFormed`; `tryBook` (3-way `confirmed`/`duplicate`/`full`, accept-iff-room) + `tryBookPreservesInv` (capacity safety); `confirmedCountSnoc` homomorphism + `withinCapacityUpto` reflection (sound + complete) + `withinCapacityUptoAppend`. | A, B | ✅ **verified** (20 VCs, 0 errors) |
| **0b — conservation + cancel** | `remaining` (conservation `remaining + confirmed === capacity`, `≥ 0`); `cancelById`/`cancelMonotone` (reverse monotonicity) / `cancel` (Inv-preserving). | C | ✅ **verified** (27 VCs, 0 errors) |
| **1 — provider mutations** | `initPage`/`addSlot`/`setCapacity`/`closeSlot` preserve `Inv`; the "can't lower capacity below booked" obligation. Also **strengthened the invariant with A3** (no phantom bookings, needed by `addSlot`) and re-proved `tryBook`/`cancel` preserve it. | A, G | ✅ **verified** (47 VCs, 0 errors) |
| **2 — op model + replay** | `Op`/`applyOp`/`replay` (total) + `applyOpPreservesInv`/`replayPreservesInv` (every reachable state well-formed); `confirmedCountConcat` count homomorphism + `confirmedCountComm` batch commutativity. | D (core) | ✅ **verified** (53 VCs, 0 errors) |
| **2b — order boundary** | `bookCountOrderInvariant`: two booking attempts, applied in **either order**, leave every slot's `confirmedCount` identical — *even under contention* (the loser is rejected either way, so the count saturates the same). Built from `bookDelta` (per-attempt count delta) + `keyHoldsSnoc`/`keyHoldsAfterBook`. The exact formal "Quorum-inversion": availability/safety is order-free (no locking), only *which booker wins* is order-sensitive (fairness needs the serializer). | D | ✅ **verified** (71 VCs, 0 errors) |
| **3 — queries** | `bookersOf` (length === count), `availableSlots` (per-slot room mask, exact), `soldOut` (iff no slot has room). | F | ✅ **verified** (67 VCs, 0 errors) |
| **3b — export faithfulness** | `confirmedOnly` + `confirmedOnlyPreservesCount` (E1: dropping cancelled bookings preserves every slot's count); `exportPage`/`availableSlotsOverExport` (E2: availability is identical over the export — query-over-export soundness). The export carries the verified-confirmed bookings; a query re-run over them yields the booker's answer. | E | ✅ **verified** (76 VCs, 0 errors) |
| **2c — full permutation invariance** | `confirmedCountPerm` (`perm(xs, ys) ==> confirmedCount` agrees) and `hasRoomPermInvariant` (same slots + permuted log ⇒ same `hasRoom`) — the N-attempt closure of 2b, via the `perm(...)` predicate added to LemmaScript; proof reuses `confirmedCountConcat` as a remove-at-index step. | D | ✅ **verified** (80 VCs, 0 errors) |
| **4 — richness (optional)** | Waitlist (rejected → FIFO queue; cancel promotes the head, capacity still safe) — adds promotion semantics + FIFO/served-≤-capacity proofs. Per-slot booking windows (open/close times) as shell + a verified "closed ⇒ no accept" guard. | (extends B/C) | _deferred_ |

Each stage is shippable; the safety core is trustworthy after Stage 0, with the proof surface
growing without restructuring it.

## 10. Verification approach

- **`//@ backend dafny`**, discharged via `lsc` on the real TypeScript (`src/domain.ts`);
  `LemmaScript-files.txt` manifest; CI regenerates `.dfy.gen` and runs `dafny verify`,
  asserting no drift — matching the workspace convention.
- **The same `domain.ts` runs everywhere** — React (render `hasRoom`/`remaining`), the Durable
  Object (authoritative `tryBook`/`cancel`/`replay`), and the query endpoint (replay over
  corpus). No adapter, no second implementation, no desync.
- **`ensures` are separate lemmas.** As in Quorum: write **pure recursive functions** (not
  imperative loops — `method`s can't take proof hints); keep the kernel **total** (`holds`,
  `confirmedCount`, `capacityAt` are precondition-free) so it composes inside `tryBook`,
  `hasRoom`, and the convergence lemmas; relational lemmas (snoc, monotonicity, homomorphism,
  order-freeness) use the **pure-carrier technique** (TS body `return true`, induction in the
  generated `_ensures`).
- **Nonlinear-arithmetic caution / `.dfy.base` regen gotcha** — follow Quorum's notes: prove
  multiplication facts with tiny inductive helpers; `rm -f src/domain.dfy.base` before re-running
  a `regen` that previously errored.
- **Honest scope:** state each `ensures` precisely and name the trusted edges inline (auth,
  I/O, time labeling, DB-enforced append-only, identity spoofing). No "verified end-to-end"
  claim — we verify the *meaning of the booking decision*, not the whole app.

## 11. Open questions / deferred

- **Booker identity & dedup.** `key` = a localStorage token. Multi-slot booking is allowed by
  design, so the dedup is *only* per-(slot, booker) idempotency (a refresh/double-click doesn't
  double-book the *same* slot; "my bookings" works per device). One open choice: also key
  idempotency on email when given, so the same person can't take *two* seats of the *same* slot
  from two devices. Impersonation/abuse stays a trusted/rate-limiting concern (a malicious
  client can present any `key`).
- **Optional per-page per-person cap (deferred, verified-able).** If a provider wants "at most
  K slots per person on this page," it's a clean verified extension: a `personCount(bookings,
  key)` recursive count and a `tryBook` guard `personCount < maxPerPerson`, with a snoc lemma
  and invariant just like capacity. Default is **unlimited** (per your call); add only if a
  provider asks for it.
- **Hold / TTL semantics.** Should a click place a short **tentative hold** (seat reserved for
  N minutes pending confirmation) rather than an instant confirm? That adds a timed
  `held → confirmed | expired` sub-state and a clock dependency — a candidate Stage-4 extension
  with its own "expired holds free the seat" proof.
- **Waitlist (Stage 4).** Adopt only if the promotion/FIFO proofs are worth it; the v1 product
  is reject-when-full.
- **Index↔layout map.** Verify the featured-page layout arithmetic (à la Quorum's `grid.ts`,
  e.g. row/column or day/time placement of slots) to shrink the trusted edge to just
  calendar/timezone labels — or leave it fully shell if the layout is a flat list.
- **Capacity model.** Core is general `count ≤ capacity` with **default 1**; the product models
  a class as N sibling slots. Revisit only if a true single-row "N seats" cell is wanted in the
  UI (the core already supports it — purely a UI/labeling choice).