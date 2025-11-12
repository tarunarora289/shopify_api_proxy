const fetch = require('node-fetch');

module.exports = async (req, res) => {
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

  // POST: Submit Exchange
  if (req.method === 'POST' && bodyAction === 'submit_exchange' && order && customer_id) {
    try {
      const response = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
          'User-Agent': 'Grok-Proxy/1.0'
        },
        body: JSON.stringify(order)
      });
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      res.json(data);
    } catch (err) {
      console.error('POST Error:', err.message);
      res.status(500).json({ error: 'Submit failed: ' + err.message });
    }
    return;
  }

  // GET: Order Lookup + Image Fetch
  if (req.method === 'GET' && query) {
    let data;
    try {
      if (contact) {
        const contactField = contact.includes('@') ? 'email' : 'phone';
        const customerUrl = `https://${storeDomain}/admin/api/2024-07/customers/search.json?query=${contactField}:${encodeURIComponent(contact)}`;
        const customerRes = await fetch(customerUrl, { headers: { 'X-Shopify-Access-Token': token, 'User-Agent': 'Grok-Proxy/1.0' } });
        if (!customerRes.ok) throw new Error(await customerRes.text());
        const customerData = await customerRes.json();
        if (!customerData.customers.length) return res.status(404).json({ error: 'Customer not found' });

        const customerId = customerData.customers[0].id;
        const ordersUrl = `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&query=customer_id:${customerId} name:#${encodeURIComponent(query)}&limit=1`;
        const ordersRes = await fetch(ordersUrl, { headers: { 'X-Shopify-Access-Token': token, 'User-Agent': 'Grok-Proxy/1.0' } });
        if (!ordersRes.ok) throw new Error(await ordersRes.text());
        data = await ordersRes.json();
      } else {
        const ordersUrl = `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&query=name:#${encodeURIComponent(query)}&limit=1`;
        const ordersRes = await fetch(ordersUrl, { headers: { 'X-Shopify-Access-Token': token, 'User-Agent': 'Grok-Proxy/1.0' } });
        if (!ordersRes.ok) throw new Error(await ordersRes.text());
        data = await ordersRes.json();
      }

      // === FIX: Attach Image URL to Line Items ===
      if (data.orders && data.orders.length > 0) {
        const order = data.orders[0];
        const lineItems = (order.fulfillments?.[0]?.line_items) || order.line_items || [];

        for (const item of lineItems) {
          if (item.product_id) {
            try {
              const productUrl = `https://${storeDomain}/admin/api/2024-07/products/${item.product_id}.json?fields=images`;
              const productRes = await fetch(productUrl, {
                headers: { 'X-Shopify-Access-Token': token, 'User-Agent': 'Grok-Proxy/1.0' }
              });

              if (productRes.ok) {
                const productData = await productRes.json();
                const images = productData.product?.images || [];
                // Use first image OR fallback to variant image if exists
                item.image_url = images[0]?.src || item.image || 'https://via.placeholder.com/100';
              } else {
                item.image_url = item.image || 'https://via.placeholder.com/100';
              }
            } catch (imgErr) {
              console.warn(`Image fetch failed for product ${item.product_id}:`, imgErr.message);
              item.image_url = item.image || 'https://via.placeholder.com/100';
            }
          } else {
            item.image_url = 'https://via.placeholder.com/100';
          }
        }
      }

      res.json(data);
    } catch (err) {
      console.error('GET Error:', err.message);
      res.status(500).json({ error: 'Failed: ' + err.message });
    }
    return;
  }

  // GET: Available Sizes (Inventory)
  if (req.method === 'GET' && action === 'get_available_sizes' && order_number && contact && item_id) {
    try {
      const contactField = contact.includes('@') ? 'email' : 'phone';
      const customerUrl = `https://${storeDomain}/admin/api/2024-07/customers/search.json?query=${contactField}:${encodeURIComponent(contact)}`;
      const customerRes = await fetch(customerUrl, { headers: { 'X-Shopify-Access-Token': token } });
      if (!customerRes.ok) throw new Error(await customerRes.text());
      const customerData = await customerRes.json();
      if (!customerData.customers.length) return res.status(404).json({ error: 'Customer not found' });

      const customerId = customerData.customers[0].id;
      const ordersUrl = `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&query=customer_id:${customerId} name:#${encodeURIComponent(order_number)}&limit=1`;
      const ordersRes = await fetch(ordersUrl, { headers: { 'X-Shopify-Access-Token': token } });
      if (!ordersRes.ok) throw new Error(await ordersRes.text());
      const orderData = await ordersRes.json();
      if (!orderData.orders?.length) return res.status(404).json({ error: 'Order not found' });

      const order = orderData.orders[0];
      const lineItem = (order.fulfillments?.[0]?.line_items || order.line_items || [])
        .find(item => item.id === parseInt(item_id));
      if (!lineItem) return res.status(404).json({ error: 'Item not found' });

      const productId = lineItem.product_id;
      const productUrl = `https://${storeDomain}/admin/api/2024-07/products/${productId}.json?fields=variants`;
      const productRes = await fetch(productUrl, { headers: { 'X-Shopify-Access-Token': token } });
      if (!productRes.ok) throw new Error(await productRes.text());
      const productData = await productRes.json();

      const variants = productData.product?.variants || [];
      const availableSizes = variants.map(v => ({
        size: v.option1 || v.title,
        available: (v.inventory_quantity || 0) > 0
      })).filter(s => s.size);

      res.json({ available_sizes: availableSizes });
    } catch (err) {
      console.error('Sizes Error:', err.message);
      res.status(500).json({ error: 'Sizes failed: ' + err.message });
    }
    return;
  }

  res.status(400).json({ error: 'Invalid request' });
};
