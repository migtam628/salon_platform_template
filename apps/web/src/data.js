export const demoProducts = [
  { id: 'shampoo', name: 'Restorative Shampoo', category: 'Hair Care', price: 34, description: 'Strengthen + nourish hair', image: '/images/product-shampoo.webp' },
  { id: 'oil', name: 'Nourishing Hair Oil', category: 'Hair Care', price: 48, description: 'Smooth + illuminate', image: '/images/product-oil.webp' },
  { id: 'balm', name: 'Cuticle Balm', category: 'Nail Care', price: 26, description: 'Nourish + restore', image: '/images/product-balm.webp' },
];
export const demoServices = [
  { id: 'cut-style', category: 'Hair', name: 'Cut & Style', durationMinutes: 60, price: 75, description: 'A bespoke cut and polished finish' },
  { id: 'color', category: 'Hair', name: 'Color & Gloss', durationMinutes: 120, price: 145, description: 'Color tailored to your look' },
  { id: 'manicure', category: 'Nails', name: 'Signature Manicure', durationMinutes: 45, price: 45, description: 'Care, shape, and beautiful color' },
  { id: 'pedicure', category: 'Nails', name: 'Luxury Pedicure', durationMinutes: 60, price: 65, description: 'Restorative foot and nail ritual' },
  { id: 'facial', category: 'Beauty', name: 'Radiance Facial', durationMinutes: 60, price: 110, description: 'Personalized skincare treatment' },
  { id: 'brows', category: 'Beauty', name: 'Brow Design', durationMinutes: 30, price: 35, description: 'Shape and define' },
];
export const demoStaff = [
  { id: 'alex', name: 'Alex Morgan', specialties: ['Hair'] },
  { id: 'sofia', name: 'Sofia Reyes', specialties: ['Nails'] },
  { id: 'jordan', name: 'Jordan Lee', specialties: ['Beauty'] },
];
export const categories = ['Hair', 'Nails', 'Beauty'];
export const price = (value) => `$${Number(value).toFixed(2)}`;
export const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
