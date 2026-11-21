import assert from 'node:assert/strict';

// Setup browser globals for Node test environment before importing app modules
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

const localStorageMock = new MemoryStorage();
const sessionStorageMock = new MemoryStorage();
const eventTarget = new EventTarget();

Object.assign(globalThis, {
  localStorage: localStorageMock,
  sessionStorage: sessionStorageMock,
  window: {
    localStorage: localStorageMock,
    sessionStorage: sessionStorageMock,
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    location: { origin: 'http://localhost:3000', hostname: 'localhost' },
  },
});

Object.defineProperty(globalThis, 'navigator', {
  value: { onLine: false },
  configurable: true,
  writable: true,
});

async function runTests() {
  const dbModule = await import('../db');
  const firebaseModule = await import('../firebase');
  const multiTenantModule = await import('../multiTenantAuth');

  const {
    initializeDatabase,
    runSql,
    getNextSequentialCompanyId,
    setPermanentCompanyIdForUser,
    getPermanentCompanyIdForUser,
    dedupeAndCleanBusinessesTable,
    upsertUserAndMembership,
    runWithHydrationGuard,
    isHydratingOrRestoringDatabase,
  } = dbModule;

  const {
    prepareIdempotentCompanyRegistration,
    backupToCloud,
  } = firebaseModule;

  const { computeCredentialHashSync, deriveUserId } = multiTenantModule;

  console.log('Running POS Company Creation Idempotency & Multi-Refresh Tests...');

  // ---------------------------------------------------------------------------
  // TEST 1: Sequential Company IDs start at "1" and follow "1", "2", "3", ...
  // ---------------------------------------------------------------------------
  localStorageMock.clear();
  initializeDatabase('blank', true);

  const firstId = getNextSequentialCompanyId();
  assert.equal(firstId, '1', 'First sequential company ID must start from "1"');

  // Register Company #1 intentionally
  const email1 = 'owner@alpha-shop.com';
  const pass1 = 'secretPass123';
  const credHash1 = computeCredentialHashSync(email1, pass1);

  const reg1 = await prepareIdempotentCompanyRegistration({
    email: email1,
    password: pass1,
    companyName: 'Alpha Supermarket',
    ownerName: 'Alice Owner',
  });

  assert.equal(reg1.alreadyExists, false, 'First intentional registration should succeed');
  assert.equal(reg1.companyId, '1', 'First registered company must receive sequential ID "1"');

  runSql(`
    INSERT INTO businesses (id, name, owner, email, password, currency, tax_rate, status, created_at, business_id, store_id)
    VALUES ('${reg1.companyId}', 'Alpha Supermarket', 'Alice Owner', '${email1}', '${pass1}', 'K', 16, 'ACTIVE', '${new Date().toISOString()}', '${reg1.companyId}', 'store_1')
  `);
  upsertUserAndMembership({
    businessId: reg1.companyId,
    email: email1,
    fullName: 'Alice Owner',
    password: pass1,
    credentialHash: credHash1,
    role: 'owner',
    storeId: 'store_1',
    status: 'ACTIVE',
  });

  // Add stock, orders (sales), and settings to Company #1
  runSql(`
    INSERT INTO products (id, name, price, cost_price, category, sku, stock, business_id, store_id)
    VALUES ('prod_101', '25kg Mealie Meal', 320, 260, 'Groceries', 'SKU-MM-25', 45, '1', 'store_1')
  `);
  runSql(`
    INSERT INTO orders (id, customerId, orderDate, subtotal, tax, discount, total, paymentMethod, status, business_id, store_id)
    VALUES ('ord_501', NULL, '${new Date().toISOString()}', 640, 0, 0, 640, 'Cash', 'COMPLETED', '1', 'store_1')
  `);

  localStorageMock.setItem(
    'active_business_profile',
    JSON.stringify({ id: '1', name: 'Alpha Supermarket', owner: 'Alice Owner', email: email1 })
  );
  localStorageMock.setItem('pos_authenticated_session', 'true');
  localStorageMock.setItem('logged_in_user_email', email1);

  // Verify next sequential ID is "2", then "3"
  const secondId = getNextSequentialCompanyId();
  assert.equal(secondId, '2', 'Second sequential company ID must be "2"');
  const thirdIdWithCloud = getNextSequentialCompanyId(['2', '3']);
  assert.equal(thirdIdWithCloud, '4', 'Sequential company ID generator must respect cloud IDs and return "4"');
  console.log('✓ Test 1 Passed: Sequential company IDs start from "1" and increment sequentially ("1", "2", "3", ...).');

  // ---------------------------------------------------------------------------
  // TEST 2: Authenticated user profile stores and resolves permanent Company ID
  // ---------------------------------------------------------------------------
  const resolvedPermId = getPermanentCompanyIdForUser({
    userId: deriveUserId(email1),
    credentialHash: credHash1,
    email: email1,
  });
  assert.equal(resolvedPermId, '1', 'User profile must resolve permanent Company ID "1"');
  console.log('✓ Test 2 Passed: Authenticated user profile permanently binds and resolves Company ID "1".');

  // ---------------------------------------------------------------------------
  // TEST 3: Simultaneous / duplicate registration calls are idempotent
  // ---------------------------------------------------------------------------
  const [dupAttemptA, dupAttemptB] = await Promise.all([
    prepareIdempotentCompanyRegistration({
      email: email1,
      password: pass1,
      companyName: 'Alpha Supermarket',
      ownerName: 'Alice Owner',
    }),
    prepareIdempotentCompanyRegistration({
      email: email1,
      password: pass1,
      companyName: 'Alpha Supermarket',
      ownerName: 'Alice Owner',
    }),
  ]);

  assert.equal(dupAttemptA.alreadyExists, true, 'Duplicate registration A must be blocked');
  assert.equal(dupAttemptA.companyId, '1', 'Duplicate registration A must return existing permanent Company ID "1"');
  assert.equal(dupAttemptB.alreadyExists, true, 'Duplicate registration B must be blocked');
  assert.equal(dupAttemptB.companyId, '1', 'Duplicate registration B must return existing permanent Company ID "1"');

  const businessesAfterDup = dedupeAndCleanBusinessesTable();
  assert.equal(businessesAfterDup.length, 1, 'Database must still have exactly 1 company after simultaneous duplicate attempts');
  console.log('✓ Test 3 Passed: Simultaneous/duplicate registration attempts are idempotent and create 0 duplicates.');

  // ---------------------------------------------------------------------------
  // TEST 4: Refreshing the POS multiple times creates ZERO additional company documents
  // and preserves existing stock, sales, and settings
  // ---------------------------------------------------------------------------
  for (let refreshCycle = 1; refreshCycle <= 10; refreshCycle++) {
    // Simulate browser refresh: startup initializeDatabase('blank') + session restoration + hydration events
    initializeDatabase('blank', false);

    const savedBizRaw = localStorageMock.getItem('active_business_profile');
    assert.ok(savedBizRaw, `Refresh #${refreshCycle}: active_business_profile must remain intact`);
    const savedBiz = JSON.parse(savedBizRaw!);
    const permId = getPermanentCompanyIdForUser({ email: savedBiz.email });
    assert.equal(permId, '1', `Refresh #${refreshCycle}: Permanent company ID must remain "1"`);

    // Simulate hydration guard during SQLite / Firestore restore
    await runWithHydrationGuard(() => {
      assert.equal(isHydratingOrRestoringDatabase(), true, 'Hydration guard must be active during restore');
      window.dispatchEvent(new Event('local_db_restored'));
    });
    assert.equal(isHydratingOrRestoringDatabase(), false, 'Hydration guard must release after restore');

    // Simulate data update event and verify no new businesses are created
    window.dispatchEvent(new Event('pos_data_updated'));

    // Verify backupToCloud without allowCreateCompanyDoc never creates a new company doc
    const unallowedCreateAttempt = await backupToCloud('999', {
      silentIfNotOwner: true,
      allowCreateCompanyDoc: false,
    });
    assert.equal(
      unallowedCreateAttempt.success,
      false,
      `Refresh #${refreshCycle}: backupToCloud must refuse to create an unhydrated/unknown company`
    );

    const allCompanies = dedupeAndCleanBusinessesTable();
    assert.equal(
      allCompanies.length,
      1,
      `Refresh #${refreshCycle}: Refreshing POS must NOT create additional company documents (found ${allCompanies.length})`
    );
    assert.equal(allCompanies[0].id, '1', `Refresh #${refreshCycle}: Company ID must remain "1"`);
    assert.equal(allCompanies[0].name, 'Alpha Supermarket', `Refresh #${refreshCycle}: Company name must remain intact`);

    // Verify stock & sales (orders) are untouched
    const prodRes = runSql(`SELECT * FROM products WHERE business_id = '1'`);
    assert.equal(prodRes.data?.length, 1, `Refresh #${refreshCycle}: Existing stock must be preserved`);
    assert.equal(Number(prodRes.data?.[0]?.stock), 45, `Refresh #${refreshCycle}: Stock quantity must remain 45`);

    const ordersRes = runSql(`SELECT * FROM orders WHERE business_id = '1'`);
    assert.equal(ordersRes.data?.length, 1, `Refresh #${refreshCycle}: Existing sales orders must be preserved`);
    assert.equal(Number(ordersRes.data?.[0]?.total), 640, `Refresh #${refreshCycle}: Sales total must remain 640`);
  }

  console.log('✓ Test 4 Passed: Refreshing POS 10 consecutive times created 0 extra companies and preserved all stock & sales.');

  // ---------------------------------------------------------------------------
  // TEST 5: Registering a second distinct company assigns sequential ID "2"
  // ---------------------------------------------------------------------------
  const email2 = 'owner@beta-hardware.com';
  const pass2 = 'betaPass456';
  const reg2 = await prepareIdempotentCompanyRegistration({
    email: email2,
    password: pass2,
    companyName: 'Beta Hardware Ltd',
    ownerName: 'Bob Builder',
  });
  assert.equal(reg2.alreadyExists, false, 'Second distinct company registration should succeed');
  assert.equal(reg2.companyId, '2', 'Second distinct company must receive sequential ID "2"');
  console.log('✓ Test 5 Passed: Second intentional company registration receives sequential ID "2".');

  console.log('\nALL COMPANY IDEMPOTENCY & REFRESH TESTS PASSED SUCCESSFULLY!');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
