import assert from "node:assert/strict";
import { beforeEach, describe, test } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import {
  approveRegistration,
  listPendingRegistrations,
  rejectRegistration,
} from "./b2b-approval.server";
import {
  buildRegistrationEmail,
  graphConfigFromEnv,
  graphMailer,
  smtpConfigFromEnv,
  type GraphConfig,
  type MailMessage,
} from "./b2b-registration-email.server";
import {
  businessEmailDomain,
  companyNameMatchRank,
  prepareRegistrationPayload,
  REGISTRATION_TAGS,
  registerB2bCustomer,
  type B2bRegistrationOptions,
  type B2bRegistrationPayload,
} from "./b2b-registration.server";

/**
 * In-memory stand-in for the Admin GraphQL API, answering the operations the
 * registration service sends. Records created during a test are left out of
 * the search index (as on Shopify, where it lags a few seconds behind) until
 * `reindex()` is called; direct reads and the newest-companies list see them.
 */
type FakeCustomer = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  note?: string;
  locale?: string;
  tags: string[];
  addressCompany?: string;
  addressPhone?: string;
  indexed: boolean;
};

type FakeCompany = {
  id: string;
  name: string;
  createdAt: string;
  note?: string;
  locationPhone?: string;
  billingSameAsShipping?: boolean;
  contactCustomerIds: string[];
  /** Customer ID -> CompanyContact ID. */
  contactIds: Map<string, string>;
  /** Customer IDs whose contact has a role at the location (can order). */
  orderingCustomerIds: Set<string>;
  /** "namespace.key" -> value. */
  metafields: Map<string, string>;
  indexed: boolean;
};

/** The company fields IDentiphoto defined in their admin (Fig. 6). */
const COMPANY_DEFINITIONS = [
  {
    name: "B2B account status",
    namespace: "custom",
    key: "b2b_account_status",
    type: { name: "single_line_text_field" },
    validations: [
      { name: "choices", value: JSON.stringify(["Pending approval", "Approved", "Rejected"]) },
    ],
  },
  {
    name: "Approved by",
    namespace: "custom",
    key: "approved_by",
    type: { name: "single_line_text_field" },
    validations: [],
  },
  {
    name: "Approved on",
    namespace: "custom",
    key: "approved_on",
    type: { name: "date" },
    validations: [],
  },
  {
    name: "Credit limit",
    namespace: "custom",
    key: "credit_limit",
    type: { name: "money" },
    validations: [],
  },
];

class FakeShop {
  customers: FakeCustomer[] = [];
  companies: FakeCompany[] = [];
  companyDefinitions: typeof COMPANY_DEFINITIONS = COMPANY_DEFINITIONS;
  /** Names of the operations sent, in order. */
  operations: string[] = [];
  private nextId = 1;
  private clock = Date.parse("2026-10-08T00:00:00Z");

  /** An approved company whose contacts can already order. */
  addCompany(name: string, createdAt: string, contactEmails: string[] = []) {
    const company = this.newCompany(name, createdAt, true);
    company.metafields.set("custom.b2b_account_status", "Approved");
    for (const email of contactEmails) {
      const customer = this.addCustomer(email, true);
      this.addContact(company, customer.id);
      company.orderingCustomerIds.add(customer.id);
    }
    return company;
  }

  private newCompany(name: string, createdAt: string, indexed: boolean) {
    const company: FakeCompany = {
      id: `gid://shopify/Company/${this.nextId++}`,
      name,
      createdAt,
      contactCustomerIds: [],
      contactIds: new Map(),
      orderingCustomerIds: new Set(),
      metafields: new Map(),
      indexed,
    };
    this.companies.push(company);
    return company;
  }

  private addContact(company: FakeCompany, customerId: string) {
    const contactId = `gid://shopify/CompanyContact/${this.nextId++}`;
    company.contactCustomerIds.push(customerId);
    company.contactIds.set(customerId, contactId);
    return contactId;
  }

  private contact(contactId: string) {
    for (const company of this.companies) {
      for (const [customerId, id] of company.contactIds) {
        if (id === contactId) return { company, customerId };
      }
    }
    throw new Error(`No contact ${contactId}`);
  }

  addCustomer(email: string, indexed: boolean) {
    const customer: FakeCustomer = {
      id: `gid://shopify/Customer/${this.nextId++}`,
      firstName: "Test",
      lastName: "Person",
      email,
      tags: [],
      indexed,
    };
    this.customers.push(customer);
    return customer;
  }

  reindex() {
    for (const record of [...this.customers, ...this.companies]) {
      record.indexed = true;
    }
  }

  companyByName(name: string) {
    return this.companies.find((company) => company.name === name);
  }

  customerByEmail(email: string) {
    return this.customers.find((customer) => customer.email === email);
  }

  customerById(id: string) {
    return this.customers.find((customer) => customer.id === id);
  }

  private companiesOf(customerId: string) {
    return this.companies.filter((company) =>
      company.contactCustomerIds.includes(customerId),
    );
  }

  private summary(company: FakeCompany) {
    return { id: company.id, name: company.name, createdAt: company.createdAt };
  }

