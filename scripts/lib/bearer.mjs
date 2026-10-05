import { execFileSync } from "node:child_process";

let cached;

/**
 * Headers that authenticate a raw GraphQL call the way the CLI does: the
 * bearer in SWITCHBOARD_TOKEN, else the CLI profile's (`switchboard auth
 * token`). Empty when there is none, for an open Switchboard. A vault running
 * with REQUIRE_AUTHENTICATED_CALLER answers 401 to every call without it,
 * reads included.
 */
export function authHeaders(profile) {
  if (cached !== undefined) return cached;
  let token = (process.env.SWITCHBOARD_TOKEN || "").trim();
  if (!token) {
    try {
      token = execFileSync("switchboard", [...(profile ? ["-p", profile] : []), "auth", "token"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      token = "";
    }
  }
  cached = token ? { authorization: `Bearer ${token}` } : {};
  return cached;
}
