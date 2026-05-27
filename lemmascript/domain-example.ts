//@ backend dafny

// ═══════════════════════════════════════════════════════════════
// Quota — verified domain core
//
// A booking page is a list of `slots` (each with a capacity) and an append-only
// list of `bookings`. Anonymous users grab slots until they're full; the core
// guarantees a page is NEVER oversold.
//
// Quota is Quorum *inverted*: where Quorum's data was partitioned per
// participant (no conflicts ⇒ optimistic, lock-free), Quota's bookings CONTEND
// for shared inventory, so the load-bearing fact is a *bound*, not a count:
//   for every slot j,  confirmedCount(bookings, j) <= slots[j].capacity.
//
// Stage 0 (this file): the safety spine.
//   • confirmedCount — the per-slot count of confirmed bookings (Quorum's
//     countFree kernel, re-pointed at bookings; total, precondition-free).
//   • withinCapacity / wellFormed — the no-overbooking invariant (A1).
//   • tryBook — accept iff there's room and this booker doesn't already hold the
//     slot (idempotent); a three-way outcome so a retry reads as success, not a
//     rejection. Only "confirmed" mutates.
//   • tryBookPreservesInv — capacity safety: a booking attempt never oversells.
//
// Style mirrors Quorum: pure recursive functions (no imperative loops), a TOTAL
// counting kernel so it composes freely, and each `//@ ensures` discharged by an
// inductive proof in the companion .dfy. Slot indices are abstract; the
// date/time/label of a slot is a concern of the (unverified) shell.
// ═══════════════════════════════════════════════════════════════

// ── Types ─────────────────────────────────────────────────────

interface Slot {
  label: string      // display only (time/title); OPAQUE to the core
  capacity: number   // >= 0; product default 1. capacity 0 === "closed"
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
  slots: Slot[]          // append-only; close by lowering capacity to current count
  bookings: Booking[]    // append-only log; cancellation flips status, never removes
}

type BookOutcome = "confirmed" | "duplicate" | "full"

interface BookResult {
  outcome: BookOutcome
  page: Page
}

export type { Slot, Booking, Page, BookingStatus, BookOutcome, BookResult }

// ── Counting kernel ───────────────────────────────────────────

// Does booking `b` hold slot `idx`? — TOTAL: a hold is a confirmed booking for
// that exact index. (Quorum's freeAt analog.)
export function holds(b: Booking, idx: number): boolean {
  //@ verify
  return b.status === "confirmed" && b.slotIdx === idx
}

// The number of confirmed bookings against slot `idx`. Precondition-free
// recursive count; the spec-level count and the engine that produces it are the
// same function. (Quorum's countFree, re-pointed at bookings.)
export function confirmedCount(bs: Booking[], idx: number): number {
  //@ verify
  //@ decreases bs.length
  //@ ensures 0 <= \result && \result <= bs.length
  if (bs.length === 0) return 0
  const rest = confirmedCount(bs.slice(1), idx)
  return (holds(bs[0], idx) ? 1 : 0) + rest
}

// Capacity of slot `idx`, or 0 if out of range (TOTAL).
export function capacityAt(slots: Slot[], idx: number): number {
  //@ verify
  //@ ensures (0 <= idx && idx < slots.length) ==> \result === slots[idx].capacity
  //@ ensures !(0 <= idx && idx < slots.length) ==> \result === 0
  if (idx < 0) return 0
  if (idx >= slots.length) return 0
  return slots[idx].capacity
}

// Room at slot `idx` iff it's in range and its confirmed count is below capacity.
export function hasRoom(p: Page, idx: number): boolean {
  //@ verify
  //@ ensures \result === (0 <= idx && idx < p.slots.length && confirmedCount(p.bookings, idx) < capacityAt(p.slots, idx))
  if (idx < 0) return false
  if (idx >= p.slots.length) return false
  return confirmedCount(p.bookings, idx) < capacityAt(p.slots, idx)
}