  private now() {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  admin(): AdminApiContext {
    const graphql = async (
      query: string,
      options?: { variables?: Record<string, unknown> },
    ) => {
      const operation = query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
      this.operations.push(operation ?? "");
      const data = this.handle(operation ?? "", options?.variables ?? {});
      return new Response(JSON.stringify({ data }));
    };
    return { graphql } as unknown as AdminApiContext;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handle(operation: string, variables: any): unknown {
    switch (operation) {
      case "B2bRegistrationFindCompanies": {
        // `name:shiv* OR name:shiv*` matches companies with a word starting so.
        const prefixes = [
          ...(variables.query as string).matchAll(/name:(\S+)\*/g),
        ].map((match) => match[1].toLowerCase());
        const byName = this.companies
          .filter((company) => company.indexed)
          .filter((company) =>
            company.name
              .toLowerCase()
              .split(/[^\p{L}\p{N}]+/u)
              .some((word) => prefixes.some((prefix) => word.startsWith(prefix))),
          )
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const recent = [...this.companies]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 50);
        return {
          byName: { nodes: byName.map((company) => this.summary(company)) },
          recent: { nodes: recent.map((company) => this.summary(company)) },
        };
      }

      case "B2bRegistrationCustomersByEmailDomain": {
        // Loose like Shopify's tokenized search: substring, not exact domain.
        const term = (variables.query as string).match(/email:"(.*)"/)![1];
        const nodes = this.customers
          .filter((customer) => customer.indexed)
          .filter((customer) => customer.email.includes(term))
          .map((customer) => ({
            defaultEmailAddress: { emailAddress: customer.email },
            companyContactProfiles: this.companiesOf(customer.id).map(
              (company) => ({ company: this.summary(company) }),
            ),
          }));
        return { customers: { nodes } };
      }

      case "B2bRegistrationCompanyContactEmails":
        return {
          nodes: (variables.ids as string[]).map((id) => {
            const company = this.companies.find((entry) => entry.id === id);
            if (!company) return null;
            return {
              id,
              contacts: {
                nodes: [...company.contactCustomerIds]
                  .reverse()
                  .slice(0, 20)
                  .map((customerId) => ({
                    customer: {
                      defaultEmailAddress: {
                        emailAddress: this.customers.find(
                          (customer) => customer.id === customerId,
                        )?.email,
                      },
                    },
                  })),
              },
            };
          }),
        };

      case "B2bRegistrationFindCustomer": {
        const email = (variables.query as string).match(/email:"(.*)"/)![1];
        const customer = this.customerByEmail(email);
        return {
          customers: {
            nodes: customer ? [{ id: customer.id, email: customer.email }] : [],
          },
        };
      }

      case "B2bRegistrationCustomerCreate": {
        const input = variables.input;
        // Like Shopify: a customer's phone must be E.164 and unique.
        if (input.phone !== undefined) {
          const message = !/^\+\d{8,15}$/.test(input.phone)
            ? "Phone is invalid"
            : this.customers.some((entry) => entry.phone === input.phone)
              ? "Phone has already been taken"
              : null;
          if (message) {
            return {
              customerCreate: {
                customer: null,
                userErrors: [{ field: ["phone"], message }],
              },
            };
          }
        }
        const customer = this.addCustomer(input.email, false);
        customer.firstName = input.firstName;
        customer.lastName = input.lastName;
        customer.phone = input.phone;
        customer.note = input.note;
        customer.locale = input.locale;
        customer.addressCompany = input.addresses[0].company;
        customer.addressPhone = input.addresses[0].phone;
        return { customerCreate: { customer: { id: customer.id }, userErrors: [] } };
      }

      case "B2bRegistrationMatchCustomer": {
        const customer = this.customerById(variables.id);
        if (!customer) return { customer: null };
        return {
          customer: {
            email: customer.email,
            companyContactProfiles: this.companiesOf(customer.id).map(
              (company) => ({ company: { id: company.id } }),
            ),
          },
        };
      }

      case "B2bRegistrationCustomer": {
        const customer = this.customers.find(
          (entry) => entry.id === variables.id,
        );
        if (!customer) return { customer: null };
        return {
          customer: {
            id: customer.id,
            firstName: customer.firstName,
            lastName: customer.lastName,
            email: customer.email,
            tags: customer.tags,
            companyContactProfiles: this.companiesOf(customer.id).map(
              (company) => ({ company: { id: company.id } }),
            ),
          },
        };
      }

      case "B2bRegistrationCompanyCreate": {
        const company = this.newCompany(
          variables.input.company.name,
          this.now(),
          false,
        );
        company.note = variables.input.company.note;
        company.locationPhone = variables.input.companyLocation.phone;
        company.billingSameAsShipping = variables.input.companyLocation.billingSameAsShipping;
        return {
          companyCreate: {
            company: { id: company.id, name: company.name },
            userErrors: [],
          },
        };
      }

      case "B2bRegistrationCustomerUpdate": {
        const customer = this.customers.find(
          (entry) => entry.id === variables.input.id,
        )!;
        customer.addressCompany = variables.input.addresses[0].company;
        return { customerUpdate: { userErrors: [] } };
      }

      case "B2bRegistrationAssignContact": {
        const company = this.companies.find(
          (entry) => entry.id === variables.companyId,
        )!;
        const contactId = this.addContact(company, variables.customerId);
        return {
          companyAssignCustomerAsContact: {
            companyContact: { id: contactId },
            userErrors: [],
          },
        };
      }

      case "B2bRegistrationTagCustomer":
      case "B2bRegistrationUntagCustomer": {
        const customer = this.customerById(variables.id)!;
        const tags = variables.tags as string[];
        customer.tags =
          operation === "B2bRegistrationTagCustomer"
            ? [...new Set([...customer.tags, ...tags])]
            : customer.tags.filter((tag) => !tags.includes(tag));
        return {
          [operation === "B2bRegistrationTagCustomer" ? "tagsAdd" : "tagsRemove"]: {
            userErrors: [],
          },
        };
      }

      case "B2bRegistrationCompanyFieldDefinitions":
        return { metafieldDefinitions: { nodes: this.companyDefinitions } };

      case "B2bRegistrationCreateCompanyField": {
        const { name, namespace, key, type } = variables.definition;
        if (this.companyDefinitions.some((d) => d.namespace === namespace && d.key === key)) {
          return {
            metafieldDefinitionCreate: {
              userErrors: [{ field: ["definition", "key"], message: "Key is in use", code: "TAKEN" }],
            },
          };
        }
        this.companyDefinitions = [
          ...this.companyDefinitions,
          { name, namespace, key, type: { name: type }, validations: [] },
        ];
        return { metafieldDefinitionCreate: { userErrors: [] } };
      }

      case "B2bRegistrationSetCompanyFields": {
        for (const field of variables.metafields) {
          const company = this.companies.find((entry) => entry.id === field.ownerId)!;
          company.metafields.set(`${field.namespace}.${field.key}`, field.value);
        }
        return { metafieldsSet: { userErrors: [] } };
      }

      case "B2bPendingRegistrations": {
        const tags = [...(variables.query as string).matchAll(/tag:'([^']*)'/g)].map(
          (match) => match[1],
        );
        return {
          customers: {
            nodes: this.customers
              .filter((customer) => customer.tags.some((tag) => tags.includes(tag)))
              .map((customer) => ({
                id: customer.id,
                displayName: `${customer.firstName} ${customer.lastName}`,
                defaultEmailAddress: { emailAddress: customer.email },
                createdAt: "2026-10-10T00:00:00Z",
                updatedAt: "2026-10-10T00:00:00Z",
                tags: customer.tags,
                note: customer.note ?? null,
                companyContactProfiles: this.companiesOf(customer.id).map(
                  (company) => ({
                    company: {
                      id: company.id,
                      name: company.name,
                      contactsCount: { count: company.contactCustomerIds.length },
                      locations: {
                        nodes: [{ phone: company.locationPhone ?? null, shippingAddress: null }],
                      },
                    },
                  }),
                ),
              })),
          },
        };
      }

      case "B2bApprovalCustomer": {
        const customer = this.customerById(variables.id);
        if (!customer) return { customer: null };
        return {
          customer: {
            id: customer.id,
            firstName: customer.firstName,
            locale: customer.locale ?? "en",
            defaultEmailAddress: { emailAddress: customer.email },
            companyContactProfiles: this.companiesOf(customer.id).map(
              (company) => ({
                id: company.contactIds.get(customer.id),
                roleAssignments: {
                  nodes: company.orderingCustomerIds.has(customer.id)
                    ? [{ id: "gid://shopify/CompanyContactRoleAssignment/1" }]
                    : [],
                },
                company: {
                  id: company.id,
                  name: company.name,
                  contactsCount: { count: company.contactCustomerIds.length },
                  defaultRole: null,
                  contactRoles: {
                    nodes: [
                      { id: "gid://shopify/CompanyContactRole/1", name: "Location admin" },
                      { id: "gid://shopify/CompanyContactRole/2", name: "Ordering only" },
                    ],
                  },
                  locations: { nodes: [{ id: "gid://shopify/CompanyLocation/1" }] },
                },
              }),
            ),
          },
        };
      }

      case "B2bApprovalAssignRole": {
        const { company, customerId } = this.contact(variables.companyContactId);
        assert.equal(variables.companyContactRoleId, "gid://shopify/CompanyContactRole/2");
        company.orderingCustomerIds.add(customerId);
        return {
          companyContactAssignRole: {
            companyContactRoleAssignment: { id: `gid://shopify/CompanyContactRoleAssignment/${this.nextId++}` },
            userErrors: [],
          },
        };
      }

      case "B2bApprovalCompanyStatus": {
        const company = this.companies.find((entry) => entry.id === variables.id)!;
        const value = company.metafields.get(`${variables.namespace}.${variables.key}`);
        return { company: { metafield: value === undefined ? null : { value } } };
      }

      case "B2bApprovalRemoveContact": {
        const { company, customerId } = this.contact(variables.companyContactId);
        company.contactCustomerIds = company.contactCustomerIds.filter(
          (id) => id !== customerId,
        );
        company.contactIds.delete(customerId);
        return {
          companyContactRemoveFromCompany: {
            removedCompanyContactId: variables.companyContactId,
            userErrors: [],
          },
        };
      }

      case "B2bRegistrationEmailShop":
      case "B2bApprovalEmailShop":
        return {
          shop: {
            name: "Identiphoto",
            primaryDomain: { url: "https://shop.identiphoto.test" },
          },
        };

      default:
        throw new Error(`Unexpected operation: ${operation}`);
    }
  }
}

