import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { addressAreaError, shopifyZoneCode } from "./b2b-localization.server";
import { checkPhone, netsuitePhone, normalizePhoneExt } from "./b2b-phone.server";
import {
  sendRegistrationEmail,
  mailerFromEnv,
  type Mailer,
} from "./b2b-registration-email.server";

export type B2bRegistrationPayload = {
  firstName?: string;
  lastName?: string;
  email?: string;
  companyName: string;
  phone?: string;
  /** Country whose dial code the phone uses; defaults to the address country. */
  phoneCountryCode?: string;
  /** Phone extension, digits only. Shopify phone fields can't hold one. */
  phoneExt?: string;
  address1: string;
  address2?: string;
  city: string;
  provinceCode?: string;
  countryCode: string;
  zip: string;
  /** Storefront locale the form was submitted from; picks the email language. */
  locale?: string;
  /**
   * The registrant's answer after the form showed them an existing company
   * that matches: join it, or register a new company anyway. Unset on the
   * first submit, which only asks.
   */
  companyChoice?: "join" | "new";
};

/** Why an existing company was offered to the registrant. */
export type CompanyMatchReason = "email_domain" | "company_name";

export type B2bRegistrationOptions = {
  /**
   * Sends the confirmation email. Defaults to the SMTP server in the
   * environment; null skips the email.
   */
  emailSender?: { mailer: Mailer; from: string } | null;
};

export type B2bRegistrationResult =
  | {
      ok: true;
      customerId: string;
      companyId: string;
      /** Name of the company the customer was linked to (existing or new). */
      companyName: string;
      /** True when a new company was created; false when an existing one was matched. */
      created: boolean;
      linked: boolean;
      /**
       * "pending" until a staff member approves the registration in the app;
       * only then does the contact get a role that lets them order.
       */
      status: RegistrationStatus;
      customerCreated?: boolean;
      alreadyLinked?: boolean;
      /** True when the registration confirmation email was handed to SMTP. */
      emailSent?: boolean;
    }
  | {
      ok: false;
      error: string;
      userErrors?: { field?: string[]; message: string }[];
      /**
       * COMPANY_MATCH: an existing company matches. Nothing was created; the
       * form asks the registrant and submits again with `companyChoice`.
       */
      code?: "COMPANY_MATCH";
      match?: {
        companyName: string;
        reason: CompanyMatchReason;
        /** The business email domain that matched, for the "email_domain" reason. */
        emailDomain?: string;
      };
    };

export type RegistrationStatus = "pending" | "approved";

/**
 * Customer tags that track a registration. Tags show in the Shopify admin,
 * can be searched, and are readable in Liquid (`customer.tags`), so the
 * storefront form can tell a signed-in customer their request is pending.
 */
export const REGISTRATION_TAGS = {
  pending: "b2b-registration-pending",
  approved: "b2b-registration-approved",
  rejected: "b2b-registration-rejected",
} as const;

export function isProtectedCustomerDataError(message: string): boolean {
  return (
    /not approved to access the Customer/i.test(message) ||
    /protected customer data/i.test(message)
  );
}

export function protectedCustomerDataHelpMessage(): string {
  return (
    "This app must be allowed to use protected customer data (name, email, phone, address) " +
    "in the Shopify Dev Dashboard before it can create customers. " +
    "Open your app → API access → Protected customer data → enable Level 2 and select the " +
    "customer fields this registration form uses, then reinstall the app on the store."
  );
}

export function normalizeCompanyName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

const COMPANY_NAME_MAX_LENGTH = 255;

/**
 * Legal-entity designators that do not distinguish one company from another.
 * Multi-word phrases are listed before their single-word tails so they are
 * stripped as a unit (e.g. "Pty Ltd", "Limited Liability Company").
 */
const LEGAL_SUFFIX_PHRASES: string[][] = [
  ["limited", "liability", "company"],
  ["limited", "liability", "partnership"],
  ["private", "limited"],
  ["pvt", "ltd"],
  ["pty", "ltd"],
  ["co", "ltd"],
  ...[
    "llc",
    "pllc",
    "llp",
    "lp",
    "inc",
    "incorporated",
    "ltd",
    "limited",
    "corp",
    "corporation",
    "co",
    "company",
    "plc",
    "pc",
    "pvt",
    "pty",
    "gmbh",
    "ag",
    "kg",
    "sa",
    "sas",
    "sarl",
    "srl",
    "spa",
    "bv",
    "nv",
    "oy",
    "ab",
  ].map((suffix) => [suffix]),
];

const LEGAL_SUFFIX_WORDS = new Set(LEGAL_SUFFIX_PHRASES.flat());

