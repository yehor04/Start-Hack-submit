import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyFonioRequest } from "@/lib/fonio-auth";

async function resolvePatient(attemptId: string | null, phone: string | null) {
  if (attemptId) {
    const a = await db.recoveryAttempt.findUnique({ where: { id: attemptId }, include: { patient: true, slot: true } });
    if (a) return { patient: a.patient, slot: a.slot };
  }
  if (phone) {
    const p = await db.patient.findFirst({ where: { phone } });
    if (p) return { patient: p, slot: null };
  }
  return null;
}

function shapePatient(p: {
  name: string; condition: string; assignedDoctor: string; urgency: string;
  timePreference: string; preferredTime: string; daysOnWaitlist: number;
  onWaitlist: boolean; consentOutbound: boolean;
}) {
  return {
    name: p.name,
    condition: p.condition,
    doctor: p.assignedDoctor,
    urgency: p.urgency,
    time_preference: p.timePreference,
    preferred_time: p.preferredTime,
    days_on_waitlist: p.daysOnWaitlist,
    on_waitlist: p.onWaitlist,
    consent: p.consentOutbound,
  };
}

export async function GET(req: Request) {
  if (!verifyFonioRequest(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const q = new URL(req.url).searchParams;
  const found = await resolvePatient(q.get("attempt_id"), q.get("phone"));
  if (!found) return NextResponse.json({ ok: false, error: "patient not found" }, { status: 404 });

  return NextResponse.json({
    ok: true,
    patient: shapePatient(found.patient),
    offered_slot: found.slot
      ? {
          when: found.slot.startsAt.toISOString(),
          treatment: found.slot.treatment,
          practitioner: found.slot.practitioner,
          durationMin: found.slot.durationMin,
        }
      : null,
  });
}
