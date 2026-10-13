import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import {
  sendApprovalEmail,
  smtpMailerFromEnv,
  type Mailer,
} from "./b2b-registration-email.server";
import {
  companyFieldDefinitions,
  companyStatusValue,
  graphql,
  pickContactRoleId,
  REGISTRATION_TAGS,
  setCompanyStatusFields,
  updateCustomerTags,
} from "./b2b-registration.server";

/**
 * Staff review of B2B registrations. A registration leaves the customer as a
 * company contact with no role and tagged `b2b-registration-pending`;
 * approving gives the contact the company's ordering role at its location.
 */

type UserError = { field?: string[] | null; message: string };

export type RegistrationStatusTag = "pending" | "approved" | "rejected";

export type Registration = {
  customerId: string;
  name: string;
  email: string;
  registeredAt: string;
  updatedAt: string;
  status: RegistrationStatusTag;
  /** Customer note: holds the phone extension, if one was given. */
  note: string;
  companies: {
    id: string;
    name: string;
    /** 1 when the registrant is the company's only contact (they created it). */
    contactCount: number;
    phone: string;
    address: string;
  }[];
};

function statusOf(tags: string[]): RegistrationStatusTag | null {
  if (tags.includes(REGISTRATION_TAGS.pending)) return "pending";
  if (tags.includes(REGISTRATION_TAGS.approved)) return "approved";
  if (tags.includes(REGISTRATION_TAGS.rejected)) return "rejected";
  return null;
}

/**
 * Registrations whose status is one of `statuses`. Customer search lags a few
 * seconds behind tag changes, so each result is checked against the
 * customer's current tags: someone approved a moment ago doesn't come back as
 * pending.
 */
