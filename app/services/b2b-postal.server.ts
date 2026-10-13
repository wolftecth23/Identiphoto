/**
 * City and state/province for a ZIP or postal code, so the registration form
 * can fill them in. Data: GeoNames (www.geonames.org, CC BY 4.0), built by
 * scripts/build-postal-data.ts. US and Canada only.
 */

type PostalData = {
  /** "City|REGION" entries, referenced by index. */
  cities: string[];
  /** Full code (no spaces) -> city index. For Canada, only codes that differ from their FSA's city. */
  codes: Record<string, number>;
  /** Canada: first three characters (FSA) -> the area's main city. */
  fsa?: Record<string, number>;
};

export type PostalLookup = { city: string; provinceCode: string };

const loaders: Record<string, () => Promise<{ default: PostalData }>> = {
  US: () => import("../data/postal/US.json"),
  CA: () => import("../data/postal/CA.json"),
};

const loaded = new Map<string, Promise<PostalData>>();

function postalData(country: string): Promise<PostalData> | undefined {
  const load = loaders[country];
  if (!load) return undefined;
  let data = loaded.get(country);
  if (!data) {
    data = load().then((module) => module.default);
    loaded.set(country, data);
  }
  return data;
}

/** True for countries the lookup has data for. */
export function hasPostalData(countryCode: string): boolean {
  return countryCode.trim().toUpperCase() in loaders;
}

export async function lookupPostalCode(
  countryCode: string,
  postalCode: string,
): Promise<PostalLookup | null> {
  const country = countryCode.trim().toUpperCase();
  const code = postalCode.replace(/[\s-]+/g, "").toUpperCase();
  const data = await postalData(country);
  if (!data) return null;

  let id: number | undefined;
  if (country === "US") {
    // ZIP+4 shares its first five digits' city.
    if (!/^\d{5}(\d{4})?$/.test(code)) return null;
    id = data.codes[code.slice(0, 5)];
  } else if (country === "CA") {
    if (!/^[A-Z]\d[A-Z](\d[A-Z]\d)?$/.test(code)) return null;
    id = data.codes[code] ?? data.fsa?.[code.slice(0, 3)];
  }
  if (id === undefined) return null;

  const [city, provinceCode] = data.cities[id].split("|");
  return { city, provinceCode };
}
