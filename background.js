// Amazon Order Exporter - Background Service Worker
// Coordinates multi-page scraping across page navigations

// Message handlers
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'START_EXPORT':
      handleStartExport(sender.tab?.id);
      sendResponse({ success: true });
      break;

    case 'CHECK_EXPORT_STATUS':
      handleCheckStatus(sendResponse);
      return true; // Keep channel open for async response

    case 'ADD_ORDERS':
      handleAddOrders(message.orders, message.pageInfo);
      sendResponse({ success: true });
      break;

    case 'EXPORT_COMPLETE':
      handleExportComplete(sender.tab?.id);
      sendResponse({ success: true });
      break;

    case 'CANCEL_EXPORT':
      handleCancelExport();
      sendResponse({ success: true });
      break;

    case 'GET_ALL_ORDERS':
      handleGetAllOrders(sendResponse);
      return true; // Keep channel open for async response

    default:
      sendResponse({ error: 'Unknown message type' });
  }
});

async function handleStartExport(tabId) {
  // Clear any previous export data and start fresh
  await chrome.storage.local.set({
    exportActive: true,
    exportTabId: tabId,
    exportOrders: [],
    exportOrderIds: [],
    exportStartTime: Date.now(),
    exportPagesProcessed: 0
  });
  console.log('AOE Background: Export started');
}

async function handleCheckStatus(sendResponse) {
  const data = await chrome.storage.local.get([
    'exportActive',
    'exportOrders',
    'exportPagesProcessed'
  ]);
  sendResponse({
    isActive: data.exportActive || false,
    orderCount: data.exportOrders?.length || 0,
    pagesProcessed: data.exportPagesProcessed || 0
  });
}

async function handleAddOrders(orders, pageInfo) {
  const data = await chrome.storage.local.get(['exportOrders', 'exportOrderIds', 'exportPagesProcessed']);

  const existingOrders = data.exportOrders || [];
  const existingIds = new Set(data.exportOrderIds || []);

  // Dedupe and add new orders
  const newOrders = orders.filter(o => o.orderId && !existingIds.has(o.orderId));
  newOrders.forEach(o => existingIds.add(o.orderId));

  const allOrders = [...existingOrders, ...newOrders];
  const pagesProcessed = (data.exportPagesProcessed || 0) + 1;

  await chrome.storage.local.set({
    exportOrders: allOrders,
    exportOrderIds: Array.from(existingIds),
    exportPagesProcessed: pagesProcessed
  });

  console.log(`AOE Background: Added ${newOrders.length} orders from page ${pageInfo?.currentPage || '?'}. Total: ${allOrders.length}`);
}

async function handleExportComplete(tabId) {
  console.log('AOE Background: Export complete, notifying content script');

  // Get all collected orders
  const data = await chrome.storage.local.get(['exportOrders', 'exportPagesProcessed', 'exportStartTime']);
  const orders = data.exportOrders || [];
  const pagesProcessed = data.exportPagesProcessed || 0;
  const duration = Date.now() - (data.exportStartTime || Date.now());

  // Send orders back to content script for CSV generation
  if (tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'GENERATE_CSV',
        orders: orders,
        stats: {
          totalOrders: orders.length,
          pagesProcessed: pagesProcessed,
          duration: duration
        }
      });
    } catch (err) {
      console.error('AOE Background: Failed to send GENERATE_CSV message:', err);
    }
  }

  // Clear export state
  await chrome.storage.local.set({
    exportActive: false,
    exportTabId: null
  });
}

async function handleCancelExport() {
  console.log('AOE Background: Export cancelled');
  await chrome.storage.local.set({
    exportActive: false,
    exportTabId: null,
    exportOrders: [],
    exportOrderIds: [],
    exportPagesProcessed: 0
  });
}

async function handleGetAllOrders(sendResponse) {
  const data = await chrome.storage.local.get(['exportOrders']);
  sendResponse({ orders: data.exportOrders || [] });
}

// Clean up if tab is closed during export
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const data = await chrome.storage.local.get(['exportTabId']);
  if (data.exportTabId === tabId) {
    console.log('AOE Background: Export tab closed, cleaning up');
    await handleCancelExport();
  }
});

console.log('AOE Background: Service worker initialized');
