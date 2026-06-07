import { NextResponse } from "next/server";
import { getTodaySchedule, getActiveRecovery, getKpis, getSlotAttempts } from "@/lib/queries";
import { markExpiredSlots } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";

export async function GET() {

  await markExpiredSlots().catch((e) => console.error("[state] markExpiredSlots failed", e));
  const [schedule, recovery, kpis, slotAttempts] = await Promise.all([
    getTodaySchedule(),
    getActiveRecovery(),
    getKpis(),
    getSlotAttempts().catch(() => []),
  ]);
  return NextResponse.json({ schedule, recovery, kpis, slotAttempts });
}
