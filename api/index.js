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

  // ==================== EXCHANGE: 100% FIXED WITH DRAFT ORDERS ====================
  if (req.method === 'POST' && action === 'submit_exchange' && order && customer_id) {
    console.log('Processing EXCHANGE for customer_id:', customer_id);

    try {
      const draftResponse = await fetch(`https://${storeDomain}/admin/api/2024-07/draft_orders.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
          'User-Agent': 'Grok-Proxy/1.0'
        },
        body: JSON.stringify({
          draft_order: {
            line_items: order.line_items || [],
            customer: { id: customer_id },
            email: order.email,
            shipping_address: order.shipping_address || null,
            billing_address: order.billing_address || null,
            note: `EXCHANGE - Original Order: ${order.name} | Created via Customer Portal`,
            tags: "exchange,size-exchange,customer-portal",
            applied_discount: {
              description: "Free Exchange Replacement",
              value_type: "percentage",
              value: 100.0,
              amount: "0.00",
              title: "100% Exchange Discount"
            },
            note_attributes: [
              { name: "Original Order", value: order.name },
              { name: "RMA Type", value: "Exchange" }
            ]
          }
        })
      });

      if (!draftResponse.ok) {
        const errorText = await draftResponse.text();
        throw new Error(`Draft order creation failed: ${errorText}`);
      }

      const draftData = await draftResponse.json();
      const draftOrderId = draftData.draft_order.id;

      // Complete the draft order as paid (free)
      const completeResponse = await fetch(
        `https://${storeDomain}/admin/api/2024-07/draft_orders/${draftOrderId}/complete.json?payment_status=paid`,
        {
          method: 'PUT',
          headers: { 'X-Shopify-Access-Token': token }
        }
      );

      if (!completeResponse.ok) {
        const errorText = await completeResponse.text();
        throw new Error(`Failed to complete draft order: ${errorText}`);
      }

      const completed = await completeResponse.json();

      res.json({
        success: true,
        message: "Exchange order created successfully!",
        exchange_order: {
          id: completed.draft_order.order_id,
          name: completed.draft_order.name,
          admin_url: `https://${storeDomain}/admin/orders/${completed.draft_order.order_id}`,
          customer_message: "Your exchange has been processed. We'll ship the new item soon!"
        }
      });

    } catch (err) {
      console.error('EXCHANGE ERROR:', err.message);
      res.status(500).json({
        success: false,
        error: "Failed to create exchange order",
        details: err.message
      });
    }
    return;
  }

  // ==================== RETURN: FULL REFUND TO ORIGINAL PAYMENT ====================
  if (req.method === 'POST' && action === 'submit_return' && return_items && original_order_name) {
    console.log('Processing RETURN & REFUND for order:', original_order_name);

    try {
      // Find the original order
      const orderResponse = await fetch(
        `https://${storeDomain}/admin/api/2024-07/orders.json?name=${original_order_name}&status=any&limit=1`,
        { headers: { 'X-Shopify-Access-Token': token } }
      );

      if (!orderResponse.ok) throw new Error("Could not fetch order");
      const orderData = await orderResponse.json();
      const shopifyOrder = orderData.orders?.[0];

      if (!shopifyOrder) {
        return res.status(404).json({ success: false, error: "Order not found" });
      }

      const refundAmount = return_items.reduce((sum, item) => sum + (item.price * item.quantity), 0).toFixed(2);

      const refundResponse = await fetch(
        `https://${storeDomain}/admin/api/2024-07/orders/${shopifyOrder.id}/refunds.json`,
        {
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
                amount: refundAmount,
                currency: shopifyOrder.currency,
                gateway: shopifyOrder.gateway || "manual",
                status: "success"
              }]
            }
          })
        }
      );

      if (!refundResponse.ok) {
        const errorText = await refundResponse.text();
        throw new Error(`Refund API failed: ${errorText}`);
      }

      const refundResult = await refundResponse.json();

      res.json({
        success: true,
        message: "Return accepted! Refund processed.",
        refund_amount: refundAmount,
        currency: shopifyOrder.currency,
        refund_id: refundResult.refund.id,
        customer_message: "Your refund will be processed to your original payment method within 3-7 business days."
      });

    } catch (err) {
      console.error('RETURN ERROR:', err.message);
      res.status(500).json({
        success: false,
        error: "Failed to process return",
        details: err.message
      });
    }
    return;
  }

  // ==================== ORIGINAL GET LOGIC (100% UNCHANGED) ====================
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
              currentShippingStatus = 'In Transit';
            }
          } else {
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

      if (actualDeliveryDate) {
        order.actual_delivery_date = actualDeliveryDate;
        order.delivered_at = actualDeliveryDate;
      } else {
        order.actual_delivery_date = null;
        order.delivered_at = null;
      }
      order.current_shipping_status = currentShippingStatus;

      const created = new Date(order.created_at);
      const minDelivery = new Date(created);
      minDelivery.setDate(created.getDate() + 5);
      const maxDelivery = new Date(created);
      maxDelivery.setDate(created.getDate() + 7);
      order.estimated_delivery = {
        min: minDelivery.toISOString().split('T')[0],
        max: maxDelivery.toISOString().split('T')[0]
      };

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
