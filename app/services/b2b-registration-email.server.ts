import nodemailer from "nodemailer";

export type MailMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
};

/** Anything that can deliver a message; a nodemailer transport qualifies. */
export type Mailer = {
  sendMail(message: MailMessage): Promise<unknown>;
};

export type RegistrationEmailDetails = {
  to: string;
  firstName?: string | null;
  /** Name of the company the customer belongs to now (existing or new). */
  companyName: string;
  /** True when registration created the company; false when it joined one. */
  created: boolean;
  shopName: string;
  /** Storefront base URL, e.g. https://example.com. */
  storeUrl: string;
  /** Storefront locale the form was submitted from, e.g. "fr" or "en-US". */
  locale?: string;
};

const EN = {
  subject: (shop: string) => `Your business registration with ${shop} is complete`,
  greeting: (name: string) => (name ? `Hi ${name},` : "Hi,"),
  intro: (shop: string) =>
    `Thanks for registering with ${shop}. Your business account is ready.`,
  created: (company: string) =>
    `We created the company ${company} and added you as its contact.`,
  joined: (company: string) =>
    `You have been added to the existing company ${company}.`,
  signIn: (email: string) =>
    `Sign in with ${email} to see your business account and place orders:`,
  button: "Go to my account",
  signOff: "Thank you,",
};

const FR: typeof EN = {
  subject: (shop) => `Votre inscription professionnelle chez ${shop} est confirmée`,
  greeting: (name) => (name ? `Bonjour ${name},` : "Bonjour,"),
  intro: (shop) =>
    `Merci de votre inscription chez ${shop}. Votre compte professionnel est prêt.`,
  created: (company) =>
    `Nous avons créé l'entreprise ${company} et vous avons ajouté comme contact.`,
  joined: (company) =>
    `Vous avez été ajouté à l'entreprise existante ${company}.`,
  signIn: (email) =>
    `Connectez-vous avec ${email} pour accéder à votre compte professionnel et passer commande :`,
  button: "Accéder à mon compte",
  signOff: "Merci,",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Subject and bodies of the confirmation sent after a successful registration. */
export function buildRegistrationEmail(details: RegistrationEmailDetails): {
  subject: string;
  text: string;
  html: string;
} {
  const copy = details.locale?.toLowerCase().startsWith("fr") ? FR : EN;
  const firstName = details.firstName?.trim() ?? "";
  const accountUrl = `${details.storeUrl.replace(/\/+$/, "")}/account`;
  const outcome = details.created
    ? copy.created(details.companyName)
    : copy.joined(details.companyName);

  const text = [
    copy.greeting(firstName),
    "",
    copy.intro(details.shopName),
    outcome,
    "",
    copy.signIn(details.to),
    accountUrl,
    "",
    copy.signOff,
    details.shopName,
  ].join("\n");

  // Each piece is escaped once here, so names like "Smith & Sons" are safe.
  const h = {
    greeting: escapeHtml(copy.greeting(firstName)),
    intro: escapeHtml(copy.intro(details.shopName)),
    outcome: escapeHtml(outcome),
    signIn: escapeHtml(copy.signIn(details.to)),
    button: escapeHtml(copy.button),
    accountUrl: escapeHtml(accountUrl),
    signOff: escapeHtml(copy.signOff),
    shopName: escapeHtml(details.shopName),
  };

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f6f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#202223;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;">
      <tr>
        <td style="padding:32px;font-size:16px;line-height:1.5;">
          <p style="margin:0 0 16px;">${h.greeting}</p>
          <p style="margin:0 0 16px;">${h.intro}<br>${h.outcome}</p>
          <p style="margin:0 0 24px;">${h.signIn}</p>
          <p style="margin:0 0 24px;">
            <a href="${h.accountUrl}" style="display:inline-block;padding:12px 20px;background:#202223;color:#ffffff;text-decoration:none;border-radius:6px;">${h.button}</a>
          </p>
          <p style="margin:0;">${h.signOff}<br>${h.shopName}</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject: copy.subject(details.shopName), text, html };
}

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
};

/**
 * SMTP settings from the environment, or null when sending is not set up
 * (SMTP_HOST unset), in which case registration skips the email.
 */
export function smtpConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) return null;

  const port = Number(env.SMTP_PORT) || 587;
  const user = env.SMTP_USER?.trim() || undefined;
  const from = env.SMTP_FROM?.trim() || user;
  if (!from) {
    throw new Error("Set SMTP_FROM (or SMTP_USER) to send registration emails.");
  }

  return {
    host,
    port,
    // Port 465 is TLS from the start; other ports upgrade with STARTTLS.
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === "true" : port === 465,
    user,
    pass: env.SMTP_PASS || undefined,
    from,
  };
}

let smtpMailer: { mailer: Mailer; from: string } | null | undefined;

/** The SMTP mailer configured in the environment, created once and reused. */
export function smtpMailerFromEnv(): { mailer: Mailer; from: string } | null {
  if (smtpMailer !== undefined) return smtpMailer;

  const config = smtpConfigFromEnv();
  smtpMailer = config && {
    mailer: nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    }),
    from: config.from,
  };
  return smtpMailer;
}

/** Sends the registration confirmation to the customer. */
export async function sendRegistrationEmail(
  sender: { mailer: Mailer; from: string },
  details: RegistrationEmailDetails,
): Promise<void> {
  const { subject, text, html } = buildRegistrationEmail(details);
  await sender.mailer.sendMail({
    from: sender.from,
    to: details.to,
    subject,
    text,
    html,
  });
}
