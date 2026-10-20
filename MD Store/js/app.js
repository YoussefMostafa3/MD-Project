const API_URL = window.MDSTORE_API_URL;
const OWNER_PHONE = "201210829120"; // رقم صاحب المحل على الواتساب
let currentLang = localStorage.getItem('preferredLang') || 'ar';

let allStoreProductsCache = [];
let allGameProductsCache = [];
let currentProduct = null; // للمنتج المعروض حالياً في صفحة التفاصيل
    window.selectedProductVariantId = null;
let chatPollInterval = null;
let lastRenderedChatData = "";
let cartItems = [];
let isCheckoutSubmitting = false;
let deliveryOptions = [];
let paymentOptions = [];
let activeCartStorageKey = null;
let homepageBanners = [];
let heroSlideIndex = 0;
let heroAutoAdvanceTimer = null;
let heroPointerStartX = null;
// إخفاء الـ Loader بعد اكتمال تحميل الصفحة
window.addEventListener('load', () => {
    hideGlobalLoader();
});

function hideGlobalLoader() {
    const loader = document.getElementById('page-loader');
    if (loader) {
        loader.classList.add('opacity-0', 'pointer-events-none');
        setTimeout(() => {
            loader.classList.add('hidden');
        }, 500);
    }
}

function showGlobalLoader() {
    const loader = document.getElementById('page-loader');
    if (loader) {
        loader.classList.remove('hidden', 'pointer-events-none');
        // تأخير بسيط لإعطاء التأثير البصري
        setTimeout(() => {
            loader.classList.remove('opacity-0');
        }, 10);
    }
}

// تشغيل الـ Loader عند الضغط على اللوجو أو إعادة تنشيط الصفحة
function handleLogoClick() {
    showGlobalLoader();
    setTimeout(() => {
        switchTab('landing');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        hideGlobalLoader();
    }, 400);
}
function readCurrentUser() {
    try { return JSON.parse(localStorage.getItem('currentUser') || 'null'); }
    catch (_) { return null; }
}

