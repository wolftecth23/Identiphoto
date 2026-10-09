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
      /** E.164 number, plus " ext. N" when an extension was given. */
      formatted: string;
      /** National format for showing back in the field, e.g. "(212) 555-0123". */
      national: string;
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
    formatted: parsed.ext
      ? `${parsed.number} ext. ${parsed.ext}`
      : parsed.number,
    national: parsed.formatNational(),
  };
}
