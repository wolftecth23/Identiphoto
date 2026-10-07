import type { Session } from "@shopify/shopify-api";
import { apiVersion } from "../shopify.server";

export type RegionOption = { code: string; name: string };

type RestCountry = {
  code: string;
  name: string;
  provinces?: { code: string; name: string }[];
};

async function fetchShippingCountries(
  session: Session,
): Promise<RestCountry[]> {
  const version = apiVersion;
  const response = await fetch(
    `https://${session.shop}/admin/api/${version}/countries.json`,
    {
      headers: {
        "X-Shopify-Access-Token": session.accessToken ?? "",
        "Content-Type": "application/json",
      },
    },
  );

  if (!response.ok) {
    console.error(
      "Failed to load countries from Admin REST",
      response.status,
      await response.text(),
    );
    return [];
  }

  const payload = (await response.json()) as { countries?: RestCountry[] };
  return payload.countries ?? [];
}

/** Provinces/states for countries configured in the store's shipping zones. */
export async function getProvincesForCountry(
  session: Session,
  countryCode: string,
): Promise<RegionOption[]> {
  const code = countryCode.trim().toUpperCase();
  if (!code) return [];

  const countries = await fetchShippingCountries(session);
  const country = countries.find(
    (entry) => entry.code?.toUpperCase() === code,
  );
  const provinces = country?.provinces ?? [];

  return provinces
    .filter((p) => p.code && p.name)
    .map((p) => ({ code: p.code, name: p.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
