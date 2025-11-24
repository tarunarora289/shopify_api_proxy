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
  const { action, order, customer_id } = req.body || {};

  const token = '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';
  const storeDomain = 'trueweststore.myshopify.com';

  // ==================== POST: EXCHANGE SUBMISSION (unchanged) ====================
  if (req.method === 'POST' && action === 'submit_exchange' && order && customer_id) {
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

  // ==================== GET: MAIN LOGIC WITH FULL DETECTION ====================
  if (req.method === 'GET' && query) {
    try {
      const cleanQuery = query.replace('#', '').trim();
      let customerId = null;

      // Step 1: Find customer by email/phone
      if (contact) {
        const contactField = contact.includes('@') ? 'email' : 'phone';
        const customerUrl = `https://${storeDomain}/admin/api/2024-07/customers/search.json?query=${contactField}:${encodeURIComponent(contact)}`;
        const customerResponse = await fetch(customerUrl, { headers: { 'X-Shopify-Access-Token': token } });
        if (!customerResponse.ok) throw new Error(await customerResponse.text());
        const customerData = await customerResponse.json();
        if (customerData.customers.length === 0) return res.status(404).json({ error: 'Customer not found' });
        customerId = customerData.customers[0].id;
      }

      // Step 2: Find the main order
      const ordersUrl = customerId
        ? `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&customer_id=${customerId}&name=${cleanQuery}&limit=10`
        : `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&name=${cleanQuery}&limit=10`;

      const ordersResponse = await fetch(ordersUrl, { headers: { 'X-Shopify-Access-Token': token } });
      if (!ordersResponse.ok) throw new Error(await ordersResponse.text());
      const data = await ordersResponse.json();

      if (!data.orders || data.orders.length === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }

      // Ensure exact match
      const exactOrder = data.orders.find(o => o.name === `#${cleanQuery}` || o.order_number == cleanQuery);
      const mainOrder = exactOrder || data.orders[0];

      // FINAL RESPONSE OBJECT
      const response = {
        orders: [],
        already_processed: false,
        exchange_order_name: null,
        related_order: null
      };

      // ENHANCE MAIN ORDER (your existing logic)
      await enhanceOrder(mainOrder);
      response.orders = [mainOrder];

      const tags = (mainOrder.tags || '').toLowerCase();
      const note = (mainOrder.note || '').toLowerCase();

      // CASE 1: ORIGINAL ORDER — already exchanged
      if (tags.includes('exchange-processed') || tags.includes('return-processed')) {
        response.already_processed = true;

        const allOrdersRes = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json?status=any&limit=50`, {
          headers: { 'X-Shopify-Access-Token': token }
        });
        const allOrders = (await allOrdersRes.json()).orders || [];

        const replacement = allOrders.find(o =>
          o.note && o.note.toLowerCase().includes(`exchange for order ${mainOrder.name.toLowerCase()}`)
        );

        if (replacement) {
          response.exchange_order_name = replacement.name;
          if (with_related === '1') {
            await enhanceOrder(replacement);
            response.related_order = replacement;
          }
        }
      }

      // CASE 2: THIS IS THE REPLACEMENT ORDER
      else if (note.includes('exchange for order') || note.includes('customer portal')) {
        const match = mainOrder.note.match(/order [#]*(\d+)/i);
        if (match) {
          const origNum = match[1];
          const origRes = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json?name=${origNum}&status=any&limit=1`, {
            headers: { 'X-Shopify-Access-Token': token }
          });
          const origData = await origRes.json();
          const original = origData.orders?.[0];
          if (original && with_related === '1') {
            await enhanceOrder(original);
            response.related_order = original;
          }
        }
      }

      res.json(response);

    } catch (err) {
      console.error('Proxy error:', err.message);
      res.status(500).json({ error: 'Server error', details: err.message });
    }
    return;
  }

  res.status(400).json({ error: 'Invalid request' });
};

// ==================== ENHANCE ORDER: All your existing magic ====================
async function enhanceOrder(order) {
  const fulfillment = order.fulfillments?.[0] || {};

  // eShipz Tracking Logic (unchanged)
  let actualDeliveryDate = null;
  let currentShippingStatus = 'Processing';
  if (fulfillment.tracking_number) {
    const awb = fulfillment.tracking_number.trim();
    try {
      const trackRes = await fetch(`https://track.eshipz.com/track?awb=${awb}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 10000
      });
      const html = await trackRes.text();
      if (html.toLowerCase().includes('delivered')) {
        const patterns = [/Delivered.*?(\d{2}\/\d{2}\/\d{4})/i, /Delivered on.*?(\d{2}\/\d{2}\/\d{4})/i, /(\d{4}-\d{2}-\d{2})/];
        for (const p of patterns) {
          const m = html.match(p);
          if (m) { actualDeliveryDate = m[1]; currentShippingStatus = 'Delivered'; break; }
        }
        if (!actualDeliveryDate) currentShippingStatus = 'In Transit';
      } else if (html.toLowerCase().includes('in transit') || html.includes('out for delivery')) {
        currentShippingStatus = 'In Transit';
      } else if (html.toLowerCase().includes('picked up')) {
        currentShippingStatus = 'Picked Up';
      }
    } catch (e) {
      currentShippingStatus = 'Unknown';
    }
  }

  order.actual_delivery_date = actualDeliveryDate || null;
  order.delivered_at = actualDeliveryDate || null;
  order.current_shipping_status = currentShippingStatus;

  // Estimated delivery
  const created = new Date(order.created_at);
  const min = new Date(created); min.setDate(created.getDate() + 5);
  const max = new Date(created); max.setDate(created.getDate() + 7);
  order.estimated_delivery = { min: min.toISOString().split('T')[0], max: max.toISOString().split('T')[0] };

  // Enhance line items
  for (let item of order.line_items) {
    try {
      const prodRes = await fetch(
        `https://${storeDomain}/admin/api/2024-07/products/${item.product_id}.json?fields=id,title,images,variants`,
        { headers: { 'X-Shopify-Access-Token': token } }
      );
      const prod = (await prodRes.json()).product;
      item.image_url = prod.images?.[0]?.src || null;
      item.available_variants = (prod.variants || []).map(v => ({
        id: v.id, title: v.title, inventory_quantity: v.inventory_quantity, available: v.inventory_quantity > 0
      }));
      const variant = prod.variants.find(v => v.id === item.variant_id);
      if (variant) {
        item.current_size = variant.title;
        item.current_inventory = variant.inventory_quantity;
      }
    } catch (e) { /* skip */ }
  }
}
