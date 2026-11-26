const { requireAdmin, requireManager } = require('./_shared/store-auth');
const {
  getItems,
  getCategories,
  saveCategories,
  saveItems,
  genId,
  IMAGE_FIELDS,
  isInlineImage,
  saveImage,
  deleteImage,
  migrateInlineImages,
} = require('./_shared/store-blobs');
const { checkAccess } = require('./_shared/store-access');
const { audit, describeChanges } = require('./_shared/audit');
const { getBookings } = require('./_shared/store-blobs');
const { cleanCode, cleanVariations, describeVariationChanges, runCategoryMigrationOnce } = require('./_shared/inventory');
const { isLive } = require('./_shared/bookings');

const REQUIRED_FIELDS = ['name', 'category'];
const ITEM_FIELDS = [
  ['name', 'name'],
  ['code', 'item code'],
  ['category', 'category'],
  ['unit', 'unit'],
  ['quantity', 'total', 'number'],
  ['lowStockThreshold', 'low-stock level', 'number'],
  ['returnable', 'loanable'],
  ['locationText', 'location'],
  ['notes', 'notes'],
  ['itemImage', 'photo', 'photo'],
  ['locationImage', 'location photo', 'photo'],
  ['hasVariations', 'has variations'],
];
const MAX_CATEGORY_LENGTH = 60;

function json(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
}

// Admin: replace the category list. body = { categories: [names in order],
// renames: { oldName: newName } }. Items in a renamed category move with it;
// a category that still has items can't be dropped.
async function updateCategories(body, event) {
  const list = [];
  const seen = new Set();
  for (const raw of Array.isArray(body.categories) ? body.categories : []) {
    const name = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!name) continue;
    if (name.length > MAX_CATEGORY_LENGTH) return json(400, { error: `"${name.slice(0, 20)}…" is too long (${MAX_CATEGORY_LENGTH} characters at most)` });
    if (seen.has(name.toLowerCase())) return json(400, { error: `"${name}" is listed twice` });
    seen.add(name.toLowerCase());
    list.push(name);
  }
  if (list.length === 0) return json(400, { error: 'Keep at least one category' });

  const renames = body.renames && typeof body.renames === 'object' ? body.renames : {};
  const items = await getItems();
  let moved = 0;
  for (const item of items) {
    const target = renames[item.category];
    if (typeof target === 'string' && list.includes(target.trim().replace(/\s+/g, ' '))) {
      item.category = target.trim().replace(/\s+/g, ' ');
      item.updatedAt = new Date().toISOString();
      moved++;
    }
  }
  const stranded = {};
  items.forEach((i) => {
    if (!list.includes(i.category)) stranded[i.category] = (stranded[i.category] || 0) + 1;
  });
  const names = Object.keys(stranded);
  if (names.length) {
    return json(400, {
      error: names.map((n) => `"${n}" still has ${stranded[n]} item${stranded[n] === 1 ? '' : 's'}`).join('; ') + ' — move them to another category first',
    });
  }

  const previous = await getCategories();
  if (moved) await saveItems(items);
  await saveCategories(list);

  const renamed = Object.entries(renames)
    .filter(([from, to]) => typeof to === 'string' && from !== to && previous.includes(from))
    .map(([from, to]) => `"${from}" → "${to}"`);
  const renamedTargets = Object.values(renames);
  const added = list.filter((n) => !previous.includes(n) && !renamedTargets.includes(n));
  const removed = previous.filter((n) => !list.includes(n) && !(n in renames));
  const parts = [];
  if (renamed.length) parts.push(`renamed ${renamed.join(', ')}`);
  if (added.length) parts.push(`added ${added.map((n) => `"${n}"`).join(', ')}`);
  if (removed.length) parts.push(`removed ${removed.map((n) => `"${n}"`).join(', ')}`);
  if (!parts.length && previous.join('\n') !== list.join('\n')) parts.push('changed the order');
  if (parts.length) await audit(event, 'categories', `Categories: ${parts.join('; ')}`);

  return json(200, { categories: list, items, moved });
}

