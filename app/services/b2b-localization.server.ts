import { City, Country, State } from "country-state-city";
import { dialCode } from "./b2b-phone.server";

export type CountryOption = {
  code: string;
  name: string;
  /**
   * International dialing code without "+", e.g. "1" or "44"; "" for the few
   * uninhabited territories with no phone numbering data.
   */
  phoneCode: string;
};

export type RegionOption = { code: string; name: string };

/** City names by "COUNTRY:REGION", plus "COUNTRY:" for every city in a country. */
let cityIndex: Map<string, Set<string>> | undefined;

function citiesByArea(): Map<string, Set<string>> {
  if (cityIndex) return cityIndex;

  cityIndex = new Map();
  const add = (key: string, name: string) => {
    let names = cityIndex!.get(key);
    if (!names) cityIndex!.set(key, (names = new Set()));
    names.add(name);
  };
  for (const city of City.getAllCities()) {
    add(`${city.countryCode}:${city.stateCode}`, city.name);
    add(`${city.countryCode}:`, city.name);
  }
  return cityIndex;
}

function sortedNames<T>(items: T[], name: (item: T) => string): T[] {
  return items.sort((a, b) => name(a).localeCompare(name(b)));
}

let countries: CountryOption[] | undefined;

/** Every country, for the registration form's Country dropdown. */
export function listCountries(): CountryOption[] {
  countries ??= sortedNames(
    Country.getAllCountries().map((country) => ({
      code: country.isoCode,
      name: country.name,
      phoneCode: dialCode(country.isoCode),
    })),
    (country) => country.name,
  );
  return countries;
}

export function findCountry(countryCode: string): CountryOption | undefined {
  const code = countryCode.trim().toUpperCase();
  return listCountries().find((country) => country.code === code);
}

/**
 * States/provinces offered for a country. The dataset mixes subdivision
 * levels (the UK lists nations and 200+ counties, France regions and
 * departments) and only attaches cities to one of them, so when a country has
 * city data we offer just the regions that have cities.
 */
export function listRegions(countryCode: string): RegionOption[] {
  const code = countryCode.trim().toUpperCase();
  const index = citiesByArea();
  const regions = State.getStatesOfCountry(code);
  const withCities = regions.filter((region) =>
    index.has(`${code}:${region.isoCode}`),
  );

  return sortedNames(
    (withCities.length ? withCities : regions).map((region) => ({
      code: region.isoCode,
      name: region.name,
    })),
    (region) => region.name,
  );
}

/**
 * Cities for a region, or for the whole country when it has no regions. An
 * empty list means the dataset has no cities there, so the form falls back to
 * a free-text city.
 */
export function listCities(countryCode: string, regionCode?: string): string[] {
  const key = `${countryCode.trim().toUpperCase()}:${regionCode?.trim().toUpperCase() ?? ""}`;
  return sortedNames([...(citiesByArea().get(key) ?? [])], (name) => name);
}

/**
 * Checks the country/state/city the customer picked against the same lists
 * the form offers. Returns an error message, or null when the address is OK.
 */
export function addressAreaError(address: {
  countryCode: string;
  provinceCode?: string;
  city: string;
}): string | null {
  const country = findCountry(address.countryCode);
  if (!country) return "Select a valid country.";

  const regions = listRegions(country.code);
  const regionCode = address.provinceCode?.trim().toUpperCase() ?? "";
  if (regions.length && !regions.some((region) => region.code === regionCode)) {
    return "Select a valid state/province.";
  }

  const cities = listCities(country.code, regions.length ? regionCode : "");
  if (cities.length && !cities.includes(address.city.trim())) {
    return "Select a city from the list.";
  }

  return null;
}

/**
 * Countries whose dataset region codes are also Shopify's zone codes. Shopify
 * has no zones for most other countries (UK, France, Germany, …) or uses its
 * own codes (Mexico, Malaysia, …), so their regions aren't sent to Shopify.
 */
const SHOPIFY_ZONE_FORMAT: Record<string, (code: string) => string> = {
  US: (code) => code,
  CA: (code) => code,
  AU: (code) => code,
  IN: (code) => code,
  BR: (code) => code,
  AE: (code) => code,
  // Shopify writes prefectures as JP-13; the dataset as 13.
  JP: (code) => `JP-${code}`,
};

/** Shopify zone code for a dataset region code, or undefined to omit it. */
export function shopifyZoneCode(
  countryCode: string,
  regionCode: string,
): string | undefined {
  const country = countryCode.trim().toUpperCase();
  const code = regionCode
    .trim()
    .toUpperCase()
    .replace(new RegExp(`^${country}-`), "");
  const format = SHOPIFY_ZONE_FORMAT[country];
  if (!format || !code) return undefined;
  return format(code);
}
