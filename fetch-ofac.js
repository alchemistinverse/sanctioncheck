/**
 * fetch-ofac.js — UPGRADED VERSION (with advanced matching support)
 */

const fs   = require('fs')
const path = require('path')

function findFile(names) {
  for (const n of names) {
    if (fs.existsSync(n)) return n
  }
  return null
}

const SDN_FILE  = findFile(['SDN_ENHANCED.XML','sdn_enhanced.xml'])
const CONS_FILE = findFile(['cons_enhanced.xml','CONS_ENHANCED.XML'])
const OUT_FILE  = path.join('public','sdn.json')

/* ───────────── NORMALIZATION HELPERS ───────────── */

function normalize(str) {
  return (str || "")
    .toLowerCase()
    .replace(/,/g, "")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(str) {
  return normalize(str).split(" ").filter(Boolean);
}

/* ───────────── XML HELPERS ───────────── */

function tagText(str, tag) {
  const m = str.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'))
  return m ? m[1].trim() : ''
}

function getBlocks(str, tag) {
  const blocks = []
  const close = `</${tag}>`
  let pos = 0

  while (true) {
    const open = str.indexOf(`<${tag}`, pos)
    if (open === -1) break
    const end = str.indexOf(close, open)
    if (end === -1) break
    blocks.push(str.substring(open, end + close.length))
    pos = end + close.length
  }
  return blocks
}

function getAttr(str, tag, attr) {
  const m = str.match(new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i'))
  return m ? m[1] : ''
}

/* ───────────── ENTITY PARSER ───────────── */

function parseEntity(block) {
  const id = getAttr(block, 'entity', 'id')

  const rawType = tagText(block, 'entityType')
  const type =
    rawType === 'Individual' ? 'Person' :
    rawType === 'Entity'     ? 'Organization' :
    rawType === 'Vessel'     ? 'Vessel' :
    rawType === 'Aircraft'   ? 'Aircraft' :
    'Other'

  const nameBlocks = getBlocks(block, 'name')
  let primaryName = ''
  const aliases = []

  for (const nb of nameBlocks) {
    const fullName  = tagText(nb, 'formattedFullName')
    const firstName = tagText(nb, 'formattedFirstName')
    const lastName  = tagText(nb, 'formattedLastName')

    let display = ''

    if (firstName && lastName) {
      display = `${firstName} ${lastName}`
    } else if (fullName) {
      if (fullName.includes(',')) {
        const parts = fullName.split(',').map(s => s.trim())
        display = parts.length >= 2 ? `${parts[1]} ${parts[0]}` : fullName
      } else {
        display = fullName
      }
    }

    const finalName = display || fullName
    if (!finalName) continue

    if (!primaryName) primaryName = finalName
    else aliases.push(finalName)
  }

  if (!primaryName) return null

  const allNames = [primaryName, ...aliases]

  // 🔥 KEY ADDITIONS
  const normalizedName = normalize(primaryName)
  const normalizedAliases = allNames.map(n => normalize(n))
  const tokens = [...new Set(allNames.flatMap(n => tokenize(n)))]
  const searchBlob = normalize(allNames.join(" "))

  // Country
  const countries = []
  for (const ab of getBlocks(block, 'address')) {
    const c = tagText(ab, 'country')
    if (c) countries.push(c)
  }

  // DOB
  let dob = null
  for (const fb of getBlocks(block, 'feature')) {
    if (tagText(fb, 'type') === 'Birthdate') {
      dob = tagText(fb, 'value')
    }
  }

  return {
    id: `ofac-${id}`,
    name: primaryName,
    aliases: [...new Set(aliases)],
    type,
    countries: [...new Set(countries)],
    dob,

    // 🔥 MATCHING FIELDS
    normalizedName,
    normalizedAliases,
    tokens,
    searchBlob
  }
}

/* ───────────── PARSE XML ───────────── */

function parseXML(xml) {
  const blocks = getBlocks(xml, 'entity')
  const records = []

  for (const b of blocks) {
    try {
      const r = parseEntity(b)
      if (r) records.push(r)
    } catch {}
  }

  return records
}

/* ───────────── MAIN ───────────── */

function main() {
  if (!fs.existsSync('public')) fs.mkdirSync('public')

  let all = []

  if (SDN_FILE) {
    console.log("Reading SDN...")
    const xml = fs.readFileSync(SDN_FILE, 'utf8')
    all = all.concat(parseXML(xml))
  }

  if (CONS_FILE) {
    console.log("Reading CONS...")
    const xml = fs.readFileSync(CONS_FILE, 'utf8')
    all = all.concat(parseXML(xml))
  }

  console.log("Total records:", all.length)

  fs.writeFileSync(OUT_FILE, JSON.stringify({ records: all }, null, 2))

  console.log("Saved to", OUT_FILE)
}

main()