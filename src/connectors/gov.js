/**
 * Government open-data connectors — free, keyless, documented US federal APIs.
 *
 * Two agencies publish exactly the data two of our tool categories were being
 * asked to scrape, and publish it as JSON with no key and no account:
 *
 *   nhtsa-vin     NHTSA vPIC — decode a VIN to 154 vehicle fields.
 *                 Docs:    https://vpic.nhtsa.dot.gov/api/
 *                 robots:  https://vpic.nhtsa.dot.gov/robots.txt is HTTP 404 —
 *                          the host publishes none, so nothing is disallowed.
 *                          (www.nhtsa.gov's robots.txt is a different host and
 *                          does not govern this one; it answers 403 anyway.)
 *                 Rates:   the API help states vPIC applies "an automated
 *                          traffic rate control mechanism", so the caller's
 *                          own polite-rate policy still applies (G6).
 *
 *   npi-provider  NPPES NPI Registry — US health care provider records.
 *                 Docs:    https://npiregistry.cms.hhs.gov/api-page
 *                 robots:  https://npiregistry.cms.hhs.gov/robots.txt answers
 *                          HTTP 200 with the site's Angular index.html
 *                          (content-type: text/html, 406 bytes) rather than a
 *                          robots file — a soft 404. There are no directives
 *                          to honour on this host.
 *
 * Both are documented APIs, which is why they are here instead of a scraper
 * pointed at the same agencies' search pages (G3).
 *
 * Templates make no network calls: `listUrl(params)` builds the URL and the
 * caller fetches it under its own SSRF, timeout and billing policy.
 *
 * Every fixture under tests/fixtures/gov/ is condensed from a live capture
 * taken 2026-08-28 with
 *   curl -A 'CrawlForge/1.2.4 (+https://crawlforge.dev)'
 * — a car, a truck, a motorcycle, a partial VIN and an undecodable one for
 * vPIC; individuals, organisations and all three error shapes for NPPES.
 */

// ── NHTSA vPIC ───────────────────────────────────────────────────────────────

const VPIC_BASE = 'https://vpic.nhtsa.dot.gov/api/vehicles';

/**
 * vPIC writes "" for a variable it holds no value for — its own response
 * Message says so, and warns that a missing value must not be read as "the
 * feature is unavailable". Around 120 of the 154 fields come back empty on a
 * typical decode, and once "" is sitting in a record a caller cannot tell it
 * from a real value.
 */
function vinValue(value) {
  const trimmed = typeof value === 'string' ? value.trim() : value;
  return trimmed === '' || trimmed === undefined ? null : trimmed;
}

/**
 * ErrorCode is a comma-joined list — "6,7,11,400" on a VIN with invalid
 * characters. "0" is the not-an-error code ("VIN decoded clean"), so an empty
 * list here is the clean decode.
 *
 * The matching ErrorText is surfaced whole rather than split per code: code 7's
 * own description contains a semicolon ("…for use on U.S roads; Please contact
 * the manufacturer directly for more information"), so splitting on the "; "
 * separator yields five parts for four codes.
 */
function vinErrorCodes(value) {
  return String(value ?? '')
    .split(',')
    .map(code => code.trim())
    .filter(code => code && code !== '0');
}

// ── NPPES NPI Registry ───────────────────────────────────────────────────────

const NPI_ENDPOINT = 'https://npiregistry.cms.hhs.gov/api/';

// Versions 1.0 and 2.0 are retired, and so is the unversioned endpoint — the
// registry answers all three with an "Unsupported Version" error now.
const NPI_VERSION = '2.1';

// Documented ceilings: 200 records per request, skip up to 1000.
const NPI_MAX_LIMIT = 200;
const NPI_MAX_SKIP = 1000;
const NPI_DEFAULT_LIMIT = 10;

