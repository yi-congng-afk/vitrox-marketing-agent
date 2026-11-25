const { getItems, saveItems, getCategories, saveCategories, genId } = require('./store-blobs');
const { getStore } = require('@netlify/blobs');

// ---------- Item codes ----------

// Short code prefix per category, e.g. "EVT-003". Other categories use their initials.
const CODE_PREFIX = {
  'marketing materials': 'MKT',
  'event equipment': 'EVT',
  'display accessories': 'DSP',
  'document & filing supplies': 'DOC',
  'promotional merchandise': 'PRM',
};
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{0,19}$/;

function prefixFor(category) {
  const known = CODE_PREFIX[String(category || '').trim().toLowerCase()];
  if (known) return known;
  const letters = String(category || 'Item')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w && !/^(and|of|the)$/i.test(w))
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  return (letters || 'ITM').slice(0, 3).padEnd(3, 'X');
}

function nextCode(category, items, exceptId) {
  const prefix = prefixFor(category);
  const taken = new Set(items.filter((i) => i.id !== exceptId && i.code).map((i) => String(i.code).toUpperCase()));
  for (let n = 1; n < 10000; n++) {
    const code = `${prefix}-${String(n).padStart(3, '0')}`;
    if (!taken.has(code)) return code;
  }
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
}

// Returns { code } or { error }. Blank means "make one".
function cleanCode(raw, category, items, exceptId) {
  const code = String(raw || '').trim().toUpperCase().replace(/\s+/g, '-');
  if (!code) return { code: nextCode(category, items, exceptId) };
  if (!CODE_RE.test(code)) return { error: 'Item code: letters, numbers and dashes only (20 characters at most), e.g. EVT-003' };
  if (items.some((i) => i.id !== exceptId && String(i.code || '').toUpperCase() === code)) {
    return { error: `Item code ${code} is already used by another item` };
  }
  return { code };
}

// ---------- Design variations ----------
// All variations of an item share the item's one stock quantity.

const MAX_VARIATIONS = 50;
const VAR_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,19}$/;

// input: [{ id?, code, name, active }] -> { variations } or { error }
function cleanVariations(input, previous) {
  if (!Array.isArray(input)) return { error: 'Variations must be a list' };
  if (input.length > MAX_VARIATIONS) return { error: `${MAX_VARIATIONS} variations at most` };
  const before = Array.isArray(previous) ? previous : [];
  const out = [];
  const codes = new Set();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name || '').trim().replace(/\s+/g, ' ');
    const code = String(raw.code || '').trim().toUpperCase();
    if (!name && !code) continue;
    if (!name) return { error: `Variation ${code}: enter a name` };
    if (name.length > 60) return { error: `Variation "${name.slice(0, 20)}…": name is too long (60 characters at most)` };
    if (!code) return { error: `Variation "${name}": enter a code` };
    if (!VAR_CODE_RE.test(code)) return { error: `Variation "${name}": code can use letters, numbers and dashes only` };
    if (codes.has(code)) return { error: `Variation code ${code} is used twice` };
    codes.add(code);
    const old = raw.id ? before.find((v) => v.id === raw.id) : null;
    out.push({ id: old ? old.id : genId('var'), code, name, active: raw.active !== false });
  }
  return { variations: out };
}

// "added Open Day; renamed …; deactivated Scholarship" for the activity log.
function describeVariationChanges(before, after) {
  const a = Array.isArray(before) ? before : [];
  const b = Array.isArray(after) ? after : [];
  const parts = [];
  b.forEach((v) => {
    const old = a.find((o) => o.id === v.id);
    if (!old) parts.push(`added variation "${v.name}" (${v.code})`);
    else {
      if (old.name !== v.name || old.code !== v.code) parts.push(`variation "${old.name}" → "${v.name}" (${v.code})`);
      if (old.active !== v.active) parts.push(`${v.active ? 'activated' : 'deactivated'} variation "${v.name}"`);
    }
  });
  a.forEach((o) => {
    if (!b.some((v) => v.id === o.id)) parts.push(`removed variation "${o.name}"`);
  });
  return parts.join(', ');
}

