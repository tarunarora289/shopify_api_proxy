module.exports = async (req, res) => {
  const { query, contact } = req.query;
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
      if (response.status === 404) {
        // Fallback to check if query is an ID (less likely)
        const idUrl = `https://${storeDomain}/admin/api/2025-10/orders/${encodeURIComponent(query)}.json`;
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
        const data = await fallbackResponse.json();
        res.json(data);
        return;
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
