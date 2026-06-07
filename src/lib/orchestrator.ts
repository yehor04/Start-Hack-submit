import { db } from "./db";
import { rankPool, type PatientLite, type Scored } from "./scoring";
import { triggerCall, cancelCall } from "./fonio";

export type Outcome =
  | "yes"
  | "no"
  | "maybe"
  | "reschedule"
  | "cancel"
  | "optout"
  | "voicemail"
  | "no_answer"
  | "wrong_person"
  | "failed"
  | "human_requested";

export type RankedCandidate = {
  patientId: string;
  name: string;
  phone: string;
  condition: string;
  procedureTimeMin: number;
  scored: Scored;
  attempted: boolean;
  attemptStatus: string | null;
};

function toLite(p: any): PatientLite {
  return {
    id: p.id,
    name: p.name,
    phone: p.phone,
    consentOutbound: p.consentOutbound,
    urgency: p.urgency,
    condition: p.condition,
    assignedDoctor: p.assignedDoctor,
    timePreference: p.timePreference,
    preferredTime: p.preferredTime,
    daysOnWaitlist: p.daysOnWaitlist,
    assignedDate: p.assignedDate,
    contactAttempts: p.contactAttempts,
    lastContactResult: p.lastContactResult,
    timesSkipped: p.timesSkipped,
    procedureTimeMin: p.procedureTimeMin,
    procedureCost: p.procedureCost,
  };
}

async function log(type: string, payload: Record<string, unknown> & { slotId?: string }) {
  await db.eventLog.create({
    data: { type, slotId: payload.slotId ?? null, payload: JSON.stringify(payload) },
  });
}

export async function rankCandidates(slotId: string): Promise<RankedCandidate[]> {
  const slot = await db.slot.findUnique({ where: { id: slotId } });
  if (!slot) return [];
  const patients = await db.patient.findMany({ where: { onWaitlist: true } });
  const ranked = rankPool(
    { startsAt: slot.startsAt, durationMin: slot.durationMin, doctor: slot.practitioner ?? "" },
    patients.map(toLite),
  );
  const attempts = await db.recoveryAttempt.findMany({ where: { slotId } });
  const byPatient = new Map(attempts.map((a) => [a.patientId, a] as const));

  return ranked.map((r) => {
    const at = byPatient.get(r.patient.id);
    return {
      patientId: r.patient.id,
      name: r.patient.name,
      phone: r.patient.phone,
      condition: r.patient.condition,
      procedureTimeMin: r.patient.procedureTimeMin,
      scored: r.scored,
      attempted: !!at,
      attemptStatus: at?.status ?? null,
    };
  });
}

export async function cancelSlot(slotId: string, source = "reception") {
  const slot = await db.slot.findUnique({ where: { id: slotId } });
  if (!slot) throw new Error("slot not found");
  if (slot.status === "filling") return slot;

  await db.slot.update({
    where: { id: slotId },
    data: { status: "filling", bookedPatientName: null, recoveredBy: null },
  });
  await log("cancellation", { slotId, source, treatment: slot.treatment, value: slot.valueEur });
  await startRecovery(slotId);
  return slot;
}

export async function startRecovery(slotId: string) {
  await db.slot.update({ where: { id: slotId }, data: { status: "filling" } });
  const ranked = await rankCandidates(slotId);
  const eligible = ranked.filter((r) => r.scored.eligible && !r.attempted);
  await log("scored", { slotId, candidates: eligible.length, top: eligible[0]?.name ?? null });

  const slot = await db.slot.findUnique({ where: { id: slotId } });
  console.log("\n────────────────────────────────────────────────────────");
  console.log(`🦷 SLOT FREED: ${slot?.treatment} · ${slot?.practitioner} · ${slot?.startsAt.toISOString()} · €${slot?.valueEur}`);
  console.log(`📊 RANKED ${eligible.length} eligible candidate(s):`);
  eligible.slice(0, 5).forEach((r, i) =>
    console.log(`   ${i + 1}. ${r.name.padEnd(22)} score ${r.scored.score.toFixed(2)}  📞 ${r.phone}   — ${r.scored.reason}`),
  );
  if (!eligible.length) {
    console.log("   ⚠️  none eligible → escalating to a human.");
    console.log("────────────────────────────────────────────────────────\n");
    return escalate(slotId, "no eligible candidates");
  }
  console.log("────────────────────────────────────────────────────────\n");
  return callNext(slotId);
}

