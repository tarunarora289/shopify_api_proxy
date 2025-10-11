const fetch = require('node-fetch');

module.exports = async (req, res) => {
  // CORS headers to allow Shopify page access
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS request for CORS preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { query, contact } = req.query || {};
  const { action, order, customer_id } = req.body || {};

  const token = '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'; // Verify this token
  const storeDomain = 'trueweststore.myshopify.com';

  // Handle GET request for order lookup
  if (req.method === 'GET') {
    if (!query || !contact) {
      return res.status(400).json({ error: 'Missing query or contact parameter' });
    }

    const encodedQuery = encodeURIComponent(`name:#${query}`);
    const encodedContact = encodeURIComponent(contact);
    const contactField = contact.includes('@') ? 'customer_email' : 'customer_phone';
    const apiUrl = `https://${storeDomain}/admin/api/2024-10/orders/search.json?query=${encodedQuery}+${contactField}:${encodedContact}`;
    console.log('Fetching URL:', apiUrl); // Debug log

    try {
      const response = await fetch(apiUrl, {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
          'User-Agent': 'Grok-Proxy/1.0 (xai.com)'
        }
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Shopify API error! status: ${response.status} - ${errorText}`);
      }
      const data = await response.json();
      res.json(data);
    } catch (err) {
      console.error('Proxy error details (GET):', err.message); // Log full error
      res.status(500).json({ error: 'Proxy failed (GET): ' + err.message });
    }
    return;
  }

  // Handle POST request for exchange submission
  if (req.method === 'POST' && action === 'submit_exchange' && order && customer_id) {
    console.log('Processing exchange submission for customer_id:', customer_id); // Debug log
    try {
      const response = await fetch(`https://${storeDomain}/admin/api/2024-10/orders.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
          'User-Agent': 'Grok-Proxy/1.0 (xai.com)'
        },
        body: JSON.stringify(order)
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Shopify API error! status: ${response.status} - ${errorText}`);
      }
      const data = await response.json();
      res.json(data);
    } catch (err) {
      console.error('Proxy error details (POST):', err.message); // Log full error
      res.status(500).json({ error: 'Proxy failed (POST): ' + err.message });
    }
    return;
  }

  // Invalid method or missing parameters
  res.status(400).json({ error: 'Invalid request method or missing parameters' });
};