// Does `key` already hold a confirmed booking for slot `idx`? — the
// per-(slot, booker) idempotency check. False for a booker who holds only OTHER
// slots, so multi-slot booking is unrestricted by design.
export function keyHolds(bs: Booking[], idx: number, key: string): boolean {
  //@ verify
  //@ decreases bs.length
  if (bs.length === 0) return false
  if (bs[0].status === "confirmed" && bs[0].slotIdx === idx && bs[0].key === key) return true
  return keyHolds(bs.slice(1), idx, key)
}

// ── The no-overbooking invariant (Family A) ───────────────────

// withinCapacity over the first `k` slots: every slot j in [0, k) is within
// capacity. Recurses on `k` (not by slicing slots) so booking-referenced slot
// indices stay absolute. The reflection lemma (from `ensures`) hands a caller
// the quantified per-slot bound. (Quorum's allAvailLen pattern.)
export function withinCapacityUpto(slots: Slot[], bs: Booking[], k: number): boolean {
  //@ verify
  //@ requires 0 <= k && k <= slots.length
  //@ decreases k
  //@ ensures \result === true ==> forall(j, 0 <= j && j < k ==> confirmedCount(bs, j) <= slots[j].capacity)
  if (k === 0) return true
  if (confirmedCount(bs, k - 1) > slots[k - 1].capacity) return false
  return withinCapacityUpto(slots, bs, k - 1)
}

// Completeness of the reflection: the quantified bound rebuilds the predicate.
// (Pure-carrier lemma; induction in the companion .dfy.)
export function withinCapacityUptoComplete(slots: Slot[], bs: Booking[], k: number): boolean {
  //@ verify
  //@ requires 0 <= k && k <= slots.length
  //@ requires forall(j, 0 <= j && j < k ==> confirmedCount(bs, j) <= slots[j].capacity)
  //@ decreases k
  //@ ensures withinCapacityUpto(slots, bs, k) === true
  return true
}

// A1: no slot is oversold.
export function withinCapacity(slots: Slot[], bs: Booking[]): boolean {
  //@ verify
  return withinCapacityUpto(slots, bs, slots.length)
}

export function wellFormed(p: Page): boolean {
  //@ verify
  return withinCapacity(p.slots, p.bookings) && allInRange(p.bookings, p.slots.length)
}

// ── The booking decision (Family B) ───────────────────────────

// Appending a booking bumps exactly its own slot's count by one (if it's a
// confirmed hold there) and leaves every other slot's count fixed — the snoc
// homomorphism the safety proof rests on. (Quorum's countFreeConcat analog.)
export function confirmedCountSnoc(bs: Booking[], b: Booking, idx: number): boolean {
  //@ verify
  //@ ensures confirmedCount(bs.concat([b]), idx) === confirmedCount(bs, idx) + (holds(b, idx) ? 1 : 0)
  return true
}

// Appending a confirmed booking for an in-range slot that still has room keeps
// withinCapacityUpto: the booked slot rises by one (and was strictly under
// capacity), every other slot is unchanged. (Pure-carrier; induction in .dfy.)
export function withinCapacityUptoAppend(slots: Slot[], bs: Booking[], b: Booking, k: number): boolean {
  //@ verify
  //@ requires 0 <= k && k <= slots.length
  //@ requires withinCapacityUpto(slots, bs, k) === true
  //@ requires (0 <= b.slotIdx && b.slotIdx < slots.length) ==> confirmedCount(bs, b.slotIdx) < slots[b.slotIdx].capacity
  //@ decreases k
  //@ ensures withinCapacityUpto(slots, bs.concat([b]), k) === true
  return true
}

