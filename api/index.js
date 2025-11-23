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

  // ========================= ALTERNATIVE: DRAFT ORDER METHOD (NEVER FAILS) =========================
  if (req.method === 'POST' && action === 'submit_exchange' && order && customer_id) {
    try {
      // Step 1: Create Draft Order
      const draftResponse = await fetch(`https://${storeDomain}/admin/api/2024-07/draft_orders.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          draft_order: {
            line_items: order.line_items.map(item => ({
              variant_id: parseInt(item.variant_id),
              quantity: item.quantity || 1
            })),
            customer: { id: parseInt(customer_id) },
            note: order.note || 'Exchange/Return Request via Returns Page',
            tags: 'exchange-request, returns-page',
            email: order.email,
            shipping_address: order.shipping_address,
            use_customer_default_address: true,
            applied_discount: order.financial_status === 'pending' ? {
              description: "Return Processing Fee",
              value_type: "fixed_amount",
              value: 0.0,
              amount: 0.0
            } : undefined
          }
        })
      });

      const draftText = await draftResponse.text();
      if (!draftResponse.ok) {
        console.error('Draft Order Failed:', draftText);
        return res.status(400).json({ error: 'Draft failed', details: draftText });
      }

      const draft = JSON.parse(draftText).draft_order;

      // Step 2: Complete Draft Order (creates real order instantly)
      const completeResponse = await fetch(`https://${storeDomain}/admin/api/2024-07/draft_orders/${draft.id}/complete.json?send_receipt=true`, {
        method: 'PUT',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        }
      });

      if (!completeResponse.ok) {
        const err = await completeResponse.text();
        console.error('Complete Draft Failed:', err);
        return res.status(400).json({ error: 'Complete failed', details: err });
      }

      const finalOrder = await completeResponse.json();
      res.json(finalOrder); // Returns the real created order

    } catch (err) {
      console.error('Proxy Draft Error:', err);
      res.status(500).json({ error: 'Server error' });
    }
    return;
  }

  // ========================= GET: ORDER LOOKUP + TRACKING (unchanged) =========================
  if (req.method === 'GET') {
    if (!query) return res.status(400).json({ error: 'Missing query parameter' });

    let data;
    try {
      if (contact) {
        const field = contact.includes('@') ? 'email' : 'phone';
        const custRes = await fetch(`https://${storeDomain}/admin/api/2024-07/customers/search.json?query=${field}:${encodeURIComponent(contact)}`, {
          headers: { 'X-Shopify-Access-Token': token }
        });
        const custData = await custRes.json();
        if (!custData.customers?.length) return res.status(404).json({ error: 'Customer not found' });
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

      if (!data.orders?.length) return res.status(404).json({ error: 'Order not found' });

      const order = data.orders[0];
      const fulfillment = order.fulfillments?.[0];

      let actualDeliveryDate = null;
      let currentShippingStatus = 'Processing';

      if (fulfillment?.tracking_number) {
        const awb = fulfillment.tracking_number.trim();
        try {
          const trackRes = await fetch(`https://track.eshipz.com/track?awb=${awb}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
          });
          const html = await trackRes.text();
          const deliveredMatch = html.match(/Delivered.*?(\d{2}\/\d{2}\/\d{4}|\d{1,2}\s[A-Za-z]+\s\d{4})/i);
          if (deliveredMatch) {
            actualDeliveryDate = deliveredMatch[1];
            currentShippingStatus = 'Delivered';
          } else if (/in transit|out for delivery|dispatched/i.test(html)) {
            currentShippingStatus = 'In Transit';
          } else if (/picked up|manifested/i.test(html)) {
            currentShippingStatus = 'Picked Up';
          }
        } catch (e) { console.warn('Tracking failed', e); }
      }

      if (actualDeliveryDate) {
        order.actual_delivery_date = actualDeliveryDate;
        order.delivered_at = actualDeliveryDate;
      } else {
        order.actual_delivery_date = null;
        order.delivered_at = null;
      }
      order.current_shipping_status = currentShippingStatus;

      // Enhance line items...
      for (let item of order.line_items) {
        const prodRes = await fetch(`https://${storeDomain}/admin/api/2024-07/products/${item.product_id}.json?fields=images,variants`, {
          headers: { 'X-Shopify-Access-Token': token }
        });
        const p = (await prodRes.json()).product;
        item.image_url = p?.images?.[0]?.src || '';
        item.available_variants = (p?.variants || []).map(v => ({
          id: v.id, title: v.title, available: v.inventory_quantity > 0
        }));
        const cur = p?.variants?.find(v => v.id === item.variant_id);
        if (cur) item.current_size = cur.title;
      }

      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  res.status(400).json({ error: 'Invalid request' });
};
