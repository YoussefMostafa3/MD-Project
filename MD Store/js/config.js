// Shared API origin for the storefront and admin dashboard. Set
// window.MDSTORE_API_URL before this file when the backend is hosted elsewhere.
const isMdStoreGateway =
    (window.location.hostname === '127.0.0.1' && window.location.port === '8080') ||
    window.location.hostname === 'reclusive-caliber-purplish.ngrok-free.dev';
const defaultApiOrigin = isMdStoreGateway
    ? window.location.origin
    : `${window.location.protocol === 'file:' ? 'http:' : window.location.protocol}//${window.location.hostname || '127.0.0.1'}:8000`;
window.MDSTORE_API_URL = String(window.MDSTORE_API_URL || defaultApiOrigin).replace(/\/$/, '');
