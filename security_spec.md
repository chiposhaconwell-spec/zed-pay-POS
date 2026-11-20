# Security Specification & "Dirty Dozen" Payloads for POS ERP Firestore & Storage

## 1. Data Invariants & Relational Architecture
- **Multi-Tenant Ownership Boundary (`/businesses/{businessId}`)**: The master source of truth is `/businesses/{businessId}`. All client CRM data (`customers`), store branches (`stores`), inventory & batches (`products`), sales & refund transactions (`orders`, `order_items`), and double-entry accounting ledgers (`ledgers`) reside as relational subcollections under `/businesses/{businessId}`.
- **Mandatory Tenant & Branch Tagging (`business_id`, `store_id`)**: Every document across `Business`, `Store`, `Product`, `Customer`, `Order`, `OrderItem`, and `LedgerBackup` must carry explicit non-empty `business_id` and `store_id` strings validated on both `create` and `update`.
- **Master Gate (`isBusinessOwner`)**: Every subcollection write (`create`, `update`, `delete`) verifies parent ownership via `get(/databases/$(database)/documents/businesses/$(businessId)).data.ownerUid == request.auth.uid`.
- **Cost-Optimized Secure List Queries**: Every subcollection document stores `ownerUid` and `business_id` so `allow list` enforces `existing().ownerUid == request.auth.uid && existing().business_id == businessId` without O(n) `get()` calls.
- **Identity Integrity**: `ownerUid` must strictly match `request.auth.uid` on creation and remain immutable on update.
- **ID Sizing & Regex Guard**: All document IDs (`businessId`, `storeId`, `productId`, `customerId`, `orderId`, `itemId`, `ledgerId`) must match `^[a-zA-Z0-9_\-]+$` and be `<= 128` characters.
- **Strict Keys & Anti-Update-Gap**: Standalone `isValid[Entity]` helpers validate both `create` and `update`, combined with `affectedKeys().hasOnly(...)` on every update action.
- **Temporal Strictness**: `createdAt` and `updatedAt` timestamps on `Business`, `LedgerBackup`, `SuperAdmin`, and `PlatformAuditLog` are validated against `request.time`.
- **Platform Super Admin Separation (`/super_admins/{adminUid}`)**: Super Admins sit completely above tenant `BusinessMembership` roles. Tenant owners can only update business profile/billing fields and are strictly blocked from modifying moderation fields (`status`, `suspended_reason`, `flagged_for_fraud`, `plan_tier`, `subscription_status`).
- **Suspended/Fraud Hard Delete Guard**: `/businesses/{businessId}` only permits `delete` by verified `isAdmin()` AND only when `existing().status == 'SUSPENDED' || existing().flagged_for_fraud == true`.
- **Immutable Platform Audit Trail (`/platform_audit_logs/{logId}`)**: Every moderation action (`SUSPEND_BUSINESS`, `RESTORE_BUSINESS`, `FLAG_FRAUD`, `CLEAR_FRAUD`, `UPDATE_PLAN`, `HARD_DELETE_BUSINESS`) is append-only (`allow update, delete: if false;`) and strictly readable/creatable only by `isAdmin()`.

---

## 2. The "Dirty Dozen" Payloads

1. **Identity Spoofing (Create Business with someone else's UID)**: Rejected (`incoming().ownerUid == request.auth.uid` fails).
2. **Schema Breach (Create Business or Sub-document omitting required `business_id` or `store_id`)**: Rejected (`hasAll` and `hasOnly` check fails).
3. **Poisoned Document ID (XSS/Buffer overflow in `businessId`)**: Rejected (`isValidId` regex & length check fails).
4. **Subcollection Tenant Escape (Write store/customer/order into another user's `businessId`)**: Rejected (`isBusinessOwner(businessId)` Master Gate fails).
5. **Value Type Poisoning (Negative product price or negative customer loyalty points)**: Rejected (`isValidProduct` / `isValidCustomer` range check fails).
6. **Relational Link Mutation (Change `business_id` or `ownerUid` during update)**: Rejected (`incoming().business_id == existing().business_id && incoming().ownerUid == existing().ownerUid` fails).
7. **Denial of Wallet (1MB string payload in `imageUrl` or unbounded array in `ledgers`)**: Rejected (`imageUrl.size() <= 300000` and `records.size() <= 500` checks fail).
8. **Shadow Field Injection (Inject `isAdmin: true` or `systemVerified: true` on Order)**: Rejected (`keys().hasOnly(...)` fails).
9. **Email Spoofing Attack (Unverified email claiming admin)**: Rejected (`request.auth.token.email_verified == true` required for admin email check, and `/super_admins` self-provisioning strictly checks deterministic `cred_id` + `auth_email`).
10. **Anonymous Write Attempt**: Rejected (`isSignedIn()` fails).
11. **Order History Tampering (Mutating immutable `orderDate` or `store_id` on Order update, or tenant owner attempting to clear `SUSPENDED` status)**: Rejected (`affectedKeys().hasOnly(...)` blocks non-admin mutation of `status`, `flagged_for_fraud`, and `plan_tier`).
12. **Cross-Tenant List Scraping (Querying `/customers` or `/orders` without `ownerUid == request.auth.uid` and `business_id == businessId`)**: Rejected (`allow list` enforces tenant membership or verified `isAdmin()`).
