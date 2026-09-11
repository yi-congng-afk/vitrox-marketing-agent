const { getItems, saveItems, getTransactions, saveTransactions, genId } = require('./_shared/store-blobs');
const { sendAlertEmail } = require('./_shared/mailer');
const { requireAdmin } = require('./_shared/store-auth');

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

    const justCrossedLowStock =
      type === 'remove' && quantityBefore > item.lowStockThreshold && item.quantity <= item.lowStockThreshold;
    if (justCrossedLowStock) {
      await sendAlertEmail(
        `[ViTrox Store] Low stock: ${item.name}`,
        `"${item.name}" has dropped to ${item.quantity} ${item.unit || 'pcs'}, at or below its low-stock threshold of ${item.lowStockThreshold}.\n\n` +
          `Moved out by ${transaction.name} (${transaction.employeeNo})\nPurpose: ${transaction.remarks}\nWhen: ${transaction.timestamp}`
      );
    }

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item, transaction }),
    };
  }

  if (method === 'PATCH') {
    const adminError = requireAdmin(event);
    if (adminError) return adminError;

    const id = event.queryStringParameters && event.queryStringParameters.id;
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Missing id query parameter' }) };

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const transactions = await getTransactions();
    const index = transactions.findIndex((t) => t.id === id);
    if (index === -1) return { statusCode: 404, body: JSON.stringify({ error: 'Transaction not found' }) };

    const original = transactions[index];
    const newType = ['add', 'remove'].includes(body.type) ? body.type : original.type;
    const newQuantity = body.quantity !== undefined ? Math.round(Number(body.quantity)) : original.quantity;
    if (!newQuantity || newQuantity <= 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'quantity must be a positive number' }) };
    }
    const newName = body.name !== undefined ? String(body.name).trim() : original.name;
    const newEmployeeNo = body.employeeNo !== undefined ? String(body.employeeNo).trim() : original.employeeNo;
    const newRemarks = body.remarks !== undefined ? String(body.remarks).trim() : original.remarks;
    if (!newName) return { statusCode: 400, body: JSON.stringify({ error: 'Employee name is required' }) };
    if (!newEmployeeNo) return { statusCode: 400, body: JSON.stringify({ error: 'Employee number is required' }) };
    if (newType === 'remove' && !newRemarks) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Remarks (purpose) is required for move-out records' }) };
    }

    const items = await getItems();
    const item = items.find((i) => i.id === original.itemId);

    let quantityBefore = original.quantityBefore;
    let quantityAfter = original.quantityAfter;

    if (item) {
      const withOriginalReversed = original.type === 'add' ? item.quantity - original.quantity : item.quantity + original.quantity;
      const recomputed = newType === 'add' ? withOriginalReversed + newQuantity : withOriginalReversed - newQuantity;
      if (recomputed < 0) {
        return { statusCode: 400, body: JSON.stringify({ error: `That edit would bring "${item.name}" below 0 in stock` }) };
      }
      quantityBefore = withOriginalReversed;
      quantityAfter = recomputed;
      item.quantity = recomputed;
      item.updatedAt = new Date().toISOString();
      await saveItems(items);
    }

    transactions[index] = {
      ...original,
      type: newType,
      quantity: newQuantity,
      quantityBefore,
      quantityAfter,
      name: newName,
      employeeNo: newEmployeeNo,
      remarks: newRemarks,
      editedAt: new Date().toISOString(),
    };
    await saveTransactions(transactions);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: transactions[index], item }),
    };
  }

  if (method === 'DELETE') {
    const adminError = requireAdmin(event);
    if (adminError) return adminError;

    const id = event.queryStringParameters && event.queryStringParameters.id;
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Missing id query parameter' }) };

    const transactions = await getTransactions();
    const index = transactions.findIndex((t) => t.id === id);
    if (index === -1) return { statusCode: 404, body: JSON.stringify({ error: 'Transaction not found' }) };

    const original = transactions[index];
    const items = await getItems();
    const item = items.find((i) => i.id === original.itemId);

    if (item) {
      const reversed = original.type === 'add' ? item.quantity - original.quantity : item.quantity + original.quantity;
      if (reversed < 0) {
        return { statusCode: 400, body: JSON.stringify({ error: `Deleting this record would bring "${item.name}" below 0 in stock` }) };
      }
      item.quantity = reversed;
      item.updatedAt = new Date().toISOString();
      await saveItems(items);
    }

    const [removed] = transactions.splice(index, 1);
    await saveTransactions(transactions);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: removed, item }),
    };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
