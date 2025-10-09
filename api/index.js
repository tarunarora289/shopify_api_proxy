module.exports = async (req, res) => {
  const { query, contact } = req.query;
  if (!query || !contact) {
    return res.status(400).json({ error: 'Missing query or contact parameter' });
  }
  const token = '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'; // Your token
  const storeDomain = 'trueweststore.myshopify.com'; // Confirmed domain
  const fullQuery = `name:%23${encodeURIComponent(query)} ${contact.includes('@') ? 'customer_email' : 'customer_phone'}:${encodeURIComponent(contact)}`;
  const apiUrl = `https://${storeDomain}/admin/api/2025-10/orders/search.json?query=${encodeURIComponent(fullQuery)}`;
  console.log('Fetching URL:', apiUrl); // Debug log
  try {
    const response = await fetch(apiUrl, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      }
    });
    if (!response.ok) {
      const errorText = await response.text(); // Capture full response
      throw new Error(`HTTP error! status: ${response.status} - ${errorText}`);
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({ error: 'Failed to fetch from Shopify API: ' + err.message });
  }
};
