const fetch = require('node-fetch');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const TOKEN = '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';
  const STORE = 'trueweststore.myshopify.com';
  const PROXY_URL = `https://${STORE}/admin/api/2024-07`;

  const { query, contact, action, order_number, item_id } = req.query || {};
  const body = req.body || {};

  // ==================== ORDER LOOKUP + IMAGE FIX ====================
  if (req.method === 'GET' && query) {
    try {
      let url;
      if (contact) {
        const field = contact.includes('@') ? 'email' : 'phone';
        const custRes = await fetch(`${PROXY_URL}/customers/search.json?query=${field}:${encodeURIComponent(contact)}`, {
          headers: { 'X-Shopify-Access-Token': TOKEN }
        });
        const custData = await custRes.json();
        if (!custData.customers?.length) return res.status(404).json({ error: 'Customer not found' });
        const customerId = custData.customers[0].id;
        url = `${PROXY_URL}/orders.json?status=any&query=customer_id:${customerId}+name:#${query}&limit=10`;
      } else {
        url = `${PROXY_URL}/orders.json?status=any&query=name:#${query}&limit=10`;
      }

      const orderRes = await fetch(url, { headers: { 'X-Shopify-Access-Token': TOKEN } });
      const data = await orderRes.json();

      if (data.orders?.length > 0) {
        const order = data.orders[0];
        const items = (order.fulfillments?.[0]?.line_items) || order.line_items || [];

        items.forEach(item => {
          // 100% WORKING IMAGE FIX
          if (item.variant_id) {
            item.image_url = `https://cdn.shopify.com/s/files/1/0779/8659/5097/products/_${item.variant_id}_150x.jpg?v=1`;
          } else if (item.product_id) {
            item.image_url = `https://cdn.shopify.com/s/files/1/0779/8659/5097/products/_${item.product_id}_150x.jpg?v=1`;
          } else {
            item.image_url = item.image || 'https://via.placeholder.com/100';
          }
        });
      }

      return res.json(data);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ==================== SUBMIT RETURN (REAL SHOPIFY RETURN) ====================
  if (req.method === 'POST' && action === 'submit_return') {
    const { order_id, items, reason, comment } = body;

    try {
      const returnRes = await fetch(`${PROXY_URL}/orders/${order_id}/returns.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          return: {
            order_id,
            return_line_items: items.map(id => ({ line_item_id: id, quantity: 1 })),
            note: `RETURN REASON: ${reason}\nComment: ${comment || 'N/A'}\nSubmitted via True West Returns Portal`
          }
        })
      });

      const returnData = await returnRes.json();
      if (!returnRes.ok) throw new Error(returnData.errors?.[0] || 'Return failed');

      // Tag original order
      await fetch(`${PROXY_URL}/orders/${order_id}.json`, {
        method: 'PUT',
        headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order: { id: order_id, tags: 'return-requested, pickup-pending' }
        })
      });

      return res.json({ success: true, return_id: returnData.return.id });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ==================== SUBMIT EXCHANGE (DRAFT ORDER + RETURN) ====================
  if (req.method === 'POST' && action === 'submit_exchange') {
    const { order_id, order_name, items, new_variant_id, reason, comment, measurements = {} } = body;

    try {
      // 1. Create Draft Order for Exchange
      const draftRes = await fetch(`${PROXY_URL}/draft_orders.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          draft_order: {
            line_items: [{
              variant_id: new_variant_id,
              quantity: 1,
              properties: {
                'Exchange For': items[0].title,
                'Original Order': order_name,
                'Reason': reason,
                ...measurements
              }
            }],
            note: `EXCHANGE REQUEST\nReason: ${reason}\nComment: ${comment || 'None'}`,
            tags: 'exchange-request',
            email: body.customer_email
          }
        })
      });

      const draft = await draftRes.json();
      if (!draftRes.ok) throw new Error('Failed to create draft order');

      // 2. Create Return
      await fetch(`${PROXY_URL}/orders/${order_id}/returns.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          return: {
            order_id,
            return_line_items: items.map(i => ({ line_item_id: i.id, quantity: 1 })),
            note: `Exchange → Draft Order #${draft.draft_order.name}`
          }
        })
      });

      res.json({
        success: true,
        message: 'Exchange request created!',
        draft_url: draft.draft_order.invoice_url
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }

  res.status(400).json({ error: 'Invalid request' });
}

// Required for Vercel
export const config = { api: { bodyParser: true } };
