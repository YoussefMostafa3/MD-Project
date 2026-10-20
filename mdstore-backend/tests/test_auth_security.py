import os
import json
import hashlib
import hmac
import io
import sqlite3
import sys
import tempfile
import types
import unittest
import uuid
import importlib.machinery
from datetime import datetime
from decimal import Decimal
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

from fastapi import HTTPException
from pydantic import ValidationError


TEST_ROOT = tempfile.TemporaryDirectory(prefix=".mdstore-auth-test-", dir=Path(__file__).resolve().parent)
TEST_DIR = Path(TEST_ROOT.name)
TEST_DB = TEST_DIR / "legacy_test.db"
TEST_UPLOADS = TEST_DIR / "uploads"

# Seed only synthetic legacy data before importing the app. This proves the
# additive migration against the old users table without touching mdstore.db.
connection = sqlite3.connect(TEST_DB)
try:
    connection.execute(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL UNIQUE, "
        "email VARCHAR NOT NULL UNIQUE, password VARCHAR, phone VARCHAR UNIQUE, address VARCHAR)"
    )
    connection.execute(
        "CREATE TABLE admin_accounts (id INTEGER PRIMARY KEY, username VARCHAR(180) NOT NULL UNIQUE, "
        "password_hash VARCHAR(256) NOT NULL, is_active BOOLEAN NOT NULL DEFAULT 1, created_at DATETIME NOT NULL)"
    )
    connection.execute(
        "INSERT INTO users (id, name, email, password, phone, address) VALUES (?, ?, ?, ?, ?, ?)",
        (1, "LegacyCustomer", "legacy@example.test", "legacy-passphrase", "10000000001", "Test address"),
    )
    connection.execute(
        "INSERT INTO users (id, name, email, password, phone, address) VALUES (?, ?, ?, ?, ?, ?)",
        (2, "LegacyDefault", "default@example.test", "123456", "10000000002", "Test address"),
    )
    connection.execute(
        "CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, customer_name VARCHAR NOT NULL, "
        "phone VARCHAR, address VARCHAR, total_price FLOAT NOT NULL, status VARCHAR NOT NULL, created_at DATETIME NOT NULL)"
    )
    connection.execute(
        "INSERT INTO orders (id, user_id, customer_name, phone, address, total_price, status, created_at) "
        "VALUES (900, 1, 'Legacy Recipient', '10000000001', 'Legacy delivery address', 75.5, 'completed', '2025-01-01 10:00:00')"
    )
    connection.execute(
        "CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, product_id INTEGER, "
        "product_name VARCHAR NOT NULL, variant VARCHAR, unit_price FLOAT NOT NULL, quantity INTEGER NOT NULL, line_total FLOAT NOT NULL)"
    )
    connection.execute("CREATE TABLE ratings (id INTEGER PRIMARY KEY, user_id INTEGER, stars INTEGER NOT NULL, comment VARCHAR, created_at DATETIME)")
    connection.execute("INSERT INTO ratings (id, user_id, stars, comment, created_at) VALUES (70, 1, 4, 'Legacy review', '2025-01-02 10:00:00')")
    connection.execute("CREATE TABLE user_interests (id INTEGER PRIMARY KEY, user_id INTEGER, category VARCHAR NOT NULL, views_count INTEGER)")
    connection.execute("INSERT INTO user_interests (id, user_id, category, views_count) VALUES (80, 1, 'Legacy category', 3)")
    connection.commit()
finally:
    connection.close()

os.environ["MDSTORE_DATABASE_URL"] = f"sqlite:///{TEST_DB.as_posix()}"
os.environ["MDSTORE_UPLOADS_DIR"] = str(TEST_UPLOADS)
os.environ["MDSTORE_AUTH_SECRET"] = "test-only-signing-key-" + uuid.uuid4().hex
os.environ["MDSTORE_SHIPPING_FEES_JSON"] = json.dumps({"Cairo": {"fee": 15.5, "label_ar": "القاهرة", "label_en": "Cairo"}})
os.environ["MDSTORE_PAYMENT_METHODS_JSON"] = json.dumps(["manual", "cash_on_delivery"])
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# The environment has no python-multipart package. FastAPI checks this marker
# while registering the existing upload route; upload bodies are not parsed in
# these tests. Production dependencies are documented in requirements.txt.
multipart_stub = types.ModuleType("python_multipart")
multipart_stub.__version__ = "0.0.20"
multipart_stub.__spec__ = importlib.machinery.ModuleSpec("python_multipart", loader=None)
sys.modules.setdefault("python_multipart", multipart_stub)

import main  # noqa: E402
from payments.paymob import PaymobNotConfigured, create_paymob_checkout_session, verify_paymob_webhook  # noqa: E402
import payments.paymob as paymob  # noqa: E402


def api_request(method, path, *, token=None, payload=None, idempotency_key=None, origin=None, extra_headers=None):
    """Invoke FastAPI endpoint functions with their real database/auth dependencies.

    This preserves request schemas, endpoint business logic and authorization. The Windows
    sandbox cannot initialize asyncio's local socket-pair, so ASGI transport is unavailable.
    """
    try:
        claims = main.decode_access_token(token) if token else None
        with main.SessionLocal() as db:
            if path == "/delivery/options" and method == "GET":
                return 200, main.get_delivery_options(), {}
            if path == "/orders" and method == "POST":
                current = main.get_current_customer(claims, db) if claims else main.authenticated_claims(None)
                data = main.OrderCreate.model_validate(payload or {})
                return 200, main.create_order(data, idempotency_key, db, current), {}
            if path.startswith("/users/") and path.endswith("/orders") and method == "GET":
                current = main.get_current_customer(claims, db) if claims else main.authenticated_claims(None)
                user_id = int(path.split("/")[2])
                return 200, main.get_customer_orders(user_id, db, current), {}
            if path.startswith("/admin/orders/") and path.endswith("/status") and method == "PUT":
                admin = main.require_admin(claims, db) if claims else main.authenticated_claims(None)
                order_id = int(path.split("/")[3])
                return 200, main.update_order_status(order_id, main.OrderStatusUpdate.model_validate(payload or {}), db, admin), {}
            if path == "/admin/orders" and method == "GET":
                admin = main.require_admin(claims, db) if claims else main.authenticated_claims(None)
                return 200, main.get_all_orders(db, admin), {}
            if path.startswith("/admin/orders/") and path.endswith("/payment") and method == "POST":
                admin = main.require_admin(claims, db) if claims else main.authenticated_claims(None)
                order_id = int(path.split("/")[3])
                return 200, main.record_order_payment(order_id, main.PaymentCollectionUpdate.model_validate(payload or {}), db, admin), {}
            if path == "/chat/send" and method == "POST":
                customer = main.get_current_customer(claims, db) if claims else main.authenticated_claims(None)
                return 200, main.send_chat_message(main.ChatMessageCreate.model_validate(payload or {}), db, customer), {}
            if path.startswith("/chat/messages/") and method == "GET":
                customer = main.get_current_customer(claims, db) if claims else main.authenticated_claims(None)
                session_id = path.rsplit("/", 1)[1]
                return 200, main.get_chat_messages(session_id, None, db, customer), {}
            if path.startswith("/users/") and path.endswith("/interest") and method == "POST":
                customer = main.get_current_customer(claims, db) if claims else main.authenticated_claims(None)
                user_id = int(path.split("/")[2])
                data = main.TrackInterestCategory.model_validate(payload or {})
                return 200, main.track_user_interest(user_id, data, db, customer), {}
            if path == "/ratings" and method == "POST":
                customer = main.get_current_customer(claims, db) if claims else main.authenticated_claims(None)
                data = main.RatingCreate.model_validate(payload or {})
                return 200, main.create_rating(data, db, customer), {}
            if path.startswith("/products/") and path.endswith("/ratings") and method == "GET":
                product_id = int(path.split("/")[2])
                return 200, main.get_product_ratings(product_id, db), {}
            if path == "/admin/ratings" and method == "GET":
                admin = main.require_admin(claims, db) if claims else main.authenticated_claims(None)
                return 200, main.get_admin_ratings(db, admin), {}
            if path.startswith("/admin/ratings/") and method == "DELETE":
                admin = main.require_admin(claims, db) if claims else main.authenticated_claims(None)
                rating_id = int(path.rsplit("/", 1)[1])
                return 200, main.delete_admin_rating(rating_id, db, admin), {}
            if path.startswith("/admin/users/") and method == "DELETE":
                admin = main.require_admin(claims, db) if claims else main.authenticated_claims(None)
                user_id = int(path.rsplit("/", 1)[1])
                return 200, main.delete_admin_user(user_id, db, admin), {}
            if path == "/admin/users" and method == "GET":
                admin = main.require_admin(claims, db) if claims else main.authenticated_claims(None)
                return 200, main.get_all_users_for_admin(db, admin), {}
            if path == "/admin/chats" and method == "GET":
                admin = main.require_admin(claims, db) if claims else main.authenticated_claims(None)
                return 200, main.get_admin_chats(db, admin), {}
            if path == "/admin/chats/read" and method == "POST":
                admin = main.require_admin(claims, db) if claims else main.authenticated_claims(None)
                return 200, main.mark_admin_chat_read(main.AdminChatRead.model_validate(payload or {}), db, admin), {}
            return 404, {"detail": "Test route not mapped"}, {}
    except ValidationError as exc:
        return 422, {"detail": exc.errors(include_url=False)}, {}
    except HTTPException as exc:
        return exc.status_code, {"detail": exc.detail}, {}


class AuthSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        main.create_first_admin("test-admin", "test-admin-password-9482")
        with main.SessionLocal() as db:
            admin = db.query(main.AdminDB).filter_by(username="test-admin").one()
            cls.admin_id = admin.id
            status_code = main.admin_login(main.AdminLogin(username="test-admin", password="test-admin-password-9482"), db)
            cls.admin_token = status_code["token"]
            cls.admin = admin

    @classmethod
    def tearDownClass(cls):
        main.engine.dispose()
        TEST_ROOT.cleanup()

    def setUp(self):
        with main.SessionLocal() as db:
            db.query(main.PaymobPaymentAttemptDB).delete(synchronize_session=False)
            db.query(main.OrderItemDB).filter(main.OrderItemDB.order_id != 900).delete(synchronize_session=False)
            db.query(main.OrderDB).filter(main.OrderDB.id != 900).delete(synchronize_session=False)
            db.query(main.ProductVariantDB).delete()
            db.query(main.ProductDB).delete()
            db.commit()
            product = main.ProductDB(
                name=f"Test Product {uuid.uuid4().hex[:10]}", price=20.0, stock=6,
                category="Test", is_active=True,
            )
            db.add(product)
            db.commit()
            db.refresh(product)
            self.product_id = product.id
            admin = db.query(main.AdminDB).filter_by(username="test-admin").one()
            self.admin_token = main.create_access_token(admin.id, "admin", admin.token_version)

    def order_data(self, product_id=None, quantity=1, **overrides):
        values = {
            "recipient_name": "Synthetic Recipient",
            "phone": "10000000123",
            "address": "Synthetic full delivery address",
            "delivery_area": "القاهرة",
            "items": [main.OrderItemCreate(product_id=product_id or self.product_id, quantity=quantity)],
        }
        values.update(overrides)
        return main.OrderCreate(**values)

    def register_customer(self, name):
        suffix = uuid.uuid4().hex[:10]
        payload = main.UserCreate(
            name=f"{name}-{suffix}", email=f"{name}-{suffix}@example.test",
            phone=f"2{uuid.uuid4().int % 10**10:010d}", address="Isolated test address",
            password="customer-passphrase-81",
        )
        with main.SessionLocal() as db:
            result = main.create_or_get_user(payload, db)
        self.assertIn("token", result)
        self.assertNotIn("password", result)
        with main.SessionLocal() as db:
            stored = db.query(main.UserDB).filter_by(id=result["id"]).one()
            self.assertEqual(stored.password, "")
            self.assertNotEqual(stored.password_hash, payload.password)
        return result

    def test_legacy_accounts_are_preserved_and_plaintext_is_cleared(self):
        with main.SessionLocal() as db:
            legacy = db.query(main.UserDB).filter_by(email="legacy@example.test").one()
            default = db.query(main.UserDB).filter_by(email="default@example.test").one()
            self.assertEqual(legacy.password, "")
            self.assertTrue(main.verify_password("legacy-passphrase", legacy.password_hash))
            self.assertEqual(default.password, "")
            self.assertIsNone(default.password_hash)
            self.assertEqual(legacy.name, "LegacyCustomer")
            historical = db.query(main.OrderDB).filter_by(id=900).one()
            self.assertEqual(historical.customer_name, "Legacy Recipient")
            self.assertEqual(historical.total_price, 75.5)
            self.assertEqual(historical.payment_status, "unpaid")
            admin_columns = {column["name"] for column in main.inspect(main.engine).get_columns("admin_accounts")}
            self.assertIn("token_version", admin_columns)
            order_columns = {column["name"] for column in main.inspect(main.engine).get_columns("orders")}
            self.assertTrue({"delivery_area", "shipping_fee", "idempotency_key", "payment_status"}.issubset(order_columns))
            item_columns = {column["name"] for column in main.inspect(main.engine).get_columns("order_items")}
            self.assertTrue({"variant_id", "platform", "edition"}.issubset(item_columns))
            self.assertTrue({"is_deleted", "deleted_at"}.issubset({column["name"] for column in main.inspect(main.engine).get_columns("users")}))
            rating_columns = {column["name"] for column in main.inspect(main.engine).get_columns("ratings")}
            self.assertIn("product_id", rating_columns)
            legacy_rating = db.query(main.RatingDB).filter_by(id=70).one()
            self.assertEqual(legacy_rating.comment, "Legacy review")
            self.assertIsNone(legacy_rating.product_id)
            interest_columns = {column["name"] for column in main.inspect(main.engine).get_columns("user_interests")}
            self.assertTrue({"interest_type", "normalized_value", "product_id", "created_at"}.issubset(interest_columns))
            legacy_interest = db.query(main.UserInterestDB).filter_by(id=80).one()
            self.assertEqual(legacy_interest.category, "Legacy category")
            self.assertEqual(legacy_interest.interest_type, "category")

    def test_missing_and_invalid_customer_passwords_are_rejected(self):
        with self.assertRaises(ValidationError):
            main.UserLogin.model_validate({"identifier": "legacy@example.test"})
        with main.SessionLocal() as db:
            with self.assertRaises(HTTPException) as missing:
                main.authenticated_claims(None)
            self.assertEqual(missing.exception.status_code, 401)
            with self.assertRaises(HTTPException) as invalid:
                main.user_login(main.UserLogin(identifier="legacy@example.test", password="wrong-passphrase"), db)
            self.assertEqual(invalid.exception.status_code, 401)
            with self.assertRaises(HTTPException) as old_default:
                main.user_login(main.UserLogin(identifier="default@example.test", password="123456"), db)
            self.assertEqual(old_default.exception.status_code, 401)
            valid = main.user_login(main.UserLogin(identifier="legacy@example.test", password="legacy-passphrase"), db)
            self.assertEqual(valid["id"], 1)
            self.assertTrue(valid["token"])

    def test_customer_registration_login_and_profile_workflow(self):
        customer = self.register_customer("new-customer")
        claims = main.decode_access_token(customer["token"])
        with main.SessionLocal() as db:
            current = main.get_current_customer(claims, db)
            profile = main.get_current_customer_profile(current)
            self.assertEqual(profile["id"], customer["id"])
            login = main.user_login(
                main.UserLogin(identifier=customer["email"], password="customer-passphrase-81"), db
            )
            self.assertEqual(login["id"], customer["id"])
            main.customer_logout(current, db)
            with self.assertRaises(HTTPException) as revoked:
                main.get_current_customer(claims, db)
            self.assertEqual(revoked.exception.status_code, 401)

    def test_customer_order_access_and_identity_are_isolated(self):
        first = self.register_customer("first-customer")
        second = self.register_customer("second-customer")
        first_claims = main.decode_access_token(first["token"])
        second_claims = main.decode_access_token(second["token"])
        with main.SessionLocal() as db:
            first_user = main.get_current_customer(first_claims, db)
            second_user = main.get_current_customer(second_claims, db)
            with self.assertRaises(HTTPException) as anon:
                main.authenticated_claims(None)
            self.assertEqual(anon.exception.status_code, 401)
            with self.assertRaises(HTTPException) as other_orders:
                main.get_customer_orders(first_user.id, db, second_user)
            self.assertEqual(other_orders.exception.status_code, 403)
            with self.assertRaises(HTTPException) as other_interest:
                main.track_user_interest(second_user.id, main.TrackInterestCategory(category="Test"), db, first_user)
            self.assertEqual(other_interest.exception.status_code, 403)
            with self.assertRaises(HTTPException) as forged_repair:
                main.create_repair(main.RepairCreate(user_id=second_user.id, phone="100", device_type="Test", issue_description="Test"), db, first_user)
            self.assertEqual(forged_repair.exception.status_code, 403)
            with self.assertRaises(HTTPException) as forged_trade:
                main.create_trade(main.TradeCreate(user_id=second_user.id, item_details="Test", condition_details="Test"), db, first_user)
            self.assertEqual(forged_trade.exception.status_code, 403)
            forged = self.order_data(user_id=first_user.id)
            with self.assertRaises(HTTPException) as forged_order:
                main.create_order(forged, f"forged-{uuid.uuid4().hex}", db, second_user)
            self.assertEqual(forged_order.exception.status_code, 403)
            self.assertEqual(db.query(main.ProductDB).filter_by(id=self.product_id).one().stock, 6)

            order = main.create_order(
                self.order_data(quantity=2), f"order-{uuid.uuid4().hex}", db, first_user
            )
            self.assertEqual(order["user_id"], first_user.id)
            self.assertEqual(order["total_price"], 55.5)
            self.assertEqual(order["payment_status"], "unpaid")
            self.assertEqual(order["shipping_fee"], 15.5)
            self.assertEqual([item["id"] for item in main.get_customer_orders(first_user.id, db, first_user)], [order["id"]])
            self.assertEqual(main.get_customer_orders(second_user.id, db, second_user), [])
            self.assertEqual(db.query(main.ProductDB).filter_by(id=self.product_id).one().stock, 4)

    def test_admin_customer_roles_and_business_workflow(self):
        customer = self.register_customer("role-customer")
        customer_claims = main.decode_access_token(customer["token"])
        with main.SessionLocal() as db:
            customer_user = main.get_current_customer(customer_claims, db)
            with self.assertRaises(HTTPException) as no_admin:
                main.require_admin({"role": "customer", "sub": str(customer_user.id)}, db)
            self.assertEqual(no_admin.exception.status_code, 403)
            invalid_admin = main.AdminLogin(username="test-admin", password="wrong-admin-password")
            with self.assertRaises(HTTPException) as bad_login:
                main.admin_login(invalid_admin, db)
            self.assertEqual(bad_login.exception.status_code, 401)

            admin = main.require_admin(main.decode_access_token(self.admin_token), db)
            product = main.create_product(
                main.ProductCreate(name=f"Admin Product {uuid.uuid4().hex[:8]}", price=12.5, stock=3, category="Test"),
                db, admin,
            )
            self.assertTrue(product.id)
            order = main.create_order(
                self.order_data(), f"order-{uuid.uuid4().hex}", db, customer_user
            )
            self.assertGreaterEqual(len(main.get_all_orders(db, admin)), 2)
            updated = main.update_order_status(order["id"], main.OrderStatusUpdate(status="confirmed"), db, admin)
            self.assertEqual(updated["status"], "confirmed")
            admin_claims = main.decode_access_token(self.admin_token)
            main.admin_logout(admin, db)
            with self.assertRaises(HTTPException) as revoked:
                main.require_admin(admin_claims, db)
            self.assertEqual(revoked.exception.status_code, 401)

    def test_every_admin_route_has_server_side_admin_dependency(self):
        def contains_admin_dependency(dependant):
            return dependant.call is main.require_admin or any(
                contains_admin_dependency(child) for child in dependant.dependencies
            )

        protected_admin_paths = []
        for route in main.app.routes:
            if not hasattr(route, "dependant"):
                continue
            if route.path.startswith("/admin/") and route.path != "/admin/login":
                protected_admin_paths.append(route.path)
                self.assertTrue(contains_admin_dependency(route.dependant), f"Missing admin dependency: {route.path}")
        self.assertGreaterEqual(len(protected_admin_paths), 10)
        for route in main.app.routes:
            if not hasattr(route, "dependant"):
                continue
            if route.path in {"/upload", "/api/upload"} or route.path in {"/products", "/products/{product_id}"} and route.methods & {"POST", "PUT", "DELETE"}:
                self.assertTrue(contains_admin_dependency(route.dependant), f"Missing admin dependency: {route.path}")

    def test_checkout_endpoint_idempotency_status_and_payment_lifecycle(self):
        customer = self.register_customer("http-order")
        headers = {"authorization": f"Bearer {customer['token']}"}
        unauth_status, _, _ = api_request("POST", "/orders", payload=self.order_data().model_dump(), idempotency_key="unauth-key-001")
        self.assertEqual(unauth_status, 401)

        missing_details = self.order_data().model_dump()
        missing_details.pop("delivery_area")
        missing_status, _, _ = api_request("POST", "/orders", token=customer["token"], payload=missing_details, idempotency_key="missing-fields-1")
        self.assertEqual(missing_status, 422)

        forged = self.order_data(user_id=customer["id"] + 999).model_dump()
        forged_status, _, _ = api_request("POST", "/orders", token=customer["token"], payload=forged, idempotency_key="forged-user-001")
        self.assertEqual(forged_status, 403)

        malicious = self.order_data().model_dump()
        malicious["payment_status"] = "paid"
        malicious_status, _, _ = api_request("POST", "/orders", token=customer["token"], payload=malicious, idempotency_key="client-paid-001")
        self.assertEqual(malicious_status, 422)

        key = "stable-order-key-001"
        payload = self.order_data(quantity=2, payment_method="cash_on_delivery").model_dump()
        status_code, order, _ = api_request("POST", "/orders", token=customer["token"], payload=payload, idempotency_key=key)
        self.assertEqual(status_code, 200)
        self.assertEqual(order["total_price"], 55.5)
        self.assertEqual(order["customer_name"], "Synthetic Recipient")
        self.assertEqual(order["delivery_area"], "القاهرة")
        self.assertEqual(order["shipping_fee"], 15.5)
        self.assertEqual(order["payment_status"], "unpaid")
        self.assertEqual(order["payment_method"], "cash_on_delivery")
        self.assertEqual(order["items"][0]["line_total"], 40.0)

        unavailable_online = self.order_data(payment_method="online_payment_demo").model_dump()
        online_status, _, _ = api_request("POST", "/orders", token=customer["token"], payload=unavailable_online, idempotency_key="online-off-key-001")
        self.assertEqual(online_status, 422)
        with main.SessionLocal() as db:
            self.assertEqual(db.query(main.ProductDB).filter_by(id=self.product_id).one().stock, 4)

        repeat_status, repeated, _ = api_request("POST", "/orders", token=customer["token"], payload=payload, idempotency_key=key)
        self.assertEqual(repeat_status, 200)
        self.assertEqual(repeated["id"], order["id"])
        changed_payload = self.order_data(quantity=1).model_dump()
        changed_status, _, _ = api_request("POST", "/orders", token=customer["token"], payload=changed_payload, idempotency_key=key)
        self.assertEqual(changed_status, 409)
        with main.SessionLocal() as db:
            self.assertEqual(db.query(main.ProductDB).filter_by(id=self.product_id).one().stock, 4)

        customer_b = self.register_customer("http-order-b")
        foreign_status, _, _ = api_request("GET", f"/users/{customer['id']}/orders", token=customer_b["token"])
        self.assertEqual(foreign_status, 403)
        owned_status, owned, _ = api_request("GET", f"/users/{customer['id']}/orders", token=customer["token"])
        self.assertEqual(owned_status, 200)
        self.assertEqual([entry["id"] for entry in owned], [order["id"]])

        no_admin_status, _, _ = api_request("PUT", f"/admin/orders/{order['id']}/status", token=customer["token"], payload={"status": "confirmed"})
        self.assertEqual(no_admin_status, 403)
        invalid_transition, _, _ = api_request("PUT", f"/admin/orders/{order['id']}/status", token=self.admin_token, payload={"status": "completed"})
        self.assertEqual(invalid_transition, 409)
        confirmed_status, _, _ = api_request("PUT", f"/admin/orders/{order['id']}/status", token=self.admin_token, payload={"status": "confirmed"})
        self.assertEqual(confirmed_status, 200)
        processing_status, _, _ = api_request("PUT", f"/admin/orders/{order['id']}/status", token=self.admin_token, payload={"status": "processing"})
        self.assertEqual(processing_status, 200)
        unpaid_delivery_status, _, _ = api_request("PUT", f"/admin/orders/{order['id']}/status", token=self.admin_token, payload={"status": "completed"})
        self.assertEqual(unpaid_delivery_status, 409)
        forbidden_payment, _, _ = api_request("POST", f"/admin/orders/{order['id']}/payment", token=customer["token"], payload={"collected": True})
        self.assertEqual(forbidden_payment, 403)
        paid_status, paid, _ = api_request("POST", f"/admin/orders/{order['id']}/payment", token=self.admin_token, payload={"collected": True})
        self.assertEqual(paid_status, 200)
        self.assertEqual(paid["payment_status"], "paid")
        self.assertIsNotNone(paid["payment_collected_at"])
        with main.SessionLocal() as db:
            saved = db.query(main.OrderDB).filter_by(id=order["id"]).one()
            self.assertEqual(saved.payment_collected_by, 1)
        complete_status, completed, _ = api_request("PUT", f"/admin/orders/{order['id']}/status", token=self.admin_token, payload={"status": "completed"})
        self.assertEqual(complete_status, 200)
        self.assertEqual(completed["fulfillment_status"], "completed")
        cancel_after_delivery, _, _ = api_request("PUT", f"/admin/orders/{order['id']}/status", token=self.admin_token, payload={"status": "cancelled"})
        self.assertEqual(cancel_after_delivery, 409)

        second_payload = self.order_data(quantity=1).model_dump()
        second_status, second_order, _ = api_request("POST", "/orders", token=customer["token"], payload=second_payload, idempotency_key="cancel-order-key-01")
        self.assertEqual(second_status, 200)
        cancel_status, cancelled, _ = api_request("PUT", f"/admin/orders/{second_order['id']}/status", token=self.admin_token, payload={"status": "cancelled"})
        self.assertEqual(cancel_status, 200)
        self.assertEqual(cancelled["status"], "cancelled")
        repeat_cancel_status, _, _ = api_request("PUT", f"/admin/orders/{second_order['id']}/status", token=self.admin_token, payload={"status": "cancelled"})
        self.assertEqual(repeat_cancel_status, 200)
        reopen_status, _, _ = api_request("PUT", f"/admin/orders/{second_order['id']}/status", token=self.admin_token, payload={"status": "confirmed"})
        self.assertEqual(reopen_status, 409)
        with main.SessionLocal() as db:
            self.assertEqual(db.query(main.ProductDB).filter_by(id=self.product_id).one().stock, 4)

    def test_variant_validation_and_shipping_configuration(self):
        customer = self.register_customer("variant-order")
        with main.SessionLocal() as db:
            product = db.query(main.ProductDB).filter_by(id=self.product_id).one()
            product.requires_variants = True
            db.add(main.ProductVariantDB(product_id=product.id, platform="PS5", edition="Digital", price=33.25, is_active=True))
            db.add(main.ProductVariantDB(product_id=product.id, platform="PS4", edition="Legacy", price=None, is_active=True))
            db.commit()
            variants = db.query(main.ProductVariantDB).filter_by(product_id=product.id).all()
            valid_id = next(v.id for v in variants if v.price is not None)
            no_price_id = next(v.id for v in variants if v.price is None)

        invalid_area = self.order_data().model_dump()
        invalid_area["delivery_area"] = "Not configured"
        invalid_area["items"][0].update({"variant_id": valid_id, "platform": "PS5", "edition": "Digital"})
        status_code, _, _ = api_request("POST", "/orders", token=customer["token"], payload=invalid_area, idempotency_key="bad-area-key-001")
        self.assertEqual(status_code, 422)

        no_variant = self.order_data().model_dump()
        status_code, _, _ = api_request("POST", "/orders", token=customer["token"], payload=no_variant, idempotency_key="missing-variant-01")
        self.assertEqual(status_code, 422)
        wrong_variant = self.order_data().model_dump()
        wrong_variant["items"][0].update({"variant_id": valid_id, "platform": "PS4", "edition": "Legacy"})
        status_code, _, _ = api_request("POST", "/orders", token=customer["token"], payload=wrong_variant, idempotency_key="wrong-variant-001")
        self.assertEqual(status_code, 422)
        no_price = self.order_data().model_dump()
        no_price["items"][0].update({"variant_id": no_price_id, "platform": "PS4", "edition": "Legacy"})
        status_code, _, _ = api_request("POST", "/orders", token=customer["token"], payload=no_price, idempotency_key="no-price-key-001")
        self.assertEqual(status_code, 409)

        changed_price = self.order_data().model_dump()
        changed_price["items"][0].update({"variant_id": valid_id, "platform": "PS5", "edition": "Digital", "expected_price": 12.0})
        status_code, _, _ = api_request("POST", "/orders", token=customer["token"], payload=changed_price, idempotency_key="price-changed-001")
        self.assertEqual(status_code, 409)
        valid_variant = self.order_data().model_dump()
        valid_variant["items"][0].update({"variant_id": valid_id, "platform": "PS5", "edition": "Digital", "expected_price": 33.25})
        status_code, variant_order, _ = api_request("POST", "/orders", token=customer["token"], payload=valid_variant, idempotency_key="valid-variant-001")
        self.assertEqual(status_code, 200)
        self.assertEqual(variant_order["items"][0]["unit_price"], 33.25)
        self.assertEqual(variant_order["total_price"], 48.75)

        before = os.environ.pop("MDSTORE_SHIPPING_FEES_JSON")
        try:
            no_setup, _, _ = api_request("GET", "/delivery/options")
            self.assertEqual(no_setup, 200)
            no_delivery, _, _ = api_request("POST", "/orders", token=customer["token"], payload=self.order_data().model_dump(), idempotency_key="no-fees-order-001")
            self.assertEqual(no_delivery, 503)
        finally:
            os.environ["MDSTORE_SHIPPING_FEES_JSON"] = before

    def test_delivery_options_list_all_governorates_without_inventing_fees(self):
        options = main.get_delivery_options()
        self.assertEqual(len(options), 27)
        self.assertEqual(options[0]["area"], "القاهرة")
        self.assertEqual(options[0]["shipping_fee"], 15.5)
        self.assertTrue(options[0]["configured"])
        self.assertEqual(options[1]["shipping_fee"], None)
        self.assertFalse(options[1]["configured"])
        customer = self.register_customer("unconfigured-governorate")
        payload = self.order_data(delivery_area="الجيزة").model_dump()
        status_code, _, _ = api_request("POST", "/orders", token=customer["token"], payload=payload, idempotency_key="governorate-unconfigured-01")
        self.assertEqual(status_code, 422)

    def test_alexandria_shipping_fee_and_order_total_are_calculated_once(self):
        alexandria_fees = json.dumps({"Alexandria": {"fee": "50"}})
        with patch.dict(os.environ, {"MDSTORE_SHIPPING_FEES_JSON": alexandria_fees}):
            options = main.get_delivery_options()
            alexandria = next(option for option in options if option["area"] == "الإسكندرية")
            cairo = next(option for option in options if option["area"] == "القاهرة")
            self.assertTrue(alexandria["configured"])
            self.assertEqual(alexandria["shipping_fee"], 50.0)
            self.assertFalse(cairo["configured"])
            self.assertIsNone(cairo["shipping_fee"])

            customer = self.register_customer("alexandria-shipping-fee")
            payload = self.order_data(
                quantity=2, delivery_area="الإسكندرية", delivery_method="home_delivery"
            ).model_dump()
            status_code, order, _ = api_request(
                "POST", "/orders", token=customer["token"], payload=payload,
                idempotency_key="alexandria-shipping-50",
            )
            self.assertEqual(status_code, 200)
            self.assertEqual(order["shipping_fee"], 50.0)
            self.assertEqual(order["items"][0]["line_total"], 40.0)
            self.assertEqual(order["total_price"], 90.0)
            admin_status, admin_orders, _ = api_request(
                "GET", "/admin/orders", token=self.admin_token
            )
            self.assertEqual(admin_status, 200)
            self.assertIn(order["id"], [entry["id"] for entry in admin_orders])

    def test_store_pickup_accepts_order_without_governorate_or_shipping_fee(self):
        customer = self.register_customer("pickup-governorate")
        payload = self.order_data(
            address="", delivery_area="", delivery_method="store_pickup"
        ).model_dump()
        status_code, order, _ = api_request(
            "POST", "/orders", token=customer["token"], payload=payload,
            idempotency_key="pickup-governorate-01",
        )
        self.assertEqual(status_code, 200)
        self.assertIsNone(order["delivery_area"])
        self.assertEqual(order["shipping_fee"], 0.0)
        self.assertEqual(order["address"], "")

    def test_paymob_fails_closed_without_credentials_or_webhook_verification(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(paymob.paymob_checkout_configured())
            self.assertEqual(main.configured_payment_methods(), ["cash_on_delivery"])
            with self.assertRaises(PaymobNotConfigured):
                create_paymob_checkout_session(
                    order_id=1, amount=Decimal("10.00"), items=[{"name": "Test", "amount": 1000}],
                    billing_data={"phone_number": "10000000000"},
                )
            self.assertFalse(verify_paymob_webhook({"event": "success"}, "untrusted-signature"))
        configured = {
            "PAYMOB_SECRET_KEY": "test-secret",
            "PAYMOB_HMAC_SECRET": "test-hmac",
            "PAYMOB_INTEGRATION_ID": "321",
            "PAYMOB_PUBLIC_KEY": "pk_test_example",
            "PAYMOB_NOTIFICATION_URL": "https://merchant.example.test/payments/paymob/callback",
        }
        with patch.dict(os.environ, configured):
            self.assertTrue(paymob.paymob_checkout_configured())
            self.assertEqual(main.configured_payment_methods(), ["cash_on_delivery", "paymob"])

    def test_invalid_product_quantity_price_and_stock_do_not_change_inventory(self):
        customer = self.register_customer("inventory-order")
        payload = self.order_data().model_dump()
        payload["items"][0]["quantity"] = 0
        status_code, _, _ = api_request("POST", "/orders", token=customer["token"], payload=payload, idempotency_key="zero-quantity-001")
        self.assertEqual(status_code, 400)

        missing_product = self.order_data(product_id=self.product_id + 999).model_dump()
        status_code, _, _ = api_request("POST", "/orders", token=customer["token"], payload=missing_product, idempotency_key="missing-product-01")
        self.assertEqual(status_code, 404)

        excessive_stock = self.order_data(quantity=7).model_dump()
        status_code, _, _ = api_request("POST", "/orders", token=customer["token"], payload=excessive_stock, idempotency_key="excess-stock-001")
        self.assertEqual(status_code, 409)
        with main.SessionLocal() as db:
            product = db.query(main.ProductDB).filter_by(id=self.product_id).one()
            product.is_active = False
            db.commit()
        inactive = self.order_data().model_dump()
        status_code, _, _ = api_request("POST", "/orders", token=customer["token"], payload=inactive, idempotency_key="inactive-prod-001")
        self.assertEqual(status_code, 409)
        with main.SessionLocal() as db:
            product = db.query(main.ProductDB).filter_by(id=self.product_id).one()
            product.is_active = True
            product.price = -10
            db.commit()
        invalid_price = self.order_data().model_dump()
        status_code, _, _ = api_request("POST", "/orders", token=customer["token"], payload=invalid_price, idempotency_key="invalid-price-001")
        self.assertEqual(status_code, 422)
        with main.SessionLocal() as db:
            product = db.query(main.ProductDB).filter_by(id=self.product_id).one()
            self.assertEqual(product.stock, 6)
            self.assertEqual(db.query(main.OrderDB).filter_by(user_id=customer["id"]).count(), 0)

    def test_concurrent_orders_cannot_oversell_inventory(self):
        first = self.register_customer("race-a")
        second = self.register_customer("race-b")
        with main.SessionLocal() as db:
            product = db.query(main.ProductDB).filter_by(id=self.product_id).one()
            product.stock = 1
            db.commit()
        gate = Barrier(2)

        def attempt(user, key):
            gate.wait(timeout=10)
            return api_request("POST", "/orders", token=user["token"], payload=self.order_data().model_dump(), idempotency_key=key)

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda pair: attempt(*pair), [(first, "race-order-key-001"), (second, "race-order-key-002")]))
        self.assertEqual(sorted(result[0] for result in results), [200, 409])
        with main.SessionLocal() as db:
            self.assertEqual(db.query(main.ProductDB).filter_by(id=self.product_id).one().stock, 0)
            self.assertEqual(db.query(main.OrderDB).filter(main.OrderDB.idempotency_key.like("race-order-key-%")).count(), 1)

    def test_admin_chat_read_markers_and_unread_counts(self):
        customer = self.register_customer("chat-order")
        message = {"session_id": "synthetic-chat-session", "user_id": customer["id"], "sender": "user", "message": "Synthetic customer question"}
        sent, _, _ = api_request("POST", "/chat/send", token=customer["token"], payload=message)
        self.assertEqual(sent, 200)
        status_code, chats, _ = api_request("GET", "/admin/chats", token=self.admin_token)
        self.assertEqual(status_code, 200)
        chat = next(chat for chat in chats if chat["user_id"] == customer["id"])
        self.assertEqual(chat["unread_count"], 1)
        read_status, _, _ = api_request("POST", "/admin/chats/read", token=self.admin_token, payload={"user_id": customer["id"], "session_id": "synthetic-chat-session"})
        self.assertEqual(read_status, 200)
        _, chats, _ = api_request("GET", "/admin/chats", token=self.admin_token)
        chat = next(chat for chat in chats if chat["user_id"] == customer["id"])
        self.assertEqual(chat["unread_count"], 0)
        message["message"] = "Second synthetic question"
        api_request("POST", "/chat/send", token=customer["token"], payload=message)
        _, chats, _ = api_request("GET", "/admin/chats", token=self.admin_token)
        chat = next(chat for chat in chats if chat["user_id"] == customer["id"])
        self.assertEqual(chat["unread_count"], 1)
        unauthorized, _, _ = api_request("POST", "/admin/chats/read", payload={"user_id": customer["id"], "session_id": "synthetic-chat-session"})
        self.assertEqual(unauthorized, 401)

    def test_guest_chat_is_read_only_and_customer_sessions_are_isolated(self):
        before = main.SessionLocal().query(main.ChatMessageDB).count()
        guest_send, _, _ = api_request("POST", "/chat/send", payload={
            "session_id": "guest-attempt", "message": "hello"
        })
        guest_read, _, _ = api_request("GET", "/chat/messages/guest-attempt")
        self.assertEqual(guest_send, 401)
        self.assertEqual(guest_read, 401)
        with main.SessionLocal() as db:
            self.assertEqual(db.query(main.ChatMessageDB).count(), before)

        first = self.register_customer("chat-owner")
        second = self.register_customer("chat-other")
        sent, _, _ = api_request("POST", "/chat/send", token=first["token"], payload={
            "session_id": "owned-customer-chat", "user_id": first["id"], "sender": "spoofed", "message": "hello"
        })
        self.assertEqual(sent, 200)
        self.assertEqual(api_request("GET", "/chat/messages/owned-customer-chat", token=second["token"])[0], 403)
        forged, _, _ = api_request("POST", "/chat/send", token=second["token"], payload={
            "session_id": "owned-customer-chat", "message": "take over"
        })
        self.assertEqual(forged, 403)
        with main.SessionLocal() as db:
            messages = db.query(main.ChatMessageDB).filter_by(session_id="owned-customer-chat").all()
            self.assertTrue(messages)
            self.assertTrue(all(m.user_id == first["id"] for m in messages))
            self.assertTrue(all(m.sender in {"user", "bot"} for m in messages))

    def test_product_ratings_validate_upsert_and_require_admin_for_listing(self):
        customer = self.register_customer("reviewer")
        for stars in (0, 6):
            status_code, _, _ = api_request("POST", "/ratings", token=customer["token"], payload={
                "product_id": self.product_id, "stars": stars
            })
            self.assertEqual(status_code, 422)
        self.assertEqual(api_request("POST", "/ratings", payload={"product_id": self.product_id, "stars": 5})[0], 401)

        status_code, first_result, _ = api_request("POST", "/ratings", token=customer["token"], payload={
            "user_id": customer["id"], "product_id": self.product_id, "stars": 5, "comment": "<script>alert(1)</script>"
        })
        self.assertEqual(status_code, 200)
        self.assertEqual(first_result["status"], "success")
        initial_reviews = api_request("GET", f"/products/{self.product_id}/ratings")[1]
        self.assertEqual(initial_reviews["ratings"][0]["comment"], "<script>alert(1)</script>")
        self.assertEqual(api_request("POST", "/ratings", token=customer["token"], payload={
            "user_id": customer["id"] + 1, "product_id": self.product_id, "stars": 2
        })[0], 403)
        status_code, updated, _ = api_request("POST", "/ratings", token=customer["token"], payload={
            "product_id": self.product_id, "stars": 3
        })
        self.assertEqual(status_code, 200)
        self.assertEqual(updated["status"], "updated")
        status_code, summary, _ = api_request("GET", f"/products/{self.product_id}/ratings")
        self.assertEqual(status_code, 200)
        self.assertEqual(summary["count"], 1)
        self.assertEqual(summary["average"], 3)
        self.assertEqual(summary["ratings"][0]["customer_name"], customer["name"])
        self.assertIsNone(summary["ratings"][0]["comment"])
        self.assertEqual(api_request("GET", "/admin/ratings")[0], 401)
        self.assertEqual(api_request("GET", "/admin/ratings", token=customer["token"])[0], 403)
        status_code, admin_ratings, _ = api_request("GET", "/admin/ratings", token=self.admin_token)
        self.assertEqual(status_code, 200)
        legacy_rating = next(r for r in admin_ratings if r["id"] == 70)
        self.assertEqual(legacy_rating["rating_type"], "unlinked")
        self.assertIn("غير مرتبط بمنتج", legacy_rating["product_name"])
        matching = next(r for r in admin_ratings if r["product_name"].startswith("Test Product") and r["customer_name"] == customer["name"])
        self.assertEqual(matching["stars"], 3)
        self.assertEqual(matching["product_id"], self.product_id)
        self.assertEqual(matching["rating_type"], "product")
        with main.SessionLocal() as db:
            self.assertEqual(db.query(main.RatingDB).filter_by(user_id=customer["id"], product_id=self.product_id).count(), 1)

    def test_admin_can_remove_product_and_unlinked_ratings_and_stats_refresh(self):
        customer = self.register_customer("rating-delete")
        self.assertEqual(api_request("POST", "/ratings", token=customer["token"], payload={
            "product_id": self.product_id, "stars": 4, "comment": "remove me"
        })[0], 200)
        with main.SessionLocal() as db:
            linked = db.query(main.RatingDB).filter_by(user_id=customer["id"], product_id=self.product_id).one()
            linked_id = linked.id
            legacy = main.RatingDB(user_id=customer["id"], product_id=None, stars=2, comment="legacy unlinked")
            db.add(legacy); db.commit(); db.refresh(legacy)
            legacy_id = legacy.id

        self.assertEqual(api_request("DELETE", f"/admin/ratings/{linked_id}")[0], 401)
        self.assertEqual(api_request("DELETE", f"/admin/ratings/{linked_id}", token=customer["token"])[0], 403)
        status_code, result, _ = api_request("DELETE", f"/admin/ratings/{linked_id}", token=self.admin_token)
        self.assertEqual(status_code, 200)
        self.assertEqual(result["product_id"], self.product_id)
        summary = api_request("GET", f"/products/{self.product_id}/ratings")[1]
        self.assertEqual((summary["count"], summary["average"], summary["ratings"]), (0, 0, []))

        status_code, result, _ = api_request("DELETE", f"/admin/ratings/{legacy_id}", token=self.admin_token)
        self.assertEqual(status_code, 200)
        self.assertIsNone(result["product_id"])
        self.assertEqual(api_request("DELETE", f"/admin/ratings/{legacy_id}", token=self.admin_token)[0], 404)
        self.assertEqual(api_request("DELETE", "/admin/ratings/0", token=self.admin_token)[0], 404)

    def test_admin_deletion_anonymizes_customer_and_preserves_orders(self):
        customer = self.register_customer("delete-customer")
        self.assertEqual(api_request("DELETE", f"/admin/users/{customer['id']}")[0], 401)
        self.assertEqual(api_request("DELETE", f"/admin/users/{customer['id']}", token=customer["token"])[0], 403)
        with main.SessionLocal() as db:
            order_data = self.order_data()
            order = main.create_order(order_data, f"delete-preserve-{uuid.uuid4().hex}", db, db.query(main.UserDB).filter_by(id=customer["id"]).one())
            order_id = order["id"]
            stored_order = db.query(main.OrderDB).filter_by(id=order_id).one()
            stored_order.payment_status = "paid"
            stored_order.payment_collected_at = datetime.now()
            stored_order.payment_collected_by = self.admin_id
            db.commit()
            admin_count_before = db.query(main.AdminDB).filter_by(is_active=True).count()

        status_code, result, _ = api_request("DELETE", f"/admin/users/{customer['id']}", token=self.admin_token)
        self.assertEqual(status_code, 200)
        self.assertEqual(result["id"], customer["id"])
        with main.SessionLocal() as db:
            stored_user = db.query(main.UserDB).filter_by(id=customer["id"]).one()
            self.assertTrue(stored_user.is_deleted)
            self.assertTrue(stored_user.deleted_at)
            self.assertIsNone(stored_user.password_hash)
            self.assertIsNone(stored_user.phone)
            self.assertIsNone(stored_user.address)
            stored_order = db.query(main.OrderDB).filter_by(id=order_id).one()
            self.assertEqual(stored_order.user_id, customer["id"])
            self.assertEqual(stored_order.payment_status, "paid")
            self.assertEqual(stored_order.payment_collected_by, self.admin_id)
            self.assertEqual(db.query(main.OrderItemDB).filter_by(order_id=order_id).count(), 1)
            self.assertEqual(db.query(main.AdminDB).filter_by(is_active=True).count(), admin_count_before)
            current_admin = main.require_admin(main.decode_access_token(self.admin_token), db)
            self.assertEqual(current_admin.id, self.admin_id)
            with self.assertRaises(HTTPException) as revoked:
                main.get_current_customer(main.decode_access_token(customer["token"]), db)
            self.assertEqual(revoked.exception.status_code, 401)
        self.assertEqual(api_request("DELETE", f"/admin/users/{customer['id']}", token=self.admin_token)[0], 404)
        self.assertEqual(api_request("DELETE", "/admin/users/999999", token=self.admin_token)[0], 404)
        listed = api_request("GET", "/admin/users", token=self.admin_token)[1]
        tombstone = next(user for user in listed if user["id"] == customer["id"])
        self.assertTrue(tombstone["is_deleted"])
        self.assertEqual(tombstone["email"], "—")

    def test_search_and_product_interests_are_unique_per_customer(self):
        first = self.register_customer("interest-one")
        second = self.register_customer("interest-two")
        self.assertEqual(api_request("POST", f"/users/{first['id']}/interest", payload={
            "category": "ignored", "interest_type": "search"
        })[0], 401)

        for term in ("  DualSense   PS5  ", "dualsense ps5"):
            status_code, _, _ = api_request("POST", f"/users/{first['id']}/interest", token=first["token"], payload={
                "category": term, "interest_type": "search"
            })
            self.assertEqual(status_code, 200)
        api_request("POST", f"/users/{second['id']}/interest", token=second["token"], payload={
            "category": "DualSense PS5", "interest_type": "search"
        })
        for _ in range(2):
            status_code, _, _ = api_request("POST", f"/users/{first['id']}/interest", token=first["token"], payload={
                "interest_type": "product", "product_id": self.product_id
            })
            self.assertEqual(status_code, 200)
        with main.SessionLocal() as db:
            first_searches = db.query(main.UserInterestDB).filter_by(user_id=first["id"], interest_type="search").all()
            other_searches = db.query(main.UserInterestDB).filter_by(user_id=second["id"], interest_type="search").all()
            product_interests = db.query(main.UserInterestDB).filter_by(user_id=first["id"], interest_type="product").all()
            self.assertEqual(len(first_searches), 1)
            self.assertEqual(first_searches[0].category, "DualSense PS5")
            self.assertTrue(first_searches[0].created_at)
            self.assertEqual(len(other_searches), 1)
            self.assertEqual(len(product_interests), 1)
            self.assertEqual(product_interests[0].product_id, self.product_id)
        status_code, users, _ = api_request("GET", "/admin/users", token=self.admin_token)
        self.assertEqual(status_code, 200)
        customer = next(user for user in users if user["id"] == first["id"])
        self.assertEqual({item["type"] for item in customer["interests"] if item["type"] != "category"}, {"search", "product"})
        self.assertTrue(all(item["created_at"] for item in customer["interests"] if item["type"] in {"search", "product"}))
        product_interest = next(item for item in customer["interests"] if item["type"] == "product")
        self.assertEqual(product_interest["product_id"], self.product_id)
        self.assertTrue(product_interest["item"].startswith("Test Product"))

    def test_cors_is_explicit_and_order_routes_are_real_app_routes(self):
        self.assertNotIn("*", main.CORS_ORIGINS)
        self.assertIn("http://localhost:5500", main.CORS_ORIGINS)
        self.assertIn("http://127.0.0.1:5500", main.CORS_ORIGINS)

    def test_paymob_intention_and_verified_callback_are_idempotent(self):
        customer = self.register_customer("paymob-customer")
        test_secret = "sandbox-secret-key-only-for-unit-test"
        test_hmac_secret = "sandbox-hmac-only-for-unit-test"
        settings = {
            "PAYMOB_SECRET_KEY": test_secret,
            "PAYMOB_HMAC_SECRET": test_hmac_secret,
            "PAYMOB_INTEGRATION_ID": "12345",
            "PAYMOB_PUBLIC_KEY": "pk_test_unit_only",
            "PAYMOB_NOTIFICATION_URL": "https://merchant.example.test/payments/paymob/callback",
        }

        class FakePaymobResponse:
            def __init__(self, intention_id, paymob_order_id):
                self.response = {"id": intention_id, "intention_order_id": paymob_order_id, "client_secret": f"csk_test_{intention_id}"}
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self):
                return json.dumps(self.response).encode()

        class FakeRequest:
            def __init__(self, payload): self.payload = payload
            async def json(self): return self.payload

        captured_intentions = []
        fake_responses = iter((FakePaymobResponse("intention-test-1", 99001), FakePaymobResponse("intention-test-2", 99002)))

        def fake_urlopen(request, timeout):
            captured_intentions.append(json.loads(request.data.decode("utf-8")))
            return next(fake_responses)

        def invoke_callback(coroutine):
            try:
                coroutine.send(None)
            except StopIteration as result:
                return result.value
            raise AssertionError("Callback unexpectedly suspended during local test")

        with patch.dict(os.environ, settings), patch("payments.paymob.urlopen", side_effect=fake_urlopen):
            with main.SessionLocal() as db:
                user = db.query(main.UserDB).filter_by(id=customer["id"]).one()
                result = main.create_order(
                    self.order_data(quantity=2, payment_method="paymob"),
                    f"paymob-{uuid.uuid4().hex}", db, user,
                )
                self.assertEqual(result["payment_method"], "paymob")
                self.assertEqual(result["payment_status"], "unpaid")
                self.assertIn("clientSecret=csk_test_intention-test-1", result["checkout_url"])
                first_intention = captured_intentions[0]
                self.assertEqual(sum(item["amount"] for item in first_intention["items"]), first_intention["amount"])
                self.assertEqual(len(first_intention["items"]), 1)
                self.assertEqual(first_intention["items"][0]["quantity"], 1)
                self.assertEqual(first_intention["items"][0]["amount"], first_intention["amount"])
                self.assertEqual(first_intention["items"][0]["name"], f"MD Store order #{result['id']}")
                amount_cents = int(round(result["total_price"] * 100))
                obj = {
                    "amount_cents": amount_cents,
                    "created_at": "2026-10-18T12:00:00",
                    "currency": "EGP",
                    "error_occured": False,
                    "has_parent_transaction": False,
                    "id": 555001,
                    "integration_id": 12345,
                    "is_3d_secure": True,
                    "is_auth": False,
                    "is_capture": False,
                    "is_refunded": False,
                    "is_standalone_payment": True,
                    "is_voided": False,
                    "order": {"id": 99001, "amount_cents": amount_cents, "paid_amount_cents": amount_cents},
                    "owner": 123,
                    "pending": False,
                    "source_data": {"pan": "4242", "sub_type": "Visa", "type": "card"},
                    "success": True,
                }
                payload = {"type": "TRANSACTION", "obj": obj}
                parts = []
                for path in paymob.HMAC_TRANSACTION_FIELDS:
                    value = obj
                    for key_part in path:
                        value = value[key_part]
                    parts.append(("true" if value is True else "false") if isinstance(value, bool) else str(value))
                message = "".join(parts).encode()
                signature = hmac.new(test_hmac_secret.encode(), message, hashlib.sha512).hexdigest()
                with self.assertRaises(HTTPException) as invalid_signature:
                    invoke_callback(main.paymob_transaction_callback(FakeRequest(payload), "0" * 128, db))
                self.assertEqual(invalid_signature.exception.status_code, 401)
                db.rollback()
                confirmed = invoke_callback(main.paymob_transaction_callback(FakeRequest(payload), signature, db))
                self.assertTrue(confirmed["paid"])
                duplicate = invoke_callback(main.paymob_transaction_callback(FakeRequest(payload), signature, db))
                self.assertTrue(duplicate["duplicate"])
                order = db.query(main.OrderDB).filter_by(id=result["id"]).one()
                self.assertEqual(order.payment_status, "paid")
                self.assertEqual(db.query(main.PaymobPaymentAttemptDB).filter_by(order_id=order.id).count(), 1)

                failed_order = main.create_order(
                    self.order_data(payment_method="paymob"),
                    f"paymob-failed-{uuid.uuid4().hex}", db, user,
                )
                failed_amount_cents = int(round(failed_order["total_price"] * 100))
                failed_obj = dict(obj)
                failed_obj.update({
                    "amount_cents": failed_amount_cents,
                    "id": 555002,
                    "success": False,
                    "order": {"id": 99002, "amount_cents": failed_amount_cents, "paid_amount_cents": 0},
                })
                failed_payload = {"type": "TRANSACTION", "obj": failed_obj}
                failed_parts = []
                for path in paymob.HMAC_TRANSACTION_FIELDS:
                    value = failed_obj
                    for key_part in path:
                        value = value[key_part]
                    failed_parts.append(("true" if value is True else "false") if isinstance(value, bool) else str(value))
                failed_signature = hmac.new(test_hmac_secret.encode(), "".join(failed_parts).encode(), hashlib.sha512).hexdigest()
                rejected = invoke_callback(main.paymob_transaction_callback(FakeRequest(failed_payload), failed_signature, db))
                self.assertFalse(rejected["paid"])
                self.assertEqual(db.query(main.OrderDB).filter_by(id=failed_order["id"]).one().payment_status, "unpaid")

    def test_paymob_intention_error_logs_redact_secrets_and_billing_data(self):
        settings = {
            "PAYMOB_SECRET_KEY": "secret-unit-should-never-log",
            "PAYMOB_API_KEY": "api-unit-should-never-log",
            "PAYMOB_PUBLIC_KEY": "public-unit-should-never-log",
            "PAYMOB_HMAC_SECRET": "hmac-unit-should-never-log",
            "PAYMOB_INTEGRATION_ID": "12345",
            "PAYMOB_NOTIFICATION_URL": "https://merchant.example.test/payments/paymob/callback",
        }
        billing = {
            "phone_number": "+201234567890",
            "email": "customer-private@example.test",
            "first_name": "PrivateCustomer",
        }
        provider_body = json.dumps({
            "detail": "Invalid configuration; retry later",
            "secret_key": settings["PAYMOB_SECRET_KEY"],
            "api_key": settings["PAYMOB_API_KEY"],
            "public_key": settings["PAYMOB_PUBLIC_KEY"],
            "hmac_secret": settings["PAYMOB_HMAC_SECRET"],
            "authorization": "Bearer authorization-unit-should-never-log",
            "billing_data": billing,
            "card": "4111111111111111",
        }).encode()
        failure = HTTPError(
            "https://accept.paymob.com/v1/intention/", 406, "Not Acceptable", {},
            io.BytesIO(provider_body),
        )
        with patch.dict(os.environ, settings), patch("payments.paymob.urlopen", side_effect=failure):
            with self.assertLogs("payments.paymob", level="WARNING") as captured:
                with self.assertRaises(paymob.PaymobProviderError) as raised:
                    paymob.create_paymob_checkout_session(
                        order_id=987, amount=Decimal("12.34"), currency="EGP",
                        items=[{"name": "Synthetic item", "amount": 1234, "quantity": 1}],
                        billing_data=billing,
                    )
        log_output = "\n".join(captured.output)
        self.assertIn("HTTP 406", log_output)
        self.assertIn("Invalid configuration; retry later", log_output)
        for sensitive in (
            *settings.values(), "authorization-unit-should-never-log",
            *billing.values(), "4111111111111111",
        ):
            self.assertNotIn(sensitive, log_output)
        self.assertEqual(str(raised.exception), "Paymob could not create the payment session")
        self.assertNotIn("406", str(raised.exception))


    def test_products_endpoint_returns_a_list_matching_frontend_fields(self):
        with main.SessionLocal() as db:
            products = main.get_products(db)
            self.assertEqual(len(products), 1)
            serialized = main.ProductResponse.model_validate(products[0]).model_dump()
        self.assertEqual(serialized["id"], self.product_id)
        self.assertEqual(serialized["name"].split()[0], "Test")
        self.assertEqual(serialized["category"], "Test")
        self.assertEqual(serialized["is_active"], True)
        self.assertIn("image_url", serialized)



if __name__ == "__main__":
    unittest.main(verbosity=2)
