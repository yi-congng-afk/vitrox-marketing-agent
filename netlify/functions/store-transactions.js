const { getItems, saveItems, getTransactions, saveTransactions, genId } = require('./_shared/store-blobs');

exports.handler = async (event) => {
  const method = event.httpMethod;

  if (method === 'GET') {
    const itemId = event.queryStringParameters && event.queryStringParameters.itemId;
    let transactions = await getTransactions();
    if (itemId) transactions = transactions.filter((t) => t.itemId === itemId);
    transactions = transactions.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions }),
    };
  }

  if (method === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { itemId, type, quantity, name, employeeNo, remarks } = body;

    if (!itemId || !['add', 'remove'].includes(type)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'itemId and a valid type (add/remove) are required' }) };
    }
    const qty = Math.round(Number(quantity));
    if (!qty || qty <= 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'quantity must be a positive number' }) };
    }
    if (!name || !String(name).trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Employee name is required' }) };
    }
    if (!employeeNo || !String(employeeNo).trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Employee number is required' }) };
    }
    if (type === 'remove' && (!remarks || !String(remarks).trim())) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Remarks (purpose) is required when moving out stock' }) };
    }

    const items = await getItems();
    const item = items.find((i) => i.id === itemId);
    if (!item) return { statusCode: 404, body: JSON.stringify({ error: 'Item not found' }) };

    const quantityBefore = item.quantity;
    if (type === 'remove' && qty > quantityBefore) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `Cannot move out ${qty} — only ${quantityBefore} in stock` }),
      };
    }

    item.quantity = type === 'add' ? quantityBefore + qty : quantityBefore - qty;
    item.updatedAt = new Date().toISOString();
    await saveItems(items);

    const transaction = {
      id: genId('txn'),
      itemId,
      itemName: item.name,
      type,
      quantity: qty,
      quantityBefore,
      quantityAfter: item.quantity,
      name: String(name).trim(),
      employeeNo: String(employeeNo).trim(),
      remarks: remarks ? String(remarks).trim() : '',
      timestamp: new Date().toISOString(),
    };

    const transactions = await getTransactions();
    transactions.push(transaction);
    await saveTransactions(transactions);

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item, transaction }),
    };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
