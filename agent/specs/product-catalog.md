# Product Catalog

A single-page application for browsing a catalog of items. The application reads item records from a mocked GraphQL API, displays them as cards, lets the user search and sort the list, and lets the user add new items through a form.

## Data

Each item in the catalog has the following fields:

- A unique identifier
- A manufacturer (e.g. "Toyota")
- A product name (e.g. "Camry")
- A release year (a four-digit integer)
- A primary attribute (a string describing the item — e.g. "Silver")
- Three image URLs, one for each viewport size: mobile, tablet, and desktop

The mock GraphQL API and the five seed items it serves are already configured in the boilerplate. The relevant GraphQL operations — a query that returns all items, a query that returns a single item by ID, and a mutation that adds a new item — are already defined in `src/graphql/queries.ts` and the boilerplate's MSW handlers already respond to them. The application should import and use these existing operations rather than redefining them.

(Note: the GraphQL operations in the boilerplate use the field names `make`, `model`, `year`, `color`, `mobile`, `tablet`, `desktop` — treat `make` as manufacturer, `model` as product name, `year` as release year, and `color` as the primary attribute.)

## Screens and Behavior

There is one screen. It shows the following, top to bottom:

### Title

A heading identifying the application as a product catalog.

### Controls

A horizontal row of controls that lets the user filter and sort the list below:

- A search input that filters the list by product name. Matching is case-insensitive and partial.
- A sort selector with two options: sort by release year (newest first) and sort by manufacturer (alphabetical).

### Catalog Grid

Below the controls, a grid of cards — one card per item in the filtered, sorted list. Each card shows:

- The item's image, chosen based on the current viewport width: mobile for 640px and below, tablet for 641–1023px, desktop for 1024px and above.
- The release year, manufacturer, and product name displayed together as a readable heading.
- The primary attribute displayed below the heading.

### Add Item Form

Below the catalog grid, a form that lets the user add a new item. The form has four fields: manufacturer, product name, year, and primary attribute — all required. Submitting calls the GraphQL mutation that adds an item. After successful submission, the form clears and the new item appears in the list.

## Styling

Uses Material UI throughout. Responsive layout. No additional CSS-in-JS libraries.

## Code Organization

GraphQL access is extracted into a custom hook. Components are small and single-purpose.

## Testing

Tests cover the card rendering, the search filter, and the add-item form submission, using Apollo's `MockedProvider` pattern with `__typename` on mock data.

## What Is Already Set Up

- React, TypeScript, Vite, Material UI, Apollo Client, MSW, Vitest are configured.
- The data type is defined in `src/types.ts` (named `Car` in the boilerplate, representing a generic catalog item).
- Apollo client, GraphQL operations (`GetCars`, `GetCar`, `AddCar`), MSW handlers, and five seed items are set up.
- `src/components/Example.tsx` and `src/__tests__/Example.test.tsx` demonstrate the expected style.

Generated code should match the conventions visible in those reference files.