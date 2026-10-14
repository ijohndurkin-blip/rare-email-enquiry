// Creates a demo business with sample enquiries: `npm run seed`
const { db } = require('./db');
const sec = require('./security');
const { getBusiness } = require('./enquiries');
const { loadDemo } = require('./demo');

const name = process.argv[2] || 'Harbour Kitchens & Bathrooms';
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const code = process.argv[3] || 'demo-1234';

let b = getBusiness('slug', slug);
if (!b) {
  db.prepare('INSERT INTO businesses (slug, name, brand_color, access_hash, inbound_token, settings) VALUES (?, ?, ?, ?, ?, ?)')
    .run(slug, name, '#1c5cab', sec.hashCode(code), sec.randomToken(), JSON.stringify({
      contactEmail: 'hello@harbourkitchens.co.uk',
      scoring: { serviceTerms: ['kitchen', 'bathroom', 'worktop', 'fitting', 'renovation', 'tiling', 'extension'] },
    }));
  b = getBusiness('slug', slug);
} else {
  db.prepare('UPDATE businesses SET access_hash = ? WHERE id = ?').run(sec.hashCode(code), b.id);
}
const n = loadDemo(b);
console.log(`Seeded "${name}" with ${n} enquiries.`);
console.log(`Dashboard: http://localhost:${process.env.PORT || 3000}/b/${slug}   access code: ${code}`);
console.log(`Admin:     http://localhost:${process.env.PORT || 3000}/admin   password: ${sec.loadAdminPassword()}`);
