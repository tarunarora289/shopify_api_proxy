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
  const token = process.env.SHOPIFY_API_TOKEN;
  const storeDomain = 'trueweststore.myshopify.com';
  // ==================== POST: CREATE EXCHANGE ====================
  if (req.method === 'POST' && action === 'submit_exchange' && order && customer_id) {
    try {
      // 1. Check previous exchanges for fee
      const customerOrdersRes = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json?customer_id=${customer_id}&status=any&limit=250&fields=tags,name`, {
        headers: { 'X-Shopify-Access-Token': token }
      });
      if (!customerOrdersRes.ok) throw new Error(await customerOrdersRes.text());
      const customerOrders = (await customerOrdersRes.json()).orders || [];
      const previousExchanges = customerOrders.filter(o => (o.tags || '').toLowerCase().includes('exchange-processed')).length;
      const addExchangeFee = previousExchanges > 0; // First free

      // 2. Calculate price difference
      const frontendLineItem = order.order.line_items[0];
      const originalPrice = parseFloat(currentOrder.line_items[0].price);
      let newPrice = 0;
      let variantTitle = 'Custom Size Item';

      if (frontendLineItem.variant_id) {
        const variantRes = await fetch(`https://${storeDomain}/admin/api/2024-07/variants/${frontendLineItem.variant_id}.json`, {
          headers: { 'X-Shopify-Access-Token': token }
        });
        if (!variantRes.ok) throw new Error(await variantRes.text());
        const variantData = await variantRes.json();
        newPrice = parseFloat(variantData.variant.price);
        variantTitle = variantData.variant.title;
      } else {
        newPrice = originalPrice; // Custom: same price
      }

      // 3. Build line items
      const draftLineItems = [
        {
          variant_id: frontendLineItem.variant_id || null,
          quantity: 1,
          price: newPrice.toFixed(2),
          title: variantTitle,
          taxable: true
        }
      ];

      const priceDifference = newPrice - originalPrice;

      if (priceDifference > 0) {
        draftLineItems.push({
          title: "Price Difference",
          price: priceDifference.toFixed(2),
          quantity: 1,
          taxable: false
        });
      } else if (priceDifference < 0) {
        // Add discount line for refund
        draftLineItems.push({
          title: "Price Adjustment Refund",
          price: priceDifference.toFixed(2), // negative
          quantity: 1,
          taxable: false
        });
      }

      if (addExchangeFee) {
        draftLineItems.push({
          title: "Exchange Fee",
          price: "200.00",
          quantity: 1,
          taxable: false
        });
      }

      // 4. Create draft order
      const draftPayload = {
        draft_order: {
          line_items: draftLineItems,
          customer: { id: customer_id },
          email: order.order.email,
          shipping_address: order.order.shipping_address,
          billing_address: order.order.billing_address || order.order.shipping_address,
          note: `EXCHANGE for Order ${order.name} | Portal Request | Draft ID: pending`,
          tags: "exchange-draft,portal-created"
        }
      };

      const draftRes = await fetch(`https://${storeDomain}/admin/api/2024-07/draft_orders.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(draftPayload)
      });

      if (!draftRes.ok) throw new Error(await draftRes.text());
      const draftData = await draftRes.json();
      const draftId = draftData.draft_order.id;

      // 5. If no payment needed (priceDifference + fee = 0), complete draft automatically
      const totalAdditional = priceDifference + (addExchangeFee ? 200 : 0);
      if (totalAdditional <= 0) {
        const completeRes = await fetch(`https://${storeDomain}/admin/api/2024-07/draft_orders/${draftId}/complete.json?payment_pending=true`, {
          method: 'PUT',
          headers: { 'X-Shopify-Access-Token': token }
        });
        if (!completeRes.ok) throw new Error(await completeRes.text());
        const completeData = await completeRes.json();
        // Update note with new order number
        await fetch(`https://${storeDomain}/admin/api/2024-07/orders/${completeData.order.id}.json`, {
          method: 'PUT',
          headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ order: { note: `EXCHANGE for Order ${order.name} | Portal Request | New Order: ${completeData.order.name}` } })
        });
        res.json({
          success: true,
          exchange_order: completeData.order,
          message: "Exchange created successfully!"
        });
      } else {
        // Send invoice for payment
        const invoiceRes = await fetch(`https://${storeDomain}/admin/api/2024-07/draft_orders/${draftId}/send_invoice.json`, {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            draft_order_invoice: {
              to: order.order.email,
              subject: "Exchange Payment for Order " + order.name,
              custom_message: "Please complete payment for your exchange. Total additional: ₹" + totalAdditional.toFixed(2) + (addExchangeFee ? " (incl. ₹200 fee)" : "")
            }
          })
        });
        if (!invoiceRes.ok) throw new Error(await invoiceRes.text());
        const invoiceData = await invoiceRes.json();

        res.json({
          success: true,
          payment_url: invoiceData.draft_order.invoice_url,
          message: "Redirecting to payment..."
        });
      }

      // 6. Tag original order as processed
      const origRes = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json?name=${order.name}`, {
        headers: { 'X-Shopify-Access-Token': token }
      });
      const origData = await origRes.json();
      if (origData.orders?.[0]) {
        await fetch(`https://${storeDomain}/admin/api/2024-07/orders/${origData.orders[0].id}.json`, {
          method: 'PUT',
          headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ order: { tags: "exchange-processed,portal-exchange",
            note: `EXCHANGED → Draft #${draftId}` } })
        });
      }
    } catch (err) {
      console.error('Proxy error (POST):', err.message);
      res.status(500).json({ error: 'Proxy failed (POST): ' + err.message });
    }
    return;
  }

  // ==================== GET: FETCH ORDER ====================
  if (req.method === 'GET') {
    if (!query) return res.status(400).json({ error: 'Missing query parameter' });
    let data;
    let customerId = null;
    try {
      // 1. Find customer if contact provided
      if (contact) {
        const contactField = contact.includes('@') ? 'email' : 'phone';
        const customerUrl = `https://${storeDomain}/admin/api/2024-07/customers/search.json?query=${contactField}:${encodeURIComponent(contact)}`;
        const customerResponse = await fetch(customerUrl, { headers: { 'X-Shopify-Access-Token': token } });
        if (!customerResponse.ok) throw new Error(await customerResponse.text());
        const customerData = await customerResponse.json();
        if (customerData.customers.length === 0) return res.status(404).json({ error: 'Customer not found' });
        customerId = customerData.customers[0].id;
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
      if (!data.orders || data.orders.length === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }
      // ENSURE ONLY ONE ORDER IS RETURNED
      const cleanQuery = query.replace('#', '');
      const exactOrder = data.orders.find(o => o.name === `#${cleanQuery}` || String(o.order_number) === cleanQuery);
      const order = exactOrder || data.orders[0];
      data.orders = [order];
      // ==================== TRACKING & DELIVERY DATE ====================
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
            }
          }
        } catch (e) {
          console.warn(`eShipz tracking failed for AWB ${awb}:`, e.message);
          currentShippingStatus = 'Unknown';
        }
      }
      order.actual_delivery_date = actualDeliveryDate || null;
      order.delivered_at = actualDeliveryDate || null;
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
      // ==================== PRODUCT IMAGES & VARIANTS ====================
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
      // ==================== FINAL DUPLICATE PROTECTION + REFERENCE (PERFECT) ====================
      const tags = (order.tags || '').toLowerCase();
      const note = (order.note || '').toLowerCase();
      // Case 1: Original order → show replacement
      if (tags.includes('exchange-processed') || tags.includes('return-processed')) {
        if (customerId) {
          const allRes = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json?customer_id=${customerId}&limit=250`, {
            headers: { 'X-Shopify-Access-Token': token }
          });
          const all = (await allRes.json()).orders || [];
          const replacement = all.find(o => o.note && o.note.toLowerCase().includes(order.name.toLowerCase()));
          if (replacement) {
            data.already_processed = true;
            data.exchange_order_name = replacement.name;
            data.related_order = replacement;
          } else {
            data.already_processed = true;
            data.exchange_order_name = "Processed";
          }
        } else {
          data.already_processed = true;
          data.exchange_order_name = "Processed";
        }
      }
      // Case 2: Replacement order → show original
      else if (note.includes('exchange for') || tags.includes('exchange-order') || tags.includes('portal-created')) {
        data.already_processed = true;
        data.exchange_order_name = order.name;
        const match = note.match(/exchange for [#]?(\d+)/i);
        if (match) {
          const origRes = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json?name=#${match[1]}`, {
            headers: { 'X-Shopify-Access-Token': token }
          });
          const origData = await origRes.json();
          if (origData.orders?.[0]) {
            data.related_order = origData.orders[0];
          }
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