export async function callNext(slotId: string) {
  const slot = await db.slot.findUnique({ where: { id: slotId } });
  if (!slot || slot.status === "stopped" || slot.status === "escalated" || slot.status === "filled") return;
  const ranked = await rankCandidates(slotId);
  const next = ranked.find((r) => r.scored.eligible && !r.attempted);

  if (!next) return callbackOrEscalate(slotId);

  const priorAttempts = await db.recoveryAttempt.count({ where: { slotId } });
  const CAP = Number(process.env.FONIO_MAX_CALLS_PER_SLOT ?? 3);
  if (priorAttempts >= CAP) {
    console.log(`🛑 call cap (${CAP}) reached for this slot → escalating to a human.`);
    return escalate(slotId, `call cap (${CAP}) reached`);
  }

  let attempt;
  try {
    attempt = await db.recoveryAttempt.create({
      data: {
        slotId,
        patientId: next.patientId,
        status: "calling",
        score: next.scored.score,
        pAccept: next.scored.likelihood,
        evEur: Math.round(next.scored.score * (slot.valueEur || 0)),
        scoreBreakdown: JSON.stringify(next.scored.factors),
        reasonText: next.scored.reason,
        idempotencyKey: `${slotId}:${next.patientId}`,
      },
    });
  } catch (e) {

    if ((e as { code?: string }).code === "P2002") return;
    throw e;
  }

  const slotNow = await db.slot.findUnique({ where: { id: slotId } });
  if (!slotNow || slotNow.status === "stopped" || slotNow.status === "escalated" || slotNow.status === "filled") {
    await db.recoveryAttempt.update({ where: { id: attempt.id }, data: { status: "failed", resolvedAt: new Date() } });
    console.log(`🛑 slot ${slotId} is ${slotNow?.status ?? "gone"} — aborting call for ${next.name}`);
    return;
  }

  await log("call_started", { slotId, patient: next.name, attemptId: attempt.id });
  console.log(`\n📞 CALLING #${priorAttempts + 1}: ${next.name}  →  ${next.phone}  (attempt ${attempt.id})`);
  await triggerCall({
    attemptId: attempt.id,
    slotId,
    patient: { name: next.name, phone: next.phone, condition: next.condition },
    slot: {
      startsAt: slot.startsAt,
      treatment: slot.treatment,
      practitioner: slot.practitioner ?? "",
      durationMin: slot.durationMin,
    },
    procedureMinutes: next.procedureTimeMin,
    pAccept: next.scored.likelihood,
  });
}

export async function handleOutcome(
  attemptId: string,
  outcome: Outcome,
  meta?: { summary?: string; preferredAlternative?: string },
) {
  const attempt = await db.recoveryAttempt.findUnique({
    where: { id: attemptId },
    include: { patient: true, slot: true },
  });
  if (!attempt || attempt.resolvedAt) return;

  const note = meta?.preferredAlternative ?? meta?.summary;
  await db.recoveryAttempt.update({
    where: { id: attemptId },
    data: { status: outcome, resolvedAt: new Date(), reasonText: note ?? attempt.reasonText },
  });
  await log("outcome", { slotId: attempt.slotId, patient: attempt.patient.name, outcome, summary: meta?.summary ?? null });

  const patientId = attempt.patientId;
  const patch = (data: Record<string, unknown>) => db.patient.update({ where: { id: patientId }, data });

  switch (outcome) {
    case "yes":
      await db.slot.update({
        where: { id: attempt.slotId },
        data: { status: "filled", recoveredBy: attempt.patient.name },
      });
      await patch({ onWaitlist: false, contactAttempts: { increment: 1 }, lastContactResult: "confirmed" });
      await log("booked", { slotId: attempt.slotId, patient: attempt.patient.name, value: attempt.slot.valueEur });
      return;

    case "optout":
      await patch({ consentOutbound: false, onWaitlist: false, contactAttempts: { increment: 1 }, lastContactResult: "declined" });
      await log("optout", { slotId: attempt.slotId, patient: attempt.patient.name });
      break;

    case "no":
      await patch({ contactAttempts: { increment: 1 }, timesSkipped: { increment: 1 }, lastContactResult: "declined" });
      break;

    case "maybe":
      await log("maybe", { slotId: attempt.slotId, patient: attempt.patient.name });
      break;

    case "reschedule":

      await patch({ contactAttempts: { increment: 1 } });
      await log("reschedule", {
        slotId: attempt.slotId,
        patient: attempt.patient.name,
        preferred: meta?.preferredAlternative ?? null,
      });
      break;

    case "cancel":
      await patch({ onWaitlist: false, contactAttempts: { increment: 1 } });
      await log("cancel", { slotId: attempt.slotId, patient: attempt.patient.name });
      break;

    case "voicemail":
      await patch({ contactAttempts: { increment: 1 }, lastContactResult: "voicemail" });
      break;

    case "no_answer":
      await patch({ contactAttempts: { increment: 1 }, lastContactResult: "no_answer" });
      break;

    case "wrong_person":
      await patch({ contactAttempts: { increment: 1 } });
      break;

    case "human_requested":
      await patch({ contactAttempts: { increment: 1 } });
      await log("human_requested", {
        slotId: attempt.slotId,
        patient: attempt.patient.name,
        summary: meta?.summary ?? null,
      });
      break;

    case "failed":
      await log("call_failed", { slotId: attempt.slotId, patient: attempt.patient.name, note: "technical failure — manual review" });
      break;
  }

  await callNext(attempt.slotId);
}