// The headline transition. A three-way verdict so the shell can tell a happy
// retry from a real "sold out":
//   • "confirmed" — a NEW seat was appended (room, and not already held).
//   • "duplicate" — this booker already holds this slot; idempotent success,
//                   page unchanged (a double-click / reconnect lands here).
//   • "full"      — no room (or no such slot); page unchanged.
// Only "confirmed" mutates. A booker holding OTHER slots never affects this.
export function tryBook(p: Page, idx: number, bookingId: string, key: string, seq: number): BookResult {
  //@ verify
  //@ ensures \result.page.slots === p.slots
  //@ ensures (\result.outcome === "duplicate") === keyHolds(p.bookings, idx, key)
  //@ ensures (\result.outcome === "confirmed") === (!keyHolds(p.bookings, idx, key) && hasRoom(p, idx))
  //@ ensures (\result.outcome === "confirmed") || (\result.page === p)
  if (keyHolds(p.bookings, idx, key)) return { outcome: "duplicate", page: p }
  if (!hasRoom(p, idx)) return { outcome: "full", page: p }
  const b: Booking = { id: bookingId, slotIdx: idx, key: key, status: "confirmed", seq: seq }
  return { outcome: "confirmed", page: { ...p, bookings: [...p.bookings, b] } }
}

// Capacity safety: a booking attempt NEVER oversells — for any outcome the
// resulting page is still well-formed.
export function tryBookPreservesInv(p: Page, idx: number, bookingId: string, key: string, seq: number): boolean {
  //@ verify
  //@ requires wellFormed(p)
  //@ ensures wellFormed(tryBook(p, idx, bookingId, key, seq).page)
  return true
}

// ── Conservation & cancellation (Stage 0b / Family C) ─────────

// Cancel the booking whose id === bookingId: flip its status to "cancelled".
// The log is append-only — we never remove a row, only flip its status — so the
// length is unchanged (and replay/audit stays faithful).
export function cancelById(bs: Booking[], bookingId: string): Booking[] {
  //@ verify
  //@ decreases bs.length
  //@ ensures \result.length === bs.length
  if (bs.length === 0) return []
  if (bs[0].id === bookingId) return [{ ...bs[0], status: "cancelled" }, ...bs.slice(1)]
  return [bs[0], ...cancelById(bs.slice(1), bookingId)]
}

// C: cancelling never RAISES a slot's count — it frees a seat or leaves it
// untouched (reverse monotonicity). Proof by induction on bs. (Pure-carrier.)
export function cancelMonotone(bs: Booking[], bookingId: string, idx: number): boolean {
  //@ verify
  //@ decreases bs.length
  //@ ensures confirmedCount(cancelById(bs, bookingId), idx) <= confirmedCount(bs, idx)
  return true
}

// A cancellation preserves the no-overbooking invariant: every count only goes
// down, so each stays within capacity. (Reverse-monotone ⇒ trivially safe.)
export function cancel(p: Page, bookingId: string): Page {
  //@ verify
  //@ requires wellFormed(p)
  //@ ensures wellFormed(\result)
  //@ ensures \result.slots === p.slots
  return { ...p, bookings: cancelById(p.bookings, bookingId) }
}

// Conservation: remaining seats + confirmed bookings === capacity, and on a
// well-formed page (where no slot is oversold) the remainder is never negative.
export function remaining(p: Page, idx: number): number {
  //@ verify
  //@ requires wellFormed(p)
  //@ requires 0 <= idx && idx < p.slots.length
  //@ ensures \result + confirmedCount(p.bookings, idx) === capacityAt(p.slots, idx)
  //@ ensures \result >= 0
  return capacityAt(p.slots, idx) - confirmedCount(p.bookings, idx)
}

// ── Booking-index well-formedness (A3) ────────────────────────
//
// A3: every booking targets a real slot. Folded into `wellFormed` so the mutations
// can rely on "no phantom bookings" — in particular so a freshly added slot starts
// genuinely empty. The reflection lemma hands a caller the quantified fact.

export function allInRange(bs: Booking[], n: number): boolean {
  //@ verify
  //@ decreases bs.length
  //@ ensures \result === true ==> forall(i, 0 <= i && i < bs.length ==> 0 <= bs[i].slotIdx && bs[i].slotIdx < n)
  if (bs.length === 0) return true
  if (bs[0].slotIdx < 0) return false
  if (bs[0].slotIdx >= n) return false
  return allInRange(bs.slice(1), n)
}

