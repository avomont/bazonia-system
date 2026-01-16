/*************************************************************
 * BAZONIA SYNC - Google Sheets → WooCommerce
 * Repo: github.com/avomont/bazonia-system
 * Historial de cambios: ver CHANGELOG.md o git log
 *************************************************************/


// ==============================
// CONFIGURACIÓN
// ==============================
const WC_URL = 'https://bazonia.sermasivo.com';
const WC_KEY = 'ck_8f4045e8a2ac97eacec10865b822bdd04b48bc98';
const WC_SECRET = 'cs_a243e248600a41e0af9a2cd299309d8dd2365f8f';

// WordPress Application Password (para media upload)
const WP_USER = 'avomont';
const WP_APP_PASS = 'cg6N HdXq VtQQ ZPLY DDKE taYy';
const WP_BASIC = Utilities.base64Encode(`${WP_USER}:${WP_APP_PASS}`);

// Configuración de sync - OPTIMIZADO
const UPLOAD_IMAGES = true;
const MAX_IMAGES = 5;        // Reducido de 10 a 5 para velocidad
const SLEEP_MS = 150;        // Reducido de 300 a 150
const VAR_BATCH = 100;       // Aumentado de 50 a 100

// Categorías
const CATEGORIES_SHEET_NAME = 'CATEGORÍAS';
const DEFAULT_CATEGORY_NAME = 'Otros';

// ==============================
// MENÚ
// ==============================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🛒 BAZONIA SYNC')
    .addItem('▶️ Sincronizar TODO', 'syncActiveSheet')
    .addItem('▶️ Sincronizar SELECCIÓN', 'syncSelection')
    .addItem('⏹ Cancelar sync', 'stopSync')
    .addSeparator()
    .addItem('📊 Estadísticas', 'showStats')
    .addItem('🔄 Refrescar categorías', 'refreshCategories')
    .addItem('🏷️ Refrescar brands', 'refreshBrands')
        .addItem('📁 Crear TODAS las categorías', 'createAllCategories')
    .addToUi();
}

function stopSync() {
  PropertiesService.getScriptProperties().setProperty('BAZONIA_STOP', '1');
  SpreadsheetApp.getUi().alert('⏹ Sync se detendrá después del producto actual');
}

function showStats() {
  const sh = SpreadsheetApp.getActive().getActiveSheet();
  const data = sh.getDataRange().getValues();
  if (!data || data.length < 2) {
    SpreadsheetApp.getUi().alert('No hay datos');
    return;
  }
  const headers = data[0].map(h => String(h).trim());
  const id = mapHeaders(headers);
  
  const statusCol = id['sync_status'];
  if (statusCol === undefined) {
    SpreadsheetApp.getUi().alert('No hay columna sync_status. Ejecuta sync primero.');
    return;
  }

  let total = 0, synced = 0, errors = 0, pending = 0;
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const sku = id['SKU'] !== undefined ? String(row[id['SKU']]).trim() : '';
    if (!sku) continue;
    total++;

    const status = String(row[statusCol] || '').trim();
    if (status.includes('✅')) synced++;
    else if (status.includes('❌')) errors++;
    else pending++;
  }

  SpreadsheetApp.getUi().alert(
    `📊 BAZONIA Stats\n\n` +
    `Total: ${total}\n` +
    `✅ Sincronizados: ${synced}\n` +
    `❌ Errores: ${errors}\n` +
    `⏳ Pendientes: ${pending}`
  );
}

// ==============================
// UTILIDADES
// ==============================
function wcHeaders() {
  return {
    Authorization: 'Basic ' + Utilities.base64Encode(`${WC_KEY}:${WC_SECRET}`),
    'Content-Type': 'application/json'
  };
}

function wpHeaders() {
  return { Authorization: 'Basic ' + WP_BASIC };
}

