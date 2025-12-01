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

  // Parse orders from the current page
  function parseOrdersFromPage() {
    const orders = [];
    
    // Find all order cards
    const orderCards = document.querySelectorAll('.order-card, [data-testid="order-card"], .a-box-group.order');
    
    orderCards.forEach(card => {
      const orderData = extractOrderInfo(card);
      if (orderData.items.length > 0) {
        orders.push(orderData);
      }
    });

    // Fallback: Try alternative selectors if no orders found
    if (orders.length === 0) {
      const altOrderCards = document.querySelectorAll('.order-info, .js-order-card');
      altOrderCards.forEach(card => {
        const parent = card.closest('.a-box-group') || card.parentElement;
        const orderData = extractOrderInfo(parent);
        if (orderData.items.length > 0) {
          orders.push(orderData);
        }
      });
    }

    return orders;
  }

  // Extract order information from a single order card
  function extractOrderInfo(card) {
    if (!card) return { items: [] };

    // Order date
    const dateEl = card.querySelector('.order-info .value, [data-testid="order-date"] .value, .a-color-secondary.value');
    const orderDate = dateEl ? dateEl.textContent.trim() : '';

    // Order ID
    const orderIdEl = card.querySelector('[data-testid="order-id"] .value, .yohtmlc-order-id .value, bdi');
    let orderId = '';
    if (orderIdEl) {
      orderId = orderIdEl.textContent.trim();
    } else {
      // Try finding it in a link
      const orderLink = card.querySelector('a[href*="order-details"]');
      if (orderLink) {
        const match = orderLink.href.match(/orderID=([A-Z0-9-]+)/);
        if (match) orderId = match[1];
      }
    }

    // Order total
    const totalEl = card.querySelector('.order-info .value:last-of-type, [data-testid="order-total"] .value, .yohtmlc-order-total .value');
    const orderTotal = totalEl ? totalEl.textContent.trim() : '';

    // Items in this order
    const items = [];
    const itemRows = card.querySelectorAll('.yohtmlc-item, .a-fixed-left-grid.item-box, [data-testid="item-box"], .shipment .a-row');

    itemRows.forEach(row => {
      const item = extractItemInfo(row, orderDate, orderId, orderTotal);
      if (item && item.productName) {
        items.push(item);
      }
    });

    // Fallback: If no items found, try to find product titles directly
    if (items.length === 0) {
      const productLinks = card.querySelectorAll('.yohtmlc-product-title, a.a-link-normal[href*="/dp/"], a.a-link-normal[href*="/gp/product/"]');
      productLinks.forEach(link => {
        const name = link.textContent.trim();
        if (name && name.length > 3) {
          items.push({
            productName: name,
            quantity: '1',
            price: '',
            orderDate: orderDate,
            orderId: orderId,
            orderTotal: orderTotal
          });
        }
      });
    }

    return { orderDate, orderId, orderTotal, items };
  }

  // Extract individual item info
  function extractItemInfo(row, orderDate, orderId, orderTotal) {
    // Product name
    const nameEl = row.querySelector('.yohtmlc-product-title, a[href*="/dp/"], a[href*="/gp/product/"], .a-text-bold');
    let productName = '';
    if (nameEl) {
      productName = nameEl.textContent.trim();
    }

    // Skip if no product name or it's too short (likely a button or link)
    if (!productName || productName.length < 4) return null;

    // Quantity - look for explicit quantity text
    let quantity = '1';
    const qtyMatch = row.textContent.match(/Qty:\s*(\d+)/i);
    if (qtyMatch) {
      quantity = qtyMatch[1];
    }

    // Price
    const priceEl = row.querySelector('.a-color-price, .yohtmlc-item-price, span.a-price .a-offscreen');
    let price = '';
    if (priceEl) {
      price = priceEl.textContent.trim();
    }

    // ASIN
    let asin = '';
    const asinLink = row.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
    if (asinLink) {
      const asinMatch = asinLink.href.match(/\/dp\/([A-Z0-9]+)|\/gp\/product\/([A-Z0-9]+)/);
      if (asinMatch) {
        asin = asinMatch[1] || asinMatch[2];
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
  function setStatus(message, isError = false) {
    const statusEl = document.getElementById('aoe-status');
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = isError ? 'aoe-status-error' : 'aoe-status-success';
      setTimeout(() => { statusEl.textContent = ''; }, 5000);
    }
  }

  // Main export function
  async function exportOrders() {
    const btn = document.getElementById('aoe-export-btn');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<span class="aoe-spinner"></span> Scanning...';
    btn.disabled = true;

    try {
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
