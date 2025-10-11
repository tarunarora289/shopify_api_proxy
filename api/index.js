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
  if (!query || !contact) {
    return res.status(400).json({ error: 'Missing query or contact parameter' });
  }
  const token = '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'; // Your token
  const storeDomain = 'trueweststore.myshopify.com'; // Confirmed domain
  const encodedQuery = encodeURIComponent(`name:#${query}`);
  const encodedContact = encodeURIComponent(contact);
  const contactField = contact.includes('@') ? 'customer_email' : 'customer_phone';
  const apiUrl = `https://${storeDomain}/admin/api/2025-10/orders/search.json?query=${encodedQuery}+${contactField}:${encodedContact}`;
  console.log('Fetching URL:', apiUrl); // Debug log
  try {
    const response = await fetch(apiUrl, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      }
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP error! status: ${response.status} - ${errorText}`);
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({ error: 'Failed to fetch from Shopify API: ' + err.message });
  }
};