function sanitize(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function money(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  if (!s || s === '0' || s === '0.0' || s === '0.00') return '';
  return s.replace(/[$€£¥,\s]/g, '').replace(/[^\d.\-]/g, '').trim();
}

function sleep(ms) { Utilities.sleep(ms); }

function mapHeaders(headers) {
  const idx = {};
  headers.forEach((h, i) => { idx[h] = i; });
  return idx;
}

function safeJsonParse(txt, fallback) {
  try { return JSON.parse(txt); } catch (e) { return fallback; }
}

function shortErr(txt, maxLen = 200) {
  const s = sanitize(txt);
  return s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
}

function nowTimestamp() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

function wcFetch(url, opt) {
  const res = UrlFetchApp.fetch(url, Object.assign({
    muteHttpExceptions: true,
    headers: wcHeaders()
  }, opt || {}));
  return {
    code: res.getResponseCode(),
    bodyTxt: res.getContentText() || '',
    body: safeJsonParse(res.getContentText(), null)
  };
}

// ==============================
// BRANDS - TAXONOMÍA WOOCOMMERCE
// ==============================
let WC_BRANDS_CACHE = null;

function refreshBrands() {
  WC_BRANDS_CACHE = null;
  listWooBrands();
  SpreadsheetApp.getUi().alert('✅ Brands refrescados: ' + WC_BRANDS_CACHE.length);
}

function listWooBrands() {
  if (WC_BRANDS_CACHE) return WC_BRANDS_CACHE;
  
  // Intentar obtener brands de la taxonomía pw_brand (Perfect WooCommerce Brands)
  // o product_brand (WooCommerce Brands)
  let all = [];
  
  // Primero intentamos con la API de términos de WordPress
  try {
    const url = `${WC_URL}/wp-json/wp/v2/product_brand?per_page=100`;
    const res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: wpHeaders()
    });
    if (res.getResponseCode() === 200) {
      all = safeJsonParse(res.getContentText(), []);
    }
  } catch (e) {
    Logger.log('⚠️ No se pudo obtener product_brand: ' + e);
  }
  
  // Si no hay, intentar con pw_brand
  if (all.length === 0) {
    try {
      const url = `${WC_URL}/wp-json/wp/v2/pwb-brand?per_page=100`;
      const res = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        headers: wpHeaders()
      });
      if (res.getResponseCode() === 200) {
        all = safeJsonParse(res.getContentText(), []);
      }
    } catch (e) {
      Logger.log('⚠️ No se pudo obtener pwb-brand: ' + e);
    }
  }
  
  WC_BRANDS_CACHE = all;
  Logger.log(`🏷️ ${all.length} brands cargados`);
  return WC_BRANDS_CACHE;
}

function ensureBrand(brandName) {
  if (!brandName) return null;
  
  const brands = listWooBrands();
  const norm = brandName.toLowerCase().trim();
  
  // Buscar existente
  const existing = brands.find(b => 
    String(b.name || b.title?.rendered || '').toLowerCase().trim() === norm
  );
  if (existing) return existing.id;
  
  // Crear nuevo brand
  // Intentar con product_brand primero
  try {
    const url = `${WC_URL}/wp-json/wp/v2/product_brand`;
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      muteHttpExceptions: true,
      headers: Object.assign({ 'Content-Type': 'application/json' }, wpHeaders()),
      payload: JSON.stringify({ name: brandName })
    });
    if (res.getResponseCode() === 201) {
      const newBrand = safeJsonParse(res.getContentText(), null);
      if (newBrand && newBrand.id) {
        WC_BRANDS_CACHE = null; // Invalidar cache
        return newBrand.id;
      }
    }
  } catch (e) {
    Logger.log('⚠️ No se pudo crear brand en product_brand: ' + e);
  }
  
  // Si falla, intentar con pwb-brand
  try {
    const url = `${WC_URL}/wp-json/wp/v2/pwb-brand`;
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      muteHttpExceptions: true,
      headers: Object.assign({ 'Content-Type': 'application/json' }, wpHeaders()),
      payload: JSON.stringify({ name: brandName })
    });
    if (res.getResponseCode() === 201) {
      const newBrand = safeJsonParse(res.getContentText(), null);
      if (newBrand && newBrand.id) {
        WC_BRANDS_CACHE = null;
        return newBrand.id;
      }
    }
  } catch (e) {
    Logger.log('⚠️ No se pudo crear brand en pwb-brand: ' + e);
  }
  
  return null;
}

/**
 * Asigna un brand a un producto usando WordPress REST API
 * Esto evita el problema de formato de la API de WooCommerce
 */
function assignBrandToProduct(productId, brandId) {
  if (!productId || !brandId) return false;
  
  // Intentar con product_brand (WooCommerce Core 9.6+)
  try {
    const url = `${WC_URL}/wp-json/wp/v2/product/${productId}`;
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      muteHttpExceptions: true,
      headers: Object.assign({ 'Content-Type': 'application/json' }, wpHeaders()),
      payload: JSON.stringify({ product_brand: [brandId] })
    });
    if (res.getResponseCode() >= 200 && res.getResponseCode() < 300) {
      return true;
    }
  } catch (e) {
    Logger.log('⚠️ Error asignando brand via product_brand: ' + e);
  }
  
  // Intentar con pwb-brand (Perfect WooCommerce Brands)
  try {
    const url = `${WC_URL}/wp-json/wp/v2/product/${productId}`;
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      muteHttpExceptions: true,
      headers: Object.assign({ 'Content-Type': 'application/json' }, wpHeaders()),
      payload: JSON.stringify({ 'pwb-brand': [brandId] })
    });
    if (res.getResponseCode() >= 200 && res.getResponseCode() < 300) {
      return true;
    }
  } catch (e) {
    Logger.log('⚠️ Error asignando brand via pwb-brand: ' + e);
  }
  
  return false;
}

