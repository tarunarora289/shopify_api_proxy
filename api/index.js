const fetch = require('node-fetch');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { query, contact, with_related } = req.query || {};
  const body = req.body || {};
  const { action, order, order_id, return_items, reason, customer_id } = body;

  const token = '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';
  const storeDomain = 'trueweststore.myshopify.com';

  // ==================== SUBMIT RETURN ====================
  if (req.method === 'POST' && action === 'submit_return') {
    try {
      const returnRes = await fetch(`https://${storeDomain}/admin/api/2024-07/returns.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          return: {
            order_id: parseInt(order_id),
            notify_customer: true,
            note: `Portal return - ${reason || 'Size/Quality issue'}`,
            refund: true,
            return_line_items: return_items.map(i => ({
              line_item_id: i.line_item_id,
              quantity: i.quantity || 1,
              restock_type: "return"
            }))
          }
        })
      });
      if (!returnRes.ok) throw new Error(await returnRes.text());

      // Tag as processed
      await fetch(`https://${storeDomain}/admin/api/2024-07/orders/${order_id}.json`, {
        method: 'PUT',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: { tags: "return-processed,portal-return" } })
      });

      const amount = return_items.reduce((s, i) => s + (i.price || 0) * (i.quantity || 1), 0).toFixed(2);
      return res.json({ success: true, refund_amount: amount });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ==================== SUBMIT EXCHANGE ====================
  if (req.method === 'POST' && action === 'submit_exchange' && order) {
    try {
      const originalName = order.name || 'unknown';
      const createRes = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order: {
            ...order,
            note: `Exchange for ${originalName} via portal`,
            financial_status: "paid",
            tags: "exchange-order,portal-created"
          }
        })
      });
      if (!createRes.ok) throw new Error(await createRes.text());
      const newOrder = (await createRes.json()).order;

      // Tag original
      const origRes = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json?name=${originalName}`, {
        headers: { 'X-Shopify-Access-Token': token }
      });
      const origData = await origRes.json();
      if (origData.orders?.[0]) {
        await fetch(`https://${storeDomain}/admin/api/2024-07/orders/${origData.orders[0].id}.json`, {
          method: 'PUT',
          headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ order: { tags: "exchange-processed,portal-exchange" } })
        });
      }

      return res.json({ success: true, exchange_order: newOrder });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ==================== GET ORDER - YOUR ORIGINAL LOGIC + FIXED DETECTION ====================
  if (req.method === 'GET' && query) {
    if (!query) return res.status(400).json({ error: 'Missing query' });

    let mainOrder = null;
    let allOrders = [];

    try {
      if (contact) {
        const field = contact.includes('@') ? 'email' : 'phone';
        const custRes = await fetch(`https://${storeDomain}/admin/api/2024-07/customers/search.json?query=${field}:${encodeURIComponent(contact)}`, {
          headers: { 'X-Shopify-Access-Token': token }
        });
        const custData = await custRes.json();
        if (!custData.customers?.length) return res.status(404).json({ error: 'Customer not found' });
        const customerId = custData.customers[0].id;

        const allRes = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json?customer_id=${customerId}&status=any&limit=250`, {
          headers: { 'X-Shopify-Access-Token': token }
        });
        allOrders = (await allRes.json()).orders || [];

        const cleanQuery = query.replace('#', '').trim();
        mainOrder = allOrders.find(o => o.name.includes(cleanQuery) || String(o.order_number) === cleanQuery);
        if (!mainOrder) return res.status(404).json({ error: 'Order not found' });
      } else {
        const apiUrl = `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&name=#${query}&limit=1`;
        const res = await fetch(apiUrl, { headers: { 'X-Shopify-Access-Token': token } });
        const data = await res.json();
        mainOrder = data.orders?.[0];
        if (!mainOrder) return res.status(404).json({ error: 'Order not found' });
      }

      // YOUR ORIGINAL PERFECT ENHANCEMENT LOGIC — NOW RUNS EVERY TIME
      const fulfillment = mainOrder.fulfillments?.[0];
      let actualDeliveryDate = null;
      let currentShippingStatus = 'Processing';

      if (fulfillment?.tracking_number) {
        const awb = fulfillment.tracking_number.trim();
        try {
          const trackRes = await fetch(`https://track.eshipz.com/track?awb=${awb}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 10000
          });
          const html = await trackRes.text();

          if (html.toLowerCase().includes('delivered')) {
            const patterns = [/Delivered.*?(\d{2}\/\d{2}\/\d{4})/i, /Delivered on.*?(\d{2}\/\d{2}\/\d{4})/i, /(\d{4}-\d{2}-\d{2})/i];
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

      if (actualDeliveryDate) {
        mainOrder.actual_delivery_date = actualDeliveryDate;
        mainOrder.delivered_at = actualDeliveryDate;
      } else {
        mainOrder.actual_delivery_date = null;
        mainOrder.delivered_at = null;
      }
      mainOrder.current_shipping_status = currentShippingStatus;

      // Line items enhancement (your original)
      for (let item of mainOrder.line_items) {
        try {
          const prodRes = await fetch(`https://${storeDomain}/admin/api/2024-07/products/${item.product_id}.json?fields=images,variants`, {
            headers: { 'X-Shopify-Access-Token': token }
          });
          const prod = (await prodRes.json()).product;
          item.image_url = prod.images?.[0]?.src || 'https://via.placeholder.com/80';
          item.available_variants = (prod.variants || []).map(v => ({
            id: v.id, title: v.title, available: v.inventory_quantity > 0
          }));
          const v = prod.variants.find(v => v.id === item.variant_id);
          if (v) item.current_size = v.title;
        } catch (e) {
          item.image_url = 'https://via.placeholder.com/80';
          item.current_size = 'Standard';
        }
      }

      const response = {
        orders: [mainOrder],
        already_processed: false,
        exchange_order_name: null,
        related_order: null
      };

      const tags = (mainOrder.tags || '').toLowerCase();
      const note = (mainOrder.note || '').toLowerCase();

      // Detection works for NEW exchanges
      if (tags.includes('exchange-processed') || tags.includes('return-processed')) {
        response.already_processed = true;
        const replacement = allOrders.find(o => o.note && o.note.includes(mainOrder.name));
        if (replacement) {
          response.exchange_order_name = replacement.name;
          response.related_order = replacement;
        }
      } else if (note.includes('exchange for') || note.includes('portal')) {
        const match = note.match(/#(\d+)/i);
        if (match) {
          const original = allOrders.find(o => o.name.includes(match[1]));
          if (original) response.related_order = original;
        }
      }

      res.json(response);

    } catch (err) {
      console.error('GET error:', err.message);
      res.status(500).json({ error: err.message });
    }
  } else {
    res.status(400).json({ error: 'Invalid request' });
  }
};