const SHIV = "Shiv Technolabs PVT. LTD.";
const NIKE = "Nike LLC";

/** The store the earlier manual tests ran against. */
function seededShop() {
  const shop = new FakeShop();
  shop.addCompany(SHIV, "2026-01-01T00:00:00Z", ["karan@shivlab.com"]);
  shop.addCompany(NIKE, "2026-02-01T00:00:00Z", ["buyer@nike.com"]);
  return shop;
}

function payload(companyName: string, email: string): B2bRegistrationPayload {
  return {
    firstName: "New",
    lastName: "Registrant",
    email,
    companyName,
    address1: "1 Main St",
    city: "Ahmedabad",
    countryCode: "IN",
    zip: "380001",
  };
}

/**
 * Registers a new (guest) customer the way the form does: when an existing
 * company matches, the first submit only asks, and the customer answers
 * "join" (or `companyChoice`). Checks which company they ended up in.
 * No email is sent unless `options.emailSender` is given.
 */
async function register(
  shop: FakeShop,
  companyName: string,
  email: string,
  options: B2bRegistrationOptions & {
    locale?: string;
    companyChoice?: "join" | "new";
  } = {},
) {
  const { locale, emailSender = null, companyChoice = "join" } = options;
  const submit = (choice?: "join" | "new") =>
    registerB2bCustomer(
      shop.admin(),
      null,
      { ...payload(companyName, email), locale, companyChoice: choice },
      { emailSender },
    );

  const customersBefore = shop.customers.length;
  let result = await submit();
  let match: Extract<typeof result, { ok: false }>["match"];
  if (!result.ok && result.code === "COMPANY_MATCH") {
    match = result.match;
    assert.equal(shop.customers.length, customersBefore, "asked after creating the customer");
    result = await submit(companyChoice);
  }
  assert.ok(result.ok, `registration failed: ${JSON.stringify(result)}`);
  const company = shop.companies.find((entry) => entry.id === result.companyId);
  assert.ok(company, "result points at a company that does not exist");
  const customer = shop.customerByEmail(email.toLowerCase())!;
  assert.ok(
    company.contactCustomerIds.includes(customer.id),
    "customer was not added as a contact of the company",
  );
  // The customer's address carries the company's real name, not what was typed.
  assert.equal(customer.addressCompany, company.name);
  assert.equal(result.companyName, company.name);
  return { result, company, match };
}

async function expectJoins(
  shop: FakeShop,
  companyName: string,
  email: string,
  existingName: string,
) {
  const companiesBefore = shop.companies.length;
  const { result, match } = await register(shop, companyName, email);
  // The customer was asked first, and told which company matched.
  assert.equal(match?.companyName, existingName);
  assert.equal(result.companyName, existingName);
  assert.equal(result.created, false);
  assert.equal(shop.companies.length, companiesBefore, "a company was created");
}

async function expectNewCompany(
  shop: FakeShop,
  companyName: string,
  email: string,
) {
  const companiesBefore = shop.companies.length;
  const { result, match } = await register(shop, companyName, email);
  assert.equal(match, undefined, "asked about an existing company");
  assert.equal(result.companyName, companyName);
  assert.equal(result.created, true);
  assert.equal(shop.companies.length, companiesBefore + 1);
}