async function listRegistrations(
  admin: AdminApiContext,
  statuses: RegistrationStatusTag[],
  limit: number,
): Promise<Registration[]> {
  type RegistrationsQuery = {
    data?: {
      customers?: {
        nodes: {
          id: string;
          displayName: string;
          defaultEmailAddress?: { emailAddress?: string | null } | null;
          createdAt: string;
          updatedAt: string;
          note?: string | null;
          tags: string[];
          companyContactProfiles: {
            company: {
              id: string;
              name: string;
              contactsCount?: { count: number } | null;
              locations: {
                nodes: {
                  phone?: string | null;
                  shippingAddress?: {
                    address1?: string | null;
                    address2?: string | null;
                    city?: string | null;
                    zoneCode?: string | null;
                    countryCode?: string | null;
                    zip?: string | null;
                  } | null;
                }[];
              };
            };
          }[];
        }[];
      };
    };
  };

  const data = await graphql<RegistrationsQuery>(
    admin,
    `
      #graphql
      query B2bPendingRegistrations($query: String!, $first: Int!) {
        customers(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {
          nodes {
            id
            displayName
            defaultEmailAddress {
              emailAddress
            }
            createdAt
            updatedAt
            note
            tags
            companyContactProfiles {
              company {
                id
                name
                contactsCount {
                  count
                }
                locations(first: 1) {
                  nodes {
                    phone
                    shippingAddress {
                      address1
                      address2
                      city
                      zoneCode
                      countryCode
                      zip
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    {
      query: statuses
        .map((status) => `tag:'${REGISTRATION_TAGS[status]}'`)
        .join(" OR "),
      first: limit,
    },
  );

  const registrations: Registration[] = [];
  for (const customer of data.data?.customers?.nodes ?? []) {
    const status = statusOf(customer.tags);
    if (!status || !statuses.includes(status)) continue;
    registrations.push({
      customerId: customer.id,
      name: customer.displayName,
      email: customer.defaultEmailAddress?.emailAddress ?? "",
      registeredAt: customer.createdAt,
      updatedAt: customer.updatedAt,
      status,
      note: customer.note ?? "",
      companies: customer.companyContactProfiles.map(({ company }) => {
        const location = company.locations.nodes[0];
        const address = location?.shippingAddress;
        return {
          id: company.id,
          name: company.name,
          contactCount: company.contactsCount?.count ?? 0,
          phone: location?.phone ?? "",
          address: address
            ? [
                address.address1,
                address.address2,
                address.city,
                [address.zoneCode, address.zip].filter(Boolean).join(" "),
                address.countryCode,
              ]
                .filter(Boolean)
                .join(", ")
            : "",
        };
      }),
    });
  }
  return registrations;
}

/** Registrations waiting for a decision, newest activity first. */
export function listPendingRegistrations(
  admin: AdminApiContext,
): Promise<Registration[]> {
  return listRegistrations(admin, ["pending"], 50);
}

/** The most recently approved or rejected registrations. */
export function listRecentDecisions(
  admin: AdminApiContext,
  limit = 10,
): Promise<Registration[]> {
  return listRegistrations(admin, ["approved", "rejected"], limit);
}

type ApprovalCustomer = {
  id: string;
  firstName?: string | null;
  locale?: string | null;
  defaultEmailAddress?: { emailAddress?: string | null } | null;
  companyContactProfiles: {
    id: string;
    roleAssignments: { nodes: { id: string }[] };
    company: {
      id: string;
      name: string;
      contactsCount?: { count: number } | null;
      defaultRole?: { id: string } | null;
      contactRoles?: { nodes: { id: string; name: string }[] };
      locations: { nodes: { id: string }[] };
    };
  }[];
};

async function approvalCustomer(
  admin: AdminApiContext,
  customerId: string,
): Promise<ApprovalCustomer | null> {
  const data = await graphql<{ data?: { customer?: ApprovalCustomer | null } }>(
    admin,
    `
      #graphql
      query B2bApprovalCustomer($id: ID!) {
        customer(id: $id) {
          id
          firstName
          locale
          defaultEmailAddress {
            emailAddress
          }
          companyContactProfiles {
            id
            roleAssignments(first: 1) {
              nodes {
                id
              }
            }
            company {
              id
              name
              contactsCount {
                count
              }
              defaultRole {
                id
              }
              contactRoles(first: 10) {
                nodes {
                  id
                  name
                }
              }
              locations(first: 1) {
                nodes {
                  id
                }
              }
            }
          }
        }
      }
    `,
    { id: customerId },
  );
  return data.data?.customer ?? null;
}

/** True when the company's "B2B account status" metafield already says approved. */
async function companyIsApproved(
  admin: AdminApiContext,
  companyId: string,
): Promise<boolean> {
  const definitions = await companyFieldDefinitions(admin);
  const status = definitions.status;
  if (!status) return false;

  const data = await graphql<{
    data?: { company?: { metafield?: { value: string } | null } | null };
  }>(
    admin,
    `
      #graphql
      query B2bApprovalCompanyStatus($id: ID!, $namespace: String!, $key: String!) {
        company(id: $id) {
          metafield(namespace: $namespace, key: $key) {
            value
          }
        }
      }
    `,
    { id: companyId, namespace: status.namespace, key: status.key },
  );
  const value = data.data?.company?.metafield?.value;
  return Boolean(value) && value === companyStatusValue(status, "approved");
}

export type ReviewResult =
  | { ok: true; emailSent?: boolean }
  | { ok: false; error: string };

/**
 * Lets the customer order for their company: assigns the company's ordering
 * role at its location (unless they have one), marks a company that was
 * waiting on this registration as approved, swaps the pending tag for the
 * approved one and emails the customer.
 */
export async function approveRegistration(
  admin: AdminApiContext,
  customerId: string,
  approvedBy: string,
  options: { emailSender?: { mailer: Mailer; from: string } | null; now?: Date } = {},
): Promise<ReviewResult> {
  const customer = await approvalCustomer(admin, customerId);
  if (!customer) return { ok: false, error: "Customer not found." };
  if (!customer.companyContactProfiles.length) {
    return {
      ok: false,
      error: "This customer isn't a contact of any company. Add them to a company in the Shopify admin first.",
    };
  }

  for (const profile of customer.companyContactProfiles) {
    const { company } = profile;
    if (profile.roleAssignments.nodes.length === 0) {
      const roleId = pickContactRoleId(company);
      const locationId = company.locations.nodes[0]?.id;
      if (!roleId || !locationId) {
        return {
          ok: false,
          error: `${company.name} has no location or contact role to assign. Add one in the Shopify admin, then approve again.`,
        };
      }

      const result = await graphql<{
        data?: {
          companyContactAssignRole?: {
            companyContactRoleAssignment?: { id: string } | null;
            userErrors: UserError[];
          };
        };
      }>(
        admin,
        `
          #graphql
          mutation B2bApprovalAssignRole(
            $companyContactId: ID!
            $companyContactRoleId: ID!
            $companyLocationId: ID!
          ) {
            companyContactAssignRole(
              companyContactId: $companyContactId
              companyContactRoleId: $companyContactRoleId
              companyLocationId: $companyLocationId
            ) {
              companyContactRoleAssignment {
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
          companyContactId: profile.id,
          companyContactRoleId: roleId,
          companyLocationId: locationId,
        },
      );
      const assign = result.data?.companyContactAssignRole;
      if (!assign?.companyContactRoleAssignment) {
        const details = (assign?.userErrors ?? []).map((entry) => entry.message);
        return {
          ok: false,
          error: [`Could not give the contact a role at ${company.name}.`, ...details].join(" "),
        };
      }
    }

    // Approving someone who joined an approved company keeps the original
    // "Approved by/on" values.
    if (!(await companyIsApproved(admin, company.id))) {
      await setCompanyStatusFields(admin, company.id, "approved", {
        by: approvedBy,
        on: options.now ?? new Date(),
      });
    }
  }

  const tagErrors = await updateCustomerTags(admin, customer.id, {
    remove: [REGISTRATION_TAGS.pending, REGISTRATION_TAGS.rejected],
    add: [REGISTRATION_TAGS.approved],
  });
  if (tagErrors.length) {
    return {
      ok: false,
      error: [
        "The contact can now order, but the customer's tags were not updated.",
        ...tagErrors.map((entry) => entry.message),
      ].join(" "),
    };
  }

  const sender =
    options.emailSender === undefined ? smtpMailerFromEnv() : options.emailSender;
  const to = customer.defaultEmailAddress?.emailAddress;
  let emailSent = false;
  if (sender && to) {
    try {
      const shop = await graphql<{
        data?: { shop?: { name: string; primaryDomain: { url: string } } };
      }>(
        admin,
        `
          #graphql
          query B2bApprovalEmailShop {
            shop {
              name
              primaryDomain {
                url
              }
            }
          }
        `,
      );
      const details = shop.data?.shop;
      if (!details) throw new Error("Shop details unavailable.");
      await sendApprovalEmail(sender, {
        to,
        firstName: customer.firstName,
        companyName: customer.companyContactProfiles
          .map((profile) => profile.company.name)
          .join(", "),
        shopName: details.name,
        storeUrl: details.primaryDomain.url,
        locale: customer.locale ?? undefined,
      });
      emailSent = true;
    } catch (error) {
      console.error("B2B approval email failed", error);
    }
  }

  return { ok: true, emailSent };
}

