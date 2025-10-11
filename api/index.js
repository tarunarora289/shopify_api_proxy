const fetch = require('node-fetch');

module.exports = async (req, res) => {
  const { query, contact } = req.query || {};
  if (!query && !contact) {
    return res.status(400).json({ error: 'Missing query or contact parameter' });
  }
  const token = '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'; // Your token
  const storeDomain = 'trueweststore.myshopify.com'; // Confirmed domain
  let data;
  try {
    if (contact) {
      // Step 1: Search customers by contact
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
      if (!customerResponse.ok) {
        const errorText = await customerResponse.text();
        throw new Error(`Customer search HTTP error! status: ${customerResponse.status} - ${errorText}`);
      }
      const customerData = await customerResponse.json();
      if (customerData.customers.length === 0) {
        return res.status(404).json({ error: 'Customer not found with provided contact' });
      }
      const customerId = customerData.customers[0].id;
      console.log('Found customer ID:', customerId);
      
      // Step 2: Search orders by customer ID and query (name)
      let ordersQuery = `customer_id:${customerId}`;
      if (query) {
        ordersQuery += ` name:#${encodeURIComponent(query)}`;
      }
      const ordersUrl = `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&query=${encodeURIComponent(ordersQuery)}&limit=10`;
      console.log('Fetching orders URL:', ordersUrl);
      const ordersResponse = await fetch(ordersUrl, {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
          'User-Agent': 'Grok-Proxy/1.0 (xai.com)'
        }
      });
      if (!ordersResponse.ok) {
        const errorText = await ordersResponse.text();
        throw new Error(`Orders search HTTP error! status: ${ordersResponse.status} - ${errorText}`);
      }
      data = await ordersResponse.json();
    } else if (query) {
      // If only query, search by name
      const apiUrl = `https://${storeDomain}/admin/api/2024-07/orders.json?status=any&query=name:#${encodeURIComponent(query)}&limit=10`;
      console.log('Fetching URL:', apiUrl);
      const response = await fetch(apiUrl, {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
          'User-Agent': 'Grok-Proxy/1.0 (xai.com)'
        }
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status} - ${errorText}`);
      }
      data = await response.json();
    }
    res.json(data);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({ error: 'Failed to fetch from Shopify API: ' + err.message });
  }
};
