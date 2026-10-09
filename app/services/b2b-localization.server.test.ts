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
import { checkPhone, dialCode } from "./b2b-phone.server";
import {
  formatPhone,
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
  test("accepts a country, state and city from the lists", () => {
    assert.equal(
      addressAreaError({
        countryCode: "US",
        provinceCode: "CA",
        city: "Los Angeles",
      }),
      null,
    );
  });

  test("rejects values that aren't in the lists", () => {
    assert.equal(
      addressAreaError({ countryCode: "ZZ", city: "Anywhere" }),
      "Select a valid country.",
    );
    assert.equal(
      addressAreaError({ countryCode: "US", city: "Los Angeles" }),
      "Select a valid state/province.",
    );
    assert.equal(
      addressAreaError({
        countryCode: "US",
        provinceCode: "CA",
        city: "Chicago",
      }),
      "Select a city from the list.",
    );
  });

  test("allows any city where the dataset has none", () => {
    const [region] = listRegions("HK");
    assert.deepEqual(listCities("HK", region.code), []);
    assert.equal(
      addressAreaError({
        countryCode: "HK",
        provinceCode: region.code,
        city: "Kowloon",
      }),
      null,
    );
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
      formatted: "+998901234567",
      national: "90 123 45 67",
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
    assert.equal(
      formatPhone("212 555 0123 ext. 12", "US"),
      "+12125550123 ext. 12",
    );
    // Numbers that don't validate are passed through as typed.
    assert.equal(formatPhone("12345", "US"), "12345");
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