// ==============================
// CATEGORÍAS - CACHE Y MAPPING
// ==============================
let WC_CATEGORIES_CACHE = null;
let CATEGORY_RULES_CACHE = null;

function refreshCategories() {
  WC_CATEGORIES_CACHE = null;
  CATEGORY_RULES_CACHE = null;
  listWooCategories();
  loadCategoryRules();
  SpreadsheetApp.getUi().alert('✅ Categorías refrescadas');
}

function listWooCategories() {
  if (WC_CATEGORIES_CACHE) return WC_CATEGORIES_CACHE;
  
  let all = [];
  let page = 1;
  while (true) {
    const url = `${WC_URL}/wp-json/wc/v3/products/categories?per_page=100&page=${page}`;
    const r = wcFetch(url, { method: 'get' });
    const cats = Array.isArray(r.body) ? r.body : [];
    if (cats.length === 0) break;
    all = all.concat(cats);
    page++;
    if (cats.length < 100) break;
  }
  
  WC_CATEGORIES_CACHE = all;
  Logger.log(`📁 ${all.length} categorías cargadas`);
  return WC_CATEGORIES_CACHE;
}

function ensureCategory(name, parentId = 0) {
  if (!name) return null;
  const cats = listWooCategories();
  const norm = name.toLowerCase().trim();
  
  const existing = cats.find(c =>
    String(c.name).toLowerCase().trim() === norm &&
    Number(c.parent || 0) === parentId
  );
  if (existing) return existing.id;

  const payload = parentId ? { name, parent: parentId } : { name };
  const r = wcFetch(`${WC_URL}/wp-json/wc/v3/products/categories`, {
    method: 'post',
    payload: JSON.stringify(payload)
  });
  
  if (r.body && r.body.id) {
    WC_CATEGORIES_CACHE = null;
    return r.body.id;
  }
  return null;
}

function loadCategoryRules() {
  if (CATEGORY_RULES_CACHE) return CATEGORY_RULES_CACHE;
  
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(CATEGORIES_SHEET_NAME) || ss.getSheetByName('CATEGORIAS');
  
  if (!sh) {
    Logger.log('⚠️ No existe hoja CATEGORÍAS');
    CATEGORY_RULES_CACHE = [];
    return CATEGORY_RULES_CACHE;
  }

  const values = sh.getDataRange().getValues();
  if (!values || values.length < 2) {
    CATEGORY_RULES_CACHE = [];
    return CATEGORY_RULES_CACHE;
  }

  const headers = values[0].map(h => String(h).trim());
  const idx = (name) => headers.indexOf(name);

  const rules = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const term = idx('term_name') >= 0 ? String(row[idx('term_name')] || '').trim() : '';
    if (!term) continue;

    rules.push({
      term_name: term,
      parent_name: idx('parent_name') >= 0 ? String(row[idx('parent_name')] || '').trim() : '',
      woo_cat_id: idx('woo_cat_id') >= 0 ? String(row[idx('woo_cat_id')] || '').trim() : '',
      rule_keywords: idx('rule_keywords') >= 0 ? String(row[idx('rule_keywords')] || '').trim() : '',
      amazon_keywords: idx('amazon_keywords') >= 0 ? String(row[idx('amazon_keywords')] || '').trim() : '',
      level: idx('level') >= 0 ? Number(row[idx('level')] || 0) : 0
    });
  }

  CATEGORY_RULES_CACHE = rules;
  Logger.log(`📋 ${rules.length} reglas de categorías`);
  return CATEGORY_RULES_CACHE;
}

function findCategoryByKeywords(name, brand, description) {
  const rules = loadCategoryRules();
  if (!rules.length) return null;

  const searchText = `${name || ''} ${brand || ''} ${description || ''}`.toLowerCase();
  
  let bestMatch = null;
  let bestScore = 0;

  for (const rule of rules) {
    const keywords = (rule.amazon_keywords || rule.rule_keywords || '').toLowerCase();
    if (!keywords) continue;

    const kwList = keywords.split(/[,|;]/).map(k => k.trim()).filter(k => k.length >= 3);
    let score = 0;
    
    for (const kw of kwList) {
      if (searchText.includes(kw)) {
        score += kw.length;
      }
    }

    score += (rule.level || 0) * 2;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = rule;
    }
  }

  return bestMatch;
}