// Photo fields arrive as: the URL the item already has (unchanged), a freshly
// picked photo as a data: URL (store it, keep its URL), or empty (removed).
// Anything else is ignored, so an item can never point at an outside address.
// Returns the old photo URLs that are no longer used.
async function applyImages(input, item, previous) {
  const replaced = [];
  for (const field of IMAGE_FIELDS) {
    if (input[field] === undefined) continue;
    const value = input[field];
    const old = (previous && previous[field]) || null;
    if (!value) {
      item[field] = null;
      if (old) replaced.push(old);
    } else if (value === old) {
      item[field] = old;
    } else if (isInlineImage(value)) {
      item[field] = await saveImage(value);
      if (old) replaced.push(old);
    } else {
      item[field] = old;
    }
  }
  return replaced;
}

function sanitizeItem(input, existing) {
  const item = existing ? { ...existing } : {};
  if (typeof input.name === 'string') item.name = input.name.trim();
  if (typeof input.category === 'string') item.category = input.category;
  if (typeof input.unit === 'string') item.unit = input.unit.trim() || 'pcs';
  if (input.quantity !== undefined) item.quantity = Math.max(0, Math.round(Number(input.quantity)) || 0);
  if (input.lowStockThreshold !== undefined) {
    item.lowStockThreshold = Math.max(0, Math.round(Number(input.lowStockThreshold)) || 0);
  }
  if (typeof input.locationText === 'string') item.locationText = input.locationText.trim();
  if (typeof input.notes === 'string') item.notes = input.notes.trim();
  if (typeof input.returnable === 'boolean') item.returnable = input.returnable;
  // quantityOnLoan is intentionally never accepted from the client — it's only
  // ever changed by store-loans.js as loans are opened/returned.
  return item;
}