// ---------- One-time category update (Nov 2026 specification) ----------

const NEW_CATEGORIES = ['Marketing Materials', 'Event Equipment', 'Display Accessories', 'Document & Filing Supplies', 'Promotional Merchandise'];

const BY_NAME = {
  'programme flyers': 'Marketing Materials',
  'roll-up stand bunting': 'Marketing Materials',
  'roll-up bunting': 'Marketing Materials',
  'a4 standee': 'Marketing Materials',
  'stand backdrop': 'Marketing Materials',
  backdrop: 'Marketing Materials',
  table: 'Event Equipment',
  chair: 'Event Equipment',
  'rack stand': 'Event Equipment',
  'foldable desktop': 'Event Equipment',
  'portable desktop': 'Event Equipment',
  'pole hanger': 'Event Equipment',
  'table cloth': 'Display Accessories',
  'pen stand': 'Display Accessories',
  'l-shaped file': 'Document & Filing Supplies',
  'grey files': 'Document & Filing Supplies',
  'grey file folder': 'Document & Filing Supplies',
  'goodies bag': 'Promotional Merchandise',
  pen: 'Promotional Merchandise',
  notebook: 'Promotional Merchandise',
  'pencil case': 'Promotional Merchandise',
};

const BY_OLD_CATEGORY = {
  'marketing materials': 'Marketing Materials',
  'event & display equipment': 'Event Equipment',
  'tabletop display & accessories': 'Display Accessories',
  merchandise: 'Promotional Merchandise',
  souvenirs: 'Promotional Merchandise',
  'promotional items': 'Promotional Merchandise',
};

const MIGRATION_ID = 'categories-2026-11';

function configStore() {
  const siteID = process.env.NETLIFY_BLOBS_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  return getStore(siteID && token ? { name: 'vitrox-store-config', siteID, token } : 'vitrox-store-config');
}

let migrationDone = false;

// Runs once ever (remembered in the config store): keeps a copy of the item
// list first, then moves items into the new categories and gives every item a
// code. Admin changes made afterwards are never touched again.
async function runCategoryMigrationOnce(audit) {
  if (migrationDone) return null;
  const store = configStore();
  const done = (await store.get('migrations', { type: 'json' })) || {};
  if (done[MIGRATION_ID]) {
    migrationDone = true;
    return null;
  }

  const items = await getItems();
  const before = await getCategories();
  await store.setJSON(`backup-before-${MIGRATION_ID}`, { at: new Date().toISOString(), categories: before, items });

  let moved = 0;
  const next = items.map((item) => {
    const target = BY_NAME[String(item.name || '').trim().toLowerCase()] || BY_OLD_CATEGORY[String(item.category || '').trim().toLowerCase()];
    if (target && target !== item.category) {
      moved++;
      return { ...item, category: target };
    }
    return item;
  });
  let coded = 0;
  next.forEach((item) => {
    if (!item.code) {
      item.code = nextCode(item.category, next, item.id);
      coded++;
    }
    if (!Array.isArray(item.variations)) item.variations = [];
    if (typeof item.hasVariations !== 'boolean') item.hasVariations = false;
  });

  const stillUsed = [...new Set(next.map((i) => i.category))].filter((c) => c && !NEW_CATEGORIES.includes(c));
  const list = NEW_CATEGORIES.concat(stillUsed);

  await saveItems(next);
  await saveCategories(list);
  await store.setJSON('migrations', { ...done, [MIGRATION_ID]: new Date().toISOString() });
  migrationDone = true;

  if (audit) {
    await audit(
      { __admin: { email: '', name: 'System', via: 'system' } },
      'categories',
      `One-time update: categories set to ${list.map((c) => `"${c}"`).join(', ')}; ${moved} items moved to their new category; ${coded} items given an item code (a copy of the old list was kept)`
    );
  }
  return { moved, coded, categories: list };
}

module.exports = {
  CODE_RE,
  prefixFor,
  nextCode,
  cleanCode,
  cleanVariations,
  describeVariationChanges,
  NEW_CATEGORIES,
  runCategoryMigrationOnce,
};
