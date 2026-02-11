// /api/hesapla.js — Tuval Fiyat Hesaplama Backend
// Vercel Serverless Function
// Frontend'e sadece nihai fiyat döner, maliyet detayları gizli kalır.

// ─── SABİTLER (Shopify metaobject'ten de çekilebilir, şimdilik hardcode) ───
const SHOPIFY_STORE = 'cbx25.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN; // Vercel env variable

// ─── CORS HEADERS ───
const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://colorbox.com.tr',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── SHOPIFY'DAN METAOBJECTLERİ ÇEK ───
async function fetchMetaobjects() {
  const query = `{
    saseList: metaobjects(type: "sase_tipi", first: 50) {
      nodes {
        handle
        fields { key value }
      }
    }
    bezList: metaobjects(type: "bez_tipi", first: 50) {
      nodes {
        handle
        fields { key value }
      }
    }
    sabitler: metaobjects(type: "tuval_sabitler", first: 1) {
      nodes {
        fields { key value }
      }
    }
  }`;

  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) throw new Error(`Shopify API error: ${res.status}`);
  const data = await res.json();
  return data.data;
}

// ─── METAOBJECT PARSE ───
function parseFields(nodes, keyField) {
  const result = {};
  for (const node of nodes) {
    const obj = {};
    let name = node.handle;
    for (const f of node.fields) {
      if (f.key === keyField) {
        name = f.value.replace(/"/g, '');
      } else if (f.key === 'formul') {
        obj[f.key] = f.value.replace(/"/g, '');
      } else {
        obj[f.key] = parseFloat(f.value);
      }
    }
    result[name] = obj;
  }
  return result;
}

function parseSabitler(nodes) {
  const sabit = {};
  for (const f of nodes[0].fields) {
    if (f.key === 'kayit_segmentleri') {
      sabit[f.key] = JSON.parse(f.value);
    } else {
      sabit[f.key] = parseFloat(f.value);
    }
  }
  return sabit;
}

// ─── HESAPLAMA MOTORU (Frontend'dekiyle aynı mantık) ───
function getKayitAdet(cm, segmentler) {
  for (const seg of segmentler) {
    if (cm >= seg.min && cm <= seg.max) return seg.adet;
  }
  return 0;
}

function bezBirimFiyatTL(bezConfig, usdKuru) {
  if (bezConfig.formul === 'direkt_tl') {
    return bezConfig.usd_m2;
  }
  return usdKuru * bezConfig.usd_m2 * 10 / bezConfig.bolum;
}

function hesaplaTuvalFiyat(en, boy, saseConfig, bezConfig, sabitler) {
  // ADIM 1-2: Şase
  const saseMetre = ((en + boy) * 2 * (1 + sabitler.fire_orani)) / 100;
  const saseMaliyet = saseMetre * saseConfig.birim_fiyat;

  // ADIM 3-4: Bez
  const bezM2 = ((boy + saseConfig.bez_payi) * (en + saseConfig.bez_payi)) / 10000;
  const bezBirimTL = bezBirimFiyatTL(bezConfig, sabitler.usd_kuru);
  const bezMaliyet = bezM2 * bezBirimTL;

  // ADIM 5-6: Kayıt
  const enKayitAdet = getKayitAdet(en, sabitler.kayit_segmentleri);
  const boyKayitAdet = getKayitAdet(boy, sabitler.kayit_segmentleri);
  const kayitMetre = ((boyKayitAdet * en) + (boy * enKayitAdet)) / 100;
  const kayitMaliyet = kayitMetre * saseConfig.kayit_birim;

  // ADIM 7: İşçilik
  const iscilik = saseMetre * sabitler.iscilik_birim;

  // ADIM 8: Nihai fiyat
  const malzeme = saseMaliyet + bezMaliyet + kayitMaliyet;
  const memberFiyat = Math.round(
    ((malzeme * sabitler.kar_carpani) + iscilik) * (1 + sabitler.kdv_orani) * 10
  ) / 10;

  return {
    fiyat: memberFiyat,
    kayitAdet: enKayitAdet + boyKayitAdet,
  };
}

// ─── DİNAMİK VARIANT OLUŞTUR ───
async function createVariantWithPrice(price, en, boy, saseCinsi, bezCinsi) {
  const PRODUCT_ID = 'gid://shopify/Product/10400727662886';

  // Önce mevcut geçici variantları temizle (opsiyonel, ileride eklenebilir)

  const mutation = `mutation {
    productVariantsBulkCreate(
      productId: "${PRODUCT_ID}",
      strategy: REMOVE_STANDALONE_VARIANT,
      variants: [{
        price: "${price.toFixed(2)}",
        optionValues: [{
          optionName: "Ebat",
          name: "${en}x${boy} ${saseCinsi} ${bezCinsi}"
        }],
        inventoryPolicy: CONTINUE
      }]
    ) {
      productVariants {
        id
        title
        price
      }
      userErrors {
        field
        message
      }
    }
  }`;

  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    },
    body: JSON.stringify({ query: mutation }),
  });

  const data = await res.json();

  if (data.data?.productVariantsBulkCreate?.userErrors?.length > 0) {
    throw new Error(data.data.productVariantsBulkCreate.userErrors[0].message);
  }

  const variant = data.data?.productVariantsBulkCreate?.productVariants?.[0];
  if (!variant) throw new Error('Variant oluşturulamadı');

  return {
    variantId: variant.id.replace('gid://shopify/ProductVariant/', ''),
    price: variant.price,
    title: variant.title,
  };
}