function companyNameTokens(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function endsWithPhrase(tokens: string[], phrase: string[]): boolean {
  if (tokens.length <= phrase.length) return false;
  const tail = tokens.slice(tokens.length - phrase.length);
  return tail.every((token, index) => token === phrase[index]);
}

/** Name tokens with legal suffixes, a trailing "and" and a leading "The" removed. */
function companyKeyTokens(name: string): string[] {
  const tokens = companyNameTokens(name);

  let stripped = true;
  while (stripped) {
    stripped = false;
    const phrase = LEGAL_SUFFIX_PHRASES.find((candidate) =>
      endsWithPhrase(tokens, candidate),
    );
    if (phrase) {
      tokens.splice(tokens.length - phrase.length, phrase.length);
      stripped = true;
    }
    if (tokens.length > 1 && tokens[tokens.length - 1] === "and") {
      tokens.pop();
      stripped = true;
    }
  }

  if (tokens.length > 1 && tokens[0] === "the") {
    tokens.shift();
  }

  return tokens;
}

/**
 * Reduces a company name to the part that identifies the business, so
 * "Nike", "Nike LLC", "NIKE, Inc." and "The Nike Company" share one key.
 */
export function companyMatchKey(name: string): string {
  // Joined without spaces so "Coca Cola" and "Coca-Cola" also match.
  return companyKeyTokens(name).join("");
}

/**
 * Key tokens with repeated letters collapsed and a plural "s" dropped, so
 * "Shiv Technolab", "Shiv Technolabs" and "shiv technolabssss" agree.
 */
function companySkeletonTokens(name: string): string[] {
  return companyKeyTokens(name).map((token) => {
    const collapsed = token.replace(/(.)\1+/gu, "$1");
    return collapsed.length > 3 && collapsed.endsWith("s")
      ? collapsed.slice(0, -1)
      : collapsed;
  });
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(
        above + 1,
        row[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return row[b.length];
}

/**
 * How closely an existing company name matches the one typed at
 * registration: lower is closer, null means a different business.
 */
export function companyNameMatchRank(
  typed: string,
  existing: string,
): number | null {
  if (normalizeCompanyName(typed) === normalizeCompanyName(existing)) return 0;
  if (companyMatchKey(typed) === companyMatchKey(existing)) return 1;

  const typedTokens = companySkeletonTokens(typed);
  const existingTokens = companySkeletonTokens(existing);
  if (typedTokens.join("") === existingTokens.join("")) return 2;

  // Tolerate a single-letter typo in one longer word ("Technolabz"). Short
  // words and first letters must agree so "Krishna Foods" / "Krishna Goods"
  // and "Kumar Plastics" / "Kumar Elastics" stay separate companies.
  if (typedTokens.length !== existingTokens.length) return null;
  const differing = typedTokens
    .map((token, index) => [token, existingTokens[index]] as const)
    .filter(([a, b]) => a !== b);
  if (differing.length !== 1) return null;
  const [a, b] = differing[0];
  if (Math.min(a.length, b.length) < 6 || a.slice(0, 2) !== b.slice(0, 2)) {
    return null;
  }
  return editDistance(a, b) === 1 ? 3 : null;
}

/**
 * Mailbox providers whose domain says nothing about where someone works, so
 * sharing one must not put two registrants in the same company.
 */
const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "protonmail.ch",
  "pm.me",
  "aim.com",
  "hushmail.com",
  "lycos.com",
  "usa.net",
  "zoho.com",
  "zohomail.com",
  "zohomail.in",
  "rediffmail.com",
  "rediff.com",
  "rocketmail.com",
  "mail.com",
  "email.com",
  "inbox.com",
  "fastmail.com",
  "hey.com",
  "tutanota.com",
  "tutanota.de",
  "tutamail.com",
  "tuta.com",
  "tuta.io",
  "duck.com",
  "web.de",
  "qq.com",
  "163.com",
  "126.com",
  "naver.com",
  "hanmail.net",
  "mail.ru",
  "comcast.net",
  "verizon.net",
  "att.net",
  "sbcglobal.net",
  "bellsouth.net",
  "cox.net",
  "charter.net",
  "earthlink.net",
  "optonline.net",
  "optimum.net",
  "rr.com",
  "roadrunner.com",
  "twc.com",
  "spectrum.net",
  "centurylink.net",
  "q.com",
  "frontier.com",
  "frontiernet.net",
  "windstream.net",
  "embarqmail.com",
  "juno.com",
  "netzero.net",
  "netzero.com",
  "mindspring.com",
  "prodigy.net",
  "suddenlink.net",
  "cableone.net",
  "mediacombb.net",
  // Canadian internet providers
  "sympatico.ca",
  "bell.net",
  "videotron.ca",
  "rogers.com",
  "shaw.ca",
  "telus.net",
  "cogeco.ca",
  // European internet providers
  "orange.fr",
  "wanadoo.fr",
  "free.fr",
  "sfr.fr",
  "laposte.net",
  "t-online.de",
  "freenet.de",
  "btinternet.com",
  "sky.com",
  "virginmedia.com",
  "libero.it",
  "seznam.cz",
  "wp.pl",
  "o2.pl",
]);

/** Providers that also run country domains such as yahoo.co.in or outlook.in. */
const PERSONAL_EMAIL_PROVIDER =
  /^(yahoo|ymail|hotmail|outlook|live|msn|aol|gmx|yandex)\.[a-z.]+$/;

/** Returns the email's domain when it can identify a business, otherwise null. */
export function businessEmailDomain(
  email: string | null | undefined,
): string | null {
  const match = email
    ?.trim()
    .toLowerCase()
    .match(/^[^@\s]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/);
  const domain = match?.[1];
  if (!domain) return null;
  if (
    PERSONAL_EMAIL_DOMAINS.has(domain) ||
    PERSONAL_EMAIL_PROVIDER.test(domain)
  ) {
    return null;
  }
  return domain;
}

/** Returns an error message, or null when the company name is acceptable. */
export function validateCompanyName(name: string | undefined): string | null {
  const trimmed = name?.trim().replace(/\s+/g, " ") ?? "";
  if (!trimmed) {
    return "Company name is required.";
  }
  if (trimmed.length > COMPANY_NAME_MAX_LENGTH) {
    return `Company name must be ${COMPANY_NAME_MAX_LENGTH} characters or fewer.`;
  }

  const tokens = companyNameTokens(trimmed);
  if (tokens.join("").length < 2) {
    return "Company name must contain at least 2 letters or numbers.";
  }
  if (
    tokens.every(
      (token) =>
        LEGAL_SUFFIX_WORDS.has(token) || token === "the" || token === "and",
    )
  ) {
    return 'Enter your company\'s name, not just its legal entity type (e.g. "LLC").';
  }

  return null;
}

/** Letters (any script), then letters, spaces, apostrophes, periods or hyphens. */
const PERSON_NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}\s'’.-]*$/u;
const PERSON_NAME_MAX_LENGTH = 100;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Postal code format for the country, or "" when it's fine. */
export function postalCodeError(zip: string, countryCode: string): string {
  const value = zip.trim();
  const country = countryCode.trim().toUpperCase();
  if (country === "US") {
    return /^\d{5}(-\d{4})?$/.test(value)
      ? ""
      : "Enter a valid ZIP code, like 12345 or 12345-6789.";
  }
  if (country === "CA") {
    return /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/.test(value)
      ? ""
      : "Enter a valid postal code, like K1A 0B1.";
  }
  return /^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$/.test(value)
    ? ""
    : "Please enter a valid postal code.";
}

/**
 * Basic checks on what the customer typed, matching the storefront form's.
 * Returns the first problem with the form field it belongs to.
 */
export function registrationFieldError(
  payload: B2bRegistrationPayload,
): { field: string; error: string } | null {
  const names = [
    ["firstName", payload.firstName, "first name"],
    ["lastName", payload.lastName, "last name"],
  ] as const;
  for (const [field, value, label] of names) {
    if (
      value !== undefined &&
      (value.length > PERSON_NAME_MAX_LENGTH || !PERSON_NAME_PATTERN.test(value))
    ) {
      return { field, error: `Please enter a valid ${label}.` };
    }
  }

  if (
    payload.email !== undefined &&
    (payload.email.length > 254 || !EMAIL_PATTERN.test(payload.email))
  ) {
    return {
      field: "email",
      error: "Enter a valid email address, like name@example.com.",
    };
  }

  const companyNameError = validateCompanyName(payload.companyName);
  if (companyNameError) {
    return { field: "companyName", error: companyNameError };
  }

  const address1 = payload.address1.trim();
  if (
    address1.length < 3 ||
    address1.length > 255 ||
    !/[\p{L}\p{N}]/u.test(address1)
  ) {
    return { field: "address1", error: "Please enter a valid street address." };
  }
  if ((payload.address2?.length ?? 0) > 255) {
    return { field: "address2", error: "Address lines are too long." };
  }

  const city = payload.city.trim();
  if (city.length > 255 || !/\p{L}/u.test(city)) {
    return { field: "city", error: "Please enter a valid city." };
  }

  const zipError = postalCodeError(payload.zip, payload.countryCode);
  if (zipError) return { field: "zip", error: zipError };

  return null;
}

/**
 * Serializes company lookup + creation within this process so two
 * simultaneous registrations for one business ("Nike" and "Nike LLC", or two
 * people at the same email domain) cannot both create a company. A single
 * queue is used because a name match and a domain match can point at the
 * same company from different keys; registrations are infrequent.
 */
let companyResolutionQueue: Promise<unknown> = Promise.resolve();

function withCompanyLock<T>(task: () => Promise<T>): Promise<T> {
  const current = companyResolutionQueue.catch(() => undefined).then(task);
  companyResolutionQueue = current;
  return current;
}