function getCategoryId(row, id) {
  const v = (col) => id[col] !== undefined ? sanitize(row[id[col]]) : '';
  
  const existingCat = v('Categories');
  if (existingCat) {
    const cats = listWooCategories();
    const found = cats.find(c => c.name.toLowerCase() === existingCat.toLowerCase());
    if (found) return { id: found.id, name: found.name };
  }

  const name = v('Name');
  const brand = v('Tags') || v('meta:_bazonia_brand');
  const desc = v('Short description');
  
  const rule = findCategoryByKeywords(name, brand, desc);
  
  if (rule) {
    if (rule.woo_cat_id) {
      const catId = Number(rule.woo_cat_id);
      if (!isNaN(catId) && catId > 0) {
        return { id: catId, name: rule.term_name };
      }
    }
    
    let parentId = 0;
    if (rule.parent_name) {
      const cats = listWooCategories();
      const parent = cats.find(c => c.name.toLowerCase() === rule.parent_name.toLowerCase());
      parentId = parent ? parent.id : (ensureCategory(rule.parent_name) || 0);
    }
    
    const catId = ensureCategory(rule.term_name, parentId);
    if (catId) {
      return { id: catId, name: rule.term_name };
    }
  }

  const defaultId = ensureCategory(DEFAULT_CATEGORY_NAME);
  return defaultId ? { id: defaultId, name: DEFAULT_CATEGORY_NAME } : null;
}

// ==============================
// IMÁGENES - OPTIMIZADO
// ==============================
function uploadImage(url, filename) {
  if (!UPLOAD_IMAGES || !url) return null;
  
  try {
    const img = UrlFetchApp.fetch(url, {
      method: 'get',
      followRedirects: true,
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (BazoniaBot/1.0)' }
    });
    
    if (img.getResponseCode() < 200 || img.getResponseCode() >= 300) return null;

    const blob = img.getBlob();
    blob.setName(filename || 'image.jpg');

    const media = UrlFetchApp.fetch(`${WC_URL}/wp-json/wp/v2/media`, {
      method: 'post',
      headers: Object.assign({
        'Content-Disposition': `attachment; filename="${blob.getName()}"`
      }, wpHeaders()),
      payload: blob,
      muteHttpExceptions: true
    });

    const result = safeJsonParse(media.getContentText(), null);
    return result && result.id ? result : null;
  } catch (e) {
    Logger.log('❌ Image error: ' + e);
    return null;
  }
}

function prepareImages(imagesStr, sku) {
  if (!imagesStr) return [];
  
  const urls = imagesStr.split(',').map(u => u.trim()).filter(Boolean).slice(0, MAX_IMAGES);
  const images = [];
  
  for (let i = 0; i < urls.length; i++) {
    const media = uploadImage(urls[i], `${sku}_${i + 1}.jpg`);
    if (media && media.id) {
      images.push({ id: media.id });
    }
    // Sin sleep entre imágenes para mayor velocidad
  }
  
  return images;
}

// ==============================
// PRODUCTO - BUSCAR/CREAR/ACTUALIZAR
// ==============================
function findProductBySKU(sku) {
  const statuses = ['any', 'trash', 'draft', 'pending', 'private', 'publish'];
  for (const status of statuses) {
    const url = `${WC_URL}/wp-json/wc/v3/products?per_page=1&sku=${encodeURIComponent(sku)}&status=${status}`;
    const r = wcFetch(url, { method: 'get' });
    const arr = Array.isArray(r.body) ? r.body : [];
    if (arr.length && arr[0].id) return arr[0];
  }
  return null;
}

function upsertProduct(payload, existingId, sku) {
  if (existingId) {
    const r = wcFetch(`${WC_URL}/wp-json/wc/v3/products/${existingId}`, {
      method: 'put',
      payload: JSON.stringify(payload)
    });
    if (r.code === 200 && r.body && r.body.id) {
      return { action: 'update', product: r.body };
    }
  }

  const found = findProductBySKU(sku);
  if (found && found.id) {
    const r = wcFetch(`${WC_URL}/wp-json/wc/v3/products/${found.id}`, {
      method: 'put',
      payload: JSON.stringify(payload)
    });
    if (r.code === 200 && r.body && r.body.id) {
      return { action: 'update', product: r.body };
    }
  }

  const r = wcFetch(`${WC_URL}/wp-json/wc/v3/products`, {
    method: 'post',
    payload: JSON.stringify(payload)
  });

  if ((r.code === 200 || r.code === 201) && r.body && r.body.id) {
    return { action: 'create', product: r.body };
  }

  if (r.code === 400 && r.bodyTxt.toLowerCase().includes('sku')) {
    const retry = findProductBySKU(sku);
    if (retry && retry.id) {
      const u = wcFetch(`${WC_URL}/wp-json/wc/v3/products/${retry.id}`, {
        method: 'put',
        payload: JSON.stringify(payload)
      });
      if (u.code === 200 && u.body) return { action: 'update', product: u.body };
    }
  }

  return { action: 'error', error: `HTTP ${r.code}: ${shortErr(r.bodyTxt)}` };
}

