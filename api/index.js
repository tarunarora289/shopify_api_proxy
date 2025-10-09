module.exports = async (req, res) => {
  const { query, contact } = req.query;
  if (!query || !contact) {
    return res.status(400).json({ error: 'Missing query or contact parameter' });
  }
  const token = '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'; // Your token
  const storeDomain = 'trueweststore.myshopify.com'; // Replace with your actual store domain
  const apiUrl = `https://${storeDomain}/admin/api/2025-10/orders/search.json?query=name:${encodeURIComponent(query)} ${contact.includes('@') ? 'customer_email' : 'customer_phone'}:${encodeURIComponent(contact)}`;
  try {
    const response = await fetch(apiUrl, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      }
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({ error: 'Failed to fetch from Shopify API: ' + err.message });
  }
};
