const fetch = require('node-fetch');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { query, contact } = req.query || {};
  const { action, order, customer_id, order_id, return_items, selected_line_items, original_order_id } = req.body || {};
  const token = process.env.SHOPIFY_API_TOKEN;
  const storeDomain = 'trueweststore.myshopify.com';

  // ==================== POST: SUBMIT RETURN REQUEST (✅ UNCHANGED) ====================
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
          message: 'No eligible items found for return. Please contact support at truewest.care@gmail.com',
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

  // ==================== POST: CREATE EXCHANGE DRAFT (✅ FIXED - CUSTOM SIZE CAPTURE) ====================
  if (req.method === 'POST' && action === 'submit_exchange' && order && customer_id && selected_line_items) {
    try {
      // ✅ DEBUG: Log incoming data to verify custom measurements
      console.log('=== EXCHANGE REQUEST RECEIVED ===');
      console.log('Number of items:', selected_line_items.length);
      selected_line_items.forEach((item, idx) => {
        console.log(`Item ${idx + 1}:`, {
          title: item.title,
          is_custom_size: item.is_custom_size,
          has_measurements: !!item.custom_measurements,
          measurements: item.custom_measurements
        });
      });

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
        // ✅ DEBUG: Log each item processing
        console.log('=== PROCESSING ITEM ===');
        console.log('Title:', selected.title);
        console.log('is_custom_size:', selected.is_custom_size);
        console.log('custom_measurements:', JSON.stringify(selected.custom_measurements));

        const originalPrice = parseFloat(selected.price || 0);
        let newPrice = originalPrice;
        let variantTitle = 'N/A';
        let productId = selected.product_id;
        let productTitle = selected.title || 'Custom Item';

        const isCustom = selected.is_custom_size === true;
        let variantId = selected.original_variant_id;

        if (isCustom) {
          hasCustomSize = true;
          variantId = selected.original_variant_id;
          variantTitle = 'Custom Size';
          console.log('✅ Identified as CUSTOM SIZE');
        } else if (selected.variant_id) {
          variantId = selected.variant_id;

          const variantRes = await fetch(
            `https://${storeDomain}/admin/api/2024-07/variants/${selected.variant_id}.json`,
            { headers: { 'X-Shopify-Access-Token': token } }
          );
          if (variantRes.ok) {
            const variantData = await variantRes.json();
            newPrice = parseFloat(variantData.variant.price || originalPrice);
            variantTitle = variantData.variant.title || 'N/A';
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

        // ✅ FIXED: Custom size properties with measurements
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
          console.log('✅ Custom measurements captured in properties:', customProperties);
        } else {
          customProperties = [
            { name: 'Exchange Type', value: 'Size Change' },
            { name: 'Original Size', value: selected.current_size || 'N/A' },
            { name: 'New Size', value: variantTitle }
          ];
          console.log('ℹ️ Regular size change properties:', customProperties);
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

      // ✅ IMPROVED: Add custom measurements to order note for visibility
      let orderNote = `EXCHANGE for Order ${originalOrderName} | ${itemSummary} | Total Items: ${selected_line_items.length}`;

      const customSizeDetails = selected_line_items
        .filter(item => item.is_custom_size && item.custom_measurements)
        .map((item, idx) => {
          const m = item.custom_measurements;
          return `\n\nCUSTOM SIZE ${idx + 1}: ${item.title}\nBust: ${m.bust || 'N/A'}" | Waist: ${m.waist || 'N/A'}" | Hips: ${m.hips || 'N/A'}" | Shoulder: ${m.shoulder || 'N/A'}" | Length: ${m.length || 'N/A'}"`;
        })
        .join('');

      if (customSizeDetails) {
        orderNote += customSizeDetails;
        console.log('✅ Custom measurements added to order note');
      }

      const draftPayload = {
        draft_order: {
          line_items: draftLineItems,
          customer: { id: customer_id },
          email: order.email,
          shipping_address: order.shipping_address,
          billing_address: order.billing_address || order.shipping_address,
          note: orderNote,
          tags: draftTags,
          requires_shipping: true
        }
      };

      console.log('📤 Creating draft order with payload...');

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

      console.log('✅ Draft order created:', draftOrderName);

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

  // ==================== GET: FETCH ORDER (✅ UNCHANGED) ====================
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

      // ✅ CARRIER-BASED DELIVERY DETECTION
      const fulfillment = order.fulfillments?.[0];
      let actualDeliveryDate = null;
      let currentShippingStatus = 'Processing';

      if (fulfillment) {
        const trackingCompany = (fulfillment.tracking_company || '').toLowerCase();
        const trackingNumber = fulfillment.tracking_number?.trim();
        const shipmentStatus = fulfillment.shipment_status;
        
        const isDelhivery = trackingCompany.includes('delhivery');
        const isBluedart = trackingCompany.includes('bluedart') || trackingCompany.includes('blue dart');
        
        // ========== DELHIVERY: USE SHOPIFY DATA ==========
        if (isDelhivery) {
          if (shipmentStatus === 'delivered' || order.fulfillment_status === 'fulfilled') {
            currentShippingStatus = 'Delivered';
            
            if (fulfillment.updated_at) {
              const deliveryDate = new Date(fulfillment.updated_at);
              actualDeliveryDate = deliveryDate.toISOString().split('T')[0];
            }
          } else if (shipmentStatus === 'in_transit') {
            currentShippingStatus = 'In Transit';
          } else if (shipmentStatus === 'out_for_delivery') {
            currentShippingStatus = 'Out for Delivery';
          }
        }
        
// ========== BLUEDART: HYBRID JSON + HTML FALLBACK (FIXES DATE ISSUE) ==========
else if (isBluedart && trackingNumber) {
  try {
    const trackUrl = `https://track.eshipz.com/track?awb=${trackingNumber}`;
    const trackRes = await fetch(trackUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!trackRes.ok) throw new Error(`Eshipz returned ${trackRes.status}`);

    const html = await trackRes.text();

    console.log('=== BLUEDART / ESHIPZ DEBUG START ===');
    console.log('AWB:', trackingNumber);

    // === PART 1: Parse JSON for status/date (most reliable) ===
    let events = [];
    const jsonMatch = html.match(/var\s+response_data\s*=\s*(\[[\s\S]*?\]);/i);
    if (jsonMatch) {
      try {
        events = JSON.parse(jsonMatch[1]);
      } catch (e) {
        console.warn('JSON parse failed, falling back to HTML');
      }
    }

    let eshipzStatus = null;
    let deliveryDateFromJson = null; // will be ISO: YYYY-MM-DD

    if (events.length > 0) {
      // Strict delivered event
      const deliveredEvent = events.find(ev => {
        const tag    = (ev.tag    || '').toLowerCase().trim();
        const subtag = (ev.subtag || '').toLowerCase().trim();
        const msg    = (ev.message || '').toLowerCase().trim();

        const looksDelivered =
          tag === 'delivered' ||
          subtag === 'delivered' ||
          /\bdelivered\b/.test(msg);

        const looksFailure =
          /undelivered|not delivered|delivery failed|failed delivery|rto/.test(msg);

        return looksDelivered && !looksFailure;
      });

      if (deliveredEvent) {
        eshipzStatus = 'Delivered';
        const ts = deliveredEvent.checkpoint_time;
        if (ts) {
          const d = new Date(ts);
          if (!isNaN(d.getTime())) {
            // Store ISO for safe parsing on frontend: 2026-02-02
            deliveryDateFromJson = d.toISOString().split('T')[0]; // [web:441][web:389]
          }
        }
      } else {
        // No delivered event: map latest event to a live status (no date)
        const latest = events[0];
        const tag = (latest.tag || '').toLowerCase();
        const msg = (latest.message || '').toLowerCase();

        if (tag.includes('outfordelivery'))      currentShippingStatus = 'Out for Delivery';
        else if (tag.includes('intransit'))      currentShippingStatus = 'In Transit';
        else if (tag.includes('pickedup'))       currentShippingStatus = 'Picked Up';
        else if (tag.includes('info'))           currentShippingStatus = 'Info Received';
        else                                     currentShippingStatus = latest.message || 'Unknown';
      }
    }

    // === PART 2: If JSON didn't give status or date, fallback to HTML ===
    if (!eshipzStatus || !deliveryDateFromJson) {
      // Status from StatusBlockTitle
      const titleMatch = html.match(/<h4[^>]*id="StatusBlockTitle"[^>]*>([^<]+)<\/h4>/i);
      if (titleMatch) {
        eshipzStatus = titleMatch[1].trim();
      }

      // If still no status, try Remarks: <h5 id="Remarks">Status :<strong> Delivered</strong></h5>
      if (!eshipzStatus) {
        const remarksMatch = html.match(
          /<h5[^>]*id="Remarks"[^>]*>[^<]*<strong>\s*([^<]+)\s*<\/strong>/i
        );
        if (remarksMatch) {
          eshipzStatus = remarksMatch[1].trim();
        }
      }

      // Date from StatusBlock for Delivered
      if (/delivered/i.test(eshipzStatus || '')) {
        const dayMatch   = html.match(/<h1[^>]*id="StatusBlockDate"[^>]*>(\d+)<\/h1>/i);
        const monthMatch = html.match(/<h3[^>]*id="StatusBlockMonth"[^>]*>([^<]+)<\/h3>/i);
        const yearMatch  = html.match(/<h4[^>]*id="StatusBlockYear"[^>]*>(\d+)<\/h4>/i);

        if (dayMatch && monthMatch && yearMatch) {
          const day      = dayMatch[1].padStart(2, '0');
          const monthStr = monthMatch[1].trim().toLowerCase();
          const year     = yearMatch[1].trim();

          const monthMap = {
            jan: '01', january: '01',
            feb: '02', february: '02',
            mar: '03', march: '03',
            apr: '04', april: '04',
            may: '05',
            jun: '06', june: '06',
            jul: '07', july: '07',
            aug: '08', august: '08',
            sep: '09', september: '09',
            oct: '10', october: '10',
            nov: '11', november: '11',
            dec: '12', december: '12'
          };

          const month = monthMap[monthStr];
          if (month) {
            // Build ISO: YYYY-MM-DD (frontend will format as dd/mm/yyyy) [web:441][web:442]
            deliveryDateFromJson = `${year}-${month}-${day}`;
          }
        }

        // Optional extra fallback: first DD/MM/YYYY near "DELIVERED" row in table
        if (!deliveryDateFromJson) {
          const deliveredRowMatch = html.match(
            /(\d{2}\/\d{2}\/\d{4})[^<]{0,120}(SHIPMENT DELIVERED|DELIVERED|Delivered Successfully)/i
          );
          if (deliveredRowMatch) {
            const [dd, mm, yyyy] = deliveredRowMatch[1].split('/');
            if (dd && mm && yyyy) {
              deliveryDateFromJson = `${yyyy}-${mm}-${dd}`;
            }
          }
        }
      }
    }

    // === Final assignment ===
    if (eshipzStatus) {
      if (/delivered/i.test(eshipzStatus)) {
        currentShippingStatus = 'Delivered';
      } else if (/exception|failed|undelivered/i.test(eshipzStatus.toLowerCase())) {
        currentShippingStatus = 'Exception';
      } else if (/out for delivery/i.test(eshipzStatus.toLowerCase())) {
        currentShippingStatus = 'Out for Delivery';
      } else if (/in transit/i.test(eshipzStatus.toLowerCase())) {
        currentShippingStatus = 'In Transit';
      } else if (/picked|pickup/i.test(eshipzStatus.toLowerCase())) {
        currentShippingStatus = 'Picked Up';
      } else {
        currentShippingStatus = eshipzStatus;
      }
    }

    if (deliveryDateFromJson) {
      actualDeliveryDate = deliveryDateFromJson; // ISO string, e.g. "2026-02-02"
    }

    console.log('Final status:', currentShippingStatus);
    console.log('Final date (ISO):', actualDeliveryDate || 'Not found');
    console.log('=== BLUEDART / ESHIPZ DEBUG END ===');

  } catch (err) {
    console.warn(`Eshipz tracking failed for AWB ${trackingNumber}:`, err.message);
    // Fallback: never claim Delivered on failure
    currentShippingStatus = order.fulfillment_status === 'fulfilled' ? 'In Transit' : 'Unknown';
    // Do NOT guess date
  }
}
        // ========== UNKNOWN CARRIER: FALLBACK ==========
        else {
          if (order.fulfillment_status === 'fulfilled') {
            currentShippingStatus = 'Delivered';
            if (fulfillment.updated_at) {
              actualDeliveryDate = new Date(fulfillment.updated_at).toISOString().split('T')[0];
            }
          }
        }
      }

      order.actual_delivery_date = actualDeliveryDate;
      order.delivered_at = actualDeliveryDate;
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
  // ==================== ADMIN: AUTH CHECK ====================
  // All admin routes require x-admin-token header matching ADMIN_SECRET_TOKEN env var
  const adminToken = req.headers['x-admin-token'];
  const isAdmin = adminToken && adminToken === process.env.ADMIN_SECRET_TOKEN;

  // If token is present but wrong → reject immediately
  if (adminToken && !isAdmin) {
    return res.status(401).json({ error: 'Unauthorized', code: 'INVALID_ADMIN_TOKEN' });
  }

  // ==================== ADMIN POST: SUBMIT RETURN (with override) ====================
  if (req.method === 'POST' && isAdmin) {
    const {
      action: adminAction,
      order_id: adminOrderId,
      return_items: adminReturnItems,
      customer_id: adminCustomerId,
      order: adminOrder,
      selected_line_items: adminSelectedLineItems,
      original_order_id: adminOriginalOrderId,
      admin_override: adminOverride,
      admin_portal: adminPortal,
      fee_waived: feeWaived
    } = req.body || {};

    // ---------- ADMIN RETURN ----------
    if (adminAction === 'admin_submit_return' && adminOrderId && adminReturnItems) {
      try {
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

        const adminReturnableRes = await fetch(`https://${storeDomain}/admin/api/2024-07/graphql.json`, {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            query: returnableQuery,
            variables: { orderId: `gid://shopify/Order/${adminOrderId}` }
          })
        });

        if (!adminReturnableRes.ok) {
          const errorText = await adminReturnableRes.text();
          throw new Error(`GraphQL request failed (${adminReturnableRes.status}): ${errorText}`);
        }

        const adminReturnableData = await adminReturnableRes.json();

        if (adminReturnableData.errors) {
          throw new Error(`GraphQL errors: ${JSON.stringify(adminReturnableData.errors)}`);
        }

        const adminReturnableFulfillments = adminReturnableData.data?.returnableFulfillments?.edges || [];

        console.log('=== ADMIN RETURN REQUEST DEBUG ===');
        console.log('Admin Order ID:', adminOrderId);
        console.log('Returnable Fulfillments Found:', adminReturnableFulfillments.length);
        console.log('Admin Override:', adminOverride);

        // ✅ GUARD 1: No returnable fulfillments
        if (adminReturnableFulfillments.length === 0) {
          if (!adminOverride) {
            return res.status(400).json({
              error: 'Order not eligible for return',
              message: 'Order has no returnable fulfillments. Check admin_override to proceed manually.',
              code: 'NO_RETURNABLE_FULFILLMENTS',
              requires_override: true
            });
          }

          console.warn('⚠️ ADMIN OVERRIDE: No returnable fulfillments. Tagging order manually.');

          let manualReturnTags = 'admin-manual-return,return-requested,portal-created,admin-override';
          if (adminPortal) manualReturnTags += ',admin-portal';

          await fetch(`https://${storeDomain}/admin/api/2024-07/orders/${adminOrderId}.json`, {
            method: 'PUT',
            headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              order: {
                tags: manualReturnTags,
                note: `ADMIN MANUAL RETURN OVERRIDE → Items: ${adminReturnItems.map(i => i.line_item_id).join(', ')} | Reason: ${adminReturnItems[0]?.reason || 'N/A'} | Override: Order had no returnable fulfillments`
              }
            })
          });

          return res.json({
            success: true,
            admin_override: true,
            warning: 'Order had no returnable fulfillments. It has been tagged for manual return processing.',
            manual: true,
            order_id: adminOrderId
          });
        }

        // ✅ Build line item mapping
        const adminLineItemToFulfillmentMap = {};

        adminReturnableFulfillments.forEach(edge => {
          const returnableItems = edge.node.returnableFulfillmentLineItems.edges || [];
          returnableItems.forEach(item => {
            const fliId = item.node.fulfillmentLineItem.id;
            const liId = item.node.fulfillmentLineItem.lineItem.id;
            const cleanLiId = liId.split('/').pop();
            adminLineItemToFulfillmentMap[cleanLiId] = fliId;
          });
        });

        console.log('Admin Line Item Mapping:', adminLineItemToFulfillmentMap);

        // ✅ Build return line items
        const adminReturnLineItems = [];
        const adminFailedItems = [];

        for (const returnItem of adminReturnItems) {
          const lineItemId = String(returnItem.line_item_id);
          const fulfillmentLineItemId = adminLineItemToFulfillmentMap[lineItemId];

          if (!fulfillmentLineItemId) {
            console.warn(`Admin: No returnable fulfillment found for line item ${lineItemId}`);
            adminFailedItems.push({
              line_item_id: lineItemId,
              reason: 'Item not found in fulfillment records'
            });
            continue;
          }

          const reasonMap = {
            'size': 'SIZE_TOO_SMALL',
            'defective': 'DEFECTIVE',
            'quality': 'NOT_AS_DESCRIBED',
            'other': 'OTHER'
          };

          adminReturnLineItems.push({
            fulfillmentLineItemId: fulfillmentLineItemId,
            quantity: returnItem.quantity || 1,
            returnReason: reasonMap[returnItem.reason] || 'OTHER',
            customerNote: returnItem.comment || `Admin return: ${returnItem.reason}`
          });
        }

        // ✅ GUARD 2: No valid items mapped
        if (adminReturnLineItems.length === 0) {
          if (!adminOverride) {
            return res.status(400).json({
              error: 'No eligible items found',
              message: 'No line items could be mapped to fulfillment records. Check admin_override to tag manually.',
              code: 'NO_VALID_ITEMS',
              requires_override: true,
              failed_items: adminFailedItems
            });
          }

          console.warn('⚠️ ADMIN OVERRIDE: No valid line items mapped. Tagging order manually.');

          let manualItemsTags = 'admin-manual-return,return-requested,portal-created,admin-override';
          if (adminPortal) manualItemsTags += ',admin-portal';

          await fetch(`https://${storeDomain}/admin/api/2024-07/orders/${adminOrderId}.json`, {
            method: 'PUT',
            headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              order: {
                tags: manualItemsTags,
                note: `ADMIN MANUAL RETURN OVERRIDE → Items could not be mapped to fulfillments. Requested items: ${adminReturnItems.map(i => i.line_item_id).join(', ')} | Reason: ${adminReturnItems[0]?.reason || 'N/A'}`
              }
            })
          });

          return res.json({
            success: true,
            admin_override: true,
            warning: 'Items could not be mapped to fulfillment records. Order has been tagged for manual return processing.',
            manual: true,
            failed_items: adminFailedItems,
            order_id: adminOrderId
          });
        }

        // ✅ Create return via Shopify returnRequest mutation
        const adminReturnRequestMutation = `
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

        const adminReturnRes = await fetch(`https://${storeDomain}/admin/api/2024-07/graphql.json`, {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            query: adminReturnRequestMutation,
            variables: {
              input: {
                orderId: `gid://shopify/Order/${adminOrderId}`,
                returnLineItems: adminReturnLineItems
              }
            }
          })
        });

        if (!adminReturnRes.ok) {
          const errorText = await adminReturnRes.text();
          throw new Error(`Return request failed (${adminReturnRes.status}): ${errorText}`);
        }

        const adminReturnData = await adminReturnRes.json();

        if (adminReturnData.errors) {
          throw new Error(`GraphQL errors: ${JSON.stringify(adminReturnData.errors)}`);
        }

        const adminReturnRequest = adminReturnData.data.returnRequest;

        if (adminReturnRequest.userErrors && adminReturnRequest.userErrors.length > 0) {
          const errorMessages = adminReturnRequest.userErrors.map(e => e.message).join(', ');
          throw new Error(`Return creation failed: ${errorMessages}`);
        }

        const adminCreatedReturn = adminReturnRequest.return;
        console.log('✅ Admin return created successfully:', adminCreatedReturn.name);

        // Tag original order
        try {
          let returnSuccessTags = 'return-requested,portal-created,admin-created';
          if (adminPortal) returnSuccessTags += ',admin-portal';

          await fetch(`https://${storeDomain}/admin/api/2024-07/orders/${adminOrderId}.json`, {
            method: 'PUT',
            headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              order: {
                tags: returnSuccessTags,
                note: `ADMIN RETURN → Return: ${adminCreatedReturn.name}`
              }
            })
          });
        } catch (tagErr) {
          console.warn('Warning: Could not tag order:', tagErr.message);
        }

        return res.json({
          success: true,
          message: 'Admin return request created successfully!',
          return_id: adminCreatedReturn.id,
          return_name: adminCreatedReturn.name,
          status: adminCreatedReturn.status,
          order_name: adminCreatedReturn.order.name,
          admin_created: true
        });

      } catch (err) {
        console.error('❌ Admin return error:', err.message);
        return res.status(500).json({
          error: 'Admin return failed: ' + err.message,
          code: 'ADMIN_RETURN_ERROR',
          details: err.toString()
        });
      }
    }

    // ---------- ADMIN EXCHANGE ----------
    if (adminAction === 'admin_submit_exchange' && adminOrder && adminCustomerId && adminSelectedLineItems) {
      try {
        console.log('=== ADMIN EXCHANGE REQUEST RECEIVED ===');
        console.log('Number of items:', adminSelectedLineItems.length);
        console.log('Fee Waived:', feeWaived);

        const adminOriginalOrderName = adminOrder.name || 'Unknown Order';

        const adminCustomerOrdersRes = await fetch(
          `https://${storeDomain}/admin/api/2024-07/orders.json?customer_id=${adminCustomerId}&status=any&limit=250&fields=tags`,
          { headers: { 'X-Shopify-Access-Token': token } }
        );
        const adminCustomerOrders = (await adminCustomerOrdersRes.json()).orders || [];
        const adminPreviousExchanges = adminCustomerOrders.filter(o =>
          (o.tags || '').toLowerCase().includes('exchange-processed')
        ).length;
        const adminIsFirstExchange = adminPreviousExchanges === 0;

        let adminTotalPriceDifference = 0;
        let adminTotalCustomFees = 0;
        let adminTotalExchangeFees = 0;
        const adminDraftLineItems = [];
        let adminHasCustomSize = false;

        for (const selected of adminSelectedLineItems) {
          const originalPrice = parseFloat(selected.price || 0);
          let newPrice = originalPrice;
          let variantTitle = 'N/A';
          let productId = selected.product_id;
          let productTitle = selected.title || 'Custom Item';

          const isCustom = selected.is_custom_size === true;
          let variantId = selected.original_variant_id;

          if (isCustom) {
            adminHasCustomSize = true;
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
              variantTitle = variantData.variant.title || 'N/A';
            }
          }

          if (productId) {
            const productRes = await fetch(
              `https://${storeDomain}/admin/api/2024-07/products/${productId}.json`,
              { headers: { 'X-Shopify-Access-Token': token } }
            );
            if (productRes.ok) {
              const prodData = await productRes.json();
              productTitle = prodData.product.title;
            }
          }

          let adminCustomProperties = [];
          if (isCustom && selected.custom_measurements) {
            const m = selected.custom_measurements;
            adminCustomProperties = [
              { name: 'Exchange Type', value: 'Custom Size (Admin Created)' },
              { name: 'Original Size', value: selected.current_size || 'N/A' },
              { name: 'Bust', value: `${m.bust || '-'} inches` },
              { name: 'Waist', value: `${m.waist || '-'} inches` },
              { name: 'Hips', value: `${m.hips || '-'} inches` },
              { name: 'Shoulder', value: `${m.shoulder || '-'} inches` },
              { name: 'Length', value: `${m.length || '-'} inches` }
            ];
          } else {
            adminCustomProperties = [
              { name: 'Exchange Type', value: 'Size Change (Admin Created)' },
              { name: 'Original Size', value: selected.current_size || 'N/A' },
              { name: 'New Size', value: variantTitle }
            ];
          }

          adminDraftLineItems.push({
            product_id: productId,
            variant_id: variantId,
            quantity: 1,
            price: '0.00',
            title: isCustom ? `${productTitle} - Custom Size` : productTitle,
            properties: adminCustomProperties,
            taxable: true,
            requires_shipping: true
          });

          adminTotalPriceDifference += (newPrice - originalPrice);

          if (isCustom) {
            adminTotalCustomFees += 200;
          }
        }

        // ✅ Exchange fee
        if (!adminIsFirstExchange) {
          adminTotalExchangeFees += 200;
        }

        // ✅ FEE WAIVER: skip all fee line items if admin waived
        if (!feeWaived) {
          if (adminTotalCustomFees > 0) {
            adminDraftLineItems.push({
              title: `Custom Size Fee (${adminTotalCustomFees / 200} item${adminTotalCustomFees > 200 ? 's' : ''})`,
              price: adminTotalCustomFees.toFixed(2),
              quantity: 1,
              taxable: false,
              custom: true
            });
          }

          if (adminTotalExchangeFees > 0) {
            adminDraftLineItems.push({
              title: 'Exchange Processing Fee',
              price: adminTotalExchangeFees.toFixed(2),
              quantity: 1,
              taxable: false,
              custom: true
            });
          }

          if (adminTotalPriceDifference !== 0) {
            adminDraftLineItems.push({
              title: adminTotalPriceDifference > 0 ? 'Price Difference' : 'Price Adjustment (Store Credit)',
              price: adminTotalPriceDifference.toFixed(2),
              quantity: 1,
              taxable: false,
              custom: true
            });
          }
        }

        // ✅ Total: zero if fee waived
        const adminTotalAmountDue = feeWaived ? 0 : (adminTotalPriceDifference + adminTotalCustomFees + adminTotalExchangeFees);

        // ✅ Tags
        let adminDraftTags = 'exchange-draft,portal-created,exchange-portal,exchange-requested,admin-created';
        if (adminHasCustomSize) adminDraftTags += ',custom-size-exchange';
        if (adminPortal) adminDraftTags += ',admin-portal';
        if (feeWaived) adminDraftTags += ',admin-fee-waived';

        const adminItemSummary = adminSelectedLineItems.map((item, idx) => {
          const type = item.is_custom_size ? 'Custom Size' : 'Size Change';
          return `Item ${idx + 1}: ${item.title} (${type})`;
        }).join(' | ');

        let adminOrderNote = `ADMIN EXCHANGE for Order ${adminOriginalOrderName} | ${adminItemSummary} | Total Items: ${adminSelectedLineItems.length}`;
        if (feeWaived) adminOrderNote += ' | FEES WAIVED BY ADMIN';

        const adminCustomSizeDetails = adminSelectedLineItems
          .filter(item => item.is_custom_size && item.custom_measurements)
          .map((item, idx) => {
            const m = item.custom_measurements;
            return `\n\nCUSTOM SIZE ${idx + 1}: ${item.title}\nBust: ${m.bust || 'N/A'}" | Waist: ${m.waist || 'N/A'}" | Hips: ${m.hips || 'N/A'}" | Shoulder: ${m.shoulder || 'N/A'}" | Length: ${m.length || 'N/A'}"`;
          })
          .join('');

        if (adminCustomSizeDetails) {
          adminOrderNote += adminCustomSizeDetails;
        }

        const adminDraftPayload = {
          draft_order: {
            line_items: adminDraftLineItems,
            customer: { id: adminCustomerId },
            email: adminOrder.email,
            shipping_address: adminOrder.shipping_address,
            billing_address: adminOrder.billing_address || adminOrder.shipping_address,
            note: adminOrderNote,
            tags: adminDraftTags,
            requires_shipping: true
          }
        };

        const adminDraftRes = await fetch(`https://${storeDomain}/admin/api/2024-07/draft_orders.json`, {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(adminDraftPayload)
        });

        if (!adminDraftRes.ok) {
          const errorText = await adminDraftRes.text();
          throw new Error('Admin draft creation failed: ' + errorText);
        }

        const adminDraftData = await adminDraftRes.json();
        const adminDraftId = adminDraftData.draft_order.id;
        const adminDraftOrderName = adminDraftData.draft_order.name;

        console.log('✅ Admin draft order created:', adminDraftOrderName);

        // Tag original order
        if (adminOriginalOrderId) {
          try {
            let originalOrderTags = 'exchange-in-progress,portal-exchange,admin-created';
            if (adminPortal) originalOrderTags += ',admin-portal';
            if (feeWaived) originalOrderTags += ',admin-fee-waived';

            await fetch(`https://${storeDomain}/admin/api/2024-07/orders/${adminOriginalOrderId}.json`, {
              method: 'PUT',
              headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                order: {
                  tags: originalOrderTags,
                  note: `ADMIN EXCHANGE REQUESTED → Draft Order: ${adminDraftOrderName}`
                }
              })
            });
          } catch (tagErr) {
            console.warn('Warning: Could not tag original order:', tagErr.message);
          }
        }

        // ✅ Complete if no payment, else send invoice
        if (adminTotalAmountDue <= 0) {
          const adminCompleteRes = await fetch(
            `https://${storeDomain}/admin/api/2024-07/draft_orders/${adminDraftId}/complete.json`,
            {
              method: 'PUT',
              headers: { 'X-Shopify-Access-Token': token }
            }
          );

          if (!adminCompleteRes.ok) {
            const errorText = await adminCompleteRes.text();
            throw new Error('Admin draft completion failed: ' + errorText);
          }

          const adminCompleteData = await adminCompleteRes.json();
          const adminCompletedOrder = adminCompleteData.draft_order;
          const adminCompletedOrderName = adminCompletedOrder.name || `#${adminCompletedOrder.order_id}`;

          if (adminOriginalOrderId) {
            try {
              let completedTags = 'exchange-processed,portal-exchange,admin-created';
              if (adminPortal) completedTags += ',admin-portal';
              if (feeWaived) completedTags += ',admin-fee-waived';

              await fetch(`https://${storeDomain}/admin/api/2024-07/orders/${adminOriginalOrderId}.json`, {
                method: 'PUT',
                headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  order: {
                    tags: completedTags,
                    note: `ADMIN EXCHANGED → New Order: ${adminCompletedOrderName}`
                  }
                })
              });
            } catch (updateErr) {
              console.warn('Warning: Could not update original order:', updateErr.message);
            }
          }

          return res.json({
            success: true,
            exchange_order: adminCompletedOrder,
            message: 'Admin exchange order created successfully! No payment required.',
            amount_due: 0,
            admin_created: true
          });

        } else {
          try {
            await fetch(
              `https://${storeDomain}/admin/api/2024-07/draft_orders/${adminDraftId}/send_invoice.json`,
              {
                method: 'POST',
                headers: {
                  'X-Shopify-Access-Token': token,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  draft_order_invoice: {
                    to: adminOrder.email,
                    from: 'trueweststore@gmail.com',
                    subject: `Payment Required for Exchange - Order ${adminOriginalOrderName}`,
                    custom_message: `Hi! To complete your exchange, please pay ₹${adminTotalAmountDue.toFixed(2)}. Click the button below to complete payment.`
                  }
                })
              }
            );
          } catch (invoiceErr) {
            console.warn('Warning: Could not send invoice email:', invoiceErr.message);
          }

          return res.json({
            success: true,
            payment_url: adminDraftData.draft_order.invoice_url,
            draft_id: adminDraftId,
            draft_order_name: adminDraftOrderName,
            amount_due: adminTotalAmountDue.toFixed(2),
            breakdown: {
              price_difference: adminTotalPriceDifference.toFixed(2),
              custom_size_fees: adminTotalCustomFees.toFixed(2),
              exchange_fees: adminTotalExchangeFees.toFixed(2)
            },
            message: 'Admin exchange: Payment required. Invoice sent to customer.',
            admin_created: true
          });
        }

      } catch (err) {
        console.error('❌ Admin exchange error:', err.message);
        return res.status(500).json({
          error: 'Admin exchange failed: ' + err.message,
          code: 'ADMIN_EXCHANGE_ERROR',
          details: err.toString()
        });
      }
    }

    // ---------- ADMIN GET ORDER ----------
    if (req.method === 'GET' && isAdmin) {
      const { query: adminQuery, contact: adminContact } = req.query || {};
      if (!adminQuery) return res.status(400).json({ error: 'Missing query parameter' });

      let adminData;
      let adminCustomerId = null;

      try {
        if (adminContact) {
          const contactField = adminContact.includes('@') ? 'email' : 'phone';
          const adminCustomerRes = await fetch(
            `https://${storeDomain}/admin/api/2024-07/customers/search.json?query=${contactField}:${encodeURIComponent(adminContact)}`,
            { headers: { 'X-Shopify-Access-Token': token } }
          );
          if (!adminCustomerRes.ok) throw new Error(await adminCustomerRes.text());
          const adminCustomerData = await adminCustomerRes.json();
          if (adminCustomerData.customers.length === 0) return res.status(404).json({ error: 'Customer not found' });
          adminCustomerId = adminCustomerData.customers[0].id;

          const adminOrdersRes = await fetch(
            `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&customer_id=${adminCustomerId}&name=#${adminQuery}&limit=1`,
            { headers: { 'X-Shopify-Access-Token': token } }
          );
          if (!adminOrdersRes.ok) throw new Error(await adminOrdersRes.text());
          adminData = await adminOrdersRes.json();
        } else {
          const adminOrderRes = await fetch(
            `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&name=#${adminQuery}&limit=1`,
            { headers: { 'X-Shopify-Access-Token': token } }
          );
          if (!adminOrderRes.ok) throw new Error(await adminOrderRes.text());
          adminData = await adminOrderRes.json();
        }

        if (!adminData.orders || adminData.orders.length === 0) {
          return res.status(404).json({ error: 'Order not found' });
        }

        const adminCleanQuery = adminQuery.replace('#', '');
        const adminExactOrder = adminData.orders.find(o => o.name === `#${adminCleanQuery}` || String(o.order_number) === adminCleanQuery);
        const adminFetchedOrder = adminExactOrder || adminData.orders[0];
        adminData.orders = [adminFetchedOrder];

        if (!adminCustomerId && adminFetchedOrder.customer) {
          adminCustomerId = adminFetchedOrder.customer.id;
        }

        // ✅ Exchange count
        if (adminCustomerId) {
          try {
            const adminExchangeCountRes = await fetch(
              `https://${storeDomain}/admin/api/2024-07/orders.json?customer_id=${adminCustomerId}&status=any&limit=250&fields=tags`,
              { headers: { 'X-Shopify-Access-Token': token } }
            );
            if (adminExchangeCountRes.ok) {
              const adminAllOrders = (await adminExchangeCountRes.json()).orders || [];
              adminData.exchange_count = adminAllOrders.filter(o =>
                (o.tags || '').toLowerCase().includes('exchange-processed')
              ).length;
            }
          } catch (e) {
            adminData.exchange_count = 0;
          }
        } else {
          adminData.exchange_count = 0;
        }

        // ✅ Shipping status
        const adminFulfillment = adminFetchedOrder.fulfillments?.[0];
        let adminActualDeliveryDate = null;
        let adminCurrentShippingStatus = 'Processing';

        if (adminFulfillment) {
          const adminTrackingCompany = (adminFulfillment.tracking_company || '').toLowerCase();
          const adminTrackingNumber = adminFulfillment.tracking_number?.trim();
          const adminShipmentStatus = adminFulfillment.shipment_status;

          const adminIsDelhivery = adminTrackingCompany.includes('delhivery');
          const adminIsBluedart = adminTrackingCompany.includes('bluedart') || adminTrackingCompany.includes('blue dart');

          if (adminIsDelhivery) {
            if (adminShipmentStatus === 'delivered' || adminFetchedOrder.fulfillment_status === 'fulfilled') {
              adminCurrentShippingStatus = 'Delivered';
              if (adminFulfillment.updated_at) {
                adminActualDeliveryDate = new Date(adminFulfillment.updated_at).toISOString().split('T')[0];
              }
            } else if (adminShipmentStatus === 'in_transit') {
              adminCurrentShippingStatus = 'In Transit';
            } else if (adminShipmentStatus === 'out_for_delivery') {
              adminCurrentShippingStatus = 'Out for Delivery';
            }
          } else if (adminIsBluedart && adminTrackingNumber) {
            try {
              const adminTrackRes = await fetch(`https://track.eshipz.com/track?awb=${adminTrackingNumber}`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
              });
              if (adminTrackRes.ok) {
                const adminHtml = await adminTrackRes.text();
                let adminEvents = [];
                const adminJsonMatch = adminHtml.match(/var\s+response_data\s*=\s*(\[[\s\S]*?\]);/i);
                if (adminJsonMatch) {
                  try { adminEvents = JSON.parse(adminJsonMatch[1]); } catch (e) {}
                }

                if (adminEvents.length > 0) {
                  const adminDeliveredEvent = adminEvents.find(ev => {
                    const tag = (ev.tag || '').toLowerCase().trim();
                    const msg = (ev.message || '').toLowerCase().trim();
                    return (tag === 'delivered' || /\bdelivered\b/.test(msg)) && !/undelivered|not delivered|delivery failed|rto/.test(msg);
                  });

                  if (adminDeliveredEvent) {
                    adminCurrentShippingStatus = 'Delivered';
                    const ts = adminDeliveredEvent.checkpoint_time;
                    if (ts) {
                      const d = new Date(ts);
                      if (!isNaN(d.getTime())) {
                        adminActualDeliveryDate = d.toISOString().split('T')[0];
                      }
                    }
                  }
                }
              }
            } catch (trackErr) {
              console.warn('Admin: Eshipz tracking failed:', trackErr.message);
              adminCurrentShippingStatus = adminFetchedOrder.fulfillment_status === 'fulfilled' ? 'In Transit' : 'Unknown';
            }
          } else {
            if (adminFetchedOrder.fulfillment_status === 'fulfilled') {
              adminCurrentShippingStatus = 'Delivered';
              if (adminFulfillment.updated_at) {
                adminActualDeliveryDate = new Date(adminFulfillment.updated_at).toISOString().split('T')[0];
              }
            }
          }
        }

        adminFetchedOrder.actual_delivery_date = adminActualDeliveryDate;
        adminFetchedOrder.delivered_at = adminActualDeliveryDate;
        adminFetchedOrder.current_shipping_status = adminCurrentShippingStatus;

        const adminCreated = new Date(adminFetchedOrder.created_at);
        const adminMinDelivery = new Date(adminCreated);
        adminMinDelivery.setDate(adminCreated.getDate() + 5);
        const adminMaxDelivery = new Date(adminCreated);
        adminMaxDelivery.setDate(adminCreated.getDate() + 7);
        adminFetchedOrder.estimated_delivery = {
          min: adminMinDelivery.toISOString().split('T')[0],
          max: adminMaxDelivery.toISOString().split('T')[0]
        };

        // ✅ Fetch product images + variants
        for (let item of adminFetchedOrder.line_items) {
          if (item.product_id) {
            const adminProductRes = await fetch(
              `https://${storeDomain}/admin/api/2024-07/products/${item.product_id}.json?fields=id,title,images,variants`,
              { headers: { 'X-Shopify-Access-Token': token } }
            );
            const adminProductData = await adminProductRes.json();
            const adminProduct = adminProductData.product;

            item.image_url = adminProduct?.images?.[0]?.src || 'https://via.placeholder.com/80';
            item.available_variants = adminProduct?.variants?.map(v => ({
              id: v.id,
              title: v.title,
              price: v.price,
              inventory_quantity: v.inventory_quantity,
              available: v.inventory_quantity > 0
            })) || [];

            const adminCurrentVariant = adminProduct?.variants?.find(v => v.id === item.variant_id);
            if (adminCurrentVariant) {
              item.current_size = adminCurrentVariant.title;
              item.current_inventory = adminCurrentVariant.inventory_quantity;
            }
          } else {
            item.image_url = 'https://via.placeholder.com/80';
            item.available_variants = [];
          }
        }

        // ✅ already_processed check — warns but does NOT block admin
        const adminTags = (adminFetchedOrder.tags || '').toLowerCase();
        const adminNote = (adminFetchedOrder.note || '').toLowerCase();

        if (adminTags.includes('exchange-processed') || adminTags.includes('return-processed')) {
          adminData.already_processed = true;
          adminData.admin_warning = 'This order has already been processed. You are viewing as admin and can still proceed.';

          if (adminCustomerId) {
            try {
              const adminAllRes = await fetch(
                `https://${storeDomain}/admin/api/2024-07/orders.json?customer_id=${adminCustomerId}&limit=250`,
                { headers: { 'X-Shopify-Access-Token': token } }
              );
              const adminAll = (await adminAllRes.json()).orders || [];
              const adminReplacement = adminAll.find(o => o.note && o.note.toLowerCase().includes(adminFetchedOrder.name.toLowerCase()));
              if (adminReplacement) {
                adminData.exchange_order_name = adminReplacement.name;
                adminData.related_order = adminReplacement;
              } else {
                adminData.exchange_order_name = 'Processed';
              }
            } catch (e) {
              adminData.exchange_order_name = 'Processed';
            }
          }
        } else if (adminNote.includes('exchange for') || adminTags.includes('exchange-order') || adminTags.includes('portal-created')) {
          adminData.already_processed = true;
          adminData.admin_warning = 'This order has already been processed. You are viewing as admin and can still proceed.';
          adminData.exchange_order_name = adminFetchedOrder.name;
        }

        return res.json(adminData);

      } catch (err) {
        console.error('Admin proxy error:', err.message);
        return res.status(500).json({
          error: err.message,
          code: 'ADMIN_ORDER_FETCH_ERROR',
          details: err.toString()
        });
      }
    }
  }
  res.status(400).json({ error: 'Invalid request' });
};
