// /api/hesapla.js — Tuval Fiyat Hesaplama Backend (v3)
// Vercel Serverless Function — CommonJS format

const SHOPIFY_STORE = 'cbx25.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const PRODUCT_ID = '10400727662886';

// ─── SHOPIFY'DAN METAOBJECTLERİ ÇEK ───
async function fetchMetaobjects() {
  var query = '{ saseList: metaobjects(type: "sase_tipi", first: 50) { nodes { handle fields { key value } } } bezList: metaobjects(type: "bez_tipi", first: 50) { nodes { handle fields { key value } } } sabitler: metaobjects(type: "tuval_sabitler", first: 1) { nodes { fields { key value } } } }';

  var res = await fetch('https://' + SHOPIFY_STORE + '/admin/api/2025-01/graphql.json', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    },
    body: JSON.stringify({ query: query }),
  });

  if (!res.ok) throw new Error('Shopify API error: ' + res.status);
  var data = await res.json();
  return data.data;
}

// ─── METAOBJECT PARSE ───
function parseFields(nodes, keyField) {
  var result = {};
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    var obj = {};
    var name = node.handle;
    for (var j = 0; j < node.fields.length; j++) {
      var f = node.fields[j];
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
  var sabit = {};
  for (var i = 0; i < nodes[0].fields.length; i++) {
    var f = nodes[0].fields[i];
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
  for (var i = 0; i < segmentler.length; i++) {
    if (cm >= segmentler[i].min && cm <= segmentler[i].max) return segmentler[i].adet;
  }
  return 0;
}

function bezBirimFiyatTL(bezConfig, usdKuru) {
  if (bezConfig.formul === 'direkt_tl') return bezConfig.usd_m2;
  return usdKuru * bezConfig.usd_m2 * 10 / bezConfig.bolum;
}

function hesaplaTuvalFiyat(en, boy, saseConfig, bezConfig, sabitler) {
  var saseMetre = ((en + boy) * 2 * (1 + sabitler.fire_orani)) / 100;
  var saseMaliyet = saseMetre * saseConfig.birim_fiyat;

  var bezM2 = ((boy + saseConfig.bez_payi) * (en + saseConfig.bez_payi)) / 10000;
  var bezBirimTL = bezBirimFiyatTL(bezConfig, sabitler.usd_kuru);
  var bezMaliyet = bezM2 * bezBirimTL;

  var enKayitAdet = getKayitAdet(en, sabitler.kayit_segmentleri);
  var boyKayitAdet = getKayitAdet(boy, sabitler.kayit_segmentleri);
  var kayitMetre = ((boyKayitAdet * en) + (boy * enKayitAdet)) / 100;
  var kayitMaliyet = kayitMetre * saseConfig.kayit_birim;

  var iscilik = saseMetre * sabitler.iscilik_birim;

  var malzeme = saseMaliyet + bezMaliyet + kayitMaliyet;
  var memberFiyat = Math.round(
    ((malzeme * sabitler.kar_carpani) + iscilik) * (1 + sabitler.kdv_orani) * 10
  ) / 10;

  return { fiyat: memberFiyat, kayitAdet: enKayitAdet + boyKayitAdet };
}

// ─── ÜRÜNE GÖRSEL EKLE VE VARIANT'A BAĞLA ───
async function addImageToVariant(variantId, en, boy, saseCinsi, bezCinsi) {
  // Orantılı görsel boyutu (max 600px, en-boy oranı korunur)
  var maxPx = 600;
  var ratio = en / boy;
  var imgW, imgH;
  if (ratio >= 1) {
    imgW = maxPx;
    imgH = Math.round(maxPx / ratio);
  } else {
    imgH = maxPx;
    imgW = Math.round(maxPx * ratio);
  }

  var text = en + 'x' + boy + 'cm\n' + saseCinsi + '\n' + bezCinsi;
  var imageUrl = 'https://placehold.co/' + imgW + 'x' + imgH + '/1a1a2e/ffffff?text=' + encodeURIComponent(text);

  var res = await fetch(
    'https://' + SHOPIFY_STORE + '/admin/api/2025-01/products/' + PRODUCT_ID + '/images.json',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      },
      body: JSON.stringify({
        image: {
          src: imageUrl,
          alt: en + 'x' + boy + ' cm ' + saseCinsi + ' ' + bezCinsi,
          variant_ids: [parseInt(variantId, 10)],
        }
      }),
    }
  );

  var data = await res.json();
  return data.image ? data.image.id : null;
}

// ─── MEVCUT VARIANTLARI ÇEK ───
async function getExistingVariants() {
  var res = await fetch(
    'https://' + SHOPIFY_STORE + '/admin/api/2025-01/products/' + PRODUCT_ID + '/variants.json?limit=250',
    {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN },
    }
  );
  var data = await res.json();
  return data.variants || [];
}

