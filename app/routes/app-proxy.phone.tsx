import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { checkPhone } from "../services/b2b-phone.server";

/**
 * Storefront path: /apps/b2b-register/phone (see [app_proxy] in shopify.app.toml).
 *
 * Checks the registration form's phone number as the customer leaves the
 * field. POST `{ number, country }` (a POST keeps the number out of URLs and
 * logs); returns `{ valid, countryCode, national }`. The submit endpoint
 * checks again, so this only gives earlier feedback.
 */
export const loader = async () => {
  return Response.json(
    { error: "Use POST to check a phone number." },
    { status: 405 },
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.public.appProxy(request);

  let body: { number?: unknown; country?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const number = typeof body.number === "string" ? body.number : "";
  const country = typeof body.country === "string" ? body.country : "";
  const check = checkPhone(number, country);

  return Response.json(
    check.valid
      ? {
          valid: true,
          countryCode: check.countryCode,
          national: check.national,
        }
      : { valid: false },
    { headers: { "Cache-Control": "no-store" } },
  );
};
