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
  const { action, order, customer_id, order_id, return_items, reason } = req.body || {};

  const token = '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';
  const storeDomain = 'trueweststore.myshopify.com';

  // ==================== 1. SUBMIT EXCHANGE - CREATE REPLACEMENT ORDER ====================
  if (req.method === 'POST' && action === 'submit_exchange' && order && customer_id) {
    try {
      console.log('Creating exchange order for customer:', customer_id);

      // Add note to link back to original order
      if (!order.note) {
        order.note = `Exchange for order #${order.name || 'unknown'} via portal`;
      }

      // Create the actual order (not draft)
      const createRes = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
          'User-Agent': 'TrueWest-Portal/1.0'
        },
        body: JSON.stringify({ order })
      });

      if (!createRes.ok) {
        const err = await createRes.text();
        throw new Error(`Shopify API Error: ${err}`);
      }

      const createdOrder = (await createRes.json()).order;

      // Tag original order as processed (if we can find it)
      if (order.note && order.note.includes('#')) {
        const originalNum = order.note.match(/#(\d+)/);
        if (originalNum) {
          const originalId = originalNum[1];
          await fetch(`https://${storeDomain}/admin/api/2024-07/orders/${originalId}.json`, {
            method: 'PUT',
            headers: {
              'X-Shopify-Access-Token': token,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              order: { tags: "exchange-processed,portal-exchange" }
            })
          });
        }
      }

      // THIS IS THE FIX — YOUR PORTAL WAITED FOR THIS FORMAT
      res.json({
        success: true,
        message: "Exchange created successfully!",
        exchange_order: createdOrder,
        order_number: createdOrder.name
      });

    } catch (err) {
      console.error('Exchange creation failed:', err.message);
      res.status(500).json({
        success: false,
        error: err.message || "Failed to create exchange order"
      });
    }
    return;
  }

  // ==================== 2. SUBMIT RETURN - REAL SHOPIFY RETURN API ====================
  if (req.method === 'POST' && action === 'submit_return' && order_id && return_items) {
    try {
      console.log('Creating return for order:', order_id);

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
            note: `Customer portal return - Reason: ${reason || 'Not specified'}`,
            refund: true,
            return_line_items: return_items.map(item => ({
              line_item_id: item.line_item_id,
              quantity: item.quantity || 1,
              restock_type: "return"
            }))
          }
        })
      });

      if (!returnRes.ok) {
        const err = await returnRes.text();
        throw new Error(err);
      }

      const returnData = await returnRes.json();

      // Tag the original order
      await fetch(`https://${storeDomain}/admin/api/2024-07/orders/${order_id}.json`, {
        method: 'PUT',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          order: { tags: "return-processed,portal-return" }
        })
      });

      const refundAmount = return_items.reduce((sum, i) => sum + (i.price || 0) * (i.quantity || 1), 0).toFixed(2);

      res.json({
        success: true,
        message: "Return created successfully!",
        refund_amount: refundAmount,
        return_id: returnData.return.id
      });

    } catch (err) {
      console.error('Return failed:', err.message);
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
    return;
  }

  // ==================== 3. GET ORDER - FULLY ENHANCED + DETECTION ====================
  if (req.method === 'GET' && query) {
    try {
      const cleanQuery = query.replace('#', '').trim();
      let customerId = null;

      if (contact) {
        const field = contact.includes('@') ? 'email' : 'phone';
        const custRes = await fetch(
          `https://${storeDomain}/admin/api/2024-07/customers/search.json?query=${field}:${encodeURIComponent(contact)}`,
          { headers: { 'X-Shopify-Access-Token': token } }
        );
        const custData = await custRes.json();
        if (custData.customers?.length > 0) {
          customerId = custData.customers[0].id;
        }
      }

      const ordersUrl = customerId
        ? `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&customer_id=${customerId}&limit=10`
        : `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&name=#${cleanQuery}&limit=10`;

      const ordersRes = await fetch(ordersUrl, { headers: { 'X-Shopify-Access-Token': token } });
      const ordersData = await ordersRes.json();

      if (!ordersData.orders?.length) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const mainOrder = ordersData.orders.find(o => 
        o.name === `#${cleanQuery}` || String(o.order_number) === cleanQuery
      ) || ordersData.orders[0];

      const response = {
        orders: [],
        already_processed: false,
        exchange_order_name: null,
        related_order: null
      };

      await enhanceOrder(mainOrder);
      response.orders = [mainOrder];

      const tags = (mainOrder.tags || '').toLowerCase();
      const note = (mainOrder.note || '').toLowerCase();

      if (tags.includes('exchange-processed') || tags.includes('return-processed')) {
        response.already_processed = true;

        if (with_related === '1') {
          const allRes = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json?status=any&limit=50`, {
            headers: { 'X-Shopify-Access-Token': token }
          });
          const allOrders = (await allRes.json()).orders || [];

          const replacement = allOrders.find(o => 
            o.note && o.note.toLowerCase().includes(mainOrder.name.toLowerCase())
          );

          if (replacement) {
            response.exchange_order_name = replacement.name;
            await enhanceOrder(replacement);
            response.related_order = replacement;
          }
        }
      } else if (note.includes('exchange for order') && with_related === '1') {
        const match = mainOrder.note.match(/#(\d+)/);
        if (match) {
          const origRes = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json?name=#${match[1]}&limit=1`, {
            headers: { 'X-Shopify-Access-Token': token }
          });
          const origData = await origRes.json();
          if (origData.orders?.[0]) {
            await enhanceOrder(origData.orders[0]);
            response.related_order = origData.orders[0];
          }
        }
      }

      res.json(response);

    } catch (err) {
      console.error('GET error:', err.message);
      res.status(500).json({ error: err.message });
    }
    return;
  }

  res.status(400).json({ error: 'Invalid request' });
};

// ==================== ENHANCE ORDER - ALL YOUR MAGIC ====================
async function enhanceOrder(order) {
  const fulfillment = order.fulfillments?.[0] || {};
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
        const patterns = [
          /Delivered.*?(\d{2}\/\d{2}\/\d{4})/i,
          /Delivered on.*?(\d{2}\/\d{2}\/\d{4})/i,
          /(\d{4}-\d{2}-\d{2})/
        ];
        for (const p of patterns) {
          const m = html.match(p);
          if (m) {
            actualDeliveryDate = m[1];
            currentShippingStatus = 'Delivered';
            break;
          }
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

  order.actual_delivery_date = actualDeliveryDate;
  order.delivered_at = actualDeliveryDate;
  order.current_shipping_status = currentShippingStatus;

  // Estimated delivery
  const created = new Date(order.created_at);
  const min = new Date(created); min.setDate(created.getDate() + 5);
  const max = new Date(created); max.setDate(created.getDate() + 7);
  order.estimated_delivery = {
    min: min.toISOString().split('T')[0],
    max: max.toISOString().split('T')[0]
  };

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
        id: v.id,
        title: v.title,
        inventory_quantity: v.inventory_quantity,
        available: v.inventory_quantity > 0
      }));
      const variant = prod.variants.find(v => v.id === item.variant_id);
      if (variant) {
        item.current_size = variant.title;
        item.current_inventory = variant.inventory_quantity;
      }
    } catch (e) {
      console.warn('Failed to enhance item:', item.id);
    }
  }
}
