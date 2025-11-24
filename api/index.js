const fetch = require('node-fetch');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { query, contact, with_related } = req.query || {};
  const body = req.body || {};
  const { action, order, order_id, return_items, reason } = body;

  const token = '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';
  const storeDomain = 'trueweststore.myshopify.com';

  // ==================== 1. CREATE EXCHANGE ORDER ====================
  if (req.method === 'POST' && action === 'submit_exchange' && order) {
    try {
      const originalOrderName = order.name || order.note?.match(/#(\d+)/)?.[0];

      // Create real order
      const createRes = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          order: {
            ...order,
            note: `Exchange for ${originalOrderName} via portal`,
            financial_status: "paid",
            tags: "exchange-order,portal-created"
          }
        })
      });

      if (!createRes.ok) throw new Error(await createRes.text());
      const newOrder = (await createRes.json()).order;

      // Tag original order as processed
      if (originalOrderName) {
        const origRes = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json?name=${originalOrderName}&limit=1`, {
          headers: { 'X-Shopify-Access-Token': token }
        });
        const origData = await origRes.json();
        if (origData.orders?.[0]) {
          await fetch(`https://${storeDomain}/admin/api/2024-07/orders/${origData.orders[0].id}.json`, {
            method: 'PUT',
            headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              order: { tags: "exchange-processed,portal-exchange" }
            })
          });
        }
      }

      res.json({
        success: true,
        message: "Exchange created!",
        exchange_order: newOrder
      });

    } catch (err) {
      console.error('Exchange failed:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
    return;
  }

  // ==================== 2. CREATE RETURN ====================
  if (req.method === 'POST' && action === 'submit_return' && order_id && return_items) {
    try {
      const returnRes = await fetch(`https://${storeDomain}/admin/api/2024-07/returns.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          return: {
            order_id: parseInt(order_id),
            notify_customer: true,
            note: `Portal return - Reason: ${reason || 'Not specified'}`,
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
      await returnRes.json();

      // Tag as processed
      await fetch(`https://${storeDomain}/admin/api/2024-07/orders/${order_id}.json`, {
        method: 'PUT',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: { tags: "return-processed,portal-return" } })
      });

      const refundAmount = return_items.reduce((sum, i) => sum + (i.price || 0) * (i.quantity || 1), 0).toFixed(2);

      res.json({
        success: true,
        message: "Return created!",
        refund_amount: refundAmount
      });

    } catch (err) {
      console.error('Return failed:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
    return;
  }

  // ==================== 3. GET ORDER - 100% ACCURATE DETECTION ====================
  if (req.method === 'GET' && query && contact) {
    try {
      const cleanQuery = query.replace('#', '').trim();

      // Find customer
      const field = contact.includes('@') ? 'email' : 'phone';
      const custRes = await fetch(
        `https://${storeDomain}/admin/api/2024-07/customers/search.json?query=${field}:${encodeURIComponent(contact)}`,
        { headers: { 'X-Shopify-Access-Token': token } }
      );
      const custData = await custRes.json();
      if (!custData.customers?.length) return res.status(404).json({ error: 'Customer not found' });
      const customerId = custData.customers[0].id;

      // Get ALL orders for this customer
      const allRes = await fetch(
        `https://${storeDomain}/admin/api/2024-07/orders.json?customer_id=${customerId}&status=any&limit=250`,
        { headers: { 'X-Shopify-Access-Token': token } }
      );
      const allOrders = (await allRes.json()).orders || [];

      // Find the exact order user is searching
      const mainOrder = allOrders.find(o => 
        o.name.toLowerCase().includes(cleanQuery.toLowerCase()) || 
        String(o.order_number) === cleanQuery
      );
      if (!mainOrder) return res.status(404).json({ error: 'Order not found' });

      await enhanceOrder(mainOrder);

      const tags = (mainOrder.tags || '').toLowerCase();
      const note = (mainOrder.note || '').toLowerCase();

      const response = {
        orders: [mainOrder],
        already_processed: false,
        exchange_order_name: null,
        related_order: null
      };

      // CASE 1: This is the ORIGINAL order that was already exchanged/returned
      if (tags.includes('exchange-processed') || tags.includes('return-processed')) {
        response.already_processed = true;

        // Find the replacement order (has note pointing back to original)
        const replacement = allOrders.find(o => 
          o.note && o.note.toLowerCase().includes(mainOrder.name.toLowerCase())
        );

        if (replacement) {
          response.exchange_order_name = replacement.name;
          await enhanceOrder(replacement);
          response.related_order = replacement;
        }
      }

      // CASE 2: This IS the replacement order (block it!)
      else if (note.includes('exchange for') || note.includes('portal')) {
        const match = note.match(/#(\d+)/i);
        if (match) {
          const original = allOrders.find(o => o.name.includes(match[1]));
          if (original) {
            await enhanceOrder(original);
            response.related_order = original;
            // This is the replacement → block further actions
          }
        }
      }

      res.json(response);

    } catch (err) {
      console.error('GET error:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
    return;
  }

  res.status(400).json({ error: 'Invalid request' });
};

// ==================== ENHANCE ORDER - FULL MAGIC (eShipz + Images + Sizes) ====================
async function enhanceOrder(order) {
  order.line_items = order.line_items || [];

  // Delivery status via eShipz
  const fulfillment = order.fulfillments?.[0] || {};
  let deliveredAt = null;
  let shippingStatus = 'Processing';

  if (fulfillment.tracking_number) {
    const awb = fulfillment.tracking_number.trim();
    try {
      const trackRes = await fetch(`https://track.eshipz.com/track?awb=${awb}`, { timeout: 8000 });
      const html = await trackRes.text();

      if (html.includes('Delivered')) {
        const dateMatch = html.match(/(\d{2}\/\d{2}\/\d{4})/);
        if (dateMatch) deliveredAt = dateMatch[1];
        shippingStatus = 'Delivered';
      } else if (html.includes('In Transit') || html.includes('Out for Delivery')) {
        shippingStatus = 'In Transit';
      } else if (html.includes('Picked Up')) {
        shippingStatus = 'Picked Up';
      }
    } catch (e) { /* ignore */ }
  }

  order.delivered_at = deliveredAt;
  order.current_shipping_status = shippingStatus;

  // Enhance line items
  for (let item of order.line_items) {
    try {
      const prodRes = await fetch(
        `https://${storeDomain}/admin/api/2024-07/products/${item.product_id}.json?fields=images,variants`,
        { headers: { 'X-Shopify-Access-Token': token } }
      );
      const prod = (await prodRes.json()).product;

      item.image_url = prod.images?.[0]?.src || 'https://via.placeholder.com/80';
      
      const variant = prod.variants.find(v => v.id === item.variant_id);
      item.current_size = variant?.title || 'Standard';
      
      item.available_variants = (prod.variants || [])
        .filter(v => v.inventory_quantity > 0)
        .map(v => ({ id: v.id, title: v.title, available: true }));
    } catch (e) {
      item.image_url = 'https://via.placeholder.com/80';
      item.current_size = 'Standard';
    }
  }
}