function escapeSearchTerm(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Phone in E.164 for Shopify, using the country's dial code for national
 * numbers. Any extension is dropped: Shopify rejects "+1… ext. 12" as an
 * invalid phone. Numbers that don't validate are passed through as typed.
 */
export function formatPhone(
  phone: string | undefined,
  countryCode: string,
): string | undefined {
  const trimmed = phone?.trim();
  if (!trimmed) return undefined;
  const check = checkPhone(trimmed, countryCode);
  return check.valid ? check.e164 : trimmed;
}

/**
 * "Phone: +1 212-555-0123 ext. 12" for the customer note, as customers have
 * no extension field. Empty without an extension.
 */
export function phoneExtensionNote(payload: B2bRegistrationPayload): string {
  const ext = normalizePhoneExt(payload.phoneExt);
  const phone = formatPhone(
    payload.phone,
    payload.phoneCountryCode || payload.countryCode,
  );
  return ext && phone ? `Phone: ${phone} ext. ${ext}` : "";
}

function customerGid(customerId: string): string {
  return `gid://shopify/Customer/${customerId}`;
}

const US_STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
};

const CA_PROVINCE_NAME_TO_CODE: Record<string, string> = {
  alberta: "AB",
  "british columbia": "BC",
  manitoba: "MB",
  "new brunswick": "NB",
  "newfoundland and labrador": "NL",
  "northwest territories": "NT",
  "nova scotia": "NS",
  nunavut: "NU",
  ontario: "ON",
  "prince edward island": "PE",
  quebec: "QC",
  saskatchewan: "SK",
  yukon: "YT",
};

/** Returns a valid region code for Shopify, or undefined to omit the field. */
export function resolveZoneCode(
  raw: string | undefined,
  countryCode: string,
): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;

  const country = countryCode.trim().toUpperCase();
  const compact = trimmed.replace(/\s+/g, " ");

  if (/^([A-Za-z]{2}-)?[A-Za-z0-9]{1,4}$/.test(compact)) {
    return shopifyZoneCode(country, compact);
  }

  const normalized = compact.toLowerCase();
  if (country === "US") {
    return US_STATE_NAME_TO_CODE[normalized];
  }
  if (country === "CA") {
    return CA_PROVINCE_NAME_TO_CODE[normalized];
  }

  return undefined;
}

function buildCustomerMailingAddress(
  payload: B2bRegistrationPayload,
  firstName: string | null | undefined,
  lastName: string | null | undefined,
) {
  const provinceCode = resolveZoneCode(
    payload.provinceCode,
    payload.countryCode,
  );

  return {
    address1: payload.address1,
    address2: payload.address2 || undefined,
    city: payload.city,
    ...(provinceCode ? { provinceCode } : {}),
    countryCode: payload.countryCode,
    zip: payload.zip,
    phone: formatPhone(payload.phone, payload.phoneCountryCode || payload.countryCode),
    firstName: firstName || undefined,
    lastName: lastName || undefined,
  };
}

function buildCompanyLocationAddress(
  payload: B2bRegistrationPayload,
  firstName: string | null | undefined,
  lastName: string | null | undefined,
) {
  const zoneCode = resolveZoneCode(payload.provinceCode, payload.countryCode);

  return {
    address1: payload.address1,
    address2: payload.address2 || undefined,
    city: payload.city,
    ...(zoneCode ? { zoneCode } : {}),
    countryCode: payload.countryCode,
    zip: payload.zip,
    phone: formatPhone(payload.phone, payload.phoneCountryCode || payload.countryCode),
    firstName: firstName || undefined,
    lastName: lastName || undefined,
  };
}

type GraphqlEnvelope = {
  errors?: { message: string }[];
};

export async function graphql<T>(
  admin: AdminApiContext,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  let response: Response;
  try {
    response = await admin.graphql(query, { variables });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Admin API request failed.";
    if (isProtectedCustomerDataError(message)) {
      throw new ProtectedCustomerDataAccessError(message);
    }
    throw new Error(message);
  }

  const json = (await response.json()) as T & GraphqlEnvelope;
  if (json.errors?.length) {
    const message = json.errors.map((entry) => entry.message).join(" ");
    if (isProtectedCustomerDataError(message)) {
      throw new ProtectedCustomerDataAccessError(message);
    }
    throw new Error(message);
  }

  return json;
}

export class ProtectedCustomerDataAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtectedCustomerDataAccessError";
  }
}

export function pickContactRoleId(company: {
  defaultRole?: { id: string } | null;
  contactRoles?: { nodes: { id: string; name: string }[] };
}): string | undefined {
  if (company.defaultRole?.id) {
    return company.defaultRole.id;
  }

  const roles = company.contactRoles?.nodes ?? [];
  const preferred = roles.find((role) => /order|buy|purch/i.test(role.name));
  return preferred?.id ?? roles[0]?.id;
}

type UserError = { field?: string[] | null; message: string };

/** Adds or removes customer tags. Returns the user errors, if any. */
export async function updateCustomerTags(
  admin: AdminApiContext,
  customerId: string,
  change: { add?: string[]; remove?: string[] },
): Promise<UserError[]> {
  type TagsResult = {
    data?: {
      tagsAdd?: { userErrors: UserError[] };
      tagsRemove?: { userErrors: UserError[] };
    };
  };

  const errors: UserError[] = [];
  if (change.remove?.length) {
    const result = await graphql<TagsResult>(
      admin,
      `
        #graphql
        mutation B2bRegistrationUntagCustomer($id: ID!, $tags: [String!]!) {
          tagsRemove(id: $id, tags: $tags) {
            userErrors {
              field
              message
            }
          }
        }
      `,
      { id: customerId, tags: change.remove },
    );
    errors.push(...(result.data?.tagsRemove?.userErrors ?? []));
  }
  if (change.add?.length) {
    const result = await graphql<TagsResult>(
      admin,
      `
        #graphql
        mutation B2bRegistrationTagCustomer($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            userErrors {
              field
              message
            }
          }
        }
      `,
      { id: customerId, tags: change.add },
    );
    errors.push(...(result.data?.tagsAdd?.userErrors ?? []));
  }
  return errors;
}

/**
 * Company metafields the merchant defined in the admin (Settings → Custom
 * data → Companies), found by their names so their namespace/key don't need
 * configuring. Missing definitions are simply not written.
 */
export const COMPANY_FIELD_NAMES = {
  status: "B2B account status",
  approvedBy: "Approved by",
  approvedOn: "Approved on",
  phoneExtension: "Phone extension",
  netsuitePhone: "NetSuite phone",
} as const;

/**
 * Phone fields the app defines itself when missing. They go in the merchant's
 * "custom" namespace, not the app's, so the NetSuite connector can read them.
 */
const COMPANY_PHONE_FIELDS = {
  phoneExtension: {
    key: "phone_extension",
    description: "Extension of the company phone, digits only.",
  },
  netsuitePhone: {
    key: "netsuite_phone",
    description:
      "Company phone with its extension in the form NetSuite takes, e.g. 440-555-0100 x214.",
  },
} as const;

type CompanyFieldDefinition = {
  namespace: string;
  key: string;
  type: string;
  choices: string[];
};

type MetafieldsSetInput = {
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
};

