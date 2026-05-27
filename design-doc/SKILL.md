---
name: design-doc
description: Create a DESIGN.md for a LemmaScript-verified app. Use when starting a new verified app, translating requirements into a formal design, or when the user asks for a design document.
---

# DESIGN.md for LemmaScript Apps

A DESIGN.md is the single source of truth for a verified app's architecture. It
drives the domain.ts implementation. The agent writes the first draft from the
user's description; the user reviews and iterates.

## Structure

The document follows this exact section order:

### 1. The product
One paragraph: what the app does, who it's for, how it works. Plain language.

### 2. The promise — what is verified, and why
Numbered list of concrete guarantees the verified core provides. Then an explicit
trust boundary: what is NOT verified (UI, I/O, auth, timezone labeling, etc.).
Be precise about both sides. Never claim "verified end-to-end."

### 3. The key design insight
The domain-specific structural property that makes verification tractable. This
is the conceptual spine. Examples:
- "Availability is partitioned by participant — no edit conflicts"
- "Bookings contend for shared limited inventory — serialization is necessary"

This insight shapes the architecture, the proof strategy, and the concurrency model.

### 4. Data model
TypeScript interfaces with `//@ backend dafny`. The verified core works in
abstract indices, not IDs or foreign keys. Containment, not references.

Include:
- All interfaces
- The invariant `Inv(s)` spelled out as numbered conditions (A1, A2, A3...)
- Why you chose this representation (e.g., "dense bitset makes well-formedness trivial")

### 5. Architecture
An ASCII diagram showing:
- The unverified shell (React UI, I/O, storage)
- The verified pure core (domain.ts)
- How they connect (store seam, dispatch, verified queries)
- Where the core runs (client, server, query endpoint — same import)

### 6. Properties — the staged catalog
Group properties into families:
- **Family A** — Well-formedness (the invariant)
- **Family B** — Aggregation / decision correctness (the headline promise)
- **Family C** — Monotonicity or conservation
- **Family D** — Convergence / order-independence (if applicable)
- **Family E** — Export faithfulness / codec round-trip (if applicable)
- **Family F** — Query algebra soundness (if applicable)

Each property gets a LemmaScript spec sketch:
```ts
//@ ensures forall(s, 0 <= s && s < e.numSlots ==> \result[s] === countFree(e.participants, s))
function heatmap(e: Event): number[]
```

### 7. Verification approach
Conventions:
- Pure recursive functions, not imperative loops
- Total kernel (no preconditions on counting/aggregation functions)
- `ensures` are separate lemmas (LemmaScript convention)
- Relational lemmas use the pure-carrier technique (body `return true`, induction in .dfy)
- State the trust boundary inline

### 8. Roadmap (staged proofs)
A table: Stage | Lands | Families | Status. Each stage is shippable. The safety
core is trustworthy after Stage 0.

### 9. Open questions / deferred
Choices not yet made, extensions that could be verified later, known gaps.

## Rules for the agent

- Write in the voice of the reference docs: precise, technical, but readable
- The verified core uses abstract indices, not string IDs
- Containment, not references (no foreign keys)
- Every interface field must justify its presence
- The invariant must be spelled out condition by condition
- Trust boundary must be stated explicitly in §2 AND §5
- Properties must have LemmaScript spec sketches, not just prose
- Keep the counting/aggregation kernel total (precondition-free) so it composes
- Design for pure recursive functions (loops can't take proof hints in LemmaScript)
- Name prior art / influences if building on existing patterns

## Reference

See DESIGN_QUORUM.md and DESIGN_QUOTA.md in this folder for complete examples of this format applied to real apps.
