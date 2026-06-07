# Refill — Technical Report

**Track:** fonio.ai · **START Hack Vienna '26**
**One line:** Turn every cancellation into a booking — detect the freed slot, call the right waitlisted patient, close it on the phone.

---

## 1. The angle we chose

The brief offered three example directions (Intelligent Dispatcher, Conversational Closer, Operator's Cockpit). We built primarily the **Intelligent Dispatcher**, with a working cockpit and a real call on top — because the hardest, most defensible problem isn't placing a call, it's **choosing who to call**.

Our framing: *the empty chair is perishable inventory*. We don't optimize for revenue (calling the most lucrative patient over the one in pain is the wrong thing in healthcare and reads badly to a jury). We optimize for **patient benefit** — `urgency × likelihood-to-attend × fit` — and we can explain every decision.

Context: a private dental / implantology practice in Vienna serving international patients, so an English-speaking assistant is in character.

## 2. Architecture

```
Cancellation (dashboard | patient page | fonio inbound)
        │
        ▼
   Orchestrator ──► Scoring engine ranks eligible waitlist (with reasons)
        │                     │
        │              picks top candidate
        ▼                     ▼
  RecoveryAttempt ───► fonio Outbound Call API  (name, slot, doctor as context)
        ▲                     │
        │            fonio places the real call
        │                     ▼
  Outcome webhook ◄──── fonio Variable Extraction posts the structured result
        │
  yes → book + stop · no/no-answer/voicemail → next candidate
  reschedule/cancel/opt-out/wrong-person/human → handle + advance
        │
        ▼
  Append-only event log ──► live dashboard (1.5s poll)
```

- **Next.js (App Router, TypeScript)** — dashboard + API routes (the fonio webhooks) in one deployable app.
- **Prisma + PostgreSQL** — reachable by fonio's cloud once deployed.
- **One unified entry point** (`cancelSlot`) for every cancellation source, so the loop behaves identically however a slot frees.

## 3. The scoring engine (`src/lib/scoring.ts`)

Two stages:

1. **Hard filters** (a candidate is excluded outright):
   - No outbound consent → never scored (GDPR hard gate).
   - Procedure longer than the slot duration.
   - Joined the waitlist after the slot's date.
   - Assigned to a different doctor.

2. **Pool-normalised soft score** over the eligible set:
   `urgency·0.35 + timeMatch·0.20 + daysWaiting·0.20 − attempts·0.10 − reachabilityPenalty·0.10 − fairness·0.05`.

Design choices:
- **Procedure cost is deliberately excluded from the score** — revenue is a displayed KPI, never an objective.
- **Every factor degrades gracefully** — missing enrichment contributes a neutral value instead of crashing, which is how we absorb not knowing a real PMS's exact fields.
- **Likelihood-to-attend is an honest heuristic prior**, not a fake "learned" rate: `0.35 + 0.45·timeMatch + 0.20·(1−reachabilityPenalty) − 0.15·attempts`.
- **Fairness** down-weights recently-skipped patients so we don't always ring the same person first.
- Each candidate gets a written, counterfactual-style rationale ("Strong: urgent need, time fits. Caveats: hard to reach.").

## 4. State machine & idempotency (`src/lib/orchestrator.ts`)

Per `RecoveryAttempt`: `queued → calling → {yes | no | maybe | reschedule | cancel | optout | voicemail | no_answer | wrong_person | failed | human_requested}`.

- **yes** books the slot and stops the loop. **no/voicemail/no_answer** advance. **maybe** gets one guarded callback. **reschedule** keeps the patient engaged and advances. **cancel/optout** remove from the waitlist. **wrong_person/failed** log and advance. **human_requested** ends the AI call and surfaces the conversation summary to reception.
- **Idempotent transitions**: an attempt with `resolvedAt` set is never reprocessed; `@@unique(slotId, patientId)` + an idempotency key prevent double-dialling the same person; a `P2002` race is caught and ignored.
- **Call cap per slot** protects the credit budget if a trigger keeps failing.
- **Expired-slot sweep** marks past-due unfilled slots as `lost` and logs the revenue.
- **Escalation** uses a distinct terminal status so the UI shows "needs human" rather than looking like it's filling forever.

## 5. fonio integration (`src/lib/fonio.ts`, `src/app/api/fonio/*`)

- **Outbound trigger**: `POST /api/public/v1/outbound_call` with E.164 normalisation, a 15s timeout, and a fail-safe that advances the loop if the call never connects.
- **Structured outcome**: fonio's **Variable Extraction** fills a JSON schema (accepted / reschedule_requested / cancel_requested / opt_out / wrong_person / human_requested …). No transcript parsing on the happy path.
- **Post-call webhook** (`/api/fonio/outcome`): a defensive parser searches the whole nested payload by key and accepts booleans, numbers, or strings, since fonio's payload shape varies. The raw payload is persisted for auditing.
- **Pre-loaded call context**: each call carries the patient, the slot, and `reschedule_options` — the times the patient could move to, pre-filtered to slots that are open *and* long enough for their procedure. This lets the assistant answer "what other times are available?" with no mid-call lookup.
- **Auth**: every fonio endpoint is gated by a shared secret (`Authorization: Bearer`, `x-fonio-secret`, or `?secret=`).

## 6. Consent & privacy (GDPR)

- Consent is a **hard filter** in scoring — a patient without `consentOutbound` is never called.
- The patient self-service page exposes a consent toggle ("Want to be seen sooner?").
- During a call, opt-out is captured and applied by our backend; fonio has **read-only** access to the DB (the read endpoints never write), so all writes are controlled and auditable through the webhook.

## 7. What's real vs. mocked

| Real | Mocked / simulated |
|---|---|
| Outbound call via fonio (`FONIO_LIVE=true`) | The 80-patient waitlist dataset (synthetic) |
| The full loop, scoring, state machine, persistence | Phone numbers in the seed (placeholders) |
| Postgres persistence + audit log | No real PMS / EHR / calendar integration (by design — out of scope) |
| Consent gate, idempotency, error handling | `FONIO_LIVE=false` simulates the call in-process |

We deliberately do **not** use fonio's native calendar scheduler (its event metadata isn't exposed back to us); we book into our own database so we own all the metadata.

## 8. If we had more time

- Manual override controls in the dashboard (force-call a specific candidate).
- A simulation harness to A/B the patient-benefit policy vs. naive "call-first" over 100+ synthetic cancellations (framed honestly as policy behaviour, not proof of uplift).
- A confirmation SMS on "yes" via fonio's native Send SMS.
