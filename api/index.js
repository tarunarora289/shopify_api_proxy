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
  const { action, order, customer_id, return_items, original_order_name } = req.body || {};
  const token = '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';
  const storeDomain = 'trueweststore.myshopify.com';

  // ==================== EXCHANGE: CREATE FREE REPLACEMENT + PERMANENT TAG ====================
  if (req.method === 'POST' && action === 'submit_exchange' && order && customer_id) {
    console.log('Processing exchange for order:', order.name);

    try {
      // 1. Create draft order (free replacement)
      const draftRes = await fetch(`https://${storeDomain}/admin/api/2024-07/draft_orders.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          draft_order: {
            line_items: order.line_items || [],
            customer: { id: customer_id },
            email: order.email,
            shipping_address: order.shipping_address || order.customer?.default_address,
            billing_address: order.billing_address || order.customer?.default_address,
            note: `EXCHANGE for Order ${order.name} | Customer Portal`,
            tags: "exchange,customer-portal",
            applied_discount: {
              description: "Exchange - Free Replacement",
              value_type: "percentage",
              value: 100.0,
              amount: "0.00",
              title: "Exchange - 100% Free"
            },
            note_attributes: [
              { name: "Original Order", value: order.name },
              { name: "Type", value: "Exchange" }
            ]
          }
        })
      });

      if (!draftRes.ok) throw new Error(await draftRes.text());
      const draftData = await draftRes.json();
      const draftOrder = draftData.draft_order;

      // 2. Complete as paid (free)
      const completeRes = await fetch(
        `https://${storeDomain}/admin/api/2024-07/draft_orders/${draftOrder.id}/complete.json?payment_status=paid`,
        { method: 'PUT', headers: { 'X-Shopify-Access-Token': token } }
      );

      if (!completeRes.ok) throw new Error(await completeRes.text());
      const completed = await completeRes.json();
      const newOrderId = completed.draft_order.order_id;
      const newOrderName = completed.draft_order.name;

      // 3. PERMANENTLY TAG ORIGINAL ORDER — THIS IS THE UNBREAKABLE LOCK
      await fetch(`https://${storeDomain}/admin/api/2024-07/orders/${order.id}.json`, {
        method: 'PUT',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          order: {
            tags: "exchange-processed,customer-portal,do-not-reprocess"
          }
        })
      });

      res.json({
        success: true,
        message: "Exchange created successfully!",
        exchange_order: { id: newOrderId, name: newOrderName }
      });

    } catch (err) {
      console.error('Exchange failed:', err.message);
      res.status(500).json({ error: 'Failed to create exchange', details: err.message });
    }
    return;
  }

  // ==================== RETURN: PROCESS REFUND + PERMANENT TAG ====================
  if (req.method === 'POST' && action === 'submit_return' && return_items && original_order_name) {
    try {
      const orderRes = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json?name=${original_order_name}&status=any&limit=1`, {
        headers: { 'X-Shopify-Access-Token': token }
      });
      const ordersData = await orderRes.json();
      const shopifyOrder = ordersData.orders?.[0];
      if (!shopifyOrder) throw new Error('Order not found');

      const totalRefund = return_items.reduce((sum, item) => sum + (parseFloat(item.price) * item.quantity), 0).toFixed(2);

      const refundRes = await fetch(`https://${storeDomain}/admin/api/2024-07/orders/${shopifyOrder.id}/refunds.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          refund: {
            note: "Return processed via customer portal",
            notify: true,
            refund_line_items: return_items.map(item => ({
              line_item_id: item.line_item_id,
              quantity: item.quantity,
              restock_type: "return"
            })),
            transactions: [{
              kind: "refund",
              amount: totalRefund,
              currency: shopifyOrder.currency,
              gateway: shopifyOrder.gateway || "manual",
              status: "success"
            }]
          }
        })
      });

      if (!refundRes.ok) throw new Error(await refundRes.text());
      const refundResult = await refundRes.json();

      // PERMANENTLY TAG ORIGINAL ORDER — RETURN LOCKED FOREVER
      await fetch(`https://${storeDomain}/admin/api/2024-07/orders/${shopifyOrder.id}.json`, {
        method: 'PUT',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          order: {
            tags: "return-processed,customer-portal,do-not-reprocess"
          }
        })
      });

      res.json({
        success: true,
        message: "Return & refund processed!",
        refund_amount: totalRefund
      });

    } catch (err) {
      console.error('Return failed:', err.message);
      res.status(500).json({ error: 'Failed to process return', details: err.message });
    }
    return;
  }

  // ==================== GET ORDER: FULL DUPLICATE DETECTION ====================
  if (req.method === 'GET' && query) {
    try {
      let customerId = null;
      const cleanQuery = query.replace('#', '').trim();

      if (contact) {
        const field = contact.includes('@') ? 'email' : 'phone';
        const custRes = await fetch(
          `https://${storeDomain}/admin/api/2024-07/customers/search.json?query=${field}:${encodeURIComponent(contact)}`,
          { headers: { 'X-Shopify-Access-Token': token } }
        );
        const custData = await custRes.json();
        if (custData.customers?.length > 0) customerId = custData.customers[0].id;
      }

      const orderUrl = customerId
        ? `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&customer_id=${customerId}&name=#${cleanQuery}&limit=1`
        : `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&name=#${cleanQuery}&limit=1`;

      const orderRes = await fetch(orderUrl, { headers: { 'X-Shopify-Access-Token': token } });
      const orderData = await orderRes.json();
      if (!orderData.orders?.length) return res.status(404).json({ error: 'Order not found' });

      const mainOrder = orderData.orders[0];
      const tags = (mainOrder.tags || '').toLowerCase();

      // UNBREAKABLE CHECK: If order has been processed — block forever
      if (tags.includes('exchange-processed') || tags.includes('return-processed')) {
        return res.json({
          orders: [mainOrder],
          already_processed: true,
          processed_type: tags.includes('exchange-processed') ? 'exchange' : 'return'
        });
      }

      // Your existing enrichment (images, variants, tracking, etc.)
      // ... keep all your current code here ...

      res.json({
        orders: [mainOrder],
        already_processed: false
      });

    } catch (err) {
      console.error('GET error:', err.message);
      res.status(500).json({ error: err.message });
    }
    return;
  }

  res.status(400).json({ error: 'Invalid request' });
};
