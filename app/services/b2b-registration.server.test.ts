import assert from "node:assert/strict";
import { beforeEach, describe, test } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import {
  buildRegistrationEmail,
  smtpConfigFromEnv,
  type MailMessage,
} from "./b2b-registration-email.server";
import {
  businessEmailDomain,
  companyNameMatchRank,
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
  addressCompany?: string;
  indexed: boolean;
};

type FakeCompany = {
  id: string;
  name: string;
  createdAt: string;
  contactCustomerIds: string[];
  indexed: boolean;
};

class FakeShop {
  customers: FakeCustomer[] = [];
  companies: FakeCompany[] = [];
  private nextId = 1;
  private clock = Date.parse("2026-10-08T00:00:00Z");

  addCompany(name: string, createdAt: string, contactEmails: string[] = []) {
    const company: FakeCompany = {
      id: `gid://shopify/Company/${this.nextId++}`,
      name,
      createdAt,
      contactCustomerIds: [],
      indexed: true,
    };
    this.companies.push(company);
    for (const email of contactEmails) {
      const customer = this.addCustomer(email, true);
      company.contactCustomerIds.push(customer.id);
    }
    return company;
  }

  addCustomer(email: string, indexed: boolean) {
    const customer: FakeCustomer = {
      id: `gid://shopify/Customer/${this.nextId++}`,
      firstName: "Test",
      lastName: "Person",
      email,
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
        const customer = this.addCustomer(variables.input.email, false);
        customer.firstName = variables.input.firstName;
        customer.lastName = variables.input.lastName;
        customer.addressCompany = variables.input.addresses[0].company;
        return { customerCreate: { customer: { id: customer.id }, userErrors: [] } };
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
            companyContactProfiles: this.companiesOf(customer.id).map(
              (company) => ({ company: { id: company.id } }),
            ),
          },
        };
      }

      case "B2bRegistrationCompanyCreate": {
        const company: FakeCompany = {
          id: `gid://shopify/Company/${this.nextId++}`,
          name: variables.input.company.name,
          createdAt: this.now(),
          contactCustomerIds: [],
          indexed: false,
        };
        this.companies.push(company);
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
        company.contactCustomerIds.push(variables.customerId);
        return {
          companyAssignCustomerAsContact: {
            companyContact: { id: `gid://shopify/CompanyContact/${this.nextId++}` },
            userErrors: [],
          },
        };
      }

      case "B2bRegistrationCompanyRole":
        return {
          company: {
            defaultRole: { id: "gid://shopify/CompanyContactRole/1" },
            contactRoles: { nodes: [] },
            locations: { nodes: [{ id: "gid://shopify/CompanyLocation/1" }] },
          },
        };

      case "B2bRegistrationAssignRole":
        return { companyContactAssignRole: { userErrors: [] } };

      case "B2bRegistrationEmailShop":
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
 * Registers a new (guest) customer and checks which company they ended up in.
 * No email is sent unless `options.emailSender` is given.
 */
async function register(
  shop: FakeShop,
  companyName: string,
  email: string,
  options: B2bRegistrationOptions & { locale?: string } = {},
) {
  const { locale, emailSender = null } = options;
  const result = await registerB2bCustomer(
    shop.admin(),
    null,
    { ...payload(companyName, email), locale },
    { emailSender },
  );
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
  return { result, company };
}

async function expectJoins(
  shop: FakeShop,
  companyName: string,
  email: string,
  existingName: string,
) {
  const companiesBefore = shop.companies.length;
  const { result } = await register(shop, companyName, email);
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
  const { result } = await register(shop, companyName, email);
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
      "Your business registration with Identiphoto is complete",
    );
    assert.match(email.text, /^Hi New,/);
    assert.match(email.text, /We created the company Globex/);
    assert.match(email.text, /Sign in with hank@globex\.com/);
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
      /added to the existing company Shiv Technolabs PVT\. LTD\./,
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
      "Votre inscription professionnelle chez Identiphoto est confirmée",
    );
    assert.match(sent[0].text, /^Bonjour New,/);
    assert.match(sent[0].text, /ajouté à l'entreprise existante Nike LLC/);
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
