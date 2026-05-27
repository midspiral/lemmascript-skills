# Quorum Domain Proof Review

Reviewed `src/domain.ts`, `src/domain.dfy`, `src/domain.dfy.gen`, and `DESIGN_QUORUM.md`.

Verification status checked locally:

```sh
dafny verify quorum/src/domain.dfy
```

Result: `90 verified, 0 errors`.

## Executive Summary

The Dafny proofs do capture the strongest current domain-core requirements around:

- total per-slot availability lookup,
- exact heatmap counting,
- exact argmax-style best-slot mask,
- threshold masks,
- invariant preservation for the implemented mutations/op replay,
- participant-order independence of the heatmap,
- same-participant LWW commutativity for distinct timestamps,
- dense/sparse availability round-trip,
- and `whoIsFree` count consistency.

Those are real, mechanically checked guarantees, not just comments.

However, the proofs do **not** yet support the full product promise as written in the design doc. In particular:

- `wellFormed` omits participant-id uniqueness (A2).
- The export proof is only the boolean-array sparse-codec round-trip, not event-level NDJSON export/decode/query soundness.
- Query soundness is limited to `whoIsFree` length matching the heatmap; it does not yet prove membership-exact query results, `participantsAt`, or `overlap`.
- “More availability only helps” is only proved for adding a participant, not for changing an existing participant from fewer free slots to more free slots.
- The heatmap is proved independent of participant-list order, but not of arbitrary op-log order involving joins and paints.
- LWW convergence is proved for two writes to the same `pid` with distinct timestamps, but because the model does not require unique participant ids, that guarantee applies to the behavior of `setAvailLWW` over a list, not to a unique real-world participant row unless uniqueness is trusted externally.

## What Is Safely Guaranteed

### A. Availability Lookup And Counting

`freeAt` is total: out-of-range slots return `false`; in-range slots return the participant's availability bit. This supports the design choice that aggregation can run without requiring full event well-formedness.

`countFree` is bounded:

- `0 <= countFree(ps, s)`
- `countFree(ps, s) <= ps.length`

This means every count is non-negative and cannot exceed the number of rows counted.

Relevant contracts:

- `domain.ts`: `freeAt`, `countFree`
- `domain.dfy`: `freeAt_ensures`, `countFree_ensures`

### B. Well-Formedness, As Actually Implemented

The proved invariant is:

```ts
wellFormed(e) === e.numSlots >= 0 && allAvailLen(e.participants, e.numSlots)
```

That gives:

- non-negative slot count,
- every participant availability array has exactly `numSlots` entries.

The reflection/completeness lemmas for `allAvailLen` are proved, so callers can move between the recursive predicate and the quantified per-participant length fact.

Important limitation: despite `DESIGN_QUORUM.md` listing A2 as participant-id uniqueness, A2 is explicitly not part of `wellFormed` in `domain.ts`. The design doc also acknowledges this, but some later architectural language leans on “each participant owns exactly their own row.” That ownership/uniqueness is not currently a domain proof guarantee.

### C. Heatmap Correctness

For any event with `e.numSlots >= 0`, `heatmap(e)` is proved to:

- have length `e.numSlots`,
- equal `countFree(e.participants, s)` at every in-range slot,
- have every count between `0` and `e.participants.length`.

This supports the design promise that “the heatmap is the count,” with the precise interpretation that the counted population is the event's participant row list, including duplicate ids if present.

### D. Best-Time Recommendation

For any event with `e.numSlots >= 0`, `isBest(e)` is proved to:

- have length `e.numSlots`,
- mark slot `s` exactly when `heatmap(e)[s] === maxCount(heatmap(e)) && maxCount(heatmap(e)) > 0`.

`maxCount` is proved to be an upper bound on every element and, for non-empty arrays, to be attained by some element.

This safely supports:

- best slots are exactly heatmap argmax slots,
- ties are represented,
- no best slot is marked when the maximum count is `0`.

