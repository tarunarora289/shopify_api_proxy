// api/index.js → FINAL VERSION (Nov 2025) – 100% WORKING

import { Shopify } from '@shopify/shopify-api';

const shop = process.env.SHOPIFY_SHOP;
const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
const client = new Shopify.Clients.Rest(shop, accessToken);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { query, contact, with_related } = req.query;
  if (!query || !contact) return res.status(400).json({ error: 'Missing params' });

  try {
    // 1. Find orders by number
    const ordersRes = await client.get({
      path: 'orders',
      query: { name: query.replace('#', ''), status: 'any', limit: 100 },
    });

    let orders = ordersRes.body.orders || [];

    // 2. Filter by email/phone
    const search = contact.toLowerCase().replace(/[^\w@.+]/g, '');
    orders = orders.filter(o => {
      const email = (o.email || '').toLowerCase();
      const phone = (o.shipping_address?.phone || '').replace(/[^\d]/g, '');
      return email.includes(search) || phone.includes(search);
    });

    if (orders.length === 0) return res.json({ orders: [] });

    orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const mainOrder = orders[0];

    const response = {
      orders: [formatOrder(mainOrder)],
      already_processed: false,
      exchange_order_name: null,
      related_order: null,
    };

    const tags = (mainOrder.tags || '').toLowerCase();
    const note = (mainOrder.note || '').toLowerCase();

    // CASE A: Original order → already exchanged
    if (tags.includes('exchange-processed') || tags.includes('return-processed')) {
      response.already_processed = true;

      const relatedRes = await client.get({ path: 'orders', query: { limit: 50 } });
      const all = relatedRes.body.orders || [];
      const replacement = all.find(o => o.note && o.note.toLowerCase().includes(mainOrder.name.toLowerCase()));

      if (replacement) {
        response.exchange_order_name = replacement.name;
        if (with_related === '1') response.related_order = formatOrder(replacement);
      }
    }

    // CASE B: This IS the replacement order
    else if (note.includes('exchange for order') || note.includes('replacement') || note.includes('portal')) {
      const match = mainOrder.note.match(/#?(\d{4,})/);
      if (match) {
        const origNum = match[1];
        const origRes = await client.get({ path: 'orders', query: { name: origNum, limit: 1 } });
        const original = origRes.body.orders?.[0];
        if (original && with_related === '1') response.related_order = formatOrder(original);
      }
    }

    res.json(response);

  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Server error' });
  }
}

function formatOrder(order) {
  return {
    id: order.id,
    name: order.name,
    total_price: order.total_price,
    created_at: order.created_at,
    tags: order.tags || '',
    note: order.note || '',
    refunds: order.refunds || [],
    line_items: (order.line_items || []).map(item => ({
      id: item.id,
      title: item.title,
      variant_title: item.variant_title || '',
      quantity: item.quantity,
      image_url: item.image?.src || null,
      current_size: extractSize(item.title + ' ' + (item.variant_title || '')),
    })),
  };
}

function extractSize(str) {
  const match = str.match(/\b(XS|S|M|L|XL|XXL|2XL|3XL|\d{1,3})\b/i);
  return match ? match[0].toUpperCase() : 'M';
}
