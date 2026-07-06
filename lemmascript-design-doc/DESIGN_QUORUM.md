# Quorum — Design

A slick, login-free **when2meet** clone whose answer — *"here's the time the most people can make it"* — is **formally verified** in [LemmaScript](https://github.com/midspiral/LemmaScript), and whose data is **exportable and queryable** with the guarantee that queries over the export return the same answers as the live app.

The name is the domain concept: the recommended slot is where you reach **quorum** — enough people available — which is exactly the threshold/argmax math we prove.

---

## 1. The product

- Create an event: a grid of candidate slots (days × a daily time range at some granularity). Get a shareable link.
- **No login.** A participant opens the link, types a name, and paints their availability on the grid (drag to select).
- A **live heatmap** shows, per slot, how many people are free. Best times surface automatically.
- One click **exports** the whole event as NDJSON. A query endpoint (and raw SQL over the stored corpus) lets you ask "best slots", "slots where ≥ k are free", "who's free at slot s", "overlap between this subset of people", etc.

Classic when2meet, but with a verified core and a trustworthy export.

## 2. The promise — what is verified, and why

The thing a scheduling tool must get right is the **aggregate**: the heatmap and the recommendation. Everyone makes a real decision based on it. So the heatmap, the best-time recommendation, the query answers, and the export's faithfulness are exactly what we verify. Concretely, Quorum's verified core guarantees:

1. **The heatmap is the count.** Each slot's number is exactly the number of participants who marked themselves free there — never off by one, never double-counting.
2. **The recommendation is actually best.** The "best" mask flags exactly the argmax slots of the heatmap, and flags nothing when nobody has entered anything.
3. **More availability only helps.** Adding a participant or marking more slots never lowers any slot's count (monotonicity).
4. **Order doesn't matter (convergence).** Because each participant owns only their own row, the heatmap is independent of the order edits arrive in. This is the formal justification for "no login, no locking, just merge."
5. **The export round-trips, and queries over it are sound.** Decoding the export reconstructs the event; a query computed over the export equals the same query computed live.

What is **not** verified (the trust boundary, stated honestly): the React UI, the WebSocket/storage I/O, and abuse/rate-limiting. The core reasons in abstract slot indices; the shell maps those to real calendar times for display. (The *index arithmetic* of that mapping — cell `(day,time)` → slot — is itself verified in `src/grid.ts`: in-range + injective. So only the calendar/timezone labels remain trusted.)

## 3. The key design insight

A when2meet clone is **far simpler to verify** than a general collaborative app, and the architecture leans entirely on why:

> **Availability is partitioned by participant.** Each participant owns exactly their own row of the grid; nobody edits anyone else's cells.

So there are *no edit conflicts*. The entire rebase / intent-envelope / minimal-rejection machinery that a collaborative todo/kanban app needs (see *Influences*) collapses. What replaces it is cleaner and has more interesting proof content:

- The heatmap is a **commutative fold** over per-participant availability ⇒ **convergence/order-independence** is a real, provable property rather than a bolted-on conflict resolver.
- The structural invariant is tiny (one well-formedness condition per participant), so the proof effort concentrates where the *algorithmic* cleverness is — aggregation, convergence, and query soundness — not in data-structure plumbing.

## 4. Influences (prior art in this workspace)

- **`rallly-lemmascript`** — the scheduling domain. Its verified `scorePoll` pins the score formula, proves within-poll **monotonicity** (a strictly-better option can't rank lower) and **tiebreaker injectivity**, and the "no winner at zero votes" rule. Quorum generalizes these from a flat option list to a grid.
- **`trace-solo-lemmascript`** — the greenfield architecture: Vite + React, **no login** (anonymous id in localStorage), local-first, **Cloudflare Worker + D1 + R2**, NDJSON export, and a higher-order verified pure core whose `validateFrom`/round-trip properties are the model for our **export faithfulness**.
- **`dafny-replay` / `collab-todo-lemmascript`** — server-authoritative state with an append-only op log, and the discipline of *one invariant proved once, preserved by every transition, executing identically on client and server*. We keep the append-log and the "one import everywhere" discipline; we drop the rebase machinery (partitioned data, no conflicts).
- **`reference-crdts-lemmascript` / `g-counter-crdt-lemmascript`** — in-house precedent for the **convergence** proofs (Family D).

## 5. Data model

The verified core works in abstract slot indices `[0, numSlots)`. The grid's day/time/timezone labeling is a shell concern.

```ts
//@ backend dafny

interface Participant {
  id: string;        // anonymous, allocated on join; identity = "this row"
  name: string;
  avail: boolean[];  // length === numSlots; avail[s] === free at slot s (dense bitset)
  updatedAt: number; // logical timestamp, for LWW convergence (Family D)
}

interface Event {
  id: string;
  title: string;
  numSlots: number;        // = numDays * slotsPerDay; dims/labels live in the shell
  participants: Participant[];
}
```

**Why a dense `boolean[]` bitset rather than a set of indices?** It makes the well-formedness invariant trivial (in-range and duplicate-free come for free from "length === numSlots"), so the count is bounded by the participant total automatically and Families A/B are cheap. The *export* uses a sparse representation (sorted unique indices); the codec correctness (`densify(sparsify(a)) == a`) becomes a meaningful round-trip lemma rather than free.

**Invariant `Inv(e)`** — the structural conditions a well-formed event satisfies:

- **A1.** Every participant's bitset matches the grid: `forall(i, participants[i].avail.length === numSlots)`.
- **A2.** Participant ids are unique: `forall(i, forall(j, i < j ==> participants[i].id !== participants[j].id))`.
- **A3.** `numSlots >= 0`.

(In-range and per-participant dedup are subsumed by A1 — that's the payoff of the bitset.)

> **Implemented (Stage 0):** `wellFormed(e)` = A3 ∧ `allAvailLen(participants, numSlots)`, where `allAvailLen` is a recursive predicate carrying a reflection lemma that hands a caller the quantified A1 fact. **Aggregation no longer depends on `Inv` at all:** `countFree` is built on a *total* `freeAt` (out-of-range slots count as not-free), so `heatmap`/`isBest`/`availableAtLeast` only require `numSlots >= 0`. `wellFormed` remains the intended event shape that the mutations (Stage 0b) preserve; on a well-formed event A1 makes `freeAt(p, s) === p.avail[s]` for every in-range slot. **A2 (id uniqueness) is not yet in `wellFormed`** — not needed by the heatmap (counting is per-row, order-free), only by the query layer (Family F, e.g. `participantsAt` returning distinct ids), so it lands there.

## 6. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  React grid painter + live heatmap (UNVERIFIED shell)            │
│  imports domain.ts directly → optimistic heatmap uses the SAME   │
│  verified heatmap() the server uses → no client/server desync    │
└───────────────────────────────┬──────────────────────────────────┘
                                │ WebSocket (hibernatable)
┌───────────────────────────────▼───────────────────────────────────┐
│  Durable Object, one per event (UNVERIFIED shell)                 │
│   • canonical Event + append-only op log in DO storage            │
│   • mutates state ONLY via verified applyOp() / setAvailability() │
│   • broadcasts heatmap diffs to connected painters                │
└────────────────────────────────┬──────────────────────────────────┘
                ┌────────────────┴────────────────┐
        ┌───────▼────────┐               ┌────────▼────────┐
        │  D1 (SQLite)   │               │  R2 (objects)   │
        │  append-only   │               │  immutable      │
        │  op records;   │               │  NDJSON         │
        │  PRIMARY KEY   │               │  snapshots      │
        │  enforces E3   │               │  (the corpus)   │
        └────────────────┘               └─────────────────┘

    ╔═══════════════════════════════════════════════════════════════╗
    ║  VERIFIED pure core — src/domain.ts (161 VCs, 0 errors)       ║
    ║  wellFormed/wellFormedStrict (A1+A2+A3); countFree, heatmap,  ║
    ║    maxCount, isBest, availableAtLeast; countFree homomorphism  ║
    ║    + monotonicity (joins + paints via isSubsetOf);             ║
    ║    init/add/setAvailability/removeP (Inv-preserving);          ║
    ║    sparsify/densify codec (E1) + event-level round-trip;       ║
    ║    Op/applyOp/replay (Inv-preserving + strict under freshIds); ║
    ║    setAvailLWW (D2 LWW); D1 full-perm; participantsAt         ║
    ║    (membership-exact + distinct under uniqueIds); overlap;     ║
    ║    query-over-export (heatmap/isBest/availableAtLeast/overlap) ║
    ╚═══════════════════════════════════════════════════════════════╝
```

**Hosting: Cloudflare, one Durable Object per event.** The DO is single-threaded, so it serializes all writes to an event into a *total order* for free. Two things make this elegant:

1. It gives the append-only op log a canonical order without any locking.
2. Because the heatmap is order-independent anyway (Family D), the storage layer and the proof reinforce each other — the DO's serialization is *sufficient but not necessary* for correctness, which is the strongest possible position.

`D1` holds append-only op records (the queryable corpus, with `PRIMARY KEY` enforcing append-only integrity); `R2` holds immutable NDJSON snapshots. The export and query endpoints **replay the same verified functions server-side**, so their answers provably match the live app.

> **Alternative backend (Supabase).** Maps cleanly: Postgres row per event with a `version` column for optimistic concurrency (à la `collab-todo`), Realtime for live heatmap push, an edge function calling the same `domain.ts`. We default to Cloudflare + DO because the per-event single-threaded model is the slicker fit and needs no auth; Supabase remains a drop-in if we want managed Postgres + SQL out of the box.

> **Built so far (the app).** A pure **React + Vite SPA in TypeScript** (shell and verified core are both `.ts`/`.tsx`, so the UI is typechecked against the core's exported `Event`/`Participant` types), light-themed, local-first, with a deliberately **transport-agnostic seam**: `src/store.ts` is the only module that imports `applyOp` (`dispatch(op)` = `applyOp` + persist + notify, over a monotonic LWW clock), and `src/useQuorum.ts` is the only caller of `heatmap`/`isBest`/`maxCount` — so no scheduling math lives in components. Today the store is local (in-memory + `localStorage`); a future `RemoteStore` (WebSocket → the Durable Object above) implements the same `{getSnapshot, subscribe, dispatch}` interface with **no UI rewrite**. The cell↔slot mapping goes through the verified `src/grid.ts`; the NDJSON export uses the verified `sparsify`. UI is `src/App.tsx` (event creation in **two modes — a Sunday-start month calendar for specific dates, or day-of-week chips for recurring availability**; single grid with Paint/Group toggle, participant chips) + `src/components/Grid.tsx`. The grid model is `{kind: "dates" | "weekdays", cols, …}` — both modes are pure shell labeling over the same flat slot indices, so `domain.ts`/`grid.ts` are untouched by the distinction. In Group view, hovering a cell shows **who is free there** via the verified `whoIsFree` (whose length provably equals the cell's count). The verified `availableAtLeast` threshold query stays in the core but isn't surfaced in the UI (the heatmap already shows per-slot counts). Runtime-checked by `test/smoke.mjs` (`npm test`).

**Trust boundary, stated precisely.** Verified: all slot-index math, aggregation, queries, codec, op-log semantics. Trusted: WebSocket/DO/D1/R2 I/O, and the `slotIndex ⟷ (date, time, timezone)` map (each viewer renders the abstract grid in their own tz; the canonical index is tz-independent, anchored to absolute instants chosen at event creation).

## 7. Properties — the staged catalog

Properties are grouped into families and sequenced into stages. We design the data model now so every family is reachable; we prove them in order. Spec sketches below use LemmaScript syntax (`forall(k, P)`, `\result`, no `\old`). **All families through Stage 3 are implemented and verified (`src/domain.ts`, 161 VCs, 0 errors): A1 well-formedness + A2 id-uniqueness (standalone `uniqueIds` predicate with `wellFormedStrict` + preservation through mutations/ops/replay), B aggregation, C monotonicity (joins AND availability-expanding paints via `isSubsetOf`), D convergence (batch + full permutation + D2 LWW), E codec (sparse round-trip + event-level `encodeEvent`/`decodeEvent` round-trip + query-over-export soundness for `heatmap`/`isBest`/`availableAtLeast`/`overlap`), F queries (`whoIsFree` count + membership-exact `freeParticipants`, `participantsAt` with membership-exact ids + distinctness under `uniqueIds`, `overlap`). Those specs are the real ones; the rest are illustrative and get pinned during implementation.**

A note from Stage 0 that shapes the specs: LemmaScript emits each pure function's `//@ ensures` as a *separate* `_ensures` lemma rather than a Dafny postcondition. So a function cannot rely on a callee's `ensures` inside its own body — callee preconditions must be discharged structurally. This pushed three concrete choices: aggregation is written as **pure recursive functions** (not imperative loops, which can't take proof hints); the counting core is **total** (`freeAt` guards the bit access) so it carries no precondition and composes freely; and `maxCount` is **precondition-free** for the same reason.

### Family A — Well-formedness (the invariant)
`Inv(e)` as in §5. Every mutation preserves it:

```ts
//@ requires Inv(e) && p.avail.length === e.numSlots && !idTaken(e, p.id)
//@ ensures Inv(\result)
function addParticipant(e: Event, p: Participant): Event

//@ requires Inv(e) && newAvail.length === e.numSlots
//@ ensures Inv(\result) && sameParticipantsExceptAvail(e, \result, pid)
function setAvailability(e: Event, pid: string, newAvail: boolean[]): Event
```

### Family B — Aggregation correctness (heatmap + best) — **implemented & verified**
The core promise. `countFree(ps, s)` is the spec-level recursive count, built on a **total** `freeAt(p, s)` (out-of-range slots are not free), so it needs no well-formedness precondition — which is what lets it compose freely (Family D) and keeps these specs clean.

```ts
//@ requires e.numSlots >= 0
//@ ensures \result.length === e.numSlots
//@ ensures forall(s, 0 <= s && s < e.numSlots ==> \result[s] === countFree(e.participants, s))
//@ ensures forall(s, 0 <= s && s < e.numSlots ==> 0 <= \result[s] && \result[s] <= e.participants.length)
function heatmap(e: Event): number[]

// Precondition-free so it composes inside isBest's body. NOT floored at 0: the max
// of a non-empty list is an actual element (else maxCount([-5]) === 0 would break
// attainment). On a real heatmap every entry is >= 0, so the result is too.
//@ ensures forall(s, 0 <= s && s < h.length ==> h[s] <= \result)
//@ ensures h.length > 0 ==> exists(s, 0 <= s && s < h.length && h[s] === \result)
function maxCount(h: number[]): number

// "Best" is realized as a boolean MASK over slots, not a number[] index list: slot s
// is best iff its count ties the max AND the max is positive (the `best > 0` guard is
// property B5 — no recommendation when nobody has entered anything). The mask sidesteps
// set-membership reasoning and is exactly what the grid UI highlights.
//@ requires e.numSlots >= 0
//@ ensures heatmap(e).length === e.numSlots
//@ ensures \result.length === e.numSlots
//@ ensures forall(s, 0 <= s && s < e.numSlots ==>
//@           \result[s] === (heatmap(e)[s] === maxCount(heatmap(e)) && maxCount(heatmap(e)) > 0))
function isBest(e: Event): boolean[]
```

(A `number[]` list of best-slot indices — and the membership-iff characterization — remains a possible verified extraction later; the mask is the load-bearing form.)

### Family C — Monotonicity ("more people = better") — **implemented & verified**
Phrased without `\old` — as a relation between `f(e)` and `f(g(e))`, proved with the pure-carrier-lemma technique (TS body `return true`, induction in the generated `_ensures`).

**Implemented & verified** (real specs):
```ts
// C1: a join never lowers any slot's count. Proof: countFree(ps ++ [p]) =
// countFree(ps) + countFree([p]) >= countFree(ps) (homomorphism + non-negativity).
//@ requires wellFormed(e) && p.avail.length === e.numSlots
//@ ensures heatmap(addParticipant(e, p)).length === e.numSlots
//@ ensures heatmap(e).length === e.numSlots
//@ ensures forall(s, 0 <= s && s < e.numSlots ==> heatmap(addParticipant(e, p))[s] >= heatmap(e)[s])
function heatmapMonotoneUnderJoin(e: Event, p: Participant): boolean { return true; }

// C2: if everyone is free at s, then s is a best slot. The hypothesis uses the
// total `freeAt`, so it needs no well-formedness to be stated.
//@ requires e.numSlots >= 0 && e.participants.length > 0 && 0 <= s && s < e.numSlots
//@ requires forall(i, 0 <= i && i < e.participants.length ==> freeAt(e.participants[i], s) === true)
//@ ensures isBest(e).length === e.numSlots
//@ ensures isBest(e)[s] === true
function unanimousIsBest(e: Event, s: number): boolean { return true; }
```

Threshold query — **implemented & verified** (also a boolean mask, matching `isBest`):
```ts
//@ requires e.numSlots >= 0
//@ ensures heatmap(e).length === e.numSlots
//@ ensures \result.length === e.numSlots
//@ ensures forall(s, 0 <= s && s < e.numSlots ==> \result[s] === (heatmap(e)[s] >= k))
function availableAtLeast(e: Event, k: number): boolean[]
```

### Family D — Convergence / order-independence (the headline) — **batch core + D2 LWW + op-model verified**
Because the heatmap is a fold over per-participant rows, and `countFree` is **total**, the per-slot count is a *homomorphism from participant-list concatenation to integer addition*. That gives the algebraic backbone of "order doesn't matter," and it's proved:

```ts
// Homomorphism: counting two batches and adding === counting the joined list.
//@ ensures countFree(xs.concat(ys), s) === countFree(xs, s) + countFree(ys, s)
function countFreeConcat(xs: Participant[], ys: Participant[], s: number): boolean { return true; }

// Batch commutativity (corollary of the homomorphism + commutativity of +).
//@ ensures countFree(xs.concat(ys), s) === countFree(ys.concat(xs), s)
function countFreeComm(xs: Participant[], ys: Participant[], s: number): boolean { return true; }

// Lifted to the observable: two events differing only by the order of two
// participant batches have identical heatmaps — so concurrent batches of
// responses, applied in any order, agree on the heatmap (and on isBest / availableAtLeast).
//@ requires a.numSlots >= 0 && a.numSlots === b.numSlots
//@ requires a.participants === xs.concat(ys) && b.participants === ys.concat(xs)
//@ ensures forall(s, 0 <= s && s < a.numSlots ==> heatmap(a)[s] === heatmap(b)[s])
function heatmapBatchOrderInvariant(a: Event, b: Event, xs: Participant[], ys: Participant[]): boolean { return true; }
```

This is the formal "why login-free merge is safe": the aggregate factors through the commutative monoid (ℤ, +), so batch order and grouping are irrelevant.

**D2 (same-participant LWW convergence) — implemented & verified.** Concurrent edits to *one* participant (e.g. two devices) resolve last-writer-wins by timestamp. `setAvailLWW` writes a row only if the incoming timestamp is strictly newer; two writes to the same participant with distinct timestamps commute:
```ts
//@ requires t1 !== t2
//@ ensures setAvailLWW(setAvailLWW(ps, pid, a1, t1), pid, a2, t2) === setAvailLWW(setAvailLWW(ps, pid, a2, t2), pid, a1, t1)
function setAvailLWWCommutes(ps, pid, a1, t1, a2, t2): boolean { return true; }
```

**Op model / replay — implemented & verified.** A total `applyOp` (join a row / LWW-repaint a row) and `replay` (fold an op log) preserve the invariant — `applyOpPreservesInv` and `replayPreservesInv` show every reachable event state is well-formed. (`applyOp`/`replay` are total and inline the pure transforms, so they compose without a `wellFormed` precondition; preservation is proved separately — the CRDT discipline of total ops + invariant lemmas.)

**Verified — D1 (full element-level permutation invariance).** The natural statement, `perm(xs, ys) ==> countFree(xs, s) === countFree(ys, s)`, is now expressible: the `perm(...)` spec predicate (lowering to Dafny's `multiset(a) == multiset(b)`) was added to LemmaScript to close exactly this gap. `countFreePerm` proves it, and `heatmapPermInvariant` lifts it to the observable — two events whose participant lists are permutations of each other have identical heatmaps (subsuming the two-batch `heatmapBatchOrderInvariant`). The proof is a remove-one-element induction that reuses the concat-homomorphism `countFreeConcat` as its remove-at-index step — the "one lemma away" the abelian-monoid core promised.

### Family E — Export faithfulness + query soundness
The dense⟷sparse codec is **implemented & verified**, characterized through membership (`contains`) rather than sortedness — `i` is in `sparsify(a)` iff `a[i]` is an in-range true bit, and `densify` reads `contains` pointwise, so the round-trip is the identity.

```ts
// i is a member of the sparse encoding iff it is an in-range true bit of a.
//@ ensures forall(i, contains(\result, i) === (0 <= i && i < a.length && a[i]))
function sparsify(a: boolean[]): number[]

//@ requires 0 <= n
//@ ensures \result.length === n
//@ ensures forall(i, 0 <= i && i < n ==> \result[i] === contains(idxs, i))
function densify(idxs: number[], n: number): boolean[]

// E1 round-trip — densify ∘ sparsify is the identity on a bitset (export loses nothing).
//@ ensures densify(sparsify(a), a.length).length === a.length
//@ ensures forall(i, 0 <= i && i < a.length ==> densify(sparsify(a), a.length)[i] === a[i])
function sparseRoundTrip(a: boolean[]): boolean { return true; }
```
(Event-level `decodeEvent ∘ encodeEvent = id` is the remaining plumbing: `id`/`title`/`numSlots` are scalars and each participant's `avail` round-trips by the lemma above.)
- **E2 (query-over-export soundness)** — corollary of E1 + purity: for any query `Q`, `Q(decodeEvent(encodeEvent(e))) === Q(e)`. Stated directly for `isBest`, `availableAtLeast`, `participantsAt`.
- **E3 (append-only integrity)** — enforced at D1 by `PRIMARY KEY (event_id, op_seq)`; the corpus is immutable and re-export is deterministic. (DB-enforced, not in-code — stated as a trusted mechanism, like trace-solo's P3.)
- **E4 (canonical encoding)** — `encodeEvent` is a function (same event → same bytes), so exports are reproducible and diffable.

### Family F — Query algebra soundness (the "run queries over it" layer)
**"Who is free at slot s" — implemented & verified, and surfaced in-app.** `whoIsFree`
returns the participants free at `s` (by construction the `freeAt`-filter of the roster);
its length provably equals the heatmap count, so the Group-view hover tooltip ("N free:
Alex, Sam") can never disagree with the number on the cell.

```ts
//@ ensures \result.length === countFree(ps, s)
function freeParticipants(ps: Participant[], s: number): Participant[]

//@ requires e.numSlots >= 0 && 0 <= s && s < e.numSlots
//@ ensures heatmap(e).length === e.numSlots
//@ ensures \result.length === heatmap(e)[s]
function whoIsFree(e: Event, s: number): Participant[]
```

**`participantsAt` — implemented & verified.** Returns the ids of participants free at `s`; length provably equals the heatmap count. `freeIdListMembership` proves membership-exactness: every returned id comes from a free participant, and every free participant's id is returned. `freeIdListDistinct` proves the returned ids are duplicate-free under `uniqueIds`.

```ts
//@ ensures \result.length === countFree(ps, s)
function freeIdList(ps: Participant[], s: number): string[]

//@ ensures \result.length === heatmap(e)[s]
function participantsAt(e: Event, s: number): string[]

// membership-exact: every result id has a free source, every free participant's id is in result
function freeIdListMembership(ps: Participant[], s: number): boolean

// under uniqueIds, returned ids are distinct
//@ requires uniqueIds(ps)
//@ ensures noDupStrings(freeIdList(ps, s))
function freeIdListDistinct(ps: Participant[], s: number): boolean
```

**`overlap` — implemented & verified.** Returns a boolean mask where slot `s` is true iff every requested participant id has some free row at `s`.

```ts
//@ ensures \result.length === e.numSlots
//@ ensures forall(s, 0 <= s && s < e.numSlots ==> \result[s] === allPidsFreeAt(e.participants, pids, s))
function overlap(e: Event, pids: string[]): boolean[]
```

## 8. The query layer & export format

- **Export:** one NDJSON line per participant (`{eventId, participantId, name, slots: number[]}`) plus an event header line (`{eventId, title, numSlots, dims}`). Sparse `slots` via verified `sparsify`. Streamed from `GET /event/:id/export.ndjson`.
- **Ad-hoc queries:** raw SQL over the D1 op/participant tables for exploration ("how many events reached quorum ≥ 5", cross-event analytics).
- **Trustworthy queries:** the recommendation-grade answers (`isBest`, `availableAtLeast`, `overlap`) come from a `GET /event/:id/query` endpoint that **runs the verified functions** on the decoded corpus — so the answer is provably the same one the painter saw (E2). The split is deliberate: SQL for free-form exploration, verified functions for answers people act on.

## 9. Roadmap (staged proofs, designed-for upfront)

| Stage | Lands | Families | Status |
|-------|-------|----------|--------|
| **0 — spine** | Total `countFree`/`freeAt`, `heatmap`/`maxCount`/`isBest`/`availableAtLeast` (count-correctness, boundedness, best mask, threshold). | A1, B, C4 | ✅ **verified** |
| **2 — convergence (core)** | `countFreeConcat` homomorphism, `countFreeComm` batch commutativity, `heatmapBatchOrderInvariant` — order-independence of the heatmap under participant batches. | D (core) | ✅ **verified** |
| **0b — mutations** | `initEvent`/`addParticipant`/`setAvailability`/`removeParticipant` preserve `Inv`. | A | ✅ **verified** |
| **0b — codec** | sparse codec `densify(sparsify) == id` (membership-characterized). | E1 | ✅ **verified** |
| **1 — monotonicity** | `heatmapMonotoneUnderJoin` (a join never lowers a count), `unanimousIsBest` (all-free ⇒ best slot). | C | ✅ **verified** |
| **2b — op-model + LWW** | `Op`/`applyOp`/`replay` (total) preserve `Inv` (`applyOpPreservesInv`, `replayPreservesInv`); `setAvailLWWCommutes` — D2: same-participant LWW writes with distinct timestamps converge. | D2 + op-log | ✅ **verified** |
| **2 — convergence (deep)** | D1 full element-permutation invariance — `countFreePerm` / `heatmapPermInvariant` via the `perm(...)` predicate. | D1 | ✅ **verified** |
| **3 — query layer** | `participantsAt` (membership-exact + distinct under `uniqueIds`), `overlap`, `freeIdListMembership`; query-over-export soundness E2 (`heatmap`/`isBest`/`availableAtLeast`/`overlap` over export); event-level codec round-trip (`decodeEvent(encodeEvent(e)) == e`). | F, E2 | ✅ **verified** |
| **3b — strict invariant** | `wellFormedStrict` (A1+A2+A3), `applyOpPreservesStrict`, `replayPreservesStrict` under `freshJoinIds`; paint monotonicity (`heatmapMonotoneUnderPaint` via `isSubsetOf`). | A2, C | ✅ **verified** |
| **4 — richness (optional)** | Ternary availability (`Available \| IfNeedBe \| Unavailable`) → unlocks rallly-style score-formula pinning + tiebreaker injectivity on top of the grid. | (extends B/C) | |

Each stage is shippable; the aggregation core is trustworthy after Stage 0, with the proof surface growing without restructuring it.

## 10. Verification approach

- **`//@ backend dafny`**, discharged via `lsc` on the real TypeScript (`src/domain.ts`); `LemmaScript-files.txt` manifest; CI regenerates `.dfy.gen` and runs `dafny verify`, asserting no drift — matching the workspace convention.
- **The same `domain.ts` runs everywhere** — React (optimistic heatmap), the Durable Object (authoritative mutate), and the query endpoint (replay over corpus). No adapter, no second implementation, no desync.
- **`ensures` are separate lemmas.** LemmaScript emits each pure function's `//@ ensures` as a standalone `_ensures` lemma, not a Dafny postcondition. Consequences confirmed so far: (1) write **pure recursive functions**, not imperative loops (`method`s can't take proof hints); (2) a function can't lean on a callee's `ensures` in its own body, so callee preconditions are discharged structurally — this is why the counting core is **total** (`freeAt`/`countFree` carry no precondition) and `maxCount` is precondition-free, so they compose inside `heatmap`, `isBest`, and the convergence lemmas; (3) lemmas that need induction get hand-written proofs in `domain.dfy` (e.g. `allAvailLen_ensures`, `heatmapUpto_ensures`, `maxCount_ensures`, `countFreeConcat_ensures`), which Dafny then re-checks. Many simple `_ensures` auto-discharge.
- **Induction without `\old`:** relational/monotonicity/convergence lemmas use the pure-carrier technique (TS body `return true`, induction in the generated `_ensures`).
- **`regen` + the `.dfy.base` gotcha.** `lsc regen` does a 3-way merge and preserves proof additions — but it anchors on `foo.dfy.base`, which it deletes only on success. A `regen` that ends in a verification error leaves a stale `.base`, and the *next* regen mis-merges (duplicate declarations). Fix: `rm -f src/domain.dfy.base` before re-running `regen` (`.base` is gitignored). New top-level functions are appended to the end of `domain.ts` so existing proofs aren't disturbed.
- **Honest scope:** we state each `ensures` precisely and name the trusted edges inline (I/O, timezone labeling, DB-enforced append-only). No "verified end-to-end" claim, no "just a demo."

## 11. Open questions / deferred

- **Timezones.** Canonical slot index is tz-independent (absolute instants fixed at creation); per-viewer rendering is shell. Confirm we don't need DST-aware slot math in the core.
- **Identity without login.** Participant id = localStorage token + chosen name. "Editing the wrong row" is prevented by the partition (you only ever send ops for your own id); impersonation/abuse is a trusted/rate-limiting concern, not a core property.
- **Ternary vs binary availability** (Stage 4) — adopt only if the richer scoring properties are worth the added codec/aggregation complexity.
- **Same-participant LWW depth (D2)** — how far to push the CRDT proof vs. relying on the DO's total order in practice.