function customerHeaders(json = true) {
    const headers = {};
    if (json) headers['Content-Type'] = 'application/json';
    const token = localStorage.getItem('customerToken');
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

function saveCustomerSession(data) {
    if (!data?.token || !data.id) return false;
    const customer = { id: data.id, name: data.name, email: data.email, phone: data.phone, address: data.address };
    localStorage.setItem('customerToken', data.token);
    localStorage.setItem('currentUser', JSON.stringify(customer));
    return true;
}

function clearCustomerSession() {
    localStorage.removeItem('customerToken');
    localStorage.removeItem('currentUser');
    localStorage.removeItem('token');
}

if (!localStorage.getItem('customerToken')) localStorage.removeItem('currentUser');

async function validateCustomerSession() {
    const token = localStorage.getItem('customerToken');
    if (!token) return;
    try {
        const response = await fetch(`${API_URL}/users/me`, { headers: customerHeaders(false) });
        if (!response.ok) throw new Error('Session expired');
        const customer = await response.json();
        localStorage.setItem('currentUser', JSON.stringify(customer));
        activateCartForUser(customer);
        checkCurrentUser();
    } catch (_) {
        clearCustomerSession();
        activateCartForUser(null, { clearVisible: true });
        checkCurrentUser();
    }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', validateCustomerSession);
else validateCustomerSession();

function cartStorageKeyForUser(user) {
    return user?.id !== undefined && user?.id !== null && String(user.id).trim() !== ''
        ? `mdstore_cart_user_${encodeURIComponent(String(user.id))}`
        : 'mdstore_cart_guest';
}

function activateCartForUser(user, { reset = false, clearVisible = false } = {}) {
    const storageKey = cartStorageKeyForUser(user);
    activeCartStorageKey = storageKey;
    if (reset) {
        cartItems = [];
        localStorage.setItem(storageKey, '[]');
    } else if (clearVisible) {
        // Logout should immediately hide the former account's cart. Keep the
        // separate guest cart saved on disk so no other cart is deleted.
        cartItems = [];
    } else {
        try {
            const stored = JSON.parse(localStorage.getItem(storageKey) || '[]');
            cartItems = Array.isArray(stored) ? stored : [];
        } catch (_) { cartItems = []; }
    }
    updateCartBadge();
    renderCart();
}

activeCartStorageKey = cartStorageKeyForUser(readCurrentUser());
try {
    const initialCart = JSON.parse(localStorage.getItem(activeCartStorageKey) || '[]');
    cartItems = Array.isArray(initialCart) ? initialCart : [];
} catch (_) { cartItems = []; }

function saveCart() {
    const currentKey = cartStorageKeyForUser(readCurrentUser());
    if (activeCartStorageKey !== currentKey) {
        activateCartForUser(readCurrentUser());
        return false;
    }
    localStorage.setItem(activeCartStorageKey, JSON.stringify(cartItems));
    updateCartBadge();
    return true;
}

function remainingCartAfterOrder(storedItems, submittedItems) {
    const submittedQuantity = new Map();
    submittedItems.forEach(item => {
        const key = `${item.product_id}::${item.variant_id || ''}`;
        submittedQuantity.set(key, (submittedQuantity.get(key) || 0) + Number(item.quantity || 0));
    });
    return storedItems.reduce((remaining, item) => {
        const key = `${item.product_id}::${item.variant_id || ''}`;
        const quantityToSubtract = submittedQuantity.get(key) || 0;
        const quantity = Math.max(0, Number(item.quantity || 0) - quantityToSubtract);
        if (quantityToSubtract) submittedQuantity.set(key, Math.max(0, quantityToSubtract - Number(item.quantity || 0)));
        if (quantity > 0) remaining.push({ ...item, quantity });
        return remaining;
    }, []);
}

function findProductById(productId) {
    const allProducts = [...allStoreProductsCache, ...allGameProductsCache, ...(window.products || []), ...(window.gameProducts || [])];
    return allProducts.find(product => String(product.id) === String(productId) && product.is_active !== false);
}

function resolveProductImageUrl(value) {
    if (!value) return 'logo.jpeg';
    try {
        const api = new URL(API_URL);
        const parsed = new URL(String(value).trim(), `${api.origin}/`);
        if ((parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') && parsed.pathname.startsWith('/uploads/')) {
            parsed.protocol = api.protocol;
            parsed.host = api.host;
        }
        return parsed.href;
    } catch (_) { return 'logo.jpeg'; }
}

function handleProductImageError(image) {
    if (image.dataset.fallbackApplied) { image.classList.add('hidden'); return; }
    image.dataset.fallbackApplied = 'true';
    image.src = 'logo.jpeg';
}

function isOfferBadge(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'save' || normalized === 'offer';
}

function getLocalizedBannerText(banner, field) {
    const preferred = banner?.[`${field}_${currentLang}`];
    const fallback = banner?.[`${field}_${currentLang === 'ar' ? 'en' : 'ar'}`];
    return String(preferred || fallback || '').trim();
}

function heroBannerAction(banner) {
    const label = getLocalizedBannerText(banner, 'button_text');
    let destination = String(banner?.button_link || '').trim();
    const legacyDestinations = { store: 'store-section', '#store-section': 'store-section', '/store': 'store-section' };
    destination = legacyDestinations[destination.toLowerCase()] || destination;
    const availableDestinations = ['store-section', 'offers-section', 'modified-games-section'];
    if (!label || !availableDestinations.includes(destination)) return '';
    return `<button type="button" onclick="navigateToLandingSection('${destination}')" class="relative z-10 inline-flex items-center gap-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-black px-7 py-3 rounded-xl shadow-xl transition">${escapeOrderText(label)}<i class="fa-solid fa-arrow-left"></i></button>`;
}

function scrollToVisibleSection(sectionId) {
    const target = document.getElementById(sectionId);
    if (!target || target.classList.contains('hidden') || target.closest('.hidden')) {
        showToast(currentLang === 'ar' ? 'القسم المختار غير متاح حاليًا.' : 'The selected section is not available right now.', 'info');
        return false;
    }
    target.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    return true;
}

function navigateToLandingSection(sectionId) {
    const target = document.getElementById(sectionId);
    if (!target) {
        showToast(currentLang === 'ar' ? 'القسم المختار غير موجود.' : 'The selected section could not be found.', 'info');
        return;
    }
    const tab = target.closest('[id^="tab-content-"]');
    const tabName = tab?.id.replace('tab-content-', '');
    if (tabName && tab.classList.contains('hidden')) {
        switchTab(tabName);
        window.setTimeout(() => scrollToVisibleSection(sectionId), 280);
        return;
    }
    scrollToVisibleSection(sectionId);
}

function renderHeroBanners(banners = homepageBanners) {
    const container = document.getElementById('hero-dynamic-slides');
    if (!container) return;
    const validBanners = (Array.isArray(banners) ? banners : []).filter(banner => banner?.is_active && banner.image_url).slice(0, 3);
    homepageBanners = validBanners;
    container.innerHTML = validBanners.map((banner, index) => {
        const title = getLocalizedBannerText(banner, 'title');
        const subtitle = getLocalizedBannerText(banner, 'subtitle');
        const image = resolveProductImageUrl(banner.image_url);
        return `<section class="hero-slide rounded-3xl overflow-hidden border border-slate-800 bg-slate-900 shadow-2xl min-h-[580px] flex items-center" aria-label="${escapeOrderText(title)}" aria-hidden="true">
            <img src="${escapeOrderText(image)}" alt="" class="absolute inset-0 w-full h-full object-cover" onerror="handleProductImageError(this)">
            <div class="absolute inset-0 bg-gradient-to-l from-slate-950/95 via-slate-950/75 to-blue-950/35"></div>
                <div class="relative z-10 w-full px-10 sm:px-20 py-16 ${currentLang === 'ar' ? 'text-right' : 'text-left'}" dir="${currentLang === 'ar' ? 'rtl' : 'ltr'}">
                <p class="text-xs uppercase tracking-[0.25em] font-extrabold text-cyan-300 mb-4">MD STORE</p>
                <h2 class="text-3xl sm:text-5xl md:text-6xl font-black leading-tight text-white drop-shadow-xl max-w-3xl">${escapeOrderText(title)}</h2>
                ${subtitle ? `<p class="mt-5 text-sm sm:text-lg text-slate-200 max-w-2xl">${escapeOrderText(subtitle)}</p>` : ''}
                ${heroBannerAction(banner) ? `<div class="mt-8">${heroBannerAction(banner)}</div>` : ''}
            </div>
        </section>`;
    }).join('');
    updateHeroSlider();
}

function getHeroSlides() {
    return [...document.querySelectorAll('#hero-slide-primary, #hero-dynamic-slides .hero-slide')];
}

function updateHeroSlider() {
    const slides = getHeroSlides();
    const indicators = document.getElementById('hero-indicators');
    const controls = document.querySelectorAll('#hero-prev, #hero-next');
    if (!slides.length) return;
    heroSlideIndex = ((heroSlideIndex % slides.length) + slides.length) % slides.length;
    slides.forEach((slide, index) => {
        const active = index === heroSlideIndex;
        slide.classList.toggle('hero-slide-active', active);
        slide.setAttribute('aria-hidden', active ? 'false' : 'true');
    });
    if (indicators) {
        indicators.innerHTML = slides.length > 1 ? slides.map((_, index) => `<button type="button" class="hero-indicator" aria-label="${currentLang === 'ar' ? `الشريحة ${index + 1}` : `Slide ${index + 1}`}" aria-current="${index === heroSlideIndex}" onclick="goToHeroSlide(${index})"></button>`).join('') : '';
        indicators.classList.toggle('hidden', slides.length <= 1);
    }
    controls.forEach(button => button.classList.toggle('hidden', slides.length <= 1));
    syncLandingSliderControls();
}

function goToHeroSlide(index) {
    const slides = getHeroSlides();
    if (slides.length <= 1) return;
    heroSlideIndex = Math.max(0, Math.min(Number(index) || 0, slides.length - 1));
    updateHeroSlider();
    restartHeroAutoAdvance();
}

function moveHeroSlide(direction) {
    const slides = getHeroSlides();
    if (slides.length <= 1) return;
    heroSlideIndex = (heroSlideIndex + direction + slides.length) % slides.length;
    updateHeroSlider();
    restartHeroAutoAdvance();
}

function startHeroAutoAdvance() {
    clearInterval(heroAutoAdvanceTimer);
    if (getHeroSlides().length <= 1 || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    heroAutoAdvanceTimer = setInterval(() => moveHeroSlide(1), 5500);
}

function restartHeroAutoAdvance() {
    startHeroAutoAdvance();
}

async function loadHomepageBanners() {
    try {
        const response = await fetch(`${API_URL}/homepage/banners`);
        if (!response.ok) throw new Error(`Banner request failed (${response.status})`);
        const banners = await response.json();
        heroSlideIndex = 0;
        renderHeroBanners(Array.isArray(banners) ? banners : []);
        startHeroAutoAdvance();
    } catch (error) {
        console.warn('Homepage banners could not be loaded; showing the original hero.', error);
        renderHeroBanners([]);
    }
}

function scrollLandingCarousel(containerId, direction) {
    const carousel = document.getElementById(containerId);
    if (!carousel || carousel.scrollWidth <= carousel.clientWidth + 1) return;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const isNext = direction === 'next' || direction === 1;
    const first = carousel.firstElementChild?.getBoundingClientRect();
    const second = carousel.children[1]?.getBoundingClientRect();
    const nextPhysicalDirection = first && second && second.left !== first.left
        ? Math.sign(second.left - first.left)
        : (getComputedStyle(carousel).direction === 'rtl' ? -1 : 1);
    const physicalDirection = isNext ? nextPhysicalDirection : -nextPhysicalDirection;
    carousel.scrollBy({ left: physicalDirection * Math.max(260, carousel.clientWidth * 0.8), behavior: reducedMotion ? 'auto' : 'smooth' });
}

function syncLandingSliderControls() {
    const rtl = document.documentElement.dir === 'rtl';
    const previous = document.getElementById('hero-prev');
    const next = document.getElementById('hero-next');
    const positionHeroControl = (button, side) => {
        if (!button) return;
        button.classList.remove('left-3', 'right-3', 'sm:left-5', 'sm:right-5');
        button.classList.add(side === 'left' ? 'left-3' : 'right-3', side === 'left' ? 'sm:left-5' : 'sm:right-5');
    };
    positionHeroControl(previous, rtl ? 'right' : 'left');
    positionHeroControl(next, rtl ? 'left' : 'right');
    if (previous?.firstElementChild) previous.firstElementChild.className = `fa-solid fa-chevron-${rtl ? 'right' : 'left'}`;
    if (next?.firstElementChild) next.firstElementChild.className = `fa-solid fa-chevron-${rtl ? 'left' : 'right'}`;

    document.querySelectorAll('[data-carousel-controls]').forEach(controls => {
        const carousel = document.getElementById(controls.dataset.carouselControls);
        const previousButton = controls.querySelector('[data-carousel-control="previous"]');
        const nextButton = controls.querySelector('[data-carousel-control="next"]');
        if (!carousel) return;
        const first = carousel.firstElementChild?.getBoundingClientRect();
        const second = carousel.children[1]?.getBoundingClientRect();
        const nextPhysicalDirection = first && second && second.left !== first.left
            ? Math.sign(second.left - first.left)
            : (getComputedStyle(carousel).direction === 'rtl' ? -1 : 1);
        const nextIcon = nextPhysicalDirection < 0 ? 'left' : 'right';
        if (previousButton?.firstElementChild) previousButton.firstElementChild.className = `fa-solid fa-chevron-${nextIcon === 'left' ? 'right' : 'left'}`;
        if (nextButton?.firstElementChild) nextButton.firstElementChild.className = `fa-solid fa-chevron-${nextIcon}`;
        const last = carousel.lastElementChild?.getBoundingClientRect();
        const bounds = carousel.getBoundingClientRect();
        const hasOverflow = carousel.scrollWidth > carousel.clientWidth + 1;
        if (previousButton) previousButton.disabled = !hasOverflow || !first || (nextPhysicalDirection < 0 ? first.right <= bounds.right + 1 : first.left >= bounds.left - 1);
        if (nextButton) nextButton.disabled = !hasOverflow || !last || (nextPhysicalDirection < 0 ? last.left >= bounds.left - 1 : last.right <= bounds.right + 1);
    });
}

function initLandingSliderControls() {
    document.querySelectorAll('#offers-products-grid, #modified-games-grid').forEach(carousel => {
        carousel.addEventListener('scroll', syncLandingSliderControls, { passive: true });
    });
    window.addEventListener('resize', syncLandingSliderControls);
    syncLandingSliderControls();
}

function initHeroSliderControls() {
    const slider = document.getElementById('hero-slider');
    if (!slider) return;
    slider.addEventListener('pointerdown', event => {
        if (event.target.closest('button, a')) return;
        heroPointerStartX = event.clientX;
    });
    slider.addEventListener('pointerup', event => {
        if (heroPointerStartX === null) return;
        const distance = event.clientX - heroPointerStartX;
        heroPointerStartX = null;
        if (Math.abs(distance) > 45) moveHeroSlide(distance < 0 ? 1 : -1);
    });
    slider.addEventListener('pointercancel', () => { heroPointerStartX = null; });
    slider.addEventListener('mouseenter', () => clearInterval(heroAutoAdvanceTimer));
    slider.addEventListener('mouseleave', startHeroAutoAdvance);
    slider.addEventListener('focusin', () => clearInterval(heroAutoAdvanceTimer));
    slider.addEventListener('focusout', event => {
        if (!slider.contains(event.relatedTarget)) startHeroAutoAdvance();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) clearInterval(heroAutoAdvanceTimer);
        else startHeroAutoAdvance();
    });
}

function getProductVariant(product, variantId) {
    return (product?.variants || []).find(variant => String(variant.id) === String(variantId));
}

function getCartUnitPrice(product, item) {
    const variant = item.variant_id ? getProductVariant(product, item.variant_id) : null;
    const value = variant ? Number(variant.price) : Number(product?.price);
    return Number.isFinite(value) ? Math.round((value + Number.EPSILON) * 100) / 100 : NaN;
}

function productOptionLabel(variant) {
    return [variant?.platform, variant?.edition].filter(Boolean).join(' / ');
}

function escapeOrderText(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function updateCartBadge() {
    const count = cartItems.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    ['cart-count', 'mobile-cart-count'].forEach(id => {
        const badge = document.getElementById(id);
        if (!badge) return;
        badge.textContent = count > 99 ? '99+' : String(count);
        if (id === 'cart-count') badge.classList.toggle('hidden', count === 0);
    });
}

function addCurrentProductToCart() {
    if (!currentProduct) return;
    if (currentProduct.show_in_modified_games) {
        showToast(translations[currentLang].modified_game_checkout_blocked, 'error');
        return;
    }
    const quantity = Math.max(1, parseInt(document.getElementById('product-page-qty')?.value || '1', 10));
    const stock = Number(currentProduct.stock) || 0;
    if (stock < 1) {
        showToast(translations[currentLang].cart_out_of_stock, 'error');
        return;
    }
    const activeVariants = (currentProduct.variants || []).filter(option => option.is_active);
    const needsVariant = Boolean(currentProduct.requires_variants || currentProduct.variants?.length);
    const selectedVariant = window.selectedProductVariantId ? getProductVariant(currentProduct, window.selectedProductVariantId) : null;
    if (needsVariant && (!selectedVariant || !selectedVariant.is_active || selectedVariant.price == null || !Number.isFinite(Number(selectedVariant.price)))) {
        showToast(currentLang === 'ar' ? 'اختر خياراً له سعر متاح قبل الإضافة.' : 'Select an available, priced option before adding this product.', 'error');
        return;
    }
    if (needsVariant && !activeVariants.some(option => String(option.id) === String(selectedVariant.id))) return;
    const variant = selectedVariant ? productOptionLabel(selectedVariant) : '';
    const key = `${currentProduct.id}::${selectedVariant?.id || ''}`;
    const existing = cartItems.find(item => `${item.product_id}::${item.variant_id || ''}` === key);
    const nextQuantity = (existing?.quantity || 0) + quantity;
    const totalForProduct = cartItems.filter(item => String(item.product_id) === String(currentProduct.id)).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    if (totalForProduct + quantity > stock) {
        showToast(translations[currentLang].cart_stock_limit.replace('{stock}', stock), 'error');
        return;
    }
    if (existing) existing.quantity = nextQuantity;
    else cartItems.push({ product_id: currentProduct.id, quantity, variant_id: selectedVariant?.id || null, platform: selectedVariant?.platform || null, edition: selectedVariant?.edition || null, variant, expected_price: getCartUnitPrice(currentProduct, { variant_id: selectedVariant?.id || null }) });
    saveCart();
    showToast(translations[currentLang].cart_added, 'success');
}

function handleAddToCart() { addCurrentProductToCart(); }

function contactModifiedGame() {
    if (!currentProduct?.show_in_modified_games) return;
    const selected = window.selectedProductVariantId ? getProductVariant(currentProduct, window.selectedProductVariantId) : null;
    const optionText = selected ? ` (${productOptionLabel(selected)})` : '';
    const message = currentLang === 'ar'
        ? `مرحباً، أريد التنسيق لتركيب اللعبة المعدّلة: ${currentProduct.name}${optionText}. سأحضر جهازي إلى الفرع للتثبيت. يرجى إخباري بالتفاصيل.`
        : `Hello, I would like to arrange installation for the modified-console game: ${currentProduct.name}${optionText}. I will bring my device to the branch for installation. Please share the details.`;
    window.open(`https://wa.me/${OWNER_PHONE}?text=${encodeURIComponent(message)}`, '_blank');
}

function openCart() {
    const modal = document.getElementById('cart-modal');
    if (modal) modal.classList.remove('hidden');
    const user = readCurrentUser();
    const nameInput = document.getElementById('checkout-recipient-name');
    const phoneInput = document.getElementById('checkout-phone');
    const addressInput = document.getElementById('checkout-address');
    if (nameInput && !nameInput.value && user?.name) nameInput.value = user.name;
    if (phoneInput && !phoneInput.value && user?.phone) phoneInput.value = user.phone;
    if (addressInput && !addressInput.value && user?.address) addressInput.value = user.address;
    renderCart();
    loadDeliveryOptions();
}

async function loadDeliveryOptions() {
    const areaSelect = document.getElementById('checkout-delivery-area');
    const paymentSelect = document.getElementById('checkout-payment-method');
    if (!areaSelect || !paymentSelect) return;
    try {
        const [deliveryResponse, paymentResponse] = await Promise.all([
            fetch(`${API_URL}/delivery/options`),
            fetch(`${API_URL}/payment/options`)
        ]);
        if (!deliveryResponse.ok || !paymentResponse.ok) throw new Error('Checkout options unavailable');
        deliveryOptions = await deliveryResponse.json();
        paymentOptions = await paymentResponse.json();
        const selected = areaSelect.value;
        const selectedPayment = paymentSelect.value;
        areaSelect.replaceChildren(new Option(translations[currentLang].checkout_area, ''));
        deliveryOptions.forEach(option => {
            const label = currentLang === 'ar' ? (option.label_ar || option.area) : (option.label_en || option.area);
            const isConfigured = Boolean(option.configured ?? (option.shipping_fee != null));
            const availability = isConfigured ? '' : ` — ${translations[currentLang].checkout_fee_unconfigured}`;
            areaSelect.add(new Option(`${label}${availability}`, option.area));
        });
        if (deliveryOptions.some(option => option.area === selected)) areaSelect.value = selected;
        paymentSelect.replaceChildren();
        paymentOptions.forEach(method => {
            const label = method === 'cash_on_delivery' ? translations[currentLang].checkout_cash_on_delivery
                : method === 'paymob' ? translations[currentLang].checkout_online_payment : '';
            if (!label) return;
            paymentSelect.add(new Option(label, method));
        });
        paymentSelect.value = paymentOptions.includes(selectedPayment) ? selectedPayment : (paymentOptions.includes('cash_on_delivery') ? 'cash_on_delivery' : '');
    } catch (_) {
        deliveryOptions = [
            ["القاهرة", "Cairo"], ["الجيزة", "Giza"], ["الإسكندرية", "Alexandria"],
            ["القليوبية", "Qalyubia"], ["البحيرة", "Beheira"], ["مطروح", "Matrouh"],
            ["كفر الشيخ", "Kafr El Sheikh"], ["الغربية", "Gharbia"], ["المنوفية", "Monufia"],
            ["الدقهلية", "Dakahlia"], ["دمياط", "Damietta"], ["الشرقية", "Sharqia"],
            ["بورسعيد", "Port Said"], ["الإسماعيلية", "Ismailia"], ["السويس", "Suez"],
            ["شمال سيناء", "North Sinai"], ["جنوب سيناء", "South Sinai"], ["الفيوم", "Faiyum"],
            ["بني سويف", "Beni Suef"], ["المنيا", "Minya"], ["أسيوط", "Asyut"],
            ["سوهاج", "Sohag"], ["قنا", "Qena"], ["الأقصر", "Luxor"],
            ["أسوان", "Aswan"], ["البحر الأحمر", "Red Sea"], ["الوادي الجديد", "New Valley"]
        ].map(([label_ar, label_en]) => ({ area: label_ar, label_ar, label_en, configured: false, shipping_fee: null }));
        paymentOptions = ['cash_on_delivery'];
        const selectedArea = areaSelect.value;
        areaSelect.replaceChildren(new Option(translations[currentLang].checkout_choose_governorate, ''));
        deliveryOptions.forEach(option => {
            const label = currentLang === 'ar' ? option.label_ar : option.label_en;
            areaSelect.add(new Option(`${label} — ${translations[currentLang].checkout_fee_unconfigured}`, option.area));
        });
        if (deliveryOptions.some(option => option.area === selectedArea)) areaSelect.value = selectedArea;
        paymentSelect.replaceChildren();
        paymentOptions.forEach(method => paymentSelect.add(new Option(translations[currentLang].checkout_cash_on_delivery, method)));
        paymentSelect.value = 'cash_on_delivery';
    }
    updateCheckoutFulfillment();
}

function updateCheckoutFulfillment() {
    const deliveryMethod = document.getElementById('checkout-delivery-method')?.value || 'home_delivery';
    const areaSelect = document.getElementById('checkout-delivery-area');
    const areaWrap = document.getElementById('checkout-delivery-area-wrap');
    const addressInput = document.getElementById('checkout-address');
    const paymentMethod = document.getElementById('checkout-payment-method')?.value;
    const isHomeDelivery = deliveryMethod === 'home_delivery';
    if (areaWrap) areaWrap.classList.toggle('hidden', !isHomeDelivery);
    if (areaSelect) areaSelect.required = isHomeDelivery;
    if (addressInput) addressInput.required = isHomeDelivery;
    const codNotice = document.getElementById('cart-payment-note');
    const pickupCashNotice = document.getElementById('cart-pickup-cash-note');
    const demoNotice = document.getElementById('cart-payment-demo-note');
    const paymentSection = document.getElementById('checkout-electronic-payment-section');
    const isOnlinePayment = paymentMethod === 'paymob';
    if (codNotice) {
        codNotice.textContent = translations[currentLang].cart_cod_note;
        codNotice.classList.toggle('hidden', !(isHomeDelivery && !isOnlinePayment));
    }
    if (pickupCashNotice) {
        pickupCashNotice.textContent = translations[currentLang].checkout_pickup_cash_note;
        pickupCashNotice.classList.toggle('hidden', !(deliveryMethod === 'store_pickup' && !isOnlinePayment));
    }
    if (paymentSection) {
        paymentSection.classList.toggle('grid-rows-[1fr]', isOnlinePayment);
        paymentSection.classList.toggle('grid-rows-[0fr]', !isOnlinePayment);
        paymentSection.classList.toggle('opacity-100', isOnlinePayment);
        paymentSection.classList.toggle('opacity-0', !isOnlinePayment);
        paymentSection.classList.toggle('pointer-events-none', !isOnlinePayment);
        paymentSection.setAttribute('aria-hidden', String(!isOnlinePayment));
        paymentSection.inert = !isOnlinePayment;
    }
    if (!isOnlinePayment) {
        if (demoNotice) { demoNotice.textContent = ''; demoNotice.classList.add('hidden'); }
    }
    const checkoutButton = document.getElementById('cart-checkout-btn');
    if (checkoutButton) checkoutButton.classList.toggle('hidden', isOnlinePayment);
    renderCart();
}

function continueToElectronicPaymentDemo() {
    checkoutCart();
}

function closeCart() {
    document.getElementById('cart-modal')?.classList.add('hidden');
}

function setCartQuantity(productId, variantId, quantity) {
    const item = cartItems.find(entry => String(entry.product_id) === String(productId) && String(entry.variant_id || '') === String(variantId || ''));
    if (!item) return;
    const product = findProductById(productId);
    const stock = Number(product?.stock) || 0;
    const otherVariantsQuantity = cartItems.filter(entry => String(entry.product_id) === String(productId) && entry !== item).reduce((sum, entry) => sum + (Number(entry.quantity) || 0), 0);
    const next = Math.max(0, Math.min(parseInt(quantity, 10) || 0, Math.max(0, stock - otherVariantsQuantity)));
    if (!next) cartItems = cartItems.filter(entry => entry !== item);
    else item.quantity = next;
    saveCart();
    renderCart();
}

function removeCartItem(productId, variantId) {
    cartItems = cartItems.filter(item => !(String(item.product_id) === String(productId) && String(item.variant_id || '') === String(variantId || '')));
    saveCart();
    renderCart();
}

function acceptCurrentCartPrices() {
    cartItems = cartItems.map(item => {
        const product = findProductById(item.product_id);
        return product ? { ...item, expected_price: getCartUnitPrice(product, item) } : item;
    });
    saveCart();
    renderCart();
}

function renderCart() {
    const modalTitle = document.getElementById('cart-modal-title');
    const list = document.getElementById('cart-items');
    const totalLabel = document.getElementById('cart-total-label');
    const totalElement = document.getElementById('cart-total');
    const shippingLabel = document.getElementById('cart-shipping-label');
    const shippingElement = document.getElementById('cart-shipping-fee');
    const grandTotalLabel = document.getElementById('cart-grand-total-label');
    const grandTotalElement = document.getElementById('cart-grand-total');
    const areaSelect = document.getElementById('checkout-delivery-area');
    const paymentSelect = document.getElementById('checkout-payment-method');
    const deliveryMethod = document.getElementById('checkout-delivery-method')?.value || 'home_delivery';
    const checkoutButton = document.getElementById('cart-checkout-btn');
    if (!list) return;
    const t = translations[currentLang];
    modalTitle.innerHTML = `<i class="fa-solid fa-cart-shopping"></i> ${t.cart_title}`;
    totalLabel.textContent = t.cart_total;
    checkoutButton.textContent = t.cart_checkout;
    if (shippingLabel) shippingLabel.textContent = t.checkout_shipping;
    if (grandTotalLabel) grandTotalLabel.textContent = t.checkout_grand_total;

    const selectedArea = deliveryOptions.find(option => option.area === areaSelect?.value) || null;
    const hasConfiguredArea = Boolean(selectedArea?.configured ?? (selectedArea && selectedArea.shipping_fee != null));
    const shippingFee = deliveryMethod === 'home_delivery' && hasConfiguredArea ? Number(selectedArea.shipping_fee) : 0;
    if (shippingElement) shippingElement.textContent = deliveryMethod === 'store_pickup' ? `0 ${t.currency}` : selectedArea ? (hasConfiguredArea ? `${shippingFee.toLocaleString()} ${t.currency}` : t.checkout_fee_unconfigured) : t.checkout_choose_area;
    if (areaSelect && areaSelect.options.length && areaSelect.options[0].value === '') areaSelect.options[0].textContent = deliveryOptions.length ? t.checkout_choose_governorate : t.checkout_area_unavailable;

    let total = 0;
    let stalePrice = false;
    let missingProduct = false;
    let stockShort = false;
    list.innerHTML = cartItems.map(item => {
        const product = findProductById(item.product_id);
        const variant = item.variant || '';
        if (!product) {
            missingProduct = true;
            return `<div class="bg-slate-950 border border-rose-500/30 p-4 rounded-xl flex items-center justify-between gap-3"><span class="text-rose-300">${t.cart_unavailable} (#${escapeOrderText(item.product_id)})</span><button onclick="removeCartItem('${escapeOrderText(item.product_id)}','${escapeOrderText(item.variant_id || '')}')" class="text-rose-400 hover:text-rose-300">${t.cart_remove}</button></div>`;
        }
        if (product.show_in_modified_games) {
            missingProduct = true;
            return `<div class="bg-slate-950 border border-amber-500/30 p-4 rounded-xl flex items-center justify-between gap-3"><span class="text-amber-300">${escapeOrderText(product.name)} — ${t.modified_game_checkout_blocked}</span><button onclick="removeCartItem('${escapeOrderText(item.product_id)}','${escapeOrderText(item.variant_id || '')}')" class="text-rose-400 hover:text-rose-300">${t.cart_remove}</button></div>`;
        }
        const selectedVariant = item.variant_id ? getProductVariant(product, item.variant_id) : null;
        const needsVariant = Boolean(product.requires_variants || product.variants?.length);
        if (needsVariant && (!selectedVariant || !selectedVariant.is_active || selectedVariant.price == null)) {
            missingProduct = true;
            return `<div class="bg-slate-950 border border-rose-500/30 p-4 rounded-xl flex items-center justify-between gap-3"><span class="text-rose-300">${escapeOrderText(product.name)} — ${currentLang === 'ar' ? 'الخيار لم يعد متاحاً أو بلا سعر' : 'The selected option is unavailable or has no price'}</span><button onclick="removeCartItem('${escapeOrderText(item.product_id)}','${escapeOrderText(item.variant_id || '')}')" class="text-rose-400 hover:text-rose-300">${t.cart_remove}</button></div>`;
        }
        const unitPrice = getCartUnitPrice(product, item);
        const optionLabel = selectedVariant ? productOptionLabel(selectedVariant) : '';
        if (Number(item.expected_price) !== unitPrice) stalePrice = true;
        if (Number(item.quantity) > Number(product.stock)) stockShort = true;
        const lineTotal = Math.round((unitPrice * Number(item.quantity) + Number.EPSILON) * 100) / 100;
        total = Math.round((total + lineTotal + Number.EPSILON) * 100) / 100;
        return `<div class="bg-slate-950 border border-slate-800 p-3 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div class="flex items-center gap-3 min-w-0"><img src="${escapeOrderText(resolveProductImageUrl(product.image_url || product.image))}" onerror="handleProductImageError(this)" alt="" class="w-12 h-12 object-contain rounded-lg bg-slate-900"><div class="min-w-0"><p class="font-bold text-slate-100 truncate">${escapeOrderText(product.name)}</p><p class="text-[10px] text-slate-400">${optionLabel ? `${t.cart_variant}: ${escapeOrderText(optionLabel)} · ` : ''}${unitPrice.toLocaleString()} ${t.currency}</p>${Number(item.quantity) > Number(product.stock) ? `<p class="text-[10px] text-rose-400">${t.cart_stock_changed} (${product.stock})</p>` : ''}</div></div>
            <div class="flex items-center justify-between gap-3"><div class="flex items-center gap-2"><button onclick="setCartQuantity('${escapeOrderText(item.product_id)}','${escapeOrderText(item.variant_id || '')}',${item.quantity - 1})" class="w-7 h-7 rounded-lg bg-slate-800 text-slate-200">−</button><span class="min-w-5 text-center">${item.quantity}</span><button onclick="setCartQuantity('${escapeOrderText(item.product_id)}','${escapeOrderText(item.variant_id || '')}',${item.quantity + 1})" class="w-7 h-7 rounded-lg bg-slate-800 text-slate-200">+</button></div><strong class="text-cyan-400 whitespace-nowrap">${lineTotal.toLocaleString()} ${t.currency}</strong><button onclick="removeCartItem('${escapeOrderText(item.product_id)}','${escapeOrderText(item.variant_id || '')}')" class="text-rose-400 text-xs">${t.cart_remove}</button></div>
        </div>`;
    }).join('');
    if (!cartItems.length) list.innerHTML = `<p class="text-center text-slate-400 py-8">${t.cart_empty}</p>`;
    totalElement.textContent = `${total.toLocaleString()} ${t.currency}`;
    const totalShippingIsKnown = deliveryMethod === 'store_pickup' || Boolean(selectedArea && hasConfiguredArea);
    if (grandTotalElement) grandTotalElement.textContent = totalShippingIsKnown
        ? `${(total + shippingFee).toLocaleString()} ${t.currency}`
        : t.checkout_total_unavailable;
    const priceWarning = document.getElementById('cart-price-warning');
    if (priceWarning) {
        priceWarning.classList.toggle('hidden', !stalePrice);
        priceWarning.querySelector('[data-price-warning]')?.replaceChildren(document.createTextNode(t.cart_price_changed));
        const acceptButton = priceWarning.querySelector('button');
        if (acceptButton) acceptButton.textContent = t.cart_accept_price;
    }
    const isElectronicPayment = paymentSelect?.value === 'paymob';
    const recipientName = document.getElementById('checkout-recipient-name')?.value.trim() || '';
    const phone = document.getElementById('checkout-phone')?.value.trim() || '';
    const address = document.getElementById('checkout-address')?.value.trim() || '';
    let blockedMessage = '';
    if (!cartItems.length) blockedMessage = t.cart_empty;
    else if (missingProduct) blockedMessage = t.cart_unavailable;
    else if (stalePrice) blockedMessage = t.cart_price_changed;
    else if (stockShort) blockedMessage = t.cart_stock_conflict;
    else if (!recipientName) blockedMessage = t.checkout_recipient_required;
    else if (phone.length < 5) blockedMessage = t.checkout_phone_required;
    else if (deliveryMethod === 'home_delivery' && !address) blockedMessage = t.checkout_address_required;
    else if (deliveryMethod === 'home_delivery' && !selectedArea) blockedMessage = t.checkout_choose_governorate;
    else if (deliveryMethod === 'home_delivery' && !hasConfiguredArea) blockedMessage = t.checkout_fee_unconfigured;
    else if (!['cash_on_delivery', 'paymob'].includes(paymentSelect?.value)) blockedMessage = t.checkout_payment_required;
    checkoutButton.disabled = isCheckoutSubmitting || Boolean(blockedMessage);
    checkoutButton.classList.toggle('opacity-50', checkoutButton.disabled);
    checkoutButton.textContent = isCheckoutSubmitting ? t.cart_submitting : (isElectronicPayment ? t.checkout_continue_payment : t.cart_checkout);
    const validationHint = document.getElementById('checkout-validation-hint');
    if (validationHint) {
        validationHint.textContent = blockedMessage;
        validationHint.classList.toggle('hidden', !blockedMessage);
    }
}

function checkoutSuccessMessage(order) {
    if (order.delivery_method === 'store_pickup') return translations[currentLang].order_pickup_success;
    return translations[currentLang].cart_order_success;
}

async function checkoutCart() {
    if (isCheckoutSubmitting) return;
    const user = readCurrentUser();
    if (!user) {
        closeCart();
        openUserModal();
        return;
    }
    const ownerKey = cartStorageKeyForUser(user);
    if (activeCartStorageKey !== ownerKey) {
        activateCartForUser(user);
        const ownershipMessage = currentLang === 'ar'
            ? 'تم تغيير الحساب. تمت مزامنة سلته؛ راجع المنتجات قبل تأكيد الطلب.'
            : 'The account changed. Its cart has been loaded; review it before placing the order.';
        const ownershipError = document.getElementById('cart-error');
        if (ownershipError) { ownershipError.textContent = ownershipMessage; ownershipError.classList.remove('hidden'); }
        return;
    }
    if (!user.id) {
        const errorElement = document.getElementById('cart-error');
        if (errorElement) {
            errorElement.textContent = currentLang === 'ar' ? 'تعذر تحديد الحساب. سجّل الدخول مجدداً قبل تأكيد الطلب.' : 'Could not identify the account. Sign in again before placing the order.';
            errorElement.classList.remove('hidden');
        }
        return;
    }
    if (!cartItems.length) return;
    const recipientName = document.getElementById('checkout-recipient-name')?.value.trim() || '';
    const phone = document.getElementById('checkout-phone')?.value.trim() || '';
    const address = document.getElementById('checkout-address')?.value.trim() || '';
    const deliveryMethod = document.getElementById('checkout-delivery-method')?.value || 'home_delivery';
    const deliveryArea = deliveryMethod === 'home_delivery' ? (document.getElementById('checkout-delivery-area')?.value || '') : '';
    const paymentMethod = document.getElementById('checkout-payment-method')?.value || '';
    const selectedGovernorate = deliveryOptions.find(option => option.area === deliveryArea);
    const hasConfiguredGovernorateFee = Boolean(selectedGovernorate?.configured ?? (selectedGovernorate && selectedGovernorate.shipping_fee != null));
    if (!recipientName || phone.length < 5 || (deliveryMethod === 'home_delivery' && (!deliveryArea || !address || !hasConfiguredGovernorateFee)) || !['cash_on_delivery', 'paymob'].includes(paymentMethod)) {
        const errorElement = document.getElementById('cart-error');
        if (errorElement) {
            const t = translations[currentLang];
            errorElement.textContent = !recipientName ? t.checkout_recipient_required
                : phone.length < 5 ? t.checkout_phone_required
                    : deliveryMethod === 'home_delivery' && !address ? t.checkout_address_required
                        : deliveryMethod === 'home_delivery' && !deliveryArea ? t.checkout_choose_governorate
                            : deliveryMethod === 'home_delivery' && !hasConfiguredGovernorateFee ? t.checkout_fee_unconfigured
                                : t.checkout_payment_required;
            errorElement.classList.remove('hidden');
        }
        return;
    }
    const submittedItems = cartItems.map(item => ({ ...item }));
    const button = document.getElementById('cart-checkout-btn');
    const electronicButton = document.querySelector('#checkout-electronic-payment-section button[data-key="checkout_continue_payment"]');
    const errorElement = document.getElementById('cart-error');
    isCheckoutSubmitting = true;
    if (button) { button.disabled = true; button.textContent = translations[currentLang].cart_submitting; }
    if (electronicButton) { electronicButton.disabled = true; electronicButton.textContent = translations[currentLang].cart_submitting; }
    errorElement?.classList.add('hidden');
    try {
        const requestPayload = {
            user_id: user.id,
            recipient_name: recipientName,
            phone,
            address,
            delivery_method: deliveryMethod,
            delivery_area: deliveryArea,
            payment_method: paymentMethod,
            items: submittedItems.map(item => ({
                product_id: item.product_id,
                quantity: item.quantity,
                variant_id: item.variant_id || null,
                platform: item.platform || null,
                edition: item.edition || null,
                expected_price: item.expected_price
            }))
        };
        const fingerprint = JSON.stringify(requestPayload);
        const idempotencyStorageKey = `mdstore_checkout_${user.id}`;
        let savedCheckout = null;
        try { savedCheckout = JSON.parse(localStorage.getItem(idempotencyStorageKey) || 'null'); } catch (_) {}
        const idempotencyKey = savedCheckout?.fingerprint === fingerprint
            ? savedCheckout.key
            : (window.crypto?.randomUUID ? window.crypto.randomUUID() : `md-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        localStorage.setItem(idempotencyStorageKey, JSON.stringify({ fingerprint, key: idempotencyKey }));
        const headers = customerHeaders();
        headers['Idempotency-Key'] = idempotencyKey;
        const response = await fetch(`${API_URL}/orders`, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestPayload)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            if (response.status === 409) {
                const productsResponse = await fetch(`${API_URL}/products`).catch(() => null);
                if (productsResponse?.ok) {
                    const products = await productsResponse.json();
                    allStoreProductsCache = products.filter(product => product.category !== 'Games');
                    allGameProductsCache = products.filter(product => product.category === 'Games');
                    window.products = products;
                    window.gameProducts = allGameProductsCache;
                    renderCart();
                }
                throw new Error(data.detail?.toLowerCase().includes('price') ? translations[currentLang].cart_price_changed : (data.detail || translations[currentLang].cart_stock_conflict));
            }
            throw new Error(data.detail || `${translations[currentLang].cart_order_failed} (HTTP ${response.status})`);
        }
        if (!data.id || !Number.isInteger(Number(data.id)) || !data.status) throw new Error(translations[currentLang].cart_order_failed);
        if (paymentMethod === 'paymob' && !data.checkout_url) throw new Error(translations[currentLang].cart_order_failed);
        const persistedCheckout = JSON.parse(localStorage.getItem(idempotencyStorageKey) || 'null');
        if (persistedCheckout?.key === idempotencyKey) localStorage.removeItem(idempotencyStorageKey);
        // Remove only quantities included in this order. Preserve cart edits
        // made while the request was in flight, and never touch another
        // account's currently active cart.
        let storedOwnerCart = [];
        try {
            const parsedCart = JSON.parse(localStorage.getItem(ownerKey) || '[]');
            if (Array.isArray(parsedCart)) storedOwnerCart = parsedCart;
        } catch (_) { /* Treat malformed saved cart data as empty. */ }
        const remainingOwnerCart = remainingCartAfterOrder(storedOwnerCart, submittedItems);
        localStorage.setItem(ownerKey, JSON.stringify(remainingOwnerCart));
        if (activeCartStorageKey === ownerKey) {
            cartItems = remainingOwnerCart;
            updateCartBadge();
            renderCart();
            closeCart();
        }
        if (paymentMethod === 'paymob') {
            window.location.assign(data.checkout_url);
            return;
        }
        showToast(checkoutSuccessMessage(data).replace('{id}', data.id), 'success', 6000);
        await loadStoreProducts();
        await loadGameProducts();
        const refreshedProduct = currentProduct ? findProductById(currentProduct.id) : null;
        if (refreshedProduct) populateProductPage(refreshedProduct);
        loadCustomerOrders();
    } catch (error) {
        const details = String(error.message || '');
        const normalized = details.toLowerCase();
        const localizedDetails = currentLang === 'ar' && normalized.includes('stock') ? translations.ar.cart_stock_conflict
            : currentLang === 'ar' && normalized.includes('price') ? translations.ar.cart_price_changed
                : currentLang === 'ar' && normalized.includes('delivery fees') ? translations.ar.checkout_fee_unconfigured
                    : currentLang === 'ar' && normalized.includes('governorate') ? translations.ar.checkout_choose_governorate
                        : currentLang === 'ar' && normalized.includes('recipient name') ? translations.ar.checkout_recipient_required
                            : currentLang === 'ar' && normalized.includes('phone') ? translations.ar.checkout_phone_required
                                : currentLang === 'ar' && normalized.includes('address') ? translations.ar.checkout_address_required
                : currentLang === 'ar' && (normalized.includes('option') || normalized.includes('variant')) ? translations.ar.cart_select_variant
                    : details;
        if (errorElement) {
            errorElement.textContent = error instanceof TypeError ? (currentLang === 'ar' ? `تعذر الاتصال بالخادم (${API_URL}). تحقق من تشغيل الخادم وإعداد عنوان API وCORS.` : `Could not reach the server at ${API_URL}. Check that it is running and the API URL/CORS are configured.`) : (localizedDetails || translations[currentLang].cart_order_failed);
            errorElement.classList.remove('hidden');
        }
    } finally {
        isCheckoutSubmitting = false;
        if (electronicButton) { electronicButton.disabled = false; electronicButton.textContent = translations[currentLang].checkout_continue_payment; }
        renderCart();
    }
}

function escapeQuotes(str) {
    if (!str) return '';
    return String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// 🔔 دالة إظهار التنبيهات الاحترافية للمستخدم
function showToast(message, type = 'info', duration = 3000) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'fixed bottom-5 left-5 z-[100] flex flex-col gap-2 pointer-events-none';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    
    let bgBorder, iconClass, textColor;
    if (type === 'success') {
        bgBorder = 'bg-slate-900/90 border-emerald-500/40 shadow-emerald-500/10';
        iconClass = 'fa-solid fa-circle-check text-emerald-400';
        textColor = 'text-emerald-300';
    } else if (type === 'error') {
        bgBorder = 'bg-slate-900/90 border-rose-500/40 shadow-rose-500/10';
        iconClass = 'fa-solid fa-circle-xmark text-rose-400';
        textColor = 'text-rose-300';
    } else {
        bgBorder = 'bg-slate-900/90 border-cyan-500/40 shadow-cyan-500/10';
        iconClass = 'fa-solid fa-circle-info text-cyan-400';
        textColor = 'text-cyan-300';
    }

    toast.className = `pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-2xl border ${bgBorder} backdrop-blur-md shadow-2xl text-xs font-bold ${textColor} opacity-0 translate-y-4 transition-all duration-300 ease-out`;
    
    toast.innerHTML = `
        <i class="${iconClass} text-base"></i>
        <span class="${textColor}"></span>
    `;
    toast.querySelector('span').textContent = String(message ?? '');

    container.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.remove('opacity-0', 'translate-y-4');
        toast.classList.add('opacity-100', 'translate-y-0');
    });

    setTimeout(() => {
        toast.classList.remove('opacity-100', 'translate-y-0');
        toast.classList.add('opacity-0', 'translate-y-4');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// دالة تتبع البحث والاهتمامات للسيرفر
async function trackInterest(term, interestType = 'category', productId = null) {
    const currentUser = readCurrentUser();
    if (!currentUser?.id || !localStorage.getItem('customerToken')) return { status: 'guest' };
    const normalizedProductId = Number(productId);
    if (interestType === 'product' && (!Number.isInteger(normalizedProductId) || normalizedProductId <= 0)) {
        console.error('تعذر تسجيل الاهتمام: معرّف المنتج غير صالح.', productId);
        return { status: 'invalid_product' };
    }
    const normalizedTerm = String(term || '').replace(/\s+/g, ' ').trim();
    if (interestType !== 'product' && !normalizedTerm) return { status: 'ignored' };

    try {
        const response = await fetch(`${API_URL}/users/${currentUser.id}/interest`, {
            method: 'POST',
            headers: customerHeaders(),
            body: JSON.stringify({
                category: normalizedTerm || null,
                interest_type: interestType,
                product_id: interestType === 'product' ? normalizedProductId : null
            })
        });
        if (!response.ok) {
            const detail = await response.json().catch(() => ({}));
            throw new Error(detail.detail || `Interest tracking failed: ${response.status}`);
        }
        return await response.json();
    } catch (err) {
        console.error('تعذر تسجيل الاهتمام:', err);
        return { status: 'error', error: err };
    }
}

function showError(inputId, message) {
    const inputElem = document.getElementById(inputId);
    const errorElem = document.getElementById(`error-${inputId}`);

    if (inputElem) {
        inputElem.classList.add('border-rose-500', 'focus:border-rose-500');
        inputElem.classList.remove('border-slate-800', 'focus:border-cyan-500');
    }

    if (errorElem) {
        const span = errorElem.querySelector('span') || errorElem;
        span.innerText = message;
        errorElem.classList.remove('hidden');
    }
}

function clearErrors() {
    document.querySelectorAll('[id^="error-"]').forEach(elem => {
        elem.classList.add('hidden');
        const span = elem.querySelector('span');
        if (span) span.innerText = '';
    });

    document.querySelectorAll('input, select, textarea').forEach(input => {
        input.classList.remove('border-rose-500', 'focus:border-rose-500');
        input.classList.add('border-slate-800', 'focus:border-cyan-500');
    });

    const globalErr = document.getElementById('global-error');
    if (globalErr) globalErr.classList.add('hidden');
}

function showGlobalError(message) {
    const globalErr = document.getElementById('global-error');
    const globalMsg = document.getElementById('global-error-msg');
    if (globalErr && globalMsg) {
        globalMsg.innerText = message;
        globalErr.classList.remove('hidden');
    }
}

function switchAuthMode(mode) {
    clearErrors();
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const loginTab = document.getElementById('modal-tab-login');
    const registerTab = document.getElementById('modal-tab-register');

    if (mode === 'login') {
        if (loginForm) loginForm.classList.remove('hidden');
        if (registerForm) registerForm.classList.add('hidden');
        if (loginTab) loginTab.className = 'text-cyan-400 border-b-2 border-cyan-400 pb-1 cursor-pointer';
        if (registerTab) registerTab.className = 'text-slate-400 hover:text-slate-200 pb-1 cursor-pointer';
    } else {
        if (registerForm) registerForm.classList.remove('hidden');
        if (loginForm) loginForm.classList.add('hidden');
        if (registerTab) registerTab.className = 'text-cyan-400 border-b-2 border-cyan-400 pb-1 cursor-pointer';
        if (loginTab) loginTab.className = 'text-slate-400 hover:text-slate-200 pb-1 cursor-pointer';
    }
}

// 🛒 دالة الشراء المباشر لرسالة الواتساب
async function handleBuyClick(productName, price) {
    const savedUser = localStorage.getItem('currentUser');
    if (!savedUser) {
        openUserModal();
        return;
    }

    const currentUser = JSON.parse(savedUser);
    await trackInterest(`شراء: ${productName}`);

    const currencyText = translations[currentLang].currency;

    const messageText = currentLang === 'ar' 
        ? `🛒 *طلب شراء جديد من المتجر*
-----------------------
👤 *اسم الحساب:* ${currentUser.name}
📧 *البريد الإلكتروني:* ${currentUser.email || 'غير محدد'}
📞 *رقم الهاتف:* ${currentUser.phone || 'غير محدد'}
📦 *المنتج / اللعبة:* ${productName}
💰 *السعر:* ${price} ${currencyText}`
        : `🛒 *New Purchase Order*
-----------------------
👤 *Account Name:* ${currentUser.name}
📧 *Email:* ${currentUser.email || 'N/A'}
📞 *Phone:* ${currentUser.phone || 'N/A'}
📦 *Item:* ${productName}
💰 *Price:* ${price} ${currencyText}`;

    const encodedMessage = encodeURIComponent(messageText);
    window.open(`https://wa.me/${OWNER_PHONE}?text=${encodedMessage}`, '_blank');
}

// ======================================================
// 1. نظام الـ Routing المحسّن والتنقل بين الصفحات
// ======================================================

window.currentSelectedProduct = null;

// دالة اختيار نسخة اللعبة والمنصة
function selectProductVersion(btnElement, versionValue) {
    document.querySelectorAll('.version-option-btn').forEach(btn => {
        btn.classList.remove('border-cyan-400', 'bg-cyan-500/20', 'text-cyan-300', 'shadow-cyan-500/20');
        btn.classList.add('border-slate-800', 'bg-slate-900/80', 'text-slate-400');
    });

    if (btnElement) {
        btnElement.classList.remove('border-slate-800', 'bg-slate-900/80', 'text-slate-400');
        btnElement.classList.add('border-cyan-400', 'bg-cyan-500/20', 'text-cyan-300', 'shadow-cyan-500/20');
    }
    window.selectedProductVariantId = null;
    updateWhatsAppLink();
}

function selectProductVariant(variantId) {
    window.selectedProductVariantId = variantId ? Number(variantId) : null;
    const variant = window.selectedProductVariantId ? getProductVariant(currentProduct, window.selectedProductVariantId) : null;
    const price = variant?.price;
    const currencyText = translations[currentLang]?.currency || (currentLang === 'ar' ? '?.?' : 'EGP');
    const priceElement = document.getElementById('product-page-price');
    if (priceElement) priceElement.textContent = price == null ? (currentLang === 'ar' ? '\u0627\u0644\u0633\u0639\u0631 \u063a\u064a\u0631 \u0645\u062a\u0627\u062d' : 'Price unavailable') : `${Number(price).toLocaleString()} ${currencyText}`;
    updateWhatsAppLink();
}

function populateProductPage(product) {
    if (!product) return;

    currentProduct = product;
    window.currentSelectedProduct = product;
    trackInterest(product.name || product.title || '', 'product', product.id);
    renderProductRatings(product.id);
    window.selectedProductVariantId = null;
    const cartButton = document.getElementById('add-to-cart-btn');
    const modifiedContactButton = document.getElementById('product-page-modified-contact');
    if (cartButton) cartButton.classList.toggle('hidden', Boolean(product.show_in_modified_games));
    if (modifiedContactButton) modifiedContactButton.classList.toggle('hidden', !product.show_in_modified_games);
    const modifiedContactLabel = document.getElementById('product-page-modified-contact-label');
    if (modifiedContactLabel) modifiedContactLabel.textContent = currentLang === 'ar' ? 'نسّق تركيب اللعبة بالفرع عبر واتساب' : 'Arrange branch installation on WhatsApp';

    const currencyText = (translations[currentLang] && translations[currentLang].currency) || (currentLang === 'ar' ? 'ج.م' : 'EGP');
    const nameVal = product.name || product.title || '';
    const priceVal = product.price ?? 0;
    const imgUrl = resolveProductImageUrl(product.image_url || product.image);
    const descVal = product.description || product.desc || '';

    // 1. تحديث اسم المنتج
    const nameElems = ['product-detail-name', 'product-name', 'product-title', 'product-page-title'];
    nameElems.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = nameVal;
    });

    // 2. تحديث السعر
    const priceElems = ['product-detail-price', 'product-price', 'product-page-price'];
    priceElems.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = `${priceVal} ${currencyText}`;
    });

    // 3. تحديث صورة المنتج
    const imgElems = ['main-product-image', 'product-detail-img', 'product-image', 'product-main-img', 'product-page-img'];
    imgElems.forEach(id => {
        const el = document.getElementById(id);
        if (el && el.tagName === 'IMG') {
            el.src = imgUrl;
            el.onerror = () => handleProductImageError(el);
            el.alt = nameVal;
        }
    });

    // 4. تحديث الوصف
    const descElems = ['product-page-description', 'product-detail-desc', 'product-description', 'product-desc', 'product-page-desc'];
    descElems.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = descVal;
    });

    // 5. استهداف الحاوية المخصصة للمنصات والنسخ بعرض الصفحة الكامل (#product-page-variants)
    let versionContainer = document.getElementById('product-page-variants') || document.getElementById('product-versions-container');
    
    // في حالة عدم وجود الحاوية، يتم إنشاؤها أعلى قسم الكمية وليس داخله
    if (!versionContainer) {
        const qtyInput = document.getElementById('product-page-qty');
        if (qtyInput) {
            const qtySection = qtyInput.closest('.mb-6') || qtyInput.parentElement;
            versionContainer = document.createElement('div');
            versionContainer.id = 'product-page-variants';
            versionContainer.className = 'mb-6 space-y-2';
            qtySection.parentElement.insertBefore(versionContainer, qtySection);
        }
    }

    window.selectedProductVariantId = null;
    if (versionContainer) {
        const variants = (product.variants || []).filter(option => option.is_active);
        const needsVariant = Boolean(product.requires_variants || (product.variants || []).length);
        
        versionContainer.classList.toggle('hidden', !needsVariant);

        if (needsVariant) {
            const priceElement = document.getElementById('product-page-price');
            if (priceElement) priceElement.textContent = currentLang === 'ar' ? 'اختر خياراً' : 'Select an option';
            
            const options = variants.map(option => {
                const label = productOptionLabel(option);
                const priced = option.price !== null && Number.isFinite(Number(option.price));
                return `<option value="${option.id}" ${priced ? '' : 'disabled'}>${escapeOrderText(label)}${priced ? ` — ${Number(option.price).toLocaleString()}${currencyText}` : (currentLang === 'ar' ? ' — السعر غير محدد' : ' — price not configured')}</option>`;
            }).join('');

            versionContainer.innerHTML = `
                <label class="block text-xs font-bold text-slate-400 mb-2">${currentLang === 'ar' ? 'اختر المنصة / الإصدار والسعر:' : 'Select platform / edition and price:'}</label>
                <select id="product-variant-select" onchange="selectProductVariant(this.value)" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-100 focus:outline-none focus:border-cyan-500 transition">
                    <option value="">${currentLang === 'ar' ? 'اختر الخيار' : 'Select an option'}</option>
                    ${options}
                </select>
                <p id="product-variant-note" class="text-xs text-amber-300 mt-2">${variants.length ? '' : (currentLang === 'ar' ? 'هذا المنتج غير متاح للشراء حتى إعداد الخيارات والأسعار' : 'This product cannot be purchased until its options and prices are configured.')}</p>
            `;
        } else {
            const priceElement = document.getElementById('product-page-price');
            if (priceElement) priceElement.textContent = `${Number(priceVal).toLocaleString()} ${currencyText}`;
            versionContainer.innerHTML = '';
        }
    }

    // 6. إعادة ضبط الكمية إلى 1
    const qtyInput = document.getElementById('product-page-qty');
    if (qtyInput) qtyInput.value = 1;
}

