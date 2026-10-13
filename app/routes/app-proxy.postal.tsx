import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { lookupPostalCode } from "../services/b2b-postal.server";

/**
 * Storefront path: /apps/b2b-register/postal (see [app_proxy] in shopify.app.toml).
 *
 * `?country=US&zip=44094` -> `{ city: "Willoughby", provinceCode: "OH" }`, or
 * `{ city: null }` when the code isn't known. The registration form calls it
 * once the ZIP/postal code is complete to fill in the city and state.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);

  const params = new URL(request.url).searchParams;
  const result = await lookupPostalCode(
    params.get("country") ?? "",
    (params.get("zip") ?? "").slice(0, 12),
  );

  // The data only changes when scripts/build-postal-data.ts is re-run.
  return Response.json(result ?? { city: null, provinceCode: null }, {
    headers: { "Cache-Control": "public, max-age=86400" },
  });
};