// Appending an in-range booking preserves A3.
export function allInRangeSnoc(bs: Booking[], b: Booking, n: number): boolean {
  //@ verify
  //@ requires allInRange(bs, n)
  //@ requires 0 <= b.slotIdx && b.slotIdx < n
  //@ decreases bs.length
  //@ ensures allInRange(bs.concat([b]), n)
  return true
}

// Cancelling flips a status, never a slotIdx, so A3 survives a cancellation.
export function allInRangeCancel(bs: Booking[], bookingId: string, n: number): boolean {
  //@ verify
  //@ requires allInRange(bs, n)
  //@ decreases bs.length
  //@ ensures allInRange(cancelById(bs, bookingId), n)
  return true
}

// A3 widens: in range for n stays in range for any m >= n (used when a slot is added).
export function allInRangeWiden(bs: Booking[], n: number, m: number): boolean {
  //@ verify
  //@ requires allInRange(bs, n)
  //@ requires n <= m
  //@ decreases bs.length
  //@ ensures allInRange(bs, m)
  return true
}

// If every booking targets [0, n), nothing holds an index >= n, so its count is 0.
// (A freshly added slot at index n starts genuinely empty.)
export function countZeroAtUnbooked(bs: Booking[], n: number, idx: number): boolean {
  //@ verify
  //@ requires allInRange(bs, n)
  //@ requires idx >= n
  //@ decreases bs.length
  //@ ensures confirmedCount(bs, idx) === 0
  return true
}

// ── Provider mutations (Stage 1 / Family G) ───────────────────
//
// Slots are append-only: a provider creates a page, appends slots, raises/lowers
// capacity (never below what's booked), and "closes" a slot by capping it to its
// current count. Every mutation preserves the no-overbooking invariant.

// A fresh page: given slots (capacities >= 0) and no bookings — well-formed
// vacuously (every count is 0; no booking out of range).
export function initPage(id: string, title: string, slots: Slot[]): Page {
  //@ verify
  //@ requires forall(j, 0 <= j && j < slots.length ==> slots[j].capacity >= 0)
  //@ ensures wellFormed(\result)
  //@ ensures \result.slots === slots
  return { id: id, title: title, slots: slots, bookings: [] }
}

// Append a new slot (capacity >= 0). It starts empty — no booking referenced the
// new index (A3) — so it's within capacity and the page stays well-formed.
export function addSlot(p: Page, label: string, newCap: number): Page {
  //@ verify
  //@ requires wellFormed(p)
  //@ requires newCap >= 0
  //@ ensures wellFormed(\result)
  return { ...p, slots: [...p.slots, { label: label, capacity: newCap }] }
}

// Replace the capacity of slot `idx`, leaving every other slot untouched.
export function setCapAt(slots: Slot[], idx: number, newCap: number): Slot[] {
  //@ verify
  //@ decreases slots.length
  //@ ensures \result.length === slots.length
  //@ ensures forall(j, 0 <= j && j < slots.length && j !== idx ==> \result[j] === slots[j])
  //@ ensures (0 <= idx && idx < slots.length) ==> \result[idx].capacity === newCap
  if (slots.length === 0) return []
  if (idx === 0) return [{ ...slots[0], capacity: newCap }, ...slots.slice(1)]
  return [slots[0], ...setCapAt(slots.slice(1), idx - 1, newCap)]
}

// Set a slot's capacity. Lowering is allowed ONLY down to what's already booked,
// so a page can never be made retroactively oversold.
export function setCapacity(p: Page, idx: number, newCap: number): Page {
  //@ verify
  //@ requires wellFormed(p)
  //@ requires 0 <= idx && idx < p.slots.length
  //@ requires newCap >= confirmedCount(p.bookings, idx)
  //@ ensures wellFormed(\result)
  //@ ensures \result.slots.length === p.slots.length
  return { ...p, slots: setCapAt(p.slots, idx, newCap) }
}