// دالة معالجة رابط الـ Hash وإظهار التبويب المطلوب
function handleRouting() {
    const rawHash = window.location.hash.replace('#', '') || 'landing';
    const parts = rawHash.split('/');
    const tabName = parts[0];
    const productId = parts[1];

    if (tabName === 'product' && productId) {
        const allItems = [
            ...(allStoreProductsCache || []),
            ...(allGameProductsCache || []),
            ...(window.products || []),
            ...(window.gameProducts || [])
        ];

        let product = window.currentSelectedProduct?.is_active === false ? null : window.currentSelectedProduct;

        if (!product || String(product.id) !== String(productId)) {
            product = allItems.find(p => String(p.id) === String(productId) && p.is_active !== false);
        }

        if (product) {
            populateProductPage(product);
            showTabDOM('product');
        } else {
            showTabDOM('product');
        }
    } else {
        showTabDOM(tabName || 'landing');
    }
}

function handleLogoClick() {
    if (window.location.hash !== '#landing' && window.location.hash !== '') {
        window.location.hash = 'landing';
    }
    location.reload();
}

// دالة التنقل بين التبويبات الرئيسية
function switchTab(tabName) {
    // 1. إظهار انيميشن التحميل
    showGlobalLoader();

    // 2. تحديث الـ Hash أو تنفيذ الـ Routing
    setTimeout(() => {
        if (tabName === 'profile') loadCustomerOrders();
        
        const targetHash = tabName === 'product' && currentProduct ? `product/${currentProduct.id}` : tabName;
        
        if (window.location.hash === `#${targetHash}`) {
            handleRouting();
        } else {
            window.location.hash = targetHash;
        }

        // 3. التمرير لأعلى الصفحة
        window.scrollTo({ top: 0, behavior: 'smooth' });

        // 4. إخفاء الـ Loader بعد ما الصفحة تتغير
        setTimeout(() => {
            hideGlobalLoader();
        }, 200);
    }, 150);
}

