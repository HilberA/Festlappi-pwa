// ─── Firebase Konfiguration ───────────────────────────────────────────────
const FIREBASE_PROJECT_ID = 'festlapp-ce1d0';       // ← deine Project ID
const FIREBASE_API_KEY    = 'AIzaSyAzBxshvJ5Tv3MfoJ5nQ9sgVG-5ot2QuGc'; // ← dein API Key
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

// ─── App State ───────────────────────────────────────────────────────────
let state = {
  screen: 'login',       // login | table | order | cash
  waiter: null,
  tableNumber: null,
  cart: [],
  menuItems: [],
  waiters: [],
  submittedOrder: null,
  tenantId: null,
  licensePin: null
};

// ─── Firebase REST Helpers ────────────────────────────────────────────────
async function firestoreRequest(path, method = 'GET', body = null) {
  const url = `${BASE_URL}/${path}?key=${FIREBASE_API_KEY}`;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return res.json();
}

function toField(value) {
  if (typeof value === 'string')  return { stringValue: value };
  if (typeof value === 'number' && Number.isInteger(value)) return { integerValue: `${value}` };
  if (typeof value === 'number')  return { doubleValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Array.isArray(value))       return { arrayValue: { values: value.map(toField) } };
  if (typeof value === 'object' && value !== null)
    return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k,v]) => [k, toField(v)])) } };
  return { nullValue: null };
}

function fromField(field) {
  if (field.stringValue  !== undefined) return field.stringValue;
  if (field.doubleValue  !== undefined) return field.doubleValue;
  if (field.integerValue !== undefined) return parseInt(field.integerValue);
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.arrayValue)  return (field.arrayValue.values || []).map(fromField);
  if (field.mapValue)    return Object.fromEntries(
    Object.entries(field.mapValue.fields || {}).map(([k,v]) => [k, fromField(v)]));
  return null;
}

function docId(name) { return name.split('/').pop(); }

function tenantPath(collection) {
  return state.tenantId ? `tenants/${state.tenantId}/${collection}` : collection;
}

// ─── Firebase API ─────────────────────────────────────────────────────────
async function loadWaiters() {
  const result = await firestoreRequest(tenantPath('waiters'));
  if (!result.documents) return [];
  return result.documents.map(doc => {
    const f = doc.fields || {};
    return {
      id:       docId(doc.name),
      name:     fromField(f.name     || {}),
      qrCode:   fromField(f.qrCode   || {}),
      isActive: fromField(f.isActive || {})
    };
  }).filter(w => w.isActive);
}

async function loadMenu() {
  const result = await firestoreRequest(tenantPath('menu'));
  if (!result.documents) return [];
  return result.documents.map(doc => {
    const f = doc.fields || {};
    return {
      id:          docId(doc.name),
      name:        fromField(f.name        || {}),
      price:       fromField(f.price       || {}),
      category:    fromField(f.category    || {}),
      isAvailable: fromField(f.isAvailable || {})
    };
  }).filter(m => m.isAvailable);
}

async function findLicenseByPin(pin) {
  const result = await firestoreRequest('licenses');
  if (!result.documents) return null;
  const licenses = result.documents.map(doc => {
    const f = doc.fields || {};
    return {
      id:       docId(doc.name),
      pin:      fromField(f.pin      || {}),
      isActive: fromField(f.isActive || {}),
      name:     fromField(f.name     || {})
    };
  });
  return licenses.find(l => l.pin === pin && l.isActive) || null;
}

async function submitOrder(order) {
  const itemsArray = order.items.map(item => ({
    menuItemId:   item.menuItemId,
    menuItemName: item.menuItemName,
    price:        item.price,
    quantity:     item.quantity,
    note:         item.note || ''
  }));

  const fields = {
    tableNumber: order.tableNumber,
    waiterName:  order.waiterName,
    status:      'open',
    items:       itemsArray,
    total:       order.total
  };

  let encoded = Object.fromEntries(
    Object.entries(fields).map(([k,v]) => [k, toField(v)])
  );
  encoded.timestamp = { timestampValue: new Date().toISOString() };

  await firestoreRequest(
    `${tenantPath('orders')}/${order.id}`,
    'PATCH',
    { fields: encoded }
  );
}

