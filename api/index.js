const fetch = require('node-fetch');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { query, contact } = req.query || {};
  const { action, order, customer_id } = req.body || {};
  const token = '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';
  const storeDomain = 'trueweststore.myshopify.com';

  // POST — Exchange/Return Order Creation
  if (req.method === 'POST' && action === 'submit_exchange' && order && customer_id) {
    try {
      const response = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(order)
      });
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      res.json(data);
    } catch (err) {
      console.error('POST Error:', err.message);
      res.status(500).json({ error: 'Failed to create order' });
    }
    return;
  }

  // GET — Order Lookup + Smart Bluedart Tracking
  if (req.method === 'GET') {
    if (!query) return res.status(400).json({ error: 'Missing query parameter' });

    let data;
    try {
      // Step 1: Find order by number + optional email/phone
      if (contact) {
        const field = contact.includes('@') ? 'email' : 'phone';
        const custRes = await fetch(`https://${storeDomain}/admin/api/2024-07/customers/search.json?query=${field}:${encodeURIComponent(contact)}`, {
          headers: { 'X-Shopify-Access-Token': token }
        });
        const custData = await custRes.json();
        if (custData.customers.length === 0) return res.status(404).json({ error: 'Customer not found' });
        const cid = custData.customers[0].id;
        const ordRes = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json?status=any&customer_id=${cid}&name=#${query}&limit=1`, {
          headers: { 'X-Shopify-Access-Token': token }
        });
        data = await ordRes.json();
      } else {
        const ordRes = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json?status=any&name=#${query}&limit=1`, {
          headers: { 'X-Shopify-Access-Token': token }
        });
        data = await ordRes.json();
      }

      if (!data.orders || data.orders.length === 0) return res.status(404).json({ error: 'Order not found' });

      const order = data.orders[0];
      const fulfillment = order.fulfillments?.[0];

      // Step 2: Smart eShipz (Bluedart) tracking — ONLY mark as Delivered if real delivery date exists
      let actualDeliveryDate = null;
      let currentShippingStatus = 'Processing';

      if (fulfillment?.tracking_number) {
        const awb = fulfillment.tracking_number.trim();
        try {
          const trackRes = await fetch(`https://track.eshipz.com/track?awb=${awb}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 10000
          });
          const html = await trackRes.text();

          let isActuallyDelivered = false;

          // Look for "Delivered" + real date
          if (/delivered/i.test(html)) {
            const patterns = [
              /Delivered.*?(\d{2}\/\d{2}\/\d{4})/i,
              /Delivered on.*?(\d{2}\/\d{2}\/\d{4})/i,
              /Delivered.*?(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i,
              /Delivered.*?(\d{4}-\d{2}-\d{2})/i
            ];

            for (const p of patterns) {
              const m = html.match(p);
              if (m) {
                actualDeliveryDate = m[1];
                isActuallyDelivered = true;
                break;
              }
            }
          }

          // Final status decision
          if (isActuallyDelivered) {
            currentShippingStatus = 'Delivered';
          } else if (/(in transit|out for delivery|dispatched|shipped)/i.test(html)) {
            currentShippingStatus = 'In Transit';
          } else if (/(picked up|manifested|pickup)/i.test(html)) {
            currentShippingStatus = 'Picked Up';
          } else {
            currentShippingStatus = 'Processing';
          }

        } catch (e) {
          console.warn(`eShipz failed for AWB ${awb}:`, e.message);
          currentShippingStatus = 'Unknown';
        }
      }

      // Attach ONLY if truly delivered
      if (actualDeliveryDate) {
        order.actual_delivery_date = actualDeliveryDate;
        order.delivered_at = actualDeliveryDate;
      } else {
        order.actual_delivery_date = null;
        order.delivered_at = null;
      }

      order.current_shipping_status = currentShippingStatus;

      // Estimated delivery (optional)
      const created = new Date(order.created_at);
      const min = new Date(created); min.setDate(created.getDate() + 5);
      const max = new Date(created); max.setDate(created.getDate() + 7);
      order.estimated_delivery = { min: min.toISOString().split('T')[0], max: max.toISOString().split('T')[0] };

      // Enhance line items
      for (let item of order.line_items) {
        const prodRes = await fetch(`https://${storeDomain}/admin/api/2024-07/products/${item.product_id}.json?fields=images,variants`, {
          headers: { 'X-Shopify-Access-Token': token }
        });
        const prodData = await prodRes.json();
        const p = prodData.product;
        item.image_url = p?.images?.[0]?.src || '';
        item.available_variants = (p?.variants || []).map(v => ({
          id: v.id,
          title: v.title,
          available: v.inventory_quantity > 0
        }));
        const curVar = p?.variants?.find(v => v.id === item.variant_id);
        if (curVar) item.current_size = curVar.title;
      }

      res.json(data);

    } catch (err) {
      console.error('Proxy error:', err.message);
      res.status(500).json({ error: err.message });
    }
    return;
  }

  res.status(400).json({ error: 'Invalid request' });
};
