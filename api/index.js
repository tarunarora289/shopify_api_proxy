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

  // ==================== EXCHANGE: FULLY FIXED & CLEAN ====================
  if (req.method === 'POST' && action === 'submit_exchange' && order && customer_id && order.name) {
    console.log('Creating EXCHANGE for order:', order.name, 'Customer ID:', customer_id);

    try {
      // Prepare clean line items (only variant_id and quantity needed)
      const lineItems = (order.line_items || []).map(item => ({
        variant_id: item.variant_id,
        quantity: item.quantity || 1,
        properties: [
          { name: "Original Item", value: item.title },
          { name: "Original Size", value: item.variant_title || item.current_size || "N/A" }
        ]
      }));

      const draftResponse = await fetch(`https://${storeDomain}/admin/api/2024-07/draft_orders.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          draft_order: {
            line_items: lineItems,
            customer: { id: customer_id },
            email: order.email || order.customer?.email,
            shipping_address: order.shipping_address || order.customer?.default_address || null,
            billing_address: order.billing_address || order.customer?.default_address || null,
            note: `EXCHANGE - Original Order: ${order.name}`,
            tags: "exchange, size-exchange, customer-portal",
            applied_discount: {
              description: "Free Exchange Replacement",
              value_type: "percentage",
              value: 100.0,
              amount: "0.00",
              title: "100% Free Exchange"
            },
            note_attributes: [
              { name: "Original Order", value: order.name },
              { name: "RMA Type", value: "Exchange" },
              { name: "Exchange Reason", value: "Size/Color Issue" }
            ]
          }
        })
      });

      if (!draftResponse.ok) {
        const err = await draftResponse.text();
        throw new Error(`Draft order failed: ${err}`);
      }

      const draftData = await draftResponse.json();
      const draftId = draftData.draft_order.id;

      // Complete as paid (free)
      const completeRes = await fetch(`https://${storeDomain}/admin/api/2024-07/draft_orders/${draftId}/complete.json?payment_status=paid`, {
        method: 'PUT',
        headers: { 'X-Shopify-Access-Token': token }
      });

      if (!completeRes.ok) {
        const err = await completeRes.text();
        throw new Error(`Complete failed: ${err}`);
      }

      const completed = await completeRes.json();
      const newOrder = completed.draft_order;

      // SUCCESS — This stops the frontend error
      res.json({
        success: true,
        message: "Your exchange has been processed successfully!",
        new_order_name: newOrder.name,
        new_order_id: newOrder.order_id,
        admin_url: `https://${storeDomain}/admin/orders/${newOrder.order_id}`,
        customer_message: `We have created exchange order ${newOrder.name}. Your new item will be shipped soon!`
      });

    } catch (err) {
      console.error('EXCHANGE FAILED:', err.message);
      res.status(500).json({
        success: false,
        error: "Failed to create exchange order",
        details: err.message
      });
    }
    return;
  }

  // ==================== RETURN: FULL REFUND (CASH BACK) ====================
  if (req.method === 'POST' && action === 'submit_return' && return_items && original_order_name) {
    try {
      const orderRes = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json?name=${original_order_name}&status=any&limit=1`, {
        headers: { 'X-Shopify-Access-Token': token }
      });
      const orderData = await orderRes.json();
      const shopifyOrder = orderData.orders?.[0];

      if (!shopifyOrder) {
        return res.status(404).json({ success: false, error: "Original order not found" });
      }

      const refundRes = await fetch(`https://${storeDomain}/admin/api/2024-07/orders/${shopifyOrder.id}/refunds.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          refund: {
            note: `RETURN via Customer Portal - Order ${original_order_name}`,
            notify: true,
            refund_line_items: return_items.map(item => ({
              line_item_id: item.line_item_id,
              quantity: item.quantity,
              restock_type: "return"
            }))
          }
        })
      });

      if (!refundRes.ok) {
        const err = await refundRes.text();
        throw new Error(err);
      }

      const refundData = await refundRes.json();

      res.json({
        success: true,
        message: "Return accepted! Refund processed successfully.",
        refund_amount: refundData.refund.total_refunded_amount,
        customer_message: "Your refund will reach your original payment method in 3–7 days."
      });

    } catch (err) {
      console.error('RETURN FAILED:', err.message);
      res.status(500).json({
        success: false,
        error: "Failed to process return",
        details: err.message
      });
    }
    return;
  }

  // ==================== GET ORDER: YOUR ORIGINAL LOGIC (UNCHANGED) ====================
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

      if (data.orders && data.orders.length > 0) {
        const cleanQuery = query.replace('#', '');
        const exactOrder = data.orders.find(o => o.name === `#${cleanQuery}` || String(o.order_number) === cleanQuery);
        data.orders = exactOrder ? [exactOrder] : [data.orders[0]];
      } else {
        return res.status(404).json({ error: 'Order not found' });
      }

      const order = data.orders[0];
      const fulfillment = order.fulfillments?.[0];
      let actualDeliveryDate = null;
      let currentShippingStatus = 'Processing';
      if (fulfillment?.tracking_number) {
        const awb = fulfillment.tracking_number.trim();
        try {
          const trackUrl = `https://track.eshipz.com/track?awb=${awb}`;
          const trackRes = await fetch(trackUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 10000
          });
          const html = await trackRes.text();
          if (html.toLowerCase().includes('delivered')) {
            const patterns = [/Delivered.*?(\d{2}\/\d{2}\/\d{4})/i, /Delivered on.*?(\d{2}\/\d{2}\/\d{4})/i, /Delivered.*?(\d{1,2}\s[A-Za-z]{3,9}\s\d{4})/i, /Delivered.*?(\d{4}-\d{2}-\d{2})/i];
            for (const pattern of patterns) {
              const match = html.match(pattern);
              if (match) {
                actualDeliveryDate = match[1];
                currentShippingStatus = 'Delivered';
                break;
              }
            }
            if (!actualDeliveryDate) currentShippingStatus = 'In Transit';
          } else {
            if (html.toLowerCase().includes('in transit') || html.includes('out for delivery') || html.includes('dispatched')) currentShippingStatus = 'In Transit';
            else if (html.toLowerCase().includes('picked up') || html.includes('pickup')) currentShippingStatus = 'Picked Up';
          }
        } catch (e) {
          console.warn(`eShipz tracking failed for AWB ${awb}:`, e.message);
          currentShippingStatus = 'Unknown';
        }
      }

      if (actualDeliveryDate) {
        order.actual_delivery_date = actualDeliveryDate;
        order.delivered_at = actualDeliveryDate;
      } else {
        order.actual_delivery_date = null;
        order.delivered_at = null;
      }
      order.current_shipping_status = currentShippingStatus;

      const created = new Date(order.created_at);
      const minDelivery = new Date(created); minDelivery.setDate(created.getDate() + 5);
      const maxDelivery = new Date(created); maxDelivery.setDate(created.getDate() + 7);
      order.estimated_delivery = {
        min: minDelivery.toISOString().split('T')[0],
        max: maxDelivery.toISOString().split('T')[0]
      };

      for (let item of order.line_items) {
        const productRes = await fetch(`https://${storeDomain}/admin/api/2024-07/products/${item.product_id}.json?fields=id,title,images,variants`, { headers: { 'X-Shopify-Access-Token': token } });
        const productData = await productRes.json();
        const product = productData.product;
        if (product.images?.[0]) item.image_url = product.images[0].src;
        item.available_variants = (product.variants || []).map(v => ({
          id: v.id, title: v.title, inventory_quantity: v.inventory_quantity, available: v.inventory_quantity > 0
        }));
        const currentVariant = product.variants?.find(v => v.id === item.variant_id);
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