// دالة إظهار وإخفاء عناصر الـ DOM للتبويبات
function showTabDOM(activeTab) {
    const tabs = ['landing', 'store', 'games', 'product', 'maintenance', 'trade', 'profile'];
    
    tabs.forEach(tab => {
        const content = document.getElementById(`tab-content-${tab}`);
        const btn = document.getElementById(`tab-btn-${tab}`);
        
        if (content) {
            if (tab === activeTab) {
                content.classList.remove('hidden');
            } else {
                content.classList.add('hidden');
            }
        }

        if (btn) {
            if (tab === activeTab) {
                btn.classList.add('tab-active', 'text-cyan-400');
                btn.classList.remove('text-slate-400');
            } else {
                btn.classList.remove('tab-active', 'text-cyan-400');
                btn.classList.add('text-slate-400');
            }
        }
    });

    window.scrollTo({ top: 0, behavior: 'smooth' });
    window.requestAnimationFrame(syncLandingSliderControls);
}

// الاستماع لتغيرات الـ Hash وزر الرجوع بالمتصفح
window.addEventListener('hashchange', handleRouting);
window.addEventListener('popstate', handleRouting);

// ➕/➖ دالة تعديل الكمية
function changeQty(delta) {
    const qtyInput = document.getElementById('product-page-qty');
    if (!qtyInput) return;
    let qty = parseInt(qtyInput.value) || 1;
    const maxStock = currentProduct ? Math.max(1, Number(currentProduct.stock) || 1) : Number.MAX_SAFE_INTEGER;
    qty = Math.min(maxStock, Math.max(1, qty + delta));
    qtyInput.value = qty;
    updateWhatsAppLink();
}

// 📲 دالة تحديث رابط الواتساب من داخل صفحة التفاصيل
function updateWhatsAppLink() {
    if (!currentProduct) return;

    const savedUser = localStorage.getItem('currentUser');
    const currentUser = savedUser ? JSON.parse(savedUser) : { name: 'زائر', phone: 'غير محدد' };

    const qtyInput = document.getElementById('product-page-qty');
    const qty = qtyInput ? (parseInt(qtyInput.value) || 1) : 1;
    const selectedOption = window.selectedProductVariantId ? getProductVariant(currentProduct, window.selectedProductVariantId) : null;
    const totalPrice = (selectedOption?.price ?? currentProduct.price ?? 0) * qty;
    const currencyText = translations[currentLang].currency;
    const productName = currentProduct.name || currentProduct.title || 'منتج';
    const selectedVer = selectedOption ? productOptionLabel(selectedOption) : '';

    const versionTextAr = `🎮 *النسخة والمنصة:* ${selectedVer}\n`;
    const versionTextEn = `🎮 *Version & Platform:* ${selectedVer}\n`;

    const messageText = currentLang === 'ar' 
        ? `🛒 *طلب شراء جديد من المتجر*
-----------------------
👤 *اسم الحساب:* ${currentUser.name}
📧 *البريد الإلكتروني:* ${currentUser.email || 'غير محدد'}
📞 *رقم الهاتف:* ${currentUser.phone || 'غير محدد'}
📦 *المنتج / اللعبة:* ${productName}
${versionTextAr}🔢 *الكمية:* ${qty}
💰 *السعر الإجمالي:* ${totalPrice} ${currencyText}`
        : `🛒 *New Purchase Order*
-----------------------
👤 *Account Name:* ${currentUser.name}
📧 *Email:* ${currentUser.email || 'N/A'}
📞 *Phone:* ${currentUser.phone || 'N/A'}
📦 *Item:* ${productName}
${versionTextEn}🔢 *Quantity:* ${qty}
💰 *Total Price:* ${totalPrice} ${currencyText}`;

    const waBtn = document.getElementById('product-page-whatsapp');
    if (waBtn) {
        waBtn.onclick = (e) => {
            e.preventDefault();
            if (!savedUser) {
                openUserModal();
                return;
            }
            trackInterest(`شراء (${selectedVer}): ${productName}`);
            window.open(`https://wa.me/${OWNER_PHONE}?text=${encodeURIComponent(messageText)}`, '_blank');
        };
    }
}

