/**
 * fetch-ofac.js — SanctionCheck OFAC Data Converter v4
 *
 * Reads local XML files and converts to public/sdn.json
 *
 * Files needed in same folder:
 *   SDN_ENHANCED.XML   — from sanctionslist.ofac.treas.gov/Home/SdnList
 *   cons_enhanced.xml  — from sanctionslist.ofac.treas.gov/Home/ConsolidatedList
 *
 * Usage: node fetch-ofac.js
 *
 * Monthly refresh:
 *   1. Download fresh SDN_ENHANCED.XML from sanctionslist.ofac.treas.gov/Home/SdnList
 *   2. Download fresh cons_enhanced.xml from sanctionslist.ofac.treas.gov/Home/ConsolidatedList
 *   3. Run: node fetch-ofac.js
 *   4. Commit + push to GitHub
 */

const fs   = require('fs')
const path = require('path')

// Accept various filename casings
function findFile(names) {
  for (const n of names) { if (fs.existsSync(n)) return n }
  return null
}

const SDN_FILE  = findFile(['SDN_ENHANCED.XML','sdn_enhanced.xml','SDN_ENHANCED.xml'])
const CONS_FILE = findFile(['cons_enhanced.xml','CONS_ENHANCED.XML','cons_enhanced.XML'])
const OUT_FILE  = path.join('public','sdn.json')

// ── XML helpers ────────────────────────────────────────────────────

function tagText(str, tag) {
  const s = str.indexOf(`<${tag}`)
  if (s === -1) return ''
  const cs = str.indexOf('>', s) + 1
  const e  = str.indexOf(`</${tag}>`, cs)
  if (e === -1) return ''
  return str.substring(cs, e).replace(/<[^>]+>/g, '').trim()
}

function allTagText(str, tag) {
  const results = [], close = `</${tag}>`
  let pos = 0
  while (true) {
    const open = str.indexOf(`<${tag}`, pos)
    if (open === -1) break
    const cs = str.indexOf('>', open) + 1
    const e  = str.indexOf(close, cs)
    if (e === -1) break
    const text = str.substring(cs, e).replace(/<[^>]+>/g, '').trim()
    if (text) results.push(text)
    pos = e + close.length
  }
  return results
}

function blocks(str, tag) {
  const out = [], close = `</${tag}>`
  let pos = 0
  while (true) {
    // Find opening tag — must be followed by > or space (not partial match)
    let open = -1, search = pos
    while (search < str.length) {
      const idx = str.indexOf(`<${tag}`, search)
      if (idx === -1) break
      const next = str[idx + tag.length + 1]
      if (next === '>' || next === ' ' || next === '\n' || next === '\r') { open = idx; break }
      search = idx + 1
    }
    if (open === -1) break
    const e = str.indexOf(close, open)
    if (e === -1) break
    out.push(str.substring(open, e + close.length))
    pos = e + close.length
  }
  return out
}

function getAttr(str, tag, attrName) {
  const s = str.indexOf(`<${tag}`)
  if (s === -1) return ''
  const e = str.indexOf('>', s)
  const m = str.substring(s, e).match(new RegExp(`\\b${attrName}="([^"]*)"`, 'i'))
  return m ? m[1] : ''
}

function listName(block) {
  const gt  = block.indexOf('>') + 1
  const cl  = block.toLowerCase().indexOf('</sanctionslist>')
  if (gt < 1 || cl < 0 || cl <= gt) return ''
  return block.substring(gt, cl).trim()
}

function programName(block) {
  const gt = block.indexOf('>') + 1
  const cl = block.toLowerCase().indexOf('</sanctionsprogram>')
  if (gt < 1 || cl < 0) return ''
  return block.substring(gt, cl).trim()
}

// ── Build reference value map ──────────────────────────────────────
function buildRefMap(xml) {
  const map = {}
  for (const b of blocks(xml, 'referenceValue')) {
    const id  = getAttr(b, 'referenceValue', 'refId')
    const val = tagText(b, 'value')
    if (id && val) map[id] = val
  }
  return map
}

