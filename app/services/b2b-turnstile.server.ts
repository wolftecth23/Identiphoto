/**
 * Cloudflare Turnstile, the registration form's CAPTCHA. The form's widget
 * gets a one-time token in the browser; the submit endpoint asks Cloudflare
 * whether it's valid before anything is created in Shopify.
 */

export type TurnstileConfig = {
  /** Public; the form's widget uses it. */
  siteKey: string;
  /** Private; only sent to Cloudflare. */
  secretKey: string;
};

/**
 * Keys from the environment, or null when Turnstile is off. Both are needed:
 * a secret without a site key would reject every registration, since the
 * form couldn't get a token.
 */
export function turnstileConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): TurnstileConfig | null {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim();
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim();
  if (!siteKey && !secretKey) return null;
  if (!siteKey || !secretKey) {
    console.error(
      "Turnstile is off: set both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY.",
    );
    return null;
  }
  return { siteKey, secretKey };
}

/** The widget's `action`; tokens made for anything else are refused. */
export const TURNSTILE_ACTION = "b2b-register";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileResult =
  | { ok: true }
  | { ok: false; errorCodes: string[] };

/**
 * Asks Cloudflare whether `token` is valid. Tokens are single use and last
 * five minutes. If Cloudflare can't be reached the registration goes ahead
 * (logged): the honeypot and timing checks still apply and staff approve
 * every registration, while failing closed would turn real customers away.
 */
export async function verifyTurnstile(
  config: TurnstileConfig,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TurnstileResult> {
  if (!token) return { ok: false, errorCodes: ["missing-input-response"] };

  let body: { success?: boolean; action?: string; "error-codes"?: string[] };
  try {
    const response = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: config.secretKey, response: token }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = await response.json();
  } catch (error) {
    console.warn("Turnstile check skipped: Cloudflare unreachable.", error);
    return { ok: true };
  }

  if (!body.success) {
    return { ok: false, errorCodes: body["error-codes"] ?? [] };
  }
  // Cloudflare's test keys answer with action "test". Only test secrets
  // accept their dummy token (real ones refuse it above), so this exception
  // can't let anything through in production.
  if (body.action && body.action !== TURNSTILE_ACTION && token !== TURNSTILE_TEST_TOKEN) {
    return { ok: false, errorCodes: ["action-mismatch"] };
  }
  return { ok: true };
}

/** The token Cloudflare's test site keys hand out. */
const TURNSTILE_TEST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