// ─── Rendering ────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');
  switch (state.screen) {
    case 'login': app.innerHTML = renderLogin(); break;
    case 'table': app.innerHTML = renderTable(); break;
    case 'order': app.innerHTML = renderOrder(); break;
    case 'cash':  app.innerHTML = renderCash();  break;
  }
  attachEvents();
}

// ─── Login Screen ─────────────────────────────────────────────────────────
function renderLogin() {
  return `
    <div class="screen login-screen">
      <div class="login-hero">
        <div class="logo">🍺</div>
        <h1>FestlApp</h1>
        <p class="subtitle">Kellner-Bestellsystem</p>
      </div>

      <div class="card">
        <h2>Anmelden</h2>
        <p class="hint">Scanne deinen QR-Code oder gib den PIN ein</p>

        <div class="qr-section">
          <button class="btn btn-outline" id="btn-scan">
            <span class="icon">📷</span> QR-Code scannen
          </button>
        </div>

        <div class="divider"><span>oder</span></div>

        <div class="form-group">
          <label>Lizenz-PIN</label>
          <input type="number" id="license-pin" placeholder="PIN eingeben" inputmode="numeric">
        </div>

        <button class="btn btn-primary" id="btn-pin-login">Freischalten</button>
        <div id="login-error" class="error hidden"></div>
      </div>

      <video id="qr-video" class="hidden"></video>
      <canvas id="qr-canvas" class="hidden"></canvas>
    </div>
  `;
}

// ─── Table Screen ─────────────────────────────────────────────────────────
function renderTable() {
  return `
    <div class="screen table-screen">
      <div class="topbar">
        <div class="waiter-badge">
          <span class="waiter-icon">👤</span>
          <span>${state.waiter?.name || 'Kellner'}</span>
        </div>
        <button class="btn-icon" id="btn-logout">Abmelden</button>
      </div>

      <div class="center-content">
        <h2>Welcher Tisch?</h2>

        <div class="table-input-wrap">
          <input
            type="number"
            id="table-input"
            inputmode="numeric"
            placeholder="0"
            min="1"
            max="99"
            autofocus
          >
        </div>

        <button class="btn btn-primary btn-large" id="btn-table-next">
          Weiter →
        </button>
      </div>
    </div>
  `;
}

// ─── Order Screen ─────────────────────────────────────────────────────────
function renderOrder() {
  const categories = [...new Set(state.menuItems.map(i => i.category))].sort();
  const cartTotal = state.cart.reduce((s, i) => s + i.price * i.quantity, 0);

  const menuHtml = categories.map(cat => {
    const items = state.menuItems.filter(i => i.category === cat);
    return `
      <div class="category">
        <div class="category-header">${categoryIcon(cat)} ${cat}</div>
        ${items.map(item => {
          const qty = state.cart.find(c => c.menuItemId === item.id)?.quantity || 0;
          return `
            <div class="menu-item">
              <div class="menu-item-info">
                <span class="menu-item-name">${item.name}</span>
                <span class="menu-item-price">€ ${item.price.toFixed(2)}</span>
              </div>
              <div class="qty-control">
                <button class="qty-btn minus" data-id="${item.id}" ${qty === 0 ? 'disabled' : ''}>−</button>
                <span class="qty-num">${qty}</span>
                <button class="qty-btn plus" data-id="${item.id}" data-name="${item.name}" data-price="${item.price}">+</button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }).join('');

  const cartHtml = state.cart.length > 0 ? `
    <div class="cart">
      <div class="cart-header">
        <span>🛒 Bestellung</span>
        <span class="cart-total">€ ${cartTotal.toFixed(2)}</span>
      </div>
      ${state.cart.map(item => `
        <div class="cart-item">
          <span>${item.quantity}× ${item.menuItemName}</span>
          <span>€ ${(item.price * item.quantity).toFixed(2)}</span>
        </div>
      `).join('')}
      <button class="btn btn-primary btn-full" id="btn-order-pay">
        Bestellen & Bezahlen
      </button>
    </div>
  ` : '';

  return `
    <div class="screen order-screen">
      <div class="topbar">
        <button class="btn-icon" id="btn-back-table">← Tisch</button>
        <div class="topbar-title">Tisch ${state.tableNumber}</div>
        <span class="waiter-small">${state.waiter?.name || ''}</span>
      </div>

      <div class="order-content">
        ${menuHtml}
        ${cartHtml}
      </div>
    </div>
  `;
}

