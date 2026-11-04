# Amazon Order Exporter

A Chrome extension that exports your Amazon order history to CSV format.

## Features

- Adds an "Export Orders to CSV" button to your Amazon Orders page
- Exports order date, order ID, product names, quantities, prices, and ASINs
- Works with Amazon's current order history layout
- No data leaves your browser - all processing is done locally

## Installation

### From Source (Developer Mode)

1. Clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select the extension folder
5. The extension icon should appear in your toolbar

## Usage

1. Navigate to [Amazon Orders](https://www.amazon.com/gp/your-account/order-history)
2. Pick what to export in the dropdown next to the export button:
   - "This view only" exports whatever Amazon's time filter is showing
   - A year range, such as "2026 back to 2023", exports each of those years into one CSV
3. Click the "Export Orders to CSV" button that appears on the page
4. Leave the tab open while the extension moves through the pages, then a CSV file will download

## CSV Output

The exported CSV includes the following columns:

| Column | Description |
|--------|-------------|
| Order Date | Date the order was placed |
| Order ID | Amazon order identifier |
| Product Name | Name of the product |
| Quantity | Number of items |
| Item Price | Price of the item |
| ASIN | Amazon Standard Identification Number |
| Order Total | Total order amount |

## Privacy

This extension:
- Does NOT send any data to external servers
- Does NOT require any login or account
- Processes everything locally in your browser
- Only activates on Amazon order history pages

## License

MIT
