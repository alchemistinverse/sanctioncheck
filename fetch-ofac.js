/**
 * fetch-ofac.js
 * Converts local OFAC XML files to sdn.json
 *
 * Files needed in same folder:
 *   sdn_enhanced.xml     — SDN List (download from sanctionslist.ofac.treas.gov/Home/SdnList)
 *   cons_enhanced.xml    — Consolidated List (download from sanctionslist.ofac.treas.gov/Home/ConsolidatedList)
 *
 * Usage: node fetch-ofac.js
 *
 * Refresh: Download fresh XML files monthly, then re-run this script
 */

const fs   = require('fs')
const path = require('path')

const SOURCES = [
  { file: 'sdn_enhanced.xml',  defaultList: 'SDN List' },
  { file: 'cons_enhanced.xml', defaultList: 'Consolidated List' },
]
const OUT_FILE = path.join('public', 'sdn.json')

// ── XML helpers ────────────────────────────────────────────────────

// Extract text content of a tag — strips inner XML
function tagText(str, tag) {
  const s = str.indexOf(`<${tag}`)
  if (s === -1) return ''
  const cs = str.indexOf('>', s) + 1
  const e  = str.indexOf(`</${tag}>`, cs)
  if (e === -1) return ''
  return str.substring(cs, e).replace(/<[^>]+>/g, '').trim()
}

// Get ALL text contents of a repeating tag
function allTagText(str, tag) {
  const out = [], close = `</${tag}>`
  let pos = 0
  while (true) {
    const open = str.indexOf(`<${tag}`, pos)
    if (open === -1) break
    const cs = str.indexOf('>', open) + 1
    const e  = str.indexOf(close, cs)
    if (e === -1) break
    const text = str.substring(cs, e).replace(/<[^>]+>/g, '').trim()
    if (text) out.push(text)
    pos = e + close.length
  }
  return out
}

// Get all full blocks of a tag (including inner XML)
function blocks(str, tag) {
  const out = [], close = `</${tag}>`
  let pos = 0
  while (true) {
    const open = str.indexOf(`<${tag}`, pos)
    if (open === -1) break
    const e = str.indexOf(close, open)
    if (e === -1) break
    out.push(str.substring(open, e + close.length))
    pos = e + close.length
  }
  return out
}

// Get attribute value from opening tag
function attr(str, tag, a) {
  const s = str.indexOf(`<${tag}`)
  if (s === -1) return ''
  const e = str.indexOf('>', s)
  const m = str.substring(s, e).match(new RegExp(`${a}="([^"]*)"`, 'i'))
  return m ? m[1] : ''
}

// Extract list name from a sanctionsList block
// Block looks like: <sanctionsList refId="1550" id="123" datePublished="2026">SDN List</sanctionsList>
function listName(block) {
  const open  = block.indexOf('>') + 1
  const close = block.indexOf('</sanctionsList>')
  if (open < 1 || close < 0) return ''
  return block.substring(open, close).trim()
}

// ── Build reference value map from XML ────────────────────────────
// The enhanced XML has a <referenceValues> section that maps refId → value
// We use this to resolve entity types, countries etc.
function buildRefMap(xml) {
  const map = {}
  for (const b of blocks(xml, 'referenceValue')) {
    const id  = attr(b, 'referenceValue', 'refId')
    const val = tagText(b, 'value')
    if (id && val) map[id] = val
  }
  return map
}

