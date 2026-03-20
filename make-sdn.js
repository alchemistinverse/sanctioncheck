const fs = require('fs')

console.log('Converting SDN CSV to JSON...')

const csv = fs.readFileSync('sdn_raw.csv', 'utf8')
const lines = csv.split('\n')
const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim())

const records = []

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim()
  if (!line) continue

  const vals = []
  let cur = '', inQ = false
  for (const ch of line) {
    if (ch === '"') inQ = !inQ
    else if (ch === ',' && !inQ) { vals.push(cur.trim()); cur = '' }
    else cur += ch
  }
  vals.push(cur.trim())

  const row = {}
  headers.forEach((h, idx) => {
    row[h] = (vals[idx] || '').replace(/"/g, '').trim()
  })

  const schema = row.schema || ''
  if (['Address', 'CryptoWallet', 'Security'].includes(schema)) continue

  const split = v => v ? v.split(';').map(s => s.trim()).filter(Boolean) : []

  records.push({
    id:        row.id || '',
    name:      row.name || row.caption || '',
    type:      row.schema || '',
    aliases:   split(row.aliases),
    programs:  split(row.topics),
    countries: split(row.countries),
    dob:       row.birth_date || null,
  })
}

console.log('Records converted:', records.length)

if (!fs.existsSync('public')) fs.mkdirSync('public')

const out = JSON.stringify({ updated: new Date().toISOString(), count: records.length, records })
fs.writeFileSync('public/sdn.json', out)

const sizeMB = (out.length / 1024 / 1024).toFixed(2)
console.log('Done! Size: ' + sizeMB + 'MB')
console.log('Saved to: public/sdn.json')