// 🛠 معالجة طلب الصيانة
async function handleMaintSubmit(event) {
    event.preventDefault();
    clearErrors();

    const savedUser = localStorage.getItem('currentUser');
    if (!savedUser) {
        openUserModal();
        return;
    }

    const currentUser = JSON.parse(savedUser);
    const deviceSelect = document.getElementById('maint-device');
    const deviceText = deviceSelect.options[deviceSelect.selectedIndex] ? deviceSelect.options[deviceSelect.selectedIndex].text : deviceSelect.value;
    const deviceValue = deviceSelect.value;
    const phone = document.getElementById('maint-phone').value.trim();
    const desc = document.getElementById('maint-desc').value.trim();

    let hasErr = false;
    if (!deviceValue) { showError('maint-device', currentLang === 'ar' ? 'من فضلك اختر نوع الجهاز' : 'Please select device type'); hasErr = true; }
    if (!phone) { showError('maint-phone', currentLang === 'ar' ? 'من فضلك أدخل رقم الهاتف للتواصل' : 'Please enter contact phone'); hasErr = true; }
    if (!desc) { showError('maint-desc', currentLang === 'ar' ? 'من فضلك اكتب تفاصيل المشكلة' : 'Please describe the issue'); hasErr = true; }

    if (hasErr) return;

    let repairId = "جديد";
    try {
        const response = await fetch(`${API_URL}/repairs`, {
            method: 'POST',
            headers: customerHeaders(),
            body: JSON.stringify({
                user_id: currentUser.id,
                phone: phone,
                device_type: deviceText,
                issue_description: desc
            })
        });

        if (response.ok) {
            const data = await response.json();
            if (data.repair_id) repairId = `#${data.repair_id}`;
        }
    } catch (error) {
        console.warn('تعذر الاتصال بالسيرفر لحفظ الطلب');
    }

    const messageText = 
`🛠️ *طلب صيانة جديد (رقم الطلب: ${repairId})*
-----------------------
👤 *اسم الحساب:* ${currentUser.name}
📧 *البريد الإلكتروني:* ${currentUser.email || 'غير محدد'}
📞 *رقم التواصل:* ${phone}
🎮 *الجهاز / الذراع:* ${deviceText}
📝 *تفاصيل المشكلة:*
${desc}`;

    window.open(`https://wa.me/${OWNER_PHONE}?text=${encodeURIComponent(messageText)}`, '_blank');
    const maintForm = document.getElementById('maint-form');
    if (maintForm) maintForm.reset();
}

// 🔄 معالجة طلب الاستبدال والبيع
async function handleTradeSubmit(event) {
    event.preventDefault();
    clearErrors();

    const savedUser = localStorage.getItem('currentUser');
    if (!savedUser) {
        openUserModal();
        return;
    }

    const currentUser = JSON.parse(savedUser);
    const item = document.getElementById('trade-item').value.trim();
    const condition = document.getElementById('trade-condition').value.trim();

    let hasErr = false;
    if (!item) { showError('trade-item', currentLang === 'ar' ? 'من فضلك اذكر اسم أو نوع الجهاز/الذراع' : 'Please specify the item'); hasErr = true; }
    if (!condition) { showError('trade-condition', currentLang === 'ar' ? 'من فضلك اذكر حالة الجهاز والملحقات' : 'Please describe the condition'); hasErr = true; }

    if (hasErr) return;

    let tradeId = "جديد";
    try {
        const response = await fetch(`${API_URL}/trades`, {
            method: 'POST',
            headers: customerHeaders(),
            body: JSON.stringify({
                user_id: currentUser.id,
                item_details: item,
                condition_details: condition
            })
        });

        if (response.ok) {
            const data = await response.json();
            if (data.trade_id) tradeId = `#${data.trade_id}`;
        }
    } catch (error) {
        console.warn('تعذر الاتصال بالسيرفر لحفظ الطلب');
    }

    const messageText = 
`🔄 *طلب تقييم استبدال / بيع (رقم الطلب: ${tradeId})*
-----------------------
👤 *اسم الحساب:* ${currentUser.name}
📧 *البريد الإلكتروني:* ${currentUser.email || 'غير محدد'}
📞 *رقم الهاتف:* ${currentUser.phone || 'غير محدد'}
📦 *الجهاز المعروض:* ${item}
📋 *الحالة والمشتملات:*
${condition}`;

    window.open(`https://wa.me/${OWNER_PHONE}?text=${encodeURIComponent(messageText)}`, '_blank');
    const tradeForm = document.getElementById('trade-form');
    if (tradeForm) tradeForm.reset();
}

// 🔐 معالجة تسجيل الدخول
async function handleLoginSubmit(event) {
    event.preventDefault();
    clearErrors();

    const identifierInput = document.getElementById('login-identifier');
    const passwordInput = document.getElementById('login-password');
    const identifier = identifierInput.value.trim().toLowerCase();
    const password = passwordInput.value;

    let hasError = false;
    if (!identifier) {
        showError('login-identifier', currentLang === 'ar' ? 'من فضلك ادخل البريد أو رقم الهاتف' : 'Please enter email or phone');
        hasError = true;
    }
    if (!password) {
        showError('login-password', currentLang === 'ar' ? 'من فضلك ادخل كلمة المرور' : 'Please enter password');
        hasError = true;
    }

    if (hasError) return;

    try {
        const response = await fetch(`${API_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier: identifier, password: password })
        });

        const data = await response.json();

        if (response.ok) {
            if (!saveCustomerSession(data)) throw new Error('The server did not return an authenticated customer session.');
            const customer = readCurrentUser();
            activateCartForUser(customer);
            localStorage.removeItem('chat_session_id'); // مسح جلسة الزائر
            checkCurrentUser();
            closeUserModal();
            switchTab('profile');
            showToast(currentLang === 'ar' ? 'تم تسجيل الدخول بنجاح' : 'Logged in successfully', 'success');
        } else {
            showGlobalError(data.detail || (currentLang === 'ar' ? 'بيانات خاطئة!' : 'Invalid credentials!'));
        }
    } catch (error) {
        showGlobalError(currentLang === 'ar' ? 'تعذر الاتصال بالسيرفر لتسجيل الدخول' : 'Server connection failed');
    }
}

// 📝 معالجة إنشاء حساب جديد
async function handleUserSubmit(event) {
    event.preventDefault();
    clearErrors();

    const name = document.getElementById('user-name').value.trim();
    const email = document.getElementById('user-email').value.trim().toLowerCase();
    const phone = document.getElementById('user-phone').value.trim();
    const password = document.getElementById('user-password').value;
    const address = document.getElementById('user-address').value.trim();

    let hasError = false;

    if (!name) { showError('user-name', currentLang === 'ar' ? 'من فضلك أدخل الاسم بالكامل' : 'Please enter full name'); hasError = true; }
    if (!email) { showError('user-email', currentLang === 'ar' ? 'من فضلك أدخل البريد الإلكتروني' : 'Please enter email'); hasError = true; }
    if (!phone) { showError('user-phone', currentLang === 'ar' ? 'من فضلك أدخل رقم الهاتف' : 'Please enter phone number'); hasError = true; }
    if (!password) { 
        showError('user-password', currentLang === 'ar' ? 'من فضلك أدخل كلمة المرور' : 'Please enter password'); 
        hasError = true; 
    } else if (password.length < 8) {
        showError('user-password', currentLang === 'ar' ? 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' : 'Password must be at least 8 characters'); 
        hasError = true;
    }
    if (!address) { showError('user-address', currentLang === 'ar' ? 'من فضلك أدخل العنوان بالتفصيل' : 'Please enter address'); hasError = true; }

    if (hasError) return;

    const userData = { name, email, phone, password, address };

    try {
        const response = await fetch(`${API_URL}/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(userData)
        });

        const data = await response.json();

        if (!response.ok) {
            const detail = data.detail ? data.detail.toLowerCase() : '';
            if (detail.includes('email') || detail.includes('البريد')) {
                showError('user-email', currentLang === 'ar' ? 'البريد الإلكتروني مستخدم بالفعل!' : 'Email already in use!');
            } else if (detail.includes('phone') || detail.includes('الهاتف')) {
                showError('user-phone', currentLang === 'ar' ? 'رقم الهاتف مستخدم بالفعل!' : 'Phone number already in use!');
            } else {
                showGlobalError(data.detail || (currentLang === 'ar' ? 'تعذر إنشاء الحساب' : 'Failed to create account'));
            }
            return;
        }

        if (!saveCustomerSession(data)) throw new Error('The server did not return an authenticated customer session.');
        const savedUser = readCurrentUser();
        // A newly registered account starts with an empty cart. Guest items
        // remain in the guest cart and are never copied into this account.
        activateCartForUser(savedUser, { reset: true });

        checkCurrentUser();
        closeUserModal();
        switchTab('profile');
        showToast(currentLang === 'ar' ? 'تم إنشاء الحساب بنجاح' : 'Account created successfully', 'success');

    } catch (error) {
        showGlobalError(currentLang === 'ar' ? 'تعذر الاتصال بالسيرفر!' : 'Server connection failed!');
    }
}

function handleAuthClick() {
    if (localStorage.getItem('currentUser')) switchTab('profile');
    else openUserModal();
}

// 👤 تحديث بيانات المستخدم في واجهة المكتب والموبايل
function checkCurrentUser() {
    const savedUser = localStorage.getItem('currentUser');
    const activeUser = readCurrentUser();
    if (activeCartStorageKey !== cartStorageKeyForUser(activeUser)) activateCartForUser(activeUser);
    const logoutBtn = document.getElementById('logout-btn');
    const userLabel = document.getElementById('user-btn-label');
    const mobileUserCard = document.getElementById('mobile-user-card');

    if (savedUser) {
        const user = JSON.parse(savedUser);
        if (userLabel) userLabel.innerText = `${currentLang === 'ar' ? 'أهلاً،' : 'Welcome,'} ${user.name}`;
        if (logoutBtn) logoutBtn.classList.remove('hidden');

        const profName = document.getElementById('profile-name-display');
        const profEmail = document.getElementById('profile-email-display');
        const profPhone = document.getElementById('profile-phone-display');
        if (profName) profName.innerText = user.name;
        if (profEmail) profEmail.innerText = user.email || '';
        if (profPhone) profPhone.innerText = user.phone || '';

        if (mobileUserCard) {
            mobileUserCard.innerHTML = `
                <div class="flex items-center gap-3">
                    <div class="w-9 h-9 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 font-black flex items-center justify-center text-sm">
                        <i class="fa-solid fa-user-astronaut"></i>
                    </div>
                    <div>
                        <p class="text-xs font-bold text-slate-100">${user.name}</p>
                        <p class="text-[10px] text-cyan-400">${user.email || user.phone || ''}</p>
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <button onclick="mobileNavigate('profile')" class="bg-slate-900 border border-cyan-500/30 text-cyan-400 hover:bg-cyan-500 hover:text-slate-950 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition">
                        ${currentLang === 'ar' ? 'حسابي' : 'My Profile'}
                    </button>
                    <button onclick="logoutUser()" class="bg-rose-500/10 text-rose-400 border border-rose-500/30 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition">
                        <i class="fa-solid fa-right-from-bracket"></i>
                    </button>
                </div>
            `;
        }
    } else {
        if (userLabel) userLabel.innerText = translations[currentLang].account_btn;
        if (logoutBtn) logoutBtn.classList.add('hidden');

        if (mobileUserCard) {
            mobileUserCard.innerHTML = `
                <span class="text-xs text-slate-400 font-semibold">${currentLang === 'ar' ? 'زائر - غير مسجل' : 'Guest'}</span>
                <button onclick="openUserModal(); toggleMobileMenu();" class="bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-extrabold text-xs px-3.5 py-1.5 rounded-xl transition shadow-md">
                    ${currentLang === 'ar' ? 'تسجيل الدخول / حساب جديد' : 'Login / Register'}
                </button>
            `;
        }
    }
}

async function loadCustomerOrders() {
    const profile = document.getElementById('tab-content-profile');
    if (!profile) return;
    let container = document.getElementById('profile-orders');
    if (!container) {
        const placeholder = profile.querySelector('[data-key="prof_no_orders"]');
        if (!placeholder) return;
        container = document.createElement('div');
        container.id = 'profile-orders';
        container.className = 'text-xs text-slate-400 space-y-3';
        placeholder.replaceWith(container);
    }
    const user = JSON.parse(localStorage.getItem('currentUser') || 'null');
    if (!user?.id) {
        container.textContent = translations[currentLang].prof_no_orders;
        return;
    }
    container.textContent = translations[currentLang].orders_loading;
    try {
        const response = await fetch(`${API_URL}/users/${user.id}/orders`, { headers: customerHeaders(false) });
        if (!response.ok) throw new Error('Could not load orders');
        const orders = await response.json();
        if (!orders.length) {
            container.textContent = translations[currentLang].prof_no_orders;
            return;
        }
        container.innerHTML = orders.map(order => {
            const statusKey = `order_status_${order.status}`;
            const statusText = translations[currentLang][statusKey] || escapeOrderText(order.status);
            const dateText = order.created_at ? new Date(order.created_at).toLocaleString(currentLang === 'ar' ? 'ar-EG' : 'en-GB') : '';
            const itemText = order.items.map(item => `${escapeOrderText(item.product_name)}${item.variant ? ` (${escapeOrderText(item.variant)})` : ''} × ${item.quantity} · ${Number(item.unit_price).toLocaleString(currentLang === 'ar' ? 'ar-EG' : 'en-GB')} ${translations[currentLang].currency}`).join('، ');
            return `<div class="bg-slate-900 border border-slate-800 rounded-xl p-3 space-y-1"><div class="flex items-center justify-between gap-2"><strong class="text-slate-100">${translations[currentLang].order_number} #${order.id}</strong><span class="text-cyan-400">${statusText}</span></div><p>${itemText}</p>${order.status === 'cancelled' && Number(order.cancellation_fee) > 0 ? `<p class="text-amber-300 text-[10px]">${currentLang === 'ar' ? 'رسوم التوصيل المستحقة بسبب الإلغاء' : 'Cancellation delivery fee'}: ${Number(order.cancellation_fee).toLocaleString()} ${translations[currentLang].currency} · ${order.cancellation_fee_status === 'paid' ? (currentLang === 'ar' ? 'مدفوعة' : 'Paid') : (currentLang === 'ar' ? 'مستحقة' : 'Due')}</p>` : ''}<div class="flex justify-between gap-2 text-[10px]"><span>${dateText}</span><strong>${Number(order.total_price).toLocaleString()} ${translations[currentLang].currency}</strong></div></div>`;
        }).join('');
    } catch (error) {
        container.textContent = translations[currentLang].orders_load_error;
    }
}

function openUserModal() { clearErrors(); const modal = document.getElementById('user-modal'); if (modal) modal.classList.remove('hidden'); }
function closeUserModal() { clearErrors(); const modal = document.getElementById('user-modal'); if (modal) modal.classList.add('hidden'); }

function logoutUser() {
    fetch(`${API_URL}/users/logout`, { method: 'POST', headers: customerHeaders(false), keepalive: true }).catch(() => {});
    clearCustomerSession();
    closeCart();
    activateCartForUser(null, { clearVisible: true });
    resetChatSession();

    const chatContainer = document.getElementById('chat-messages');
    if (chatContainer) {
        chatContainer.innerHTML = '';
    }

    checkCurrentUser();
    if (typeof fetchUserChatMessages === 'function') {
        fetchUserChatMessages();
    }

    switchTab('landing');
    showToast(currentLang === 'ar' ? 'تم تسجيل الخروج' : 'Logged out', 'info');
}