// ─── ANA HANDLER ───
export default async function handler(req, res) {
  // CORS preflight
// CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', 'https://colorbox.com.tr');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { en, boy, sase, bez, action } = req.body;

    // Validasyon
    if (!en || !boy || !sase || !bez) {
      return res.status(400).json({ error: 'Eksik parametre' });
    }

    const enNum = parseInt(en, 10);
    const boyNum = parseInt(boy, 10);

    if (isNaN(enNum) || isNaN(boyNum) || enNum < 10 || enNum > 350 || boyNum < 10 || boyNum > 350) {
      return res.status(400).json({ error: 'Geçersiz ebat (10-350 cm)' });
    }

    // Shopify'dan güncel verileri çek
    const rawData = await fetchMetaobjects();
    const saseTipleri = parseFields(rawData.saseList.nodes, 'ad');
    const bezTipleri = parseFields(rawData.bezList.nodes, 'ad');
    const sabitler = parseSabitler(rawData.sabitler.nodes);

    const saseConfig = saseTipleri[sase];
    const bezConfig = bezTipleri[bez];

    if (!saseConfig) {
      return res.status(400).json({ error: `Geçersiz şase: ${sase}` });
    }
    if (!bezConfig) {
      return res.status(400).json({ error: `Geçersiz bez: ${bez}` });
    }

    // Hesapla
    const result = hesaplaTuvalFiyat(enNum, boyNum, saseConfig, bezConfig, sabitler);

    // Sadece fiyat hesaplama mı, yoksa sepete ekleme mi?
    if (action === 'add_to_cart') {
      // Dinamik variant oluştur
      const variant = await createVariantWithPrice(result.fiyat, enNum, boyNum, sase, bez);
      return res.status(200).json({
        fiyat: result.fiyat,
        kayitAdet: result.kayitAdet,
        variantId: variant.variantId,
      });
    }

    // Sadece fiyat dön — maliyet detayı YOK
    return res.status(200).json({
      fiyat: result.fiyat,
      kayitAdet: result.kayitAdet,
    });

  } catch (err) {
    console.error('[Tuval API Error]', err);
    return res.status(500).json({ error: 'Hesaplama hatası', detail: err.message });
  }
```

Commit et, 30 saniye bekle, sonra aynı curl komutunu tekrar çalıştır:
```
curl -s -X POST "https://mtvs-tuval-api.vercel.app/api/hesapla" -H "Content-Type: application/json" -d "{\"en\":120,\"boy\":240,\"sase\":\"1,7x2,8\",\"bez\":\"320gr Pamuk\",\"action\":\"add_to_cart\"}"
