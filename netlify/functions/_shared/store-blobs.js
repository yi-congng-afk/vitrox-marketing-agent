const { getStore } = require('@netlify/blobs');

const CATEGORIES = [
  'Marketing Materials',
  'Event & Display Equipment',
  'Tabletop Display & Accessories',
  'Merchandise',
  'Souvenirs',
  'Promotional Items',
];

// Maps each original seed item's id to its category under the new list above,
// so items already saved under the old 5-category scheme get corrected on read
// instead of silently disappearing from every category filter.
const LEGACY_CATEGORY_BY_SEED_ID = {
  itm_seed_1: 'Merchandise', // Goodies Bag
  itm_seed_2: 'Marketing Materials', // Programme Flyers
  itm_seed_3: 'Tabletop Display & Accessories', // L-shaped File
  itm_seed_4: 'Tabletop Display & Accessories', // Grey Files
  itm_seed_5: 'Event & Display Equipment', // Roll-up Stand Bunting
  itm_seed_6: 'Event & Display Equipment', // A4 Standee
  itm_seed_7: 'Tabletop Display & Accessories', // Table Cloth
  itm_seed_8: 'Promotional Items', // Pen
  itm_seed_9: 'Event & Display Equipment', // Stand Backdrop
  itm_seed_10: 'Event & Display Equipment', // Table
  itm_seed_11: 'Event & Display Equipment', // Chair
  itm_seed_12: 'Event & Display Equipment', // Foldable Desktop
};

const SEED_ITEMS = [
  { name: 'Goodies Bag', category: 'Merchandise', unit: 'pcs', quantity: 0, lowStockThreshold: 20 },
  { name: 'Programme Flyers', category: 'Marketing Materials', unit: 'pcs', quantity: 0, lowStockThreshold: 50 },
  { name: 'L-shaped File', category: 'Tabletop Display & Accessories', unit: 'pcs', quantity: 0, lowStockThreshold: 10 },
  { name: 'Grey Files', category: 'Tabletop Display & Accessories', unit: 'pcs', quantity: 0, lowStockThreshold: 10 },
  { name: 'Roll-up Stand Bunting', category: 'Event & Display Equipment', unit: 'pcs', quantity: 0, lowStockThreshold: 2, returnable: true },
  { name: 'A4 Standee', category: 'Event & Display Equipment', unit: 'pcs', quantity: 0, lowStockThreshold: 2, returnable: true },
  { name: 'Table Cloth', category: 'Tabletop Display & Accessories', unit: 'pcs', quantity: 0, lowStockThreshold: 2 },
  { name: 'Pen', category: 'Promotional Items', unit: 'pcs', quantity: 0, lowStockThreshold: 30 },
  { name: 'Stand Backdrop', category: 'Event & Display Equipment', unit: 'pcs', quantity: 1, lowStockThreshold: 1, returnable: true },
  { name: 'Table', category: 'Event & Display Equipment', unit: 'pcs', quantity: 0, lowStockThreshold: 2, returnable: true },
  { name: 'Chair', category: 'Event & Display Equipment', unit: 'pcs', quantity: 0, lowStockThreshold: 4, returnable: true },
  { name: 'Rack Stand', category: 'Event & Display Equipment', unit: 'pcs', quantity: 0, lowStockThreshold: 2, returnable: true },
  { name: 'Foldable Desktop', category: 'Event & Display Equipment', unit: 'pcs', quantity: 0, lowStockThreshold: 1, returnable: true },
].map((item, index) => ({
  id: `itm_seed_${index + 1}`,
  name: item.name,
  category: item.category,
  unit: item.unit,
  quantity: item.quantity,
  lowStockThreshold: item.lowStockThreshold,
  returnable: Boolean(item.returnable),
  quantityOnLoan: 0,
  itemImage: null,
  locationImage: null,
  locationText: '',
  notes: '',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
}));

// Netlify's zero-config getStore(name) relies on deploy-context auto-detection,
// which isn't available on every site/plan (MissingBlobsEnvironmentError). If
// NETLIFY_BLOBS_SITE_ID / NETLIFY_BLOBS_TOKEN are set, connect explicitly instead.
function storeConfig(name) {
  const siteID = process.env.NETLIFY_BLOBS_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  return siteID && token ? { name, siteID, token } : name;
}

function itemsStore() {
  return getStore(storeConfig('vitrox-store-items'));
}
function transactionsStore() {
  return getStore(storeConfig('vitrox-store-transactions'));
}
function reportsStore() {
  return getStore(storeConfig('vitrox-store-reports'));
}
function loansStore() {
  return getStore(storeConfig('vitrox-store-loans'));
}

async function getItems() {
  const store = itemsStore();
  const data = await store.get('items', { type: 'json' });
  if (!data) {
    await store.setJSON('items', SEED_ITEMS);
    return SEED_ITEMS;
  }

  let changed = false;
  const migrated = data.map((item) => {
    let next = item;

    if (!CATEGORIES.includes(next.category)) {
      const fixedCategory = LEGACY_CATEGORY_BY_SEED_ID[next.id];
      if (fixedCategory) {
        changed = true;
        next = { ...next, category: fixedCategory };
      }
    }

    if (next.returnable === undefined || next.quantityOnLoan === undefined) {
      changed = true;
      next = { ...next, returnable: Boolean(next.returnable), quantityOnLoan: next.quantityOnLoan || 0 };
    }

    return next;
  });

  const rackStandSeed = SEED_ITEMS.find((i) => i.name === 'Rack Stand');
  const hasRackStand = migrated.some((i) => i.name.trim().toLowerCase() === 'rack stand');
  if (rackStandSeed && !hasRackStand) {
    migrated.push(rackStandSeed);
    changed = true;
  }

  if (changed) await saveItems(migrated);
  return migrated;
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

async function getLoans() {
  const data = await loansStore().get('loans', { type: 'json' });
  return data || [];
}

async function saveLoans(loans) {
  await loansStore().setJSON('loans', loans);
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
  getLoans,
  saveLoans,
  genId,
};