window.addEventListener('storage', event => {
    if (event.key !== 'currentUser') return;
    closeCart();
    activateCartForUser(readCurrentUser());
    checkCurrentUser();
    if (readCurrentUser()) loadCustomerOrders();
});

const translations = {
    ar: {
        cart_title: "سلة التسوق",
        cart_add_button: "إضافة إلى السلة",
        product_quantity: "الكمية المطلوبة:",
        cart_total: "الإجمالي",
        checkout_recipient: "اسم المستلم",
        checkout_phone: "رقم الهاتف",
        checkout_address: "العنوان بالتفصيل",
        checkout_area: "المحافظة",
        checkout_area_unavailable: "التوصيل غير معد للطلب حاليًا",
        checkout_choose_area: "اختر المحافظة",
        checkout_choose_governorate: "اختر المحافظة",
        checkout_fee_unconfigured: "رسوم التوصيل غير مضبوطة لهذه المحافظة",
        checkout_total_unavailable: "يُحدد بعد ضبط رسوم التوصيل",
        checkout_shipping: "رسوم التوصيل",
        checkout_grand_total: "الإجمالي شامل التوصيل",
        checkout_delivery_method: "طريقة الاستلام",
        checkout_home_delivery: "توصيل للعنوان",
        checkout_store_pickup: "استلام من الفرع",
        checkout_online_payment: "الدفع الإلكتروني",
        checkout_payment_description: "اختر وسيلة الدفع المناسبة لك",
        checkout_wallets: "المحافظ الإلكترونية",
        checkout_payment_placeholder: "ستختار البطاقة أو المحفظة بأمان داخل صفحة Paymob.",
        checkout_continue_payment: "متابعة إلى Paymob",
        checkout_payment_unavailable: "الدفع الإلكتروني غير مفعّل حاليًا. لم يتم إنشاء طلب أو تنفيذ أي عملية دفع.",
        checkout_pickup_cash_note: "يتم الدفع نقداً عند استلام الطلب من الفرع.",
        checkout_payment_method: "طريقة الدفع",
        checkout_cash_on_delivery: "الدفع عند الاستلام",
        checkout_recipient_required: "أدخل اسم المستلم.",
        checkout_phone_required: "أدخل رقم هاتف صحيحًا (5 أرقام على الأقل).",
        checkout_address_required: "أدخل العنوان بالتفصيل للتوصيل للمنزل.",
        checkout_payment_required: "اختر طريقة الدفع.",
        checkout_manual_payment: "تأكيد الدفع يدويًا مع المتجر",
        checkout_options_unavailable: "تعذر تحميل خيارات الطلب",
        checkout_required: "أدخل اسم المستلم ورقم الهاتف واختر المحافظة. أدخل العنوان عند التوصيل للمنزل.",
        cart_checkout: "تأكيد الطلب",
        cart_submitting: "جارٍ إرسال الطلب...",
        cart_order_failed: "تعذر إنشاء الطلب. حاول مرة أخرى.",
        cart_empty: "سلة التسوق فارغة.",
        cart_unavailable: "هذا المنتج لم يعد متاحًا.",
        cart_remove: "إزالة",
        cart_variant: "النسخة",
        cart_select_variant: "\u0647\u0630\u0627 \u0627\u0644\u062e\u064a\u0627\u0631 \u063a\u064a\u0631 \u0645\u062a\u0627\u062d \u0623\u0648 \u0644\u0645 \u064a\u0643\u062a\u0645\u0644 \u0625\u0639\u062f\u0627\u062f \u0633\u0639\u0631\u0647. \u0627\u062e\u062a\u0631 \u062e\u064a\u0627\u0631\u0627\u064b \u0645\u062a\u0627\u062d\u0627\u064b \u0623\u0648 \u062a\u0648\u0627\u0635\u0644 \u0645\u0639 \u0627\u0644\u0645\u062a\u062c\u0631.",
        cart_price_changed: "تغير سعر منتج في سلتك. راجع السعر الحالي قبل المتابعة.",
        cart_accept_price: "استخدام الأسعار الحالية",
        cart_out_of_stock: "هذا المنتج غير متوفر حاليًا.",
        cart_stock_changed: "الكمية المطلوبة تتجاوز المخزون الحالي:",
        cart_stock_conflict: "تغير المخزون قبل تأكيد الطلب. راجع الكمية المتاحة وحاول مرة أخرى.",
        cart_stock_limit: "الكمية المتاحة لهذا المنتج هي {stock}.",
        cart_added: "تمت إضافة المنتج إلى السلة.",
        order_pickup_success: "تم تسجيل الطلب #{id}. يُرجى الدفع نقداً عند استلامه من الفرع.",
        cart_order_success: "تم تسجيل الطلب رقم #{id}. سيحصّل مندوب التوصيل قيمة المنتجات ورسوم التوصيل عند التسليم.",
        order_number: "طلب",
        order_items: "منتج",
        order_status_pending: "بانتظار التأكيد",
        order_status_confirmed: "تم التأكيد",
        order_status_processing: "قيد التجهيز",
        order_status_completed: "مكتمل",
        order_status_cancelled: "ملغي",
        cart_cod_note: "الدفع نقداً عند الاستلام. سيحصّل مندوب التوصيل قيمة المنتجات ورسوم التوصيل معاً. عند إلغاء الطلب تُستحق رسوم التوصيل على العميل.",
        modified_game_checkout_blocked: "هذه اللعبة المعدّلة تتطلب التنسيق عبر واتساب أو زيارة الفرع لإحضار الجهاز وتركيبها.",
        modified_game_contact_button: "\u0646\u0633\u0651\u0642 \u062a\u0631\u0643\u064a\u0628 \u0627\u0644\u0644\u0639\u0628\u0629 \u0628\u0627\u0644\u0641\u0631\u0639 \u0639\u0628\u0631 \u0648\u0627\u062a\u0633\u0627\u0628",
        orders_loading: "جارٍ تحميل الطلبات...",
        orders_load_error: "تعذر تحميل الطلبات الآن.",
        lbl_password: "كلمة المرور",
        lbl_password_hint: "كلمة المرور يجب أن تكون 8 أحرف على الأقل",
        in_stock: "متوفر",
        out_of_stock: "نفدت الكمية",
        tagline: "بيع، شراء، صيانة، وألعاب البلايستيشن",
        nav_home: "الرئيسية",
        nav_store: "المتجر",
        nav_games: "مكتبة الألعاب",
        nav_maintenance: "الصيانة",
        nav_trade: "الاستبدال والبيع",
        account_btn: "تسجيل الدخول / حسابي",
        hero_sub: "THE NEXT GENERATION OF PLAY",
        hero_main_title: "اللعب بيبدأ من هنا",
        btn_shop: "تسوق أجهزة واكسسوارات PS5",
        btn_maint: "احجز صيانة لجهازك",
        feat_warranty_title: "ضمان معتمد",
        feat_warranty_desc: "ضمان على جميع الأجهزة والصيانة",
        feat_delivery_title: "توصيل سريع",
        feat_delivery_desc: "شحن لجميع المناطق بالإسكندرية",
        feat_trade_title: "استبدال فورى",
        feat_trade_desc: "بدل ذراعك أو جهازك القديم بأحدث فئة",
        feat_support_title: "دعم متواصل",
        feat_support_desc: "فريق فني جاهز للاستفسارات",
        store_title: "متجر الأجهزة والاكسسوارات",
        store_subtitle: "أجهزة بلايستيشن الأصلية، ذراعات التحكم، واكسسوارات الألعاب المعززة",
        offers_title: "عروض مميزة",
        offers_subtitle: "منتجات مختارة تحمل شارة Save أو Offer",
        modified_games_title: "ألعاب الأجهزة المعدّلة",
        modified_games_subtitle: "ألعاب يحددها المتجر للأجهزة المعدّلة",
        badge_new: "جديد",
        badge_discount: "خصم",
        btn_buy_now: "عرض التفاصيل",
        btn_order_game: "عرض التفاصيل",
        currency: "ج.م",
        games_title: "مكتبة الألعاب والاشتراكات",
        games_subtitle: "أحدث ألعاب PS5 & PS4 بالأقراص الأصلية أو الحسابات الرقمية",
        maint_main_title: "مركز صيانة البلايستيشن والذراعات",
        maint_sub_title: "صيانة فورية بأحدث المعدات وقطع غيار أصلية 100%",
        maint_services_heading: "خدماتنا الشائعة",
        maint_s1: "تنظيف جهاز PS5 وتغيير السائل الحراري (Liquid Metal)",
        maint_s2: "إصلاح مشكلة انحراف الانالوج (Stick Drift)",
        maint_s3: "تغيير مدخل HDMI المكسور للجهاز",
        maint_s4: "إصلاح أزرار الذراع وتغيير البطاريات الأصلية",
        maint_form_heading: "طلب حجز صيانة جهاز/ذراع",
        maint_device_lbl: "نوع الجهاز / الذراع",
        maint_device_select: "اختر نوع الجهاز",
        maint_phone_lbl: "رقم الهاتف للتواصل",
        maint_desc_lbl: "وصف المشكلة بالتفصيل",
        maint_desc_ph: "مثال: الجهاز بيسخن وبيفصل بعد نص ساعة، أو الانالوج الشمال بيتحرك لوحده",
        maint_submit_btn: "إرسال طلب الصيانة",
        trade_main_title: "بيع أو استبدال جهازك القديم",
        trade_sub_title: "قيم جهازك/ذراعك المستعمل وخذ الفرق فوراً",
        trade_form_heading: "نموذج تقييم الاستبدال أو البيع",
        trade_item_lbl: "ما الذي ترغب في بيعه أو استبداله؟",
        trade_item_ph: "مثال: PS4 Pro 1TB مع ذراعين",
        trade_cond_lbl: "حالة الجهاز والمشتملات",
        trade_cond_ph: "اذكر إن كان مع العلبة، الأوراق، أو به أي خدوش بسيطة",
        trade_submit_btn: "طلب التقييم المبدئي",
        prof_recent_orders: "طلبياتك الأخيرة",
        prof_no_orders: "لا توجد طلبات شراء حالية",
        prof_maint_devices: "أجهزة في الصيانة",
        prof_no_maint: "لا توجد أجهزة قيد الصيانة الآن",
        modal_login_tab: "تسجيل الدخول",
        modal_register_tab: "حساب جديد",
        lbl_login_id: "البريد الإلكتروني أو الهاتف",
        ph_login_id: "ادخل الإيميل أو رقم الهاتف",
        btn_login_submit: "دخول",
        lbl_full_name: "الاسم بالكامل",
        ph_full_name: "أحمد محمد",
        lbl_email: "البريد الإلكتروني",
        lbl_phone: "رقم الهاتف",
        lbl_address: "العنوان",
        ph_address: "الإسكندرية - سموحة",
        btn_register_submit: "إنشاء حساب جديد"
    },
    en: {
        cart_title: "Shopping Cart",
        cart_add_button: "Add to Cart",
        product_quantity: "Quantity:",
        cart_total: "Total",
        checkout_recipient: "Recipient name",
        checkout_phone: "Phone number",
        checkout_address: "Full delivery address",
        checkout_area: "Governorate",
        checkout_area_unavailable: "Delivery is not configured for checkout",
        checkout_choose_area: "Choose a governorate",
        checkout_choose_governorate: "Choose a governorate",
        checkout_fee_unconfigured: "Delivery fee is not configured for this governorate",
        checkout_total_unavailable: "Available after the delivery fee is configured",
        checkout_shipping: "Delivery fee",
        checkout_grand_total: "Total including delivery",
        checkout_delivery_method: "Fulfillment method",
        checkout_home_delivery: "Home delivery",
        checkout_store_pickup: "Pick up from store",
        checkout_online_payment: "Online Payment",
        checkout_payment_description: "Choose your preferred payment method",
        checkout_wallets: "E-wallets",
        checkout_payment_placeholder: "Choose card or wallet securely on Paymob's hosted checkout.",
        checkout_continue_payment: "Continue to Paymob",
        checkout_payment_unavailable: "Online payment is not enabled yet. No order was created and no payment was processed.",
        checkout_pickup_cash_note: "Pay cash when you pick up your order from the branch.",
        checkout_payment_method: "Payment method",
        checkout_cash_on_delivery: "Cash on delivery",
        checkout_recipient_required: "Enter the recipient name.",
        checkout_phone_required: "Enter a valid phone number (at least 5 characters).",
        checkout_address_required: "Enter the full address for home delivery.",
        checkout_payment_required: "Choose a payment method.",
        checkout_manual_payment: "Manual payment confirmation with the store",
        checkout_options_unavailable: "Could not load checkout options",
        checkout_required: "Enter the recipient name and phone, then choose a governorate. Enter an address for home delivery.",
        cart_cod_note: "Pay cash on delivery. The courier collects both the product price and delivery fee. If the order is cancelled, the customer is responsible for the delivery fee.",
        modified_game_checkout_blocked: "Modified-console games must be arranged through WhatsApp or a branch visit so you can bring your device for installation.",
        modified_game_contact_button: "Arrange branch installation on WhatsApp",
        cart_checkout: "Place Order",
        cart_submitting: "Submitting order...",
        cart_order_failed: "Could not create the order. Please try again.",
        cart_empty: "Your cart is empty.",
        cart_unavailable: "This product is no longer available.",
        cart_remove: "Remove",
        cart_variant: "Version",
        cart_select_variant: "This option is unavailable or has no configured price. Select an available option or contact the store.",
        cart_price_changed: "A product price changed in your cart. Review the current price before continuing.",
        cart_accept_price: "Accept current prices",
        cart_out_of_stock: "This product is currently out of stock.",
        cart_stock_changed: "Requested quantity exceeds current stock:",
        cart_stock_conflict: "Stock changed before checkout. Review the available quantity and try again.",
        cart_stock_limit: "Only {stock} units are currently available.",
        cart_added: "Product added to your cart.",
        order_pickup_success: "Order #{id} was placed. Please pay cash when collecting it from the branch.",
        cart_order_success: "Order #{id} was placed. The courier will collect the product and delivery charges on delivery.",
        order_number: "Order",
        order_items: "items",
        order_status_pending: "Awaiting confirmation",
        order_status_confirmed: "Confirmed",
        order_status_processing: "Processing",
        order_status_completed: "Completed",
        order_status_cancelled: "Cancelled",
        orders_loading: "Loading orders...",
        orders_load_error: "Orders could not be loaded right now.",
        lbl_password: "Password",
        lbl_password_hint: "Password must be at least 8 characters",
        in_stock: "In Stock",
        out_of_stock: "Out of Stock",
        tagline: "PlayStation Sales, Trade, Repair & Games",
        nav_home: "Home",
        nav_store: "Store",
        nav_games: "Games Library",
        nav_maintenance: "Maintenance",
        nav_trade: "Trade & Sell",
        account_btn: "Login / My Account",
        hero_sub: "THE NEXT GENERATION OF PLAY",
        hero_main_title: "Game Starts Here",
        btn_shop: "Shop PS5 Consoles & Gear",
        btn_maint: "Book a Repair",
        feat_warranty_title: "Certified Warranty",
        feat_warranty_desc: "Warranty on all devices & repairs",
        feat_delivery_title: "Fast Delivery",
        feat_delivery_desc: "Express shipping across Alexandria",
        feat_trade_title: "Instant Trade-In",
        feat_trade_desc: "Trade old gear for latest generation",
        feat_support_title: "24/7 Support",
        feat_support_desc: "Technical team ready for inquiries",
        store_title: "Consoles & Accessories Store",
        store_subtitle: "Original PlayStation consoles, controllers & gaming accessories",
        offers_title: "Featured Offers",
        offers_subtitle: "Selected products marked Save or Offer",
        modified_games_title: "Modified-Console Games",
        modified_games_subtitle: "Games selected by the store for modified consoles",
        badge_new: "NEW",
        badge_discount: "SALE",
        btn_buy_now: "View Details",
        btn_order_game: "View Details",
        currency: "EGP",
        games_title: "Games Library & Subscriptions",
        games_subtitle: "Latest PS5 & PS4 physical discs or digital accounts",
        maint_main_title: "PlayStation & Controller Repair Center",
        maint_sub_title: "Instant repairs with 100% original spare parts",
        maint_services_heading: "Popular Services",
        maint_s1: "PS5 Cleaning & Liquid Metal Replacement",
        maint_s2: "Analog Stick Drift Repair",
        maint_s3: "HDMI Port Replacement",
        maint_s4: "Button Repair & Original Battery Replacement",
        maint_form_heading: "Book a Repair Service",
        maint_device_lbl: "Device / Controller Type",
        maint_device_select: "Select Device Type",
        maint_phone_lbl: "Contact Phone Number",
        maint_desc_lbl: "Detailed Problem Description",
        maint_desc_ph: "e.g., PS5 overheats after 30 mins or left analog drifts",
        maint_submit_btn: "Submit Repair Request",
        trade_main_title: "Sell or Trade Your Used Console",
        trade_sub_title: "Get your device valued and pay/receive the difference",
        trade_form_heading: "Trade-In Valuation Form",
        trade_item_lbl: "What do you want to sell or trade?",
        trade_item_ph: "e.g., PS4 Pro 1TB with 2 controllers",
        trade_cond_lbl: "Device Condition & Accessories",
        trade_cond_ph: "Mention box, cables, condition or scratches",
        trade_submit_btn: "Request Initial Evaluation",
        prof_recent_orders: "Recent Orders",
        prof_no_orders: "No current purchase orders",
        prof_maint_devices: "Devices in Repair",
        prof_no_maint: "No devices currently in maintenance",
        modal_login_tab: "Login",
        modal_register_tab: "New Account",
        lbl_login_id: "Email or Phone Number",
        ph_login_id: "Enter email or phone number",
        btn_login_submit: "Sign In",
        lbl_full_name: "Full Name",
        ph_full_name: "John Doe",
        lbl_email: "Email Address",
        lbl_phone: "Phone Number",
        lbl_address: "Address",
        ph_address: "Alexandria, Smouha",
        btn_register_submit: "Create Account"
    }
};

