import { listCountries } from "./b2b-localization.server";
import type { RegistrationCustomer } from "./b2b-registration.server";

/** Storefront paths of the app proxy endpoints ([app_proxy] in shopify.app.toml). */
const SUBMIT_PATH = "/apps/b2b-register/link";
const REGIONS_PATH = "/apps/b2b-register/regions";
const PHONE_PATH = "/apps/b2b-register/phone";

const EN = {
  pageTitle: "Business registration",
  pageDescription: "Register your company to set up a business account.",
  signInPrompt: "Already have an account?",
  signIn: "Sign in",
  businessAccountTitle: "Business account",
  status: "Status",
  active: "Active",
  personalInformation: "Personal information",
  companyInformation: "Company information",
  addressInformation: "Address information",
  firstName: "First name",
  lastName: "Last name",
  email: "Email",
  remoteAssist: "Allow remote shopping assistance",
  company: "Company",
  phone: "Phone number",
  phoneCountry: "Country code",
  phoneExt: "Phone extension (optional)",
  streetAddress: "Street address",
  addressLine2: "Address line 2 (optional)",
  addressLine3: "Address line 3 (optional)",
  country: "Country",
  countryPlaceholder: "Select a country",
  stateProvince: "State/Province",
  statePlaceholder: "Please select a region, state or province.",
  city: "City",
  cityPlaceholder: "Select a city",
  zip: "ZIP/Postal code",
  submit: "Create an Account",
  submitError: "We could not complete registration. Please try again.",
  addressLoadError:
    "We couldn't load the address options. Refresh the page and try again.",
  phoneInvalid: "Please enter a valid number.",
  firstNameInvalid: "Please enter a valid first name.",
  lastNameInvalid: "Please enter a valid last name.",
  emailInvalid: "Enter a valid email address, like name@example.com.",
  companyNameInvalid:
    "Company name must contain at least 2 letters or numbers.",
  addressInvalid: "Please enter a valid street address.",
  cityInvalid: "Please enter a valid city.",
  zipInvalid: "Enter a valid ZIP code, like 12345 or 12345-6789.",
  postalCodeCaInvalid: "Enter a valid postal code, like K1A 0B1.",
  postalCodeInvalid: "Please enter a valid postal code.",
  success: "Your account and company profile have been saved.",
  successJoinedCompany:
    "Your account has been saved and added to the existing company %companyName%.",
  signInAfterRegister:
    "Sign in with the email you registered to start ordering.",
};

type Copy = typeof EN;

const FR: Copy = {
  pageTitle: "Inscription de l'entreprise",
  pageDescription:
    "Inscrivez votre entreprise pour créer un compte professionnel.",
  signInPrompt: "Vous avez déjà un compte ?",
  signIn: "Se connecter",
  businessAccountTitle: "Compte professionnel",
  status: "Statut",
  active: "Actif",
  personalInformation: "Informations personnelles",
  companyInformation: "Informations sur l'entreprise",
  addressInformation: "Informations d'adresse",
  firstName: "Prénom",
  lastName: "Nom",
  email: "Courriel",
  remoteAssist: "Autoriser l'assistance à distance pour les achats",
  company: "Entreprise",
  phone: "Numéro de téléphone",
  phoneCountry: "Indicatif du pays",
  phoneExt: "Poste",
  streetAddress: "Adresse",
  addressLine2: "Complément d'adresse (facultatif)",
  addressLine3: "Complément d'adresse 2 (facultatif)",
  country: "Pays",
  countryPlaceholder: "Sélectionnez un pays",
  stateProvince: "État/Province",
  statePlaceholder:
    "Veuillez sélectionner une région, un état ou une province.",
  city: "Ville",
  cityPlaceholder: "Sélectionnez une ville",
  zip: "Code postal",
  submit: "Créer un compte",
  submitError: "Impossible de terminer l'inscription. Réessayez.",
  addressLoadError:
    "Impossible de charger les options d'adresse. Actualisez la page et réessayez.",
  phoneInvalid: "Veuillez entrer un numéro valide.",
  firstNameInvalid: "Veuillez entrer un prénom valide.",
  lastNameInvalid: "Veuillez entrer un nom valide.",
  emailInvalid: "Entrez une adresse courriel valide, par exemple nom@exemple.com.",
  companyNameInvalid:
    "Le nom de l'entreprise doit contenir au moins 2 lettres ou chiffres.",
  addressInvalid: "Veuillez entrer une adresse valide.",
  cityInvalid: "Veuillez entrer une ville valide.",
  zipInvalid: "Entrez un code ZIP valide, par exemple 12345 ou 12345-6789.",
  postalCodeCaInvalid: "Entrez un code postal valide, par exemple K1A 0B1.",
  postalCodeInvalid: "Veuillez entrer un code postal valide.",
  success: "Votre compte et votre profil entreprise ont été enregistrés.",
  successJoinedCompany:
    "Votre compte a été enregistré et ajouté à l'entreprise existante %companyName%.",
  signInAfterRegister:
    "Connectez-vous avec l'adresse courriel utilisée pour commencer à commander.",
};