// Close a slot to new bookings: cap it at its current confirmed count. The
// precondition of setCapacity holds trivially (count >= count), so it's safe.
export function closeSlot(p: Page, idx: number): Page {
  //@ verify
  //@ requires wellFormed(p)
  //@ requires 0 <= idx && idx < p.slots.length
  //@ ensures wellFormed(\result)
  return setCapacity(p, idx, confirmedCount(p.bookings, idx))
}

// ── Op model & replay (Stage 2 / Family D) ────────────────────
//
// The Durable Object applies a totally-ordered log of ops — each a booking
// attempt or a cancellation. Unlike Quorum, the order is *load-bearing*: under
// contention, which attempts win depends on it (that's why a single serializer
// is NECESSARY). But every reachable state is still well-formed, and the count
// of a FIXED set of bookings is order-independent (the homomorphism below) — the
// algebraic boundary that pins exactly where order does and doesn't matter.

type Op =
  | { kind: "book"; idx: number; bookingId: string; key: string; seq: number }
  | { kind: "cancel"; bookingId: string }

// applyOp is TOTAL — tryBook and cancelById are both safe for any args on a
// well-formed page (a bad idx just yields "full"; an unknown id is a no-op), so
// it composes inside replay with no precondition. It never touches the slots.
export function applyOp(p: Page, op: Op): Page {
  //@ verify
  //@ ensures \result.slots === p.slots
  if (op.kind === "book") return tryBook(p, op.idx, op.bookingId, op.key, op.seq).page
  return { ...p, bookings: cancelById(p.bookings, op.bookingId) }
}

// Every op preserves the invariant (book by capacity safety, cancel by reverse
// monotonicity), so no op log can ever produce an oversold page.
export function applyOpPreservesInv(p: Page, op: Op): boolean {
  //@ verify
  //@ requires wellFormed(p)
  //@ ensures wellFormed(applyOp(p, op))
  return true
}

// replay folds a totally-ordered op log over an initial page.
export function replay(p: Page, ops: Op[]): Page {
  //@ verify
  //@ decreases ops.length
  if (ops.length === 0) return p
  return replay(applyOp(p, ops[0]), ops.slice(1))
}

// Replay determinism is structural (a fold is a function); this is the safety
// half: every reachable state from a well-formed page stays well-formed — so the
// DO's stored state, and any re-export's replay, are always within capacity.
export function replayPreservesInv(p: Page, ops: Op[]): boolean {
  //@ verify
  //@ requires wellFormed(p)
  //@ decreases ops.length
  //@ ensures wellFormed(replay(p, ops))
  return true
}

// HOMOMORPHISM: the count of a fixed booking set is independent of how it's
// split — counting two batches and adding equals counting the concatenation.
// This factors the per-slot count through the commutative monoid (ℤ, +); it is
// the formal sense in which a *fixed set* of confirmed bookings is order-free.
export function confirmedCountConcat(xs: Booking[], ys: Booking[], idx: number): boolean {
  //@ verify
  //@ ensures confirmedCount(xs.concat(ys), idx) === confirmedCount(xs, idx) + confirmedCount(ys, idx)
  return true
}

// Batch commutativity — a corollary of the homomorphism plus commutativity of
// (+). Two batches of confirmed bookings yield the same per-slot count in either
// order. (NB: this is about the COUNT of a fixed set; which attempts get accepted
// under contention is still order-sensitive — that's Stage 2b.)
export function confirmedCountComm(xs: Booking[], ys: Booking[], idx: number): boolean {
  //@ verify
  //@ ensures confirmedCount(xs.concat(ys), idx) === confirmedCount(ys.concat(xs), idx)
  return true
}

// ── Queries (Stage 3 / Family F) ──────────────────────────────
//
// The "trustworthy" answers the booking pages and provider console render. Each
// is characterized exactly against the verified count, so a tooltip or badge can
// never disagree with the number that drives the booking decision.

