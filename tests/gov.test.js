/**
 * Unit tests: the government open-data connectors.
 *
 * Run: node --test tests/gov.test.js
 *
 * Every fixture under tests/fixtures/gov/ is condensed from a live capture taken
 * 2026-08-28 with `curl -A 'CrawlForge/1.2.4 (+https://crawlforge.dev)'` against
 * the two agencies' own APIs — never written from the published field list. That
 * inversion is what let youtube-video break unnoticed: a fixture written from
 * the field list only proves the parser matches itself.
 *
 * The captures deliberately cover the shapes a single happy-path example hides:
 *   vPIC     a car, a truck, a motorcycle, a partial VIN and a VIN it cannot
 *            decode — each answered HTTP 200, three of them with error codes.
 *   NPPES    individuals, organisations, a former name, an empty result set and
 *            two error payloads — again all HTTP 200.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GOV_TEMPLATES } from '../src/connectors/gov.js';

const fixture = name =>
  readFileSync(new URL(`./fixtures/gov/${name}.json`, import.meta.url), 'utf8');

const vin = GOV_TEMPLATES.find(t => t.id === 'nhtsa-vin');
const npi = GOV_TEMPLATES.find(t => t.id === 'npi-provider');

const VPIC_URL = 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/x?format=json';
const NPI_URL = 'https://npiregistry.cms.hhs.gov/api/?version=2.1&state=CA&taxonomy_description=Cardiology&limit=5';

const decode = name => vin.extractRaw(fixture(name), VPIC_URL);
const search = (name, url = NPI_URL) => npi.extractList(fixture(name), url);

// ── nhtsa-vin ────────────────────────────────────────────────────────────────

describe('nhtsa-vin URL building', () => {
  test('builds the flat JSON decode URL from a VIN', () => {
    assert.equal(
      vin.listUrl({ vin: '1HGCM82633A004352' }),
      'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/1HGCM82633A004352?format=json'
    );
  });

  test('keeps the "*" a partial VIN needs', () => {
    assert.equal(
      vin.listUrl({ vin: '5UXWX7C5*BA' }),
      'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/5UXWX7C5*BA?format=json'
    );
  });

  test('passes modelYear through, which vPIC documents as improving accuracy', () => {
    assert.equal(
      vin.listUrl({ vin: '1FTFW1ET5DFC10312', modelYear: 2013 }),
      'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/1FTFW1ET5DFC10312?format=json&modelyear=2013'
    );
  });

  test('throws naming the missing parameter', () => {
    assert.throws(() => vin.listUrl({}), /requires a "vin" parameter/);
    assert.throws(() => vin.listUrl({ vin: '   ' }), /requires a "vin" parameter/);
  });
});

describe('nhtsa-vin URL resolution', () => {
  test('rewrites the XML documentation URL to the flat JSON endpoint', () => {
    assert.equal(
      vin.resolveUrl('https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/5UXWX7C5*BA?format=xml&modelyear=2011'),
      'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/5UXWX7C5*BA?format=json&modelyear=2011'
    );
  });

  test('rewrites the Extended endpoint, whose flat shape this template does not read', () => {
    assert.equal(
      vin.resolveUrl('https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/1HGCM82633A004352?format=json'),
      'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/1HGCM82633A004352?format=json'
    );
  });

  test('leaves an unrelated URL alone', () => {
    assert.equal(vin.resolveUrl('https://example.com/whatever'), 'https://example.com/whatever');
  });

  test('matches a vPIC decode URL with its targetPattern', () => {
    assert.match(
      'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/1HGCM82633A004352?format=json',
      vin.targetPattern
    );
  });
});

describe('nhtsa-vin extraction', () => {
  test('decodes a passenger car', () => {
    const data = decode('nhtsa-vin-car');
    assert.equal(data.vin, '1HGCM82633A004352');
    assert.equal(data.make, 'HONDA');
    assert.equal(data.model, 'Accord');
    assert.equal(data.model_year, '2003');
    assert.equal(data.trim, 'EX-V6');
    assert.equal(data.body_class, 'Coupe');
    assert.equal(data.vehicle_type, 'PASSENGER CAR');
    assert.equal(data.doors, '2');
    assert.equal(data.transmission_style, 'Automatic');
    assert.equal(data.transmission_speeds, '5');
    assert.equal(data.engine_hp, '240');
    assert.equal(data.engine_model, 'J30A4');
    assert.equal(data.plant_city, 'MARYSVILLE');
    assert.equal(data.plant_country, 'UNITED STATES (USA)');
    assert.equal(data.gvwr, 'Class 1C: 4,001 - 5,000 lb (1,814 - 2,268 kg)');
  });

  test('decodes a truck, including the body-specific fields a car has none of', () => {
    const data = decode('nhtsa-vin-truck');
    assert.equal(data.make, 'FORD');
    assert.equal(data.model, 'F-150');
    assert.equal(data.vehicle_type, 'TRUCK');
    assert.equal(data.body_class, 'Pickup');
    assert.equal(data.drive_type, '4WD/4-Wheel Drive/4x4');
    assert.equal(data.engine_manufacturer, 'Ford');
    assert.equal(data.raw.BodyCabType, 'Crew/Super Crew/Crew Max');
  });

  test('decodes a motorcycle, which reports a series and no doors', () => {
    const data = decode('nhtsa-vin-motorcycle');
    assert.equal(data.make, 'HARLEY-DAVIDSON');
    assert.equal(data.model, 'Street Glide');
    assert.equal(data.vehicle_type, 'MOTORCYCLE');
    assert.equal(data.body_class, 'Motorcycle - Touring/Sport Touring');
    assert.equal(data.series, 'FLHX');
    assert.equal(data.doors, null);
    assert.equal(data.raw.OtherMotorcycleInfo, 'Heavyweight Motorcycle: 901cm3 or larger');
  });

  test('reads "" as null, because vPIC writes it for "no value held"', () => {
    const car = decode('nhtsa-vin-car');
    // Present and empty in the live capture, not absent.
    assert.equal(car.series, null);
    assert.equal(car.drive_type, null);
    assert.equal(car.fuel_type_secondary, null);
    assert.equal(decode('nhtsa-vin-truck').trim, null);
    assert.equal(decode('nhtsa-vin-partial').plant_state, null);
  });

  test('leaves "Not Applicable" alone — it is an answer, not a missing value', () => {
    assert.equal(decode('nhtsa-vin-truck').raw.BusType, 'Not Applicable');
    assert.equal(decode('nhtsa-vin-motorcycle').raw.BedType, 'Not Applicable');
  });

  test('keeps the whole 154-field decode under raw', () => {
    const data = decode('nhtsa-vin-car');
    assert.equal(data.raw.ValveTrainDesign, 'Single Overhead Cam (SOHC)');
    assert.equal(data.raw.AirBagLocCurtain, '1st and 2nd Rows');
    assert.equal(data.raw.DisplacementCI, '183');
  });

  test('reports a clean decode as no error codes', () => {
    const data = decode('nhtsa-vin-car');
    assert.deepEqual(data.decode_errors.codes, []);
    assert.match(data.decode_errors.text, /VIN decoded clean/);
    assert.equal(data.decode_errors.suggested_vin, null);
  });

  test('surfaces a bad check digit without hiding the decode it still produced', () => {
    const data = decode('nhtsa-vin-truck');
    assert.deepEqual(data.decode_errors.codes, ['1']);
    assert.match(data.decode_errors.text, /Check Digit \(9th position\) does not calculate properly/);
    assert.match(data.decode_errors.additional_text, /Model Year decoded for this VIN may be incorrect/);
    // The point of reporting rather than throwing: the vehicle still decoded.
    assert.equal(data.make, 'FORD');
  });

  test('reports an incomplete VIN as code 6 and still returns what decoded', () => {
    const data = decode('nhtsa-vin-partial');
    assert.deepEqual(data.decode_errors.codes, ['6']);
    assert.equal(data.vin, '5UXWX7C5*BA');
    assert.equal(data.vehicle_descriptor, '5UXWX7C5*BA');
    assert.equal(data.make, 'BMW');
    assert.equal(data.model, 'X3');
    assert.equal(data.trim, 'xDrive35i');
    assert.equal(data.plant_country, 'GERMANY');
  });

  test('reports every code on a VIN it cannot decode, answered HTTP 200', () => {
    const data = decode('nhtsa-vin-undecodable');
    assert.deepEqual(data.decode_errors.codes, ['6', '7', '11', '400']);
    assert.equal(data.decode_errors.suggested_vin, 'N!TAREAL!!N12345');
    assert.equal(data.decode_errors.additional_text, 'Invalid character(s): 2:O, 9:V, 10:I.');
    // Nothing decoded — but the codes say why, which an empty record alone would not.
    assert.equal(data.make, null);
    assert.equal(data.model, null);
    assert.equal(data.model_year, null);
  });

  test('the ErrorText for a multi-code failure survives code 7\'s own semicolon', () => {
    const { text } = decode('nhtsa-vin-undecodable').decode_errors;
    assert.match(text, /7 - Manufacturer is not registered with NHTSA[^;]*; Please contact the manufacturer/);
    assert.match(text, /400 - Invalid Characters Present/);
  });

  test('throws on the JSON 404 vPIC answers a missing VIN with', () => {
    assert.throws(
      () => vin.extractRaw(fixture('nhtsa-vin-not-found'), VPIC_URL),
      /Not a vPIC decode response.*No HTTP resource was found/s
    );
  });

  test('throws on the nested DecodeVin shape rather than returning empty fields', () => {
    const nested = JSON.stringify({ Count: 136, Results: [{ Variable: 'Make', Value: 'HONDA', VariableId: 26 }] });
    assert.throws(() => vin.extractRaw(nested, VPIC_URL), /Not a vPIC decode response/);
  });

  test('throws when the response is not JSON', () => {
    assert.throws(
      () => vin.extractRaw('<!doctype html><html>Access Denied</html>', VPIC_URL),
      /did not return JSON/
    );
  });
});

// ── npi-provider ─────────────────────────────────────────────────────────────

describe('npi-provider URL building', () => {
  test('builds a documented search URL and pins the API version', () => {
    const url = new URL(npi.listUrl({ state: 'CA', taxonomy_description: 'Cardiology', limit: 5 }));
    assert.equal(url.origin + url.pathname, 'https://npiregistry.cms.hhs.gov/api/');
    // 1.0, 2.0 and the unversioned endpoint are retired.
    assert.equal(url.searchParams.get('version'), '2.1');
    assert.equal(url.searchParams.get('state'), 'CA');
    assert.equal(url.searchParams.get('taxonomy_description'), 'Cardiology');
    assert.equal(url.searchParams.get('limit'), '5');
  });

  test('supports the registry\'s documented criteria', () => {
    const url = new URL(npi.listUrl({
      number: '1265478150',
      enumeration_type: 'NPI-2',
      first_name: 'jo',
      last_name: 'smith',
      organization_name: 'hospital*',
      taxonomy_description: 'Internal Medicine',
      city: 'EL PASO',
      state: 'TX',
      postal_code: '79925',
      country_code: 'US',
      limit: 25,
      skip: 50
    }));
    for (const [key, value] of Object.entries({
      number: '1265478150', enumeration_type: 'NPI-2', first_name: 'jo', last_name: 'smith',
      organization_name: 'hospital*', taxonomy_description: 'Internal Medicine',
      city: 'EL PASO', state: 'TX', postal_code: '79925', country_code: 'US',
      limit: '25', skip: '50'
    })) {
      assert.equal(url.searchParams.get(key), value, key);
    }
  });

  test('throws when no search criterion is given, which the API answers with an error body', () => {
    assert.throws(() => npi.listUrl({}), /requires at least one search criterion/);
    assert.throws(() => npi.listUrl({ limit: 20 }), /requires at least one search criterion/);
  });

  test('names the 200-record cap instead of letting the registry silently apply it', () => {
    assert.throws(() => npi.listUrl({ state: 'CA', limit: 500 }), /"limit" must be an integer between 1 and 200/);
    assert.throws(() => npi.listUrl({ state: 'CA', limit: 0 }), /"limit" must be an integer between 1 and 200/);
    assert.equal(new URL(npi.listUrl({ state: 'CA', limit: 200 })).searchParams.get('limit'), '200');
  });

  test('names the 1000-record skip cap', () => {
    assert.throws(() => npi.listUrl({ state: 'CA', skip: 1001 }), /"skip" must be an integer between 0 and 1000/);
    assert.equal(new URL(npi.listUrl({ state: 'CA', skip: 1000 })).searchParams.get('skip'), '1000');
  });

  test('matches a registry API URL with its targetPattern', () => {
    assert.match(NPI_URL, npi.targetPattern);
  });
});

describe('npi-provider extraction', () => {
  test('returns one item per registry record', () => {
    const result = search('npi-individuals');
    assert.equal(result.count, 3);
    assert.equal(result.items.length, 3);
    assert.deepEqual(result.items.map(i => i.npi), ['1982227625', '1265566509', '1700742640']);
  });

  test('reads an individual provider record', () => {
    const [provider] = search('npi-individuals').items;
    assert.equal(provider.enumeration_type, 'NPI-1');
    assert.equal(provider.name, 'TARIQ AL-SALEH');
    assert.equal(provider.first_name, 'TARIQ');
    assert.equal(provider.last_name, 'AL-SALEH');
    assert.equal(provider.organization_name, null);
    assert.equal(provider.credential, 'BCCP, APH, RPh, PACS');
    assert.equal(provider.sole_proprietor, false);
    assert.equal(provider.status, 'A');
    assert.equal(provider.enumeration_date, '2020-05-28');
    assert.equal(provider.last_updated, '2025-07-12');
  });

  test('reads an organisation record', () => {
    const [organisation] = search('npi-organizations').items;
    assert.equal(organisation.npi, '1265478150');
    assert.equal(organisation.enumeration_type, 'NPI-2');
    assert.equal(organisation.name, 'BECKER MEDICAL, PC');
    assert.equal(organisation.organization_name, 'BECKER MEDICAL, PC');
    assert.equal(organisation.first_name, null);
    // Organisations are not sole proprietors, and the registry omits the field.
    assert.equal(organisation.sole_proprietor, null);
  });

  test('reads the registry\'s "--" for an absent name part as absent', () => {
    const provider = search('npi-individuals').items[1];
    // name_prefix "Mr.", middle_name "REDDY", name_suffix "--" in the capture.
    assert.equal(provider.name, 'Mr. SRINIVASA REDDY AALURI');
    assert.equal(provider.credential, 'md');
  });

  test('reports a sole proprietor, and a missing credential as null', () => {
    const provider = search('npi-individuals').items[2];
    assert.equal(provider.sole_proprietor, true);
    assert.equal(provider.credential, null);
  });

  test('separates the practice location from the mailing address by purpose, not index', () => {
    const [locationFirst, mailingFirst] = search('npi-individuals').items;

    // Captured LOCATION-first.
    assert.equal(locationFirst.addresses.location.line1, '175 W LEXINGTON AVE STE B');
    assert.equal(locationFirst.addresses.location.city, 'EL CAJON');
    assert.equal(locationFirst.addresses.mailing.line1, '300 14TH ST APT 531');
    assert.equal(locationFirst.addresses.mailing.city, 'SAN DIEGO');

    // Captured MAILING-first — the registry's API help says this never happens,
    // and half the captured records do it. Reading addresses[0] as the practice
    // location would put the mailing address here.
    assert.equal(mailingFirst.addresses.location.purpose, 'LOCATION');
    assert.equal(mailingFirst.addresses.mailing.purpose, 'MAILING');
    assert.equal(mailingFirst.addresses.location.state, 'TX');
  });

  test('normalises an address to named fields', () => {
    const { location } = search('npi-individuals').items[0].addresses;
    assert.deepEqual(location, {
      purpose: 'LOCATION',
      line1: '175 W LEXINGTON AVE STE B',
      line2: null,
      city: 'EL CAJON',
      state: 'CA',
      // ZIP+4, unhyphenated as the registry writes it.
      postal_code: '920204454',
      country_code: 'US',
      country_name: 'United States',
      telephone: '786-445-2814',
      fax: '619-923-5881'
    });
    assert.equal(search('npi-organizations').items[0].addresses.mailing.line2, 'SUITE 1');
  });

  test('returns the extra practice sites the registry keeps in its own array', () => {
    const [provider] = search('npi-individuals').items;
    assert.equal(provider.practice_locations.length, 1);
    assert.equal(provider.practice_locations[0].city, 'SAN DIEGO');
    assert.deepEqual(search('npi-organizations').items[0].practice_locations, []);
  });

  test('flags the primary taxonomy, which a specialty search does not guarantee', () => {
    const [provider] = search('npi-individuals').items;
    assert.equal(provider.taxonomies.length, 4);
    // Captured from a taxonomy_description=Cardiology search: the record matches
    // on "Pharmacist, Cardiology" while its primary taxonomy is something else.
    assert.equal(provider.primary_taxonomy, 'Pharmacist, Ambulatory Care');
    assert.ok(provider.taxonomies.some(t => t.description === 'Pharmacist, Cardiology' && !t.primary));
    assert.equal(provider.taxonomies.filter(t => t.primary).length, 1);
  });

  test('normalises a taxonomy entry, including the empty taxonomy_group', () => {
    const primary = search('npi-individuals').items[1].taxonomies[0];
    assert.deepEqual(primary, {
      code: '207Q00000X',
      description: 'Family Medicine',
      primary: true,
      license: 'L9590',
      state: 'TX',
      group: null
    });
    assert.equal(
      search('npi-organizations').items[0].taxonomies[0].group,
      '193400000X - Single Specialty Group'
    );
  });

  test('reads both spellings of an other-name entry', () => {
    // Organisations spell it organization_name.
    assert.deepEqual(search('npi-organizations').items[0].other_names, [
      { type: 'Other Name', name: 'HOSPITAL MEDICINE ASSOCIATES' }
    ]);
    // Individuals spell the affixes prefix/suffix, not name_prefix/name_suffix,
    // and this record's suffix is the registry's "--".
    assert.deepEqual(search('npi-former-name').items[0].other_names, [
      { type: 'Former Name', name: 'Dr. SIU-HAN PAOLA ARTEAGA' }
    ]);
  });

  test('does not surface sex or an organisation\'s authorized official (G8)', () => {
    const individual = search('npi-individuals').items[0];
    const organisation = search('npi-organizations').items[0];
    const fields = JSON.stringify(individual) + JSON.stringify(organisation);
    // basic.sex is "M" on this record in the registry and is not carried over.
    assert.equal(individual.sex, undefined);
    assert.doesNotMatch(fields, /authorized_official/);
    // The authorized official's given name and direct line, both in the capture.
    // ("BECKER" is not checked — it is also the organisation's own name.)
    assert.doesNotMatch(fields, /RICHARD/);
    assert.doesNotMatch(fields, /9144553101/);
  });
});

describe('npi-provider pagination', () => {
  test('reports the effective page window from the request', () => {
    const result = search('npi-individuals',
      'https://npiregistry.cms.hhs.gov/api/?version=2.1&state=CA&taxonomy_description=Cardiology&limit=5&skip=200');
    assert.equal(result.limit, 5);
    assert.equal(result.skip, 200);
  });

  test('falls back to the registry\'s documented default limit of 10', () => {
    const result = search('npi-individuals', 'https://npiregistry.cms.hhs.gov/api/?version=2.1&number=1982227625');
    assert.equal(result.limit, 10);
    assert.equal(result.skip, 0);
  });

  test('a short page is the registry\'s own stop condition', () => {
    // 3 records against a limit of 5 — there is no next page.
    assert.equal(search('npi-individuals').more_possible, false);
  });

  test('a full page is the only "there may be more" signal the API gives', () => {
    const result = search('npi-individuals',
      'https://npiregistry.cms.hhs.gov/api/?version=2.1&state=CA&taxonomy_description=Cardiology&limit=3');
    assert.equal(result.more_possible, true);
    // The registry publishes no total, so none is invented here.
    assert.equal(result.total_available, undefined);
  });
});

describe('npi-provider error handling', () => {
  test('throws on the HTTP 200 error body a bare query gets, not an empty list', () => {
    assert.throws(
      () => npi.extractList(fixture('npi-error-no-criteria'), NPI_URL),
      /NPI registry rejected the query.*No valid search criteria provided/s
    );
  });

  test('reports every error the registry returned', () => {
    assert.throws(
      () => npi.extractList(fixture('npi-error-multiple'), NPI_URL),
      /version: Unsupported Version; state: Field state requires additional search criteria/
    );
  });

  test('a genuinely empty result set is not an error', () => {
    const result = npi.extractList(fixture('npi-empty'), NPI_URL);
    assert.deepEqual(result.items, []);
    assert.equal(result.count, 0);
    assert.equal(result.more_possible, false);
  });

  test('throws when the response is not the registry\'s payload', () => {
    assert.throws(
      () => npi.extractList('{"data":[]}', NPI_URL),
      /returned JSON without a results array/
    );
  });

  test('throws when the response is not JSON', () => {
    assert.throws(
      () => npi.extractList('<!doctype html><html>NPPES NPI Registry</html>', NPI_URL),
      /did not return JSON/
    );
  });
});

// ── Shared connector contract ────────────────────────────────────────────────

describe('gov connector contract', () => {
  test('exports exactly the two connectors, with unique ids', () => {
    assert.deepEqual(GOV_TEMPLATES.map(t => t.id), ['nhtsa-vin', 'npi-provider']);
  });

  test('every connector carries the fields the registry lists on', () => {
    for (const template of GOV_TEMPLATES) {
      assert.equal(typeof template.name, 'string', template.id);
      assert.equal(typeof template.description, 'string', template.id);
      assert.ok(template.targetPattern instanceof RegExp, template.id);
      assert.equal(typeof template.listUrl, 'function', template.id);
    }
  });

  test('extractList is what marks a list connector — VIN decode returns one entity', () => {
    assert.equal(typeof vin.extractRaw, 'function');
    assert.equal(vin.extractList, undefined);
    assert.equal(typeof npi.extractList, 'function');
    assert.equal(npi.extractRaw, undefined);
  });

  test('neither connector needs a credential', () => {
    for (const template of GOV_TEMPLATES) {
      assert.equal(template.requiresApiKey, undefined, template.id);
      assert.equal(template.credentialRef, undefined, template.id);
    }
  });
});