describe("earlier manual cases (still expected to pass)", () => {
  let shop: FakeShop;
  beforeEach(() => {
    shop = seededShop();
  });

  const joins: [string, string, string][] = [
    ["shivvvvv technolab", "ronakpatel@shivlab.com", SHIV],
    ["shiv technolabssss", "ronakpatel@shivlab.com", SHIV],
    ["ShivTechnolabs", "ronakpatel@shivlab.com", SHIV],
    ["shivlab", "ronakpatel@shivlab.com", SHIV],
    [SHIV, "someone@otherfirm.com", SHIV],
    ["Shiv Technolabs", "ronak@gmail.com", SHIV],
    ["Nike", "aakash112@gmail.com", NIKE],
    ["Nike LLC", "aakash112@gmail.com", NIKE],
    ["NIKE, Inc.", "someone@yahoo.com", NIKE],
  ];
  for (const [typed, email, existing] of joins) {
    test(`"${typed}" + ${email} -> joins "${existing}"`, () =>
      expectJoins(shop, typed, email, existing));
  }

  const creates: [string, string][] = [
    ["Nikee", "aakash112@gmail.com"],
    ["shiv technolab", "ronak@gmail.com"],
  ];
  for (const [typed, email] of creates) {
    test(`"${typed}" + ${email} -> NEW company "${typed}"`, () =>
      expectNewCompany(shop, typed, email));
  }

  // Changed on purpose: shivlab.com already belongs to Shiv Technolabs, and
  // the email domain now outranks the typed name (was: joins "Nike LLC").
  test(`"Nike" + karan.bhatt@shivlab.com -> joins "${SHIV}" (was "${NIKE}")`, () =>
    expectJoins(shop, "Nike", "karan.bhatt@shivlab.com", SHIV));

  test(`"Nike" + karan.bhatt@newstartup.com -> joins "${NIKE}" (name match, unknown domain)`, () =>
    expectJoins(shop, "Nike", "karan.bhatt@newstartup.com", NIKE));
});

describe("email domain matches an existing company", () => {
  let shop: FakeShop;
  beforeEach(() => {
    shop = seededShop();
  });

  test(`"Acme Corp" + ronakpatel@shivlab.com -> joins "${SHIV}", typed name ignored`, () =>
    expectJoins(shop, "Acme Corp", "ronakpatel@shivlab.com", SHIV));

  test(`"Totally Different Pvt Ltd" + RONAK@SHIVLAB.COM -> joins "${SHIV}" (case-insensitive)`, () =>
    expectJoins(shop, "Totally Different Pvt Ltd", "RONAK@SHIVLAB.COM", SHIV));

  test(`"Adidas" + jane@nike.com -> joins "${NIKE}"`, () =>
    expectJoins(shop, "Adidas", "jane@nike.com", NIKE));

  test("domain shared by two companies -> joins the one whose name is closest", async () => {
    shop.addCompany("Shiv Exports", "2025-06-01T00:00:00Z", ["exports@shivlab.com"]);
    await expectJoins(shop, "Shiv Technolabs", "ronakpatel@shivlab.com", SHIV);
  });

  test("domain shared by two companies, unrelated name -> joins the oldest", async () => {
    shop.addCompany("Shiv Exports", "2025-06-01T00:00:00Z", ["exports@shivlab.com"]);
    await expectJoins(shop, "Acme Corp", "ronakpatel@shivlab.com", "Shiv Exports");
  });

  test("look-alike domain (shivlab.com.au) does not count as shivlab.com", async () => {
    shop.addCompany("Shiv Australia", "2025-01-01T00:00:00Z", ["ops@shivlab.com.au"]);
    await expectJoins(shop, "Acme Corp", "ronakpatel@shivlab.com", SHIV);
  });

  test(`"Acme Corp" + ronak@notshivlab.com -> NEW company`, () =>
    expectNewCompany(shop, "Acme Corp", "ronak@notshivlab.com"));

  test(`"Globex" + someone@globex.com -> NEW company (domain unknown, name unknown)`, () =>
    expectNewCompany(shop, "Globex", "someone@globex.com"));
});

describe("personal mailboxes never match by domain", () => {
  test(`"Acme Corp" + other@gmail.com -> NEW company even though a gmail.com user is a company contact`, async () => {
    const shop = seededShop();
    shop.addCompany("Gmail Buyers Co", "2025-01-01T00:00:00Z", ["aakash@gmail.com"]);
    await expectNewCompany(shop, "Acme Corp", "other@gmail.com");
  });

  test(`"Acme Corp" + someone@yahoo.co.in -> NEW company`, async () => {
    const shop = seededShop();
    shop.addCompany("Yahoo Buyers Co", "2025-01-01T00:00:00Z", ["buyer@yahoo.co.in"]);
    await expectNewCompany(shop, "Acme Corp", "someone@yahoo.co.in");
  });

  test(`"Acme Corp" + someone@optonline.net -> NEW company (internet provider mailbox)`, async () => {
    const shop = seededShop();
    shop.addCompany("Optimum Buyers Co", "2025-01-01T00:00:00Z", ["buyer@optonline.net"]);
    await expectNewCompany(shop, "Acme Corp", "someone@optonline.net");
  });

  test("free mailbox still joins by company name", async () => {
    const shop = seededShop();
    await expectJoins(shop, "Nike Inc.", "buyer@sympatico.ca", NIKE);
  });
});

describe("registrations seconds apart (before Shopify's search index catches up)", () => {
  test("second person at the same domain joins the company the first one just created", async () => {
    const shop = seededShop();
    await expectNewCompany(shop, "Acme Corp", "first@acme.io");
    await expectJoins(shop, "Acme Industries", "second@acme.io", "Acme Corp");
  });

  test("same domain, submitted at the same time -> only one company is created", async () => {
    const shop = seededShop();
    const before = shop.companies.length;
    const [first, second] = await Promise.all([
      register(shop, "Acme Corp", "first@acme.io"),
      register(shop, "Acme Holdings", "second@acme.io"),
    ]);
    assert.equal(shop.companies.length, before + 1);
    assert.equal(first.company.id, second.company.id);
    assert.equal(second.result.companyName, "Acme Corp");
  });

  test("after the index catches up, the domain still matches", async () => {
    const shop = seededShop();
    await expectNewCompany(shop, "Acme Corp", "first@acme.io");
    shop.reindex();
    await expectJoins(shop, "Something Else", "third@acme.io", "Acme Corp");
  });
});

