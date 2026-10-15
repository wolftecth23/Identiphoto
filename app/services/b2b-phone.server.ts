import {
  getCountryCallingCode,
  isSupportedCountry,
  parsePhoneNumberFromString,
} from "libphonenumber-js/max";

export type PhoneCheck =
  | { valid: false }
  | {
      valid: true;
      /** Country the number belongs to; differs from the chosen one when it was typed as +<code>…. */
      countryCode: string;
      /**
       * E.164 number without the extension, the only form Shopify accepts in
       * its phone fields.
       */
      e164: string;
      /** Extension typed after the number ("ext. 12", "x12"), or "". */
      ext: string;
      /** National format for showing back in the field, e.g. "(212) 555-0123". */
      national: string;
      /** International format, e.g. "+44 20 7946 0958". */
      international: string;
    };

/** Dial code for a country, or "" when there's no phone numbering data for it. */
export function dialCode(countryCode: string): string {
  const code = countryCode.trim().toUpperCase();
  return isSupportedCountry(code) ? getCountryCallingCode(code) : "";
}

/**
 * Validates a phone number against the chosen country's numbering plan. A
 * number typed with a leading "+" is checked as international instead, so an
 * autofilled "+1 …" isn't read as a local number of the chosen country.
 */
export function checkPhone(number: string, countryCode: string): PhoneCheck {
  const country = countryCode.trim().toUpperCase();
  const parsed = parsePhoneNumberFromString(
    number.trim(),
    isSupportedCountry(country) ? country : undefined,
  );
  if (!parsed?.isValid() || !parsed.country) return { valid: false };

  return {
    valid: true,
    countryCode: parsed.country,
    e164: parsed.number,
    ext: parsed.ext ?? "",
    national: parsed.formatNational(),
    international: parsed.formatInternational(),
  };
}

/**
 * Phone with its extension the way NetSuite keeps it in one field:
 * "440-555-0100 x214" for North American numbers, "+44 20 7946 0958 x12"
 * elsewhere. Numbers that don't validate are kept as typed.
 */
export function netsuitePhone(number: string, countryCode: string, ext: string): string {
  const check = checkPhone(number, countryCode);
  let main = number.trim();
  if (check.valid) {
    main = check.e164.startsWith("+1")
      ? check.e164.slice(2).replace(/^(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3")
      : check.international;
  }
  return ext ? `${main} x${ext}` : main;
}

/** Phone extension as typed in its own field: digits only, up to 10. */
export function normalizePhoneExt(ext: string | undefined): string {
  const trimmed = ext?.trim().replace(/^(ext\.?|x)\s*/i, "") ?? "";
  return /^\d{1,10}$/.test(trimmed) ? trimmed : "";
}