// ─── Cash Register Screen ─────────────────────────────────────────────────
function renderCash() {
  const order = state.submittedOrder;
  if (!order) return '';

  const quickAmounts = getQuickAmounts(order.total);

  return `
    <div class="screen cash-screen">
      <div class="topbar">
        <div class="topbar-title">Kasse – Tisch ${order.tableNumber}</div>
      </div>

      <div class="cash-content">
        <div class="cash-card total-card">
          <div class="cash-label">Zu zahlen</div>
          <div class="cash-amount">€ ${order.total.toFixed(2)}</div>
        </div>

        <div class="cash-card">
          <div class="cash-label">Gegeben (€)</div>
          <input
            type="number"
            id="given-input"
            inputmode="decimal"
            placeholder="0.00"
            class="given-input"
          >
        </div>

        <div class="quick-amounts">
          ${quickAmounts.map((amt, i) => `
            <button class="quick-btn ${i === 0 ? 'quick-btn-primary' : ''}"
                    data-amount="${amt}">
              € ${amt % 1 === 0 ? amt : amt.toFixed(2)}
            </button>
          `).join('')}
        </div>

        <div id="change-card" class="cash-card change-card hidden">
          <div class="cash-label">Retourgeld</div>
          <div id="change-amount" class="cash-amount change-amount">€ 0.00</div>
        </div>

        <button class="btn btn-success btn-large btn-full hidden" id="btn-done">
          ✓ Fertig
        </button>
      </div>
    </div>
  `;
}

function categoryIcon(cat) {
  if (cat === 'Speisen')  return '🍽';
  if (cat === 'Getränke') return '🥤';
  return '✦';
}

function getQuickAmounts(total) {
  const denominations = [1, 2, 5, 10, 20, 50, 100, 200];
  const nextFive = Math.ceil(total / 5) * 5;
  const amounts = [];
  if (nextFive > total) amounts.push(nextFive);
  for (const d of denominations) {
    if (d >= total && !amounts.includes(d)) amounts.push(d);
    if (amounts.length >= 5) break;
  }
  return amounts.sort((a,b) => a-b);
}

// ─── Event Handlers ───────────────────────────────────────────────────────
function attachEvents() {
  switch (state.screen) {
    case 'login': attachLoginEvents(); break;
    case 'table': attachTableEvents(); break;
    case 'order': attachOrderEvents(); break;
    case 'cash':  attachCashEvents();  break;
  }
}

function attachLoginEvents() {
  // QR Scanner
  document.getElementById('btn-scan')?.addEventListener('click', startQRScan);

  // PIN Login
  document.getElementById('btn-pin-login')?.addEventListener('click', async () => {
    const pin = document.getElementById('license-pin')?.value?.trim();
    if (!pin) return;
    await handlePinLogin(pin);
  });

  document.getElementById('license-pin')?.addEventListener('keydown', async e => {
    if (e.key === 'Enter') {
      const pin = e.target.value.trim();
      if (pin) await handlePinLogin(pin);
    }
  });
}

