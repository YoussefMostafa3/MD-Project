import os
import shutil
import math
import base64
import hashlib
import hmac
import json
import logging
import secrets
import sys
import getpass
import re
from urllib.parse import urlparse
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from fastapi import FastAPI, HTTPException, Depends, UploadFile, File, Header, Query, Request, status
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Union, Optional, Any, Literal
from sqlalchemy import create_engine, Column, Integer, String, Float, ForeignKey, Text, DateTime, Boolean, inspect, text, func, or_
from sqlalchemy.orm import declarative_base, sessionmaker, Session, relationship
from sqlalchemy.exc import IntegrityError, OperationalError
from fastapi import HTTPException
from payments.paymob import (
    PaymobNotConfigured,
    PaymobProviderError,
    create_paymob_checkout_session,
    paymob_checkout_configured,
    verify_paymob_webhook,
)

# 1. إعداد قاعدة البيانات ومجلد رفع الصور بالمسار المطلق
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def load_backend_env_file() -> None:
    """Load KEY=VALUE entries from this backend's .env without overriding process settings."""
    env_path = os.path.join(BASE_DIR, ".env")
    try:
        with open(env_path, "r", encoding="utf-8-sig") as env_file:
            for raw_line in env_file:
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[7:].lstrip()
                name, separator, value = line.partition("=")
                name = name.strip()
                if not separator or not name or not (name[0].isalpha() or name[0] == "_"):
                    continue
                if not all(character.isalnum() or character == "_" for character in name):
                    continue
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                    value = value[1:-1]
                else:
                    value = value.split(" #", 1)[0].rstrip()
                os.environ.setdefault(name, value)
    except FileNotFoundError:
        pass


load_backend_env_file()
DATABASE_URL = os.environ.get("MDSTORE_DATABASE_URL", f"sqlite:///{os.path.join(BASE_DIR, 'mdstore.db')}")

UPLOADS_DIR = os.environ.get("MDSTORE_UPLOADS_DIR", os.path.join(BASE_DIR, "uploads"))
os.makedirs(UPLOADS_DIR, exist_ok=True)

AUTH_SECRET = os.environ.get("MDSTORE_AUTH_SECRET", "")
if len(AUTH_SECRET.encode("utf-8")) < 32:
    raise RuntimeError("MDSTORE_AUTH_SECRET must be configured with at least 32 bytes of random data")
AUTH_SECRET_BYTES = AUTH_SECRET.encode("utf-8")
TOKEN_ISSUER = "mdstore"
CUSTOMER_TOKEN_TTL = timedelta(days=7)
ADMIN_TOKEN_TTL = timedelta(hours=8)
PASSWORD_ITERATIONS = 600_000

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# ---------------------------------------------------------
# 2. جداول قاعدة البيانات (Models)
# ---------------------------------------------------------

class ProductDB(Base):
    __tablename__ = "products"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, index=True)
    description = Column(String, nullable=True)
    price = Column(Float)
    stock = Column(Integer)
    category = Column(String, nullable=True)
    image_url = Column(String, nullable=True, default=None)
    badge = Column(String, nullable=True, default=None)
    requires_variants = Column(Boolean, nullable=False, default=False, server_default="0")
    is_active = Column(Boolean, nullable=False, default=True, server_default="1")
    show_in_modified_games = Column(Boolean, nullable=False, default=False, server_default="0")
    variants = relationship("ProductVariantDB", back_populates="product", cascade="all, delete-orphan")

class ProductVariantDB(Base):
    __tablename__ = "product_variants"
    id = Column(Integer, primary_key=True, index=True)
    product_id = Column(Integer, ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True)
    platform = Column(String(80), nullable=True)
    edition = Column(String(80), nullable=True)
    price = Column(Float, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True, server_default="1")
    product = relationship("ProductDB", back_populates="variants")

class HomepageBannerDB(Base):
    __tablename__ = "homepage_banners"
    id = Column(Integer, primary_key=True, index=True)
    image_url = Column(String, nullable=False)
    title_ar = Column(String(180), nullable=False)
    title_en = Column(String(180), nullable=False)
    subtitle_ar = Column(String(300), nullable=True)
    subtitle_en = Column(String(300), nullable=True)
    button_text_ar = Column(String(100), nullable=True)
    button_text_en = Column(String(100), nullable=True)
    button_link = Column(String(1000), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True, server_default="1")
    position = Column(Integer, nullable=False, default=1)

class UserDB(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, index=True, nullable=False)
    email = Column(String, unique=True, index=True, nullable=False)
    password = Column(String, nullable=True)
    password_hash = Column(String(256), nullable=True)
    token_version = Column(Integer, nullable=False, default=0, server_default="0")
    is_deleted = Column(Boolean, nullable=False, default=False, server_default="0")
    deleted_at = Column(DateTime, nullable=True)
    phone = Column(String, unique=True, index=True, nullable=True)
    address = Column(String, nullable=True)

    interests = relationship("UserInterestDB", back_populates="user", cascade="all, delete-orphan")
    repairs = relationship("RepairDB", back_populates="user", cascade="all, delete-orphan")
    trades = relationship("TradeDB", back_populates="user", cascade="all, delete-orphan")

class AdminDB(Base):
    __tablename__ = "admin_accounts"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(180), unique=True, index=True, nullable=False)
    password_hash = Column(String(256), nullable=False)
    token_version = Column(Integer, nullable=False, default=0, server_default="0")
    is_active = Column(Boolean, nullable=False, default=True, server_default="1")
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)

class UserInterestDB(Base):
    __tablename__ = "user_interests"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    category = Column(String, nullable=False)
    views_count = Column(Integer, default=1)
    interest_type = Column(String(20), nullable=True)
    normalized_value = Column(String(500), nullable=True)
    product_id = Column(Integer, ForeignKey("products.id", ondelete="SET NULL"), nullable=True, index=True)
    created_at = Column(DateTime, nullable=True, default=datetime.utcnow)

    user = relationship("UserDB", back_populates="interests")

class RepairDB(Base):
    __tablename__ = "repairs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    phone = Column(String, nullable=False)
    device_type = Column(String, nullable=False)
    issue_description = Column(String, nullable=False)
    status = Column(String, default="قيد الفحص")
    created_at = Column(DateTime, default=datetime.now)

    user = relationship("UserDB", back_populates="repairs")

class TradeDB(Base):
    __tablename__ = "trades"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    item_details = Column(String, nullable=False)
    condition_details = Column(String, nullable=False)
    status = Column(String, default="قيد التقييم")
    created_at = Column(DateTime, default=datetime.now)

    user = relationship("UserDB", back_populates="trades")

class ChatMessageDB(Base):
    __tablename__ = "chat_messages"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String, index=True, nullable=False) # معرف الجلسة أو العميل
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    sender = Column(String, nullable=False) # 'user', 'admin', 'bot'
    message = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.now)

class ChatReadStateDB(Base):
    __tablename__ = "chat_read_states"

    conversation_key = Column(String(220), primary_key=True)
    user_id = Column(Integer, nullable=True, index=True)
    session_id = Column(String, nullable=True)
    last_read_message_id = Column(Integer, nullable=False, default=0, server_default="0")
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow)

class RatingDB(Base):
    __tablename__ = "ratings"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    product_id = Column(Integer, ForeignKey("products.id", ondelete="SET NULL"), nullable=True, index=True)
    stars = Column(Integer, nullable=False)
    comment = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.now)

class OrderDB(Base):
    __tablename__ = "orders"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    customer_name = Column(String, nullable=False)
    phone = Column(String, nullable=True)
    address = Column(String, nullable=True)
    delivery_method = Column(String(30), nullable=False, default="home_delivery", server_default="home_delivery")
    delivery_area = Column(String(180), nullable=True)
    shipping_fee = Column(Float, nullable=False, default=0, server_default="0")
    total_price = Column(Float, nullable=False)
    idempotency_key = Column(String(128), nullable=True)
    request_fingerprint = Column(String(64), nullable=True)
    status = Column(String, nullable=False, default="pending")
    payment_method = Column(String(40), nullable=False, default="cash_on_delivery", server_default="cash_on_delivery")
    payment_status = Column(String(20), nullable=False, default="unpaid", server_default="unpaid")
    payment_collected_at = Column(DateTime, nullable=True)
    payment_collected_by = Column(Integer, ForeignKey("admin_accounts.id"), nullable=True)
    cancellation_fee = Column(Float, nullable=False, default=0, server_default="0")
    cancellation_fee_status = Column(String(20), nullable=False, default="not_applicable", server_default="not_applicable")
    created_at = Column(DateTime, default=datetime.now, nullable=False)

    items = relationship("OrderItemDB", back_populates="order", cascade="all, delete-orphan")

class OrderItemDB(Base):
    __tablename__ = "order_items"

    id = Column(Integer, primary_key=True, index=True)
    order_id = Column(Integer, ForeignKey("orders.id"), nullable=False, index=True)
    product_id = Column(Integer, ForeignKey("products.id", ondelete="SET NULL"), nullable=True)
    product_name = Column(String, nullable=False)
    variant = Column(String, nullable=True)
    variant_id = Column(Integer, ForeignKey("product_variants.id", ondelete="SET NULL"), nullable=True)
    platform = Column(String(80), nullable=True)
    edition = Column(String(80), nullable=True)
    unit_price = Column(Float, nullable=False)
    quantity = Column(Integer, nullable=False)
    line_total = Column(Float, nullable=False)

    order = relationship("OrderDB", back_populates="items")

class PaymobPaymentAttemptDB(Base):
    """One Paymob intention per checkout attempt; transaction IDs are idempotent."""
    __tablename__ = "paymob_payment_attempts"

    id = Column(Integer, primary_key=True, index=True)
    order_id = Column(Integer, ForeignKey("orders.id"), nullable=False, index=True)
    paymob_order_id = Column(String(80), nullable=False, unique=True, index=True)
    paymob_intention_id = Column(String(100), nullable=False, unique=True, index=True)
    transaction_id = Column(String(80), nullable=True, unique=True, index=True)
    amount_cents = Column(Integer, nullable=False)
    currency = Column(String(8), nullable=False)
    integration_id = Column(Integer, nullable=False)
    status = Column(String(30), nullable=False, default="pending")
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)

Base.metadata.create_all(bind=engine)

def migrate_user_deletion_schema():
    """Add account tombstone fields without rebuilding or dropping user data."""
    columns = {column["name"] for column in inspect(engine).get_columns("users")}
    with engine.begin() as connection:
        if "is_deleted" not in columns:
            connection.execute(text("ALTER TABLE users ADD COLUMN is_deleted BOOLEAN NOT NULL DEFAULT 0"))
        if "deleted_at" not in columns:
            connection.execute(text("ALTER TABLE users ADD COLUMN deleted_at DATETIME"))

migrate_user_deletion_schema()

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    salt_text = base64.urlsafe_b64encode(salt).decode("ascii").rstrip("=")
    digest_text = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${salt_text}${digest_text}"

def verify_password(password: str, encoded: Optional[str]) -> bool:
    if not encoded:
        return False
    try:
        algorithm, iterations, salt_text, digest_text = encoded.split("$", 3)
        iterations_value = int(iterations)
        if algorithm != "pbkdf2_sha256" or not 100_000 <= iterations_value <= 2_000_000:
            return False
        salt = base64.urlsafe_b64decode(salt_text + "=" * (-len(salt_text) % 4))
        expected = base64.urlsafe_b64decode(digest_text + "=" * (-len(digest_text) % 4))
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations_value)
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False

def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")