### E. Threshold Query

`availableAtLeast(e, k)` is proved to:

- have length `e.numSlots`,
- mark exactly those slots whose heatmap count is at least `k`.

The contract allows any integer `k`. That means unusual thresholds are also specified: for example, `k <= 0` marks every slot, because every heatmap count is non-negative.

### F. Mutation And Replay Invariant Preservation

The following preserve `wellFormed`, under their stated preconditions:

- `initEvent`
- `addParticipant`
- `setAvailability`
- `removeParticipant`

`applyOp` is total and preserves `numSlots`. `applyOpPreservesInv` and `replayPreservesInv` prove that starting from a well-formed event, applying or replaying any op log leaves the event well-formed.

Important limitation: because `wellFormed` does not include id uniqueness, `join` can add duplicate participant ids while still preserving the proved invariant.

### G. Monotonicity

The proved monotonicity facts are:

- Adding a well-formed participant row cannot lower any heatmap count.
- If every participant is free at an in-range slot and there is at least one participant, that slot is marked best.

This is narrower than the design statement “adding a participant or marking more slots never lowers any slot's count.” The current proofs do not define or prove a relation like `avail1 <= avail2` for an existing participant update, so paint/update monotonicity is not currently established.

### H. Participant-Order Independence

The convergence proofs are strong for participant-list order:

- `countFree(xs.concat(ys), s) === countFree(xs, s) + countFree(ys, s)`
- `countFree(xs.concat(ys), s) === countFree(ys.concat(xs), s)`
- heatmaps match for two-batch reorderings,
- heatmaps match for any permutation of the participant list.

This safely supports: the heatmap depends on the multiset of participant rows, not their order.

It does not, by itself, prove arbitrary op-log commutativity. For example, reordering a `join` with a later `paint` for the same id can change the final state if the paint only has an effect after the row exists.

### I. LWW Same-Participant Convergence

`setAvailLWWCommutes` proves that two LWW writes to the same `pid` commute when their timestamps are distinct.

This is a useful local convergence property, but it is not a complete multi-device convergence theorem for the whole op model. The proof does not cover equal timestamps, interaction with joins, or uniqueness of the target participant id.

### J. Sparse Codec

The codec proof establishes:

- `sparsify(a)` contains exactly the in-range true-bit indices of `a`,
- `densify(idxs, n)` returns a length-`n` boolean array whose entries are `contains(idxs, i)`,
- `densify(sparsify(a), a.length)` equals `a` pointwise.

This safely supports “availability bitsets round-trip through the sparse representation.”

It does not prove:

- sortedness of `sparsify` despite the source comment saying “sorted list,”
- uniqueness of sparse indices,
- event-level encode/decode,
- NDJSON parse/serialization correctness,
- or query-over-export soundness.

### K. `whoIsFree`

`freeParticipants(ps, s)` is proved to return a list whose length is exactly `countFree(ps, s)`.

`whoIsFree(e, s)` is proved to return a list whose length equals `heatmap(e)[s]`.

This supports the UI guarantee that a tooltip count cannot disagree with the heatmap count if both are computed from these functions.

Important limitation: the proof does not yet state membership exactness. It proves the returned list's length, not a theorem of the form “a participant is in the result iff they are in the event and free at `s`.”

## Design-Doc Claims: Supported, Partially Supported, Or Not Yet Supported