async function handlePinLogin(pin) {
  showError('');
  showLoading(true);
  try {
    const license = await findLicenseByPin(pin);
    if (!license) {
      showError('Ungültiger PIN');
      showLoading(false);
      return;
    }
    state.tenantId = license.id;
    state.licensePin = pin;

    // Kellner laden
    state.waiters = await loadWaiters();
    state.menuItems = await loadMenu();

    // Falls nur ein Kellner → direkt weiter
    // Sonst → Kellnerauswahl (hier: QR-Scan nötig, daher direkt zur Tischauswahl)
    // Für PWA: PIN-Login = als "Gast-Kellner" einloggen
    state.waiter = { name: 'Kellner', id: 'guest' };
    state.screen = 'table';
    render();
  } catch (err) {
    showError('Fehler beim Anmelden');
  }
  showLoading(false);
}

// QR-Scanner via Browser-Kamera
let scanning = false;
async function startQRScan() {
  const video = document.getElementById('qr-video');
  const canvas = document.getElementById('qr-canvas');
  if (!video || !canvas) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }
    });
    video.srcObject = stream;
    video.classList.remove('hidden');
    video.play();
    scanning = true;
    scanQRFrame(video, canvas, stream);
  } catch (err) {
    showError('Kamera nicht verfügbar');
  }
}

function scanQRFrame(video, canvas, stream) {
  if (!scanning) return;
  if (video.readyState !== video.HAVE_ENOUGH_DATA) {
    requestAnimationFrame(() => scanQRFrame(video, canvas, stream));
    return;
  }

  const ctx = canvas.getContext('2d');
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.drawImage(video, 0, 0);

  try {
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // BarcodeDetector API (Chrome/Android)
    if ('BarcodeDetector' in window) {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      detector.detect(canvas).then(codes => {
        if (codes.length > 0) {
          const code = codes[0].rawValue;
          scanning = false;
          stream.getTracks().forEach(t => t.stop());
          video.classList.add('hidden');
          handleQRCode(code);
        } else {
          requestAnimationFrame(() => scanQRFrame(video, canvas, stream));
        }
      });
    } else {
      // Fallback: jsQR (wird dynamisch geladen)
      if (window.jsQR) {
        const code = window.jsQR(imageData.data, canvas.width, canvas.height);
        if (code) {
          scanning = false;
          stream.getTracks().forEach(t => t.stop());
          video.classList.add('hidden');
          handleQRCode(code.data);
          return;
        }
      }
      requestAnimationFrame(() => scanQRFrame(video, canvas, stream));
    }
  } catch (e) {
    requestAnimationFrame(() => scanQRFrame(video, canvas, stream));
  }
}

async function handleQRCode(code) {
  showLoading(true);
  // Kellner-QR: direkt einloggen (kein Lizenz-PIN nötig wenn schon eingeloggt)
  if (state.tenantId) {
    const waiter = state.waiters.find(w => w.qrCode === code);
    if (waiter) {
      state.waiter = waiter;
      state.screen = 'table';
      render();
      showLoading(false);
      return;
    }
    showError('Unbekannter QR-Code');
    showLoading(false);
    return;
  }

  // Noch nicht eingeloggt → QR könnte Lizenz-PIN enthalten
  showError('Bitte zuerst PIN eingeben');
  showLoading(false);
}

function attachTableEvents() {
  document.getElementById('btn-logout')?.addEventListener('click', () => {
    state = { screen: 'login', waiter: null, tableNumber: null,
              cart: [], menuItems: [], waiters: [], submittedOrder: null,
              tenantId: null, licensePin: null };
    render();
  });

  const input = document.getElementById('table-input');
  input?.focus();

  // Tastatur ausblenden bei Klick außerhalb
  document.querySelector('.table-screen')?.addEventListener('click', e => {
    if (e.target !== input) input?.blur();
  });

  document.getElementById('btn-table-next')?.addEventListener('click', () => {
    const num = parseInt(input?.value);
    if (!num || num < 1 || num > 99) {
      input?.classList.add('shake');
      setTimeout(() => input?.classList.remove('shake'), 500);
      return;
    }
    state.tableNumber = num;
    state.cart = [];
    state.screen = 'order';
    render();
  });

  input?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      document.getElementById('btn-table-next')?.click();
    }
  });
}