// ── Parse one entity ───────────────────────────────────────────────
function parseEntity(block, refMap, defaultList) {
  const id = attr(block, 'entity', 'id')

  // Entity type — resolve via refId
  const entityTypeBlock = block.match(/<entityType[^>]*refId="(\d+)"[^>]*>([^<]*)<\/entityType>/)
  let rawType = ''
  if (entityTypeBlock) {
    rawType = entityTypeBlock[2].trim() || refMap[entityTypeBlock[1]] || ''
  }
  if (!rawType) rawType = tagText(block, 'entityType')

  const type = rawType === 'Individual' ? 'Person'
    : rawType === 'Entity'   ? 'Organization'
    : rawType === 'Vessel'   ? 'Vessel'
    : rawType === 'Aircraft' ? 'Airplane'
    : rawType || 'Other'

  // Sanctions lists — extract text between > and </sanctionsList>
  const lists = [...new Set(
    blocks(block, 'sanctionsList').map(listName).filter(Boolean)
  )]

// Entered date — earliest datePublished across all list entries
  // Last changed — latest datePublished across all list entries
  const allListDates=getBlocks(block,'sanctionsList')
    .map(b=>{const m=b.match(/datePublished="([^"]*)"/);return m?m[1]:null})
    .filter(Boolean).sort()
  const enteredDate=allListDates[0]||null
  const lastChanged=allListDates[allListDates.length-1]||null

  // Programs
  const programs = [...new Set(allTagText(block, 'sanctionsProgram').filter(Boolean))]

  // Names — primary name + all aliases from all name blocks and translations
  const nameBlocks = blocks(block, 'name')
  let primaryName = ''
  const aliases   = []

  function buildDisplayName(translationBlock) {
    const fn = tagText(translationBlock, 'formattedFullName')
    const fi = tagText(translationBlock, 'formattedFirstName')
    const ln = tagText(translationBlock, 'formattedLastName')
    if (fi && ln) return fi + ' ' + ln
    if (fn) return fn.includes(',') ? fn.split(',').map(s=>s.trim()).filter(Boolean).reverse().join(' ') : fn
    return ''
  }

  for (const nb of nameBlocks) {
    const nameIsPrimary = tagText(nb, 'isPrimary') === 'true'
    const translationBlocks = blocks(nb, 'translation')

    if (translationBlocks.length === 0) {
      // No translations — try direct fields
      const display = buildDisplayName(nb)
      if (nameIsPrimary && !primaryName) primaryName = display
      else if (display && display !== primaryName) aliases.push(display)
      continue
    }

    for (const tb of translationBlocks) {
      const transIsPrimary = tagText(tb, 'isPrimary') === 'true'
      const display = buildDisplayName(tb)
      if (!display) continue

      if (nameIsPrimary && transIsPrimary && !primaryName) {
        primaryName = display
      } else {
        if (display !== primaryName && !aliases.includes(display)) aliases.push(display)
      }

      // Also add the raw formattedFullName as alias if different format
      const raw = tagText(tb, 'formattedFullName')
      if (raw && raw !== display && raw !== primaryName && !aliases.includes(raw)) {
        aliases.push(raw)
      }
    }
  }

  if (!primaryName) return null

  // Addresses
  const countries = [], cities = [], states = []
  for (const ab of blocks(block, 'address')) {
    // Country — try text content first, then refMap
    const countryBlock = ab.match(/<country[^>]*refId="(\d+)"[^>]*>([^<]*)<\/country>/)
    if (countryBlock) {
      const cName = countryBlock[2].trim() || refMap[countryBlock[1]] || ''
      if (cName) countries.push(cName)
    }
    for(const ap of getBlocks(ab,'addressPart')){
      const t=tagText(ap,'type'),v=tagText(ap,'value')
      if(t==='CITY'&&v)cities.push(v)
      if(t==='STATE/PROVINCE'&&v)states.push(v)
      if(t==='POSTAL CODE'&&v)addrObj.postal=v
      if(t==='ADDRESS1'&&v)addrObj.street=v
      if(t==='ADDRESS2'&&v)addrObj.street2=v
    }

  // Features — DOB, gender, place of birth
  let dob = null, gender = null, placeOfBirth = null
  for (const fb of blocks(block, 'feature')) {
    const t = tagText(fb, 'type')
    const v = tagText(fb, 'value')
    if (t === 'Birthdate')       dob          = tagText(fb, 'fromDateBegin') || v
    if (t === 'Gender')          gender        = v
    if (t === 'Place of Birth')  placeOfBirth  = v
  }

  // Identity documents
  const idDocuments = []
  for (const idb of blocks(block, 'identityDocument')) {
    const num = tagText(idb, 'documentNumber')
    if (num) idDocuments.push({
      type:    tagText(idb, 'type'),
      number:  num,
      country: tagText(idb, 'issuingCountry')
    })
  }

  // Relationships
  const relationships = []
  for (const rb of blocks(block, 'relationship')) {
    const rt = tagText(rb, 'type'), re = tagText(rb, 'relatedEntity')
    if (rt && re) relationships.push({ type: rt, entity: re })
  }

  const record = {
    id:            'ofac-' + id,
    name:          primaryName,
    type,
    lists:         lists.length ? lists : [defaultList],
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

//enteredDate
const record={
    id:'ofac-'+id,
    name:primaryName,
    type,
    title,
    enteredDate:enteredDate||undefined,
    lists:lists.length?lists:[defaultList],
    lastChanged:lastChanged||undefined,


  // Remove empty fields
  Object.keys(record).forEach(k => {
    if (record[k] === null || record[k] === undefined) delete record[k]
    if (Array.isArray(record[k]) && record[k].length === 0) delete record[k]
  })

  return record
}

// ── Parse full XML file ────────────────────────────────────────────
function parseFile(xml, defaultList) {
  console.log('  Building reference map...')
  const refMap = buildRefMap(xml)
  console.log(`  Reference values: ${Object.keys(refMap).length}`)

  console.log('  Parsing entities...')
  const entityBlocks = blocks(xml, 'entity')
  console.log(`  Found ${entityBlocks.length} entity blocks`)

  const records = []; let skipped = 0
  const tick = Math.floor(entityBlocks.length / 20)

  for (let i = 0; i < entityBlocks.length; i++) {
    if (tick && i % tick === 0) process.stdout.write(`\r  Progress: ${Math.round(i/entityBlocks.length*100)}%`)
    try {
      const r = parseEntity(entityBlocks[i], refMap, defaultList)
      if (r) records.push(r); else skipped++
    } catch(e) { skipped++ }
  }
  console.log(`\r  Progress: 100%`)
  return { records, skipped }
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  console.log('╔════════════════════════════════════════════╗')
  console.log('║  SanctionCheck — OFAC Data Converter       ║')
  console.log('║  Reads local XML files → sdn.json          ║')
  console.log('╚════════════════════════════════════════════╝\n')

  if (!fs.existsSync('public')) fs.mkdirSync('public')

  const allRecords = [], seenIds = new Set()

  for (const source of SOURCES) {
    if (!fs.existsSync(source.file)) {
      console.log(`\nSkipping ${source.file} — file not found`)
      continue
    }
    const sizeMB = (fs.statSync(source.file).size / 1024 / 1024).toFixed(1)
    console.log(`\nReading: ${source.file} (${sizeMB} MB)`)
    const xml = fs.readFileSync(source.file, 'utf8')
    const { records, skipped } = parseFile(xml, source.defaultList)
    console.log(`  Parsed: ${records.length} · Skipped: ${skipped}`)

    let added = 0, merged = 0
    for (const rec of records) {
      if (!seenIds.has(rec.id)) {
        seenIds.add(rec.id); allRecords.push(rec); added++
      } else {
        const ex = allRecords.find(r => r.id === rec.id)
        if (ex && rec.lists) {
          ex.lists = [...new Set([...(ex.lists||[]), ...rec.lists])]
          merged++
        }
      }
    }
    console.log(`  New: ${added} · Merged into existing: ${merged}`)
  }

  // Summary
  const byType = {}, byList = {}
  allRecords.forEach(r => {
    byType[r.type] = (byType[r.type]||0) + 1
    ;(r.lists||[]).forEach(l => byList[l] = (byList[l]||0)+1)
  })

  console.log('\n══════════════════════════════════════════════')
  console.log('FINAL SUMMARY')
  console.log('══════════════════════════════════════════════')
  console.log('By type:')
  Object.entries(byType).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`  ${k}: ${v}`))
  console.log('By list:')
  Object.entries(byList).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`  ${k}: ${v}`))
  console.log('Total unique records:', allRecords.length)

  // Save
  const output = JSON.stringify({
    updated:  new Date().toISOString(),
    count:    allRecords.length,
    source:   'US Treasury OFAC — sanctionslistservice.ofac.treas.gov',
    lists:    Object.keys(byList),
    byType,
    byList,
    records:  allRecords
  })

  fs.writeFileSync(OUT_FILE, output)
  console.log(`\nSaved:  ${OUT_FILE}`)
  console.log(`Size:   ${(output.length/1024/1024).toFixed(2)} MB`)
  console.log('\n✓ Done! Commit public/sdn.json to GitHub to deploy.')
  console.log('\nMonthly refresh:')
  console.log('  1. Download fresh sdn_enhanced.xml from sanctionslist.ofac.treas.gov/Home/SdnList')
  console.log('  2. Download fresh cons_enhanced.xml from sanctionslist.ofac.treas.gov/Home/ConsolidatedList')
  console.log('  3. Run: node fetch-ofac.js')
  console.log('  4. Commit + push to GitHub')
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1) })