// ==============================
// VARIACIONES
// ==============================
function syncVariations(productId, variantsJson, sku, attributes) {
  if (!variantsJson) return 0;
  
  let variants;
  try {
    variants = JSON.parse(variantsJson);
  } catch (e) {
    return 0;
  }
  
  if (!Array.isArray(variants) || variants.length === 0) return 0;

  // Eliminar variaciones existentes
  try {
    const r = wcFetch(`${WC_URL}/wp-json/wc/v3/products/${productId}/variations?per_page=100`, { method: 'get' });
    const existing = Array.isArray(r.body) ? r.body : [];
    if (existing.length) {
      wcFetch(`${WC_URL}/wp-json/wc/v3/products/${productId}/variations/batch`, {
        method: 'post',
        payload: JSON.stringify({ delete: existing.map(v => v.id) })
      });
    }
  } catch (e) { /* ignore */ }

  let created = 0;
  const varAttrs = attributes.filter(a => a.variation);

  for (let i = 0; i < variants.length; i += VAR_BATCH) {
    const chunk = variants.slice(i, i + VAR_BATCH);
    
    const create = chunk.map((v, idx) => {
      const varSku = `${sku}_V${String(i + idx + 1).padStart(3, '0')}`;
      
      const attrs = [];
      if (v.specs) {
        for (const attr of varAttrs) {
          const val = v.specs[attr.name];
          if (val) attrs.push({ name: attr.name, option: val });
        }
      }

      return {
        sku: varSku,
        regular_price: money(v.price) || '0',
        attributes: attrs,
        manage_stock: false,
        stock_status: 'instock',
        meta_data: [
          { key: '_bazonia_variant_asin', value: v.id || '' }
        ]
      };
    });

    const r = wcFetch(`${WC_URL}/wp-json/wc/v3/products/${productId}/variations/batch`, {
      method: 'post',
      payload: JSON.stringify({ create })
    });

    if (r.body && r.body.create) {
      created += r.body.create.filter(v => v.id).length;
    }
    sleep(100);
  }

  return created;
}

