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

  // POST logic unchanged
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

  if (req.method === 'GET') {
    if (!query) return res.status(400).json({ error: 'Missing query parameter' });
    let data;
    try {
      if (contact) {
        const contactField = contact.includes('@') ? 'email' : 'phone';
        const customerUrl = `https://${storeDomain}/admin/api/2024-07/customers/search.json?query=${contactField}:${encodeURIComponent(contact)}`;
        const customerResponse = await fetch(customerUrl, { headers: { 'X-Shopify-Access-Token': token } });
        if (!customerResponse.ok) throw new Error(await customerResponse.text());
        const customerData = await customerResponse.json();
        if (customerData.customers.length === 0) return res.status(404).json({ error: 'Customer not found' });
        const customerId = customerData.customers[0].id;
        const ordersUrl = `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&customer_id=${customerId}&name=#${query}&limit=1`;
        const ordersResponse = await fetch(ordersUrl, { headers: { 'X-Shopify-Access-Token': token } });
        if (!ordersResponse.ok) throw new Error(await ordersResponse.text());
        data = await ordersResponse.json();
      } else {
        const apiUrl = `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&name=#${query}&limit=1`;
        const response = await fetch(apiUrl, { headers: { 'X-Shopify-Access-Token': token } });
        if (!response.ok) throw new Error(await response.text());
        data = await response.json();
      }

      // ENSURE ONLY ONE ORDER
      if (data.orders && data.orders.length > 0) {
        const cleanQuery = query.replace('#', '');
        const exactOrder = data.orders.find(o => o.name === `#${cleanQuery}` || String(o.order_number) === cleanQuery);
        data.orders = exactOrder ? [exactOrder] : [data.orders[0]];
      } else {
        return res.status(404).json({ error: 'Order not found' });
      }

      const order = data.orders[0];
      const fulfillment = order.fulfillments?.[0];

      // FIXED: Smart eShipz tracking — only set "Delivered" if real delivery date is found
      let actualDeliveryDate = null;
      let currentShippingStatus = 'Processing';

      if (fulfillment?.tracking_number) {
        const awb = fulfillment.tracking_number.trim();
        try {
          const trackUrl = `https://track.eshipz.com/track?awb=${awb}`;
          const trackRes = await fetch(trackUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 10000
          });
          const html = await trackRes.text();

          // Step 1: Check if "Delivered" exists
          if (html.toLowerCase().includes('delivered')) {
            // Step 2: Look for real delivery date
            const patterns = [
              /Delivered.*?(\d{2}\/\d{2}\/\d{4})/i,
              /Delivered on.*?(\d{2}\/\d{2}\/\d{4})/i,
              /Delivered.*?(\d{1,2}\s[A-Za-z]{3,9}\s\d{4})/i,
              /Delivered.*?(\d{4}-\d{2}-\d{2})/i
            ];

            let deliveryMatch = null;
            for (const pattern of patterns) {
              deliveryMatch = html.match(pattern);
              if (deliveryMatch) break;
            }

            if (deliveryMatch) {
              actualDeliveryDate = deliveryMatch[1];
              currentShippingStatus = 'Delivered';
            } else {
              // "Delivered" mentioned but no date → likely in transit
              currentShippingStatus = 'In Transit';
            }
          } else {
            // Not delivered — detect transit status
            if (html.toLowerCase().includes('in transit') || html.includes('out for delivery') || html.includes('dispatched')) {
              currentShippingStatus = 'In Transit';
            } else if (html.toLowerCase().includes('picked up') || html.includes('pickup')) {
              currentShippingStatus = 'Picked Up';
            } else {
              currentShippingStatus = 'Processing';
            }
          }
        } catch (e) {
          console.warn(`eShipz tracking failed for AWB ${awb}:`, e.message);
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

      // Keep estimated delivery (optional)
      const created = new Date(order.created_at);
      const minDelivery = new Date(created);
      minDelivery.setDate(created.getDate() + 5);
      const maxDelivery = new Date(created);
      maxDelivery.setDate(created.getDate() + 7);
      order.estimated_delivery = {
        min: minDelivery.toISOString().split('T')[0],
        max: maxDelivery.toISOString().split('T')[0]
      };

      // ENHANCE LINE ITEMS WITH IMAGE + ALL VARIANTS + INVENTORY
      for (let item of order.line_items) {
        const productRes = await fetch(
          `https://${storeDomain}/admin/api/2024-07/products/${item.product_id}.json?fields=id,title,images,variants`,
          { headers: { 'X-Shopify-Access-Token': token } }
        );
        const productData = await productRes.json();
        const product = productData.product;

        if (product.images && product.images.length > 0) {
          item.image_url = product.images[0].src;
        }

        item.available_variants = product.variants.map(v => ({
          id: v.id,
          title: v.title,
          inventory_quantity: v.inventory_quantity,
          available: v.inventory_quantity > 0
        }));

        const currentVariant = product.variants.find(v => v.id === item.variant_id);
        if (currentVariant) {
          item.current_size = currentVariant.title;
          item.current_inventory = currentVariant.inventory_quantity;
        }
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