/**
 * Declines a registration: takes the customer off the company (their customer
 * account stays) and tags them `b2b-registration-rejected`. A company the
 * registrant created is marked rejected for staff to delete or keep.
 */
export async function rejectRegistration(
  admin: AdminApiContext,
  customerId: string,
): Promise<ReviewResult> {
  const customer = await approvalCustomer(admin, customerId);
  if (!customer) return { ok: false, error: "Customer not found." };

  for (const profile of customer.companyContactProfiles) {
    // Someone already ordering for the company isn't part of this request.
    if (profile.roleAssignments.nodes.length) continue;

    const ownCompany = (profile.company.contactsCount?.count ?? 0) <= 1;
    const result = await graphql<{
      data?: {
        companyContactRemoveFromCompany?: {
          removedCompanyContactId?: string | null;
          userErrors: UserError[];
        };
      };
    }>(
      admin,
      `
        #graphql
        mutation B2bApprovalRemoveContact($companyContactId: ID!) {
          companyContactRemoveFromCompany(companyContactId: $companyContactId) {
            removedCompanyContactId
            userErrors {
              field
              message
            }
          }
        }
      `,
      { companyContactId: profile.id },
    );
    const removal = result.data?.companyContactRemoveFromCompany;
    if (!removal?.removedCompanyContactId) {
      return {
        ok: false,
        error: [
          `Could not remove the contact from ${profile.company.name}.`,
          ...(removal?.userErrors ?? []).map((entry) => entry.message),
        ].join(" "),
      };
    }
    if (ownCompany) {
      await setCompanyStatusFields(admin, profile.company.id, "rejected");
    }
  }

  const tagErrors = await updateCustomerTags(admin, customer.id, {
    remove: [REGISTRATION_TAGS.pending],
    add: [REGISTRATION_TAGS.rejected],
  });
  if (tagErrors.length) {
    return {
      ok: false,
      error: tagErrors.map((entry) => entry.message).join(" "),
    };
  }
  return { ok: true };
}