// ==============================
// PROCESAR FILA
// ==============================
function processRow(sheet, row, rowIdx, id, headers) {
  const v = (col) => id[col] !== undefined ? sanitize(row[id[col]]) : '';
  
  const sku = v('SKU');
  if (!sku) return { action: 'skip', reason: 'Sin SKU' };

  const inStock = v('In stock?');
  if (inStock === '0' || inStock.toLowerCase() === 'false') {
    setCell(sheet, rowIdx, id, headers, 'sync_status', '⏭️ OOS');
    setCell(sheet, rowIdx, id, headers, 'sync_log', 'Out of stock');
    setCell(sheet, rowIdx, id, headers, 'sync_timestamp', nowTimestamp());
    return { action: 'skip', reason: 'Out of stock' };
  }

  const productType = v('Type') || 'simple';
  const isVariable = productType === 'variable';
  
  const price = money(v('Regular price'));
  if (!price && !isVariable) {
    setCell(sheet, rowIdx, id, headers, 'sync_status', '⏭️ SIN PRECIO');
    setCell(sheet, rowIdx, id, headers, 'sync_log', 'Sin precio');
    setCell(sheet, rowIdx, id, headers, 'sync_timestamp', nowTimestamp());
    return { action: 'skip', reason: 'Sin precio' };
  }

  // Categoría
  const catInfo = getCategoryId(row, id);
  const categories = catInfo ? [{ id: catInfo.id }] : [];

  // Brand - como taxonomía
  const brandName = v('meta:_bazonia_brand') || v('Tags');
  const brandId = ensureBrand(brandName);
  
  // Imágenes
  const images = prepareImages(v('Images'), sku);

  // Atributos
  const attributes = [];
  for (let i = 1; i <= 3; i++) {
    const attrName = v(`Attribute ${i} name`);
    const attrValues = v(`Attribute ${i} value(s)`);
    const attrVisible = v(`Attribute ${i} visible`) !== '0';
    
    if (attrName && attrValues) {
      const options = attrValues.split('|').map(o => o.trim()).filter(Boolean);
      if (options.length) {
        attributes.push({
          name: attrName,
          options: options,
          visible: attrVisible,
          variation: isVariable
        });
      }
    }
  }

  // Meta data
  const meta_data = [
    { key: '_bazonia_asin', value: v('meta:_bazonia_asin') },
    { key: '_bazonia_parent_asin', value: v('meta:_bazonia_parent_asin') },
    { key: '_bazonia_brand', value: brandName },
    { key: '_bazonia_upc', value: v('meta:_bazonia_upc') },
    { key: '_bazonia_url', value: v('meta:_bazonia_url') },
    { key: '_bazonia_prime', value: v('meta:_bazonia_prime') },
    { key: '_bazonia_has_variants', value: v('meta:_bazonia_has_variants') },
    { key: '_bazonia_variants_count', value: v('meta:_bazonia_variants_count') },
    { key: '_bazonia_variants_json', value: v('meta:_bazonia_variants_json') },
    { key: '_bazonia_last_sync', value: nowTimestamp() },
    { key: '_bazonia_parser', value: v('meta:_bazonia_parser') }
  ].filter(m => m.value);

  // Payload
  const payload = {
    sku,
    name: v('Name'),
    type: productType,
    status: v('Published') === '1' ? 'publish' : 'draft',
    featured: v('Is featured?') === '1',
    catalog_visibility: v('Visibility in catalog') || 'visible',
    description: v('Description'),
    short_description: v('Short description'),
    regular_price: isVariable ? undefined : price,
    tax_status: v('Tax status') || 'taxable',
    manage_stock: false,
    stock_status: 'instock',
    weight: v('Weight (kg)'),
    dimensions: {
      length: v('Length (cm)'),
      width: v('Width (cm)'),
      height: v('Height (cm)')
    },
    categories,
    tags: brandName ? [{ name: brandName }] : [],
    images,
    attributes,
    meta_data
  };

  // NOTA: brands se omite del payload por incompatibilidad de formatos
  // Se asigna después vía WordPress REST API
  // if (brandId) { payload.brands = [brandId]; }

  const existingId = id['ID'] !== undefined ? Number(row[id['ID']]) : null;
  const result = upsertProduct(payload, (existingId && !isNaN(existingId) && existingId > 0) ? existingId : null, sku);

  if (result.action === 'error') {
    setCell(sheet, rowIdx, id, headers, 'sync_status', '❌ ERROR');
    setCell(sheet, rowIdx, id, headers, 'sync_log', shortErr(result.error));
    setCell(sheet, rowIdx, id, headers, 'sync_timestamp', nowTimestamp());
    return { action: 'error' };
  }

  const productId = result.product.id;

  // Asignar brand por separado (evita error de formato)
  if (brandId && productId) {
    assignBrandToProduct(productId, brandId);
  }

  // Variaciones
  let varCount = 0;
  if (isVariable) {
    const variantsJson = v('meta:_bazonia_variants_json');
    varCount = syncVariations(productId, variantsJson, sku, attributes);
  }

  // Actualizar sheet
  setCell(sheet, rowIdx, id, headers, 'ID', productId);
  setCell(sheet, rowIdx, id, headers, 'sync_status', '✅ OK');
  setCell(sheet, rowIdx, id, headers, 'sync_log', `${result.action} #${productId}${isVariable ? ` (${varCount}v)` : ''}`);
  setCell(sheet, rowIdx, id, headers, 'sync_timestamp', nowTimestamp());
  
  if (catInfo && catInfo.name) {
    setCell(sheet, rowIdx, id, headers, 'Categories', catInfo.name);
  }

  return { action: result.action, productId, varCount };
}

function setCell(sheet, row, id, headers, colName, value) {
  let colIdx = id[colName];
  
  if (colIdx === undefined) {
    // Agregar columna al final
    const lastCol = headers.length;
    headers.push(colName);
    colIdx = lastCol;
    id[colName] = colIdx;
    sheet.getRange(1, colIdx + 1).setValue(colName);
  }
  
  sheet.getRange(row, colIdx + 1).setValue(value);
}

// ==============================
// SYNC PRINCIPAL
// ==============================
function syncActiveSheet() {
  const sh = SpreadsheetApp.getActive().getActiveSheet();
  doSync(sh, null);
}

function syncSelection() {
  const sh = SpreadsheetApp.getActive().getActiveSheet();
  const range = sh.getActiveRange();
  if (!range) {
    SpreadsheetApp.getUi().alert('⚠️ Selecciona las filas a sincronizar');
    return;
  }
  doSync(sh, range);
}