/**
 * Escapes text for HTML. Braces are escaped too: the response is rendered as
 * Liquid, so customer data must never form `{{` or `{%`.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

/** JSON safe to embed in a <script> tag inside a Liquid response. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\{(?=[{%])/g, "\\u007b");
}

type PageOptions = {
  signedIn: boolean;
  customer: RegistrationCustomer | null;
};

function textField(
  copy: Copy,
  options: {
    name: string;
    label: keyof Copy;
    type?: string;
    autocomplete?: string;
    value?: string;
    required?: boolean;
    maxLength?: number;
  },
): string {
  const id = `b2b-register-${options.name}`;
  return `
    <div class="b2b-register__field">
      <label for="${id}">${escapeHtml(copy[options.label])}</label>
      <input id="${id}" name="${options.name}" type="${options.type ?? "text"}"${
        options.autocomplete ? ` autocomplete="${options.autocomplete}"` : ""
      } value="${escapeHtml(options.value ?? "")}"${
        options.maxLength ? ` maxlength="${options.maxLength}"` : ""
      }${options.required ? " required" : ""}>
    </div>`;
}

function businessAccount(copy: Copy, companyName: string): string {
  return `
    <h2 class="b2b-register__heading">${escapeHtml(copy.businessAccountTitle)}</h2>
    <dl class="b2b-register__card b2b-register__summary">
      <div><dt>${escapeHtml(copy.company)}</dt><dd data-b2b-register-company>${escapeHtml(companyName)}</dd></div>
      <div><dt>${escapeHtml(copy.status)}</dt><dd><span class="b2b-register__badge">${escapeHtml(copy.active)}</span></dd></div>
    </dl>`;
}

function registrationForm(copy: Copy, { signedIn, customer }: PageOptions) {
  const countryCode = customer?.countryCode ?? "";
  const countryOptions = listCountries()
    .map(
      (country) =>
        `<option value="${country.code}"${country.code === countryCode ? " selected" : ""}>${escapeHtml(country.name)}</option>`,
    )
    .join("");
  // Only countries with phone numbering data can be validated.
  const phoneCountryOptions = listCountries()
    .filter((country) => country.phoneCode)
    .map(
      (country) =>
        `<option value="${country.code}"${country.code === countryCode ? " selected" : ""}>${escapeHtml(country.name)} (+${country.phoneCode})</option>`,
    )
    .join("");

  return `
    <form class="b2b-register__card" data-b2b-register-form novalidate>
      <fieldset>
        <legend>${escapeHtml(copy.personalInformation)}</legend>
        <div class="b2b-register__grid">
          ${textField(copy, { name: "firstName", label: "firstName", autocomplete: "given-name", value: customer?.firstName, required: true, maxLength: 100 })}
          ${textField(copy, { name: "lastName", label: "lastName", autocomplete: "family-name", value: customer?.lastName, required: true, maxLength: 100 })}
        </div>
        ${
          // Signed-in customers are identified by the app proxy, so only
          // guests enter an email for their new account.
          signedIn
            ? ""
            : textField(copy, { name: "email", label: "email", type: "email", autocomplete: "email", required: true, maxLength: 254 })
        }
        <label class="b2b-register__checkbox">
          <input type="checkbox" name="remoteAssist">
          ${escapeHtml(copy.remoteAssist)}
        </label>
      </fieldset>

      <fieldset>
        <legend>${escapeHtml(copy.companyInformation)}</legend>
        ${textField(copy, { name: "companyName", label: "company", autocomplete: "organization", required: true, maxLength: 255 })}
        <div class="b2b-register__grid b2b-register__grid--phone">
          <div class="b2b-register__field">
            <label for="b2b-register-phoneCountry">${escapeHtml(copy.phoneCountry)}</label>
            <select id="b2b-register-phoneCountry" name="phoneCountry">
              ${phoneCountryOptions}
            </select>
          </div>
          ${textField(copy, { name: "phone", label: "phone", type: "tel", autocomplete: "tel-national", required: true, maxLength: 30 })}
          ${textField(copy, { name: "phoneExt", label: "phoneExt", maxLength: 10 })}
        </div>
      </fieldset>

      <fieldset>
        <legend>${escapeHtml(copy.addressInformation)}</legend>
        ${textField(copy, { name: "address1", label: "streetAddress", autocomplete: "address-line1", required: true, maxLength: 255 })}
        <div class="b2b-register__grid">
          ${textField(copy, { name: "address2", label: "addressLine2", autocomplete: "address-line2", maxLength: 120 })}
          ${textField(copy, { name: "address3", label: "addressLine3", autocomplete: "address-line3", maxLength: 120 })}
          <div class="b2b-register__field">
            <label for="b2b-register-countryCode">${escapeHtml(copy.country)}</label>
            <select id="b2b-register-countryCode" name="countryCode" autocomplete="country" required>
              <option value="">${escapeHtml(copy.countryPlaceholder)}</option>
              ${countryOptions}
            </select>
          </div>
          <div class="b2b-register__field" data-b2b-register-region>
            <label for="b2b-register-provinceCode">${escapeHtml(copy.stateProvince)}</label>
            <select id="b2b-register-provinceCode" name="provinceCode" autocomplete="address-level1" required>
              <option value="">${escapeHtml(copy.statePlaceholder)}</option>
            </select>
          </div>
          <div class="b2b-register__field">
            <label for="b2b-register-city">${escapeHtml(copy.city)}</label>
            <select id="b2b-register-city" name="city" required data-b2b-register-city-select>
              <option value="">${escapeHtml(copy.cityPlaceholder)}</option>
            </select>
            <input id="b2b-register-city-text" name="city" type="text" autocomplete="address-level2" maxlength="255" aria-label="${escapeHtml(copy.city)}" required disabled hidden data-b2b-register-city-text>
          </div>
          ${textField(copy, { name: "zip", label: "zip", autocomplete: "postal-code", required: true, maxLength: 10 })}
        </div>
      </fieldset>

      <button type="submit" class="button button--primary">${escapeHtml(copy.submit)}</button>
    </form>`;
}

function localizedPage(copy: Copy, options: PageOptions): string {
  const companyName = options.customer?.companyName;
  const messages = {
    submitError: copy.submitError,
    success: copy.success,
    successJoinedCompany: copy.successJoinedCompany,
    addressLoadError: copy.addressLoadError,
    statePlaceholder: copy.statePlaceholder,
    cityPlaceholder: copy.cityPlaceholder,
    phoneInvalid: copy.phoneInvalid,
    firstNameInvalid: copy.firstNameInvalid,
    lastNameInvalid: copy.lastNameInvalid,
    emailInvalid: copy.emailInvalid,
    companyNameInvalid: copy.companyNameInvalid,
    addressInvalid: copy.addressInvalid,
    cityInvalid: copy.cityInvalid,
    zipInvalid: copy.zipInvalid,
    postalCodeCaInvalid: copy.postalCodeCaInvalid,
    postalCodeInvalid: copy.postalCodeInvalid,
  };
  // Guests start from the storefront's country (rendered by Liquid).
  const country = options.customer?.countryCode
    ? escapeHtml(options.customer.countryCode)
    : "{{ localization.country.iso_code }}";

  // Customers already linked to a company see their business account instead.
  if (companyName) {
    return `
      <div class="b2b-register">
        <h1>${escapeHtml(copy.pageTitle)}</h1>
        ${businessAccount(copy, companyName)}
      </div>`;
  }

  return `
    <div class="b2b-register" data-b2b-register data-signed-in="${options.signedIn}"
      data-country="${country}"
      data-province="${escapeHtml(options.customer?.provinceCode ?? "")}"
      data-city="${escapeHtml(options.customer?.city ?? "")}">
      <script type="application/json" data-b2b-register-messages>${scriptJson(messages)}</script>
      <h1>${escapeHtml(copy.pageTitle)}</h1>
      <p class="b2b-register__subdued">${escapeHtml(copy.pageDescription)}</p>
      ${
        options.signedIn
          ? ""
          : `<p>${escapeHtml(copy.signInPrompt)} <a href="{{ routes.account_login_url }}">${escapeHtml(copy.signIn)}</a></p>`
      }
      <div class="b2b-register__banner" role="alert" data-b2b-register-banner hidden></div>
      ${registrationForm(copy, options)}
      <div data-b2b-register-success hidden>
        ${businessAccount(copy, "")}
        ${
          options.signedIn
            ? ""
            : `<p>${escapeHtml(copy.signInAfterRegister)} <a href="{{ routes.account_login_url }}">${escapeHtml(copy.signIn)}</a></p>`
        }
      </div>
    </div>`;
}

const STYLES = `
<style>
  .b2b-register { max-width: 72rem; margin: 0 auto; padding: 3rem 1.5rem; }
  .b2b-register [hidden] { display: none !important; }
  .b2b-register h1 { margin: 0 0 0.5rem; }
  .b2b-register__subdued { opacity: 0.75; margin-top: 0; }
  .b2b-register__heading { margin: 2rem 0 1rem; }
  .b2b-register__card { border: 1px solid color-mix(in srgb, currentColor 15%, transparent); border-radius: 0.75rem; padding: 2rem; }
  .b2b-register form { display: grid; gap: 2rem; }
  .b2b-register fieldset { border: 0; margin: 0; padding: 0; display: grid; gap: 1.25rem; }
  .b2b-register fieldset + fieldset { border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent); padding-top: 2rem; }
  .b2b-register legend { font-weight: 600; font-size: 1.15em; padding: 0; margin-bottom: 1.25rem; }
  .b2b-register__grid { display: grid; gap: 1.25rem; grid-template-columns: 1fr; }
  .b2b-register__field { display: grid; gap: 0.4rem; }
  .b2b-register__field input, .b2b-register__field select { width: 100%; box-sizing: border-box; min-height: 4.4rem; padding: 0.8rem 1.2rem; font: inherit; color: inherit; background: transparent; border: 1px solid color-mix(in srgb, currentColor 40%, transparent); border-radius: 0.5rem; }
  .b2b-register__field select option { color: initial; }
  .b2b-register__field select:disabled { opacity: 0.6; }
  .b2b-register__checkbox { display: flex; gap: 0.75rem; align-items: center; }
  .b2b-register button[type="submit"] { justify-self: start; }
  .b2b-register button[aria-busy="true"] { opacity: 0.6; cursor: progress; }
  .b2b-register__banner { border-radius: 0.5rem; padding: 1.2rem 1.5rem; margin: 1.5rem 0; }
  .b2b-register__banner[data-tone="critical"] { background: color-mix(in srgb, #d72c0d 12%, transparent); border: 1px solid color-mix(in srgb, #d72c0d 50%, transparent); }
  .b2b-register__banner[data-tone="success"] { background: color-mix(in srgb, #008060 12%, transparent); border: 1px solid color-mix(in srgb, #008060 50%, transparent); }
  .b2b-register__summary { margin: 0; display: grid; gap: 1.25rem; }
  .b2b-register__summary div { display: flex; justify-content: space-between; gap: 1rem; }
  .b2b-register__summary div + div { border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent); padding-top: 1.25rem; }
  .b2b-register__summary dt { opacity: 0.75; }
  .b2b-register__summary dd { margin: 0; }
  .b2b-register__badge { border-radius: 999px; padding: 0.2rem 0.9rem; background: color-mix(in srgb, currentColor 10%, transparent); }
  @media (min-width: 750px) {
    .b2b-register__grid { grid-template-columns: 1fr 1fr; }
    .b2b-register__grid--phone { grid-template-columns: 1.5fr 2fr 1fr; }
  }
</style>`;

// Plain JS for the storefront. It must not contain `{{` or `{%`, because the
// whole response is rendered as Liquid.
const SCRIPT = `
<script>
  (function () {
    var root = document.querySelector("[data-b2b-register]");
    if (!root) return;
    var form = root.querySelector("[data-b2b-register-form]");
    var banner = root.querySelector("[data-b2b-register-banner]");
    var success = root.querySelector("[data-b2b-register-success]");
    var button = form.querySelector('button[type="submit"]');
    var messages = JSON.parse(root.querySelector("[data-b2b-register-messages]").textContent);

    function showBanner(tone, message) {
      banner.dataset.tone = tone;
      banner.textContent = message;
      banner.hidden = false;
      banner.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    var country = form.elements.namedItem("countryCode");
    var region = form.elements.namedItem("provinceCode");
    var regionField = root.querySelector("[data-b2b-register-region]");
    var citySelect = root.querySelector("[data-b2b-register-city-select]");
    var cityText = root.querySelector("[data-b2b-register-city-text]");
    var responses = {};

    function loadOptions(params) {
      var url = ${JSON.stringify(REGIONS_PATH)} + "?" + new URLSearchParams(params);
      if (!responses[url]) {
        responses[url] = fetch(url, { headers: { Accept: "application/json" } })
          .then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.json();
          })
          .catch(function (error) { delete responses[url]; throw error; });
      }
      return responses[url];
    }

    function fillSelect(select, options, placeholder, selected) {
      select.replaceChildren(new Option(placeholder, ""));
      options.forEach(function (option) { select.add(new Option(option.label, option.value)); });
      select.value = selected || "";
      if (select.selectedIndex < 0) select.value = "";
    }

    // Strict city list when the dataset has cities for the area; free text
    // only where it has none, so those customers can still register.
    function showCities(names, selected) {
      var hasList = names.length > 0;
      citySelect.hidden = !hasList;
      cityText.hidden = hasList;
      cityText.disabled = hasList;
      citySelect.disabled = !hasList;
      cityText.value = hasList ? "" : selected || "";
      fillSelect(
        citySelect,
        names.map(function (name) { return { value: name, label: name }; }),
        messages.cityPlaceholder,
        selected
      );
    }

    // An empty (still required) city list until a state is picked.
    function resetCities() {
      showCities([], "");
      citySelect.hidden = false;
      citySelect.disabled = false;
      cityText.hidden = true;
      cityText.disabled = true;
    }

    // The browser skips disabled fields when checking required ones and
    // leaves them out of the submission, so only a field that doesn't apply
    // is disabled.
    function showRegions(applies) {
      regionField.hidden = !applies;
      region.disabled = !applies;
    }

    // Each change bumps the token so a slow response for an earlier choice
    // can't overwrite the lists for the current one.
    var loadToken = 0;

    function loadCities(selectedCity) {
      var token = ++loadToken;
      resetCities();
      if (!region.value) return Promise.resolve();
      return loadOptions({ country: country.value, region: region.value }).then(function (result) {
        if (token === loadToken) showCities(result.cities, selectedCity);
      });
    }

    function loadRegions(selectedRegion, selectedCity) {
      var token = ++loadToken;
      fillSelect(region, [], messages.statePlaceholder, "");
      showRegions(true);
      resetCities();
      if (!country.value) return Promise.resolve();
      return loadOptions({ country: country.value }).then(function (result) {
        if (token !== loadToken) return;
        showRegions(result.regions.length > 0);
        fillSelect(
          region,
          result.regions.map(function (entry) { return { value: entry.code, label: entry.name }; }),
          messages.statePlaceholder,
          selectedRegion
        );
        if (result.regions.length) return loadCities(selectedCity);
        showCities(result.cities, selectedCity);
      });
    }

    function addressLoadFailed(error) {
      console.error(error);
      showBanner("critical", messages.addressLoadError);
    }

    // The dial code follows the address country until the customer picks
    // one themselves (e.g. a US company with a Canadian phone number).
    var phoneCountry = form.elements.namedItem("phoneCountry");
    var phoneInput = form.elements.namedItem("phone");
    var phoneCountryChosen = false;

    // The server checks the number against the dial-code country's numbering
    // plan. A number typed as +<code>… (often by autofill) moves the dial code
    // to its country; valid numbers are shown in that country's format.
    function verifyPhone() {
      var number = phoneInput.value.trim();
      var dialCountry = phoneCountry.value;
      if (!number) return Promise.resolve(true);
      return fetch(${JSON.stringify(PHONE_PATH)}, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ number: number, country: dialCountry }),
        credentials: "same-origin",
      })
        .then(function (response) {
          if (!response.ok) throw new Error("HTTP " + response.status);
          return response.json();
        })
        .then(function (result) {
          // Ignore answers for a number or dial code that has since changed.
          if (phoneInput.value.trim() !== number || phoneCountry.value !== dialCountry) return true;
          if (!result.valid) return false;
          if (result.countryCode !== dialCountry) {
            phoneCountry.value = result.countryCode;
            phoneCountryChosen = true;
          }
          phoneInput.value = result.national;
          return true;
        })
        .catch(function (error) {
          // The submit endpoint still validates.
          console.error(error);
          return true;
        });
    }

    // Checked when the customer leaves the field only to format it; messages
    // are shown on submit.
    phoneInput.addEventListener("change", verifyPhone);

    // Errors the submit endpoint returned, kept until that field changes.
    var serverErrors = {};
    // Names in any script: letters, spaces, apostrophes, periods, hyphens.
    var namePattern = /^[\\p{L}\\p{M}][\\p{L}\\p{M}\\s'’.\\-]*$/u;

    // Format rules for filled-in fields; the browser checks required ones.
    function fieldProblem(el) {
      var value = el.value.trim();
      if (!value) return "";
      var serverError = serverErrors[el.name];
      if (serverError && serverError.value === value) return serverError.message;
      switch (el.name) {
        case "firstName":
          return namePattern.test(value) ? "" : messages.firstNameInvalid;
        case "lastName":
          return namePattern.test(value) ? "" : messages.lastNameInvalid;
        case "email":
          return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test(value) ? "" : messages.emailInvalid;
        case "companyName":
          return (value.match(/[\\p{L}\\p{N}]/gu) || []).length >= 2 ? "" : messages.companyNameInvalid;
        case "address1":
          return value.length >= 3 && /[\\p{L}\\p{N}]/u.test(value) ? "" : messages.addressInvalid;
        case "city":
          return /\\p{L}/u.test(value) ? "" : messages.cityInvalid;
        case "phoneExt":
          return /^\\d+$/.test(value) ? "" : messages.phoneInvalid;
        case "zip":
          if (country.value === "US") return /^\\d{5}(-\\d{4})?$/.test(value) ? "" : messages.zipInvalid;
          if (country.value === "CA") {
            return /^[A-Za-z]\\d[A-Za-z][ -]?\\d[A-Za-z]\\d$/.test(value) ? "" : messages.postalCodeCaInvalid;
          }
          return /^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$/.test(value) ? "" : messages.postalCodeInvalid;
      }
      return "";
    }
    phoneCountry.addEventListener("change", function () {
      phoneCountryChosen = true;
      verifyPhone();
    });

    country.addEventListener("change", function () {
      loadRegions("", "").catch(addressLoadFailed);
      if (!phoneCountryChosen && country.value && country.value !== phoneCountry.value) {
        phoneCountry.value = country.value;
        verifyPhone();
      }
    });
    region.addEventListener("change", function () { loadCities("").catch(addressLoadFailed); });

    // Preselect the signed-in customer's default address, or the
    // storefront's country for guests.
    if (!country.value && root.dataset.country) country.value = root.dataset.country;
    if (country.value && phoneCountry.querySelector('option[value="' + country.value + '"]')) {
      phoneCountry.value = country.value;
    }
    loadRegions(root.dataset.province, root.dataset.city).catch(addressLoadFailed);

    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      banner.hidden = true;

      // Messages only change here, so they stay put while the customer
      // fixes a field.
      button.disabled = true;
      var phoneValid = await verifyPhone();
      button.disabled = false;
      Array.prototype.forEach.call(form.elements, function (el) {
        if (el.setCustomValidity && !el.disabled) el.setCustomValidity(fieldProblem(el));
      });
      if (!phoneValid) phoneInput.setCustomValidity(messages.phoneInvalid);
      if (!form.reportValidity()) return;

      var data = new FormData(form);
      var value = function (name) { return String(data.get(name) || "").trim(); };
      var phone = value("phone");
      var phoneExt = value("phoneExt");
      var payload = {
        firstName: value("firstName"),
        lastName: value("lastName"),
        email: value("email"),
        companyName: value("companyName"),
        phone: phoneExt ? phone + " ext. " + phoneExt : phone,
        address1: value("address1"),
        address2: [value("address2"), value("address3")].filter(Boolean).join(", "),
        city: value("city"),
        provinceCode: value("provinceCode"),
        countryCode: value("countryCode"),
        phoneCountryCode: value("phoneCountry"),
        zip: value("zip"),
        remoteShoppingAssistance: data.has("remoteAssist"),
        locale: {{ request.locale.iso_code | json }},
      };

      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      try {
        var response = await fetch(${JSON.stringify(SUBMIT_PATH)}, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(payload),
          credentials: "same-origin",
        });
        var result = null;
        try { result = await response.json(); } catch (error) { result = null; }

        if (response.ok && result && result.ok) {
          var companyName = result.companyName || payload.companyName;
          form.hidden = true;
          success.querySelector("[data-b2b-register-company]").textContent = companyName;
          success.hidden = false;
          showBanner(
            "success",
            result.created === false && result.companyName
              ? messages.successJoinedCompany.replace("%companyName%", result.companyName)
              : messages.success
          );
          return;
        }

        // Show a field's error on that field.
        var target = result && result.field
          ? form.querySelector('[name="' + result.field + '"]:not(:disabled)')
          : null;
        if (target) {
          serverErrors[target.name] = {
            value: target.value.trim(),
            message: target === phoneInput ? messages.phoneInvalid : result.error,
          };
          target.setCustomValidity(serverErrors[target.name].message);
          target.reportValidity();
          return;
        }

        var details = (result && result.userErrors ? result.userErrors : [])
          .map(function (entry) { return entry.message; });
        showBanner(
          "critical",
          [(result && result.error) || messages.submitError].concat(details).join(" ")
        );
      } catch (error) {
        console.error(error);
        showBanner("critical", messages.submitError);
      } finally {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    });
  })();
</script>`;

/**
 * Liquid for the storefront registration page at /apps/b2b-register. Shopify
 * renders it inside the theme layout, so the store header and footer show.
 */
export function renderB2bRegistrationPage(options: PageOptions): string {
  return `${STYLES}
{%- assign b2b_register_lang = request.locale.iso_code | slice: 0, 2 -%}
{%- if b2b_register_lang == 'fr' -%}
${localizedPage(FR, options)}
{%- else -%}
${localizedPage(EN, options)}
{%- endif -%}
${SCRIPT}`;
}
