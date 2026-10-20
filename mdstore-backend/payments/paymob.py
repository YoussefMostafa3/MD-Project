"""Paymob Intention API checkout and Transaction Processed callback helpers."""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import logging
import os
import re
from decimal import Decimal, ROUND_HALF_UP
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen


PAYMOB_BASE_URL = "https://accept.paymob.com"
logger = logging.getLogger(__name__)


def _safe_provider_error(body: bytes, billing_data: dict[str, str]) -> str:
    """Extract and sanitize a short provider error without logging request data."""
    try:
        decoded = json.loads(body[:16_384].decode("utf-8", errors="replace"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return "Provider returned a non-JSON error body"
    if not isinstance(decoded, dict):
        return "Provider returned an unrecognized error body"
    message = next(
        (decoded.get(key) for key in ("detail", "message", "error", "code")
         if isinstance(decoded.get(key), str)),
        None,
    )
    if message is None:
        return "Provider returned an unrecognized error body"

    # Remove known credentials and all request billing values before logging.
    sensitive_values = [
        value for key, value in os.environ.items()
        if ("PAYMOB" in key.upper() or any(word in key.upper() for word in ("SECRET", "API_KEY", "PUBLIC_KEY", "HMAC")))
        and isinstance(value, str) and value
    ]
    sensitive_values.extend(value for value in billing_data.values() if isinstance(value, str) and value)
    for value in sorted(set(sensitive_values), key=len, reverse=True):
        message = message.replace(value, "[redacted]")
    message = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[redacted-email]", message)
    message = re.sub(r"(?i)(authorization|api[-_ ]?key|secret(?:[-_ ]?key)?|public[-_ ]?key|hmac|token)\s*[:=]?\s*\S+", r"\1=[redacted]", message)
    message = re.sub(r"(?<!\w)(?:\+?\d[\d ()-]{6,}\d)(?!\w)", "[redacted-number]", message)
    message = "".join(char if char.isprintable() else " " for char in message)
    return message[:300] or "Provider returned an empty error message"


class PaymobNotConfigured(RuntimeError):
    """Raised when required merchant settings are missing or invalid."""


class PaymobProviderError(RuntimeError):
    """Raised when Paymob does not create a usable payment intention."""


def _setting(name: str) -> str:
    return os.environ.get(name, "").strip()


def paymob_checkout_configured() -> bool:
    """Return whether the hosted checkout and its server callback can be used."""
    required = (
        "PAYMOB_SECRET_KEY",
        "PAYMOB_HMAC_SECRET",
        "PAYMOB_INTEGRATION_ID",
        "PAYMOB_PUBLIC_KEY",
        "PAYMOB_NOTIFICATION_URL",
    )
    if any(not _setting(name) for name in required):
        return False
    try:
        int(_setting("PAYMOB_INTEGRATION_ID"))
    except ValueError:
        return False
    notification_url = _setting("PAYMOB_NOTIFICATION_URL")
    try:
        parsed = urlsplit(notification_url)
    except ValueError:
        return False
    hostname = parsed.hostname
    if not hostname:
        return False
    try:
        if not ipaddress.ip_address(hostname).is_global:
            return False
    except ValueError:
        if hostname == "localhost" or hostname.endswith(".localhost") or "." not in hostname:
            return False
    return (
        parsed.scheme == "https"
        and parsed.path.rstrip("/").endswith("/payments/paymob/callback")
    )


def _required_config() -> tuple[str, str, int, str, str]:
    if not paymob_checkout_configured():
        raise PaymobNotConfigured("Paymob checkout settings are incomplete")
    return (
        _setting("PAYMOB_SECRET_KEY"),
        _setting("PAYMOB_PUBLIC_KEY"),
        int(_setting("PAYMOB_INTEGRATION_ID")),
        _setting("PAYMOB_NOTIFICATION_URL"),
        _setting("PAYMOB_HMAC_SECRET"),
    )


def _cents(value: Decimal) -> int:
    if not value.is_finite() or value <= 0:
        raise ValueError("Invalid payment amount")
    cents = (value * Decimal("100")).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    if value != cents / Decimal("100"):
        raise ValueError("Payment amount must have no more than two decimal places")
    return int(cents)


def create_paymob_checkout_session(
    *,
    order_id: int,
    amount: Decimal,
    currency: str = "EGP",
    items: list[dict[str, Any]],
    billing_data: dict[str, str],
) -> dict[str, Any]:
    """Create a Paymob Intention and return its hosted Unified Checkout URL.

    Amount and line items are expected to be prepared by the backend from its
    persisted order snapshot. PAYMOB_API_KEY is intentionally not sent: the
    documented Intention API authenticates with the distinct Secret Key.
    """
    secret_key, public_key, integration_id, notification_url, _ = _required_config()
    if order_id <= 0 or currency != "EGP":
        raise ValueError("Invalid payment session details")
    amount_cents = _cents(amount)
    if not items or not billing_data.get("phone_number"):
        raise ValueError("Paymob requires order items and a customer phone number")
    try:
        items_total_cents = sum(int(item["amount"]) for item in items)
    except (KeyError, TypeError, ValueError):
        raise ValueError("Paymob items must include valid amounts") from None
    if items_total_cents != amount_cents:
        raise ValueError("Paymob item amounts must match the order total")

    payload = {
        "amount": amount_cents,
        "currency": currency,
        "payment_methods": [integration_id],
        "items": items,
        "billing_data": billing_data,
        "special_reference": f"MDSTORE-{order_id}",
        "extras": {"mdstore_order_id": str(order_id)},
        "notification_url": notification_url,
    }
    redirection_url = _setting("PAYMOB_REDIRECTION_URL")
    if redirection_url:
        if not redirection_url.startswith("https://"):
            raise PaymobNotConfigured("PAYMOB_REDIRECTION_URL must use HTTPS")
        payload["redirection_url"] = redirection_url

    request = Request(
        f"{PAYMOB_BASE_URL}/v1/intention/",
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers={
            "Authorization": f"Token {secret_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=20) as response:
            response_data = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        try:
            safe_message = _safe_provider_error(exc.read(16_384), billing_data)
        finally:
            exc.close()
        logger.warning("Paymob Intention request failed (HTTP %s): %s", exc.code, safe_message)
        # Provider details are for diagnostics only; clients receive a generic error.
        raise PaymobProviderError("Paymob could not create the payment session") from None
    except (URLError, TimeoutError, json.JSONDecodeError):
        raise PaymobProviderError("Paymob could not create the payment session") from None

    client_secret = response_data.get("client_secret")
    provider_order_id = response_data.get("intention_order_id")
    intention_id = response_data.get("id")
    try:
        provider_order_id = int(provider_order_id)
    except (TypeError, ValueError):
        provider_order_id = 0
    if not isinstance(client_secret, str) or not client_secret or provider_order_id <= 0 or not intention_id:
        raise PaymobProviderError("Paymob returned an incomplete payment session")
    checkout_url = f"{PAYMOB_BASE_URL}/unifiedcheckout/?{urlencode({'publicKey': public_key, 'clientSecret': client_secret})}"
    return {
        "checkout_url": checkout_url,
        "intention_id": str(intention_id),
        "paymob_order_id": provider_order_id,
        "amount_cents": amount_cents,
        "currency": currency,
        "integration_id": integration_id,
    }


HMAC_TRANSACTION_FIELDS = (
    ("amount_cents",),
    ("created_at",),
    ("currency",),
    ("error_occured",),
    ("has_parent_transaction",),
    ("id",),
    ("integration_id",),
    ("is_3d_secure",),
    ("is_auth",),
    ("is_capture",),
    ("is_refunded",),
    ("is_standalone_payment",),
    ("is_voided",),
    ("order", "id"),
    ("owner",),
    ("pending",),
    ("source_data", "pan"),
    ("source_data", "sub_type"),
    ("source_data", "type"),
    ("success",),
)


def _callback_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None or isinstance(value, (dict, list)):
        raise ValueError("Callback contains an unsupported HMAC value")
    return str(value)


def verify_paymob_webhook(payload: dict[str, Any], signature: str) -> bool:
    """Verify Paymob Transaction Processed callbacks (POST body.obj, SHA-512)."""
    secret = _setting("PAYMOB_HMAC_SECRET")
    if not secret or not isinstance(signature, str) or len(signature) != 128:
        return False
    obj = payload.get("obj") if isinstance(payload, dict) else None
    if not isinstance(obj, dict):
        return False
    try:
        parts: list[str] = []
        for path in HMAC_TRANSACTION_FIELDS:
            value: Any = obj
            for key in path:
                if not isinstance(value, dict) or key not in value:
                    return False
                value = value[key]
            parts.append(_callback_value(value))
        message = "".join(parts).encode("utf-8")
    except (TypeError, ValueError):
        return False
    expected = hmac.new(secret.encode("utf-8"), message, hashlib.sha512).hexdigest()
    return hmac.compare_digest(expected, signature)
