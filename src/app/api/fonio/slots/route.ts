import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { rankCandidates } from "@/lib/orchestrator";
import { verifyFonioRequest } from "@/lib/fonio-auth";
import { treatmentLabel, timeLabel, weekdayLabel } from "@/lib/format";

export async function GET(req: Request) {
  if (!verifyFonioRequest(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const slotId = new URL(req.url).searchParams.get("slotId");

  if (slotId) {
    const slot = await db.slot.findUnique({ where: { id: slotId } });
    if (!slot) {
      return NextResponse.json({ ok: false, error: "slot not found" }, { status: 404 });
    }
    const candidates = (await rankCandidates(slotId))
      .filter((c) => c.scored.eligible)
      .map((c, i) => ({
        rank: i + 1,
        name: c.name,
        likelihood: c.scored.likelihood,
        urgency: c.scored.urgency,
        reason: c.scored.reason,
        status: c.attemptStatus ?? "queued",
      }));
    return NextResponse.json({ ok: true, slot: shapeSlot(slot), candidates });
  }

  const slots = await db.slot.findMany({
    where: { status: { in: ["open", "filling"] } },
    orderBy: { startsAt: "asc" },
  });
  return NextResponse.json({ ok: true, count: slots.length, slots: slots.map(shapeSlot) });
}

type SlotRow = {
  id: string;
  startsAt: Date;
  durationMin: number;
  treatment: string;
  practitioner: string | null;
  room: string | null;
  status: string;
  valueEur: number;
};

function shapeSlot(s: SlotRow) {
  return {
    id: s.id,
    startsAt: s.startsAt.toISOString(),
    when: `${weekdayLabel(s.startsAt)} at ${timeLabel(s.startsAt)}`,
    durationMin: s.durationMin,
    treatment: treatmentLabel(s.treatment),
    practitioner: s.practitioner ?? null,
    room: s.room ?? null,
    status: s.status,
    valueEur: s.valueEur,
  };
}
