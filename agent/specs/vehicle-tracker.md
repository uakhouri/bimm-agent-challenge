# Vehicle Tracker

A single-page application for browsing a small fleet of vehicles. The application reads vehicle records from a mocked GraphQL API, displays them as cards, lets the user search and sort the list, and lets the user add new vehicles through a form.

## Data

Each vehicle has the following fields:

- A unique identifier
- Manufacturer (e.g. "Toyota")
- Model designation (e.g. "Camry")
- Production year (a four-digit integer)
- Exterior finish
- Three image URLs, one for each viewport size: mobile, tablet, and desktop

The mock GraphQL API and the five seed vehicles it serves are already configured in the boilerplate. The relevant GraphQL operations — a query that returns all vehicles, a query that returns a single vehicle by ID, and a mutation that adds a new vehicle — are already defined in `src/graphql/queries.ts` and the boilerplate's MSW handlers already respond to them. The application should import and use these existing operations rather than redefining them.

## Screens and Behavior

There is one screen. It shows the following, top to bottom:

### Title

A heading identifying the application as a vehicle tracker.

### Controls

A horizontal row of controls that lets the user filter and sort the list below:

- A search input that filters the list by model designation. Matching is case-insensitive and partial (typing "cam" should match "Camry").
- A sort selector with two options: sort by production year (newest first) and sort by manufacturer (alphabetical).

Filter and sort are applied together — the user sees the list that results from applying the current search term and then applying the current sort order.

### Vehicle List

Below the controls, a grid of cards — one card per vehicle in the filtered, sorted list. Each card shows:

- The vehicle's image, chosen based on the current viewport width:
  - Mobile image when the viewport is 640px wide or narrower
  - Tablet image when the viewport is between 641px and 1023px inclusive
  - Desktop image when the viewport is 1024px wide or wider
- The manufacturer, model designation, and production year, displayed together as a readable heading (e.g. "2024 Toyota Camry")
- The exterior finish, displayed below the heading

If the underlying query is still loading, the list area shows a loading indicator. If the query fails, the list area shows an error message.

### Add Vehicle Form

Below the vehicle list, a form that lets the user add a new vehicle. The form has four fields:

- Manufacturer (text input, required)
- Model designation (text input, required)
- Year (numeric input, required, must be a valid four-digit year)
- Exterior finish (text input, required)

Submitting the form calls the GraphQL mutation that adds a vehicle. After a successful submission, the form clears and the newly added vehicle appears in the list without requiring a page reload.

If the submission fails, the form shows an error and keeps the user's entered values so they can retry.

## Styling

The application uses Material UI for all visual components — cards, text inputs, buttons, typography, and loading/error indicators. It does not introduce additional CSS-in-JS libraries or custom theming beyond what the boilerplate already provides. The overall layout is responsive: it works on mobile, tablet, and desktop viewports without horizontal scrolling.

## Code Organization

GraphQL data access is extracted into a custom React hook. Any component that needs the list of vehicles or needs to add a vehicle uses the hook rather than calling Apollo directly.

Components are small and single-purpose. The card, the search input, the sort selector, and the add-vehicle form are each their own component.

## Testing

Unit tests exist for the most important behaviors:

- The card renders the vehicle's manufacturer, model designation, production year, and exterior finish.
- The search input filters the list as the user types.
- The add-vehicle form submits the mutation with the entered values.

Tests use Apollo's `MockedProvider` pattern and include `__typename` on mocked response data for Apollo cache compatibility. This pattern is demonstrated in the boilerplate's existing test file.

## What Is Already Set Up

The following pieces are already in place in the boilerplate and should not be re-created by the generated code:

- React, TypeScript, Vite, Material UI, Apollo Client, MSW, and Vitest are configured.
- The vehicle data type is defined in `src/types.ts`. (The underlying GraphQL schema uses the field names `make`, `model`, `year`, `color`, `mobile`, `tablet`, `desktop` — treat `make` as manufacturer, `model` as model designation, `year` as production year, and `color` as exterior finish when presenting values in the UI.)
- The Apollo client, GraphQL operations, MSW handlers, and five seed records are set up.
- A reference component at `src/components/Example.tsx` and a reference test at `src/__tests__/Example.test.tsx` demonstrate the expected style, import conventions (`@/` alias), and testing pattern.

The generated code should match the conventions visible in those reference files.