function doSync(sh, selectionRange) {
  const data = sh.getDataRange().getValues();
  if (!data || data.length < 2) {
    SpreadsheetApp.getUi().alert('⚠️ No hay datos');
    return;
  }

  PropertiesService.getScriptProperties().deleteProperty('BAZONIA_STOP');

  let headers = data[0].map(h => String(h).trim());
  let id = mapHeaders(headers);

  // Asegurar columnas de control
  const syncCols = ['sync_status', 'sync_log', 'sync_timestamp'];
  for (const col of syncCols) {
    if (id[col] === undefined) {
      headers.push(col);
      id[col] = headers.length - 1;
      sh.getRange(1, headers.length).setValue(col);
    }
  }

  // Filas a procesar
  let rowsToProcess = [];
  if (selectionRange) {
    const first = selectionRange.getRow();
    const last = first + selectionRange.getNumRows() - 1;
    for (let r = first; r <= last; r++) {
      if (r >= 2) rowsToProcess.push(r);
    }
  } else {
    for (let r = 2; r <= sh.getLastRow(); r++) {
      rowsToProcess.push(r);
    }
  }

  if (rowsToProcess.length === 0) {
    SpreadsheetApp.getUi().alert('⚠️ No hay filas');
    return;
  }

  // Pre-cargar caches
  listWooCategories();
  loadCategoryRules();
  listWooBrands();

  let created = 0, updated = 0, errors = 0, skipped = 0;
  const startTime = new Date();

  for (const rowIdx of rowsToProcess) {
    if (PropertiesService.getScriptProperties().getProperty('BAZONIA_STOP') === '1') {
      SpreadsheetApp.getUi().alert('⏹ Cancelado');
      break;
    }

    const row = sh.getRange(rowIdx, 1, 1, headers.length).getValues()[0];

    try {
      const res = processRow(sh, row, rowIdx, id, headers);
      if (res.action === 'create') created++;
      else if (res.action === 'update') updated++;
      else if (res.action === 'error') errors++;
      else if (res.action === 'skip') skipped++;
    } catch (e) {
      errors++;
      setCell(sh, rowIdx, id, headers, 'sync_status', '❌ EXC');
      setCell(sh, rowIdx, id, headers, 'sync_log', shortErr(String(e)));
      setCell(sh, rowIdx, id, headers, 'sync_timestamp', nowTimestamp());
      Logger.log(`❌ Row ${rowIdx}: ${e}`);
    }

    sleep(SLEEP_MS);
  }

  const duration = Math.round((new Date() - startTime) / 1000);

  SpreadsheetApp.getUi().alert(
    `✅ BAZONIA Sync v11.1\n\n` +
    `🆕 Creados: ${created}\n` +
    `🔄 Actualizados: ${updated}\n` +
    `⏭️ Saltados: ${skipped}\n` +
    `❌ Errores: ${errors}\n\n` +
    `⏱️ ${duration}s (${rowsToProcess.length} productos)`
  );
}


// ==============================
// AUTO-CREAR CATEGORÍAS EN WOOCOMMERCE
// ==============================

/**
 * Crea todas las categorías del sheet CATEGORÍAS en WooCommerce
 * y llena automáticamente la columna woo_cat_id
 */
// ==============================
// AUTO-CREAR CATEGORÍAS EN WOOCOMMERCE (CORREGIDO)
// ==============================

/**
 * Crea todas las categorías del sheet CATEGORÍAS en WooCommerce
 * y llena automáticamente la columna woo_cat_id
 * CORREGIDO: Maneja categorías con mismo nombre bajo diferentes padres
 */