// The confirmed bookings holding slot `idx`, by construction the holds-filter of
// the log. Its length provably equals the count, so the provider's "3 booked: …"
// list can never disagree with the cell's number.
export function confirmedBookers(bs: Booking[], idx: number): Booking[] {
  //@ verify
  //@ decreases bs.length
  //@ ensures \result.length === confirmedCount(bs, idx)
  if (bs.length === 0) return []
  const rest = confirmedBookers(bs.slice(1), idx)
  return holds(bs[0], idx) ? [bs[0], ...rest] : rest
}

export function bookersOf(p: Page, idx: number): Booking[] {
  //@ verify
  //@ ensures \result.length === confirmedCount(p.bookings, idx)
  return confirmedBookers(p.bookings, idx)
}

// Per-slot availability mask, characterized exactly: entry j is `hasRoom(p, j)`.
export function availableUpto(p: Page, k: number): boolean[] {
  //@ verify
  //@ requires 0 <= k && k <= p.slots.length
  //@ decreases k
  //@ ensures \result.length === k
  //@ ensures forall(j, 0 <= j && j < k ==> \result[j] === hasRoom(p, j))
  if (k === 0) return []
  const prev = availableUpto(p, k - 1)
  return [...prev, hasRoom(p, k - 1)]
}

export function availableSlots(p: Page): boolean[] {
  //@ verify
  //@ ensures \result.length === p.slots.length
  //@ ensures forall(j, 0 <= j && j < p.slots.length ==> \result[j] === hasRoom(p, j))
  return availableUpto(p, p.slots.length)
}

// "Is the whole page sold out?" — true iff no slot has room.
export function noneAvailUpto(p: Page, k: number): boolean {
  //@ verify
  //@ requires 0 <= k && k <= p.slots.length
  //@ decreases k
  //@ ensures \result === forall(j, 0 <= j && j < k ==> !hasRoom(p, j))
  if (k === 0) return true
  if (hasRoom(p, k - 1)) return false
  return noneAvailUpto(p, k - 1)
}

export function soldOut(p: Page): boolean {
  //@ verify
  //@ ensures \result === forall(j, 0 <= j && j < p.slots.length ==> !hasRoom(p, j))
  return noneAvailUpto(p, p.slots.length)
}

// ── Export faithfulness (Stage 3b / Family E) ─────────────────
//
// The export carries only the CONFIRMED bookings (cancelled ones are noise for
// availability). The proofs show this loses nothing a query depends on: every
// slot's count — and hence availableSlots/soldOut — is identical over the export
// and the live page. So "query over the export === the answer the booker saw".

// Keep only confirmed bookings.
export function confirmedOnly(bs: Booking[]): Booking[] {
  //@ verify
  //@ decreases bs.length
  if (bs.length === 0) return []
  if (bs[0].status === "confirmed") return [bs[0], ...confirmedOnly(bs.slice(1))]
  return confirmedOnly(bs.slice(1))
}

// E1: dropping cancelled bookings never changes a slot's confirmed count.
export function confirmedOnlyPreservesCount(bs: Booking[], idx: number): boolean {
  //@ verify
  //@ decreases bs.length
  //@ ensures confirmedCount(confirmedOnly(bs), idx) === confirmedCount(bs, idx)
  return true
}

// The exported page: same slots, confirmed bookings only.
export function exportPage(p: Page): Page {
  //@ verify
  //@ ensures \result.slots === p.slots
  return { ...p, bookings: confirmedOnly(p.bookings) }
}

// E2: availability is identical over the export and the live page (query-over-
// export soundness — the round-trip preserves every observable answer).
export function availableSlotsOverExport(p: Page): boolean {
  //@ verify
  //@ ensures availableSlots(exportPage(p)).length === p.slots.length
  //@ ensures availableSlots(p).length === p.slots.length
  //@ ensures forall(j, 0 <= j && j < p.slots.length ==> availableSlots(exportPage(p))[j] === availableSlots(p)[j])
  return true
}

// ── Order boundary (Stage 2b / Family D headline) ─────────────
//
// The precise formal sense of "Quota is Quorum inverted": the AGGREGATE
// (per-slot count → availability/soldOut) is order-invariant under booking
// attempts EVEN UNDER CONTENTION, while WHICH booker wins is not. So safety and
// availability need no serialization (any order yields the same counts); only
// *fairness* (who gets the last seat) needs the DO's total order.

