const API_URL = window.MDSTORE_API_URL;
let allProductsCache = [];
let allUsersCache = [];
let allRatingsCache = [];
let allChatsCache = [];
let activeChatUserId = null;
let allHomepageBannersCache = [];
let editingHomepageBannerId = null;

function normalizeHomepageBannerDestination(value) {
    const destination = String(value || '').trim().toLowerCase();
    const legacy = { store: 'store-section', '#store-section': 'store-section', '/store': 'store-section' };
    const normalized = legacy[destination] || destination;
    return ['store-section', 'offers-section', 'modified-games-section'].includes(normalized) ? normalized : '';
}

function adminHeaders(json = true) {
    const headers = {};
    if (json) headers['Content-Type'] = 'application/json';
    const token = sessionStorage.getItem('adminToken');
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

function resolveAdminImageUrl(value) {
    if (!value) return 'logo.jpeg';
    try {
        const api = new URL(API_URL);
        const parsed = new URL(String(value), `${api.origin}/`);
        if ((parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') && parsed.pathname.startsWith('/uploads/')) {
            parsed.protocol = api.protocol; parsed.host = api.host;
        }
        return parsed.href;
    } catch (_) { return 'logo.jpeg'; }
}

function handleAdminImageError(image) {
    if (image.dataset.fallbackApplied) { image.classList.add('hidden'); return; }
    image.dataset.fallbackApplied = 'true'; image.src = 'logo.jpeg';
}

function toggleVariantPriceRequirement(prefix) {
    const checkbox = document.getElementById(`${prefix}-requires-variants`);
    const priceInput = document.getElementById(`${prefix}-price`);
    if (checkbox && priceInput) priceInput.required = !checkbox.checked;
}

// حفظ حالة الرسائل المقروءة محلياً لضمان الإخفاء والظهور الفوري

function escapeQuotes(str) {
    if (!str) return '';
    return String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

document.addEventListener('DOMContentLoaded', async () => {
    if (!sessionStorage.getItem('adminToken')) return;
    try {
        const response = await fetch(`${API_URL}/admin/me`, { headers: adminHeaders(false) });
        if (!response.ok) throw new Error('Administrator session expired');
        document.getElementById('admin-login-overlay').classList.add('hidden');
        loadAdminProducts();
        loadAdminHomepageBanners();
        loadAdminOrders();
        loadAdminUsers();
        loadAdminRatings();
        loadAdminChats();
        setInterval(loadAdminChats, 5000);
    } catch (_) {
        sessionStorage.removeItem('adminToken');
    }
});

// 🔔 تنبيهات Toast
function showToast(message, type = 'success', duration = 3000) {
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
    toast.innerHTML = `<i class="${iconClass} text-base"></i><span class="${textColor}"></span>`;
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

async function handleAdminLogin(event) {
    event.preventDefault();
    const username = document.getElementById('admin-user').value.trim();
    const password = document.getElementById('admin-pass').value.trim();

    try {
        const response = await fetch(`${API_URL}/admin/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        if (response.ok) {
            const data = await response.json();
            sessionStorage.setItem('adminToken', data.token);
            document.getElementById('admin-login-overlay').classList.add('hidden');
            loadAdminProducts();
            loadAdminHomepageBanners();
            loadAdminOrders();
            loadAdminUsers();
            loadAdminRatings();
            loadAdminChats();
        } else {
            showToast('❌ بيانات الدخول غير صحيحة!', 'error');
        }
    } catch (error) {
        showToast('حدث خطأ في الاتصال بالسيرفر.', 'error');
    }
}

function adminLogout() {
    fetch(`${API_URL}/admin/logout`, { method: 'POST', headers: adminHeaders(false), keepalive: true }).catch(() => {});
    sessionStorage.removeItem('adminToken');
    location.reload();
}

// ----------------------------------------------------
// 💬 نظام إدارة المحادثات والعدادات (WhatsApp Style)
// ----------------------------------------------------

function toggleAdminChatWidget() {
    const modal = document.getElementById('admin-chat-modal');
    if (!modal) return;

    modal.classList.toggle('hidden');
    if (!modal.classList.contains('hidden')) {
        loadAdminChats();
    }
}

function getChatKey(chat) {
    if (chat.user_id !== null && chat.user_id !== undefined) return String(chat.user_id);
    if (chat.session_id) return String(chat.session_id);
    if (chat.id) return String(chat.id);
    return 'unknown';
}

// حساب عدد الرسائل غير المقروءة لكل محادثة
function calculateUnreadCount(chat) {
    const key = getChatKey(chat);
    if (String(activeChatUserId) === String(key)) return 0;
    return Math.max(0, Number(chat.unread_count) || 0);
}

// تحديث الشارة الكلية للأيقونة العائمة
function updateTotalUnreadBadge() {
    const badge = document.getElementById('admin-chat-badge');
    if (!badge) return;

    const totalUnread = allChatsCache.reduce((sum, chat) => sum + calculateUnreadCount(chat), 0);

    if (totalUnread > 0) {
        badge.innerText = totalUnread > 99 ? '+99' : totalUnread;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

async function loadAdminChats() {
    const threadsContainer = document.getElementById('admin-chat-threads');
    if (!threadsContainer) return;

    try {
        const response = await fetch(`${API_URL}/admin/chats`, { headers: adminHeaders(false) });
        if (!response.ok) throw new Error('فشل جلب المحادثات');

        allChatsCache = await response.json();
        
        updateTotalUnreadBadge();
        filterChatThreads();

        if (activeChatUserId !== null && activeChatUserId !== undefined) {
            const activeChat = allChatsCache.find(c => getChatKey(c) === String(activeChatUserId));
            if (activeChat) {
                renderActiveChatMessages(activeChat);
            }
        }
    } catch (error) {
        if (!allChatsCache || allChatsCache.length === 0) {
            threadsContainer.innerHTML = `
                <div class="p-6 text-center text-rose-400 text-xs">
                    <i class="fa-solid fa-triangle-exclamation text-lg mb-1 block"></i>
                    تعذر تحميل قائمة المحادثات من السيرفر.
                </div>
            `;
        }
    }
}

function renderChatThreads(chats) {
    const threadsContainer = document.getElementById('admin-chat-threads');
    if (!threadsContainer) return;

    if (!chats || chats.length === 0) {
        threadsContainer.innerHTML = `
            <div class="p-6 text-center text-slate-500 text-xs">
                لا توجد رسائل أو استفسارات حالية من العملاء.
            </div>
        `;
        return;
    }

    threadsContainer.innerHTML = chats.map(chat => {
        const chatKey = getChatKey(chat);
        const isActive = String(activeChatUserId) === String(chatKey);
        
        const lastMsgObj = chat.messages && chat.messages.length > 0 ? chat.messages[chat.messages.length - 1] : null;
        const lastMsgText = lastMsgObj ? lastMsgObj.text : 'لا توجد رسائل';
        
        const unreadCount = calculateUnreadCount(chat);
        const unreadBadge = unreadCount > 0 
            ? `<span class="bg-emerald-500 text-slate-950 font-extrabold text-[10px] min-w-[20px] h-5 px-1.5 rounded-full flex items-center justify-center shadow-lg shadow-emerald-500/20 animate-pulse">${unreadCount}</span>` 
            : '';

        const displayName = chat.user_name || (chat.session_id ? `زائر (${String(chat.session_id).substring(0, 8)})` : 'زائر / عميل');

        return `
            <div data-chat-key="${escapeHtml(chatKey)}" class="p-3.5 flex items-center justify-between gap-3 cursor-pointer transition ${isActive ? 'bg-cyan-500/10 border-r-4 border-cyan-500' : 'hover:bg-slate-900/60'}">
                <div class="flex items-center gap-3 overflow-hidden">
                    <div class="w-9 h-9 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-cyan-400 font-bold text-xs shrink-0">
                        ${escapeHtml(displayName.charAt(0).toUpperCase())}
                    </div>
                    <div class="overflow-hidden">
                        <h4 class="text-xs font-bold ${unreadCount > 0 ? 'text-white' : 'text-slate-200'} truncate">${escapeHtml(displayName)}</h4>
                        <p class="text-[11px] ${unreadCount > 0 ? 'text-emerald-400 font-semibold' : 'text-slate-400'} truncate mt-0.5">${escapeHtml(lastMsgText)}</p>
                    </div>
                </div>
                <div class="flex flex-col items-end gap-1 shrink-0">
                    <span class="text-[9px] ${unreadCount > 0 ? 'text-emerald-400 font-bold' : 'text-slate-500'}">${escapeHtml(chat.last_updated || (lastMsgObj ? lastMsgObj.created_at : ''))}</span>
                    ${unreadBadge}
                </div>
            </div>
        `;
    }).join('');
    threadsContainer.querySelectorAll('[data-chat-key]').forEach(thread => {
        thread.addEventListener('click', () => selectChatUser(thread.dataset.chatKey));
    });
}

function filterChatThreads() {
    const searchInput = document.getElementById('chat-user-search');
    const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
    
    if (!query) {
        renderChatThreads(allChatsCache);
        return;
    }

    const filtered = allChatsCache.filter(c => 
        (c.user_name && c.user_name.toLowerCase().includes(query)) ||
        (c.user_email && c.user_email.toLowerCase().includes(query)) ||
        (c.session_id && String(c.session_id).toLowerCase().includes(query))
    );
    renderChatThreads(filtered);
}

async function selectChatUser(chatKey) {
    activeChatUserId = String(chatKey);
    
    const chat = allChatsCache.find(c => getChatKey(c) === activeChatUserId);

    if (!chat) return;

    // 🟢 تعليم كافة رسائل هذه المحادثة كـ "مقروءة" فوراً
    chat.unread_count = 0;

    // تحديث العدادات وإخفاء الشارة
    updateTotalUnreadBadge();
    filterChatThreads();

    // إرسال إشعار للسيرفر لتحديث الحالة لديه
    fetch(`${API_URL}/admin/chats/read`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({
            user_id: chat.user_id || null,
            session_id: chat.session_id || chatKey
        })
    }).then(response => {
        if (!response.ok) loadAdminChats();
    }).catch(() => loadAdminChats());

    const displayName = chat.user_name || (chat.session_id ? `زائر (${String(chat.session_id).substring(0, 8)})` : 'زائر / عميل');

    document.getElementById('chat-active-avatar').innerText = displayName.charAt(0).toUpperCase();
    document.getElementById('chat-active-username').innerText = displayName;
    document.getElementById('chat-active-userinfo').innerText = `${chat.user_email || ''} ${chat.user_phone ? '| ' + chat.user_phone : ''} ${chat.session_id ? '[جلسة زائر]' : ''}`;
    document.getElementById('chat-active-status').classList.remove('hidden');

    document.getElementById('chat-message-input').disabled = false;
    document.getElementById('chat-send-btn').disabled = false;

    renderActiveChatMessages(chat);
}

function renderActiveChatMessages(chat) {
    const container = document.getElementById('chat-messages-container');
    if (!container) return;

    if (!chat.messages || chat.messages.length === 0) {
        container.innerHTML = `
            <div class="h-full flex items-center justify-center text-slate-500 text-xs">
                لا توجد رسائل سابقة في هذه المحادثة.
            </div>
        `;
        return;
    }

    container.innerHTML = chat.messages.map(msg => {
        const isAdmin = msg.sender === 'admin';

        if (isAdmin) {
            return `
                <div class="flex flex-col items-end gap-1">
                    <div class="bg-cyan-500 text-slate-950 px-3.5 py-2 rounded-2xl rounded-tl-none max-w-[80%] text-xs font-semibold shadow-md">
                        ${escapeHtml(msg.text)}
                    </div>
                    <span class="text-[9px] text-slate-500 font-mono px-1">${escapeHtml(msg.created_at || '')}</span>
                </div>
            `;
        } else {
            return `
                <div class="flex flex-col items-start gap-1">
                    <div class="bg-slate-800 text-slate-100 border border-slate-700 px-3.5 py-2 rounded-2xl rounded-tr-none max-w-[80%] text-xs font-medium shadow-md">
                        ${escapeHtml(msg.text)}
                    </div>
                    <span class="text-[9px] text-slate-500 font-mono px-1">${escapeHtml(msg.created_at || '')}</span>
                </div>
            `;
        }
    }).join('');

    container.scrollTop = container.scrollHeight;
}

async function handleSendAdminMessage(event) {
    event.preventDefault();

    if (!activeChatUserId) {
        showToast('برجاء تحديد محادثة عميل أولاً.', 'error');
        return;
    }

    const input = document.getElementById('chat-message-input');
    const messageText = input.value.trim();
    if (!messageText) return;

    const chat = allChatsCache.find(c => getChatKey(c) === activeChatUserId);

    try {
        const response = await fetch(`${API_URL}/admin/chats/send`, {
            method: 'POST',
            headers: adminHeaders(),
            body: JSON.stringify({
                user_id: chat && chat.user_id ? chat.user_id : null,
                session_id: chat && chat.session_id ? chat.session_id : activeChatUserId,
                message: messageText
            })
        });

        if (response.ok) {
            input.value = '';
            
            if (chat) {
                if (!chat.messages) chat.messages = [];
                chat.messages.push({
                    sender: 'admin',
                    text: messageText,
                    created_at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                });
                renderActiveChatMessages(chat);
            }

            loadAdminChats();
        } else {
            showToast('تعذر إرسال الرسالة.', 'error');
        }
    } catch (error) {
        showToast('حدث خطأ أثناء الاتصال بالسيرفر.', 'error');
    }
}

// ----------------------------------------------------
// 🛍️ PRODUCTS MANAGEMENT
// ----------------------------------------------------

async function uploadProductImage(fileInputId) {
    const fileInput = document.getElementById(fileInputId);
    if (fileInput && fileInput.files && fileInput.files.length > 0) {
        const formData = new FormData();
        formData.append('file', fileInput.files[0]);

        try {
            const uploadRes = await fetch(`${API_URL}/upload`, {
                method: 'POST',
                headers: adminHeaders(false),
                body: formData
            });

            if (!uploadRes.ok) throw new Error('فشل رفع ملف الصورة');
            const uploadData = await uploadRes.json();
            return uploadData.image_url || null;
        } catch (err) {
            showToast('❌ حدث خطأ أثناء رفع ملف الصورة من الجهاز.', 'error');
            return null;
        }
    }
    return null;
}

async function loadAdminProducts() {
    const tableBody = document.getElementById('admin-products-table');
    try {
        const response = await fetch(`${API_URL}/products`);
        if (!response.ok) throw new Error('فشل جلب المنتجات');
        
        allProductsCache = await response.json();

        if (allProductsCache.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="8" class="text-center py-8 text-slate-500">لا توجد منتجات حالية.</td></tr>`;
            return;
        }

        tableBody.innerHTML = '';
        allProductsCache.forEach(p => {
            const displayImg = resolveAdminImageUrl(p.image_url);
            const hasOptions = Boolean(p.requires_variants || p.variants?.length);
            const priceLabel = hasOptions
                ? (p.price == null ? 'Variant prices / أسعار الخيارات' : `Base fallback ${Number(p.price).toLocaleString()} EGP`)
                : `${Number(p.price || 0).toLocaleString()} EGP`;

            tableBody.innerHTML += `
                <tr class="hover:bg-slate-950/50 transition">
                    <td class="p-3 font-bold text-slate-400">#${p.id}</td>
                    <td class="p-3">
                        <img src="${displayImg}" alt="${p.name}" class="h-8 w-8 object-cover rounded-lg border border-slate-800" onerror="handleAdminImageError(this)">
                    </td>
                    <td class="p-3 font-semibold text-slate-200">${p.name}</td>
                    <td class="p-3 font-bold text-cyan-400">${priceLabel}</td>
                    <td class="p-3">${p.stock}</td>
                    <td class="p-3 text-slate-400">${p.category || 'عام'}</td>
                    <td class="p-3 text-cyan-400 font-bold">${p.badge || '-'}</td>
                    <td class="p-3 text-center">
                        <div class="flex items-center justify-center gap-2">
                            <button onclick="openEditModal(${p.id})" class="bg-cyan-500/10 hover:bg-cyan-500 text-cyan-400 hover:text-slate-950 px-3 py-1.5 rounded-lg border border-cyan-500/30 transition text-[11px] flex items-center gap-1">
                                <i class="fa-solid fa-pen-to-square"></i>
                                <span>تعديل</span>
                            </button>
                            <button onclick="openProductVariants(${p.id})" class="bg-violet-500/10 hover:bg-violet-500 text-violet-300 hover:text-slate-950 px-3 py-1.5 rounded-lg border border-violet-500/30 transition text-[11px] flex items-center gap-1">
                                <i class="fa-solid fa-sliders"></i><span>Options / الخيارات</span>
                            </button>
                            <button onclick="deleteProduct(${p.id})" class="bg-red-500/10 hover:bg-red-500 text-red-400 hover:text-white px-3 py-1.5 rounded-lg border border-red-500/30 transition text-[11px] flex items-center gap-1">
                                <i class="fa-solid fa-trash"></i>
                                <span>مسح</span>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        });
    } catch (error) {
        tableBody.innerHTML = `<tr><td colspan="8" class="text-center py-8 text-red-400">تأكد من تشغيل السيرفر.</td></tr>`;
    }
}

async function loadAdminHomepageBanners() {
    const list = document.getElementById('homepage-banners-list');
    if (!list) return;
    try {
        const response = await fetch(`${API_URL}/admin/homepage/banners`, { headers: adminHeaders(false) });
        const data = await response.json().catch(() => []);
        if (!response.ok) throw new Error(data.detail || `Could not load banners (HTTP ${response.status})`);
        allHomepageBannersCache = Array.isArray(data) ? data : [];
        renderAdminHomepageBanners();
    } catch (error) {
        list.innerHTML = `<p class="text-xs text-rose-400">Could not load banners / تعذر تحميل البنرات: ${escapeHtml(error.message)}</p>`;
    }
}

function renderAdminHomepageBanners() {
    const list = document.getElementById('homepage-banners-list');
    const count = document.getElementById('homepage-banner-count');
    const addButton = document.getElementById('add-homepage-banner-btn');
    if (!list) return;
    if (count) count.textContent = `${allHomepageBannersCache.length} / 3 configured / تم إعداد ${allHomepageBannersCache.length} من 3`;
    if (addButton) {
        addButton.disabled = allHomepageBannersCache.length >= 3;
        addButton.classList.toggle('opacity-50', addButton.disabled);
        addButton.classList.toggle('cursor-not-allowed', addButton.disabled);
    }
    if (!allHomepageBannersCache.length) {
        list.innerHTML = '<p class="text-xs text-slate-500">No extra banners configured. / لم يتم إعداد بنرات إضافية.</p>';
        return;
    }
    list.innerHTML = allHomepageBannersCache.map((banner, index) => `
        <article class="bg-slate-950 border border-slate-800 rounded-xl p-3 flex flex-col sm:flex-row gap-3">
            <img src="${escapeHtml(resolveAdminImageUrl(banner.image_url))}" alt="" class="w-full sm:w-32 h-24 object-cover rounded-lg border border-slate-800" onerror="handleAdminImageError(this)">
            <div class="flex-1 min-w-0 space-y-1">
                <p class="font-bold text-slate-100 truncate">${escapeHtml(banner.title_ar)} / ${escapeHtml(banner.title_en)}</p>
                <p class="text-[10px] text-slate-500 truncate">${escapeHtml(banner.subtitle_en || banner.subtitle_ar || '')}</p>
                <span class="inline-flex rounded-full px-2 py-0.5 text-[10px] ${banner.is_active ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30' : 'bg-slate-800 text-slate-400 border border-slate-700'}">${banner.is_active ? 'Active / مفعّل' : 'Disabled / معطّل'} · #${banner.position}</span>
            </div>
            <div class="flex flex-wrap sm:flex-col gap-1.5 sm:justify-center">
                <button type="button" onclick="moveHomepageBanner(${banner.id},-1)" ${index === 0 ? 'disabled' : ''} class="px-2 py-1 rounded-lg bg-slate-800 text-slate-300 text-[10px] disabled:opacity-30" title="Move up / لأعلى"><i class="fa-solid fa-arrow-up"></i></button>
                <button type="button" onclick="moveHomepageBanner(${banner.id},1)" ${index === allHomepageBannersCache.length - 1 ? 'disabled' : ''} class="px-2 py-1 rounded-lg bg-slate-800 text-slate-300 text-[10px] disabled:opacity-30" title="Move down / لأسفل"><i class="fa-solid fa-arrow-down"></i></button>
                <button type="button" onclick="openHomepageBannerModal(${banner.id})" class="px-2 py-1 rounded-lg bg-cyan-500/10 text-cyan-300 text-[10px]">Edit / تعديل</button>
                <button type="button" onclick="toggleHomepageBanner(${banner.id})" class="px-2 py-1 rounded-lg bg-amber-500/10 text-amber-300 text-[10px]">${banner.is_active ? 'Disable / تعطيل' : 'Enable / تفعيل'}</button>
                <button type="button" onclick="deleteHomepageBanner(${banner.id})" class="px-2 py-1 rounded-lg bg-rose-500/10 text-rose-300 text-[10px]">Delete / حذف</button>
            </div>
        </article>`).join('');
}

function openHomepageBannerModal(bannerId = null) {
    if (!bannerId && allHomepageBannersCache.length >= 3) {
        showToast('Only 3 extra banners are allowed / الحد الأقصى 3 بنرات إضافية', 'error');
        return;
    }
    editingHomepageBannerId = bannerId;
    const banner = allHomepageBannersCache.find(item => item.id === bannerId);
    const form = document.getElementById('homepage-banner-form');
    form?.reset();
    document.getElementById('homepage-banner-modal-title').textContent = banner ? 'Edit homepage banner / تعديل بانر الصفحة الرئيسية' : 'Add homepage banner / إضافة بانر للصفحة الرئيسية';
    document.getElementById('homepage-banner-title-ar').value = banner?.title_ar || '';
    document.getElementById('homepage-banner-title-en').value = banner?.title_en || '';
    document.getElementById('homepage-banner-subtitle-ar').value = banner?.subtitle_ar || '';
    document.getElementById('homepage-banner-subtitle-en').value = banner?.subtitle_en || '';
    document.getElementById('homepage-banner-button-ar').value = banner?.button_text_ar || '';
    document.getElementById('homepage-banner-button-en').value = banner?.button_text_en || '';
    document.getElementById('homepage-banner-link').value = normalizeHomepageBannerDestination(banner?.button_link);
    document.getElementById('homepage-banner-position').value = String(banner?.position || allHomepageBannersCache.length + 1 || 1);
    document.getElementById('homepage-banner-active').checked = banner ? Boolean(banner.is_active) : true;
    const preview = document.getElementById('homepage-banner-preview');
    if (banner?.image_url) {
        preview.src = resolveAdminImageUrl(banner.image_url);
        preview.classList.remove('hidden');
    } else {
        preview.removeAttribute('src');
        preview.classList.add('hidden');
    }
    document.getElementById('homepage-banner-modal').classList.remove('hidden');
}

function closeHomepageBannerModal() {
    document.getElementById('homepage-banner-modal')?.classList.add('hidden');
    editingHomepageBannerId = null;
}

function previewHomepageBannerImage(event) {
    const file = event.target.files?.[0];
    const preview = document.getElementById('homepage-banner-preview');
    if (!file || !preview) return;
    if (!file.type.startsWith('image/')) {
        event.target.value = '';
        showToast('Choose an image file / اختر ملف صورة', 'error');
        return;
    }
    const reader = new FileReader();
    reader.onload = () => {
        preview.src = reader.result;
        preview.classList.remove('hidden');
    };
    reader.readAsDataURL(file);
}

async function saveHomepageBanner(event) {
    event.preventDefault();
    const fileInput = document.getElementById('homepage-banner-image');
    const selectedFile = Boolean(fileInput.files?.length);
    const previous = allHomepageBannersCache.find(item => item.id === editingHomepageBannerId);
    let imageUrl = previous?.image_url || null;
    if (selectedFile) {
        imageUrl = await uploadProductImage('homepage-banner-image');
        if (!imageUrl) return;
    }
    if (!imageUrl) {
        showToast('Upload a banner image first / ارفع صورة للبانر أولاً', 'error');
        return;
    }
    const payload = {
        image_url: imageUrl,
        title_ar: document.getElementById('homepage-banner-title-ar').value.trim(),
        title_en: document.getElementById('homepage-banner-title-en').value.trim(),
        subtitle_ar: document.getElementById('homepage-banner-subtitle-ar').value.trim() || null,
        subtitle_en: document.getElementById('homepage-banner-subtitle-en').value.trim() || null,
        button_text_ar: document.getElementById('homepage-banner-button-ar').value.trim() || null,
        button_text_en: document.getElementById('homepage-banner-button-en').value.trim() || null,
        button_link: document.getElementById('homepage-banner-link').value.trim() || null,
        position: Number(document.getElementById('homepage-banner-position').value),
        is_active: document.getElementById('homepage-banner-active').checked
    };
    if (!payload.title_ar || !payload.title_en) {
        showToast('Enter both Arabic and English titles / أدخل العنوان بالعربية والإنجليزية', 'error');
        return;
    }
    try {
        const endpoint = editingHomepageBannerId ? `${API_URL}/admin/homepage/banners/${editingHomepageBannerId}` : `${API_URL}/admin/homepage/banners`;
        const response = await fetch(endpoint, { method: editingHomepageBannerId ? 'PUT' : 'POST', headers: adminHeaders(), body: JSON.stringify(payload) });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.detail || `Could not save banner (HTTP ${response.status})`);
        closeHomepageBannerModal();
        await loadAdminHomepageBanners();
        showToast('Banner saved / تم حفظ البانر', 'success');
    } catch (error) {
        showToast(`Could not save banner / تعذر حفظ البانر: ${error.message}`, 'error');
    }
}

async function persistHomepageBannerOrder(ids) {
    const response = await fetch(`${API_URL}/admin/homepage/banners/order`, { method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ ids }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `Could not reorder banners (HTTP ${response.status})`);
    allHomepageBannersCache = data;
    renderAdminHomepageBanners();
}

async function moveHomepageBanner(bannerId, direction) {
    const ids = allHomepageBannersCache.map(banner => banner.id);
    const index = ids.indexOf(bannerId);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    try { await persistHomepageBannerOrder(ids); }
    catch (error) { showToast(`Could not reorder / تعذر تغيير الترتيب: ${error.message}`, 'error'); }
}

async function toggleHomepageBanner(bannerId) {
    const banner = allHomepageBannersCache.find(item => item.id === bannerId);
    if (!banner) return;
    try {
        const response = await fetch(`${API_URL}/admin/homepage/banners/${banner.id}`, {
            method: 'PUT', headers: adminHeaders(),
            body: JSON.stringify({ ...banner, button_link: normalizeHomepageBannerDestination(banner.button_link) || null, is_active: !banner.is_active })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || `Could not update banner (HTTP ${response.status})`);
        await loadAdminHomepageBanners();
    } catch (error) { showToast(`Could not update banner / تعذر تحديث البانر: ${error.message}`, 'error'); }
}

async function deleteHomepageBanner(bannerId) {
    if (!confirm('Delete this banner? / هل تريد حذف هذا البانر؟')) return;
    try {
        const response = await fetch(`${API_URL}/admin/homepage/banners/${bannerId}`, { method: 'DELETE', headers: adminHeaders(false) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || `Could not delete banner (HTTP ${response.status})`);
        await loadAdminHomepageBanners();
        showToast('Banner deleted / تم حذف البانر', 'success');
    } catch (error) { showToast(`Could not delete banner / تعذر حذف البانر: ${error.message}`, 'error'); }
}

function orderStatusLabel(status) {
    return ({
        pending: 'بانتظار التأكيد / Awaiting confirmation',
        confirmed: 'تم التأكيد / Confirmed',
        processing: 'قيد التجهيز / Processing',
        completed: 'مكتمل / Completed',
        cancelled: 'ملغي / Cancelled'
    })[status] || escapeHtml(status);
}

async function loadAdminOrders() {
    const tableBody = document.getElementById('admin-orders-table');
    if (!tableBody) return;
    try {
        const response = await fetch(`${API_URL}/admin/orders`, { headers: adminHeaders(false) });
        if (!response.ok) throw new Error('Could not load orders');
        const orders = await response.json();
        if (!orders.length) {
            tableBody.innerHTML = '<tr><td colspan="9" class="text-center py-8 text-slate-500">لا توجد طلبات / No orders yet.</td></tr>';
            return;
        }
        tableBody.innerHTML = orders.map(order => {
            const dateText = order.created_at ? new Date(order.created_at).toLocaleString() : '-';
            const itemText = (order.items || []).map(item => `${escapeHtml(item.product_name)}${item.variant ? ` (${escapeHtml(item.variant)})` : ''} × ${item.quantity} · ${Number(item.unit_price).toLocaleString()} EGP each`).join('<br>');
            const options = (order.allowed_statuses || [order.status]).map(status => `<option value="${status}" ${order.status === status ? 'selected' : ''}>${orderStatusLabel(status)}</option>`).join('');
            const paymentLabel = order.payment_status === 'paid' ? 'Collected / مدفوع' : 'Unpaid / غير مدفوع';
            const cancellationFeeDue = order.status === 'cancelled' && order.cancellation_fee_status === 'due';
            const paymentAction = cancellationFeeDue
                ? `<button onclick="recordAdminOrderPayment(${order.id}, true)" class="mt-1 rounded-lg border border-amber-500/30 px-2 py-1 text-[10px] text-amber-300 hover:bg-amber-500/10">Record cancellation delivery fee / تسجيل رسوم التوصيل للإلغاء</button>`
                : order.payment_status === 'unpaid' && order.status !== 'cancelled' && order.payment_method !== 'paymob'
                    ? `<button onclick="recordAdminOrderPayment(${order.id}, false, '${order.payment_method || 'cash_on_delivery'}')" class="mt-1 rounded-lg border border-cyan-500/30 px-2 py-1 text-[10px] text-cyan-300 hover:bg-cyan-500/10">${order.payment_method === 'cash_on_delivery' ? 'Confirm courier COD collection / تأكيد تحصيل المندوب' : order.payment_method === 'paymob' ? 'Paymob online payment / دفع إلكتروني عبر Paymob' : order.payment_method === 'online_payment_demo' ? 'Confirm payment received manually / تأكيد استلام الدفع يدوياً' : 'Record legacy order collection / تسجيل تحصيل الطلب السابق'}</button>`
                    : '';
            return `<tr class="hover:bg-slate-950/50 transition align-top">
                <td class="p-3 font-bold text-cyan-400">#${order.id}</td>
                <td class="p-3 text-slate-400">${escapeHtml(dateText)}</td>
                <td class="p-3"><div class="font-semibold text-slate-200">${escapeHtml(order.customer_name)}</div><div class="text-slate-500">${escapeHtml(order.phone || '')}</div><div class="text-slate-500">${escapeHtml(order.address || '')}</div></td>
                <td class="p-3 text-slate-400">${order.delivery_method === 'store_pickup' ? 'Store pickup / استلام من الفرع' : 'Home delivery / توصيل للعنوان'}<div>${escapeHtml(order.delivery_area || '')}</div><div>Delivery: ${Number(order.shipping_fee || 0).toLocaleString()} EGP</div>${order.status === 'cancelled' ? `<div class="text-amber-300">Cancellation fee: ${Number(order.cancellation_fee || 0).toLocaleString()} EGP (${order.cancellation_fee_status || 'not_applicable'})</div>` : ''}</td>
                <td class="p-3 text-slate-300">${itemText}</td>
                <td class="p-3 font-bold text-cyan-400 whitespace-nowrap">${Number(order.total_price).toLocaleString()} ج.م / EGP</td>
                <td class="p-3 text-slate-300">${paymentLabel}<div>${order.payment_method === 'cash_on_delivery' ? 'Cash on delivery / الدفع عند الاستلام' : order.payment_method === 'paymob' ? 'Paymob online payment / دفع إلكتروني عبر Paymob' : order.payment_method === 'online_payment_demo' ? 'Online demo (unpaid) / دفع تجريبي غير مدفوع' : 'Legacy manual order / طلب دفع يدوي سابق'}</div>${paymentAction}</td>
                <td class="p-3 text-slate-300">${orderStatusLabel(order.status)}</td>
                <td class="p-3"><select ${order.allowed_statuses?.length < 2 ? 'disabled' : ''} onchange="updateAdminOrderStatus(${order.id}, this.value)" class="bg-slate-950 border border-slate-700 rounded-lg p-2 text-[10px] text-slate-100">${options}</select></td>
            </tr>`;
        }).join('');
    } catch (error) {
        tableBody.innerHTML = '<tr><td colspan="9" class="text-center py-8 text-red-400">تعذر تحميل الطلبات / Could not load orders.</td></tr>';
    }
}

async function updateAdminOrderStatus(orderId, status) {
    try {
        const response = await fetch(`${API_URL}/admin/orders/${orderId}/status`, {
            method: 'PUT',
            headers: adminHeaders(),
            body: JSON.stringify({ status })
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.detail || 'Could not update order status');
        }
        showToast('تم تحديث الطلب / Order status updated', 'success');
        await loadAdminOrders();
    } catch (error) {
        showToast(`تعذر تحديث الطلب / Could not update order: ${error.message}`, 'error');
        loadAdminOrders();
    }
}

async function recordAdminOrderPayment(orderId, isCancellationFee = false, paymentMethod = 'cash_on_delivery') {
    const prompt = isCancellationFee
        ? 'Confirm that the customer paid the cancellation delivery fee / أكد تحصيل رسوم التوصيل للإلغاء'
        : 'Confirm that the courier collected the product price and delivery fee / أكد أن المندوب حصّل قيمة المنتج ورسوم التوصيل';
    if (!confirm(prompt)) return;
    try {
        const response = await fetch(`${API_URL}/admin/orders/${orderId}/payment`, {
            method: 'POST',
            headers: adminHeaders(),
            body: JSON.stringify({ collected: true })
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.detail || 'Could not record collection');
        }
        showToast('تم تسجيل التحصيل / Collection recorded', 'success');
        await loadAdminOrders();
    } catch (error) {
        showToast(`تعذر تسجيل التحصيل / Could not record collection: ${error.message}`, 'error');
    }
}

async function handleAddProduct(event) {
    event.preventDefault();
    const imageUrl = await uploadProductImage('prod-image-file');
    const badgeVal = document.getElementById('prod-badge').value.trim();

    const productData = {
        name: document.getElementById('prod-name').value.trim(),
        price: document.getElementById('prod-price').value === '' ? null : parseFloat(document.getElementById('prod-price').value),
        stock: parseInt(document.getElementById('prod-stock').value),
        category: document.getElementById('prod-category').value || "General",
        description: document.getElementById('prod-desc').value.trim() || "",
        image_url: imageUrl,
        badge: badgeVal ? badgeVal : null,
        requires_variants: document.getElementById('prod-requires-variants').checked,
        is_active: document.getElementById('prod-is-active').checked,
        show_in_modified_games: document.getElementById('prod-modified-games').checked
    };

    try {
        const response = await fetch(`${API_URL}/products`, {
            method: 'POST',
            headers: adminHeaders(),
            body: JSON.stringify(productData)
        });

        if (response.ok) {
            showToast('✅ تم إضافة المنتج بنجاح!', 'success');
            document.getElementById('add-product-form').reset();
            toggleVariantPriceRequirement('prod');
            loadAdminProducts();
        } else {
            showToast('❌ تعذر إضافة المنتج.', 'error');
        }
    } catch (error) {
        showToast('تعذر الاتصال بالسيرفر.', 'error');
    }
}

function openEditModal(productId) {
    const product = allProductsCache.find(p => p.id === productId);
    if (!product) return;

    document.getElementById('edit-prod-id').innerText = product.id;
    document.getElementById('edit-prod-name').value = product.name;
    document.getElementById('edit-prod-price').value = product.price;
    document.getElementById('edit-prod-requires-variants').checked = Boolean(product.requires_variants || product.variants?.length);
    toggleVariantPriceRequirement('edit-prod');
    document.getElementById('edit-prod-stock').value = product.stock;
    document.getElementById('edit-prod-category').value = product.category || 'General';
    document.getElementById('edit-prod-badge').value = product.badge || '';
    document.getElementById('edit-prod-is-active').checked = product.is_active !== false;
    document.getElementById('edit-prod-modified-games').checked = Boolean(product.show_in_modified_games);
    if (document.getElementById('edit-prod-image-file')) {
        document.getElementById('edit-prod-image-file').value = '';
    }
    document.getElementById('edit-prod-desc').value = product.description || '';

    document.getElementById('edit-modal').classList.remove('hidden');
}

function closeEditModal() {
    document.getElementById('edit-modal').classList.add('hidden');
}

async function handleUpdateProduct(event) {
    event.preventDefault();
    const productId = document.getElementById('edit-prod-id').innerText;
    const currentProduct = allProductsCache.find(p => p.id == productId);

    let imageUrl = await uploadProductImage('edit-prod-image-file');
    if (!imageUrl && currentProduct) {
        imageUrl = currentProduct.image_url;
    }

    const badgeVal = document.getElementById('edit-prod-badge').value.trim();

    const updatedData = {
        name: document.getElementById('edit-prod-name').value.trim(),
        price: document.getElementById('edit-prod-price').value === '' ? null : parseFloat(document.getElementById('edit-prod-price').value),
        stock: parseInt(document.getElementById('edit-prod-stock').value),
        category: document.getElementById('edit-prod-category').value || "General",
        description: document.getElementById('edit-prod-desc').value.trim() || "",
        image_url: imageUrl,
        badge: badgeVal ? badgeVal : null,
        requires_variants: document.getElementById('edit-prod-requires-variants').checked,
        is_active: document.getElementById('edit-prod-is-active').checked,
        show_in_modified_games: document.getElementById('edit-prod-modified-games').checked
    };

    try {
        const response = await fetch(`${API_URL}/products/${productId}`, {
            method: 'PUT',
            headers: adminHeaders(),
            body: JSON.stringify(updatedData)
        });

        if (response.ok) {
            showToast('✅ تم تحديث المنتج بنجاح!', 'success');
            closeEditModal();
            loadAdminProducts();
        } else {
            showToast('❌ فشل التحديث.', 'error');
        }
    } catch (error) {
        showToast('حدث خطأ أثناء محاولة التعديل.', 'error');
    }
}

let activeVariantsProductId = null;

async function openProductVariants(productId) {
    const product = allProductsCache.find(item => Number(item.id) === Number(productId));
    if (!product) return;
    activeVariantsProductId = Number(productId);
    document.getElementById('variant-product-name').textContent = product.name;
    document.getElementById('variant-required-toggle').checked = Boolean(product.requires_variants);
    document.getElementById('variants-modal').classList.remove('hidden');
    await loadProductVariantRows();
}

function closeProductVariants() {
    document.getElementById('variants-modal')?.classList.add('hidden');
    activeVariantsProductId = null;
}

async function loadProductVariantRows() {
    if (!activeVariantsProductId) return;
    const container = document.getElementById('variant-manager-list');
    container.innerHTML = '<p class="text-slate-400 text-xs">Loading / جار التحميل...</p>';
    try {
        const response = await fetch(`${API_URL}/products/${activeVariantsProductId}/variants`);
        const variants = await response.json();
        if (!response.ok) throw new Error(variants.detail || `HTTP ${response.status}`);
        container.innerHTML = variants.length ? variants.map(variant => `
            <div class="grid grid-cols-1 sm:grid-cols-[1fr_1fr_130px_auto_auto] gap-2 bg-slate-950 border border-slate-800 rounded-xl p-3 items-center">
                <input id="variant-platform-${variant.id}" maxlength="80" value="${escapeHtml(variant.platform || '')}" placeholder="Platform / المنصة" class="bg-slate-900 border border-slate-800 rounded-lg p-2 text-xs">
                <input id="variant-edition-${variant.id}" maxlength="80" value="${escapeHtml(variant.edition || '')}" placeholder="Edition / الإصدار" class="bg-slate-900 border border-slate-800 rounded-lg p-2 text-xs">
                <input id="variant-price-${variant.id}" type="number" min="0" step="0.01" value="${variant.price ?? ''}" placeholder="Price / السعر" class="bg-slate-900 border border-slate-800 rounded-lg p-2 text-xs">
                <label class="text-[10px] text-slate-300 flex items-center gap-1"><input id="variant-active-${variant.id}" type="checkbox" ${variant.is_active ? 'checked' : ''} class="accent-cyan-400"> Active / فعال</label>
                <div class="flex gap-1"><button onclick="saveProductVariant(${variant.id})" class="bg-cyan-500/10 text-cyan-300 border border-cyan-500/30 rounded-lg px-2 py-1 text-xs">Save</button><button onclick="deleteProductVariant(${variant.id})" class="bg-rose-500/10 text-rose-300 border border-rose-500/30 rounded-lg px-2 py-1 text-xs">Delete</button></div>
            </div>`).join('') : '<p class="text-xs text-slate-500">No configured options yet / لا توجد خيارات مسجلة.</p>';
    } catch (error) {
        container.innerHTML = `<p class="text-xs text-rose-400">${escapeHtml(error.message)}</p>`;
    }
}

async function saveVariantSettings() {
    if (!activeVariantsProductId) return;
    try {
        const response = await fetch(`${API_URL}/admin/products/${activeVariantsProductId}/variant-settings`, {
            method: 'PUT', headers: adminHeaders(),
            body: JSON.stringify({ requires_variants: document.getElementById('variant-required-toggle').checked })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
        showToast('Variant requirement saved / تم حفظ إعداد الخيارات', 'success');
        await loadAdminProducts();
    } catch (error) { showToast(`Could not save / تعذر الحفظ: ${error.message}`, 'error'); }
}

async function addProductVariant(event) {
    event.preventDefault();
    if (!activeVariantsProductId) return;
    const rawPrice = document.getElementById('new-variant-price').value;
    const payload = {
        platform: document.getElementById('new-variant-platform').value.trim() || null,
        edition: document.getElementById('new-variant-edition').value.trim() || null,
        price: rawPrice === '' ? null : Number(rawPrice), is_active: true
    };
    try {
        const response = await fetch(`${API_URL}/admin/products/${activeVariantsProductId}/variants`, { method: 'POST', headers: adminHeaders(), body: JSON.stringify(payload) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
        document.getElementById('variant-add-form').reset();
        await loadProductVariantRows(); await loadAdminProducts();
    } catch (error) { showToast(`Could not add option / تعذر إضافة الخيار: ${error.message}`, 'error'); }
}

async function saveProductVariant(variantId) {
    const rawPrice = document.getElementById(`variant-price-${variantId}`).value;
    const payload = {
        platform: document.getElementById(`variant-platform-${variantId}`).value.trim() || null,
        edition: document.getElementById(`variant-edition-${variantId}`).value.trim() || null,
        price: rawPrice === '' ? null : Number(rawPrice),
        is_active: document.getElementById(`variant-active-${variantId}`).checked
    };
    try {
        const response = await fetch(`${API_URL}/admin/product-variants/${variantId}`, { method: 'PUT', headers: adminHeaders(), body: JSON.stringify(payload) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
        await loadProductVariantRows(); await loadAdminProducts();
    } catch (error) { showToast(`Could not update option / تعذر تحديث الخيار: ${error.message}`, 'error'); }
}

async function deleteProductVariant(variantId) {
    if (!confirm('Remove this option? / حذف هذا الخيار؟')) return;
    try {
        const response = await fetch(`${API_URL}/admin/product-variants/${variantId}`, { method: 'DELETE', headers: adminHeaders(false) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
        await loadProductVariantRows(); await loadAdminProducts();
    } catch (error) { showToast(`Could not remove option / تعذر حذف الخيار: ${error.message}`, 'error'); }
}

async function deleteProduct(productId) {
    if (!confirm(`هل أنت تأكد من مسح المنتج رقم #${productId}؟`)) return;

    try {
        const response = await fetch(`${API_URL}/products/${productId}`, { method: 'DELETE', headers: adminHeaders(false) });
        if (response.ok) {
            showToast('✅ تم المسح بنجاح!', 'success');
            loadAdminProducts();
        }
    } catch (error) {
        showToast('حدث خطأ أثناء محاولة المسح.', 'error');
    }
}

// ----------------------------------------------------
// 👥 USERS & ACTIVITIES MANAGEMENT
// ----------------------------------------------------

async function loadAdminUsers() {
    const tableBody = document.getElementById('admin-users-table');
    try {
        const response = await fetch(`${API_URL}/admin/users`, { headers: adminHeaders(false) });
        if (!response.ok) throw new Error('فشل جلب قائمة العملاء');

        allUsersCache = await response.json();

        if (allUsersCache.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="9" class="text-center py-8 text-slate-500">لا يوجد عملاء مسجلين بعد.</td></tr>`;
            return;
        }

        tableBody.innerHTML = '';
        allUsersCache.forEach(u => {
            const repairCount = u.repairs ? u.repairs.length : 0;
            const tradeCount = u.trades ? u.trades.length : 0;
            const interestCount = u.interests ? u.interests.length : 0;
            const deleteButton = u.is_deleted
                ? '<span class="text-[10px] text-slate-500">تم حذف الحساب</span>'
                : `<button type="button" onclick="deleteCustomerAccount(${Number(u.id)})" class="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-[11px] font-bold text-rose-300 transition hover:bg-rose-500 hover:text-white"><i class="fa-solid fa-user-xmark"></i><span>حذف الحساب</span></button>`;

            tableBody.innerHTML += `
                <tr class="hover:bg-slate-950/50 transition">
                    <td class="p-3 font-bold text-slate-400">#${u.id}</td>
                    <td class="p-3 font-semibold ${u.is_deleted ? 'text-slate-500' : 'text-slate-200'}">${escapeHtml(u.name)}${u.is_deleted ? '<span class="mr-2 text-[10px] text-rose-400">معطّل</span>' : ''}</td>
                    <td class="p-3 text-cyan-400 font-mono">${escapeHtml(u.email)}</td>
                    <td class="p-3 text-slate-300 font-mono">${escapeHtml(u.phone)}</td>
                    <td class="p-3 text-slate-400">${escapeHtml(u.address)}</td>
                    <td class="p-3 text-center">
                        <button onclick="showUserRepairs(${u.id})" class="bg-yellow-500/10 hover:bg-yellow-500 text-yellow-400 hover:text-slate-950 border border-yellow-500/30 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition flex items-center gap-1 mx-auto">
                            <i class="fa-solid fa-wrench"></i>
                            <span>صيانة (${repairCount})</span>
                        </button>
                    </td>
                    <td class="p-3 text-center">
                        <button onclick="showUserTrades(${u.id})" class="bg-blue-500/10 hover:bg-blue-500 text-blue-400 hover:text-slate-950 border border-blue-500/30 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition flex items-center gap-1 mx-auto">
                            <i class="fa-solid fa-arrows-rotate"></i>
                            <span>تقييم/بيع (${tradeCount})</span>
                        </button>
                    </td>
                    <td class="p-3 text-center">
                        <button onclick="showUserInterests(${u.id})" class="bg-emerald-500/10 hover:bg-emerald-500 text-emerald-400 hover:text-slate-950 border border-emerald-500/30 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition flex items-center gap-1 mx-auto">
                            <i class="fa-solid fa-magnifying-glass"></i>
                            <span>الاهتمامات (${interestCount})</span>
                        </button>
                    </td>
                    <td class="p-3 text-center">${deleteButton}</td>
                </tr>
            `;
        });
    } catch (error) {
        tableBody.innerHTML = `<tr><td colspan="9" class="text-center py-8 text-red-400">تعذر جلب بيانات العملاء.</td></tr>`;
    }
}

async function deleteCustomerAccount(userId) {
    const customer = allUsersCache.find(user => Number(user.id) === Number(userId));
    if (!customer || customer.is_deleted) return;
    const confirmed = confirm(`سيتم تعطيل حساب «${customer.name}» (${customer.email}) وحذف بيانات الملف الشخصية. ستظل الطلبات وسجلات المعاملات محفوظة. هل تريد المتابعة؟`);
    if (!confirmed) return;
    try {
        const response = await fetch(`${API_URL}/admin/users/${Number(userId)}`, { method: 'DELETE', headers: adminHeaders(false) });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.detail || `Delete failed: ${response.status}`);
        }
        await loadAdminUsers();
        showToast('تم تعطيل الحساب وإخفاء بياناته الشخصية مع الاحتفاظ بسجلات الطلبات.', 'success');
    } catch (error) {
        console.error(error);
        showToast(error.message || 'تعذر حذف الحساب.', 'error');
    }
}

function showUserRepairs(userId) {
    const user = allUsersCache.find(u => u.id === userId);
    if (!user) return;

    document.getElementById('details-modal-title').innerHTML = `<i class="fa-solid fa-wrench text-yellow-400"></i> طلبات صيانة العميل: ${escapeHtml(user.name)} (${escapeHtml(user.email)})`;
    const modalBody = document.getElementById('details-modal-body');

    if (!user.repairs || user.repairs.length === 0) {
        modalBody.innerHTML = `<div class="p-4 text-center text-slate-500">لا توجد طلبات صيانة لهذا العميل.</div>`;
    } else {
        modalBody.innerHTML = user.repairs.map(r => {
            const isDelivered = r.status === "تم التسليم";
            const deleteBtn = isDelivered 
                ? `<button onclick="deleteRepair(${r.id}, ${userId})" class="bg-red-500/10 hover:bg-red-500 text-red-400 hover:text-white px-2.5 py-1 rounded-lg text-[11px] font-bold border border-red-500/30 transition flex items-center gap-1">
                    <i class="fa-solid fa-trash"></i> مسح الطلب
                   </button>` 
                : '';

            return `
                <div class="bg-slate-950 border border-slate-800 p-3.5 rounded-xl space-y-2">
                    <div class="flex items-center justify-between gap-2">
                        <span class="font-bold text-slate-200">🎮 الجهاز: ${escapeHtml(r.device_type)}</span>
                        <div class="flex items-center gap-2">
                            <select onchange="updateRepairStatus(${r.id}, this.value, ${userId})" class="bg-slate-900 border border-slate-700 text-yellow-400 text-[11px] font-bold rounded-lg px-2 py-1 focus:outline-none focus:border-yellow-500 cursor-pointer">
                                <option value="قيد الفحص" ${r.status === 'قيد الفحص' ? 'selected' : ''}>قيد الفحص</option>
                                <option value="تم الاصلاح" ${r.status === 'تم الاصلاح' ? 'selected' : ''}>تم الاصلاح</option>
                                <option value="تم التسليم" ${r.status === 'تم التسليم' ? 'selected' : ''}>تم التسليم</option>
                            </select>
                            ${deleteBtn}
                        </div>
                    </div>
                    <p class="text-slate-400">📞 الهاتف: ${escapeHtml(r.phone)}</p>
                    <p class="text-slate-300">📝 المشكلة: ${escapeHtml(r.issue_description)}</p>
                    <p class="text-[10px] text-slate-500 font-mono">📅 التاريخ: ${escapeHtml(r.created_at)}</p>
                </div>
            `;
        }).join('');
    }

    document.getElementById('details-modal').classList.remove('hidden');
}

async function updateRepairStatus(repairId, newStatus, userId) {
    try {
        const res = await fetch(`${API_URL}/repairs/${repairId}/status`, {
            method: 'PUT',
            headers: adminHeaders(),
            body: JSON.stringify({ status: newStatus })
        });
        if (res.ok) {
            await loadAdminUsers();
            showUserRepairs(userId);
        }
    } catch (err) {
        showToast('حدث خطأ أثناء تحديث حالة الصيانة.', 'error');
    }
}

async function deleteRepair(repairId, userId) {
    if (!confirm('هل أنت تأكد من مسح طلب الصيانة هذا نهائياً من قاعدة البيانات؟')) return;

    try {
        const res = await fetch(`${API_URL}/repairs/${repairId}`, { method: 'DELETE', headers: adminHeaders(false) });
        if (res.ok) {
            await loadAdminUsers();
            showUserRepairs(userId);
        }
    } catch (err) {
        showToast('حدث خطأ أثناء مسح طلب الصيانة.', 'error');
    }
}

function showUserTrades(userId) {
    const user = allUsersCache.find(u => u.id === userId);
    if (!user) return;

    document.getElementById('details-modal-title').innerHTML = `<i class="fa-solid fa-arrows-rotate text-blue-400"></i> طلبات تقييم واستبدال العميل: ${escapeHtml(user.name)} (${escapeHtml(user.email)})`;
    const modalBody = document.getElementById('details-modal-body');

    if (!user.trades || user.trades.length === 0) {
        modalBody.innerHTML = `<div class="p-4 text-center text-slate-500">لا توجد طلبات تقييم لهذا العميل.</div>`;
    } else {
        modalBody.innerHTML = user.trades.map(t => {
            const isDelivered = t.status === "تم التسليم";
            const deleteBtn = isDelivered 
                ? `<button onclick="deleteTrade(${t.id}, ${userId})" class="bg-red-500/10 hover:bg-red-500 text-red-400 hover:text-white px-2.5 py-1 rounded-lg text-[11px] font-bold border border-red-500/30 transition flex items-center gap-1">
                    <i class="fa-solid fa-trash"></i> مسح الطلب
                   </button>` 
                : '';

            return `
                <div class="bg-slate-950 border border-slate-800 p-3.5 rounded-xl space-y-2">
                    <div class="flex items-center justify-between gap-2">
                        <span class="font-bold text-slate-200">📦 الجهاز: ${escapeHtml(t.item_details)}</span>
                        <div class="flex items-center gap-2">
                            <select onchange="updateTradeStatus(${t.id}, this.value, ${userId})" class="bg-slate-900 border border-slate-700 text-blue-400 text-[11px] font-bold rounded-lg px-2 py-1 focus:outline-none focus:border-blue-500 cursor-pointer">
                                <option value="قيد التقييم" ${t.status === 'قيد التقييم' ? 'selected' : ''}>قيد التقييم</option>
                                <option value="تم التقييم" ${t.status === 'تم التقييم' ? 'selected' : ''}>تم التقييم</option>
                                <option value="تم التسليم" ${t.status === 'تم التسليم' ? 'selected' : ''}>تم التسليم</option>
                            </select>
                            ${deleteBtn}
                        </div>
                    </div>
                    <p class="text-slate-300">📋 الحالة والمشتملات: ${escapeHtml(t.condition_details)}</p>
                    <p class="text-[10px] text-slate-500 font-mono">📅 التاريخ: ${escapeHtml(t.created_at)}</p>
                </div>
            `;
        }).join('');
    }

    document.getElementById('details-modal').classList.remove('hidden');
}

async function updateTradeStatus(tradeId, newStatus, userId) {
    try {
        const res = await fetch(`${API_URL}/trades/${tradeId}/status`, {
            method: 'PUT',
            headers: adminHeaders(),
            body: JSON.stringify({ status: newStatus })
        });
        if (res.ok) {
            await loadAdminUsers();
            showUserTrades(userId);
        }
    } catch (err) {
        showToast('حدث خطأ أثناء تحديث حالة التقييم.', 'error');
    }
}

async function deleteTrade(tradeId, userId) {
    if (!confirm('هل أنت تأكد من مسح طلب التقييم هذا نهائياً من قاعدة البيانات؟')) return;

    try {
        const res = await fetch(`${API_URL}/trades/${tradeId}`, { method: 'DELETE', headers: adminHeaders(false) });
        if (res.ok) {
            await loadAdminUsers();
            showUserTrades(userId);
        }
    } catch (err) {
        showToast('حدث خطأ أثناء مسح طلب التقييم.', 'error');
    }
}

function showUserInterests(userId) {
    const user = allUsersCache.find(u => u.id === userId);
    if (!user) return;

    document.getElementById('details-modal-title').innerHTML = `<i class="fa-solid fa-magnifying-glass text-emerald-400"></i> سجل البحث والاهتمامات: ${escapeHtml(user.name)} (${escapeHtml(user.email)})`;
    const modalBody = document.getElementById('details-modal-body');
    if (!user.interests || user.interests.length === 0) {
        modalBody.innerHTML = `<div class="p-4 text-center text-slate-500">لا يوجد سجل بحث أو اهتمامات لهذا العميل بعد.</div>`;
    } else {
        modalBody.innerHTML = `
            <div class="space-y-2">
                ${user.interests.map(i => {
                    const kind = i.type === 'search' ? 'بحث' : i.type === 'product' ? 'منتج' : 'اهتمام سابق';
                    return `
                    <div class="bg-slate-950 border border-slate-800 p-3 rounded-xl flex items-center justify-between gap-3">
                        <div class="flex items-center gap-2 min-w-0">
                            <button data-delete-interest="${userId}" data-interest-id="${Number(i.id) || 0}" data-interest="${escapeHtml(i.item)}" class="delete-interest-button text-rose-500 hover:text-white hover:bg-rose-500 p-1.5 rounded-lg transition text-xs flex items-center justify-center shrink-0" title="حذف هذا الاهتمام"><i class="fa-solid fa-xmark"></i></button>
                            <div class="min-w-0"><span class="text-[10px] text-emerald-400">${kind}</span><p class="font-semibold text-slate-200 break-words">${escapeHtml(i.item)}</p></div>
                        </div>
                        <span class="text-[10px] text-slate-500 shrink-0">${escapeHtml(i.created_at || 'تاريخ غير متاح')}</span>
                    </div>`;
                }).join('')}
            </div>`;
        modalBody.querySelectorAll('.delete-interest-button').forEach(button => {
            button.addEventListener('click', () => deleteInterest(Number(button.dataset.deleteInterest), button.dataset.interest, Number(button.dataset.interestId) || null));
        });
    }
    document.getElementById('details-modal').classList.remove('hidden');
}

async function loadAdminRatings() {
    const tableBody = document.getElementById('admin-ratings-table');
    if (!tableBody) return;
    try {
        const response = await fetch(`${API_URL}/admin/ratings`, { headers: adminHeaders(false) });
        if (!response.ok) throw new Error(`Review request failed: ${response.status}`);
        const ratings = await response.json();
        allRatingsCache = ratings;
        if (!ratings.length) {
            tableBody.innerHTML = '<tr><td colspan="6" class="text-center py-6 text-slate-500">لا توجد تقييمات بعد.</td></tr>';
            return;
        }
        tableBody.innerHTML = ratings.map(review => {
            const stars = Math.max(0, Math.min(5, Number(review.stars) || 0));
            const productLabel = review.rating_type === 'product' && review.product_id
                ? escapeHtml(review.product_name)
                : `<span class="text-slate-400">${escapeHtml(review.product_name || 'تقييم قديم غير مرتبط بمنتج')}</span><span class="block text-[10px] text-slate-500">لا يتوفر معرّف موثوق لربطه بمنتج</span>`;
            return `<tr class="hover:bg-slate-950/50"><td class="p-3 text-slate-200">${escapeHtml(review.customer_name)}</td><td class="p-3 text-cyan-300">${productLabel}</td><td class="p-3 text-amber-400">${'★'.repeat(stars)}${'☆'.repeat(5-stars)}</td><td class="p-3 text-slate-300 whitespace-pre-line">${escapeHtml(review.comment || '—')}</td><td class="p-3 text-slate-500">${escapeHtml(review.created_at || '')}</td><td class="p-3 text-center"><button type="button" onclick="deleteAdminRating(${Number(review.id)})" class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-[11px] font-bold text-rose-300 transition hover:bg-rose-500 hover:text-white"><i class="fa-solid fa-trash"></i> حذف التقييم</button></td></tr>`;
        }).join('');
    } catch (error) {
        tableBody.innerHTML = '<tr><td colspan="6" class="text-center py-6 text-rose-400">تعذر تحميل التقييمات.</td></tr>';
    }
}

async function deleteAdminRating(ratingId) {
    const review = allRatingsCache.find(item => Number(item.id) === Number(ratingId));
    if (!review) return;
    const target = review.product_id ? `المنتج «${review.product_name}»` : 'تقييم قديم غير مرتبط بمنتج';
    if (!confirm(`حذف تقييم ${review.stars} نجوم للعميل «${review.customer_name}» (${target})؟`)) return;
    try {
        const response = await fetch(`${API_URL}/admin/ratings/${Number(ratingId)}`, { method: 'DELETE', headers: adminHeaders(false) });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.detail || `Delete failed: ${response.status}`);
        }
        await loadAdminRatings();
        showToast('تم حذف التقييم وتحديث القائمة. ستُحسب إحصائيات المنتج من التقييمات المتبقية.', 'success');
    } catch (error) {
        console.error(error);
        showToast(error.message || 'تعذر حذف التقييم.', 'error');
    }
}

async function deleteInterest(userId, category, interestId = null) {
    try {
        const res = await fetch(`${API_URL}/users/${userId}/interest`, {
            method: 'DELETE',
            headers: adminHeaders(),
            body: JSON.stringify({ category: category, interest_id: interestId })
        });

        if (res.ok) {
            await loadAdminUsers();
            showUserInterests(userId);
        } else {
            showToast('تعذر مسح الاهتمام.', 'error');
        }
    } catch (err) {
        showToast('حدث خطأ أثناء مسح الاهتمام.', 'error');
    }
}

function closeDetailsModal() {
    document.getElementById('details-modal').classList.add('hidden');
}
