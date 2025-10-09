module.exports = async (req, res) => {
  const { query, contact } = req.query;
  const token = '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'; // Your token
  const apiUrl = 'https://6507fb-2.myshopify.com/admin/api/2025-10/orders/search.json?query=name:' + query + ' customer_email:' + contact;
  const response = await fetch(apiUrl, {
    headers: {
      'X-Shopify-Access-Token': token
    }
  });
  const data = await response.json();
  res.json(data);
};
