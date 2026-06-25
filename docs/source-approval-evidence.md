# Source Approval Evidence

This ledger records authoritative evidence for Phase 0 decisions in the
[live pool status integration plan](live-pool-status-integration-plan.md). The unchecked Phase 0
items in that plan remain the canonical decision list. This file must not turn an assumption,
synthetic fixture, inferred source value, or implementation choice into approval evidence.

No Phase 0 evidence has been accepted yet. Live source observation and external outreach remain
unauthorized for routine repository work.

## Evidence Standard

Add a record only when evidence is available. Each record must contain:

- Decision: the exact unchecked plan item the evidence addresses.
- Authority: the named CA or product owner empowered to decide it.
- Requests: the number of live requests used to obtain or verify the evidence, including zero.
- Retrieved at: an ISO 8601 instant, or `not-applicable` for written guidance received without a
  live request.
- Evidence reference: a durable correspondence, document, or approved observation-log reference;
  do not commit secrets, personal data, source payloads, or production identifiers.
- Confidence: `high`, `medium`, or `low`, with a short evidence-based reason.
- Decision status: `accepted`, `deferred`, or `rejected`.
- Residual uncertainty: unresolved semantics, ownership, cadence, scope, or expiry conditions.
- Reviewer: the person who accepted the evidence and the review date.

Only an `accepted` record with an authorized reviewer may close its matching plan item. A deferred,
rejected, expired, or contradictory record leaves the plan item open. When evidence changes, append
a superseding record and identify the prior record; do not silently rewrite decision history.

## Records

There are no accepted, deferred, or rejected evidence records.
