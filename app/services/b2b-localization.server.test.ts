import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  addressAreaError,
  findCountry,
  listCities,
  listCountries,
  listRegions,
  shopifyZoneCode,
} from "./b2b-localization.server";
import { checkPhone, dialCode, netsuitePhone, normalizePhoneExt } from "./b2b-phone.server";
import { lookupPostalCode } from "./b2b-postal.server";
import {
  formatPhone,
  phoneExtensionNote,
  prepareRegistrationPayload,
  postalCodeError,
  registrationFieldError,
  resolveZoneCode,
  type B2bRegistrationPayload,
} from "./b2b-registration.server";

describe("address options", () => {
  test("lists every country with its dial code", () => {
    assert.ok(listCountries().length > 200);
    assert.equal(findCountry("us")?.phoneCode, "1");
    assert.equal(findCountry("GB")?.phoneCode, "44");
    // Territories share their parent's country code ("+1-684").
    assert.equal(findCountry("AS")?.phoneCode, "1");
  });

  test("offers only regions that have cities", () => {
    const us = listRegions("US").map((region) => region.code);
    assert.ok(us.includes("CA") && us.includes("DC"));
    assert.ok(!us.some((code) => code.startsWith("UM-")));

    // The UK lists nations and 200+ counties; only nations have cities.
    assert.ok(listRegions("GB").length < 10);
  });

  test("lists cities for a region, or the country when it has no regions", () => {
    assert.ok(listCities("US", "CA").includes("Los Angeles"));
    assert.deepEqual(listCities("US", "XX"), []);
  });
});

describe("addressAreaError", () => {
  test("accepts a country and state from the lists", () => {
    assert.equal(addressAreaError({ countryCode: "US", provinceCode: "CA" }), null);
  });

  test("rejects a country or state that isn't in the lists", () => {
    assert.equal(
      addressAreaError({ countryCode: "ZZ" }),
      "Select a valid country.",
    );
    assert.equal(
      addressAreaError({ countryCode: "US" }),
      "Select a valid state/province.",
    );
  });

  test("allows a country without regions", () => {
    const withoutRegions = listCountries().find(
      (country) => listRegions(country.code).length === 0,
    )!;
    assert.equal(addressAreaError({ countryCode: withoutRegions.code }), null);
  });
});

describe("typed city", () => {
  const registration: B2bRegistrationPayload = {
    firstName: "Tom",
    lastName: "Tester",
    email: "tom@identiphoto.test",
    companyName: "Identiphoto LLC",
    address1: "1810 Joseph Lloyd Pkwy",
    city: "Willoughby",
    provinceCode: "OH",
    countryCode: "US",
    zip: "44094",
  };

  test("a city missing from the suggestions is accepted", () => {
    // Jeromesville, OH has its own ZIP but isn't in the dataset's city list,
    // which the old dropdown limited customers to.
    assert.ok(!listCities("US", "OH").includes("Jeromesville"));
    const prepared = prepareRegistrationPayload({
      ...registration,
      city: "Jeromesville",
    });
    assert.ok(prepared.ok);
  });

  test("a city in another state than the one picked is accepted too", () => {
    assert.ok(
      prepareRegistrationPayload({ ...registration, provinceCode: "CA" }).ok,
    );
  });
});

describe("ZIP and postal code lookup", () => {
  test("a US ZIP gives its city and state", async () => {
    assert.deepEqual(await lookupPostalCode("US", "44094"), {
      city: "Willoughby",
      provinceCode: "OH",
    });
    assert.deepEqual(await lookupPostalCode("us", "10001-1234"), {
      city: "New York",
      provinceCode: "NY",
    });
  });

  test("a Canadian postal code gives its city and province", async () => {
    assert.deepEqual(await lookupPostalCode("CA", "m5v 2t6"), {
      city: "Toronto",
      provinceCode: "ON",
    });
    // A rural code whose town differs from the area's main one.
    assert.deepEqual(await lookupPostalCode("CA", "T0A 0A1"), {
      city: "Saddle Lake",
      provinceCode: "AB",
    });
    // Only the first three characters typed so far.
    assert.equal((await lookupPostalCode("CA", "H2X"))?.provinceCode, "QC");
  });

  test("unknown codes and other countries give nothing", async () => {
    assert.equal(await lookupPostalCode("US", "00000"), null);
    assert.equal(await lookupPostalCode("US", "4409"), null);
    assert.equal(await lookupPostalCode("GB", "SW1A 1AA"), null);
  });
});

describe("Shopify zone codes", () => {
  test("sends codes only for countries whose zones match the dataset", () => {
    assert.equal(shopifyZoneCode("US", "ca"), "CA");
    assert.equal(shopifyZoneCode("JP", "13"), "JP-13");
    assert.equal(shopifyZoneCode("JP", "JP-13"), "JP-13");
    assert.equal(shopifyZoneCode("GB", "ENG"), undefined);
    assert.equal(shopifyZoneCode("MX", "AGU"), undefined);
  });

  test("resolveZoneCode still maps US and Canadian names", () => {
    assert.equal(resolveZoneCode("New York", "US"), "NY");
    assert.equal(resolveZoneCode("Ontario", "CA"), "ON");
    assert.equal(resolveZoneCode("13", "JP"), "JP-13");
  });
});

