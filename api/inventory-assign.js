export default async function handler(req, res) {
  const startTime = Date.now();
  const SHOP = "cbx25";
  const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
  const API = `https://${SHOP}.myshopify.com/admin/api/2024-01/graphql.json`;

  const FENERBAHCE = "gid://shopify/Location/114207686950";
  const OTHER_LOCATIONS = [
    114207752486, // Akatlar
    114207588646, // İnönü
    114207654182, // Teşvikiye
    114207719718  // Tuzla
  ];

  // 1. Tüm ürünlerin inventory item'larını ve location bilgilerini çek
  let allItems = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    const afterClause = cursor ? `, after: "${cursor}"` : "";
    const query = `{
      productVariants(first: 250${afterClause}) {
        edges {
          cursor
          node {
            id
            inventoryItem {
              id
              inventoryLevels(first: 10) {
                edges {
                  node {
                    location { id }
                  }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage }
      }
    }`;

    const resp = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
      body: JSON.stringify({ query })
    });
    const data = await resp.json();
    const edges = data.data.productVariants.edges;
    
    for (const edge of edges) {
      const item = edge.node.inventoryItem;
      const locations = item.inventoryLevels.edges.map(e => e.node.location.id);
      const hasFenerbahce = locations.includes(FENERBAHCE);
      const missingLocations = OTHER_LOCATIONS.filter(
        loc => !locations.includes(`gid://shopify/Location/${loc}`)
      );
      
      if (hasFenerbahce && missingLocations.length > 0) {
        const numericId = item.id.replace("gid://shopify/InventoryItem/", "");
        allItems.push({ inventoryItemId: numericId, missingLocations });
      }
    }

    hasNext = data.data.productVariants.pageInfo.hasNextPage;
    if (hasNext) cursor = edges[edges.length - 1].cursor;
  }

  // 2. Eksik lokasyonlara stok 0 ata — 10'lu paralel batch
  const BATCH_SIZE = 10;
  let tasks = [];
  for (const item of allItems) {
    for (const locId of item.missingLocations) {
      tasks.push({ inventory_item_id: parseInt(item.inventoryItemId), location_id: locId });
    }
  }

  let success = 0;
  let errors = 0;

  for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
    const batch = tasks.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(task =>
        fetch(`https://${SHOP}.myshopify.com/admin/api/2024-01/inventory_levels/set.json`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
          body: JSON.stringify(task)
        }).then(r => r.ok ? "ok" : "fail").catch(() => "fail")
      )
    );
    success += results.filter(r => r === "ok").length;
    errors += results.filter(r => r === "fail").length;
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  return res.status(200).json({
    success: true,
    scanned_variants: allItems.length,
    total_assignments: tasks.length,
    completed: success,
    errors,
    duration_seconds: duration
  });
}