exports.handler = async (event) => {
  const method = event.httpMethod;

  const access = await checkAccess(event);
  if (access.response) return access.response;

  if (method === 'GET') {
    try {
      await runCategoryMigrationOnce(audit);
    } catch {
      // Tried again on the next load; the list still works meanwhile.
    }
    let items = await getItems();
    try {
      items = await migrateInlineImages(items);
    } catch {
      // Moving old photos out is an optimisation; the list still works without it.
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, categories: await getCategories() }),
    };
  }

  if (method === 'POST' && event.queryStringParameters && event.queryStringParameters.action === 'categories') {
    const adminError = await requireAdmin(event);
    if (adminError) return adminError;
    let body;
    try {
      body = JSON.parse(event.body || '{}') || {};
    } catch {
      return json(400, { error: 'Invalid request body' });
    }
    return updateCategories(body, event);
  }

  const managerError = await requireManager(event);
  if (managerError) return managerError;

  if (method === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const missing = REQUIRED_FIELDS.filter((f) => !body[f]);
    if (missing.length) {
      return { statusCode: 400, body: JSON.stringify({ error: `Missing required field(s): ${missing.join(', ')}` }) };
    }

    const items = await getItems();
    const now = new Date().toISOString();
    const codeResult = cleanCode(body.code, body.category, items, null);
    if (codeResult.error) return json(400, { error: codeResult.error });
    const varResult = cleanVariations(Array.isArray(body.variations) ? body.variations : [], []);
    if (varResult.error) return json(400, { error: varResult.error });
    const hasVariations = body.hasVariations === true;
    if (hasVariations && !varResult.variations.length) return json(400, { error: 'Add at least one design variation, or untick "Has design variations"' });
    const newItem = {
      id: genId('itm'),
      name: '',
      category: body.category,
      unit: 'pcs',
      quantity: 0,
      lowStockThreshold: 5,
      returnable: false,
      quantityOnLoan: 0,
      itemImage: null,
      locationImage: null,
      locationText: '',
      notes: '',
      createdAt: now,
      updatedAt: now,
      ...sanitizeItem(body, null),
    };
    newItem.createdAt = now;
    newItem.updatedAt = now;
    newItem.code = codeResult.code;
    newItem.hasVariations = hasVariations;
    newItem.variations = varResult.variations;
    newItem.archived = false;
    try {
      await applyImages(body, newItem, null);
    } catch (err) {
      return { statusCode: 400, body: JSON.stringify({ error: err.message }) };
    }

    items.push(newItem);
    await saveItems(items);
    await audit(
      event,
      'item.add',
      `Added item "${newItem.name}" ${newItem.code} (${newItem.category}, ${newItem.quantity} ${newItem.unit})` +
        (newItem.hasVariations ? ` with variations ${newItem.variations.map((v) => `"${v.name}"`).join(', ')}` : '')
    );

    return { statusCode: 201, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: newItem }) };
  }

  if (method === 'PUT') {
    const id = event.queryStringParameters && event.queryStringParameters.id;
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Missing id query parameter' }) };

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const items = await getItems();
    const index = items.findIndex((i) => i.id === id);
    if (index === -1) return { statusCode: 404, body: JSON.stringify({ error: 'Item not found' }) };

    const updated = sanitizeItem(body, items[index]);
    if (body.code !== undefined || !updated.code) {
      const codeResult = cleanCode(body.code !== undefined ? body.code : '', updated.category, items, id);
      if (codeResult.error) return json(400, { error: codeResult.error });
      updated.code = codeResult.code;
    }
    if (body.variations !== undefined) {
      const varResult = cleanVariations(body.variations, items[index].variations);
      if (varResult.error) return json(400, { error: varResult.error });
      updated.variations = varResult.variations;
    }
    if (!Array.isArray(updated.variations)) updated.variations = [];
    if (typeof body.hasVariations === 'boolean') updated.hasVariations = body.hasVariations;
    if (updated.hasVariations && !updated.variations.some((v) => v.active)) {
      return json(400, { error: 'Keep at least one active design variation, or untick "Has design variations"' });
    }
    if (typeof body.archived === 'boolean' && body.archived !== Boolean(items[index].archived)) {
      if (body.archived) {
        if ((items[index].quantityOnLoan || 0) > 0) {
          return json(400, { error: `${items[index].quantityOnLoan} of "${items[index].name}" are still out on loan — get them returned before archiving` });
        }
        const bookings = await getBookings();
        const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
        const live = bookings.filter((b) => isLive(b, today) && (b.lines || []).some((l) => l.itemId === id));
        if (live.length) {
          return json(400, { error: `"${items[index].name}" is booked for ${live.map((b) => `"${b.event}"`).join(', ')} — cancel or move those bookings first` });
        }
      }
      updated.archived = body.archived;
      updated.archivedAt = body.archived ? new Date().toISOString() : null;
    }
    const tiedUp = (items[index].quantityOnLoan || 0) + (items[index].quantityDamaged || 0);
    if (updated.quantity < tiedUp) {
      return json(400, {
        error: `${items[index].quantityOnLoan || 0} of "${items[index].name}" are out on loan${items[index].quantityDamaged ? ` and ${items[index].quantityDamaged} are held as damaged` : ''}, so the total can't be set below ${tiedUp}`,
      });
    }
    updated.updatedAt = new Date().toISOString();
    let replacedImages;
    try {
      replacedImages = await applyImages(body, updated, items[index]);
    } catch (err) {
      return { statusCode: 400, body: JSON.stringify({ error: err.message }) };
    }
    const before = items[index];
    items[index] = updated;
    await saveItems(items);
    await Promise.all(replacedImages.map(deleteImage));
    if (Boolean(before.archived) !== Boolean(updated.archived)) {
      await audit(event, updated.archived ? 'item.archive' : 'item.restore', `${updated.archived ? 'Archived' : 'Restored'} item "${updated.name}" ${updated.code || ''}`.trim());
    }
    const changes = [describeChanges(before, updated, ITEM_FIELDS), describeVariationChanges(before.variations, updated.variations)].filter(Boolean).join(', ');
    if (changes) await audit(event, 'item.edit', `Edited "${before.name}": ${changes}`);

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: updated }) };
  }

  if (method === 'DELETE') {
    const id = event.queryStringParameters && event.queryStringParameters.id;
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Missing id query parameter' }) };

    const items = await getItems();
    const index = items.findIndex((i) => i.id === id);
    if (index === -1) return { statusCode: 404, body: JSON.stringify({ error: 'Item not found' }) };
    if (items[index].quantityOnLoan > 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `"${items[index].name}" still has ${items[index].quantityOnLoan} unit(s) on loan — get them returned first` }),
      };
    }

    const [removed] = items.splice(index, 1);
    await saveItems(items);
    await Promise.all(IMAGE_FIELDS.map((field) => deleteImage(removed[field])));
    await audit(event, 'item.delete', `Deleted item "${removed.name}" (had ${removed.quantity} ${removed.unit || 'pcs'})`);

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: removed }) };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
