const fetch = require('node-fetch');

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { query, contact } = req.query || {};
  const { action, order, customer_id } = req.body || {};
  const token = 'shpat_NEW_TOKEN_HERE'; // Paste your new regenerated token here
  const storeDomain = 'trueweststore.myshopify.com';

  // Handle POST for exchange submission
  if (req.method === 'POST' && action === 'submit_exchange' && order && customer_id) {
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
      res.status(500).json({ error: err.message });
    }
    return;
  }

  // Handle GET for order lookup
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
      }
      res.json(data);
    } catch (err) {
      console.error('Proxy error:', err.message);
      res.status(500).json({ error: 'Failed to fetch from Shopify API: ' + err.message });
    }
    return;
  }

  // Invalid method
  res.status(400).json({ error: 'Invalid request method' });
};