export type CompanyFieldDefinitions = Partial<
  Record<keyof typeof COMPANY_FIELD_NAMES, CompanyFieldDefinition>
>;

export async function companyFieldDefinitions(
  admin: AdminApiContext,
): Promise<CompanyFieldDefinitions> {
  type DefinitionsQuery = {
    data?: {
      metafieldDefinitions?: {
        nodes: {
          name: string;
          namespace: string;
          key: string;
          type: { name: string };
          validations: { name: string; value?: string | null }[];
        }[];
      };
    };
  };

  const data = await graphql<DefinitionsQuery>(
    admin,
    `
      #graphql
      query B2bRegistrationCompanyFieldDefinitions {
        metafieldDefinitions(ownerType: COMPANY, first: 100) {
          nodes {
            name
            namespace
            key
            type {
              name
            }
            validations {
              name
              value
            }
          }
        }
      }
    `,
  );

  const nodes = data.data?.metafieldDefinitions?.nodes ?? [];
  const definitions: CompanyFieldDefinitions = {};
  for (const [field, name] of Object.entries(COMPANY_FIELD_NAMES) as [
    keyof typeof COMPANY_FIELD_NAMES,
    string,
  ][]) {
    const node = nodes.find(
      (entry) => entry.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (!node) continue;
    let choices: string[] = [];
    const choicesRule = node.validations.find((rule) => rule.name === "choices");
    try {
      const parsed = JSON.parse(choicesRule?.value ?? "[]");
      if (Array.isArray(parsed)) choices = parsed.map(String);
    } catch {
      choices = [];
    }
    definitions[field] = {
      namespace: node.namespace,
      key: node.key,
      type: node.type.name,
      choices,
    };
  }
  return definitions;
}

const STATUS_LABELS: Record<RegistrationStatus | "rejected", string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
};

/**
 * The value to store for a status: the definition's own choice when it
 * limits the values (e.g. "Pending approval"), else "Pending"/"Approved"/….
 */
export function companyStatusValue(
  definition: CompanyFieldDefinition,
  status: RegistrationStatus | "rejected",
): string {
  const stems = {
    pending: /pend|await|review/i,
    approved: /approv|activ/i,
    rejected: /reject|declin|denied/i,
  };
  const matches = definition.choices.filter((choice) => stems[status].test(choice));
  // "Pending approval" mentions approval but is the pending choice.
  const others = (Object.keys(stems) as (keyof typeof stems)[]).filter(
    (other) => other !== status,
  );
  return (
    matches.find((choice) => !others.some((other) => stems[other].test(choice))) ??
    matches[0] ??
    STATUS_LABELS[status]
  );
}

/**
 * Writes the company's "B2B account status" (and, on approval, "Approved by"
 * and "Approved on") metafields. Best effort: the registration itself is
 * tracked with customer tags, so a missing or differently typed definition
 * only means the admin field stays empty.
 */
export async function setCompanyStatusFields(
  admin: AdminApiContext,
  companyId: string,
  status: RegistrationStatus | "rejected",
  approval?: { by: string; on: Date },
): Promise<void> {
  try {
    const definitions = await companyFieldDefinitions(admin);
    const metafields: MetafieldsSetInput[] = [];
    const add = (definition: CompanyFieldDefinition | undefined, value: string) => {
      if (definition && value) {
        metafields.push({
          ownerId: companyId,
          namespace: definition.namespace,
          key: definition.key,
          type: definition.type,
          value,
        });
      }
    };

    if (definitions.status?.type.endsWith("text_field")) {
      add(definitions.status, companyStatusValue(definitions.status, status));
    }
    if (approval) {
      if (definitions.approvedBy?.type.endsWith("text_field")) {
        add(definitions.approvedBy, approval.by.trim());
      }
      const approvedOn = definitions.approvedOn;
      if (approvedOn) {
        const iso = approval.on.toISOString();
        add(
          approvedOn,
          approvedOn.type === "date_time" ? iso : iso.slice(0, 10),
        );
      }
    }
    if (!metafields.length) return;

    type SetResult = {
      data?: { metafieldsSet?: { userErrors: UserError[] } };
    };
    const result = await graphql<SetResult>(
      admin,
      `
        #graphql
        mutation B2bRegistrationSetCompanyFields(
          $metafields: [MetafieldsSetInput!]!
        ) {
          metafieldsSet(metafields: $metafields) {
            userErrors {
              field
              message
            }
          }
        }
      `,
      { metafields },
    );
    const errors = result.data?.metafieldsSet?.userErrors ?? [];
    if (errors.length) {
      console.warn("B2B company status fields not saved", errors);
    }
  } catch (error) {
    console.warn("B2B company status fields not saved", error);
  }
}

/**
 * Creates a missing phone field in the "custom" namespace. A definition that
 * already holds the key under another name is used as is.
 */
async function createCompanyPhoneField(
  admin: AdminApiContext,
  field: keyof typeof COMPANY_PHONE_FIELDS,
): Promise<CompanyFieldDefinition | undefined> {
  const { key, description } = COMPANY_PHONE_FIELDS[field];
  const definition: CompanyFieldDefinition = {
    namespace: "custom",
    key,
    type: "single_line_text_field",
    choices: [],
  };

  type CreateResult = {
    data?: {
      metafieldDefinitionCreate?: {
        userErrors: (UserError & { code?: string | null })[];
      };
    };
  };
  const result = await graphql<CreateResult>(
    admin,
    `
      #graphql
      mutation B2bRegistrationCreateCompanyField(
        $definition: MetafieldDefinitionInput!
      ) {
        metafieldDefinitionCreate(definition: $definition) {
          userErrors {
            field
            message
            code
          }
        }
      }
    `,
    {
      definition: {
        name: COMPANY_FIELD_NAMES[field],
        namespace: definition.namespace,
        key,
        description,
        type: definition.type,
        ownerType: "COMPANY",
        pin: true,
      },
    },
  );
  const errors = result.data?.metafieldDefinitionCreate?.userErrors ?? [];
  if (errors.length && !errors.every((error) => error.code === "TAKEN")) {
    console.warn(`B2B company field "${COMPANY_FIELD_NAMES[field]}" not created`, errors);
    return undefined;
  }
  return definition;
}

/**
 * Writes the new company's "Phone extension" and "NetSuite phone" fields,
 * creating their definitions the first time. The location phone can't hold
 * an extension, so these are what the NetSuite connector maps. Best effort,
 * like the status fields.
 */