describe("signed-in customers", () => {
  test("existing contact submitting a different name stays on their company", async () => {
    const shop = seededShop();
    const karan = shop.customerByEmail("karan@shivlab.com")!;
    const result = await registerB2bCustomer(
      shop.admin(),
      karan.id.replace(/\D/g, ""),
      payload("Nike", "karan@shivlab.com"),
      { emailSender: null },
    );
    assert.ok(result.ok);
    assert.equal(result.companyName, SHIV);
    assert.equal(result.alreadyLinked, true);
    assert.equal(shop.companyByName(NIKE)!.contactCustomerIds.length, 1);
  });
});

describe("helpers", () => {
  test("businessEmailDomain ignores personal providers", () => {
    assert.equal(businessEmailDomain("ronak@shivlab.com"), "shivlab.com");
    assert.equal(businessEmailDomain(" Ronak@ShivLab.com "), "shivlab.com");
    assert.equal(businessEmailDomain("ronak@gmail.com"), null);
    assert.equal(businessEmailDomain("ronak@outlook.in"), null);
    assert.equal(businessEmailDomain("ronak@yahoo.co.in"), null);
    assert.equal(businessEmailDomain("ronak@protonmail.ch"), null);
    assert.equal(businessEmailDomain("ronak@rr.com"), null);
    assert.equal(businessEmailDomain("ronak@videotron.ca"), null);
    assert.equal(businessEmailDomain("ronak@orange.fr"), null);
    assert.equal(businessEmailDomain("not-an-email"), null);
    assert.equal(businessEmailDomain(undefined), null);
  });

  test("companyNameMatchRank keeps different businesses apart", () => {
    assert.equal(companyNameMatchRank("Nike", "Nike LLC"), 1);
    assert.equal(companyNameMatchRank("shiv technolabssss", SHIV), 2);
    assert.equal(companyNameMatchRank("Krishna Foods", "Krishna Goods"), null);
    assert.equal(companyNameMatchRank("Kumar Plastics", "Kumar Elastics"), null);
  });
});

/** Records sent messages instead of delivering them. */
function recordingSender(options: { fail?: boolean } = {}) {
  const sent: MailMessage[] = [];
  return {
    sent,
    sender: {
      from: "Identiphoto <no-reply@identiphoto.test>",
      mailer: {
        async sendMail(message: MailMessage) {
          if (options.fail) throw new Error("SMTP connection refused");
          sent.push(message);
        },
      },
    },
  };
}

