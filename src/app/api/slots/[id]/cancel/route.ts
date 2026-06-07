import { NextResponse } from "next/server";
import { cancelSlot } from "@/lib/orchestrator";

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  try {
    await cancelSlot(params.id, "reception");
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[slots/cancel] failed", e);
    return NextResponse.json({ ok: false, error: "cancel failed" }, { status: 400 });
  }
}