export async function setCompanyPhoneFields(
  admin: AdminApiContext,
  companyId: string,
  payload: B2bRegistrationPayload,
): Promise<void> {
  const phone = payload.phone?.trim();
  if (!phone) return;
  const ext = normalizePhoneExt(payload.phoneExt);
  const values = {
    phoneExtension: ext,
    netsuitePhone: netsuitePhone(
      phone,
      payload.phoneCountryCode || payload.countryCode,
      ext,
    ),
  };

  try {
    const definitions = await companyFieldDefinitions(admin);
    const metafields: MetafieldsSetInput[] = [];
    for (const field of Object.keys(COMPANY_PHONE_FIELDS) as (keyof typeof COMPANY_PHONE_FIELDS)[]) {
      if (!values[field]) continue;
      const definition =
        definitions[field] ?? (await createCompanyPhoneField(admin, field));
      if (!definition?.type.endsWith("text_field")) continue;
      metafields.push({
        ownerId: companyId,
        namespace: definition.namespace,
        key: definition.key,
        type: definition.type,
        value: values[field],
      });
    }
    if (!metafields.length) return;

    type SetResult = {
      data?: { metafieldsSet?: { userErrors: UserError[] } };
    };
    const result = await graphql<SetResult>(
      admin,
      `
        #graphql
        mutation B2bRegistrationSetCompanyFields(
          $metafields: [MetafieldsSetInput!]!
        ) {
          metafieldsSet(metafields: $metafields) {
            userErrors {
              field
              message
            }
          }
        }
      `,
      { metafields },
    );
    const errors = result.data?.metafieldsSet?.userErrors ?? [];
    if (errors.length) {
      console.warn("B2B company phone fields not saved", errors);
    }
  } catch (error) {
    console.warn("B2B company phone fields not saved", error);
  }
}

type CompanySummary = { id: string; name: string; createdAt: string };

type RankedCompany = { company: CompanySummary; rank: number };

function byRankThenAge(a: RankedCompany, b: RankedCompany): number {
  return (
    a.rank - b.rank || a.company.createdAt.localeCompare(b.company.createdAt)
  );
}

/**
 * Lists existing companies whose name matches `companyName` once legal
 * suffixes, punctuation, casing, repeated letters, plurals and small typos
 * are ignored, closest name first and then oldest. Combines a name-prefix
 * search with the most recently created companies, because the search index
 * can lag a few seconds behind `companyCreate`; those recent companies are
 * returned too, newest first.
 */
async function findCompaniesByName(
  admin: AdminApiContext,
  companyName: string,
): Promise<{ nameMatches: RankedCompany[]; recent: CompanySummary[] }> {
  const targetKey = companyMatchKey(companyName);
  const firstToken = companyNameTokens(companyName).find(
    (token) => token !== "the",
  );
  // Also search by the key's first letters so "ShivTechnolabs" (one word)
  // still finds "Shiv Technolabs".
  const prefixes = new Set(
    [firstToken, targetKey.slice(0, 4)].filter((prefix): prefix is string =>
      Boolean(prefix),
    ),
  );

  type CompaniesQuery = {
    data?: {
      byName?: { nodes: CompanySummary[] };
      recent?: { nodes: CompanySummary[] };
    };
  };

  const companiesData = await graphql<CompaniesQuery>(
    admin,
    `
      #graphql
      query B2bRegistrationFindCompanies($query: String!) {
        byName: companies(first: 100, query: $query, sortKey: CREATED_AT) {
          nodes {
            id
            name
            createdAt
          }
        }
        recent: companies(first: 50, sortKey: CREATED_AT, reverse: true) {
          nodes {
            id
            name
            createdAt
          }
        }
      }
    `,
    {
      query: [...prefixes].map((prefix) => `name:${prefix}*`).join(" OR "),
    },
  );

  const recent = companiesData.data?.recent?.nodes ?? [];
  const candidates = new Map<string, RankedCompany>();
  for (const company of [
    ...(companiesData.data?.byName?.nodes ?? []),
    ...recent,
  ]) {
    const rank = companyNameMatchRank(companyName, company.name);
    if (rank !== null) {
      candidates.set(company.id, { company, rank });
    }
  }

  return { nameMatches: [...candidates.values()].sort(byRankThenAge), recent };
}

function hasEmailAtDomain(
  email: string | null | undefined,
  domain: string,
): boolean {
  return Boolean(email?.toLowerCase().endsWith(`@${domain}`));
}

/**
 * Companies that customers with an email at `domain` are contacts of, found
 * through customer search so it also covers companies with many contacts.
 */
async function findCompaniesByEmailDomain(
  admin: AdminApiContext,
  domain: string,
): Promise<Map<string, CompanySummary>> {
  type CustomersQuery = {
    data?: {
      customers?: {
        nodes: {
          defaultEmailAddress?: { emailAddress?: string | null } | null;
          companyContactProfiles: { company: CompanySummary }[];
        }[];
      };
    };
  };

  const data = await graphql<CustomersQuery>(
    admin,
    `
      #graphql
      query B2bRegistrationCustomersByEmailDomain($query: String!) {
        customers(first: 100, query: $query, sortKey: CREATED_AT) {
          nodes {
            defaultEmailAddress {
              emailAddress
            }
            companyContactProfiles {
              company {
                id
                name
                createdAt
              }
            }
          }
        }
      }
    `,
    { query: `email:"${escapeSearchTerm(domain)}"` },
  );

  const companies = new Map<string, CompanySummary>();
  for (const customer of data.data?.customers?.nodes ?? []) {
    // The email filter is tokenized, so confirm the domain matches exactly.
    if (!hasEmailAtDomain(customer.defaultEmailAddress?.emailAddress, domain)) {
      continue;
    }
    for (const { company } of customer.companyContactProfiles) {
      companies.set(company.id, company);
    }
  }
  return companies;
}

/**
 * Of `companyIds`, returns those with a contact whose email is at `domain`,
 * read straight from each company so contacts added seconds ago (not yet in
 * the customer search index) still count. Only the newest contacts are read:
 * older ones are already found through customer search.
 */
async function companiesWithContactAtDomain(
  admin: AdminApiContext,
  companyIds: string[],
  domain: string,
): Promise<Set<string>> {
  if (companyIds.length === 0) return new Set();

  type ContactsQuery = {
    data?: {
      nodes: ({
        id?: string;
        contacts?: {
          nodes: {
            customer?: {
              defaultEmailAddress?: { emailAddress?: string | null } | null;
            } | null;
          }[];
        };
      } | null)[];
    };
  };

  const data = await graphql<ContactsQuery>(
    admin,
    `
      #graphql
      query B2bRegistrationCompanyContactEmails($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Company {
            id
            contacts(first: 20, sortKey: CREATED_AT, reverse: true) {
              nodes {
                customer {
                  defaultEmailAddress {
                    emailAddress
                  }
                }
              }
            }
          }
        }
      }
    `,
    { ids: companyIds },
  );

  const matched = new Set<string>();
  for (const company of data.data?.nodes ?? []) {
    if (!company?.id) continue;
    const contactAtDomain = company.contacts?.nodes.some((contact) =>
      hasEmailAtDomain(
        contact.customer?.defaultEmailAddress?.emailAddress,
        domain,
      ),
    );
    if (contactAtDomain) matched.add(company.id);
  }
  return matched;
}

/** How many name matches have their contacts' emails checked directly. */
const MAX_NAME_MATCHES_TO_VERIFY = 5;

/**
 * How many of the newest companies have their contacts' emails checked
 * directly, covering contacts the customer search index has not caught up on.
 */
const MAX_RECENT_COMPANIES_TO_VERIFY = 5;

/**
 * Highest `companyNameMatchRank` that counts as the same name: identical
 * apart from casing, punctuation and legal suffixes ("Nike" / "Nike LLC").
 */
const SAME_NAME_RANK = 1;

/** Sorts domain matches whose name differs from the typed one last. */
const UNRELATED_NAME_RANK = Number.MAX_SAFE_INTEGER;

