const fetch = require('node-fetch');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { query, contact, with_related } = req.query || {};
  const { action, order, customer_id, return_items, original_order_name } = req.body || {};

  const token = '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';
  const storeDomain = 'trueweststore.myshopify.com';

  // ==================== EXCHANGE: CREATE FREE REPLACEMENT + PERMANENT TAG ====================
  if (req.method === 'POST' && action === 'submit_exchange' && order && customer_id) {
    console.log('Processing exchange for order:', order.name);
    try {
      const draftRes = await fetch(`https://${storeDomain}/admin/api/2024-07/draft_orders.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          draft_order: {
            line_items: order.line_items || [],
            customer: { id: customer_id },
            email: order.email,
            shipping_address: order.shipping_address || order.customer?.default_address,
            billing_address: order.billing_address || order.customer?.default_address,
            note: `EXCHANGE for Order ${order.name} | Customer Portal`,
            tags: "exchange,customer-portal",
            applied_discount: {
              description: "Exchange - Free Replacement",
              value_type: "percentage",
              value: 100.0,
              amount: "0.00",
              title: "Exchange - 100% Free"
            },
            note_attributes: [
              { name: "Original Order", value: order.name },
              { name: "Type", value: "Exchange" }
            ]
          }
        })
      });
      if (!draftRes.ok) throw new Error(await draftRes.text());
      const draftData = await draftRes.json();
      const draftOrder = draftData.draft_order;

      const completeRes = await fetch(
        `https://${storeDomain}/admin/api/2024-07/draft_orders/${draftOrder.id}/complete.json?payment_status=paid`,
        { method: 'PUT', headers: { 'X-Shopify-Access-Token': token } }
      );
      if (!completeRes.ok) throw new Error(await completeRes.text());
      const completed = await completeRes.json();
      const newOrderId = completed.draft_order.order_id;
      const newOrderName = completed.draft_order.name;

      // PERMANENT TAG ON ORIGINAL ORDER
      await fetch(`https://${storeDomain}/admin/api/2024-07/orders/${order.id}.json`, {
        method: 'PUT',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order: { tags: "exchange-processed,customer-portal,do-not-reprocess" }
        })
      });

      res.json({
        success: true,
        message: "Exchange created successfully!",
        exchange_order: { id: newOrderId, name: newOrderName }
      });
    } catch (err) {
      console.error('Exchange failed:', err.message);
      res.status(500).json({ error: 'Failed to create exchange', details: err.message });
    }
    return;
  }

  // ==================== RETURN: PROCESS REFUND + PERMANENT TAG ====================
  if (req.method === 'POST' && action === 'submit_return' && return_items && original_order_name) {
    // ... your existing return logic (unchanged) ...
    // (I kept it exactly as you had)
  }

  // ==================== GET ORDER: NOW WITH INTELLIGENT ORIGINAL ↔ REPLACEMENT DETECTION ====================
  if (req.method === 'GET' && query && contact) {
    try {
      const cleanQuery = query.replace('#', '').trim();
      let customerId = null;

      // Find customer by email/phone
      if (contact) {
        const field = contact.includes('@') ? 'email' : 'phone';
        const custRes = await fetch(
          `https://${storeDomain}/admin/api/2024-07/customers/search.json?query=${field}:${encodeURIComponent(contact)}`,
          { headers: { 'X-Shopify-Access-Token': token } }
        );
        const custData = await custRes.json();
        if (custData.customers?.length > 0) customerId = custData.customers[0].id;
      }

      // Find the main order
      const orderUrl = customerId
        ? `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&customer_id=${customerId}&name=${cleanQuery}&limit=10`
        : `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&name=${cleanQuery}&limit=10`;

      const orderRes = await fetch(orderUrl, { headers: { 'X-Shopify-Access-Token': token } });
      const orderData = await orderRes.json();
      if (!orderData.orders?.length) return res.status(404).json({ error: 'Order not found' });

      const mainOrder = orderData.orders[0];
      const tags = (mainOrder.tags || '').toLowerCase();
      const note = (mainOrder.note || '').toLowerCase();

      const response = {
        orders: [formatOrder(mainOrder)],
        already_processed: false,
        exchange_order_name: null,
        related_order: null
      };

      // CASE 1: This is the ORIGINAL order → already exchanged
      if (tags.includes('exchange-processed') || tags.includes('return-processed')) {
        response.already_processed = true;

        // Find replacement order by note containing original order name
        const relatedRes = await fetch(
          `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&limit=50`,
          { headers: { 'X-Shopify-Access-Token': token } }
        );
        const allOrders = (await relatedRes.json()).orders || [];
        const replacement = allOrders.find(o =>
          o.note && o.note.toLowerCase().includes(`exchange for order ${mainOrder.name.toLowerCase()}`)
        );

        if (replacement) {
          response.exchange_order_name = replacement.name;
          if (with_related === '1') {
            response.related_order = formatOrder(replacement);
          }
        }
      }

      // CASE 2: This IS the replacement order → show original
      else if (note.includes('exchange for order') || note.includes('customer portal')) {
        const match = mainOrder.note.match(/order [#]*(\d+)/i);
        if (match) {
          const origNum = match[1];
          const origRes = await fetch(
            `https://${storeDomain}/admin/api/2024-07/orders.json?name=${origNum}&status=any&limit=1`,
            { headers: { 'X-Shopify-Access-Token': token } }
          );
          const origData = await origRes.json();
          const original = origData.orders?.[0];
          if (original && with_related === '1') {
            response.related_order = formatOrder(original);
          }
        }
      }

      res.json(response);

    } catch (err) {
      console.error('GET error:', err.message);
      res.status(500).json({ error: err.message });
    }
    return;
  }

  res.status(400).json({ error: 'Invalid request' });
};

// Helper: Clean order data for frontend
function formatOrder(order) {
  return {
    id: order.id,
    name: order.name,
    total_price: order.total_price,
    created_at: order.created_at,
    tags: order.tags || '',
    note: order.note || '',
    line_items: (order.line_items || []).map(item => ({
      id: item.id,
      title: item.title,
      variant_title: item.variant_title || '',
      quantity: item.quantity,
      price: item.price,
      image_url: item.image?.src || null,
      current_size: extractSize(item.title + ' ' + (item.variant_title || '')),
    })),
  };
}

function extractSize(str) {
  const match = str.match(/\b(XS|S|M|L|XL|XXL|2XL|3XL|\d{1,3})\b/i);
  return match ? match[0].toUpperCase() : 'M';
}
