import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  listCities,
  listCountries,
  listRegions,
} from "../services/b2b-localization.server";

/**
 * Storefront path: /apps/b2b-register/regions (see [app_proxy] in shopify.app.toml).
 *
 * Address options for the registration form's dropdowns:
 * - no params: `{ countries }`
 * - `?country=US`: `{ regions, cities }` (cities only when the country has no regions)
 * - `?country=US&region=CA`: `{ cities }`
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);

  const params = new URL(request.url).searchParams;
  const country = params.get("country")?.trim().toUpperCase() ?? "";
  const region = params.get("region")?.trim().toUpperCase() ?? "";

  let body;
  if (!country) {
    body = { countries: listCountries() };
  } else if (region) {
    body = { cities: listCities(country, region) };
  } else {
    const regions = listRegions(country);
    body = { regions, cities: regions.length ? [] : listCities(country) };
  }

  // The dataset only changes when the package is upgraded.
  return Response.json(body, {
    headers: { "Cache-Control": "public, max-age=86400" },
  });
};
