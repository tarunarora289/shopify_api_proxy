const fetch = require('node-fetch');

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { query, contact, action, order_number, item_id } = req.query || {};
  const { action: bodyAction, order, customer_id } = req.body || {};

  const token = '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';
  const storeDomain = 'trueweststore.myshopify.com';

  /* ------------------- POST – Submit Exchange ------------------- */
  if (req.method === 'POST' && bodyAction === 'submit_exchange' && order && customer_id) {
    console.log('Processing exchange for customer_id:', customer_id);
    try {
      const resp = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
          'User-Agent': 'Grok-Proxy/1.0 (xai.com)'
        },
        body: JSON.stringify(order)
      });
      if (!resp.ok) throw new Error(await resp.text());
      res.json(await resp.json());
    } catch (e) {
      console.error('POST error:', e.message);
      res.status(500).json({ error: 'POST failed: ' + e.message });
    }
    return;
  }

  /* ------------------- GET – Order Lookup + Images ------------------- */
  if (req.method === 'GET' && query) {
    if (!query) return res.status(400).json({ error: 'Missing query' });

    let data;
    try {
      // ---- 1. Find customer (if contact supplied) ----
      if (contact) {
        const field = contact.includes('@') ? 'email' : 'phone';
        const custUrl = `https://${storeDomain}/admin/api/2024-07/customers/search.json?query=${field}:${encodeURIComponent(contact)}`;
        const custRes = await fetch(custUrl, { headers: { 'X-Shopify-Access-Token': token, 'User-Agent': 'Grok-Proxy/1.0' } });
        if (!custRes.ok) throw new Error(await custRes.text());
        const cust = await custRes.json();
        if (!cust.customers.length) return res.status(404).json({ error: 'Customer not found' });

        const custId = cust.customers[0].id;
        const ordersUrl = `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&query=customer_id:${custId} name:#${encodeURIComponent(query)}&limit=10`;
        const ordRes = await fetch(ordersUrl, { headers: { 'X-Shopify-Access-Token': token, 'User-Agent': 'Grok-Proxy/1.0' } });
        if (!ordRes.ok) throw new Error(await ordRes.text());
        data = await ordRes.json();
      } else {
        const apiUrl = `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&query=name:#${encodeURIComponent(query)}&limit=10`;
        const resp = await fetch(apiUrl, { headers: { 'X-Shopify-Access-Token': token, 'User-Agent': 'Grok-Proxy/1.0' } });
        if (!resp.ok) throw new Error(await resp.text());
        data = await resp.json();
      }

      // ---- 2. Attach image_url to line items (both branches) ----
      const attachImages = async (order) => {
        const items = (order.fulfillments?.[0]?.line_items) || order.line_items || [];
        for (const itm of items) {
          if (!itm.product_id) {
            itm.image_url = 'https://via.placeholder.com/100';
            continue;
          }
          try {
            const prodUrl = `https://${storeDomain}/admin/api/2024-07/products/${itm.product_id}.json?fields=images`;
            const prodRes = await fetch(prodUrl, { headers: { 'X-Shopify-Access-Token': token, 'User-Agent': 'Grok-Proxy/1.0' } });
            if (prodRes.ok) {
              const p = await prodRes.json();
              itm.image_url = p.product?.images?.[0]?.src || itm.image || 'https://via.placeholder.com/100';
            } else {
              itm.image_url = itm.image || 'https://via.placeholder.com/100';
            }
          } catch (e) {
            console.warn(`Image fetch failed for ${itm.product_id}:`, e.message);
            itm.image_url = itm.image || 'https://via.placeholder.com/100';
          }
        }
      };

      if (data.orders?.length) await attachImages(data.orders[0]);

      res.json(data);
    } catch (e) {
      console.error('GET error:', e.message);
      res.status(500).json({ error: 'GET failed: ' + e.message });
    }
    return;
  }

  /* ------------------- GET – Available Sizes (for exchange) ------------------- */
  if (req.method === 'GET' && action === 'get_available_sizes' && order_number && contact && item_id) {
    try {
      // 1. Find customer
      const field = contact.includes('@') ? 'email' : 'phone';
      const custUrl = `https://${storeDomain}/admin/api/2024-07/customers/search.json?query=${field}:${encodeURIComponent(contact)}`;
      const custRes = await fetch(custUrl, { headers: { 'X-Shopify-Access-Token': token } });
      if (!custRes.ok) throw new Error(await custRes.text());
      const cust = await custRes.json();
      if (!cust.customers.length) return res.status(404).json({ error: 'Customer not found' });

      const custId = cust.customers[0].id;

      // 2. Find order
      const ordUrl = `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&query=customer_id:${custId} name:#${encodeURIComponent(order_number)}&limit=1`;
      const ordRes = await fetch(ordUrl, { headers: { 'X-Shopify-Access-Token': token } });
      if (!ordRes.ok) throw new Error(await ordRes.text());
      const ord = await ordRes.json();
      if (!ord.orders?.length) return res.status(404).json({ error: 'Order not found' });

      const lineItem = (ord.orders[0].fulfillments?.[0]?.line_items || ord.orders[0].line_items || [])
        .find(i => i.id === parseInt(item_id));
      if (!lineItem) return res.status(404).json({ error: 'Item not found' });

      // 3. Get variants + inventory
      const prodUrl = `https://${storeDomain}/admin/api/2024-07/products/${lineItem.product_id}.json?fields=variants`;
      const prodRes = await fetch(prodUrl, { headers: { 'X-Shopify-Access-Token': token } });
      if (!prodRes.ok) throw new Error(await prodRes.text());
      const prod = await prodRes.json();

      const sizes = (prod.product?.variants || []).map(v => ({
        size: v.option1 || v.title,
        available: (v.inventory_quantity || 0) > 0
      })).filter(s => s.size);

      res.json({ available_sizes: sizes });
    } catch (e) {
      console.error('Sizes error:', e.message);
      res.status(500).json({ error: 'Sizes failed: ' + e.message });
    }
    return;
  }

  // Fallback
  res.status(400).json({ error: 'Invalid request' });
};