export async function stopRecovery(slotId: string) {
  await db.slot.update({ where: { id: slotId }, data: { status: "stopped" } });
  await db.eventLog.create({
    data: { type: "stopped", slotId, payload: JSON.stringify({ slotId, why: "stopped manually by staff" }) },
  });
  console.log(`🛑 RECOVERY STOPPED manually for slot ${slotId}`);

  const active = await db.recoveryAttempt.findFirst({
    where: { slotId, status: "calling", resolvedAt: null },
  });
  if (active) {
    await db.recoveryAttempt.update({
      where: { id: active.id },
      data: { status: "failed", resolvedAt: new Date() },
    });

    cancelCall(active.fonioCallId, active.id).catch(() => {});
  }
}

async function escalate(slotId: string, why: string) {

  await db.slot.update({ where: { id: slotId }, data: { status: "escalated" } });
  await log("escalated", { slotId, why });
  console.log(`🛑 ESCALATED slot ${slotId}: ${why} — needs a human.`);
}

async function callbackOrEscalate(slotId: string) {
  const slot = await db.slot.findUnique({ where: { id: slotId } });
  if (!slot) return;

  const calledBack = await db.eventLog.count({ where: { slotId, type: "callback" } });
  if (calledBack === 0) {
    const m = await db.recoveryAttempt.findFirst({
      where: { slotId, status: "maybe" },
      orderBy: { score: "desc" },
      include: { patient: true },
    });
    if (m && m.patient.consentOutbound && m.patient.onWaitlist) {
      await db.recoveryAttempt.update({ where: { id: m.id }, data: { status: "calling", resolvedAt: null } });
      await log("callback", { slotId, patient: m.patient.name });
      console.log(`📞 CALLBACK: ${m.patient.name} (no fresh candidates left → retrying a "maybe")`);
      await triggerCall({
        attemptId: m.id,
        slotId,
        patient: { name: m.patient.name, phone: m.patient.phone, condition: m.patient.condition },
        slot: {
          startsAt: slot.startsAt,
          treatment: slot.treatment,
          practitioner: slot.practitioner ?? "",
          durationMin: slot.durationMin,
        },
        procedureMinutes: m.patient.procedureTimeMin,
        pAccept: m.pAccept ?? 0.5,
      });
      return;
    }
  }
  return escalate(slotId, "waitlist exhausted");
}

export async function markExpiredSlots() {
  const expired = await db.slot.findMany({
    where: { startsAt: { lt: new Date() }, status: "open" },
  });
  for (const s of expired) {
    await db.slot.update({ where: { id: s.id }, data: { status: "lost" } });
    await db.eventLog.create({
      data: {
        type: "lost",
        slotId: s.id,
        payload: JSON.stringify({ slotId: s.id, revenueLost: s.valueEur, treatment: s.treatment }),
      },
    });
    console.log(`⏰ SLOT LOST: ${s.treatment} expired unfilled — €${s.valueEur} lost.`);
  }
  return expired.length;
}
