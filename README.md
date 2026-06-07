# Refill

Recover cancelled dental appointments by calling the right waitlisted patient — automatically — for the **fonio.ai** track.

A submission for **START Hack Vienna '26**, built for the case provided by **fonio.ai**.

---

## About

When a patient cancels, a clinic loses a high-value slot and a receptionist has to phone the waitlist one by one. Refill closes that loop end to end: it detects the cancellation, ranks the waitlist by who will *benefit most and is most likely to attend*, has fonio place a real, personalized outbound call to the best candidate, handles the reply (yes / no / reschedule / cancel / no-answer / voicemail / wants-a-human), and books the slot or advances to the next person — all consent-gated and shown live on a dashboard.

## The challenge

fonio.ai provides AI phone agents. The case: use them to solve a real operational problem. We chose appointment recovery for a private dental practice in Vienna serving international patients — high slot value, long waitlists, time-sensitive. The empty chair is perishable inventory, so the goal is to fill it quickly with the patient who should get it, not just the first name on a list.

## What we built

- **Patient-benefit dispatcher** — ranks the waitlist by `urgency × likelihood-to-attend × fit`, never by revenue. Consent is a hard gate; every decision is explainable with a written rationale.
- **Real outbound calling via fonio** — a personalized call placed automatically, with structured outcomes returned through a post-call webhook.
- **Full outcome handling** — yes, no, reschedule (feasibility-checked), cancel, opt-out, voicemail, no-answer, wrong-person, technical failure, and "speak to a human" (ends the call and flags reception with the AI conversation summary).
- **Live staff dashboard** — reception view (ranked candidates with reasons + real-time activity) and owner view (refill rate, revenue recovered, attempts per slot, outcomes by reason).
- **Patient self-service page** — reschedule, cancel, and a consent toggle, all live against the database.
- **Simulation mode** — the whole loop runs in-process without placing real calls, so it is fully demoable offline.

## Demo

- Live demo: run locally (see below)
- Screenshots / video: `<link>`

---

## Getting started

### Prerequisites

- Node.js 18+
- A PostgreSQL database (e.g. a free Neon or Supabase instance)
- A fonio.ai account (only needed for real outbound calls; the app simulates calls otherwise)

### Setup

```bash
# 1. Clone the repository
git clone <your-repo-url>
cd <your-repo>

# 2. Configure environment
cp .env.example .env
# fill in the required values (see .env.example)

# 3. Install dependencies and set up the database
npm install
npx prisma migrate deploy
npm run seed
```

### Run

```bash
npm run dev
```

Then open `http://localhost:3000` — staff dashboard. The patient page is at `http://localhost:3000/p/demo`.

---

## Project structure

```
src/
  app/
    page.tsx, StaffShell.tsx     staff dashboard (reception + owner views)
    p/[token]/                   patient self-service page
    api/
      slots/[id]/                cancel / reschedule / stop-recovery
      patient/consent            consent toggle
      fonio/                     outbound-call outcome webhook + read endpoints
      state                      dashboard state
  lib/
    orchestrator.ts              the recovery loop + state machine
    scoring.ts                   patient-benefit ranking engine
    fonio.ts                     fonio outbound-call client (real + simulated)
    fonio-auth.ts                shared-secret verification for fonio requests
    queries.ts, db.ts, format.ts
prisma/
  schema.prisma, seed.ts, migrations/
waitlist_patients.json           synthetic demo dataset (80 patients)
```

## Configuration

All settings live in `.env` (git-ignored). See `.env.example` for the full list. The essentials:

- `DATABASE_URL` — PostgreSQL connection string.
- `FONIO_LIVE` — `"false"` simulates calls in-process; `"true"` places real calls.
- `FONIO_API_KEY`, `FONIO_FROM_NUMBER` — required only when `FONIO_LIVE="true"`.
- `FONIO_WEBHOOK_SECRET` — shared secret to verify fonio's post-call webhook.

**Never commit secrets.** Keep them in `.env`.

## Architecture & assumptions

A cancellation (from the dashboard, the patient page, or a fonio inbound call) enters the orchestrator, which ranks eligible waitlist patients and calls the top one through fonio. fonio extracts a structured outcome and posts it back to a webhook; the orchestrator books the slot or advances to the next candidate. Every transition is idempotent and written to an append-only event log that drives the live dashboard.

Full technical write-up: [`REPORT.md`](REPORT.md).

## What's real vs. mocked

| Real | Mocked / simulated |
|---|---|
| Outbound phone call via fonio (`FONIO_LIVE="true"`) | The 80-patient waitlist dataset (synthetic) |
| The full recovery loop, scoring, state machine | Phone numbers in the seed (placeholders) |
| PostgreSQL persistence + append-only audit log | No real PMS / EHR / calendar integration (out of scope per the brief) |
| Consent gate, idempotency, error handling, call-cap | `FONIO_LIVE="false"` simulates the call in-process for offline demos |

We intentionally do not use fonio's native calendar scheduler (its event metadata isn't exposed back to the app); the system books into its own database so it owns all the metadata.

## Troubleshooting

- Reschedule shows no times → the seed needs open future slots; re-run `npm run seed`.
- fonio webhook not arriving → confirm the deployed URL and `FONIO_WEBHOOK_SECRET` match the fonio side.
- Database errors on first run → run `npx prisma migrate deploy` before `npm run seed`.

---

## Team

- Yehor Larchenko
- Olha Rybak
- Oleksandr Kravchuk

## Submission

- Track: **fonio.ai** · Case partner: **fonio.ai**
- Submitted to the START Hack Vienna '26 GitHub organisation.

## License

Released under the MIT License — see [`LICENSE`](LICENSE).