/**
 * Of the companies with a contact at `emailDomain`, returns the one whose name
 * is closest to `companyName`, then the oldest; null when there are none.
 */
async function findCompanyByEmailDomain(
  admin: AdminApiContext,
  companyName: string,
  emailDomain: string,
  nameMatches: RankedCompany[],
  recent: CompanySummary[],
): Promise<CompanySummary | null> {
  const domainCompanies = await findCompaniesByEmailDomain(admin, emailDomain);

  const unverified = new Map<string, CompanySummary>();
  for (const company of [
    ...nameMatches
      .slice(0, MAX_NAME_MATCHES_TO_VERIFY)
      .map(({ company }) => company),
    ...recent.slice(0, MAX_RECENT_COMPANIES_TO_VERIFY),
  ]) {
    if (!domainCompanies.has(company.id)) unverified.set(company.id, company);
  }
  const verifiedIds = await companiesWithContactAtDomain(
    admin,
    [...unverified.keys()],
    emailDomain,
  );
  for (const id of verifiedIds) {
    domainCompanies.set(id, unverified.get(id)!);
  }

  const ranked = [...domainCompanies.values()]
    .map((company) => ({
      company,
      rank:
        companyNameMatchRank(companyName, company.name) ?? UNRELATED_NAME_RANK,
    }))
    .sort(byRankThenAge);
  return ranked[0]?.company ?? null;
}

/**
 * Finds the existing company this registrant belongs to. The company name and
 * the business email domain each identify a company on their own:
 *
 * - A company with a contact at the registrant's business email domain is
 *   used whatever name was typed, so ronak@shivlab.com joins the company
 *   karan@shivlab.com belongs to even when typing "Acme". If several
 *   companies share the domain, the closest name and then the oldest wins.
 * - Otherwise the same name ("Nike LLC" for "Nike") is used. Personal
 *   mailboxes (gmail.com, ...) never match by domain, only by name.
 */
async function findMatchingCompany(
  admin: AdminApiContext,
  companyName: string,
  emailDomain: string | null,
): Promise<{ company: CompanySummary; reason: CompanyMatchReason } | null> {
  const { nameMatches, recent } = await findCompaniesByName(
    admin,
    companyName,
  );

  if (emailDomain) {
    const domainCompany = await findCompanyByEmailDomain(
      admin,
      companyName,
      emailDomain,
      nameMatches,
      recent,
    );
    if (domainCompany) return { company: domainCompany, reason: "email_domain" };
  }

  const byName = nameMatches.find(({ rank }) => rank <= SAME_NAME_RANK)?.company;
  return byName ? { company: byName, reason: "company_name" } : null;
}

/**
 * Emails the customer that registration succeeded. Failures are logged and
 * reported as false: the account and company are already saved by then.
 */
async function sendRegistrationConfirmation(
  admin: AdminApiContext,
  sender: { mailer: Mailer; from: string } | null,
  details: {
    to: string | null | undefined;
    firstName: string | null | undefined;
    companyName: string;
    created: boolean;
    locale: string | undefined;
  },
): Promise<boolean> {
  if (!sender) {
    console.warn("B2B registration email skipped: email sending is not set up (MS_* or SMTP_HOST).");
    return false;
  }
  if (!details.to) {
    console.warn("B2B registration email skipped: customer has no email.");
    return false;
  }

  try {
    type ShopQuery = {
      data?: {
        shop?: { name: string; primaryDomain: { url: string } };
      };
    };

    const shopData = await graphql<ShopQuery>(
      admin,
      `
        #graphql
        query B2bRegistrationEmailShop {
          shop {
            name
            primaryDomain {
              url
            }
          }
        }
      `,
    );
    const shop = shopData.data?.shop;
    if (!shop) throw new Error("Shop details unavailable.");

    await sendRegistrationEmail(sender, {
      to: details.to,
      firstName: details.firstName,
      companyName: details.companyName,
      created: details.created,
      shopName: shop.name,
      storeUrl: shop.primaryDomain.url,
      locale: details.locale,
    });
    return true;
  } catch (error) {
    console.error("B2B registration email failed", error);
    return false;
  }
}

