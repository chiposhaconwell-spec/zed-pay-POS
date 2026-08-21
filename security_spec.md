# Security Specification & "Dirty Dozen" Payloads for POS ERP Firestore

## 1. Data Invariants
- **Multi-Tenant Ownership Boundary**: The parent collection path is `/businesses/{businessId}`. Inside each database, all sub-resources (`stores`, `products`, `customers`, `orders`) reside nested inside the business document. A user can only access/write nested business nested path elements if they own the parent business (`businesses/{businessId}.ownerUid == request.auth.uid`).
- **Identity Integrity**: For `Business` documents, `ownerUid` must match `request.auth.uid` on write.
- **Id Sizing & Regex Limits**: Any ID must match identifier patterns `^[a-zA-Z0-9_\-]+$` and be `<= 128` characters.
- **Strict Keys**: Prevent unauthorized ghost/shadow fields during creation and updates using size and key matching.
- **Temporal Strictness**: Timestamps (e.g. `createdAt`) are server-generated (`request.time`).
- **Immutability Protection**: Fields such as `id` and parent link variables `business_id` inside any document type cannot be mutated during update.

---

## 2. The "Dirty Dozen" Payloads

### Payload 1: Identity Spoofing (Create Business with someone else's UID)
- **Path**: `/businesses/biz_attack1`
- **Payload**:
```json
{
  "id": "biz_attack1",
  "name": "Hacked Shop",
  "owner": "Attacker",
  "email": "attacker@gmail.com",
  "ownerUid": "victim_uid"
}
```
- **Authentication**: `uid: "attacker_uid"`
- **Result**: `PERMISSION_DENIED` (auth uid must match ownerUid field).

### Payload 2: Schema Breach (Create Business omitting required property `owner`)
- **Path**: `/businesses/biz_attack2`
- **Payload**:
```json
{
  "id": "biz_attack2",
  "name": "Incomplete Biz",
  "email": "noowner@gmail.com",
  "ownerUid": "attacker_uid"
}
```
- **Authentication**: `uid: "attacker_uid"`
- **Result**: `PERMISSION_DENIED` (fails missing property validation constraints).

### Payload 3: Poisoned ID (malicious non-alphanumeric special character or buffer overflow)
- **Path**: `/businesses/biz_injection$<script>alert('hack')</script>`
- **Payload**:
```json
{
  "id": "biz_injection$<script>alert('hack')</script>",
  "name": "Injection Biz",
  "owner": "Attacker",
  "email": "inject@gmail.com",
  "ownerUid": "attacker_uid"
}
```
- **Authentication**: `uid: "attacker_uid"`
- **Result**: `PERMISSION_DENIED` (ID fails isValidId check).

### Payload 4: Subcollection Tenant Escape (Create store in victim business space)
- **Path**: `/businesses/victim_biz_999/stores/store_hijack`
- **Payload**:
```json
{
  "id": "store_hijack",
  "business_id": "victim_biz_999",
  "name": "Hijacked Branch",
  "location": "Lusaka"
}
```
- **Authentication**: `uid: "attacker_uid"` (The victim's business document has `ownerUid: "victim_uid"`).
- **Result**: `PERMISSION_DENIED` (Attacker does not own the parent business record).

### Payload 5: Value Type Poisoning (Create product with negative price/invalid string as price)
- **Path**: `/businesses/attacker_biz/products/prod_negative`
- **Payload**:
```json
{
  "id": 1234,
  "name": "Malicious Copper",
  "sku": "COP-MAL",
  "category": "Raw",
  "price": -99.99,
  "cost": 5.0,
  "stock": 100,
  "imageUrl": "",
  "business_id": "attacker_biz"
}
```
- **Authentication**: `uid: "attacker_uid"`
- **Result**: `PERMISSION_DENIED` (price MUST be >= 0.0).

### Payload 6: Field Mutability Hijack (Update store parent link)
- **Path**: `/businesses/attacker_biz/stores/my_store_1`
- **Existing**: `{ "id": "my_store_1", "business_id": "attacker_biz", "name": "Store" }`
- **Payload**:
```json
{
  "id": "my_store_1",
  "business_id": "hijacked_biz",
  "name": "Altered Store"
}
```
- **Authentication**: `uid: "attacker_uid"`
- **Result**: `PERMISSION_DENIED` (parent link cannot be mutated on update).

### Payload 7: Denial of Wallet (Store product image URL with massive 1MB payload of empty strings)
- **Path**: `/businesses/attacker_biz/products/prod_bloat`
- **Payload**:
```json
{
  "id": 999,
  "name": "Massive Bloat",
  "sku": "BLOAT",
  "category": "A",
  "price": 10,
  "cost": 1,
  "stock": 1,
  "imageUrl": "<10,000 character redundant string...>",
  "business_id": "attacker_biz"
}
```
- **Authentication**: `uid: "attacker_uid"`
- **Result**: `PERMISSION_DENIED` (fails string size validation).

### Payload 8: System Filed Pollution (Inject unapproved state `systemVerified`)
- **Path**: `/businesses/attacker_biz/orders/ord_spoof`
- **Payload**:
```json
{
  "id": "ord_spoof",
  "customerId": 101,
  "orderDate": "2026-06-10",
  "subtotal": 100,
  "tax": 16,
  "discount": 0,
  "total": 116,
  "paymentMethod": "CASH",
  "status": "COMPLETED",
  "store_id": "outlet",
  "performed_by": "cashier",
  "systemVerified": true
}
```
- **Authentication**: `uid: "attacker_uid"`
- **Result**: `PERMISSION_DENIED` (strict keys check rejects unapproved schema variables).

### Payload 9: Self-Assigned Privilege Escalation (Modifying role/admin fields)
- **Path**: `/businesses/attacker_biz/stores/my_store_1`
- **Payload**: Attempt to write arbitrary parameters inside metadata to grant extra workspace parameters.
- **Result**: `PERMISSION_DENIED` (Strict schemas limit available properties).

### Payload 10: Anonymous Write (Unauthenticated client write attempt)
- **Path**: `/businesses/biz_anonymous/stores/str_anonymous`
- **Payload**: `{ "id": "1", "business_id": "biz_anonymous" }`
- **Authentication**: `None`
- **Result**: `PERMISSION_DENIED` (isSignedIn() check failed).

### Payload 11: Transaction State Shortcutting (Update Order total direct rewrite)
- **Path**: `/businesses/attacker_biz/orders/ord_immutable1`
- **Existing**: `{ "id": "ord_immutable1", "total": 150.0, "status": "COMPLETED" }`
- **Payload**:
```json
{
  "id": "ord_immutable1",
  "total": 0.0,
  "status": "COMPLETED"
}
```
- **Result**: `PERMISSION_DENIED` (Order is completed and locked from updates, terminal state locking).

### Payload 12: Broad Database Read Harvesting (Harvest orders of another business)
- **Query**: `/businesses/victim_biz_999/orders`
- **Authentication**: `uid: "attacker_uid"`
- **Result**: `PERMISSION_DENIED` (fails relational check resource.data.ownerUid != attacker_uid).
