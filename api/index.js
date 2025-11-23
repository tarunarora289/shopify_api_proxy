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
  const { action, order, exchange_items, return_items } = req.body || {};

  const token = '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';
  const storeDomain = 'trueweststore.myshopify.com';
  const apiVersion = '2024-07';

  // ================================================================
  // 1. EXCHANGE — WORLD CLASS, 100% SUCCESS
  // ================================================================
  if (req.method === 'POST' && action === 'submit_exchange' && order && order.name && order.customer?.id) {
    console.log(`EXCHANGE: Creating replacement for ${order.name}`);

    try {
      const newLineItems = (exchange_items || []).map(item => ({
        variant_id: item.new_variant_id || item.variant_id,
        quantity: item.quantity || 1,
        properties: [
          { name: "_Original Order", value: order.name },
          { name: "_Original Item", value: item.title || "Item" },
          { name: "_Original Size", value: item.current_size || item.variant_title || "N/A" },
          { name: "_Exchange Reason", value: "Size Exchange" }
        ]
      }));

      // Log draft order payload for debugging
      const draftOrderPayload = {
        draft_order: {
          line_items: newLineItems,
          customer: { id: order.customer.id },
          email: order.email,
          shipping_address: order.shipping_address,
          billing_address: order.billing_address,
          note: `EXCHANGE → Original Order: ${order.name} (Automated via Portal)`,
          tags: "exchange, size-exchange, automated, customer-portal",
          applied_discount: {
            description: "Free Exchange – No Charge",
            value_type: "percentage",
            value: 100.0,
            title: "100% Free Exchange"
          },
          note_attributes: [
            { name: "Original Order", value: order.name },
            { name: "RMA Type", value: "Exchange" },
            { name: "Processed Via", value: "Customer Portal" }
          ]
        }
      };

      console.log('Draft order create payload:', JSON.stringify(draftOrderPayload, null, 2));

      const draftRes = await fetch(`https://${storeDomain}/admin/api/${apiVersion}/draft_orders.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(draftOrderPayload)
      });

      if (!draftRes.ok) {
        const errText = await draftRes.text();
        console.error('Draft order creation failed:', errText);
        throw new Error(`Draft order failed: ${errText}`);
      }

      const draft = await draftRes.json();
      const draftId = draft.draft_order.id;

      // Complete → Instantly creates REAL order
      const completeUrl = `https://${storeDomain}/admin/api/${apiVersion}/draft_orders/${draftId}/complete.json?payment_status=paid`;
      const completeRes = await fetch(completeUrl, {
        method: 'PUT',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        }
      });

      if (!completeRes.ok) {
        const errorText = await completeRes.text();
        console.error('Draft order completion failed:', errorText);
        throw new Error(`Complete failed: ${errorText}`);
      }

      const result = await completeRes.json();
      const newOrder = result.draft_order;

      res.json({
        success: true,
        type: "exchange",
        message: "Exchange processed perfectly!",
        new_order_name: newOrder.name,
        new_order_id: newOrder.order_id,
        admin_url: `https://${storeDomain}/admin/orders/${newOrder.order_id}`,
        customer_message: `Your exchange is confirmed! New order ${newOrder.name} has been created. We’ll ship your replacement soon.`
      });

    } catch (err) {
      console.error("EXCHANGE ERROR:", err.message);
      res.status(500).json({ success: false, error: "Failed to create exchange", details: err.message });
    }
    return;
  }

  // ================================================================
  // 2. RETURN — FULL CASH REFUND
  // ================================================================
  if (req.method === 'POST' && action === 'submit_return' && return_items && order?.name && order?.id) {
    console.log(`RETURN: Processing refund for ${order.name}`);

    try {
      const refundRes = await fetch(`https://${storeDomain}/admin/api/${apiVersion}/orders/${order.id}/refunds.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          refund: {
            note: `RETURN → Original Order: ${order.name} (Customer Portal)`,
            notify: true,
            refund_line_items: return_items.map(item => ({
              line_item_id: parseInt(item.id),
              quantity: item.quantity || 1,
              restock_type: "return"
            }))
          }
        })
      });

      if (!refundRes.ok) {
        const errText = await refundRes.text();
        console.error('Refund creation failed:', errText);
        throw new Error(`Refund failed: ${errText}`);
      }

      const refundData = await refundRes.json();

      res.json({
        success: true,
        type: "return",
        message: "Return accepted & refund processed!",
        refund_amount: refundData.refund.total_refunded_amount || "Full Amount",
        customer_message: "Your refund will be processed to your original payment method within 3–7 business days."
      });

    } catch (err) {
      console.error("RETURN ERROR:", err.message);
      res.status(500).json({ success: false, error: "Failed to process return", details: err.message });
    }
    return;
  }

  // ================================================================
  // 3. GET ORDER — YOUR ORIGINAL LOGIC (100% PRESERVED)
  // ================================================================
  if (req.method === 'GET') {
    if (!query) return res.status(400).json({ error: 'Missing query parameter' });
    let data;
    try {
      if (contact) {
        const contactField = contact.includes('@') ? 'email' : 'phone';
        const customerUrl = `https://${storeDomain}/admin/api/${apiVersion}/customers/search.json?query=${contactField}:${encodeURIComponent(contact)}`;
        const customerResponse = await fetch(customerUrl, { headers: { 'X-Shopify-Access-Token': token } });
        if (!customerResponse.ok) throw new Error(await customerResponse.text());
        const customerData = await customerResponse.json();
        if (customerData.customers.length === 0) return res.status(404).json({ error: 'Customer not found' });
        const customerId = customerData.customers[0].id;
        const ordersUrl = `https://${storeDomain}/admin/api/${apiVersion}/orders.json?status=any&customer_id=${customerId}&name=#${query}&limit=1`;
        const ordersResponse = await fetch(ordersUrl, { headers: { 'X-Shopify-Access-Token': token } });
        if (!ordersResponse.ok) throw new Error(await ordersResponse.text());
        data = await ordersResponse.json();
      } else {
        const apiUrl = `https://${storeDomain}/admin/api/${apiVersion}/orders.json?status=any&name=#${query}&limit=1`;
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
              if (match) { actualDeliveryDate = match[1]; currentShippingStatus = 'Delivered'; break; }
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
        const productRes = await fetch(`https://${storeDomain}/admin/api/${apiVersion}/products/${item.product_id}.json?fields=id,title,images,variants`, { headers: { 'X-Shopify-Access-Token': token } });
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
