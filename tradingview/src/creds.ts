/**
 * Account credentials.
 *
 * TradingView serves less data anonymously: shorter intraday history, no Pine
 * studies, and possibly delayed or substitute feeds. Supplying the `sessionid`
 * and `sessionid_sign` cookies unlocks whatever the account can access.
 *
 * Read from the environment only — never from flags or files in this repo:
 *   TV_SESSION  (or TV_SESSIONID)        -> session
 *   TV_SIGNATURE (or TV_SESSIONID_SIGN)  -> signature
 */

export type Credentials = { session: string; signature: string };

export function credentials(): Credentials | undefined {
  const session = process.env.TV_SESSION ?? process.env.TV_SESSIONID;
  const signature = process.env.TV_SIGNATURE ?? process.env.TV_SESSIONID_SIGN;
  if (!session || !signature) return undefined;
  return { session, signature };
}

export function hasCredentials(): boolean {
  return credentials() !== undefined;
}