describe("registration confirmation email", () => {
  test("new company -> one email to the registrant saying the company was created", async () => {
    const shop = seededShop();
    const { sent, sender } = recordingSender();
    const { result } = await register(shop, "Globex", "hank@globex.com", {
      emailSender: sender,
    });

    assert.ok(result.ok);
    assert.equal(result.emailSent, true);
    assert.equal(sent.length, 1);
    const [email] = sent;
    assert.equal(email.to, "hank@globex.com");
    assert.equal(email.from, "Identiphoto <no-reply@identiphoto.test>");
    assert.equal(
      email.subject,
      "We received your business registration with Identiphoto",
    );
    assert.match(email.text, /^Hi New,/);
    assert.match(email.text, /application for the company Globex is pending approval/);
    assert.match(email.text, /Once approved, sign in with hank@globex\.com/);
    assert.match(email.text, /https:\/\/shop\.identiphoto\.test\/account/);
    assert.match(email.html, /href="https:\/\/shop\.identiphoto\.test\/account"/);
  });

  test("joined by email domain -> email names the existing company, not the typed one", async () => {
    const shop = seededShop();
    const { sent, sender } = recordingSender();
    await register(shop, "Acme Corp", "ronakpatel@shivlab.com", {
      emailSender: sender,
    });

    assert.equal(sent.length, 1);
    assert.match(
      sent[0].text,
      /request to join the existing company Shiv Technolabs PVT\. LTD\. is pending approval/,
    );
    assert.doesNotMatch(sent[0].text, /Acme/);
  });

  test("French storefront -> French email", async () => {
    const shop = seededShop();
    const { sent, sender } = recordingSender();
    await register(shop, "Nike", "aakash112@gmail.com", {
      emailSender: sender,
      locale: "fr-CA",
    });

    assert.equal(
      sent[0].subject,
      "Nous avons reçu votre inscription professionnelle chez Identiphoto",
    );
    assert.match(sent[0].text, /^Bonjour New,/);
    assert.match(sent[0].text, /rejoindre l'entreprise existante Nike LLC est en attente/);
  });

  test("customer already on the company -> no email", async () => {
    const shop = seededShop();
    const { sent, sender } = recordingSender();
    const karan = shop.customerByEmail("karan@shivlab.com")!;
    const result = await registerB2bCustomer(
      shop.admin(),
      karan.id.replace(/\D/g, ""),
      payload("Shiv Technolabs", "karan@shivlab.com"),
      { emailSender: sender },
    );

    assert.ok(result.ok);
    assert.equal(result.alreadyLinked, true);
    assert.equal(sent.length, 0);
  });

  test("SMTP failure -> registration still succeeds, emailSent is false", async () => {
    const shop = seededShop();
    const { sender } = recordingSender({ fail: true });
    const { result } = await register(shop, "Globex", "hank@globex.com", {
      emailSender: sender,
    });

    assert.ok(result.ok);
    assert.equal(result.created, true);
    assert.equal(result.emailSent, false);
  });

  test("SMTP not configured -> registration succeeds without an email", async () => {
    const shop = seededShop();
    const { result } = await register(shop, "Globex", "hank@globex.com", {
      emailSender: null,
    });

    assert.ok(result.ok);
    assert.equal(result.emailSent, false);
  });

  test("names are HTML-escaped in the HTML body", () => {
    const { html, text } = buildRegistrationEmail({
      to: "a@b.com",
      firstName: "<script>",
      companyName: "Smith & Sons <b>Ltd</b>",
      created: true,
      shopName: "Identiphoto",
      storeUrl: "https://shop.identiphoto.test/",
    });

    assert.match(html, /Smith &amp; Sons &lt;b&gt;Ltd&lt;\/b&gt;/);
    assert.doesNotMatch(html, /<script>|<b>Ltd/);
    assert.match(text, /Smith & Sons <b>Ltd<\/b>/);
    // Trailing slash on the store URL does not double up.
    assert.match(text, /https:\/\/shop\.identiphoto\.test\/account$/m);
  });

  test("SMTP settings come from the environment", () => {
    assert.equal(smtpConfigFromEnv({}), null);
    assert.deepEqual(
      smtpConfigFromEnv({
        SMTP_HOST: "smtp.example.com",
        SMTP_USER: "mailer@example.com",
        SMTP_PASS: "secret",
      }),
      {
        host: "smtp.example.com",
        port: 587,
        secure: false,
        user: "mailer@example.com",
        pass: "secret",
        from: "mailer@example.com",
      },
    );
    assert.equal(
      smtpConfigFromEnv({ SMTP_HOST: "smtp.example.com", SMTP_PORT: "465", SMTP_FROM: "x@example.com" })
        ?.secure,
      true,
    );
    assert.throws(() => smtpConfigFromEnv({ SMTP_HOST: "smtp.example.com" }));
  });
});

describe("sending through Microsoft 365 (Graph)", () => {
  const config: GraphConfig = {
    tenantId: "tenant-1",
    clientId: "client-1",
    clientSecret: "secret-1",
    from: "IDentiphoto <sales@identiphoto.test>",
  };

  const message: MailMessage = {
    from: config.from,
    to: "hank@globex.com",
    subject: "We received your business registration with Identiphoto",
    text: "Hi Hank,",
    html: "<p>Hi Hank,</p>",
  };

  /** Fake fetch answering Microsoft's token and sendMail endpoints. */
  function fakeMicrosoft(
    options: { tokenStatus?: number; sendStatus?: number; expiresIn?: number } = {},
  ) {
    const calls: { url: string; init: RequestInit }[] = [];
    let tokens = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("login.microsoftonline.com")) {
        const status = options.tokenStatus ?? 200;
        return new Response(
          JSON.stringify(
            status === 200
              ? { access_token: `token-${++tokens}`, expires_in: options.expiresIn ?? 3599 }
              : { error: "invalid_client", error_description: "Invalid client secret provided." },
          ),
          { status },
        );
      }
      const status = options.sendStatus ?? 202;
      return status === 202
        ? new Response(null, { status })
        : new Response(
            JSON.stringify({ error: { message: "Access to OData is disabled." } }),
            { status },
          );
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  test("settings come from the environment", () => {
    assert.equal(graphConfigFromEnv({}), null);
    assert.deepEqual(
      graphConfigFromEnv({
        MS_TENANT_ID: "t",
        MS_CLIENT_ID: "c",
        MS_CLIENT_SECRET: "s",
        MAIL_FROM: "sales@identiphoto.com",
      }),
      { tenantId: "t", clientId: "c", clientSecret: "s", from: "sales@identiphoto.com" },
    );
    // A half-filled setup is a mistake, not "send with SMTP instead".
    assert.throws(() => graphConfigFromEnv({ MS_TENANT_ID: "t", MAIL_FROM: "a@b.com" }));
    assert.throws(() =>
      graphConfigFromEnv({ MS_TENANT_ID: "t", MS_CLIENT_ID: "c", MS_CLIENT_SECRET: "s" }),
    );
  });

  test("signs in with client credentials and sends as the mailbox", async () => {
    const { calls, fetchImpl } = fakeMicrosoft();
    await graphMailer(config, fetchImpl).sendMail(message);

    assert.equal(calls.length, 2);
    const [signIn, send] = calls;
    assert.equal(signIn.url, "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token");
    const form = new URLSearchParams(String(signIn.init.body));
    assert.equal(form.get("grant_type"), "client_credentials");
    assert.equal(form.get("client_id"), "client-1");
    assert.equal(form.get("client_secret"), "secret-1");
    assert.equal(form.get("scope"), "https://graph.microsoft.com/.default");

    assert.equal(
      send.url,
      "https://graph.microsoft.com/v1.0/users/sales%40identiphoto.test/sendMail",
    );
    assert.equal(
      (send.init.headers as Record<string, string>).Authorization,
      "Bearer token-1",
    );
    assert.deepEqual(JSON.parse(String(send.init.body)), {
      message: {
        subject: message.subject,
        body: { contentType: "HTML", content: "<p>Hi Hank,</p>" },
        toRecipients: [{ emailAddress: { address: "hank@globex.com" } }],
      },
      saveToSentItems: true,
    });
  });

  test("the token is reused until shortly before it expires", async () => {
    const { calls, fetchImpl } = fakeMicrosoft({ expiresIn: 3600 });
    let clock = 0;
    const mailer = graphMailer(config, fetchImpl, () => clock);

    await mailer.sendMail(message);
    clock = 30 * 60 * 1000;
    await mailer.sendMail(message);
    assert.equal(calls.filter((call) => call.url.includes("login")).length, 1);

    clock = 56 * 60 * 1000;
    await mailer.sendMail(message);
    assert.equal(calls.filter((call) => call.url.includes("login")).length, 2);
  });

  test("Microsoft's error is reported, without the secret", async () => {
    const signIn = fakeMicrosoft({ tokenStatus: 401 });
    await assert.rejects(
      graphMailer(config, signIn.fetchImpl).sendMail(message),
      (error: Error) =>
        /sign-in failed \(401\): Invalid client secret provided\./.test(error.message) &&
        !error.message.includes("secret-1"),
    );

    const send = fakeMicrosoft({ sendStatus: 403 });
    await assert.rejects(
      graphMailer(config, send.fetchImpl).sendMail(message),
      /send failed \(403\): Access to OData is disabled\./,
    );
  });

  test("a failed Microsoft send still lets the registration succeed", async () => {
    const shop = seededShop();
    const { fetchImpl } = fakeMicrosoft({ sendStatus: 403 });
    const { result } = await register(shop, "Globex", "hank@globex.com", {
      emailSender: { mailer: graphMailer(config, fetchImpl), from: config.from },
    });

    assert.ok(result.ok);
    assert.equal(result.created, true);
    assert.equal(result.emailSent, false);
  });
});

describe("new registrations wait for approval (client issue #3)", () => {
  test("new company -> pending: contact without a role, tagged, status field Pending", async () => {
    const shop = seededShop();
    const { result, company } = await register(shop, "Globex", "hank@globex.com");
    const hank = shop.customerByEmail("hank@globex.com")!;

    assert.ok(result.ok);
    assert.equal(result.status, "pending");
    assert.deepEqual(hank.tags, [REGISTRATION_TAGS.pending]);
    assert.equal(company.orderingCustomerIds.size, 0, "contact must not be able to order yet");
    assert.equal(company.metafields.get("custom.b2b_account_status"), "Pending approval");
    assert.ok(
      !shop.operations.some((operation) => /AssignRole/.test(operation)),
      "registration must not assign an ordering role",
    );
  });

  test("joining an existing company -> pending too; the company keeps its status", async () => {
    const shop = seededShop();
    const { result, company } = await register(shop, "Acme", "ronak@shivlab.com");

    assert.ok(result.ok);
    assert.equal(result.status, "pending");
    assert.equal(result.created, false);
    assert.equal(company.name, SHIV);
    const ronak = shop.customerByEmail("ronak@shivlab.com")!;
    assert.ok(!company.orderingCustomerIds.has(ronak.id));
    assert.equal(company.metafields.get("custom.b2b_account_status"), "Approved");
  });

  test("the store has no status fields -> registration still works", async () => {
    const shop = seededShop();
    shop.companyDefinitions = [];
    const { result, company } = await register(shop, "Globex", "hank@globex.com");
    assert.equal(result.status, "pending");
    assert.equal(company.metafields.size, 0);
  });

  test("a signed-in customer still waiting is told so, not 'Active'", async () => {
    const shop = seededShop();
    await register(shop, "Globex", "hank@globex.com");
    const hank = shop.customerByEmail("hank@globex.com")!;
    const again = await registerB2bCustomer(
      shop.admin(),
      hank.id.replace(/\D/g, ""),
      payload("Globex", "hank@globex.com"),
      { emailSender: null },
    );
    assert.ok(again.ok);
    assert.equal(again.alreadyLinked, true);
    assert.equal(again.status, "pending");
  });
});

describe("staff approval", () => {
  test("lists pending registrations with their company", async () => {
    const shop = seededShop();
    await register(shop, "Globex", "hank@globex.com");
    await register(shop, "Acme", "ronak@shivlab.com");

    const pending = await listPendingRegistrations(shop.admin());
    assert.deepEqual(
      pending.map((entry) => [entry.email, entry.companies.map((c) => [c.name, c.contactCount])]),
      [
        ["hank@globex.com", [["Globex", 1]]],
        ["ronak@shivlab.com", [[SHIV, 2]]],
      ],
    );
  });

  test("approving a new company -> ordering role, status fields, tag swap, email", async () => {
    const shop = seededShop();
    await register(shop, "Globex", "hank@globex.com", { locale: "fr" });
    const hank = shop.customerByEmail("hank@globex.com")!;
    const company = shop.companyByName("Globex")!;
    const { sent, sender } = recordingSender();

    const result = await approveRegistration(shop.admin(), hank.id, "Tom Esler", {
      emailSender: sender,
      now: new Date("2026-10-13T15:00:00Z"),
    });

    assert.deepEqual(result, { ok: true, emailSent: true });
    assert.ok(company.orderingCustomerIds.has(hank.id));
    assert.equal(company.metafields.get("custom.b2b_account_status"), "Approved");
    assert.equal(company.metafields.get("custom.approved_by"), "Tom Esler");
    assert.equal(company.metafields.get("custom.approved_on"), "2026-10-13");
    assert.deepEqual(hank.tags, [REGISTRATION_TAGS.approved]);
    assert.equal(sent.length, 1);
    // The registrant's storefront language is kept for later emails.
    assert.equal(sent[0].subject, "Votre compte professionnel chez Identiphoto est approuvé");
    assert.match(sent[0].text, /Globex a été approuvé/);

    assert.deepEqual(await listPendingRegistrations(shop.admin()), []);
  });

  test("approving someone who joined keeps the company's original approval", async () => {
    const shop = seededShop();
    const company = shop.companyByName(SHIV)!;
    company.metafields.set("custom.approved_by", "Original Approver");
    await register(shop, "Acme", "ronak@shivlab.com");
    const ronak = shop.customerByEmail("ronak@shivlab.com")!;

    const result = await approveRegistration(shop.admin(), ronak.id, "Tom Esler", {
      emailSender: null,
    });

    assert.ok(result.ok);
    assert.ok(company.orderingCustomerIds.has(ronak.id));
    assert.equal(company.metafields.get("custom.approved_by"), "Original Approver");
  });

  test("rejecting takes the customer off the company and marks a new company rejected", async () => {
    const shop = seededShop();
    await register(shop, "Globex", "hank@globex.com");
    const hank = shop.customerByEmail("hank@globex.com")!;
    const company = shop.companyByName("Globex")!;

    const result = await rejectRegistration(shop.admin(), hank.id);

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(company.contactCustomerIds, []);
    assert.equal(company.metafields.get("custom.b2b_account_status"), "Rejected");
    assert.deepEqual(hank.tags, [REGISTRATION_TAGS.rejected]);
  });

  test("rejecting a join request leaves the company and its other contacts alone", async () => {
    const shop = seededShop();
    await register(shop, "Acme", "ronak@shivlab.com");
    const ronak = shop.customerByEmail("ronak@shivlab.com")!;
    const company = shop.companyByName(SHIV)!;

    await rejectRegistration(shop.admin(), ronak.id);

    assert.deepEqual(company.contactCustomerIds, [shop.customerByEmail("karan@shivlab.com")!.id]);
    assert.equal(company.metafields.get("custom.b2b_account_status"), "Approved");
  });
});

describe("company phone with an extension (client issues #1 and #6)", () => {
  /** Registers with a phone the way the storefront endpoint does. */
  async function registerWithPhone(
    shop: FakeShop,
    companyName: string,
    email: string,
    phone: string,
    phoneExt?: string,
    companyChoice?: "join" | "new",
  ) {
    const prepared = prepareRegistrationPayload({
      ...payload(companyName, email),
      city: "Willoughby",
      provinceCode: "OH",
      countryCode: "US",
      zip: "44094",
      phone,
      phoneExt,
      companyChoice,
    });
    assert.ok(prepared.ok);
    return registerB2bCustomer(shop.admin(), null, prepared.payload, {
      emailSender: null,
    });
  }

  test("main line with an extension registers; the extension gets its own company field", async () => {
    const shop = seededShop();
    const result = await registerWithPhone(
      shop,
      "IDentiphoto LLC",
      "tom@identiphoto.test",
      "(440) 555-0100 ext. 214",
    );

    assert.ok(result.ok, JSON.stringify(result));
    const tom = shop.customerByEmail("tom@identiphoto.test")!;
    const company = shop.companyByName("IDentiphoto LLC")!;
    assert.equal(tom.phone, undefined, "the company line is not the person's own phone");
    assert.equal(tom.addressPhone, "+14405550100");
    assert.equal(tom.note, "Phone: +14405550100 ext. 214");
    assert.equal(company.locationPhone, "+14405550100");
    assert.equal(company.billingSameAsShipping, true, "orders get a billing address");
    assert.equal(company.note, undefined);
    assert.equal(company.metafields.get("custom.phone_extension"), "214");
    assert.equal(company.metafields.get("custom.netsuite_phone"), "440-555-0100 x214");
    assert.ok(
      shop.companyDefinitions.some((d) => d.name === "NetSuite phone"),
      "the missing definitions are created",
    );
  });

  test("without an extension only the NetSuite phone is written", async () => {
    const shop = seededShop();
    const result = await registerWithPhone(
      shop,
      "IDentiphoto LLC",
      "tom@identiphoto.test",
      "(440) 555-0100",
    );

    assert.ok(result.ok, JSON.stringify(result));
    const company = shop.companyByName("IDentiphoto LLC")!;
    assert.equal(company.metafields.get("custom.phone_extension"), undefined);
    assert.equal(company.metafields.get("custom.netsuite_phone"), "440-555-0100");
  });

  test("a field the merchant already defined under that name is used", async () => {
    const shop = seededShop();
    shop.companyDefinitions = [
      ...shop.companyDefinitions,
      {
        name: "Phone extension",
        namespace: "custom",
        key: "ext",
        type: { name: "single_line_text_field" },
        validations: [],
      },
    ];
    const result = await registerWithPhone(
      shop,
      "IDentiphoto LLC",
      "tom@identiphoto.test",
      "(440) 555-0100",
      "214",
    );

    assert.ok(result.ok, JSON.stringify(result));
    const company = shop.companyByName("IDentiphoto LLC")!;
    assert.equal(company.metafields.get("custom.ext"), "214");
    assert.equal(company.metafields.get("custom.phone_extension"), undefined);
  });

  test("a colleague registering with the same company phone joins instead of being blocked", async () => {
    const shop = seededShop();
    const first = await registerWithPhone(
      shop,
      "IDentiphoto LLC",
      "tom@identiphoto.test",
      "(440) 555-0100",
      "214",
    );
    const asked = await registerWithPhone(
      shop,
      "identiphoto",
      "bill@identiphoto.test",
      "(440) 555-0100",
      "215",
    );
    // Not blocked by the shared phone: offered the existing company instead.
    assert.ok(!asked.ok);
    assert.equal(asked.code, "COMPANY_MATCH");
    assert.equal(asked.match?.companyName, "IDentiphoto LLC");

    const second = await registerWithPhone(
      shop,
      "identiphoto",
      "bill@identiphoto.test",
      "(440) 555-0100",
      "215",
      "join",
    );

    assert.ok(first.ok && second.ok, JSON.stringify(second));
    assert.equal(second.created, false);
    assert.equal(second.companyId, first.companyId);
    assert.equal(second.status, "pending");
  });

  test("the extension can also be typed in the phone field itself", async () => {
    const shop = seededShop();
    const result = await registerWithPhone(
      shop,
      "Globex",
      "hank@globex.com",
      "440-555-0100 x9",
    );
    assert.ok(result.ok);
    assert.equal(shop.customerByEmail("hank@globex.com")!.note, "Phone: +14405550100 ext. 9");
  });
});

describe("an existing company matches: the registrant is asked (retest feedback)", () => {
  test("a fresh company name with an email domain a company already uses -> asks, says why", async () => {
    const shop = seededShop();
    const result = await registerB2bCustomer(
      shop.admin(),
      null,
      payload("Fresh Startup Inc", "new.person@shivlab.com"),
      { emailSender: null },
    );

    assert.ok(!result.ok);
    assert.equal(result.code, "COMPANY_MATCH");
    assert.deepEqual(result.match, {
      companyName: SHIV,
      reason: "email_domain",
      emailDomain: "shivlab.com",
    });
    assert.equal(shop.customerByEmail("new.person@shivlab.com"), undefined);
    assert.equal(shop.companyByName("Fresh Startup Inc"), undefined);
  });

  test("same name, different suffix -> asks with the company_name reason", async () => {
    const shop = seededShop();
    const result = await registerB2bCustomer(
      shop.admin(),
      null,
      payload("Nike Inc.", "buyer@gmail.com"),
      { emailSender: null },
    );
    assert.ok(!result.ok);
    assert.deepEqual(result.match, { companyName: NIKE, reason: "company_name" });
  });

  test('answering "new" registers a separate company even though the domain matches', async () => {
    const shop = seededShop();
    const before = shop.companies.length;
    const { result, match, company } = await register(
      shop,
      "Fresh Startup Inc",
      "new.person@shivlab.com",
      { companyChoice: "new" },
    );
    assert.equal(match?.companyName, SHIV);
    assert.equal(result.created, true);
    assert.equal(company.name, "Fresh Startup Inc");
    assert.equal(shop.companies.length, before + 1);
    assert.equal(result.status, "pending");
  });

  test("a signed-in contact of the matching company is not asked", async () => {
    const shop = seededShop();
    const karan = shop.customerByEmail("karan@shivlab.com")!;
    const result = await registerB2bCustomer(
      shop.admin(),
      karan.id.replace(/\D/g, ""),
      payload("Shiv Technolabs", "karan@shivlab.com"),
      { emailSender: null },
    );
    assert.ok(result.ok);
    assert.equal(result.alreadyLinked, true);
  });
});