// keyHolds under append (companion to confirmedCountSnoc): appending b adds
// exactly the (slot, key) it confirms to the "already holds" set.
export function keyHoldsSnoc(bs: Booking[], b: Booking, idx: number, key: string): boolean {
  //@ verify
  //@ decreases bs.length
  //@ ensures keyHolds(bs.concat([b]), idx, key) === (keyHolds(bs, idx, key) || (b.status === "confirmed" && b.slotIdx === idx && b.key === key))
  return true
}

// The count-delta of a single booking attempt at slot s: +1 exactly when the
// attempt is accepted (not a duplicate, has room) AND targets s; else +0.
export function bookDelta(p: Page, idx: number, bookingId: string, key: string, seq: number, s: number): boolean {
  //@ verify
  //@ ensures confirmedCount(tryBook(p, idx, bookingId, key, seq).page.bookings, s) === confirmedCount(p.bookings, s) + ((!keyHolds(p.bookings, idx, key) && hasRoom(p, idx) && idx === s) ? 1 : 0)
  return true
}

// keyHolds after a booking attempt: the (s, key) set gains (idx, key) iff the
// attempt was accepted there.
export function keyHoldsAfterBook(p: Page, idx: number, bookingId: string, key: string, seq: number, s: number, k: string): boolean {
  //@ verify
  //@ ensures keyHolds(tryBook(p, idx, bookingId, key, seq).page.bookings, s, k) === (keyHolds(p.bookings, s, k) || (!keyHolds(p.bookings, idx, key) && hasRoom(p, idx) && idx === s && key === k))
  return true
}

// THE THEOREM: two booking attempts, applied in either order, leave every slot's
// confirmed count identical — even when they contend for the same slot (the
// loser is rejected either way, so the count saturates the same). This is what
// makes availability/soldOut order-independent (so safety needs no locking),
// while the identity of who got in is the only order-sensitive part.
export function bookCountOrderInvariant(
  p: Page,
  i1: number, id1: string, k1: string, q1: number,
  i2: number, id2: string, k2: string, q2: number,
  s: number,
): boolean {
  //@ verify
  //@ ensures confirmedCount(tryBook(tryBook(p, i1, id1, k1, q1).page, i2, id2, k2, q2).page.bookings, s) === confirmedCount(tryBook(tryBook(p, i2, id2, k2, q2).page, i1, id1, k1, q1).page.bookings, s)
  return true
}

// ── Convergence (Family D-perm): full permutation invariance of the count ──
//
// confirmedCountConcat gives order-independence for two *batches*; `perm(...)`
// lifts it to ANY reordering of the booking log. This is the complete
// element-level statement of "a fixed set of confirmed bookings is order-free"
// that was previously inexpressible — `//@` specs could not name a multiset, so
// the concat-homomorphism was the strongest substitute. bookCountOrderInvariant
// above is the pairwise case; this is its N-attempt closure (any permutation is
// a sequence of adjacent swaps, each count-preserving). (Proof in the companion
// .dfy: a remove-one-element induction reusing confirmedCountConcat.)
export function confirmedCountPerm(xs: Booking[], ys: Booking[], idx: number): boolean {
  //@ verify
  //@ requires perm(xs, ys)
  //@ ensures confirmedCount(xs, idx) === confirmedCount(ys, idx)
  return true
}

// Lifted to the observable that the product acts on: availability. Two pages
// with the same slots whose booking logs are permutations of each other agree
// on hasRoom at every slot — reordering how the log accumulated never changes
// what is available. (Only *which* contender won is order-sensitive; that is
// what the serializer pins, and it is the reason it is needed for fairness.)
export function hasRoomPermInvariant(a: Page, b: Page, idx: number): boolean {
  //@ verify
  //@ requires a.slots === b.slots
  //@ requires perm(a.bookings, b.bookings)
  //@ ensures hasRoom(a, idx) === hasRoom(b, idx)
  return true
}