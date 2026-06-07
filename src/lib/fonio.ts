import type { Outcome } from "./orchestrator";
import { db } from "./db";

const LIVE = process.env.FONIO_LIVE === "true";
const BASE = (process.env.FONIO_API_BASE_URL || "https://app.fonio.ai").replace(/\/$/, "");
const OUTBOUND_PATH = process.env.FONIO_OUTBOUND_PATH || "/api/public/v1/outbound_call";
const API_KEY = process.env.FONIO_API_KEY || "";
const FROM_NUMBER = process.env.FONIO_FROM_NUMBER || "";
const AGENT_ID = process.env.FONIO_AGENT_ID || "";
const TIMEOUT_MS = 15_000;

export type TriggerOpts = {
  attemptId: string;
  slotId: string;
  patient: { name: string; phone: string; condition: string };
  slot: { startsAt: Date; treatment: string; practitioner: string; durationMin: number };
  procedureMinutes: number;
  pAccept: number;
};

function toE164(raw: string): string | null {
  const t = (raw || "").replace(/[\s()\-.]/g, "");
  return /^\+\d{6,15}$/.test(t) ? t : null;
}

const CLINIC_TZ = "Europe/Vienna";
const fmtDate = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: CLINIC_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const fmtTime = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: CLINIC_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);

const fmtSlotHuman = (d: Date, practitioner: string) =>
  `${new Intl.DateTimeFormat("en-GB", { timeZone: CLINIC_TZ, weekday: "short", day: "2-digit", month: "short" }).format(d)} at ${fmtTime(d)}${practitioner ? ` with ${practitioner}` : ""}`;

async function buildAlternativeSlots(currentSlotId: string, procedureMinutes: number): Promise<string> {
  try {
    const others = await db.slot.findMany({
      where: {
        id: { not: currentSlotId },
        status: { in: ["open", "filling"] },
        startsAt: { gt: new Date() },
        durationMin: { gte: procedureMinutes },
      },
      orderBy: { startsAt: "asc" },
      take: 8,
    });
    if (!others.length) return "None — there are no other openings that fit this appointment.";
    return others.map((s) => fmtSlotHuman(s.startsAt, s.practitioner ?? "")).join("; ");
  } catch (err) {
    console.error("[fonio] buildAlternativeSlots failed (non-fatal)", err);
    return "";
  }
}

export async function triggerCall(opts: TriggerOpts): Promise<void> {
  if (LIVE) {
    await triggerLiveCall(opts);
    return;
  }

  const delay = 4000 + Math.random() * 3000;
  const outcome = simulateOutcome(opts.pAccept);
  setTimeout(() => {

    import("./orchestrator")
      .then((m) => m.handleOutcome(opts.attemptId, outcome))
      .catch((err) => console.error("[fonio sim] outcome failed", err));
  }, delay);
}

async function triggerLiveCall(opts: TriggerOpts): Promise<void> {
  const toNumber = toE164(opts.patient.phone);
  if (!API_KEY || !FROM_NUMBER || !toNumber) {
    console.error("[fonio] live call misconfigured — aborting", {
      hasApiKey: !!API_KEY,
      hasFromNumber: !!FROM_NUMBER,
      rawPhone: opts.patient.phone,
      normalised: toNumber,
    });
    return failAttempt(opts.attemptId);
  }

  const alternativeSlots = await buildAlternativeSlots(opts.slotId, opts.procedureMinutes);

  const body: Record<string, unknown> = {
    fromNumber: FROM_NUMBER,
    toNumber,
    context: {

      patient_name: opts.patient.name,
      patient_condition: opts.patient.condition,
      doctor_name: opts.slot.practitioner,
      slot_date: fmtDate(opts.slot.startsAt),
      slot_time: fmtTime(opts.slot.startsAt),
      slot_duration: String(opts.slot.durationMin),

      reschedule_options: alternativeSlots,

      attempt_id: opts.attemptId,
    },
  };

  if (AGENT_ID) body.agentId = AGENT_ID;

  const url = `${BASE}${OUTBOUND_PATH}`;
  console.log(`🌐 fonio API → POST ${url}`);
  console.log(`   from ${FROM_NUMBER}  to ${toNumber}  context.attempt_id=${opts.attemptId}`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => ({}))) as { status?: string; message?: string };
    if (!res.ok || data?.status === "error") {
      console.error(`❌ fonio API rejected — HTTP ${res.status}`, data);
      return failAttempt(opts.attemptId);
    }
    console.log(`✅ fonio API ${res.status} — ${data?.status}: ${data?.message}  → ${toNumber} is ringing\n`);
  } catch (err) {
    console.error("[fonio] outbound_call threw", err);
    return failAttempt(opts.attemptId);
  } finally {
    clearTimeout(timer);
  }
}

async function failAttempt(attemptId: string): Promise<void> {
  try {
    const m = await import("./orchestrator");
    await m.handleOutcome(attemptId, "failed");
  } catch (err) {
    console.error("[fonio] failAttempt could not advance the loop", err);
  }
}

function simulateOutcome(pAccept: number): Outcome {
  if (pAccept >= 0.7) return "yes";
  if (pAccept >= 0.45) return "no_answer";
  return "no";
}
