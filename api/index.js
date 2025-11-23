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
  const { action, order, customer_id, return_items, exchange_items, reason, original_order_name } = req.body || {};

  const token = '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';
  const storeDomain = 'trueweststore.myshopify.com';
  const apiVersion = '2024-07';

  // ==================== SUBMIT EXCHANGE ====================
  if (req.method === 'POST' && action === 'submit_exchange' && exchange_items && customer_id) {
    console.log('Processing EXCHANGE for customer:', customer_id);

    try {
      const draftResponse = await fetch(`https://${storeDomain}/admin/api/${apiVersion}/draft_orders.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          draft_order: {
            line_items: exchange_items.map(item => ({
              variant_id: item.variant_id,
              quantity: item.quantity || 1,
              price: "0.00", // Force free replacement
              applied_discount: {
                description: "Exchange - Free Replacement",
                value_type: "fixed_amount",
                value: item.price || 0,
                amount: item.price || 0,
                title: "100% Exchange Discount"
              }
            })),
            customer: { id: customer_id },
            email: order?.email,
            shipping_address: order?.shipping_address || order?.customer?.default_address,
            billing_address: order?.billing_address || order?.customer?.default_address,
            note: `EXCHANGE for Order ${original_order_name || order?.name} | Reason: ${reason || 'Size Exchange'}`,
            tags: "exchange,size-exchange,rma",
            applied_discount: {
              description: "Full Exchange - No Charge",
              value_type: "percentage",
              value: 100.0,
              amount: "0.00",
              title: "Exchange - Free"
            },
            note_attributes: [
              { name: "Original Order", value: original_order_name || order?.name },
              { name: "RMA Type", value: "Exchange" },
              { name: "Reason", value: reason || "Wrong Size" }
            ]
          }
        })
      });

      if (!draftResponse.ok) {
        const err = await draftResponse.text();
        throw new Error(`Draft order failed: ${err}`);
      }

      const draft = await draftResponse.json();
      const draftOrder = draft.draft_order;

      // Complete as paid (no charge)
      const completeRes = await fetch(`https://${storeDomain}/admin/api/${apiVersion}/draft_orders/${draftOrder.id}/complete.json?payment_status=paid`, {
        method: 'PUT',
        headers: { 'X-Shopify-Access-Token': token }
      });

      if (!completeRes.ok) throw new Error('Failed to complete exchange draft order');

      const completed = await completeRes.json();

      res.json({
        success: true,
        type: "exchange",
        message: "Exchange order created successfully!",
        exchange_order: {
          id: completed.draft_order.order_id,
          name: completed.draft_order.name,
          admin_url: `https://${storeDomain}/admin/orders/${completed.draft_order.order_id}`,
          customer_url: completed.draft_order.invoice_url
        },
        original_order: original_order_name || order?.name
      });

    } catch (err) {
      console.error('Exchange Error:', err.message);
      res.status(500).json({ success: false, error: "Failed to create exchange", details: err.message });
    }
    return;
  }

  // ==================== SUBMIT RETURN (Refund) ====================
  if (req.method === 'POST' && action === 'submit_return' && return_items && original_order_name) {
    console.log('Processing RETURN for order:', original_order_name);

    try {
      // Step 1: Find the original order
      const orderRes = await fetch(`https://${storeDomain}/admin/api/${apiVersion}/orders.json?name=${original_order_name}&status=any`, {
        headers: { 'X-Shopify-Access-Token': token }
      });
      if (!orderRes.ok) throw new Error('Order not found');
      const ordersData = await orderRes.json();
      const shopifyOrder = ordersData.orders.find(o => o.name === original_order_name);
      if (!shopifyOrder) throw new Error('Order not found in Shopify');

      const orderId = shopifyOrder.id;

      // Step 2: Create Refund
      const refundResponse = await fetch(`https://${storeDomain}/admin/api/${apiVersion}/orders/${orderId}/refunds.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          refund: {
            note: `RETURN Request | Reason: ${reason || 'Not Satisfied'}`,
            notify: true,
            shipping: { full_refund: false },
            refund_line_items: return_items.map(item => ({
              line_item_id: item.line_item_id,
              quantity: item.quantity,
              restock_type: "return", // or "no_restock" if damaged
              location_id: null // auto-detect if null
            })),
            transactions: [{
              kind: "refund",
              status: "success",
              gateway: shopifyOrder.gateway || "manual",
              amount: return_items.reduce((sum, i) => sum + (i.price * i.quantity), 0).toFixed(2),
              currency: shopifyOrder.currency,
              parent_id: shopifyOrder.transactions.find(t => t.kind === "sale" || t.kind === "authorization")?.id
            }]
          }
        })
      });

      if (!refundResponse.ok) {
        const err = await refundResponse.text();
        throw new Error(`Refund failed: ${err}`);
      }

      const refundResult = await refundResponse.json();

      res.json({
        success: true,
        type: "return",
        message: "Return processed and refund issued!",
        refund: refundResult.refund,
        return_instructions: "Please ship the item back to: True West Store, [Your Address], within 15 days.",
        original_order: original_order_name
      });

    } catch (err) {
      console.error('Return Error:', err.message);
      res.status(500).json({ success: false, error: "Failed to process return", details: err.message });
    }
    return;
  }

  // ==================== GET ORDER (Existing Logic - Unchanged + Minor Fixes) ====================
  if (req.method === 'GET') {
    if (!query) return res.status(400).json({ error: 'Missing query parameter' });

    try {
      let data;
      if (contact) {
        const field = contact.includes('@') ? 'email' : 'phone';
        const custRes = await fetch(`https://${storeDomain}/admin/api/${apiVersion}/customers/search.json?query=${field}:${encodeURIComponent(contact)}`, {
          headers: { 'X-Shopify-Access-Token': token }
        });
        const custData = await custRes.json();
        if (!custData.customers?.length) return res.status(404).json({ error: 'Customer not found' });
        const customerId = custData.customers[0].id;

        const ordersRes = await fetch(`https://${storeDomain}/admin/api/${apiVersion}/orders.json?status=any&customer_id=${customerId}&name=#${query}&limit=1`, {
          headers: { 'X-Shopify-Access-Token': token }
        });
        data = await ordersRes.json();
      } else {
        const res = await fetch(`https://${storeDomain}/admin/api/${apiVersion}/orders.json?status=any&name=#${query}&limit=1`, {
          headers: { 'X-Shopify-Access-Token': token }
        });
        data = await res.json();
      }

      if (!data.orders?.length) return res.status(404).json({ error: 'Order not found' });

      const cleanQuery = query.replace('#', '');
      const exactOrder = data.orders.find(o => o.name === `#${cleanQuery}` || String(o.order_number) === cleanQuery);
      const order = exactOrder || data.orders[0];

      // [Keep your existing tracking + image + variants logic here...]
      // ... (all your eShipz tracking, images, variants code remains unchanged)

      res.json({ orders: [order] });
    } catch (err) {
      console.error('GET Proxy error:', err.message);
      res.status(500).json({ error: err.message });
    }
    return;
  }

  res.status(400).json({ error: 'Invalid request' });
};
