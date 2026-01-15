<?php
/**
 * Plugin Name: Bazonia Frontend
 * Plugin URI: https://sermasivo.com/bazonia
 * Description: Dynamic variant updates via ZINC API webhook - TiendaMia-style UX
 * Version: 1.4.14
 * Requires at least: 6.5
 * Requires PHP: 8.1
 * Author: SerMasivo
 * Author URI: https://sermasivo.com
 * License: GPL v2 or later
 * Text Domain: bazonia-frontend
 * WC requires at least: 8.0
 * WC tested up to: 9.5
 * 
 * v1.4.14 - ZINC enrichment + WooCommerce sync
 * - Based on v1.4.9 (working base)
 * - NEW: bazonia_sync_to_wc endpoint to save ZINC data to WooCommerce
 * - NEW: Image download to Media Library
 * - NEW: manage_stock + stock_quantity for Divi Stock Module
 * - NEW: Hide price range for variable products (single price only)
 * - FIX: Weight format to 2 decimals
 * 
 * v1.4.9 - Fix regressions from v1.4.8
 * - Restored form.submit() flow that worked in v1.4.7
 * - Fixed stock display  
 * - Fixed add to cart button logic
 * - Added discount/stars support from n8n
 * - Kept unique cart item keys to fix cart overwrite bug
 */

defined('ABSPATH') || exit;

define('BAZONIA_FRONTEND_VERSION', '1.4.14');
define('BAZONIA_FRONTEND_FILE', __FILE__);
define('BAZONIA_FRONTEND_PATH', plugin_dir_path(__FILE__));
define('BAZONIA_FRONTEND_URL', plugin_dir_url(__FILE__));

// WooCommerce HPOS compatibility
add_action('before_woocommerce_init', function(): void {
    if (class_exists(\Automattic\WooCommerce\Utilities\FeaturesUtil::class)) {
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('custom_order_tables', __FILE__, true);
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('cart_checkout_blocks', __FILE__, true);
    }
});

/**
 * Main plugin class - v1.4.9
 */
final class Bazonia_Frontend {
    
    private static ?self $instance = null;
    private string $webhook_url = 'https://n8n.sermasivo.com/webhook/bazonia-get-variant';
    
    public static function instance(): self {
        if (self::$instance === null) {
            self::$instance = new self();
        }
        return self::$instance;
    }
    
    private function __construct() {
        add_action('init', [$this, 'start_session'], 1);
        add_action('init', [$this, 'load_textdomain'], 5);
        add_action('wp_enqueue_scripts', [$this, 'enqueue_scripts'], 20);
        $this->webhook_url = apply_filters('bazonia_webhook_url', $this->webhook_url);
    }
    
    public function start_session(): void {
        if (!session_id() && !headers_sent()) {
            session_start();
        }
    }
    
    public function load_textdomain(): void {
        load_plugin_textdomain('bazonia-frontend', false, dirname(plugin_basename(__FILE__)) . '/languages');
    }
    
