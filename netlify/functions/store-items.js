const { requireAdmin } = require('./_shared/store-auth');
const { CATEGORIES, getItems, saveItems, genId } = require('./_shared/store-blobs');

const REQUIRED_FIELDS = ['name', 'category'];

function sanitizeItem(input, existing) {
  const item = existing ? { ...existing } : {};
  if (typeof input.name === 'string') item.name = input.name.trim();
  if (typeof input.category === 'string') item.category = input.category;
  if (typeof input.unit === 'string') item.unit = input.unit.trim() || 'pcs';
  if (input.quantity !== undefined) item.quantity = Math.max(0, Math.round(Number(input.quantity)) || 0);
  if (input.lowStockThreshold !== undefined) {
    item.lowStockThreshold = Math.max(0, Math.round(Number(input.lowStockThreshold)) || 0);
  }
  if (input.itemImage !== undefined) item.itemImage = input.itemImage || null;
  if (input.locationImage !== undefined) item.locationImage = input.locationImage || null;
  if (typeof input.locationText === 'string') item.locationText = input.locationText.trim();
  if (typeof input.notes === 'string') item.notes = input.notes.trim();
  return item;
}

exports.handler = async (event) => {
  const method = event.httpMethod;

  if (method === 'GET') {
    const items = await getItems();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, categories: CATEGORIES }),
    };
  }

  const adminError = requireAdmin(event);
  if (adminError) return adminError;

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
    updated.updatedAt = new Date().toISOString();
    items[index] = updated;
    await saveItems(items);

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: updated }) };
  }

  if (method === 'DELETE') {
    const id = event.queryStringParameters && event.queryStringParameters.id;
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Missing id query parameter' }) };

    const items = await getItems();
    const index = items.findIndex((i) => i.id === id);
    if (index === -1) return { statusCode: 404, body: JSON.stringify({ error: 'Item not found' }) };

    const [removed] = items.splice(index, 1);
    await saveItems(items);

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: removed }) };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
