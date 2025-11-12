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
    console.log('Processing exchange submission for customer_id:', customer_id);
    try {
      const response = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
          'User-Agent': 'Grok-Proxy/1.0 (xai.com)'
        },
        body: JSON.stringify(order)
      });
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      res.json(data);
    } catch (err) {
      console.error('Proxy error (POST):', err.message);
      res.status(500).json({ error: 'Proxy failed (POST): ' + err.message });
    }
    return;
  }

  /* ------------------- GET – Order Lookup (original logic) ------------------- */
  if (req.method === 'GET' && query) {
    if (!query) {
      return res.status(400).json({ error: 'Missing query parameter (order number)' });
    }
    let data;
    try {
      // ---- WITH CONTACT ----
      if (contact) {
        const contactField = contact.includes('@') ? 'email' : 'phone';
        const customerUrl = `https://${storeDomain}/admin/api/2024-07/customers/search.json?query=${contactField}:${encodeURIComponent(contact)}`;
        console.log('Fetching customers URL:', customerUrl);
        const customerResponse = await fetch(customerUrl, {
          headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json',
            'User-Agent': 'Grok-Proxy/1.0 (xai.com)'
          }
        });
        if (!customerResponse.ok) throw new Error(await customerResponse.text());
        const customerData = await customerResponse.json();
        if (customerData.customers.length === 0) {
          return res.status(404).json({ error: 'Customer not found with provided contact' });
        }
        const customerId = customerData.customers[0].id;
        console.log('Found customer ID:', customerId);
        const ordersQuery = `customer_id:${customerId} name:#${encodeURIComponent(query)}`;
        const ordersUrl = `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&query=${encodeURIComponent(ordersQuery)}&limit=10`;
        console.log('Fetching orders URL:', ordersUrl);
        const ordersResponse = await fetch(ordersUrl, {
          headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json',
            'User-Agent': 'Grok-Proxy/1.0 (xai.com)'
          }
        });
        if (!ordersResponse.ok) throw new Error(await ordersResponse.text());
        data = await ordersResponse.json();

        // ---- ATTACH IMAGE (safe) ----
        if (data.orders && data.orders.length > 0) {
          const order = data.orders[0];
          if (order.fulfillments && order.fulfillments.length > 0) {
            const lineItems = order.fulfillments[0].line_items;
            for (let item of lineItems) {
              if (!item.product_id) {
                item.image_url = 'https://via.placeholder.com/100';
                continue;
              }
              try {
                const productUrl = `https://${storeDomain}/admin/api/2024-07/products/${item.product_id}.json?fields=images`;
                const productResponse = await fetch(productUrl, {
                  headers: {
                    'X-Shopify-Access-Token': token,
                    'Content-Type': 'application/json',
                    'User-Agent': 'Grok-Proxy/1.0 (xai.com)'
                  }
                });
                if (productResponse.ok) {
                  const productData = await productResponse.json();
                  item.image_url = productData.product?.images?.[0]?.src || item.image || 'https://via.placeholder.com/100';
                } else {
                  item.image_url = item.image || 'https://via.placeholder.com/100';
                }
              } catch (imgErr) {
                console.warn(`Image fetch failed for product ${item.product_id}:`, imgErr.message);
                item.image_url = item.image || 'https://via.placeholder.com/100';
              }
            }
          }
        }
      }
      // ---- WITHOUT CONTACT ----
      else {
        const apiUrl = `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&query=name:#${encodeURIComponent(query)}&limit=10`;
        console.log('Fetching URL:', apiUrl);
        const response = await fetch(apiUrl, {
          headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json',
            'User-Agent': 'Grok-Proxy/1.0 (xai.com)'
          }
        });
        if (!response.ok) throw new Error(await response.text());
        data = await response.json();

        // ---- ATTACH IMAGE (safe) ----
        if (data.orders && data.orders.length > 0) {
          const order = data.orders[0];
          if (order.fulfillments && order.fulfillments.length > 0) {
            const lineItems = order.fulfillments[0].line_items;
            for (let item of lineItems) {
              if (!item.product_id) {
                item.image_url = 'https://via.placeholder.com/100';
                continue;
              }
              try {
                const productUrl = `https://${storeDomain}/admin/api/2024-07/products/${item.product_id}.json?fields=images`;
                const productResponse = await fetch(productUrl, {
                  headers: {
                    'X-Shopify-Access-Token':