    public function enqueue_scripts(): void {
        if (is_admin()) return;
        
        $product_id = 0;
        $product = null;
        
        if (function_exists('is_product') && is_product()) {
            $product_id = get_the_ID();
        } elseif (is_singular('product')) {
            $product_id = get_the_ID();
        } elseif (get_post_type() === 'product') {
            $product_id = get_the_ID();
        } elseif (isset($_SERVER['REQUEST_URI']) && strpos($_SERVER['REQUEST_URI'], '/product/') !== false) {
            global $wpdb;
            if (preg_match('#/product/([^/\?]+)#', $_SERVER['REQUEST_URI'], $matches)) {
                $slug = sanitize_title($matches[1]);
                $product_id = $wpdb->get_var($wpdb->prepare(
                    "SELECT ID FROM {$wpdb->posts} WHERE post_name = %s AND post_type = 'product' LIMIT 1",
                    $slug
                ));
            }
        }
        
        if (!$product_id) return;
        
        $product = wc_get_product($product_id);
        if (!$product instanceof \WC_Product) return;
        
        $variants_json = get_post_meta($product_id, '_bazonia_variants_json', true);
        
        if (!$product->is_type('variable') && empty($variants_json)) return;
        
        $variants = [];
        if (!empty($variants_json) && is_string($variants_json)) {
            $decoded = json_decode($variants_json, true);
            if (json_last_error() === JSON_ERROR_NONE && is_array($decoded)) {
                $variants = $decoded;
            }
        }
        
        $default_variant = null;
        foreach ($variants as $variant) {
            if (!empty($variant['price']) && floatval($variant['price']) > 0) {
                $default_variant = $variant;
                break;
            }
        }
        if (!$default_variant && !empty($variants)) {
            $default_variant = $variants[0];
        }
        
        $parent_weight = $product->get_weight();
        
        wp_enqueue_script(
            'bazonia-frontend',
            BAZONIA_FRONTEND_URL . 'js/bazonia-frontend.js',
            ['jquery'],
            BAZONIA_FRONTEND_VERSION,
            ['in_footer' => true, 'strategy' => 'defer']
        );
        
        wp_localize_script('bazonia-frontend', 'bazonia_data', [
            'webhook_url'       => esc_url($this->webhook_url),
            'variants'          => $variants,
            'default_variant'   => $default_variant,
            'product_id'        => absint($product_id),
            'parent_weight'     => floatval($parent_weight),
            'currency_symbol'   => html_entity_decode(get_woocommerce_currency_symbol()),
            'currency_pos'      => get_option('woocommerce_currency_pos', 'left'),
            'decimals'          => absint(get_option('woocommerce_price_num_decimals', 2)),
            'decimal_sep'       => get_option('woocommerce_price_decimal_sep', '.'),
            'thousand_sep'      => get_option('woocommerce_price_thousand_sep', ','),
            'i18n'              => [
                'loading'       => esc_html__('Cargando...', 'bazonia-frontend'),
                'checking'      => esc_html__('Verificando...', 'bazonia-frontend'),
                'in_stock'      => esc_html__('En stock', 'bazonia-frontend'),
                'out_of_stock'  => esc_html__('Agotado', 'bazonia-frontend'),
                'unavailable'   => esc_html__('No disponible', 'bazonia-frontend'),
                'error'         => esc_html__('Error al consultar', 'bazonia-frontend'),
                'select_options'=> esc_html__('Selecciona opciones', 'bazonia-frontend'),
                'reviews'       => esc_html__('calificaciones', 'bazonia-frontend'),
                'off'           => esc_html__('OFF', 'bazonia-frontend'),
            ],
            'nonce'             => wp_create_nonce('bazonia_frontend'),
            'ajax_url'          => admin_url('admin-ajax.php'),
            'cart_url'          => wc_get_cart_url(),
        ]);
        
        $this->add_inline_styles();
    }
    