function createAllCategories() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(CATEGORIES_SHEET_NAME) || ss.getSheetByName('CATEGORIAS');
  
  if (!sh) {
    SpreadsheetApp.getUi().alert('❌ No existe hoja CATEGORÍAS');
    return;
  }
  
  const data = sh.getDataRange().getValues();
  if (!data || data.length < 2) {
    SpreadsheetApp.getUi().alert('❌ No hay datos en CATEGORÍAS');
    return;
  }
  
  const headers = data[0].map(h => String(h).trim());
  const termIdx = headers.indexOf('term_name');
  const parentIdx = headers.indexOf('parent_name');
  let wooIdIdx = headers.indexOf('woo_cat_id');
  
  if (termIdx < 0) {
    SpreadsheetApp.getUi().alert('❌ Falta columna term_name');
    return;
  }
  
  // Crear columna woo_cat_id si no existe
  if (wooIdIdx < 0) {
    wooIdIdx = headers.length;
    sh.getRange(1, wooIdIdx + 1).setValue('woo_cat_id');
  }
  
  // Refrescar cache de categorías
  WC_CATEGORIES_CACHE = null;
  listWooCategories();
  
  let created = 0, existed = 0, errors = 0;
  
  // Mapa local para trackear categorías creadas en esta sesión
  // Key: "nombre|parentId", Value: woo_cat_id
  const localCache = {};
  
  // Primera pasada: categorías padre (sin parent_name)
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const termName = String(row[termIdx] || '').trim();
    const parentName = parentIdx >= 0 ? String(row[parentIdx] || '').trim() : '';
    
    if (!termName || parentName) continue; // Solo padres en primera pasada
    
    const cacheKey = termName.toLowerCase() + '|0';
    
    // Verificar si ya tiene ID en el sheet
    const existingId = wooIdIdx < row.length ? String(row[wooIdIdx] || '').trim() : '';
    if (existingId && !isNaN(Number(existingId))) {
      localCache[cacheKey] = Number(existingId);
      existed++;
      continue;
    }
    
    const result = createOrFindCategoryFixed(termName, 0);
    if (result.id) {
      sh.getRange(i + 1, wooIdIdx + 1).setValue(result.id);
      localCache[cacheKey] = result.id;
      if (result.created) created++; else existed++;
    } else {
      errors++;
      Logger.log('❌ Error creando padre: ' + termName);
    }
    sleep(100);
  }
  
  // Refrescar cache después de crear padres
  WC_CATEGORIES_CACHE = null;
  listWooCategories();
  
  // Segunda pasada: categorías hijo (con parent_name)
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const termName = String(row[termIdx] || '').trim();
    const parentName = parentIdx >= 0 ? String(row[parentIdx] || '').trim() : '';
    
    if (!termName || !parentName) continue; // Solo hijos en segunda pasada
    
    // Verificar si ya tiene ID en el sheet
    const existingId = wooIdIdx < row.length ? String(row[wooIdIdx] || '').trim() : '';
    if (existingId && !isNaN(Number(existingId))) {
      existed++;
      continue;
    }
    
    // Buscar ID del padre en cache local primero
    const parentCacheKey = parentName.toLowerCase() + '|0';
    let parentId = localCache[parentCacheKey] || 0;
    
    // Si no está en cache local, buscar en WooCommerce
    if (!parentId) {
      const cats = listWooCategories();
      const parent = cats.find(c => 
        String(c.name).toLowerCase().trim() === parentName.toLowerCase().trim() &&
        Number(c.parent || 0) === 0
      );
      parentId = parent ? parent.id : 0;
    }
    
    if (!parentId) {
      Logger.log('⚠️ Padre no encontrado: ' + parentName + ' para ' + termName);
      errors++;
      continue;
    }
    
    const cacheKey = termName.toLowerCase() + '|' + parentId;
    
    const result = createOrFindCategoryFixed(termName, parentId);
    if (result.id) {
      sh.getRange(i + 1, wooIdIdx + 1).setValue(result.id);
      localCache[cacheKey] = result.id;
      if (result.created) created++; else existed++;
    } else {
      errors++;
      Logger.log('❌ Error creando hijo: ' + termName + ' bajo ' + parentName);
    }
    sleep(100);
  }
  
  SpreadsheetApp.getUi().alert(
    '✅ Categorías procesadas\n\n' +
    '🆕 Creadas: ' + created + '\n' +
    '🔄 Existentes: ' + existed + '\n' +
    '❌ Errores: ' + errors
  );
}

function createOrFindCategoryFixed(name, parentId) {
  const cats = listWooCategories();
  
  // Buscar si ya existe CON EL MISMO PADRE
  const existing = cats.find(c => 
    String(c.name).toLowerCase().trim() === name.toLowerCase().trim() &&
    Number(c.parent || 0) === Number(parentId)
  );
  
  if (existing) {
    return { id: existing.id, created: false };
  }
  
  // Crear nueva - SIEMPRE incluir parent aunque sea 0
  const payload = { name: name, parent: Number(parentId) };
  
  const r = wcFetch(WC_URL + '/wp-json/wc/v3/products/categories', {
    method: 'post',
    payload: JSON.stringify(payload)
  });
  
  if (r.body && r.body.id) {
    // Invalidar cache para que se recargue
    WC_CATEGORIES_CACHE = null;
    return { id: r.body.id, created: true };
  }
  
  Logger.log('❌ Error creando categoría ' + name + ' (parent:' + parentId + '): ' + r.bodyTxt);
  return { id: null, created: false };
}
