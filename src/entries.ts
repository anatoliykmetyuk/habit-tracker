// Single source of truth for the `entries` frontmatter format.
//
// Shape: Entry[]  — an array of objects, each with a required `date`
// (YYYY-MM-DD) and an optional numeric `value`. An entry without a value
// is a boolean completion; an entry with a value records a number for
// that day. The same habit can mix both.
//
// Core invariant: any mutation touches exactly one day. Helpers below
// return new arrays and preserve every other entry by reference, so
// callers can never accidentally rewrite the whole list.

export type Entry = { date: string; value?: number; [k: string]: unknown }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function isValidDate(s: unknown): s is string {
	return typeof s === 'string' && ISO_DATE.test(s) && !isNaN(Date.parse(s))
}

export function isFiniteNumber(n: unknown): n is number {
	return typeof n === 'number' && Number.isFinite(n)
}

/**
 * Read `entries` from frontmatter and normalize to Entry[].
 * Accepts:
 *   - new format: array of {date, value?, ...}
 *   - legacy format: array of date strings
 * Returns [] for anything else. The old `{date: value}` object map is
 * intentionally not supported.
 */
export function normalizeEntries(raw: unknown): Entry[] {
	if (!Array.isArray(raw)) return []
	const result: Entry[] = []
	const seen = new Set<string>()
	for (const item of raw) {
		if (typeof item === 'string') {
			if (!isValidDate(item) || seen.has(item)) continue
			seen.add(item)
			result.push({ date: item })
			continue
		}
		if (item && typeof item === 'object' && !Array.isArray(item)) {
			const obj = item as Record<string, unknown>
			if (!isValidDate(obj.date) || seen.has(obj.date)) continue
			seen.add(obj.date)
			const entry: Entry = { date: obj.date }
			for (const k of Object.keys(obj)) {
				if (k === 'date') continue
				const v = (obj as Record<string, unknown>)[k]
				if (isFiniteNumber(v)) {
					entry[k] = v
				}
			}
			result.push(entry)
		}
	}
	return result
}

export function findEntry(
	entries: Entry[],
	date: string,
): Entry | undefined {
	return entries.find((e) => e.date === date)
}

export function hasEntry(entries: Entry[], date: string): boolean {
	return entries.some((e) => e.date === date)
}

/**
 * Returns a new array with the entry for `date` updated or inserted.
 * All other entries are preserved by reference.
 */
export function upsertEntry(
	entries: Entry[],
	date: string,
	patch: Partial<Entry>,
): Entry[] {
	const idx = entries.findIndex((e) => e.date === date)
	if (idx === -1) {
		return [...entries, { date, ...patch }]
	}
	const result = entries.slice()
	result[idx] = { ...entries[idx], ...patch, date }
	return result
}

/**
 * Returns a new array without the entry for `date`. All other entries
 * are preserved by reference.
 */
export function removeEntry(entries: Entry[], date: string): Entry[] {
	return entries.filter((e) => e.date !== date)
}
