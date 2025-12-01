// Amazon Order Exporter - Content Script

(function() {
  'use strict';

  // Prevent multiple injections
  if (window.amazonOrderExporterLoaded) return;
  window.amazonOrderExporterLoaded = true;

  // Global flag for cancellation
  let exportCancelled = false;

  // ============================================
  // PAGINATION DETECTION
  // ============================================

  function detectTotalOrders() {
    // Primary: ".num-orders" shows "X orders placed in YYYY"
    const numOrdersEl = document.querySelector('.num-orders');
    if (numOrdersEl) {
      const match = numOrdersEl.textContent.match(/(\d+)\s*orders?/i);
      if (match) return parseInt(match[1], 10);
    }

    // Fallback: look in page header text
    const headerText = document.querySelector('.a-spacing-top-medium, .your-orders-content-container');
    if (headerText) {
      const match = headerText.textContent.match(/(\d+)\s*orders?/i);
      if (match) return parseInt(match[1], 10);
    }

    return null;
  }

  function buildPageUrl(startIndex) {
    // Clone the current URL and just change startIndex
    // This preserves all other parameters (timeFilter, ref, etc.)
    const url = new URL(window.location.href);
    url.searchParams.set('startIndex', startIndex.toString());
    console.log(`AOE: Built URL for startIndex=${startIndex}: ${url.toString()}`);
    return url.toString();
  }

  // ============================================
  // RATE-LIMITED REQUEST QUEUE
  // ============================================

  class RequestQueue {
    constructor(concurrency = 2, delayMs = 800) {
      this.concurrency = concurrency;
      this.delayMs = delayMs;
      this.running = 0;
      this.queue = [];
    }

    async add(fn) {
      return new Promise((resolve, reject) => {
        this.queue.push({ fn, resolve, reject });
        this.processNext();
      });
    }

    async processNext() {
      if (this.running >= this.concurrency || this.queue.length === 0) return;

      this.running++;
      const { fn, resolve, reject } = this.queue.shift();

      try {
        await new Promise(r => setTimeout(r, this.delayMs));
        const result = await fn();
        resolve(result);
      } catch (err) {
        reject(err);
      } finally {
        this.running--;
        this.processNext();
      }
    }
  }

  // ============================================
  // FETCH AND PARSE FUNCTIONS
  // ============================================

  async function fetchPageWithRetry(url, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, { credentials: 'include' });

        if (response.status === 429 || response.status === 503) {
          // Rate limited - exponential backoff
          const delay = Math.pow(2, attempt) * 1000;
          console.log(`AOE: Rate limited, waiting ${delay}ms before retry`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        if (response.status === 401 || response.status === 403) {
          throw new Error('Authentication required. Please refresh the page and try again.');
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        return await response.text();
      } catch (err) {
        if (attempt === maxRetries) throw err;
        console.warn(`AOE: Fetch attempt ${attempt} failed, retrying...`, err);
      }
    }
  }

  function parseOrdersFromHTML(html, pageNum) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Debug: Check if we got a login page or error page
    const title = doc.querySelector('title')?.textContent || '';
    console.log(`AOE: Page ${pageNum} title: "${title}"`);

    if (title.includes('Sign-In') || title.includes('Sign in')) {
      console.warn('AOE: Got login page instead of orders');
      return [];
    }

    const orders = [];
    const seenOrderIds = new Set();

    const orderCards = doc.querySelectorAll('.order-card, [data-testid="order-card"], .a-box-group.order, .order');
    console.log(`AOE: Page ${pageNum} found ${orderCards.length} order cards`);

    orderCards.forEach(card => {
      const orderData = extractOrderInfo(card);
      if (orderData.orderId && !seenOrderIds.has(orderData.orderId) && orderData.items.length > 0) {
        seenOrderIds.add(orderData.orderId);
        orders.push(orderData);
      }
    });

    console.log(`AOE: Page ${pageNum} parsed ${orders.length} orders`);
    return orders;
  }

  // ============================================
  // PROGRESS UI
  // ============================================

  function showProgressUI() {
    hideProgressUI(); // Remove any existing

    const overlay = document.createElement('div');
    overlay.id = 'aoe-progress-overlay';
    overlay.innerHTML = `
      <div class="aoe-progress-modal">
        <h3>Exporting Orders</h3>
        <div class="aoe-progress-bar-container">
          <div class="aoe-progress-bar" id="aoe-progress-bar"></div>
        </div>
        <p class="aoe-progress-text" id="aoe-progress-text">Initializing...</p>
        <p class="aoe-progress-stats" id="aoe-progress-stats"></p>
        <button class="aoe-cancel-btn" id="aoe-cancel-btn">Cancel</button>
      </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById('aoe-cancel-btn').addEventListener('click', () => {
      exportCancelled = true;
      hideProgressUI();
    });
  }

  function updateProgress({ current, total, message, ordersCollected }) {
    const progressBar = document.getElementById('aoe-progress-bar');
    const progressText = document.getElementById('aoe-progress-text');
    const progressStats = document.getElementById('aoe-progress-stats');

    if (progressText && message) {
      progressText.textContent = message;
    }

    if (progressBar && current && total) {
      const percent = Math.round((current / total) * 100);
      progressBar.style.width = `${percent}%`;
    }

    if (progressStats && ordersCollected !== undefined) {
      progressStats.textContent = `${ordersCollected} orders collected`;
    }
  }

  function hideProgressUI() {
    const existing = document.getElementById('aoe-progress-overlay');
    if (existing) {
      existing.remove();
    }
  }

  // ============================================
  // MULTI-PAGE FETCH ORCHESTRATOR
  // ============================================

  async function fetchAllPages(onProgress) {
    const totalOrders = detectTotalOrders();
    const ordersPerPage = 10;
    const totalPages = totalOrders ? Math.ceil(totalOrders / ordersPerPage) : 1;

    console.log(`AOE: Detected ${totalOrders} total orders, ${totalPages} pages`);
    console.log(`AOE: Current URL: ${window.location.href}`);

    onProgress({
      message: `Found ${totalOrders || 'unknown'} orders across ${totalPages} page(s)`,
      ordersCollected: 0
    });

    // Parse current page first
    const allOrders = parseOrdersFromPage();
    const seenOrderIds = new Set(allOrders.map(o => o.orderId));

    onProgress({
      current: 1,
      total: totalPages,
      message: `Parsed current page (${allOrders.length} orders)`,
      ordersCollected: allOrders.length
    });

    // If only one page or couldn't detect total, return current page results
    if (totalPages <= 1 || !totalOrders) {
      return allOrders;
    }

    // Create request queue with rate limiting
    const queue = new RequestQueue(2, 800);

    // Determine current page's startIndex
    const currentStartIndex = parseInt(
      new URL(window.location.href).searchParams.get('startIndex') || '0'
    );

    // Fetch remaining pages
    const pagePromises = [];
    let pagesProcessed = 1; // We already have current page

    for (let startIndex = 0; startIndex < totalOrders; startIndex += ordersPerPage) {
      // Skip current page (already parsed)
      if (startIndex === currentStartIndex) continue;

      const url = buildPageUrl(startIndex);
      const pageNum = Math.floor(startIndex / ordersPerPage) + 1;

      pagePromises.push(
        queue.add(async () => {
          if (exportCancelled) {
            throw new Error('Export cancelled');
          }

          onProgress({
            current: pagesProcessed + 1,
            total: totalPages,
            message: `Fetching page ${pageNum} of ${totalPages}...`,
            ordersCollected: allOrders.length
          });

          try {
            console.log(`AOE: Fetching URL: ${url}`);
            const html = await fetchPageWithRetry(url);
            console.log(`AOE: Got ${html.length} bytes for page ${pageNum}`);
            const orders = parseOrdersFromHTML(html, pageNum);
            pagesProcessed++;
            return { success: true, orders, pageNum };
          } catch (err) {
            console.error(`AOE: Failed to fetch page ${pageNum}:`, err);
            pagesProcessed++;
            return { success: false, error: err, pageNum, orders: [] };
          }
        })
      );
    }

    // Wait for all pages to complete
    const results = await Promise.all(pagePromises);

    // Merge results, deduplicating by order ID
    let successCount = 1; // Current page
    let failCount = 0;

    results.forEach(result => {
      if (result.success) {
        successCount++;
        result.orders.forEach(order => {
          if (!seenOrderIds.has(order.orderId)) {
            seenOrderIds.add(order.orderId);
            allOrders.push(order);
          }
        });
      } else {
        failCount++;
      }
    });

    onProgress({
      current: totalPages,
      total: totalPages,
      message: `Completed: ${successCount} pages fetched${failCount > 0 ? `, ${failCount} failed` : ''}`,
      ordersCollected: allOrders.length
    });

    // Sort by date (newest first) - parse the date for sorting
    allOrders.sort((a, b) => {
      const dateA = new Date(a.orderDate);
      const dateB = new Date(b.orderDate);
      if (isNaN(dateA.getTime()) || isNaN(dateB.getTime())) return 0;
      return dateB - dateA;
    });

    return allOrders;
  }

  // ============================================
  // BUTTON INJECTION
  // ============================================

  function injectExportButton() {
    const existingBtn = document.getElementById('aoe-export-btn');
    if (existingBtn) return;

    // Find the orders container header area
    const headerArea = document.querySelector('.your-orders-content-container h1')
      || document.querySelector('[data-testid="yo-order-history-header"]')
      || document.querySelector('.a-row.a-spacing-base');

    if (!headerArea) {
      console.log('AOE: Could not find header area, retrying...');
      setTimeout(injectExportButton, 1000);
      return;
    }

    const btnContainer = document.createElement('div');
    btnContainer.id = 'aoe-btn-container';
    btnContainer.innerHTML = `
      <button id="aoe-export-btn" class="aoe-btn">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        Export Orders to CSV
      </button>
      <span id="aoe-status"></span>
    `;

    headerArea.parentNode.insertBefore(btnContainer, headerArea.nextSibling);

    document.getElementById('aoe-export-btn').addEventListener('click', exportOrders);
  }

  // ============================================
  // SCROLL TO LOAD LAZY CONTENT
  // ============================================

  async function scrollToLoadAllOrders(updateStatus) {
    return new Promise((resolve) => {
      let lastHeight = 0;
      let sameHeightCount = 0;
      let scrollAttempts = 0;
      const maxAttempts = 50; // Reduced since we're fetching other pages anyway

      const scrollInterval = setInterval(() => {
        const currentHeight = document.documentElement.scrollHeight;

        window.scrollTo(0, currentHeight);
        scrollAttempts++;

        const orderCount = document.querySelectorAll('.order-card, [data-testid="order-card"], .a-box-group.order').length;
        updateStatus(`Loading visible orders... (${orderCount} found)`);

        if (currentHeight === lastHeight) {
          sameHeightCount++;
        } else {
          sameHeightCount = 0;
        }

        lastHeight = currentHeight;

        if (sameHeightCount >= 3 || scrollAttempts >= maxAttempts) {
          clearInterval(scrollInterval);
          window.scrollTo(0, 0);
          setTimeout(resolve, 300);
        }
      }, 500);
    });
  }

  // ============================================
  // ORDER PARSING
  // ============================================

  function parseOrdersFromPage() {
    const orders = [];
    const seenOrderIds = new Set();

    const orderCards = document.querySelectorAll('.order-card, [data-testid="order-card"], .a-box-group.order, .order');

    orderCards.forEach(card => {
      const orderData = extractOrderInfo(card);
      if (orderData.orderId && !seenOrderIds.has(orderData.orderId) && orderData.items.length > 0) {
        seenOrderIds.add(orderData.orderId);
        orders.push(orderData);
      }
    });

    return orders;
  }

  function extractOrderInfo(card) {
    if (!card) return { items: [], orderId: '', orderDate: '', orderTotal: '' };

    // Order date
    let orderDate = '';
    const orderInfoSection = card.querySelector('.order-info, .yohtmlc-order-info');
    if (orderInfoSection) {
      const spans = orderInfoSection.querySelectorAll('.a-color-secondary, .value');
      for (const span of spans) {
        const text = span.textContent.trim();
        if (/^(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}$/i.test(text)) {
          orderDate = text;
          break;
        }
      }
    }

    if (!orderDate) {
      const allText = card.textContent;
      const dateMatch = allText.match(/(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/i);
      if (dateMatch) {
        orderDate = dateMatch[0];
      }
    }

    // Order ID
    let orderId = '';
    const orderIdEl = card.querySelector('.yohtmlc-order-id .value, [data-testid="order-id"] .value, bdi');
    if (orderIdEl) {
      orderId = orderIdEl.textContent.trim();
    }

    if (!orderId) {
      const orderLink = card.querySelector('a[href*="order-details"], a[href*="orderID="]');
      if (orderLink) {
        const match = orderLink.href.match(/orderID=([A-Z0-9-]+)/i);
        if (match) orderId = match[1];
      }
    }

    if (!orderId) {
      const idMatch = card.textContent.match(/\b(\d{3}-\d{7}-\d{7})\b/);
      if (idMatch) {
        orderId = idMatch[1];
      }
    }

    // Order total
    let orderTotal = '';
    const totalEl = card.querySelector('.yohtmlc-order-total .value, [data-testid="order-total"] .value');
    if (totalEl) {
      orderTotal = totalEl.textContent.trim();
    }

    if (!orderTotal) {
      const totalMatch = card.textContent.match(/(?:Order Total|Total)[:\s]*(\$[\d,]+\.\d{2})/i);
      if (totalMatch) {
        orderTotal = totalMatch[1];
      }
    }

    // Items
    const items = [];
    const seenProducts = new Set();

    const itemContainers = card.querySelectorAll('.yohtmlc-item, [data-testid="item-box"], .a-fixed-left-grid.item-box');

    itemContainers.forEach(container => {
      const item = extractItemInfo(container, orderDate, orderId, orderTotal);
      if (item && item.productName) {
        const key = `${item.productName}|${item.asin}`;
        if (!seenProducts.has(key)) {
          seenProducts.add(key);
          items.push(item);
        }
      }
    });

    if (items.length === 0) {
      const productLinks = card.querySelectorAll('.yohtmlc-product-title, a.a-link-normal[title]');
      productLinks.forEach(link => {
        const name = (link.title || link.textContent).trim();
        if (name && name.length > 5) {
          const key = `${name}|`;
          if (!seenProducts.has(key)) {
            seenProducts.add(key);

            let asin = '';
            const href = link.href || '';
            const asinMatch = href.match(/\/dp\/([A-Z0-9]{10})|\/gp\/product\/([A-Z0-9]{10})/i);
            if (asinMatch) {
              asin = (asinMatch[1] || asinMatch[2]).toUpperCase();
            }

            items.push({
              productName: cleanText(name),
              quantity: '1',
              price: '',
              asin,
              orderDate,
              orderId,
              orderTotal: cleanText(orderTotal)
            });
          }
        }
      });
    }

    return { orderDate, orderId, orderTotal, items };
  }

  function extractItemInfo(container, orderDate, orderId, orderTotal) {
    const nameEl = container.querySelector('.yohtmlc-product-title, a[href*="/dp/"][title], a[href*="/gp/product/"][title]');
    let productName = '';
    if (nameEl) {
      productName = nameEl.title || nameEl.textContent.trim();
    }

    if (!productName) {
      const anyProductLink = container.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
      if (anyProductLink) {
        productName = anyProductLink.title || anyProductLink.textContent.trim();
      }
    }

    if (!productName || productName.length < 5) return null;
    if (/^(Buy|View|Return|Write|Track|Archive|Problem)/i.test(productName)) return null;

    let quantity = '1';
    const qtyMatch = container.textContent.match(/Qty:\s*(\d+)/i);
    if (qtyMatch) {
      quantity = qtyMatch[1];
    }

    let price = '';
    const priceEl = container.querySelector('.a-color-price, .yohtmlc-item-price, .a-price .a-offscreen');
    if (priceEl) {
      price = priceEl.textContent.trim();
    }

    let asin = '';
    const asinLink = container.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
    if (asinLink) {
      const asinMatch = asinLink.href.match(/\/dp\/([A-Z0-9]{10})|\/gp\/product\/([A-Z0-9]{10})/i);
      if (asinMatch) {
        asin = (asinMatch[1] || asinMatch[2]).toUpperCase();
      }
    }

    return {
      productName: cleanText(productName),
      quantity,
      price: cleanText(price),
      asin,
      orderDate,
      orderId,
      orderTotal: cleanText(orderTotal)
    };
  }

  function cleanText(text) {
    if (!text) return '';
    return text.replace(/\s+/g, ' ').trim();
  }

  // ============================================
  // CSV GENERATION
  // ============================================

  function ordersToCSV(orders) {
    const headers = ['Order Date', 'Order ID', 'Product Name', 'Quantity', 'Item Price', 'ASIN', 'Order Total'];
    const rows = [headers.join(',')];

    orders.forEach(order => {
      order.items.forEach(item => {
        const row = [
          escapeCSV(item.orderDate),
          escapeCSV(item.orderId),
          escapeCSV(item.productName),
          escapeCSV(item.quantity),
          escapeCSV(item.price),
          escapeCSV(item.asin),
          escapeCSV(item.orderTotal)
        ];
        rows.push(row.join(','));
      });
    });

    return rows.join('\n');
  }

  function escapeCSV(value) {
    if (!value) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  function downloadCSV(csv, filename) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }

  function setStatus(message, isError = false, persist = false) {
    const statusEl = document.getElementById('aoe-status');
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = isError ? 'aoe-status-error' : 'aoe-status-success';
      if (!persist) {
        setTimeout(() => { statusEl.textContent = ''; }, 5000);
      }
    }
  }

  // ============================================
  // MAIN EXPORT FUNCTION
  // ============================================

  async function exportOrders() {
    const btn = document.getElementById('aoe-export-btn');
    const originalText = btn.innerHTML;
    btn.disabled = true;

    exportCancelled = false;
    showProgressUI();

    try {
      // First scroll to load lazy content on current page
      updateProgress({ message: 'Loading orders on current page...' });
      await scrollToLoadAllOrders((msg) => updateProgress({ message: msg }));

      if (exportCancelled) {
        throw new Error('Export cancelled');
      }

      // Fetch all pages
      const orders = await fetchAllPages(updateProgress);

      if (exportCancelled) {
        throw new Error('Export cancelled');
      }

      if (orders.length === 0) {
        updateProgress({ message: 'No orders found. Make sure you\'re on the Orders page.' });
        setTimeout(hideProgressUI, 2000);
        return;
      }

      // Generate and download CSV
      const totalItems = orders.reduce((sum, o) => sum + o.items.length, 0);
      const csv = ordersToCSV(orders);
      const date = new Date().toISOString().split('T')[0];
      const filename = `amazon-orders-${date}.csv`;

      downloadCSV(csv, filename);

      updateProgress({
        current: 100,
        total: 100,
        message: `Success! Exported ${totalItems} items from ${orders.length} orders`,
        ordersCollected: orders.length
      });

      setStatus(`Exported ${totalItems} items from ${orders.length} orders`);

      setTimeout(hideProgressUI, 2000);

    } catch (error) {
      console.error('AOE Export Error:', error);
      if (error.message !== 'Export cancelled') {
        updateProgress({ message: `Export failed: ${error.message}` });
        setStatus('Export failed: ' + error.message, true);
        setTimeout(hideProgressUI, 3000);
      }
    } finally {
      btn.innerHTML = originalText;
      btn.disabled = false;
    }
  }

  // ============================================
  // INITIALIZATION
  // ============================================

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectExportButton);
  } else {
    injectExportButton();
  }

  // Re-inject on navigation (for SPAs)
  const observer = new MutationObserver(() => {
    if (!document.getElementById('aoe-export-btn')) {
      injectExportButton();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

})();
