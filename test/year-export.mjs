// Runs the real extension in Chromium against a fake Amazon orders site.
// CHROME_PATH must point at a Chromium build (branded Chrome ignores --load-extension).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const extensionPath = path.resolve(import.meta.dirname, '..');

const ordersByFilter = {
  'months-3': [['111-0000001-0000001', 'October 1, 2026', 'Recent Desk Lamp']],
  'year-2026': [
    ['111-0000001-0000001', 'October 1, 2026', 'Recent Desk Lamp'],
    ['111-0000002-0000002', 'February 2, 2026', 'Winter Gloves Pair'],
  ],
  'year-2025': [['111-0000003-0000003', 'June 3, 2025', 'Garden Hose Long']],
  'year-2024': [],
  'year-2023': [['111-0000004-0000004', 'May 4, 2023', 'Should Not Export']],
};

function orderCard([id, date, name]) {
  return `<div class="order-card js-order-card">
    <span>Order placed</span> <span>${date}</span> <span>Total</span> <span>$10.00</span>
    <div class="yohtmlc-order-id"><span dir="ltr">${id}</span></div>
    <div class="yohtmlc-product-title"><a href="/gp/product/B000000001">${name}</a></div>
  </div>`;
}

function pagination(filter, pageIndex, pageCount) {
  if (pageCount < 2) return '';
  const next = pageIndex + 1 < pageCount
    ? `<a href="/your-orders/orders?timeFilter=${filter}&startIndex=${(pageIndex + 1) * 10}">Next</a>`
    : 'Next';
  const disabled = pageIndex + 1 < pageCount ? '' : 'a-disabled';
  return `<ul class="a-pagination"><li class="a-selected"><a>${pageIndex + 1}</a></li><li class="a-last ${disabled}">${next}</li></ul>`;
}

function ordersPage(filter, startIndex) {
  const orders = ordersByFilter[filter];
  const pageIndex = startIndex / 10;
  const shown = filter === 'year-2026' ? orders.slice(pageIndex, pageIndex + 1) : orders;
  const pageCount = filter === 'year-2026' ? orders.length : 1;
  const options = Object.keys(ordersByFilter)
    .map(value => `<option value="${value}"${value === filter ? ' selected' : ''}>${value}</option>`)
    .join('');
  return `<!doctype html><title>Your Orders</title>
    <div class="your-orders-content-container"><h1>Your Orders</h1>
    <select name="timeFilter">${options}</select>
    ${shown.map(orderCard).join('')}${pagination(filter, pageIndex, pageCount)}</div>`;
}

async function exportCsv(context, chooseOption) {
  const page = await context.newPage();
  await page.goto('https://www.amazon.com/your-orders/orders');
  await page.waitForSelector('#aoe-export-btn');
  const labels = await page.locator('#aoe-year-select option').allTextContents();
  if (chooseOption) await page.selectOption('#aoe-year-select', chooseOption);
  const download = page.waitForEvent('download', { timeout: 30000 });
  await page.click('#aoe-export-btn');
  const csv = fs.readFileSync(await (await download).path(), 'utf8');
  await page.close();
  return { csv, labels };
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aoe-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH,
  headless: false,
  acceptDownloads: true,
  args: [
    '--headless=new',
    '--no-sandbox',
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
});

try {
  await context.route('https://www.amazon.com/**', route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/your-orders')) return route.fulfill({ status: 404, body: '' });
    const filter = url.searchParams.get('timeFilter') ?? 'months-3';
    const startIndex = Number(url.searchParams.get('startIndex') ?? 0);
    return route.fulfill({ contentType: 'text/html', body: ordersPage(filter, startIndex) });
  });

  const range = await exportCsv(context, '2024');
  assert.deepEqual(range.labels, [
    'This view only',
    '2026',
    '2026 back to 2025',
    '2026 back to 2024',
    '2026 back to 2023',
  ]);
  assert.match(range.csv, /Recent Desk Lamp/);
  assert.match(range.csv, /Winter Gloves Pair/);
  assert.match(range.csv, /Garden Hose Long/);
  assert.doesNotMatch(range.csv, /Should Not Export/);
  assert.equal(range.csv.trim().split('\n').length, 4);

  const currentView = await exportCsv(context);
  assert.equal(currentView.csv.trim().split('\n').length, 2);
  assert.match(currentView.csv, /Recent Desk Lamp/);

  console.log('year export ok');
} finally {
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