def create_access_token(subject_id: int, role: str, token_version: int = 0) -> str:
    now = datetime.now(timezone.utc)
    ttl = ADMIN_TOKEN_TTL if role == "admin" else CUSTOMER_TOKEN_TTL
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "iss": TOKEN_ISSUER,
        "sub": str(subject_id),
        "role": role,
        "ver": token_version,
        "iat": int(now.timestamp()),
        "exp": int((now + ttl).timestamp()),
    }
    signing_input = f"{_b64url(json.dumps(header, separators=(',', ':')).encode())}.{_b64url(json.dumps(payload, separators=(',', ':')).encode())}"
    signature = hmac.new(AUTH_SECRET_BYTES, signing_input.encode("ascii"), hashlib.sha256).digest()
    return f"{signing_input}.{_b64url(signature)}"

def decode_access_token(token: str) -> dict:
    try:
        encoded_header, encoded_payload, encoded_signature = token.split(".", 2)
        signing_input = f"{encoded_header}.{encoded_payload}"
        expected = hmac.new(AUTH_SECRET_BYTES, signing_input.encode("ascii"), hashlib.sha256).digest()
        actual = base64.urlsafe_b64decode(encoded_signature + "=" * (-len(encoded_signature) % 4))
        if not hmac.compare_digest(actual, expected):
            raise ValueError("signature")
        header = json.loads(base64.urlsafe_b64decode(encoded_header + "=" * (-len(encoded_header) % 4)))
        claims = json.loads(base64.urlsafe_b64decode(encoded_payload + "=" * (-len(encoded_payload) % 4)))
        if header != {"alg": "HS256", "typ": "JWT"} or claims.get("iss") != TOKEN_ISSUER:
            raise ValueError("claims")
        if int(claims.get("exp", 0)) <= int(datetime.now(timezone.utc).timestamp()):
            raise ValueError("expired")
        if claims.get("role") not in {"customer", "admin"} or int(claims.get("sub", 0)) <= 0:
            raise ValueError("subject")
        return claims
    except (ValueError, TypeError, KeyError, json.JSONDecodeError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")

def migrate_order_schema():
    """Add new nullable/defaulted columns without disturbing existing store data."""
    with engine.begin() as connection:
        product_columns = {column["name"] for column in inspect(engine).get_columns("products")}
        if "requires_variants" not in product_columns:
            connection.execute(text("ALTER TABLE products ADD COLUMN requires_variants BOOLEAN NOT NULL DEFAULT 0"))
        if "is_active" not in product_columns:
            connection.execute(text("ALTER TABLE products ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT 1"))
        if "show_in_modified_games" not in product_columns:
            connection.execute(text("ALTER TABLE products ADD COLUMN show_in_modified_games BOOLEAN NOT NULL DEFAULT 0"))
        order_item_columns = {column["name"] for column in inspect(engine).get_columns("order_items")}
        additions = {
            "variant_id": "INTEGER REFERENCES product_variants(id) ON DELETE SET NULL",
            "platform": "VARCHAR(80)",
            "edition": "VARCHAR(80)",
        }
        for name, sql_type in additions.items():
            if name not in order_item_columns:
                connection.execute(text(f"ALTER TABLE order_items ADD COLUMN {name} {sql_type}"))

        order_columns = {column["name"] for column in inspect(engine).get_columns("orders")}
        order_additions = {
            "delivery_method": "VARCHAR(30) NOT NULL DEFAULT 'home_delivery'",
            "delivery_area": "VARCHAR(180)",
            "shipping_fee": "FLOAT NOT NULL DEFAULT 0",
            "idempotency_key": "VARCHAR(128)",
            "request_fingerprint": "VARCHAR(64)",
            "payment_method": "VARCHAR(40) NOT NULL DEFAULT 'manual'",
            "payment_status": "VARCHAR(20) NOT NULL DEFAULT 'unpaid'",
            "payment_collected_at": "DATETIME",
            "payment_collected_by": "INTEGER REFERENCES admin_accounts(id)",
            "cancellation_fee": "FLOAT NOT NULL DEFAULT 0",
            "cancellation_fee_status": "VARCHAR(20) NOT NULL DEFAULT 'not_applicable'",
        }
        for name, sql_type in order_additions.items():
            if name not in order_columns:
                connection.execute(text(f"ALTER TABLE orders ADD COLUMN {name} {sql_type}"))
        connection.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_order_customer_idempotency "
            "ON orders (user_id, idempotency_key)"
        ))

        user_columns = {column["name"] for column in inspect(engine).get_columns("users")}
        if "password_hash" not in user_columns:
            connection.execute(text("ALTER TABLE users ADD COLUMN password_hash VARCHAR(256)"))
        if "token_version" not in user_columns:
            connection.execute(text("ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0"))
        admin_columns = {column["name"] for column in inspect(engine).get_columns("admin_accounts")}
        if "token_version" not in admin_columns:
            connection.execute(text("ALTER TABLE admin_accounts ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0"))
        legacy_users = connection.execute(text(
            "SELECT id, password, password_hash FROM users WHERE password_hash IS NULL OR password_hash = ''"
        )).fetchall()
        for row in legacy_users:
            legacy_password = row.password or ""
            # The old API applied this known default when callers omitted a password.
            # Keep those accounts but force a secure password reset instead of trusting it.
            new_hash = hash_password(legacy_password) if legacy_password and legacy_password != "123456" else None
            connection.execute(text("UPDATE users SET password_hash = :password_hash, password = '' WHERE id = :id"), {
                "password_hash": new_hash,
                "id": row.id,
            })
        connection.execute(text("UPDATE users SET password = '' WHERE password IS NOT NULL AND password != ''"))

migrate_order_schema()

def migrate_customer_activity_schema():
    """Additive migration for reviews and deduplicated customer interests."""
    with engine.begin() as connection:
        rating_columns = {column["name"] for column in inspect(engine).get_columns("ratings")}
        if "product_id" not in rating_columns:
            connection.execute(text(
                "ALTER TABLE ratings ADD COLUMN product_id INTEGER REFERENCES products(id) ON DELETE SET NULL"
            ))
        connection.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_rating_customer_product "
            "ON ratings (user_id, product_id) WHERE user_id IS NOT NULL AND product_id IS NOT NULL"
        ))

        interest_columns = {column["name"] for column in inspect(engine).get_columns("user_interests")}
        interest_additions = {
            "interest_type": "VARCHAR(20)",
            "normalized_value": "VARCHAR(500)",
            "product_id": "INTEGER REFERENCES products(id) ON DELETE SET NULL",
            "created_at": "DATETIME",
        }
        for name, sql_type in interest_additions.items():
            if name not in interest_columns:
                connection.execute(text(f"ALTER TABLE user_interests ADD COLUMN {name} {sql_type}"))
        connection.execute(text(
            "UPDATE user_interests SET interest_type = 'category' WHERE interest_type IS NULL"
        ))
        connection.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_user_interest_type_value "
            "ON user_interests (user_id, interest_type, normalized_value)"
        ))

migrate_customer_activity_schema()

# ---------------------------------------------------------
# 3. مخططات البيانات (Pydantic Schemas)
# ---------------------------------------------------------

class ProductCreate(BaseModel):
    name: str
    description: Optional[str] = None
    price: Optional[float] = None
    stock: int
    category: Optional[str] = "General"
    image_url: Optional[str] = None
    badge: Optional[str] = None
    requires_variants: bool = False
    is_active: bool = True
    show_in_modified_games: bool = False

class VariantResponse(BaseModel):
    id: int
    product_id: int
    platform: Optional[str] = None
    edition: Optional[str] = None
    price: Optional[float] = None
    is_active: bool = True
    class Config:
        from_attributes = True

class VariantCreate(BaseModel):
    platform: Optional[str] = None
    edition: Optional[str] = None
    price: Optional[float] = None
    is_active: bool = True

class VariantSettingsUpdate(BaseModel):
    requires_variants: bool

class ProductResponse(ProductCreate):
    id: int
    variants: List[VariantResponse] = []
    class Config:
        from_attributes = True

class HomepageBannerWrite(BaseModel):
    image_url: str
    title_ar: str
    title_en: str
    subtitle_ar: Optional[str] = None
    subtitle_en: Optional[str] = None
    button_text_ar: Optional[str] = None
    button_text_en: Optional[str] = None
    button_link: Optional[str] = None
    is_active: bool = True
    position: int = 1

class HomepageBannerOrder(BaseModel):
    ids: List[int]

class UserCreate(BaseModel):
    name: str
    email: str
    phone: Optional[str] = None
    address: Optional[str] = None
    password: str = Field(min_length=8, max_length=128)

class UserLogin(BaseModel):
    identifier: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    password: str = Field(min_length=1, max_length=128)

class AdminLogin(BaseModel):
    username: str = Field(min_length=1, max_length=180)
    password: str = Field(min_length=1, max_length=128)

class TrackInterestCategory(BaseModel):
    category: Optional[str] = Field(default=None, max_length=500)
    interest_type: Literal["category", "search", "product"] = "category"
    product_id: Optional[int] = Field(default=None, gt=0)
    interest_id: Optional[int] = Field(default=None, gt=0)

class RepairCreate(BaseModel):
    user_id: int
    phone: str
    device_type: str
    issue_description: str

class TradeCreate(BaseModel):
    user_id: int
    item_details: str
    condition_details: str

class StatusUpdate(BaseModel):
    status: str

class ChatMessageCreate(BaseModel):
    session_id: str = Field(min_length=1, max_length=220)
    user_id: Optional[int] = None
    sender: str = "user"
    message: str = Field(min_length=1, max_length=2000)

class RatingCreate(BaseModel):
    user_id: Optional[int] = None
    product_id: Optional[int] = None
    stars: int = Field(ge=1, le=5)
    comment: Optional[str] = Field(default=None, max_length=2000)

class OrderItemCreate(BaseModel):
    product_id: int
    quantity: int
    variant_id: Optional[int] = None
    platform: Optional[str] = None
    edition: Optional[str] = None
    # Retained for older clients; never used as the charged price.
    expected_price: Optional[float] = None

class OrderCreate(BaseModel):
    user_id: Optional[int] = None
    recipient_name: str = Field(min_length=1, max_length=180)
    phone: str = Field(min_length=5, max_length=40)
    address: str = Field(default="", max_length=500)
    delivery_method: Literal["home_delivery", "store_pickup"] = "home_delivery"
    delivery_area: str = Field(default="", max_length=180)
    payment_method: Literal["cash_on_delivery", "paymob", "online_payment_demo"] = "cash_on_delivery"
    items: List[OrderItemCreate]
    model_config = {"extra": "forbid"}

class OrderStatusUpdate(BaseModel):
    status: str

class PaymentCollectionUpdate(BaseModel):
    collected: bool

# ---------------------------------------------------------
# 4. تطبيق FastAPI و CORS
# ---------------------------------------------------------

app = FastAPI(title="MD Store API")