// ── Parse one entity ───────────────────────────────────────────────
function parseEntity(block, refMap, defaultList) {
  const id = getAttr(block, 'entity', 'id')

  // ── General Info ────────────────────────────────────────────────
  const generalInfo = blocks(block, 'generalInfo')[0] || ''

  // Entity type
  const entityTypeBlock = generalInfo.match(/<entityType[^>]*refId="(\d+)"[^>]*>([^<]*)<\/entityType>/)
  let rawType = entityTypeBlock
    ? (entityTypeBlock[2].trim() || refMap[entityTypeBlock[1]] || '')
    : tagText(generalInfo, 'entityType')

  const type = rawType === 'Individual' ? 'Person'
    : rawType === 'Entity'   ? 'Organization'
    : rawType === 'Vessel'   ? 'Vessel'
    : rawType === 'Aircraft' ? 'Airplane'
    : rawType || 'Other'

  // Title / Position (e.g. "President of Venezuela") — NEW
  const title = tagText(generalInfo, 'title') || ''

  // Remarks — additional notes — NEW
  const remarks = tagText(generalInfo, 'remarks') || ''

  // Living status — NEW
  const livingStatus = tagText(generalInfo, 'livingStatus') || ''

  // ── Sanctions lists ─────────────────────────────────────────────
  const lists = [...new Set(
    blocks(block, 'sanctionsList').map(listName).filter(Boolean)
  )]

  // ── Programs ────────────────────────────────────────────────────
  const programs = [...new Set(
    blocks(block, 'sanctionsProgram').map(programName).filter(Boolean)
  )]

  // ── Names ───────────────────────────────────────────────────────
  const nameBlocks = blocks(block, 'name')
  let primaryName = ''
  const aliases   = []

  for (const nb of nameBlocks) {
    const isPrimary = tagText(nb, 'isPrimary') === 'true'

    // Names are inside <translation> blocks
    const translationBlocks = blocks(nb, 'translation')
    const primaryTrans = translationBlocks.find(t => tagText(t, 'isPrimary') === 'true') || translationBlocks[0]

    if (!primaryTrans) continue

    const fullName  = tagText(primaryTrans, 'formattedFullName')
    const firstName = tagText(primaryTrans, 'formattedFirstName')
    const lastName  = tagText(primaryTrans, 'formattedLastName')

    let display = ''
    if (firstName && lastName) {
      display = `${firstName} ${lastName}`
    } else if (fullName) {
      display = fullName.includes(',')
        ? fullName.split(',').map(s => s.trim()).filter(Boolean).reverse().join(' ')
        : fullName
    }

    const finalName = display || fullName
    if (!finalName) continue

    if (isPrimary && !primaryName) {
      primaryName = finalName
    } else {
      if (finalName && finalName !== primaryName) aliases.push(finalName)
      if (fullName && fullName !== finalName && fullName !== primaryName) aliases.push(fullName)
    }

    // Also collect non-primary translations as aliases
    for (const t of translationBlocks) {
      if (tagText(t, 'isPrimary') === 'true') continue
      const fn = tagText(t, 'formattedFullName')
      const fi = tagText(t, 'formattedFirstName')
      const ln = tagText(t, 'formattedLastName')
      let alt = ''
      if (fi && ln) alt = `${fi} ${ln}`
      else if (fn) alt = fn.includes(',') ? fn.split(',').map(s=>s.trim()).reverse().join(' ') : fn
      if (alt && alt !== primaryName && !aliases.includes(alt)) aliases.push(alt)
    }
  }

  if (!primaryName) return null

  // ── Addresses ───────────────────────────────────────────────────
  const countries = [], cities = [], states = [], addresses = []

  for (const ab of blocks(block, 'address')) {
    // Country
    const countryM = ab.match(/<country[^>]*refId="(\d+)"[^>]*>([^<]*)<\/country>/)
    if (countryM) {
      const cName = countryM[2].trim() || refMap[countryM[1]] || ''
      if (cName) countries.push(cName)
    }

    // Address parts
    const addrObj = {}
    for (const ap of blocks(ab, 'addressPart')) {
      const t = tagText(ap, 'type')
      const v = tagText(ap, 'value')
      if (t === 'CITY' && v)                  { cities.push(v); addrObj.city = v }
      if (t === 'STATE/PROVINCE' && v)         { states.push(v); addrObj.state = v }
      if (t === 'POSTAL CODE' && v)             addrObj.postal = v
      if (t === 'ADDRESS1' && v)                addrObj.street = v
    }
    if (Object.keys(addrObj).length) addresses.push(addrObj)
  }

  // ── Features ────────────────────────────────────────────────────
  let dob = null, gender = null, placeOfBirth = null
  const nationalities = []

  for (const fb of blocks(block, 'feature')) {
    const t = tagText(fb, 'type')
    const v = tagText(fb, 'value')
    if (t === 'Birthdate')             dob           = tagText(fb, 'fromDateBegin') || v
    if (t === 'Gender')                gender         = v
    if (t === 'Place of Birth')        placeOfBirth   = v
    if (t === 'Citizenship Country' && v) nationalities.push(v)
    if (t === 'Nationality Country' && v) nationalities.push(v)
  }

  // ── Identity documents ───────────────────────────────────────────
  const idDocuments = []
  for (const idb of blocks(block, 'identityDocument')) {
    const num = tagText(idb, 'documentNumber')
    if (num) idDocuments.push({
      type:    tagText(idb, 'type'),
      number:  num,
      country: tagText(idb, 'issuingCountry'),
      valid:   tagText(idb, 'isValid') !== 'false',
    })
  }

  // ── Relationships ────────────────────────────────────────────────
  const relationships = []
  for (const rb of blocks(block, 'relationship')) {
    const rt = tagText(rb, 'type')
    const re = tagText(rb, 'relatedEntity')
    if (rt && re) relationships.push({ type: rt, entity: re })
  }

  // ── Build record ─────────────────────────────────────────────────
  const record = {
    id:            'ofac-' + id,
    name:          primaryName,
    type,
    title:         title || undefined,
    lists:         lists.length ? lists : [defaultList],
    programs:      [...new Set(programs)],
    aliases:       [...new Set(aliases.filter(a => a && a !== primaryName))],
    countries:     [...new Set(countries)],
    nationalities: nationalities.length ? [...new Set(nationalities)] : undefined,
    cities:        [...new Set(cities)],
    addresses:     addresses.length ? addresses : undefined,
    dob,
    gender,
    placeOfBirth,
    livingStatus:  livingStatus || undefined,
    remarks:       remarks || undefined,
    idDocuments:   idDocuments.length   ? idDocuments             : undefined,
    relationships: relationships.length ? relationships.slice(0,5) : undefined,
  }

  // Remove empty/null/undefined fields
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

  const entityBlocks = blocks(xml, 'entity')
  console.log(`  Found ${entityBlocks.length} entity blocks`)

  const records = []; let skipped = 0
  const tick = Math.max(1, Math.floor(entityBlocks.length / 10))

  for (let i = 0; i < entityBlocks.length; i++) {
    if (i % tick === 0) process.stdout.write(`\r  Parsing: ${Math.round(i/entityBlocks.length*100)}%`)
    try {
      const r = parseEntity(entityBlocks[i], refMap, defaultList)
      if (r) records.push(r); else skipped++
    } catch(e) { skipped++ }
  }
  console.log(`\r  Parsing: 100%`)
  return { records, skipped }
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════╗')
  console.log('║  SanctionCheck — OFAC Data Converter v4      ║')
  console.log('║  Source: US Treasury                         ║')
  console.log('╚══════════════════════════════════════════════╝\n')

  if (!fs.existsSync('public')) fs.mkdirSync('public')

  const sources = []
  if (SDN_FILE)  sources.push({ file: SDN_FILE,  defaultList: 'SDN List' })
  if (CONS_FILE) sources.push({ file: CONS_FILE, defaultList: 'Consolidated List' })

  if (sources.length === 0) {
    console.error('No XML files found!')
    console.error('  Download SDN_ENHANCED.XML from sanctionslist.ofac.treas.gov/Home/SdnList')
    console.error('  Download cons_enhanced.xml from sanctionslist.ofac.treas.gov/Home/ConsolidatedList')
    process.exit(1)
  }

  const allRecords = [], seenIds = new Set()

  for (const source of sources) {
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
    console.log(`  New: ${added} · Merged: ${merged}`)
  }

  // Stats
  const byType = {}, byList = {}
  allRecords.forEach(r => {
    byType[r.type] = (byType[r.type]||0) + 1
    ;(r.lists||[]).forEach(l => byList[l] = (byList[l]||0)+1)
  })

  console.log('\n══════════════════════════════════════════════')
  console.log('SUMMARY')
  console.log('══════════════════════════════════════════════')
  console.log('By type:')
  Object.entries(byType).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`  ${k}: ${v}`))
  console.log('By list:')
  Object.entries(byList).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`  ${k}: ${v}`))
  console.log('Total:', allRecords.length)

  // Verify key records
  const maduro = allRecords.find(r => r.name && r.name.includes('MADURO MOROS'))
  if (maduro) {
    console.log('\nVerification — Nicolas Maduro:')
    console.log('  Name:', maduro.name)
    console.log('  Title:', maduro.title || '(missing)')
    console.log('  Lists:', maduro.lists)
    console.log('  Programs:', maduro.programs)
    console.log('  ID docs:', (maduro.idDocuments||[]).length)
    console.log('  Relationships:', (maduro.relationships||[]).length)
  }

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
  console.log(`Size:   ${(output.length/1024/1024).toFixed(2)} MB`)
  console.log('\n✓ Done! Commit public/sdn.json to deploy.')
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1) })
