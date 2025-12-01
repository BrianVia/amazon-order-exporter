// Amazon Order Exporter - Content Script
// Uses click-through pagination with background script coordination

(function() {
  'use strict';

  // Prevent multiple injections
  if (window.amazonOrderExporterLoaded) return;
  window.amazonOrderExporterLoaded = true;

  const BUTTON_ORIGINAL_HTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
      <polyline points="7 10 12 15 17 10"></polyline>
      <line x1="12" y1="15" x2="12" y2="3"></line>
    </svg>
    Export Orders to CSV
  `;

  // ============================================
  // PAGINATION DETECTION
  // ============================================

  function detectPagination() {
    const result = {
      hasNextPage: false,
      nextButton: null,
      currentPage: 1,
      totalOrders: null
    };

    // Detect total orders
    const numOrdersEl = document.querySelector('.num-orders');
    if (numOrdersEl) {
      const match = numOrdersEl.textContent.match(/(\d+)\s*orders?/i);
      if (match) result.totalOrders = parseInt(match[1], 10);
    }

    // Find pagination controls
    const pagination = document.querySelector('.a-pagination');
    if (pagination) {
      // Find current page number
      const selectedPage = pagination.querySelector('li.a-selected');
      if (selectedPage) {
        result.currentPage = parseInt(selectedPage.textContent.trim(), 10) || 1;
      }

      // Find Next button
      const nextLi = pagination.querySelector('li.a-last');
      if (nextLi && !nextLi.classList.contains('a-disabled')) {
        const nextLink = nextLi.querySelector('a');
        if (nextLink) {
          result.hasNextPage = true;
          result.nextButton = nextLink;
        }
      }
    }

    // Fallback: look for next page link in URL pattern
    if (!result.nextButton) {
      const nextLinks = document.querySelectorAll('a[href*="startIndex"]');
      for (const link of nextLinks) {
        if (link.textContent.trim().toLowerCase() === 'next' ||
            link.querySelector('.a-icon-next')) {
          result.hasNextPage = true;
          result.nextButton = link;
          break;
        }
      }
    }

    console.log(`AOE: Pagination detected - Page ${result.currentPage}, hasNext: ${result.hasNextPage}, totalOrders: ${result.totalOrders}`);
    return result;
  }

  // ============================================
  // ORDER PARSING
  // ============================================

  function parseOrdersFromPage() {
    const orders = [];
    const seenOrderIds = new Set();

    const orderCards = document.querySelectorAll('.order-card, [data-testid="order-card"], .a-box-group.order, .order');
    console.log(`AOE: Found ${orderCards.length} order cards on page`);

    orderCards.forEach(card => {
      const orderData = extractOrderInfo(card);
      if (orderData.orderId && !seenOrderIds.has(orderData.orderId) && orderData.items.length > 0) {
        seenOrderIds.add(orderData.orderId);
        orders.push(orderData);
      }
    });

    console.log(`AOE: Parsed ${orders.length} orders from current page`);
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

  // ============================================
  // UI COMPONENTS
  // ============================================

  function injectExportButton() {
    const existingBtn = document.getElementById('aoe-export-btn');
    if (existingBtn) return;

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
      <button id="aoe-export-btn" class="aoe-btn">${BUTTON_ORIGINAL_HTML}</button>
      <span id="aoe-status"></span>
    `;

    headerArea.parentNode.insertBefore(btnContainer, headerArea.nextSibling);

    document.getElementById('aoe-export-btn').addEventListener('click', startExport);
  }

  function setStatus(message, isError = false) {
    const statusEl = document.getElementById('aoe-status');
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = isError ? 'aoe-status-error' : 'aoe-status-success';
    }
  }

  function setButtonState(loading, text) {
    const btn = document.getElementById('aoe-export-btn');
    if (btn) {
      if (loading) {
        btn.innerHTML = `<span class="aoe-spinner"></span> ${text || 'Processing...'}`;
        btn.disabled = true;
      } else {
        btn.innerHTML = BUTTON_ORIGINAL_HTML;
        btn.disabled = false;
      }
    }
  }

  function showProgressBanner(message) {
    let banner = document.getElementById('aoe-progress-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'aoe-progress-banner';
      banner.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        background: linear-gradient(to right, #232f3e, #37475a);
        color: white;
        padding: 12px 20px;
        font-size: 14px;
        z-index: 10000;
        display: flex;
        justify-content: space-between;
        align-items: center;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      `;
      document.body.appendChild(banner);
    }

    banner.innerHTML = `
      <span><span class="aoe-spinner" style="border-color: white; border-top-color: transparent; margin-right: 10px;"></span>${message}</span>
      <button id="aoe-cancel-export" style="background: #c45500; border: none; color: white; padding: 6px 12px; border-radius: 4px; cursor: pointer;">Cancel</button>
    `;

    document.getElementById('aoe-cancel-export')?.addEventListener('click', cancelExport);
  }

  function hideProgressBanner() {
    const banner = document.getElementById('aoe-progress-banner');
    if (banner) {
      banner.remove();
    }
  }

  // ============================================
  // EXPORT FLOW
  // ============================================

  async function startExport() {
    console.log('AOE: Starting export...');

    // Tell background to start export mode
    await chrome.runtime.sendMessage({ type: 'START_EXPORT' });

    // Process current page
    await processCurrentPage();
  }

  async function processCurrentPage() {
    const pagination = detectPagination();

    setButtonState(true, `Page ${pagination.currentPage}...`);
    showProgressBanner(`Collecting orders from page ${pagination.currentPage}...`);

    // Wait a moment for any lazy content to load
    await new Promise(r => setTimeout(r, 500));

    // Parse orders from current page
    const orders = parseOrdersFromPage();
    console.log(`AOE: Page ${pagination.currentPage} has ${orders.length} orders`);

    // Send to background
    await chrome.runtime.sendMessage({
      type: 'ADD_ORDERS',
      orders: orders,
      pageInfo: {
        currentPage: pagination.currentPage,
        hasNextPage: pagination.hasNextPage,
        totalOrders: pagination.totalOrders
      }
    });

    // Update status
    const status = await chrome.runtime.sendMessage({ type: 'CHECK_EXPORT_STATUS' });
    showProgressBanner(`Collected ${status.orderCount} orders from ${status.pagesProcessed} page(s)...`);

    if (pagination.hasNextPage && pagination.nextButton) {
      console.log('AOE: Navigating to next page...');

      // Small delay before clicking to avoid rate limiting
      await new Promise(r => setTimeout(r, 1000));

      // Click next - page will reload and content script will re-run
      pagination.nextButton.click();
    } else {
      // No more pages - complete export
      console.log('AOE: No more pages, completing export');
      await chrome.runtime.sendMessage({ type: 'EXPORT_COMPLETE' });
    }
  }

  async function cancelExport() {
    console.log('AOE: Cancelling export...');
    await chrome.runtime.sendMessage({ type: 'CANCEL_EXPORT' });
    hideProgressBanner();
    setButtonState(false);
    setStatus('Export cancelled');
  }

  // ============================================
  // MESSAGE HANDLERS
  // ============================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GENERATE_CSV') {
      console.log('AOE: Generating CSV with', message.orders.length, 'orders');
      generateAndDownloadCSV(message.orders, message.stats);
      sendResponse({ success: true });
    }
    return true;
  });

  function generateAndDownloadCSV(orders, stats) {
    hideProgressBanner();
    setButtonState(false);

    if (orders.length === 0) {
      setStatus('No orders found', true);
      return;
    }

    // Sort by date (newest first)
    orders.sort((a, b) => {
      const dateA = new Date(a.orderDate);
      const dateB = new Date(b.orderDate);
      if (isNaN(dateA.getTime()) || isNaN(dateB.getTime())) return 0;
      return dateB - dateA;
    });

    const totalItems = orders.reduce((sum, o) => sum + o.items.length, 0);
    const csv = ordersToCSV(orders);
    const date = new Date().toISOString().split('T')[0];
    const filename = `amazon-orders-${date}.csv`;

    downloadCSV(csv, filename);

    const duration = Math.round((stats.duration || 0) / 1000);
    setStatus(`Exported ${totalItems} items from ${orders.length} orders (${stats.pagesProcessed} pages, ${duration}s)`);

    console.log(`AOE: Export complete - ${totalItems} items from ${orders.length} orders`);
  }

  // ============================================
  // INITIALIZATION
  // ============================================

  async function initialize() {
    console.log('AOE: Content script initializing...');

    // Always inject the button
    injectExportButton();

    // Check if we're in the middle of an export (page navigation during export)
    try {
      const status = await chrome.runtime.sendMessage({ type: 'CHECK_EXPORT_STATUS' });

      if (status.isActive) {
        console.log('AOE: Export in progress, continuing from page navigation...');

        // Continue the export - process this page
        setTimeout(() => {
          processCurrentPage();
        }, 500); // Small delay to let page render
      }
    } catch (err) {
      console.log('AOE: Not in export mode (background not responding)');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }

  // Re-inject button on SPA navigation
  const observer = new MutationObserver(() => {
    if (!document.getElementById('aoe-export-btn')) {
      injectExportButton();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

})();