describe("phone numbers", () => {
  test("validates against the chosen country's numbering plan", () => {
    assert.deepEqual(checkPhone("90 123 45 67", "UZ"), {
      valid: true,
      countryCode: "UZ",
      e164: "+998901234567",
      ext: "",
      national: "90 123 45 67",
      international: "+998 90 123 45 67",
    });
    assert.equal(checkPhone("12345", "UZ").valid, false);
    // A US-length number isn't a valid Uzbek one.
    assert.equal(checkPhone("212 555 0123", "UZ").valid, false);
  });

  test("checks numbers typed with + as international", () => {
    // The autofilled number from the bug report: +1 with an unassigned area code.
    assert.equal(checkPhone("+1 (676) 972-7557", "UZ").valid, false);

    const check = checkPhone("+1 (212) 555-0123", "UZ");
    assert.ok(check.valid);
    assert.equal(check.countryCode, "US");
    assert.equal(check.national, "(212) 555-0123");
  });

  test("formats valid numbers as E.164 for Shopify", () => {
    assert.equal(formatPhone("(212) 555-0123", "US"), "+12125550123");
    // The national trunk 0 is dropped after the country code.
    assert.equal(formatPhone("020 7946 0958", "GB"), "+442079460958");
    // Shopify rejects "+1… ext. 12" ("Phone is invalid"), so the extension
    // is left out of the phone and kept separately.
    assert.equal(formatPhone("212 555 0123 ext. 12", "US"), "+12125550123");
    // Numbers that don't validate are passed through as typed.
    assert.equal(formatPhone("12345", "US"), "12345");
  });

  test("formats the NetSuite phone with its extension", () => {
    assert.equal(netsuitePhone("+14405550100", "US", "214"), "440-555-0100 x214");
    assert.equal(netsuitePhone("(416) 555-0199", "CA", ""), "416-555-0199");
    assert.equal(netsuitePhone("020 7946 0958", "GB", "12"), "+44 20 7946 0958 x12");
    assert.equal(netsuitePhone("12345", "US", "9"), "12345 x9");
  });

  test("an extension typed after the number is split off", () => {
    for (const typed of ["(440) 555-0100 ext. 214", "440-555-0100 x214", "4405550100 ext 214"]) {
      const check = checkPhone(typed, "US");
      assert.ok(check.valid, typed);
      assert.equal(check.e164, "+14405550100");
      assert.equal(check.ext, "214");
    }
  });

  test("the extension field accepts digits only", () => {
    assert.equal(normalizePhoneExt(" 214 "), "214");
    assert.equal(normalizePhoneExt("ext. 214"), "214");
    assert.equal(normalizePhoneExt("x9"), "9");
    assert.equal(normalizePhoneExt("12a"), "");
    assert.equal(normalizePhoneExt("12345678901"), "");
    assert.equal(normalizePhoneExt(undefined), "");
  });

  test("the submitted phone is E.164 with the extension in phoneExt", () => {
    const base: B2bRegistrationPayload = {
      companyName: "Identiphoto LLC",
      address1: "1 Main St",
      city: "Willoughby",
      provinceCode: "OH",
      countryCode: "US",
      zip: "44094",
    };
    const typedTogether = prepareRegistrationPayload({
      ...base,
      phone: "(440) 555-0100 ext. 214",
    });
    assert.ok(typedTogether.ok);
    assert.equal(typedTogether.payload.phone, "+14405550100");
    assert.equal(typedTogether.payload.phoneExt, "214");

    const separateField = prepareRegistrationPayload({
      ...base,
      phone: "(440) 555-0100",
      phoneExt: "12",
    });
    assert.ok(separateField.ok);
    assert.equal(separateField.payload.phone, "+14405550100");
    assert.equal(separateField.payload.phoneExt, "12");
    assert.equal(
      phoneExtensionNote(separateField.payload),
      "Phone: +14405550100 ext. 12",
    );
    assert.equal(phoneExtensionNote({ ...base, phone: "(440) 555-0100" }), "");

    const invalid = prepareRegistrationPayload({ ...base, phone: "12345" });
    assert.ok(!invalid.ok);
    assert.equal(invalid.body.field, "phone");
  });

  test("dial codes come from the phone numbering data", () => {
    assert.equal(dialCode("VA"), "39");
    assert.equal(dialCode("AQ"), "");
  });
});

describe("registrationFieldError", () => {
  const valid: B2bRegistrationPayload = {
    firstName: "José",
    lastName: "O'Brien-Smith",
    email: "jose@acme.com",
    companyName: "Acme Supplies",
    address1: "12 Main St",
    city: "Toronto",
    countryCode: "CA",
    provinceCode: "ON",
    zip: "M5V 2T6",
  };

  test("accepts a typical registration", () => {
    assert.equal(registrationFieldError(valid), null);
  });

  test("names the field with the first problem", () => {
    const fieldOf = (change: Partial<B2bRegistrationPayload>) =>
      registrationFieldError({ ...valid, ...change })?.field;
    assert.equal(fieldOf({ firstName: "J0hn" }), "firstName");
    assert.equal(fieldOf({ lastName: "<script>" }), "lastName");
    assert.equal(fieldOf({ email: "jose@acme" }), "email");
    assert.equal(fieldOf({ companyName: "A" }), "companyName");
    assert.equal(fieldOf({ companyName: "LLC" }), "companyName");
    assert.equal(fieldOf({ address1: "--" }), "address1");
    assert.equal(fieldOf({ city: "123" }), "city");
    assert.equal(fieldOf({ zip: "12345" }), "zip");
  });

  test("checks postal codes by country", () => {
    assert.equal(postalCodeError("12345-6789", "US"), "");
    assert.notEqual(postalCodeError("1234", "US"), "");
    assert.equal(postalCodeError("K1A0B1", "CA"), "");
    assert.equal(postalCodeError("SW1A 1AA", "GB"), "");
    assert.notEqual(postalCodeError("#", "GB"), "");
  });
});