function applyLanguageUI() {
    document.documentElement.setAttribute('dir', currentLang === 'ar' ? 'rtl' : 'ltr');
    const langLabel = document.getElementById('lang-label');
    if (langLabel) langLabel.innerText = currentLang === 'ar' ? 'EN' : 'عربي';

    document.querySelectorAll('[data-key]').forEach(elem => {
        const key = elem.getAttribute('data-key');
        if (translations[currentLang] && translations[currentLang][key]) {
            elem.innerText = translations[currentLang][key];
        }
    });

    document.querySelectorAll('[data-ph-key]').forEach(elem => {
        const key = elem.getAttribute('data-ph-key');
        if (translations[currentLang] && translations[currentLang][key]) {
            elem.setAttribute('placeholder', translations[currentLang][key]);
        }
    });

    const addToCartLabel = document.querySelector('#add-to-cart-btn span');
    if (addToCartLabel) addToCartLabel.textContent = translations[currentLang].cart_add_button;
    const quantityLabel = document.getElementById('product-page-qty')?.closest('.mb-6')?.querySelector('label');
    if (quantityLabel) quantityLabel.textContent = translations[currentLang].product_quantity;

    document.querySelectorAll('button[onclick*="togglePasswordVisibility"]').forEach(btn => {
        const inputField = btn.parentElement.querySelector('input');
        if (currentLang === 'en') {
            btn.classList.remove('left-3');
            btn.classList.add('right-3');
            if (inputField) {
                inputField.classList.remove('pl-10');
                inputField.classList.add('pr-10');
            }
        } else {
            btn.classList.remove('right-3');
            btn.classList.add('left-3');
            if (inputField) {
                inputField.classList.remove('pr-10');
                inputField.classList.add('pl-10');
            }
        }
    });

    filterStoreProducts();
    filterGameProducts();
    renderHeroBanners(homepageBanners);
    syncLandingSliderControls();
    checkCurrentUser();
    updateCartBadge();
    updateCheckoutFulfillment();
    if (deliveryOptions.length || paymentOptions.length) loadDeliveryOptions();
    if (!document.getElementById('tab-content-profile')?.classList.contains('hidden') && localStorage.getItem('currentUser')) {
        loadCustomerOrders();
    }
}

function toggleLanguage() {
    currentLang = currentLang === 'ar' ? 'en' : 'ar';
    localStorage.setItem('preferredLang', currentLang);
    applyLanguageUI();
}

function openProductDetails(productOrId, category) {
    if (!productOrId) return;

    let productId = productOrId;

    if (typeof productOrId === 'object') {
        if (productOrId.is_active === false) return;
        window.currentSelectedProduct = productOrId;
        currentProduct = productOrId;
        productId = productOrId.id;
    } else {
        const product = findProductById(productOrId);
        if (!product) return;
        window.currentSelectedProduct = product;
        currentProduct = product;
    }

    const targetHash = `product/${productId}`;
    if (window.location.hash === `#${targetHash}`) {
        handleRouting();
    } else {
        window.location.hash = targetHash;
    }
}
// 📦 تحميل أجهزة المتجر
async function loadStoreProducts() {
    const productsGrid = document.getElementById('products-grid');
    if (!productsGrid) return;

    try {
        const response = await fetch(`${API_URL}/products`);
        if (!response.ok) throw new Error(`Failed to load products: ${response.status}`);

        const allProducts = await response.json();
        allStoreProductsCache = allProducts.filter(p => p.category !== 'Games' && p.is_active !== false);
        window.products = allProducts;
        renderStoreProducts(allStoreProductsCache);
        renderLandingProductSections(allProducts);
        renderCart();
        
        handleRouting();
    } catch (error) {
        console.error('Error loading products:', error);
        productsGrid.innerHTML = `<div class="col-span-full text-center py-12 text-red-400">${currentLang === 'ar' ? 'تعذر تحميل المنتجات.' : 'Failed to load products.'}</div>`;
    }
}

function renderStoreProducts(productsList, containerId = 'products-grid') {
    const productsGrid = document.getElementById(containerId);
    if (!productsGrid) return;

    if (!Array.isArray(productsList) || productsList.length === 0) {
        productsGrid.innerHTML = containerId === 'products-grid' ? `<div class="col-span-full text-center py-12 text-slate-500">${currentLang === 'ar' ? 'لا توجد منتجات مطابقة للبحث.' : 'No products match your search.'}</div>` : '';
        return;
    }

    const buyBtnText = translations[currentLang].btn_buy_now;
    const currencyText = translations[currentLang].currency;
    const inStockText = translations[currentLang].in_stock || "متوفر";
    const outOfStockText = translations[currentLang].out_of_stock || "نفدت الكمية";

    productsGrid.innerHTML = productsList.map(product => {
        const image = resolveProductImageUrl(product.image_url || product.image);
        const name = product.name || 'منتج';
        const description = product.description || '';
        const hasOptions = Boolean(product.requires_variants || product.variants?.length);
        const price = hasOptions ? (currentLang === 'ar' ? '\u0627\u062e\u062a\u0631 \u062e\u064a\u0627\u0631\u0627\u064b' : 'Select options') : `${Number(product.price ?? 0).toLocaleString()} ${currencyText}`;
        const stock = product.stock ?? 0;
        const isAvailable = stock > 0;

        const offerBadge = isOfferBadge(product.badge);
        const badgeTag = product.badge ? `<span class="absolute top-2 left-2 ${offerBadge ? 'bg-red-600' : 'bg-blue-600'} text-white font-black text-[10px] px-2 py-0.5 rounded-full z-10">${escapeOrderText(product.badge)}</span>` : '';

        const stockBadge = isAvailable
            ? `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-extrabold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                 <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                 ${inStockText}
               </span>`
            : `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-extrabold bg-rose-500/10 text-rose-400 border border-rose-500/30">
                 <span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
                 ${outOfStockText}
               </span>`;

        const actionBtn = isAvailable
            ? `<button type="button" onclick="openProductDetails(${product.id},'store')" class="bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold px-3.5 py-1.5 rounded-lg text-xs transition shadow-md">${buyBtnText}</button>`
            : `<button type="button" disabled class="bg-slate-800 text-slate-500 font-bold px-3 py-1.5 rounded-lg text-xs cursor-not-allowed border border-slate-700/50">${outOfStockText}</button>`;

        return `
            <div class="glass-card ${containerId === 'products-grid' ? '' : 'landing-product-card'} rounded-2xl p-4 flex flex-col justify-between hover:border-cyan-500/40 transition group cursor-pointer" onclick="openProductDetails(${product.id},'store')">
                <div>
                    <div class="h-48 rounded-xl bg-slate-950 flex items-center justify-center p-4 relative overflow-hidden">
                        ${badgeTag}
                        <img src="${image}" alt="${name}" class="max-h-full object-contain group-hover:scale-105 transition duration-300" onerror="handleProductImageError(this)">
                    </div>
                    <div class="flex items-center justify-between gap-2 mt-4">
                        <h3 class="font-extrabold text-slate-100 text-sm truncate">${name}</h3>
                        ${stockBadge}
                    </div>
                    <p class="text-xs text-slate-400 mt-1 line-clamp-2">${description}</p>
                </div>
                <div class="flex items-center justify-between mt-5 pt-3 border-t border-slate-800/80" onclick="event.stopPropagation()">
                    <span class="font-black text-cyan-400 text-sm">${price}</span>
                    ${actionBtn}
                </div>
            </div>
        `;
    }).join('');
}

function filterStoreProducts() {
    const query = document.getElementById('store-search-input')?.value.trim().toLowerCase() || '';
    
    const filtered = allStoreProductsCache.filter(p => 
        (p.name || '').toLowerCase().includes(query) || 
        (p.description || '').toLowerCase().includes(query)
    );
    renderStoreProducts(filtered);
}

// 🎮 تحميل ألعاب المكتبة
async function loadGameProducts() {
    const gamesGrid = document.getElementById('games-grid');
    if (!gamesGrid) return;

    try {
        const response = await fetch(`${API_URL}/products`);
        if (!response.ok) throw new Error(`Failed to load games: ${response.status}`);

        const allProducts = await response.json();
        allGameProductsCache = allProducts.filter(p => p.category === 'Games' && p.is_active !== false);
        window.products = allProducts;
        window.gameProducts = allGameProductsCache;
        renderGameProducts(allGameProductsCache);
        renderLandingProductSections(allProducts);
        renderCart();

        handleRouting();
    } catch (error) {
        console.error('Error loading games:', error);
        gamesGrid.innerHTML = `<div class="col-span-full text-center py-12 text-red-400">${currentLang === 'ar' ? 'تعذر تحميل ألعاب المكتبة.' : 'Failed to load games library.'}</div>`;
    }
}

function renderGameProducts(gamesList, containerId = 'games-grid') {
    const gamesGrid = document.getElementById(containerId);
    if (!gamesGrid) return;

    if (!Array.isArray(gamesList) || gamesList.length === 0) {
        gamesGrid.innerHTML = containerId === 'games-grid' ? `<div class="col-span-full text-center py-12 text-slate-500">${currentLang === 'ar' ? 'لا توجد ألعاب مطابقة للبحث.' : 'No games match your search.'}</div>` : '';
        return;
    }

    const orderBtnText = translations[currentLang].btn_order_game;
    const currencyText = translations[currentLang].currency;
    const inStockText = translations[currentLang].in_stock || "متوفر";
    const outOfStockText = translations[currentLang].out_of_stock || "نفدت الكمية";

    gamesGrid.innerHTML = gamesList.map(game => {
        const image = resolveProductImageUrl(game.image_url || game.image);
        const name = game.name || 'لعبة';
        const description = game.description || '';
        const hasOptions = Boolean(game.requires_variants || game.variants?.length);
        const price = hasOptions ? (currentLang === 'ar' ? '\u0627\u062e\u062a\u0631 \u062e\u064a\u0627\u0631\u0627\u064b' : 'Select options') : `${Number(game.price ?? 0).toLocaleString()} ${currencyText}`;
        const stock = game.stock ?? 0;
        const isAvailable = stock > 0;

        const offerBadge = isOfferBadge(game.badge);
        const badgeTag = game.badge ? `<span class="absolute top-2 left-2 ${offerBadge ? 'bg-red-600' : 'bg-blue-600'} text-white font-black text-[10px] px-2 py-0.5 rounded-full z-10">${escapeOrderText(game.badge)}</span>` : '';

        const stockBadge = isAvailable
            ? `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-extrabold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                 <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                 ${inStockText}
               </span>`
            : `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-extrabold bg-rose-500/10 text-rose-400 border border-rose-500/30">
                 <span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
                 ${outOfStockText}
               </span>`;

        const actionBtn = isAvailable
            ? `<button onclick="openProductDetails(${game.id},'games')" class="bg-slate-800 hover:bg-cyan-500 hover:text-slate-950 text-slate-200 font-bold px-3 py-1.5 rounded-lg text-xs transition">${orderBtnText}</button>`
            : `<button disabled class="bg-slate-800 text-slate-500 font-bold px-3 py-1.5 rounded-lg text-xs cursor-not-allowed opacity-60 border border-slate-700/50">${outOfStockText}</button>`;

        return `
            <div class="glass-card ${containerId === 'games-grid' ? '' : 'landing-product-card'} rounded-2xl p-4 flex flex-col justify-between hover:border-cyan-500/40 transition group cursor-pointer" onclick="openProductDetails(${game.id},'games')">
                <div>
                    <div class="h-56 bg-slate-950 rounded-xl flex items-center justify-center p-3 relative overflow-hidden">
                        ${badgeTag}
                        <img src="${image}" alt="${name}" class="max-h-full object-contain group-hover:scale-105 transition duration-300" onerror="handleProductImageError(this)">
                    </div>
                    <div class="flex items-center justify-between gap-2 mt-3">
                        <h3 class="font-extrabold text-slate-100 text-sm truncate">${name}</h3>
                        ${stockBadge}
                    </div>
                    <p class="text-xs text-slate-400 mt-1 line-clamp-2">${description}</p>
                </div>
                <div class="mt-4 pt-3 border-t border-slate-800 flex items-center justify-between" onclick="event.stopPropagation()">
                    <span class="text-cyan-400 font-black text-sm">${price}</span>
                    ${actionBtn}
                </div>
            </div>
        `;
    }).join('');
}

function renderLandingProductSections(products = window.products || []) {
    const activeProducts = (Array.isArray(products) ? products : []).filter(product => product && product.is_active !== false);
    const offers = activeProducts.filter(product => isOfferBadge(product.badge));
    const modifiedGames = activeProducts.filter(product => product.category === 'Games' && product.show_in_modified_games === true);
    const offersSection = document.getElementById('offers-section');
    const modifiedGamesSection = document.getElementById('modified-games-section');
    if (offersSection) offersSection.classList.toggle('hidden', offers.length === 0);
    if (modifiedGamesSection) modifiedGamesSection.classList.toggle('hidden', modifiedGames.length === 0);
    renderStoreProducts(offers, 'offers-products-grid');
    renderGameProducts(modifiedGames, 'modified-games-grid');
    syncLandingSliderControls();
}

function filterGameProducts() {
    const query = document.getElementById('games-search-input')?.value.trim().toLowerCase() || '';
    const filtered = allGameProductsCache.filter(g => 
        (g.name || '').toLowerCase().includes(query) || 
        (g.description || '').toLowerCase().includes(query)
    );
    renderGameProducts(filtered);
}

function toggleMobileMenu() {
    const mobileMenu = document.getElementById('mobile-menu');
    const openIcon = document.getElementById('menu-icon-open');
    const closeIcon = document.getElementById('menu-icon-close');

    if (!mobileMenu) return;

    if (mobileMenu.classList.contains('hidden')) {
        mobileMenu.classList.remove('hidden');
        if (openIcon) openIcon.classList.add('hidden');
        if (closeIcon) closeIcon.classList.remove('hidden');
    } else {
        mobileMenu.classList.add('hidden');
        if (openIcon) openIcon.classList.remove('hidden');
        if (closeIcon) closeIcon.classList.add('hidden');
    }
}

function mobileNavigate(tabName) {
    switchTab(tabName);
    const mobileMenu = document.getElementById('mobile-menu');
    if (mobileMenu && !mobileMenu.classList.contains('hidden')) {
        toggleMobileMenu();
    }
}

// ==========================================
// 💬 LIVE CHAT LOGIC (التحكم بالشات والدعم)
// ==========================================

function getChatSessionId() {
    let sessionId = localStorage.getItem('chat_session_id');
    if (!sessionId) {
        sessionId = 'session_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now();
        localStorage.setItem('chat_session_id', sessionId);
    }
    return sessionId;
}

function getVisitorChatMessages() {
    return [
        { id: 'visitor-address', sender: 'bot', message: '📍 عنوان الفرع: الإسكندرية - سموحة. مواعيد العمل: يوميًا من 1 ظهرًا حتى 11 مساءً.', created_at: '' },
        { id: 'visitor-payments', sender: 'bot', message: '💳 طرق الدفع المتاحة: كاش عند الاستلام داخل الإسكندرية، أو Vodafone Cash و InstaPay.', created_at: '' }
    ];
}