/** The registry's documented search criteria, in its own spelling. */
const NPI_SEARCH_FIELDS = [
  'number',
  'enumeration_type',
  'taxonomy_description',
  'name_purpose',
  'first_name',
  'use_first_name_alias',
  'last_name',
  'organization_name',
  'address_purpose',
  'city',
  'state',
  'postal_code',
  'country_code'
];

/**
 * The registry writes "--" where a name part is absent — 1265566509 and
 * 1184624694 both carry name_suffix "--" (captured 2026-08-28). Passed through
 * it renders as a real suffix, so it reads as null, the same way an unset
 * Shopify compare-at price does.
 */
function npiNamePart(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed && trimmed !== '--' ? trimmed : null;
}

/**
 * Compose the display name from whichever name fields the record carries.
 *
 * A `basic` block spells the affixes name_prefix/name_suffix; an `other_names`
 * entry spells the same two fields prefix/suffix. Both are read here so one
 * function covers both shapes.
 */
function npiName(fields) {
  if (fields.organization_name) return npiNamePart(fields.organization_name);
  const parts = [
    fields.name_prefix ?? fields.prefix,
    fields.first_name,
    fields.middle_name,
    fields.last_name,
    fields.name_suffix ?? fields.suffix
  ];
  return parts.map(npiNamePart).filter(Boolean).join(' ') || null;
}

/** sole_proprietor is "YES"/"NO" on individuals and absent on organisations. */
function npiYesNo(value) {
  if (value === 'YES') return true;
  if (value === 'NO') return false;
  return null;
}

function npiAddress(address) {
  if (!address) return null;
  return {
    purpose: address.address_purpose || null,
    line1: address.address_1 || null,
    line2: address.address_2 || null,
    city: address.city || null,
    state: address.state || null,
    // ZIP+4 arrives unhyphenated ("920204454"), left as the registry writes it.
    postal_code: address.postal_code || null,
    country_code: address.country_code || null,
    country_name: address.country_name || null,
    telephone: address.telephone_number || null,
    fax: address.fax_number || null
  };
}

/**
 * The registry silently caps rather than reporting: limit=1201 answers
 * result_count 200, not an error (verified 2026-08-28). A caller that paginates
 * on the page size it asked for would step over records it never received, so
 * the ceiling is named here instead of quietly applied.
 */
function npiBound(name, value, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(
      `npi-provider "${name}" must be an integer between ${min} and ${max}. ` +
      `The NPI registry silently caps anything larger instead of reporting it. Got: ${value}`
    );
  }
  return number;
}

/** limit and skip live in the request; the response echoes neither. */
function npiPaging(url) {
  let params;
  try {
    params = new URL(url).searchParams;
  } catch {
    params = new URLSearchParams();
  }
  const limit = Number.parseInt(params.get('limit') ?? '', 10);
  const skip = Number.parseInt(params.get('skip') ?? '', 10);
  return {
    limit: Number.isInteger(limit) ? limit : NPI_DEFAULT_LIMIT,
    skip: Number.isInteger(skip) ? skip : 0
  };
}

// ── Connector definitions ────────────────────────────────────────────────────

