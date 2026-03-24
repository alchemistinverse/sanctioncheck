/**
 * fetch-ofac.js — SanctionCheck OFAC Data Converter
 *
 * Reads local XML files and converts to public/sdn.json
 *
 * Files needed:
 *   SDN_ENHANCED.XML   — from sanctionslist.ofac.treas.gov/Home/SdnList
 *   cons_enhanced.xml  — from sanctionslist.ofac.treas.gov/Home/ConsolidatedList
 *
 * Usage: node fetch-ofac.js
 */

const fs   = require('fs')
const path = require('path')

// Accept various filename casings
function findFile(names) {
  for (const n of names) {
    if (fs.existsSync(n)) return n
  }
  return null
}

const SDN_FILE  = findFile(['SDN_ENHANCED.XML','sdn_enhanced.xml','SDN_ENHANCED.xml'])
const CONS_FILE = findFile(['cons_enhanced.xml','CONS_ENHANCED.XML','cons_enhanced.XML'])
const OUT_FILE  = path.join('public','sdn.json')

// ── XML helpers ────────────────────────────────────────────────────

// Strip XML namespace prefixes and default namespace declarations
// The enhanced XML uses xmlns="..." which affects tag matching
function stripNS(xml) {
  return xml
    .replace(/xmlns[^"]*"[^"]*"/g, '')   // remove xmlns declarations
    .replace(/<(\/?)[a-zA-Z]+:([a-zA-Z])/g, '<$1$2')  // remove ns prefixes
}

// Get text content between tags — handles self-closing and nested
function tagText(str, tag) {
  // Try with namespace-stripped approach
  const patterns = [
    new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`, 'i'),
    new RegExp(`<${tag}>([^<]*)<\/${tag}>`, 'i'),
  ]
  for (const p of patterns) {
    const m = str.match(p)
    if (m && m[1].trim()) return m[1].trim()
  }
  // Fallback — find tag manually
  const open = str.indexOf(`<${tag}`)
  if (open === -1) return ''
  const cs = str.indexOf('>', open) + 1
  const close = str.indexOf(`</${tag}>`, cs)
  if (close === -1) return ''
  return str.substring(cs, close).replace(/<[^>]+>/g, '').trim()
}

// Get all text values for a repeating tag
function allTagText(str, tag) {
  const results = []
  const close   = `</${tag}>`
  let pos = 0
  while (true) {
    const open = str.search(new RegExp(`<${tag}[\\s>]`, 'i'))
    if (open === -1 || open <= pos - str.length) break
    const realOpen = str.indexOf(`<${tag}`, pos)
    if (realOpen === -1) break
    const cs = str.indexOf('>', realOpen) + 1
    const e  = str.indexOf(close, cs)
    if (e === -1) break
    const text = str.substring(cs, e).replace(/<[^>]+>/g, '').trim()
    if (text) results.push(text)
    pos = e + close.length
  }
  return results
}

// Get all blocks of a tag
function getBlocks(str, tag) {
  const blocks = []
  const closeTag = `</${tag}>`
  let pos = 0
  while (true) {
    // Find opening tag (with or without attributes)
    let open = -1
    let searchPos = pos
    while (searchPos < str.length) {
      const idx = str.indexOf(`<${tag}`, searchPos)
      if (idx === -1) break
      // Make sure it's actually this tag (not e.g. <sanctionsListXYZ>)
      const nextChar = str[idx + tag.length + 1]
      if (nextChar === '>' || nextChar === ' ' || nextChar === '\n' || nextChar === '\r' || nextChar === '/') {
        open = idx
        break
      }
      searchPos = idx + 1
    }
    if (open === -1) break
    const e = str.indexOf(closeTag, open)
    if (e === -1) break
    blocks.push(str.substring(open, e + closeTag.length))
    pos = e + closeTag.length
  }
  return blocks
}

// Get attribute value
function getAttr(str, tag, attrName) {
  const s = str.indexOf(`<${tag}`)
  if (s === -1) return ''
  const e = str.indexOf('>', s)
  const tagStr = str.substring(s, e)
  const m = tagStr.match(new RegExp(`\\b${attrName}="([^"]*)"`, 'i'))
  return m ? m[1] : ''
}

// Extract clean list name from a sanctionsList block
// Handles: <sanctionsList refId="1550" id="123" datePublished="2026-03-20">SDN List</sanctionsList>
function extractListName(block) {
  const gtPos    = block.indexOf('>')
  const closePos = block.toLowerCase().indexOf('</sanctionslist>')
  if (gtPos < 0 || closePos < 0 || closePos <= gtPos) return ''
  return block.substring(gtPos + 1, closePos).trim()
}

// ── Parse one entity ───────────────────────────────────────────────
function parseEntity(block) {
  const id = getAttr(block, 'entity', 'id')

  // Entity type
  const rawType = tagText(block, 'entityType')
  const type =
    rawType === 'Individual' ? 'Person' :
    rawType === 'Entity'     ? 'Organization' :
    rawType === 'Vessel'     ? 'Vessel' :
    rawType === 'Aircraft'   ? 'Airplane' :
    rawType || 'Other'

  // Sanctions lists — clean text extraction
  const listBlocks = getBlocks(block, 'sanctionsList')
  const lists = [...new Set(listBlocks.map(extractListName).filter(Boolean))]

  // Programs
  const programBlocks = getBlocks(block, 'sanctionsProgram')
  const programs = [...new Set(programBlocks.map(b => {
    const gt = b.indexOf('>')
    const cl = b.toLowerCase().indexOf('</sanctionsprogram>')
    if (gt < 0 || cl < 0) return ''
    return b.substring(gt + 1, cl).trim()
  }).filter(Boolean))]

  // ── Names ──────────────────────────────────────────────────────
  const nameBlocks = getBlocks(block, 'name')
  let primaryName = ''
  const aliases   = []

  for (const nb of nameBlocks) {
    const isPrimary = tagText(nb, 'isPrimary') === 'true'
    // Names are inside <translation> blocks
    const translationBlocks = getBlocks(nb, 'translation')
    const primaryTranslation = translationBlocks.find(t => tagText(t, 'isPrimary') === 'true') || translationBlocks[0]
    if (!primaryTranslation) continue
    const fullName  = tagText(primaryTranslation, 'formattedFullName')
    const firstName = tagText(primaryTranslation, 'formattedFirstName')
    const lastName  = tagText(primaryTranslation, 'formattedLastName')

    // Build display name — prefer "First Last" over "LAST, First"
    let display = ''
    if (firstName && lastName) {
      display = `${firstName} ${lastName}`
    } else if (fullName) {
      if (fullName.includes(',')) {
        const parts = fullName.split(',').map(s => s.trim()).filter(Boolean)
        display = parts.length >= 2 ? `${parts[1]} ${parts[0]}` : fullName
      } else {
        display = fullName
      }
    }

    if (!display && !fullName) continue

    const finalName = display || fullName

    if (isPrimary && !primaryName) {
      primaryName = finalName
    } else {
      if (finalName && finalName !== primaryName) aliases.push(finalName)
      // Also keep the original formatted form as alias
      if (fullName && fullName !== finalName && fullName !== primaryName) {
        aliases.push(fullName)
      }
    }
  }

  if (!primaryName) return null

  // ── Addresses ──────────────────────────────────────────────────
  const countries = [], cities = [], states = []
  for (const ab of getBlocks(block, 'address')) {
    const country = tagText(ab, 'country')
    if (country) countries.push(country)
    for (const ap of getBlocks(ab, 'addressPart')) {
      const apType  = tagText(ap, 'type')
      const apValue = tagText(ap, 'value')
      if (apType === 'CITY' && apValue)           cities.push(apValue)
      if (apType === 'STATE/PROVINCE' && apValue) states.push(apValue)
    }
  }

  // ── Features ───────────────────────────────────────────────────
  let dob = null, gender = null, placeOfBirth = null
  for (const fb of getBlocks(block, 'feature')) {
    const fType = tagText(fb, 'type')
    const fVal  = tagText(fb, 'value')
    if (fType === 'Birthdate')       dob          = tagText(fb, 'fromDateBegin') || fVal
    if (fType === 'Gender')          gender        = fVal
    if (fType === 'Place of Birth')  placeOfBirth  = fVal
  }

  // ── Identity documents ─────────────────────────────────────────
  const idDocuments = []
  for (const idb of getBlocks(block, 'identityDocument')) {
    const num = tagText(idb, 'documentNumber')
    if (num) idDocuments.push({
      type:    tagText(idb, 'type'),
      number:  num,
      country: tagText(idb, 'issuingCountry'),
    })
  }

  // ── Relationships ──────────────────────────────────────────────
  const relationships = []
  for (const rb of getBlocks(block, 'relationship')) {
    const rt = tagText(rb, 'type')
    const re = tagText(rb, 'relatedEntity')
    if (rt && re) relationships.push({ type: rt, entity: re })
  }

  const rec = {
    id:            `ofac-${id}`,
    name:          primaryName,
    type,
    lists:         lists.length ? lists : ['SDN List'],
    programs:      [...new Set(programs)],
    aliases:       [...new Set(aliases.filter(a => a && a !== primaryName))],
    countries:     [...new Set(countries)],
    cities:        [...new Set(cities)],
    dob,
    gender,
    placeOfBirth,
    idDocuments:   idDocuments.length   ? idDocuments             : undefined,
    relationships: relationships.length ? relationships.slice(0,5) : undefined,
  }

  // Remove empty/null fields
  for (const k of Object.keys(rec)) {
    if (rec[k] === null || rec[k] === undefined) delete rec[k]
    if (Array.isArray(rec[k]) && rec[k].length === 0) delete rec[k]
  }

  return rec
}

// ── Parse full XML file ────────────────────────────────────────────
function parseXML(xml, defaultList) {
  const entityBlocks = getBlocks(xml, 'entity')
  console.log(`  Found ${entityBlocks.length} entity blocks`)

  const records = []
  let skipped = 0
  const tick = Math.max(1, Math.floor(entityBlocks.length / 10))

  for (let i = 0; i < entityBlocks.length; i++) {
    if (i % tick === 0) {
      process.stdout.write(`\r  Parsing: ${Math.round(i / entityBlocks.length * 100)}%`)
    }
    try {
      const rec = parseEntity(entityBlocks[i])
      if (rec) {
        // Apply default list if none found
        if (!rec.lists || rec.lists.length === 0) rec.lists = [defaultList]
        records.push(rec)
      } else {
        skipped++
      }
    } catch (e) {
      skipped++
    }
  }
  console.log(`\r  Parsing: 100%`)
  return { records, skipped }
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════╗')
  console.log('║  SanctionCheck — OFAC Data Converter v3      ║')
  console.log('╚══════════════════════════════════════════════╝\n')

  if (!fs.existsSync('public')) fs.mkdirSync('public')

  const sources = []
  if (SDN_FILE)  sources.push({ file: SDN_FILE,  defaultList: 'SDN List' })
  if (CONS_FILE) sources.push({ file: CONS_FILE, defaultList: 'Consolidated List' })

  if (sources.length === 0) {
    console.error('No XML files found! Download:')
    console.error('  SDN_ENHANCED.XML  from sanctionslist.ofac.treas.gov/Home/SdnList')
    console.error('  cons_enhanced.xml from sanctionslist.ofac.treas.gov/Home/ConsolidatedList')
    process.exit(1)
  }

  const allRecords = [], seenIds = new Set()

  for (const source of sources) {
    const sizeMB = (fs.statSync(source.file).size / 1024 / 1024).toFixed(1)
    console.log(`\nReading: ${source.file} (${sizeMB} MB)`)
    const xml = fs.readFileSync(source.file, 'utf8')
    const { records, skipped } = parseXML(xml, source.defaultList)
    console.log(`  Parsed: ${records.length} · Skipped: ${skipped}`)

    let added = 0, merged = 0
    for (const rec of records) {
      if (!seenIds.has(rec.id)) {
        seenIds.add(rec.id)
        allRecords.push(rec)
        added++
      } else {
        const ex = allRecords.find(r => r.id === rec.id)
        if (ex && rec.lists) {
          ex.lists = [...new Set([...(ex.lists || []), ...rec.lists])]
          merged++
        }
      }
    }
    console.log(`  New: ${added} · Merged: ${merged}`)
  }

  // Stats
  const byType = {}, byList = {}
  allRecords.forEach(r => {
    byType[r.type] = (byType[r.type] || 0) + 1
    ;(r.lists || []).forEach(l => byList[l] = (byList[l] || 0) + 1)
  })

  console.log('\n══════════════════════════════════════════════')
  console.log('SUMMARY')
  console.log('══════════════════════════════════════════════')
  console.log('By type:')
  Object.entries(byType).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`  ${k}: ${v}`))
  console.log('By list:')
  Object.entries(byList).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`  ${k}: ${v}`))
  console.log(`Total: ${allRecords.length}`)

  // Verify Maduro is found
  const maduro = allRecords.filter(r => r.name && r.name.toUpperCase().includes('MADURO'))
  console.log(`\nVerification — Maduro records: ${maduro.length}`)
  if (maduro.length) console.log('  Sample:', maduro[0].name, '|', maduro[0].lists)

  // Save
  const output = JSON.stringify({
    updated:  new Date().toISOString(),
    count:    allRecords.length,
    source:   'US Treasury OFAC — sanctionslistservice.ofac.treas.gov',
    lists:    Object.keys(byList),
    byType,
    byList,
    records:  allRecords,
  })

  fs.writeFileSync(OUT_FILE, output)
  console.log(`\nSaved:  ${OUT_FILE}`)
  console.log(`Size:   ${(output.length / 1024 / 1024).toFixed(2)} MB`)
  console.log('\n✓ Done!')
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1) })