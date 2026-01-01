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
  const { action, order, customer_id, order_id, return_items } = req.body || {};
  const token = process.env.SHOPIFY_API_TOKEN;
  const storeDomain = 'trueweststore.myshopify.com';

  // ==================== POST: SUBMIT RETURN REQUEST ====================
  if (req.method === 'POST' && action === 'submit_return' && order_id && return_items) {
    try {
      await fetch(`https://${storeDomain}/admin/api/2024-07/orders/${order_id}.json`, {
        method: 'PUT',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order: {
            tags: "return-processed,portal-return",
            note: `RETURN REQUESTED via Portal | Items: ${return_items.map(i => i.quantity + 'x line_item ' + i.line_item_id).join(', ')}`
          }
        })
      });

      res.json({
        success: true,
        message: "Return request created successfully!"
      });
    } catch (err) {
      console.error('Proxy error (Return):', err.message);
      res.status(500).json({ error: 'Return failed: ' + err.message });
    }
    return;
  }

  // ==================== POST: CREATE EXCHANGE DRAFT ====================
  if (req.method === 'POST' && action === 'submit_exchange' && order && customer_id) {
    try {
      const originalOrderName = order.name || 'Unknown Order';
      const isCustom = !order.order.line_items[0].variant_id;

      // 1. Check previous exchanges for fee
      const customerOrdersRes = await fetch(
        `https://${storeDomain}/admin/api/2024-07/orders.json?customer_id=${customer_id}&status=any&limit=250&fields=tags`,
        { headers: { 'X-Shopify-Access-Token': token } }
      );
      const customerOrders = (await customerOrdersRes.json()).orders || [];
      const previousExchanges = customerOrders.filter(o => 
        (o.tags || '').toLowerCase().includes('exchange-processed')
      ).length;
      const addFee = previousExchanges > 0;

      // 2. Get original line item details
      const frontendLineItem = order.order.line_items[0];
      const originalPrice = parseFloat(frontendLineItem.price || 0);
      let newPrice = originalPrice;
      let variantTitle = 'Custom Size Item';
      let productId = frontendLineItem.product_id;
      let productTitle = frontendLineItem.title || 'Custom Item';
      let productImage = 'https://via.placeholder.com/80';

      if (frontendLineItem.variant_id) {
        const variantRes = await fetch(
          `https://${storeDomain}/admin/api/2024-07/variants/${frontendLineItem.variant_id}.json`,
          { headers: { 'X-Shopify-Access-Token': token } }
        );
        if (variantRes.ok) {
          const variantData = await variantRes.json();
          newPrice = parseFloat(variantData.variant.price || originalPrice);
          variantTitle = variantData.variant.title || 'Selected Size';
        }
      }

      // 3. For custom — fetch original product title & image
      if (isCustom && productId) {
        const productRes = await fetch(
          `https://${storeDomain}/admin/api/2024-07/products/${productId}.json`,
          { headers: { 'X-Shopify-Access-Token': token } }
        );
        if (productRes.ok) {
          const prodData = await productRes.json();
          const product = prodData.product;
          productTitle = product.title;
          productImage = product.images?.[0]?.src || productImage;
        }
      }

      // 4. Custom measurements note
      let customNote = '';
      let customProperties = {};
      if (isCustom && order.order.custom_measurements) {
        const m = order.order.custom_measurements;
        customNote = ` | Custom: Bust ${m.bust || '-'}", Waist ${m.waist || '-'}", Hips ${m.hips || '-'}", Shoulder ${m.shoulder || '-'}", Length ${m.length || '-'}in`;
        customProperties = {
          "Custom Measurements": `Bust ${m.bust || '-'}", Waist ${m.waist || '-'}", Hips ${m.hips || '-'}", Shoulder ${m.shoulder || '-'}", Length ${m.length || '-'}in`
        };
      }

      // 5. Calculate total additional
      let totalAdditional = newPrice - originalPrice;
      if (addFee) totalAdditional += 200;

      // 6. Build line items — USE ORIGINAL PRODUCT IMAGE/TITLE FOR CUSTOM
      const draftLineItems = [
        {
          product_id: productId,
          variant_id: frontendLineItem.variant_id || null,
          quantity: 1,
          price: newPrice.toFixed(2),
          title: isCustom ? `${productTitle} - Custom Size` : variantTitle,
          name: isCustom ? `${productTitle} - Custom Size` : variantTitle,
          properties: isCustom ? customProperties : {},
          taxable: true,
          requires_shipping: true
        }
      ];

      const priceDiff = newPrice - originalPrice;
      if (priceDiff !== 0) {
        draftLineItems.push({
          title: priceDiff > 0 ? "Price Difference" : "Price Adjustment Refund",
          price: priceDiff.toFixed(2),
          quantity: 1,
          taxable: false
        });
      }

      if (addFee) {
        draftLineItems.push({
          title: "Exchange Fee",
          price: "200.00",
          quantity: 1,
          taxable: false
        });
      }

      // 7. Tags
      let draftTags = "exchange-draft,portal-created,exchange-portal,exchange-requested,exchange-in-progress";
      if (isCustom) draftTags += ",custom-size-exchange";

      // 8. Create draft
      const draftPayload = {
        draft_order: {
          line_items: draftLineItems,
          customer: { id: customer_id },
          email: order.order.email,
          shipping_address: order.order.shipping_address,
          billing_address: order.order.billing_address || order.order.shipping_address,
          note: `EXCHANGE for Order ${originalOrderName} | Portal Request${customNote}`,
          tags: draftTags,
          requires_shipping: true
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

      // 9. Payment or auto-complete
      if (totalAdditional <= 0) {
        const completeRes = await fetch(`https://${storeDomain}/admin/api/2024-07/draft_orders/${draftId}/complete.json?payment_pending=true`, {
          method: 'PUT',
          headers: { 'X-Shopify-Access-Token': token }
        });
        if (!completeRes.ok) throw new Error(await completeRes.text());
        const completeData = await completeRes.json();
        res.json({ success: true, exchange_order: completeData.order });
      } else {
        const invoiceRes = await fetch(`https://${storeDomain}/admin/api/2024-07/draft_orders/${draftId}/send_invoice.json`, {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            draft_order_invoice: {
              to: order.order.email,
              subject: `Payment Required for Exchange - Order ${originalOrderName}`,
              custom_message: `Please pay ₹${totalAdditional.toFixed(2)} to complete your exchange.`
            }
          })
        });
        if (!invoiceRes.ok) throw new Error(await invoiceRes.text());
        const invoiceData = await invoiceRes.json();
        res.json({ success: true, payment_url: invoiceData.draft_order.invoice_url });
      }

      // 10. Tag original
      const origRes = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json?name=${originalOrderName}`, {
        headers: { 'X-Shopify-Access-Token': token }
      });
      const origData = await origRes.json();
      if (origData.orders?.[0]) {
        await fetch(`https://${storeDomain}/admin/api/2024-07/orders/${origData.orders[0].id}.json`, {
          method: 'PUT',
          headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            order: {
              tags: "exchange-processed,portal-exchange,exchange-in-progress",
              note: `EXCHANGE REQUESTED → Draft #${draftId}${customNote}`
            }
          })
        });
      }

    } catch (err) {
      console.error('Proxy error (POST):', err.message);
      res.status(500).json({ error: 'Exchange failed: ' + err.message });
    }
    return;
  }

  // ==================== GET: FETCH ORDER ====================
  if (req.method === 'GET') {
    if (!query) return res.status(400).json({ error: 'Missing query parameter' });
    let data;
    let customerId = null;
    try {
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
      const cleanQuery = query.replace('#', '');
      const exactOrder = data.orders.find(o => o.name === `#${cleanQuery}` || String(o.order_number) === cleanQuery);
      const order = exactOrder || data.orders[0];
      data.orders = [order];

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
      for (let item of order.line_items) {
        const productRes = await fetch(
          `https://${storeDomain}/admin/api/2024-07/products/${item.product_id}.json?fields=id,title,images,variants`,
          { headers: { 'X-Shopify-Access-Token': token } }
        );
        const productData = await productRes.json();
        const product = productData.product;
        item.image_url = product?.images?.[0]?.src || 'https://via.placeholder.com/80';
        item.available_variants = product?.variants?.map(v => ({
          id: v.id,
          title: v.title,
          inventory_quantity: v.inventory_quantity,
          available: v.inventory_quantity > 0
        })) || [];
        const currentVariant = product?.variants?.find(v => v.id === item.variant_id);
        if (currentVariant) {
          item.current_size = currentVariant.title;
          item.current_inventory = currentVariant.inventory_quantity;
        }
      }
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
