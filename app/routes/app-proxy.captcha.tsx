import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { turnstileConfigFromEnv } from "../services/b2b-turnstile.server";

/**
 * Storefront path: /apps/b2b-register/captcha (see [app_proxy] in shopify.app.toml).
 *
 * The registration form's Turnstile site key, so both keys are set in one
 * place (the hosting environment) instead of one there and one in the theme.
 * Returns `{ siteKey: null }` when Turnstile is off.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);

  return Response.json(
    { siteKey: turnstileConfigFromEnv()?.siteKey ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
};
