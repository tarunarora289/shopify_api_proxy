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
        
       // ========== BLUEDART: USE ESHIPZ TRACKING ==========
else if (isBluedart && trackingNumber) {
  try {
    const trackUrl = `https://track.eshipz.com/track?awb=${trackingNumber}`;
    const trackRes = await fetch(trackUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    
    if (!trackRes.ok) {
      throw new Error(`Eshipz returned ${trackRes.status}`);
    }
    
    const html = await trackRes.text();
    
    // ✅ Extract status from StatusBlockTitle
    const statusBlockMatch = html.match(/<h4[^>]*id="StatusBlockTitle"[^>]*>([^<]+)<\/h4>/i);
    let eshipzStatus = statusBlockMatch ? statusBlockMatch[1].trim() : null;
    
    // Fallback: Extract from Remarks field
    if (!eshipzStatus) {
      const remarksMatch = html.match(/<h5[^>]*id="Remarks"[^>]*>Status\s*:<strong>\s*([^<]+)<\/strong>/i);
      eshipzStatus = remarksMatch ? remarksMatch[1].trim() : null;
    }
    
    if (eshipzStatus && eshipzStatus.toLowerCase() === 'delivered') {
      currentShippingStatus = 'Delivered';
      
      // ✅ Extract date from StatusBlock structure
      const dateMatch = html.match(/<h1[^>]*id="StatusBlockDate"[^>]*>(\d+)<\/h1>/i);
      const monthMatch = html.match(/<h3[^>]*id="StatusBlockMonth"[^>]*>([^<]+)<\/h3>/i);
      const yearMatch = html.match(/<h4[^>]*id="StatusBlockYear"[^>]*>(\d+)<\/h4>/i);
      
      if (dateMatch && monthMatch && yearMatch) {
        const day = dateMatch[1].padStart(2, '0');
        const monthStr = monthMatch[1].trim();
        const year = yearMatch[1].trim();
        
        const monthMap = {
          'jan': '01', 'january': '01',
          'feb': '02', 'february': '02',
          'mar': '03', 'march': '03',
          'apr': '04', 'april': '04',
          'may': '05',
          'jun': '06', 'june': '06',
          'jul': '07', 'july': '07',
          'aug': '08', 'august': '08',
          'sep': '09', 'september': '09',
          'oct': '10', 'october': '10',
          'nov': '11', 'november': '11',
          'dec': '12', 'december': '12'
        };
        
        const month = monthMap[monthStr.toLowerCase()];
        
        if (month) {
          actualDeliveryDate = `${day}/${month}/${year}`;
        }
      }
      
      // Fallback: Extract from shipment history table (first "DELIVERED" row)
      if (!actualDeliveryDate) {
        const deliveredRowMatch = html.match(/<tr>\s*<td>(\d{2}\/\d{2}\/\d{4})[^<]*<\/td>\s*<td>[^<]*<\/td>\s*<td[^>]*>SHIPMENT DELIVERED/i);
        if (deliveredRowMatch) {
          actualDeliveryDate = deliveredRowMatch[1];
        }
      }
      
    } else if (eshipzStatus) {
      const statusLower = eshipzStatus.toLowerCase();
      
      if (statusLower.includes('exception')) {
        currentShippingStatus = 'Exception';
      } else if (statusLower.includes('out for delivery')) {
        currentShippingStatus = 'Out for Delivery';
      } else if (statusLower.includes('in transit')) {
        currentShippingStatus = 'In Transit';
      } else if (statusLower.includes('picked')) {
        currentShippingStatus = 'Picked Up';
      } else {
        currentShippingStatus = eshipzStatus;
      }
    }
    
  } catch (e) {
    console.warn(`Tracking failed for AWB ${trackingNumber}:`, e.message);
    
    // ✅ SIMPLIFIED FALLBACK: Just show status, no date
    if (order.fulfillment_status === 'fulfilled') {
      currentShippingStatus = 'Delivered';
      // Don't set actualDeliveryDate - let it remain null
      // Frontend can handle null delivery dates gracefully
    } else {
      currentShippingStatus = 'Unknown';
    }
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

  res.status(400).json({ error: 'Invalid request' });
};
