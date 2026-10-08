// §4.14 Places: the "Travelling from" city search, served from the bundled dataset in data/cities-in.json (no
// third-party call at request time). The file is loaded into `places_cities` by scripts/migrate.ts, once per version
// of the file; this module owns the file's shape, the load and the two reads.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Db } from '../db/pool.js';
import { invalid } from './errors.js';

export const CITIES_FILE = new URL('../../data/cities-in.json', import.meta.url);

/** One row of data/cities-in.json. `ascii_name` is lower-cased and accent-free: what a typed prefix is matched against. */
export interface City {
  id: string;
  name: string;
  ascii_name: string;
  region: string;
  country: string;
  lat: number;
  lng: number;
  population: number;
}

/** What the app gets per city: `region` is "<state>, India" for the secondary line; `name` is what it stores as from_city. */
export interface CityItem {
  id: string;
  name: string;
  region: string;
  lat: number;
  lng: number;
  population: number;
}

const COUNTRY_NAMES: Record<string, string> = { IN: 'India' };
/** The countries the dataset covers. Others answer 422 until their extract is bundled. */
export const COUNTRIES = Object.keys(COUNTRY_NAMES);
export const PAGE = 8;

/** Accents stripped, lower-cased: "Bengalūru" and "bengaluru" match the same rows. The same fold the file's ascii_name uses. */
export const foldForSearch = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** The dataset file: its rows and a short hash of its text (the load is recorded against the hash, so a new file loads once). */
export function readCitiesFile(file: URL = CITIES_FILE): { cities: City[]; version: string } {
  const text = readFileSync(file, 'utf8');
  const parsed = JSON.parse(text) as { cities?: unknown };
  if (!Array.isArray(parsed.cities)) throw new Error(`${file.pathname}: expected { cities: [...] }`);
  const cities = parsed.cities as City[];
  for (const [i, c] of cities.entries()) {
    const ok = typeof c.id === 'string' && c.id && typeof c.name === 'string' && c.name && typeof c.region === 'string' && typeof c.country === 'string'
      && Number.isFinite(c.lat) && Number.isFinite(c.lng) && Number.isInteger(c.population);
    if (!ok) throw new Error(`${file.pathname}: row ${i} is not a city`);
  }
  return { cities, version: createHash('sha256').update(text).digest('hex').slice(0, 12) };
}

/** Upserts the dataset into `places_cities` (one multi-row statement per chunk). Safe to run again. */
export async function loadCities(db: Pick<Db, 'query'>, cities: City[]): Promise<number> {
  const CHUNK = 200;
  for (let i = 0; i < cities.length; i += CHUNK) {
    const chunk = cities.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const rows = chunk.map((c) => {
      values.push(c.id, c.name, foldForSearch(c.ascii_name || c.name), c.region, c.country, c.lat, c.lng, c.population);
      const n = values.length;
      return `($${n - 7}, $${n - 6}, $${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
    });
    await db.query(
      `insert into places_cities (id, name, ascii_name, region, country, lat, lng, population) values ${rows.join(', ')}
       on conflict (id) do update set name = excluded.name, ascii_name = excluded.ascii_name, region = excluded.region,
         country = excluded.country, lat = excluded.lat, lng = excluded.lng, population = excluded.population`,
      values,
    );
  }
  return cities.length;
}

interface CityRow { id: string; name: string; region: string; country: string; lat: number; lng: number; population: number }

const itemOf = (r: CityRow): CityItem => ({ id: r.id, name: r.name, region: `${r.region}, ${COUNTRY_NAMES[r.country] ?? r.country}`, lat: r.lat, lng: r.lng, population: r.population });

function checkCountry(country: string): string {
  const c = country.toUpperCase();
  if (!COUNTRIES.includes(c)) throw invalid(`country must be one of ${COUNTRIES.join(', ')}`, 'country');
  return c;
}

/**
 * Cities whose name starts with what was typed (accents and case ignored), biggest first, one row per name and state,
 * at most `limit` (never more than 8). Fewer than two characters typed: the top list.
 */
export async function searchCities(db: Db, q: string, country = 'IN', limit = PAGE): Promise<CityItem[]> {
  const c = checkCountry(country);
  const prefix = foldForSearch(q);
  if (prefix.length < 2) return topCities(db, c, limit);
  const n = Math.max(1, Math.min(PAGE, limit));
  // `like` on a literal prefix (special characters escaped) uses the text_pattern_ops index.
  const pattern = `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const { rows } = await db.query<CityRow>(
    `select id, name, region, country, lat, lng, population from (
       select distinct on (name, region) id, name, region, country, lat, lng, population from places_cities
        where country = $1 and ascii_name like $2 escape '\\' order by name, region, population desc) c
      order by population desc, name limit $3`,
    [c, pattern, n],
  );
  return rows.map(itemOf);
}

/** The biggest cities of the country, for the dropdown before anything is typed. */
export async function topCities(db: Db, country = 'IN', limit = PAGE): Promise<CityItem[]> {
  const c = checkCountry(country);
  const n = Math.max(1, Math.min(PAGE, limit));
  const { rows } = await db.query<CityRow>(
    `select id, name, region, country, lat, lng, population from (
       select distinct on (name, region) id, name, region, country, lat, lng, population from places_cities
        where country = $1 order by name, region, population desc) c
      order by population desc, name limit $2`,
    [c, n],
  );
  return rows.map(itemOf);
}
