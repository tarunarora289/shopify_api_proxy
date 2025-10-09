const fetch = require('node-fetch');

module.exports = async (req, res) => {
  const { query, contact } = req.query;

  if (!query || !contact) {
    return res.status(400).json({ error: 'Missing query or contact parameter' });
  }

  const token = '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'; // Your token
  const storeDomain = 'trueweststore.myshopify.com'; // Confirmed domain

  // Remove leading '#' if any from order number
  const sanitizedQuery = query.toString().replace(/^#/, '').trim();
  const contactField = contact.includes('@') ? 'customer_email' : 'customer_phone';
  const encodedContact = encodeURIComponent(contact);

  // Use stable API version 2024-10 (recommended)
  const apiUrl = `https://${storeDomain}/admin/api/2024-10/orders/search.json?query=name:${sanitizedQuery}+${contactField}:${encodedContact}`;

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

      if (response.status === 404) {
        // Fallback: fetch order by ID
        const idUrl = `https://${storeDomain}/admin/api/2024-10/orders/${encodeURIComponent(sanitizedQuery)}.json`;
        console.log('Fallback URL:', idUrl);

        const fallbackResponse = await fetch(idUrl, {
          headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json'
          }
        });

        if (!fallbackResponse.ok) {
          throw new Error(`Fallback HTTP error! status: ${fallbackResponse.status} - ${await fallbackResponse.text()}`);
        }
        const fallbackData = await fallbackResponse.json();
        return res.json(fallbackData);
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
