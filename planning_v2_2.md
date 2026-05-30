# Lifting App — Planning Lock (v2.2)

*Minor text patch over v2.1. Three small corrections from the v2.1 cross-LLM review (ChatGPT). No schema changes, no scope changes. Read v2.1 for the full document; this patch describes only what changed.*

---

## Patches over v2.1

### Patch 1 — `consecutiveBackwards` definition (replaces v2.1 §12 inline definition)

**v2.1 wording:** "count, starting from the most recent completed session for this `(exercise_id, set_role)` and walking backwards, the number of consecutive sessions where the suggested load did not advance."

**Problem:** circular. The "suggested load" is the engine's output, which depends on `consecutiveBackwards`. Defining the input by the output creates a feedback loop. The bigger issue: user overrides are first-class, so an override that succeeds means the user advanced even if the suggestion didn't — that should reset the counter, not increment it.

**v2.2 wording:**

> `consecutiveBackwards` counts completed sessions where the relevant set failed to clear the progression condition at the same or lower **executed** load relative to the prior completed session. Computed from executed outcomes, not prior suggestions, because user overrides are first-class.

**Practical computation (in app code):**

1. Fetch the last 5-10 completed sets matching `(exercise_id, set_role, position)`, ordered DESC by `logged_at`, filtered for `executed_load IS NOT NULL` and `sessions.ended_at IS NOT NULL`.
2. Walk forward in pairs from most recent to older. For each pair, check whether `executed_load[older] < executed_load[newer]` (advanced) or `executed_load[older] >= executed_load[newer]` (held/regressed).
3. Starting from the most recent pair, count consecutive "held/regressed" pairs. Stop counting on first "advanced" pair.
4. That count is `consecutiveBackwards`.

If fewer than 2 completed sessions exist, `consecutiveBackwards = 0`.

This is the correct anchor: training reality (executed loads), not engine bookkeeping (prior suggestions).

---

### Patch 2 — Plate calculator wording and disclaimer (replaces v2.1 §13 comment + adds note)

**v2.1 wording:** `platesPerSide: [45, 35, 25, 20, 15, 10, 5, 2.5] as const, // available pairs`

**Problem:** "available pairs" implies inventory counts, but the algorithm uses `while (remaining >= plate)` — unlimited per denomination. Wording mismatch.

**v2.2 wording:**

```typescript
platesPerSide: [45, 35, 25, 20, 15, 10, 5, 2.5] as const,
// Available denominations, not inventory counts. The algorithm assumes
// enough plates of each denomination exist (true at most commercial gyms
// and home gyms with standard plate sets).
```

**Algorithm disclaimer to add to v2.1 §13:**

> MVP uses greedy round-down. Greedy is provably optimal for canonical coin systems and works correctly for the standard plate set above. If real test cases reveal closer-but-missed combinations under non-standard plate inventories, replace with bounded subset search. Don't pre-build that.

---

### Patch 3 — MVP-A prefill safety filters (clarifies v2.1 §11 scope)

**v2.1 wording (MVP-A description):** "Pre-fill in MVP-A is dumb: if history exists for `(exercise_id, set_role, position)`, fill last `executed_load`. If not, fill `initialLoad`. No progression engine yet; user adjusts manually."

**Problem:** doesn't explicitly state that the safety filters from §11 apply to MVP-A's dumb prefill too. An LLM coding assistant might implement "last executed_load" as `SELECT executed_load FROM sets ORDER BY logged_at DESC LIMIT 1` — reintroducing the blank-row poisoning problem v2.1 specifically fixed.

**v2.2 wording:**

> Pre-fill in MVP-A is dumb (no progression engine), but the history lookup uses the **same safety filters** as MVP-B's smart prefill: `executed_load IS NOT NULL`, `executed_reps IS NOT NULL`, `sessions.ended_at IS NOT NULL`. The only thing MVP-A skips is the engine; it does NOT skip filter hygiene.

This becomes a `CLAUDE.md` project rule: **"All history lookups, dumb or smart, filter incomplete sets and unfinished sessions."**

---

## Schema changes

None. v2.2 is a text-only patch.

## Scope changes

None.

## Estimate changes

None.

---

## What this patch is for

Three text fixes that prevent specific implementation drift. Apply to the in-repo copy of v2.1, archive both, and start the runway. Implementation artifacts (seed, progression, plates, CLAUDE.md) follow this patch.
