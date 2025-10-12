const fetch = require('node-fetch');

module.exports = async (req, res) => {
  // Add CORS headers to allow Shopify page access
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS request for CORS preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { query, contact, action, order_number, item_id } = req.query || {};
  const { action: bodyAction, order, customer_id } = req.body || {};
  const token = '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'; // Replace with new token if 401 persists
  const storeDomain = 'trueweststore.myshopify.com'; // Confirmed domain

  // Handle POST request for exchange submission
  if (req.method === 'POST' && bodyAction === 'submit_exchange' && order && customer_id) {
    console.log('Processing exchange submission for customer_id:', customer_id); // Debug log
    try {
      const response = await fetch(`https://${storeDomain}/admin/api/2024-07/orders.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
          'User-Agent': 'Grok-Proxy/1.0 (xai.com)'
        },
        body: JSON.stringify(order)
      });
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      res.json(data);
    } catch (err) {
      console.error('Proxy error (POST):', err.message); // Log full error
      res.status(500).json({ error: 'Proxy failed (POST): ' + err.message });
    }
    return;
  }

  // Handle GET request for order lookup
  if (req.method === 'GET') {
    if (!query) {
      return res.status(400).json({ error: 'Missing query parameter (order number)' });
    }
    let data;
    try {
      if (contact) {
        const contactField = contact.includes('@') ? 'email' : 'phone';
        const customerUrl = `https://${storeDomain}/admin/api/2024-07/customers/search.json?query=${contactField}:${encodeURIComponent(contact)}`;
        console.log('Fetching customers URL:', customerUrl);
        const customerResponse = await fetch(customerUrl, {
          headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json',
            'User-Agent': 'Grok-Proxy/1.0 (xai.com)'
          }
        });
        if (!customerResponse.ok) throw new Error(await customerResponse.text());
        const customerData = await customerResponse.json();
        if (customerData.customers.length === 0) {
          return res.status(404).json({ error: 'Customer not found with provided contact' });
        }
        const customerId = customerData.customers[0].id;
        console.log('Found customer ID:', customerId);
        const ordersQuery = `customer_id:${customerId} name:#${encodeURIComponent(query)}`;
        const ordersUrl = `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&query=${encodeURIComponent(ordersQuery)}&limit=10`;
        console.log('Fetching orders URL:', ordersUrl);
        const ordersResponse = await fetch(ordersUrl, {
          headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json',
            'User-Agent': 'Grok-Proxy/1.0 (xai.com)'
          }
        });
        if (!ordersResponse.ok) throw new Error(await ordersResponse.text());
        data = await ordersResponse.json();
        // Fetch product image and inventory for the first order's line items
        if (data.orders && data.orders.length > 0) {
          const order = data.orders[0];
          if (order.fulfillments && order.fulfillments.length > 0) {
            const lineItems = order.fulfillments[0].line_items;
            for (let item of lineItems) {
              const productUrl = `https://${storeDomain}/admin/api/2024-07/products/${item.product_id}.json?fields=images,variants`;
              console.log('Fetching product image and variants URL:', productUrl);
              const productResponse = await fetch(productUrl, {
                headers: {
                  'X-Shopify-Access-Token': token,
                  'Content-Type': 'application/json',
                  'User-Agent': 'Grok-Proxy/1.0 (xai.com)'
                }
              });
              if (!productResponse.ok) throw new Error(await productResponse.text());
              const productData = await productResponse.json();
              if (productData.product && productData.product.images && productData.product.images.length > 0) {
                item.image_url = productData.product.images[0].src; // Use the first image URL
              }
              // Add inventory quantity to the line item if variant matches
              const variant = productData.product.variants.find(v => v.id === item.variant_id);
              if (variant) {
                item.inventory_quantity = variant.inventory_quantity || 0; // Add inventory data
              }
            }
          }
        }
      } else {
        const apiUrl = `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&query=name:#${encodeURIComponent(query)}&limit=10`;
        console.log('Fetching URL:', apiUrl);
        const response = await fetch(apiUrl, {
          headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json',
            'User-Agent': 'Grok-Proxy/1.0 (xai.com)'
          }
        });
        if (!response.ok) throw new Error(await response.text());
        data = await response.json();
        // Fetch product image and inventory for the first order's line items
        if (data.orders && data.orders.length > 0) {
          const order = data.orders[0];
          if (order.fulfillments && order.fulfillments.length > 0) {
            const lineItems = order.fulfillments[0].line_items;
            for (let item of lineItems) {
              const productUrl = `https://${storeDomain}/admin/api/2024-07/products/${item.product_id}.json?fields=images,variants`;
              console.log('Fetching product image and variants URL:', productUrl);
              const productResponse = await fetch(productUrl, {
                headers: {
                  'X-Shopify-Access-Token': token,
                  'Content-Type': 'application/json',
                  'User-Agent': 'Grok-Proxy/1.0 (xai.com)'
                }
              });
              if (!productResponse.ok) throw new Error(await productResponse.text());
              const productData = await productResponse.json();
              if (productData.product && productData.product.images && productData.product.images.length > 0) {
                item.image_url = productData.product.images[0].src; // Use the first image URL
              }
              // Add inventory quantity to the line item if variant matches
              const variant = productData.product.variants.find(v => v.id === item.variant_id);
              if (variant) {
                item.inventory_quantity = variant.inventory_quantity || 0; // Add inventory data
              }
            }
          }
        }
      }
      res.json(data);
    } catch (err) {
      console.error('Proxy error (GET):', err.message); // Log full error
      res.status(500).json({ error: 'Failed to fetch from Shopify API: ' + err.message });
    }
    return;
  }

  // GET endpoint for fetching available sizes using product inventory
  if (req.method === 'GET' && action === 'get_available_sizes' && order_number && contact && item_id) {
    try {
      // Find the customer by contact
      const contactField = contact.includes('@') ? 'email' : 'phone';
      const customerUrl = `https://${storeDomain}/admin/api/2024-07/customers/search.json?query=${contactField}:${encodeURIComponent(contact)}`;
      console.log('Fetching customer URL for sizes:', customerUrl);
      const customerResponse = await fetch(customerUrl, {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
          'User-Agent': 'Grok-Proxy/1.0 (xai.com)'
        }
      });
      if (!customerResponse.ok) throw new Error(await customerResponse.text());
      const customerData = await customerResponse.json();
      if (customerData.customers.length === 0) {
        return res.status(404).json({ error: 'Customer not found with provided contact' });
      }
      const customerId = customerData.customers[0].id;

      // Find the order
      const ordersQuery = `customer_id:${customerId} name:#${encodeURIComponent(order_number)}`;
      const ordersUrl = `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&query=${encodeURIComponent(ordersQuery)}&limit=1`;
      console.log('Fetching order URL for sizes:', ordersUrl);
      const ordersResponse = await fetch(ordersUrl, {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
          'User-Agent': 'Grok-Proxy/1.0 (xai.com)'
        }
      });
      if (!ordersResponse.ok) throw new Error(await ordersResponse.text());
      const orderData = await ordersResponse.json();
      if (!orderData.orders || orderData.orders.length === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }
      const order = orderData.orders[0];
      const lineItem = (order.fulfillments && order.fulfillments.length > 0 ? order.fulfillments[0].line_items : order.line_items || []).find(item => item.id === parseInt(item_id));
      if (!lineItem) {
        return res.status(404).json({ error: 'Line item not found' });
      }
      const productId = lineItem.product_id;

      // Fetch product variants with inventory
      const productUrl = `https://${storeDomain}/admin/api/2024-07/products/${productId}.json?fields=variants`;
      console.log('Fetching product variants URL:', productUrl);
      const productResponse = await fetch(productUrl, {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
          'User-Agent': 'Grok-Proxy/1.0 (xai.com)'
        }
      });
      if (!productResponse.ok) throw new Error(await productResponse.text());
      const productData = await productResponse.json();
      const variants = productData.product.variants || [];

      // Map sizes with availability using inventory_quantity
      const availableSizes = variants.map(variant => ({
        size: variant.option1 || variant.title, // Assuming size is in option1 or title
        available: variant.inventory_quantity > 0 // Use inventory_quantity for availability
      })).filter(size => size.size); // Filter out invalid sizes

      res.json({ available_sizes: availableSizes });
    } catch (err) {
      console.error('Proxy error (get_available_sizes):', err.message);
      res.status(500).json({ error: 'Failed to fetch available sizes: ' + err.message });
    }
    return;
  }

  // Invalid method
  res.status(400).json({ error: 'Invalid request method' });
};
