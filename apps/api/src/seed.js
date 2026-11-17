export const products = [
  { id: 'shampoo', sku: 'AB-HC-001', name: 'Restorative Shampoo', category: 'Hair Care', price: 34, inventory: 24, lowStockThreshold: 6, image: '/images/product-shampoo.webp', description: 'Strengthen + nourish hair', featured: true, active: true },
  { id: 'oil', sku: 'AB-HC-002', name: 'Nourishing Hair Oil', category: 'Hair Care', price: 48, inventory: 18, lowStockThreshold: 6, image: '/images/product-oil.webp', description: 'Smooth + illuminate', featured: true, active: true },
  { id: 'balm', sku: 'AB-NC-001', name: 'Cuticle Balm', category: 'Nail Care', price: 26, inventory: 5, lowStockThreshold: 6, image: '/images/product-balm.webp', description: 'Nourish + restore', featured: true, active: true },
];

export const services = [
  { id: 'cut-style', category: 'Hair', name: 'Cut & Style', durationMinutes: 60, price: 75, description: 'A bespoke cut and polished finish', active: true },
  { id: 'color', category: 'Hair', name: 'Color & Gloss', durationMinutes: 120, price: 145, description: 'Color tailored to your look', active: true },
  { id: 'manicure', category: 'Nails', name: 'Signature Manicure', durationMinutes: 45, price: 45, description: 'Care, shape, and beautiful color', active: true },
  { id: 'pedicure', category: 'Nails', name: 'Luxury Pedicure', durationMinutes: 60, price: 65, description: 'Restorative foot and nail ritual', active: true },
  { id: 'facial', category: 'Beauty', name: 'Radiance Facial', durationMinutes: 60, price: 110, description: 'Personalized skincare treatment', active: true },
  { id: 'brows', category: 'Beauty', name: 'Brow Design', durationMinutes: 30, price: 35, description: 'Shape and define', active: true },
];

export const staff = [
  { id: 'alex', name: 'Alex Morgan', specialties: ['Hair'], active: true, workDays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' },
  { id: 'sofia', name: 'Sofia Reyes', specialties: ['Nails'], active: true, workDays: [2, 3, 4, 5, 6], startTime: '10:00', endTime: '18:00' },
  { id: 'jordan', name: 'Jordan Lee', specialties: ['Beauty'], active: true, workDays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' },
];