// ─── ESKİ VARIANTLARI TEMİZLE (Default Title hariç, 7 günden eski) ───
async function cleanOldVariants(variants) {
  var now = Date.now();
  var SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

  for (var i = 0; i < variants.length; i++) {
    var v = variants[i];
    if (v.title === 'Default Title') continue;

    var createdAt = new Date(v.created_at).getTime();
    if (now - createdAt > SEVEN_DAYS) {
      try {
        if (v.image_id) {
          await fetch(
            'https://' + SHOPIFY_STORE + '/admin/api/2025-01/products/' + PRODUCT_ID + '/images/' + v.image_id + '.json',
            {
              method: 'DELETE',
              headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN },
            }
          );
        }
        await fetch(
          'https://' + SHOPIFY_STORE + '/admin/api/2025-01/products/' + PRODUCT_ID + '/variants/' + v.id + '.json',
          {
            method: 'DELETE',
            headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN },
          }
        );
      } catch (e) {
        // Silme hatasi onemsiz
      }
    }
  }
}

// ─── DİNAMİK VARIANT OLUŞTUR ───
async function createVariantWithPrice(price, en, boy, saseCinsi, bezCinsi) {
  var optionValue = en + 'x' + boy + ' ' + saseCinsi + ' ' + bezCinsi;

  var variants = await getExistingVariants();

  // Arka planda eski variantları temizle
  cleanOldVariants(variants).catch(function() {});

  // Aynı option value ile variant var mı?
  var existing = null;
  for (var i = 0; i < variants.length; i++) {
    if (variants[i].option1 === optionValue) {
      existing = variants[i];
      break;
    }
  }

  if (existing) {
    // Fiyatı güncelle
    var res = await fetch(
      'https://' + SHOPIFY_STORE + '/admin/api/2025-01/variants/' + existing.id + '.json',
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        },
        body: JSON.stringify({
          variant: { id: existing.id, price: price.toFixed(2) }
        }),
      }
    );
    var data = await res.json();
    return {
      variantId: data.variant.id.toString(),
      price: data.variant.price,
      title: data.variant.title,
    };
  }

  // Yeni oluştur
  var res2 = await fetch(
    'https://' + SHOPIFY_STORE + '/admin/api/2025-01/products/' + PRODUCT_ID + '/variants.json',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      },
      body: JSON.stringify({
        variant: {
          option1: optionValue,
          price: price.toFixed(2),
          inventory_policy: 'continue',
          inventory_management: null,
        }
      }),
    }
  );

  var data2 = await res2.json();

  if (data2.errors) {
    throw new Error(JSON.stringify(data2.errors));
  }

  if (!data2.variant) {
    throw new Error('Variant olusturulamadi: ' + JSON.stringify(data2));
  }

  // Görseli arka planda ekle
  addImageToVariant(data2.variant.id.toString(), en, boy, saseCinsi, bezCinsi).catch(function() {});

  return {
    variantId: data2.variant.id.toString(),
    price: data2.variant.price,
    title: data2.variant.title,
  };
}

// ─── ANA HANDLER ───
module.exports = async function handler(req, res) {
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
    var en = req.body.en;
    var boy = req.body.boy;
    var sase = req.body.sase;
    var bez = req.body.bez;
    var action = req.body.action;

    if (!en || !boy || !sase || !bez) {
      return res.status(400).json({ error: 'Eksik parametre' });
    }

    var enNum = parseInt(en, 10);
    var boyNum = parseInt(boy, 10);

    if (isNaN(enNum) || isNaN(boyNum) || enNum < 10 || enNum > 350 || boyNum < 10 || boyNum > 350) {
      return res.status(400).json({ error: 'Gecersiz ebat (10-350 cm)' });
    }

    var rawData = await fetchMetaobjects();
    var saseTipleri = parseFields(rawData.saseList.nodes, 'ad');
    var bezTipleri = parseFields(rawData.bezList.nodes, 'ad');
    var sabitler = parseSabitler(rawData.sabitler.nodes);

    var saseConfig = saseTipleri[sase];
    var bezConfig = bezTipleri[bez];

    if (!saseConfig) {
      return res.status(400).json({ error: 'Gecersiz sase: ' + sase });
    }
    if (!bezConfig) {
      return res.status(400).json({ error: 'Gecersiz bez: ' + bez });
    }

    var result = hesaplaTuvalFiyat(enNum, boyNum, saseConfig, bezConfig, sabitler);

    if (action === 'add_to_cart') {
      var variant = await createVariantWithPrice(result.fiyat, enNum, boyNum, sase, bez);
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
    return res.status(500).json({ error: 'Hesaplama hatasi' });
  }
};
