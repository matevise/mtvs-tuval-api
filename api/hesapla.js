// /api/hesapla.js — Tuval Fiyat Hesaplama Backend (v2)
// Vercel Serverless Function — CommonJS format

const SHOPIFY_STORE = 'cbx25.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// ─── SHOPIFY'DAN METAOBJECTLERİ ÇEK ───
async function fetchMetaobjects() {
  const query = `{
    saseList: metaobjects(type: "sase_tipi", first: 50) {
      nodes { handle fields { key value } }
    }
    bezList: metaobjects(type: "bez_tipi", first: 50) {
      nodes { handle fields { key value } }
    }
    sabitler: metaobjects(type: "tuval_sabitler", first: 1) {
      nodes { fields { key value } }
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

  if (!res.ok) throw new Error('Shopify API error: ' + res.status);
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

// ─── HESAPLAMA MOTORU ───
function getKayitAdet(cm, segmentler) {
  for (const seg of segmentler) {
    if (cm >= seg.min && cm <= seg.max) return seg.adet;
  }
  return 0;
}

function bezBirimFiyatTL(bezConfig, usdKuru) {
  if (bezConfig.formul === 'direkt_tl') return bezConfig.usd_m2;
  return usdKuru * bezConfig.usd_m2 * 10 / bezConfig.bolum;
}

function hesaplaTuvalFiyat(en, boy, saseConfig, bezConfig, sabitler) {
  const saseMetre = ((en + boy) * 2 * (1 + sabitler.fire_orani)) / 100;
  const saseMaliyet = saseMetre * saseConfig.birim_fiyat;

  const bezM2 = ((boy + saseConfig.bez_payi) * (en + saseConfig.bez_payi)) / 10000;
  const bezBirimTL = bezBirimFiyatTL(bezConfig, sabitler.usd_kuru);
  const bezMaliyet = bezM2 * bezBirimTL;

  const enKayitAdet = getKayitAdet(en, sabitler.kayit_segmentleri);
  const boyKayitAdet = getKayitAdet(boy, sabitler.kayit_segmentleri);
  const kayitMetre = ((boyKayitAdet * en) + (boy * enKayitAdet)) / 100;
  const kayitMaliyet = kayitMetre * saseConfig.kayit_birim;

  const iscilik = saseMetre * sabitler.iscilik_birim;

  const malzeme = saseMaliyet + bezMaliyet + kayitMaliyet;
  const memberFiyat = Math.round(
    ((malzeme * sabitler.kar_carpani) + iscilik) * (1 + sabitler.kdv_orani) * 10
  ) / 10;

  return { fiyat: memberFiyat, kayitAdet: enKayitAdet + boyKayitAdet };
}

// ─── DİNAMİK VARIANT OLUŞTUR (REST API) ───
async function createVariantWithPrice(price, en, boy, saseCinsi, bezCinsi) {
  const PRODUCT_ID = '10400727662886';

  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2025-01/products/${PRODUCT_ID}/variants.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      },
      body: JSON.stringify({
        variant: {
          option1: en + 'x' + boy + ' ' + saseCinsi + ' ' + bezCinsi,
          price: price.toFixed(2),
          inventory_policy: 'continue',
          inventory_management: null,
        }
      }),
    }
  );

  const data = await res.json();

  if (data.errors) {
    throw new Error(JSON.stringify(data.errors));
  }

  if (!data.variant) {
    throw new Error('Variant olusturulamadi: ' + JSON.stringify(data));
  }

  return {
    variantId: data.variant.id.toString(),
    price: data.variant.price,
    title: data.variant.title,
  };
}

// ─── ANA HANDLER ───
module.exports = async function handler(req, res) {
  // CORS
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

    if (!en || !boy || !sase || !bez) {
      return res.status(400).json({ error: 'Eksik parametre' });
    }

    const enNum = parseInt(en, 10);
    const boyNum = parseInt(boy, 10);

    if (isNaN(enNum) || isNaN(boyNum) || enNum < 10 || enNum > 350 || boyNum < 10 || boyNum > 350) {
      return res.status(400).json({ error: 'Gecersiz ebat (10-350 cm)' });
    }

    const rawData = await fetchMetaobjects();
    const saseTipleri = parseFields(rawData.saseList.nodes, 'ad');
    const bezTipleri = parseFields(rawData.bezList.nodes, 'ad');
    const sabitler = parseSabitler(rawData.sabitler.nodes);

    const saseConfig = saseTipleri[sase];
    const bezConfig = bezTipleri[bez];

    if (!saseConfig) {
      return res.status(400).json({ error: 'Gecersiz sase: ' + sase });
    }
    if (!bezConfig) {
      return res.status(400).json({ error: 'Gecersiz bez: ' + bez });
    }

    const result = hesaplaTuvalFiyat(enNum, boyNum, saseConfig, bezConfig, sabitler);

    if (action === 'add_to_cart') {
      const variant = await createVariantWithPrice(result.fiyat, enNum, boyNum, sase, bez);
      return res.status(200).json({
        fiyat: result.fiyat,
        kayitAdet: result.kayitAdet,
        variantId: variant.variantId,
      });
    }

    return res.status(200).json({
      fiyat: result.fiyat,
      kayitAdet: result.kayitAdet,
    });

  } catch (err) {
    console.error('[Tuval API Error]', err);
    return res.status(500).json({ error: 'Hesaplama hatasi', detail: err.message });
  }
};
