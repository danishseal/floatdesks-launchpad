/**
 * Server-side Privy verification. Confirms a comment really comes from a
 * signed-in user (their access token is verified against the app secret,
 * which lives only in the server env), and derives a stable display name
 * from their verified linked email or wallet so authors cannot be spoofed.
 */
import { PrivyClient } from "@privy-io/server-auth";

const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
const appSecret = process.env.PRIVY_APP_SECRET;

const client =
  appId && appSecret ? new PrivyClient(appId, appSecret) : null;

export async function verifyAuthor(token: string): Promise<string | null> {
  if (!client) return null;
  try {
    const claims = await client.verifyAuthToken(token);
    try {
      const user = await client.getUserById(claims.userId);
      const accounts: any[] = (user as any).linkedAccounts ?? [];
      const email = accounts.find((a) => a.type === "email" && a.address);
      if (email) return String(email.address);
      const wallet = accounts.find((a) => a.type === "wallet" && a.address);
      if (wallet) {
        const addr = String(wallet.address);
        return `${addr.slice(0, 4)}..${addr.slice(-4)}`;
      }
    } catch {
      // getUserById is rate-limited; the token is already verified, so fall
      // back to an opaque but stable handle derived from the user id.
    }
    return `member_${claims.userId.slice(-6)}`;
  } catch {
    return null;
  }
}