DEFAULT_LOCAL_ORIGINS = (
    "null,http://localhost:3000,http://127.0.0.1:3000,"
    "http://localhost:5500,http://127.0.0.1:5500,"
    "http://localhost:5501,http://127.0.0.1:5501"
)
CORS_ORIGINS = [origin.strip() for origin in os.environ.get("MDSTORE_CORS_ORIGINS", DEFAULT_LOCAL_ORIGINS).split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def authenticated_claims(authorization: Optional[str] = Header(default=None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    return decode_access_token(authorization[7:].strip())

def get_current_customer(claims: dict = Depends(authenticated_claims), db: Session = Depends(get_db)) -> UserDB:
    if claims.get("role") != "customer":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Customer access required")
    user = db.query(UserDB).filter(UserDB.id == int(claims["sub"])).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Customer account is unavailable")
    if user.is_deleted:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Customer account is unavailable")
    if claims.get("ver") != user.token_version:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Customer session has been revoked")
    return user

def get_optional_customer(authorization: Optional[str] = Header(default=None), db: Session = Depends(get_db)) -> Optional[UserDB]:
    if not authorization:
        return None
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    claims = decode_access_token(authorization[7:].strip())
    if claims.get("role") != "customer":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Customer access required")
    user = db.query(UserDB).filter(UserDB.id == int(claims["sub"])).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Customer account is unavailable")
    if user.is_deleted:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Customer account is unavailable")
    if claims.get("ver") != user.token_version:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Customer session has been revoked")
    return user

def require_admin(claims: dict = Depends(authenticated_claims), db: Session = Depends(get_db)) -> AdminDB:
    if claims.get("role") != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator access required")
    admin = db.query(AdminDB).filter(AdminDB.id == int(claims["sub"]), AdminDB.is_active.is_(True)).first()
    if not admin:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Administrator account is unavailable")
    if claims.get("ver") != admin.token_version:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Administrator session has been revoked")
    return admin
# 5. مسار رفع الصور
# ---------------------------------------------------------

@app.post("/upload")
@app.post("/api/upload")
async def upload_image(file: UploadFile = File(...), _admin: AdminDB = Depends(require_admin)):
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="الملف المرفوع ليس صورة!")

    safe_filename = os.path.basename(file.filename or "product-image")
    unique_filename = f"{datetime.now().strftime('%Y%m%d%H%M%S')}_{safe_filename}"
    file_path = os.path.join(UPLOADS_DIR, unique_filename)

    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    return {
        "status": "success",
        "image_url": f"/uploads/{unique_filename}"
    }

# ---------------------------------------------------------
# 6. مسارات المنتجات
# ---------------------------------------------------------

@app.get("/products", response_model=List[ProductResponse])
def get_products(db: Session = Depends(get_db)):
    return db.query(ProductDB).all()

def serialize_homepage_banner(banner: HomepageBannerDB):
    return {
        "id": banner.id,
        "image_url": banner.image_url,
        "title_ar": banner.title_ar,
        "title_en": banner.title_en,
        "subtitle_ar": banner.subtitle_ar,
        "subtitle_en": banner.subtitle_en,
        "button_text_ar": banner.button_text_ar,
        "button_text_en": banner.button_text_en,
        "button_link": banner.button_link,
        "is_active": banner.is_active,
        "position": banner.position,
    }

def validate_homepage_banner(data: HomepageBannerWrite):
    title_ar = data.title_ar.strip()
    title_en = data.title_en.strip()
    image_url = data.image_url.strip()
    if not title_ar or not title_en:
        raise HTTPException(status_code=422, detail="Arabic and English banner titles are required")
    if not image_url or len(image_url) > 1000:
        raise HTTPException(status_code=422, detail="A valid banner image is required")
    if image_url.startswith("/uploads/"):
        relative_path = image_url.removeprefix("/uploads/").replace("/", os.sep)
        resolved = os.path.realpath(os.path.join(UPLOADS_DIR, relative_path))
        uploads_root = os.path.realpath(UPLOADS_DIR) + os.sep
        if not resolved.startswith(uploads_root) or not os.path.isfile(resolved):
            raise HTTPException(status_code=422, detail="Banner image was not found in uploads")
    else:
        parsed_image = urlparse(image_url)
        if parsed_image.scheme not in ("http", "https") or not parsed_image.netloc:
            raise HTTPException(status_code=422, detail="Banner image must be uploaded or use an HTTP(S) URL")

    button_link = data.button_link.strip() if data.button_link else None
    if button_link and button_link not in {"store-section", "offers-section", "modified-games-section"}:
        raise HTTPException(status_code=422, detail="Choose a valid homepage section for the banner button")
    if data.position < 1 or data.position > 3:
        raise HTTPException(status_code=422, detail="Banner position must be between 1 and 3")
    return {
        "image_url": image_url,
        "title_ar": title_ar,
        "title_en": title_en,
        "subtitle_ar": data.subtitle_ar.strip() if data.subtitle_ar and data.subtitle_ar.strip() else None,
        "subtitle_en": data.subtitle_en.strip() if data.subtitle_en and data.subtitle_en.strip() else None,
        "button_text_ar": data.button_text_ar.strip() if data.button_text_ar and data.button_text_ar.strip() else None,
        "button_text_en": data.button_text_en.strip() if data.button_text_en and data.button_text_en.strip() else None,
        "button_link": button_link,
        "is_active": data.is_active,
    }

def ordered_homepage_banners(db: Session):
    return db.query(HomepageBannerDB).order_by(HomepageBannerDB.position, HomepageBannerDB.id).all()

def set_homepage_banner_order(db: Session, banners: List[HomepageBannerDB]):
    for position, banner in enumerate(banners, start=1):
        banner.position = position

@app.get("/homepage/banners")
def get_homepage_banners(db: Session = Depends(get_db)):
    banners = db.query(HomepageBannerDB).filter(HomepageBannerDB.is_active.is_(True)).order_by(
        HomepageBannerDB.position, HomepageBannerDB.id
    ).all()
    return [serialize_homepage_banner(banner) for banner in banners]

@app.get("/admin/homepage/banners")
def get_admin_homepage_banners(db: Session = Depends(get_db), _admin: None = Depends(require_admin)):
    return [serialize_homepage_banner(banner) for banner in ordered_homepage_banners(db)]

@app.put("/admin/homepage/banners/order")
def update_homepage_banner_order(data: HomepageBannerOrder, db: Session = Depends(get_db), _admin: None = Depends(require_admin)):
    banners = ordered_homepage_banners(db)
    banner_ids = {banner.id for banner in banners}
    if len(data.ids) != len(banner_ids) or set(data.ids) != banner_ids:
        raise HTTPException(status_code=422, detail="Order must include every configured banner exactly once")
    by_id = {banner.id: banner for banner in banners}
    set_homepage_banner_order(db, [by_id[banner_id] for banner_id in data.ids])
    db.commit()
    return [serialize_homepage_banner(banner) for banner in ordered_homepage_banners(db)]

@app.post("/admin/homepage/banners")
def create_homepage_banner(data: HomepageBannerWrite, db: Session = Depends(get_db), _admin: None = Depends(require_admin)):
    existing = ordered_homepage_banners(db)
    if len(existing) >= 3:
        raise HTTPException(status_code=409, detail="Only three additional homepage banners are allowed")
    payload = validate_homepage_banner(data)
    banner = HomepageBannerDB(**payload, position=min(data.position, len(existing) + 1))
    db.add(banner)
    db.flush()
    order = existing
    order.insert(banner.position - 1, banner)
    set_homepage_banner_order(db, order)
    db.commit()
    db.refresh(banner)
    return serialize_homepage_banner(banner)

@app.put("/admin/homepage/banners/{banner_id}")
def update_homepage_banner(banner_id: int, data: HomepageBannerWrite, db: Session = Depends(get_db), _admin: None = Depends(require_admin)):
    banner = db.query(HomepageBannerDB).filter(HomepageBannerDB.id == banner_id).first()
    if not banner:
        raise HTTPException(status_code=404, detail="Banner not found")
    payload = validate_homepage_banner(data)
    for field, value in payload.items():
        setattr(banner, field, value)
    order = [item for item in ordered_homepage_banners(db) if item.id != banner.id]
    order.insert(min(data.position, len(order) + 1) - 1, banner)
    set_homepage_banner_order(db, order)
    db.commit()
    db.refresh(banner)
    return serialize_homepage_banner(banner)

@app.delete("/admin/homepage/banners/{banner_id}")
def delete_homepage_banner(banner_id: int, db: Session = Depends(get_db), _admin: None = Depends(require_admin)):
    banner = db.query(HomepageBannerDB).filter(HomepageBannerDB.id == banner_id).first()
    if not banner:
        raise HTTPException(status_code=404, detail="Banner not found")
    db.delete(banner)
    db.flush()
    set_homepage_banner_order(db, ordered_homepage_banners(db))
    db.commit()
    return {"status": "success"}

@app.get("/products/{product_id}/variants", response_model=List[VariantResponse])
def get_product_variants(product_id: int, db: Session = Depends(get_db)):
    if not db.query(ProductDB.id).filter(ProductDB.id == product_id).first():
        raise HTTPException(status_code=404, detail="Product not found")
    return db.query(ProductVariantDB).filter(ProductVariantDB.product_id == product_id).order_by(ProductVariantDB.id).all()

def validate_variant_data(data: VariantCreate):
    platform = data.platform.strip() if data.platform and data.platform.strip() else None
    edition = data.edition.strip() if data.edition and data.edition.strip() else None
    if not platform and not edition:
        raise HTTPException(status_code=422, detail="A platform or edition is required")
    if (platform and len(platform) > 80) or (edition and len(edition) > 80):
        raise HTTPException(status_code=422, detail="Platform and edition must be 80 characters or fewer")
    if data.price is not None and (not math.isfinite(data.price) or data.price < 0):
        raise HTTPException(status_code=422, detail="Variant price must be a finite non-negative amount")
    return platform, edition

def ensure_unique_variant(db: Session, product_id: int, platform: Optional[str], edition: Optional[str], exclude_id: Optional[int] = None):
    variants = db.query(ProductVariantDB).filter(ProductVariantDB.product_id == product_id).all()
    for variant in variants:
        if variant.id != exclude_id and (variant.platform or "").casefold() == (platform or "").casefold() and (variant.edition or "").casefold() == (edition or "").casefold():
            raise HTTPException(status_code=409, detail="This platform and edition combination already exists")

@app.put("/admin/products/{product_id}/variant-settings")
def update_variant_settings(product_id: int, data: VariantSettingsUpdate, db: Session = Depends(get_db), _admin: None = Depends(require_admin)):
    product = db.query(ProductDB).filter(ProductDB.id == product_id).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    product.requires_variants = data.requires_variants
    db.commit()
    return {"status": "success", "requires_variants": product.requires_variants}

@app.post("/admin/products/{product_id}/variants", response_model=VariantResponse)
def create_product_variant(product_id: int, data: VariantCreate, db: Session = Depends(get_db), _admin: None = Depends(require_admin)):
    product = db.query(ProductDB).filter(ProductDB.id == product_id).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    platform, edition = validate_variant_data(data)
    ensure_unique_variant(db, product_id, platform, edition)
    variant = ProductVariantDB(product_id=product_id, platform=platform, edition=edition, price=data.price, is_active=data.is_active)
    db.add(variant)
    db.commit()
    db.refresh(variant)
    return variant

@app.put("/admin/product-variants/{variant_id}", response_model=VariantResponse)
def update_product_variant(variant_id: int, data: VariantCreate, db: Session = Depends(get_db), _admin: None = Depends(require_admin)):
    variant = db.query(ProductVariantDB).filter(ProductVariantDB.id == variant_id).first()
    if not variant:
        raise HTTPException(status_code=404, detail="Variant not found")
    platform, edition = validate_variant_data(data)
    ensure_unique_variant(db, variant.product_id, platform, edition, variant_id)
    variant.platform, variant.edition, variant.price, variant.is_active = platform, edition, data.price, data.is_active
    db.commit()
    db.refresh(variant)
    return variant

@app.delete("/admin/product-variants/{variant_id}")
def delete_product_variant(variant_id: int, db: Session = Depends(get_db), _admin: None = Depends(require_admin)):
    variant = db.query(ProductVariantDB).filter(ProductVariantDB.id == variant_id).first()
    if not variant:
        raise HTTPException(status_code=404, detail="Variant not found")
    db.query(OrderItemDB).filter(OrderItemDB.variant_id == variant.id).update(
        {OrderItemDB.variant_id: None}, synchronize_session=False
    )
    db.delete(variant)
    db.commit()
    return {"status": "success"}

@app.post("/products", response_model=ProductResponse)
def create_product(product: ProductCreate, db: Session = Depends(get_db), _admin: AdminDB = Depends(require_admin)):
    if (product.price is None and not product.requires_variants) or (product.price is not None and (not math.isfinite(product.price) or product.price < 0)) or product.stock < 0:
        raise HTTPException(status_code=422, detail="Product price and stock must be non-negative finite values")
    new_product = ProductDB(**product.model_dump())
    db.add(new_product)
    db.commit()
    db.refresh(new_product)
    return new_product

@app.put("/products/{product_id}")
def update_product(product_id: int, updated_data: ProductCreate, db: Session = Depends(get_db), _admin: AdminDB = Depends(require_admin)):
    product = db.query(ProductDB).filter(ProductDB.id == product_id).first()
    if not product:
        raise HTTPException(status_code=404, detail="المنتج غير موجود")
    
    variants_required = updated_data.requires_variants or bool(product.variants)
    if (updated_data.price is None and not variants_required) or (updated_data.price is not None and (not math.isfinite(updated_data.price) or updated_data.price < 0)) or updated_data.stock < 0:
        raise HTTPException(status_code=422, detail="Product price and stock must be non-negative finite values")
    product.name = updated_data.name
    product.price = updated_data.price
    product.stock = updated_data.stock
    product.category = updated_data.category
    product.description = updated_data.description
    product.image_url = updated_data.image_url
    product.badge = updated_data.badge
    product.requires_variants = updated_data.requires_variants
    if "is_active" in updated_data.model_fields_set:
        product.is_active = updated_data.is_active
    if "show_in_modified_games" in updated_data.model_fields_set:
        product.show_in_modified_games = updated_data.show_in_modified_games
    
    db.commit()
    db.refresh(product)
    return {"status": "success", "message": f"تم تحديث المنتج رقم {product_id} بنجاح"}

@app.delete("/products/{product_id}")
def delete_product(product_id: int, db: Session = Depends(get_db), _admin: AdminDB = Depends(require_admin)):
    product = db.query(ProductDB).filter(ProductDB.id == product_id).first()
    if not product:
        raise HTTPException(status_code=404, detail="المنتج غير موجود")
    db.delete(product)
    db.commit()
    return {"message": "تم مسح المنتج بنجاح"}

# ---------------------------------------------------------
# 7. مسارات تسجيل دخول الأدمن
# ---------------------------------------------------------

ORDER_STATUSES = ("pending", "confirmed", "processing", "completed", "cancelled")
ORDER_STATUS_TRANSITIONS = {
    "pending": {"confirmed", "cancelled"},
    "confirmed": {"processing", "cancelled"},
    "processing": {"completed", "cancelled"},
    "completed": set(),
    "cancelled": set(),
}
MONEY_QUANTUM = Decimal("0.01")

def money_value(value: Any, *, label: str) -> Decimal:
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        raise HTTPException(status_code=422, detail=f"Invalid {label}")
    if not amount.is_finite() or amount < 0:
        raise HTTPException(status_code=422, detail=f"Invalid {label}")
    return amount.quantize(MONEY_QUANTUM, rounding=ROUND_HALF_UP)

def shipping_fee_table() -> dict[str, tuple[str, Decimal, str, str]]:
    raw = os.environ.get("MDSTORE_SHIPPING_FEES_JSON", "").strip()
    if not raw:
        return {}
    try:
        values = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(status_code=503, detail="Delivery fees are not configured correctly")
    if not isinstance(values, dict):
        raise HTTPException(status_code=503, detail="Delivery fees are not configured correctly")
    result = {}
    for area, setting in values.items():
        if not isinstance(area, str) or not area.strip():
            raise HTTPException(status_code=503, detail="Delivery fees are not configured correctly")
        label_ar = area.strip()
        label_en = area.strip()
        fee = setting
        if isinstance(setting, dict):
            fee = setting.get("fee")
            label_ar = str(setting.get("label_ar") or label_ar).strip()
            label_en = str(setting.get("label_en") or label_en).strip()
        result[area.strip().casefold()] = (area.strip(), money_value(fee, label="delivery fee"), label_ar, label_en)
    return result


# The checkout accepts governorates as the customer's delivery region. Fees are
# still sourced exclusively from MDSTORE_SHIPPING_FEES_JSON; this list provides
# names only and deliberately contains no default prices.
EGYPT_GOVERNORATES = [
    ("القاهرة", "Cairo"), ("الجيزة", "Giza"), ("الإسكندرية", "Alexandria"),
    ("القليوبية", "Qalyubia"), ("البحيرة", "Beheira"), ("مطروح", "Matrouh"),
    ("كفر الشيخ", "Kafr El Sheikh"), ("الغربية", "Gharbia"), ("المنوفية", "Monufia"),
    ("الدقهلية", "Dakahlia"), ("دمياط", "Damietta"), ("الشرقية", "Sharqia"),
    ("بورسعيد", "Port Said"), ("الإسماعيلية", "Ismailia"), ("السويس", "Suez"),
    ("شمال سيناء", "North Sinai"), ("جنوب سيناء", "South Sinai"), ("الفيوم", "Faiyum"),
    ("بني سويف", "Beni Suef"), ("المنيا", "Minya"), ("أسيوط", "Asyut"),
    ("سوهاج", "Sohag"), ("قنا", "Qena"), ("الأقصر", "Luxor"),
    ("أسوان", "Aswan"), ("البحر الأحمر", "Red Sea"), ("الوادي الجديد", "New Valley"),
]

def normalized_delivery_name(value: str) -> str:
    return " ".join(str(value).split()).casefold()

def governorate_fee_match(governorate: str, fee_table: dict[str, tuple[str, Decimal, str, str]]):
    selected = normalized_delivery_name(governorate)
    governorate_names = next((names for names in EGYPT_GOVERNORATES
                              if selected in {normalized_delivery_name(names[0]), normalized_delivery_name(names[1])}), None)
    if not governorate_names:
        return None
    accepted_names = {normalized_delivery_name(name) for name in governorate_names}
    for key, setting in fee_table.items():
        if key in accepted_names or normalized_delivery_name(setting[0]) in accepted_names \
                or normalized_delivery_name(setting[2]) in accepted_names \
                or normalized_delivery_name(setting[3]) in accepted_names:
            return setting
    return None

def canonical_governorate(value: str) -> Optional[str]:
    normalized = normalized_delivery_name(value)
    for arabic_name, english_name in EGYPT_GOVERNORATES:
        if normalized in {normalized_delivery_name(arabic_name), normalized_delivery_name(english_name)}:
            return arabic_name
    return None

def configured_payment_methods() -> list[str]:
    methods = ["cash_on_delivery"]
    if paymob_checkout_configured():
        methods.append("paymob")
    return methods


def _paymob_session_for_order(db: Session, order: OrderDB, user: UserDB) -> str:
    """Create and persist one provider attempt for a server-priced order."""
    full_name = (order.customer_name or user.name or "MD Store customer").strip()
    name_parts = full_name.split(maxsplit=1)
    first_name = name_parts[0] if name_parts else "MD"
    last_name = name_parts[1] if len(name_parts) > 1 else "Store"
    city = order.delivery_area or "Cairo"
    billing_data = {
        "first_name": first_name[:100],
        "last_name": last_name[:100],
        "phone_number": order.phone or "",
        "email": user.email or "customer@mdstore.invalid",
        "street": order.address or "Store pickup",
        "building": "NA",
        "floor": "NA",
        "apartment": "NA",
        "city": city,
        "country": "EGY",
        "state": city,
    }
    # Paymob's item-price validator can interpret quantity differently across
    # integrations. Use one honest order-total line so its amount is exactly
    # the persisted transaction total, including any delivery fee.
    total_cents = int((Decimal(str(order.total_price)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    line_items = [{
        "name": f"MD Store order #{order.id}",
        "amount": total_cents,
        "description": f"MD Store order total #{order.id}",
        "quantity": 1,
    }]

    session = create_paymob_checkout_session(
        order_id=order.id,
        amount=Decimal(str(order.total_price)),
        currency="EGP",
        items=line_items,
        billing_data=billing_data,
    )
    db.add(PaymobPaymentAttemptDB(
        order_id=order.id,
        paymob_order_id=str(session["paymob_order_id"]),
        paymob_intention_id=session["intention_id"],
        amount_cents=session["amount_cents"],
        currency=session["currency"],
        integration_id=session["integration_id"],
        status="pending",
    ))
    return session["checkout_url"]

@app.get("/delivery/options")
def get_delivery_options():
    fee_table = shipping_fee_table()
    result = []
    for arabic_name, english_name in EGYPT_GOVERNORATES:
        match = governorate_fee_match(arabic_name, fee_table)
        result.append({
            "area": arabic_name,
            "shipping_fee": float(match[1]) if match else None,
            "configured": match is not None,
            "label_ar": arabic_name,
            "label_en": english_name,
        })
    return result

@app.get("/payment/options")
def get_payment_options():
    return configured_payment_methods()


@app.post("/payments/paymob/callback")
async def paymob_transaction_callback(
    request: Request,
    hmac_signature: Optional[str] = Query(default=None, alias="hmac"),
    db: Session = Depends(get_db),
):
    """Paymob Transaction Processed callback; only its signed POST can mark paid."""
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid Paymob callback body")
    if not isinstance(payload, dict) or not verify_paymob_webhook(payload, hmac_signature or ""):
        raise HTTPException(status_code=401, detail="Invalid Paymob callback signature")
    transaction = payload.get("obj")
    if payload.get("type") != "TRANSACTION" or not isinstance(transaction, dict):
        raise HTTPException(status_code=400, detail="Unsupported Paymob callback type")
    try:
        transaction_id = str(int(transaction["id"]))
        provider_order_id = str(int(transaction["order"]["id"]))
        amount_cents = int(transaction["amount_cents"])
        integration_id = int(transaction["integration_id"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Incomplete Paymob transaction callback")
    currency = transaction.get("currency")
    provider_order = transaction.get("order") if isinstance(transaction.get("order"), dict) else {}
    try:
        provider_order_amount = int(provider_order["amount_cents"]) if provider_order.get("amount_cents") is not None else None
        provider_paid_amount = int(provider_order["paid_amount_cents"]) if provider_order.get("paid_amount_cents") is not None else None
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid Paymob transaction amount")
    attempt = db.query(PaymobPaymentAttemptDB).filter_by(paymob_order_id=provider_order_id).first()
    if not attempt:
        raise HTTPException(status_code=404, detail="Paymob order reference not found")
    if attempt.transaction_id == transaction_id:
        return {"received": True, "duplicate": True}
    if attempt.transaction_id is not None:
        return {"received": True, "duplicate": True}
    order = db.query(OrderDB).filter(OrderDB.id == attempt.order_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Store order not found")
    expected_cents = int((Decimal(str(order.total_price)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    if (
        amount_cents != attempt.amount_cents
        or amount_cents != expected_cents
        or (provider_order_amount is not None and provider_order_amount != expected_cents)
        or (transaction.get("success") is True and provider_paid_amount is not None and provider_paid_amount != expected_cents)
        or currency != attempt.currency
        or currency != "EGP"
        or integration_id != attempt.integration_id
    ):
        raise HTTPException(status_code=409, detail="Paymob transaction does not match the store order")

    paid = (
        transaction.get("success") is True
        and transaction.get("pending") is False
        and transaction.get("error_occured") is False
        and transaction.get("is_voided") is False
        and transaction.get("is_refunded") is False
    )
    claimed_attempt = db.query(PaymobPaymentAttemptDB).filter(
        PaymobPaymentAttemptDB.id == attempt.id,
        PaymobPaymentAttemptDB.transaction_id.is_(None),
    ).update({
        PaymobPaymentAttemptDB.transaction_id: transaction_id,
        PaymobPaymentAttemptDB.status: "succeeded" if paid else "failed",
    }, synchronize_session=False)
    if claimed_attempt != 1:
        db.rollback()
        return {"received": True, "duplicate": True}
    paid_applied = False
    if paid and order.status != "cancelled":
        changed = db.query(OrderDB).filter(
            OrderDB.id == order.id,
            OrderDB.payment_status == "unpaid",
            OrderDB.payment_method == "paymob",
        ).update({
            OrderDB.payment_status: "paid",
            OrderDB.payment_collected_at: datetime.utcnow(),
            OrderDB.payment_collected_by: None,
            OrderDB.cancellation_fee_status: "paid" if order.status == "cancelled" and order.cancellation_fee > 0 else order.cancellation_fee_status,
        }, synchronize_session=False)
        if changed == 0:
            db.query(PaymobPaymentAttemptDB).filter_by(id=attempt.id).update({PaymobPaymentAttemptDB.status: "succeeded_unapplied"}, synchronize_session=False)
        else:
            paid_applied = True
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.query(PaymobPaymentAttemptDB).filter_by(transaction_id=transaction_id).first()
        if existing:
            return {"received": True, "duplicate": True}
        raise HTTPException(status_code=409, detail="Paymob callback could not be recorded")
    return {"received": True, "paid": paid_applied}

def serialize_order(order: OrderDB):
    allowed_statuses = list(ORDER_STATUS_TRANSITIONS.get(order.status, set()))
    if order.payment_status != "paid" and "completed" in allowed_statuses:
        allowed_statuses.remove("completed")
    return {
        "id": order.id,
        "user_id": order.user_id,
        "customer_name": order.customer_name,
        "phone": order.phone,
        "address": order.address,
        "delivery_method": order.delivery_method,
        "delivery_area": order.delivery_area,
        "shipping_fee": order.shipping_fee,
        "total_price": order.total_price,
        "status": order.status,
        "fulfillment_status": order.status,
        "payment_method": order.payment_method,
        "payment_status": order.payment_status,
        "cancellation_fee": order.cancellation_fee,
        "cancellation_fee_status": order.cancellation_fee_status,
        "payment_collected_at": order.payment_collected_at.isoformat() if order.payment_collected_at else None,
        "allowed_statuses": [order.status, *sorted(allowed_statuses)],
        "created_at": order.created_at.isoformat() if order.created_at else None,
        "items": [{
            "id": item.id,
            "product_id": item.product_id,
            "product_name": item.product_name,
            "variant": item.variant,
            "variant_id": item.variant_id,
            "platform": item.platform,
            "edition": item.edition,
            "unit_price": item.unit_price,
            "quantity": item.quantity,
            "line_total": item.line_total,
        } for item in order.items],
    }

@app.post("/orders")
def create_order(data: OrderCreate, idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key"), db: Session = Depends(get_db), current_user: UserDB = Depends(get_current_customer)):
    if not data.items:
        raise HTTPException(status_code=400, detail="Order must contain at least one item")
    if any(item.product_id <= 0 or item.quantity <= 0 for item in data.items):
        raise HTTPException(status_code=400, detail="Product IDs and quantities must be positive")
    if not idempotency_key or not 8 <= len(idempotency_key) <= 128 or any(ord(char) < 33 or ord(char) > 126 for char in idempotency_key):
        raise HTTPException(status_code=400, detail="A valid Idempotency-Key header is required")
    payment_methods = configured_payment_methods()
    if data.payment_method == "online_payment_demo":
        raise HTTPException(status_code=422, detail="The legacy demo payment method is no longer available")
    if data.payment_method not in payment_methods:
        raise HTTPException(status_code=422, detail="Choose an enabled payment method")

    fingerprint_payload = data.model_dump(exclude={"user_id"})
    fingerprint = hashlib.sha256(json.dumps(fingerprint_payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()
    prior_order = db.query(OrderDB).filter_by(user_id=current_user.id, idempotency_key=idempotency_key).first()
    if prior_order:
        if prior_order.request_fingerprint != fingerprint:
            raise HTTPException(status_code=409, detail="This idempotency key was already used for a different order")
        if prior_order.payment_method == "paymob" and prior_order.payment_status != "paid":
            if prior_order.status == "cancelled":
                raise HTTPException(status_code=409, detail="This order has been cancelled")
            try:
                checkout_url = _paymob_session_for_order(db, prior_order, current_user)
                db.commit()
            except (PaymobNotConfigured, PaymobProviderError, ValueError) as exc:
                db.rollback()
                raise HTTPException(status_code=503, detail=str(exc)) from None
            result = serialize_order(prior_order)
            result["checkout_url"] = checkout_url
            return result
        return serialize_order(prior_order)

    contact_values = {
        "recipient_name": data.recipient_name.strip(),
        "phone": data.phone.strip(),
        "address": data.address.strip(),
        "delivery_area": data.delivery_area.strip(),
    }
    if not contact_values["recipient_name"] or not contact_values["phone"]:
        raise HTTPException(status_code=422, detail="Recipient name and phone are required")
    if data.delivery_method == "home_delivery":
        if not contact_values["address"] or not contact_values["delivery_area"]:
            raise HTTPException(status_code=422, detail="A full address and governorate are required for home delivery")
        selected_governorate = canonical_governorate(contact_values["delivery_area"])
        if not selected_governorate:
            raise HTTPException(status_code=422, detail="Choose a valid Egyptian governorate")
        fee_table = shipping_fee_table()
        area_match = governorate_fee_match(selected_governorate, fee_table)
        if not fee_table:
            raise HTTPException(status_code=503, detail="Checkout is unavailable until delivery fees are configured")
        if not area_match:
            raise HTTPException(status_code=422, detail="Delivery fees are not configured for the selected governorate")
        delivery_area, shipping_fee = selected_governorate, area_match[1]
    else:
        delivery_area, shipping_fee = None, Decimal("0.00")
        contact_values["address"] = ""

    quantities = {}
    for item in data.items:
        quantities[item.product_id] = quantities.get(item.product_id, 0) + item.quantity

    try:
        if data.user_id is not None and data.user_id != current_user.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Customer identity does not match the authenticated account")
        user = current_user

        products = db.query(ProductDB).filter(ProductDB.id.in_(quantities.keys())).all()
        products_by_id = {product.id: product for product in products}
        missing_ids = set(quantities) - set(products_by_id)
        if missing_ids:
            raise HTTPException(status_code=404, detail=f"Product not found: {min(missing_ids)}")

        subtotal = Decimal("0.00")
        item_snapshots = []
        for product_id, quantity in quantities.items():
            product = products_by_id[product_id]
            if not product.is_active:
                raise HTTPException(status_code=409, detail=f"Product {product.name} is no longer available")
            if product.show_in_modified_games:
                raise HTTPException(status_code=422, detail=f"Modified-console games must be arranged through WhatsApp or a branch visit: {product.name}")
            if product.stock is None or quantity > product.stock:
                raise HTTPException(status_code=409, detail=f"Insufficient stock for {product.name}")
        for requested_item in data.items:
            product = products_by_id[requested_item.product_id]
            if product.requires_variants or product.variants:
                if not requested_item.variant_id:
                    raise HTTPException(status_code=422, detail=f"Select an available option for {product.name}")
                selected = db.query(ProductVariantDB).filter(
                    ProductVariantDB.id == requested_item.variant_id,
                    ProductVariantDB.product_id == product.id,
                    ProductVariantDB.is_active.is_(True),
                ).first()
                if not selected:
                    raise HTTPException(status_code=422, detail=f"Selected option is unavailable for {product.name}")
                if selected.price is None:
                    raise HTTPException(status_code=409, detail=f"Selected option has no configured price for {product.name}")
                unit_price = money_value(selected.price, label="variant price")
                if requested_item.platform != selected.platform or requested_item.edition != selected.edition:
                    raise HTTPException(status_code=422, detail=f"Selected option does not match {product.name}")
                variant_id = selected.id
                platform, edition = selected.platform, selected.edition
                variant_label = " / ".join(value for value in (platform, edition) if value) or None
            else:
                if requested_item.variant_id is not None:
                    raise HTTPException(status_code=422, detail=f"This product does not have configurable options: {product.name}")
                if product.price is None:
                    raise HTTPException(status_code=400, detail=f"Product {product.id} has an invalid price")
                unit_price = money_value(product.price, label="product price")
                variant_id = platform = edition = variant_label = None
            if requested_item.expected_price is not None and money_value(requested_item.expected_price, label="expected price") != unit_price:
                raise HTTPException(status_code=409, detail=f"Price changed for {product.name}; refresh the cart before checkout")
            line_total = (unit_price * requested_item.quantity).quantize(MONEY_QUANTUM, rounding=ROUND_HALF_UP)
            subtotal += line_total
            item_snapshots.append((product, requested_item.quantity, variant_label, variant_id, platform, edition, unit_price, line_total))

        for product_id, quantity in quantities.items():
            product = products_by_id[product_id]
            changed = db.query(ProductDB).filter(
                ProductDB.id == product_id,
                ProductDB.stock >= quantity,
                ProductDB.is_active.is_(True),
            ).update({ProductDB.stock: ProductDB.stock - quantity}, synchronize_session=False)
            if changed != 1:
                raise HTTPException(status_code=409, detail=f"Insufficient stock for {product.name}")

        order = OrderDB(
            user_id=user.id,
            customer_name=contact_values["recipient_name"],
            phone=contact_values["phone"],
            address=contact_values["address"],
            delivery_method=data.delivery_method,
            delivery_area=delivery_area,
            shipping_fee=float(shipping_fee),
            total_price=float(subtotal + shipping_fee),
            idempotency_key=idempotency_key,
            request_fingerprint=fingerprint,
            status="pending",
            payment_method=data.payment_method,
            payment_status="unpaid",
        )
        db.add(order)
        db.flush()
        for product, quantity, variant, variant_id, platform, edition, unit_price, line_total in item_snapshots:
            db.add(OrderItemDB(
                order=order,
                product_id=product.id,
                product_name=product.name,
                variant=variant,
                variant_id=variant_id,
                platform=platform,
                edition=edition,
                unit_price=float(unit_price),
                quantity=quantity,
                line_total=float(line_total),
            ))
        checkout_url = None
        if data.payment_method == "paymob":
            try:
                checkout_url = _paymob_session_for_order(db, order, user)
            except (PaymobNotConfigured, PaymobProviderError, ValueError) as exc:
                db.rollback()
                raise HTTPException(status_code=503, detail=str(exc)) from None
        db.commit()
        db.refresh(order)
        result = serialize_order(order)
        if checkout_url:
            result["checkout_url"] = checkout_url
        return result
    except IntegrityError:
        db.rollback()
        existing = db.query(OrderDB).filter_by(user_id=current_user.id, idempotency_key=idempotency_key).first()
        if existing and existing.request_fingerprint == fingerprint:
            return serialize_order(existing)
        if existing:
            raise HTTPException(status_code=409, detail="This idempotency key was already used for a different order")
        raise HTTPException(status_code=409, detail="Order could not be saved; retry with the same idempotency key")
    except OperationalError as exc:
        db.rollback()
        if "locked" in str(exc).lower():
            raise HTTPException(status_code=409, detail="Inventory is being updated; retry with the same idempotency key")
        raise
    except Exception:
        db.rollback()
        raise

@app.get("/users/{user_id}/orders")
def get_customer_orders(user_id: int, db: Session = Depends(get_db), current_user: UserDB = Depends(get_current_customer)):
    if user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You can only access your own orders")
    return [serialize_order(order) for order in db.query(OrderDB)
            .filter(OrderDB.user_id == user_id)
            .order_by(OrderDB.created_at.desc(), OrderDB.id.desc()).all()]

@app.get("/admin/orders")
def get_all_orders(db: Session = Depends(get_db), _admin: AdminDB = Depends(require_admin)):
    return [serialize_order(order) for order in db.query(OrderDB)
            .order_by(OrderDB.created_at.desc(), OrderDB.id.desc()).all()]

@app.put("/admin/orders/{order_id}/status")
def update_order_status(order_id: int, data: OrderStatusUpdate, db: Session = Depends(get_db), _admin: AdminDB = Depends(require_admin)):
    if data.status not in ORDER_STATUSES:
        raise HTTPException(status_code=400, detail=f"Status must be one of: {', '.join(ORDER_STATUSES)}")

    try:
        order = db.query(OrderDB).filter(OrderDB.id == order_id).first()
        if not order:
            raise HTTPException(status_code=404, detail="Order not found")
        if data.status == order.status:
            return serialize_order(order)
        if data.status not in ORDER_STATUS_TRANSITIONS.get(order.status, set()):
            raise HTTPException(status_code=409, detail=f"Cannot transition order from {order.status} to {data.status}")
        if data.status == "cancelled" and order.payment_status == "paid":
            raise HTTPException(status_code=409, detail="Cancellation after collection requires a supported refund workflow")
        if data.status == "completed" and order.payment_status != "paid":
            raise HTTPException(status_code=409, detail="Record the collected payment before completing delivery")
        previous_status = order.status
        updated = db.query(OrderDB).filter(
            OrderDB.id == order.id,
            OrderDB.status == previous_status,
        ).update({OrderDB.status: data.status}, synchronize_session=False)
        if updated != 1:
            raise HTTPException(status_code=409, detail="Order status changed; refresh and try again")
        if data.status == "cancelled":
            order.cancellation_fee = order.shipping_fee
            order.cancellation_fee_status = "due" if order.shipping_fee > 0 else "not_applicable"
            for item in order.items:
                if item.product_id is not None:
                    db.query(ProductDB).filter(ProductDB.id == item.product_id).update(
                        {ProductDB.stock: ProductDB.stock + item.quantity}, synchronize_session=False)
        db.commit()
        db.refresh(order)
        return serialize_order(order)
    except Exception:
        db.rollback()
        raise

@app.post("/admin/orders/{order_id}/payment")
def record_order_payment(order_id: int, data: PaymentCollectionUpdate, db: Session = Depends(get_db), current_admin: AdminDB = Depends(require_admin)):
    if not data.collected:
        raise HTTPException(status_code=422, detail="Only an actual collection can be recorded")
    order = db.query(OrderDB).filter(OrderDB.id == order_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if order.payment_method == "paymob":
        raise HTTPException(status_code=409, detail="Paymob payments can only be confirmed by a verified provider callback")
    if order.status == "cancelled":
        if order.cancellation_fee_status != "due" or order.cancellation_fee <= 0:
            raise HTTPException(status_code=409, detail="No cancellation delivery fee is due")
        changed = db.query(OrderDB).filter(
            OrderDB.id == order_id,
            OrderDB.status == "cancelled",
            OrderDB.cancellation_fee_status == "due",
        ).update({
            OrderDB.cancellation_fee_status: "paid",
            OrderDB.payment_collected_at: datetime.utcnow(),
            OrderDB.payment_collected_by: current_admin.id,
        }, synchronize_session=False)
        if changed != 1:
            db.rollback()
            raise HTTPException(status_code=409, detail="Cancellation fee state changed; refresh and try again")
        db.commit()
        order = db.query(OrderDB).filter(OrderDB.id == order_id).first()
        db.refresh(order)
        return serialize_order(order)
    if order.payment_status == "paid":
        return serialize_order(order)
    changed = db.query(OrderDB).filter(
        OrderDB.id == order_id,
        OrderDB.payment_status == "unpaid",
        OrderDB.status != "cancelled",
    ).update({
        OrderDB.payment_status: "paid",
        OrderDB.payment_collected_at: datetime.utcnow(),
        OrderDB.payment_collected_by: current_admin.id,
    }, synchronize_session=False)
    if changed != 1:
        db.rollback()
        order = db.query(OrderDB).filter(OrderDB.id == order_id).first()
        if order and order.payment_status == "paid":
            return serialize_order(order)
        raise HTTPException(status_code=409, detail="Order payment state changed; refresh and try again")
    db.commit()
    db.refresh(order)
    return serialize_order(order)

@app.post("/admin/login")
def admin_login(credentials: AdminLogin, db: Session = Depends(get_db)):
    username = credentials.username.strip().lower()
    admin = db.query(AdminDB).filter(func.lower(AdminDB.username) == username, AdminDB.is_active.is_(True)).first()
    if not admin or not verify_password(credentials.password, admin.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")
    return {
        "status": "success",
        "token": create_access_token(admin.id, "admin", admin.token_version),
        "token_type": "bearer",
    }

@app.get("/admin/me")
def get_current_admin_profile(current_admin: AdminDB = Depends(require_admin)):
    return {"id": current_admin.id, "username": current_admin.username}

@app.post("/admin/logout")
def admin_logout(current_admin: AdminDB = Depends(require_admin), db: Session = Depends(get_db)):
    current_admin.token_version += 1
    db.commit()
    return {"status": "success"}

# ---------------------------------------------------------
# 8. مسارات المستخدمين والاهتمامات
# ---------------------------------------------------------

@app.post("/users")
def create_or_get_user(user: UserCreate, db: Session = Depends(get_db)):
    email_clean = user.email.strip().lower()
    name_clean = user.name.strip()
    phone_clean = user.phone.strip() if user.phone else None

    existing_by_email = db.query(UserDB).filter(func.lower(UserDB.email) == email_clean).first()
    if existing_by_email:
        raise HTTPException(status_code=400, detail="البريد الإلكتروني هذا مستخدم بالفعل!")

    existing_by_name = db.query(UserDB).filter(func.lower(UserDB.name) == name_clean.lower()).first()
    if existing_by_name:
        raise HTTPException(status_code=400, detail="اسم المستخدم هذا مستخدم بالفعل!")

    if phone_clean:
        existing_by_phone = db.query(UserDB).filter(UserDB.phone == phone_clean).first()
        if existing_by_phone:
            raise HTTPException(status_code=400, detail="رقم الهاتف هذا مستخدم بالفعل!")

    user_data = user.model_dump(exclude={"password"})
    user_data['email'] = email_clean
    user_data['name'] = name_clean
    user_data['phone'] = phone_clean

    new_user = UserDB(**user_data, password="", password_hash=hash_password(user.password))
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    return {
        "status": "success",
        "token": create_access_token(new_user.id, "customer", new_user.token_version),
        "token_type": "bearer",
        "id": new_user.id,
        "name": new_user.name,
        "email": new_user.email,
        "phone": new_user.phone,
        "address": new_user.address
    }

@app.post("/login")
@app.post("/users/login")
def user_login(credentials: UserLogin, db: Session = Depends(get_db)):
    query_val = (credentials.identifier or credentials.email or credentials.phone or "").strip()
    
    if not query_val:
        raise HTTPException(status_code=400, detail="يرجى إدخال البريد الإلكتروني أو رقم الهاتف")
    
    query_val_lower = query_val.lower()

    user = db.query(UserDB).filter(
        or_(
            func.lower(UserDB.email) == query_val_lower,
            UserDB.phone == query_val,
            func.lower(UserDB.name) == query_val_lower
        )
    ).first()

    # إذا كان المستخدم غير موجود أو كلمة المرور غير صحيحة، نعيد رسالة عامة موحدة
    if not user or not verify_password(credentials.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    return {
        "status": "success",
        "message": "تم تسجيل الدخول بنجاح",
        "token": create_access_token(user.id, "customer", user.token_version),
        "token_type": "bearer",
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "phone": user.phone,
        "address": user.address
    }

@app.get("/users/me")
def get_current_customer_profile(current_user: UserDB = Depends(get_current_customer)):
    return {
        "id": current_user.id,
        "name": current_user.name,
        "email": current_user.email,
        "phone": current_user.phone,
        "address": current_user.address,
    }

@app.post("/users/logout")
def customer_logout(current_user: UserDB = Depends(get_current_customer), db: Session = Depends(get_db)):
    current_user.token_version += 1
    db.commit()
    return {"status": "success"}

@app.post("/users/{user_id}/interest")
def track_user_interest(user_id: int, data: TrackInterestCategory, db: Session = Depends(get_db), current_user: UserDB = Depends(get_current_customer)):
    if user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You can only update your own interests")

    product = None
    if data.interest_type == "product":
        product = db.query(ProductDB).filter(ProductDB.id == data.product_id, ProductDB.is_active.is_(True)).first()
        if not product:
            raise HTTPException(status_code=404, detail="Product not found")
        item_name = product.name
        normalized_value = str(product.id)
    else:
        raw_value = data.category or ""
        item_name = re.sub(r"\s+", " ", raw_value).strip()
        if not item_name:
            return {"status": "ignored"}
        normalized_value = item_name.casefold() if data.interest_type == "search" else item_name.lower()

    existing = db.query(UserInterestDB).filter(
        UserInterestDB.user_id == user_id,
        UserInterestDB.interest_type == data.interest_type,
        UserInterestDB.normalized_value == normalized_value,
    ).first()
    if existing:
        return {"status": "already_recorded"}

    db.add(UserInterestDB(
        user_id=user_id,
        category=item_name,
        views_count=1,
        interest_type=data.interest_type,
        normalized_value=normalized_value,
        product_id=product.id if product else None,
        created_at=datetime.utcnow(),
    ))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        duplicate = db.query(UserInterestDB.id).filter(
            UserInterestDB.user_id == user_id,
            UserInterestDB.interest_type == data.interest_type,
            UserInterestDB.normalized_value == normalized_value,
        ).first()
        if duplicate:
            return {"status": "already_recorded"}
        raise
    return {"status": "success"}

@app.delete("/users/{user_id}/interest")
def delete_user_interest(user_id: int, data: TrackInterestCategory, db: Session = Depends(get_db), _admin: AdminDB = Depends(require_admin)):
    if data.interest_id is None and (not data.category or not data.category.strip()):
        raise HTTPException(status_code=422, detail="An interest value is required")
    interest_query = db.query(UserInterestDB).filter(UserInterestDB.user_id == user_id)
    if data.interest_id is not None:
        interest_query = interest_query.filter(UserInterestDB.id == data.interest_id)
    else:
        interest_query = interest_query.filter(func.lower(UserInterestDB.category) == data.category.strip().lower())
    interest = interest_query.first()
    if interest:
        db.delete(interest)
        db.commit()
        return {"status": "success", "message": "تم مسح الاهتمام بنجاح"}
    raise HTTPException(status_code=404, detail="الاهتمام غير موجود")

@app.get("/admin/users")
def get_all_users_for_admin(db: Session = Depends(get_db), _admin: AdminDB = Depends(require_admin)):
    users = db.query(UserDB).all()
    result = []
    for u in users:
        user_repairs = [{
            "id": r.id,
            "device_type": r.device_type,
            "phone": r.phone,
            "issue_description": r.issue_description,
            "status": r.status,
            "created_at": r.created_at.strftime("%Y-%m-%d %I:%M %p") if r.created_at else "-"
        } for r in u.repairs]

        user_trades = [{
            "id": t.id,
            "item_details": t.item_details,
            "condition_details": t.condition_details,
            "status": t.status,
            "created_at": t.created_at.strftime("%Y-%m-%d %I:%M %p") if t.created_at else "-"
        } for t in u.trades]

        user_interests = []
        for interest in db.query(UserInterestDB).filter(UserInterestDB.user_id == u.id).order_by(UserInterestDB.created_at.desc(), UserInterestDB.id.desc()).all():
            product = db.query(ProductDB).filter(ProductDB.id == interest.product_id).first() if interest.product_id else None
            user_interests.append({
                "id": interest.id,
                "item": product.name if product else interest.category,
                "type": interest.interest_type or "category",
                "product_id": interest.product_id,
                "count": interest.views_count,
                "created_at": interest.created_at.strftime("%Y-%m-%d %H:%M") if interest.created_at else "",
            })

        result.append({
            "id": u.id,
            "name": f"حساب محذوف #{u.id}" if u.is_deleted else u.name,
            "email": "—" if u.is_deleted else u.email,
            "phone": "—" if u.is_deleted else (u.phone or "غير محدد"),
            "address": "—" if u.is_deleted else (u.address or "غير محدد"),
            "is_deleted": u.is_deleted,
            "deleted_at": u.deleted_at.strftime("%Y-%m-%d %H:%M") if u.deleted_at else "",
            "repairs": user_repairs,
            "trades": user_trades,
            "interests": user_interests
        })
    return result

@app.delete("/admin/users/{user_id}")
def delete_admin_user(user_id: int, db: Session = Depends(get_db), current_admin: AdminDB = Depends(require_admin)):
    if user_id <= 0:
        raise HTTPException(status_code=404, detail="Customer account not found")
    user = db.query(UserDB).filter(UserDB.id == user_id).first()
    if not user or user.is_deleted:
        raise HTTPException(status_code=404, detail="Customer account not found")

    # Keep the user row as a tombstone because orders, ratings, repairs, trades,
    # interests and chat history reference its id. Revoke sessions and erase profile PII.
    user.name = f"حساب محذوف #{user.id}"
    user.email = f"deleted-user-{user.id}@deleted.invalid"
    user.phone = None
    user.address = None
    user.password = None
    user.password_hash = None
    user.token_version += 1
    user.is_deleted = True
    user.deleted_at = datetime.utcnow()
    db.commit()
    logging.getLogger("mdstore.audit").warning(
        "ADMIN_ACTION delete_customer admin_id=%s customer_id=%s mode=anonymized",
        current_admin.id, user.id,
    )
    return {"status": "success", "id": user.id, "deleted_at": user.deleted_at.strftime("%Y-%m-%d %H:%M")}

# ---------------------------------------------------------
# 9. مسارات الصيانة والتقييم (تحديث وتغيير الحالة والمسح)
# ---------------------------------------------------------

@app.post("/repairs")
@app.post("/api/repairs")
def create_repair(repair: RepairCreate, db: Session = Depends(get_db), current_user: UserDB = Depends(get_current_customer)):
    if repair.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Customer identity does not match the authenticated account")

    new_repair = RepairDB(
        user_id=repair.user_id,
        phone=repair.phone,
        device_type=repair.device_type,
        issue_description=repair.issue_description
    )
    db.add(new_repair)
    db.commit()
    db.refresh(new_repair)
    return {
        "status": "success",
        "message": "تم تقديم طلب الصيانة بنجاح",
        "repair_id": new_repair.id
    }

@app.put("/repairs/{repair_id}/status")
def update_repair_status(repair_id: int, data: StatusUpdate, db: Session = Depends(get_db), _admin: AdminDB = Depends(require_admin)):
    repair = db.query(RepairDB).filter(RepairDB.id == repair_id).first()
    if not repair:
        raise HTTPException(status_code=404, detail="طلب الصيانة غير موجود")
    repair.status = data.status
    db.commit()
    return {"status": "success", "message": "تم تحديث حالة طلب الصيانة"}

@app.delete("/repairs/{repair_id}")
def delete_repair(repair_id: int, db: Session = Depends(get_db), _admin: AdminDB = Depends(require_admin)):
    repair = db.query(RepairDB).filter(RepairDB.id == repair_id).first()
    if not repair:
        raise HTTPException(status_code=404, detail="طلب الصيانة غير موجود")
    db.delete(repair)
    db.commit()
    return {"status": "success", "message": "تم مسح طلب الصيانة بنجاح"}

@app.post("/trades")
@app.post("/api/trades")
def create_trade(trade: TradeCreate, db: Session = Depends(get_db), current_user: UserDB = Depends(get_current_customer)):
    if trade.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Customer identity does not match the authenticated account")

    new_trade = TradeDB(
        user_id=trade.user_id,
        item_details=trade.item_details,
        condition_details=trade.condition_details
    )
    db.add(new_trade)
    db.commit()
    db.refresh(new_trade)
    return {
        "status": "success",
        "message": "تم تقديم طلب التقييم بنجاح",
        "trade_id": new_trade.id
    }

@app.put("/trades/{trade_id}/status")
def update_trade_status(trade_id: int, data: StatusUpdate, db: Session = Depends(get_db), _admin: AdminDB = Depends(require_admin)):
    trade = db.query(TradeDB).filter(TradeDB.id == trade_id).first()
    if not trade:
        raise HTTPException(status_code=404, detail="طلب التقييم غير موجود")
    trade.status = data.status
    db.commit()
    return {"status": "success", "message": "تم تحديث حالة طلب التقييم"}

@app.delete("/trades/{trade_id}")
def delete_trade(trade_id: int, db: Session = Depends(get_db), _admin: AdminDB = Depends(require_admin)):
    trade = db.query(TradeDB).filter(TradeDB.id == trade_id).first()
    if not trade:
        raise HTTPException(status_code=404, detail="طلب التقييم غير موجود")
    db.delete(trade)
    db.commit()
    return {"status": "success", "message": "تم مسح طلب التقييم بنجاح"}

# ---------------------------------------------------------
# 10. مسارات الشات والدعم الفني والتقييمات
# ---------------------------------------------------------

# ---------------------------------------------------------
# 10. مسارات الشات والدعم الفني والتقييمات (المُعدّلة لتتوافق تماماً مع admin.js)
# ---------------------------------------------------------
# ---------------------------------------------------------
# 10. مسارات الشات والدعم الفني والتقييمات (مُعدّلة ومضمونة)
# ---------------------------------------------------------

class AdminSendChat(BaseModel):
    user_id: Optional[Union[int, str]] = None
    session_id: Optional[str] = None
    message: str = Field(min_length=1, max_length=2000)

class AdminChatRead(BaseModel):
    user_id: Optional[Union[int, str]] = None
    session_id: Optional[str] = None

@app.post("/chat/send")
def send_chat_message(data: ChatMessageCreate, db: Session = Depends(get_db), current_user: UserDB = Depends(get_current_customer)):
    if data.user_id is not None and data.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Customer identity does not match the authenticated account")
    session_id = data.session_id.strip()
    if not session_id or len(session_id) > 220:
        raise HTTPException(status_code=422, detail="A valid chat session is required")
    session_owner = db.query(ChatMessageDB.user_id).filter(
        ChatMessageDB.session_id == session_id,
        ChatMessageDB.user_id.isnot(None),
        ChatMessageDB.user_id != current_user.id,
    ).first()
    if session_owner:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This chat session belongs to another customer")

    message_text = data.message.strip()
    if not message_text:
        raise HTTPException(status_code=422, detail="Message cannot be empty")
    db.add(ChatMessageDB(session_id=session_id, user_id=current_user.id, sender="user", message=message_text))
    db.commit()

    text_value = message_text.casefold()
    bot_reply = None
    if any(keyword in text_value for keyword in ("عنوان", "موقع", "مكان", "فين", "address", "location")):
        bot_reply = "📍 عنوان الفرع: الإسكندرية - سموحة. مواعيد العمل: يوميًا من 1 ظهرًا حتى 11 مساءً."
    elif any(keyword in text_value for keyword in ("دفع", "طرق الدفع", "فيزا", "كاش", "payment")):
        bot_reply = "💳 طرق الدفع المتاحة: كاش عند الاستلام داخل الإسكندرية، أو Vodafone Cash و InstaPay."
    else:
        last_admin_msg = db.query(ChatMessageDB).filter(
            ChatMessageDB.user_id == current_user.id,
            ChatMessageDB.sender == "admin",
        ).order_by(ChatMessageDB.id.desc()).first()
        last_bot_notif = db.query(ChatMessageDB).filter(
            ChatMessageDB.user_id == current_user.id,
            ChatMessageDB.sender == "bot",
            ChatMessageDB.message.like("%تم تحويل استفسارك%"),
        ).order_by(ChatMessageDB.id.desc()).first()
        if (not last_bot_notif) or (last_admin_msg and last_admin_msg.id > last_bot_notif.id) or (
            last_bot_notif.created_at and datetime.utcnow() - last_bot_notif.created_at >= timedelta(minutes=5)
        ):
            bot_reply = "تم تحويل استفسارك إلى الإدارة وفريق الدعم، وسيتم الرد عليك عبر حسابك قريبًا!"

    if bot_reply:
        db.add(ChatMessageDB(session_id=session_id, user_id=current_user.id, sender="bot", message=bot_reply))
        db.commit()
    return {"status": "success", "message": "تم إرسال الرسالة بنجاح"}

@app.get("/chat/messages/{session_id}")
def get_chat_messages(session_id: str, user_id: Optional[int] = None, db: Session = Depends(get_db), current_user: UserDB = Depends(get_current_customer)):
    if user_id is not None and user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You can only read your own chat history")
    session_owner = db.query(ChatMessageDB.user_id).filter(
        ChatMessageDB.session_id == session_id,
        ChatMessageDB.user_id.isnot(None),
    ).distinct().all()
    if any(owner_id != current_user.id for (owner_id,) in session_owner):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This chat session belongs to another customer")
    query = db.query(ChatMessageDB).filter(ChatMessageDB.user_id == current_user.id)
    messages = query.order_by(ChatMessageDB.id.asc()).all()
    return [{
        "id": message.id,
        "sender": message.sender,
        "message": message.message,
        "created_at": message.created_at.strftime("%I:%M %p") if message.created_at else "",
    } for message in messages]

@app.get("/admin/chats")
def get_admin_chats(db: Session = Depends(get_db), _admin: AdminDB = Depends(require_admin)):
    result = []

    # 1. جلب محادثات المستخدمين المسجلين
    users_with_chats = db.query(ChatMessageDB.user_id).filter(ChatMessageDB.user_id.isnot(None)).distinct().all()
    user_ids = [u[0] for u in users_with_chats]

    for uid in user_ids:
        u = db.query(UserDB).filter(UserDB.id == uid).first()
        if not u:
            continue

        msgs = db.query(ChatMessageDB).filter(ChatMessageDB.user_id == uid).order_by(ChatMessageDB.created_at.asc()).all()
        if not msgs:
            continue

        main_session = msgs[-1].session_id
        read_state = db.query(ChatReadStateDB).filter_by(conversation_key=f"user:{uid}").first()
        last_read_id = read_state.last_read_message_id if read_state else 0
        unread_count = db.query(func.count(ChatMessageDB.id)).filter(
            ChatMessageDB.user_id == uid,
            ChatMessageDB.sender == "user",
            ChatMessageDB.id > last_read_id,
        ).scalar() or 0

        formatted_msgs = [{
            "id": m.id,
            "sender": m.sender,
            "text": m.message,
            "created_at": m.created_at.strftime("%I:%M %p") if m.created_at else ""
        } for m in msgs]

        result.append({
            "user_id": u.id,
            "session_id": main_session,
            "user_name": u.name,
            "user_email": u.email,
            "user_phone": u.phone or "",
            "unread_count": unread_count,
            "last_updated": formatted_msgs[-1]["created_at"],
            "messages": formatted_msgs
        })

    # 2. جلب محادثات الزوار (Guest Sessions)
    anon_sessions = db.query(ChatMessageDB.session_id).filter(ChatMessageDB.user_id.is_(None)).distinct().all()
    for s in anon_sessions:
        s_id = s[0]
        if not s_id:
            continue

        msgs = db.query(ChatMessageDB).filter(ChatMessageDB.session_id == s_id, ChatMessageDB.user_id.is_(None)).order_by(ChatMessageDB.created_at.asc()).all()
        if not msgs:
            continue

        read_state = db.query(ChatReadStateDB).filter_by(conversation_key=f"session:{s_id}").first()
        last_read_id = read_state.last_read_message_id if read_state else 0
        unread_count = db.query(func.count(ChatMessageDB.id)).filter(
            ChatMessageDB.session_id == s_id,
            ChatMessageDB.user_id.is_(None),
            ChatMessageDB.sender == "user",
            ChatMessageDB.id > last_read_id,
        ).scalar() or 0

        formatted_msgs = [{
            "id": m.id,
            "sender": m.sender,
            "text": m.message,
            "created_at": m.created_at.strftime("%I:%M %p") if m.created_at else ""
        } for m in msgs]

        result.append({
            "user_id": f"session_{s_id}",
            "session_id": s_id,
            "user_name": f"زائر ({s_id[:8]})",
            "user_email": "زائر غير مسجل",
            "user_phone": "",
            "unread_count": unread_count,
            "last_updated": formatted_msgs[-1]["created_at"],
            "messages": formatted_msgs
        })

    return result

@app.post("/admin/chats/send")
def send_admin_reply(data: AdminSendChat, db: Session = Depends(get_db), _admin: AdminDB = Depends(require_admin)):
    target_session_id = data.session_id
    target_user_id = None

    if isinstance(data.user_id, int):
        target_user_id = data.user_id
        if not target_session_id:
            last_msg = db.query(ChatMessageDB).filter(ChatMessageDB.user_id == target_user_id).order_by(ChatMessageDB.created_at.desc()).first()
            if last_msg:
                target_session_id = last_msg.session_id
    elif isinstance(data.user_id, str):
        if data.user_id.startswith("session_"):
            target_session_id = data.user_id.replace("session_", "")
        else:
            try:
                target_user_id = int(data.user_id)
                if not target_session_id:
                    last_msg = db.query(ChatMessageDB).filter(ChatMessageDB.user_id == target_user_id).order_by(ChatMessageDB.created_at.desc()).first()
                    if last_msg:
                        target_session_id = last_msg.session_id
            except ValueError:
                if not target_session_id:
                    target_session_id = data.user_id

    if not target_session_id:
        target_session_id = "general_session"

    session_owners = db.query(ChatMessageDB.user_id).filter(
        ChatMessageDB.session_id == target_session_id,
        ChatMessageDB.user_id.isnot(None),
    ).distinct().all()
    if target_user_id is not None:
        if not db.query(UserDB.id).filter(UserDB.id == target_user_id).first():
            raise HTTPException(status_code=404, detail="Customer chat not found")
        if any(owner_id != target_user_id for (owner_id,) in session_owners):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Chat session belongs to another customer")
    elif session_owners:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Chat session belongs to a customer")

    new_msg = ChatMessageDB(
        session_id=target_session_id,
        user_id=target_user_id,
        sender="admin",
        message=data.message
    )
    db.add(new_msg)
    db.commit()
    return {"status": "success", "message": "تم إرسال رد الأدمن بنجاح"}

@app.post("/admin/chats/read")
def mark_admin_chat_read(data: AdminChatRead, db: Session = Depends(get_db), _admin: AdminDB = Depends(require_admin)):
    raw_user_id = data.user_id
    session_id = (data.session_id or "").strip()
    if isinstance(raw_user_id, str) and raw_user_id.startswith("session_"):
        session_id = session_id or raw_user_id[len("session_"):]
        raw_user_id = None
    elif isinstance(raw_user_id, str) and raw_user_id.isdigit():
        raw_user_id = int(raw_user_id)

    if isinstance(raw_user_id, int) and raw_user_id > 0:
        if not db.query(UserDB.id).filter(UserDB.id == raw_user_id).first():
            raise HTTPException(status_code=404, detail="Customer chat not found")
        key = f"user:{raw_user_id}"
        latest_id = db.query(func.max(ChatMessageDB.id)).filter(ChatMessageDB.user_id == raw_user_id).scalar() or 0
        stored_user_id = raw_user_id
        stored_session_id = session_id or None
    else:
        if not session_id:
            raise HTTPException(status_code=422, detail="A customer or guest session is required")
        key = f"session:{session_id}"
        latest_id = db.query(func.max(ChatMessageDB.id)).filter(
            ChatMessageDB.session_id == session_id,
            ChatMessageDB.user_id.is_(None),
        ).scalar() or 0
        stored_user_id = None
        stored_session_id = session_id

    read_state = db.query(ChatReadStateDB).filter_by(conversation_key=key).first()
    if not read_state:
        read_state = ChatReadStateDB(conversation_key=key, user_id=stored_user_id, session_id=stored_session_id, last_read_message_id=latest_id)
        db.add(read_state)
    else:
        read_state.last_read_message_id = max(read_state.last_read_message_id, latest_id)
        read_state.session_id = stored_session_id or read_state.session_id
        read_state.updated_at = datetime.utcnow()
    db.commit()
    return {"status": "success"}

@app.post("/ratings")
def create_rating(data: RatingCreate, db: Session = Depends(get_db), current_user: UserDB = Depends(get_current_customer)):
    if data.user_id is not None and data.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Customer identity does not match the authenticated account")
    product = None
    if data.product_id is not None:
        product = db.query(ProductDB).filter(ProductDB.id == data.product_id, ProductDB.is_active.is_(True)).first()
        if not product:
            raise HTTPException(status_code=404, detail="Product not found")

    comment = (data.comment or "").strip() or None
    rating = None
    if product:
        rating = db.query(RatingDB).filter(
            RatingDB.user_id == current_user.id,
            RatingDB.product_id == product.id,
        ).first()
    if rating:
        rating.stars = data.stars
        rating.comment = comment
        rating.created_at = datetime.utcnow()
        result_status = "updated"
    else:
        rating = RatingDB(user_id=current_user.id, product_id=product.id if product else None, stars=data.stars, comment=comment)
        db.add(rating)
        result_status = "success"
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        if not product:
            raise
        rating = db.query(RatingDB).filter(RatingDB.user_id == current_user.id, RatingDB.product_id == product.id).first()
        if not rating:
            raise
        rating.stars = data.stars
        rating.comment = comment
        rating.created_at = datetime.utcnow()
        db.commit()
        result_status = "updated"
    return {"status": result_status, "message": "شكرًا لك، تم حفظ تقييمك"}

@app.get("/products/{product_id}/ratings")
def get_product_ratings(product_id: int, db: Session = Depends(get_db)):
    product = db.query(ProductDB).filter(ProductDB.id == product_id, ProductDB.is_active.is_(True)).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    reviews = db.query(RatingDB, UserDB.name).outerjoin(UserDB, RatingDB.user_id == UserDB.id).filter(
        RatingDB.product_id == product_id
    ).order_by(RatingDB.created_at.desc(), RatingDB.id.desc()).all()
    ratings = [{
        "id": rating.id,
        "customer_name": name or "Customer",
        "stars": rating.stars,
        "comment": rating.comment,
        "created_at": rating.created_at.strftime("%Y-%m-%d %H:%M") if rating.created_at else "",
    } for rating, name in reviews]
    average = sum(item["stars"] for item in ratings) / len(ratings) if ratings else 0
    return {"product_id": product_id, "average": round(average, 2), "count": len(ratings), "ratings": ratings}

@app.get("/admin/ratings")
def get_admin_ratings(db: Session = Depends(get_db), _admin: AdminDB = Depends(require_admin)):
    ratings = db.query(RatingDB).order_by(RatingDB.created_at.desc(), RatingDB.id.desc()).all()
    result = []
    for rating in ratings:
        customer = db.query(UserDB).filter(UserDB.id == rating.user_id).first() if rating.user_id else None
        product = db.query(ProductDB).filter(ProductDB.id == rating.product_id).first() if rating.product_id else None
        result.append({
            "id": rating.id,
            "customer_name": customer.name if customer else "عميل غير معروف",
            "product_id": rating.product_id,
            "rating_type": "product" if product else "unlinked",
            "product_name": product.name if product else "تقييم قديم غير مرتبط بمنتج",
            "stars": rating.stars,
            "comment": rating.comment,
            "created_at": rating.created_at.strftime("%Y-%m-%d %H:%M") if rating.created_at else "",
        })
    return result

@app.delete("/admin/ratings/{rating_id}")
def delete_admin_rating(rating_id: int, db: Session = Depends(get_db), current_admin: AdminDB = Depends(require_admin)):
    if rating_id <= 0:
        raise HTTPException(status_code=404, detail="Rating not found")
    rating = db.query(RatingDB).filter(RatingDB.id == rating_id).first()
    if not rating:
        raise HTTPException(status_code=404, detail="Rating not found")
    product_id = rating.product_id
    db.delete(rating)
    db.commit()
    logging.getLogger("mdstore.audit").warning(
        "ADMIN_ACTION delete_rating admin_id=%s rating_id=%s product_id=%s",
        current_admin.id, rating_id, product_id,
    )
    return {"status": "success", "id": rating_id, "product_id": product_id}

def create_first_admin(username: str, password: str) -> None:
    username = username.strip().lower()
    if not username or len(username) > 180 or len(password) < 12 or len(password) > 128:
        raise ValueError("Admin username is required; admin passwords must be 12 to 128 characters")
    db = SessionLocal()
    try:
        if db.query(AdminDB.id).first():
            raise ValueError("An administrator is already configured; bootstrap is only for the first account")
        db.add(AdminDB(username=username, password_hash=hash_password(password), is_active=True))
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

def reset_customer_password(identifier: str, password: str) -> None:
    if len(password) < 8 or len(password) > 128:
        raise ValueError("Customer passwords must be 8 to 128 characters")
    db = SessionLocal()
    try:
        user = db.query(UserDB).filter(func.lower(UserDB.email) == identifier.strip().lower()).first()
        if not user:
            raise ValueError("No customer account matches that email address")
        user.password_hash = hash_password(password)
        user.password = ""
        user.token_version += 1
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

def reset_admin_password(username: str, password: str) -> None:
    if len(password) < 12 or len(password) > 128:
        raise ValueError("Admin passwords must be 12 to 128 characters")
    db = SessionLocal()
    try:
        admin = db.query(AdminDB).filter(func.lower(AdminDB.username) == username.strip().lower()).first()
        if not admin:
            raise ValueError("No administrator account matches that username")
        admin.password_hash = hash_password(password)
        admin.token_version += 1
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

def run_security_cli() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "create-first-admin":
        username = input("Admin username: ").strip()
        password = getpass.getpass("New admin password (12+ characters): ")
        confirmation = getpass.getpass("Confirm admin password: ")
        if not secrets.compare_digest(password, confirmation):
            raise SystemExit("Passwords do not match")
        try:
            create_first_admin(username, password)
        except ValueError as error:
            raise SystemExit(str(error))
        print("The first administrator account was created.")
        return
    if len(sys.argv) == 3 and sys.argv[1] == "reset-customer-password":
        password = getpass.getpass("New customer password (8+ characters): ")
        confirmation = getpass.getpass("Confirm customer password: ")
        if not secrets.compare_digest(password, confirmation):
            raise SystemExit("Passwords do not match")
        try:
            reset_customer_password(sys.argv[2], password)
        except ValueError as error:
            raise SystemExit(str(error))
        print("The customer password was reset.")
        return
    if len(sys.argv) == 3 and sys.argv[1] == "reset-admin-password":
        password = getpass.getpass("New admin password (12+ characters): ")
        confirmation = getpass.getpass("Confirm admin password: ")
        if not secrets.compare_digest(password, confirmation):
            raise SystemExit("Passwords do not match")
        try:
            reset_admin_password(sys.argv[2], password)
        except ValueError as error:
            raise SystemExit(str(error))
        print("The administrator password was reset and existing admin sessions were revoked.")
        return
    raise SystemExit("Use: python main.py create-first-admin | python main.py reset-customer-password <email> | python main.py reset-admin-password <username>")

if __name__ == "__main__":
    run_security_cli()
