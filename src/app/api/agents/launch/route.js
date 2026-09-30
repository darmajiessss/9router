import { NextResponse } from "next/server";
import { launch } from "@/lib/agents/runner";

export const dynamic = "force-dynamic";

// POST /api/agents/launch - launch N slot (config opsional di body; selalu restart bersih)
export async function POST(request) {
  try {
    let input;
    try {
      const body = await request.json();
      input = body.config;
    } catch {
      input = undefined; // tanpa body = pakai config tersimpan
    }
    const state = launch(input);
    return NextResponse.json({ state });
  } catch (error) {
    console.log("agents launch error:", error);
    return NextResponse.json({ error: String(error?.message || error) }, { status: 400 });
  }
}
