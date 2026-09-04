import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { HORNS } from "@/lib/horns-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ChatMessage = { role: "user" | "assistant"; content: string };

const MODEL = process.env.HORNS_CHAT_MODEL || "claude-haiku-4-5-20251001";

function catalogContext(): string {
  return HORNS.map(
    (h) =>
      `## ${h.name} (${h.category})\n` +
      `Hooks: ${h.hooks.join(", ")}\n` +
      `${h.tagline}\n${h.blurb}\n` +
      `Highlights:\n${h.points.map((p) => `- ${p}`).join("\n")}`,
  ).join("\n\n");
}

const SYSTEM = `You are the Horns assistant for ansemchain, a Cosmos launchpad whose coins launch on a bonding curve and graduate to the ANSEM AMM. "Horns" are v4-style hook contracts that attach to a graduated pool. They can skim a slice of every swap fee to the Horn Vault (where ANSEM and CHANSE stakers earn it) or reshape how the pool prices, gates, and fills trades.

Answer questions about the Horns clearly and concisely, grounded in the catalog below and general knowledge of AMMs and CosmWasm. Rules:
- Be accurate. If something is not covered, say so plainly rather than inventing it.
- Never invent live numbers, TVL, APRs, or addresses. Those activate as the program wires to the indexer.
- Prefer short, direct answers. Use plain prose or short lists. Do not use em dashes.
- The gas token is CHANSE; ANSEM is the other stakeable asset. The chain is ansem-1.

Horn catalog:

${catalogContext()}`;

async function focusContext(focus: unknown): Promise<string> {
  if (typeof focus !== "string" || !focus) return "";
  const horn = HORNS.find((h) => h.slug === focus);
  if (!horn) return "";
  try {
    const file = path.join(process.cwd(), "public", "horns", `${focus}.rs`);
    const src = await fs.readFile(file, "utf8");
    return (
      `\n\nThe user is currently viewing the ${horn.name} Horn, and its full source follows. When they say "this Horn" or "it", they mean the ${horn.name}. Answer from this source when relevant:\n\n` +
      "```rust\n" +
      `${src.slice(0, 60000)}\n` +
      "```"
    );
  } catch {
    return "";
  }
}

export async function POST(req: Request) {
  let body: { messages?: ChatMessage[]; focus?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const messages = (body.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return NextResponse.json({ error: "no question" }, { status: 400 });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return NextResponse.json({
      reply:
        "The Horns assistant is not configured on this deployment yet (no ANTHROPIC_API_KEY). In the meantime, pick any Horn on the left to read what it does and preview its real source.",
      configured: false,
    });
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: SYSTEM + (await focusContext(body.focus)), messages }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("[horns-chat] upstream error", res.status, detail.slice(0, 300));
      return NextResponse.json({ error: "assistant unavailable" }, { status: 502 });
    }
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const reply = (data.content ?? [])
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n")
      .trim();
    return NextResponse.json({ reply: reply || "I could not produce an answer for that.", configured: true });
  } catch (err) {
    console.error("[horns-chat] fetch failed", err);
    return NextResponse.json({ error: "assistant unavailable" }, { status: 502 });
  }
}
