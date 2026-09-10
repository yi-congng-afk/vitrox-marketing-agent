const { getStore } = require('@netlify/blobs');

const CATEGORIES = [
  'Promotional Merchandise',
  'Printed Marketing Materials',
  'Stationery & Filing',
  'Event & Booth Equipment',
  'Furniture',
];

const SEED_ITEMS = [
  { name: 'Goodies Bag', category: 'Promotional Merchandise', unit: 'pcs', quantity: 0, lowStockThreshold: 20 },
  { name: 'Programme Flyers', category: 'Printed Marketing Materials', unit: 'pcs', quantity: 0, lowStockThreshold: 50 },
  { name: 'L-shaped File', category: 'Stationery & Filing', unit: 'pcs', quantity: 0, lowStockThreshold: 10 },
  { name: 'Grey Files', category: 'Stationery & Filing', unit: 'pcs', quantity: 0, lowStockThreshold: 10 },
  { name: 'Roll-up Stand Bunting', category: 'Event & Booth Equipment', unit: 'pcs', quantity: 0, lowStockThreshold: 2 },
  { name: 'A4 Standee', category: 'Event & Booth Equipment', unit: 'pcs', quantity: 0, lowStockThreshold: 2 },
  { name: 'Table Cloth', category: 'Event & Booth Equipment', unit: 'pcs', quantity: 0, lowStockThreshold: 2 },
  { name: 'Pen', category: 'Stationery & Filing', unit: 'pcs', quantity: 0, lowStockThreshold: 30 },
  { name: 'Stand Backdrop', category: 'Event & Booth Equipment', unit: 'pcs', quantity: 1, lowStockThreshold: 1 },
  { name: 'Table', category: 'Furniture', unit: 'pcs', quantity: 0, lowStockThreshold: 2 },
  { name: 'Chair', category: 'Furniture', unit: 'pcs', quantity: 0, lowStockThreshold: 4 },
  { name: 'Foldable Desktop', category: 'Furniture', unit: 'pcs', quantity: 0, lowStockThreshold: 1 },
].map((item, index) => ({
  id: `itm_seed_${index + 1}`,
  name: item.name,
  category: item.category,
  unit: item.unit,
  quantity: item.quantity,
  lowStockThreshold: item.lowStockThreshold,
  itemImage: null,
  locationImage: null,
  locationText: '',
  notes: '',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
}));

function itemsStore() {
  return getStore('vitrox-store-items');
}
function transactionsStore() {
  return getStore('vitrox-store-transactions');
}
function reportsStore() {
  return getStore('vitrox-store-reports');
}

async function getItems() {
  const store = itemsStore();
  const data = await store.get('items', { type: 'json' });
  if (!data) {
    await store.setJSON('items', SEED_ITEMS);
    return SEED_ITEMS;
  }
  return data;
}

async function saveItems(items) {
  await itemsStore().setJSON('items', items);
}

async function getTransactions() {
  const data = await transactionsStore().get('transactions', { type: 'json' });
  return data || [];
}

async function saveTransactions(transactions) {
  await transactionsStore().setJSON('transactions', transactions);
}

async function getReports() {
  const data = await reportsStore().get('reports', { type: 'json' });
  return data || [];
}

async function saveReports(reports) {
  await reportsStore().setJSON('reports', reports);
}

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
  CATEGORIES,
  getItems,
  saveItems,
  getTransactions,
  saveTransactions,
  getReports,
  saveReports,
  genId,
};
