const { requireAdmin } = require('./_shared/store-auth');
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

const REQUIRED_FIELDS = ['name', 'category'];
const MAX_CATEGORY_LENGTH = 60;

function json(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
}

// Admin: replace the category list. body = { categories: [names in order],
// renames: { oldName: newName } }. Items in a renamed category move with it;
// a category that still has items can't be dropped.
async function updateCategories(body) {
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

  if (moved) await saveItems(items);
  await saveCategories(list);
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

  const adminError = requireAdmin(event);
  if (adminError) return adminError;

  if (method === 'POST' && event.queryStringParameters && event.queryStringParameters.action === 'categories') {
    let body;
    try {
      body = JSON.parse(event.body || '{}') || {};
    } catch {
      return json(400, { error: 'Invalid request body' });
    }
    return updateCategories(body);
  }

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
    try {
      await applyImages(body, newItem, null);
    } catch (err) {
      return { statusCode: 400, body: JSON.stringify({ error: err.message }) };
    }

    items.push(newItem);
    await saveItems(items);

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
    if (updated.quantity < (items[index].quantityOnLoan || 0)) {
      return json(400, {
        error: `${items[index].quantityOnLoan} of "${items[index].name}" are out on loan, so the total can't be set below ${items[index].quantityOnLoan}`,
      });
    }
    updated.updatedAt = new Date().toISOString();
    let replacedImages;
    try {
      replacedImages = await applyImages(body, updated, items[index]);
    } catch (err) {
      return { statusCode: 400, body: JSON.stringify({ error: err.message }) };
    }
    items[index] = updated;
    await saveItems(items);
    await Promise.all(replacedImages.map(deleteImage));

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

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: removed }) };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
