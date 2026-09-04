import { NextResponse } from "next/server";
import { addPost, listPosts, postExists } from "@/lib/server/social-store";
import { verifySocial, AUTH_MAX_AGE_MS, type SocialWriteBody } from "@/lib/server/verify";
import { canonicalSocialMessage } from "@/lib/social-sign";
import { relayPost } from "@/lib/server/social-chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREFIX = "ansem";
const MAX_LEN = 1000;
/** Inline image cap (decoded bytes). Matches the client downscale ceiling. */
const IMAGE_MAX_BYTES = 900 * 1024;
const ANSEM_ADDR_RE = /^ansem1[02-9ac-hj-np-z]{20,90}$/;

/** Validate an inline image data URL and that its decoded size is within cap. */
function validImage(image: string): boolean {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(image);
  if (!m) return false;
  const b64 = m[2];
  const bytes = Math.floor((b64.length * 3) / 4);
  return bytes > 0 && bytes <= IMAGE_MAX_BYTES;
}

/** List posts (global, or by ?author=). Pass ?viewer= for viewer like/repost flags. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const author = url.searchParams.get("author") ?? undefined;
  const viewer = url.searchParams.get("viewer") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const posts = await listPosts({ author, viewer, limit });
  return NextResponse.json({ posts });
}

/** Create a post ("tweet"). The signature binds the author to this exact text
 *  plus whether an image / token / quote is attached (see postSignAction). */
export async function POST(req: Request) {
  let body: SocialWriteBody & {
    author?: string;
    text?: string;
    image?: string;
    token?: string;
    quoteOf?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const { author, ts, signature, pubkey } = body;
  const text = (body.text ?? "").trim();
  const image = typeof body.image === "string" ? body.image : undefined;
  const token = typeof body.token === "string" ? body.token : undefined;
  const quoteOf = typeof body.quoteOf === "string" ? body.quoteOf : undefined;

  // A post needs text unless it carries an attachment (image / token / quote).
  const hasAttachment = Boolean(image || token || quoteOf);
  if (!author || (!text && !hasAttachment) || !ts || !signature || !pubkey) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }
  if (text.length > MAX_LEN) {
    return NextResponse.json({ error: "too long" }, { status: 400 });
  }
  if (image && !validImage(image)) {
    return NextResponse.json({ error: "bad image" }, { status: 400 });
  }
  if (token && !ANSEM_ADDR_RE.test(token)) {
    return NextResponse.json({ error: "bad token" }, { status: 400 });
  }
  if (quoteOf && !(await postExists(quoteOf))) {
    return NextResponse.json({ error: "unknown quoted post" }, { status: 400 });
  }
  if (Math.abs(Date.now() - ts) > AUTH_MAX_AGE_MS) {
    return NextResponse.json({ error: "stale signature" }, { status: 401 });
  }
  // The client signs the contract's canonical message so ONE signature is valid
  // both here (off-chain store) and at the on-chain relay. Attachments ride as
  // off-chain metadata and are not bound by this signature.
  const ok = await verifySocial({
    prefix: PREFIX,
    signer: author,
    message: canonicalSocialMessage("post", "", ts, text),
    signatureB64: signature,
    pubkeyB64: pubkey,
    scheme: body.scheme,
    bodyBytesB64: body.bodyBytesB64,
    authInfoBytesB64: body.authInfoBytesB64,
    accountNumber: body.accountNumber,
    chainId: body.chainId,
  });
  if (!ok) return NextResponse.json({ error: "bad signature" }, { status: 401 });

  // Relay the same signed action on-chain (gas-sponsored). Degrades to
  // off-chain-only when the relay is unconfigured or the broadcast fails.
  const relayed = await relayPost(
    {
      author,
      signature,
      pubkey,
      scheme: body.scheme,
      bodyBytesB64: body.bodyBytesB64,
      authInfoBytesB64: body.authInfoBytesB64,
      accountNumber: body.accountNumber,
      chainId: body.chainId,
    },
    text,
    ts,
  );

  const post = await addPost(author, text, {
    image,
    token,
    quoteOf,
    onchainId: relayed?.onchainId,
    txhash: relayed?.txhash,
  });
  return NextResponse.json({ post });
}
