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
function imagesStore() {
  return getStore(storeConfig('vitrox-store-images'));
}

// ---- Photos ----
// Photos used to be saved inside the items list itself (as data: URLs), which
// made that list megabytes big and slow to load and to save on every action.
// Each photo now lives in its own blob, and the item only keeps a short URL to
// it. The id is new for every upload, so browsers can cache a photo forever.

const IMAGE_FIELDS = ['itemImage', 'locationImage'];
const IMAGE_URL_PREFIX = '/.netlify/functions/store-image?id=';
const INLINE_IMAGE_PATTERN = /^data:image\/(jpeg|jpg|png|webp|gif);base64,/;
const MAX_IMAGE_CHARS = 3000000;
const MIGRATE_BATCH = 8;

function isInlineImage(value) {
  return typeof value === 'string' && INLINE_IMAGE_PATTERN.test(value.slice(0, 40));
}

function isStoredImageUrl(value) {
  return typeof value === 'string' && value.startsWith(IMAGE_URL_PREFIX);
}

async function saveImage(dataUrl) {
  if (!isInlineImage(dataUrl)) throw new Error('Photos must be JPEG, PNG or WebP images');
  if (dataUrl.length > MAX_IMAGE_CHARS) throw new Error('That photo is too large — please use a smaller one');
  const id = genId('img');
  await imagesStore().set(id, dataUrl);
  return IMAGE_URL_PREFIX + id;
}

async function getImage(id) {
  return imagesStore().get(id);
}

async function deleteImage(url) {
  if (!isStoredImageUrl(url)) return;
  try {
    await imagesStore().delete(url.slice(IMAGE_URL_PREFIX.length));
  } catch {
    // A leftover photo blob is harmless; never fail the request over it.
  }
}

// Moves photos still saved inside the items list out into the photo store, a
// few per call so a request never runs long. A photo is only dropped from the
// list after its copy has been written, so nothing is lost if a step fails.
async function migrateInlineImages(items) {
  const pending = [];
  for (const item of items) {
    for (const field of IMAGE_FIELDS) {
      if (isInlineImage(item[field]) && item[field].length <= MAX_IMAGE_CHARS) {
        pending.push({ id: item.id, field, dataUrl: item[field] });
      }
    }
  }
  if (pending.length === 0) return items;

  const moved = (
    await Promise.all(
      pending.slice(0, MIGRATE_BATCH).map(async (entry) => {
        try {
          return { ...entry, url: await saveImage(entry.dataUrl) };
        } catch {
          return null;
        }
      })
    )
  ).filter(Boolean);
  if (moved.length === 0) return items;

  // Re-read just before saving so stock changes made while the photos were
  // being copied are not overwritten with the older list.
  const fresh = await getItems();
  let changed = false;
  for (const entry of moved) {
    const item = fresh.find((i) => i.id === entry.id);
    if (item && item[entry.field] === entry.dataUrl) {
      item[entry.field] = entry.url;
      changed = true;
    }
  }
  if (changed) await saveItems(fresh);
  return fresh;
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
  IMAGE_FIELDS,
  isInlineImage,
  saveImage,
  getImage,
  deleteImage,
  migrateInlineImages,
};
