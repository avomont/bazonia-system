/**
 * Bazonia Frontend v1.4.14
 * 
 * Based on v1.4.9 (working base) + WooCommerce sync
 * 
 * Changes from v1.4.9:
 * - NEW: syncToWooCommerce() - saves ZINC data to WC (image, price, stock, weight)
 * - NEW: checkWooCommerceData() - checks if WC has complete data before calling ZINC
 * - FIX: Weight shows 2 decimals instead of 1
 * - FIX: Title replaces values instead of appending
 * 
 * From v1.4.9:
 * - Added updatePrice with discount display
 * - Added updateRating for stars
 * - Stock now handles both 'available' (old) and 'in_stock' (new) from webhook
 * 
 * Restored from v1.4.7:
 * - form.submit() flow (not full AJAX add to cart)
 * - updateTitle function
 * - Only main image updates (not gallery thumbnails)
 * - MutationObserver for weight persistence
 */
(function(window, document, $) {
    'use strict';
    
    const Bazonia = {
        
        config: null,
        priceCache: new Map(),
        currentController: null,
        debounceTimer: null,
        initialized: false,
        currentVariantData: null,
        lastValidWeight: null,
        currentImageUrl: null,
        weightObserver: null,
        
        // Divi 5 WooCommerce module selectors
        selectors: {
            priceModule: '.et_pb_wc_price',
            stockModule: '.et_pb_wc_stock',
            imageModule: '.et_pb_wc_images',
            addToCartModule: '.et_pb_wc_add_to_cart',
            ratingModule: '.et_pb_wc_rating',
            infoModule: '.et_pb_wc_additional_info',
            galleryModule: '.et_pb_wc_gallery',
            titleModule: '.et_pb_wc_title',
            
            priceInner: '.price',
            stockInner: '.stock',
            titleInner: '.product_title, h1, h2',
            mainImage: '.woocommerce-product-gallery__image img, .wp-post-image',
            addToCartBtn: '.single_add_to_cart_button',
            variationForm: 'form.variations_form',
            variationSelects: '.variations select'
        },
        
        el: {},
        baseTitle: '',
        
        /**
         * Initialize
         */
        init: function() {
            if (typeof window.bazonia_data === 'undefined') {
                console.warn('[Bazonia] Config not found');
                return;
            }
            
            this.config = window.bazonia_data;
            
            // Set initial weight from parent product
            if (this.config.parent_weight && this.config.parent_weight > 0) {
                this.lastValidWeight = this.config.parent_weight;
            }
            
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => this.setup());
            } else {
                this.setup();
            }
        },
        
        /**
         * Setup after DOM ready
         */
        setup: function() {
            this.cacheElements();
            
            if (!this.el.form) {
                console.log('[Bazonia] No variation form found');
                return;
            }
            
            this.hideDefaultPrice();
            this.bindEvents();
            
            // Show initial weight if available
            if (this.lastValidWeight) {
                this.updateWeight(this.lastValidWeight);
            }
            
            setTimeout(() => this.preselectFirstVariant(), 200);
            
            this.initialized = true;
            console.log('[Bazonia] v1.4.14 Ready (Divi 5 + WC Sync Mode)');
            console.log('[Bazonia] Modules found:', {
                price: !!this.el.priceModule,
                stock: !!this.el.stockModule,
                image: !!this.el.imageModule,
                info: !!this.el.infoModule,
                title: !!this.el.titleModule,
                rating: !!this.el.ratingModule
            });
        },
        
        /**
         * Cache DOM elements
         */
        cacheElements: function() {
            const s = this.selectors;
            
            this.el.priceModule = document.querySelector(s.priceModule);
            this.el.stockModule = document.querySelector(s.stockModule);
            this.el.imageModule = document.querySelector(s.imageModule) || document.querySelector(s.galleryModule);
            this.el.addToCartModule = document.querySelector(s.addToCartModule);
            this.el.infoModule = document.querySelector(s.infoModule);
            this.el.titleModule = document.querySelector(s.titleModule);
            this.el.ratingModule = document.querySelector(s.ratingModule);
            
            // Save base title
            if (this.el.titleModule) {
                const titleEl = this.el.titleModule.querySelector(s.titleInner);
                if (titleEl) {
                    this.baseTitle = titleEl.textContent.trim();
                }
            }
            
            this.el.form = document.querySelector(s.variationForm);
            this.el.addToCartBtn = document.querySelector(s.addToCartBtn);
            this.el.mainImage = document.querySelector(s.mainImage);
            
            if (this.el.form) {
                this.el.variationSelects = this.el.form.querySelectorAll(s.variationSelects);
            }
            
            this.loadCacheFromStorage();
        },
        
        /**
         * Load price cache from sessionStorage
         */
        loadCacheFromStorage: function() {
            try {
                const cached = sessionStorage.getItem('bazonia_price_cache_' + this.config.product_id);
                if (cached) {
                    const data = JSON.parse(cached);
                    for (const [key, value] of Object.entries(data)) {
                        this.priceCache.set(key, value);
                    }
                }
            } catch (e) {}
        },
        
        /**
         * Save cache to sessionStorage
         */
        saveCacheToStorage: function() {
            try {
                const data = {};
                this.priceCache.forEach((value, key) => data[key] = value);
                sessionStorage.setItem('bazonia_price_cache_' + this.config.product_id, JSON.stringify(data));
            } catch (e) {}
        },
        
        /**
         * Bind events
         */
        bindEvents: function() {
            const self = this;
            
            if ($) {
                $(this.el.form).on('woocommerce_variation_has_changed', function() {
                    self.handleChangeDebounced();
                });
                
                $(this.el.form).on('reset_data', function() {
                    self.currentVariantData = null;
                    self.showSelectMessage();
                });
                
                // Intercept Add to Cart submission - SAME AS v1.4.7
                $(this.el.form).on('submit', function(e) {
                    if (self.currentVariantData && self.currentVariantData.price > 0) {
                        e.preventDefault();
                        self.saveAndAddToCart();
                    }
                });
            }
            
            if (this.el.variationSelects) {
                this.el.variationSelects.forEach(select => {
                    select.addEventListener('change', () => self.handleChangeDebounced());
                });
            }
            
            // Button click intercept - SAME AS v1.4.7
            if (this.el.addToCartBtn) {
                this.el.addToCartBtn.addEventListener('click', function(e) {
                    if (self.currentVariantData && self.currentVariantData.price > 0) {
                        e.preventDefault();
                        e.stopPropagation();
                        self.saveAndAddToCart();
                    }
                }, true);
            }
        },
        
        /**
         * Save price to session then add to cart - RESTORED FROM v1.4.7
         */
        saveAndAddToCart: function() {
            const self = this;
            const data = this.currentVariantData;
            
            if (!data || !data.price) {
                this.el.form.submit();
                return;
            }
            
            const variationInput = this.el.form.querySelector('input[name="variation_id"]');
            const variationId = variationInput ? variationInput.value : 0;
            
            const currentSelection = this.getSelectedSpecs();
            if (currentSelection) {
                sessionStorage.setItem('bazonia_selection_' + this.config.product_id, JSON.stringify(currentSelection));
            }
            
            // Get image - priority: webhook data > currentImageUrl > DOM image
            let imageUrl = '';
            if (data.image && data.image.length > 10) {
                imageUrl = data.image;
            } else if (this.currentImageUrl && this.currentImageUrl.length > 10) {
                imageUrl = this.currentImageUrl;
            } else if (this.el.mainImage && this.el.mainImage.src) {
                imageUrl = this.el.mainImage.src;
            } else {
                const anyImg = document.querySelector('.woocommerce-product-gallery__image img, .wp-post-image');
                if (anyImg) imageUrl = anyImg.src;
            }
            
            console.log('[Bazonia] Saving to cart - price:', data.price, 'image:', imageUrl, 'specs:', currentSelection);
            
            // Disable button
            if (this.el.addToCartBtn) {
                this.el.addToCartBtn.disabled = true;
                this.el.addToCartBtn.textContent = 'Agregando...';
            }
            
            // Save via AJAX then submit form - SAME AS v1.4.7
            const formData = new FormData();
            formData.append('action', 'bazonia_save_price');
            formData.append('nonce', this.config.nonce);
            formData.append('product_id', this.config.product_id);
            formData.append('variation_id', variationId);
            formData.append('price', data.price);
            formData.append('image', imageUrl);
            formData.append('asin', data.asin || '');
            formData.append('specs', JSON.stringify(currentSelection || {}));
            
            fetch(this.config.ajax_url, {
                method: 'POST',
                body: formData
            })
            .then(r => r.json())
            .then(response => {
                console.log('[Bazonia] Price saved:', response);
                if ($) $(self.el.form).off('submit');
                self.el.form.submit();
            })
            .catch(err => {
                console.error('[Bazonia] Save error:', err);
                self.el.form.submit();
            });
        },
        
        /**
         * Debounced change handler
         */
        handleChangeDebounced: function() {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = setTimeout(() => this.handleChange(), 150);
        },
        
        /**
         * Handle variation change
         */
        handleChange: function() {
            const specs = this.getSelectedSpecs();
            console.log('[Bazonia] Selected specs:', specs);
            
            if (!this.hasCompleteSelection(specs)) {
                this.showSelectMessage();
                return;
            }
            
            const variant = this.findMatchingVariant(specs);
            
            if (variant) {
                console.log('[Bazonia] Matched variant:', variant.id);
                
                // Check cache first
                if (this.priceCache.has(variant.id)) {
                    const cached = this.priceCache.get(variant.id);
                    console.log('[Bazonia] Using cached data');
                    this.updateAllModules(cached, variant);
                    return;
                }
                
                this.fetchPrice(variant);
            } else {
                console.log('[Bazonia] No matching variant');
                this.showSelectMessage();
            }
        },
        
        /**
         * Get currently selected specs
         */
        getSelectedSpecs: function() {
            const specs = {};
            
            if (this.el.variationSelects) {
                this.el.variationSelects.forEach(select => {
                    const name = this.cleanAttrName(select);
                    const value = select.options[select.selectedIndex]?.text || select.value;
                    if (value && value !== '' && !value.toLowerCase().includes('choose') && !value.toLowerCase().includes('elegir')) {
                        specs[name] = value;
                    }
                });
            }
            
            return specs;
        },
        
        /**
         * Check if all options are selected
         */
        hasCompleteSelection: function(specs) {
            if (!this.el.variationSelects) return false;
            return Object.keys(specs).length >= this.el.variationSelects.length;
        },
        
        /**
         * Find matching variant from config
         */
        findMatchingVariant: function(specs) {
            const variants = this.config.variants || [];
            
            for (const variant of variants) {
                if (!variant.specs) continue;
                
                let match = true;
                for (const [key, value] of Object.entries(specs)) {
                    const variantValue = variant.specs[key];
                    if (!variantValue || !this.matchValue(variantValue, value)) {
                        match = false;
                        break;
                    }
                }
                
                if (match) return variant;
            }
            
            return null;
        },
        
        /**
         * Match values (case-insensitive)
         */
        matchValue: function(a, b) {
            if (!a || !b) return false;
            const cleanA = String(a).toLowerCase().trim();
            const cleanB = String(b).toLowerCase().trim();
            return cleanA === cleanB || cleanA.includes(cleanB) || cleanB.includes(cleanA);
        },
        
        /**
         * Fetch price from webhook
         */
        fetchPrice: function(variant) {
            console.log('[Bazonia] Fetching price for:', variant.id);
            
            if (this.currentController) this.currentController.abort();
            this.currentController = new AbortController();
            
            this.showLoading();
            
            const self = this;
            
            fetch(this.config.webhook_url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ asin: variant.id }),
                signal: this.currentController.signal
            })
            .then(r => r.ok ? r.json() : Promise.reject('HTTP ' + r.status))
            .then(data => {
                console.log('[Bazonia] Received:', data);
                self.priceCache.set(variant.id, data);
                self.saveCacheToStorage();
                self.updateAllModules(data, variant);
                
                // NEW v1.4.14: Sync to WooCommerce
                self.syncToWooCommerce(data, variant);
            })
            .catch(e => {
                if (e.name === 'AbortError') return;
                console.error('[Bazonia] Error:', e);
                self.showError(variant);
            })
            .finally(() => {
                self.currentController = null;
            });
        },
        
        /**
         * NEW v1.4.14: Sync ZINC data to WooCommerce
         * Saves image to Media Library, updates price, stock, weight
         */
        syncToWooCommerce: function(data, variant) {
            if (!data || !data.price) return;
            
            // Get variation_id from form
            const variationInput = this.el.form ? this.el.form.querySelector('input[name="variation_id"]') : null;
            const variationId = variationInput ? parseInt(variationInput.value) || 0 : 0;
            
            const weightKg = data.weight_kg || (data.weight_lb ? data.weight_lb * 0.453592 : 0);
            
            // Determine stock quantity (default 100 if in_stock is true)
            const inStock = data.available !== false && data.in_stock !== false;
            const stockQty = data.num_offers || 100;
            
            const formData = new FormData();
            formData.append('action', 'bazonia_sync_to_wc');
            formData.append('nonce', this.config.nonce);
            formData.append('product_id', this.config.product_id);
            formData.append('variation_id', variationId);
            formData.append('price', data.price);
            formData.append('original_price', data.original_price || 0);
            formData.append('image_url', data.image || '');
            formData.append('weight', weightKg);
            formData.append('stock_qty', stockQty);
            formData.append('in_stock', inStock ? '1' : '0');
            
            console.log('[Bazonia] Syncing to WooCommerce:', {
                product_id: this.config.product_id,
                variation_id: variationId,
                price: data.price,
                image: data.image ? 'yes' : 'no',
                weight: weightKg,
                stock_qty: stockQty
            });
            
            fetch(this.config.ajax_url, {
                method: 'POST',
                body: formData
            })
            .then(r => r.json())
            .then(response => {
                if (response.success) {
                    console.log('[Bazonia] ✓ WC sync complete:', response.data);
                } else {
                    console.warn('[Bazonia] WC sync failed:', response.data);
                }
            })
            .catch(err => {
                console.warn('[Bazonia] WC sync error:', err);
            });
        },
        
        /**
         * Show loading state
         */
        showLoading: function() {
            const spinner = '<span class="bazonia-spinner"></span>';
            
            if (this.el.priceModule) {
                const priceEl = this.el.priceModule.querySelector(this.selectors.priceInner);
                if (priceEl) {
                    priceEl.innerHTML = spinner + ' <span class="bazonia-loading-text">' + this.config.i18n.checking + '</span>';
                    priceEl.classList.add('bazonia-loading');
                }
            }
            
            if (this.el.stockModule) {
                let stockEl = this.el.stockModule.querySelector(this.selectors.stockInner) ||
                              this.el.stockModule.querySelector('p');
                
                if (!stockEl) {
                    stockEl = document.createElement('p');
                    stockEl.className = 'stock';
                    this.el.stockModule.appendChild(stockEl);
                }
                
                stockEl.innerHTML = spinner + ' <span class="bazonia-stock-text">' + this.config.i18n.loading + '</span>';
                stockEl.className = 'stock bazonia-loading';
            }
            
            if (this.el.imageModule) {
                this.el.imageModule.classList.add('bazonia-image-loading');
            }
            
            if (this.el.addToCartBtn) {
                this.el.addToCartBtn.classList.add('bazonia-disabled');
            }
        },
        
        /**
         * Hide default $0.00 price
         */
        hideDefaultPrice: function() {
            if (this.el.priceModule) {
                const priceEl = this.el.priceModule.querySelector(this.selectors.priceInner);
                if (priceEl) {
                    const text = priceEl.textContent || '';
                    if (text.includes('0,00') || text.includes('0.00') || text.trim() === '') {
                        priceEl.innerHTML = '<span class="bazonia-select">' + this.config.i18n.select_options + '</span>';
                    }
                }
            }
            
            const addToCartPrices = document.querySelectorAll('.et_pb_wc_add_to_cart .price, .et_pb_wc_add_to_cart .woocommerce-Price-amount');
            addToCartPrices.forEach(el => el.style.display = 'none');
            
            document.querySelectorAll('.price').forEach(priceEl => {
                const text = priceEl.textContent || '';
                if ((text.includes('0,00') || text.includes('0.00')) && !priceEl.closest('.et_pb_wc_price')) {
                    priceEl.style.visibility = 'hidden';
                }
            });
        },
        
        /**
         * Update all modules with data
         */
        updateAllModules: function(data, variant) {
            const weightKg = data.weight_kg || (data.weight_lb ? data.weight_lb * 0.453592 : null);
            
            // Save current variant data
            this.currentVariantData = {
                asin: data.asin,
                price: data.price,
                image: data.image,
                weight_kg: weightKg,
                // New fields
                original_price: data.original_price,
                discount_percent: data.discount_percent,
                in_stock: data.in_stock,
                available: data.available,
                stars_numeric: data.stars_numeric,
                review_count: data.review_count
            };
            
            // Update price with discount support
            this.updatePrice(data.price, data.original_price, data.discount_percent);
            
            // Stock: handle both old 'available' and new 'in_stock' format
            const isAvailable = data.available !== false && data.in_stock !== false;
            this.updateStock(isAvailable);
            
            this.updateImage(data.image);
            this.updateWeight(weightKg);
            
            // Update rating if data available
            if (data.stars_numeric) {
                this.updateRating(data.stars_numeric, data.review_count);
            }
            
            // Update title with variant specs - RESTORED FROM v1.4.7
            if (variant && variant.specs) {
                this.updateTitle(variant.specs);
            }
            
            // Re-enable add to cart
            if (this.el.addToCartBtn && isAvailable) {
                this.el.addToCartBtn.classList.remove('bazonia-disabled');
                this.el.addToCartBtn.disabled = false;
            }
            
            console.log('[Bazonia] All modules updated');
        },
        
        /**
         * Update title with variant specs - IMPROVED v1.4.14
         * Replaces values in title, never appends
         */
        updateTitle: function(specs) {
            if (!this.el.titleModule || !this.baseTitle) return;
            
            const titleEl = this.el.titleModule.querySelector(this.selectors.titleInner);
            if (!titleEl) return;
            
            let newTitle = this.baseTitle;
            
            // 1. Replace capacity/storage pattern
            if (specs.Capacity) {
                // Pattern: "16GB Unified Memory, 256GB SSD Storage" or similar
                const memoryPattern = /\d+GB\s+Unified\s+Memory,\s+\d+GB\s+SSD\s+Storage/gi;
                if (memoryPattern.test(newTitle)) {
                    newTitle = newTitle.replace(memoryPattern, specs.Capacity);
                }
            }
            
            // 2. Replace color
            if (specs.Color) {
                const colors = ['Midnight', 'Silver', 'Sky Blue', 'Starlight', 'Space Gray', 'Gold', 'Pink', 'Blue', 'Green', 'Red', 'Purple', 'Yellow', 'Orange', 'White', 'Black'];
                for (const color of colors) {
                    const colorRegex = new RegExp('\\b' + color + '\\b', 'gi');
                    if (colorRegex.test(newTitle) && color.toLowerCase() !== specs.Color.toLowerCase()) {
                        newTitle = newTitle.replace(colorRegex, specs.Color);
                        break;
                    }
                }
            }
            
            // 3. Replace AppleCare info if exists
            if (specs.Set) {
                // Pattern: "with AppleCare+ (3 Years)" or "Without AppleCare+"
                const appleCarePattern = /(with|without)\s*AppleCare\+?\s*(\([^)]+\))?/gi;
                if (appleCarePattern.test(newTitle)) {
                    // Determine replacement text
                    let appleCareText = '';
                    if (specs.Set.toLowerCase().includes('without')) {
                        appleCareText = 'Without AppleCare+';
                    } else if (specs.Set.toLowerCase().includes('with')) {
                        appleCareText = 'with AppleCare+ (3 Years)';
                    }
                    if (appleCareText) {
                        newTitle = newTitle.replace(appleCarePattern, appleCareText);
                    }
                }
            }
            
            // 4. Remove any duplicate specs that might have been appended previously
            // Pattern: "; specs; specs" at the end
            newTitle = newTitle.replace(/;\s*\d+GB[^;]*;\s*\d+GB[^$]*$/i, '');
            
            titleEl.textContent = newTitle;
        },
        
        /**
         * Update price with discount display - NEW IN v1.4.9
         */
        updatePrice: function(price, originalPrice, discountPercent) {
            if (!this.el.priceModule) return;
            
            const priceEl = this.el.priceModule.querySelector(this.selectors.priceInner);
            if (!priceEl) return;
            
            priceEl.classList.remove('bazonia-loading');
            
            if (!price || Number(price) <= 0) {
                priceEl.innerHTML = '<span class="bazonia-error">' + this.config.i18n.unavailable + '</span>';
                return;
            }
            
            let html = '<div class="bazonia-price-wrapper">';
            
            // Show discount if available
            if (originalPrice && originalPrice > price && discountPercent > 0) {
                html += '<div class="bazonia-discount-line">';
                html += '<span class="bazonia-original-price">' + this.formatPrice(originalPrice) + '</span>';
                html += '<span class="bazonia-discount-badge">' + discountPercent + '% ' + this.config.i18n.off + '</span>';
                html += '</div>';
            }
            
            html += '<span class="bazonia-current-price woocommerce-Price-amount amount">' + this.formatPrice(price) + '</span>';
            html += '</div>';
            
            priceEl.innerHTML = html;
            
            // Flash animation
            priceEl.classList.add('bazonia-flash');
            setTimeout(() => priceEl.classList.remove('bazonia-flash'), 300);
        },
        
        /**
         * Update stock display
         */
        updateStock: function(available) {
            if (!this.el.stockModule) return;
            
            let stockEl = this.el.stockModule.querySelector(this.selectors.stockInner) ||
                          this.el.stockModule.querySelector('p');
            
            if (!stockEl) {
                stockEl = document.createElement('p');
                stockEl.className = 'stock';
                this.el.stockModule.appendChild(stockEl);
            }
            
            stockEl.classList.remove('bazonia-loading');
            
            if (available === false) {
                stockEl.className = 'stock out-of-stock';
                stockEl.innerHTML = '<span class="bazonia-stock-dot out"></span> ' + this.config.i18n.out_of_stock;
                
                if (this.el.addToCartBtn) {
                    this.el.addToCartBtn.classList.add('bazonia-disabled');
                }
            } else {
                stockEl.className = 'stock in-stock';
                stockEl.innerHTML = '<span class="bazonia-stock-dot in"></span> ' + this.config.i18n.in_stock;
            }
        },
        
        /**
         * Update rating display - NEW IN v1.4.9
         */
        updateRating: function(starsNumeric, reviewCount) {
            if (!this.el.ratingModule) return;
            
            if (!starsNumeric || starsNumeric <= 0) {
                this.el.ratingModule.style.display = 'none';
                return;
            }
            
            this.el.ratingModule.style.display = '';
            
            const fullStars = Math.floor(starsNumeric);
            const hasHalf = (starsNumeric - fullStars) >= 0.5;
            const emptyStars = 5 - fullStars - (hasHalf ? 1 : 0);
            
            let starsHtml = '<span class="bazonia-stars">';
            for (let i = 0; i < fullStars; i++) starsHtml += '★';
            if (hasHalf) starsHtml += '★';
            starsHtml += '</span>';
            
            if (emptyStars > 0) {
                starsHtml += '<span class="bazonia-stars-empty">';
                for (let i = 0; i < emptyStars; i++) starsHtml += '☆';
                starsHtml += '</span>';
            }
            
            const html = '<div class="bazonia-rating">' +
                '<span class="bazonia-rating-number">' + starsNumeric.toFixed(1) + '</span>' +
                starsHtml +
                '<span class="bazonia-review-count">(' + (reviewCount || 0) + ' ' + this.config.i18n.reviews + ')</span>' +
                '</div>';
            
            const ratingInner = this.el.ratingModule.querySelector('.star-rating') || 
                               this.el.ratingModule.querySelector('.woocommerce-product-rating') ||
                               this.el.ratingModule;
            
            ratingInner.innerHTML = html;
        },
        
        /**
         * Update image - ONLY MAIN IMAGE, not thumbnails (restored from v1.4.7)
         */
        updateImage: function(url) {
            if (this.el.imageModule) {
                this.el.imageModule.classList.remove('bazonia-image-loading');
            }
            
            console.log('[Bazonia] updateImage called with:', url);
            
            if (!url && this.el.mainImage) {
                url = this.el.mainImage.src;
            }
            
            if (url && url.length > 10) {
                this.currentImageUrl = url;
            }
            
            if (!url) return;
            
            // Update ONLY main image, NOT gallery thumbnails
            if (this.el.mainImage) {
                this.el.mainImage.src = url;
                this.el.mainImage.srcset = '';
            }
            
            // Also update first gallery image only
            const firstGalleryImg = document.querySelector('.woocommerce-product-gallery__image:first-child img');
            if (firstGalleryImg && firstGalleryImg !== this.el.mainImage) {
                firstGalleryImg.src = url;
                firstGalleryImg.srcset = '';
            }
        },
        
        /**
         * Update weight with MutationObserver - RESTORED FROM v1.4.7
         */
        updateWeight: function(weightKg) {
            console.log('[Bazonia] updateWeight called with:', weightKg);
            
            if (weightKg && Number(weightKg) > 0) {
                this.lastValidWeight = weightKg;
            } else if (this.lastValidWeight) {
                weightKg = this.lastValidWeight;
            }
            
            if (!this.el.infoModule) return;
            
            const self = this;
            const finalWeight = weightKg;
            
            if (this.weightObserver) {
                this.weightObserver.disconnect();
            }
            
            const applyWeight = function() {
                const rows = self.el.infoModule.querySelectorAll('.woocommerce-product-attributes-item');
                
                rows.forEach(row => {
                    const label = row.querySelector('.woocommerce-product-attributes-item__label');
                    const value = row.querySelector('.woocommerce-product-attributes-item__value');
                    
                    if (label && value) {
                        const labelText = label.textContent.toLowerCase();
                        if (labelText.includes('weight') || labelText.includes('peso')) {
                            if (finalWeight && Number(finalWeight) > 0) {
                                const kg = Number(finalWeight).toFixed(2);
                                value.innerHTML = '<span class="bazonia-weight">' + kg + ' kg</span>';
                                value.setAttribute('data-bazonia-weight', kg);
                            } else {
                                value.textContent = '-';
                            }
                        }
                    }
                });
            };
            
            applyWeight();
            setTimeout(applyWeight, 50);
            setTimeout(applyWeight, 150);
            setTimeout(applyWeight, 300);
            setTimeout(applyWeight, 500);
            setTimeout(applyWeight, 1000);
            
            if (weightKg && Number(weightKg) > 0) {
                this.weightObserver = new MutationObserver(function(mutations) {
                    mutations.forEach(function(mutation) {
                        if (mutation.type === 'childList' || mutation.type === 'characterData') {
                            const target = mutation.target;
                            if (target.classList && target.classList.contains('woocommerce-product-attributes-item__value')) {
                                const savedWeight = target.getAttribute('data-bazonia-weight');
                                if (savedWeight && !target.innerHTML.includes('bazonia-weight')) {
                                    target.innerHTML = '<span class="bazonia-weight">' + savedWeight + ' kg</span>';
                                }
                            }
                        }
                    });
                });
                
                this.weightObserver.observe(this.el.infoModule, {
                    childList: true,
                    subtree: true,
                    characterData: true
                });
            }
        },
        
        /**
         * Show select message
         */
        showSelectMessage: function() {
            if (this.el.priceModule) {
                const priceEl = this.el.priceModule.querySelector(this.selectors.priceInner);
                if (priceEl) {
                    priceEl.innerHTML = '<span class="bazonia-select">' + this.config.i18n.select_options + '</span>';
                    priceEl.classList.remove('bazonia-loading');
                }
            }
            
            if (this.el.stockModule) {
                let stockEl = this.el.stockModule.querySelector(this.selectors.stockInner) ||
                              this.el.stockModule.querySelector('p');
                if (stockEl) {
                    stockEl.innerHTML = '-';
                    stockEl.className = 'stock';
                }
            }
        },
        
        /**
         * Show error state
         */
        showError: function(variant) {
            if (this.el.priceModule) {
                const priceEl = this.el.priceModule.querySelector(this.selectors.priceInner);
                if (priceEl) {
                    priceEl.innerHTML = '<span class="bazonia-error">' + this.config.i18n.checking + '</span>';
                    priceEl.classList.remove('bazonia-loading');
                }
            }
            
            if (this.el.imageModule) {
                this.el.imageModule.classList.remove('bazonia-image-loading');
            }
        },
        
        /**
         * Pre-select first variant - RESTORED FROM v1.4.7
         */
        preselectFirstVariant: function() {
            const savedSelection = sessionStorage.getItem('bazonia_selection_' + this.config.product_id);
            if (savedSelection) {
                try {
                    const saved = JSON.parse(savedSelection);
                    console.log('[Bazonia] Restoring selection:', saved);
                    
                    if (this.el.variationSelects) {
                        this.el.variationSelects.forEach(select => {
                            const attrName = this.cleanAttrName(select);
                            if (saved[attrName]) {
                                // Find the option that matches
                                for (const opt of select.options) {
                                    if (this.matchValue(opt.text, saved[attrName]) || opt.value === saved[attrName]) {
                                        select.value = opt.value;
                                        break;
                                    }
                                }
                            }
                        });
                    }
                    
                    sessionStorage.removeItem('bazonia_selection_' + this.config.product_id);
                    
                    if ($) $(this.el.form).find('select').first().trigger('change');
                    this.handleChange();
                    return;
                } catch (e) {
                    console.warn('[Bazonia] Could not restore selection');
                }
            }
            
            const def = this.config.default_variant;
            if (!def || !def.specs) return;
            
            console.log('[Bazonia] Pre-selecting:', def.specs);
            
            if (this.el.variationSelects) {
                this.el.variationSelects.forEach(select => {
                    const attrName = this.cleanAttrName(select);
                    const targetValue = def.specs[attrName];
                    
                    if (targetValue) {
                        for (const opt of select.options) {
                            if (this.matchValue(opt.text, targetValue) || this.matchValue(opt.value, targetValue)) {
                                select.value = opt.value;
                                break;
                            }
                        }
                    }
                });
            }
            
            if ($) $(this.el.form).find('select').first().trigger('change');
            this.handleChange();
        },
        
        /**
         * Clean attribute name
         */
        cleanAttrName: function(select) {
            const name = select.getAttribute('data-attribute_name') || select.getAttribute('name') || '';
            return name
                .replace('attribute_pa_', '')
                .replace('attribute_', '')
                .replace(/-/g, ' ')
                .split(' ')
                .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
                .join(' ');
        },
        
        /**
         * Format price
         */
        formatPrice: function(price) {
            const num = parseFloat(price);
            if (isNaN(num)) return price;
            
            const c = this.config;
            const decimals = c.decimals || 2;
            const decSep = c.decimal_sep || '.';
            const thousandSep = c.thousand_sep || ',';
            const symbol = c.currency_symbol || '$';
            const pos = c.currency_pos || 'left';
            
            const fixed = num.toFixed(decimals);
            const parts = fixed.split('.');
            parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, thousandSep);
            const formatted = parts.join(decSep);
            
            switch (pos) {
                case 'left': return symbol + formatted;
                case 'right': return formatted + symbol;
                case 'left_space': return symbol + '\u00A0' + formatted;
                case 'right_space': return formatted + '\u00A0' + symbol;
                default: return symbol + formatted;
            }
        }
    };
    
    // Initialize
    Bazonia.init();
    
    // Expose for debugging
    window.BazoniaFrontend = Bazonia;
    
})(window, document, window.jQuery);
