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
  const { action, order, customer_id, order_id, return_items, selected_line_items, original_order_id } = req.body || {};
  const token = process.env.SHOPIFY_API_TOKEN;
  const storeDomain = 'trueweststore.myshopify.com';

  // ==================== POST: SUBMIT RETURN REQUEST (✅ ENTERPRISE APPROACH) ====================
  if (req.method === 'POST' && action === 'submit_return' && order_id && return_items) {
    try {
      // ✅ STEP 1: Query returnable fulfillments using GraphQL (Shopify's recommended approach)
      const returnableQuery = `
        query returnableFulfillmentsQuery($orderId: ID!) {
          returnableFulfillments(orderId: $orderId, first: 10) {
            edges {
              node {
                id
                fulfillment {
                  id
                }
                returnableFulfillmentLineItems(first: 50) {
                  edges {
                    node {
                      fulfillmentLineItem {
                        id
                        lineItem {
                          id
                        }
                      }
                      quantity
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const returnableRes = await fetch(`https://${storeDomain}/admin/api/2024-07/graphql.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: returnableQuery,
          variables: { orderId: `gid://shopify/Order/${order_id}` }
        })
      });

      if (!returnableRes.ok) {
        const errorText = await returnableRes.text();
        throw new Error(`GraphQL request failed (${returnableRes.status}): ${errorText}`);
      }

      const returnableData = await returnableRes.json();

      if (returnableData.errors) {
        throw new Error(`GraphQL errors: ${JSON.stringify(returnableData.errors)}`);
      }

      const returnableFulfillments = returnableData.data?.returnableFulfillments?.edges || [];

      console.log('=== RETURN REQUEST DEBUG ===');
      console.log('Order ID:', order_id);
      console.log('Returnable Fulfillments Found:', returnableFulfillments.length);

      // ✅ Check if order has any returnable fulfillments
      if (returnableFulfillments.length === 0) {
        return res.status(400).json({
          error: 'Order not eligible for return',
          message: 'Your order has not been delivered yet or is not eligible for returns.',
          code: 'NO_RETURNABLE_FULFILLMENTS'
        });
      }

      // ✅ STEP 2: Build line item mapping (fulfillment line item ID → line item ID)
      const fulfillmentLineItemMap = {};
      const lineItemToFulfillmentMap = {};

      returnableFulfillments.forEach(edge => {
        const returnableItems = edge.node.returnableFulfillmentLineItems.edges || [];
        returnableItems.forEach(item => {
          const fliId = item.node.fulfillmentLineItem.id;
          const liId = item.node.fulfillmentLineItem.lineItem.id;
          const cleanFliId = fliId.split('/').pop();
          const cleanLiId = liId.split('/').pop();

          fulfillmentLineItemMap[cleanFliId] = item.node.fulfillmentLineItem;
          lineItemToFulfillmentMap[cleanLiId] = fliId; // Store full GID
        });
      });

      console.log('Line Item Mapping:', lineItemToFulfillmentMap);

      // ✅ STEP 3: Build return line items from frontend payload
      const returnLineItems = [];
      const failedItems = [];

      for (const returnItem of return_items) {
        const lineItemId = String(returnItem.line_item_id); // Convert to string for comparison
        const fulfillmentLineItemId = lineItemToFulfillmentMap[lineItemId];

        if (!fulfillmentLineItemId) {
          console.warn(`No returnable fulfillment found for line item ${lineItemId}`);
          failedItems.push({
            line_item_id: lineItemId,
            reason: 'Item not eligible for return or not yet fulfilled'
          });
          continue;
        }

        // ✅ Map frontend reasons to Shopify enum values
        const reasonMap = {
          'size': 'SIZE_TOO_SMALL',
          'defective': 'DEFECTIVE',
          'quality': 'NOT_AS_DESCRIBED',
          'other': 'OTHER'
        };

        const returnReason = reasonMap[returnItem.reason] || 'OTHER';
        const customerNote = returnItem.comment || `Return reason: ${returnItem.reason}`;

        returnLineItems.push({
          fulfillmentLineItemId: fulfillmentLineItemId, // Already in GID format
          quantity: returnItem.quantity || 1,
          returnReason: returnReason,
          customerNote: customerNote
        });
      }

      // ✅ Validate we have items to return
      if (returnLineItems.length === 0) {
        return res.status(400).json({
          error: 'Cannot create return',
          message: 'No eligible items found for return. Please contact support at truewest.info@gmail.com',
          code: 'NO_VALID_ITEMS',
          failed_items: failedItems
        });
      }

      // ✅ STEP 4: Create return using returnRequest mutation (Shopify's official approach)
      const returnRequestMutation = `
        mutation returnRequest($input: ReturnRequestInput!) {
          returnRequest(input: $input) {
            userErrors {
              field
              message
            }
            return {
              id
              name
              status
              returnLineItems(first: 50) {
                edges {
                  node {
                    id
                    returnReason
                    customerNote
                    quantity
                  }
                }
              }
              order {
                id
                name
              }
            }
          }
        }
      `;

      const variables = {
        input: {
          orderId: `gid://shopify/Order/${order_id}`,
          returnLineItems: returnLineItems
        }
      };

      const returnRequestRes = await fetch(`https://${storeDomain}/admin/api/2024-07/graphql.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: returnRequestMutation,
          variables: variables
        })
      });

      if (!returnRequestRes.ok) {
        const errorText = await returnRequestRes.text();
        throw new Error(`Return request failed (${returnRequestRes.status}): ${errorText}`);
      }

      const returnRequestData = await returnRequestRes.json();

      if (returnRequestData.errors) {
        throw new Error(`GraphQL errors: ${JSON.stringify(returnRequestData.errors)}`);
      }

      const returnRequest = returnRequestData.data.returnRequest;

      if (returnRequest.userErrors && returnRequest.userErrors.length > 0) {
        const errorMessages = returnRequest.userErrors.map(e => e.message).join(', ');
        throw new Error(`Return creation failed: ${errorMessages}`);
      }

      const createdReturn = returnRequest.return;

      console.log('✅ Return created successfully:', createdReturn.name);

      // ✅ Update original order with return tag
      if (order_id) {
        try {
          await fetch(`https://${storeDomain}/admin/api/2024-07/orders/${order_id}.json`, {
            method: 'PUT',
            headers: { 
              'X-Shopify-Access-Token': token, 
              'Content-Type': 'application/json' 
            },
            body: JSON.stringify({
              order: {
                tags: "return-requested,portal-created",
                note: `RETURN REQUESTED via Portal → Return: ${createdReturn.name}`
              }
            })
          });
        } catch (tagErr) {
          console.warn('Warning: Could not tag original order:', tagErr.message);
        }
      }

      res.json({
        success: true,
        message: "Return request created successfully!",
        return_id: createdReturn.id,
        return_name: createdReturn.name,
        status: createdReturn.status,
        order_name: createdReturn.order.name
      });

    } catch (err) {
      console.error('❌ Return request error:', err.message);
      res.status(500).json({ 
        error: 'Return failed: ' + err.message,
        code: 'RETURN_ERROR',
        details: err.toString()
      });
    }
    return;
  }

  // ==================== POST: CREATE EXCHANGE DRAFT (✅ FIXED - PRODUCT PRICE = 0) ====================
  if (req.method === 'POST' && action === 'submit_exchange' && order && customer_id && selected_line_items) {
    try {
      const originalOrderName = order.name || 'Unknown Order';

      // Count previous exchanges
      const customerOrdersRes = await fetch(
        `https://${storeDomain}/admin/api/2024-07/orders.json?customer_id=${customer_id}&status=any&limit=250&fields=tags`,
        { headers: { 'X-Shopify-Access-Token': token } }
      );
      const customerOrders = (await customerOrdersRes.json()).orders || [];
      const previousExchanges = customerOrders.filter(o => 
        (o.tags || '').toLowerCase().includes('exchange-processed')
      ).length;
      const isFirstExchange = previousExchanges === 0;

      let totalPriceDifference = 0;
      let totalCustomFees = 0;
      let totalExchangeFees = 0;
      const draftLineItems = [];
      let hasCustomSize = false;

      for (const selected of selected_line_items) {
        const originalPrice = parseFloat(selected.price || 0);
        let newPrice = originalPrice;
        let variantTitle = 'Custom Size Item';
        let productId = selected.product_id;
        let productTitle = selected.title || 'Custom Item';

        const isCustom = selected.is_custom_size === true;
        let variantId = selected.original_variant_id;

        if (isCustom) {
          hasCustomSize = true;
          variantId = selected.original_variant_id;
          variantTitle = 'Custom Size';
        } else if (selected.variant_id) {
          variantId = selected.variant_id;

          const variantRes = await fetch(
            `https://${storeDomain}/admin/api/2024-07/variants/${selected.variant_id}.json`,
            { headers: { 'X-Shopify-Access-Token': token } }
          );
          if (variantRes.ok) {
            const variantData = await variantRes.json();
            newPrice = parseFloat(variantData.variant.price || originalPrice);
            variantTitle = variantData.variant.title || 'Selected Size';
          }
        }

        if (productId) {
          const productRes = await fetch(
            `https://${storeDomain}/admin/api/2024-07/products/${productId}.json`,
            { headers: { 'X-Shopify-Access-Token': token } }
          );
          if (productRes.ok) {
            const prodData = await productRes.json();
            const product = prodData.product;
            productTitle = product.title;
          }
        }

        let customProperties = [];
        if (isCustom && selected.custom_measurements) {
          const m = selected.custom_measurements;
          customProperties = [
            { name: 'Exchange Type', value: 'Custom Size' },
            { name: 'Original Size', value: selected.current_size || 'N/A' },
            { name: 'Bust', value: `${m.bust || '-'} inches` },
            { name: 'Waist', value: `${m.waist || '-'} inches` },
            { name: 'Hips', value: `${m.hips || '-'} inches` },
            { name: 'Shoulder', value: `${m.shoulder || '-'} inches` },
            { name: 'Length', value: `${m.length || '-'} inches` }
          ];
        } else {
          customProperties = [
            { name: 'Exchange Type', value: 'Size Change' },
            { name: 'Original Size', value: selected.current_size || 'N/A' },
            { name: 'New Size', value: variantTitle }
          ];
        }

        draftLineItems.push({
          product_id: productId,
          variant_id: variantId,
          quantity: 1,
          price: "0.00",
          title: isCustom ? `${productTitle} - Custom Size` : productTitle,
          properties: customProperties,
          taxable: true,
          requires_shipping: true
        });

        const priceDiff = newPrice - originalPrice;
        totalPriceDifference += priceDiff;

        if (isCustom) {
          totalCustomFees += 200;
        }
      }

      if (!isFirstExchange) {
        totalExchangeFees += 200;
      }

      if (totalCustomFees > 0) {
        draftLineItems.push({
          title: `Custom Size Fee (${totalCustomFees / 200} item${totalCustomFees > 200 ? 's' : ''})`,
          price: totalCustomFees.toFixed(2),
          quantity: 1,
          taxable: false,
          custom: true
        });
      }

      if (totalExchangeFees > 0) {
        draftLineItems.push({
          title: "Exchange Processing Fee",
          price: totalExchangeFees.toFixed(2),
          quantity: 1,
          taxable: false,
          custom: true
        });
      }

      if (totalPriceDifference !== 0) {
        draftLineItems.push({
          title: totalPriceDifference > 0 ? "Price Difference" : "Price Adjustment (Store Credit)",
          price: totalPriceDifference.toFixed(2),
          quantity: 1,
          taxable: false,
          custom: true
        });
      }

      const totalAmountDue = totalPriceDifference + totalCustomFees + totalExchangeFees;

      let draftTags = "exchange-draft,portal-created,exchange-portal,exchange-requested";
      if (hasCustomSize) {
        draftTags += ",custom-size-exchange";
      }

      const itemSummary = selected_line_items.map((item, idx) => {
        const type = item.is_custom_size ? 'Custom Size' : 'Size Change';
        return `Item ${idx + 1}: ${item.title} (${type})`;
      }).join(' | ');

      const draftPayload = {
        draft_order: {
          line_items: draftLineItems,
          customer: { id: customer_id },
          email: order.email,
          shipping_address: order.shipping_address,
          billing_address: order.billing_address || order.shipping_address,
          note: `EXCHANGE for Order ${originalOrderName} | ${itemSummary} | Total Items: ${selected_line_items.length}`,
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

      if (!draftRes.ok) {
        const errorText = await draftRes.text();
        throw new Error('Draft creation failed: ' + errorText);
      }

      const draftData = await draftRes.json();
      const draftId = draftData.draft_order.id;
      const draftOrderName = draftData.draft_order.name;

      if (original_order_id) {
        try {
          await fetch(`https://${storeDomain}/admin/api/2024-07/orders/${original_order_id}.json`, {
            method: 'PUT',
            headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              order: {
                tags: "exchange-in-progress,portal-exchange",
                note: `EXCHANGE REQUESTED → Draft Order: ${draftOrderName}`
              }
            })
          });
        } catch (tagErr) {
          console.warn('Warning: Could not tag original order:', tagErr.message);
        }
      }

      if (totalAmountDue <= 0) {
        const completeRes = await fetch(
          `https://${storeDomain}/admin/api/2024-07/draft_orders/${draftId}/complete.json`,
          {
            method: 'PUT',
            headers: { 'X-Shopify-Access-Token': token }
          }
        );

        if (!completeRes.ok) {
          const errorText = await completeRes.text();
          throw new Error('Draft completion failed: ' + errorText);
        }

        const completeData = await completeRes.json();
        const completedOrder = completeData.draft_order;
        const completedOrderName = completedOrder.name || `#${completedOrder.order_id}`;

        if (original_order_id) {
          try {
            await fetch(`https://${storeDomain}/admin/api/2024-07/orders/${original_order_id}.json`, {
              method: 'PUT',
              headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                order: {
                  tags: "exchange-processed,portal-exchange",
                  note: `EXCHANGED → New Order: ${completedOrderName}`
                }
              })
            });
          } catch (updateErr) {
            console.warn('Warning: Could not update original order:', updateErr.message);
          }
        }

        res.json({ 
          success: true, 
          exchange_order: completedOrder,
          message: "Exchange order created successfully! No payment required.",
          amount_due: 0
        });

      } else {
        try {
          const invoiceRes = await fetch(
            `https://${storeDomain}/admin/api/2024-07/draft_orders/${draftId}/send_invoice.json`,
            {
              method: 'POST',
              headers: {
                'X-Shopify-Access-Token': token,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                draft_order_invoice: {
                  to: order.email,
                  from: 'trueweststore@gmail.com',
                  subject: `Payment Required for Exchange - Order ${originalOrderName}`,
                  custom_message: `Hi! To complete your exchange, please pay ₹${totalAmountDue.toFixed(2)}. This includes:\n\n` +
                    (totalPriceDifference > 0 ? `• Price Difference: ₹${totalPriceDifference.toFixed(2)}\n` : '') +
                    (totalPriceDifference < 0 ? `• Store Credit Applied: ₹${Math.abs(totalPriceDifference).toFixed(2)}\n` : '') +
                    (totalCustomFees > 0 ? `• Custom Size Fee: ₹${totalCustomFees.toFixed(2)}\n` : '') +
                    (totalExchangeFees > 0 ? `• Exchange Fee: ₹${totalExchangeFees.toFixed(2)}\n` : '') +
                    `\nClick the button below to complete payment.`
                }
              })
            }
          );

          if (!invoiceRes.ok) {
            const errorText = await invoiceRes.text();
            console.warn('Invoice sending failed:', errorText);
          }
        } catch (invoiceErr) {
          console.warn('Warning: Could not send invoice email:', invoiceErr.message);
        }

        res.json({ 
          success: true, 
          payment_url: draftData.draft_order.invoice_url,
          draft_id: draftId,
          draft_order_name: draftOrderName,
          amount_due: totalAmountDue.toFixed(2),
          breakdown: {
            price_difference: totalPriceDifference.toFixed(2),
            custom_size_fees: totalCustomFees.toFixed(2),
            exchange_fees: totalExchangeFees.toFixed(2)
          },
          message: "Payment required to complete exchange. Invoice email sent to customer."
        });
      }

    } catch (err) {
      console.error('Proxy error (Exchange):', err.message);
      res.status(500).json({ 
        error: 'Exchange failed: ' + err.message,
        code: 'EXCHANGE_ERROR',
        details: err.toString()
      });
    }
    return;
  }

  // ==================== GET: FETCH ORDER (UNCHANGED) ====================
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

      if (!customerId && order.customer) {
        customerId = order.customer.id;
      }

      if (customerId) {
        try {
          const customerOrdersRes = await fetch(
            `https://${storeDomain}/admin/api/2024-07/orders.json?customer_id=${customerId}&status=any&limit=250&fields=tags`,
            { headers: { 'X-Shopify-Access-Token': token } }
          );
          if (customerOrdersRes.ok) {
            const customerOrders = (await customerOrdersRes.json()).orders || [];
            const exchangeCount = customerOrders.filter(o => 
              (o.tags || '').toLowerCase().includes('exchange-processed')
            ).length;
            data.exchange_count = exchangeCount;
          }
        } catch (exchangeCountErr) {
          console.warn('Warning: Could not fetch exchange count:', exchangeCountErr.message);
          data.exchange_count = 0;
        }
      } else {
        data.exchange_count = 0;
      }

      const fulfillment = order.fulfillments?.[0];
      let actualDeliveryDate = null;
      let currentShippingStatus = 'Processing';

      if (fulfillment?.tracking_number) {
        const awb = fulfillment.tracking_number.trim();
        try {
          const trackUrl = `https://track.eshipz.com/track?awb=${awb}`;
          const trackRes = await fetch(trackUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
          });
          const html = await trackRes.text();

          if (html.toLowerCase().includes('delivered')) {
            const patterns = [
              /(\d{2}\/\d{2}\/\d{4})/i,
              /(\d{1,2}\s[A-Za-z]{3,9}\s\d{4})/i,
              /(\d{4}-\d{2}-\d{2})/i
            ];
            let deliveryMatch = null;
            for (const pattern of patterns) {
              deliveryMatch = html.match(pattern);
              if (deliveryMatch) break;
            }
            if (deliveryMatch) {
              actualDeliveryDate = deliveryMatch[1];
              currentShippingStatus = 'Delivered';
            }
          } else if (html.toLowerCase().includes('in transit') || html.includes('dispatched')) {
            currentShippingStatus = 'In Transit';
          } else if (html.toLowerCase().includes('picked up')) {
            currentShippingStatus = 'Picked Up';
          }
        } catch (e) {
          console.warn(`Tracking failed for AWB ${awb}:`, e.message);
          currentShippingStatus = order.fulfillment_status === 'fulfilled' ? 'Delivered' : 'Unknown';
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
        if (item.product_id) {
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
            price: v.price,
            inventory_quantity: v.inventory_quantity,
            available: v.inventory_quantity > 0
          })) || [];

          const currentVariant = product?.variants?.find(v => v.id === item.variant_id);
          if (currentVariant) {
            item.current_size = currentVariant.title;
            item.current_inventory = currentVariant.inventory_quantity;
          }
        } else {
          item.image_url = 'https://via.placeholder.com/80';
          item.available_variants = [];
        }
      }

      const tags = (order.tags || '').toLowerCase();
      const note = (order.note || '').toLowerCase();

      if (tags.includes('exchange-processed') || tags.includes('return-processed')) {
        if (customerId) {
          const allRes = await fetch(
            `https://${storeDomain}/admin/api/2024-07/orders.json?customer_id=${customerId}&limit=250`, 
            { headers: { 'X-Shopify-Access-Token': token } }
          );
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
      } else if (note.includes('exchange for') || tags.includes('exchange-order') || tags.includes('portal-created')) {
        data.already_processed = true;
        data.exchange_order_name = order.name;
        const match = note.match(/exchange for [#]?(\d+)/i);
        if (match) {
          const origRes = await fetch(
            `https://${storeDomain}/admin/api/2024-07/orders.json?name=#${match[1]}`, 
            { headers: { 'X-Shopify-Access-Token': token } }
          );
          const origData = await origRes.json();
          if (origData.orders?.[0]) {
            data.related_order = origData.orders[0];
          }
        }
      }

      res.json(data);

    } catch (err) {
      console.error('Proxy error:', err.message);
      res.status(500).json({ 
        error: err.message,
        code: 'ORDER_FETCH_ERROR',
        details: err.toString()
      });
    }
    return;
  }

  res.status(400).json({ error: 'Invalid request' });
};
