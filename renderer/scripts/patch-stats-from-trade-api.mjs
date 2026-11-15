// @ts-check
// Adds missing matchers to public/data/en/stats.ndjson for mods that GGG
// reworded in-game (e.g. "#% increased Rarity of Items found" -> "+#% to Item Rarity")
// while keeping the same trade stat id.
//
// It also adds base types of new league item classes (see NEW_ITEM_CLASSES)
// to public/data/en/items.ndjson.
//
// Usage (from renderer/):  node scripts/patch-stats-from-trade-api.mjs [dir with stats.json + items.json]
// Without an argument the data is fetched from the official trade API.
// The script is idempotent: running it again only adds what is still missing.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const NDJSON_PATH = path.join(__dirname, '../public/data/en/stats.ndjson')
const ITEMS_PATH = path.join(__dirname, '../public/data/en/items.ndjson')

// trade API item group id -> ItemCategory (src/parser/meta.ts)
const NEW_ITEM_CLASSES = {
  viscera: 'Viscera' // Covens league, Wickerman
}
const TRADE_TYPES = new Set(['explicit', 'implicit', 'crafted', 'fractured', 'enchant', 'scourge'])

// Trade-site-only suffixes that never appear in the item text
// like "(Local)", "(Shields)", "(Maps)"
const TRADE_ONLY_SUFFIX = /\s\([A-Z][a-z]+\)$/

/** "+#% to Item Rarity" -> "#% to Item Rarity" (the parser swallows the sign into the roll) */
function toMatcherString (text) {
  return text.replace(/[+-]#/g, '#')
}

async function loadTradeData (name) {
  const dir = process.argv[2]
  if (dir) return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf-8'))
  const res = await fetch(`https://www.pathofexile.com/api/trade/data/${name}`, {
    headers: { 'User-Agent': 'awakened-poe-trade-fork data patcher' }
  })
  if (!res.ok) throw new Error(`Trade API /${name} responded ${res.status}`)
  return res.json()
}

const trade = await loadTradeData('stats')
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
const addedTypes = []
const changedRows = new Set()
for (const group of trade.result) {
  if (!TRADE_TYPES.has(group.id)) continue
  for (const entry of group.entries) {
    if (TRADE_ONLY_SUFFIX.test(entry.text)) continue
    const key = entry.id.slice(entry.id.indexOf('.') + 1)
    const targets = statsById.get(key)
    // only one owning stat, otherwise we can't tell which one is meant
    if (!targets || targets.length !== 1) continue
    const { stat, row } = targets[0]

    // stat known, but not for this mod type (e.g. an explicit that now also exists as Viscera implicit)
    const typeIds = (stat.trade.ids[group.id] ??= [])
    if (!typeIds.includes(entry.id)) {
      typeIds.push(entry.id)
      changedRows.add(row)
      addedTypes.push(`${entry.id}  (ref: "${stat.ref}")`)
    }

    const matcher = toMatcherString(entry.text)
    if (knownMatchers.has(matcher)) continue

    stat.matchers.push({ string: matcher })
    knownMatchers.add(matcher)
    changedRows.add(row)
    added.push(`${key}: "${matcher}"  (ref: "${stat.ref}")`)
  }
}

for (const row of changedRows) {
  lines[row] = JSON.stringify(rows[row])
}
console.log(`Added ${addedTypes.length} missing mod types to existing stats`)

// --- stats whose trade id is not in the app data at all (e.g. new Viscera implicits) ---
const NEW_STAT_TYPES = new Set(['implicit'])
const ELEMENT = /\b(?:Fire|Cold|Lightning|Chaos|Physical)\b/g
/** "Fire Exposure ... Fire Resistance" -> "@ Exposure ... @ Resistance" to find a sibling stat */
const elementless = (ref) => ref.replace(ELEMENT, '@')
const betterBySibling = new Map()
for (const statOrGroup of rows) {
  if (!statOrGroup) continue
  for (const stat of ('stats' in statOrGroup) ? statOrGroup.stats : [statOrGroup]) {
    betterBySibling.set(elementless(stat.ref), stat.better)
  }
}

/** @type {Map<string, any>} trade id -> new stat */
const newStats = new Map()
for (const group of trade.result) {
  if (!NEW_STAT_TYPES.has(group.id)) continue
  for (const entry of group.entries) {
    const key = entry.id.slice(entry.id.indexOf('.') + 1)
    if (statsById.has(key) || TRADE_ONLY_SUFFIX.test(entry.text)) continue
    const matcher = toMatcherString(entry.text)
    if (knownMatchers.has(matcher)) continue
    knownMatchers.add(matcher)

    const existing = newStats.get(key)
    if (existing) {
      existing.matchers.push({ string: matcher })
      continue
    }
    newStats.set(key, {
      ref: entry.text,
      better: betterBySibling.get(elementless(entry.text)) ?? 1,
      matchers: [{ string: matcher }],
      trade: { ids: { [group.id]: [entry.id] } }
    })
  }
}
const lastLine = lines.length - 1
const tail = lines[lastLine] === '' ? lines.pop() : undefined
for (const stat of newStats.values()) lines.push(JSON.stringify(stat))
if (tail !== undefined) lines.push(tail)
console.log(`Added ${newStats.size} new stats (${[...NEW_STAT_TYPES].join(', ')})`)

const statsEol = lines.some(line => line.endsWith('\r')) ? '\r\n' : '\n'
fs.writeFileSync(NDJSON_PATH, lines.map(line => line.replace(/\r$/, '')).join(statsEol))

console.log(added.join('\n'))
console.log(`\nAdded ${added.length} matchers to ${changedRows.size} stats in ${path.relative(process.cwd(), NDJSON_PATH)}`)

// --- new league item classes ---
const tradeItems = await loadTradeData('items')
const itemsNdjson = fs.readFileSync(ITEMS_PATH, 'utf-8')
const knownItems = new Set(itemsNdjson.split('\n').filter(Boolean)
  .map(line => JSON.parse(line))
  .filter(item => item.namespace === 'ITEM')
  .map(item => item.refName))

const newItems = []
for (const group of tradeItems.result) {
  const category = NEW_ITEM_CLASSES[group.id]
  if (!category) continue
  for (const entry of group.entries) {
    if (entry.name || knownItems.has(entry.type)) continue // skip uniques and known bases
    knownItems.add(entry.type)
    newItems.push({
      name: entry.type,
      refName: entry.type,
      namespace: 'ITEM',
      craftable: { category },
      icon: ''
    })
  }
}
if (newItems.length) {
  const eol = itemsNdjson.includes('\r\n') ? '\r\n' : '\n'
  fs.writeFileSync(ITEMS_PATH,
    itemsNdjson.replace(/\r?\n?$/, eol) + newItems.map(item => JSON.stringify(item) + eol).join(''))
}
console.log(`Added ${newItems.length} base types to ${path.relative(process.cwd(), ITEMS_PATH)}`)