function attachOrderEvents() {
  document.getElementById('btn-back-table')?.addEventListener('click', () => {
    state.screen = 'table';
    render();
  });

  // Plus/Minus Buttons
  document.querySelectorAll('.qty-btn.plus').forEach(btn => {
    btn.addEventListener('click', () => {
      const id    = btn.dataset.id;
      const name  = btn.dataset.name;
      const price = parseFloat(btn.dataset.price);
      const idx   = state.cart.findIndex(c => c.menuItemId === id);
      if (idx >= 0) {
        state.cart[idx].quantity++;
      } else {
        state.cart.push({ menuItemId: id, menuItemName: name,
                          price, quantity: 1, note: '' });
      }
      render();
    });
  });

  document.querySelectorAll('.qty-btn.minus').forEach(btn => {
    btn.addEventListener('click', () => {
      const id  = btn.dataset.id;
      const idx = state.cart.findIndex(c => c.menuItemId === id);
      if (idx < 0) return;
      if (state.cart[idx].quantity > 1) {
        state.cart[idx].quantity--;
      } else {
        state.cart.splice(idx, 1);
      }
      render();
    });
  });

  document.getElementById('btn-order-pay')?.addEventListener('click', async () => {
    if (state.cart.length === 0) return;
    showLoading(true);
    const total = state.cart.reduce((s, i) => s + i.price * i.quantity, 0);
    const order = {
      id:          crypto.randomUUID(),
      tableNumber: state.tableNumber,
      waiterName:  state.waiter?.name || 'Kellner',
      items:       state.cart,
      total,
      status:      'open'
    };
    await submitOrder(order);
    state.submittedOrder = order;
    state.cart = [];
    state.screen = 'cash';
    render();
    showLoading(false);
  });
}

function attachCashEvents() {
  const order = state.submittedOrder;
  const givenInput = document.getElementById('given-input');
  const changeCard = document.getElementById('change-card');
  const changeAmount = document.getElementById('change-amount');
  const doneBtn = document.getElementById('btn-done');

  function updateChange() {
    const given = parseFloat(givenInput?.value) || 0;
    const change = given - order.total;
    if (given >= order.total) {
      changeCard?.classList.remove('hidden');
      doneBtn?.classList.remove('hidden');
      if (changeAmount) {
        changeAmount.textContent = `€ ${Math.max(0, change).toFixed(2)}`;
        changeAmount.style.color = change > 0 ? '#16a34a' : '#1e40af';
      }
    } else {
      changeCard?.classList.add('hidden');
      doneBtn?.classList.add('hidden');
    }
  }

  givenInput?.addEventListener('input', updateChange);

  // Schnellbeträge
  document.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const amount = parseFloat(btn.dataset.amount);
      if (givenInput) {
        givenInput.value = amount % 1 === 0 ? amount : amount.toFixed(2);
        givenInput.blur();
      }
      updateChange();
    });
  });

  // Tastatur ausblenden
  document.querySelector('.cash-screen')?.addEventListener('click', e => {
    if (e.target !== givenInput) givenInput?.blur();
  });

  document.getElementById('btn-done')?.addEventListener('click', () => {
    state.submittedOrder = null;
    state.screen = 'table';
    state.tableNumber = null;
    render();
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────
function showError(msg) {
  const el = document.getElementById('login-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

function showLoading(show) {
  let overlay = document.getElementById('loading-overlay');
  if (show && !overlay) {
    overlay = document.createElement('div');
    overlay.id = 'loading-overlay';
    overlay.innerHTML = '<div class="spinner"></div>';
    document.body.appendChild(overlay);
  } else if (!show && overlay) {
    overlay.remove();
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/Festlappi-pwa/sw.js');
}


// jsQR dynamisch laden (Fallback für Browser ohne BarcodeDetector)
const jsQRScript = document.createElement('script');
jsQRScript.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
document.head.appendChild(jsQRScript);

render();
