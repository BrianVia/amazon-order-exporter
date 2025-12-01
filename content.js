// Amazon Order Exporter - Content Script

(function() {
  'use strict';

  // Prevent multiple injections
  if (window.amazonOrderExporterLoaded) return;
  window.amazonOrderExporterLoaded = true;

  // Create and inject the export button
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

  // Scroll through the page to load all lazy-loaded orders
  async function scrollToLoadAllOrders(updateStatus) {
    return new Promise((resolve) => {
      let lastHeight = 0;
      let sameHeightCount = 0;
      let scrollAttempts = 0;
      const maxAttempts = 100; // Safety limit

      const scrollInterval = setInterval(() => {
        const currentHeight = document.documentElement.scrollHeight;

        // Scroll to bottom
        window.scrollTo(0, currentHeight);
        scrollAttempts++;

        // Count how many order cards we have
        const orderCount = document.querySelectorAll('.order-card, [data-testid="order-card"], .a-box-group.order').length;
        updateStatus(`Loading orders... (${orderCount} found)`);

        // Check if we've stopped loading new content
        if (currentHeight === lastHeight) {
          sameHeightCount++;
        } else {
          sameHeightCount = 0;
        }

        lastHeight = currentHeight;

        // Stop if page height hasn't changed for 3 checks or we hit max attempts
        if (sameHeightCount >= 3 || scrollAttempts >= maxAttempts) {
          clearInterval(scrollInterval);
          // Scroll back to top
          window.scrollTo(0, 0);
          // Wait a moment for any final renders
          setTimeout(resolve, 500);
        }
      }, 800);
    });
  }

  // Parse orders from the current page
  function parseOrdersFromPage() {
    const orders = [];
    const seenOrderIds = new Set();

    // Find all order cards - be more specific with selectors
    const orderCards = document.querySelectorAll('.order-card, [data-testid="order-card"], .a-box-group.order, .order');

    orderCards.forEach(card => {
      const orderData = extractOrderInfo(card);
      // Dedupe by order ID
      if (orderData.orderId && !seenOrderIds.has(orderData.orderId) && orderData.items.length > 0) {
        seenOrderIds.add(orderData.orderId);
        orders.push(orderData);
      }
    });

    return orders;
  }

  // Extract order information from a single order card
  function extractOrderInfo(card) {
    if (!card) return { items: [], orderId: '', orderDate: '', orderTotal: '' };

    // Order date - look for specific patterns
    let orderDate = '';

    // Try multiple approaches for date
    const orderInfoSection = card.querySelector('.order-info, .yohtmlc-order-info');
    if (orderInfoSection) {
      // Look for "Order placed" or date pattern
      const spans = orderInfoSection.querySelectorAll('.a-color-secondary, .value');
      for (const span of spans) {
        const text = span.textContent.trim();
        // Match date patterns like "January 15, 2025" or "Jan 15, 2025"
        if (/^(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}$/i.test(text)) {
          orderDate = text;
          break;
        }
      }
    }

    // Fallback: search more broadly
    if (!orderDate) {
      const allText = card.textContent;
      const dateMatch = allText.match(/(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/i);
      if (dateMatch) {
        orderDate = dateMatch[0];
      }
    }

    // Order ID - look for the specific pattern
    let orderId = '';
    const orderIdEl = card.querySelector('.yohtmlc-order-id .value, [data-testid="order-id"] .value, bdi');
    if (orderIdEl) {
      orderId = orderIdEl.textContent.trim();
    }

    // Fallback: try finding it in text or links
    if (!orderId) {
      const orderLink = card.querySelector('a[href*="order-details"], a[href*="orderID="]');
      if (orderLink) {
        const match = orderLink.href.match(/orderID=([A-Z0-9-]+)/i);
        if (match) orderId = match[1];
      }
    }

    // Another fallback: look for order ID pattern in text
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

    // Fallback for total
    if (!orderTotal) {
      const totalMatch = card.textContent.match(/(?:Order Total|Total)[:\s]*(\$[\d,]+\.\d{2})/i);
      if (totalMatch) {
        orderTotal = totalMatch[1];
      }
    }

    // Items in this order - use more specific selectors and dedupe
    const items = [];
    const seenProducts = new Set();

    // Primary item selectors
    const itemContainers = card.querySelectorAll('.yohtmlc-item, [data-testid="item-box"], .a-fixed-left-grid.item-box');

    itemContainers.forEach(container => {
      const item = extractItemInfo(container, orderDate, orderId, orderTotal);
      if (item && item.productName) {
        // Dedupe by product name + ASIN combo
        const key = `${item.productName}|${item.asin}`;
        if (!seenProducts.has(key)) {
          seenProducts.add(key);
          items.push(item);
        }
      }
    });

    // Fallback: If no items found, look for product links directly
    if (items.length === 0) {
      const productLinks = card.querySelectorAll('.yohtmlc-product-title, a.a-link-normal[title]');
      productLinks.forEach(link => {
        const name = (link.title || link.textContent).trim();
        if (name && name.length > 5) {
          const key = `${name}|`;
          if (!seenProducts.has(key)) {
            seenProducts.add(key);

            // Try to get ASIN from link
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

  // Extract individual item info
  function extractItemInfo(container, orderDate, orderId, orderTotal) {
    // Product name - prioritize title attribute, then text
    const nameEl = container.querySelector('.yohtmlc-product-title, a[href*="/dp/"][title], a[href*="/gp/product/"][title]');
    let productName = '';
    if (nameEl) {
      productName = nameEl.title || nameEl.textContent.trim();
    }

    // Fallback: look for any product link
    if (!productName) {
      const anyProductLink = container.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
      if (anyProductLink) {
        productName = anyProductLink.title || anyProductLink.textContent.trim();
      }
    }

    // Skip if no product name or it's too short
    if (!productName || productName.length < 5) return null;

    // Skip if this looks like a button or action link
    if (/^(Buy|View|Return|Write|Track|Archive|Problem)/i.test(productName)) return null;

    // Quantity
    let quantity = '1';
    const qtyMatch = container.textContent.match(/Qty:\s*(\d+)/i);
    if (qtyMatch) {
      quantity = qtyMatch[1];
    }

    // Price
    let price = '';
    const priceEl = container.querySelector('.a-color-price, .yohtmlc-item-price, .a-price .a-offscreen');
    if (priceEl) {
      price = priceEl.textContent.trim();
    }

    // ASIN
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

  // Clean text - remove extra whitespace and newlines
  function cleanText(text) {
    if (!text) return '';
    return text.replace(/\s+/g, ' ').trim();
  }

  // Convert orders to CSV
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

  // Escape CSV values
  function escapeCSV(value) {
    if (!value) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  // Download CSV file
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

  // Set status message
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

  // Main export function
  async function exportOrders() {
    const btn = document.getElementById('aoe-export-btn');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<span class="aoe-spinner"></span> Loading all orders...';
    btn.disabled = true;

    try {
      // First, scroll through the page to load all lazy-loaded orders
      await scrollToLoadAllOrders((msg) => {
        const statusEl = document.getElementById('aoe-status');
        if (statusEl) {
          statusEl.textContent = msg;
          statusEl.className = 'aoe-status-success';
        }
      });

      btn.innerHTML = '<span class="aoe-spinner"></span> Parsing orders...';

      // Small delay to let the DOM settle
      await new Promise(r => setTimeout(r, 300));

      const orders = parseOrdersFromPage();

      if (orders.length === 0) {
        setStatus('No orders found on this page. Make sure you\'re on the Orders page.', true);
        return;
      }

      const totalItems = orders.reduce((sum, o) => sum + o.items.length, 0);
      const csv = ordersToCSV(orders);
      const date = new Date().toISOString().split('T')[0];
      const filename = `amazon-orders-${date}.csv`;

      downloadCSV(csv, filename);
      setStatus(`Exported ${totalItems} items from ${orders.length} orders`);

    } catch (error) {
      console.error('AOE Export Error:', error);
      setStatus('Export failed: ' + error.message, true);
    } finally {
      btn.innerHTML = originalText;
      btn.disabled = false;
    }
  }

  // Initialize
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