async function fetchUserChatMessages() {
    const currentUser = readCurrentUser();
    const token = localStorage.getItem('customerToken');
    if (!currentUser?.id || !token) {
        const messages = getVisitorChatMessages();
        renderUserMessages(messages);
        updateChatBadge(messages);
        return;
    }

    const sessionId = getChatSessionId();
    try {
        const response = await fetch(`${API_URL}/chat/messages/${encodeURIComponent(sessionId)}?user_id=${encodeURIComponent(currentUser.id)}`, {
            headers: customerHeaders(false)
        });
        if (response.status === 401) {
            renderUserMessages(getVisitorChatMessages());
            updateChatBadge([]);
            return;
        }
        if (!response.ok) return;
        const messages = await response.json();
        if (Array.isArray(messages)) {
            renderUserMessages(messages);
            updateChatBadge(messages);
        }
    } catch (error) {
        console.error('خطأ في جلب المحادثات:', error);
    }
}

function toggleChatWidget() {
    const chatBox = document.getElementById('chat-box');
    const chatBadge = document.getElementById('chat-badge') 
                   || document.querySelector('#chat-toggle-btn span') 
                   || document.querySelector('.chat-badge');

    if (!chatBox) return;

    chatBox.classList.toggle('hidden');

    if (!chatBox.classList.contains('hidden')) {
        if (chatBadge) {
            chatBadge.classList.add('hidden');
            chatBadge.style.display = 'none';
        }

        if (window.latestChatMessageId) {
            localStorage.setItem('last_read_msg_id', window.latestChatMessageId.toString());
        }

        fetchUserChatMessages();
    }
}

function resetChatSession() {
    const newSessionId = 'sess_' + Math.random().toString(36).substring(2, 15) + Date.now();
    localStorage.setItem('chat_session_id', newSessionId);
    return newSessionId;
}

function updateChatBadge(messages) {
    const chatBox = document.getElementById('chat-box') || document.getElementById('chat-container');
    const chatBadge = document.getElementById('chat-badge')
        || document.querySelector('#chat-toggle-btn span')
        || document.querySelector('.chat-badge');

    if (!chatBadge) return;

    const hideBadge = () => {
        chatBadge.classList.add('hidden');
        chatBadge.style.display = 'none';
    };

    const showBadge = () => {
        chatBadge.classList.remove('hidden', 'bg-rose-500', 'bg-red-500', 'bg-emerald-500', 'animate-pulse', 'animate-ping');
        chatBadge.classList.add('bg-cyan-400');
        chatBadge.style.display = 'block';
        chatBadge.style.backgroundColor = 'var(--theme-primary, #22d3ee)';
        chatBadge.style.boxShadow = '0 0 10px var(--theme-primary, rgba(34, 211, 238, 0.8))';
    };

    const isChatOpen = chatBox && !chatBox.classList.contains('hidden');
    const lastReadId = parseInt(localStorage.getItem('last_read_msg_id') || '0');

    if (messages && messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        window.latestChatMessageId = lastMsg.id;

        if (isChatOpen) {
            hideBadge();
            localStorage.setItem('last_read_msg_id', lastMsg.id.toString());
            return;
        }

        if (lastMsg.id > lastReadId && (lastMsg.sender === 'admin' || lastMsg.sender === 'bot')) {
            showBadge();
        } else {
            hideBadge();
        }
    } else {
        hideBadge();
    }
}

function renderUserMessages(messages) {
    const chatContainer = document.getElementById('chat-messages') || 
                          document.querySelector('#chat-box .space-y-3') || 
                          document.querySelector('#chat-box .overflow-y-auto');

    if (!chatContainer) return;

    const currentDataString = JSON.stringify(messages);

    if (currentDataString === lastRenderedChatData) return;
    lastRenderedChatData = currentDataString;
    chatContainer.innerHTML = '';

    messages.forEach(msg => {
        const isUser = msg.sender === 'user';
        const isAdmin = msg.sender === 'admin';

        const msgDiv = document.createElement('div');
        msgDiv.className = `flex ${isUser ? 'justify-end' : 'justify-start'} mb-2`;

        msgDiv.innerHTML = `
            <div class="max-w-[80%] rounded-2xl px-4 py-2 text-sm ${
                isUser 
                    ? 'bg-cyan-500 text-white rounded-br-none' 
                    : isAdmin 
                        ? 'bg-purple-600 text-white font-medium rounded-bl-none shadow-md' 
                        : 'bg-slate-800 text-slate-200 rounded-bl-none'
            }">
                <p class="whitespace-pre-line">${escapeHtml(msg.message || msg.text || '')}</p>
                <span class="text-[10px] opacity-75 block text-left mt-1">${escapeHtml(msg.created_at || '')}</span>
            </div>
        `;
        chatContainer.appendChild(msgDiv);
    });

    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function startSingleChatPolling() {
    if (chatPollInterval) clearInterval(chatPollInterval);
    fetchUserChatMessages();
    chatPollInterval = setInterval(() => {
        fetchUserChatMessages();
    }, 2500);
}

function isQuickBotQuery(text) {
    const lower = text.toLowerCase();
    const botKeywords = ["عنوان", "موقع", "مكان", "فين", "دفع", "طرق الدفع", "فيزا", "كاش", "address", "location", "payment"];
    return botKeywords.some(kw => lower.includes(kw));
}

async function sendQuickChatMessage(messageText) {
    const input = document.getElementById('chat-input');
    if (input) input.value = messageText;
    await processChatMessage(messageText);
}

async function handleChatMessageSubmit(event) {
    event.preventDefault();
    const input = document.getElementById('chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;

    await processChatMessage(text);
    input.value = '';
}

async function processChatMessage(text) {
    const savedUser = readCurrentUser();
    if (!savedUser?.id || !localStorage.getItem('customerToken')) {
        showToast(currentLang === 'ar' ? 'يرجى تسجيل الدخول أو إنشاء حساب لإرسال رسالة.' : 'Please sign in or create an account to send a message.', 'error');
        openUserModal();
        return false;
    }

    try {
        const response = await fetch(`${API_URL}/chat/send`, {
            method: 'POST',
            headers: customerHeaders(),
            body: JSON.stringify({ session_id: getChatSessionId(), message: text })
        });
        if (response.status === 401) {
            showToast(currentLang === 'ar' ? 'انتهت جلسة الدخول. يرجى تسجيل الدخول مرة أخرى.' : 'Your session expired. Please sign in again.', 'error');
            openUserModal();
            return false;
        }
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.detail || 'Failed to send message');
        }
        const input = document.getElementById('chat-input');
        if (input) input.value = '';
        await fetchUserChatMessages();
        return true;
    } catch (error) {
        console.error('Chat error:', error);
        showToast(currentLang === 'ar' ? 'تعذر إرسال الرسالة، حاول لاحقًا.' : 'Failed to send message. Please try again.', 'error');
        return false;
    }
}

// ==========================================
// ⭐ RATING LOGIC (التحكم بنظام التقييمات)
// ==========================================

function openRatingModal(productId = null) {
    const selectedProduct = window.currentSelectedProduct || currentProduct;
    const routeMatch = window.location.hash.match(/^#product\/(\d+)$/);
    const requestedProductId = productId == null ? (routeMatch ? Number(routeMatch[1]) : null) : Number(productId);
    const product = requestedProductId
        ? (selectedProduct?.id === requestedProductId ? selectedProduct : findProductById(requestedProductId))
        : null;
    const targetId = product?.id || null;
    const field = document.getElementById('rating-product-id');
    if (field) field.value = targetId || '';
    const label = document.getElementById('rating-target-label');
    if (label) label.textContent = targetId
        ? (currentLang === 'ar' ? `تقييم المنتج: ${product.name}` : `Review product: ${product.name}`)
        : (currentLang === 'ar' ? 'ما هو تقييمك لخدمتنا؟' : 'How would you rate our service?');
    document.getElementById('rating-modal')?.classList.remove('hidden');
}

function closeRatingModal() {
    document.getElementById('rating-modal')?.classList.add('hidden');
}

function setRatingStars(count) {
    const validCount = Number.isInteger(Number(count)) && Number(count) >= 1 && Number(count) <= 5 ? Number(count) : 5;
    const starsVal = document.getElementById('rating-stars-val');
    if (starsVal) starsVal.value = String(validCount);
    const container = document.getElementById('star-rating-container');
    if (!container) return;
    container.querySelectorAll('i').forEach((star, index) => {
        star.className = index < validCount
            ? 'fa-solid fa-star cursor-pointer hover:scale-110 transition text-amber-400'
            : 'fa-regular fa-star cursor-pointer hover:scale-110 transition text-slate-600';
    });
}

let productRatingsRequestId = 0;
async function renderProductRatings(productId) {
    const container = document.getElementById('product-ratings-list');
    const summary = document.getElementById('product-ratings-summary');
    const distribution = document.getElementById('product-rating-distribution');
    if (!container || !summary || !productId) return;
    const requestId = ++productRatingsRequestId;
    summary.textContent = '';
    if (distribution) distribution.innerHTML = '';
    container.innerHTML = `<div class="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/50 px-4 py-3 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-cyan-400" aria-hidden="true"></i><span>${currentLang === 'ar' ? 'جارٍ تحميل تقييمات هذا المنتج...' : 'Loading reviews for this product...'}</span></div>`;
    try {
        const response = await fetch(`${API_URL}/products/${encodeURIComponent(productId)}/ratings`);
        if (!response.ok) throw new Error(`Review request failed: ${response.status}`);
        const data = await response.json();
        if (requestId !== productRatingsRequestId || String(data.product_id) !== String(productId)) return;
        const reviewRows = Array.isArray(data.ratings) ? data.ratings : [];
        const average = Number(data.average || 0);
        const count = reviewRows.length;
        const safeAverage = Math.max(0, Math.min(5, average));
        summary.innerHTML = `<div class="flex items-center gap-3"><strong class="text-4xl font-black text-slate-100">${safeAverage.toFixed(1)}</strong><div><div class="text-xl tracking-wide text-amber-400" aria-label="${safeAverage.toFixed(1)} / 5">${'★'.repeat(Math.round(safeAverage))}${'☆'.repeat(5 - Math.round(safeAverage))}</div><span class="text-xs text-slate-400">${count} ${currentLang === 'ar' ? 'تقييم' : 'reviews'}</span></div></div>`;
        if (distribution) {
            const counts = [5, 4, 3, 2, 1].map(stars => ({
                stars,
                count: reviewRows.filter(review => Number(review.stars) === stars).length,
            }));
            distribution.innerHTML = counts.map(row => {
                const percent = count ? Math.round(row.count / count * 100) : 0;
                return `<div class="flex items-center gap-2 text-[11px] text-slate-400"><span class="w-8 shrink-0">${row.stars} <span class="text-amber-400">★</span></span><div class="h-2 flex-1 overflow-hidden rounded-full bg-slate-800"><div class="h-full rounded-full bg-amber-400 transition-all" style="width:${percent}%"></div></div><span class="w-14 shrink-0 text-left">${row.count} (${percent}%)</span></div>`;
            }).join('');
        }
        if (!reviewRows.length) {
            container.innerHTML = `<div class="rounded-xl border border-dashed border-slate-700 bg-slate-950/40 px-4 py-5 text-center text-slate-400"><i class="fa-regular fa-comment-dots mb-2 block text-xl text-cyan-400" aria-hidden="true"></i>${currentLang === 'ar' ? 'لا توجد تقييمات لهذا المنتج حتى الآن.' : 'No reviews for this product yet.'}</div>`;
            return;
        }
        container.innerHTML = reviewRows.map(review => `
            <article class="bg-slate-950/70 border border-slate-800 rounded-xl p-4 space-y-2">
                <div class="flex items-center justify-between gap-3">
                    <strong class="text-slate-100">${escapeHtml(review.customer_name)}</strong>
                    <time class="text-[10px] text-slate-500">${escapeHtml(review.created_at || '')}</time>
                </div>
                <div class="text-amber-400" aria-label="${Number(review.stars)} / 5">${'★'.repeat(Number(review.stars))}${'☆'.repeat(5 - Number(review.stars))}</div>
                ${review.comment ? `<p class="text-slate-300 whitespace-pre-line">${escapeHtml(review.comment)}</p>` : ''}
            </article>`).join('');
    } catch (error) {
        if (requestId !== productRatingsRequestId) return;
        summary.innerHTML = `<span class="text-slate-500">${currentLang === 'ar' ? 'تعذر تحميل التقييمات الآن.' : 'Reviews could not be loaded.'}</span>`;
        if (distribution) distribution.innerHTML = '';
        container.innerHTML = `<div class="rounded-xl border border-rose-900/50 bg-rose-950/20 px-4 py-3 text-rose-300">${currentLang === 'ar' ? 'تعذر تحميل تقييمات هذا المنتج. حاول تحديث الصفحة.' : 'Could not load reviews for this product. Try refreshing the page.'}</div>`;
        console.error(error);
    }
}

async function handleRatingSubmit(event) {
    event.preventDefault();
    const savedUser = readCurrentUser();
    if (!savedUser?.id || !localStorage.getItem('customerToken')) {
        closeRatingModal();
        showToast(currentLang === 'ar' ? 'يرجى تسجيل الدخول أولًا لإضافة تقييم.' : 'Please sign in to leave a review.', 'error');
        openUserModal();
        return;
    }

    const stars = Number.parseInt(document.getElementById('rating-stars-val')?.value || '0', 10);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
        showToast(currentLang === 'ar' ? 'اختر تقييمًا من نجمة إلى خمس نجوم.' : 'Choose a rating from 1 to 5 stars.', 'error');
        return;
    }
    const comment = document.getElementById('rating-comment')?.value.trim() || '';
    const productId = Number.parseInt(document.getElementById('rating-product-id')?.value || '', 10);
    const routeMatch = window.location.hash.match(/^#product\/(\d+)$/);
    if (routeMatch && (!Number.isInteger(productId) || productId !== Number(routeMatch[1]))) {
        showToast(currentLang === 'ar' ? 'تعذر تحديد المنتج لهذا التقييم. أغلق النافذة وافتحها من صفحة المنتج.' : 'Could not identify the product for this review. Reopen the form from the product page.', 'error');
        return;
    }
    try {
        const response = await fetch(`${API_URL}/ratings`, {
            method: 'POST',
            headers: customerHeaders(),
            body: JSON.stringify({ product_id: Number.isInteger(productId) ? productId : null, stars, comment })
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.detail || `Review request failed: ${response.status}`);
        }
        showToast(currentLang === 'ar' ? 'شكرًا لك، تم حفظ تقييمك.' : 'Thank you, your review was saved.', 'success');
        closeRatingModal();
        document.getElementById('rating-form')?.reset();
        setRatingStars(5);
        if (Number.isInteger(productId)) await renderProductRatings(productId);
    } catch (error) {
        showToast(currentLang === 'ar' ? 'تعذر إرسال تقييمك. يرجى المحاولة لاحقًا.' : 'Could not submit your review. Please try again.', 'error');
        console.error(error);
    }
}
window.addEventListener('hashchange', () => {
    showGlobalLoader();
    setTimeout(() => {
        hideGlobalLoader();
    }, 300);
});
// 🚀 التهيئة المباشرة عند اكتمال تحميل عناصر الصفحة
document.addEventListener('DOMContentLoaded', () => {
    if (!localStorage.getItem('chat_session_id')) {
        resetChatSession();
    }
    checkCurrentUser();
    loadStoreProducts();
    loadGameProducts();
    loadHomepageBanners();
    initHeroSliderControls();
    initLandingSliderControls();
    updateHeroSlider();
    startHeroAutoAdvance();
    startSingleChatPolling();
    applyLanguageUI();
    handleRouting();

    document.addEventListener('click', (e) => {
        const pageBtn = e.target.closest('[data-page], [data-tab]');
        if (pageBtn) {
            const targetPage = pageBtn.getAttribute('data-page') || pageBtn.getAttribute('data-tab');
            if (targetPage) {
                e.preventDefault();
                switchTab(targetPage);
            }
        }
    });

    const storeSearch = document.getElementById('store-search-input');
    if (storeSearch) {
        storeSearch.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                const query = storeSearch.value.replace(/\s+/g, ' ').trim();
                if (query) trackInterest(query, 'search');
            }
        });
    }

    const gamesSearch = document.getElementById('games-search-input');
    if (gamesSearch) {
        gamesSearch.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                const query = gamesSearch.value.replace(/\s+/g, ' ').trim();
                if (query) trackInterest(query, 'search');
            }
        });
    }
});
