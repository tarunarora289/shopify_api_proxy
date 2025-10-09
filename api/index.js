const fetch = require('node-fetch');

module.exports = async (req, res) => {
  const { query, contact } = req.query || {};
  if (!query || !contact) {
    return res.status(400).json({ error: 'Missing query or contact parameter' });
  }
  const token = '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'; // Replace with your new regenerated token
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
        'Content-Type': 'application/json',
        'User-Agent': 'Grok-Proxy/1.0 (xai.com)'
      }
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'No error details');
      console.log('API Response Error:', errorText);
      if (response.status === 404 || errorText.includes('Not Found')) {
        return res.status(404).json({ error: 'Order not found with provided query and contact' });
      }
      throw new Error(`HTTP error! status: ${response.status} - ${errorText}`);
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({ error: 'Failed to fetch from Shopify API: ' + err.message });
  }
};
