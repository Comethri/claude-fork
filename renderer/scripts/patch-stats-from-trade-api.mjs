// @ts-check
// Adds missing matchers to public/data/en/stats.ndjson for mods that GGG
// reworded in-game (e.g. "#% increased Rarity of Items found" -> "+#% to Item Rarity")
// while keeping the same trade stat id.
//
// Usage (from renderer/):  node scripts/patch-stats-from-trade-api.mjs [path/to/trade-stats.json]
// Without an argument the stats are fetched from the official trade API.
// The script is idempotent: running it again only adds what is still missing.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const NDJSON_PATH = path.join(__dirname, '../public/data/en/stats.ndjson')
const TRADE_TYPES = new Set(['explicit', 'implicit', 'crafted', 'fractured', 'enchant', 'scourge'])

// Trade-site-only suffixes that never appear in the item text
// like "(Local)", "(Shields)", "(Maps)"
const TRADE_ONLY_SUFFIX = /\s\([A-Z][a-z]+\)$/

/** "+#% to Item Rarity" -> "#% to Item Rarity" (the parser swallows the sign into the roll) */
function toMatcherString (text) {
  return text.replace(/[+-]#/g, '#')
}

async function loadTradeStats () {
  const file = process.argv[2]
  if (file) return JSON.parse(fs.readFileSync(file, 'utf-8'))
  const res = await fetch('https://www.pathofexile.com/api/trade/data/stats', {
    headers: { 'User-Agent': 'awakened-poe-trade-fork data patcher' }
  })
  if (!res.ok) throw new Error(`Trade API responded ${res.status}`)
  return res.json()
}

const trade = await loadTradeStats()
const lines = fs.readFileSync(NDJSON_PATH, 'utf-8').split('\n')
const rows = lines.map(line => line ? JSON.parse(line) : null)

/** @type {Map<string, Array<{ row: number, stat: any }>>} trade id (without type prefix) -> stats */
const statsById = new Map()
/** every matcher string currently known */
const knownMatchers = new Set()

rows.forEach((statOrGroup, row) => {
  if (!statOrGroup) return
  const stats = ('stats' in statOrGroup) ? statOrGroup.stats : [statOrGroup]
  for (const stat of stats) {
    for (const m of stat.matchers ?? []) {
      knownMatchers.add(m.string)
      if (m.advanced) knownMatchers.add(m.advanced)
    }
    for (const ids of Object.values(stat.trade?.ids ?? {})) {
      for (const id of ids) {
        const key = id.slice(id.indexOf('.') + 1)
        const list = statsById.get(key) ?? []
        if (!list.some(e => e.stat === stat)) list.push({ stat, row })
        statsById.set(key, list)
      }
    }
  }
})

const added = []
const changedRows = new Set()
for (const group of trade.result) {
  if (!TRADE_TYPES.has(group.id)) continue
  for (const entry of group.entries) {
    if (TRADE_ONLY_SUFFIX.test(entry.text)) continue
    const key = entry.id.slice(entry.id.indexOf('.') + 1)
    const targets = statsById.get(key)
    // only one owning stat, otherwise we can't tell which one is meant
    if (!targets || targets.length !== 1) continue

    const matcher = toMatcherString(entry.text)
    if (knownMatchers.has(matcher)) continue

    const { stat, row } = targets[0]
    stat.matchers.push({ string: matcher })
    knownMatchers.add(matcher)
    changedRows.add(row)
    added.push(`${key}: "${matcher}"  (ref: "${stat.ref}")`)
  }
}

for (const row of changedRows) {
  lines[row] = JSON.stringify(rows[row])
}
fs.writeFileSync(NDJSON_PATH, lines.join('\n'))

console.log(added.join('\n'))
console.log(`\nAdded ${added.length} matchers to ${changedRows.size} stats in ${path.relative(process.cwd(), NDJSON_PATH)}`)