export const GOV_TEMPLATES = [
  {
    id: 'nhtsa-vin',
    name: 'NHTSA VIN Decode',
    description:
      'Decode a VIN against NHTSA\'s vPIC API: make, model, year, trim, body class, drive type, ' +
      'engine, fuel, transmission, plant and GVWR, plus the full 154-field decode under `raw`. ' +
      'Free, keyless and authoritative — the catalogue is built from the manufacturers\' own Part ' +
      '565 submissions, so nothing is inferred or guessed. Partial VINs are accepted ("*" for ' +
      'unknown positions), and vPIC\'s own error codes are reported rather than swallowed.',
    targetPattern: /vpic\.nhtsa\.dot\.gov\/api\/vehicles\/DecodeVin/i,

    /**
     * @param {{ vin: string, modelYear?: string|number }} params
     */
    listUrl({ vin, modelYear } = {}) {
      const value = typeof vin === 'string' ? vin.trim() : '';
      if (!value) {
        throw new Error(
          'nhtsa-vin requires a "vin" parameter: the VIN to decode. A partial VIN is allowed — ' +
          'vPIC accepts "*" for unknown positions, as in 5UXWX7C5*BA.'
        );
      }
      const url = new URL(`${VPIC_BASE}/DecodeVinValues/${encodeURIComponent(value)}`);
      url.searchParams.set('format', 'json');
      // vPIC documents modelyear as improving decode accuracy, and says so in
      // the response itself when it matters: a VIN whose 10th position is
      // ambiguous comes back with "The Model Year decoded for this VIN may be
      // incorrect. If you know the Model year, please enter it and decode again".
      if (modelYear !== undefined && modelYear !== null && modelYear !== '') {
        url.searchParams.set('modelyear', String(modelYear));
      }
      return url.toString();
    },

    /**
     * Point the fetch at the flat DecodeVinValues endpoint, in JSON.
     *
     * vPIC has four decode endpoints and every one of them defaults to XML.
     * DecodeVin and DecodeVinExtended return a [{ Variable, Value }] list this
     * template does not read, so a caller pasting a URL straight out of the
     * documentation (…/DecodeVin/5UXWX7C5*BA?format=xml&modelyear=2011) would
     * otherwise fetch a body extractRaw rejects.
     */
    resolveUrl(url) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return url;
      }
      const match = parsed.pathname.match(
        /^(.*\/api\/vehicles\/)DecodeVin(?:Values)?(?:Extended)?\/(.+)$/i
      );
      if (!match) return url;
      parsed.pathname = `${match[1]}DecodeVinValues/${match[2]}`;
      parsed.searchParams.set('format', 'json');
      return parsed.toString();
    },

    extractRaw(body, url) {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new Error(
          `Not a vPIC decode response: ${url} did not return JSON. ` +
          'This template reads the NHTSA vPIC DecodeVinValues API.'
        );
      }

      const result = Array.isArray(payload?.Results) ? payload.Results[0] : null;
      // A parseable body is not proof of a decode: vPIC answers a missing VIN
      // with a 404 whose body is JSON — {"message":"No HTTP resource was found
      // that matches the request URI …"}. ErrorCode is the flat shape's
      // discriminator; the nested DecodeVin shape has no such key.
      if (!result || !('ErrorCode' in result)) {
        const reason = typeof payload?.message === 'string'
          ? payload.message
          : 'JSON without a decoded vehicle';
        throw new Error(
          `Not a vPIC decode response: ${url} returned ${reason}. ` +
          'This template reads the NHTSA vPIC DecodeVinValues API.'
        );
      }

      // The whole decode, empties normalised, so nothing vPIC returned is lost
      // by the curated shape below. "Not Applicable" is left as written — it is
      // vPIC's real answer for a variable that does not apply to this class of
      // vehicle (BusType on a pickup), not a missing value.
      const raw = Object.fromEntries(
        Object.entries(result).map(([key, value]) => [key, vinValue(value)])
      );

      return {
        vin: raw.VIN,
        // The VIN with the serial positions masked — what vPIC actually keyed
        // the lookup on, and safe to log where the full VIN is not.
        vehicle_descriptor: raw.VehicleDescriptor,

        make: raw.Make,
        model: raw.Model,
        model_year: raw.ModelYear,
        trim: raw.Trim,
        series: raw.Series,
        body_class: raw.BodyClass,
        vehicle_type: raw.VehicleType,
        doors: raw.Doors,
        drive_type: raw.DriveType,
        gvwr: raw.GVWR,

        engine_cylinders: raw.EngineCylinders,
        engine_displacement_l: raw.DisplacementL,
        engine_hp: raw.EngineHP,
        engine_configuration: raw.EngineConfiguration,
        engine_model: raw.EngineModel,
        engine_manufacturer: raw.EngineManufacturer,
        fuel_type_primary: raw.FuelTypePrimary,
        fuel_type_secondary: raw.FuelTypeSecondary,
        transmission_style: raw.TransmissionStyle,
        transmission_speeds: raw.TransmissionSpeeds,

        manufacturer: raw.Manufacturer,
        plant_city: raw.PlantCity,
        plant_state: raw.PlantState,
        plant_country: raw.PlantCountry,

        // vPIC decodes partially and says so in the payload rather than in the
        // HTTP status: a wrong check digit (code 1) still yields a full, usable
        // decode, while invalid characters (code 400) yield make and model of
        // null. A caller has to be able to see which it got.
        decode_errors: {
          codes: vinErrorCodes(raw.ErrorCode),
          text: raw.ErrorText,
          additional_text: raw.AdditionalErrorText,
          suggested_vin: raw.SuggestedVIN
        },

        raw
      };
    }
  },

  {
    id: 'npi-provider',
    name: 'NPI Provider Registry',
    description:
      'Search the NPPES NPI Registry — the public US health care provider registry CMS publishes — ' +
      'by NPI number, name, organisation, taxonomy/specialty or location. Returns registry records ' +
      'as the registry publishes them: NPI, individual-or-organisation type, credential, status, ' +
      'taxonomies with the primary one flagged, and practice and mailing addresses kept apart. ' +
      'Free and keyless. It is a registry lookup, not a people-search: it returns one record per ' +
      'NPI and joins nothing to it.',
    targetPattern: /npiregistry\.cms\.hhs\.gov\/api/i,

    /**
     * @param {Record<string, string|number>} params — the registry's own search fields
     */
    listUrl(params = {}) {
      const url = new URL(NPI_ENDPOINT);
      url.searchParams.set('version', NPI_VERSION);

      let criteria = 0;
      for (const field of NPI_SEARCH_FIELDS) {
        const value = params[field];
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(field, String(value));
        criteria += 1;
      }
      if (criteria === 0) {
        throw new Error(
          'npi-provider requires at least one search criterion. Accepted: ' +
          `${NPI_SEARCH_FIELDS.join(', ')}. The registry answers a bare query with HTTP 200 and ` +
          '{"Errors":[{"description":"No valid search criteria provided"}]}.'
        );
      }

      // The registry has further rules of its own — `state` and
      // `enumeration_type` cannot stand alone, `country_code` can only when it
      // is not US. Those are not re-implemented here: it enforces them itself,
      // and extractList turns its answer into a named error.
      if (params.limit !== undefined && params.limit !== null && params.limit !== '') {
        url.searchParams.set('limit', String(npiBound('limit', params.limit, 1, NPI_MAX_LIMIT)));
      }
      if (params.skip !== undefined && params.skip !== null && params.skip !== '') {
        url.searchParams.set('skip', String(npiBound('skip', params.skip, 0, NPI_MAX_SKIP)));
      }

      return url.toString();
    },

    extractList(body, url) {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new Error(
          `Not an NPI registry response: ${url} did not return JSON. ` +
          'This connector reads the NPPES NPI Registry API.'
        );
      }

      // The registry reports every error with HTTP 200 and an Errors array — a
      // bare query, a retired version, a state with no second criterion. Left
      // alone it would fall through to an empty item list, which reads as "no
      // such provider" when the truth is "the query was never run".
      if (Array.isArray(payload?.Errors) && payload.Errors.length) {
        const detail = payload.Errors
          .map(error => [error.field, error.description].filter(Boolean).join(': '))
          .join('; ');
        throw new Error(`NPI registry rejected the query for ${url}: ${detail}.`);
      }

      if (!Array.isArray(payload?.results)) {
        throw new Error(
          `Not an NPI registry response: ${url} returned JSON without a results array. ` +
          'This connector reads the NPPES NPI Registry API.'
        );
      }

      const items = payload.results.map(record => {
        const basic = record.basic || {};
        const addresses = Array.isArray(record.addresses) ? record.addresses : [];

        // The registry's API help states "the first address in the array will
        // always be the Primary Practice Location and the second address in the
        // array will always be the Mailing Address". It is not true: across the
        // 233 records captured 2026-08-28, 118 (50.6%) put MAILING first.
        // Reading addresses[0] as the practice location therefore returns a
        // mailing address — for a sole proprietor, often a home address — about
        // half the time. Both are keyed by address_purpose, never by index.
        const location = addresses.find(a => a.address_purpose === 'LOCATION');
        const mailing = addresses.find(a => a.address_purpose === 'MAILING');

        const taxonomies = (record.taxonomies || []).map(taxonomy => ({
          code: taxonomy.code || null,
          description: taxonomy.desc || null,
          primary: taxonomy.primary === true,
          license: taxonomy.license || null,
          state: taxonomy.state || null,
          // "" on most individuals, "193400000X - Single Specialty Group" on a
          // record that belongs to one.
          group: taxonomy.taxonomy_group || null
        }));

        return {
          npi: record.number || null,
          // NPI-1 is an individual provider, NPI-2 an organisation.
          enumeration_type: record.enumeration_type || null,
          name: npiName(basic),
          first_name: npiNamePart(basic.first_name),
          last_name: npiNamePart(basic.last_name),
          organization_name: npiNamePart(basic.organization_name),
          credential: npiNamePart(basic.credential),
          sole_proprietor: npiYesNo(basic.sole_proprietor),
          // "A" is active; the registry keeps deactivated records readable.
          status: basic.status || null,
          enumeration_date: basic.enumeration_date || null,
          last_updated: basic.last_updated || null,

          // A taxonomy_description search matches ANY of a provider's up-to-15
          // taxonomies, not the primary one: NPI 1982227625 answers a Cardiology
          // search with a primary taxonomy of "Pharmacist, Ambulatory Care".
          // Without this field a caller reads the result set as "cardiologists".
          primary_taxonomy: taxonomies.find(t => t.primary)?.description ?? null,
          taxonomies,

          addresses: {
            location: npiAddress(location),
            mailing: npiAddress(mailing)
          },
          // Additional practice sites, which the registry keeps in its own array
          // rather than in `addresses`.
          practice_locations: (record.practiceLocations || []).map(npiAddress),

          other_names: (record.other_names || []).map(other => ({
            type: other.type || null,
            name: npiName(other)
          }))
        };
      });

      const { limit, skip } = npiPaging(url);

      return {
        items,
        count: items.length,
        limit,
        skip,
        // The registry publishes no total. result_count is the size of THIS
        // page, not of the match: the same CA/Internal Medicine query answered
        // result_count 5 at limit=5 and 200 at limit=200 (2026-08-28). So there
        // is no total to report, and a full page is the only "there may be more"
        // signal the API gives — the registry's own stop condition is a page
        // shorter than the limit.
        more_possible: items.length === limit
      };
    }
  }
];

/**
 * G8 — npi-provider is a registry passthrough, not a profile builder.
 *
 * NPPES is a public professional registry: CMS publishes every NPI record for
 * anyone to read, and this connector returns those records as the registry
 * writes them. It has no enrichment hook, no join against any other source and
 * no "everything about this person" shape — the query surface is the registry's
 * own documented search, and the output is one record per NPI.
 *
 * Sole-proprietor records (NPI-1) carry an individual's name, credential and
 * practice address by the registry's own design. That is registry data being
 * passed through, not a profile being assembled.
 *
 * Two fields the registry does publish are deliberately left in it, because
 * neither is professional-registry information a provider lookup needs:
 *   basic.sex                    a personal demographic attribute
 *   basic.authorized_official_*  the name, title and direct telephone number of
 *                                the individual who signed for an organisation
 * Anyone who needs them can read the registry. This connector is not the tool
 * that collects them into a picture of a person.
 */

export default GOV_TEMPLATES;
