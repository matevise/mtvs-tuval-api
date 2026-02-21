export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { inventory_item_id } = req.body;
  if (!inventory_item_id) return res.status(400).json({ error: 'inventory_item_id required' });

  const SHOP = "cbx25";
  const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

  const locations = [
    { id: 114207752486, name: "Akatlar Mağaza" },
    { id: 114207588646, name: "İnönü Mağaza" },
    { id: 114207654182, name: "Teşvikiye Mağaza" },
    { id: 114207719718, name: "Tuzla Depo" }
  ];

  const results = [];

  for (const loc of locations) {
    try {
      const response = await fetch(
        `https://${SHOP}.myshopify.com/admin/api/2024-01/inventory_levels/set.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': TOKEN
          },
          body: JSON.stringify({
            location_id: loc.id,
            inventory_item_id: parseInt(inventory_item_id),
            available: 0
          })
        }
      );
      const data = await response.json();
      results.push({ location: loc.name, status: response.status, data });
    } catch (err) {
      results.push({ location: loc.name, error: err.message });
    }
  }

  return res.status(200).json({ success: true, results });
}