    private function add_inline_styles(): void {
        $css = '
/* BAZONIA FRONTEND v1.4.14 */

/* ==========================================
   HIDE PRICE RANGE FOR VARIABLE PRODUCTS
   Only show single price, never $X - $Y range
   ========================================== */

/* Hide ALL price ranges site-wide */
.et_pb_wc_price .price del,
.et_pb_wc_price .price ins,
.et_pb_wc_price .price > .woocommerce-Price-amount:first-child:not(:last-child),
.et_pb_wc_price .price > span.woocommerce-Price-amount ~ span.woocommerce-Price-amount:not(.bazonia-current-price),
.woocommerce-variation-price,
.price del + ins,
.price > .woocommerce-Price-amount + .woocommerce-Price-amount,
.price > .woocommerce-Price-amount + span + .woocommerce-Price-amount {
    display: none !important;
}

/* Ensure only bazonia price wrapper shows */
.et_pb_wc_price .price .bazonia-price-wrapper {
    display: flex !important;
}

/* Hide WooCommerce default variation prices */
.et_pb_wc_add_to_cart .price,
.et_pb_wc_add_to_cart .woocommerce-Price-amount,
.et_pb_wc_add_to_cart .woocommerce-variation-price,
.et_pb_wc_add_to_cart .woocommerce-variation-availability,
.woocommerce-variation-price,
.woocommerce-variation .woocommerce-Price-amount,
.single_variation_wrap .price,
.single_variation .price,
form.variations_form .woocommerce-variation-price {
    display: none !important;
}

/* Spinner */
.bazonia-spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid #e5e7eb;
    border-top-color: #3b82f6;
    border-radius: 50%;
    animation: bazonia-spin 0.6s linear infinite;
    vertical-align: middle;
    margin-right: 6px;
}

@keyframes bazonia-spin {
    to { transform: rotate(360deg); }
}

/* PRICE MODULE */
.et_pb_wc_price .price {
    display: flex !important;
    flex-direction: column;
    gap: 4px;
}

.bazonia-price-wrapper {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.bazonia-discount-line {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 14px;
}

.bazonia-original-price {
    text-decoration: line-through;
    color: #6b7280;
    font-size: 0.9em;
}

.bazonia-discount-badge {
    background: #dc2626;
    color: white;
    padding: 2px 8px;
    border-radius: 4px;
    font-weight: 600;
    font-size: 12px;
}

.bazonia-current-price {
    font-size: 1.4em;
    font-weight: 700;
    color: #111;
}

.bazonia-loading, .bazonia-select, .bazonia-error, .bazonia-loading-text {
    font-size: 16px;
    color: #666;
}

.bazonia-flash {
    animation: bazonia-flash-anim 0.3s ease;
}
@keyframes bazonia-flash-anim {
    0% { opacity: 0.5; }
    100% { opacity: 1; }
}

/* STOCK MODULE */
.et_pb_wc_stock .stock {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 600;
}

.et_pb_wc_stock .stock.in-stock {
    background-color: #dcfce7;
    color: #166534;
}

.et_pb_wc_stock .stock.out-of-stock {
    background-color: #fee2e2;
    color: #991b1b;
}

.bazonia-stock-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
}

.bazonia-stock-dot.in { background: #22c55e; }
.bazonia-stock-dot.out { background: #ef4444; }

/* RATING/STARS */
.bazonia-rating {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
}

.bazonia-stars {
    color: #f59e0b;
    font-size: 16px;
    letter-spacing: 1px;
}

.bazonia-stars-empty { color: #d1d5db; }

.bazonia-rating-number {
    font-weight: 600;
    color: #111;
}

.bazonia-review-count { color: #6b7280; }

/* IMAGE LOADING */
.et_pb_wc_images.bazonia-image-loading,
.et_pb_wc_gallery.bazonia-image-loading {
    position: relative;
}

.et_pb_wc_images.bazonia-image-loading::after,
.et_pb_wc_gallery.bazonia-image-loading::after {
    content: "";
    position: absolute;
    top: 50%;
    left: 50%;
    width: 32px;
    height: 32px;
    margin: -16px 0 0 -16px;
    border: 3px solid #e5e7eb;
    border-top-color: #3b82f6;
    border-radius: 50%;
    animation: bazonia-spin 0.6s linear infinite;
    z-index: 10;
}

.et_pb_wc_images.bazonia-image-loading img,
.et_pb_wc_gallery.bazonia-image-loading img {
    opacity: 0.5;
}

/* WEIGHT */
.bazonia-weight {
    font-weight: 600;
    color: #111;
}

/* BUTTON */
.single_add_to_cart_button.bazonia-disabled {
    opacity: 0.5;
    pointer-events: none;
}
';
        
        wp_add_inline_style('bazonia-frontend', $css);
        
        if (!wp_style_is('bazonia-frontend', 'enqueued')) {
            add_action('wp_head', function() use ($css) {
                echo '<style id="bazonia-frontend-css">' . $css . '</style>';
            }, 99);
        }
    }
}

// Initialize
add_action('plugins_loaded', function(): void {
    if (class_exists('WooCommerce')) {
        Bazonia_Frontend::instance();
    }
});

// =============================================
// AJAX HANDLERS
// =============================================

add_action('wp_ajax_bazonia_save_price', 'bazonia_save_price');
add_action('wp_ajax_nopriv_bazonia_save_price', 'bazonia_save_price');

function bazonia_save_price(): void {
    check_ajax_referer('bazonia_frontend', 'nonce');
    
    if (!session_id()) session_start();
    
    $product_id = absint($_POST['product_id'] ?? 0);
    $asin = sanitize_text_field($_POST['asin'] ?? '');
    $price = floatval($_POST['price'] ?? 0);
    $image = esc_url_raw($_POST['image'] ?? '');
    $specs = json_decode(stripslashes($_POST['specs'] ?? '{}'), true);
    
    if (!$product_id || $price <= 0) {
        wp_send_json_error(['message' => 'Invalid data']);
        return;
    }
    
    $variant_key = $asin ?: 'pid_' . $product_id;
    
    if (!isset($_SESSION['bazonia_prices'])) {
        $_SESSION['bazonia_prices'] = [];
    }
    
    $_SESSION['bazonia_prices'][$variant_key] = [
        'product_id' => $product_id,
        'asin' => $asin,
        'price' => $price,
        'image' => $image,
        'specs' => $specs ?: [],
        'timestamp' => time(),
    ];
    
    $_SESSION['bazonia_current_' . $product_id] = $variant_key;
    
    wp_send_json_success([
        'saved' => true,
        'key' => $variant_key,
        'price' => $price,
    ]);
}

// =============================================
// NEW: SYNC ZINC DATA TO WOOCOMMERCE - v1.4.14
// =============================================

add_action('wp_ajax_bazonia_sync_to_wc', 'bazonia_sync_to_wc');
add_action('wp_ajax_nopriv_bazonia_sync_to_wc', 'bazonia_sync_to_wc');

/**
 * Sync ZINC data to WooCommerce variation
 * Downloads image to Media Library and updates variation meta
 */
function bazonia_sync_to_wc(): void {
    check_ajax_referer('bazonia_frontend', 'nonce');
    
    $product_id = absint($_POST['product_id'] ?? 0);
    $variation_id = absint($_POST['variation_id'] ?? 0);
    $price = floatval($_POST['price'] ?? 0);
    $original_price = floatval($_POST['original_price'] ?? 0);
    $image_url = esc_url_raw($_POST['image_url'] ?? '');
    $weight = floatval($_POST['weight'] ?? 0);
    $stock_qty = absint($_POST['stock_qty'] ?? 100);
    $in_stock = filter_var($_POST['in_stock'] ?? true, FILTER_VALIDATE_BOOLEAN);
    
    if (!$product_id) {
        wp_send_json_error(['message' => 'Missing product_id']);
        return;
    }
    
    // Determine target: variation or parent product
    $target_id = $variation_id > 0 ? $variation_id : $product_id;
    $target = wc_get_product($target_id);
    
    if (!$target) {
        wp_send_json_error(['message' => 'Product not found: ' . $target_id]);
        return;
    }
    
    $changes = [];
    
    // 1. DOWNLOAD IMAGE TO MEDIA LIBRARY
    if (!empty($image_url) && strpos($image_url, 'http') === 0) {
        $existing_image_id = get_post_meta($target_id, '_bazonia_image_id', true);
        $existing_image_url = get_post_meta($target_id, '_bazonia_image_url', true);
        
        // Only download if URL changed or no existing image
        if ($existing_image_url !== $image_url || !$existing_image_id) {
            $image_id = bazonia_download_image_to_library($image_url, $target_id);
            
            if ($image_id && !is_wp_error($image_id)) {
                // Set as variation/product image
                if ($variation_id > 0) {
                    update_post_meta($target_id, '_thumbnail_id', $image_id);
                } else {
                    set_post_thumbnail($target_id, $image_id);
                }
                
                // Save reference to avoid re-downloading
                update_post_meta($target_id, '_bazonia_image_id', $image_id);
                update_post_meta($target_id, '_bazonia_image_url', $image_url);
                
                $changes['image_id'] = $image_id;
            }
        } else {
            $changes['image_id'] = 'cached';
        }
    }
    
    // 2. UPDATE PRICES
    if ($price > 0) {
        if ($original_price > $price) {
            // Has discount: regular = original, sale = current
            $target->set_regular_price($original_price);
            $target->set_sale_price($price);
            $changes['regular_price'] = $original_price;
            $changes['sale_price'] = $price;
        } else {
            // No discount: regular = current, no sale
            $target->set_regular_price($price);
            $target->set_sale_price('');
            $changes['regular_price'] = $price;
        }
    }
    
    // 3. UPDATE STOCK - Critical for Divi Stock Module
    $target->set_manage_stock(true);
    $target->set_stock_quantity($in_stock ? $stock_qty : 0);
    $target->set_stock_status($in_stock ? 'instock' : 'outofstock');
    $changes['manage_stock'] = true;
    $changes['stock_quantity'] = $in_stock ? $stock_qty : 0;
    
    // 4. UPDATE WEIGHT
    if ($weight > 0) {
        $target->set_weight(round($weight, 2));
        $changes['weight'] = round($weight, 2);
    }
    
    // 5. SAVE
    $target->save();
    
    // Also update post_meta directly as fallback
    update_post_meta($target_id, '_manage_stock', 'yes');
    update_post_meta($target_id, '_stock', $in_stock ? $stock_qty : 0);
    update_post_meta($target_id, '_stock_status', $in_stock ? 'instock' : 'outofstock');
    
    // Mark as enriched by ZINC
    update_post_meta($target_id, '_bazonia_zinc_enriched', current_time('mysql'));
    update_post_meta($target_id, '_bazonia_zinc_price', $price);
    
    wp_send_json_success([
        'synced' => true,
        'target_id' => $target_id,
        'changes' => $changes,
    ]);
}

/**
 * Download image from URL and add to Media Library
 */
function bazonia_download_image_to_library(string $url, int $post_id): int|WP_Error {
    // Require media handling functions
    require_once(ABSPATH . 'wp-admin/includes/file.php');
    require_once(ABSPATH . 'wp-admin/includes/media.php');
    require_once(ABSPATH . 'wp-admin/includes/image.php');
    
    // Download file to temp location
    $tmp = download_url($url, 30);
    
    if (is_wp_error($tmp)) {
        return $tmp;
    }
    
    // Get filename from URL
    $url_parts = parse_url($url);
    $path_parts = pathinfo($url_parts['path'] ?? '');
    $filename = sanitize_file_name($path_parts['basename'] ?? 'bazonia-image-' . time() . '.jpg');
    
    // Ensure proper extension
    if (empty($path_parts['extension'])) {
        $filename .= '.jpg';
    }
    
    $file_array = [
        'name' => $filename,
        'tmp_name' => $tmp,
    ];
    
    // Upload to Media Library
    $attachment_id = media_handle_sideload($file_array, $post_id);
    
    // Clean up temp file
    if (file_exists($tmp)) {
        @unlink($tmp);
    }
    
    return $attachment_id;
}

// =============================================
// WOOCOMMERCE CART FILTERS
// =============================================

add_filter('woocommerce_add_cart_item_data', 'bazonia_add_cart_item_data', 10, 3);

function bazonia_add_cart_item_data($cart_item_data, $product_id, $variation_id) {
    if (!session_id()) session_start();
    
    $current_key = $_SESSION['bazonia_current_' . $product_id] ?? null;
    
    if ($current_key && isset($_SESSION['bazonia_prices'][$current_key])) {
        $saved = $_SESSION['bazonia_prices'][$current_key];
        
        $cart_item_data['bazonia_variant_key'] = $current_key;
        $cart_item_data['bazonia_asin'] = $saved['asin'] ?? '';
        $cart_item_data['bazonia_price'] = $saved['price'] ?? 0;
        $cart_item_data['bazonia_image'] = $saved['image'] ?? '';
        $cart_item_data['bazonia_specs'] = $saved['specs'] ?? [];
    }
    
    return $cart_item_data;
}

add_action('woocommerce_before_calculate_totals', 'bazonia_apply_cart_prices', 20);

function bazonia_apply_cart_prices($cart): void {
    if (is_admin() && !defined('DOING_AJAX')) return;
    
    foreach ($cart->get_cart() as $cart_item) {
        if (!empty($cart_item['bazonia_price']) && $cart_item['bazonia_price'] > 0) {
            $cart_item['data']->set_price($cart_item['bazonia_price']);
        }
    }
}

add_filter('woocommerce_cart_item_thumbnail', 'bazonia_cart_item_thumbnail', 10, 3);

function bazonia_cart_item_thumbnail($image, $cart_item, $cart_item_key) {
    if (!empty($cart_item['bazonia_image'])) {
        $img_url = esc_url($cart_item['bazonia_image']);
        return '<img src="' . $img_url . '" class="attachment-woocommerce_thumbnail" alt="" width="100">';
    }
    return $image;
}

add_filter('woocommerce_cart_item_price', 'bazonia_cart_item_price', 10, 3);

function bazonia_cart_item_price($price, $cart_item, $cart_item_key) {
    if (!empty($cart_item['bazonia_price']) && $cart_item['bazonia_price'] > 0) {
        return wc_price($cart_item['bazonia_price']);
    }
    return $price;
}

add_filter('woocommerce_cart_item_subtotal', 'bazonia_cart_item_subtotal', 10, 3);

function bazonia_cart_item_subtotal($subtotal, $cart_item, $cart_item_key) {
    if (!empty($cart_item['bazonia_price']) && $cart_item['bazonia_price'] > 0) {
        $qty = $cart_item['quantity'] ?? 1;
        return wc_price($cart_item['bazonia_price'] * $qty);
    }
    return $subtotal;
}

add_filter('woocommerce_cart_item_name', 'bazonia_cart_item_name', 10, 3);

function bazonia_cart_item_name($name, $cart_item, $cart_item_key) {
    if (!empty($cart_item['bazonia_specs']) && is_array($cart_item['bazonia_specs'])) {
        $specs = $cart_item['bazonia_specs'];
        
        $variant_parts = [];
        if (!empty($specs['Capacity'])) $variant_parts[] = $specs['Capacity'];
        if (!empty($specs['Color'])) $variant_parts[] = $specs['Color'];
        if (!empty($specs['Set'])) $variant_parts[] = $specs['Set'];
        
        if (!empty($variant_parts)) {
            if (strpos($name, '</a>') !== false) {
                $name .= '<br><small style="color:#666;">' . esc_html(implode(' / ', $variant_parts)) . '</small>';
            } else {
                $name .= ' - ' . esc_html(implode(' / ', $variant_parts));
            }
        }
    }
    return $name;
}

add_filter('wc_add_to_cart_message_html', 'bazonia_add_to_cart_message', 10, 2);

function bazonia_add_to_cart_message($message, $products) {
    if (!session_id()) session_start();
    
    foreach ($products as $product_id => $qty) {
        $current_key = $_SESSION['bazonia_current_' . $product_id] ?? null;
        
        if ($current_key && isset($_SESSION['bazonia_prices'][$current_key])) {
            $saved = $_SESSION['bazonia_prices'][$current_key];
            $specs = $saved['specs'] ?? [];
            
            if (!empty($specs)) {
                $variant_parts = [];
                if (!empty($specs['Capacity'])) $variant_parts[] = $specs['Capacity'];
                if (!empty($specs['Color'])) $variant_parts[] = $specs['Color'];
                
                if (!empty($variant_parts)) {
                    $variant_text = implode(', ', $variant_parts);
                    $product = wc_get_product($product_id);
                    $base_name = $product ? $product->get_name() : '';
                    
                    $new_name = $base_name . ' (' . $variant_text . ')';
                    $message = str_replace('"' . $base_name . '"', '"' . $new_name . '"', $message);
                }
            }
        }
    }
    
    return $message;
}

register_activation_hook(__FILE__, function(): void {
    if (version_compare(PHP_VERSION, '8.1', '<')) {
        deactivate_plugins(plugin_basename(__FILE__));
        wp_die('Bazonia Frontend requires PHP 8.1+');
    }
    if (!class_exists('WooCommerce')) {
        deactivate_plugins(plugin_basename(__FILE__));
        wp_die('Bazonia Frontend requires WooCommerce');
    }
});
