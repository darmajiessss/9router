import { NextResponse } from "next/server";
import { stop } from "@/lib/agents/runner";

export const dynamic = "force-dynamic";

// POST /api/agents/stop - matikan semua slot, atau satu bila ?slot=N / body {slot}
export async function POST(request) {
  try {
    let slot;
    try {
      const body = await request.json();
      slot = body?.slot;
    } catch {
      slot = undefined;
    }
    const result = stop(slot ? Number(slot) : undefined);
    return NextResponse.json(result);
  } catch (error) {
    console.log("agents stop error:", error);
    return NextResponse.json({ error: String(error?.message || error) }, { status: 400 });
  }
}