export async function linkCustomerToB2bCompany(
  admin: AdminApiContext,
  customerId: string,
  payload: B2bRegistrationPayload,
  options: B2bRegistrationOptions = {},
): Promise<B2bRegistrationResult> {
  const customerIdNumeric = customerId.replace(/\D/g, "") || customerId;
  const companyNameError = validateCompanyName(payload.companyName);
  if (companyNameError) {
    return { ok: false, error: companyNameError };
  }
  const companyName = payload.companyName.trim().replace(/\s+/g, " ");
  if (
    !payload.address1?.trim() ||
    !payload.city?.trim() ||
    !payload.countryCode?.trim()
  ) {
    return { ok: false, error: "Address, city, and country are required." };
  }
  if (!payload.zip?.trim()) {
    return { ok: false, error: "Zip/postal code is required." };
  }

  const gid = customerGid(customerIdNumeric);

  type CustomerQuery = {
    data?: {
      customer?: {
        id: string;
        firstName?: string | null;
        lastName?: string | null;
        email?: string | null;
        tags: string[];
        companyContactProfiles: { company: { id: string } }[];
      } | null;
    };
  };

  const customerData = await graphql<CustomerQuery>(
    admin,
    `
      #graphql
      query B2bRegistrationCustomer($id: ID!) {
        customer(id: $id) {
          id
          firstName
          lastName
          email
          tags
          companyContactProfiles {
            company {
              id
            }
          }
        }
      }
    `,
    { id: gid },
  );

  const customer = customerData.data?.customer;
  if (!customer) {
    return { ok: false, error: "Customer not found." };
  }

  type CompanyCreateResult = {
    data?: {
      companyCreate?: {
        company?: { id: string; name: string };
        userErrors: { field?: string[]; message: string }[];
      };
    };
  };

  // A business email domain already used by a company's contact puts the
  // customer in that company regardless of the name typed. Personal mailboxes
  // (gmail.com, ...) say nothing about the employer, so they only match by name.
  const emailDomain = businessEmailDomain(customer.email ?? payload.email);

  type AssignContactResult = {
    data?: {
      companyAssignCustomerAsContact?: {
        companyContact?: { id: string } | null;
        userErrors: { field?: string[]; message: string }[];
      };
    };
  };

  // The customer becomes a contact without a role at any location, so they
  // can't order as the company until a staff member approves them in the app
  // (which assigns the role).
  const assignContact = async (
    companyId: string,
  ): Promise<{ ok: true } | Extract<B2bRegistrationResult, { ok: false }>> => {
    const assignResult = await graphql<AssignContactResult>(
      admin,
      `
        #graphql
        mutation B2bRegistrationAssignContact($companyId: ID!, $customerId: ID!) {
          companyAssignCustomerAsContact(
            companyId: $companyId
            customerId: $customerId
          ) {
            companyContact {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      { companyId, customerId: gid },
    );

    const assignErrors =
      assignResult.data?.companyAssignCustomerAsContact?.userErrors ?? [];
    if (
      assignErrors.length > 0 ||
      !assignResult.data?.companyAssignCustomerAsContact?.companyContact
    ) {
      return {
        ok: false,
        error: "Could not link customer to company.",
        userErrors: assignErrors,
      };
    }
    return { ok: true };
  };

  const resolution = await withCompanyLock(
    async (): Promise<
      | { ok: true; company: { id: string; name: string }; created: boolean }
      | Extract<B2bRegistrationResult, { ok: false }>
    > => {
      // "new": the registrant saw the matching company and chose not to join.
      const existing =
        payload.companyChoice === "new"
          ? null
          : await findMatchingCompany(admin, companyName, emailDomain);
      if (existing) {
        return { ok: true, company: existing.company, created: false };
      }

      const locationName = payload.city.trim() || companyName.slice(0, 255);

      const createResult = await graphql<CompanyCreateResult>(
        admin,
        `
          #graphql
          mutation B2bRegistrationCompanyCreate($input: CompanyCreateInput!) {
            companyCreate(input: $input) {
              company {
                id
                name
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        {
          input: {
            company: { name: companyName },
            companyLocation: {
              name: locationName,
              shippingAddress: buildCompanyLocationAddress(
                payload,
                customer.firstName,
                customer.lastName,
              ),
              // Without a billing address, B2B orders (and their confirmation
              // emails) have none either (testing feedback #7).
              billingSameAsShipping: true,
              phone: formatPhone(payload.phone, payload.phoneCountryCode || payload.countryCode),
            },
          },
        },
      );

      const createErrors = createResult.data?.companyCreate?.userErrors ?? [];
      const createdCompany = createResult.data?.companyCreate?.company;
      if (createErrors.length > 0 || !createdCompany) {
        return {
          ok: false,
          error: "Could not create company.",
          userErrors: createErrors,
        };
      }

      // Inside the lock: a colleague registering at the same moment finds
      // this company through its contact's email domain.
      const assigned = await assignContact(createdCompany.id);
      if (!assigned.ok) return assigned;

      return { ok: true, company: createdCompany, created: true };
    },
  );

  if (!resolution.ok) {
    return resolution;
  }

  const companyId = resolution.company.id;
  const resolvedCompanyName = resolution.company.name;
  const created = resolution.created;

  if (created) {
    await setCompanyStatusFields(admin, companyId, "pending");
    await setCompanyPhoneFields(admin, companyId, payload);
  }

  type CustomerUpdateResult = {
    data?: {
      customerUpdate?: {
        userErrors: { field?: string[]; message: string }[];
      };
    };
  };

  const addressInput = buildCustomerMailingAddress(
    payload,
    customer.firstName,
    customer.lastName,
  );

  // Store the canonical company name ("Nike LLC"), not what was typed ("Nike").
  const updateResult = await graphql<CustomerUpdateResult>(
    admin,
    `
      #graphql
      mutation B2bRegistrationCustomerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      input: {
        id: gid,
        addresses: [
          {
            ...addressInput,
            company: resolvedCompanyName,
          },
        ],
      },
    },
  );

  const updateErrors = updateResult.data?.customerUpdate?.userErrors ?? [];
  if (updateErrors.length > 0) {
    return {
      ok: false,
      error: "Could not update customer address.",
      userErrors: updateErrors,
    };
  }

  const alreadyOnCompany = customer.companyContactProfiles.some(
    (profile) => profile.company.id === companyId,
  );

  if (alreadyOnCompany) {
    return {
      ok: true,
      customerId: customerIdNumeric,
      companyId,
      companyName: resolvedCompanyName,
      created: false,
      linked: true,
      alreadyLinked: true,
      status: customer.tags.includes(REGISTRATION_TAGS.pending)
        ? "pending"
        : "approved",
    };
  }

  if (!created) {
    const assigned = await assignContact(companyId);
    if (!assigned.ok) return assigned;
  }

  const tagErrors = await updateCustomerTags(admin, gid, {
    add: [REGISTRATION_TAGS.pending],
    remove: [REGISTRATION_TAGS.rejected],
  });
  if (tagErrors.length) {
    console.warn("B2B registration pending tag not saved", tagErrors);
  }

  const emailSent = await sendRegistrationConfirmation(
    admin,
    options.emailSender === undefined
      ? mailerFromEnv()
      : options.emailSender,
    {
      to: customer.email ?? payload.email,
      firstName: customer.firstName ?? payload.firstName,
      companyName: resolvedCompanyName,
      created,
      locale: payload.locale,
    },
  );

  return {
    ok: true,
    customerId: customerIdNumeric,
    companyId,
    companyName: resolvedCompanyName,
    created,
    linked: true,
    status: "pending",
    emailSent,
  };
}

async function findCustomerIdByEmail(
  admin: AdminApiContext,
  email: string,
): Promise<string | null> {
  type CustomersQuery = {
    data?: {
      customers?: {
        nodes: { id: string; email?: string | null }[];
      };
    };
  };

  const data = await graphql<CustomersQuery>(
    admin,
    `
      #graphql
      query B2bRegistrationFindCustomer($query: String!) {
        customers(first: 1, query: $query) {
          nodes {
            id
            email
          }
        }
      }
    `,
    { query: `email:"${escapeSearchTerm(email)}"` },
  );

  const node = data.data?.customers?.nodes?.[0];
  return node?.id?.replace("gid://shopify/Customer/", "") ?? null;
}

async function createStorefrontCustomer(
  admin: AdminApiContext,
  payload: B2bRegistrationPayload,
): Promise<
  | { ok: true; customerId: string }
  | {
      ok: false;
      error: string;
      userErrors?: { field?: string[]; message: string }[];
    }
> {
  const firstName = payload.firstName?.trim();
  const lastName = payload.lastName?.trim();
  const email = payload.email?.trim().toLowerCase();

  if (!firstName || !lastName || !email) {
    return {
      ok: false,
      error: "First name, last name, and email are required.",
    };
  }

  const existingId = await findCustomerIdByEmail(admin, email);
  if (existingId) {
    return {
      ok: false,
      error:
        "An account with this email already exists. Sign in to your account, then submit this form again.",
    };
  }

  type CustomerCreateResult = {
    data?: {
      customerCreate?: {
        customer?: { id: string };
        userErrors: { field?: string[]; message: string }[];
      };
    };
  };

  const companyName = payload.companyName.trim();
  const extensionNote = phoneExtensionNote(payload);
  const createResult = await graphql<CustomerCreateResult>(
    admin,
    `
      #graphql
      mutation B2bRegistrationCustomerCreate($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      input: {
        firstName,
        lastName,
        email,
        // The form asks for the company's phone, so it goes on the address
        // only. A customer's own phone must be unique in Shopify, and a
        // colleague who registered first may already have this number.
        ...(extensionNote ? { note: extensionNote } : {}),
        // The storefront language, so the approval email (and Shopify's own
        // customer emails) use it too.
        ...(payload.locale ? { locale: payload.locale } : {}),
        addresses: [
          {
            ...buildCustomerMailingAddress(payload, firstName, lastName),
            company: companyName,
          },
        ],
      },
    },
  );

  const userErrors = createResult.data?.customerCreate?.userErrors ?? [];
  const customer = createResult.data?.customerCreate?.customer;
  if (userErrors.length > 0 || !customer) {
    return {
      ok: false,
      error: "Could not create customer account.",
      userErrors,
    };
  }

  return {
    ok: true,
    customerId: customer.id.replace("gid://shopify/Customer/", ""),
  };
}

export type RegistrationCustomer = {
  firstName: string;
  lastName: string;
  email: string;
  countryCode: string;
  provinceCode: string;
  city: string;
  /** Name of the first company the customer is a contact of, if any. */
  companyName: string | null;
  /** True while staff haven't approved the customer's registration yet. */
  registrationPending: boolean;
};

/** Loads what the storefront registration page needs about a signed-in customer. */
export async function getRegistrationCustomer(
  admin: AdminApiContext,
  customerId: string,
): Promise<RegistrationCustomer | null> {
  type CustomerQuery = {
    data?: {
      customer?: {
        firstName?: string | null;
        lastName?: string | null;
        email?: string | null;
        tags: string[];
        defaultAddress?: {
          countryCodeV2?: string | null;
          provinceCode?: string | null;
          city?: string | null;
        } | null;
        companyContactProfiles: { company: { name: string } }[];
      } | null;
    };
  };

  const data = await graphql<CustomerQuery>(
    admin,
    `
      #graphql
      query B2bRegistrationPageCustomer($id: ID!) {
        customer(id: $id) {
          firstName
          lastName
          email
          tags
          defaultAddress {
            countryCodeV2
            provinceCode
            city
          }
          companyContactProfiles {
            company {
              name
            }
          }
        }
      }
    `,
    { id: customerGid(customerId.replace(/\D/g, "") || customerId) },
  );

  const customer = data.data?.customer;
  if (!customer) return null;

  return {
    firstName: customer.firstName ?? "",
    lastName: customer.lastName ?? "",
    email: customer.email ?? "",
    countryCode: customer.defaultAddress?.countryCodeV2 ?? "",
    provinceCode: customer.defaultAddress?.provinceCode ?? "",
    city: customer.defaultAddress?.city ?? "",
    companyName: customer.companyContactProfiles[0]?.company.name ?? null,
    registrationPending: customer.tags.includes(REGISTRATION_TAGS.pending),
  };
}

/**
 * The existing company this registration would join, if any, unless the
 * signed-in customer already belongs to it (then there's nothing to ask).
 */
async function companyMatchToConfirm(
  admin: AdminApiContext,
  loggedInCustomerId: string | null,
  payload: B2bRegistrationPayload,
): Promise<NonNullable<Extract<B2bRegistrationResult, { ok: false }>["match"]> | null> {
  let email = payload.email;
  let ownCompanyIds: string[] = [];
  if (loggedInCustomerId) {
    type CustomerQuery = {
      data?: {
        customer?: {
          email?: string | null;
          companyContactProfiles: { company: { id: string } }[];
        } | null;
      };
    };
    const data = await graphql<CustomerQuery>(
      admin,
      `
        #graphql
        query B2bRegistrationMatchCustomer($id: ID!) {
          customer(id: $id) {
            email
            companyContactProfiles {
              company {
                id
              }
            }
          }
        }
      `,
      { id: customerGid(loggedInCustomerId.replace(/\D/g, "") || loggedInCustomerId) },
    );
    email = data.data?.customer?.email ?? email;
    ownCompanyIds =
      data.data?.customer?.companyContactProfiles.map(({ company }) => company.id) ?? [];
  }

  const emailDomain = businessEmailDomain(email);
  const match = await findMatchingCompany(
    admin,
    payload.companyName.trim().replace(/\s+/g, " "),
    emailDomain,
  );
  if (!match || ownCompanyIds.includes(match.company.id)) return null;
  return {
    companyName: match.company.name,
    reason: match.reason,
    ...(match.reason === "email_domain" && emailDomain ? { emailDomain } : {}),
  };
}

export async function registerB2bCustomer(
  admin: AdminApiContext,
  loggedInCustomerId: string | null,
  payload: B2bRegistrationPayload,
  options: B2bRegistrationOptions = {},
): Promise<B2bRegistrationResult> {
  let customerId = loggedInCustomerId;
  let customerCreated = false;

  // Never put someone in an existing company without asking: stop before
  // anything is created and let the form offer "join" or "new".
  if (!payload.companyChoice) {
    const match = await companyMatchToConfirm(admin, loggedInCustomerId, payload);
    if (match) {
      return {
        ok: false,
        code: "COMPANY_MATCH",
        error: `${match.companyName} is already registered.`,
        match,
      };
    }
  }

  if (!customerId) {
    const created = await createStorefrontCustomer(admin, payload);
    if (!created.ok) {
      return created;
    }
    customerId = created.customerId;
    customerCreated = true;
  }

  const linkResult = await linkCustomerToB2bCompany(
    admin,
    customerId,
    payload,
    options,
  );
  if (!linkResult.ok) {
    return linkResult;
  }

  return {
    ...linkResult,
    customerCreated,
  };
}

export function parseB2bRegistrationPayload(
  body: unknown,
): B2bRegistrationPayload | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const str = (key: string) =>
    typeof record[key] === "string" ? (record[key] as string).trim() : "";

  const companyName = str("companyName");
  const address1 = str("address1");
  const city = str("city");
  const countryCode = str("countryCode");
  const zip = str("zip");

  if (!companyName || !address1 || !city || !countryCode || !zip) {
    return null;
  }

  return {
    firstName: str("firstName") || undefined,
    lastName: str("lastName") || undefined,
    email: str("email") || undefined,
    companyName,
    phone: str("phone") || undefined,
    phoneCountryCode: str("phoneCountryCode") || undefined,
    phoneExt: normalizePhoneExt(str("phoneExt")) || undefined,
    companyChoice:
      str("companyChoice") === "join" || str("companyChoice") === "new"
        ? (str("companyChoice") as "join" | "new")
        : undefined,
    address1,
    address2: str("address2") || undefined,
    city,
    provinceCode: str("provinceCode") || undefined,
    countryCode,
    zip,
    locale: str("locale") || undefined,
  };
}

/**
 * Validates a parsed registration the way the storefront form does and puts
 * the phone in E.164, with any extension moved to `phoneExt`. Returns the
 * response to send when something is wrong.
 */
export function prepareRegistrationPayload(
  payload: B2bRegistrationPayload,
):
  | { ok: true; payload: B2bRegistrationPayload }
  | { ok: false; status: number; body: { ok: false; field?: string; error: string } } {
  const fieldError = registrationFieldError(payload);
  if (fieldError) {
    return { ok: false, status: 422, body: { ok: false, ...fieldError } };
  }

  const addressError = addressAreaError(payload);
  if (addressError) {
    return { ok: false, status: 422, body: { ok: false, error: addressError } };
  }

  if (!payload.phone) return { ok: true, payload };

  const phone = checkPhone(
    payload.phone,
    payload.phoneCountryCode || payload.countryCode,
  );
  if (!phone.valid) {
    return {
      ok: false,
      status: 422,
      body: { ok: false, field: "phone", error: "Please enter a valid number." },
    };
  }
  return {
    ok: true,
    payload: {
      ...payload,
      phone: phone.e164,
      phoneCountryCode: phone.countryCode,
      phoneExt: normalizePhoneExt(payload.phoneExt) || phone.ext || undefined,
    },
  };
}
