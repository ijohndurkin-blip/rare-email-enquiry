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
      info: {
        phone: '0113 496 0000',
        hours: 'Mon–Fri 8am–6pm, Sat 9am–1pm',
        website: 'harbourkitchens.co.uk',
        signature: 'Sam Carter\nHarbour Kitchens & Bathrooms\n0113 496 0000',
      },
      knowledge: {
        profile: 'Family-run kitchen and bathroom fitters based in Leeds, covering West Yorkshire. We design, supply and fit kitchens and bathrooms, and fit customer-supplied units. Free home survey and quote within 3 working days. 20% deposit to book, balance on completion. 10-year workmanship guarantee.',
        prices: [
          { item: 'Kitchen fitting (customer-supplied units)', price: 'from £1,800', notes: 'typical 10-unit kitchen, 4–5 days' },
          { item: 'Full kitchen supply & fit', price: 'from £7,500', notes: 'includes design, units, worktops, appliances extra' },
          { item: 'Bathroom refit', price: 'from £4,950', notes: 'standard 3-piece suite, tiling included' },
          { item: 'Quartz worktops', price: '£350 per metre', notes: 'templated and fitted' },
          { item: 'Home survey & quote', price: 'Free', notes: 'within 3 working days' },
        ],
      },
      automations: { followUp: { mode: 'draft', days: [3, 7] } },
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