| Design claim | Current proof status |
|---|---|
| Heatmap is exactly the number of free participants per slot | Supported, with “participant” meaning row in `participants`. |
| Best recommendation is exactly the positive argmax | Supported. |
| No recommendation when nobody is available | Supported via `maxCount(heatmap(e)) > 0` guard. |
| Threshold query marks slots with at least `k` free | Supported. |
| Adding a participant never lowers counts | Supported. |
| Marking more slots never lowers counts | Not yet proved. |
| Participant order does not affect heatmap | Supported, including full permutation invariance. |
| Op arrival order does not matter | Partially supported; not proved for arbitrary `Op[]` replay permutations. |
| Same-participant LWW edits converge | Partially supported for two distinct timestamps through `setAvailLWWCommutes`. |
| Every reachable replay state is well-formed | Supported for the implemented `wellFormed` invariant. |
| Participant ids are unique | Not proved. |
| Export round-trips | Only supported for individual availability bitsets through `densify(sparsify(a)) == a`. Event/NDJSON round-trip is not proved. |
| Queries over export equal live queries | Not proved in `domain.ts`/`domain.dfy`. |
| `whoIsFree` count agrees with heatmap | Supported. |
| `whoIsFree` returns exactly the free participants | Only by inspection of implementation; not captured as a membership-exact proof contract. |
| `participantsAt` and `overlap` query algebra | Not implemented/proved. |
| Grid slot index arithmetic is verified in `src/grid.ts` | Not checkable in this workspace snapshot; no `quorum/src/grid.ts` exists here. |
| Runtime checked by `npm test` | Not supported by this workspace snapshot; `quorum/package.json` has the default failing test script. |

## Requirements Captured Well

The core mathematical requirements for the current domain functions are captured well:

- The count kernel is total and bounded.
- The heatmap is not a heuristic; it is tied directly to `countFree`.
- The best mask is not merely “some best slot”; it is exactly all positive argmax slots.
- Threshold availability is exactly a heatmap comparison.
- The row-order convergence story is formalized cleanly through homomorphism, commutativity, and permutation invariance.
- Replay preservation proves the implemented invariant is stable under the current op model.
- The sparse codec has a precise pointwise round-trip.

These are enough to safely say: for a non-negative-slot event represented in the domain model, the scheduling aggregate and recommendation computed by `domain.ts` are correct relative to the participant rows present in that event.

## Main Gaps Before Making The Full Product Promise

1. Add A2 id uniqueness to the invariant, or state clearly that duplicate participant ids are outside the domain guarantee and must be prevented by trusted shell/storage code.

2. Strengthen query proofs with membership-exact contracts, especially for `whoIsFree`/`participantsAt`, then implement and prove `overlap`.

3. Prove paint/update monotonicity if the product wants to claim “marking more slots never lowers counts.”

4. Define event-level export encode/decode and prove `decodeEvent(encodeEvent(e)) == e` under suitable preconditions.

5. Prove concrete query-over-export lemmas, for example:
   - `isBest(decodeEvent(encodeEvent(e))) == isBest(e)`
   - `availableAtLeast(decodeEvent(encodeEvent(e)), k) == availableAtLeast(e, k)`
   - membership-exact participant queries match after decode.

6. Decide what convergence means for the op model. Current participant-list permutation invariance is excellent for aggregates, but arbitrary replay-order invariance needs careful conditions around joins, paints, missing rows, duplicate ids, and timestamp ties.

7. Align the design doc with the actual workspace state for `grid.ts`, app files, and `npm test`, or add those files/tests if they live outside this snapshot.

## Safe External Wording

A precise claim that matches the proofs:

> The verified domain core proves that, for events with non-negative slot counts, `heatmap` returns exactly the per-slot count of participant rows marked free; `isBest` marks exactly the positive argmax slots of that heatmap; `availableAtLeast` marks exactly slots meeting the requested threshold; participant-row ordering does not affect the heatmap; the implemented mutations and op replay preserve the current well-formedness invariant; LWW same-row updates with distinct timestamps commute at the list-transform level; sparse availability encoding round-trips pointwise; and `whoIsFree` returns a list whose length equals the heatmap count for that slot.

What should not be claimed yet:

> End-to-end verified export/query soundness, verified unique participant identity, arbitrary op-log convergence, verified timezone/calendar labeling, verified storage/WebSocket behavior, or verified exact membership for participant query results.

