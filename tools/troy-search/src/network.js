import { UA } from "./config.js";

/** Say what an HTTP status means for this address, in words a person can act on. */
export function refusal(status, body = "") {
  const low = String(body || "").toLowerCase();
  if (low.includes("captcha") || low.includes("just a moment") ||
      low.includes("client challenge") || low.includes("unusual traffic")) {
    return `HTTP ${status} challenge/captcha page — this address is being asked to prove it is human`;
  }
  if ([401, 403, 429, 503].includes(status)) {
    return `HTTP ${status} — this address was refused`;
  }
  if (!status) return "no answer (the request failed)";
  return `HTTP ${status}`;
}

export async function fetchText(url, timeoutMs = 25000) {
  try {
    const answer = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    const body = await answer.text();
    return { status: answer.status, body, error: "" };
  } catch (exc) {
    const cause = exc && exc.cause ? (exc.cause.code || exc.cause.message || "") : "";
    const text = String((exc && exc.message) || exc);
    return { status: 0, body: "", error: (cause ? `${text}: ${cause}` : text).slice(0, 200) };
  }
}
