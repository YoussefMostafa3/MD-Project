# Authentication rollout and account setup

## Configuration

Set `MDSTORE_AUTH_SECRET` to a randomly generated value containing at least 32 bytes before starting the API. Keep it in the deployment secret manager; do not commit it or put it in frontend files. For a local PowerShell session, generate and set it with:

```powershell
$env:MDSTORE_AUTH_SECRET = python -c "import secrets; print(secrets.token_urlsafe(48))"
```

The server refuses to start when the secret is missing or too short. Customer bearer tokens expire after seven days; administrator tokens expire after eight hours. Logout and customer password reset increment a database token version to invalidate outstanding tokens. Changing the signing secret also invalidates all outstanding tokens.

Install the backend dependencies with `python -m pip install -r requirements.txt` from this directory. The upload endpoint requires `python-multipart`.

## Database migration and preservation

On startup, the existing additive migration adds `users.password_hash` and `users.token_version`, creates `admin_accounts`, and adds its `token_version` column if needed. Existing customer rows and their orders, interests, repairs, trades, and messages remain in place. The migration hashes legacy passwords with PBKDF2-HMAC-SHA256 and empties the old `users.password` values in the same database transaction. It does not print password values.

Accounts whose old password is the legacy API default `123456` remain in the database but are not given a usable password hash. Set a new password for those accounts using the local maintenance command below. Other existing account passwords continue to work after migration.

**Before deployment:** make a verified backup of `mdstore.db`, test startup and the migration against a copy of the production database, confirm the customer login and order history on that copy, and retain the backup for rollback. The migration runs automatically when the new backend is imported; do not first import or launch it against production without completing those checks. This task did not open or alter the production database.

## Provision the first administrator

After configuring the signing secret and confirming the database path, run this command locally on the server host. It prompts for the username and password without echoing the password, enforces a 12-character minimum, and refuses to replace an existing administrator:

```powershell
python main.py create-first-admin
```

The first administrator is stored in `admin_accounts` with a salted PBKDF2-HMAC-SHA256 password hash. There is no default administrator account or password.

To reset a customer account that was migrated with the legacy default password, use the local maintenance command and enter a new password at the hidden prompt:

```powershell
python main.py reset-customer-password customer@example.com
```

To reset an administrator password locally, use the corresponding maintenance command. It also invalidates existing administrator sessions:

```powershell
python main.py reset-admin-password admin-username
```

Restrict shell access to trusted operators. These commands use the configured `MDSTORE_DATABASE_URL`, or the existing `mdstore.db` beside `main.py` when it is unset.

## Automated security tests

Run `python -m unittest discover -s tests -v` from this directory. The suite uses a synthetic SQLite database in the operating system temporary directory and never opens the store database.

## Order lifecycle, checkout, and delivery settings

Order schema changes are additive. Startup adds nullable delivery-area, idempotency, and payment-collection columns to existing orders; existing order totals and fulfillment `status` values are preserved. Historical orders receive a zero shipping-fee snapshot because their old totals did not include a recorded delivery fee, and remain `unpaid` unless a trusted operator records collection. Order items retain their product/variant/price snapshots. A new `chat_read_states` table stores the last read message ID per customer conversation or guest session.

New checkout requires a recipient name, phone, full address, configured delivery area, Cash on Delivery, and an `Idempotency-Key` header. Product and variant prices, delivery fees, line totals, and order totals are calculated on the backend. No online payment integration is present. The courier collects the product total and delivery fee together at delivery; an authenticated administrator records confirmed collection in the order dashboard before marking an order completed. Marked modified-console games are excluded from website checkout and must be arranged through WhatsApp or a branch visit. Cancelling an unpaid order restores inventory and records its shipping fee as a cancellation delivery charge due from the customer. Paid orders cannot be cancelled because no refund workflow exists.

Before enabling checkout in production, the store owner must provide the approved delivery areas, fee amounts in EGP, and Arabic/English area labels. Configure them on the server as JSON, for example (replace every placeholder with real approved values):

```powershell
$env:MDSTORE_SHIPPING_FEES_JSON = '{"<area-key>":{"fee":"<EGP amount>","label_ar":"<Arabic area name>","label_en":"<English area name>"}}'
```

The local `start server.bat` launcher creates a backend `.venv` and installs `requirements.txt` with `uv` when needed. The first launch therefore requires `uv` and package-index access if dependencies are not already installed. It supplies one development checkout fee (`Alexandria`: 50 EGP) only when `MDSTORE_SHIPPING_FEES_JSON` is not already set. This is a local checkout test setting, not a production shipping policy. Other governorates remain unconfigured. An existing environment value takes precedence; include Alexandria in that JSON if you use a custom value. Restart the backend by closing its current console and launching `start server.bat` again to load changed settings. This does not write a global Windows environment variable.

Until the active server environment contains a valid fee for the selected area, checkout returns a configuration error and the UI disables order submission. Do not substitute example fees or areas in production. Cash on Delivery is the only supported payment method for new orders; payment-method environment overrides are not used. Configure shipping values in the server's environment/secrets configuration for persistent deployment; PowerShell assignments apply only to that session.

## CORS and local startup

`MDSTORE_CORS_ORIGINS` is a comma-separated allowlist. Local defaults allow the explicitly listed `null` origin for the existing file-open workflow and local development origins on ports 3000, 5500, and 5501. For deployment, set this variable to the exact HTTPS frontend origins and omit `null` and localhost origins. The API uses bearer authorization headers, not cookies, so credentialed CORS is disabled.

For local use, serve the storefront over HTTP instead of opening `MD.html` directly as a `file://` page. Start the backend with `start server.bat`, then run the root `start storefront.bat` and open `http://127.0.0.1:5500/MD.html`. The local backend launcher sets its CORS allowlist to that exact loopback origin for this local-only run. Use a separate explicit HTTPS allowlist for deployment; do not use this local launcher as a deployment configuration.

The root `start server.bat` no longer contains a fixed signing secret; if one is not supplied, it generates a fresh random local-only secret for that launch. This invalidates local sessions after a restart. Production must set `MDSTORE_AUTH_SECRET` through a secret manager and must set explicit CORS origins, delivery fees, and the approved payment methods before rollout.

## Order migration rollout

This application runs `create_all` and additive migrations during import/startup. Do not point the updated backend at the production database until a verified backup exists and the migration has been exercised against a copy. This phase did not access or modify `mdstore.db` and did not deploy anything.
