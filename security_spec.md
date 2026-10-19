# Security Specification & "Dirty Dozen" Payloads for POS ERP Firestore & Storage

## 1. Data Invariants & Relational Architecture
- **Multi-Tenant Ownership Boundary (`/businesses/{businessId}`)**: The master source of truth is `/businesses/{businessId}`. All client CRM data (`customers`), store branches (`stores`), inventory & batches (`products`), sales & refund transactions (`orders`, `order_items`), and double-entry accounting ledgers (`ledgers`) reside as relational subcollections under `/businesses/{businessId}`.
- **Master Gate (`isBusinessOwner`)**: Every subcollection write (`create`, `update`, `delete`) verifies parent ownership via `get(/databases/$(database)/documents/businesses/$(businessId)).data.ownerUid == request.auth.uid`.
- **Cost-Optimized Secure List Queries**: Every subcollection document stores `ownerUid` and `business_id` so `allow list` enforces `existing().ownerUid == request.auth.uid` without O(n) `get()` calls.
- **Identity Integrity**: `ownerUid` must strictly match `request.auth.uid` on creation and remain immutable on update.
- **ID Sizing & Regex Guard**: All document IDs (`businessId`, `storeId`, `productId`, `customerId`, `orderId`, `itemId`, `ledgerId`) must match `^[a-zA-Z0-9_\-]+$` and be `<= 128` characters.
- **Strict Keys & Anti-Update-Gap**: Standalone `isValid[Entity]` helpers validate both `create` and `update`, combined with `affectedKeys().hasOnly(...)` on every update action.
- **Temporal Strictness**: `createdAt` and `updatedAt` timestamps on `Business` and `LedgerBackup` are validated against `request.time`.

---

## 2. The "Dirty Dozen" Payloads

1. **Identity Spoofing (Create Business with someone else's UID)**: Rejected (`incoming().ownerUid == request.auth.uid` fails).
2. **Schema Breach (Create Business omitting required `owner`)**: Rejected (`hasAll` and `hasOnly` check fails).
3. **Poisoned Document ID (XSS/Buffer overflow in `businessId`)**: Rejected (`isValidId` regex & length check fails).
4. **Subcollection Tenant Escape (Write store/customer/order into another user's `businessId`)**: Rejected (`isBusinessOwner(businessId)` Master Gate fails).
5. **Value Type Poisoning (Negative product price or negative customer loyalty points)**: Rejected (`isValidProduct` / `isValidCustomer` range check fails).
6. **Relational Link Mutation (Change `business_id` or `ownerUid` during update)**: Rejected (`incoming().business_id == existing().business_id && incoming().ownerUid == existing().ownerUid` fails).
7. **Denial of Wallet (1MB string payload in `imageUrl` or unbounded array in `ledgers`)**: Rejected (`imageUrl.size() <= 300000` and `records.size() <= 500` checks fail).
8. **Shadow Field Injection (Inject `isAdmin: true` or `systemVerified: true` on Order)**: Rejected (`keys().hasOnly(...)` fails).
9. **Email Spoofing Attack (Unverified email claiming admin)**: Rejected (`request.auth.token.email_verified == true` required for admin email check).
10. **Anonymous Write Attempt**: Rejected (`isSignedIn()` fails).
11. **Order History Tampering (Mutating immutable `orderDate` or `store_id` on Order update)**: Rejected (`incoming().orderDate == existing().orderDate` fails).
12. **Cross-Tenant List Scraping (Querying `/customers` or `/orders` without `ownerUid == request.auth.uid`)**: Rejected (`allow list` enforces `existing().ownerUid == request.auth.uid`).
